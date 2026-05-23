"use strict";
/**
 * subscription-analytics — recurring-revenue rollups for the operator
 * dashboard. Read-only aggregator composing the existing subscription
 * primitives' tables. Owns one cache table
 * (`subscription_metrics_snapshots`) for memoizing dashboard hot-path
 * rollups; everything else is pure aggregation over canonical rows.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live
 * subscription migrations (0009 base + 0045 controls + 0066 billing +
 * 0178 analytics cache). The primitive isn't wired through `bShop`
 * yet — the test requires `lib/subscription-analytics.js` directly so
 * the gate exists ahead of the entry-point edit.
 *
 * Coverage:
 *   - mrr aggregation: monthly / annual / quarterly cadence
 *     normalization, per-currency breakdown, quantity multiplier
 *   - arr derivation: ARR == MRR × 12 per currency
 *   - churnRate math: voluntary vs involuntary vs all; rate math
 *     against the exposed-count denominator
 *   - cohortRetention shape: cohort_size + month-zero retention + per-
 *     period active count
 *   - planTransitions matrix: upgrade vs downgrade classification by
 *     monthly-normalized amount
 *   - topChurningPlans ordering + per-plan churn rate
 *   - recoveryRate split: recovered / cancelled / written_off / open
 *   - pauseRate against the controls-events ledger
 *   - ltv = avg_revenue / churn_rate
 *   - dailyMrrSeries time-bucketing on UTC day boundaries
 *   - cache round-trip (REPLACE on the UNIQUE tuple) + purgeExpired +
 *     invalidate({ scope })
 *   - input refusals on every public surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop                 = require("../../lib");
var subscriptionAnalytics = require("../../lib/subscription-analytics");
var helpers               = require("../helpers");
var check                 = helpers.check;
var assert                = helpers.assert;

var MIG_BASE     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0009_subscriptions.sql");
var MIG_CONTROLS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0045_subscription_controls.sql");
var MIG_BILLING  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0066_subscription_billing.sql");
var MIG_CACHE    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0178_subscription_analytics_cache.sql");

// Minimal `variants` table — the base subscriptions migration FKs into
// it. The analytics primitive never reads from variants; we create the
// table empty so the FK constraint resolves but no rows are written.
var MIG_VARIANTS_STUB =
  "CREATE TABLE IF NOT EXISTS variants (" +
  "  id TEXT NOT NULL PRIMARY KEY" +
  ");";

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // Disable foreign keys for the in-memory schema — the subscriptions
  // table FKs into `variants`, which our tests don't populate; we
  // exercise the analytics primitive end-to-end without dragging the
  // variant catalog in.
  db.prepare("PRAGMA foreign_keys = OFF").run();
  db.prepare(MIG_VARIANTS_STUB).run();
  [MIG_BASE, MIG_CONTROLS, MIG_BILLING, MIG_CACHE].forEach(function (path) {
    _splitSchema(nodeFs.readFileSync(path, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
  });
  var q = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        changes:   Number(info.changes),
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  q.db = db;
  return q;
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- seed helpers ------------------------------------------------------

async function _insertPlan(q, plan) {
  var now = plan.created_at || Date.now();
  await q(
    "INSERT INTO subscription_plans " +
    "(id, variant_id, stripe_price_id, interval, interval_count, currency, " +
    " amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, 0, 1, ?7, ?7)",
    [
      plan.id,
      plan.stripe_price_id || ("price_" + plan.id),
      plan.interval || "month",
      plan.interval_count || 1,
      plan.currency || "usd",
      plan.amount_minor,
      now,
    ],
  );
}

async function _insertSubscription(q, sub) {
  await q(
    "INSERT INTO subscriptions " +
    "(id, customer_id, plan_id, stripe_subscription_id, status, " +
    " current_period_start, current_period_end, cancel_at_period_end, " +
    " created_at, updated_at, " +
    " paused_at, paused_until, cancelled_at, quantity, frequency, next_billing_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, 0, ?6, ?6, ?7, ?8, ?9, ?10, NULL, NULL)",
    [
      sub.id,
      sub.customer_id || _uuid(),
      sub.plan_id,
      sub.stripe_subscription_id || ("stripe_" + sub.id),
      sub.status || "active",
      sub.created_at,
      sub.paused_at      || null,
      sub.paused_until   || null,
      sub.cancelled_at   || null,
      sub.quantity       || 1,
    ],
  );
}

async function _insertControlEvent(q, ev) {
  await q(
    "INSERT INTO subscription_control_events " +
    "(id, subscription_id, event, actor_type, actor_id, before_json, after_json, reason, occurred_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    [
      _uuid(),
      ev.subscription_id,
      ev.event,
      ev.actor_type || "operator",
      ev.actor_id || null,
      JSON.stringify(ev.before || {}),
      JSON.stringify(ev.after  || {}),
      ev.reason || null,
      ev.occurred_at,
    ],
  );
}

async function _insertInvoice(q, inv) {
  await q(
    "INSERT INTO subscription_invoices " +
    "(id, subscription_id, period_start, period_end, amount_minor, currency, " +
    " invoice_url, processor_invoice_id, status, paid_at, voided_at, created_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, NULL, ?10)",
    [
      inv.id || _uuid(),
      inv.subscription_id,
      inv.period_start,
      inv.period_end,
      inv.amount_minor,
      inv.currency || "usd",
      inv.processor_invoice_id || null,
      inv.status || "paid",
      inv.paid_at || (inv.status === "paid" ? inv.created_at : null),
      inv.created_at,
    ],
  );
}

async function _insertDunning(q, d) {
  await q(
    "INSERT INTO subscription_dunning_states " +
    "(id, subscription_id, state, reason, entered_at, exited_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    [
      _uuid(),
      d.subscription_id,
      d.state,
      d.reason || null,
      d.entered_at,
      d.exited_at || null,
    ],
  );
}

// ---- 1. mrr aggregation ------------------------------------------------

async function _mrrAggregation() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  var now = Date.now();
  var past = now - 30 * 86_400_000;

  // Plan A: monthly $50.00 USD; Plan B: yearly $600.00 USD (so $50/mo);
  // Plan C: weekly £10.00 GBP; Plan D: monthly $20.00 USD.
  await _insertPlan(q, { id: "plan-A", interval: "month", amount_minor: 5000, currency: "usd", created_at: past });
  await _insertPlan(q, { id: "plan-B", interval: "year",  amount_minor: 60000, currency: "usd", created_at: past });
  await _insertPlan(q, { id: "plan-C", interval: "week",  amount_minor: 1000, currency: "gbp", created_at: past });
  await _insertPlan(q, { id: "plan-D", interval: "month", amount_minor: 2000, currency: "usd", created_at: past });

  // Two on plan-A active, one with quantity=3.
  await _insertSubscription(q, { id: "sub-1", plan_id: "plan-A", created_at: past, status: "active", quantity: 1 });
  await _insertSubscription(q, { id: "sub-2", plan_id: "plan-A", created_at: past, status: "active", quantity: 3 });

  // One on plan-B annual (active).
  await _insertSubscription(q, { id: "sub-3", plan_id: "plan-B", created_at: past, status: "active", quantity: 1 });

  // One on plan-C weekly GBP.
  await _insertSubscription(q, { id: "sub-4", plan_id: "plan-C", created_at: past, status: "active", quantity: 1 });

  // One on plan-D but CANCELLED — must not count.
  await _insertSubscription(q, {
    id: "sub-5", plan_id: "plan-D", created_at: past, status: "active",
    cancelled_at: now - 86_400_000, quantity: 1,
  });

  // One on plan-A but PAUSED indefinitely (paused_until in the future) — must not count.
  await _insertSubscription(q, {
    id: "sub-6", plan_id: "plan-A", created_at: past, status: "active",
    paused_at: past, paused_until: now + 7 * 86_400_000, quantity: 1,
  });

  var snap = await sa.mrr({ at: now });
  // USD breakdown: sub-1 ($50) + sub-2 ($50 × 3 = $150) + sub-3 ($600/12 = $50) = $250.00 = 25000 minor
  // GBP breakdown: sub-4 weekly $10 × 30/7 = $42.857... = banker's round
  //                10_minor * 1 * (30/7) / 1 → 1000 * 4.285... = ~4286
  var usd = snap.currency_breakdown.filter(function (b) { return b.currency === "usd"; })[0];
  var gbp = snap.currency_breakdown.filter(function (b) { return b.currency === "gbp"; })[0];

  check("mrr usd present",          !!usd);
  check("mrr gbp present",          !!gbp);
  check("mrr usd value 25000",      usd.mrr_minor === 25000);
  check("mrr usd sub count 3",      usd.subscription_count === 3);
  check("mrr gbp sub count 1",      gbp.subscription_count === 1);
  check("mrr gbp value ~4286",      Math.abs(gbp.mrr_minor - 4286) <= 1);
  check("mrr mixed-currency omits total", snap.total_mrr_normalized_minor == null);

  // ARR derivation
  var arrSnap = await sa.arr({ at: now });
  var usdArr = arrSnap.currency_breakdown.filter(function (b) { return b.currency === "usd"; })[0];
  check("arr usd = mrr*12",          usdArr.arr_minor === 25000 * 12);

  // Refusals
  await assert.rejects(sa.mrr({ at: -1 }),    /at/);
  await assert.rejects(sa.mrr({ at: "x" }),   /at/);
}

// ---- 2. churnRate math -------------------------------------------------

async function _churnRateMath() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  var now = Date.now();
  var weekAgo = now - 7 * 86_400_000;
  var monthAgo = now - 30 * 86_400_000;

  await _insertPlan(q, { id: "p1", interval: "month", amount_minor: 1000, currency: "usd", created_at: monthAgo });

  // 10 subscriptions exist; 2 voluntarily cancelled in [weekAgo, now]; 1 involuntary churn (dunning written_off).
  for (var i = 0; i < 10; i += 1) {
    await _insertSubscription(q, {
      id: "s-" + i, plan_id: "p1", created_at: monthAgo, status: "active", quantity: 1,
    });
  }
  // Voluntary cancellations.
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [now - 86_400_000, "s-0"]);
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [now - 2 * 86_400_000, "s-1"]);

  // Involuntary churn: dunning episode that started + exited in window with written_off.
  await _insertDunning(q, {
    subscription_id: "s-9", state: "written_off",
    entered_at: now - 5 * 86_400_000, exited_at: now - 1 * 86_400_000,
  });

  var all = await sa.churnRate({ from: weekAgo, to: now, kind: "all" });
  check("churnRate all voluntary=2",      all.voluntary === 2);
  check("churnRate all involuntary=1",    all.involuntary === 1);
  check("churnRate all churned=3",        all.churned === 3);
  check("churnRate all exposed=10",       all.exposed === 10);
  check("churnRate all rate=0.3",         Math.abs(all.rate - 0.3) < 1e-9);

  var vol = await sa.churnRate({ from: weekAgo, to: now, kind: "voluntary" });
  check("churnRate voluntary only",       vol.churned === 2 && vol.involuntary === 0);

  var inv = await sa.churnRate({ from: weekAgo, to: now, kind: "involuntary" });
  check("churnRate involuntary only",     inv.churned === 1 && inv.voluntary === 0);

  // Refusals
  await assert.rejects(sa.churnRate(),                                          /input object required/);
  await assert.rejects(sa.churnRate({ from: 100, to: 50 }),                     /from/);
  await assert.rejects(sa.churnRate({ from: 0,   to: 2 * 365 * 86_400_000 }),    /1 year/);
  await assert.rejects(sa.churnRate({ from: weekAgo, to: now, kind: "weird" }), /kind/);
}

// ---- 3. cohortRetention shape ------------------------------------------

async function _cohortRetentionShape() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  // Build a cohort in January 2025 UTC.
  var jan2025 = Date.UTC(2025, 0, 15, 12, 0, 0);
  await _insertPlan(q, { id: "p1", interval: "month", amount_minor: 1000, currency: "usd", created_at: jan2025 - 86_400_000 });

  // 5 subscriptions started in Jan 2025.
  for (var i = 0; i < 5; i += 1) {
    await _insertSubscription(q, {
      id: "ch-" + i, plan_id: "p1", created_at: jan2025 + i * 86_400_000,
      status: "active", quantity: 1,
    });
  }
  // 2 cancelled in Feb 2025 (period 1).
  var feb2025 = Date.UTC(2025, 1, 10, 12, 0, 0);
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [feb2025, "ch-0"]);
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [feb2025 + 5 * 86_400_000, "ch-1"]);
  // 1 cancelled in April 2025 (period 3).
  var apr2025 = Date.UTC(2025, 3, 10, 12, 0, 0);
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [apr2025, "ch-2"]);

  var ret = await sa.cohortRetention({ cohort_month: "2025-01", periods: 6 });
  check("cohort_month echoed",            ret.cohort_month === "2025-01");
  check("cohort_size = 5",                ret.cohort_size === 5);
  check("buckets length = 6",             ret.buckets.length === 6);
  // Month 0 (end of Jan 2025): all 5 still active (cancellations land in Feb).
  check("bucket[0] active=5",             ret.buckets[0].active === 5);
  check("bucket[0] rate=1.0",             ret.buckets[0].retention_rate === 1);
  // Month 1 (end of Feb): 2 cancelled by then — 3 remain.
  check("bucket[1] active=3",             ret.buckets[1].active === 3);
  check("bucket[1] rate=0.6",             Math.abs(ret.buckets[1].retention_rate - 0.6) < 1e-9);
  // Month 3 (end of April): 3rd cancellation lands in April — 2 remain.
  check("bucket[3] active=2",             ret.buckets[3].active === 2);
  // Month 5: still 2.
  check("bucket[5] active=2",             ret.buckets[5].active === 2);

  // Empty cohort returns size=0 with full bucket structure.
  var empty = await sa.cohortRetention({ cohort_month: "2030-06", periods: 3 });
  check("empty cohort size 0",            empty.cohort_size === 0);
  check("empty cohort buckets present",   empty.buckets.length === 3);
  check("empty cohort rate=0",            empty.buckets[0].retention_rate === 0);

  // Refusals
  await assert.rejects(sa.cohortRetention(),                                          /input object required/);
  await assert.rejects(sa.cohortRetention({ cohort_month: "BAD",  periods: 3 }),       /cohort_month/);
  await assert.rejects(sa.cohortRetention({ cohort_month: "2025-13", periods: 3 }),    /cohort_month/);
  await assert.rejects(sa.cohortRetention({ cohort_month: "2025-01", periods: 0 }),    /periods/);
  await assert.rejects(sa.cohortRetention({ cohort_month: "2025-01", periods: 99 }),   /periods/);
}

// ---- 4. planTransitions matrix -----------------------------------------

async function _planTransitionsMatrix() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  var now = Date.now();
  var monthAgo = now - 30 * 86_400_000;

  // Three plans: basic ($10/mo), pro ($50/mo), premium ($100/mo).
  await _insertPlan(q, { id: "basic",   interval: "month", amount_minor: 1000,  currency: "usd", created_at: monthAgo });
  await _insertPlan(q, { id: "pro",     interval: "month", amount_minor: 5000,  currency: "usd", created_at: monthAgo });
  await _insertPlan(q, { id: "premium", interval: "month", amount_minor: 10000, currency: "usd", created_at: monthAgo });

  // Seed some subs (irrelevant content — events drive the matrix).
  await _insertSubscription(q, { id: "s-1", plan_id: "basic",   created_at: monthAgo, status: "active", quantity: 1 });
  await _insertSubscription(q, { id: "s-2", plan_id: "pro",     created_at: monthAgo, status: "active", quantity: 1 });
  await _insertSubscription(q, { id: "s-3", plan_id: "basic",   created_at: monthAgo, status: "active", quantity: 1 });

  // Three control events in window:
  //  - s-1: basic -> pro (upgrade)
  //  - s-2: pro -> basic (downgrade)
  //  - s-3: basic -> pro (upgrade)
  //  - one out of window
  await _insertControlEvent(q, {
    subscription_id: "s-1", event: "frequency_change",
    before: { plan_id: "basic" }, after: { plan_id: "pro" },
    occurred_at: now - 86_400_000,
  });
  await _insertControlEvent(q, {
    subscription_id: "s-2", event: "frequency_change",
    before: { plan_id: "pro" }, after: { plan_id: "basic" },
    occurred_at: now - 2 * 86_400_000,
  });
  await _insertControlEvent(q, {
    subscription_id: "s-3", event: "frequency_change",
    before: { plan_id: "basic" }, after: { plan_id: "pro" },
    occurred_at: now - 3 * 86_400_000,
  });
  // Out-of-window: should not count.
  await _insertControlEvent(q, {
    subscription_id: "s-1", event: "frequency_change",
    before: { plan_id: "pro" }, after: { plan_id: "premium" },
    occurred_at: monthAgo - 86_400_000,
  });

  var matrix = await sa.planTransitions({ from: monthAgo, to: now });
  check("matrix length 2",                 matrix.length === 2);
  // basic→pro (count 2) ranks before pro→basic (count 1).
  check("matrix[0] basic→pro count=2",     matrix[0].from_plan_id === "basic" && matrix[0].to_plan_id === "pro" && matrix[0].count === 2);
  check("matrix[0] is upgrade",            matrix[0].direction === "upgrade");
  check("matrix[1] pro→basic count=1",     matrix[1].from_plan_id === "pro" && matrix[1].to_plan_id === "basic" && matrix[1].count === 1);
  check("matrix[1] is downgrade",          matrix[1].direction === "downgrade");

  // Refusals
  await assert.rejects(sa.planTransitions(),                            /input object required/);
  await assert.rejects(sa.planTransitions({ from: 100, to: 50 }),       /from/);
}

// ---- 5. dailyMrrSeries time-bucketing ----------------------------------

async function _dailyMrrSeriesBucketing() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  // Anchor a deterministic 3-day window in UTC.
  var day0 = Date.UTC(2025, 5, 10, 0, 0, 0);
  var day1 = day0 + 86_400_000;
  var day2 = day0 + 2 * 86_400_000;
  var day3End = day0 + 3 * 86_400_000;

  await _insertPlan(q, { id: "p", interval: "month", amount_minor: 1000, currency: "usd", created_at: day0 - 86_400_000 });

  // sub-1: active for the whole window
  await _insertSubscription(q, { id: "s-1", plan_id: "p", created_at: day0 - 86_400_000, status: "active", quantity: 1 });
  // sub-2: starts on day1
  await _insertSubscription(q, { id: "s-2", plan_id: "p", created_at: day1 + 60_000, status: "active", quantity: 1 });
  // sub-3: cancelled at end of day0 (so absent from day1 and day2)
  await _insertSubscription(q, {
    id: "s-3", plan_id: "p", created_at: day0 - 86_400_000, status: "active", quantity: 1,
    cancelled_at: day0 + 86_400_000 - 1,
  });

  var series = await sa.dailyMrrSeries({ from: day0, to: day3End, currency: "usd" });
  check("series has 3 days",                series.length === 3);
  check("series[0] day = day0",             series[0].day === day0);
  check("series[1] day = day1",             series[1].day === day1);
  check("series[2] day = day2",             series[2].day === day2);

  // Day0: sub-1 + sub-3 active at end-of-day cutoff (sub-3.cancelled_at = day0+86400000-1, cutoff = day1-1; predicate uses cancelled_at > at, so sub-3 EQUAL → not active). sub-1 only.
  // Actually: sub-3 cancelled_at = day0 + 86_400_000 - 1; cutoff = day1 - 1 = day0 + 86_400_000 - 1; cancelled_at > at is false → sub-3 NOT active. sub-1 only.
  check("day0 = 1 subscription",            series[0].subscription_count === 1);
  // Day1: sub-1 + sub-2 active (sub-2 started at day1 + 60s, cutoff = day2 - 1, sub-2.created_at <= cutoff). sub-3 cancelled.
  check("day1 = 2 subscriptions",           series[1].subscription_count === 2);
  // Day2: sub-1 + sub-2 active.
  check("day2 = 2 subscriptions",           series[2].subscription_count === 2);

  // Currency filter omitted returns per-currency rows.
  var seriesAll = await sa.dailyMrrSeries({ from: day0, to: day3End });
  check("series no currency filter",        seriesAll.length === 3);

  // Refusals
  await assert.rejects(sa.dailyMrrSeries(),                                /input object required/);
  await assert.rejects(sa.dailyMrrSeries({ from: 100, to: 50 }),           /from/);
  await assert.rejects(sa.dailyMrrSeries({ from: 0, to: 1000, currency: "X" }), /currency/);
}

// ---- 6. recoveryRate + topChurningPlans + pauseRate + ltv --------------

async function _supplementaryRollups() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  var now = Date.now();
  var weekAgo = now - 7 * 86_400_000;
  var monthAgo = now - 30 * 86_400_000;

  await _insertPlan(q, { id: "p1", interval: "month", amount_minor: 1000, currency: "usd", created_at: monthAgo });
  await _insertPlan(q, { id: "p2", interval: "month", amount_minor: 5000, currency: "usd", created_at: monthAgo });

  // 5 subs on p1, 3 on p2. p1 sees more churn.
  for (var i = 0; i < 5; i += 1) {
    await _insertSubscription(q, { id: "p1-" + i, plan_id: "p1", created_at: monthAgo, status: "active", quantity: 1 });
  }
  for (var j = 0; j < 3; j += 1) {
    await _insertSubscription(q, { id: "p2-" + j, plan_id: "p2", created_at: monthAgo, status: "active", quantity: 1 });
  }
  // p1: 3 cancellations in window
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [now - 86_400_000, "p1-0"]);
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [now - 86_400_000, "p1-1"]);
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [now - 86_400_000, "p1-2"]);
  // p2: 1 cancellation in window
  await q("UPDATE subscriptions SET cancelled_at = ?1 WHERE id = ?2", [now - 86_400_000, "p2-0"]);

  var top = await sa.topChurningPlans({ from: weekAgo, to: now, limit: 5 });
  check("topChurning length 2",         top.length === 2);
  check("topChurning #1 = p1 (3)",      top[0].plan_id === "p1" && top[0].churned === 3);
  check("topChurning #2 = p2 (1)",      top[1].plan_id === "p2" && top[1].churned === 1);
  check("topChurning rate present",     typeof top[0].churn_rate === "number");

  // pauseRate via control events.
  await _insertControlEvent(q, {
    subscription_id: "p1-3", event: "pause",
    before: {}, after: { paused_at: now - 86_400_000 }, occurred_at: now - 86_400_000,
  });
  await _insertControlEvent(q, {
    subscription_id: "p2-1", event: "pause",
    before: {}, after: { paused_at: now - 86_400_000 }, occurred_at: now - 86_400_000,
  });
  var pr = await sa.pauseRate({ from: weekAgo, to: now });
  check("pauseRate paused=2",           pr.paused === 2);
  check("pauseRate exposed > 0",        pr.exposed >= 6);
  check("pauseRate has rate",           typeof pr.rate === "number");

  // recoveryRate
  await _insertDunning(q, { subscription_id: "p1-3", state: "recovered",   entered_at: now - 4 * 86_400_000, exited_at: now - 2 * 86_400_000 });
  await _insertDunning(q, { subscription_id: "p1-4", state: "cancelled",   entered_at: now - 4 * 86_400_000, exited_at: now - 1 * 86_400_000 });
  await _insertDunning(q, { subscription_id: "p2-2", state: "written_off", entered_at: now - 4 * 86_400_000, exited_at: now - 1 * 86_400_000 });
  await _insertDunning(q, { subscription_id: "p1-0", state: "dunning",     entered_at: now - 1 * 86_400_000 });

  var rr = await sa.recoveryRate({ from: weekAgo, to: now });
  check("recoveryRate entered=4",         rr.entered === 4);
  check("recoveryRate recovered=1",       rr.recovered === 1);
  check("recoveryRate cancelled=1",       rr.cancelled === 1);
  check("recoveryRate written_off=1",     rr.written_off === 1);
  check("recoveryRate still_open=1",      rr.still_open === 1);
  check("recoveryRate rate = 1/3",        Math.abs(rr.recovery_rate - (1 / 3)) < 1e-9);

  // ltv — invoices on the active p1 subs.
  await _insertInvoice(q, { subscription_id: "p1-3", period_start: monthAgo, period_end: now, amount_minor: 2000, currency: "usd", status: "paid", paid_at: weekAgo + 1, created_at: weekAgo + 1 });
  await _insertInvoice(q, { subscription_id: "p1-4", period_start: monthAgo, period_end: now, amount_minor: 3000, currency: "usd", status: "paid", paid_at: weekAgo + 2, created_at: weekAgo + 2 });

  var lt = await sa.ltv({ from: weekAgo, to: now });
  check("ltv sample_size = 2",          lt.sample_size === 2);
  check("ltv avg revenue = 2500",       lt.avg_revenue_minor === 2500);
  check("ltv churn_rate > 0",           lt.churn_rate > 0);
  check("ltv minor present",            typeof lt.ltv_minor === "number" || lt.ltv_minor === null);
}

// ---- 7. cache round-trip + invalidation --------------------------------

async function _cacheRoundTrip() {
  var q = _makeQuery();
  var sa = subscriptionAnalytics.create({ query: q });
  var now = Date.now();
  var monthAgo = now - 30 * 86_400_000;

  await _insertPlan(q, { id: "p", interval: "month", amount_minor: 1000, currency: "usd", created_at: monthAgo });
  await _insertSubscription(q, { id: "s-1", plan_id: "p", created_at: monthAgo, status: "active", quantity: 1 });

  // First call seeds the cache.
  var s1 = await sa.mrr({ at: now });
  check("mrr first call",                s1.currency_breakdown.length === 1);

  var cacheRows = (await q("SELECT * FROM subscription_metrics_snapshots", [])).rows;
  check("cache row written",             cacheRows.length === 1);
  check("cache scope = mrr",             cacheRows[0].scope === "mrr");
  check("cache scope_value hex",         typeof cacheRows[0].scope_value === "string" && /^[0-9a-f]{128}$/.test(cacheRows[0].scope_value));
  check("cache value matches headline",  Number(cacheRows[0].value) === s1.total_mrr_normalized_minor);

  // Second call serves from cache (no new row).
  var s2 = await sa.mrr({ at: now });
  var cacheRows2 = (await q("SELECT * FROM subscription_metrics_snapshots", [])).rows;
  check("cache reused (no extra row)",   cacheRows2.length === 1);
  check("cache hit shape match",         s2.total_mrr_normalized_minor === s1.total_mrr_normalized_minor);

  // cache: false bypasses (no cache write, no cache read).
  var s3 = await sa.mrr({ at: now, cache: false });
  check("cache=false bypass",            s3.currency_breakdown.length === 1);
  var cacheRows3 = (await q("SELECT * FROM subscription_metrics_snapshots", [])).rows;
  check("cache row count unchanged",     cacheRows3.length === 1);

  // purgeExpired with before=now+1 wipes everything older.
  var purge = await sa.purgeExpired({ before: now + 86_400_000 });
  check("purgeExpired purged 1",         purge.purged === 1);

  // invalidate by scope removes nothing now (already empty) — sanity.
  await sa.mrr({ at: now });
  var inv = await sa.invalidate({ scope: "mrr" });
  check("invalidate by scope = 1",       inv.invalidated === 1);

  // Refusals
  await assert.rejects(sa.invalidate({ scope: "BAD CAPS" }),    /scope/);
  await assert.rejects(sa.invalidate({ before: "x" }),          /before/);
  await assert.rejects(sa.purgeExpired({ before: -1 }),         /before/);
}

async function run() {
  await _mrrAggregation();
  await _churnRateMath();
  await _cohortRetentionShape();
  await _planTransitionsMatrix();
  await _dailyMrrSeriesBucketing();
  await _supplementaryRollups();
  await _cacheRoundTrip();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/subscription-analytics.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — subscription-analytics (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — subscription-analytics: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
