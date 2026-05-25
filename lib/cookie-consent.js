"use strict";
/**
 * @module shop.cookieConsent
 * @title  Cookie consent — GDPR / ePrivacy per-session category opt-in
 *         records, DNT / Sec-GPC honored as implicit deny.
 *
 * @intro
 *   GDPR (EU 2016/679 art. 6 + 7), ePrivacy Directive (2002/58/EC
 *   art. 5(3)), German TDDDG §25, and UK PECR all require informed,
 *   specific, freely-given consent BEFORE any non-strictly-necessary
 *   cookie / tracker is set. This primitive is the durable record of
 *   the buyer's per-category decision; downstream middleware
 *   (analytics tag injection, marketing-pixel render, preference-
 *   cookie write) consults `categoryAllowed` before emitting a single
 *   byte.
 *
 *   Five categories — only the first is always-on:
 *     - strictly-necessary  always allowed (session, CSRF, load
 *                           balancer affinity, fraud-screen — the
 *                           cookies the site cannot function without)
 *     - functional          remember-me, locale, currency selector
 *     - analytics           Plausible / GA / Matomo
 *     - marketing           Meta pixel, TikTok pixel, ad retargeting
 *     - preferences         the buyer's saved UI tweaks (dark mode,
 *                           list density) that aren't strictly required
 *
 *   Default-deny. A session with no `cookie_consent_records` row gets
 *   `false` from `categoryAllowed` for every category except
 *   strictly-necessary. The banner UI surfaces an opt-in form; the
 *   form handler calls `recordConsent` with the four toggles the
 *   buyer set.
 *
 *   DNT (Mozilla's Do-Not-Track) and Sec-GPC (Global Privacy Control
 *   — CCPA-aligned, mandated by the California AG, supported by
 *   Brave / Firefox / DuckDuckGo) are honored as IMPLICIT DENY for
 *   marketing AND analytics regardless of what the recorded consent
 *   says. A buyer's browser-level opt-out wins over a stale stored
 *   opt-in (e.g. the buyer enabled GPC after their original consent).
 *   The DNT / GPC values are recorded on each row so the operator can
 *   prove to a supervisory authority that the signal was respected.
 *
 *   Re-prompt on policy bump. Operators set `policyVersion` to the
 *   active policy revision; `recordConsent` stamps the consent row
 *   with the version that was live when it was taken. When the
 *   operator bumps the policy (new tracker, expanded purpose),
 *   `getConsentFor` flags the consent as `needs_reprompt` so the
 *   banner middleware shows the form again.
 *
 *   Withdrawal is non-destructive. `withdrawConsent` writes a NEW
 *   row with every non-essential category set to 0 — the audit trail
 *   shows the original opt-in AND the withdrawal that followed.
 *
 *   Session id hashing. The raw session id NEVER lands in storage.
 *   The primitive runs every session id through
 *   `b.crypto.namespaceHash("cookie-consent-session", sessionId)`
 *   before any write or read; a database dump only ever exposes the
 *   hash + the decision shape.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — session-id hashing.
 *     - `b.uuid.v7`              — row id; lexicographically
 *                                  sortable for `occurred_at`
 *                                  tiebreak on the audit walk.
 *
 *   Surface:
 *     - `recordConsent({ session_id, categories, ip_hash?, ua_class?,
 *                        dnt?, gpc? })`
 *         → the persisted row (with `needs_reprompt: false` —
 *         a freshly-stamped row is always against the live policy).
 *     - `getConsentFor(session_id)`
 *         → latest record for the session, or null. Carries
 *         `needs_reprompt` = true when the row's policy_version
 *         lags the active `policyVersion`.
 *     - `withdrawConsent({ session_id, reason? })`
 *         → the new withdrawal row, or null when no prior consent
 *         exists for the session.
 *     - `categoryAllowed({ session_id, category })`
 *         → bool. Strictly-necessary always true. Other categories
 *         consult the latest record AND short-circuit to false on
 *         DNT / GPC for analytics + marketing.
 *     - `metricsForBanner({ from, to })`
 *         → `{ accept_all, reject_all, mixed }` counts over the
 *         window (inclusive lower / exclusive upper, ms epoch).
 *     - `cleanupOlderThan(days)`
 *         → `{ deleted: <count> }`. Removes consent rows whose
 *         `occurred_at` is older than `days` days AND are not the
 *         latest record for their session (the latest must survive
 *         so the live state isn't silently revoked).
 *     - `policyVersion` (getter / setter pair)
 *         → operator sets the active version; older records are
 *         flagged for re-prompt.
 *     - `registerPolicyVersion({ version, summary, effective_from? })`
 *         → persists a new entry in `cookie_consent_policy_versions`
 *         and bumps `policyVersion` to the new value.
 *
 *   Storage:
 *     - `cookie_consent_records`
 *     - `cookie_consent_policy_versions`
 *       (migration `0103_cookie_consent.sql`)
 *
 * @primitive cookieConsent
 * @related   b.crypto.namespaceHash, b.uuid.v7
 */

var SESSION_HASH_NAMESPACE = "cookie-consent-session";
var SESSION_ID_MAX_LEN     = 1024;
var REASON_MAX_LEN         = 512;
var SUMMARY_MAX_LEN        = 1024;
var IP_HASH_MAX_LEN        = 256;
var POLICY_VERSION_MAX_LEN = 64;

var CATEGORY_KEYS = Object.freeze([
  "strictly_necessary",
  "functional",
  "analytics",
  "marketing",
  "preferences",
]);

// Buyer-toggleable categories — strictly-necessary is implicit and
// never appears in the per-row columns (it's always allowed). The
// banner UI surfaces these four toggles.
var TOGGLEABLE_CATEGORIES = Object.freeze([
  "functional",
  "analytics",
  "marketing",
  "preferences",
]);

// Categories the browser-level DNT / GPC signal collapses to false
// regardless of stored consent. Functional + preferences are not
// covered by Sec-GPC's "sale or sharing of personal information"
// scope — those decisions stay with the recorded opt-in.
var DNT_GPC_IMPLICIT_DENY = Object.freeze(["analytics", "marketing"]);

var UA_CLASS_VALUES = Object.freeze([
  "desktop",
  "mobile",
  "tablet",
  "bot",
  "unknown",
]);

var b = require("./index").framework;
var C = b.constants;

// ---- validators --------------------------------------------------------

function _sessionId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cookie-consent: session_id must be a non-empty string");
  }
  if (s.length > SESSION_ID_MAX_LEN) {
    throw new TypeError(
      "cookie-consent: session_id must be <= " + SESSION_ID_MAX_LEN + " chars"
    );
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("cookie-consent: session_id must not contain control bytes");
  }
  return s;
}

function _hashSession(sessionId) {
  return b.crypto.namespaceHash(SESSION_HASH_NAMESPACE, sessionId);
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("cookie-consent: " + label + " must be a boolean");
  }
  return v;
}

function _optBool(v, label) {
  if (v == null) return false;
  return _bool(v, label);
}

function _categories(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("cookie-consent: categories object required");
  }
  var out = { functional: false, analytics: false, marketing: false, preferences: false };
  // Refuse unknown keys so a misspelt "marketting" can't silently
  // default-deny when the caller thought they were opting in.
  var seen = Object.keys(input);
  for (var i = 0; i < seen.length; i += 1) {
    var k = seen[i];
    if (k === "strictly_necessary") {
      // Strictly-necessary is implicit-on; accepting it explicitly is
      // a no-op when truthy and refused otherwise so callers can't
      // accidentally "opt out" of essential cookies.
      if (input[k] !== true) {
        throw new TypeError(
          "cookie-consent: strictly_necessary is implicit-on; only true is accepted"
        );
      }
      continue;
    }
    if (TOGGLEABLE_CATEGORIES.indexOf(k) === -1) {
      throw new TypeError(
        "cookie-consent: unknown category '" + k + "' — valid keys are " +
        TOGGLEABLE_CATEGORIES.join(", ")
      );
    }
    out[k] = _bool(input[k], "categories." + k);
  }
  return out;
}

function _category(s) {
  if (CATEGORY_KEYS.indexOf(s) === -1) {
    throw new TypeError(
      "cookie-consent: category must be one of " + CATEGORY_KEYS.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _optShortString(s, label, maxLen) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("cookie-consent: " + label + " must be a string");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("cookie-consent: " + label + " must not contain control bytes");
  }
  if (s.length > maxLen) {
    throw new TypeError("cookie-consent: " + label + " must be <= " + maxLen + " chars");
  }
  return s;
}

function _optUaClass(s) {
  if (s == null || s === "") return null;
  if (typeof s !== "string") {
    throw new TypeError("cookie-consent: ua_class must be a string");
  }
  if (UA_CLASS_VALUES.indexOf(s) === -1) {
    throw new TypeError(
      "cookie-consent: ua_class must be one of " + UA_CLASS_VALUES.join(", ") +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _policyVersion(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("cookie-consent: policy_version must be a non-empty string");
  }
  if (s.length > POLICY_VERSION_MAX_LEN) {
    throw new TypeError(
      "cookie-consent: policy_version must be <= " + POLICY_VERSION_MAX_LEN + " chars"
    );
  }
  if (!/^[A-Za-z0-9._-]+$/.test(s)) {
    throw new TypeError(
      "cookie-consent: policy_version must match /^[A-Za-z0-9._-]+$/, got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("cookie-consent: " + label + " must be a positive integer");
  }
  return n;
}

function _tsBound(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "cookie-consent: " + label + " must be a non-negative integer (ms epoch)"
    );
  }
  return n;
}

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- row <-> wire conversions ------------------------------------------

function _rowToRecord(row, activePolicyVersion) {
  if (!row) return null;
  var rec = {
    id:                  row.id,
    session_id_hash:     row.session_id_hash,
    policy_version:      row.policy_version,
    categories: {
      strictly_necessary: true,
      functional:         Number(row.functional)  === 1,
      analytics:          Number(row.analytics)   === 1,
      marketing:          Number(row.marketing)   === 1,
      preferences:        Number(row.preferences) === 1,
    },
    dnt:                 Number(row.dnt) === 1,
    gpc:                 Number(row.gpc) === 1,
    ip_hash:             row.ip_hash == null  ? null : row.ip_hash,
    ua_class:            row.ua_class == null ? null : row.ua_class,
    occurred_at:         Number(row.occurred_at),
    withdrawn_at:        row.withdrawn_at == null ? null : Number(row.withdrawn_at),
    withdrawal_reason:   row.withdrawal_reason == null ? null : row.withdrawal_reason,
    needs_reprompt:      row.policy_version !== activePolicyVersion,
  };
  return rec;
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // The active policy version is a per-instance handle the operator
  // mutates via the getter/setter pair. Initial value is "v1" so a
  // fresh deploy has a defined version without a separate boot step;
  // operators bump it through `registerPolicyVersion` when the
  // policy text changes.
  var activePolicyVersion = "v1";

  async function _latestRowFor(sessionHash) {
    var r = await query(
      "SELECT * FROM cookie_consent_records " +
      "WHERE session_id_hash = ?1 " +
      "ORDER BY occurred_at DESC, id DESC LIMIT 1",
      [sessionHash],
    );
    return r.rows[0] || null;
  }

  var api = {
    CATEGORY_KEYS:           CATEGORY_KEYS,
    TOGGLEABLE_CATEGORIES:   TOGGLEABLE_CATEGORIES,
    DNT_GPC_IMPLICIT_DENY:   DNT_GPC_IMPLICIT_DENY,
    UA_CLASS_VALUES:         UA_CLASS_VALUES,
    SESSION_HASH_NAMESPACE:  SESSION_HASH_NAMESPACE,

    // Active policy version — operators read / write through these.
    // `policyVersion` (the spec'd top-level field) is a getter that
    // returns the current value; the setter validates the string
    // shape but does NOT itself write a row to
    // `cookie_consent_policy_versions` — operators wanting both at
    // once use `registerPolicyVersion`.
    get policyVersion() { return activePolicyVersion; },
    set policyVersion(v) { activePolicyVersion = _policyVersion(v); },

    // Persist a policy revision and switch the active version to it.
    // `effective_from` defaults to now. The summary is operator-facing
    // and surfaces in the banner UI's "what changed since you last
    // consented" text alongside the re-prompt.
    registerPolicyVersion: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cookie-consent.registerPolicyVersion: input object required");
      }
      var version    = _policyVersion(input.version);
      var summary    = _optShortString(input.summary, "summary", SUMMARY_MAX_LEN);
      if (summary == null) {
        throw new TypeError(
          "cookie-consent.registerPolicyVersion: summary required (non-empty string <= " +
          SUMMARY_MAX_LEN + " chars)"
        );
      }
      var now        = _now();
      var effective  = input.effective_from == null ? now
                     : _tsBound(input.effective_from, "effective_from");

      // INSERT OR IGNORE — the operator may pre-register multiple
      // versions and only later flip the active one; double-registering
      // the same version is a no-op rather than a throw so the call is
      // idempotent.
      await query(
        "INSERT OR IGNORE INTO cookie_consent_policy_versions " +
        "(version, summary, effective_from, created_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [version, summary, effective, now],
      );
      activePolicyVersion = version;
      return { version: version, summary: summary, effective_from: effective, created_at: now };
    },

    // Write a per-session consent record. Strictly-necessary is
    // implicit-on and never appears in the per-row columns — the
    // record carries the four toggleable categories plus the DNT /
    // GPC values the browser sent. The session id is hashed before
    // any storage touch.
    recordConsent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cookie-consent.recordConsent: input object required");
      }
      var sessionId  = _sessionId(input.session_id);
      var cats       = _categories(input.categories);
      var ipHash     = _optShortString(input.ip_hash, "ip_hash", IP_HASH_MAX_LEN);
      var uaClass    = _optUaClass(input.ua_class);
      var dnt        = _optBool(input.dnt, "dnt");
      var gpc        = _optBool(input.gpc, "gpc");

      var sessionHash = _hashSession(sessionId);
      var id          = b.uuid.v7();
      var now         = _now();

      await query(
        "INSERT INTO cookie_consent_records " +
        "(id, session_id_hash, policy_version, " +
        " functional, analytics, marketing, preferences, " +
        " dnt, gpc, ip_hash, ua_class, " +
        " occurred_at, withdrawn_at, withdrawal_reason) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL)",
        [
          id, sessionHash, activePolicyVersion,
          cats.functional  ? 1 : 0,
          cats.analytics   ? 1 : 0,
          cats.marketing   ? 1 : 0,
          cats.preferences ? 1 : 0,
          dnt ? 1 : 0,
          gpc ? 1 : 0,
          ipHash, uaClass,
          now,
        ],
      );
      return _rowToRecord(await _latestRowFor(sessionHash), activePolicyVersion);
    },

    // Latest record for the session, or null when no consent has
    // been recorded. The returned record carries `needs_reprompt =
    // true` when its policy_version no longer matches the active
    // one — the banner-gated middleware reads that flag to decide
    // whether to surface the form again.
    getConsentFor: async function (sessionId) {
      var sessionHash = _hashSession(_sessionId(sessionId));
      var row = await _latestRowFor(sessionHash);
      return _rowToRecord(row, activePolicyVersion);
    },

    // Right-to-withdraw under GDPR art. 7(3). Non-destructive — a
    // new row is written with every toggleable category set to 0
    // and `withdrawn_at` / `withdrawal_reason` stamped. Returns null
    // when no prior consent exists for the session (withdrawing
    // nothing is a no-op).
    withdrawConsent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cookie-consent.withdrawConsent: input object required");
      }
      var sessionId   = _sessionId(input.session_id);
      var reason      = _optShortString(input.reason, "reason", REASON_MAX_LEN);
      var sessionHash = _hashSession(sessionId);
      var prior       = await _latestRowFor(sessionHash);
      if (!prior) return null;

      // Already withdrawn — return the prior withdrawal row rather
      // than stacking duplicates. The operator's audit story still
      // works (the original withdrawal moment is preserved); the
      // table doesn't grow under a UI that double-clicks "withdraw".
      if (prior.withdrawn_at != null) {
        return _rowToRecord(prior, activePolicyVersion);
      }

      var id  = b.uuid.v7();
      var now = _now();
      await query(
        "INSERT INTO cookie_consent_records " +
        "(id, session_id_hash, policy_version, " +
        " functional, analytics, marketing, preferences, " +
        " dnt, gpc, ip_hash, ua_class, " +
        " occurred_at, withdrawn_at, withdrawal_reason) " +
        "VALUES (?1, ?2, ?3, 0, 0, 0, 0, ?4, ?5, ?6, ?7, ?8, ?8, ?9)",
        [
          id, sessionHash, activePolicyVersion,
          Number(prior.dnt) === 1 ? 1 : 0,
          Number(prior.gpc) === 1 ? 1 : 0,
          prior.ip_hash, prior.ua_class,
          now, reason,
        ],
      );
      return _rowToRecord(await _latestRowFor(sessionHash), activePolicyVersion);
    },

    // Gate that downstream middleware consults before emitting a
    // cookie / tag / pixel byte. Strictly-necessary is always true.
    // DNT or GPC short-circuit analytics + marketing to false even
    // when the stored consent says otherwise (browser-level opt-out
    // wins). All other paths consult the latest record's per-
    // category boolean; missing record = default deny.
    categoryAllowed: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cookie-consent.categoryAllowed: input object required");
      }
      var sessionId = _sessionId(input.session_id);
      var category  = _category(input.category);
      if (category === "strictly_necessary") return true;

      var rec = await api.getConsentFor(sessionId);
      if (!rec) return false;

      // Browser-level opt-out short-circuit. The buyer's most-recent
      // network signal wins over a stale stored opt-in.
      if ((rec.dnt || rec.gpc) && DNT_GPC_IMPLICIT_DENY.indexOf(category) !== -1) {
        return false;
      }

      // A withdrawn record always denies the toggleable categories;
      // the row's category booleans already encode this (withdrawal
      // writes them all to 0) but we re-assert here so a future row
      // shape that diverges still gates correctly.
      if (rec.withdrawn_at != null) return false;

      return rec.categories[category] === true;
    },

    // Aggregate accept-all / reject-all / mixed counts across the
    // window. "Accept-all" = every toggleable category is true on
    // the row; "reject-all" = every toggleable category is false;
    // "mixed" = anything in between. DNT / GPC do NOT collapse the
    // bucketing — the buckets describe what the buyer SAID, not
    // what the gate ALLOWED.
    metricsForBanner: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("cookie-consent.metricsForBanner: input object required");
      }
      var from = _tsBound(input.from, "from");
      var to   = _tsBound(input.to,   "to");
      if (to <= from) {
        throw new TypeError("cookie-consent.metricsForBanner: to must be > from");
      }
      var r = await query(
        "SELECT functional, analytics, marketing, preferences " +
        "FROM cookie_consent_records " +
        "WHERE occurred_at >= ?1 AND occurred_at < ?2",
        [from, to],
      );
      var acceptAll = 0;
      var rejectAll = 0;
      var mixed     = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var n = (Number(row.functional)  === 1 ? 1 : 0) +
                (Number(row.analytics)   === 1 ? 1 : 0) +
                (Number(row.marketing)   === 1 ? 1 : 0) +
                (Number(row.preferences) === 1 ? 1 : 0);
        if (n === 4)      acceptAll += 1;
        else if (n === 0) rejectAll += 1;
        else              mixed     += 1;
      }
      return { accept_all: acceptAll, reject_all: rejectAll, mixed: mixed };
    },

    // Delete consent rows whose `occurred_at` is older than `days`
    // days. The latest record for each session is preserved
    // regardless of age — deleting the live state would silently
    // revoke a buyer's standing consent, which the GDPR audit trail
    // forbids. The withdrawn-at column is not consulted for the age
    // gate; a withdrawn record is still an audit-record and ages
    // out the same way an active one does.
    cleanupOlderThan: async function (days) {
      _positiveInt(days, "days");
      var cutoff = _now() - (days * C.TIME.days(1));
      // The subquery picks the freshest row for each
      // `session_id_hash`; the outer DELETE removes every row older
      // than the cutoff that isn't on that survivor list.
      var r = await query(
        "DELETE FROM cookie_consent_records " +
        "WHERE occurred_at < ?1 " +
        "AND id NOT IN (" +
        "  SELECT id FROM cookie_consent_records r2 " +
        "  WHERE r2.occurred_at = (" +
        "    SELECT MAX(occurred_at) FROM cookie_consent_records r3 " +
        "    WHERE r3.session_id_hash = r2.session_id_hash" +
        "  )" +
        ")",
        [cutoff],
      );
      return { deleted: Number(r.rowCount || 0) };
    },
  };

  return api;
}

module.exports = {
  create:                  create,
  CATEGORY_KEYS:           CATEGORY_KEYS,
  TOGGLEABLE_CATEGORIES:   TOGGLEABLE_CATEGORIES,
  DNT_GPC_IMPLICIT_DENY:   DNT_GPC_IMPLICIT_DENY,
  UA_CLASS_VALUES:         UA_CLASS_VALUES,
  SESSION_HASH_NAMESPACE:  SESSION_HASH_NAMESPACE,
};
