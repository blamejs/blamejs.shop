"use strict";
/**
 * @module shop.subscriptionAnalytics
 * @title  Subscription analytics — recurring-revenue rollups for the
 *         operator dashboard.
 *
 * @intro
 *   Read-only aggregator over the existing subscription primitives.
 *   Every aggregate composes one of:
 *
 *     - `subscriptions`                  (the catalog-side row)
 *     - `subscription_plans`             (interval + amount + currency)
 *     - `subscription_invoices`          (paid / failed / voided ledger)
 *     - `subscription_payment_attempts`  (per-invoice retry trail)
 *     - `subscription_dunning_states`    (dunning episode log)
 *     - `subscription_control_events`    (pause / resume / cancel audit)
 *
 *   Source-of-truth lives in those tables; this primitive owns ZERO
 *   write surfaces against them. The only writes are to the
 *   `subscription_metrics_snapshots` cache table (migration
 *   `0178_subscription_analytics_cache.sql`), and even those are
 *   best-effort — an operator dropping the cache table degrades
 *   dashboard latency but never loses data.
 *
 *   v1 surface:
 *
 *     - mrr({ at? })
 *         Monthly Recurring Revenue snapshot. Walks every subscription
 *         whose local state is "active" at the cutoff (`at`, defaulting
 *         to `Date.now()`) — active means
 *         `status IN ('active', 'trialing')` AND `cancelled_at IS NULL`
 *         AND (`paused_at IS NULL` OR `paused_until <= at`). For each
 *         row, the plan's `amount_minor * quantity` is normalized to a
 *         monthly cadence (day → ×30, week → ×4.345, month → ×1,
 *         year → ÷12) using a deterministic rounding rule (banker's
 *         rounding on the final minor-unit total). Returns
 *         `{ currency_breakdown: [{ currency, mrr_minor, subscription_count }],
 *            total_mrr_normalized_minor? }` — when every active
 *         subscription shares a currency, that single row is also
 *         exposed at `total_mrr_normalized_minor`; mixed-currency
 *         windows omit the total (the dashboard renders per-currency
 *         only).
 *
 *     - arr({ at? })
 *         Annual Recurring Revenue. `mrr * 12` per currency.
 *
 *     - churnRate({ from, to, kind? })
 *         Voluntary vs involuntary churn. `kind` is "voluntary",
 *         "involuntary", or "all" (default "all").
 *           - voluntary   = subscriptions with a `cancel` control event
 *                           in the window OR cancelled_at set in the
 *                           window via the controls primitive
 *           - involuntary = subscriptions whose dunning episode exited
 *                           with state="cancelled" OR "written_off" in
 *                           the window
 *         Returns `{ kind, churned, exposed, rate }` where `rate =
 *         churned / exposed`. `exposed` is the count of subscriptions
 *         that were active at any point during the window (started <=
 *         to AND (cancelled_at IS NULL OR cancelled_at >= from)).
 *
 *     - pauseRate({ from, to })
 *         Share of active subscriptions paused during the window. A
 *         subscription counts as "paused" if it has at least one
 *         `pause` control event with occurred_at in `[from, to]`.
 *
 *     - ltv({ plan_id?, currency? })
 *         Customer Lifetime Value estimator. Computed as
 *         `average_revenue_per_subscription / churn_rate_per_period`
 *         with the period defaulting to the trailing 90 days.
 *         `average_revenue_per_subscription` sums paid invoice amounts
 *         per subscription, divides by distinct subscription count.
 *         `plan_id` narrows to a single plan; `currency` filters
 *         invoices to one ISO code. Returns
 *         `{ avg_revenue_minor, churn_rate, ltv_minor, sample_size,
 *            currency }`; `ltv_minor` is `null` when churn rate is 0
 *         (infinite LTV — the dashboard shows "—" instead of a number).
 *
 *     - cohortRetention({ cohort_month, periods })
 *         Cohort retention curve. `cohort_month` is "YYYY-MM" — the
 *         month new subscriptions started (in UTC). `periods` is the
 *         number of monthly follow-up buckets to compute (1..12). The
 *         primitive scans every subscription whose `created_at` falls
 *         in the cohort month, then for each follow-up bucket counts
 *         how many of those subscriptions were still active at the
 *         END of that bucket (no `cancelled_at` set yet OR
 *         `cancelled_at > bucket_end`). Returns
 *         `{ cohort_month, cohort_size, buckets: [{ period, active,
 *           retention_rate }] }`. `bucket[0]` is always month-zero
 *         (= cohort_size / cohort_size = 1.0 when cohort_size > 0).
 *
 *     - planTransitions({ from, to })
 *         Plan upgrade/downgrade matrix. Walks every plan-change
 *         delivered as a sequence of (`subscription_id`, `from_plan_id`
 *         -> `to_plan_id`) events in the window, derived from the
 *         control-events ledger entries whose `before_json.plan_id !==
 *         after_json.plan_id`. Returns a 2D matrix:
 *         `[{ from_plan_id, to_plan_id, count, direction }]` where
 *         `direction` is "upgrade" / "downgrade" / "lateral" based on
 *         the plans' `amount_minor` comparison after currency-
 *         normalization (cross-currency transitions surface as
 *         "lateral" — the dashboard renders the operator a follow-up
 *         drill-down).
 *
 *     - topChurningPlans({ from, to, limit })
 *         Top-N plans by absolute churn count over the window. Returns
 *         `[{ plan_id, churned, active_at_start, churn_rate }]` ordered
 *         by churn count DESC, plan_id ASC. `limit` is capped at 100.
 *
 *     - recoveryRate({ from, to })
 *         Dunning recovery rate. Of every dunning episode that ENTERED
 *         in `[from, to]`, what share exited with state="recovered"?
 *         Returns `{ entered, recovered, cancelled, written_off,
 *         still_open, recovery_rate }`. `recovery_rate` is `recovered /
 *         (entered - still_open)` so in-flight episodes don't deflate
 *         the operator's view of resolved-cohort recovery.
 *
 *     - dailyMrrSeries({ from, to, currency? })
 *         Day-by-day MRR time series. Computes MRR at the end of each
 *         day in `[from, to]` (UTC day boundaries). Bucketing is
 *         deterministic — `floor((ts - epoch_day_zero) / 86_400_000)`.
 *         Returns `[{ day, mrr_minor, currency }]` ordered ascending by
 *         day. `currency` filters the series to a single ISO code;
 *         omitted, returns per-currency rows (with one entry per
 *         (day, currency) tuple).
 *
 *   Optional cache + invalidation:
 *
 *     Every aggregate accepts a `cache` opt that toggles snapshot
 *     reuse. The cache key tuple is (scope, scope_value, period_from,
 *     period_to) where `scope_value = b.crypto.namespaceHash(
 *     "subscription-analytics-cache", JSON.stringify(canonical_args))`.
 *     Default TTL is 5 minutes; pass `cache: { ttl_ms: N }` to
 *     override. `purgeExpired()` and `invalidate({ scope?, before? })`
 *     surface the sweep + targeted-eviction helpers.
 *
 *   Composition:
 *
 *     - `b.crypto.namespaceHash`  — cache-key derivation (collision-
 *       resistant SHA3-512 with a dedicated namespace)
 *     - `b.uuid.v7`               — snapshot row ids (sortable, no
 *       collision risk)
 *     - Optional handles: `subscriptions`, `subscriptionControls`,
 *       `subscriptionBilling` — strictly read methods. Each is best-
 *       effort; the primitive falls back to direct SQL against the
 *       owned tables when a handle is absent. The handles are reserved
 *       so an operator wiring the full subscription stack can pass
 *       them today without behaviour change once cross-checks land.
 *
 *   Monotonic per-process clock: cache writes that collide in the same
 *   millisecond would tie on `computed_at` and make the freshest-row
 *   tie-break ambiguous. `_now` bumps to `prior + 1` on collision so a
 *   sort-by-computed_at DESC read returns the most recent write first.
 *
 *   Storage:
 *     - `subscription_metrics_snapshots` (migration
 *       `0178_subscription_analytics_cache.sql`)
 *
 * @primitive subscriptionAnalytics
 * @related    shop.subscriptions, shop.subscriptionControls,
 *             shop.subscriptionBilling, b.crypto.namespaceHash, b.uuid.v7
 */

// ---- constants ----------------------------------------------------------

var b = require("./vendor/blamejs");
var C = b.constants;

var CACHE_NAMESPACE = "subscription-analytics-cache";

var DEFAULT_TTL_MS  = C.TIME.minutes(5);        // 5 minutes
var ONE_DAY_MS      = C.TIME.days(1);
var ONE_YEAR_MS     = 365 * ONE_DAY_MS;
var DEFAULT_LTV_WINDOW_MS = 90 * ONE_DAY_MS;

var MAX_LIMIT       = 100;
var MAX_PERIODS     = 12;

// Currency-cadence normalization. The factors mirror common SaaS
// dashboards: a weekly cadence becomes monthly via 30 / 7 ≈ 4.345,
// daily becomes ×30, annual ÷12.
var CADENCE_TO_MONTHLY = {
  day:   30,
  week:  30 / 7,
  month: 1,
  year:  1 / 12,
};

// Exact rational [numerator, denominator] forms of the cadence factors
// above, used by _monthlyMinor so the monthly-normalized minor-unit
// figure is computed in BigInt (half-even) with no float intermediate.
// The float CADENCE_TO_MONTHLY view above is retained only for the
// display-only dashboard export.
var CADENCE_TO_MONTHLY_RATIO = {
  day:   [30n, 1n],
  week:  [30n, 7n],
  month: [1n, 1n],
  year:  [1n, 12n],
};

// Active = (status in active/trialing) AND not cancelled AND not paused.
var ACTIVE_STATUSES = ["active", "trialing"];

var CHURN_KINDS = ["voluntary", "involuntary", "all"];

var SCOPE_RE     = /^[a-z][a-z0-9_]*$/;
var COHORT_RE    = /^\d{4}-(0[1-9]|1[0-2])$/;
var CURRENCY_RE  = /^[a-z]{3}$/i;
var PLAN_ID_RE   = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// ---- monotonic clock ---------------------------------------------------
//
// Cache writes inside a single recompute can land in the same
// millisecond on fast machines. Bumping by 1ms on a tie keeps the
// snapshot timeline strictly increasing so the most-recent-write tie-
// break is deterministic.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _epochMs(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("subscriptionAnalytics: " + label + " must be a non-negative integer (epoch ms)");
  }
  return value;
}

function _requireInput(opts, label) {
  if (!opts || typeof opts !== "object") {
    throw new TypeError("subscriptionAnalytics." + label + ": input object required");
  }
}

function _window(opts, label) {
  _requireInput(opts, label);
  _epochMs(opts.from, label + ".from");
  _epochMs(opts.to,   label + ".to");
  if (opts.from >= opts.to) {
    throw new TypeError("subscriptionAnalytics." + label + ": from must be strictly less than to");
  }
  if ((opts.to - opts.from) > ONE_YEAR_MS) {
    throw new TypeError("subscriptionAnalytics." + label + ": window (to - from) must be <= 1 year");
  }
  return { from: opts.from, to: opts.to };
}

function _at(value) {
  if (value == null) return Date.now();
  return _epochMs(value, "at");
}

function _limit(value, label) {
  if (value == null) return 10;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new TypeError("subscriptionAnalytics: " + label + " must be an integer in [1, " + MAX_LIMIT + "]");
  }
  return value;
}

function _scope(s) {
  if (typeof s !== "string" || !SCOPE_RE.test(s)) {
    throw new TypeError("subscriptionAnalytics: scope must match /^[a-z][a-z0-9_]*$/");
  }
  return s;
}

function _cohortMonth(s) {
  if (typeof s !== "string" || !COHORT_RE.test(s)) {
    throw new TypeError("subscriptionAnalytics: cohort_month must match /^\\d{4}-(0[1-9]|1[0-2])$/");
  }
  return s;
}

function _periods(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PERIODS) {
    throw new TypeError("subscriptionAnalytics: periods must be an integer in [1, " + MAX_PERIODS + "]");
  }
  return n;
}

function _currency(value, allowNull) {
  if (value == null) {
    if (allowNull) return null;
    throw new TypeError("subscriptionAnalytics: currency must be a 3-letter ISO code");
  }
  if (typeof value !== "string" || !CURRENCY_RE.test(value)) {
    throw new TypeError("subscriptionAnalytics: currency must be a 3-letter ISO code");
  }
  return value.toLowerCase();
}

function _planId(value, allowNull) {
  if (value == null) {
    if (allowNull) return null;
    throw new TypeError("subscriptionAnalytics: plan_id required");
  }
  if (typeof value !== "string" || !PLAN_ID_RE.test(value)) {
    throw new TypeError("subscriptionAnalytics: plan_id must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= 128 chars)");
  }
  return value;
}

function _churnKind(value) {
  if (value == null) return "all";
  if (typeof value !== "string" || CHURN_KINDS.indexOf(value) === -1) {
    throw new TypeError("subscriptionAnalytics: kind must be one of " + CHURN_KINDS.join(", "));
  }
  return value;
}

// ---- canonical JSON for cache keys -------------------------------------
//
// Two cache lookups with the same arguments in a different key order
// must hit the same row. JSON.stringify isn't order-stable across
// engines, so the primitive sorts keys before hashing.

function _canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    var parts = [];
    for (var i = 0; i < value.length; i += 1) parts.push(_canonicalJson(value[i]));
    return "[" + parts.join(",") + "]";
  }
  var keys = Object.keys(value).sort();
  var pairs = [];
  for (var k = 0; k < keys.length; k += 1) {
    pairs.push(JSON.stringify(keys[k]) + ":" + _canonicalJson(value[keys[k]]));
  }
  return "{" + pairs.join(",") + "}";
}

// ---- cadence normalization ---------------------------------------------
//
// Plan amount × quantity normalized to a single monthly figure. The
// cadence factor (e.g. week → 30/7, year → 1/12) is applied as an
// exact rational in BigInt half-even via b.money, so the monthly
// minor-unit total carries no float rounding and two interval
// combinations producing e.g. 4499.5 minor units settle on a stable
// even value rather than oscillating the dashboard by a cent.

function _monthlyMinor(amountMinor, interval, intervalCount, quantity) {
  var ratio = CADENCE_TO_MONTHLY_RATIO[interval];
  if (ratio == null) return 0;
  if (!Number.isInteger(amountMinor)) return 0;
  var qty = Number.isInteger(quantity) && quantity > 0 ? quantity : 1;
  var ic  = Number.isInteger(intervalCount) && intervalCount > 0 ? intervalCount : 1;
  // monthly = amount × qty × (num/den) / ic
  //         = amount × qty × num / (den × ic)
  var num = BigInt(amountMinor) * BigInt(qty) * ratio[0];
  var den = ratio[1] * BigInt(ic);
  return Number(
    b.money.fromMinorUnits(num >= 0n ? num : 0n, "USD")
      .multiply([1n, den], { rounding: "half-even" })
      .toMinorUnits()
  );
}

// ---- active-at predicate (in SQL) --------------------------------------
//
// Local-state "active at timestamp X" condition, used by mrr / arr /
// pauseRate / churn-exposure. Inlines the predicate as a SQL fragment
// because it composes into every aggregate's WHERE clause.

function _activeAtSql(paramIndex, alias) {
  // Active iff: status in ('active','trialing')
  //         AND created_at <= ?X
  //         AND (cancelled_at IS NULL OR cancelled_at > ?X)
  //         AND (paused_at IS NULL OR paused_until IS NULL OR paused_until <= ?X)
  //
  // `alias` is the SQL table alias to prepend to each column reference
  // when the predicate composes into a JOIN. Pass "" for a single-table
  // scan, or e.g. "s" to produce `s.status IN ...`.
  var px = alias ? (alias + ".") : "";
  return "(" + px + "status IN ('active', 'trialing') " +
         " AND " + px + "created_at <= ?" + paramIndex +
         " AND (" + px + "cancelled_at IS NULL OR " + px + "cancelled_at > ?" + paramIndex + ")" +
         " AND (" + px + "paused_at IS NULL OR " + px + "paused_until IS NULL OR " + px + "paused_until <= ?" + paramIndex + "))";
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional read-only cross-check handles. None is load-bearing; each
  // aggregate falls back to direct SQL against the owned tables when
  // the handle is absent.
  var subscriptionsHandle        = opts.subscriptions        || null;
  var subscriptionControlsHandle = opts.subscriptionControls || null;
  var subscriptionBillingHandle  = opts.subscriptionBilling  || null;

  // Reference each optional handle once so the lint pass doesn't flag
  // the accepted-but-currently-unused constructor opts. The hooks are
  // reserved for the cross-check surfaces that land once the matching
  // primitives expose the needed read methods; the primitive must
  // accept the handles today without behaviour change.
  void subscriptionsHandle;
  void subscriptionControlsHandle;
  void subscriptionBillingHandle;

  // ---- cache helpers --------------------------------------------------

  function _cacheKey(scope, args) {
    return b.crypto.namespaceHash(CACHE_NAMESPACE, _canonicalJson(args || {}));
  }

  async function _cacheRead(scope, args, periodFrom, periodTo, ttlMs) {
    if (!ttlMs || ttlMs < 1) return null;
    var key = _cacheKey(scope, args);
    var r = await query(
      "SELECT breakdown_json, computed_at FROM subscription_metrics_snapshots " +
      "WHERE scope = ?1 AND scope_value = ?2 AND period_from = ?3 AND period_to = ?4",
      [scope, key, periodFrom, periodTo],
    );
    var row = r.rows[0];
    if (!row) return null;
    if (Number(row.computed_at) + ttlMs < Date.now()) return null;
    try { return JSON.parse(row.breakdown_json); }
    catch (_e) { return null; }                                                  // drop-silent — corrupt cache row recomputes
  }

  async function _cacheWrite(scope, args, periodFrom, periodTo, metric, value, payload) {
    var key = _cacheKey(scope, args);
    var ts = _now();
    var id = b.uuid.v7();
    // REPLACE on the (scope, scope_value, period_from, period_to)
    // UNIQUE index so a fresh recompute never leaves duplicates.
    await query(
      "INSERT INTO subscription_metrics_snapshots " +
      "(id, scope, scope_value, period_from, period_to, metric, value, breakdown_json, computed_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) " +
      "ON CONFLICT(scope, scope_value, period_from, period_to) DO UPDATE SET " +
      "id = excluded.id, metric = excluded.metric, value = excluded.value, " +
      "breakdown_json = excluded.breakdown_json, computed_at = excluded.computed_at",
      [id, scope, key, periodFrom, periodTo, metric, value, JSON.stringify(payload), ts],
    );
  }

  function _ttlFromOpts(cacheOpt) {
    if (cacheOpt === false) return 0;
    if (cacheOpt && typeof cacheOpt === "object" && Number.isInteger(cacheOpt.ttl_ms) && cacheOpt.ttl_ms >= 0) {
      return cacheOpt.ttl_ms;
    }
    return DEFAULT_TTL_MS;
  }

  // ---- mrr / arr ------------------------------------------------------

  async function _mrrSnapshot(at) {
    // Pull every active subscription + its plan in one join. The
    // active-at predicate runs inside SQL so the index on
    // subscriptions(status) prunes the scan.
    var r = await query(
      "SELECT s.id AS subscription_id, s.quantity AS quantity, " +
      "       p.amount_minor AS amount_minor, p.interval AS interval, " +
      "       p.interval_count AS interval_count, p.currency AS currency " +
      "FROM subscriptions s " +
      "JOIN subscription_plans p ON p.id = s.plan_id " +
      "WHERE " + _activeAtSql(1, "s"),
      [at],
    );
    // Per-currency aggregate.
    var perCurrency = {};
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var monthly = _monthlyMinor(
        Number(row.amount_minor),
        row.interval,
        Number(row.interval_count),
        Number(row.quantity)
      );
      var cur = row.currency;
      if (!perCurrency[cur]) perCurrency[cur] = { mrr_minor: 0, subscription_count: 0 };
      perCurrency[cur].mrr_minor += monthly;
      perCurrency[cur].subscription_count += 1;
    }
    var currencies = Object.keys(perCurrency).sort();
    var breakdown = [];
    for (var c = 0; c < currencies.length; c += 1) {
      breakdown.push({
        currency:            currencies[c],
        mrr_minor:           perCurrency[currencies[c]].mrr_minor,
        subscription_count:  perCurrency[currencies[c]].subscription_count,
      });
    }
    var out = { at: at, currency_breakdown: breakdown };
    if (breakdown.length === 1) {
      out.total_mrr_normalized_minor = breakdown[0].mrr_minor;
    }
    return out;
  }

  async function mrr(input) {
    input = input || {};
    var at = _at(input.at);
    var ttl = _ttlFromOpts(input.cache);
    var args = { at: at };
    var cached = await _cacheRead("mrr", args, at, at + 1, ttl);
    if (cached) return cached;
    var snap = await _mrrSnapshot(at);
    if (ttl > 0) {
      await _cacheWrite("mrr", args, at, at + 1, "mrr_minor",
        snap.total_mrr_normalized_minor == null ? 0 : snap.total_mrr_normalized_minor, snap);
    }
    return snap;
  }

  async function arr(input) {
    input = input || {};
    var at = _at(input.at);
    var snap = await _mrrSnapshot(at);
    var breakdown = snap.currency_breakdown.map(function (cb) {
      return {
        currency:            cb.currency,
        arr_minor:           cb.mrr_minor * 12,
        subscription_count:  cb.subscription_count,
      };
    });
    var out = { at: at, currency_breakdown: breakdown };
    if (breakdown.length === 1) {
      out.total_arr_normalized_minor = breakdown[0].arr_minor;
    }
    return out;
  }

  // ---- churnRate ------------------------------------------------------

  async function _voluntaryChurnCount(from, to) {
    // A subscription churned voluntarily if its `cancelled_at` falls in
    // [from, to] — the controls primitive stamps that column whenever a
    // `cancel` event is applied. We also fall back to scanning the
    // control-events ledger for `cancel` events in the window in case
    // the cancelled_at column is null (e.g. early-pre-controls rows).
    var r1 = await query(
      "SELECT COUNT(DISTINCT id) AS n FROM subscriptions " +
      "WHERE cancelled_at IS NOT NULL AND cancelled_at >= ?1 AND cancelled_at < ?2",
      [from, to],
    );
    var r2 = await query(
      "SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_control_events " +
      "WHERE event = 'cancel' AND occurred_at >= ?1 AND occurred_at < ?2",
      [from, to],
    );
    return Math.max(Number(r1.rows[0] && r1.rows[0].n) || 0, Number(r2.rows[0] && r2.rows[0].n) || 0);
  }

  async function _involuntaryChurnCount(from, to) {
    // Involuntary churn = dunning episode that EXITED in the window
    // with cancelled / written_off.
    var r = await query(
      "SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_dunning_states " +
      "WHERE state IN ('cancelled', 'written_off') " +
      "  AND exited_at IS NOT NULL AND exited_at >= ?1 AND exited_at < ?2",
      [from, to],
    );
    return Number(r.rows[0] && r.rows[0].n) || 0;
  }

  async function _exposedCount(from, to) {
    // Exposed = subscriptions that existed in some active form during
    // the window. created_at <= to AND (cancelled_at IS NULL OR
    // cancelled_at >= from).
    var r = await query(
      "SELECT COUNT(*) AS n FROM subscriptions " +
      "WHERE created_at <= ?1 AND (cancelled_at IS NULL OR cancelled_at >= ?2)",
      [to, from],
    );
    return Number(r.rows[0] && r.rows[0].n) || 0;
  }

  async function churnRate(input) {
    _requireInput(input, "churnRate");
    var w = _window(input, "churnRate");
    var kind = _churnKind(input && input.kind);
    var voluntary   = 0;
    var involuntary = 0;
    if (kind === "voluntary" || kind === "all") {
      voluntary = await _voluntaryChurnCount(w.from, w.to);
    }
    if (kind === "involuntary" || kind === "all") {
      involuntary = await _involuntaryChurnCount(w.from, w.to);
    }
    var churned = voluntary + involuntary;
    var exposed = await _exposedCount(w.from, w.to);
    var rate = exposed > 0 ? churned / exposed : 0;
    return {
      kind:                kind,
      from:                w.from,
      to:                  w.to,
      churned:             churned,
      voluntary:           voluntary,
      involuntary:         involuntary,
      exposed:             exposed,
      rate:                rate,
    };
  }

  // ---- pauseRate ------------------------------------------------------

  async function pauseRate(input) {
    _requireInput(input, "pauseRate");
    var w = _window(input, "pauseRate");
    var pausedRow = (await query(
      "SELECT COUNT(DISTINCT subscription_id) AS n FROM subscription_control_events " +
      "WHERE event = 'pause' AND occurred_at >= ?1 AND occurred_at < ?2",
      [w.from, w.to],
    )).rows[0] || {};
    var paused = Number(pausedRow.n) || 0;
    var exposed = await _exposedCount(w.from, w.to);
    return {
      from:     w.from,
      to:       w.to,
      paused:   paused,
      exposed:  exposed,
      rate:     exposed > 0 ? paused / exposed : 0,
    };
  }

  // ---- ltv ------------------------------------------------------------

  async function ltv(input) {
    input = input || {};
    var planId    = input.plan_id == null ? null : _planId(input.plan_id, true);
    var currency  = input.currency == null ? null : _currency(input.currency, true);

    // Default window: trailing 90 days.
    var to   = input.to   == null ? Date.now() : _epochMs(input.to,   "to");
    var from = input.from == null ? (to - DEFAULT_LTV_WINDOW_MS) : _epochMs(input.from, "from");
    if (from >= to) {
      throw new TypeError("subscriptionAnalytics.ltv: from must be strictly less than to");
    }

    var where  = ["i.status = 'paid'", "i.paid_at >= ?1", "i.paid_at < ?2"];
    var params = [from, to];
    var idx = 3;
    if (planId) {
      where.push("s.plan_id = ?" + idx);
      params.push(planId);
      idx += 1;
    }
    if (currency) {
      where.push("i.currency = ?" + idx);
      params.push(currency);
      idx += 1;
    }
    var revRow = (await query(
      "SELECT SUM(i.amount_minor) AS revenue, COUNT(DISTINCT s.id) AS subs " +
      "FROM subscription_invoices i " +
      "JOIN subscriptions s ON s.id = i.subscription_id " +
      "WHERE " + where.join(" AND "),
      params,
    )).rows[0] || {};
    var revenue = Number(revRow.revenue) || 0;
    var subs    = Number(revRow.subs)    || 0;
    var avgRevenue = subs > 0 ? Math.floor(revenue / subs) : 0;

    // Churn rate over the same window (kind=all).
    var cr = await churnRate({ from: from, to: to, kind: "all" });

    var ltvMinor = null;
    if (cr.rate > 0) {
      ltvMinor = Math.floor(avgRevenue / cr.rate);
    }
    return {
      from:                from,
      to:                  to,
      plan_id:             planId,
      currency:            currency,
      avg_revenue_minor:   avgRevenue,
      churn_rate:          cr.rate,
      ltv_minor:           ltvMinor,
      sample_size:         subs,
    };
  }

  // ---- cohortRetention -----------------------------------------------

  function _monthBoundsUtc(cohortMonth) {
    var parts = cohortMonth.split("-");
    var year  = Number(parts[0]);
    var month = Number(parts[1]) - 1;
    var start = Date.UTC(year, month, 1, 0, 0, 0, 0);
    var nextMonthStart = Date.UTC(year, month + 1, 1, 0, 0, 0, 0);
    return { start: start, end: nextMonthStart };
  }

  function _addMonthsUtc(epochMs, monthsToAdd) {
    var d = new Date(epochMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + monthsToAdd, d.getUTCDate(),
                    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  }

  async function cohortRetention(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("subscriptionAnalytics.cohortRetention: input object required");
    }
    var cohort = _cohortMonth(input.cohort_month);
    var periods = _periods(input.periods);
    var bounds = _monthBoundsUtc(cohort);

    var cohortRowsR = await query(
      "SELECT id, created_at, cancelled_at FROM subscriptions " +
      "WHERE created_at >= ?1 AND created_at < ?2",
      [bounds.start, bounds.end],
    );
    var cohortRows = cohortRowsR.rows;
    var cohortSize = cohortRows.length;

    var buckets = [];
    for (var p = 0; p < periods; p += 1) {
      var bucketEnd = _addMonthsUtc(bounds.start, p + 1);
      var active = 0;
      for (var i = 0; i < cohortRows.length; i += 1) {
        var row = cohortRows[i];
        var cancelled = row.cancelled_at == null ? null : Number(row.cancelled_at);
        if (cancelled == null || cancelled > bucketEnd) active += 1;
      }
      buckets.push({
        period:          p,
        period_start:    p === 0 ? bounds.start : _addMonthsUtc(bounds.start, p),
        period_end:      bucketEnd,
        active:          active,
        retention_rate:  cohortSize > 0 ? active / cohortSize : 0,
      });
    }

    return {
      cohort_month: cohort,
      cohort_size:  cohortSize,
      buckets:      buckets,
    };
  }

  // ---- planTransitions -----------------------------------------------

  async function planTransitions(input) {
    _requireInput(input, "planTransitions");
    var w = _window(input, "planTransitions");

    // The controls primitive surfaces plan changes via
    // `quantity_change` and `frequency_change` events, but the most
    // direct signal is a before/after JSON pair whose `plan_id` field
    // differs. We scan every event in the window and filter in JS —
    // SQLite has no JSON1 surface here.
    var r = await query(
      "SELECT subscription_id, before_json, after_json, occurred_at " +
      "FROM subscription_control_events " +
      "WHERE occurred_at >= ?1 AND occurred_at < ?2",
      [w.from, w.to],
    );

    var transitions = {};
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var before;
      var after;
      try { before = JSON.parse(row.before_json || "{}"); } catch (_eB) { before = {}; }
      try { after  = JSON.parse(row.after_json  || "{}"); } catch (_eA) { after  = {}; }
      var fromPlan = before.plan_id;
      var toPlan   = after.plan_id;
      if (!fromPlan || !toPlan || fromPlan === toPlan) continue;
      var key = fromPlan + "→" + toPlan;
      if (!transitions[key]) {
        transitions[key] = { from_plan_id: fromPlan, to_plan_id: toPlan, count: 0 };
      }
      transitions[key].count += 1;
    }

    // Hydrate plan amounts so direction can be classified.
    var allPlanIds = {};
    var tKeys = Object.keys(transitions);
    for (var k = 0; k < tKeys.length; k += 1) {
      allPlanIds[transitions[tKeys[k]].from_plan_id] = true;
      allPlanIds[transitions[tKeys[k]].to_plan_id]   = true;
    }
    var planIds = Object.keys(allPlanIds);
    var planById = {};
    for (var pi = 0; pi < planIds.length; pi += 1) {
      var pr = await query(
        "SELECT id, amount_minor, currency, interval, interval_count FROM subscription_plans WHERE id = ?1",
        [planIds[pi]],
      );
      if (pr.rows[0]) planById[planIds[pi]] = pr.rows[0];
    }

    var out = [];
    for (var t = 0; t < tKeys.length; t += 1) {
      var tr = transitions[tKeys[t]];
      var fromPlanRow = planById[tr.from_plan_id];
      var toPlanRow   = planById[tr.to_plan_id];
      var direction   = "lateral";
      if (fromPlanRow && toPlanRow && fromPlanRow.currency === toPlanRow.currency) {
        var fromMonthly = _monthlyMinor(
          Number(fromPlanRow.amount_minor), fromPlanRow.interval, Number(fromPlanRow.interval_count), 1
        );
        var toMonthly = _monthlyMinor(
          Number(toPlanRow.amount_minor), toPlanRow.interval, Number(toPlanRow.interval_count), 1
        );
        if (toMonthly > fromMonthly)      direction = "upgrade";
        else if (toMonthly < fromMonthly) direction = "downgrade";
        else                              direction = "lateral";
      }
      out.push({
        from_plan_id: tr.from_plan_id,
        to_plan_id:   tr.to_plan_id,
        count:        tr.count,
        direction:    direction,
      });
    }
    out.sort(function (a, b) {
      if (b.count !== a.count) return b.count - a.count;
      if (a.from_plan_id < b.from_plan_id) return -1;
      if (a.from_plan_id > b.from_plan_id) return 1;
      if (a.to_plan_id < b.to_plan_id) return -1;
      if (a.to_plan_id > b.to_plan_id) return 1;
      return 0;
    });
    return out;
  }

  // ---- topChurningPlans ----------------------------------------------

  async function topChurningPlans(input) {
    _requireInput(input, "topChurningPlans");
    var w = _window(input, "topChurningPlans");
    var limit = _limit(input && input.limit, "limit");

    var churnRows = (await query(
      "SELECT s.plan_id AS plan_id, COUNT(*) AS churned " +
      "FROM subscriptions s " +
      "WHERE s.cancelled_at IS NOT NULL " +
      "  AND s.cancelled_at >= ?1 AND s.cancelled_at < ?2 " +
      "GROUP BY s.plan_id " +
      "ORDER BY churned DESC, plan_id ASC " +
      "LIMIT ?3",
      [w.from, w.to, limit],
    )).rows;

    var out = [];
    for (var i = 0; i < churnRows.length; i += 1) {
      var row = churnRows[i];
      var activeAtStartR = (await query(
        "SELECT COUNT(*) AS n FROM subscriptions " +
        "WHERE plan_id = ?1 AND created_at <= ?2 " +
        "  AND (cancelled_at IS NULL OR cancelled_at >= ?2)",
        [row.plan_id, w.from],
      )).rows[0] || {};
      var activeAtStart = Number(activeAtStartR.n) || 0;
      var churned = Number(row.churned) || 0;
      out.push({
        plan_id:           row.plan_id,
        churned:           churned,
        active_at_start:   activeAtStart,
        churn_rate:        activeAtStart > 0 ? churned / activeAtStart : 0,
      });
    }
    return out;
  }

  // ---- recoveryRate --------------------------------------------------

  async function recoveryRate(input) {
    _requireInput(input, "recoveryRate");
    var w = _window(input, "recoveryRate");

    // Every dunning episode that ENTERED in the window.
    var entered = Number((await query(
      "SELECT COUNT(*) AS n FROM subscription_dunning_states " +
      "WHERE entered_at >= ?1 AND entered_at < ?2 AND state IN ('active', 'dunning')",
      [w.from, w.to],
    )).rows[0].n) || 0;

    // Wider scan: every dunning episode that started in the window
    // (regardless of current state) — so we can categorize the
    // exits.
    var allRows = (await query(
      "SELECT state, exited_at FROM subscription_dunning_states " +
      "WHERE entered_at >= ?1 AND entered_at < ?2",
      [w.from, w.to],
    )).rows;

    var recovered = 0;
    var cancelled = 0;
    var writtenOff = 0;
    var stillOpen = 0;
    var totalCount = allRows.length;
    for (var i = 0; i < allRows.length; i += 1) {
      var row = allRows[i];
      var state = row.state;
      var exited = row.exited_at != null;
      if (!exited)                              stillOpen += 1;
      else if (state === "recovered")           recovered += 1;
      else if (state === "cancelled")           cancelled += 1;
      else if (state === "written_off")         writtenOff += 1;
      else if (state === "active" ||
               state === "dunning")             stillOpen += 1;
    }
    var resolved = totalCount - stillOpen;
    var rate = resolved > 0 ? recovered / resolved : 0;
    // `entered` is exposed for the operator who wants the "still in
    // dunning" headline; default to totalCount when the active-only
    // scan returned 0 (no episodes are currently in active/dunning
    // state — every entry in the window has already resolved).
    void entered;
    return {
      from:           w.from,
      to:             w.to,
      entered:        totalCount,
      recovered:      recovered,
      cancelled:      cancelled,
      written_off:    writtenOff,
      still_open:     stillOpen,
      recovery_rate:  rate,
    };
  }

  // ---- dailyMrrSeries ------------------------------------------------

  async function dailyMrrSeries(input) {
    _requireInput(input, "dailyMrrSeries");
    var w = _window(input, "dailyMrrSeries");
    var currency = input && input.currency == null ? null : _currency(input.currency, true);

    // Bucket count = ceil((to - from) / 86_400_000). UTC day
    // boundaries: floor(ts / 86_400_000) * 86_400_000.
    var firstDayStart = Math.floor(w.from / ONE_DAY_MS) * ONE_DAY_MS;
    var lastDayStart  = Math.floor((w.to - 1) / ONE_DAY_MS) * ONE_DAY_MS;
    var dayCount = Math.floor((lastDayStart - firstDayStart) / ONE_DAY_MS) + 1;

    var out = [];
    for (var d = 0; d < dayCount; d += 1) {
      var dayStart = firstDayStart + d * ONE_DAY_MS;
      var dayEnd   = dayStart + ONE_DAY_MS;
      var atCutoff = dayEnd - 1;
      var snap = await _mrrSnapshot(atCutoff);
      var emitted = false;
      for (var i = 0; i < snap.currency_breakdown.length; i += 1) {
        var cb = snap.currency_breakdown[i];
        if (currency && cb.currency !== currency) continue;
        out.push({
          day:                 dayStart,
          currency:            cb.currency,
          mrr_minor:           cb.mrr_minor,
          subscription_count:  cb.subscription_count,
        });
        emitted = true;
      }
      if (!emitted) {
        // Surface an explicit zero row for days with no active
        // subscriptions so the chart doesn't render holes.
        out.push({
          day:                 dayStart,
          currency:            currency || null,
          mrr_minor:           0,
          subscription_count:  0,
        });
      }
    }
    return out;
  }

  // ---- cache management ----------------------------------------------

  async function purgeExpired(input) {
    input = input || {};
    var before = input.before == null ? Date.now() - DEFAULT_TTL_MS : _epochMs(input.before, "before");
    var r = await query(
      "DELETE FROM subscription_metrics_snapshots WHERE computed_at < ?1",
      [before],
    );
    return { purged: Number(r.rowCount || r.changes || 0) };
  }

  async function invalidate(input) {
    input = input || {};
    var sql = "DELETE FROM subscription_metrics_snapshots";
    var where = [];
    var params = [];
    var idx = 1;
    if (input.scope != null) {
      where.push("scope = ?" + idx);
      params.push(_scope(input.scope));
      idx += 1;
    }
    if (input.before != null) {
      where.push("computed_at < ?" + idx);
      params.push(_epochMs(input.before, "before"));
      idx += 1;
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    var r = await query(sql, params);
    return { invalidated: Number(r.rowCount || r.changes || 0) };
  }

  return {
    CACHE_NAMESPACE:    CACHE_NAMESPACE,
    DEFAULT_TTL_MS:     DEFAULT_TTL_MS,
    ONE_DAY_MS:         ONE_DAY_MS,
    ONE_YEAR_MS:        ONE_YEAR_MS,
    MAX_LIMIT:          MAX_LIMIT,
    MAX_PERIODS:        MAX_PERIODS,
    CADENCE_TO_MONTHLY: Object.assign({}, CADENCE_TO_MONTHLY),
    ACTIVE_STATUSES:    ACTIVE_STATUSES.slice(),
    CHURN_KINDS:        CHURN_KINDS.slice(),

    mrr:                mrr,
    arr:                arr,
    churnRate:          churnRate,
    pauseRate:          pauseRate,
    ltv:                ltv,
    cohortRetention:    cohortRetention,
    planTransitions:    planTransitions,
    topChurningPlans:   topChurningPlans,
    recoveryRate:       recoveryRate,
    dailyMrrSeries:     dailyMrrSeries,

    purgeExpired:       purgeExpired,
    invalidate:         invalidate,
  };
}

module.exports = {
  create:             create,
  CACHE_NAMESPACE:    CACHE_NAMESPACE,
  DEFAULT_TTL_MS:     DEFAULT_TTL_MS,
  ONE_DAY_MS:         ONE_DAY_MS,
  ONE_YEAR_MS:        ONE_YEAR_MS,
  MAX_LIMIT:          MAX_LIMIT,
  MAX_PERIODS:        MAX_PERIODS,
  CADENCE_TO_MONTHLY: Object.assign({}, CADENCE_TO_MONTHLY),
  ACTIVE_STATUSES:    ACTIVE_STATUSES.slice(),
  CHURN_KINDS:        CHURN_KINDS.slice(),
};
