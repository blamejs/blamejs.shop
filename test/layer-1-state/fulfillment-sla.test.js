"use strict";
/**
 * fulfillment-sla — per-order shipping + delivery deadlines and breach
 * tracking.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0183
 * (fulfillment_sla_policies + fulfillment_sla_breaches).
 *
 * Coverage:
 *   - definePolicy upserts + re-defines preserve slug + un-archive
 *   - definePolicy refuses bad shape (slug, priority, hours, cutoff/tz pair)
 *   - archivePolicy hides from priority-resolution
 *   - evaluateOrder math: ship_by / deliver_by anchored on placed_at
 *   - evaluateOrder honours cutoff: before-cutoff anchors on placed_at,
 *     after-cutoff rolls to next local midnight
 *   - evaluateOrder no-policy branch returns { status: "no_policy" }
 *   - evaluateOrder via wired order.get when no snapshot supplied
 *   - recordBreach computes severity by hours_over band
 *   - recordBreach fans out to notifications + drop-silent on outage
 *   - currentBreaches filters by severity + caps via limit
 *   - breachesForOrder scopes + newest-first
 *   - metricsForPolicy aggregates by severity + on_time_rate with
 *     dedupped breach-order denominator
 *   - topBreachingPolicies ranks by breach count
 *   - forecastImpact buckets open orders into already_breached /
 *     at_risk / on_track / no_policy
 *   - factory refusals (bad order / notifications handles)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var fulfillmentSLA = require("../../lib/fulfillment-sla");
var helpers        = require("../helpers");
var check  = helpers.check;
var assert = helpers.assert;

var MIGS = ["0183_fulfillment_sla.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  var queryFn = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// In-memory notifications collector — captures every enqueue call for
// assertion. `_fail` mode flips enqueue to throw so the drop-silent
// branch in recordBreach gets exercised.
function _stubNotifications() {
  var calls = [];
  var failNext = false;
  return {
    enqueue: async function (input) {
      if (failNext) {
        failNext = false;
        throw new Error("notifications outage simulated");
      }
      calls.push(input);
      return { id: bShop.framework.uuid.v7() };
    },
    _calls:    function () { return calls; },
    _failNext: function () { failNext = true; },
  };
}

// In-memory order stub — only `get(order_id)` is needed by the
// evaluateOrder path when no snapshot is supplied.
function _stubOrder(rows) {
  return {
    get: async function (orderId) {
      return rows[orderId] || null;
    },
  };
}

async function _definePolicyAndUpsert() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });

  var p1 = await sla.definePolicy({
    slug:                 "std-48",
    priority:             "standard",
    ship_within_hours:    24,
    deliver_within_hours: 48,
  });
  check("policy slug",              p1.slug === "std-48");
  check("policy priority",          p1.priority === "standard");
  check("policy ship hours",        p1.ship_within_hours === 24);
  check("policy deliver hours",     p1.deliver_within_hours === 48);
  check("policy cutoff null",       p1.cutoff_local_time === null);
  check("policy timezone null",     p1.timezone === null);
  check("policy not archived",      p1.archived_at === null);

  // Re-define same slug — updates fields in place; created_at preserved.
  var p2 = await sla.definePolicy({
    slug:                 "std-48",
    priority:             "standard",
    ship_within_hours:    12,
    deliver_within_hours: 36,
  });
  check("re-define updates ship",   p2.ship_within_hours === 12);
  check("re-define updates deliver", p2.deliver_within_hours === 36);
  check("re-define preserves created", p2.created_at === p1.created_at);

  // Define cutoff-based same-day policy
  var sd = await sla.definePolicy({
    slug:                 "same-day-2pm",
    priority:             "same_day",
    ship_within_hours:    8,
    deliver_within_hours: 24,
    cutoff_local_time:    "14:00",
    timezone:             "America/Los_Angeles",
  });
  check("cutoff policy stores HH:MM", sd.cutoff_local_time === "14:00");
  check("cutoff policy stores tz",    sd.timezone === "America/Los_Angeles");

  // Re-define un-archives a previously-archived policy
  await sla.archivePolicy("std-48");
  var archived = await sla.getPolicy("std-48");
  check("archive sets archived_at",   typeof archived.archived_at === "number");
  var unarchived = await sla.definePolicy({
    slug:                 "std-48",
    priority:             "standard",
    ship_within_hours:    24,
    deliver_within_hours: 48,
  });
  check("re-define un-archives",     unarchived.archived_at === null);

  // Refusals
  await assert.rejects(sla.definePolicy(),                                  /input object required/);
  await assert.rejects(sla.definePolicy({ slug: "BAD SLUG", priority: "standard", ship_within_hours: 1, deliver_within_hours: 2 }), /slug/);
  await assert.rejects(sla.definePolicy({ slug: "ok", priority: "fast", ship_within_hours: 1, deliver_within_hours: 2 }), /priority/);
  await assert.rejects(sla.definePolicy({ slug: "ok", priority: "standard", ship_within_hours: 0, deliver_within_hours: 2 }), /ship_within_hours/);
  await assert.rejects(sla.definePolicy({ slug: "ok", priority: "standard", ship_within_hours: 5, deliver_within_hours: 3 }), /deliver_within_hours must be >= ship_within_hours/);
  await assert.rejects(sla.definePolicy({ slug: "ok", priority: "standard", ship_within_hours: 1, deliver_within_hours: 2, cutoff_local_time: "14:00" }), /both be set or both be omitted/);
  await assert.rejects(sla.definePolicy({ slug: "ok", priority: "standard", ship_within_hours: 1, deliver_within_hours: 2, cutoff_local_time: "25:00", timezone: "UTC" }), /cutoff_local_time/);
  await assert.rejects(sla.definePolicy({ slug: "ok", priority: "standard", ship_within_hours: 1, deliver_within_hours: 2, cutoff_local_time: "14:00", timezone: "Not/A_Zone" }), /timezone/);
}

async function _archivePolicyHides() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({ slug: "to-archive", priority: "expedited", ship_within_hours: 4, deliver_within_hours: 12 });
  // Active policy resolves
  var ev1 = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "expedited", placed_at: Date.now() },
  });
  check("active policy resolves",       ev1.status === "evaluated" && ev1.policy_slug === "to-archive");

  // Archive + resolve again — no_policy branch fires
  await sla.archivePolicy("to-archive");
  var ev2 = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "expedited", placed_at: Date.now() },
  });
  check("archived policy no longer resolves", ev2.status === "no_policy");

  // Archive miss returns null
  var miss = await sla.archivePolicy("never-existed");
  check("archivePolicy miss = null",    miss === null);
}

async function _evaluateOrderMath() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({
    slug:                 "std-48",
    priority:             "standard",
    ship_within_hours:    24,
    deliver_within_hours: 48,
  });
  var orderId = bShop.framework.uuid.v7();
  var placedAt = Date.now() - 6 * 60 * 60 * 1000;  // 6h ago
  var ev = await sla.evaluateOrder({
    order_id: orderId,
    order_snapshot: { priority: "standard", placed_at: placedAt },
  });
  check("evaluated status",             ev.status === "evaluated");
  check("policy slug echoed",           ev.policy_slug === "std-48");
  check("priority echoed",              ev.priority === "standard");
  check("ship_by = placed + 24h",       ev.ship_by === placedAt + 24 * 60 * 60 * 1000);
  check("deliver_by = placed + 48h",    ev.deliver_by === placedAt + 48 * 60 * 60 * 1000);
  check("hours_to_ship mirrored",       ev.hours_to_ship === 24);
  check("hours_to_deliver mirrored",    ev.hours_to_deliver === 48);
  // 24h budget, 6h elapsed → ~18h slack against earliest deadline (ship_by)
  check("slack ~18h (positive)",        ev.slack_hours > 17 && ev.slack_hours < 19);
  check("clock_start = placed_at (no cutoff)", ev.clock_start_at === placedAt);

  // Past-due order → negative slack
  var oldPlaced = Date.now() - 36 * 60 * 60 * 1000;
  var late = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "standard", placed_at: oldPlaced },
  });
  check("late order negative slack",    late.slack_hours < 0);

  // No-policy branch
  var noPol = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "overnight", placed_at: Date.now() },
  });
  check("no_policy branch",             noPol.status === "no_policy");
  check("no_policy echoes priority",    noPol.priority === "overnight");

  // Refusals
  await assert.rejects(sla.evaluateOrder(),                                          /input object required/);
  await assert.rejects(sla.evaluateOrder({ order_id: "not-a-uuid", order_snapshot: { priority: "standard", placed_at: 0 } }), /order_id/);
  await assert.rejects(sla.evaluateOrder({ order_id: bShop.framework.uuid.v7(), order_snapshot: { priority: "bogus", placed_at: 0 } }), /priority/);
  await assert.rejects(sla.evaluateOrder({ order_id: bShop.framework.uuid.v7(), order_snapshot: { priority: "standard", placed_at: -1 } }), /placed_at/);
  await assert.rejects(sla.evaluateOrder({ order_id: bShop.framework.uuid.v7() }),   /order_snapshot required/);
}

async function _evaluateOrderCutoff() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({
    slug:                 "same-day-2pm-utc",
    priority:             "same_day",
    ship_within_hours:    8,
    deliver_within_hours: 24,
    cutoff_local_time:    "14:00",
    timezone:             "UTC",
  });

  // Order placed at 13:00 UTC on 2026-01-15 → before cutoff → clock
  // starts at placed_at.
  var beforeCutoff = Date.UTC(2026, 0, 15, 13, 0, 0);
  var ev1 = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "same_day", placed_at: beforeCutoff },
  });
  check("before-cutoff clock = placed_at", ev1.clock_start_at === beforeCutoff);

  // Order placed at 15:00 UTC same day → after cutoff → clock rolls to
  // 2026-01-16 00:00 UTC.
  var afterCutoff   = Date.UTC(2026, 0, 15, 15, 0, 0);
  var nextMidnight  = Date.UTC(2026, 0, 16,  0, 0, 0);
  var ev2 = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "same_day", placed_at: afterCutoff },
  });
  check("after-cutoff rolls to next midnight", ev2.clock_start_at === nextMidnight);
  check("after-cutoff ship_by rolled",         ev2.ship_by === nextMidnight + 8 * 60 * 60 * 1000);
  check("after-cutoff deliver_by rolled",      ev2.deliver_by === nextMidnight + 24 * 60 * 60 * 1000);

  // Order placed exactly AT 14:00 UTC → inclusive → before cutoff.
  var atCutoff = Date.UTC(2026, 0, 15, 14, 0, 0);
  var ev3 = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "same_day", placed_at: atCutoff },
  });
  check("at-cutoff treated as before",         ev3.clock_start_at === atCutoff);
}

async function _evaluateOrderViaOrderHandle() {
  var q = _makeQuery();
  var orderRow = { priority: "standard", placed_at: Date.now() - 2 * 60 * 60 * 1000 };
  var orderId  = bShop.framework.uuid.v7();
  var orderRows = {};
  orderRows[orderId] = orderRow;
  var sla = fulfillmentSLA.create({ query: q, order: _stubOrder(orderRows) });
  await sla.definePolicy({
    slug: "std", priority: "standard", ship_within_hours: 12, deliver_within_hours: 24,
  });
  var ev = await sla.evaluateOrder({ order_id: orderId });
  check("evaluateOrder via order.get",   ev.status === "evaluated");
  check("placed_at resolved via order",  ev.placed_at === orderRow.placed_at);

  // Missing order → throws
  await assert.rejects(sla.evaluateOrder({ order_id: bShop.framework.uuid.v7() }), /not found via order.get/);
}

async function _recordBreachSeverity() {
  var q = _makeQuery();
  var notif = _stubNotifications();
  var sla = fulfillmentSLA.create({ query: q, notifications: notif });
  await sla.definePolicy({
    slug: "std-48", priority: "standard", ship_within_hours: 24, deliver_within_hours: 48,
  });
  var orderA = bShop.framework.uuid.v7();
  var minor = await sla.recordBreach({
    order_id: orderA, policy_slug: "std-48", breach_type: "ship", hours_over: 4,
  });
  check("minor severity (<24h)",        minor.severity === "minor");
  check("breach returns id",            typeof minor.id === "string" && minor.id.length === 36);

  var orderB = bShop.framework.uuid.v7();
  var major = await sla.recordBreach({
    order_id: orderB, policy_slug: "std-48", breach_type: "deliver", hours_over: 36,
  });
  check("major severity (24-72h)",      major.severity === "major");

  var orderC = bShop.framework.uuid.v7();
  var critical = await sla.recordBreach({
    order_id: orderC, policy_slug: "std-48", breach_type: "ship", hours_over: 100,
  });
  check("critical severity (>=72h)",    critical.severity === "critical");

  // Boundary: hours_over = 24 should be "major" (>= 24 < 72)
  var orderD = bShop.framework.uuid.v7();
  var boundary = await sla.recordBreach({
    order_id: orderD, policy_slug: "std-48", breach_type: "ship", hours_over: 24,
  });
  check("boundary 24 → major",          boundary.severity === "major");
  // Boundary: hours_over = 72 should be "critical" (>= 72)
  var orderE = bShop.framework.uuid.v7();
  var boundary2 = await sla.recordBreach({
    order_id: orderE, policy_slug: "std-48", breach_type: "ship", hours_over: 72,
  });
  check("boundary 72 → critical",       boundary2.severity === "critical");

  // Notifications fan-out happened (one per breach)
  check("notifications enqueued one per breach", notif._calls().length === 5);
  var first = notif._calls()[0];
  check("notif channel",                first.channel === "sla-breach");
  check("notif event_type",             first.event_type === "sla_breach_recorded");
  check("notif payload severity",       first.payload.severity === "minor");

  // Drop-silent on notifications outage — breach still records
  notif._failNext();
  var orderF = bShop.framework.uuid.v7();
  var stillOk = await sla.recordBreach({
    order_id: orderF, policy_slug: "std-48", breach_type: "deliver", hours_over: 1,
  });
  check("breach recorded despite notif outage", stillOk.severity === "minor");
  var allBreaches = await sla.currentBreaches({ limit: 100 });
  check("all 6 breaches recorded",      allBreaches.length === 6);

  // recordBreach via priority lookup (no policy_slug)
  var orderG = bShop.framework.uuid.v7();
  var viaPriority = await sla.recordBreach({
    order_id: orderG, priority: "standard", breach_type: "ship", hours_over: 5,
  });
  check("recordBreach via priority",    viaPriority.policy_slug === "std-48");

  // Refusals
  await assert.rejects(sla.recordBreach(),                                                   /input object required/);
  await assert.rejects(sla.recordBreach({ order_id: orderA, breach_type: "ship", hours_over: 1 }), /policy_slug or priority required/);
  await assert.rejects(sla.recordBreach({ order_id: orderA, policy_slug: "nope", breach_type: "ship", hours_over: 1 }), /not found/);
  await assert.rejects(sla.recordBreach({ order_id: orderA, priority: "overnight", breach_type: "ship", hours_over: 1 }), /no active policy/);
  await assert.rejects(sla.recordBreach({ order_id: orderA, policy_slug: "std-48", breach_type: "bogus", hours_over: 1 }), /breach_type/);
  await assert.rejects(sla.recordBreach({ order_id: orderA, policy_slug: "std-48", breach_type: "ship", hours_over: -1 }), /hours_over/);
}

async function _currentBreachesAndForOrder() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({
    slug: "p", priority: "standard", ship_within_hours: 24, deliver_within_hours: 48,
  });
  var orderA = bShop.framework.uuid.v7();
  var orderB = bShop.framework.uuid.v7();
  await sla.recordBreach({ order_id: orderA, policy_slug: "p", breach_type: "ship",    hours_over: 4 });
  // Advance the monotonic clock so the next breach sorts after the first
  await helpers.waitUntil(function (start) {
    return function () { return Date.now() > start; };
  }(Date.now()), { timeoutMs: 100, intervalMs: 1, label: "ms tick" });
  await sla.recordBreach({ order_id: orderA, policy_slug: "p", breach_type: "deliver", hours_over: 100 });
  await helpers.waitUntil(function (start) {
    return function () { return Date.now() > start; };
  }(Date.now()), { timeoutMs: 100, intervalMs: 1, label: "ms tick" });
  await sla.recordBreach({ order_id: orderB, policy_slug: "p", breach_type: "ship",    hours_over: 30 });

  var all = await sla.currentBreaches();
  check("currentBreaches returns 3",          all.length === 3);
  check("currentBreaches newest first",       all[0].order_id === orderB);

  // Filter by severity
  var crits = await sla.currentBreaches({ severity: "critical" });
  check("severity filter critical",           crits.length === 1 && crits[0].hours_over === 100);
  var majors = await sla.currentBreaches({ severity: "major" });
  check("severity filter major",              majors.length === 1 && majors[0].order_id === orderB);
  var minors = await sla.currentBreaches({ severity: "minor" });
  check("severity filter minor",              minors.length === 1 && minors[0].order_id === orderA);

  // Limit cap
  var capped = await sla.currentBreaches({ limit: 2 });
  check("limit caps result",                  capped.length === 2);

  // breachesForOrder scoped + newest-first
  var aBreaches = await sla.breachesForOrder(orderA);
  check("breachesForOrder count",             aBreaches.length === 2);
  check("breachesForOrder newest first",      aBreaches[0].breach_type === "deliver");
  check("breachesForOrder scoped",            aBreaches.every(function (r) { return r.order_id === orderA; }));

  // Refusals
  await assert.rejects(sla.currentBreaches({ severity: "weird" }),               /severity/);
  await assert.rejects(sla.currentBreaches({ limit: 0 }),                        /limit/);
  await assert.rejects(sla.currentBreaches({ limit: 1000 }),                     /limit/);
  await assert.rejects(sla.breachesForOrder("not-a-uuid"),                       /order_id/);
}

async function _metricsForPolicy() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({
    slug: "metrics-p", priority: "standard", ship_within_hours: 24, deliver_within_hours: 48,
  });
  var from = Date.now() - 60000;
  var orderA = bShop.framework.uuid.v7();
  var orderB = bShop.framework.uuid.v7();
  var orderC = bShop.framework.uuid.v7();
  // orderA breaches twice (ship + deliver); orderB once; orderC once
  await sla.recordBreach({ order_id: orderA, policy_slug: "metrics-p", breach_type: "ship",    hours_over: 2 });
  await sla.recordBreach({ order_id: orderA, policy_slug: "metrics-p", breach_type: "deliver", hours_over: 30 });
  await sla.recordBreach({ order_id: orderB, policy_slug: "metrics-p", breach_type: "ship",    hours_over: 80 });
  await sla.recordBreach({ order_id: orderC, policy_slug: "metrics-p", breach_type: "deliver", hours_over: 1 });
  var to = Date.now() + 60000;

  var m1 = await sla.metricsForPolicy({ slug: "metrics-p", from: from, to: to });
  check("total_breaches",                4 === m1.total_breaches);
  check("by_severity minor",             m1.by_severity.minor === 2);   // 2h + 1h
  check("by_severity major",             m1.by_severity.major === 1);   // 30h
  check("by_severity critical",          m1.by_severity.critical === 1); // 80h
  // average lateness = (2 + 30 + 80 + 1) / 4 = 28.25
  check("average_lateness_hours",        Math.abs(m1.average_lateness_hours - 28.25) < 1e-9);
  check("worst_lateness_hours",          m1.worst_lateness_hours === 80);
  check("on_time_rate null without total_orders", m1.on_time_rate === null);

  // With total_orders supplied → on-time rate dedups breaching orders
  // (orderA appears twice but counts as one breaching order).
  var m2 = await sla.metricsForPolicy({
    slug: "metrics-p", from: from, to: to, total_orders: 10,
  });
  // 3 distinct breaching orders out of 10 → on_time_rate = 7/10
  check("on_time_rate dedups orders",    Math.abs(m2.on_time_rate - 0.7) < 1e-9);
  check("total_orders echoed",           m2.total_orders === 10);

  // Empty window
  var future = Date.now() + 365 * 24 * 60 * 60 * 1000;
  var m3 = await sla.metricsForPolicy({ slug: "metrics-p", from: future, to: future + 1 });
  check("empty window total=0",          m3.total_breaches === 0);
  check("empty window avg=0",            m3.average_lateness_hours === 0);
  check("empty window worst=0",          m3.worst_lateness_hours === 0);

  // Refusals
  await assert.rejects(sla.metricsForPolicy(),                                                /input object required/);
  await assert.rejects(sla.metricsForPolicy({ slug: "metrics-p", from: 100, to: 50 }),        /from must be <= to/);
  await assert.rejects(sla.metricsForPolicy({ slug: "metrics-p", from: 0, to: 1, total_orders: -1 }), /total_orders/);
}

async function _topBreachingPolicies() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({ slug: "a", priority: "standard",  ship_within_hours: 24, deliver_within_hours: 48 });
  await sla.definePolicy({ slug: "b", priority: "expedited", ship_within_hours: 8,  deliver_within_hours: 24 });
  await sla.definePolicy({ slug: "c", priority: "overnight", ship_within_hours: 4,  deliver_within_hours: 12 });

  var from = Date.now() - 60000;
  // a: 3 breaches, b: 2 breaches, c: 1 breach
  for (var i = 0; i < 3; i += 1) {
    await sla.recordBreach({ order_id: bShop.framework.uuid.v7(), policy_slug: "a", breach_type: "ship", hours_over: 5 });
  }
  for (var j = 0; j < 2; j += 1) {
    await sla.recordBreach({ order_id: bShop.framework.uuid.v7(), policy_slug: "b", breach_type: "deliver", hours_over: 10 });
  }
  await sla.recordBreach({ order_id: bShop.framework.uuid.v7(), policy_slug: "c", breach_type: "ship", hours_over: 1 });
  var to = Date.now() + 60000;

  var top = await sla.topBreachingPolicies({ from: from, to: to, limit: 5 });
  check("topBreaching returns 3 policies",   top.length === 3);
  check("topBreaching ranked by count",      top[0].policy_slug === "a" && top[0].breach_count === 3);
  check("topBreaching rank 2",               top[1].policy_slug === "b" && top[1].breach_count === 2);
  check("topBreaching rank 3",               top[2].policy_slug === "c" && top[2].breach_count === 1);
  check("topBreaching avg lateness present", top[0].average_lateness_hours === 5);

  // Limit caps result
  var top1 = await sla.topBreachingPolicies({ from: from, to: to, limit: 1 });
  check("topBreaching limit=1",              top1.length === 1 && top1[0].policy_slug === "a");

  // Refusals
  await assert.rejects(sla.topBreachingPolicies(),                                       /input object required/);
  await assert.rejects(sla.topBreachingPolicies({ from: 100, to: 50 }),                  /from must be <= to/);
  await assert.rejects(sla.topBreachingPolicies({ from: 0, to: 1, limit: 0 }),           /limit/);
}

async function _forecastImpact() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({
    slug: "std", priority: "standard", ship_within_hours: 24, deliver_within_hours: 48,
  });
  var now = Date.now();
  var orderBreached = bShop.framework.uuid.v7();  // placed 30h ago → ship_by 6h overdue
  var orderAtRisk   = bShop.framework.uuid.v7();  // placed 20h ago → 4h slack < 6 default
  var orderOnTrack  = bShop.framework.uuid.v7();  // placed 1h ago  → 23h slack
  var orderNoPolicy = bShop.framework.uuid.v7();  // overnight — no policy defined
  var snapshots = [
    { order_id: orderBreached, priority: "standard",  placed_at: now - 30 * 60 * 60 * 1000 },
    { order_id: orderAtRisk,   priority: "standard",  placed_at: now - 20 * 60 * 60 * 1000 },
    { order_id: orderOnTrack,  priority: "standard",  placed_at: now -      60 * 60 * 1000 },
    { order_id: orderNoPolicy, priority: "overnight", placed_at: now },
  ];
  var fc = await sla.forecastImpact({ open_orders: snapshots });
  check("already_breached count",        fc.already_breached_count === 1);
  check("at_risk count",                 fc.at_risk_count === 1);
  check("on_track count",                fc.on_track_count === 1);
  check("no_policy count",               fc.no_policy_count === 1);
  check("breached order id",             fc.already_breached[0].order_id === orderBreached);
  check("at_risk order id",              fc.at_risk[0].order_id === orderAtRisk);
  check("on_track order id",             fc.on_track[0].order_id === orderOnTrack);
  check("no_policy order id",            fc.no_policy[0].order_id === orderNoPolicy);
  check("breached slack negative",       fc.already_breached[0].slack_hours < 0);

  // Custom at_risk_hours threshold — 12h pulls the "on_track" 23h
  // slack still into on_track, but the "at_risk" 4h slack stays at_risk
  var fc2 = await sla.forecastImpact({ open_orders: snapshots, at_risk_hours: 12 });
  check("custom at_risk_hours echoed",   fc2.at_risk_hours === 12);

  // Refusals
  await assert.rejects(sla.forecastImpact(),                                                /input object required/);
  await assert.rejects(sla.forecastImpact({ open_orders: "not-array" }),                    /open_orders must be an array/);
  await assert.rejects(sla.forecastImpact({ open_orders: [null] }),                         /must be an object/);
  await assert.rejects(sla.forecastImpact({ open_orders: [], at_risk_hours: -1 }),          /at_risk_hours/);
  await assert.rejects(sla.forecastImpact({ open_orders: [{ order_id: "not-a-uuid", priority: "standard", placed_at: 0 }] }), /order_id/);
}

async function _listPoliciesAndArchiveFiltering() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({ slug: "p1", priority: "standard",  ship_within_hours: 24, deliver_within_hours: 48 });
  await sla.definePolicy({ slug: "p2", priority: "expedited", ship_within_hours: 8,  deliver_within_hours: 24 });
  await sla.definePolicy({ slug: "p3", priority: "overnight", ship_within_hours: 4,  deliver_within_hours: 12 });
  await sla.archivePolicy("p2");

  var active = await sla.listPolicies();
  check("listPolicies excludes archived",    active.length === 2);
  var slugs = active.map(function (r) { return r.slug; });
  check("listPolicies missing p2",           slugs.indexOf("p2") === -1);

  var all = await sla.listPolicies({ include_archived: true });
  check("listPolicies include_archived=3",   all.length === 3);
}

async function _multipleActivePoliciesMostRecentWins() {
  var q = _makeQuery();
  var sla = fulfillmentSLA.create({ query: q });
  await sla.definePolicy({ slug: "old", priority: "standard", ship_within_hours: 24, deliver_within_hours: 48 });
  // Advance the monotonic clock so the second policy's updated_at is strictly later
  await helpers.waitUntil(function (start) {
    return function () { return Date.now() > start; };
  }(Date.now()), { timeoutMs: 100, intervalMs: 1, label: "ms tick" });
  await sla.definePolicy({ slug: "new", priority: "standard", ship_within_hours: 12, deliver_within_hours: 24 });

  var ev = await sla.evaluateOrder({
    order_id: bShop.framework.uuid.v7(),
    order_snapshot: { priority: "standard", placed_at: Date.now() },
  });
  check("most-recent policy wins",      ev.policy_slug === "new");
  check("uses winning policy's hours",  ev.hours_to_ship === 12 && ev.hours_to_deliver === 24);
}

async function _factoryRefusals() {
  assert.throws(function () { fulfillmentSLA.create({ order: {} }); },                       /order must expose a get/);
  assert.throws(function () { fulfillmentSLA.create({ notifications: {} }); },               /notifications must expose an enqueue/);
}

async function run() {
  await _definePolicyAndUpsert();
  await _archivePolicyHides();
  await _evaluateOrderMath();
  await _evaluateOrderCutoff();
  await _evaluateOrderViaOrderHandle();
  await _recordBreachSeverity();
  await _currentBreachesAndForOrder();
  await _metricsForPolicy();
  await _topBreachingPolicies();
  await _forecastImpact();
  await _listPoliciesAndArchiveFiltering();
  await _multipleActivePoliciesMostRecentWins();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - fulfillment-sla (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - fulfillment-sla: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
