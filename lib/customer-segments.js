"use strict";
/**
 * @module shop.customerSegments
 * @title  Customer segments — RFM-style operator-defined groupings
 *
 * @intro
 *   Operators define named segments — "VIPs", "lapsed-90d", "high-
 *   value-new", "high-refund-rate" — as a bag of rule predicates
 *   ANDed together. The primitive evaluates the segment against the
 *   shop's order history (orders + return_authorizations) and
 *   returns the matching customer ids for targeted campaigns
 *   (newsletter sends, retention emails, loyalty bonuses).
 *
 *   Surface:
 *
 *     - defineSegment({ slug, title, description?, rules })
 *         Create a new segment. `slug` is the stable operator-facing
 *         handle (UNIQUE). `rules` is an AND-composed predicate bag —
 *         every predicate must hold for a customer to land in the
 *         segment. Unknown rule keys are refused at define time so a
 *         typo doesn't silently produce an empty segment.
 *
 *         Supported rule keys:
 *
 *           recency_days_max         — last paid order ≤ N days ago
 *           recency_days_min         — last paid order ≥ N days ago
 *                                       (the "lapsed" half of RFM)
 *           frequency_orders_min     — count of paid orders ≥ N
 *                                       (lifetime; combine with
 *                                       recency_days_max for
 *                                       "frequent recent buyer")
 *           lifetime_orders_min      — alias of frequency_orders_min
 *                                       kept for spec parity
 *           lifetime_orders_max      — count of paid orders ≤ N
 *                                       (used to gate "new" buyers)
 *           monetary_minor_min       — lifetime gross_total_minor ≥ N
 *           monetary_minor_max       — lifetime gross_total_minor ≤ N
 *           aov_minor_min            — avg-order-value ≥ N
 *           refund_rate_bps_max      — refunds / orders in bps ≤ N
 *                                       (10000 bps = 100%); customers
 *                                       with zero orders are excluded
 *                                       from this gate (no division)
 *           refund_rate_bps_min      — refunds / orders in bps ≥ N
 *           last_order_status_in     — last paid order's status is in
 *                                       the supplied list (e.g.
 *                                       ["refunded"] catches
 *                                       post-refund customers)
 *           country_in               — last paid order's ship-to
 *                                       country is in the supplied
 *                                       2-letter ISO list
 *           currency_in              — last paid order's currency in
 *                                       list (3-letter ISO)
 *
 *     - evaluate(slug, { limit?, cursor? })
 *         Returns matching `customer_id`s from the membership cache,
 *         paginated via b.pagination HMAC cursor. Reads only — call
 *         `recompute()` to refresh the cache.
 *
 *     - recompute({ slugs? })
 *         Operator scheduler entry point. Re-evaluates every active
 *         segment (or the supplied subset) against the live order /
 *         return tables and rewrites `customer_segment_membership`.
 *         Archived segments are skipped (their cache stays empty).
 *
 *     - segmentsForCustomer(customer_id)
 *         Returns the active segments the customer currently sits in.
 *
 *     - listSegments({ include_archived? })
 *         Enumerate every defined segment.
 *
 *     - update(slug, patch)
 *         Mutates title / description / rules. Does NOT auto-recompute
 *         — the next scheduler tick will pick up the change.
 *
 *     - archive(slug) / unarchive(slug)
 *         Soft-delete. Archive clears the cache; unarchive marks the
 *         segment for the next recompute.
 *
 *     - stats(slug)
 *         { member_count, avg_lifetime_minor, last_recomputed_at }.
 *
 *   Composition:
 *
 *     - b.guardUuid     — every customer_id / segment_id is shape-
 *                          checked at the entry point.
 *     - b.uuid.v7        — segment row ids (also lexicographically
 *                          sortable, but the primary sort key is
 *                          customer_id within a segment).
 *     - b.pagination     — HMAC-tagged cursor on (customer_id ASC)
 *                          for `evaluate` so an operator can't
 *                          hand-craft a cursor to skip past a hidden
 *                          row or replay across deployments.
 *
 *   Storage:
 *
 *     - customer_segments + customer_segment_membership
 *       (migration 0049_customer_segments.sql).
 *
 *   Cache semantics:
 *
 *     The membership table is a denormalized cache. Newly defined or
 *     updated segments don't appear in `evaluate()` output until the
 *     next `recompute()` — by design, since campaign sends usually
 *     run off a snapshot. Archive clears the cache immediately so a
 *     cancelled segment doesn't leak into a campaign mid-send.
 *
 * @primitive customerSegments
 * @related   b.guardUuid, b.pagination, b.uuid
 */

var b = require("./index").framework;
var C = b.constants;

var DEFAULT_LIMIT = 100;
var MAX_LIMIT     = 1000;
var SLUG_RE       = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
var MAX_TITLE_LEN = 200;
var MAX_DESC_LEN  = 1000;
var MAX_LIST_LEN  = 64;   // country_in / last_order_status_in / currency_in caps
var ORDER_KEY     = ["customer_id:asc"];

var KNOWN_RULE_KEYS = Object.freeze([
  "recency_days_max",
  "recency_days_min",
  "frequency_orders_min",
  "lifetime_orders_min",
  "lifetime_orders_max",
  "monetary_minor_min",
  "monetary_minor_max",
  "aov_minor_min",
  "refund_rate_bps_max",
  "refund_rate_bps_min",
  "last_order_status_in",
  "country_in",
  "currency_in",
]);

var ALLOWED_ORDER_STATUSES = Object.freeze([
  "pending", "paid", "fulfilling", "shipped", "delivered", "refunded", "cancelled",
]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("customer-segments: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("customer-segments: slug must match /^[a-z0-9][a-z0-9_-]*[a-z0-9]?$/ (≤ 64 chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("customer-segments: title must be a non-empty string");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("customer-segments: title must be ≤ " + MAX_TITLE_LEN + " chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError("customer-segments: title must not contain control bytes");
  }
  return s;
}

function _description(s) {
  if (s == null || s === "") return "";
  if (typeof s !== "string") {
    throw new TypeError("customer-segments: description must be a string");
  }
  if (s.length > MAX_DESC_LEN) {
    throw new TypeError("customer-segments: description must be ≤ " + MAX_DESC_LEN + " chars");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) {
    throw new TypeError("customer-segments: description must not contain control bytes");
  }
  return s;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("customer-segments: " + label + " must be a non-negative integer");
  }
  return n;
}

function _bps(n, label) {
  _nonNegInt(n, label);
  if (n > 10000) {
    throw new TypeError("customer-segments: " + label + " must be ≤ 10000 (basis points)");
  }
  return n;
}

function _stringList(arr, label, validator) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("customer-segments: " + label + " must be a non-empty array");
  }
  if (arr.length > MAX_LIST_LEN) {
    throw new TypeError("customer-segments: " + label + " must contain ≤ " + MAX_LIST_LEN + " entries");
  }
  var seen = {};
  for (var i = 0; i < arr.length; i += 1) {
    var v = arr[i];
    if (typeof v !== "string") {
      throw new TypeError("customer-segments: " + label + "[" + i + "] must be a string");
    }
    if (validator) validator(v, label + "[" + i + "]");
    if (seen[v]) {
      throw new TypeError("customer-segments: " + label + " has duplicate entry " + JSON.stringify(v));
    }
    seen[v] = true;
  }
  return arr.slice();
}

function _countryCode(v, label) {
  if (!/^[A-Z]{2}$/.test(v)) {
    throw new TypeError("customer-segments: " + label + " must be a 2-letter ISO 3166-1 country code");
  }
}

function _currencyCode(v, label) {
  if (!/^[A-Z]{3}$/.test(v)) {
    throw new TypeError("customer-segments: " + label + " must be a 3-letter ISO 4217 currency code");
  }
}

function _statusValue(v, label) {
  if (ALLOWED_ORDER_STATUSES.indexOf(v) === -1) {
    throw new TypeError("customer-segments: " + label + " must be one of " + ALLOWED_ORDER_STATUSES.join(", "));
  }
}

function _validateRules(rules) {
  if (rules == null || typeof rules !== "object" || Array.isArray(rules)) {
    throw new TypeError("customer-segments: rules must be a plain object");
  }
  var keys = Object.keys(rules);
  if (keys.length === 0) {
    throw new TypeError("customer-segments: rules must contain at least one predicate");
  }
  var out = {};
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (KNOWN_RULE_KEYS.indexOf(k) === -1) {
      throw new TypeError("customer-segments: unknown rule key " + JSON.stringify(k) +
        " (allowed: " + KNOWN_RULE_KEYS.join(", ") + ")");
    }
    var v = rules[k];
    switch (k) {
      case "recency_days_max":
      case "recency_days_min":
      case "frequency_orders_min":
      case "lifetime_orders_min":
      case "lifetime_orders_max":
      case "monetary_minor_min":
      case "monetary_minor_max":
      case "aov_minor_min":
        _nonNegInt(v, "rules." + k);
        out[k] = v;
        break;
      case "refund_rate_bps_max":
      case "refund_rate_bps_min":
        _bps(v, "rules." + k);
        out[k] = v;
        break;
      case "last_order_status_in":
        out[k] = _stringList(v, "rules." + k, _statusValue);
        break;
      case "country_in":
        out[k] = _stringList(v, "rules." + k, _countryCode);
        break;
      case "currency_in":
        out[k] = _stringList(v, "rules." + k, _currencyCode);
        break;
      default:
        // Unreachable — KNOWN_RULE_KEYS gate above catches anything
        // else. Falling through here would silently drop a rule, so
        // we throw to surface the missing branch in development.
        throw new TypeError("customer-segments: rule key " + JSON.stringify(k) + " has no validator");
    }
  }
  // Coherence: min ≤ max where both are set.
  if (out.lifetime_orders_min != null && out.lifetime_orders_max != null
      && out.lifetime_orders_min > out.lifetime_orders_max) {
    throw new TypeError("customer-segments: rules.lifetime_orders_min must be ≤ lifetime_orders_max");
  }
  if (out.monetary_minor_min != null && out.monetary_minor_max != null
      && out.monetary_minor_min > out.monetary_minor_max) {
    throw new TypeError("customer-segments: rules.monetary_minor_min must be ≤ monetary_minor_max");
  }
  if (out.refund_rate_bps_min != null && out.refund_rate_bps_max != null
      && out.refund_rate_bps_min > out.refund_rate_bps_max) {
    throw new TypeError("customer-segments: rules.refund_rate_bps_min must be ≤ refund_rate_bps_max");
  }
  if (out.recency_days_min != null && out.recency_days_max != null
      && out.recency_days_min > out.recency_days_max) {
    throw new TypeError("customer-segments: rules.recency_days_min must be ≤ recency_days_max");
  }
  return out;
}

function _limit(n, label) {
  if (n == null) return DEFAULT_LIMIT;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new TypeError("customer-segments: " + label + " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pagination cursors for evaluate() are HMAC-tagged via b.pagination
  // so an operator can't hand-craft one to skip past a hidden row or
  // replay across deployments. The secret defaults to a dev-only
  // placeholder so the primitive boots in tests; production deploys
  // supply a derived value (typically b.crypto.namespaceHash(
  // "customer-segments-cursor", D1_BRIDGE_SECRET)).
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("customer-segments.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "customer-segments-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  async function _readSegment(slug) {
    var r = await query(
      "SELECT id, slug, title, description, rules_json, archived_at, " +
      "last_recomputed_at, last_member_count, created_at, updated_at " +
      "FROM customer_segments WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows[0] || null;
  }

  function _hydrate(row) {
    if (!row) return null;
    var rules;
    try { rules = JSON.parse(row.rules_json); }
    catch (_e) { rules = {}; }
    return {
      id:                 row.id,
      slug:               row.slug,
      title:              row.title,
      description:        row.description,
      rules:              rules,
      archived_at:        row.archived_at,
      last_recomputed_at: row.last_recomputed_at,
      last_member_count:  row.last_member_count,
      created_at:         row.created_at,
      updated_at:         row.updated_at,
    };
  }

  // Build the customer aggregate row set that segment rules predicate
  // against. One row per customer_id observed in the orders table.
  // Cancelled orders are excluded entirely (matches the analytics +
  // sales-reports policy). Refund rate is computed from refunded-
  // status orders, not from return_authorizations directly — an order
  // moves to status='refunded' when its refund completes, which is
  // the same FSM gate the operator dashboards use.
  async function _customerAggregates(nowTs) {
    var r = await query(
      "SELECT customer_id, " +
      "  COUNT(*) AS order_count, " +
      "  SUM(grand_total_minor) AS gross_minor, " +
      "  MAX(created_at) AS last_order_at, " +
      "  SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) AS refunded_count " +
      "FROM orders " +
      "WHERE customer_id IS NOT NULL AND status != 'cancelled' " +
      "GROUP BY customer_id",
      [],
    );
    var rows = r.rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      var orderCount = Number(row.order_count || 0);
      var gross = Number(row.gross_minor || 0);
      var refunded = Number(row.refunded_count || 0);
      var lastAt = Number(row.last_order_at || 0);
      var aov = orderCount > 0 ? Math.floor(gross / orderCount) : 0;
      var refundBps = orderCount > 0 ? Math.floor((refunded * 10000) / orderCount) : 0;
      var recencyDays = lastAt > 0 ? Math.floor((nowTs - lastAt) / C.TIME.days(1)) : null;
      out.push({
        customer_id:    row.customer_id,
        order_count:    orderCount,
        gross_minor:    gross,
        aov_minor:      aov,
        last_order_at:  lastAt,
        recency_days:   recencyDays,
        refunded_count: refunded,
        refund_rate_bps: refundBps,
      });
    }
    return out;
  }

  // Per-customer last-paid-order context (status, country, currency)
  // needed for the last_order_status_in / country_in / currency_in
  // predicates. Skipping cancelled orders so a cancelled last order
  // doesn't surface as the "current" state.
  async function _lastOrderContext() {
    var r = await query(
      "SELECT o.customer_id, o.status, o.currency, o.ship_to_json, o.created_at " +
      "FROM orders o " +
      "WHERE o.customer_id IS NOT NULL AND o.status != 'cancelled' " +
      "  AND o.created_at = (" +
      "    SELECT MAX(o2.created_at) FROM orders o2 " +
      "    WHERE o2.customer_id = o.customer_id AND o2.status != 'cancelled'" +
      "  )",
      [],
    );
    var byCustomer = {};
    var rows = r.rows;
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      // If two orders share the same created_at timestamp the inner
      // MAX returns both — pick the first deterministically; the
      // last-order predicates don't need cross-row ordering once
      // we're at the max timestamp.
      if (byCustomer[row.customer_id]) continue;
      var country = null;
      try {
        var shipTo = JSON.parse(row.ship_to_json || "{}");
        if (shipTo && typeof shipTo.country === "string") country = shipTo.country;
      } catch (_e) { /* drop-silent — ship_to_json is operator-shaped */ }
      byCustomer[row.customer_id] = {
        status:   row.status,
        currency: row.currency,
        country:  country,
      };
    }
    return byCustomer;
  }

  // Pure predicate evaluator. Returns true iff every rule in the
  // segment matches the customer aggregate row. Unknown rule keys
  // never reach this function — they're rejected at define time.
  function _matches(rules, agg, ctx) {
    if (rules.recency_days_max != null) {
      if (agg.recency_days == null || agg.recency_days > rules.recency_days_max) return false;
    }
    if (rules.recency_days_min != null) {
      if (agg.recency_days == null || agg.recency_days < rules.recency_days_min) return false;
    }
    if (rules.frequency_orders_min != null) {
      if (agg.order_count < rules.frequency_orders_min) return false;
    }
    if (rules.lifetime_orders_min != null) {
      if (agg.order_count < rules.lifetime_orders_min) return false;
    }
    if (rules.lifetime_orders_max != null) {
      if (agg.order_count > rules.lifetime_orders_max) return false;
    }
    if (rules.monetary_minor_min != null) {
      if (agg.gross_minor < rules.monetary_minor_min) return false;
    }
    if (rules.monetary_minor_max != null) {
      if (agg.gross_minor > rules.monetary_minor_max) return false;
    }
    if (rules.aov_minor_min != null) {
      if (agg.aov_minor < rules.aov_minor_min) return false;
    }
    if (rules.refund_rate_bps_max != null) {
      // Customers with zero orders never reach this branch (the
      // aggregate query filters them out). Refund rate is a true
      // fraction once we have at least one order.
      if (agg.refund_rate_bps > rules.refund_rate_bps_max) return false;
    }
    if (rules.refund_rate_bps_min != null) {
      if (agg.refund_rate_bps < rules.refund_rate_bps_min) return false;
    }
    if (rules.last_order_status_in != null) {
      if (!ctx || rules.last_order_status_in.indexOf(ctx.status) === -1) return false;
    }
    if (rules.country_in != null) {
      if (!ctx || ctx.country == null || rules.country_in.indexOf(ctx.country) === -1) return false;
    }
    if (rules.currency_in != null) {
      if (!ctx || rules.currency_in.indexOf(ctx.currency) === -1) return false;
    }
    return true;
  }

  // Recompute the membership for one segment. Returns the count of
  // matched customers. Caller owns the transactional shape: this
  // helper assumes the prior cache row set has already been deleted.
  async function _recomputeSegment(segment, aggregates, lastContext, ts) {
    if (segment.archived_at != null) return 0;
    var rules = JSON.parse(segment.rules_json);
    var matched = 0;
    for (var i = 0; i < aggregates.length; i += 1) {
      var agg = aggregates[i];
      var ctx = lastContext[agg.customer_id] || null;
      if (!_matches(rules, agg, ctx)) continue;
      await query(
        "INSERT INTO customer_segment_membership (segment_id, customer_id, evaluated_at) " +
        "VALUES (?1, ?2, ?3)",
        [segment.id, agg.customer_id, ts],
      );
      matched += 1;
    }
    await query(
      "UPDATE customer_segments SET last_recomputed_at = ?1, last_member_count = ?2, " +
      "updated_at = ?1 WHERE id = ?3",
      [ts, matched, segment.id],
    );
    return matched;
  }

  return {
    KNOWN_RULE_KEYS:        KNOWN_RULE_KEYS.slice(),
    ALLOWED_ORDER_STATUSES: ALLOWED_ORDER_STATUSES.slice(),
    DEFAULT_LIMIT:          DEFAULT_LIMIT,
    MAX_LIMIT:              MAX_LIMIT,

    defineSegment: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("customer-segments.defineSegment: input object required");
      }
      var slug        = _slug(input.slug);
      var title       = _title(input.title);
      var description = _description(input.description);
      var rules       = _validateRules(input.rules);

      var existing = await _readSegment(slug);
      if (existing) {
        var err = new Error("customer-segments.defineSegment: slug " + JSON.stringify(slug) + " already defined");
        err.code = "CUSTOMER_SEGMENT_SLUG_EXISTS";
        throw err;
      }

      var id = b.uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO customer_segments " +
        "(id, slug, title, description, rules_json, archived_at, " +
        " last_recomputed_at, last_member_count, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0, ?6, ?6)",
        [id, slug, title, description, JSON.stringify(rules), ts],
      );
      return _hydrate(await _readSegment(slug));
    },

    evaluate: async function (slug, evalOpts) {
      _slug(slug);
      evalOpts = evalOpts || {};
      var limit = _limit(evalOpts.limit, "limit");

      var seg = await _readSegment(slug);
      if (!seg) {
        throw new TypeError("customer-segments.evaluate: unknown slug " + JSON.stringify(slug));
      }
      if (seg.archived_at != null) {
        // Archived segments evaluate to empty — we cleared the cache
        // on archive(), but a defensive check guards against an
        // operator manually inserting rows in the membership table.
        return { customer_ids: [], next_cursor: null };
      }

      var cursorVal = null;
      if (evalOpts.cursor != null) {
        if (typeof evalOpts.cursor !== "string") {
          throw new TypeError("customer-segments.evaluate: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(evalOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(ORDER_KEY)) {
            throw new TypeError("customer-segments.evaluate: cursor orderKey mismatch");
          }
          cursorVal = state.vals[0];
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("customer-segments.evaluate: cursor — " + (e && e.message || "malformed"));
        }
      }

      var sql, params;
      if (cursorVal != null) {
        sql = "SELECT customer_id FROM customer_segment_membership " +
              "WHERE segment_id = ?1 AND customer_id > ?2 " +
              "ORDER BY customer_id ASC LIMIT ?3";
        params = [seg.id, cursorVal, limit];
      } else {
        sql = "SELECT customer_id FROM customer_segment_membership " +
              "WHERE segment_id = ?1 ORDER BY customer_id ASC LIMIT ?2";
        params = [seg.id, limit];
      }
      var rows = (await query(sql, params)).rows;
      var ids = [];
      for (var i = 0; i < rows.length; i += 1) ids.push(rows[i].customer_id);
      var nextCursor = null;
      if (ids.length === limit) {
        nextCursor = b.pagination.encodeCursor({
          orderKey: ORDER_KEY,
          vals:     [ids[ids.length - 1]],
          forward:  true,
        }, cursorSecret);
      }
      return { customer_ids: ids, next_cursor: nextCursor };
    },

    recompute: async function (recomputeOpts) {
      recomputeOpts = recomputeOpts || {};
      var slugFilter = null;
      if (recomputeOpts.slugs != null) {
        if (!Array.isArray(recomputeOpts.slugs)) {
          throw new TypeError("customer-segments.recompute: slugs must be an array");
        }
        slugFilter = {};
        for (var i = 0; i < recomputeOpts.slugs.length; i += 1) {
          slugFilter[_slug(recomputeOpts.slugs[i])] = true;
        }
      }
      var ts = _now();
      var segments = (await query(
        "SELECT id, slug, title, description, rules_json, archived_at, " +
        "last_recomputed_at, last_member_count, created_at, updated_at " +
        "FROM customer_segments WHERE archived_at IS NULL",
        [],
      )).rows;
      var aggregates = await _customerAggregates(ts);
      var lastContext = await _lastOrderContext();

      var report = { segments_evaluated: 0, total_members: 0, per_segment: {} };
      for (var j = 0; j < segments.length; j += 1) {
        var seg = segments[j];
        if (slugFilter && !slugFilter[seg.slug]) continue;
        await query(
          "DELETE FROM customer_segment_membership WHERE segment_id = ?1",
          [seg.id],
        );
        var count = await _recomputeSegment(seg, aggregates, lastContext, ts);
        report.segments_evaluated += 1;
        report.total_members += count;
        report.per_segment[seg.slug] = count;
      }
      return report;
    },

    segmentsForCustomer: async function (customerId) {
      _uuid(customerId, "customer_id");
      var r = await query(
        "SELECT cs.slug, cs.title, cs.description, cs.rules_json, cs.last_recomputed_at, " +
        "csm.evaluated_at " +
        "FROM customer_segment_membership csm " +
        "JOIN customer_segments cs ON cs.id = csm.segment_id " +
        "WHERE csm.customer_id = ?1 AND cs.archived_at IS NULL " +
        "ORDER BY cs.slug ASC",
        [customerId],
      );
      var rows = r.rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var row = rows[i];
        var rules;
        try { rules = JSON.parse(row.rules_json); }
        catch (_e) { rules = {}; }
        out.push({
          slug:               row.slug,
          title:              row.title,
          description:        row.description,
          rules:              rules,
          last_recomputed_at: row.last_recomputed_at,
          evaluated_at:       row.evaluated_at,
        });
      }
      return out;
    },

    listSegments: async function (listOpts) {
      listOpts = listOpts || {};
      var includeArchived = !!listOpts.include_archived;
      var sql = "SELECT id, slug, title, description, rules_json, archived_at, " +
                "last_recomputed_at, last_member_count, created_at, updated_at " +
                "FROM customer_segments";
      if (!includeArchived) sql += " WHERE archived_at IS NULL";
      sql += " ORDER BY slug ASC";
      var rows = (await query(sql, [])).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_hydrate(rows[i]));
      return out;
    },

    update: async function (slug, patch) {
      _slug(slug);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("customer-segments.update: patch object required");
      }
      var existing = await _readSegment(slug);
      if (!existing) {
        throw new TypeError("customer-segments.update: unknown slug " + JSON.stringify(slug));
      }

      var nextTitle = existing.title;
      var nextDesc  = existing.description;
      var nextRules = existing.rules_json;

      if (Object.prototype.hasOwnProperty.call(patch, "title")) {
        nextTitle = _title(patch.title);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "description")) {
        nextDesc = _description(patch.description);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "rules")) {
        nextRules = JSON.stringify(_validateRules(patch.rules));
      }

      var ts = _now();
      await query(
        "UPDATE customer_segments SET title = ?1, description = ?2, rules_json = ?3, " +
        "updated_at = ?4 WHERE id = ?5",
        [nextTitle, nextDesc, nextRules, ts, existing.id],
      );
      return _hydrate(await _readSegment(slug));
    },

    archive: async function (slug) {
      _slug(slug);
      var existing = await _readSegment(slug);
      if (!existing) {
        throw new TypeError("customer-segments.archive: unknown slug " + JSON.stringify(slug));
      }
      if (existing.archived_at != null) {
        return _hydrate(existing);
      }
      var ts = _now();
      await query(
        "UPDATE customer_segments SET archived_at = ?1, updated_at = ?1, last_member_count = 0 " +
        "WHERE id = ?2",
        [ts, existing.id],
      );
      // Clear the cache so a campaign mid-send doesn't pick up rows
      // for an archived segment.
      await query(
        "DELETE FROM customer_segment_membership WHERE segment_id = ?1",
        [existing.id],
      );
      return _hydrate(await _readSegment(slug));
    },

    unarchive: async function (slug) {
      _slug(slug);
      var existing = await _readSegment(slug);
      if (!existing) {
        throw new TypeError("customer-segments.unarchive: unknown slug " + JSON.stringify(slug));
      }
      if (existing.archived_at == null) {
        return _hydrate(existing);
      }
      var ts = _now();
      await query(
        "UPDATE customer_segments SET archived_at = NULL, updated_at = ?1 WHERE id = ?2",
        [ts, existing.id],
      );
      return _hydrate(await _readSegment(slug));
    },

    stats: async function (slug) {
      _slug(slug);
      var seg = await _readSegment(slug);
      if (!seg) {
        throw new TypeError("customer-segments.stats: unknown slug " + JSON.stringify(slug));
      }
      // Live member count from the cache so a count run mid-recompute
      // reflects what's actually visible to evaluate(). The
      // last_member_count column on the segment row records the
      // value at last_recomputed_at — equal once the recompute
      // settles.
      var memberRow = (await query(
        "SELECT COUNT(*) AS n FROM customer_segment_membership WHERE segment_id = ?1",
        [seg.id],
      )).rows[0] || {};
      var memberCount = Number(memberRow.n || 0);
      var avgRow = (await query(
        "SELECT AVG(o.grand_total_minor * 1.0) AS avg_minor " +
        "FROM customer_segment_membership csm " +
        "JOIN orders o ON o.customer_id = csm.customer_id " +
        "WHERE csm.segment_id = ?1 AND o.status != 'cancelled'",
        [seg.id],
      )).rows[0] || {};
      var avgMinor = avgRow.avg_minor == null ? 0 : Math.round(Number(avgRow.avg_minor));
      return {
        slug:               seg.slug,
        member_count:       memberCount,
        avg_lifetime_minor: avgMinor,
        last_recomputed_at: seg.last_recomputed_at,
      };
    },
  };
}

module.exports = {
  create:                 create,
  KNOWN_RULE_KEYS:        KNOWN_RULE_KEYS,
  ALLOWED_ORDER_STATUSES: ALLOWED_ORDER_STATUSES,
  DEFAULT_LIMIT:          DEFAULT_LIMIT,
  MAX_LIMIT:              MAX_LIMIT,
};
