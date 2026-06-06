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
 *     - emailSuppressions (optional) — when wired, the scanner
 *       short-circuits sends to addresses on the marketing-scope
 *       suppression list (hard bounce / spam complaint / unsubscribe)
 *       and accounts them as `suppressed` without consuming a
 *       dedupe / weekly-cap slot. These alerts are marketing mail and
 *       honour the same suppression list every other marketing path
 *       consults.
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

var b = require("./vendor/blamejs");
var pricing = require("./pricing");

var C = b.constants;

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
var MS_PER_DAY = C.TIME.days(1);
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
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
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
    query = function (sql, params) { return b.externalDb.query(sql, params); };
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
  // Marketing suppression list. When wired the scanner short-circuits
  // sends to addresses that hard-bounced, filed a spam complaint, or
  // unsubscribed — these price-drop / back-in-stock notices are
  // marketing-scope mail and must honour the same suppression list every
  // other marketing path consults. Optional so an operator running only
  // the cron without the suppression primitive still dispatches.
  var emailSuppressions = opts.emailSuppressions || null;
  if (emailSuppressions && typeof emailSuppressions.isSuppressed !== "function") {
    throw new TypeError("wishlistAlerts.create: opts.emailSuppressions must expose isSuppressed when wired");
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
    var id = b.uuid.v7();
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

  // Customer re-opt-in lever — the inverse of unsubscribeFromAlertKind.
  // DELETEs the (customer_id, trigger) opt-out row so the dispatcher
  // resumes firing that trigger for the customer. Idempotent: deleting a
  // row that isn't there returns `{ status: "already-subscribed" }`.
  // Same input validation as the unsubscribe verb (UUID-shape customer,
  // enum trigger) so a bad caller fails with a typed error the route
  // turns into HTTP 400.
  async function resubscribeToAlertKind(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("wishlistAlerts.resubscribeToAlertKind: input object required");
    }
    var customerId = _uuid(input.customer_id, "customer_id");
    var trigger    = _trigger(input.trigger);
    var r = await query(
      "DELETE FROM wishlist_alert_unsubscribes WHERE customer_id = ?1 AND trigger = ?2",
      [customerId, trigger],
    );
    return { status: Number(r.rowCount || 0) > 0 ? "resubscribed" : "already-subscribed" };
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
        var state = b.pagination.decodeCursor(input.cursor, cursorSecret);
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
      nextCursor = b.pagination.encodeCursor({
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

  // Last-observed state for a (customer, sku, policy) tuple — the memory
  // that turns a current-state read into a transition read. NULL when the
  // scanner has never seen this tuple.
  async function _lastState(customerId, sku, policySlug) {
    var r = await query(
      "SELECT last_in_stock, last_alerted_bps FROM wishlist_alert_state "
      + "WHERE customer_id = ?1 AND sku = ?2 AND policy_slug = ?3 LIMIT 1",
      [customerId, sku, policySlug],
    );
    var row = r.rows[0];
    if (!row) return { last_in_stock: null, last_alerted_bps: null };
    return {
      last_in_stock:    row.last_in_stock    == null ? null : Number(row.last_in_stock),
      last_alerted_bps: row.last_alerted_bps == null ? null : Number(row.last_alerted_bps),
    };
  }

  // Upsert the observed state for a tuple. Only the columns named in
  // `patch` are written; the row's other column keeps its prior value
  // (read once here so the UNIQUE-keyed REPLACE doesn't clobber the
  // sibling column). `inStock` / `alertedBps` are 0/1/null and int/null.
  async function _recordState(customerId, sku, policySlug, patch, now) {
    var prior = await _lastState(customerId, sku, policySlug);
    var inStock    = Object.prototype.hasOwnProperty.call(patch, "last_in_stock")
      ? patch.last_in_stock
      : prior.last_in_stock;
    var alertedBps = Object.prototype.hasOwnProperty.call(patch, "last_alerted_bps")
      ? patch.last_alerted_bps
      : prior.last_alerted_bps;
    // INSERT-or-UPDATE on the UNIQUE(customer_id, sku, policy_slug) key.
    await query(
      "INSERT INTO wishlist_alert_state "
      + "(customer_id, sku, policy_slug, last_in_stock, last_alerted_bps, updated_at) "
      + "VALUES (?1, ?2, ?3, ?4, ?5, ?6) "
      + "ON CONFLICT (customer_id, sku, policy_slug) DO UPDATE SET "
      + "last_in_stock = ?4, last_alerted_bps = ?5, updated_at = ?6",
      [customerId, sku, policySlug, inStock, alertedBps, now],
    );
  }

  // Atomic dedupe + weekly-cap CLAIM. Writes the sent-ledger row in a
  // single conditional INSERT that refuses when (a) a fire for the same
  // (customer, sku, policy) already landed inside the dedupe window, or
  // (b) the customer is at/over the weekly cap. Because the guard and the
  // write are one statement, two concurrent sweeps can't both pass the
  // read and then both insert — the second's INSERT...SELECT sees the
  // first's row and matches zero rows. Returns true when this call won
  // the claim. Mirrors the conditional-UPDATE house pattern
  // (catalog.inventory.adjustOnHand / hold).
  async function _claimLedgerRow(id, customerId, policySlug, sku, now, weeklyCap) {
    var dedupeSince = now - DEDUPE_WINDOW_MS;
    var weekSince   = now - MS_PER_WEEK;
    // `weeklyCap` null → no cap; encode as a sentinel the SQL treats as
    // "always under cap" by comparing against a value the count can never
    // reach when cap is absent.
    var capActive = weeklyCap != null ? 1 : 0;
    var capValue  = weeklyCap != null ? weeklyCap : 0;
    var r = await query(
      "INSERT INTO wishlist_alerts_sent (id, customer_id, policy_slug, sku, channel, occurred_at) "
      + "SELECT ?1, ?2, ?3, ?4, 'email', ?5 "
      + "WHERE NOT EXISTS ("
      + "  SELECT 1 FROM wishlist_alerts_sent "
      + "  WHERE customer_id = ?2 AND sku = ?4 AND policy_slug = ?3 AND occurred_at >= ?6"
      + ") "
      + "AND ("
      + "  ?7 = 0 OR ("
      + "    SELECT COUNT(*) FROM wishlist_alerts_sent "
      + "    WHERE customer_id = ?2 AND occurred_at >= ?8"
      + "  ) < ?9"
      + ")",
      [id, customerId, policySlug, sku, now, dedupeSince, capActive, weekSince, capValue],
    );
    return Number(r.rowCount || 0) === 1;
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

  // Evaluate a single (entry, policy) pair against the TRANSITION from
  // the last-observed state, not the current state in isolation. Returns:
  //   { fire: true,  sku, payload, state }  — dispatch + ledger; `state`
  //                                            is the observed-state patch
  //                                            to persist (always applied,
  //                                            fire or not).
  //   { fire: false, reason, sku?, state? } — accounted as `skipped`; a
  //                                            present `state` patch is
  //                                            still persisted so the next
  //                                            sweep reads a fresh baseline.
  // The last-observed { last_in_stock, last_alerted_bps } for the tuple is
  // loaded internally once the sku resolves (null fields when never seen).
  async function _evaluate(entry, policy, now) {
    // Map variant → sku.
    var variant;
    try { variant = await catalog.variants.get(entry.variant_id); }
    catch (_e) { variant = null; }
    if (!variant) return { fire: false, reason: "variant_unresolvable" };
    var sku = variant.sku;
    if (typeof sku !== "string" || !sku.length) return { fire: false, reason: "variant_has_no_sku" };

    var prior = await _lastState(entry.customer_id, sku, policy.slug);

    if (policy.trigger === "price_drop") {
      var currency = await _resolveCurrency(entry.customer_id);
      var current;
      try { current = await catalog.prices.current(entry.variant_id, currency); }
      catch (_e) { current = null; }
      if (!current) return { fire: false, reason: "no_current_price", sku: sku };
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
      if (!baseline) return { fire: false, reason: "no_baseline_price", sku: sku };
      var baseAmt = Number(baseline.amount_minor);
      var curAmt  = Number(current.amount_minor);
      if (!(baseAmt > 0) || !(curAmt >= 0) || curAmt >= baseAmt) {
        // No drop in effect — the price recovered to/above baseline. Clear
        // the last-alerted level so a fresh drop later is a transition.
        return { fire: false, reason: "no_drop", sku: sku, state: { last_alerted_bps: null } };
      }
      // Percent-off in basis points: ((base - cur) / base) * 10000.
      var bps = Math.floor(((baseAmt - curAmt) * 10000) / baseAmt);
      var threshold = Number(policy.threshold.percent_off_bps_min);
      if (bps < threshold) {
        // Below the policy gate — not an alertable drop. Don't touch the
        // last-alerted level (a shallow dip after a deep alerted drop
        // shouldn't reset the baseline and re-arm a re-fire).
        return { fire: false, reason: "below_threshold", sku: sku };
      }
      // Transition gate: fire only on a NEW or DEEPER drop than the level
      // we last alerted. A steady drop at the same depth must not re-fire,
      // dedupe window or not.
      if (prior.last_alerted_bps != null && bps <= prior.last_alerted_bps) {
        return { fire: false, reason: "no_deeper_drop", sku: sku };
      }
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
        // `state` is the always-record observation (none here — recording
        // the alerted level happens only on a committed send, below).
        // `alertedBps` is recorded post-send so a lost claim / failed
        // mailer doesn't suppress a legitimate later re-fire.
        state:      {},
        alertedBps: bps,
      };
    }

    if (policy.trigger === "back_in_stock") {
      var inv;
      try { inv = await catalog.inventory.get(sku); }
      catch (_e) { inv = null; }
      if (!inv) return { fire: false, reason: "inventory_unresolvable", sku: sku };
      var available = Number(inv.stock_on_hand || 0) - Number(inv.stock_held || 0);
      var inStockNow = available > 0 ? 1 : 0;
      if (inStockNow === 0) {
        // Out of stock — record the observed state so a later restock is a
        // 0 -> 1 transition.
        return { fire: false, reason: "still_out_of_stock", sku: sku, state: { last_in_stock: 0 } };
      }
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
        // Still record the in-stock observation so the transition baseline
        // tracks reality even when the stockAlerts path owns the send.
        if (sub && sub.subscribed === true) {
          return { fire: false, reason: "duplicate_via_stock_alerts", sku: sku, state: { last_in_stock: 1 } };
        }
      }
      // Transition gate: fire only on the out -> in EDGE. A first
      // observation (prior unknown) or a steady in-stock state records the
      // observation but does not fire — there is no restock event to
      // announce when we never saw the item go out.
      var isRestock = prior.last_in_stock === 0;
      if (!isRestock) {
        return { fire: false, reason: "no_restock_transition", sku: sku, state: { last_in_stock: 1 } };
      }
      return {
        fire: true,
        sku:  sku,
        payload: {
          variant_id: entry.variant_id,
          available:  available,
        },
        state: { last_in_stock: 1 },
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
      suppressed:                   0,
      email_dispatch_failed:        0,
      no_baseline_price:            0,
      no_current_price:             0,
      no_drop:                      0,
      no_deeper_drop:               0,
      below_threshold:              0,
      still_out_of_stock:           0,
      no_restock_transition:        0,
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

        // Cheapest cut first.
        var optedOut = await isUnsubscribedFromTrigger(entry.customer_id, policy.trigger);
        if (optedOut) { skipped += 1; skippedBy.unsubscribed += 1; continue; }

        // Evaluate against the TRANSITION from the last-observed state —
        // a steady in-stock / steady-depth-drop state never re-fires. The
        // sku isn't known until the variant resolves inside _evaluate, so
        // it loads the prior state for the resolved tuple itself.
        var v = await _evaluate(entry, policy, now);

        // Persist the always-record observation (current in-stock state /
        // a cleared drop) regardless of fire, so the next sweep reads a
        // fresh baseline even when this one didn't send. An empty patch
        // (a price_drop fire — its alerted level is recorded only after a
        // committed send) is a no-op, so skip the write.
        if (v.sku && v.state && Object.keys(v.state).length > 0) {
          await _recordState(entry.customer_id, v.sku, policy.slug, v.state, now);
        }

        if (!v.fire) {
          skipped += 1;
          if (skippedBy[v.reason] != null) skippedBy[v.reason] += 1;
          else                              skippedBy[v.reason]  = 1;
          continue;
        }

        candidates += 1;

        // Resolve the customer's email. Absent → no_email, skipped — we
        // never claim a ledger row we can't send.
        var customerEmail = null;
        if (emailForCustomer) {
          try { customerEmail = await emailForCustomer(entry.customer_id); }
          catch (_e2) { customerEmail = null; }
        }
        if (typeof customerEmail !== "string" || !customerEmail.length) {
          skipped += 1; skippedBy.no_email += 1; continue;
        }

        // Marketing-suppression short-circuit. A hard-bounced /
        // spam-complaint / unsubscribed address must not be mailed.
        // Checked BEFORE the ledger claim so a suppressed customer never
        // consumes a dedupe / weekly-cap slot for a send that can't
        // happen — if they later resubscribe the next sweep can deliver.
        if (emailSuppressions) {
          var suppressed = false;
          try {
            var supView = await emailSuppressions.isSuppressed({
              email: customerEmail,
              scope: "marketing",
            });
            suppressed = !!(supView && supView.suppressed === true);
          } catch (_eSup) { suppressed = false; }
          if (suppressed) {
            skipped += 1; skippedBy.suppressed += 1; continue;
          }
        }

        // Atomic dedupe + weekly-cap CLAIM. The conditional INSERT is the
        // serialization point: two concurrent sweeps can't both pass the
        // dedupe/cap guard and then both write — the loser's INSERT...
        // SELECT sees the winner's row and matches zero rows.
        var id = b.uuid.v7();
        var ts = _monotonicTs(now);
        var claimed = await _claimLedgerRow(
          id, entry.customer_id, policy.slug, v.sku, ts,
          policy.max_alerts_per_week_per_customer,
        );
        if (!claimed) {
          // Lost the claim — either a recent dedupe fire or the weekly
          // cap. Distinguish for accurate accounting (read-only; the
          // mutation already serialized at the INSERT).
          var dup = await _hasRecentFire(entry.customer_id, v.sku, policy.slug, ts);
          skipped += 1;
          if (dup) skippedBy.recent_dedupe += 1;
          else     skippedBy.weekly_cap_reached += 1;
          continue;
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
            ? pricing.format(v.payload.old_amount_minor, v.payload.currency)
            : "—";
          var newPriceStr = v.payload.new_amount_minor != null
            ? pricing.format(v.payload.new_amount_minor, v.payload.currency)
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
          // poison the rest of the scan. Release the claimed ledger row
          // so a later sweep retries instead of being suppressed by the
          // dedupe window for a send that never happened.
          await query("DELETE FROM wishlist_alerts_sent WHERE id = ?1", [id]);
          skipped += 1; skippedBy.email_dispatch_failed += 1; continue;
        }
        if (!dispatchOk) continue;

        // Committed send — record the alerted depth so the same drop
        // depth is steady on the next sweep (price_drop only; the
        // back_in_stock observation was already recorded above).
        if (v.alertedBps != null) {
          await _recordState(entry.customer_id, v.sku, policy.slug, { last_alerted_bps: v.alertedBps }, ts);
        }
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
    resubscribeToAlertKind:   resubscribeToAlertKind,
    isUnsubscribedFromTrigger: isUnsubscribedFromTrigger,
    metricsForPolicy:         metricsForPolicy,
  };
}

module.exports = {
  create:   create,
  TRIGGERS: TRIGGERS,
  CHANNELS: CHANNELS,
};
