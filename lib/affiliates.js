"use strict";
/**
 * @module shop.affiliates
 * @title  Affiliates primitive — partner program with attribution +
 *         commission events
 *
 * @intro
 *   Each affiliate is registered with a payout rule
 *   (commission_kind + commission_value) and gets a unique URL-safe
 *   tracking code. The storefront route handler accepts `?ref=<code>`,
 *   calls `recordVisit({ code, visitor_session_id })`, and persists
 *   the attribution against a SHA3-512 hash of the visitor session id
 *   (raw session ids never reach storage). At checkout the order
 *   handler resolves the latest live attribution via
 *   `attributionForSession(visitor_session_id)`; if one resolves
 *   inside the affiliate's attribution_window_days, the post-checkout
 *   hook calls `recordCommissionEvent` to write the commission row.
 *
 *   Commission math:
 *
 *     percent_bps               commission_minor = floor(order_total_minor * value / 10000)
 *     amount_per_order_minor    commission_minor = value
 *     amount_per_signup_minor   commission_minor = value
 *
 *   Operators payout via a separate finance process that walks
 *   `payoutsDue({ as_of, min_payout_minor })`, issues the payment,
 *   then calls `markCommissionPaid` per commission_event_id with the
 *   payment-network reference. Refunds / chargebacks call
 *   `markCommissionVoided` which preserves the row for audit but
 *   removes it from the payouts-due sum.
 *
 *   Composes:
 *     - `b.guardUuid`          — UUID-shape validation for ids
 *     - `b.guardEmail`         — strict-profile validate + sanitize
 *     - `b.crypto.generateBytes` — uniform draw for code generation
 *     - `b.crypto.namespaceHash` — email + session-id hashing (SHA3-512)
 *     - `b.uuid.v7`            — row ids
 *     - `b.pagination`         — HMAC-tagged tuple cursors for
 *                                commissionsForAffiliate
 *
 *   Surface:
 *     registerAffiliate({ name, email, payout_method, payout_address,
 *                         commission_kind, commission_value,
 *                         attribution_window_days })
 *     getAffiliate(affiliate_id) / affiliateByCode(code)
 *     listAffiliates({ active_only? })
 *     updateAffiliate(affiliate_id, patch) /
 *     pauseAffiliate(affiliate_id, { reason? }) /
 *     reinstateAffiliate(affiliate_id)
 *     recordVisit({ code, visitor_session_id, referrer?, occurred_at? })
 *     attributionForSession(visitor_session_id, { now? })
 *     recordCommissionEvent({ order_id, affiliate_id,
 *                             order_total_minor, currency, occurred_at? })
 *     commissionsForAffiliate({ affiliate_id, from?, to?,
 *                               status_filter?, cursor?, limit? })
 *     markCommissionPaid({ commission_event_id, paid_at,
 *                          payout_reference })
 *     markCommissionVoided({ commission_event_id, reason })
 *     payoutsDue({ as_of, min_payout_minor })
 *     topAffiliates({ from, to, limit? })
 *
 *   Storage:
 *     - `affiliates` + `affiliate_visits` + `affiliate_commissions`
 *       (migration `0057_affiliates.sql`).
 *
 * @primitive affiliates
 * @related   b.guardUuid, b.guardEmail, b.crypto, b.pagination, b.uuid
 */

var MAX_NAME_LEN          = 200;
var MAX_PAYOUT_ADDRESS_LEN = 512;
var MAX_REFERRER_LEN       = 2048;
var MAX_REASON_LEN         = 280;
var MAX_PAYOUT_REF_LEN     = 256;
var MAX_LIST_LIMIT         = 100;
var DEFAULT_LIST_LIMIT     = 25;
var MAX_TOP_LIMIT          = 100;
var DEFAULT_TOP_LIMIT      = 10;
var MAX_WINDOW_DAYS        = 365;

var EMAIL_NAMESPACE   = "affiliate-email";
var SESSION_NAMESPACE = "affiliate-session";

var PAYOUT_METHODS = [
  "paypal", "bank_transfer", "stripe_connect", "gift_card", "store_credit",
];
var COMMISSION_KINDS = [
  "percent_bps", "amount_per_order_minor", "amount_per_signup_minor",
];
var COMMISSION_STATUSES = ["pending", "paid", "voided"];

var BPS_DENOMINATOR = 10000;
var MAX_BPS         = 10000;
var MAX_AMOUNT_MINOR = 100000000000; // 1e11 — sanity cap on per-row
                                     // payouts; an operator wiring a
                                     // commission_value bigger than
                                     // this is mis-configured.

// commissionsForAffiliate ordering — (occurred_at DESC, id DESC). The
// tuple is HMAC-tagged via b.pagination so a tampered cursor refuses
// to decode.
var LIST_ORDER_KEY = ["occurred_at:desc", "id:desc"];

// Public handle alphabet — confusion-resistant (no 0/O/I/1), 32
// glyphs so a single random byte maps modulo-32 to a uniform draw.
// 8 characters of 32-glyph alphabet = 32^8 ≈ 2^40 codes; collision
// probability is vanishingly low and the UNIQUE constraint is the
// safety net. Mirrors the referrals primitive's posture so operator
// vocabularies stay consistent.
var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var CODE_LEN      = 8;
var CODE_RE       = /^[A-HJ-NP-Z2-9]{8}$/;

// Control bytes + zero-width / direction-override family. The name +
// reason + payout_address render in operator dashboards; embedded
// control / direction-override bytes are a slipping-class for header
// injection + visual-spoofing attacks downstream. Spelled with
// \u-escapes so ESLint's no-irregular-whitespace stays happy.
var CONTROL_BYTE_STRICT_RE = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_LOOSE_RE  = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "name", "payout_method", "payout_address", "commission_kind",
  "commission_value", "attribution_window_days",
]);

// Framework handle (the vendored blamejs); index.js re-exports this as .framework.
var b = require("./vendor/blamejs");
var C = b.constants;

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("affiliates: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _name(s) {
  if (typeof s !== "string") {
    throw new TypeError("affiliates: name must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("affiliates: name must be non-empty after trim");
  }
  if (s.length > MAX_NAME_LEN) {
    throw new TypeError("affiliates: name must be <= " + MAX_NAME_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("affiliates: name contains control / zero-width bytes");
  }
  return s;
}

function _payoutMethod(s) {
  if (typeof s !== "string" || PAYOUT_METHODS.indexOf(s) === -1) {
    throw new TypeError("affiliates: payout_method must be one of " + PAYOUT_METHODS.join(", "));
  }
  return s;
}

function _payoutAddress(s) {
  if (typeof s !== "string") {
    throw new TypeError("affiliates: payout_address must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("affiliates: payout_address must be non-empty after trim");
  }
  if (s.length > MAX_PAYOUT_ADDRESS_LEN) {
    throw new TypeError("affiliates: payout_address must be <= " + MAX_PAYOUT_ADDRESS_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("affiliates: payout_address contains control / zero-width bytes");
  }
  return s;
}

function _commissionKind(s) {
  if (typeof s !== "string" || COMMISSION_KINDS.indexOf(s) === -1) {
    throw new TypeError("affiliates: commission_kind must be one of " + COMMISSION_KINDS.join(", "));
  }
  return s;
}

function _commissionValue(n, kind) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("affiliates: commission_value must be a non-negative integer");
  }
  if (kind === "percent_bps" && n > MAX_BPS) {
    throw new TypeError("affiliates: commission_value (percent_bps) must be <= " + MAX_BPS + " (100%)");
  }
  if (kind !== "percent_bps" && n > MAX_AMOUNT_MINOR) {
    throw new TypeError("affiliates: commission_value must be <= " + MAX_AMOUNT_MINOR);
  }
  return n;
}

function _attributionWindow(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_WINDOW_DAYS) {
    throw new TypeError("affiliates: attribution_window_days must be an integer 1.." + MAX_WINDOW_DAYS);
  }
  return n;
}

function _status(s, label) {
  if (typeof s !== "string" || COMMISSION_STATUSES.indexOf(s) === -1) {
    throw new TypeError("affiliates: " + label + " must be one of " + COMMISSION_STATUSES.join(", "));
  }
  return s;
}

function _orderTotal(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("affiliates: order_total_minor must be a non-negative integer");
  }
  if (n > MAX_AMOUNT_MINOR) {
    throw new TypeError("affiliates: order_total_minor must be <= " + MAX_AMOUNT_MINOR);
  }
  return n;
}

function _currency(s) {
  if (typeof s !== "string" || !/^[A-Z]{3}$/.test(s)) {
    throw new TypeError("affiliates: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _referrer(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("affiliates: referrer must be a string or null");
  }
  if (!s.length) return null;
  if (s.length > MAX_REFERRER_LEN) {
    throw new TypeError("affiliates: referrer must be <= " + MAX_REFERRER_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("affiliates: referrer contains control / zero-width bytes");
  }
  return s;
}

function _reason(r) {
  if (r == null) return null;
  if (typeof r !== "string") {
    throw new TypeError("affiliates: reason must be a string or null");
  }
  if (!r.length) return null;
  if (r.length > MAX_REASON_LEN) {
    throw new TypeError("affiliates: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  if (CONTROL_BYTE_LOOSE_RE.test(r) || ZERO_WIDTH_RE.test(r)) {
    throw new TypeError("affiliates: reason contains control / zero-width bytes");
  }
  return r;
}

function _payoutReference(s) {
  if (typeof s !== "string") {
    throw new TypeError("affiliates: payout_reference must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("affiliates: payout_reference must be non-empty after trim");
  }
  if (s.length > MAX_PAYOUT_REF_LEN) {
    throw new TypeError("affiliates: payout_reference must be <= " + MAX_PAYOUT_REF_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("affiliates: payout_reference contains control / zero-width bytes");
  }
  return s;
}

function _limit(n, max, def) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("affiliates: limit must be an integer 1..." + max);
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("affiliates." + label + ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("affiliates." + label + ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError("affiliates." + label + ": from must be <= to");
  }
}

function _sessionId(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("affiliates: visitor_session_id must be a non-empty string");
  }
  if (s.length > 512) {
    throw new TypeError("affiliates: visitor_session_id must be <= 512 characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("affiliates: visitor_session_id contains control / zero-width bytes");
  }
  return s;
}

function _normalizeEmail(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("affiliates: email must be a non-empty string");
  }
  var guardEmail = b.guardEmail;
  var report;
  try {
    report = guardEmail.validate(input, { profile: "strict" });
  } catch (e) {
    throw new TypeError("affiliates: email — " + (e && e.message || "invalid email"));
  }
  if (!report || report.ok === false) {
    var first = (report && report.issues && report.issues[0]) || {};
    throw new TypeError("affiliates: email — " + (first.snippet || first.ruleId || "refused at strict profile"));
  }
  var canonical;
  try {
    canonical = guardEmail.sanitize(input, { profile: "strict" });
  } catch (e2) {
    throw new TypeError("affiliates: email — " + (e2 && e2.message || "refused"));
  }
  return canonical.trim().toLowerCase();
}

function _now() { return Date.now(); }

// ---- code generation + canonicalization ---------------------------------

function _generateCode() {
  var buf = b.crypto.generateBytes(CODE_LEN);
  var out = "";
  for (var j = 0; j < CODE_LEN; j += 1) {
    out += CODE_ALPHABET.charAt(buf[j] & 31);
  }
  return out;
}

function _canonicalCode(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("affiliates: code must be a non-empty string");
  }
  // Forgiving for hand-typed codes pasted from email — strip ASCII
  // whitespace + hyphens, fold to uppercase before the regex check.
  var stripped = input.replace(/[-\s]+/g, "").toUpperCase();
  if (stripped.length !== CODE_LEN) {
    throw new TypeError("affiliates: code must be " + CODE_LEN + " alphabet characters");
  }
  if (!CODE_RE.test(stripped)) {
    throw new TypeError("affiliates: code contains characters outside the affiliate alphabet");
  }
  return stripped;
}

// ---- commission math ----------------------------------------------------

function _computeCommissionMinor(kind, value, orderTotalMinor) {
  if (kind === "percent_bps") {
    // Floor division on integers keeps the rounding consistent across
    // platforms; the operator absorbs the sub-cent dust (alternative
    // is rounding up, which lets a clever affiliate over-claim by
    // splitting orders).
    return Math.floor((orderTotalMinor * value) / BPS_DENOMINATOR);
  }
  // amount_per_order_minor and amount_per_signup_minor are flat — the
  // order_total_minor parameter is ignored beyond bounds-checking.
  return value;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pagination cursors are HMAC-tagged via b.pagination so a caller
  // can't hand-craft one to skip across affiliates or replay across
  // deployments. The secret defaults to a dev-only placeholder so the
  // primitive boots in tests; production deployments must supply a
  // derived value (typically b.crypto.namespaceHash("affiliates-
  // cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("affiliates.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "affiliates-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("affiliates." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("affiliates." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("affiliates." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.occurred_at, last.id],
      forward:  true,
    }, cursorSecret);
  }

  function _hashEmail(canonicalEmail) {
    return b.crypto.namespaceHash(EMAIL_NAMESPACE, canonicalEmail);
  }

  function _hashSession(sessionId) {
    return b.crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
  }

  async function _getAffiliateRaw(id) {
    var r = await query("SELECT * FROM affiliates WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getCommissionRaw(id) {
    var r = await query("SELECT * FROM affiliate_commissions WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Inserting an affiliate row. Code generation retries on UNIQUE
  // violation up to a small bound; on the 32^8 space the chance of
  // running out is vanishingly low, but the retry keeps the boot
  // surface deterministic instead of leaking the SQL-level error.
  async function _insertAffiliate(row) {
    var attempts = 0;
    var lastErr;
    while (attempts < 5) {
      attempts += 1;
      row.code = _generateCode();
      try {
        await query(
          "INSERT INTO affiliates " +
          "(id, code, name, email_hash, email_normalised, payout_method, " +
          " payout_address, commission_kind, commission_value, " +
          " attribution_window_days, active, paused_at, paused_reason, " +
          " created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, NULL, NULL, ?11, ?11)",
          [
            row.id, row.code, row.name, row.email_hash, row.email_normalised,
            row.payout_method, row.payout_address, row.commission_kind,
            row.commission_value, row.attribution_window_days, row.created_at,
          ],
        );
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!e || !e.message || e.message.indexOf("UNIQUE") === -1) throw e;
      }
    }
    if (lastErr) throw lastErr;
    return row.code;
  }

  return {
    EMAIL_NAMESPACE:        EMAIL_NAMESPACE,
    SESSION_NAMESPACE:      SESSION_NAMESPACE,
    CODE_ALPHABET:          CODE_ALPHABET,
    CODE_LEN:               CODE_LEN,
    PAYOUT_METHODS:         PAYOUT_METHODS.slice(),
    COMMISSION_KINDS:       COMMISSION_KINDS.slice(),
    COMMISSION_STATUSES:    COMMISSION_STATUSES.slice(),
    MAX_NAME_LEN:           MAX_NAME_LEN,
    MAX_PAYOUT_ADDRESS_LEN: MAX_PAYOUT_ADDRESS_LEN,
    MAX_REFERRER_LEN:       MAX_REFERRER_LEN,
    MAX_REASON_LEN:         MAX_REASON_LEN,
    MAX_PAYOUT_REF_LEN:     MAX_PAYOUT_REF_LEN,
    MAX_WINDOW_DAYS:        MAX_WINDOW_DAYS,
    MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:     DEFAULT_LIST_LIMIT,
    BPS_DENOMINATOR:        BPS_DENOMINATOR,
    MAX_BPS:                MAX_BPS,

    registerAffiliate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.registerAffiliate: input object required");
      }
      var name             = _name(input.name);
      var emailNorm        = _normalizeEmail(input.email);
      var emailHash        = _hashEmail(emailNorm);
      var payoutMethod     = _payoutMethod(input.payout_method);
      var payoutAddress    = _payoutAddress(input.payout_address);
      var commissionKind   = _commissionKind(input.commission_kind);
      var commissionValue  = _commissionValue(input.commission_value, commissionKind);
      var attributionDays  = _attributionWindow(input.attribution_window_days);

      var id = b.uuid.v7();
      var ts = _now();
      var row = {
        id:                       id,
        name:                     name,
        email_hash:               emailHash,
        email_normalised:         emailNorm,
        payout_method:            payoutMethod,
        payout_address:           payoutAddress,
        commission_kind:          commissionKind,
        commission_value:         commissionValue,
        attribution_window_days:  attributionDays,
        created_at:               ts,
      };
      await _insertAffiliate(row);
      return await _getAffiliateRaw(id);
    },

    getAffiliate: async function (id) {
      id = _uuid(id, "affiliate_id");
      return await _getAffiliateRaw(id);
    },

    affiliateByCode: async function (code) {
      var canonical = _canonicalCode(code);
      var r = await query("SELECT * FROM affiliates WHERE code = ?1", [canonical]);
      return r.rows[0] || null;
    },

    listAffiliates: async function (listOpts) {
      listOpts = listOpts || {};
      var sql, params;
      if (listOpts.active_only) {
        sql = "SELECT * FROM affiliates WHERE active = 1 ORDER BY created_at DESC, id DESC";
        params = [];
      } else {
        sql = "SELECT * FROM affiliates ORDER BY created_at DESC, id DESC";
        params = [];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    // Patch-style update — only ALLOWED_UPDATE_COLUMNS can be set.
    // Email + code are immutable post-registration (changing the code
    // would orphan attribution rows; changing the email would orphan
    // the email-hash audit trail).
    updateAffiliate: async function (affiliateId, patch) {
      var id = _uuid(affiliateId, "affiliate_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("affiliates.updateAffiliate: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("affiliates.updateAffiliate: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("affiliates.updateAffiliate: column '" + keys[i] + "' not updatable");
        }
      }

      var current = await _getAffiliateRaw(id);
      if (!current) return null;

      // Validate each patched value through its dedicated guard. The
      // commission_value validation depends on the (possibly patched)
      // commission_kind — resolve the effective kind first.
      var effectiveKind = patch.commission_kind != null
        ? _commissionKind(patch.commission_kind)
        : current.commission_kind;

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (patch.name != null)              _set("name",              _name(patch.name));
      if (patch.payout_method != null)     _set("payout_method",     _payoutMethod(patch.payout_method));
      if (patch.payout_address != null)    _set("payout_address",    _payoutAddress(patch.payout_address));
      if (patch.commission_kind != null)   _set("commission_kind",   effectiveKind);
      if (patch.commission_value != null)  _set("commission_value",  _commissionValue(patch.commission_value, effectiveKind));
      if (patch.attribution_window_days != null) _set("attribution_window_days", _attributionWindow(patch.attribution_window_days));

      var ts = _now();
      _set("updated_at", ts);
      params.push(id);
      var sql = "UPDATE affiliates SET " + sets.join(", ") + " WHERE id = ?" + idx;
      await query(sql, params);
      return await _getAffiliateRaw(id);
    },

    pauseAffiliate: async function (affiliateId, opts2) {
      var id = _uuid(affiliateId, "affiliate_id");
      var reason = (opts2 && opts2.reason != null) ? _reason(opts2.reason) : null;
      var current = await _getAffiliateRaw(id);
      if (!current) return null;
      var ts = _now();
      await query(
        "UPDATE affiliates SET active = 0, paused_at = ?1, paused_reason = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, reason, id],
      );
      return await _getAffiliateRaw(id);
    },

    reinstateAffiliate: async function (affiliateId) {
      var id = _uuid(affiliateId, "affiliate_id");
      var current = await _getAffiliateRaw(id);
      if (!current) return null;
      var ts = _now();
      await query(
        "UPDATE affiliates SET active = 1, paused_at = NULL, paused_reason = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      return await _getAffiliateRaw(id);
    },

    // Storefront-side attribution write. The session id is hashed at
    // the door; raw value never lands on disk. Refused if the code
    // doesn't resolve to an active affiliate (paused affiliates don't
    // accrue new attribution — historical commissions stay; new
    // visits short-circuit). Idempotent against (session, code) for
    // the same calendar minute so a refresh-spam doesn't blow up the
    // visits table; older identical visits become new rows so the
    // affiliate's funnel-stats reflect repeat traffic.
    recordVisit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.recordVisit: input object required");
      }
      var canonical    = _canonicalCode(input.code);
      var sessionId    = _sessionId(input.visitor_session_id);
      var sessionHash  = _hashSession(sessionId);
      var referrer     = _referrer(input.referrer);
      var occurredAt;
      if (input.occurred_at != null) {
        if (!Number.isInteger(input.occurred_at) || input.occurred_at < 0) {
          throw new TypeError("affiliates.recordVisit: occurred_at must be a non-negative integer (ms epoch)");
        }
        occurredAt = input.occurred_at;
      } else {
        occurredAt = _now();
      }

      var affRow = await query("SELECT id, active FROM affiliates WHERE code = ?1", [canonical]);
      var aff = affRow.rows[0];
      if (!aff) {
        var miss = new Error("affiliates.recordVisit: code not recognized");
        miss.code = "AFFILIATE_CODE_NOT_FOUND";
        throw miss;
      }
      if (Number(aff.active) !== 1) {
        var paused = new Error("affiliates.recordVisit: affiliate is paused");
        paused.code = "AFFILIATE_PAUSED";
        throw paused;
      }

      // Dedupe within one calendar minute. A refresh in
      // the same minute collapses to a single visit; later traffic
      // gets its own row so funnel-stats stay coherent.
      var dedupeWindow = C.TIME.minutes(1);
      var existing = await query(
        "SELECT id FROM affiliate_visits " +
        "WHERE visitor_session_id_hash = ?1 AND code = ?2 AND occurred_at >= ?3 " +
        "ORDER BY occurred_at DESC LIMIT 1",
        [sessionHash, canonical, occurredAt - dedupeWindow],
      );
      if (existing.rows.length) {
        return {
          id:           existing.rows[0].id,
          affiliate_id: aff.id,
          code:         canonical,
          status:       "dedup",
        };
      }

      var visitId = b.uuid.v7();
      await query(
        "INSERT INTO affiliate_visits " +
        "(id, code, affiliate_id, visitor_session_id_hash, referrer, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        [visitId, canonical, aff.id, sessionHash, referrer, occurredAt],
      );
      return {
        id:           visitId,
        affiliate_id: aff.id,
        code:         canonical,
        status:       "new",
      };
    },

    // Resolve the most recent live attribution for a visitor session.
    // "Live" means the visit's occurred_at lands inside the
    // affiliate's attribution_window_days budget — older visits are
    // out of the cookie's lifetime and don't attribute. Returns null
    // on miss.
    attributionForSession: async function (visitorSessionId, optsArg) {
      var sessionId   = _sessionId(visitorSessionId);
      var sessionHash = _hashSession(sessionId);
      var now;
      if (optsArg && optsArg.now != null) {
        if (!Number.isInteger(optsArg.now) || optsArg.now < 0) {
          throw new TypeError("affiliates.attributionForSession: opts.now must be a non-negative integer (ms epoch)");
        }
        now = optsArg.now;
      } else {
        now = _now();
      }

      // Newest visit first; iterate joined rows because the
      // attribution window lives on the affiliate, not the visit.
      var r = await query(
        "SELECT v.id AS visit_id, v.code, v.affiliate_id, v.occurred_at, " +
        "       a.attribution_window_days, a.active " +
        "FROM affiliate_visits v JOIN affiliates a ON a.id = v.affiliate_id " +
        "WHERE v.visitor_session_id_hash = ?1 " +
        "ORDER BY v.occurred_at DESC",
        [sessionHash],
      );
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var windowMs = Number(row.attribution_window_days) * C.TIME.days(1);
        if (now - Number(row.occurred_at) <= windowMs) {
          return {
            visit_id:     row.visit_id,
            code:         row.code,
            affiliate_id: row.affiliate_id,
            occurred_at:  Number(row.occurred_at),
            active:       Number(row.active) === 1,
          };
        }
      }
      return null;
    },

    // Write a commission row at order-completion time. The
    // commission_minor is computed at write time from the affiliate's
    // *current* commission_kind + commission_value; the row preserves
    // those values implicitly via commission_minor so a later
    // operator-side rate change doesn't retroactively alter historical
    // payouts. Idempotent on (order_id, affiliate_id) — a second call
    // for the same order returns the existing row's status.
    recordCommissionEvent: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.recordCommissionEvent: input object required");
      }
      var orderId      = _uuid(input.order_id, "order_id");
      var affiliateId  = _uuid(input.affiliate_id, "affiliate_id");
      var orderTotal   = _orderTotal(input.order_total_minor);
      var currency     = _currency(input.currency);
      var occurredAt;
      if (input.occurred_at != null) {
        if (!Number.isInteger(input.occurred_at) || input.occurred_at < 0) {
          throw new TypeError("affiliates.recordCommissionEvent: occurred_at must be a non-negative integer (ms epoch)");
        }
        occurredAt = input.occurred_at;
      } else {
        occurredAt = _now();
      }

      var aff = await _getAffiliateRaw(affiliateId);
      if (!aff) {
        var miss = new Error("affiliates.recordCommissionEvent: affiliate not found");
        miss.code = "AFFILIATE_NOT_FOUND";
        throw miss;
      }

      // Idempotency check on (order_id, affiliate_id).
      var dupe = await query(
        "SELECT * FROM affiliate_commissions WHERE order_id = ?1 AND affiliate_id = ?2",
        [orderId, affiliateId],
      );
      if (dupe.rows.length) {
        return dupe.rows[0];
      }

      var commissionMinor = _computeCommissionMinor(
        aff.commission_kind, Number(aff.commission_value), orderTotal
      );

      var id = b.uuid.v7();
      await query(
        "INSERT INTO affiliate_commissions " +
        "(id, order_id, affiliate_id, order_total_minor, commission_minor, " +
        " currency, status, occurred_at, paid_at, voided_at, payout_reference, void_reason) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7, NULL, NULL, NULL, NULL)",
        [id, orderId, affiliateId, orderTotal, commissionMinor, currency, occurredAt],
      );
      return await _getCommissionRaw(id);
    },

    commissionsForAffiliate: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("affiliates.commissionsForAffiliate: input object required");
      }
      var affiliateId = _uuid(listOpts.affiliate_id, "affiliate_id");
      var limit       = _limit(listOpts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT);
      var cursorVals  = _decodeCursor(listOpts.cursor, "commissionsForAffiliate");
      var statusFilter;
      if (listOpts.status_filter != null) {
        statusFilter = _status(listOpts.status_filter, "status_filter");
      }
      var from = null;
      var to   = null;
      if (listOpts.from != null || listOpts.to != null) {
        from = listOpts.from == null ? 0 : listOpts.from;
        to   = listOpts.to   == null ? Number.MAX_SAFE_INTEGER : listOpts.to;
        _timestampRange(from, to, "commissionsForAffiliate");
      }

      var where  = ["affiliate_id = ?1"];
      var params = [affiliateId];
      var idx    = 2;
      if (from !== null) {
        where.push("occurred_at >= ?" + idx);
        params.push(from);
        idx += 1;
        where.push("occurred_at <= ?" + idx);
        params.push(to);
        idx += 1;
      }
      if (statusFilter !== undefined) {
        where.push("status = ?" + idx);
        params.push(statusFilter);
        idx += 1;
      }
      if (cursorVals) {
        var pOccurred = idx;
        var pId = idx + 1;
        where.push(
          "(occurred_at < ?" + pOccurred + " OR " +
          "(occurred_at = ?" + pOccurred + " AND id < ?" + pId + "))"
        );
        params.push(cursorVals[0], cursorVals[1]);
        idx += 2;
      }
      params.push(limit);
      var sql = "SELECT * FROM affiliate_commissions WHERE " + where.join(" AND ") +
                " ORDER BY occurred_at DESC, id DESC LIMIT ?" + idx;
      var r = await query(sql, params);
      return { rows: r.rows, next_cursor: _encodeNext(r.rows, limit) };
    },

    // FSM transition: pending -> paid. Refuses if the row is already
    // paid (idempotency hazard — a second payout reference would
    // double-pay) or voided (terminal). `paid_at` + `payout_reference`
    // are stamped together.
    markCommissionPaid: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.markCommissionPaid: input object required");
      }
      var id = _uuid(input.commission_event_id, "commission_event_id");
      if (!Number.isInteger(input.paid_at) || input.paid_at < 0) {
        throw new TypeError("affiliates.markCommissionPaid: paid_at must be a non-negative integer (ms epoch)");
      }
      var paidAt = input.paid_at;
      var reference = _payoutReference(input.payout_reference);

      var current = await _getCommissionRaw(id);
      if (!current) {
        var miss = new Error("affiliates.markCommissionPaid: commission not found");
        miss.code = "AFFILIATE_COMMISSION_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "pending") {
        var refused = new Error(
          "affiliates.markCommissionPaid: refused — commission is " + current.status
        );
        refused.code = "AFFILIATE_COMMISSION_TRANSITION_REFUSED";
        throw refused;
      }
      // Atomic claim: the `AND status = 'pending'` predicate is the
      // serialization point. The JS check above only refuses a
      // SEQUENTIAL re-pay; two concurrent calls would both read
      // 'pending' and both issue a payout reference. Gating the UPDATE
      // on the status means exactly one caller transitions the row —
      // the loser sees zero rows and is refused, so a second payout
      // reference can never be issued for one commission.
      var paidUpd = await query(
        "UPDATE affiliate_commissions SET status = 'paid', paid_at = ?1, payout_reference = ?2 " +
        "WHERE id = ?3 AND status = 'pending'",
        [paidAt, reference, id],
      );
      if (Number(paidUpd.rowCount || 0) !== 1) {
        var racedPaid = await _getCommissionRaw(id);
        var refusedPaid = new Error(
          "affiliates.markCommissionPaid: refused — commission is " +
          (racedPaid ? racedPaid.status : "gone")
        );
        refusedPaid.code = "AFFILIATE_COMMISSION_TRANSITION_REFUSED";
        throw refusedPaid;
      }
      return await _getCommissionRaw(id);
    },

    // FSM transition: pending -> voided. Refunds / chargebacks /
    // operator overrides land here. Refuses if already paid (operator
    // recoups via a separate clawback row, not by mutating the paid
    // commission) or already voided.
    markCommissionVoided: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.markCommissionVoided: input object required");
      }
      var id = _uuid(input.commission_event_id, "commission_event_id");
      if (input.reason == null) {
        throw new TypeError("affiliates.markCommissionVoided: reason is required");
      }
      var reason = _reason(input.reason);
      if (reason == null) {
        // _reason returns null for empty string; voiding requires a
        // real reason for the audit trail.
        throw new TypeError("affiliates.markCommissionVoided: reason must be a non-empty string");
      }

      var current = await _getCommissionRaw(id);
      if (!current) {
        var miss = new Error("affiliates.markCommissionVoided: commission not found");
        miss.code = "AFFILIATE_COMMISSION_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "pending") {
        var refused = new Error(
          "affiliates.markCommissionVoided: refused — commission is " + current.status
        );
        refused.code = "AFFILIATE_COMMISSION_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      // Atomic claim (see markCommissionPaid). Gating on 'pending'
      // stops a void from racing a concurrent pay — without it both
      // transitions could fire, clobbering a paid row (and its payout
      // reference) into 'voided', or vice versa.
      var voidUpd = await query(
        "UPDATE affiliate_commissions SET status = 'voided', voided_at = ?1, void_reason = ?2 " +
        "WHERE id = ?3 AND status = 'pending'",
        [ts, reason, id],
      );
      if (Number(voidUpd.rowCount || 0) !== 1) {
        var racedVoid = await _getCommissionRaw(id);
        var refusedVoid = new Error(
          "affiliates.markCommissionVoided: refused — commission is " +
          (racedVoid ? racedVoid.status : "gone")
        );
        refusedVoid.code = "AFFILIATE_COMMISSION_TRANSITION_REFUSED";
        throw refusedVoid;
      }
      return await _getCommissionRaw(id);
    },

    // Operator dashboard — which affiliates are owed at least
    // `min_payout_minor` as of `as_of`. Returns one row per affiliate
    // whose sum-of-pending commissions (occurred_at <= as_of) meets
    // the threshold, with `pending_minor` total + commission count.
    payoutsDue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.payoutsDue: input object required");
      }
      if (!Number.isInteger(input.as_of) || input.as_of < 0) {
        throw new TypeError("affiliates.payoutsDue: as_of must be a non-negative integer (ms epoch)");
      }
      if (!Number.isInteger(input.min_payout_minor) || input.min_payout_minor < 0) {
        throw new TypeError("affiliates.payoutsDue: min_payout_minor must be a non-negative integer");
      }
      var r = await query(
        "SELECT affiliate_id, SUM(commission_minor) AS pending_minor, COUNT(*) AS commission_count " +
        "FROM affiliate_commissions " +
        "WHERE status = 'pending' AND occurred_at <= ?1 " +
        "GROUP BY affiliate_id " +
        "HAVING SUM(commission_minor) >= ?2 " +
        "ORDER BY pending_minor DESC, affiliate_id ASC",
        [input.as_of, input.min_payout_minor],
      );
      return r.rows.map(function (row) {
        return {
          affiliate_id:      row.affiliate_id,
          pending_minor:     Number(row.pending_minor || 0),
          commission_count:  Number(row.commission_count || 0),
        };
      });
    },

    // Top-N affiliates by total commission_minor across paid + pending
    // rows in [from, to]. Voided rows are excluded — they didn't
    // ultimately earn anything. Ranking ignores currency mixing on
    // the assumption the operator's program is single-currency; a
    // multi-currency program should call this once per currency and
    // merge client-side.
    topAffiliates: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("affiliates.topAffiliates: input object required");
      }
      _timestampRange(input.from, input.to, "topAffiliates");
      var limit = _limit(input.limit, MAX_TOP_LIMIT, DEFAULT_TOP_LIMIT);
      var r = await query(
        "SELECT affiliate_id, SUM(commission_minor) AS total_minor, COUNT(*) AS commission_count " +
        "FROM affiliate_commissions " +
        "WHERE status != 'voided' AND occurred_at >= ?1 AND occurred_at <= ?2 " +
        "GROUP BY affiliate_id " +
        "HAVING SUM(commission_minor) > 0 " +
        "ORDER BY total_minor DESC, affiliate_id ASC " +
        "LIMIT ?3",
        [input.from, input.to, limit],
      );
      return r.rows.map(function (row) {
        return {
          affiliate_id:      row.affiliate_id,
          total_minor:       Number(row.total_minor || 0),
          commission_count:  Number(row.commission_count || 0),
        };
      });
    },
  };
}

module.exports = {
  create:                 create,
  EMAIL_NAMESPACE:        EMAIL_NAMESPACE,
  SESSION_NAMESPACE:      SESSION_NAMESPACE,
  CODE_ALPHABET:          CODE_ALPHABET,
  CODE_LEN:               CODE_LEN,
  PAYOUT_METHODS:         PAYOUT_METHODS.slice(),
  COMMISSION_KINDS:       COMMISSION_KINDS.slice(),
  COMMISSION_STATUSES:    COMMISSION_STATUSES.slice(),
  MAX_NAME_LEN:           MAX_NAME_LEN,
  MAX_PAYOUT_ADDRESS_LEN: MAX_PAYOUT_ADDRESS_LEN,
  MAX_REFERRER_LEN:       MAX_REFERRER_LEN,
  MAX_REASON_LEN:         MAX_REASON_LEN,
  MAX_PAYOUT_REF_LEN:     MAX_PAYOUT_REF_LEN,
  MAX_WINDOW_DAYS:        MAX_WINDOW_DAYS,
  MAX_LIST_LIMIT:         MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT:     DEFAULT_LIST_LIMIT,
  BPS_DENOMINATOR:        BPS_DENOMINATOR,
  MAX_BPS:                MAX_BPS,
};
