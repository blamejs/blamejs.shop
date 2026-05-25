"use strict";
/**
 * @module shop.loyaltyRedemption
 * @title  Loyalty redemption — customer-facing redemption layer on top
 *         of the `loyalty` points ledger.
 *
 * @intro
 *   Operators define a reward catalog (discount tier, free product,
 *   free shipping); customers redeem points for a catalog item at
 *   checkout. This primitive composes:
 *
 *     - `loyalty` (required) — points-ledger writes. The redemption
 *       debits points via `loyalty.redeem` and refunds them via
 *       `loyalty.adjust` on cancellation.
 *     - `coupons` (optional) — when injected, redemption mints a
 *       single-use coupon code via `coupons.issueSingleUseFromReward`
 *       (or whichever handle the operator wires). When absent, the
 *       redemption is a points-only event the operator's checkout UI
 *       surfaces and applies manually.
 *
 *   Surface:
 *
 *     - `defineReward({ slug, kind, title, point_cost, value_json,
 *                       max_per_customer?,
 *                       expires_days_after_redemption?, active })`
 *       Operator-authored catalog row. `kind` is one of
 *       `discount_percent`, `discount_amount`, `free_product`,
 *       `free_shipping`. Refuses redefinition — operators
 *       `updateReward` to mutate an existing slug.
 *
 *     - `redeemForCustomer({ customer_id, reward_slug })`
 *       Debits points via `loyalty.redeem`, mints a single-use
 *       coupon via the injected `coupons` handle when present,
 *       writes a `loyalty_redemptions` row at status `active`, and
 *       returns `{ redemption_id, coupon_code?, expires_at }`.
 *       Refusals:
 *         * reward archived or inactive    — REWARD_NOT_REDEEMABLE
 *         * lifetime cap reached           — REDEMPTION_CAP_REACHED
 *         * insufficient points            — propagated from `loyalty.redeem`
 *
 *     - `markConsumed({ redemption_id, order_id })`
 *       FSM transition active → consumed. Records the order the
 *       redemption settled against. Refuses anything other than the
 *       `active` state.
 *
 *     - `cancelRedemption({ redemption_id, reason })`
 *       FSM transition active → cancelled. Refunds the debited points
 *       via `loyalty.adjust(+points)`. A consumed/expired/cancelled
 *       redemption is refused — operators issue a manual
 *       `loyalty.adjust` row if the points need to come back after
 *       consumption.
 *
 *     - `getRedemption(redemption_id)` / `redemptionsForCustomer(id,
 *       { limit?, cursor? })` — read paths.
 *
 *     - `listRewards({ active_only? })` / `updateReward(slug, patch)` /
 *       `archiveReward(slug)` — catalog CRUD.
 *
 *   Storage: `loyalty_rewards`, `loyalty_redemptions` (migration
 *   0085).
 *
 * @primitive loyaltyRedemption
 * @related   shop.loyalty, shop.coupons (optional)
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var KINDS = ["discount_percent", "discount_amount", "free_product", "free_shipping"];
var STATUSES = ["active", "consumed", "expired", "cancelled"];

var MAX_SLUG_LEN  = 80;
var MAX_TITLE_LEN = 200;
var MAX_REASON_LEN = 256;
var MAX_LIST_LIMIT = 200;
var MAX_REDEMPTIONS_LIMIT = 200;
var MAX_POINT_COST = 100000000;
var MAX_PER_CUSTOMER = 100000;
var MAX_EXPIRES_DAYS = 3650;
var MS_PER_DAY = C.TIME.days(1);

// Slug shape matches the catalog / promo-banners convention — alnum +
// hyphen + underscore + dot, leading char alnum, capped length.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "point_cost",
  "value_json",
  "max_per_customer",
  "expires_days_after_redemption",
  "active",
]);

// `value_json` shape per `kind`. The catalog refuses entries whose
// payload doesn't satisfy the kind's contract at define / update time
// so a downstream consumer (the checkout UI, the coupons primitive)
// can trust the row.
function _validateValueJsonFor(kind, value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("loyaltyRedemption: value_json must be a plain object");
  }
  if (kind === "discount_percent") {
    if (!Number.isInteger(value.percent) || value.percent < 1 || value.percent > 100) {
      throw new TypeError("loyaltyRedemption: value_json.percent must be an integer in [1, 100] for discount_percent");
    }
  } else if (kind === "discount_amount") {
    if (!Number.isInteger(value.amount_minor) || value.amount_minor <= 0) {
      throw new TypeError("loyaltyRedemption: value_json.amount_minor must be a positive integer (minor units) for discount_amount");
    }
  } else if (kind === "free_product") {
    if (typeof value.product_id !== "string" || !value.product_id.length) {
      throw new TypeError("loyaltyRedemption: value_json.product_id must be a non-empty string for free_product");
    }
  } else if (kind === "free_shipping") {
    // free_shipping has no per-row payload; an empty object is the
    // contract. Refuse unknown keys so a typo can't silently encode
    // a different intent.
    var keys = Object.keys(value);
    if (keys.length !== 0) {
      throw new TypeError("loyaltyRedemption: value_json for free_shipping must be an empty object");
    }
  }
}

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("loyaltyRedemption: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("loyaltyRedemption: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("loyaltyRedemption: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("loyaltyRedemption: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("loyaltyRedemption: title must not contain control bytes");
  }
  return s;
}

function _pointCost(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_POINT_COST) {
    throw new TypeError("loyaltyRedemption: point_cost must be a positive integer <= " + MAX_POINT_COST);
  }
  return n;
}

function _maxPerCustomer(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1 || n > MAX_PER_CUSTOMER) {
    throw new TypeError("loyaltyRedemption: max_per_customer must be a positive integer <= " + MAX_PER_CUSTOMER + " (or null)");
  }
  return n;
}

function _expiresDays(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1 || n > MAX_EXPIRES_DAYS) {
    throw new TypeError("loyaltyRedemption: expires_days_after_redemption must be a positive integer <= " + MAX_EXPIRES_DAYS + " (or null)");
  }
  return n;
}

function _active(v) {
  if (typeof v !== "boolean") {
    throw new TypeError("loyaltyRedemption: active must be a boolean");
  }
  return v;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("loyaltyRedemption: reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_LEN) {
    throw new TypeError("loyaltyRedemption: reason must be <= " + MAX_REASON_LEN + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("loyaltyRedemption: reason must not contain control bytes");
  }
  return s;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _safeParseObject(s, fallback) {
  if (s == null) return fallback;
  try {
    var parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    return fallback;
  } catch (_e) {
    return fallback;
  }
}

function _hydrateReward(r) {
  if (!r) return null;
  return {
    slug:                          r.slug,
    kind:                          r.kind,
    title:                         r.title,
    point_cost:                    Number(r.point_cost),
    value_json:                    _safeParseObject(r.value_json, {}),
    max_per_customer:              r.max_per_customer == null ? null : Number(r.max_per_customer),
    expires_days_after_redemption: r.expires_days_after_redemption == null ? null : Number(r.expires_days_after_redemption),
    active:                        r.active === 1 || r.active === true,
    archived_at:                   r.archived_at == null ? null : Number(r.archived_at),
    created_at:                    Number(r.created_at),
    updated_at:                    Number(r.updated_at),
  };
}

function _hydrateRedemption(r) {
  if (!r) return null;
  return {
    id:             r.id,
    customer_id:    r.customer_id,
    reward_slug:    r.reward_slug,
    points_debited: Number(r.points_debited),
    coupon_code:    r.coupon_code == null ? null : r.coupon_code,
    status:         r.status,
    redeemed_at:    Number(r.redeemed_at),
    consumed_at:    r.consumed_at == null ? null : Number(r.consumed_at),
    expires_at:     r.expires_at  == null ? null : Number(r.expires_at),
    order_id:       r.order_id    == null ? null : r.order_id,
    cancel_reason:  r.cancel_reason == null ? null : r.cancel_reason,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  var loyalty = opts.loyalty;
  if (!loyalty || typeof loyalty.redeem !== "function" || typeof loyalty.adjust !== "function") {
    throw new TypeError("loyaltyRedemption: opts.loyalty handle required (must expose redeem + adjust)");
  }

  // Optional coupons handle. When wired, expected shape is
  // `issueSingleUseFromReward({ customer_id, reward_slug, value_json,
  // expires_at? }) -> Promise<{ code }>`. Absent that, the redemption
  // proceeds without a coupon_code — operators surface the
  // redemption_id in their checkout UI and apply the discount
  // manually. Refuse a handle that's not shaped as expected up front
  // so a typo doesn't surface deep inside a redeem call.
  var coupons = opts.coupons || null;
  if (coupons != null && typeof coupons.issueSingleUseFromReward !== "function") {
    throw new TypeError("loyaltyRedemption: opts.coupons handle must expose issueSingleUseFromReward(...)");
  }

  // ---- defineReward --------------------------------------------------

  async function defineReward(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyRedemption.defineReward: input object required");
    }
    var slug = _slug(input.slug);
    var kind = _kind(input.kind);
    var title = _title(input.title);
    var pointCost = _pointCost(input.point_cost);
    _validateValueJsonFor(kind, input.value_json);
    var maxPerCustomer = _maxPerCustomer(input.max_per_customer);
    var expiresDays = _expiresDays(input.expires_days_after_redemption);
    var active = _active(input.active);

    // Refuse a redefine — operators should `updateReward` to mutate.
    var existing = (await query(
      "SELECT slug FROM loyalty_rewards WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("loyaltyRedemption.defineReward: slug " + JSON.stringify(slug) + " already exists — use updateReward");
    }

    var ts = _now();
    await query(
      "INSERT INTO loyalty_rewards (slug, kind, title, point_cost, value_json, max_per_customer, " +
      "expires_days_after_redemption, active, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)",
      [
        slug, kind, title, pointCost, JSON.stringify(input.value_json),
        maxPerCustomer, expiresDays, active ? 1 : 0, ts,
      ],
    );
    return await getReward(slug);
  }

  // ---- getReward / listRewards ---------------------------------------

  async function getReward(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM loyalty_rewards WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateReward(r);
  }

  async function listRewards(listOpts) {
    listOpts = listOpts || {};
    var activeOnly = false;
    if (listOpts.active_only != null) {
      if (typeof listOpts.active_only !== "boolean") {
        throw new TypeError("loyaltyRedemption.listRewards: active_only must be a boolean");
      }
      activeOnly = listOpts.active_only;
    }
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError("loyaltyRedemption.listRewards: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
    }
    var sql, params;
    if (activeOnly) {
      sql = "SELECT * FROM loyalty_rewards WHERE active = 1 AND archived_at IS NULL " +
            "ORDER BY point_cost ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql = "SELECT * FROM loyalty_rewards ORDER BY created_at DESC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateReward(rows[i]));
    return out;
  }

  // ---- updateReward --------------------------------------------------

  async function updateReward(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("loyaltyRedemption.updateReward: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("loyaltyRedemption.updateReward: patch must include at least one column");
    }
    var current = await getReward(slug);
    if (!current) {
      throw new TypeError("loyaltyRedemption.updateReward: slug " + JSON.stringify(slug) + " not found");
    }

    var sets = [];
    var params = [];
    var idx = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("loyaltyRedemption.updateReward: unsupported column " + JSON.stringify(col));
      }
      if (col === "title") {
        sets.push("title = ?" + idx);
        params.push(_title(patch[col]));
      } else if (col === "point_cost") {
        sets.push("point_cost = ?" + idx);
        params.push(_pointCost(patch[col]));
      } else if (col === "value_json") {
        _validateValueJsonFor(current.kind, patch[col]);
        sets.push("value_json = ?" + idx);
        params.push(JSON.stringify(patch[col]));
      } else if (col === "max_per_customer") {
        sets.push("max_per_customer = ?" + idx);
        params.push(_maxPerCustomer(patch[col]));
      } else if (col === "expires_days_after_redemption") {
        sets.push("expires_days_after_redemption = ?" + idx);
        params.push(_expiresDays(patch[col]));
      } else /* active */ {
        sets.push("active = ?" + idx);
        params.push(_active(patch[col]) ? 1 : 0);
      }
      idx += 1;
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(slug);

    var r = await query(
      "UPDATE loyalty_rewards SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("loyaltyRedemption.updateReward: slug " + JSON.stringify(slug) + " not found");
    }
    return await getReward(slug);
  }

  // ---- archiveReward -------------------------------------------------

  async function archiveReward(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE loyalty_rewards SET archived_at = ?1, active = 0, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getReward(slug);
      if (!existing) {
        throw new TypeError("loyaltyRedemption.archiveReward: slug " + JSON.stringify(slug) + " not found");
      }
      // Already archived — return idempotently.
      return existing;
    }
    return await getReward(slug);
  }

  // ---- redeemForCustomer ---------------------------------------------

  async function _countActiveOrConsumedForCustomer(customerId, rewardSlug) {
    var r = await query(
      "SELECT COUNT(*) AS n FROM loyalty_redemptions " +
      "WHERE customer_id = ?1 AND reward_slug = ?2 AND status IN ('active','consumed')",
      [customerId, rewardSlug],
    );
    var row = r.rows[0] || { n: 0 };
    return Number(row.n || row.N || 0);
  }

  async function redeemForCustomer(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyRedemption.redeemForCustomer: input object required");
    }
    var customerId = _uuid(input.customer_id, "customer_id");
    var rewardSlug = _slug(input.reward_slug);

    var reward = await getReward(rewardSlug);
    if (!reward) {
      throw new TypeError("loyaltyRedemption.redeemForCustomer: reward_slug " + JSON.stringify(rewardSlug) + " not found");
    }
    if (reward.archived_at != null || reward.active === false) {
      var nope = new Error("loyaltyRedemption.redeemForCustomer: reward not currently redeemable");
      nope.code = "REWARD_NOT_REDEEMABLE";
      throw nope;
    }

    if (reward.max_per_customer != null) {
      var count = await _countActiveOrConsumedForCustomer(customerId, rewardSlug);
      if (count >= reward.max_per_customer) {
        var cap = new Error("loyaltyRedemption.redeemForCustomer: customer has reached the per-customer redemption cap");
        cap.code = "REDEMPTION_CAP_REACHED";
        throw cap;
      }
    }

    // Debit points via the composed loyalty primitive. The redeem
    // call surfaces LOYALTY_INSUFFICIENT_BALANCE on its own when the
    // customer can't afford the reward; that error propagates as-is.
    await loyalty.redeem({
      customer_id: customerId,
      points:      reward.point_cost,
      notes:       "redeem:" + rewardSlug,
    });

    var redemptionId = b.uuid.v7();
    var ts = _now();
    var expiresAt = reward.expires_days_after_redemption == null
      ? null
      : ts + (reward.expires_days_after_redemption * MS_PER_DAY);

    var couponCode = null;
    if (coupons) {
      var minted = await coupons.issueSingleUseFromReward({
        customer_id: customerId,
        reward_slug: rewardSlug,
        value_json:  reward.value_json,
        expires_at:  expiresAt,
      });
      if (!minted || typeof minted.code !== "string" || !minted.code.length) {
        throw new TypeError("loyaltyRedemption.redeemForCustomer: coupons.issueSingleUseFromReward must return { code: string }");
      }
      couponCode = minted.code;
    }

    await query(
      "INSERT INTO loyalty_redemptions (id, customer_id, reward_slug, points_debited, coupon_code, " +
      "status, redeemed_at, consumed_at, expires_at, order_id, cancel_reason) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, NULL, ?7, NULL, NULL)",
      [redemptionId, customerId, rewardSlug, reward.point_cost, couponCode, ts, expiresAt],
    );

    return {
      redemption_id: redemptionId,
      coupon_code:   couponCode,
      expires_at:    expiresAt,
    };
  }

  // ---- getRedemption / redemptionsForCustomer ------------------------

  async function getRedemption(redemptionId) {
    _uuid(redemptionId, "redemption_id");
    var r = (await query(
      "SELECT * FROM loyalty_redemptions WHERE id = ?1 LIMIT 1",
      [redemptionId],
    )).rows[0];
    return _hydrateRedemption(r);
  }

  async function redemptionsForCustomer(customerId, listOpts) {
    _uuid(customerId, "customer_id");
    listOpts = listOpts || {};
    var limit = listOpts.limit == null ? 50 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_REDEMPTIONS_LIMIT) {
      throw new TypeError("loyaltyRedemption.redemptionsForCustomer: limit must be an integer in [1, " + MAX_REDEMPTIONS_LIMIT + "]");
    }
    var sql = "SELECT * FROM loyalty_redemptions WHERE customer_id = ?1";
    var params = [customerId];
    if (listOpts.cursor != null) {
      if (!Number.isInteger(listOpts.cursor) || listOpts.cursor < 0) {
        throw new TypeError("loyaltyRedemption.redemptionsForCustomer: cursor must be a non-negative integer epoch-ms");
      }
      sql += " AND redeemed_at < ?2";
      params.push(listOpts.cursor);
    }
    sql += " ORDER BY redeemed_at DESC, id DESC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var rows = (await query(sql, params)).rows;
    var hydrated = [];
    for (var i = 0; i < rows.length; i += 1) hydrated.push(_hydrateRedemption(rows[i]));
    var nextCursor = rows.length === limit ? hydrated[hydrated.length - 1].redeemed_at : null;
    return { rows: hydrated, next_cursor: nextCursor };
  }

  // ---- markConsumed --------------------------------------------------

  async function markConsumed(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyRedemption.markConsumed: input object required");
    }
    var redemptionId = _uuid(input.redemption_id, "redemption_id");
    var orderId      = _uuid(input.order_id,      "order_id");

    var current = await getRedemption(redemptionId);
    if (!current) {
      throw new TypeError("loyaltyRedemption.markConsumed: redemption_id " + JSON.stringify(redemptionId) + " not found");
    }
    if (current.status !== "active") {
      var bad = new Error("loyaltyRedemption.markConsumed: redemption status is '" + current.status + "', only 'active' may be consumed");
      bad.code = "REDEMPTION_NOT_ACTIVE";
      throw bad;
    }

    var ts = _now();
    var r = await query(
      "UPDATE loyalty_redemptions SET status = 'consumed', consumed_at = ?1, order_id = ?2 " +
      "WHERE id = ?3 AND status = 'active'",
      [ts, orderId, redemptionId],
    );
    if (Number(r.rowCount || 0) === 0) {
      // Lost the race — re-read so the caller gets the row's actual
      // post-race state. Refuse with the same FSM error so the call
      // surface is identical whether the loser noticed pre- or
      // post-SQL.
      var raceAfter = await getRedemption(redemptionId);
      var raceErr = new Error("loyaltyRedemption.markConsumed: redemption status is '" + (raceAfter && raceAfter.status) + "', only 'active' may be consumed");
      raceErr.code = "REDEMPTION_NOT_ACTIVE";
      throw raceErr;
    }
    return await getRedemption(redemptionId);
  }

  // ---- cancelRedemption ----------------------------------------------

  async function cancelRedemption(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("loyaltyRedemption.cancelRedemption: input object required");
    }
    var redemptionId = _uuid(input.redemption_id, "redemption_id");
    var reason       = _reason(input.reason);

    var current = await getRedemption(redemptionId);
    if (!current) {
      throw new TypeError("loyaltyRedemption.cancelRedemption: redemption_id " + JSON.stringify(redemptionId) + " not found");
    }
    if (current.status !== "active") {
      // Only an `active` redemption is refundable through this
      // primitive. A consumed redemption is settled against an
      // order; an expired redemption forfeited the points on
      // purpose; a cancelled redemption already refunded. Operators
      // needing to claw back points after consumption issue a
      // manual `loyalty.adjust(-points)` row.
      var bad = new Error("loyaltyRedemption.cancelRedemption: redemption status is '" + current.status + "', only 'active' may be cancelled with a point refund");
      bad.code = "REDEMPTION_NOT_ACTIVE";
      throw bad;
    }

    var ts = _now();
    var r = await query(
      "UPDATE loyalty_redemptions SET status = 'cancelled', cancel_reason = ?1 " +
      "WHERE id = ?2 AND status = 'active'",
      [reason, redemptionId],
    );
    if (Number(r.rowCount || 0) === 0) {
      var raceAfter = await getRedemption(redemptionId);
      var raceErr = new Error("loyaltyRedemption.cancelRedemption: redemption status is '" + (raceAfter && raceAfter.status) + "', only 'active' may be cancelled with a point refund");
      raceErr.code = "REDEMPTION_NOT_ACTIVE";
      throw raceErr;
    }

    // Refund the debited points via loyalty.adjust. Positive
    // delta — `loyalty.adjust` will credit lifetime as well, which
    // matches the customer's lived experience (the redemption never
    // happened, the points come back, the tier-driving lifetime
    // total returns to where it was). Note that the underlying
    // `loyalty.adjust` lifetime semantics only credit on positive
    // delta, which is exactly what we want here.
    await loyalty.adjust({
      customer_id: current.customer_id,
      points:      current.points_debited,
      source:      "redemption-refund",
      notes:       "redemption:" + redemptionId + " " + reason,
    });
    void ts;

    return await getRedemption(redemptionId);
  }

  return {
    KINDS:    KINDS.slice(),
    STATUSES: STATUSES.slice(),

    defineReward:           defineReward,
    getReward:              getReward,
    listRewards:            listRewards,
    updateReward:           updateReward,
    archiveReward:          archiveReward,

    redeemForCustomer:      redeemForCustomer,
    getRedemption:          getRedemption,
    redemptionsForCustomer: redemptionsForCustomer,
    markConsumed:           markConsumed,
    cancelRedemption:       cancelRedemption,
  };
}

module.exports = {
  create:   create,
  KINDS:    KINDS,
  STATUSES: STATUSES,
};
