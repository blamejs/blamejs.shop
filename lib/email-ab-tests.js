"use strict";
/**
 * @module shop.emailABTests
 * @title  Email A/B tests — subject + body experiments across templates
 *
 * @intro
 *   `emailTemplates` lets operators author transactional bodies;
 *   `emailABTests` lets them experiment on those bodies. An operator
 *   defines a test against a single template slug + a list of
 *   variants (each variant overrides the template's subject /
 *   body_html / body_text for the subset of recipients it owns).
 *   Every variant carries a positive-integer `weight`; assignment
 *   is deterministic per (test_id, recipient_id) — a SHA3-512
 *   namespace-hash projects the pair into a 100,000-bucket range
 *   that maps onto the cumulative-weight buckets, so the same
 *   recipient always gets the same variant across the lifetime of
 *   the test and the realised split tracks the declared weights
 *   without rounding bias.
 *
 *   Composition:
 *
 *     var ab = bShop.emailABTests.create({ query: q, emailTemplates: et });
 *
 *     var test = await ab.defineTest({
 *       slug:          "welcome-subject-v1",
 *       title:         "Welcome email — short vs. long subject",
 *       template_slug: "welcome-default",
 *       variants: [
 *         { id: "short",       label: "Short",  weight: 1, subject: "Welcome!" },
 *         { id: "long",        label: "Long",   weight: 1, subject: "Welcome to the shop — let's get you set up" },
 *       ],
 *     });
 *
 *     await ab.startTest(test.slug);
 *
 *     // For every outgoing welcome email — derive the assignment,
 *     // render the variant overrides on top of the template, record
 *     // the send.
 *     var assignment = await ab.getVariantForRecipient({
 *       test_slug:    "welcome-subject-v1",
 *       recipient_id: customer.id,
 *     });
 *     // assignment.variant.subject overrides templates.renderTemplate(...).subject
 *     await ab.recordEmailSent({
 *       test_slug:    "welcome-subject-v1",
 *       recipient_id: customer.id,
 *       variant_id:   assignment.variant.id,
 *     });
 *
 *     // Webhook side — every open / click pixel routes through here.
 *     await ab.recordOpen({  test_slug: "...", recipient_id: "...", variant_id: "..." });
 *     await ab.recordClick({ test_slug: "...", recipient_id: "...", variant_id: "..." });
 *
 *     // Operator reads the live metrics with Wilson 95% CI on
 *     // both open- and click-through rates.
 *     var metrics = await ab.metricsForTest("welcome-subject-v1");
 *
 *     // When the operator picks a winner, freeze the test.
 *     await ab.concludeTest("welcome-subject-v1", { winner_variant_id: "long" });
 *
 *   Deterministic assignment:
 *
 *     The hash input is `<test_id>|<recipient_id>` namespace-hashed
 *     under `email-ab-test-assignment`; the SHA3-512 output's first
 *     8 hex bytes (32 bits) project into [0, 100000) via modulus.
 *     Cumulative-weight thresholds are computed in the same 100000-
 *     bucket basis so weight 1:1 splits at 50000, weight 3:1 splits
 *     at 75000, weight 1:2:1 splits at 25000 / 75000. The recipient_id
 *     is the operator-chosen stable handle — usually a customer UUID,
 *     but any non-empty string under 256 chars is accepted so an
 *     operator can A/B test newsletter sends keyed by an email-hash
 *     when no logged-in customer exists.
 *
 *   FSM:
 *
 *     draft -> running   (startTest)
 *     running -> paused  (pauseTest)
 *     paused -> running  (resumeTest)
 *     running -> concluded   (concludeTest)
 *     paused  -> concluded   (concludeTest)
 *     *       -> archived    (archiveTest; terminal)
 *
 *     `pauseTest` does NOT invalidate existing per-recipient
 *     assignments — a paused test still serves the same variant to
 *     a returning recipient (so a paused experiment doesn't flip
 *     mid-flight); `recordEmailSent` refuses new assignments while
 *     paused. `archiveTest` is terminal and `recordEmailSent` /
 *     `recordOpen` / `recordClick` refuse on archived tests.
 *
 *   Wilson 95% CI:
 *
 *     `metricsForTest` returns per-variant `open_rate` + `click_rate`
 *     each as `{ rate, lower, upper, n, k }` where `lower` / `upper`
 *     are the Wilson score-interval bounds at z=1.96. The Wilson
 *     interval is well-defined for small n + extreme proportions
 *     (where the normal approximation gives nonsense bounds), so an
 *     operator who looks at a test with 30 sends + 1 open still gets
 *     a useful interval.
 *
 *   Storage: `migrations-d1/0169_email_ab_tests.sql` —
 *     `email_ab_tests` + `email_ab_test_events` (FK CASCADE).
 *
 * @primitive emailABTests
 * @related   shop.emailTemplates, b.crypto.namespaceHash, b.uuid.v7
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- constants ----------------------------------------------------------

var SLUG_RE                  = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
var VARIANT_ID_RE            = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

var STATUSES                 = Object.freeze(["draft", "running", "paused", "concluded", "archived"]);
var EVENT_KINDS              = Object.freeze(["sent", "opened", "clicked"]);

var ASSIGNMENT_NAMESPACE     = "email-ab-test-assignment";
var ASSIGNMENT_BUCKETS       = 100000;

var MIN_VARIANTS             = 2;
var MAX_VARIANTS             = 16;
var MAX_TITLE_LEN            = 200;
var MAX_LABEL_LEN            = 200;
var MAX_SUBJECT_LEN          = 200;
var MAX_BODY_LEN             = 256 * 1024;   // matches email-templates body cap
var MAX_RECIPIENT_ID_LEN     = 256;
var MAX_TOTAL_WEIGHT         = 1000000;
var MAX_LIST_LIMIT           = 500;
var DEFAULT_LIST_LIMIT       = 50;

// Wilson 95% z-score — kept as a constant so a future move to
// 99% is one literal swap. z=1.959964 is the more precise value
// but 1.96 is the de-facto convention for shipped dashboards.
var WILSON_Z                 = 1.96;


// ---- monotonic clock ----------------------------------------------------
//
// Operators record sent / open / click events in tight loops while a
// campaign drains; same-millisecond ties are routine. Bumping by 1ms
// on a tie keeps the audit timeline strictly increasing so an
// `ORDER BY occurred_at` read returns events in issue order without
// an additional tiebreaker column.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("emailABTests: " + (label || "slug") +
                         " must be lowercase alnum + . _ -, no leading/trailing punct, 1..100 chars");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("emailABTests: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  textGuard.freeText(s, "emailABTests: title", { bidiMarks: "allow" });
  return s;
}

function _variantId(s, label) {
  if (typeof s !== "string" || !VARIANT_ID_RE.test(s)) {
    throw new TypeError("emailABTests: " + (label || "variant id") +
                         " must be lowercase alnum + _ -, 1..64 chars");
  }
  return s;
}

function _label(s, idx) {
  if (typeof s !== "string" || !s.length || s.length > MAX_LABEL_LEN) {
    throw new TypeError("emailABTests: variants[" + idx + "].label must be a non-empty string <= " +
                        MAX_LABEL_LEN + " chars");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("emailABTests: variants[" + idx + "].label must not contain control bytes");
  }
  return s;
}

function _weight(n, idx) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("emailABTests: variants[" + idx + "].weight must be a positive integer");
  }
  return n;
}

function _subjectOverride(s, idx) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_SUBJECT_LEN) {
    throw new TypeError("emailABTests: variants[" + idx + "].subject must be a non-empty string <= " +
                        MAX_SUBJECT_LEN + " chars when provided");
  }
  if (/[\r\n\0]/.test(s)) {
    throw new TypeError("emailABTests: variants[" + idx + "].subject must not contain CR / LF / NUL");
  }
  return s;
}

function _bodyOverride(s, idx, field) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length || s.length > MAX_BODY_LEN) {
    throw new TypeError("emailABTests: variants[" + idx + "]." + field + " must be a non-empty string <= " +
                        MAX_BODY_LEN + " bytes when provided");
  }
  return s;
}

function _recipientId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_RECIPIENT_ID_LEN) {
    throw new TypeError("emailABTests: recipient_id must be a non-empty string <= " +
                        MAX_RECIPIENT_ID_LEN + " chars");
  }
  textGuard.freeText(s, "emailABTests: recipient_id");
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("emailABTests: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("emailABTests: " + label + " must be a non-negative integer (ms epoch) or null");
  }
  return n;
}

// Canonicalise the operator-authored variants[] array. Returns a
// deep-cloned + key-ordered array so the stored JSON is independent
// of caller mutation.
function _variants(arr) {
  if (!Array.isArray(arr)) {
    throw new TypeError("emailABTests: variants must be an array");
  }
  if (arr.length < MIN_VARIANTS) {
    throw new TypeError("emailABTests: variants must contain at least " + MIN_VARIANTS + " entries");
  }
  if (arr.length > MAX_VARIANTS) {
    throw new TypeError("emailABTests: variants must contain <= " + MAX_VARIANTS + " entries");
  }
  var seen = Object.create(null);
  var out  = [];
  var totalWeight = 0;
  var sawOverride = false;
  for (var i = 0; i < arr.length; i += 1) {
    var v = arr[i];
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new TypeError("emailABTests: variants[" + i + "] must be an object");
    }
    var id     = _variantId(v.id, "variants[" + i + "].id");
    if (seen[id]) {
      throw new TypeError("emailABTests: variants[" + i + "].id duplicates a previous entry");
    }
    seen[id] = true;
    var label  = _label(v.label, i);
    var weight = _weight(v.weight, i);
    totalWeight += weight;
    if (totalWeight > MAX_TOTAL_WEIGHT) {
      throw new TypeError("emailABTests: total variant weight must be <= " + MAX_TOTAL_WEIGHT);
    }
    var subject  = _subjectOverride(v.subject == null ? null : v.subject, i);
    var bodyHtml = _bodyOverride(v.body_html == null ? null : v.body_html, i, "body_html");
    var bodyText = _bodyOverride(v.body_text == null ? null : v.body_text, i, "body_text");
    if (subject || bodyHtml || bodyText) sawOverride = true;
    out.push({
      id:        id,
      label:     label,
      weight:    weight,
      subject:   subject,
      body_html: bodyHtml,
      body_text: bodyText,
    });
  }
  if (!sawOverride) {
    // A test with no overrides at all would assign recipients to
    // visually-identical variants — surface this at definition time
    // rather than letting the operator wonder why their metrics
    // look identical.
    throw new TypeError(
      "emailABTests: at least one variant must override subject / body_html / body_text " +
      "— otherwise the test has nothing to measure"
    );
  }
  return out;
}

// ---- deterministic assignment ------------------------------------------
//
// SHA3-512 of `<test_id>|<recipient_id>` under the assignment
// namespace; the first 32 bits of the hex digest project into
// [0, ASSIGNMENT_BUCKETS) via modulus. The bucket is then matched
// against the cumulative-weight thresholds to pick the variant.

function _bucketForPair(testId, recipientId) {
  var digest = b.crypto.namespaceHash(ASSIGNMENT_NAMESPACE, testId + "|" + recipientId);
  // Take the first 8 hex chars -> 32-bit unsigned integer. The full
  // SHA3-512 digest is 128 hex chars; 32 bits is plenty of entropy
  // for a 100,000-bucket projection and keeps the modulus bias
  // negligible (2^32 / 100000 ~= 42949 — well above the modulo-bias
  // floor where the trailing buckets would shrink).
  var n = parseInt(digest.slice(0, 8), 16);
  if (!Number.isFinite(n) || n < 0) n = 0;
  return n % ASSIGNMENT_BUCKETS;
}

function _pickVariant(variants, bucket) {
  // Cumulative-weight bucketing. The thresholds are computed in
  // the same 100000-bucket basis so the last variant's upper bound
  // is always exactly ASSIGNMENT_BUCKETS — no remainder bucket
  // drifts because of integer division.
  var totalWeight = 0;
  for (var i = 0; i < variants.length; i += 1) totalWeight += variants[i].weight;
  var accum = 0;
  for (var j = 0; j < variants.length; j += 1) {
    accum += variants[j].weight;
    var threshold = Math.floor((accum * ASSIGNMENT_BUCKETS) / totalWeight);
    if (j === variants.length - 1) threshold = ASSIGNMENT_BUCKETS;
    if (bucket < threshold) return variants[j];
  }
  return variants[variants.length - 1];
}

// ---- Wilson score interval ---------------------------------------------
//
// 95% CI for a binomial proportion. For n=0 the interval collapses
// to {0, 0, 0}; for k=0 the lower bound is 0 and the upper bound is
// the Wilson upper for k=0 (still > 0); for k=n the upper bound is
// 1. The math:
//
//   p_hat = k/n
//   denom = 1 + z^2/n
//   centre = (p_hat + z^2/(2n)) / denom
//   margin = z * sqrt((p_hat*(1-p_hat) + z^2/(4n)) / n) / denom
//   lower  = centre - margin
//   upper  = centre + margin
//
// `_round4` rounds to 4 decimal places so the operator dashboard
// shows 0.1234 / 12.34% without trailing-precision noise.

function _round4(x) {
  return Math.round(x * 10000) / 10000;
}

function _wilson(k, n) {
  if (n === 0) return { rate: 0, lower: 0, upper: 0, n: 0, k: 0 };
  var phat   = k / n;
  var z      = WILSON_Z;
  var z2     = z * z;
  var denom  = 1 + z2 / n;
  var centre = (phat + z2 / (2 * n)) / denom;
  var margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  var lower  = centre - margin;
  var upper  = centre + margin;
  if (lower < 0) lower = 0;
  if (upper > 1) upper = 1;
  return {
    rate:  _round4(phat),
    lower: _round4(lower),
    upper: _round4(upper),
    n:     n,
    k:     k,
  };
}

// ---- row decoders ------------------------------------------------------

function _decodeTest(row) {
  if (!row) return null;
  var variants;
  try { variants = JSON.parse(row.variants_json); }
  catch (_e) { variants = []; }
  return {
    id:                row.id,
    slug:              row.slug,
    title:             row.title,
    template_slug:     row.template_slug,
    variants:          variants,
    status:            row.status,
    winner_variant_id: row.winner_variant_id,
    started_at:        row.started_at   != null ? Number(row.started_at)   : null,
    paused_at:         row.paused_at    != null ? Number(row.paused_at)    : null,
    concluded_at:      row.concluded_at != null ? Number(row.concluded_at) : null,
    archived_at:       row.archived_at  != null ? Number(row.archived_at)  : null,
    created_at:        Number(row.created_at),
    updated_at:        Number(row.updated_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional emailTemplates handle — when wired, defineTest validates
  // that `template_slug` references a defined (non-archived) template.
  // Absent, the test ships against an arbitrary slug (operator
  // vouches via their own dispatch wiring).
  var templates = opts.emailTemplates || null;

  // ---- internal helpers ------------------------------------------------

  async function _bySlug(slug) {
    var r = await query("SELECT * FROM email_ab_tests WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }
  async function _byId(id) {
    var r = await query("SELECT * FROM email_ab_tests WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  function _requireRow(row, label, slug) {
    if (!row) {
      throw new TypeError("emailABTests." + label + ": test '" + slug + "' not found");
    }
    return row;
  }

  async function _existingAssignment(testId, recipientId) {
    var r = await query(
      "SELECT variant_id FROM email_ab_test_events " +
      "WHERE test_id = ?1 AND recipient_id = ?2 AND kind = 'sent' LIMIT 1",
      [testId, recipientId],
    );
    return r.rows[0] ? r.rows[0].variant_id : null;
  }

  // ---- defineTest ------------------------------------------------------

  async function defineTest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailABTests.defineTest: input object required");
    }
    var slug         = _slug(input.slug, "slug");
    var title        = _title(input.title);
    var templateSlug = _slug(input.template_slug, "template_slug");
    var variants     = _variants(input.variants);

    // Validate the template handle if one was wired into the factory.
    if (templates && typeof templates.getTemplate === "function") {
      // Use `_getTemplateRow`-style probe via the public API; an
      // archived or missing template surfaces as a clean refusal at
      // definition time so an operator can't ship an experiment
      // pointed at a template the renderer would refuse.
      var tplProbe = null;
      try {
        // `getTemplate` returns null for missing/archived; we don't
        // require a published version (an operator may be staging
        // both the template + the test together — the test only
        // needs the slug to be live, not yet published).
        // Read the raw row via a SELECT through the same query.
        var rawProbe = await query(
          "SELECT slug, archived_at FROM email_templates WHERE slug = ?1",
          [templateSlug],
        );
        tplProbe = rawProbe.rows[0] || null;
      } catch (_e) {
        // Drop-silent — the email_templates table may not exist in a
        // narrowly-scoped layer-1 fixture. The wired-handle path is
        // an opt-in safety net, not a hard prerequisite.
        tplProbe = null;
      }
      if (tplProbe) {
        if (tplProbe.archived_at != null) {
          throw new TypeError(
            "emailABTests.defineTest: template_slug '" + templateSlug + "' is archived"
          );
        }
      } else {
        throw new TypeError(
          "emailABTests.defineTest: template_slug '" + templateSlug + "' not found"
        );
      }
    }

    var existing = await _bySlug(slug);
    if (existing) {
      throw new TypeError(
        "emailABTests.defineTest: test '" + slug + "' already exists — pick a fresh slug"
      );
    }

    var id  = b.uuid.v7();
    var ts  = _now();
    await query(
      "INSERT INTO email_ab_tests " +
      "(id, slug, title, template_slug, variants_json, status, winner_variant_id, " +
      " started_at, paused_at, concluded_at, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'draft', NULL, NULL, NULL, NULL, NULL, ?6, ?6)",
      [id, slug, title, templateSlug, JSON.stringify(variants), ts],
    );
    return _decodeTest(await _byId(id));
  }

  // ---- getTest --------------------------------------------------------

  async function getTest(slug) {
    _slug(slug, "slug");
    return _decodeTest(await _bySlug(slug));
  }

  // ---- listTests ------------------------------------------------------

  async function listTests(listOpts) {
    listOpts = listOpts || {};
    var status = null;
    if (listOpts.status != null) {
      if (STATUSES.indexOf(listOpts.status) < 0) {
        throw new TypeError("emailABTests.listTests: status must be one of " + STATUSES.join(", "));
      }
      status = listOpts.status;
    }
    var limit = _limit(listOpts.limit);
    var sql = "SELECT * FROM email_ab_tests";
    var params = [];
    if (status) {
      sql += " WHERE status = ?1";
      params.push(status);
    }
    sql += " ORDER BY created_at DESC, id DESC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_decodeTest(rows[i]));
    return out;
  }

  // ---- FSM transitions ------------------------------------------------

  async function startTest(slug) {
    _slug(slug, "slug");
    var row = _requireRow(await _bySlug(slug), "startTest", slug);
    if (row.status !== "draft") {
      var bad = new Error("emailABTests.startTest: test status is " + row.status);
      bad.code = "EMAIL_AB_TEST_NOT_DRAFT";
      throw bad;
    }
    var ts = _now();
    await query(
      "UPDATE email_ab_tests SET status = 'running', started_at = ?1, updated_at = ?1 " +
      "WHERE id = ?2 AND status = 'draft'",
      [ts, row.id],
    );
    return _decodeTest(await _byId(row.id));
  }

  async function pauseTest(slug) {
    _slug(slug, "slug");
    var row = _requireRow(await _bySlug(slug), "pauseTest", slug);
    if (row.status !== "running") {
      var bad = new Error("emailABTests.pauseTest: test status is " + row.status);
      bad.code = "EMAIL_AB_TEST_NOT_RUNNING";
      throw bad;
    }
    var ts = _now();
    await query(
      "UPDATE email_ab_tests SET status = 'paused', paused_at = ?1, updated_at = ?1 " +
      "WHERE id = ?2 AND status = 'running'",
      [ts, row.id],
    );
    return _decodeTest(await _byId(row.id));
  }

  async function resumeTest(slug) {
    _slug(slug, "slug");
    var row = _requireRow(await _bySlug(slug), "resumeTest", slug);
    if (row.status !== "paused") {
      var bad = new Error("emailABTests.resumeTest: test status is " + row.status);
      bad.code = "EMAIL_AB_TEST_NOT_PAUSED";
      throw bad;
    }
    var ts = _now();
    await query(
      "UPDATE email_ab_tests SET status = 'running', paused_at = NULL, updated_at = ?1 " +
      "WHERE id = ?2 AND status = 'paused'",
      [ts, row.id],
    );
    return _decodeTest(await _byId(row.id));
  }

  async function concludeTest(slug, concludeOpts) {
    _slug(slug, "slug");
    concludeOpts = concludeOpts || {};
    var row = _requireRow(await _bySlug(slug), "concludeTest", slug);
    if (row.status !== "running" && row.status !== "paused") {
      var bad = new Error("emailABTests.concludeTest: test status is " + row.status);
      bad.code = "EMAIL_AB_TEST_NOT_ACTIVE";
      throw bad;
    }
    var variants = JSON.parse(row.variants_json);
    var winnerId = null;
    if (concludeOpts.winner_variant_id != null) {
      winnerId = _variantId(concludeOpts.winner_variant_id, "winner_variant_id");
      var match = false;
      for (var i = 0; i < variants.length; i += 1) {
        if (variants[i].id === winnerId) { match = true; break; }
      }
      if (!match) {
        throw new TypeError(
          "emailABTests.concludeTest: winner_variant_id '" + winnerId +
          "' is not one of the test's variants"
        );
      }
    }
    var ts = _now();
    await query(
      "UPDATE email_ab_tests SET status = 'concluded', concluded_at = ?1, " +
      "winner_variant_id = ?2, updated_at = ?1 " +
      "WHERE id = ?3 AND status IN ('running', 'paused')",
      [ts, winnerId, row.id],
    );
    return _decodeTest(await _byId(row.id));
  }

  async function archiveTest(slug) {
    _slug(slug, "slug");
    var row = await _bySlug(slug);
    if (!row) return null;
    if (row.status === "archived") {
      return _decodeTest(row);
    }
    var ts = _now();
    await query(
      "UPDATE email_ab_tests SET status = 'archived', archived_at = ?1, updated_at = ?1 " +
      "WHERE id = ?2 AND status <> 'archived'",
      [ts, row.id],
    );
    return _decodeTest(await _byId(row.id));
  }

  // ---- getVariantForRecipient -----------------------------------------

  async function getVariantForRecipient(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailABTests.getVariantForRecipient: input object required");
    }
    var slug        = _slug(input.test_slug, "test_slug");
    var recipientId = _recipientId(input.recipient_id);
    var row         = _requireRow(await _bySlug(slug), "getVariantForRecipient", slug);
    if (row.status === "archived") {
      var arch = new Error("emailABTests.getVariantForRecipient: test '" + slug + "' is archived");
      arch.code = "EMAIL_AB_TEST_ARCHIVED";
      throw arch;
    }
    var variants = JSON.parse(row.variants_json);

    // Sticky assignment: if the recipient already has a 'sent' row
    // recorded for this test, return that variant. The cumulative-
    // weight bucket math is deterministic given (test_id,
    // recipient_id) so re-computing returns the same answer; the
    // ledger check is a belt-and-braces guard against an operator
    // changing the variant weights mid-flight (which would silently
    // re-bucket every returning recipient otherwise).
    var sticky = await _existingAssignment(row.id, recipientId);
    var picked;
    if (sticky) {
      picked = null;
      for (var i = 0; i < variants.length; i += 1) {
        if (variants[i].id === sticky) { picked = variants[i]; break; }
      }
      if (!picked) {
        // The recipient's previous variant id no longer appears in
        // the variants[] list — surface the drift rather than
        // silently re-bucketing. Operators who really want to
        // rebucket archive the test + define a fresh one.
        var gone = new Error(
          "emailABTests.getVariantForRecipient: previous variant '" + sticky +
          "' for recipient is no longer in the test's variants"
        );
        gone.code = "EMAIL_AB_TEST_VARIANT_REMOVED";
        throw gone;
      }
    } else {
      var bucket = _bucketForPair(row.id, recipientId);
      picked = _pickVariant(variants, bucket);
    }
    return {
      test_id:      row.id,
      test_slug:    row.slug,
      recipient_id: recipientId,
      sticky:       !!sticky,
      variant:      {
        id:        picked.id,
        label:     picked.label,
        weight:    picked.weight,
        subject:   picked.subject,
        body_html: picked.body_html,
        body_text: picked.body_text,
      },
    };
  }

  // ---- record events --------------------------------------------------

  async function _recordEvent(kind, input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("emailABTests.record" + kind + ": input object required");
    }
    var slug        = _slug(input.test_slug, "test_slug");
    var recipientId = _recipientId(input.recipient_id);
    var variantId   = _variantId(input.variant_id, "variant_id");
    var occurredOpt = _epochOpt(input.occurred_at, "occurred_at");

    var row = _requireRow(await _bySlug(slug), "record" + kind, slug);
    if (row.status === "archived") {
      var arch = new Error("emailABTests.record" + kind + ": test '" + slug + "' is archived");
      arch.code = "EMAIL_AB_TEST_ARCHIVED";
      throw arch;
    }
    if (kind === "EmailSent" && row.status !== "running") {
      // sent events anchor the assignment — only running tests accept
      // new assignments. opened / clicked events can still land while
      // the test is paused / concluded so a late-firing pixel from a
      // previously-sent email doesn't drop on the floor.
      var notRun = new Error("emailABTests.recordEmailSent: test '" + slug + "' status is " + row.status);
      notRun.code = "EMAIL_AB_TEST_NOT_RUNNING";
      throw notRun;
    }

    // For opened / clicked: verify the (recipient, variant) pair was
    // actually assigned a `sent` event first. A click on a recipient
    // who was never sent the email is a webhook anomaly we refuse
    // outright so spammy upstream pixels can't inflate metrics.
    if (kind === "Open" || kind === "Click") {
      var sent = await query(
        "SELECT 1 FROM email_ab_test_events " +
        "WHERE test_id = ?1 AND recipient_id = ?2 AND variant_id = ?3 AND kind = 'sent' LIMIT 1",
        [row.id, recipientId, variantId],
      );
      if (!sent.rows.length) {
        var missing = new Error(
          "emailABTests.record" + kind + ": no matching 'sent' event for " +
          "(recipient, variant) — refusing to count an event for an unassigned pair"
        );
        missing.code = "EMAIL_AB_TEST_NOT_SENT";
        throw missing;
      }
    }

    // The (test_id, recipient_id, variant_id, kind) UNIQUE index makes
    // the event idempotent — replaying the same open / click pixel
    // lands as a no-op, never a double-count. We attempt the insert
    // first; if it conflicts, we read the existing row's id and
    // return it as the canonical event.
    var id          = b.uuid.v7();
    var ts          = _now();
    var occurredAt  = occurredOpt != null ? occurredOpt : ts;
    var eventKind   = kind === "EmailSent" ? "sent"
                    : kind === "Open"      ? "opened"
                    : "clicked";
    var inserted = false;
    try {
      await query(
        "INSERT INTO email_ab_test_events (id, test_id, recipient_id, variant_id, kind, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [id, row.id, recipientId, variantId, eventKind, occurredAt],
      );
      inserted = true;
    } catch (e) {
      // UNIQUE conflict — re-read the existing row's id + occurred_at
      // and return it. Any other error (FK violation, schema drift)
      // bubbles up.
      var msg = String(e && e.message || e);
      if (!/UNIQUE|constraint/i.test(msg)) throw e;
      var existing = await query(
        "SELECT id, occurred_at FROM email_ab_test_events " +
        "WHERE test_id = ?1 AND recipient_id = ?2 AND variant_id = ?3 AND kind = ?4 LIMIT 1",
        [row.id, recipientId, variantId, eventKind],
      );
      if (existing.rows[0]) {
        id         = existing.rows[0].id;
        occurredAt = Number(existing.rows[0].occurred_at);
      }
    }

    return {
      event_id:     id,
      test_id:      row.id,
      test_slug:    row.slug,
      recipient_id: recipientId,
      variant_id:   variantId,
      kind:         eventKind,
      occurred_at:  occurredAt,
      duplicate:    !inserted,
    };
  }

  async function recordEmailSent(input) { return _recordEvent("EmailSent", input); }
  async function recordOpen(input)      { return _recordEvent("Open",      input); }
  async function recordClick(input)     { return _recordEvent("Click",     input); }

  // ---- metricsForTest -------------------------------------------------

  async function metricsForTest(slug) {
    _slug(slug, "slug");
    var row = await _bySlug(slug);
    if (!row) return null;
    var test = _decodeTest(row);

    var counts = (await query(
      "SELECT variant_id, kind, COUNT(*) AS c FROM email_ab_test_events " +
      "WHERE test_id = ?1 GROUP BY variant_id, kind",
      [row.id],
    )).rows;

    var byVariant = Object.create(null);
    for (var i = 0; i < test.variants.length; i += 1) {
      var v = test.variants[i];
      byVariant[v.id] = {
        variant_id: v.id,
        label:      v.label,
        weight:     v.weight,
        sent:       0,
        opened:     0,
        clicked:    0,
      };
    }
    for (var j = 0; j < counts.length; j += 1) {
      var row2 = counts[j];
      var entry = byVariant[row2.variant_id];
      if (!entry) continue;   // historical variant id removed from the test
      var n = Number(row2.c);
      if (row2.kind === "sent")         entry.sent    = n;
      else if (row2.kind === "opened")  entry.opened  = n;
      else if (row2.kind === "clicked") entry.clicked = n;
    }

    var perVariant = [];
    var totalSent  = 0;
    var totalOpen  = 0;
    var totalClick = 0;
    for (var k = 0; k < test.variants.length; k += 1) {
      var ent = byVariant[test.variants[k].id];
      ent.open_rate  = _wilson(ent.opened,  ent.sent);
      ent.click_rate = _wilson(ent.clicked, ent.sent);
      perVariant.push(ent);
      totalSent  += ent.sent;
      totalOpen  += ent.opened;
      totalClick += ent.clicked;
    }

    return {
      test_id:           test.id,
      test_slug:         test.slug,
      status:            test.status,
      winner_variant_id: test.winner_variant_id,
      per_variant:       perVariant,
      totals: {
        sent:       totalSent,
        opened:     totalOpen,
        clicked:    totalClick,
        open_rate:  _wilson(totalOpen,  totalSent),
        click_rate: _wilson(totalClick, totalSent),
      },
    };
  }

  return {
    STATUSES:               STATUSES.slice(),
    EVENT_KINDS:            EVENT_KINDS.slice(),
    ASSIGNMENT_NAMESPACE:   ASSIGNMENT_NAMESPACE,
    ASSIGNMENT_BUCKETS:     ASSIGNMENT_BUCKETS,
    MIN_VARIANTS:           MIN_VARIANTS,
    MAX_VARIANTS:           MAX_VARIANTS,
    WILSON_Z:               WILSON_Z,

    defineTest:             defineTest,
    getTest:                getTest,
    listTests:              listTests,
    startTest:              startTest,
    pauseTest:              pauseTest,
    resumeTest:             resumeTest,
    concludeTest:           concludeTest,
    archiveTest:            archiveTest,
    getVariantForRecipient: getVariantForRecipient,
    recordEmailSent:        recordEmailSent,
    recordOpen:             recordOpen,
    recordClick:            recordClick,
    metricsForTest:         metricsForTest,
  };
}

module.exports = {
  create:                 create,
  STATUSES:               STATUSES,
  EVENT_KINDS:            EVENT_KINDS,
  ASSIGNMENT_NAMESPACE:   ASSIGNMENT_NAMESPACE,
  ASSIGNMENT_BUCKETS:     ASSIGNMENT_BUCKETS,
  MIN_VARIANTS:           MIN_VARIANTS,
  MAX_VARIANTS:           MAX_VARIANTS,
  WILSON_Z:               WILSON_Z,
};
