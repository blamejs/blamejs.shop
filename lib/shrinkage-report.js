"use strict";
/**
 * @module shop.shrinkageReport
 * @title  Shrinkage report — loss-prevention dashboard aggregations
 *         over inventory_writeoffs
 *
 * @intro
 *   Operators record stock that left the building without a sale
 *   through the `inventoryWriteoffs` primitive (eight enumerated
 *   reasons: damaged / lost / shrinkage / expired / recall / sample /
 *   quality_control / theft). The dashboard surface is this primitive
 *   — read-only aggregations over those rows, sliced by reason /
 *   period / location / sku / category, and a `flagAnomalies` detector
 *   that surfaces locations whose loss in the period sits more than
 *   `threshold_multiplier` standard deviations above the cross-
 *   location mean. Every result reports units (always available) and
 *   cost-impact (when costLayers was wired at write-off time so the
 *   `cost_impact_minor` column on the source row carries a number).
 *
 *   Surface (every method async; every method honors a cache opt-in):
 *
 *     report({ from, to, location_code?, sku?, reason? })
 *       Top-level rollup. Returns:
 *         {
 *           from, to,
 *           total_units,
 *           total_cost_impact_minor,            // null when nothing carries cost
 *           currency,                           // null when no cost rows
 *           period_shrinkage_rate_bps,          // total_units * 10000 / aggregate-on-hand
 *           by_reason:   [{ reason, units, cost_impact_minor, currency, share_bps }],
 *           by_location: [{ location_code, units, cost_impact_minor, currency, share_bps }],
 *           by_sku:      [{ sku, units, cost_impact_minor, currency, share_bps }],
 *           by_category: [{ category, units, cost_impact_minor, currency, share_bps }]
 *         }
 *       Filters compose with AND. Reversed rows are excluded
 *       (operator un-did them; they didn't actually cost anything).
 *       `period_shrinkage_rate_bps` is integer basis points
 *       (0..10000+ — the rate can exceed 100% if more units were
 *       written off than the on-hand baseline, e.g. catastrophic
 *       theft event). The operator-facing dashboard renders
 *       `bps / 100` as a percentage.
 *
 *     topLossLocations({ from, to, limit? })
 *       Top-N locations ranked by cost-impact desc, units desc as the
 *       tie-break. `limit` defaults to 10, capped at 100. Returns
 *       `[{ location_code, units, cost_impact_minor, currency,
 *       reason_top, reason_top_units }]` — `reason_top` is the most
 *       frequent reason on that location in the window (which bucket
 *       drives the loss). Locations with zero loss in the window are
 *       excluded.
 *
 *     topShrinkageSkus({ from, to, limit? })
 *       Top-N SKUs ranked by units desc, cost-impact desc as the
 *       tie-break. Same shape as topLossLocations but indexed by sku
 *       + carries a `location_top` field naming the location with the
 *       most writeoffs for that SKU. The `units` primary sort matches
 *       loss-prevention intuition — operators care about "which SKUs
 *       walk most often", not "which SKUs are most expensive when
 *       they walk".
 *
 *     categoryComparison({ from, to })
 *       Side-by-side comparison of the four reason-categories the
 *       primitive defines (operational / perishable / external /
 *       deliberate). Returns `[{ category, units, cost_impact_minor,
 *       currency, share_bps, top_reason, top_reason_units }]`,
 *       ordered by units desc. Reason → category mapping:
 *
 *         operational  — damaged, quality_control
 *         perishable   — expired, recall
 *         external     — sample
 *         deliberate   — lost, shrinkage, theft
 *
 *     monthlyTrend({ from, to })
 *       Per-month rollup over the window. Returns `[{ bucket_start,
 *       units, cost_impact_minor, currency }]` — bucket_start is the
 *       first day of the month (UTC, YYYY-MM-DD). Windows up to
 *       2 years are supported; longer windows refused (the trend
 *       line on the dashboard caps at 24 ticks for legibility).
 *
 *     reasonBreakdownPie({ from, to })
 *       Pie-chart-shaped breakdown by reason. Returns `[{ reason,
 *       units, share_bps, color_hint }]` — `color_hint` is a stable
 *       per-reason CSS color string so the dashboard renders the
 *       same wedge color across refreshes without a separate
 *       theme-table join.
 *
 *     flagAnomalies({ from, to, threshold_multiplier?, min_units? })
 *       Statistical-outlier detection over per-location loss. The
 *       primitive computes the mean + sample-stddev of units across
 *       every location with at least `min_units` write-offs in the
 *       window (default 1), then flags every location whose units
 *       exceed `mean + threshold_multiplier * stddev` (default 2.0 —
 *       roughly the upper 5% in a normal distribution). Returns
 *       `[{ location_code, units, cost_impact_minor, currency,
 *       z_score, mean, stddev, threshold }]` ordered by z_score
 *       desc. When fewer than 2 locations have writeoffs in the
 *       window, returns `[]` (stddev undefined; no anomaly call
 *       possible). Anomaly call is one of the loudest loss-
 *       prevention signals in retail — surfaced separately from the
 *       top-N so the dashboard can color it red without forcing the
 *       operator to read a leaderboard for clues.
 *
 *     purgeExpired(nowTs?)
 *       Operator-cron sweep: deletes cache rows whose
 *       `computed_at + scope-TTL <= now`. Returns `{ deleted }`.
 *
 *   Composition (compose-only — never hand-rolls primitives that
 *   blamejs already ships):
 *     - b.crypto.namespaceHash — params_hash on cache rows.
 *     - b.uuid.v7              — cache-row ids.
 *
 *   Three-tier input validation (use the discipline; don't write the
 *   labels): every public verb is a config-time entry point — bad
 *   shape throws. No drop-silent hot-path sinks: aggregations are
 *   operator dashboards, not request-path observability.
 *
 *   Strict-monotonic clock: per-factory `_monotonicTs()` ensures two
 *   cache rows written in the same wall-clock millisecond don't tie
 *   on `computed_at` (matters when the dashboard does fan-out reads
 *   inside the same event-loop tick).
 *
 *   No-MVP scope: every report is wired through the cache layer; the
 *   anomaly detector handles the single-location degenerate case
 *   explicitly; cost-impact attribution is currency-coherent across
 *   each rollup (mixed-currency periods refuse to roll up a single
 *   cost_impact total). `inventoryWriteoffs?` injection is optional
 *   only because the primitive reads from the table directly via the
 *   query handle — the injection is reserved for future cross-call
 *   composition (writeoffs.subscribe-to-invalidation).
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- constants ----------------------------------------------------------

var DAY_MS          = C.TIME.days(1);
var TWO_YEARS_MS    = 730 * DAY_MS;
var MAX_LIMIT       = 100;
var DEFAULT_LIMIT   = 10;

var CACHE_NAMESPACE = "shrinkage-report-cache";

// Cache TTLs by scope. Operator can override per-call via
// `cache_ttl_ms`; these are the safe defaults — short enough that a
// new write-off shows up on a refresh, long enough that an operator
// hammering the dashboard doesn't re-scan the writeoffs table on
// every keystroke. Anomaly detection caches the longest because the
// computation is the heaviest and the operator response time on a
// red-flag alert is minutes-not-seconds.
var DEFAULT_CACHE_TTL_MS = Object.freeze({
  report:               C.TIME.minutes(1),
  top_locations:        C.TIME.minutes(5),
  top_skus:             C.TIME.minutes(5),
  category_comparison:  C.TIME.minutes(5),
  monthly_trend:        C.TIME.minutes(10),
  reason_pie:           C.TIME.minutes(5),
  anomalies:            C.TIME.minutes(15),
});

// Reason-category mapping. Frozen at module load so the operator-
// facing categoryComparison surface returns a stable shape and the
// reason_pie color-hint table can mirror the same partition.
var REASON_CATEGORY = Object.freeze({
  damaged:         "operational",
  quality_control: "operational",
  expired:         "perishable",
  recall:          "perishable",
  sample:          "external",
  lost:            "deliberate",
  shrinkage:       "deliberate",
  theft:           "deliberate",
});

var REASON_ENUM = Object.freeze([
  "damaged", "lost", "shrinkage", "expired",
  "recall", "sample", "quality_control", "theft",
]);

// Stable CSS color hints for the pie-chart wedges. Frozen so a
// dashboard refresh after a vendor update doesn't shuffle wedge
// colors (operators build visual muscle memory on the chart).
var REASON_COLOR = Object.freeze({
  damaged:         "#d97706",   // amber-600
  lost:            "#7c3aed",   // violet-600
  shrinkage:       "#dc2626",   // red-600
  expired:         "#65a30d",   // lime-600
  recall:          "#ea580c",   // orange-600
  sample:          "#0891b2",   // cyan-600
  quality_control: "#0284c7",   // sky-600
  theft:           "#9f1239",   // rose-800
});

// Validation regex — matches the inventory-writeoffs primitive so
// rollup filter inputs honor the same shape gates as the producer.
var CODE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKU_RE  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---- validators ---------------------------------------------------------

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("shrinkage-report: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}

function _resolveWindow(opts, maxSpanMs) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("shrinkage-report: input object required (from + to epoch-ms)");
  }
  if (opts.from == null || opts.to == null) {
    throw new TypeError("shrinkage-report: from and to are required (epoch-ms)");
  }
  _epochMs(opts.from, "from");
  _epochMs(opts.to,   "to");
  if (opts.from >= opts.to) {
    throw new TypeError("shrinkage-report: from must be strictly less than to");
  }
  var span = opts.to - opts.from;
  var bound = maxSpanMs == null ? TWO_YEARS_MS : maxSpanMs;
  if (span > bound) {
    throw new TypeError("shrinkage-report: window (to - from) must be ≤ " + bound + "ms");
  }
  return { from: opts.from, to: opts.to };
}

function _limit(n, label) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) {
    throw new TypeError("shrinkage-report: " + (label || "limit") +
      " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return n;
}

function _optReason(v) {
  if (v == null) return null;
  if (typeof v !== "string" || REASON_ENUM.indexOf(v) === -1) {
    throw new TypeError("shrinkage-report: reason must be one of " +
      REASON_ENUM.join(", ") + ", got " + JSON.stringify(v));
  }
  return v;
}

function _optCode(v, label) {
  if (v == null) return null;
  if (typeof v !== "string" || !CODE_RE.test(v)) {
    throw new TypeError("shrinkage-report: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
  return v;
}

function _optSku(v) {
  if (v == null) return null;
  if (typeof v !== "string" || !SKU_RE.test(v)) {
    throw new TypeError("shrinkage-report: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return v;
}

function _finitePositive(n, label) {
  if (typeof n !== "number" || !isFinite(n) || n <= 0) {
    throw new TypeError("shrinkage-report: " + label + " must be a positive finite number");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("shrinkage-report: " + label + " must be a non-negative integer");
  }
  return n;
}

// Canonical JSON for cache key — sorted keys, stable across runs so
// the same input hashes the same way every time.
function _canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(_canonicalJSON).join(",") + "]";
  }
  var keys = Object.keys(value).sort();
  var parts = [];
  for (var i = 0; i < keys.length; i += 1) {
    parts.push(JSON.stringify(keys[i]) + ":" + _canonicalJSON(value[keys[i]]));
  }
  return "{" + parts.join(",") + "}";
}

// Currency-coherence reducer over a per-(group, currency) rowset.
// Returns the single coherent currency across the rowset or null
// when none of the rows carry a currency (no costLayers wiring at
// write-off time). Throws when two distinct currencies appear — a
// rolled-up cost_impact across mixed currencies is meaningless
// without an FX conversion this primitive doesn't own.
function _coherentCurrency(rows, label) {
  var currency = null;
  for (var i = 0; i < rows.length; i += 1) {
    var c = rows[i].currency;
    if (c == null) continue;
    if (currency == null) currency = c;
    else if (c !== currency) {
      throw new TypeError("shrinkage-report: " + label + " spans multiple currencies (" +
        currency + ", " + c + ") — reconcile before reporting");
    }
  }
  return currency;
}

// Share-of-total in integer basis points (0..10000). Returns 0 when
// total is zero (avoids NaN; the dashboard reads 0 as "no share").
function _shareBps(part, total) {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10000);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // The `inventoryWriteoffs?` / `costLayers?` / `order?` peer
  // injections are reserved for future cross-call composition (e.g.
  // write-off events triggering targeted cache invalidation). The
  // primitive reads from the canonical tables directly via `query`
  // today, so storing the references is enough — using them happens
  // when the corresponding cross-primitive verb lands.
  var writeoffsPeer = opts.inventoryWriteoffs == null ? null : opts.inventoryWriteoffs;
  var costLayersPeer = opts.costLayers == null ? null : opts.costLayers;
  var orderPeer      = opts.order == null ? null : opts.order;

  // Per-factory monotonic clock for cache `computed_at` stamps. Two
  // cache refreshes against the same scope in the same wall-clock
  // millisecond would otherwise tie on computed_at and confuse the
  // freshness check. Forward-leap when wall outpaces the counter;
  // otherwise bump by 1ms so the sequence stays strictly increasing
  // per primitive instance.
  var _lastTs = 0;
  function _monotonicTs() {
    var wall = Date.now();
    if (wall > _lastTs) _lastTs = wall;
    else                _lastTs += 1;
    return _lastTs;
  }

  // ---- cache helpers --------------------------------------------------

  function _scopeValue(scopeKey, params) {
    var payload = scopeKey + "::" + _canonicalJSON(params);
    return _b().crypto.namespaceHash(CACHE_NAMESPACE, payload);
  }

  async function _cacheLookup(scopeKey, scopeValue, periodFrom, periodTo, ttlMs, nowTs) {
    var r = await query(
      "SELECT breakdown_json, computed_at FROM shrinkage_report_cache " +
      " WHERE scope_key = ?1 AND scope_value = ?2 " +
      "   AND period_from = ?3 AND period_to = ?4",
      [scopeKey, scopeValue, periodFrom, periodTo],
    );
    if (!r.rows.length) return null;
    var computedAt = Number(r.rows[0].computed_at) || 0;
    if (computedAt + ttlMs <= nowTs) return null;
    try { return JSON.parse(r.rows[0].breakdown_json); }
    catch (_e) { return null; }                                              // drop-silent — bad JSON falls through to recompute
  }

  async function _cacheStore(scopeKey, scopeValue, periodFrom, periodTo, result) {
    var id = _b().uuid.v7();
    var totalUnits = Number.isInteger(result && result.total_units) ? result.total_units : 0;
    var totalCost = (result && result.total_cost_impact_minor != null)
      ? Number(result.total_cost_impact_minor)
      : null;
    var nowTs = _monotonicTs();
    // REPLACE on the unique (scope_key, scope_value, period_from,
    // period_to) — keeps the index clean without leaving stale rows.
    await query(
      "DELETE FROM shrinkage_report_cache " +
      " WHERE scope_key = ?1 AND scope_value = ?2 " +
      "   AND period_from = ?3 AND period_to = ?4",
      [scopeKey, scopeValue, periodFrom, periodTo],
    );
    await query(
      "INSERT INTO shrinkage_report_cache " +
      "(id, scope_key, scope_value, period_from, period_to, " +
      " total_units, total_cost_impact_minor, breakdown_json, computed_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      [id, scopeKey, scopeValue, periodFrom, periodTo,
        totalUnits, totalCost, JSON.stringify(result), nowTs],
    );
  }

  // Wrap a recompute function with the cache. `enabled` defaults
  // off; opt-in per call via `opts.cache === true` so test fixtures
  // see fresh data and dashboards opt in explicitly.
  async function _withCache(scopeKey, params, cacheOpts, periodFrom, periodTo, recompute) {
    if (!cacheOpts || cacheOpts.cache !== true) return recompute();
    var ttl = cacheOpts.cache_ttl_ms == null
      ? DEFAULT_CACHE_TTL_MS[scopeKey]
      : cacheOpts.cache_ttl_ms;
    if (!Number.isInteger(ttl) || ttl < 0) {
      throw new TypeError("shrinkage-report: cache_ttl_ms must be a non-negative integer");
    }
    var scopeValue = _scopeValue(scopeKey, params);
    var nowTs = Date.now();
    var hit = await _cacheLookup(scopeKey, scopeValue, periodFrom, periodTo, ttl, nowTs);
    if (hit) return hit;
    var fresh = await recompute();
    if (ttl > 0) await _cacheStore(scopeKey, scopeValue, periodFrom, periodTo, fresh);
    return fresh;
  }

  // ---- shared rollup helpers ------------------------------------------

  // Base WHERE clause for the writeoffs scan: period + status +
  // optional filters. Returns `{ clauses, params, nextIdx }`. Every
  // caller appends additional clauses to the same array if needed.
  function _baseScanWhere(window, filters) {
    var clauses = ["occurred_at >= ?1", "occurred_at < ?2", "status = 'recorded'"];
    var params  = [window.from, window.to];
    var idx = 3;
    if (filters) {
      if (filters.location_code != null) {
        clauses.push("location_code = ?" + idx);
        params.push(filters.location_code);
        idx += 1;
      }
      if (filters.sku != null) {
        clauses.push("sku = ?" + idx);
        params.push(filters.sku);
        idx += 1;
      }
      if (filters.reason != null) {
        clauses.push("reason = ?" + idx);
        params.push(filters.reason);
        idx += 1;
      }
    }
    return { clauses: clauses, params: params, nextIdx: idx };
  }

  async function _groupedScan(groupCol, window, filters) {
    var base = _baseScanWhere(window, filters);
    // GROUP BY both the dimension AND currency so the currency-
    // coherence check has the raw split available; the caller folds
    // multi-currency rows on the same key into one (sum units; sum
    // cost only when currencies match).
    var sql =
      "SELECT " + groupCol + " AS k, currency, " +
      "       SUM(quantity) AS units, " +
      "       SUM(cost_impact_minor) AS cost_impact_minor " +
      "  FROM inventory_writeoffs " +
      " WHERE " + base.clauses.join(" AND ") +
      " GROUP BY " + groupCol + ", currency";
    var r = await query(sql, base.params);
    return r.rows.map(function (row) {
      return {
        k:                  row.k,
        currency:           row.currency,
        units:              Number(row.units) || 0,
        cost_impact_minor:  row.cost_impact_minor == null ? null : Number(row.cost_impact_minor),
      };
    });
  }

  // Fold per-(dimension, currency) rows into per-dimension records.
  // Sums units across currencies, sums cost_impact within a single
  // coherent currency (multi-currency cost on the same dimension
  // refuses with a clear operator-facing error — same posture as
  // inventoryWriteoffs.costImpactForPeriod). Records with no cost
  // rows surface `cost_impact_minor: null` (the costLayers wiring
  // wasn't on when the write-off landed; the operator sees "units
  // known, value unknown").
  function _foldByKey(rows, label) {
    var bucket = Object.create(null);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (row.k == null) continue;
      var key = String(row.k);
      var slot = bucket[key];
      if (!slot) {
        slot = bucket[key] = { units: 0, cost_impact_minor: null, currency: null };
      }
      slot.units += row.units;
      if (row.cost_impact_minor != null) {
        if (slot.currency != null && slot.currency !== row.currency) {
          throw new TypeError("shrinkage-report: " + label + " '" + key +
            "' spans multiple currencies (" + slot.currency + ", " + row.currency +
            ") — reconcile before reporting");
        }
        slot.currency = row.currency;
        slot.cost_impact_minor = (slot.cost_impact_minor || 0) + row.cost_impact_minor;
      }
    }
    var keys = Object.keys(bucket).sort();
    var out = [];
    for (var j = 0; j < keys.length; j += 1) {
      var b = bucket[keys[j]];
      out.push({
        key:               keys[j],
        units:             b.units,
        cost_impact_minor: b.cost_impact_minor,
        currency:          b.currency,
      });
    }
    return out;
  }

  // SUM(quantity) + SUM(cost_impact_minor) across the whole window
  // post-filter, by currency. Used both as the headline number on
  // `report` and as the denominator on share_bps calculations.
  async function _totals(window, filters) {
    var base = _baseScanWhere(window, filters);
    var sql =
      "SELECT currency, " +
      "       SUM(quantity) AS units, " +
      "       SUM(cost_impact_minor) AS cost_impact_minor " +
      "  FROM inventory_writeoffs " +
      " WHERE " + base.clauses.join(" AND ") +
      " GROUP BY currency";
    var r = await query(sql, base.params);
    return r.rows.map(function (row) {
      return {
        currency:          row.currency,
        units:             Number(row.units) || 0,
        cost_impact_minor: row.cost_impact_minor == null ? null : Number(row.cost_impact_minor),
      };
    });
  }

  // On-hand baseline for shrinkage-rate computation. Sums
  // `quantity` across the inventory_stock table at the moment of
  // the report — the rate compares this period's loss to the
  // current shelf-snapshot. When the inventory_stock table is
  // absent (no inventoryLocations migration loaded in a test fixture
  // that only cares about writeoffs), we fall back to 0 which makes
  // the rate undefined (returned as null) rather than crashing the
  // whole report.
  async function _onHandBaseline(filters) {
    var clauses = [];
    var params  = [];
    var idx = 1;
    if (filters && filters.location_code != null) {
      clauses.push("location_code = ?" + idx);
      params.push(filters.location_code);
      idx += 1;
    }
    if (filters && filters.sku != null) {
      clauses.push("sku = ?" + idx);
      params.push(filters.sku);
      idx += 1;
    }
    var where = clauses.length ? " WHERE " + clauses.join(" AND ") : "";
    try {
      var r = await query(
        "SELECT COALESCE(SUM(quantity), 0) AS total FROM inventory_stock" + where,
        params,
      );
      return Number(r.rows[0] && r.rows[0].total) || 0;
    } catch (_e) {
      // The inventory_stock table isn't loaded into this fixture —
      // every shrinkage-rate computation in this run returns null
      // rather than guessing a baseline. Operator-facing: the report
      // row carries `period_shrinkage_rate_bps: null` so the
      // dashboard renders "—" instead of "0%".
      return null;
    }
  }

  return {
    DAY_MS:                DAY_MS,
    TWO_YEARS_MS:          TWO_YEARS_MS,
    DEFAULT_CACHE_TTL_MS:  DEFAULT_CACHE_TTL_MS,
    REASON_CATEGORY:       REASON_CATEGORY,
    REASON_COLOR:          REASON_COLOR,

    // Top-level rollup. Returns the headline numbers plus four
    // dimension breakdowns (reason / location / sku / category).
    // Every breakdown carries share_bps so the dashboard can render
    // "share of total" without re-summing on the client.
    report: async function (input) {
      var window = _resolveWindow(input);
      var locF  = _optCode(input && input.location_code, "location_code");
      var skuF  = _optSku(input && input.sku);
      var reasF = _optReason(input && input.reason);
      var filters = { location_code: locF, sku: skuF, reason: reasF };
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = {
        from: window.from, to: window.to,
        location_code: locF, sku: skuF, reason: reasF,
      };

      return _withCache("report", params, cacheOpts, window.from, window.to, async function () {
        // Headline totals.
        var totalRows = await _totals(window, filters);
        var totalUnits = 0;
        var totalCost  = null;
        var totalCurrency = null;
        for (var i = 0; i < totalRows.length; i += 1) {
          totalUnits += totalRows[i].units;
          if (totalRows[i].cost_impact_minor != null) {
            if (totalCurrency != null && totalCurrency !== totalRows[i].currency) {
              throw new TypeError("shrinkage-report.report: window spans multiple currencies (" +
                totalCurrency + ", " + totalRows[i].currency + ") — reconcile before reporting");
            }
            totalCurrency = totalRows[i].currency;
            totalCost = (totalCost || 0) + totalRows[i].cost_impact_minor;
          }
        }

        // On-hand baseline for the shrinkage rate.
        var baseline = await _onHandBaseline(filters);
        var rateBps = null;
        if (baseline != null && baseline > 0) {
          rateBps = Math.round((totalUnits / baseline) * 10000);
        }

        // Four dimension breakdowns. Each one shares the same
        // grouped-scan + fold + share_bps pipeline.
        var reasonRows   = _foldByKey(await _groupedScan("reason",        window, filters), "reason");
        var locationRows = _foldByKey(await _groupedScan("location_code", window, filters), "location");
        var skuRows      = _foldByKey(await _groupedScan("sku",           window, filters), "sku");

        // Category rollup — fold the reason rows by the static
        // reason → category mapping. Cost-impact currency-coherence
        // applies the same way as the other dimensions.
        var catBucket = Object.create(null);
        for (var r = 0; r < reasonRows.length; r += 1) {
          var rr = reasonRows[r];
          var category = REASON_CATEGORY[rr.key] || "unknown";
          var slot = catBucket[category];
          if (!slot) slot = catBucket[category] = { units: 0, cost_impact_minor: null, currency: null };
          slot.units += rr.units;
          if (rr.cost_impact_minor != null) {
            if (slot.currency != null && slot.currency !== rr.currency) {
              throw new TypeError("shrinkage-report.report: category '" + category +
                "' spans multiple currencies (" + slot.currency + ", " + rr.currency +
                ") — reconcile before reporting");
            }
            slot.currency = rr.currency;
            slot.cost_impact_minor = (slot.cost_impact_minor || 0) + rr.cost_impact_minor;
          }
        }
        var catKeys = Object.keys(catBucket).sort();
        var byCategory = catKeys.map(function (k) {
          return {
            category:          k,
            units:             catBucket[k].units,
            cost_impact_minor: catBucket[k].cost_impact_minor,
            currency:          catBucket[k].currency,
            share_bps:         _shareBps(catBucket[k].units, totalUnits),
          };
        });
        byCategory.sort(function (a, b) { return b.units - a.units || (a.category < b.category ? -1 : 1); });

        var byReason = reasonRows.map(function (rr) {
          return {
            reason:            rr.key,
            units:             rr.units,
            cost_impact_minor: rr.cost_impact_minor,
            currency:          rr.currency,
            share_bps:         _shareBps(rr.units, totalUnits),
          };
        });
        byReason.sort(function (a, b) { return b.units - a.units || (a.reason < b.reason ? -1 : 1); });

        var byLocation = locationRows.map(function (rr) {
          return {
            location_code:     rr.key,
            units:             rr.units,
            cost_impact_minor: rr.cost_impact_minor,
            currency:          rr.currency,
            share_bps:         _shareBps(rr.units, totalUnits),
          };
        });
        byLocation.sort(function (a, b) { return b.units - a.units || (a.location_code < b.location_code ? -1 : 1); });

        var bySku = skuRows.map(function (rr) {
          return {
            sku:               rr.key,
            units:             rr.units,
            cost_impact_minor: rr.cost_impact_minor,
            currency:          rr.currency,
            share_bps:         _shareBps(rr.units, totalUnits),
          };
        });
        bySku.sort(function (a, b) { return b.units - a.units || (a.sku < b.sku ? -1 : 1); });

        return {
          from:                       window.from,
          to:                         window.to,
          total_units:                totalUnits,
          total_cost_impact_minor:    totalCost,
          currency:                   totalCurrency,
          period_shrinkage_rate_bps:  rateBps,
          by_reason:                  byReason,
          by_location:                byLocation,
          by_sku:                     bySku,
          by_category:                byCategory,
        };
      });
    },

    // Top-N locations ranked by cost-impact desc, units desc tie-
    // break. Returns the `reason_top` for each location so the
    // operator sees which reason drives the loss at a glance.
    topLossLocations: async function (input) {
      var window = _resolveWindow(input);
      var rawLimit = (input && input.limit) == null ? DEFAULT_LIMIT : input.limit;
      _limit(rawLimit, "limit");
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = { from: window.from, to: window.to, limit: rawLimit };

      return _withCache("top_locations", params, cacheOpts, window.from, window.to, async function () {
        // Per-(location, reason) scan — fold to per-location with
        // a top-reason picked from the most-units reason on that
        // location. Excludes rows with null location_code (global
        // catalog-level write-offs have no per-location attribution
        // to rank).
        var r = await query(
          "SELECT location_code, reason, currency, " +
          "       SUM(quantity) AS units, " +
          "       SUM(cost_impact_minor) AS cost_impact_minor " +
          "  FROM inventory_writeoffs " +
          " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND status = 'recorded' " +
          "   AND location_code IS NOT NULL " +
          " GROUP BY location_code, reason, currency",
          [window.from, window.to],
        );
        var perLocation = Object.create(null);
        for (var i = 0; i < r.rows.length; i += 1) {
          var row = r.rows[i];
          var loc = String(row.location_code);
          var slot = perLocation[loc];
          if (!slot) {
            slot = perLocation[loc] = {
              location_code:     loc,
              units:             0,
              cost_impact_minor: null,
              currency:          null,
              reason_units:      Object.create(null),
            };
          }
          var rowUnits = Number(row.units) || 0;
          slot.units += rowUnits;
          slot.reason_units[row.reason] = (slot.reason_units[row.reason] || 0) + rowUnits;
          if (row.cost_impact_minor != null) {
            if (slot.currency != null && slot.currency !== row.currency) {
              throw new TypeError("shrinkage-report.topLossLocations: location '" + loc +
                "' spans multiple currencies (" + slot.currency + ", " + row.currency +
                ") — reconcile before reporting");
            }
            slot.currency = row.currency;
            slot.cost_impact_minor = (slot.cost_impact_minor || 0) + Number(row.cost_impact_minor);
          }
        }
        var keys = Object.keys(perLocation);
        var rows = keys.map(function (k) {
          var slot = perLocation[k];
          // Pick the top reason — most units; tie-break alphabetic
          // so the column is deterministic across refreshes.
          var topReason = null;
          var topUnits  = -1;
          var reasonKeys = Object.keys(slot.reason_units).sort();
          for (var j = 0; j < reasonKeys.length; j += 1) {
            var u = slot.reason_units[reasonKeys[j]];
            if (u > topUnits) { topUnits = u; topReason = reasonKeys[j]; }
          }
          return {
            location_code:      slot.location_code,
            units:              slot.units,
            cost_impact_minor:  slot.cost_impact_minor,
            currency:           slot.currency,
            reason_top:         topReason,
            reason_top_units:   topUnits < 0 ? 0 : topUnits,
          };
        }).filter(function (r2) { return r2.units > 0; });
        // Sort: cost-impact desc (rows with cost first), units desc
        // tie-break, location asc final tie-break for determinism.
        rows.sort(function (a, b) {
          var aCost = a.cost_impact_minor == null ? -1 : a.cost_impact_minor;
          var bCost = b.cost_impact_minor == null ? -1 : b.cost_impact_minor;
          if (aCost !== bCost) return bCost - aCost;
          if (a.units !== b.units) return b.units - a.units;
          return a.location_code < b.location_code ? -1 : 1;
        });
        return rows.slice(0, rawLimit);
      });
    },

    // Top-N SKUs ranked by units desc (primary), cost-impact desc
    // tie-break. The primary-sort flip vs `topLossLocations` matches
    // loss-prevention intuition — units-walking is the LP signal,
    // cost-of-stock is the finance signal.
    topShrinkageSkus: async function (input) {
      var window = _resolveWindow(input);
      var rawLimit = (input && input.limit) == null ? DEFAULT_LIMIT : input.limit;
      _limit(rawLimit, "limit");
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = { from: window.from, to: window.to, limit: rawLimit };

      return _withCache("top_skus", params, cacheOpts, window.from, window.to, async function () {
        var r = await query(
          "SELECT sku, location_code, currency, " +
          "       SUM(quantity) AS units, " +
          "       SUM(cost_impact_minor) AS cost_impact_minor " +
          "  FROM inventory_writeoffs " +
          " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND status = 'recorded' " +
          " GROUP BY sku, location_code, currency",
          [window.from, window.to],
        );
        var perSku = Object.create(null);
        for (var i = 0; i < r.rows.length; i += 1) {
          var row = r.rows[i];
          var sku = String(row.sku);
          var slot = perSku[sku];
          if (!slot) {
            slot = perSku[sku] = {
              sku:                sku,
              units:              0,
              cost_impact_minor:  null,
              currency:           null,
              location_units:     Object.create(null),
            };
          }
          var rowUnits = Number(row.units) || 0;
          slot.units += rowUnits;
          var loc = row.location_code == null ? "(global)" : String(row.location_code);
          slot.location_units[loc] = (slot.location_units[loc] || 0) + rowUnits;
          if (row.cost_impact_minor != null) {
            if (slot.currency != null && slot.currency !== row.currency) {
              throw new TypeError("shrinkage-report.topShrinkageSkus: sku '" + sku +
                "' spans multiple currencies (" + slot.currency + ", " + row.currency +
                ") — reconcile before reporting");
            }
            slot.currency = row.currency;
            slot.cost_impact_minor = (slot.cost_impact_minor || 0) + Number(row.cost_impact_minor);
          }
        }
        var rows = Object.keys(perSku).map(function (k) {
          var slot = perSku[k];
          var topLoc = null;
          var topUnits = -1;
          var locKeys = Object.keys(slot.location_units).sort();
          for (var j = 0; j < locKeys.length; j += 1) {
            var u = slot.location_units[locKeys[j]];
            if (u > topUnits) { topUnits = u; topLoc = locKeys[j]; }
          }
          return {
            sku:                slot.sku,
            units:              slot.units,
            cost_impact_minor:  slot.cost_impact_minor,
            currency:           slot.currency,
            location_top:       topLoc,
            location_top_units: topUnits < 0 ? 0 : topUnits,
          };
        }).filter(function (r2) { return r2.units > 0; });
        rows.sort(function (a, b) {
          if (a.units !== b.units) return b.units - a.units;
          var aCost = a.cost_impact_minor == null ? -1 : a.cost_impact_minor;
          var bCost = b.cost_impact_minor == null ? -1 : b.cost_impact_minor;
          if (aCost !== bCost) return bCost - aCost;
          return a.sku < b.sku ? -1 : 1;
        });
        return rows.slice(0, rawLimit);
      });
    },

    // Side-by-side category comparison. The four reason-categories
    // (operational / perishable / external / deliberate) cover every
    // reason enum value — operator dashboards typically show this as
    // a stacked-bar chart with the most-units category on top.
    categoryComparison: async function (input) {
      var window = _resolveWindow(input);
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = { from: window.from, to: window.to };

      return _withCache("category_comparison", params, cacheOpts, window.from, window.to, async function () {
        var r = await query(
          "SELECT reason, currency, " +
          "       SUM(quantity) AS units, " +
          "       SUM(cost_impact_minor) AS cost_impact_minor " +
          "  FROM inventory_writeoffs " +
          " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND status = 'recorded' " +
          " GROUP BY reason, currency",
          [window.from, window.to],
        );
        var categories = Object.create(null);
        var totalUnits = 0;
        for (var i = 0; i < r.rows.length; i += 1) {
          var row = r.rows[i];
          var category = REASON_CATEGORY[row.reason] || "unknown";
          var slot = categories[category];
          if (!slot) {
            slot = categories[category] = {
              category:           category,
              units:              0,
              cost_impact_minor:  null,
              currency:           null,
              reason_units:       Object.create(null),
            };
          }
          var rowUnits = Number(row.units) || 0;
          slot.units += rowUnits;
          totalUnits += rowUnits;
          slot.reason_units[row.reason] = (slot.reason_units[row.reason] || 0) + rowUnits;
          if (row.cost_impact_minor != null) {
            if (slot.currency != null && slot.currency !== row.currency) {
              throw new TypeError("shrinkage-report.categoryComparison: category '" + category +
                "' spans multiple currencies (" + slot.currency + ", " + row.currency +
                ") — reconcile before reporting");
            }
            slot.currency = row.currency;
            slot.cost_impact_minor = (slot.cost_impact_minor || 0) + Number(row.cost_impact_minor);
          }
        }
        var rows = Object.keys(categories).map(function (k) {
          var slot = categories[k];
          var topReason = null;
          var topUnits  = -1;
          var reasonKeys = Object.keys(slot.reason_units).sort();
          for (var j = 0; j < reasonKeys.length; j += 1) {
            var u = slot.reason_units[reasonKeys[j]];
            if (u > topUnits) { topUnits = u; topReason = reasonKeys[j]; }
          }
          return {
            category:           slot.category,
            units:              slot.units,
            cost_impact_minor:  slot.cost_impact_minor,
            currency:           slot.currency,
            share_bps:          _shareBps(slot.units, totalUnits),
            top_reason:         topReason,
            top_reason_units:   topUnits < 0 ? 0 : topUnits,
          };
        });
        rows.sort(function (a, b) {
          if (a.units !== b.units) return b.units - a.units;
          return a.category < b.category ? -1 : 1;
        });
        return rows;
      });
    },

    // Per-month rollup. bucket_start is the YYYY-MM-DD of the first
    // day of the calendar month (UTC). Operator-facing dashboard
    // renders this as a sparkline / area chart.
    monthlyTrend: async function (input) {
      var window = _resolveWindow(input, TWO_YEARS_MS);
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = { from: window.from, to: window.to };

      return _withCache("monthly_trend", params, cacheOpts, window.from, window.to, async function () {
        var bucketSql = "date(occurred_at/1000, 'unixepoch', 'start of month')";
        var r = await query(
          "SELECT " + bucketSql + " AS bucket_start, currency, " +
          "       SUM(quantity) AS units, " +
          "       SUM(cost_impact_minor) AS cost_impact_minor " +
          "  FROM inventory_writeoffs " +
          " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND status = 'recorded' " +
          " GROUP BY bucket_start, currency " +
          " ORDER BY bucket_start ASC, currency ASC",
          [window.from, window.to],
        );
        // Fold (bucket, currency) → bucket. Cost-impact across mixed
        // currencies inside one bucket refuses, same posture as the
        // other rollups.
        var buckets = Object.create(null);
        for (var i = 0; i < r.rows.length; i += 1) {
          var row = r.rows[i];
          var key = String(row.bucket_start);
          var slot = buckets[key];
          if (!slot) slot = buckets[key] = { bucket_start: key, units: 0, cost_impact_minor: null, currency: null };
          slot.units += Number(row.units) || 0;
          if (row.cost_impact_minor != null) {
            if (slot.currency != null && slot.currency !== row.currency) {
              throw new TypeError("shrinkage-report.monthlyTrend: bucket '" + key +
                "' spans multiple currencies (" + slot.currency + ", " + row.currency +
                ") — reconcile before reporting");
            }
            slot.currency = row.currency;
            slot.cost_impact_minor = (slot.cost_impact_minor || 0) + Number(row.cost_impact_minor);
          }
        }
        return Object.keys(buckets).sort().map(function (k) { return buckets[k]; });
      });
    },

    // Pie-chart-shaped breakdown by reason. Adds a `color_hint` from
    // the stable REASON_COLOR table so the dashboard wedge colors
    // stay consistent across refreshes without a separate theme
    // lookup.
    reasonBreakdownPie: async function (input) {
      var window = _resolveWindow(input);
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = { from: window.from, to: window.to };

      return _withCache("reason_pie", params, cacheOpts, window.from, window.to, async function () {
        var r = await query(
          "SELECT reason, SUM(quantity) AS units " +
          "  FROM inventory_writeoffs " +
          " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND status = 'recorded' " +
          " GROUP BY reason",
          [window.from, window.to],
        );
        var totalUnits = 0;
        var perReason = r.rows.map(function (row) {
          var u = Number(row.units) || 0;
          totalUnits += u;
          return { reason: row.reason, units: u };
        });
        var rows = perReason.map(function (row) {
          return {
            reason:     row.reason,
            units:      row.units,
            share_bps:  _shareBps(row.units, totalUnits),
            color_hint: REASON_COLOR[row.reason] || "#6b7280",                 // slate-500 fallback
          };
        });
        rows.sort(function (a, b) {
          if (a.units !== b.units) return b.units - a.units;
          return a.reason < b.reason ? -1 : 1;
        });
        return rows;
      });
    },

    // Statistical-outlier detection over per-location loss. Reports
    // every location whose units in the window exceed
    // `mean + threshold_multiplier * stddev`. Returns `[]` when
    // fewer than 2 locations have writeoffs in the window (stddev
    // undefined for n<2; no anomaly call possible).
    flagAnomalies: async function (input) {
      var window = _resolveWindow(input);
      var threshold = (input && input.threshold_multiplier) == null ? 2.0 : input.threshold_multiplier;
      _finitePositive(threshold, "threshold_multiplier");
      var minUnits = (input && input.min_units) == null ? 1 : input.min_units;
      _nonNegInt(minUnits, "min_units");
      var cacheOpts = input && input.cache === true ? { cache: true, cache_ttl_ms: input.cache_ttl_ms } : null;
      var params = { from: window.from, to: window.to,
        threshold_multiplier: threshold, min_units: minUnits };

      return _withCache("anomalies", params, cacheOpts, window.from, window.to, async function () {
        // Per-location rollup — exclude rows with null location_code
        // (global catalog-level write-offs can't sit on the
        // anomaly leaderboard; the operator looks at those
        // separately via the by_location field on the main report).
        var r = await query(
          "SELECT location_code, currency, " +
          "       SUM(quantity) AS units, " +
          "       SUM(cost_impact_minor) AS cost_impact_minor " +
          "  FROM inventory_writeoffs " +
          " WHERE occurred_at >= ?1 AND occurred_at < ?2 " +
          "   AND status = 'recorded' " +
          "   AND location_code IS NOT NULL " +
          " GROUP BY location_code, currency",
          [window.from, window.to],
        );
        // Fold (location, currency) → location. Same currency
        // coherence rule as every other rollup.
        var bucket = Object.create(null);
        for (var i = 0; i < r.rows.length; i += 1) {
          var row = r.rows[i];
          var loc = String(row.location_code);
          var slot = bucket[loc];
          if (!slot) slot = bucket[loc] = { location_code: loc, units: 0, cost_impact_minor: null, currency: null };
          slot.units += Number(row.units) || 0;
          if (row.cost_impact_minor != null) {
            if (slot.currency != null && slot.currency !== row.currency) {
              throw new TypeError("shrinkage-report.flagAnomalies: location '" + loc +
                "' spans multiple currencies (" + slot.currency + ", " + row.currency +
                ") — reconcile before reporting");
            }
            slot.currency = row.currency;
            slot.cost_impact_minor = (slot.cost_impact_minor || 0) + Number(row.cost_impact_minor);
          }
        }
        // Honor min_units filter — locations below the floor don't
        // pollute the statistic.
        var locations = [];
        var locKeys = Object.keys(bucket);
        for (var k = 0; k < locKeys.length; k += 1) {
          if (bucket[locKeys[k]].units >= minUnits) locations.push(bucket[locKeys[k]]);
        }
        if (locations.length < 2) return [];

        // Mean + sample-stddev (n-1 denominator — single observation
        // doesn't reach here, see the early-return above).
        var sum = 0;
        for (var s = 0; s < locations.length; s += 1) sum += locations[s].units;
        var mean = sum / locations.length;
        var sqdiff = 0;
        for (var t = 0; t < locations.length; t += 1) {
          var d = locations[t].units - mean;
          sqdiff += d * d;
        }
        var stddev = Math.sqrt(sqdiff / (locations.length - 1));
        // Degenerate case: every location has the same units count.
        // stddev is zero; no anomaly possible (the z-score is
        // undefined for every location). Return empty so the
        // dashboard renders "no anomalies" rather than flagging
        // every-or-none.
        if (stddev === 0) return [];

        var thresholdUnits = mean + threshold * stddev;
        var flagged = [];
        for (var u = 0; u < locations.length; u += 1) {
          var loc2 = locations[u];
          if (loc2.units > thresholdUnits) {
            flagged.push({
              location_code:      loc2.location_code,
              units:              loc2.units,
              cost_impact_minor:  loc2.cost_impact_minor,
              currency:           loc2.currency,
              z_score:            (loc2.units - mean) / stddev,
              mean:               mean,
              stddev:             stddev,
              threshold:          thresholdUnits,
            });
          }
        }
        flagged.sort(function (a, b) {
          if (a.z_score !== b.z_score) return b.z_score - a.z_score;
          return a.location_code < b.location_code ? -1 : 1;
        });
        return flagged;
      });
    },

    // Operator-cron sweep — deletes cache rows whose computed_at +
    // scope-TTL <= now. Without a per-row TTL column the sweep
    // iterates the catalog: for every known scope key, delete rows
    // older than its TTL. Returns the aggregate count so the cron
    // log can size the sweep.
    purgeExpired: async function (nowTs) {
      var ts = nowTs == null ? Date.now() : nowTs;
      _epochMs(ts, "nowTs");
      var total = 0;
      var scopes = Object.keys(DEFAULT_CACHE_TTL_MS);
      for (var i = 0; i < scopes.length; i += 1) {
        var key = scopes[i];
        var ttl = DEFAULT_CACHE_TTL_MS[key];
        var r = await query(
          "DELETE FROM shrinkage_report_cache WHERE scope_key = ?1 AND computed_at + ?2 <= ?3",
          [key, ttl, ts],
        );
        total += Number(r.rowCount) || 0;
      }
      return { deleted: total };
    },

    // Expose injected peers for cross-call composition that will
    // land alongside follow-up primitives (e.g. an invalidation
    // hook on inventoryWriteoffs.recordWriteoff). Operators that
    // don't wire these get null — every read-path verb above works
    // without them.
    _peers: {
      inventoryWriteoffs: writeoffsPeer,
      costLayers:         costLayersPeer,
      order:              orderPeer,
    },
  };
}

module.exports = {
  create:                create,
  DAY_MS:                DAY_MS,
  TWO_YEARS_MS:          TWO_YEARS_MS,
  DEFAULT_CACHE_TTL_MS:  DEFAULT_CACHE_TTL_MS,
  REASON_CATEGORY:       REASON_CATEGORY,
  REASON_COLOR:          REASON_COLOR,
};
