"use strict";
/**
 * @module shop.bannerABTests
 * @title  Banner A/B tests — split-test promo banners with deterministic
 *         per-session assignment + impression/click/conversion ledger
 *
 * @intro
 *   Operators run head-to-head split tests on `promoBanners` variants
 *   without taking a dependency on the broader experiments framework.
 *   Each test references N banner slugs as its variants (each with a
 *   positive integer weight); a visitor's session id deterministically
 *   maps to one variant for the test's life, so the visitor never
 *   experiences a mid-funnel banner flip. The storefront calls
 *   `recordImpression` when the banner renders, `recordClick` when the
 *   visitor follows the CTA, and `recordConversion` when the downstream
 *   purchase / signup / target action happens; `metricsForTest` rolls
 *   the ledger up with Wilson 95% confidence intervals for click-
 *   through and conversion rates so the operator dashboard can spot a
 *   statistically meaningful winner.
 *
 *   Surface:
 *     - defineTest({ slug, title, hypothesis, variants, starts_at,
 *                    ends_at? })
 *         Create the test. `variants` is an ordered array of
 *         { banner_slug, weight } records — `banner_slug` is the slug
 *         of an existing `promoBanners` row when a `promoBanners`
 *         handle was passed to `create`; without the handle the
 *         primitive treats the slug as opaque and just persists it.
 *         Variants are write-once: changing them after defineTest
 *         would corrupt assignments for sessions already seen.
 *         Status starts at `running`.
 *
 *     - getVariantForSession({ test_slug, session_id, now? })
 *         Returns { test_slug, variant_slug, banner_slug,
 *         session_id_hash } for the assigned variant, or null when
 *         the test is not currently reading traffic (status not
 *         `running`, or `now` is outside [starts_at, ends_at]). The
 *         session id is namespace-hashed (`banner-ab-tests-session`)
 *         before any storage or assignment work. Assignment is
 *         deterministic: same session id + same test slug → same
 *         variant 100% of the time, for the lifetime of the test.
 *
 *     - recordImpression({ test_slug, session_id, now? })
 *         Append an impression event for the session's currently-
 *         assigned variant. Drop-silent on unknown / archived / not-
 *         running test (hot-path observability sink — throwing here
 *         would crash the storefront response that triggered the
 *         render).
 *
 *     - recordClick({ test_slug, session_id, now? })
 *         Same shape as recordImpression but for the click step.
 *
 *     - recordConversion({ test_slug, session_id, value?, now? })
 *         Same shape, optional `value` for revenue attribution
 *         (non-negative integer).
 *
 *     - metricsForTest({ test_slug, until? })
 *         Per-variant impression / click / conversion counts +
 *         distinct-session counts + Wilson 95% CI for CTR
 *         (clicks/impressions) and conversion rate
 *         (conversions/impressions). `until` defaults to `now`.
 *
 *     - pauseTest(slug) / resumeTest(slug) / concludeTest(slug, opts?)
 *       / archiveTest(slug)
 *         FSM transitions:
 *           running    -> paused      (pauseTest)
 *           paused     -> running     (resumeTest)
 *           running    -> concluded   (concludeTest, opts.winner?)
 *           paused     -> concluded   (concludeTest)
 *           concluded  -> archived    (archiveTest, terminal)
 *         `concludeTest` accepts an optional `winner` (one of the
 *         test's variant banner slugs) to record the operator's
 *         declared winner. Resuming a concluded test is refused —
 *         operators define a new test if they want to re-run.
 *
 *     - listTests({ status?, limit?, cursor? })
 *         Enumerate tests, optionally filtered by status.
 *
 *   Composition:
 *     - b.crypto.namespaceHash — session id is hashed with namespace
 *       `banner-ab-tests-session` before any storage or assignment-
 *       hashing work. Assignment uses
 *       `namespaceHash("banner-ab-tests-assign", slug + ":" +
 *       sessionHash)` to derive a 64-bit integer modulo the
 *       cumulative weight.
 *     - b.uuid.v7 — every banner_ab_test_events row carries a v7 id
 *       so rows sort lexicographically by insertion time.
 *
 *   Storage:
 *     - `banner_ab_tests` + `banner_ab_test_events`
 *       (migration `0174_banner_ab_tests.sql`).
 *
 * @primitive bannerABTests
 * @related   b.crypto.namespaceHash, b.uuid.v7, promoBanners
 */

var MAX_SLUG_LEN          = 80;
var MAX_TITLE_LEN         = 200;
var MAX_HYPOTHESIS_LEN    = 2000;
var MAX_VARIANTS          = 16;
var MAX_WEIGHT            = 1000000;
var MAX_VALUE             = 1e12;
var DEFAULT_LIMIT         = 50;
var MAX_LIMIT             = 500;

var SESSION_NAMESPACE     = "banner-ab-tests-session";
var ASSIGN_NAMESPACE      = "banner-ab-tests-assign";

var ALLOWED_STATUSES      = Object.freeze(["running", "paused", "concluded", "archived"]);
var ALLOWED_EVENT_KINDS   = Object.freeze(["impression", "click", "conversion"]);

// FSM transition graph. Mirrors the migration header comment.
// Archived is terminal — no outbound edges.
var TRANSITIONS = Object.freeze({
  running:   { pause: "paused",    resume: null,        conclude: "concluded", archive: null      },
  paused:    { pause: null,        resume: "running",   conclude: "concluded", archive: null      },
  concluded: { pause: null,        resume: null,        conclude: null,        archive: "archived"},
  archived:  { pause: null,        resume: null,        conclude: null,        archive: null      },
});

var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Refuse C0 control bytes + DEL in operator-authored strings. The
// title / hypothesis fields land in the operator dashboard, not the
// storefront — but the discipline is the same: strings reach the UI
// as inert text, never as live markup.
var CONTROL_BYTE_LINE_RE  = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BLOCK_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Zero-width / direction-override family — mirrors the promo-banners
// + experiments catalogues. Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- monotonic clock ----------------------------------------------------
//
// Tests + events persist epoch-ms timestamps. Operators occasionally
// backfill impressions / conversions (importing from a third-party
// analytics tool). The strict-monotonic clock here guarantees that two
// same-millisecond `_now()` calls produce distinct integers so the
// row-ordering on `occurred_at` is deterministic without an extra
// tiebreaker column. Tests that fan-out impressions in tight loops
// rely on this for ordering assertions.
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
    throw new TypeError("bannerABTests: " + (label || "slug") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _line(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("bannerABTests: " + label + " must be a non-empty string <= " + maxLen + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("bannerABTests: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("bannerABTests: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _block(s, label, maxLen) {
  if (typeof s !== "string" || !s.length || s.length > maxLen) {
    throw new TypeError("bannerABTests: " + label + " must be a non-empty string <= " + maxLen + " chars");
  }
  if (CONTROL_BYTE_BLOCK_RE.test(s)) {
    throw new TypeError("bannerABTests: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("bannerABTests: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _status(s) {
  if (typeof s !== "string" || ALLOWED_STATUSES.indexOf(s) === -1) {
    throw new TypeError("bannerABTests: status must be one of " + JSON.stringify(ALLOWED_STATUSES));
  }
  return s;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("bannerABTests: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("bannerABTests: limit must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _sessionId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("bannerABTests: session_id must be a non-empty string");
  }
  return s;
}

function _variants(arr) {
  if (!Array.isArray(arr) || arr.length < 2) {
    throw new TypeError("bannerABTests: variants must be an array of at least 2 { banner_slug, weight } records");
  }
  if (arr.length > MAX_VARIANTS) {
    throw new TypeError("bannerABTests: variants must be <= " + MAX_VARIANTS + " records");
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < arr.length; i += 1) {
    var v = arr[i];
    if (!v || typeof v !== "object") {
      throw new TypeError("bannerABTests: variants[" + i + "] must be an object");
    }
    var vs = _slug(v.banner_slug, "variants[" + i + "].banner_slug");
    if (seen[vs]) {
      throw new TypeError("bannerABTests: variants[" + i + "].banner_slug duplicates an earlier variant");
    }
    seen[vs] = true;
    if (!Number.isInteger(v.weight) || v.weight < 1 || v.weight > MAX_WEIGHT) {
      throw new TypeError("bannerABTests: variants[" + i + "].weight must be an integer in [1, " +
                          MAX_WEIGHT + "]");
    }
    out.push({ banner_slug: vs, weight: v.weight });
  }
  return out;
}

// ---- assignment math ----------------------------------------------------
//
// The 64-bit modulus is computed from the first 16 hex chars (64
// bits) of the SHA3-512 hex output. JavaScript numbers are 53-bit
// safe, so the modulus is taken in two 32-bit halves to stay inside
// integer-arithmetic territory. Mathematically this is identical to
// taking the modulus of the full 64-bit unsigned integer.
function _modCumulativeWeight(sessionHashHex, cumulativeWeight) {
  var high = parseInt(sessionHashHex.slice(0, 8), 16);
  var low  = parseInt(sessionHashHex.slice(8, 16), 16);
  var cw   = cumulativeWeight;
  var twoToThe32ModCw = 4294967296 % cw;
  return ((high % cw) * twoToThe32ModCw + low) % cw;
}

// ---- Wilson score interval ---------------------------------------------
//
// Two-sided 95% confidence interval for a Bernoulli proportion. The
// Wilson interval is well-behaved at the extremes (0% / 100%) and
// for small sample sizes — strictly preferable to the normal-
// approximation interval that newcomers reach for. Returns
// { lower, upper } with both bounds clamped into [0, 1].
var Z_95 = 1.959963984540054;

function _wilsonCi(successes, trials) {
  if (trials <= 0) return { lower: 0, upper: 0 };
  var z   = Z_95;
  var n   = trials;
  var p   = successes / n;
  var z2  = z * z;
  var denom  = 1 + z2 / n;
  var center = (p + z2 / (2 * n)) / denom;
  var half   = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  var lower = center - half;
  var upper = center + half;
  if (lower < 0) lower = 0;
  if (upper > 1) upper = 1;
  return { lower: lower, upper: upper };
}

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  var variants;
  try { variants = JSON.parse(r.variants_json); }
  catch (_e) { variants = []; }
  return {
    slug:                   r.slug,
    title:                  r.title,
    hypothesis:             r.hypothesis,
    variants:               variants,
    status:                 r.status,
    starts_at:              Number(r.starts_at),
    ends_at:                r.ends_at                == null ? null : Number(r.ends_at),
    concluded_variant_slug: r.concluded_variant_slug == null ? null : r.concluded_variant_slug,
    paused_at:              r.paused_at              == null ? null : Number(r.paused_at),
    concluded_at:           r.concluded_at           == null ? null : Number(r.concluded_at),
    archived_at:            r.archived_at            == null ? null : Number(r.archived_at),
    created_at:             Number(r.created_at),
    updated_at:             Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional `promoBanners` handle. When supplied, defineTest verifies
  // each variant's banner_slug references an existing, non-archived
  // banner row before persisting. Without the handle the primitive
  // treats banner_slug as opaque (so a test harness or a deployment
  // that hasn't wired promoBanners can still drive the primitive).
  var promo = opts.promoBanners || null;

  function _hashSession(sessionId) {
    return _b().crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  function _assignVariant(testSlug, sessionHash, variants) {
    var cw = 0;
    for (var i = 0; i < variants.length; i += 1) cw += variants[i].weight;
    var keyHash = _b().crypto.namespaceHash(ASSIGN_NAMESPACE, testSlug + ":" + sessionHash);
    var bucket  = _modCumulativeWeight(keyHash, cw);
    var acc = 0;
    for (var j = 0; j < variants.length; j += 1) {
      acc += variants[j].weight;
      if (bucket < acc) return variants[j];
    }
    // Defensive fallback — unreachable since bucket < cw = sum(weights).
    return variants[variants.length - 1];
  }

  // ---- defineTest -------------------------------------------------------

  async function defineTest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bannerABTests.defineTest: input object required");
    }
    var slug       = _slug(input.slug, "slug");
    var title      = _line(input.title, "title", MAX_TITLE_LEN);
    var hypothesis = _block(input.hypothesis, "hypothesis", MAX_HYPOTHESIS_LEN);
    var variants   = _variants(input.variants);
    var startsAt   = _epochMs(input.starts_at, "starts_at");
    var endsAt     = null;
    if (input.ends_at != null) {
      endsAt = _epochMs(input.ends_at, "ends_at");
      if (endsAt <= startsAt) {
        throw new TypeError("bannerABTests.defineTest: ends_at must be strictly greater than starts_at");
      }
    }

    // Verify every variant references a real, non-archived banner
    // when a promoBanners handle was supplied. Without the handle the
    // primitive trusts the operator's banner_slug values (the schema
    // doesn't FK into promo_banners because banner slugs evolve at a
    // different pace than the test catalogue).
    if (promo && typeof promo.getBanner === "function") {
      for (var i = 0; i < variants.length; i += 1) {
        var banner = await promo.getBanner(variants[i].banner_slug);
        if (!banner) {
          throw new TypeError("bannerABTests.defineTest: banner " +
            JSON.stringify(variants[i].banner_slug) + " not found");
        }
        if (banner.archived_at != null) {
          throw new TypeError("bannerABTests.defineTest: banner " +
            JSON.stringify(variants[i].banner_slug) + " is archived");
        }
      }
    }

    var existing = await getTest(slug);
    if (existing) {
      throw new TypeError("bannerABTests.defineTest: slug " + JSON.stringify(slug) + " already defined");
    }

    var ts = _now();
    await query(
      "INSERT INTO banner_ab_tests " +
      "(slug, title, hypothesis, variants_json, status, starts_at, ends_at, " +
      " concluded_variant_slug, paused_at, concluded_at, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, NULL, NULL, NULL, NULL, ?7, ?7)",
      [slug, title, hypothesis, JSON.stringify(variants), startsAt, endsAt, ts],
    );
    return await getTest(slug);
  }

  // ---- getTest / listTests ---------------------------------------------

  async function getTest(slug) {
    _slug(slug, "slug");
    var r = (await query(
      "SELECT * FROM banner_ab_tests WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function listTests(listOpts) {
    listOpts = listOpts || {};
    var limit  = _limit(listOpts.limit);
    var cursor = listOpts.cursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor.length)) {
      throw new TypeError("bannerABTests.listTests: cursor must be a non-empty string when provided");
    }
    var sql, params, idx;
    if (listOpts.status != null) {
      _status(listOpts.status);
      sql    = "SELECT * FROM banner_ab_tests WHERE status = ?1";
      params = [listOpts.status];
      idx    = 2;
    } else {
      sql    = "SELECT * FROM banner_ab_tests WHERE 1=1";
      params = [];
      idx    = 1;
    }
    if (cursor != null) {
      // Cursor is the last-seen test slug. Sort is (created_at DESC,
      // slug DESC) — the cursor predicate collapses to `slug < cursor`
      // because slugs are unique. The created_at tiebreaker still
      // governs the sort order itself.
      sql += " AND slug < ?" + idx;
      params.push(cursor);
      idx += 1;
    }
    sql += " ORDER BY created_at DESC, slug DESC LIMIT ?" + idx;
    params.push(limit);

    var rows = (await query(sql, params)).rows.map(_hydrateRow);
    var nextCursor = rows.length === limit ? rows[rows.length - 1].slug : null;
    return { rows: rows, next_cursor: nextCursor };
  }

  // ---- getVariantForSession --------------------------------------------

  async function getVariantForSession(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bannerABTests.getVariantForSession: input object required");
    }
    _slug(input.test_slug, "test_slug");
    _sessionId(input.session_id);
    var nowTs = input.now != null ? _epochMs(input.now, "now") : _now();

    var test = await getTest(input.test_slug);
    if (!test) return null;
    if (test.status !== "running") return null;
    if (nowTs < test.starts_at) return null;
    if (test.ends_at != null && nowTs >= test.ends_at) return null;

    var sessionHash = _hashSession(input.session_id);
    var v = _assignVariant(test.slug, sessionHash, test.variants);
    return {
      test_slug:        test.slug,
      variant_slug:     v.banner_slug,
      banner_slug:      v.banner_slug,
      session_id_hash:  sessionHash,
    };
  }

  // ---- recordImpression / recordClick / recordConversion ----------------
  //
  // Drop-silent on unknown / archived / not-running test. These run
  // on the hot storefront path; throwing here would crash the
  // request that observed the event. The validation layer at
  // defineTest has already verified that legitimate slugs exist;
  // a request that arrives with a stale slug after the test was
  // archived simply doesn't record, which is the correct
  // observability behavior.

  async function _record(eventKind, input) {
    if (!input || typeof input !== "object") return { recorded: false };
    if (typeof input.test_slug !== "string" || !SLUG_RE.test(input.test_slug)) {
      return { recorded: false };
    }
    if (typeof input.session_id !== "string" || !input.session_id.length) {
      return { recorded: false };
    }
    var value = 0;
    if (input.value != null) {
      if (!Number.isInteger(input.value) || input.value < 0 || input.value > MAX_VALUE) {
        return { recorded: false };
      }
      value = input.value;
    }
    if (input.now != null && (!Number.isInteger(input.now) || input.now < 0)) {
      return { recorded: false };
    }
    try {
      var test = await getTest(input.test_slug);
      if (!test) return { recorded: false };
      if (test.status === "archived" || test.status === "concluded") return { recorded: false };
      if (test.status === "paused") return { recorded: false };
      // status is "running" — also gate on the time window so a
      // request that arrives outside [starts_at, ends_at] doesn't
      // pollute the ledger with off-window events.
      var nowTs = input.now != null ? input.now : _now();
      if (nowTs < test.starts_at) return { recorded: false };
      if (test.ends_at != null && nowTs >= test.ends_at) return { recorded: false };

      var sessionHash = _hashSession(input.session_id);
      var variant     = _assignVariant(test.slug, sessionHash, test.variants);
      var id          = _b().uuid.v7();
      await query(
        "INSERT INTO banner_ab_test_events " +
        "(id, test_slug, variant_slug, session_id_hash, event_kind, value, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        [id, test.slug, variant.banner_slug, sessionHash, eventKind, value, nowTs],
      );
      return {
        recorded:    true,
        id:          id,
        variant_slug: variant.banner_slug,
        occurred_at: nowTs,
      };
    } catch (_e) {
      return { recorded: false };
    }
  }

  function recordImpression(input) { return _record("impression", input); }
  function recordClick(input)      { return _record("click",      input); }
  function recordConversion(input) { return _record("conversion", input); }

  // ---- metricsForTest ---------------------------------------------------

  async function metricsForTest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bannerABTests.metricsForTest: input object required");
    }
    _slug(input.test_slug, "test_slug");
    var until = input.until != null ? _epochMs(input.until, "until") : _now();

    var test = await getTest(input.test_slug);
    if (!test) {
      throw new TypeError("bannerABTests.metricsForTest: test " +
        JSON.stringify(input.test_slug) + " not found");
    }

    // Per-variant aggregate counts + distinct-session counts in
    // [test.starts_at, until]. The rollup is in SQL so the metrics
    // report stays efficient as the events table grows. We pull
    // counts per (variant, event_kind) and distinct-session counts
    // per (variant, event_kind) in two queries; combining via SQL
    // CASE would be a single query but the indexes line up cleaner
    // this way.
    var countRows = (await query(
      "SELECT variant_slug, event_kind, COUNT(*) AS n, COALESCE(SUM(value), 0) AS value_sum " +
      "FROM banner_ab_test_events " +
      "WHERE test_slug = ?1 AND occurred_at <= ?2 " +
      "GROUP BY variant_slug, event_kind",
      [test.slug, until],
    )).rows;
    var distinctRows = (await query(
      "SELECT variant_slug, event_kind, COUNT(DISTINCT session_id_hash) AS n " +
      "FROM banner_ab_test_events " +
      "WHERE test_slug = ?1 AND occurred_at <= ?2 " +
      "GROUP BY variant_slug, event_kind",
      [test.slug, until],
    )).rows;

    var byVariant = Object.create(null);
    for (var v = 0; v < test.variants.length; v += 1) {
      byVariant[test.variants[v].banner_slug] = {
        variant_slug:           test.variants[v].banner_slug,
        weight:                 test.variants[v].weight,
        impressions:            0,
        clicks:                 0,
        conversions:            0,
        conversion_value:       0,
        distinct_impression_sessions: 0,
        distinct_click_sessions:      0,
        distinct_conversion_sessions: 0,
      };
    }
    for (var i = 0; i < countRows.length; i += 1) {
      var cr = countRows[i];
      var b  = byVariant[cr.variant_slug];
      if (!b) continue;
      var n  = Number(cr.n);
      if (cr.event_kind === "impression") b.impressions       = n;
      else if (cr.event_kind === "click")  b.clicks            = n;
      else                                  b.conversions       = n;
      if (cr.event_kind === "conversion")  b.conversion_value  = Number(cr.value_sum);
    }
    for (var d = 0; d < distinctRows.length; d += 1) {
      var dr = distinctRows[d];
      var db = byVariant[dr.variant_slug];
      if (!db) continue;
      var dn = Number(dr.n);
      if (dr.event_kind === "impression")      db.distinct_impression_sessions = dn;
      else if (dr.event_kind === "click")       db.distinct_click_sessions      = dn;
      else                                      db.distinct_conversion_sessions = dn;
    }

    // Compute Wilson 95% CIs for CTR + conversion rate over the
    // impression denominator. Click-through rate is clicks /
    // impressions; conversion rate is conversions / impressions. The
    // Wilson interval clamps gracefully when impressions = 0.
    var out = [];
    var variantSlugs = Object.keys(byVariant);
    for (var k = 0; k < variantSlugs.length; k += 1) {
      var entry = byVariant[variantSlugs[k]];
      var ctrCi  = _wilsonCi(entry.clicks,      entry.impressions);
      var convCi = _wilsonCi(entry.conversions, entry.impressions);
      entry.ctr             = entry.impressions > 0 ? entry.clicks / entry.impressions : 0;
      entry.ctr_ci95_lower  = ctrCi.lower;
      entry.ctr_ci95_upper  = ctrCi.upper;
      entry.conversion_rate            = entry.impressions > 0 ? entry.conversions / entry.impressions : 0;
      entry.conversion_ci95_lower      = convCi.lower;
      entry.conversion_ci95_upper      = convCi.upper;
      out.push(entry);
    }

    // Preserve the operator-defined variant order in the output.
    var ordered = [];
    for (var o = 0; o < test.variants.length; o += 1) {
      ordered.push(byVariant[test.variants[o].banner_slug]);
    }

    return {
      test_slug: test.slug,
      until:     until,
      status:    test.status,
      variants:  ordered,
    };
  }

  // ---- FSM transitions -------------------------------------------------

  async function _transition(slug, event, transitionOpts) {
    _slug(slug, "slug");
    var existing = await getTest(slug);
    if (!existing) {
      throw new TypeError("bannerABTests." + event + ": slug " + JSON.stringify(slug) + " not found");
    }
    var allowed = TRANSITIONS[existing.status];
    var next    = allowed && allowed[event];
    if (!next) {
      var err = new TypeError("bannerABTests." + event + ": cannot " + event +
        " a test in status " + JSON.stringify(existing.status));
      err.code = "BANNER_AB_TEST_INVALID_TRANSITION";
      throw err;
    }
    var ts = _now();
    var sets   = ["status = ?1", "updated_at = ?2"];
    var params = [next, ts];
    var idx    = 3;
    if (next === "paused") {
      sets.push("paused_at = ?" + idx);
      params.push(ts);
      idx += 1;
    } else if (next === "running") {
      // Clear paused_at on resume so the column reflects the most
      // recent pause window only.
      sets.push("paused_at = NULL");
    } else if (next === "concluded") {
      sets.push("concluded_at = ?" + idx);
      params.push(ts);
      idx += 1;
      var winner = transitionOpts && transitionOpts.winner;
      if (winner != null) {
        _slug(winner, "winner");
        var inSet = false;
        for (var i = 0; i < existing.variants.length; i += 1) {
          if (existing.variants[i].banner_slug === winner) { inSet = true; break; }
        }
        if (!inSet) {
          throw new TypeError("bannerABTests.concludeTest: winner " +
            JSON.stringify(winner) + " is not one of the test's variant banner slugs");
        }
        sets.push("concluded_variant_slug = ?" + idx);
        params.push(winner);
        idx += 1;
      }
    } else if (next === "archived") {
      sets.push("archived_at = ?" + idx);
      params.push(ts);
      idx += 1;
    }
    params.push(slug);
    await query(
      "UPDATE banner_ab_tests SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    return await getTest(slug);
  }

  function pauseTest(slug)               { return _transition(slug, "pause");   }
  function resumeTest(slug)              { return _transition(slug, "resume");  }
  async function concludeTest(slug, concludeOpts) {
    if (concludeOpts != null && typeof concludeOpts !== "object") {
      throw new TypeError("bannerABTests.concludeTest: opts must be an object when provided");
    }
    return await _transition(slug, "conclude", concludeOpts || {});
  }
  function archiveTest(slug)             { return _transition(slug, "archive"); }

  // ---- eventsForTest (audit helper, supports pagination) ---------------

  async function eventsForTest(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("bannerABTests.eventsForTest: input object required");
    }
    _slug(input.test_slug, "test_slug");
    var from   = _epochOpt(input.from, "from");
    var to     = _epochOpt(input.to,   "to");
    if (from != null && to != null && from > to) {
      throw new TypeError("bannerABTests.eventsForTest: from must be <= to");
    }
    var limit  = _limit(input.limit);
    var cursor = input.cursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor.length)) {
      throw new TypeError("bannerABTests.eventsForTest: cursor must be a non-empty string when provided");
    }

    var sql    = "SELECT * FROM banner_ab_test_events WHERE test_slug = ?1";
    var params = [input.test_slug];
    var idx    = 2;
    if (from != null) {
      sql += " AND occurred_at >= ?" + idx; params.push(from); idx += 1;
    }
    if (to != null) {
      sql += " AND occurred_at <= ?" + idx; params.push(to); idx += 1;
    }
    if (cursor != null) {
      // The v7 id encodes occurred_at in its prefix, so an `id <
      // cursor` predicate collapses to "older than cursor" while
      // matching the (occurred_at DESC, id DESC) sort order.
      sql += " AND id < ?" + idx; params.push(cursor); idx += 1;
    }
    sql += " ORDER BY id DESC LIMIT ?" + idx;
    params.push(limit);

    var rows = (await query(sql, params)).rows.map(function (r) {
      return {
        id:               r.id,
        test_slug:        r.test_slug,
        variant_slug:     r.variant_slug,
        session_id_hash:  r.session_id_hash,
        event_kind:       r.event_kind,
        value:            Number(r.value),
        occurred_at:      Number(r.occurred_at),
      };
    });
    var nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
    return { rows: rows, next_cursor: nextCursor };
  }

  return {
    MAX_SLUG_LEN:       MAX_SLUG_LEN,
    MAX_TITLE_LEN:      MAX_TITLE_LEN,
    MAX_HYPOTHESIS_LEN: MAX_HYPOTHESIS_LEN,
    MAX_VARIANTS:       MAX_VARIANTS,
    MAX_WEIGHT:         MAX_WEIGHT,
    ALLOWED_STATUSES:   ALLOWED_STATUSES.slice(),
    ALLOWED_EVENT_KINDS: ALLOWED_EVENT_KINDS.slice(),
    TRANSITIONS:        TRANSITIONS,

    defineTest:            defineTest,
    getTest:               getTest,
    listTests:             listTests,
    getVariantForSession:  getVariantForSession,
    recordImpression:      recordImpression,
    recordClick:           recordClick,
    recordConversion:      recordConversion,
    metricsForTest:        metricsForTest,
    pauseTest:             pauseTest,
    resumeTest:            resumeTest,
    concludeTest:          concludeTest,
    archiveTest:           archiveTest,
    eventsForTest:         eventsForTest,
  };
}

module.exports = {
  create:             create,
  MAX_SLUG_LEN:       MAX_SLUG_LEN,
  MAX_TITLE_LEN:      MAX_TITLE_LEN,
  MAX_HYPOTHESIS_LEN: MAX_HYPOTHESIS_LEN,
  MAX_VARIANTS:       MAX_VARIANTS,
  MAX_WEIGHT:         MAX_WEIGHT,
  ALLOWED_STATUSES:   ALLOWED_STATUSES,
  ALLOWED_EVENT_KINDS: ALLOWED_EVENT_KINDS,
  TRANSITIONS:        TRANSITIONS,
};
