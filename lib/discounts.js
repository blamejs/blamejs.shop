"use strict";
/**
 * @module shop.discounts
 * @title  Discounts primitive — coupon-code rules + redemption ledger
 *
 * @intro
 *   Stateless wrapper over `discounts` + `discount_redemptions` in
 *   D1. Owns three concerns:
 *
 *     1. CRUD on the rule rows (admin surface).
 *     2. `resolve({ code, subtotal_minor, currency })` — pure
 *        function over the current cart subtotal that decides what
 *        the storefront / checkout should apply. Refuses with a
 *        machine-readable `reason` rather than throwing so the cart
 *        view can render "Coupon EXPIRED" / "Below minimum" etc.
 *     3. `redeem(discountId, orderId)` — atomic increment of `uses`
 *        + ledger insert. Refuses past the `max_uses` cap via a
 *        conditional UPDATE so two concurrent confirmers can't push
 *        the counter past the operator's limit.
 *
 *   Codes are case-insensitive at the lookup boundary — operators
 *   publish `summer-25` in marketing; the customer types `SUMMER-25`;
 *   both resolve to the same row. Writes normalize to uppercase so
 *   `byCode(code)` can do a `lower(code) = lower(?1)` comparison
 *   against an index-backed expression.
 *
 *   `value_bps_or_minor` carries two semantics keyed by `type`:
 *     - percent_off: basis points (1 bps = 0.01%); capped at 10000
 *       (100% off). Computed discount: `floor(subtotal * bps / 10000)`.
 *     - fixed_off:   integer minor units of `currency`. Refused when
 *       the cart currency doesn't match.
 *
 *   The resolver clamps the computed discount to the cart subtotal
 *   so a `$50` coupon on a `$10` cart caps at `$10` — pricing.totals
 *   refuses a negative subtotal so the caller never has to special-
 *   case it.
 *
 *       var discounts = bShop.discounts.create({ query: query });
 *       var r = await discounts.resolve({ code: "summer-25",
 *                                          subtotal_minor: 5000,
 *                                          currency:       "USD" });
 *       // → { discount_minor: 1250, discount: { id, code, ... } }
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var CODE_RE     = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
var CURRENCY_RE = /^[A-Z]{3}$/;
var TYPES       = Object.freeze(["percent_off", "fixed_off"]);
var MAX_LIMIT   = 200;
var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "code", "type", "value_bps_or_minor", "currency",
  "min_subtotal_minor", "max_uses", "starts_at", "ends_at", "active",
]);

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("discounts: " + label + " — " + (e && e.message || "invalid UUID")); }
}
function _code(raw) {
  if (typeof raw !== "string") {
    throw new TypeError("discounts: code must be a string");
  }
  var up = raw.toUpperCase();
  if (!CODE_RE.test(up)) {
    throw new TypeError("discounts: code must match /^[A-Z0-9][A-Z0-9-]{2,31}$/ (3..32 chars, alnum + hyphen, leading alnum)");
  }
  return up;
}
function _type(s) {
  if (TYPES.indexOf(s) === -1) {
    throw new TypeError("discounts: type must be one of " + TYPES.join(", ") + ", got " + JSON.stringify(s));
  }
}
function _currency(s, label) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("discounts: " + label + " must be a 3-letter ISO 4217 code (uppercase), got " + JSON.stringify(s));
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("discounts: " + label + " must be a non-negative integer");
  }
}
function _nullOrNonNegInt(n, label) {
  if (n == null) return null;
  _nonNegInt(n, label);
  return n;
}
function _bool01(v, label) {
  if (v === 0 || v === 1) return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new TypeError("discounts: " + label + " must be 0 / 1 / boolean");
}

function _now() { return Date.now(); }

// Validate a create-input row + return the normalized column values.
function _normalizeForWrite(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("discounts: input object required");
  }
  var code = _code(input.code);
  _type(input.type);
  _nonNegInt(input.value_bps_or_minor, "value_bps_or_minor");
  if (input.type === "percent_off") {
    if (input.value_bps_or_minor > 10000) {
      throw new TypeError("discounts: percent_off value_bps_or_minor capped at 10000 (100%); got " + input.value_bps_or_minor);
    }
    if (input.currency != null) {
      throw new TypeError("discounts: percent_off must not carry a currency (it's currency-agnostic)");
    }
  } else { // fixed_off
    if (typeof input.currency !== "string") {
      throw new TypeError("discounts: fixed_off requires a currency (3-letter ISO 4217)");
    }
    _currency(input.currency, "currency");
  }
  var minSub = input.min_subtotal_minor == null ? 0 : input.min_subtotal_minor;
  _nonNegInt(minSub, "min_subtotal_minor");
  var maxUses = _nullOrNonNegInt(input.max_uses, "max_uses");
  var starts  = _nullOrNonNegInt(input.starts_at, "starts_at");
  var ends    = _nullOrNonNegInt(input.ends_at,   "ends_at");
  var active  = input.active == null ? 1 : _bool01(input.active, "active");
  return {
    code:                code,
    type:                input.type,
    value_bps_or_minor:  input.value_bps_or_minor,
    currency:            input.type === "percent_off" ? null : input.currency,
    min_subtotal_minor:  minSub,
    max_uses:            maxUses,
    starts_at:           starts,
    ends_at:             ends,
    active:              active,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  var api = {
    // The reason codes returned by `resolve(...)`. Exposed so the
    // storefront / admin templates can switch on them without
    // hard-coding strings inline.
    REASONS: Object.freeze({
      UNKNOWN_CODE:        "unknown-code",
      NOT_ACTIVE:          "not-active",
      EXPIRED:             "expired",
      NOT_YET_ACTIVE:      "not-yet-active",
      BELOW_MIN_SUBTOTAL:  "below-min-subtotal",
      WRONG_CURRENCY:      "wrong-currency",
      MAX_USES_EXHAUSTED:  "max-uses-exhausted",
    }),

    create: async function (input) {
      var n = _normalizeForWrite(input);
      var id = _b().uuid.v7();
      var ts = _now();
      try {
        await query(
          "INSERT INTO discounts (id, code, type, value_bps_or_minor, currency, " +
          "min_subtotal_minor, max_uses, uses, starts_at, ends_at, active, " +
          "created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9, ?10, ?11, ?11)",
          [
            id, n.code, n.type, n.value_bps_or_minor, n.currency,
            n.min_subtotal_minor, n.max_uses, n.starts_at, n.ends_at, n.active, ts,
          ],
        );
      } catch (e) {
        // Surface UNIQUE-constraint conflicts as TypeError so admin
        // routes map them to 400 instead of 500.
        var msg = (e && e.message) || String(e);
        if (/UNIQUE|unique/.test(msg)) {
          throw new TypeError("discounts: code " + JSON.stringify(n.code) + " already exists");
        }
        throw e;
      }
      return await api.get(id);
    },

    get: async function (id) {
      _id(id, "discount id");
      var r = await query("SELECT * FROM discounts WHERE id = ?1", [id]);
      return r.rows[0] || null;
    },

    // Case-insensitive lookup via lower(code). Normalize the input
    // before comparing so a query for `"summer-25"` hits the same
    // row as `"SUMMER-25"`.
    byCode: async function (code) {
      if (typeof code !== "string" || !code.length) return null;
      var normalized = code.toUpperCase();
      // Refuse a malformed code at the boundary so a caller passing
      // garbage gets a clear error rather than an empty result.
      if (!CODE_RE.test(normalized)) return null;
      var r = await query("SELECT * FROM discounts WHERE lower(code) = lower(?1) LIMIT 1", [normalized]);
      return r.rows[0] || null;
    },

    list: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("discounts.list: limit must be 1..." + MAX_LIMIT);
      }
      var offset = listOpts.offset == null ? 0 : listOpts.offset;
      if (!Number.isInteger(offset) || offset < 0) {
        throw new TypeError("discounts.list: offset must be a non-negative integer");
      }
      var sql, params;
      if (listOpts.active === true || listOpts.active === 1) {
        sql = "SELECT * FROM discounts WHERE active = 1 ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2";
        params = [limit, offset];
      } else if (listOpts.active === false || listOpts.active === 0) {
        sql = "SELECT * FROM discounts WHERE active = 0 ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2";
        params = [limit, offset];
      } else {
        sql = "SELECT * FROM discounts ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2";
        params = [limit, offset];
      }
      var r = await query(sql, params);
      return { rows: r.rows, limit: limit, offset: offset };
    },

    update: async function (id, patch) {
      _id(id, "discount id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("discounts.update: patch object required");
      }
      // Per-field validation. Mirror the create-time discipline:
      // every patched field is independently typed; we never let a
      // caller widen the row past the schema.
      var current = await api.get(id);
      if (!current) return null;
      var merged = {
        code:                Object.prototype.hasOwnProperty.call(patch, "code")               ? patch.code               : current.code,
        type:                Object.prototype.hasOwnProperty.call(patch, "type")               ? patch.type               : current.type,
        value_bps_or_minor:  Object.prototype.hasOwnProperty.call(patch, "value_bps_or_minor") ? patch.value_bps_or_minor : current.value_bps_or_minor,
        currency:            Object.prototype.hasOwnProperty.call(patch, "currency")           ? patch.currency           : current.currency,
        min_subtotal_minor:  Object.prototype.hasOwnProperty.call(patch, "min_subtotal_minor") ? patch.min_subtotal_minor : current.min_subtotal_minor,
        max_uses:            Object.prototype.hasOwnProperty.call(patch, "max_uses")           ? patch.max_uses           : current.max_uses,
        starts_at:           Object.prototype.hasOwnProperty.call(patch, "starts_at")          ? patch.starts_at          : current.starts_at,
        ends_at:             Object.prototype.hasOwnProperty.call(patch, "ends_at")            ? patch.ends_at            : current.ends_at,
        active:              Object.prototype.hasOwnProperty.call(patch, "active")             ? patch.active             : current.active,
      };
      var n = _normalizeForWrite(merged);
      var ts = _now();
      // Build the UPDATE only for keys actually in the patch, so a
      // bare bump doesn't churn unchanged columns + clobber a
      // concurrent writer's field-level change.
      var sets = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        _b().safeSql.assertOneOf(col, ALLOWED_PATCH_COLUMNS);
        sets.push(_b().safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "code"))               _addSet("code",               n.code);
      if (Object.prototype.hasOwnProperty.call(patch, "type"))               _addSet("type",               n.type);
      if (Object.prototype.hasOwnProperty.call(patch, "value_bps_or_minor")) _addSet("value_bps_or_minor", n.value_bps_or_minor);
      if (Object.prototype.hasOwnProperty.call(patch, "currency"))           _addSet("currency",           n.currency);
      if (Object.prototype.hasOwnProperty.call(patch, "min_subtotal_minor")) _addSet("min_subtotal_minor", n.min_subtotal_minor);
      if (Object.prototype.hasOwnProperty.call(patch, "max_uses"))           _addSet("max_uses",           n.max_uses);
      if (Object.prototype.hasOwnProperty.call(patch, "starts_at"))          _addSet("starts_at",          n.starts_at);
      if (Object.prototype.hasOwnProperty.call(patch, "ends_at"))            _addSet("ends_at",            n.ends_at);
      if (Object.prototype.hasOwnProperty.call(patch, "active"))             _addSet("active",             n.active);
      if (sets.length === 0) {
        throw new TypeError("discounts.update: patch contained no updatable fields");
      }
      sets.push("updated_at = ?" + (i++));
      params.push(ts);
      params.push(id);
      try {
        var r = await query("UPDATE discounts SET " + sets.join(", ") + " WHERE id = ?" + i, params);
        if (r.rowCount === 0) return null;
      } catch (e) {
        var msg = (e && e.message) || String(e);
        if (/UNIQUE|unique/.test(msg)) {
          throw new TypeError("discounts: code " + JSON.stringify(n.code) + " already exists");
        }
        throw e;
      }
      return await api.get(id);
    },

    delete: async function (id) {
      _id(id, "discount id");
      var r = await query("DELETE FROM discounts WHERE id = ?1", [id]);
      return r.rowCount > 0;
    },

    // Resolve a coupon code against a cart subtotal + currency.
    // NEVER throws on refusal (returns `{ discount_minor: 0, reason }`)
    // so the storefront can render the refusal inline. Throws only on
    // a programmer-error input shape (subtotal not an integer, etc.).
    resolve: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("discounts.resolve: input object required");
      }
      _nonNegInt(input.subtotal_minor, "subtotal_minor");
      _currency(input.currency, "currency");
      var R = api.REASONS;
      if (typeof input.code !== "string" || !input.code.length) {
        return { discount_minor: 0, reason: R.UNKNOWN_CODE };
      }
      // Normalize before lookup. byCode() handles the case-insensitive
      // match + refuses a malformed shape by returning null.
      var row = await api.byCode(input.code);
      if (!row) {
        return { discount_minor: 0, reason: R.UNKNOWN_CODE };
      }
      if (!row.active) {
        return { discount_minor: 0, reason: R.NOT_ACTIVE, discount: row };
      }
      var now = (typeof input.now === "number") ? input.now : _now();
      if (row.starts_at != null && now < row.starts_at) {
        return { discount_minor: 0, reason: R.NOT_YET_ACTIVE, discount: row };
      }
      if (row.ends_at != null && now >= row.ends_at) {
        return { discount_minor: 0, reason: R.EXPIRED, discount: row };
      }
      if (row.max_uses != null && row.uses >= row.max_uses) {
        return { discount_minor: 0, reason: R.MAX_USES_EXHAUSTED, discount: row };
      }
      if (input.subtotal_minor < row.min_subtotal_minor) {
        return { discount_minor: 0, reason: R.BELOW_MIN_SUBTOTAL, discount: row };
      }
      if (row.type === "fixed_off" && row.currency !== input.currency) {
        return { discount_minor: 0, reason: R.WRONG_CURRENCY, discount: row };
      }
      var amount;
      if (row.type === "percent_off") {
        amount = Math.floor(input.subtotal_minor * row.value_bps_or_minor / 10000);
      } else {
        amount = row.value_bps_or_minor;
      }
      // Clamp to subtotal so pricing.totals never sees a negative
      // grand-total contribution. A `$50` coupon on a `$10` cart
      // becomes `$10` — every other line item still applies (tax /
      // shipping) on the post-discount subtotal.
      if (amount > input.subtotal_minor) amount = input.subtotal_minor;
      return { discount_minor: amount, discount: row };
    },

    // Atomic redeem: conditional UPDATE only succeeds when the row
    // is below the use cap, and a redemption row is appended only
    // on success. Two concurrent confirmers can't push `uses` past
    // `max_uses` — the second one's UPDATE matches 0 rows and we
    // refuse with `max-uses-exhausted`.
    redeem: async function (discountId, orderId) {
      _id(discountId, "discount id");
      _id(orderId,    "order id");
      var ts = _now();
      // Conditional UPDATE — only bumps `uses` when there's headroom
      // (max_uses NULL means unlimited).
      var r = await query(
        "UPDATE discounts " +
        "SET uses = uses + 1, updated_at = ?1 " +
        "WHERE id = ?2 AND active = 1 " +
        "  AND (max_uses IS NULL OR uses < max_uses)",
        [ts, discountId],
      );
      if (r.rowCount === 0) {
        // Disambiguate "not found / inactive" from "exhausted" so the
        // caller can surface a helpful message. The cheapest probe is
        // a second SELECT — we're already past the hot path.
        var current = await api.get(discountId);
        if (!current) {
          var notFound = new Error("discounts.redeem: discount " + discountId + " not found");
          notFound.code = "DISCOUNT_NOT_FOUND";
          throw notFound;
        }
        var refused = new Error("discounts.redeem: refused — " + (current.active ? "max-uses-exhausted" : "not-active"));
        refused.code = current.active ? "DISCOUNT_EXHAUSTED" : "DISCOUNT_INACTIVE";
        throw refused;
      }
      var redemptionId = _b().uuid.v7();
      await query(
        "INSERT INTO discount_redemptions (id, discount_id, order_id, redeemed_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [redemptionId, discountId, orderId, ts],
      );
      return { id: redemptionId, discount_id: discountId, order_id: orderId, redeemed_at: ts };
    },

    // Recent redemptions for a discount — admin analytics surface.
    redemptions: async function (discountId, listOpts) {
      _id(discountId, "discount id");
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("discounts.redemptions: limit must be 1..." + MAX_LIMIT);
      }
      var r = await query(
        "SELECT * FROM discount_redemptions WHERE discount_id = ?1 " +
        "ORDER BY redeemed_at DESC, id DESC LIMIT ?2",
        [discountId, limit],
      );
      return { rows: r.rows, limit: limit };
    },
  };

  return api;
}

module.exports = {
  create:  create,
  // Exposed so the storefront can switch on reason codes without
  // re-defining them.
  REASONS: Object.freeze({
    UNKNOWN_CODE:        "unknown-code",
    NOT_ACTIVE:          "not-active",
    EXPIRED:             "expired",
    NOT_YET_ACTIVE:      "not-yet-active",
    BELOW_MIN_SUBTOTAL:  "below-min-subtotal",
    WRONG_CURRENCY:      "wrong-currency",
    MAX_USES_EXHAUSTED:  "max-uses-exhausted",
  }),
};
