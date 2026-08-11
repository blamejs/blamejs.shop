"use strict";
/**
 * @module shop.customerSurveys
 * @title  Customer satisfaction surveys — NPS / CSAT / CES / custom
 *
 * @intro
 *   Post-purchase feedback loop. An operator defines a survey via
 *   `defineSurvey({ slug, title, kind, trigger, questions })` once,
 *   then the application issues per-customer invitations against it
 *   in response to lifecycle events (delivery confirmed, support
 *   ticket closed, refund processed) or via a manual operator action.
 *   The invitation carries a single-use plaintext token shown to the
 *   customer exactly once; the storage column carries only the
 *   SHA3-512 namespace-hash of that token. The customer follows the
 *   link, submits answers, the primitive validates them against the
 *   survey's question shapes and records the response. Operators
 *   pull aggregates via `rollup({ slug })` which computes the
 *   kind-specific score (NPS = %promoters - %detractors; CSAT =
 *   %positive; CES = mean rating; custom = per-question aggregates).
 *
 *   Question shapes (each carries a stable `id` so a survey can
 *   evolve without breaking historical responses):
 *     - { id, kind: "rating",    label, required, max? }
 *         answer: integer in [0, max] (or [0, 10] for NPS-shaped)
 *     - { id, kind: "select",    label, required, options: [...] }
 *         answer: a string from the options[] set
 *     - { id, kind: "free_text", label, required, max? }
 *         answer: string <= max chars (default 2000)
 *
 *   Survey kinds:
 *     - "nps"    — primary question MUST be a `rating` with max 10;
 *                  rollup returns score in [-100, 100], promoter % +
 *                  passive % + detractor %.
 *     - "csat"   — primary question MUST be a `rating` with max 5;
 *                  rollup returns positive % (4 + 5) + mean rating.
 *     - "ces"    — primary question MUST be a `rating` with max 7;
 *                  rollup returns mean + per-bucket distribution.
 *     - "custom" — no shape constraint; rollup returns per-question
 *                  aggregates (mean for rating, top-k for select,
 *                  count for free_text).
 *
 *   Lifecycle (per invitation):
 *     issued -> responded   (submitResponse, FSM-guarded one-shot)
 *     issued -> expired     (expires_at < now; cleanupExpired sweeps)
 *     issued -> closed      (closeInvitation, operator-initiated
 *                            revoke before response)
 *
 *   Composes:
 *     - `b.crypto.generateBytes`   — 32-byte uniform draw for
 *                                    invitation plaintext.
 *     - `b.crypto.namespaceHash`   — SHA3-512 hash under the
 *                                    `customer-survey-invitation-token`
 *                                    namespace; the only thing stored.
 *     - `b.crypto.timingSafeEqual` — constant-time hex compare on
 *                                    submitResponse.
 *     - `b.guardUuid`              — UUID-shape validation for ids.
 *     - `b.uuid.v7`                — invitation + response row PKs
 *                                    (monotonic lexicographic so
 *                                    audit reads sort cleanly).
 *     - `b.safeSql`                — column allow-list for any
 *                                    operator-controlled SQL identifier.
 *
 *   Storage: `migrations-d1/0128_customer_surveys.sql` —
 *     `customer_surveys` + `survey_invitations` (FK CASCADE) +
 *     `survey_responses` (FK CASCADE).
 *
 * @primitive customerSurveys
 * @related   b.crypto, b.uuid, b.guardUuid
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var TOKEN_NAMESPACE          = "customer-survey-invitation-token";
var TOKEN_BYTE_LEN           = 32;
var TOKEN_PLAINTEXT_LEN      = 43;
var TOKEN_PLAINTEXT_RE       = /^[A-Za-z0-9_-]{43}$/;

var SLUG_RE                  = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
var QUESTION_ID_RE           = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

var KINDS                    = Object.freeze(["nps", "csat", "ces", "custom"]);
var TRIGGERS                 = Object.freeze([
  "after_delivery", "after_support_close", "after_refund", "manual",
]);
var QUESTION_KINDS           = Object.freeze(["rating", "select", "free_text"]);
var INVITATION_STATUSES      = Object.freeze(["issued", "responded", "expired", "closed"]);

var MAX_TITLE_LEN            = 200;
var MAX_LABEL_LEN            = 500;
var MAX_OPTION_LEN           = 200;
var MAX_OPTIONS              = 32;
var MAX_QUESTIONS            = 32;
var MAX_FREE_TEXT_LEN        = 2000;
var MAX_CLOSE_REASON_LEN     = 500;
var MAX_SOURCE_EVENT_LEN     = 200;

var DEFAULT_EXPIRES_HOURS    = 24 * 30;   // 30 days
var MIN_EXPIRES_HOURS        = 1;
var MAX_EXPIRES_HOURS        = 24 * 365;  // 1 year

var DEFAULT_LIMIT            = 50;
var MAX_LIMIT                = 500;


// NPS / CSAT / CES enforce a primary-question shape so the rollup
// math has something well-defined to bucket against. Custom surveys
// have no primary-question constraint.
var KIND_RATING_MAX          = Object.freeze({ nps: 10, csat: 5, ces: 7 });

// ---- monotonic clock ----------------------------------------------------
//
// Survey invitations + responses persist epoch-ms timestamps. Operators
// occasionally backfill responses (importing from a third-party tool,
// re-issuing a manual invitation). The strict-monotonic clock here
// guarantees that two same-millisecond `_now()` calls produce distinct
// integers so the row-ordering on `issued_at` / `occurred_at` is
// deterministic without an extra tiebreaker column. Tests that issue
// + submit in tight loops rely on this for ordering assertions.
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
    throw new TypeError("customerSurveys: " + (label || "slug") +
                         " must be lowercase alnum + dash, no leading/trailing dash, 1..100 chars");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("customerSurveys: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  textGuard.freeText(s, "customerSurveys: title", { bidiMarks: "allow" });
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) < 0) {
    throw new TypeError("customerSurveys: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _trigger(s) {
  if (typeof s !== "string" || TRIGGERS.indexOf(s) < 0) {
    throw new TypeError("customerSurveys: trigger must be one of " + TRIGGERS.join(", "));
  }
  return s;
}

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customerSurveys: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _sourceEventId(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string" || s.length > MAX_SOURCE_EVENT_LEN) {
    throw new TypeError("customerSurveys: source_event_id must be a string <= " + MAX_SOURCE_EVENT_LEN + " chars");
  }
  textGuard.freeText(s, "customerSurveys: source_event_id", { singleLine: "reject" });
  return s;
}

function _expiresInHours(n) {
  if (n == null) return DEFAULT_EXPIRES_HOURS;
  if (!Number.isInteger(n) || n < MIN_EXPIRES_HOURS || n > MAX_EXPIRES_HOURS) {
    throw new TypeError("customerSurveys: expires_in_hours must be an integer in [" +
                        MIN_EXPIRES_HOURS + ", " + MAX_EXPIRES_HOURS + "]");
  }
  return n;
}

function _closeReason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_CLOSE_REASON_LEN) {
    throw new TypeError("customerSurveys: reason must be a non-empty string <= " + MAX_CLOSE_REASON_LEN + " chars");
  }
  textGuard.freeText(s, "customerSurveys: reason", { bidiMarks: "allow" });
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError("customerSurveys: limit must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _epochOpt(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("customerSurveys: " + label + " must be a non-negative integer (ms epoch) or null");
  }
  return n;
}

// Validate the operator-authored questions[] array. Returns a
// canonical (deep-cloned) array so the stored JSON is independent
// of caller mutation.
function _questions(arr, kind) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("customerSurveys: questions must be a non-empty array");
  }
  if (arr.length > MAX_QUESTIONS) {
    throw new TypeError("customerSurveys: questions must contain <= " + MAX_QUESTIONS + " entries");
  }
  var seenIds = Object.create(null);
  var out     = [];
  for (var i = 0; i < arr.length; i += 1) {
    var q = arr[i];
    if (!q || typeof q !== "object") {
      throw new TypeError("customerSurveys: questions[" + i + "] must be an object");
    }
    if (typeof q.id !== "string" || !QUESTION_ID_RE.test(q.id)) {
      throw new TypeError("customerSurveys: questions[" + i + "].id must be lowercase alnum / underscore / dash, 1..64 chars");
    }
    if (seenIds[q.id]) {
      throw new TypeError("customerSurveys: questions[" + i + "].id duplicates a previous entry");
    }
    seenIds[q.id] = true;

    if (typeof q.kind !== "string" || QUESTION_KINDS.indexOf(q.kind) < 0) {
      throw new TypeError("customerSurveys: questions[" + i + "].kind must be one of " + QUESTION_KINDS.join(", "));
    }
    if (typeof q.label !== "string" || !q.label.length || q.label.length > MAX_LABEL_LEN) {
      throw new TypeError("customerSurveys: questions[" + i + "].label must be a non-empty string <= " + MAX_LABEL_LEN + " chars");
    }
    if (textGuard.hasCodepointThreat(q.label)) {
      throw new TypeError("customerSurveys: questions[" + i + "].label must not contain control bytes");
    }
    var required = q.required == null ? true : q.required;
    if (typeof required !== "boolean") {
      throw new TypeError("customerSurveys: questions[" + i + "].required must be a boolean");
    }

    var canonical = { id: q.id, kind: q.kind, label: q.label, required: required };

    if (q.kind === "rating") {
      var maxRating;
      if (q.max == null) {
        // Default rating max depends on the survey kind so an
        // operator who picked "nps" but forgot to set max on the
        // primary rating still gets the right scale.
        maxRating = KIND_RATING_MAX[kind] || 5;
      } else {
        if (!Number.isInteger(q.max) || q.max < 1 || q.max > 10) {
          throw new TypeError("customerSurveys: questions[" + i + "].max must be an integer in [1, 10]");
        }
        maxRating = q.max;
      }
      canonical.max = maxRating;
    } else if (q.kind === "select") {
      if (!Array.isArray(q.options) || q.options.length === 0) {
        throw new TypeError("customerSurveys: questions[" + i + "].options must be a non-empty array");
      }
      if (q.options.length > MAX_OPTIONS) {
        throw new TypeError("customerSurveys: questions[" + i + "].options must contain <= " + MAX_OPTIONS + " entries");
      }
      var seenOpts = Object.create(null);
      var opts     = [];
      for (var k = 0; k < q.options.length; k += 1) {
        var opt = q.options[k];
        if (typeof opt !== "string" || !opt.length || opt.length > MAX_OPTION_LEN) {
          throw new TypeError("customerSurveys: questions[" + i + "].options[" + k +
                              "] must be a non-empty string <= " + MAX_OPTION_LEN + " chars");
        }
        if (textGuard.hasCodepointThreat(opt)) {
          throw new TypeError("customerSurveys: questions[" + i + "].options[" + k +
                              "] must not contain control bytes");
        }
        if (seenOpts[opt]) {
          throw new TypeError("customerSurveys: questions[" + i + "].options[" + k +
                              "] duplicates a previous option");
        }
        seenOpts[opt] = true;
        opts.push(opt);
      }
      canonical.options = opts;
    } else {
      // free_text
      var maxLen;
      if (q.max == null) {
        maxLen = MAX_FREE_TEXT_LEN;
      } else {
        if (!Number.isInteger(q.max) || q.max < 1 || q.max > MAX_FREE_TEXT_LEN) {
          throw new TypeError("customerSurveys: questions[" + i + "].max must be an integer in [1, " +
                              MAX_FREE_TEXT_LEN + "]");
        }
        maxLen = q.max;
      }
      canonical.max = maxLen;
    }
    out.push(canonical);
  }

  // Kind-specific primary-question gate. The first question is the
  // canonical scoring question for NPS / CSAT / CES; the rollup
  // math depends on its shape.
  if (kind === "nps" || kind === "csat" || kind === "ces") {
    var primary = out[0];
    if (primary.kind !== "rating") {
      throw new TypeError("customerSurveys: kind '" + kind + "' requires questions[0].kind === 'rating'");
    }
    if (primary.max !== KIND_RATING_MAX[kind]) {
      throw new TypeError("customerSurveys: kind '" + kind + "' requires questions[0].max === " +
                          KIND_RATING_MAX[kind]);
    }
  }

  return out;
}

// Validate the customer-submitted answers map against the survey's
// question definitions. Returns a canonical (key-ordered) object so
// the stored JSON is independent of caller insertion order.
function _validateAnswers(answers, questions) {
  if (!answers || typeof answers !== "object") {
    throw new TypeError("customerSurveys: answers must be an object");
  }
  var byId = Object.create(null);
  for (var i = 0; i < questions.length; i += 1) byId[questions[i].id] = questions[i];

  // Refuse answers for unknown questions — defends against a stale
  // client that's holding a previous version of the survey, and
  // against a malicious caller trying to smuggle extra fields into
  // the stored JSON.
  var answerKeys = Object.keys(answers);
  for (var j = 0; j < answerKeys.length; j += 1) {
    if (!byId[answerKeys[j]]) {
      throw new TypeError("customerSurveys: answer references unknown question id " +
                          JSON.stringify(answerKeys[j]));
    }
  }

  var out = {};
  for (var k = 0; k < questions.length; k += 1) {
    var q = questions[k];
    var hasAnswer = Object.prototype.hasOwnProperty.call(answers, q.id);
    var a = hasAnswer ? answers[q.id] : undefined;

    if (!hasAnswer || a == null || a === "") {
      if (q.required) {
        throw new TypeError("customerSurveys: answer for required question " + JSON.stringify(q.id) + " is missing");
      }
      // Skip optional unanswered questions — they don't appear in
      // the stored answers object, so rollup math treats them as
      // an explicit non-response rather than a zero.
      continue;
    }

    if (q.kind === "rating") {
      if (typeof a !== "number" || !Number.isInteger(a) || a < 0 || a > q.max) {
        throw new TypeError("customerSurveys: answer for " + JSON.stringify(q.id) +
                            " must be an integer in [0, " + q.max + "]");
      }
      out[q.id] = a;
    } else if (q.kind === "select") {
      if (typeof a !== "string") {
        throw new TypeError("customerSurveys: answer for " + JSON.stringify(q.id) + " must be a string");
      }
      if (q.options.indexOf(a) < 0) {
        throw new TypeError("customerSurveys: answer for " + JSON.stringify(q.id) +
                            " must be one of " + q.options.join(", "));
      }
      out[q.id] = a;
    } else {
      // free_text
      if (typeof a !== "string") {
        throw new TypeError("customerSurveys: answer for " + JSON.stringify(q.id) + " must be a string");
      }
      if (a.length > q.max) {
        throw new TypeError("customerSurveys: answer for " + JSON.stringify(q.id) +
                            " must be <= " + q.max + " chars");
      }
      if (textGuard.hasCodepointThreat(a)) {
        throw new TypeError("customerSurveys: answer for " + JSON.stringify(q.id) +
                            " must not contain control bytes");
      }
      out[q.id] = a;
    }
  }
  return out;
}

// ---- token generation + hashing -----------------------------------------

// 32 random bytes -> 43-char base64url (no padding). Rendered
// manually so the primitive doesn't depend on a Buffer-side flag
// rename across Node minors. Routes through `b.crypto.toBase64Url`
// (linear-time built-in encoding) instead of the polynomial-ReDoS-
// shaped `.replace(/=+$/, "")` strip.
function _generateToken() {
  var buf = b.crypto.generateBytes(TOKEN_BYTE_LEN);
  return b.crypto.toBase64Url(buf);
}

function _canonicalToken(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("customerSurveys: token must be a non-empty string");
  }
  if (!TOKEN_PLAINTEXT_RE.test(input)) {
    throw new TypeError("customerSurveys: token must be 43 base64url characters");
  }
  return input;
}

function _hashToken(canonical) {
  return b.crypto.namespaceHash(TOKEN_NAMESPACE, canonical);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // ---- internal helpers -------------------------------------------------

  async function _surveyRow(slug) {
    var r = await query("SELECT * FROM customer_surveys WHERE slug = ?1", [slug]);
    return r.rows[0] || null;
  }

  function _decodeSurvey(row) {
    if (!row) return null;
    var questions;
    try { questions = JSON.parse(row.questions_json); }
    catch (_e) { questions = []; }
    return {
      slug:          row.slug,
      title:         row.title,
      kind:          row.kind,
      trigger:       row.trigger_event,
      questions:     questions,
      archived_at:   row.archived_at != null ? Number(row.archived_at) : null,
      created_at:    Number(row.created_at),
      updated_at:    Number(row.updated_at),
    };
  }

  function _decodeInvitation(row) {
    if (!row) return null;
    return {
      id:               row.id,
      survey_slug:      row.survey_slug,
      customer_id:      row.customer_id,
      source_event_id:  row.source_event_id,
      status:           row.status,
      expires_at:       Number(row.expires_at),
      issued_at:        Number(row.issued_at),
      responded_at:     row.responded_at != null ? Number(row.responded_at) : null,
      closed_at:        row.closed_at     != null ? Number(row.closed_at)     : null,
      closed_reason:    row.closed_reason,
    };
  }

  function _decodeResponse(row) {
    if (!row) return null;
    var answers;
    try { answers = JSON.parse(row.answers_json); }
    catch (_e) { answers = {}; }
    return {
      id:             row.id,
      invitation_id:  row.invitation_id,
      answers:        answers,
      occurred_at:    Number(row.occurred_at),
    };
  }

  // ---- defineSurvey -----------------------------------------------------

  async function defineSurvey(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerSurveys.defineSurvey: input object required");
    }
    var slug      = _slug(input.slug, "slug");
    var title     = _title(input.title);
    var kind      = _kind(input.kind);
    var trigger   = _trigger(input.trigger);
    var questions = _questions(input.questions, kind);

    var existing = await _surveyRow(slug);
    var ts       = _now();
    if (existing) {
      // Update path: the slug already exists. Operators evolve a
      // survey by re-issuing defineSurvey with the same slug — the
      // questions JSON is replaced atomically, but existing
      // invitations + responses retain their historical question
      // ids (which is why every question carries a stable id even
      // though defineSurvey allows the operator to reorder / extend
      // the list).
      if (existing.archived_at != null) {
        throw new TypeError("customerSurveys.defineSurvey: survey " + JSON.stringify(slug) + " is archived");
      }
      await query(
        "UPDATE customer_surveys " +
        "SET title = ?1, kind = ?2, trigger_event = ?3, questions_json = ?4, updated_at = ?5 " +
        "WHERE slug = ?6",
        [title, kind, trigger, JSON.stringify(questions), ts, slug],
      );
    } else {
      await query(
        "INSERT INTO customer_surveys " +
        "(slug, title, kind, trigger_event, questions_json, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
        [slug, title, kind, trigger, JSON.stringify(questions), ts],
      );
    }
    return _decodeSurvey(await _surveyRow(slug));
  }

  async function getSurvey(slug) {
    _slug(slug, "slug");
    return _decodeSurvey(await _surveyRow(slug));
  }

  // List defined surveys for the operator console, newest first. With
  // `{ active_only: true }` archived surveys are dropped; otherwise all are
  // returned so the console can show an archived filter.
  async function listSurveys(listOpts) {
    listOpts = listOpts || {};
    var sql, params;
    if (listOpts.active_only === true) {
      sql = "SELECT * FROM customer_surveys WHERE archived_at IS NULL ORDER BY updated_at DESC, slug ASC";
      params = [];
    } else {
      sql = "SELECT * FROM customer_surveys ORDER BY updated_at DESC, slug ASC";
      params = [];
    }
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeSurvey(r.rows[i]));
    return out;
  }

  async function archiveSurvey(slug) {
    _slug(slug, "slug");
    var ts = _now();
    var r = await query(
      "UPDATE customer_surveys SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await _surveyRow(slug);
      if (!existing) return null;
      return _decodeSurvey(existing);
    }
    return _decodeSurvey(await _surveyRow(slug));
  }

  // ---- issueInvitation --------------------------------------------------

  async function issueInvitation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerSurveys.issueInvitation: input object required");
    }
    var slug          = _slug(input.survey_slug, "survey_slug");
    var customerId    = _uuid(input.customer_id, "customer_id");
    var sourceEventId = _sourceEventId(input.source_event_id);
    var expiresHours  = _expiresInHours(input.expires_in_hours);

    var survey = await _surveyRow(slug);
    if (!survey) {
      throw new TypeError("customerSurveys.issueInvitation: survey " + JSON.stringify(slug) + " not found");
    }
    if (survey.archived_at != null) {
      throw new TypeError("customerSurveys.issueInvitation: survey " + JSON.stringify(slug) + " is archived");
    }

    var id          = b.uuid.v7();
    var plaintext   = _generateToken();
    var tokenHash   = _hashToken(plaintext);
    var issuedAt    = _now();
    var expiresAt   = issuedAt + (expiresHours * C.TIME.hours(1));

    await query(
      "INSERT INTO survey_invitations " +
      "(id, survey_slug, customer_id, token_hash, source_event_id, status, expires_at, " +
      " issued_at, responded_at, closed_at, closed_reason) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'issued', ?6, ?7, NULL, NULL, NULL)",
      [id, slug, customerId, tokenHash, sourceEventId, expiresAt, issuedAt],
    );

    // Plaintext token is returned EXACTLY ONCE here. Subsequent reads
    // of the invitation row never see it again — the storage column
    // carries only the SHA3-512 namespace-hash. Callers (email /
    // SMS dispatch) embed the plaintext in the invitation link and
    // discard it immediately after.
    return {
      invitation_id:   id,
      survey_slug:     slug,
      customer_id:     customerId,
      plaintext_token: plaintext,
      source_event_id: sourceEventId,
      status:          "issued",
      expires_at:      expiresAt,
      issued_at:       issuedAt,
    };
  }

  async function getInvitation(id) {
    _uuid(id, "id");
    var r = await query("SELECT * FROM survey_invitations WHERE id = ?1", [id]);
    return _decodeInvitation(r.rows[0]);
  }

  // Resolve an invitation + its parent survey from the single-use plaintext
  // token, for rendering the survey page (the token IS the access — no login
  // needed). Returns { invitation, survey } or null when the token matches
  // nothing. The caller inspects invitation.status / expires_at to decide
  // whether to render the form, a thank-you, or an expired/closed notice;
  // this read never mutates state. Constant-time hash compare mirrors
  // submitResponse so a malformed token can't be a timing oracle.
  async function previewByToken(token) {
    var canon = _canonicalToken(token);
    var hash  = _hashToken(canon);
    var r = await query("SELECT * FROM survey_invitations WHERE token_hash = ?1", [hash]);
    if (!r.rows.length) return null;
    var inv = r.rows[0];
    if (!b.crypto.timingSafeEqual(inv.token_hash, hash)) return null;
    var surveyRow = await _surveyRow(inv.survey_slug);
    if (!surveyRow) return null;
    return { invitation: _decodeInvitation(inv), survey: _decodeSurvey(surveyRow) };
  }

  async function invitationsForCustomer(customerId, listOpts) {
    var custId = _uuid(customerId, "customer_id");
    listOpts = listOpts || {};
    var limit = _limit(listOpts.limit);
    var cursor = listOpts.cursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor.length)) {
      throw new TypeError("customerSurveys.invitationsForCustomer: cursor must be a non-empty string when provided");
    }
    var sql = "SELECT * FROM survey_invitations WHERE customer_id = ?1";
    var params = [custId];
    var idx = 2;
    if (cursor != null) {
      // Cursor is the last-seen invitation id; v7 ids are lexicographically
      // monotonic (issued_at sits in the prefix), so a single `id < cursor`
      // over (id DESC) preserves total ordering — the same idiom
      // responsesForSurvey uses. Returning { rows, next_cursor } lets a
      // caller that needs the customer's COMPLETE invitation set — the
      // subject-access export — page to the end instead of stopping at the
      // first `limit`.
      sql += " AND id < ?" + idx; params.push(cursor); idx += 1;
    }
    sql += " ORDER BY id DESC LIMIT ?" + idx;
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeInvitation(r.rows[i]));
    var nextCursor = out.length === limit ? out[out.length - 1].id : null;
    return { rows: out, next_cursor: nextCursor };
  }

  // ---- submitResponse ---------------------------------------------------

  async function submitResponse(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerSurveys.submitResponse: input object required");
    }
    var token       = _canonicalToken(input.token);
    var occurredOpt = _epochOpt(input.occurred_at, "occurred_at");

    if (!input.answers || typeof input.answers !== "object") {
      throw new TypeError("customerSurveys.submitResponse: answers must be an object");
    }

    var hash = _hashToken(token);
    var r = await query(
      "SELECT * FROM survey_invitations WHERE token_hash = ?1",
      [hash],
    );
    if (!r.rows.length) {
      var miss = new Error("customerSurveys.submitResponse: invitation not found");
      miss.code = "SURVEY_INVITATION_NOT_FOUND";
      throw miss;
    }
    var invitation = r.rows[0];

    // Constant-time hex compare on the matched row's hash — belt-
    // and-braces over the SQL = match so any future schema change
    // that swaps the lookup for a collection scan still leaves no
    // micro-timing oracle.
    if (!b.crypto.timingSafeEqual(invitation.token_hash, hash)) {
      var mismatch = new Error("customerSurveys.submitResponse: invitation not found");
      mismatch.code = "SURVEY_INVITATION_NOT_FOUND";
      throw mismatch;
    }

    var nowTs = _now();
    var occurredAt = occurredOpt != null ? occurredOpt : nowTs;

    if (invitation.status === "responded") {
      var dupe = new Error("customerSurveys.submitResponse: invitation already responded");
      dupe.code = "SURVEY_INVITATION_ALREADY_RESPONDED";
      throw dupe;
    }
    if (invitation.status === "closed") {
      var closed = new Error("customerSurveys.submitResponse: invitation has been closed");
      closed.code = "SURVEY_INVITATION_CLOSED";
      throw closed;
    }
    if (invitation.status === "expired" || Number(invitation.expires_at) < nowTs) {
      var expired = new Error("customerSurveys.submitResponse: invitation has expired");
      expired.code = "SURVEY_INVITATION_EXPIRED";
      throw expired;
    }

    var surveyRow = await _surveyRow(invitation.survey_slug);
    if (!surveyRow) {
      // Schema CASCADE on the FK should make this unreachable, but
      // guard so a hand-deleted survey row produces a clean error.
      var noSurvey = new Error("customerSurveys.submitResponse: parent survey is missing");
      noSurvey.code = "SURVEY_NOT_FOUND";
      throw noSurvey;
    }
    var questions = JSON.parse(surveyRow.questions_json);

    var canonicalAnswers = _validateAnswers(input.answers, questions);

    // Atomic claim: flip 'issued' -> 'responded' guarded by the
    // observed status in the WHERE before recording the response. The
    // JS status checks above give precise typed errors for the
    // sequential case, but two concurrent submits on the same token
    // both pass those checks (each reads status='issued'); only this
    // conditional UPDATE can win. SQLite/D1 serializes writers, so
    // exactly one submit sees rowCount===1 and is allowed to INSERT
    // the response row — the loser sees rowCount===0 and refuses,
    // so the response is recorded exactly once (no duplicate
    // survey_responses row, no double-counted rollup).
    var claim = await query(
      "UPDATE survey_invitations SET status = 'responded', responded_at = ?1 " +
      "WHERE id = ?2 AND status = 'issued'",
      [nowTs, invitation.id],
    );
    if (!b.sql.casWon(claim).won) {
      var raced = new Error("customerSurveys.submitResponse: invitation already responded");
      raced.code = "SURVEY_INVITATION_ALREADY_RESPONDED";
      throw raced;
    }

    var responseId = b.uuid.v7();
    try {
      await query(
        "INSERT INTO survey_responses (id, invitation_id, answers_json, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [responseId, invitation.id, JSON.stringify(canonicalAnswers), occurredAt],
      );
    } catch (insErr) {
      // The claim above already flipped the invitation to 'responded'. If
      // the response insert fails (a transient D1/SQLite write error),
      // revert the claim to 'issued' so the invitation stays retryable —
      // otherwise it is stranded 'responded' with no response row and
      // every retry is rejected as ALREADY_RESPONDED, so the response can
      // never be recorded.
      await query(
        "UPDATE survey_invitations SET status = 'issued', responded_at = NULL " +
        "WHERE id = ?1 AND status = 'responded'",
        [invitation.id],
      );
      throw insErr;
    }

    return {
      response_id:    responseId,
      invitation_id:  invitation.id,
      survey_slug:    invitation.survey_slug,
      customer_id:    invitation.customer_id,
      answers:        canonicalAnswers,
      occurred_at:    occurredAt,
      responded_at:   nowTs,
    };
  }

  // ---- responsesForSurvey -----------------------------------------------

  async function responsesForSurvey(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerSurveys.responsesForSurvey: input object required");
    }
    var slug = _slug(input.slug, "slug");
    var from = _epochOpt(input.from, "from");
    var to   = _epochOpt(input.to,   "to");
    if (from != null && to != null && from > to) {
      throw new TypeError("customerSurveys.responsesForSurvey: from must be <= to");
    }
    var limit  = _limit(input.limit);
    var cursor = input.cursor;
    if (cursor != null && (typeof cursor !== "string" || !cursor.length)) {
      throw new TypeError("customerSurveys.responsesForSurvey: cursor must be a non-empty string when provided");
    }

    var sql = "SELECT r.* FROM survey_responses r " +
              "JOIN survey_invitations i ON i.id = r.invitation_id " +
              "WHERE i.survey_slug = ?1";
    var params = [slug];
    var idx = 2;
    if (from != null) {
      sql += " AND r.occurred_at >= ?" + idx; params.push(from); idx += 1;
    }
    if (to != null) {
      sql += " AND r.occurred_at <= ?" + idx; params.push(to); idx += 1;
    }
    if (cursor != null) {
      // Cursor is the last-seen response id. Sort is (occurred_at DESC,
      // id DESC) so the cursor predicate is (id < cursor) at equal
      // occurred_at — but we use a simple `id < cursor` over the
      // lexicographically-monotonic v7 id, which already encodes
      // occurred_at in its prefix. This collapses the cursor logic
      // to one comparison without losing total ordering.
      sql += " AND r.id < ?" + idx; params.push(cursor); idx += 1;
    }
    sql += " ORDER BY r.id DESC LIMIT ?" + idx;
    params.push(limit);

    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_decodeResponse(r.rows[i]));
    var nextCursor = out.length === limit ? out[out.length - 1].id : null;
    return { rows: out, next_cursor: nextCursor };
  }

  // ---- rollup -----------------------------------------------------------

  async function rollup(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerSurveys.rollup: input object required");
    }
    var slug = _slug(input.slug, "slug");
    var from = _epochOpt(input.from, "from");
    var to   = _epochOpt(input.to,   "to");
    if (from != null && to != null && from > to) {
      throw new TypeError("customerSurveys.rollup: from must be <= to");
    }

    var surveyRow = await _surveyRow(slug);
    if (!surveyRow) return null;
    var survey = _decodeSurvey(surveyRow);

    var sql = "SELECT r.answers_json FROM survey_responses r " +
              "JOIN survey_invitations i ON i.id = r.invitation_id " +
              "WHERE i.survey_slug = ?1";
    var params = [slug];
    var idx = 2;
    if (from != null) { sql += " AND r.occurred_at >= ?" + idx; params.push(from); idx += 1; }
    if (to   != null) { sql += " AND r.occurred_at <= ?" + idx; params.push(to);   idx += 1; }
    var r = await query(sql, params);

    var responseCount = r.rows.length;

    // Per-question aggregate buckets seeded from the survey shape so
    // a question with zero answers still appears in the rollup with
    // a count of 0.
    var perQuestion = Object.create(null);
    for (var i = 0; i < survey.questions.length; i += 1) {
      var q = survey.questions[i];
      var seed;
      if (q.kind === "rating") {
        seed = { kind: "rating", id: q.id, max: q.max, count: 0, sum: 0, mean: 0, buckets: {} };
      } else if (q.kind === "select") {
        seed = { kind: "select", id: q.id, options: q.options.slice(), count: 0, buckets: {} };
        for (var j = 0; j < q.options.length; j += 1) seed.buckets[q.options[j]] = 0;
      } else {
        seed = { kind: "free_text", id: q.id, count: 0 };
      }
      perQuestion[q.id] = seed;
    }

    for (var k = 0; k < r.rows.length; k += 1) {
      var answers;
      try { answers = JSON.parse(r.rows[k].answers_json); }
      catch (_e) { answers = {}; }
      var keys = Object.keys(answers);
      for (var m = 0; m < keys.length; m += 1) {
        var ansKey = keys[m];
        var bucket = perQuestion[ansKey];
        if (!bucket) continue;   // historical answer for since-removed question
        var val = answers[ansKey];
        if (bucket.kind === "rating") {
          if (typeof val !== "number") continue;
          bucket.count += 1;
          bucket.sum   += val;
          bucket.buckets[String(val)] = (bucket.buckets[String(val)] || 0) + 1;
        } else if (bucket.kind === "select") {
          if (typeof val !== "string") continue;
          bucket.count += 1;
          bucket.buckets[val] = (bucket.buckets[val] || 0) + 1;
        } else {
          if (typeof val !== "string") continue;
          bucket.count += 1;
        }
      }
    }

    // Finalize: compute mean for rating buckets.
    var perQuestionList = [];
    for (var pq = 0; pq < survey.questions.length; pq += 1) {
      var qid    = survey.questions[pq].id;
      var entry  = perQuestion[qid];
      if (entry.kind === "rating" && entry.count > 0) {
        entry.mean = entry.sum / entry.count;
      }
      perQuestionList.push(entry);
    }

    var out = {
      slug:           slug,
      kind:           survey.kind,
      from:           from,
      to:             to,
      response_count: responseCount,
      per_question:   perQuestionList,
    };

    // Kind-specific score on top of the primary (questions[0]) rating
    // bucket. Empty-response case: every score is 0 (or null where
    // mean would divide by zero) so the operator can distinguish "no
    // responses yet" from "responses with poor scores".
    var primary = perQuestionList[0];
    if (survey.kind === "nps" && primary && primary.kind === "rating") {
      // Promoters = 9-10, passives = 7-8, detractors = 0-6 (the
      // canonical NPS definition).
      var promoters = 0; var passives = 0; var detractors = 0;
      var ratingKeys = Object.keys(primary.buckets);
      for (var rk = 0; rk < ratingKeys.length; rk += 1) {
        var ratingVal = parseInt(ratingKeys[rk], 10);
        var ratingCnt = primary.buckets[ratingKeys[rk]];
        if (ratingVal >= 9)      promoters  += ratingCnt;
        else if (ratingVal >= 7) passives   += ratingCnt;
        else                     detractors += ratingCnt;
      }
      var total = promoters + passives + detractors;
      if (total === 0) {
        out.nps               = { score: 0, promoter_pct: 0, passive_pct: 0, detractor_pct: 0,
                                  promoters: 0, passives: 0, detractors: 0 };
      } else {
        var promoPct = (promoters  / total) * 100;
        var passPct  = (passives   / total) * 100;
        var detPct   = (detractors / total) * 100;
        out.nps = {
          score:         Math.round(promoPct - detPct),
          promoter_pct:  Math.round(promoPct * 10) / 10,
          passive_pct:   Math.round(passPct  * 10) / 10,
          detractor_pct: Math.round(detPct   * 10) / 10,
          promoters:     promoters,
          passives:      passives,
          detractors:    detractors,
        };
      }
    } else if (survey.kind === "csat" && primary && primary.kind === "rating") {
      // Positive = 4-5 on a 1-5 scale (CSAT convention). Top-2-box.
      var pos = 0; var neg = 0; var neu = 0;
      var csatKeys = Object.keys(primary.buckets);
      for (var ck = 0; ck < csatKeys.length; ck += 1) {
        var csatVal = parseInt(csatKeys[ck], 10);
        var csatCnt = primary.buckets[csatKeys[ck]];
        if (csatVal >= 4)      pos += csatCnt;
        else if (csatVal === 3) neu += csatCnt;
        else                    neg += csatCnt;
      }
      var csatTotal = pos + neu + neg;
      out.csat = csatTotal === 0
        ? { positive_pct: 0, mean: 0, positives: 0, neutrals: 0, negatives: 0 }
        : {
            positive_pct: Math.round((pos / csatTotal) * 1000) / 10, // allow:raw-time-literal — percentage scaling factor, not a duration

            mean:         Math.round(primary.mean * 100) / 100,
            positives:    pos,
            neutrals:     neu,
            negatives:    neg,
          };
    } else if (survey.kind === "ces" && primary && primary.kind === "rating") {
      // CES uses the mean of the 1-7 effort score directly. Lower
      // = less effort; 5+ counts as "agree the experience was easy."
      var cesAgree = 0;
      var cesKeys = Object.keys(primary.buckets);
      for (var sk = 0; sk < cesKeys.length; sk += 1) {
        var cesVal = parseInt(cesKeys[sk], 10);
        if (cesVal >= 5) cesAgree += primary.buckets[cesKeys[sk]];
      }
      out.ces = primary.count === 0
        ? { mean: 0, agree_pct: 0, agree: 0 }
        : {
            mean:      Math.round(primary.mean * 100) / 100,
            agree_pct: Math.round((cesAgree / primary.count) * 1000) / 10, // allow:raw-time-literal — percentage scaling factor, not a duration

            agree:     cesAgree,
          };
    }

    return out;
  }

  // ---- closeInvitation --------------------------------------------------

  async function closeInvitation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("customerSurveys.closeInvitation: input object required");
    }
    var id     = _uuid(input.invitation_id, "invitation_id");
    var reason = _closeReason(input.reason);
    var ts     = _now();

    var existing = await query("SELECT * FROM survey_invitations WHERE id = ?1", [id]);
    if (!existing.rows.length) return null;
    var row = existing.rows[0];
    if (row.status !== "issued") {
      // Already responded / expired / closed — refuse so a caller
      // can distinguish a successful close from a no-op.
      var bad = new Error("customerSurveys.closeInvitation: invitation status is " + row.status);
      bad.code = "SURVEY_INVITATION_NOT_ISSUED";
      throw bad;
    }
    await query(
      "UPDATE survey_invitations SET status = 'closed', closed_at = ?1, closed_reason = ?2 " +
      "WHERE id = ?3 AND status = 'issued'",
      [ts, reason, id],
    );
    var fresh = await query("SELECT * FROM survey_invitations WHERE id = ?1", [id]);
    return _decodeInvitation(fresh.rows[0]);
  }

  // ---- cleanupExpired ---------------------------------------------------

  async function cleanupExpired(cleanupOpts) {
    cleanupOpts = cleanupOpts || {};
    var nowTs = cleanupOpts.now != null ? _epochOpt(cleanupOpts.now, "now") : _now();
    if (nowTs == null) nowTs = _now();
    var r = await query(
      "UPDATE survey_invitations SET status = 'expired' " +
      "WHERE status = 'issued' AND expires_at < ?1",
      [nowTs],
    );
    return { expired_count: Number(r.rowCount || 0) };
  }

  return {
    KINDS:                   KINDS.slice(),
    TRIGGERS:                TRIGGERS.slice(),
    QUESTION_KINDS:          QUESTION_KINDS.slice(),
    INVITATION_STATUSES:     INVITATION_STATUSES.slice(),
    TOKEN_NAMESPACE:         TOKEN_NAMESPACE,
    TOKEN_PLAINTEXT_LEN:     TOKEN_PLAINTEXT_LEN,
    DEFAULT_EXPIRES_HOURS:   DEFAULT_EXPIRES_HOURS,
    MAX_QUESTIONS:           MAX_QUESTIONS,
    MAX_FREE_TEXT_LEN:       MAX_FREE_TEXT_LEN,

    defineSurvey:            defineSurvey,
    getSurvey:               getSurvey,
    archiveSurvey:           archiveSurvey,
    issueInvitation:         issueInvitation,
    getInvitation:           getInvitation,
    previewByToken:          previewByToken,
    listSurveys:             listSurveys,
    invitationsForCustomer:  invitationsForCustomer,
    submitResponse:          submitResponse,
    responsesForSurvey:      responsesForSurvey,
    rollup:                  rollup,
    closeInvitation:         closeInvitation,
    cleanupExpired:          cleanupExpired,
  };
}

module.exports = {
  create:                  create,
  KINDS:                   KINDS,
  TRIGGERS:                TRIGGERS,
  QUESTION_KINDS:          QUESTION_KINDS,
  INVITATION_STATUSES:     INVITATION_STATUSES,
  TOKEN_NAMESPACE:         TOKEN_NAMESPACE,
  TOKEN_PLAINTEXT_LEN:     TOKEN_PLAINTEXT_LEN,
  DEFAULT_EXPIRES_HOURS:   DEFAULT_EXPIRES_HOURS,
};
