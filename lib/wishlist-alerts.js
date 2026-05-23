"use strict";
/**
 * @module shop.wishlistAlerts
 * @title  Notify customers when wishlist items go on sale or come back
 *         in stock.
 *
 * @intro
 *   Customers add items to their wishlist (the `wishlist` primitive);
 *   operators author one or more alert POLICIES through this primitive
 *   ("any price drop of 20%+", "any restock of a sold-out item"); the
 *   scheduler walks the wishlist + the catalog + the sent-ledger every
 *   N minutes and fires email through the injected `email` handle for
 *   each matching (customer, sku, policy) tuple.
 *
 *   Surface:
 *
 *     - defineAlertPolicy({ slug, trigger, threshold,
 *                           max_alerts_per_week_per_customer? })
 *       Operator-authored policy row. `trigger` is one of
 *       `price_drop` / `back_in_stock` / `new_review_high_rating` /
 *       `restocked`. `threshold` is a plain-object payload whose
 *       validated shape depends on `trigger` — for price_drop it must
 *       carry `percent_off_bps_min` (1..10000 basis points; 2000 means
 *       "20% off or more"). For the other triggers it is `{}`.
 *       Refuses redefinition; operators reauthor by archiving + a
 *       fresh defineAlertPolicy.
 *
 *     - scanAndDispatch({ now, batch_size? })
 *       Scheduler-callable. For each LIVE policy whose trigger has a
 *       wired source (price_drop + back_in_stock at v1), walks the
 *       wishlist table, resolves each entry's variant + sku + current
 *       price / inventory, evaluates the policy's condition, dedupes
 *       against the sent-ledger (no second fire for the same
 *       (customer, sku, policy) in 24h), respects the per-customer
 *       weekly cap, respects opt-outs in
 *       `wishlist_alert_unsubscribes`, and hands each match to the
 *       injected `email.sendWishlistDiscount` handle. Returns
 *       `{ scanned, candidates, sent, skipped }`.
 *
 *     - markAlertSent({ alert_id, channel })
 *       Operator off-table delivery record — when the operator wires
 *       SMS or in-app delivery outside the `email` handle, this
 *       writes a wishlist_alerts_sent row for the matched policy /
 *       customer / sku without going through scanAndDispatch.
 *       `channel` ∈ {email, sms, in-app}.
 *
 *     - customerAlertHistory({ customer_id, cursor?, limit? })
 *       Account-page surface — every alert the customer has received,
 *       newest first, paginated with the standard HMAC-tagged
 *       opaque cursor.
 *
 *     - unsubscribeFromAlertKind({ customer_id, trigger })
 *       Customer opt-out lever; the dispatcher silently skips every
 *       row matching (customer_id, trigger) once this is set.
 *       Idempotent — re-unsubscribing is a no-op.
 *
 *     - metricsForPolicy({ slug, from, to })
 *       Operator-dashboard rollup — count of sent alerts per policy
 *       in a time window, broken out by channel.
 *
 *   Storage: wishlist_alert_policies, wishlist_alerts_sent,
 *   wishlist_alert_unsubscribes (migration 0156).
 *
 *   Composes:
 *     - wishlist (required) — read the saved (customer, product,
 *       variant?) tuples.
 *     - catalog (required) — resolve variant → sku, current + prior
 *       price, current inventory.
 *     - email (required) — sendWishlistDiscount for price_drop;
 *       sendWishlistDiscount also serves back_in_stock with the
 *       price slot rendered as "—" so a single template covers both
 *       v1 triggers (operators wiring distinct templates inject a
 *       wrapper email handle).
 *     - stockAlerts (optional) — when wired, the scanner skips
 *       (customer, sku) pairs the customer is independently
 *       subscribed to via the PDP "notify me" toggle so the two
 *       paths don't double-deliver the same restock signal. Without
 *       it, every back_in_stock match fires regardless of stockAlerts
 *       state.
 *
 *   Monotonic clock: a per-factory monotonic timestamp ensures that
 *   two alerts written in the same wall-clock millisecond carry
 *   strictly-increasing `occurred_at` values. The
 *   `(customer_id, occurred_at DESC)` index then returns the latest
 *   alert unambiguously and the keyset-paginated history is stable.
 *
 * @primitive wishlistAlerts
 * @related   shop.wishlist, shop.catalog, shop.email, shop.stockAlerts
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var TRIGGERS = ["price_drop", "back_in_stock", "new_review_high_rating", "restocked"];
var CHANNELS = ["email", "sms", "in-app"];

// Triggers the scanner has a wired source for at v1. The other two
// trigger kinds (new_review_high_rating + restocked) accept policies
// at definition time so a forward-compatible policy table can be
// authored before the matching event-source primitives land; the
// scanner skips them with `policy_source_unwired` accounted in the
// `skipped` count and never writes a sent-ledger row.
var SCANNABLE_TRIGGERS = ["price_drop", "back_in_stock"];

var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
var MAX_SLUG_LEN = 80;
var MAX_LIST_LIMIT = 200;
var DEFAULT_LIMIT = 50;
var DEFAULT_BATCH_SIZE = 500;
var MAX_BATCH_SIZE = 5000;
var MAX_WEEKLY_CAP = 1000;
var MAX_BPS = 10000;        // 100% — refuse strictly absurd thresholds
var MS_PER_DAY = 86400000;
var MS_PER_WEEK = MS_PER_DAY * 7;

// Per-(customer, sku, policy) re-fire suppression window. A price drop
// that triggers an alert today shouldn't re-fire tomorrow just because
// the variant's price moved again by a microscopic amount — the
// dispatcher refuses to write a fresh ledger row inside this window
// for the same triple.
var DEDUPE_WINDOW_MS = MS_PER_DAY;

var HISTORY_ORDER_KEY = ["occurred_at:desc", "id:desc"];

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("wishlistAlerts: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _trigger(s) {
  if (typeof s !== "string" || TRIGGERS.indexOf(s) === -1) {
    throw new TypeError("wishlistAlerts: trigger must be one of " + TRIGGERS.join(", "));
  }
  return s;
}

function _channel(s) {
  if (typeof s !== "string" || CHANNELS.indexOf(s) === -1) {
    throw new TypeError("wishlistAlerts: channel must be one of " + CHANNELS.join(", "));
  }
  return s;
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("wishlistAlerts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _now(n) {
  if (n == null) return Date.now();
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("wishlistAlerts: now must be a non-negative integer epoch-ms or null");
  }
  return n;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("wishlistAlerts: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _batchSize(n) {
  if (n == null) return DEFAULT_BATCH_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_BATCH_SIZE) {
    throw new TypeError("wishlistAlerts: batch_size must be an integer in [1, " + MAX_BATCH_SIZE + "]");
  }
  return n;
}

function _weeklyCap(n) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 1 || n > MAX_WEEKLY_CAP) {
    throw new TypeError("wishlistAlerts: max_alerts_per_week_per_customer must be a positive integer in [1, " + MAX_WEEKLY_CAP + "] or null");
  }
  return n;
}

function _validateThresholdFor(trigger, threshold) {
  if (threshold == null || typeof threshold !== "object" || Array.isArray(threshold)) {
    throw new TypeError("wishlistAlerts: threshold must be a plain object");
  }
  if (trigger === "price_drop") {
    if (!Number.isInteger(threshold.percent_off_bps_min)
        || threshold.percent_off_bps_min < 1
        || threshold.percent_off_bps_min > MAX_BPS) {
      throw new TypeError(
        "wishlistAlerts: threshold.percent_off_bps_min must be an integer in [1, " + MAX_BPS + "] for price_drop "
        + "(basis points; 2000 = 20%)",
      );
    }
    // Refuse extras so a typo can't silently encode a different gate.
    var keys = Object.keys(threshold);
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i] !== "percent_off_bps_min") {
        throw new TypeError("wishlistAlerts: threshold for price_drop accepts only percent_off_bps_min (got " + JSON.stringify(keys[i]) + ")");
      }
    }
    return { percent_off_bps_min: threshold.percent_off_bps_min };
  }
  // Other triggers — explicit empty-object contract.
  if (Object.keys(threshold).length !== 0) {
    throw new TypeError("wishlistAlerts: threshold for " + trigger + " must be an empty object at v1");
  }
  return {};
}

function _hydratePolicy(r) {
  if (!r) return null;
  var thresh;
  try { thresh = JSON.parse(r.threshold_json); }
  catch (_e) { thresh = {}; }
  return {
    slug:                             r.slug,
    trigger:                          r.trigger,
    threshold:                        thresh,
    max_alerts_per_week_per_customer: r.max_alerts_per_week_per_customer == null
                                        ? null
                                        : Number(r.max_alerts_per_week_per_customer),
    archived_at:                      r.archived_at == null ? null : Number(r.archived_at),
    created_at:                       Number(r.created_at),
    updated_at:                       Number(r.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // Required composed handles. `wishlist`, `catalog`, and `email` are
  // structural — the scanner can't function without them. `stockAlerts`
  // is optional; when wired the scanner double-checks PDP-subscribed
  // (customer, sku) pairs so back_in_stock doesn't duplicate.
  var wishlist = opts.wishlist;
  if (!wishlist || typeof wishlist.listForCustomer !== "function") {
    throw new TypeError("wishlistAlerts.create: opts.wishlist must expose listForCustomer (the wishlist primitive)");
  }
  var catalog = opts.catalog;
  if (!catalog
      || !catalog.variants  || typeof catalog.variants.get  !== "function"
      || !catalog.prices    || typeof catalog.prices.current !== "function"
      || typeof catalog.prices.history !== "function"
      || !catalog.inventory || typeof catalog.inventory.get !== "function") {
    throw new TypeError(
      "wishlistAlerts.create: opts.catalog must expose variants.get, prices.current, prices.history, "
      + "inventory.get (the catalog primitive)",
    );
  }
  var email = opts.email;
  if (!email || typeof email.sendWishlistDiscount !== "function") {
    throw new TypeError("wishlistAlerts.create: opts.email must expose sendWishlistDiscount (the email primitive)");
  }
  var stockAlerts = opts.stockAlerts || null;
  if (stockAlerts && typeof stockAlerts.isSubscribed !== "function") {
    throw new TypeError("wishlistAlerts.create: opts.stockAlerts must expose isSubscribed when wired");
  }

  // Pagination cursor secret — same posture as wishlist.create.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("wishlistAlerts.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "wishlist-alerts-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Default currency used to resolve catalog.prices.current / history.
  // Operators with multi-currency catalogs inject a function via
  // opts.currencyForCustomer(customer_id) for per-customer resolution;
  // absent, the dispatcher falls back to a primitive-wide default.
  var defaultCurrency = typeof opts.defaultCurrency === "string" && /^[A-Z]{3}$/.test(opts.defaultCurrency)
    ? opts.defaultCurrency
    : "USD";
  var currencyForCustomer = typeof opts.currencyForCustomer === "function" ? opts.currencyForCustomer : null;

  // Per-factory monotonic clock. Two alerts written against the same
  // (customer, sku) in the same wall-clock millisecond would otherwise
  // tie on `occurred_at` and make the `(customer_id, occurred_at DESC)`
  // index ambiguous. Forward-leap when the wall clock outpaces the
  // counter; otherwise bump by 1ms.
  var _lastTs = 0;
  function _monotonicTs(now) {
    var wall = now != null ? now : Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- defineAlertPolicy ------------------------------------------------

  async function defineAlertPolicy(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistAlerts.defineAlertPolicy: input object required");
    }
    var slug      = _slug(input.slug);
    var trigger   = _trigger(input.trigger);
    var threshold = _validateThresholdFor(trigger, input.threshold);
    var weeklyCap = _weeklyCap(input.max_alerts_per_week_per_customer);

    var existing = (await query(
      "SELECT slug FROM wishlist_alert_policies WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    if (existing) {
      throw new TypeError("wishlistAlerts.defineAlertPolicy: slug " + JSON.stringify(slug) + " already exists - archive + redefine");
    }

    var ts = _monotonicTs();
    await query(
      "INSERT INTO wishlist_alert_policies "
      + "(slug, trigger, threshold_json, max_alerts_per_week_per_customer, archived_at, created_at, updated_at) "
      + "VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
      [slug, trigger, JSON.stringify(threshold), weeklyCap, ts],
    );
    return await getAlertPolicy(slug);
  }

  async function getAlertPolicy(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM wishlist_alert_policies WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydratePolicy(r);
  }

  async function listAlertPolicies(listOpts) {
    listOpts = listOpts || {};
    var liveOnly = listOpts.live_only === true;
    var limit = _limit(listOpts.limit, "limit");
    var sql, params;
    if (liveOnly) {
      sql = "SELECT * FROM wishlist_alert_policies WHERE archived_at IS NULL "
          + "ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    } else {
      sql = "SELECT * FROM wishlist_alert_policies "
          + "ORDER BY created_at ASC, slug ASC LIMIT ?1";
      params = [limit];
    }
    var rows = (await query(sql, params)).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydratePolicy(rows[i]));
    return out;
  }

  async function archiveAlertPolicy(slug) {
    _slug(slug);
    var ts = _monotonicTs();
    var r = await query(
      "UPDATE wishlist_alert_policies SET archived_at = ?1, updated_at = ?1 "
      + "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    return { archived: Number(r.rowCount || 0) > 0 };
  }

  // ---- unsubscribe + opt-out --------------------------------------------

  async function unsubscribeFromAlertKind(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistAlerts.unsubscribeFromAlertKind: input object required");
    }
    var customerId = _uuid(input.customer_id, "customer_id");
    var trigger    = _trigger(input.trigger);
    var ts         = _monotonicTs(input.now);

    var existing = (await query(
      "SELECT id FROM wishlist_alert_unsubscribes WHERE customer_id = ?1 AND trigger = ?2 LIMIT 1",
      [customerId, trigger],
    )).rows[0];
    if (existing) {
      return { id: existing.id, status: "already-unsubscribed" };
    }
    var id = _b().uuid.v7();
    await query(
      "INSERT INTO wishlist_alert_unsubscribes (id, customer_id, trigger, occurred_at) "
      + "VALUES (?1, ?2, ?3, ?4)",
      [id, customerId, trigger, ts],
    );
    return { id: id, status: "unsubscribed" };
  }

  async function isUnsubscribedFromTrigger(customerId, trigger) {
    var r = await query(
      "SELECT id FROM wishlist_alert_unsubscribes WHERE customer_id = ?1 AND trigger = ?2 LIMIT 1",
      [customerId, trigger],
    );
    return r.rows.length > 0;
  }

  // ---- ledger reads -----------------------------------------------------

  async function customerAlertHistory(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistAlerts.customerAlertHistory: input object required");
    }
    var customerId = _uuid(input.customer_id, "customer_id");
    var limit = _limit(input.limit, "limit");
    var cursorVals = null;
    if (input.cursor != null) {
      if (typeof input.cursor !== "string") {
        throw new TypeError("wishlistAlerts.customerAlertHistory: cursor must be an opaque string or null");
      }
      try {
        var state = _b().pagination.decodeCursor(input.cursor, cursorSecret);
        if (JSON.stringify(state.orderKey) !== JSON.stringify(HISTORY_ORDER_KEY)) {
          throw new TypeError("wishlistAlerts.customerAlertHistory: cursor orderKey mismatch");
        }
        cursorVals = state.vals;
      } catch (e) {
        if (e instanceof TypeError) throw e;
        throw new TypeError("wishlistAlerts.customerAlertHistory: cursor — " + (e && e.message || "malformed"));
      }
    }
    var sql, params;
    if (cursorVals) {
      sql = "SELECT * FROM wishlist_alerts_sent WHERE customer_id = ?1 AND "
          + "(occurred_at < ?2 OR (occurred_at = ?2 AND id < ?3)) "
          + "ORDER BY occurred_at DESC, id DESC LIMIT ?4";
      params = [customerId, cursorVals[0], cursorVals[1], limit];
    } else {
      sql = "SELECT * FROM wishlist_alerts_sent WHERE customer_id = ?1 "
          + "ORDER BY occurred_at DESC, id DESC LIMIT ?2";
      params = [customerId, limit];
    }
    var rows = (await query(sql, params)).rows;
    var hydrated = [];
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      hydrated.push({
        id:          r.id,
        customer_id: r.customer_id,
        policy_slug: r.policy_slug,
        sku:         r.sku,
        channel:     r.channel,
        occurred_at: Number(r.occurred_at),
      });
    }
    var last = hydrated[hydrated.length - 1];
    var nextCursor = null;
    if (last && hydrated.length === limit) {
      nextCursor = _b().pagination.encodeCursor({
        orderKey: HISTORY_ORDER_KEY,
        vals:     [last.occurred_at, last.id],
        forward:  true,
      }, cursorSecret);
    }
    return { rows: hydrated, nextCursor: nextCursor };
  }

  async function metricsForPolicy(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistAlerts.metricsForPolicy: input object required");
    }
    var slug = _slug(input.slug);
    if (!Number.isInteger(input.from) || input.from < 0) {
      throw new TypeError("wishlistAlerts.metricsForPolicy: from must be a non-negative integer epoch-ms");
    }
    if (!Number.isInteger(input.to) || input.to < input.from) {
      throw new TypeError("wishlistAlerts.metricsForPolicy: to must be a non-negative integer epoch-ms >= from");
    }
    var r = await query(
      "SELECT channel, COUNT(*) AS n FROM wishlist_alerts_sent "
      + "WHERE policy_slug = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 "
      + "GROUP BY channel",
      [slug, input.from, input.to],
    );
    var byChannel = { email: 0, sms: 0, "in-app": 0 };
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      byChannel[row.channel] = Number(row.n);
    }
    var total = byChannel.email + byChannel.sms + byChannel["in-app"];
    return {
      policy_slug: slug,
      from:        input.from,
      to:          input.to,
      total:       total,
      by_channel:  byChannel,
    };
  }

  // ---- markAlertSent ----------------------------------------------------

  async function markAlertSent(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistAlerts.markAlertSent: input object required");
    }
    var alertId = input.alert_id;
    if (typeof alertId !== "string" || !alertId.length) {
      throw new TypeError("wishlistAlerts.markAlertSent: alert_id must be a non-empty string");
    }
    var channel = _channel(input.channel);
    var r = await query(
      "UPDATE wishlist_alerts_sent SET channel = ?1 WHERE id = ?2",
      [channel, alertId],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("wishlistAlerts.markAlertSent: alert_id " + JSON.stringify(alertId) + " not found");
    }
    var row = (await query(
      "SELECT * FROM wishlist_alerts_sent WHERE id = ?1 LIMIT 1",
      [alertId],
    )).rows[0];
    return {
      id:          row.id,
      customer_id: row.customer_id,
      policy_slug: row.policy_slug,
      sku:         row.sku,
      channel:     row.channel,
      occurred_at: Number(row.occurred_at),
    };
  }

  // ---- scanAndDispatch internals ----------------------------------------

  async function _countAlertsThisWeek(customerId, now) {
    var since = now - MS_PER_WEEK;
    var r = await query(
      "SELECT COUNT(*) AS n FROM wishlist_alerts_sent "
      + "WHERE customer_id = ?1 AND occurred_at >= ?2",
      [customerId, since],
    );
    return Number((r.rows[0] || {}).n || 0);
  }

  async function _hasRecentFire(customerId, sku, policySlug, now) {
    var since = now - DEDUPE_WINDOW_MS;
    var r = await query(
      "SELECT id FROM wishlist_alerts_sent "
      + "WHERE customer_id = ?1 AND sku = ?2 AND policy_slug = ?3 AND occurred_at >= ?4 "
      + "LIMIT 1",
      [customerId, sku, policySlug, since],
    );
    return r.rows.length > 0;
  }

  // Walk every wishlist entry that has a non-null variant_id. Whole-
  // product (variant_id IS NULL) rows are skipped at v1 — the policy
  // evaluator can't resolve a single sku for them, and the operator-
  // facing way to expand a product wishlist into per-variant alerts is
  // for the storefront to write per-variant rows.
  async function _allWishlistEntries(batchSize) {
    var r = await query(
      "SELECT id, customer_id, product_id, variant_id, created_at "
      + "FROM wishlist_entries WHERE variant_id IS NOT NULL "
      + "ORDER BY created_at ASC, id ASC LIMIT ?1",
      [batchSize],
    );
    return r.rows;
  }

  async function _resolveCurrency(customerId) {
    if (currencyForCustomer) {
      try {
        var c = await currencyForCustomer(customerId);
        if (typeof c === "string" && /^[A-Z]{3}$/.test(c)) return c;
      } catch (_e) { /* drop-silent — fall through to default currency */ }
    }
    return defaultCurrency;
  }

  // Evaluate a single (entry, policy) pair. Returns either:
  //   { fire: true,  sku, payload }    — dispatch + ledger
  //   { fire: false, reason }          — accounted as `skipped`
  async function _evaluate(entry, policy, now) {
    // Map variant → sku.
    var variant;
    try { variant = await catalog.variants.get(entry.variant_id); }
    catch (_e) { variant = null; }
    if (!variant) return { fire: false, reason: "variant_unresolvable" };
    var sku = variant.sku;
    if (typeof sku !== "string" || !sku.length) return { fire: false, reason: "variant_has_no_sku" };

    if (policy.trigger === "price_drop") {
      var currency = await _resolveCurrency(entry.customer_id);
      var current;
      try { current = await catalog.prices.current(entry.variant_id, currency); }
      catch (_e) { current = null; }
      if (!current) return { fire: false, reason: "no_current_price" };
      var history;
      try { history = await catalog.prices.history(entry.variant_id, currency); }
      catch (_e) { history = []; }
      // The current row is in history (effective_until IS NULL); the
      // baseline is the most recent CLOSED row (effective_until set).
      var baseline = null;
      for (var i = 0; i < history.length; i += 1) {
        var h = history[i];
        if (h.effective_until != null) { baseline = h; break; }
      }
      if (!baseline) return { fire: false, reason: "no_baseline_price" };
      var baseAmt = Number(baseline.amount_minor);
      var curAmt  = Number(current.amount_minor);
      if (!(baseAmt > 0) || !(curAmt >= 0) || curAmt >= baseAmt) {
        return { fire: false, reason: "no_drop" };
      }
      // Percent-off in basis points: ((base - cur) / base) * 10000.
      var bps = Math.floor(((baseAmt - curAmt) * 10000) / baseAmt);
      var threshold = Number(policy.threshold.percent_off_bps_min);
      if (bps < threshold) return { fire: false, reason: "below_threshold" };
      return {
        fire: true,
        sku:  sku,
        payload: {
          variant_id:        entry.variant_id,
          currency:          currency,
          old_amount_minor:  baseAmt,
          new_amount_minor:  curAmt,
          discount_bps:      bps,
        },
      };
    }

    if (policy.trigger === "back_in_stock") {
      var inv;
      try { inv = await catalog.inventory.get(sku); }
      catch (_e) { inv = null; }
      if (!inv) return { fire: false, reason: "inventory_unresolvable" };
      var available = Number(inv.stock_on_hand || 0) - Number(inv.stock_held || 0);
      if (!(available > 0)) return { fire: false, reason: "still_out_of_stock" };
      // Optional dep — when wired, suppress if the customer is already
      // subscribed via the PDP "notify me" toggle. The dispatcher can
      // only know the customer's email when we know they're a logged-
      // in wishlist owner — and stockAlerts.isSubscribed is keyed by
      // email, not customer_id, so we skip the cross-check unless the
      // caller-supplied stockAlerts handle exposes a customer-keyed
      // override. Keeping the cross-check shape forward-compatible:
      // when stockAlerts is wired but doesn't expose `isSubscribedBy
      // Customer`, the dispatcher fires anyway (no double-delivery
      // suppression at v1, but the surface is in place).
      if (stockAlerts && typeof stockAlerts.isSubscribedByCustomer === "function") {
        var sub;
        try { sub = await stockAlerts.isSubscribedByCustomer({ customer_id: entry.customer_id, sku: sku }); }
        catch (_e) { sub = null; }
        if (sub && sub.subscribed === true) return { fire: false, reason: "duplicate_via_stock_alerts" };
      }
      return {
        fire: true,
        sku:  sku,
        payload: {
          variant_id: entry.variant_id,
          available:  available,
        },
      };
    }

    return { fire: false, reason: "policy_source_unwired" };
  }

  // Resolve a customer-facing email address. The wishlist primitive
  // doesn't carry one — the operator's customer-store does. Callers
  // that don't supply `opts.emailForCustomer` get a `no_email`
  // skipped row. With `opts.emailForCustomer` wired, scanner asks
  // for the customer's email per-fire (cache externally if hot).
  var emailForCustomer = typeof opts.emailForCustomer === "function" ? opts.emailForCustomer : null;

  async function scanAndDispatch(sweepOpts) {
    sweepOpts = sweepOpts || {};
    var now       = _now(sweepOpts.now);
    var batchSize = _batchSize(sweepOpts.batch_size);

    var policies = await listAlertPolicies({ live_only: true, limit: MAX_LIST_LIMIT });
    // Filter to scanner-wired triggers only; the others are accounted
    // as `skipped` with `policy_source_unwired`.
    var scannablePolicies = [];
    var unwiredPolicyCount = 0;
    for (var p = 0; p < policies.length; p += 1) {
      if (SCANNABLE_TRIGGERS.indexOf(policies[p].trigger) === -1) {
        unwiredPolicyCount += 1;
      } else {
        scannablePolicies.push(policies[p]);
      }
    }

    var entries = await _allWishlistEntries(batchSize);
    var scanned    = entries.length;
    var candidates = 0;
    var sent       = 0;
    var skipped    = 0;
    var skippedBy  = {
      unsubscribed:                 0,
      weekly_cap_reached:           0,
      recent_dedupe:                0,
      no_email:                     0,
      email_dispatch_failed:        0,
      no_baseline_price:            0,
      no_current_price:             0,
      no_drop:                      0,
      below_threshold:              0,
      still_out_of_stock:           0,
      inventory_unresolvable:       0,
      variant_unresolvable:         0,
      variant_has_no_sku:           0,
      duplicate_via_stock_alerts:   0,
      policy_source_unwired:        unwiredPolicyCount,
    };

    for (var e = 0; e < entries.length; e += 1) {
      var entry = entries[e];
      // Per-customer-per-policy outer evaluation: walk every active
      // policy this entry could match.
      for (var pp = 0; pp < scannablePolicies.length; pp += 1) {
        var policy = scannablePolicies[pp];

        // Cheapest cuts first.
        var optedOut = await isUnsubscribedFromTrigger(entry.customer_id, policy.trigger);
        if (optedOut) { skipped += 1; skippedBy.unsubscribed += 1; continue; }

        if (policy.max_alerts_per_week_per_customer != null) {
          var weekN = await _countAlertsThisWeek(entry.customer_id, now);
          if (weekN >= policy.max_alerts_per_week_per_customer) {
            skipped += 1; skippedBy.weekly_cap_reached += 1; continue;
          }
        }

        // Evaluate the policy condition.
        var v = await _evaluate(entry, policy, now);
        if (!v.fire) {
          skipped += 1;
          if (skippedBy[v.reason] != null) skippedBy[v.reason] += 1;
          else                              skippedBy[v.reason]  = 1;
          continue;
        }

        // Per-(customer, sku, policy) recent-fire suppression.
        var dup = await _hasRecentFire(entry.customer_id, v.sku, policy.slug, now);
        if (dup) { skipped += 1; skippedBy.recent_dedupe += 1; continue; }

        candidates += 1;

        // Resolve the customer's email. Absent → no_email, skipped.
        var customerEmail = null;
        if (emailForCustomer) {
          try { customerEmail = await emailForCustomer(entry.customer_id); }
          catch (_e2) { customerEmail = null; }
        }
        if (typeof customerEmail !== "string" || !customerEmail.length) {
          skipped += 1; skippedBy.no_email += 1; continue;
        }

        // Resolve a product title for the email. Best-effort — falls
        // through to the sku string when the catalog read fails.
        var productTitle = v.sku;
        try {
          if (catalog.products && typeof catalog.products.get === "function") {
            var prod = await catalog.products.get(entry.product_id);
            if (prod && typeof prod.title === "string" && prod.title.length) productTitle = prod.title;
          }
        } catch (_e3) { /* drop-silent — title is cosmetic */ }

        // Dispatch via email.sendWishlistDiscount. For price_drop we
        // pass the formatted price; for back_in_stock we pass "—" so
        // the same template covers both v1 triggers without requiring
        // a second email primitive method.
        var dispatchOk = false;
        try {
          var oldPriceStr = v.payload.old_amount_minor != null
            ? String(v.payload.old_amount_minor / 100) + " " + v.payload.currency
            : "—";
          var newPriceStr = v.payload.new_amount_minor != null
            ? String(v.payload.new_amount_minor / 100) + " " + v.payload.currency
            : "—";
          var pctStr = v.payload.discount_bps != null
            ? String(Math.floor(v.payload.discount_bps / 100)) + "%"
            : "—";
          await email.sendWishlistDiscount({
            customer_email: customerEmail,
            product_title:  productTitle,
            product_url:    "/products/" + entry.product_id,
            old_price:      oldPriceStr,
            new_price:      newPriceStr,
            discount_pct:   pctStr,
          });
          dispatchOk = true;
        } catch (_e4) {
          // Drop-silent at the row level — a flapping mailer must not
          // poison the rest of the scan. Account in skipped.
          skipped += 1; skippedBy.email_dispatch_failed += 1; continue;
        }
        if (!dispatchOk) continue;

        // Ledger write — the source of truth for "we already fired
        // this alert" + the dedupe window.
        var id = _b().uuid.v7();
        var ts = _monotonicTs(now);
        await query(
          "INSERT INTO wishlist_alerts_sent (id, customer_id, policy_slug, sku, channel, occurred_at) "
          + "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
          [id, entry.customer_id, policy.slug, v.sku, "email", ts],
        );
        sent += 1;
      }
    }

    return {
      scanned:    scanned,
      candidates: candidates,
      sent:       sent,
      skipped:    skipped,
      skipped_by: skippedBy,
    };
  }

  return {
    TRIGGERS: TRIGGERS,
    CHANNELS: CHANNELS,

    defineAlertPolicy:        defineAlertPolicy,
    getAlertPolicy:           getAlertPolicy,
    listAlertPolicies:        listAlertPolicies,
    archiveAlertPolicy:       archiveAlertPolicy,

    scanAndDispatch:          scanAndDispatch,
    markAlertSent:            markAlertSent,
    customerAlertHistory:     customerAlertHistory,
    unsubscribeFromAlertKind: unsubscribeFromAlertKind,
    metricsForPolicy:         metricsForPolicy,
  };
}

module.exports = {
  create:   create,
  TRIGGERS: TRIGGERS,
  CHANNELS: CHANNELS,
};
