"use strict";
/**
 * orderEscalation — operator workflow for routing orders that need
 * manual attention. Rules detect conditions on an order snapshot and
 * auto-tag + notify an assigned operator.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0144_order_escalation.sql`. The primitive is required
 * directly (no `lib/index.js` edit gates this test).
 *
 * Coverage:
 *   - defineRule persists / hydrates conditions + auto_tags
 *   - defineRule refuses unknown condition keys + redefine + bad shapes
 *   - evaluateOrder matches per condition (total / country / prior /
 *                    fraud / refund / payment), aggregates auto_tags
 *   - evaluateOrder skips archived rules
 *   - recordEscalation persists row + invokes orderTags.applyTag for
 *                      every auto_tag + dispatches notification via the
 *                      injected stubs
 *   - resolveEscalation transitions open -> resolved + refuses re-resolve
 *   - markAsFalsePositive transitions open -> false_positive
 *   - openEscalations filters by operator + severity_min
 *   - escalationsForOrder + metricsForRule
 *   - updateRule + archiveRule + listRules
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop           = require("../../lib");
var orderEscalation = require("../../lib/order-escalation");
var helpers         = require("../helpers");
var check           = helpers.check;
var assert          = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0144_order_escalation.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- in-test stubs for the orderTags + notifications side-effects ------

function _makeOrderTagsStub() {
  var calls = [];
  return {
    applyTag: async function (orderId, tag) {
      calls.push({ order_id: orderId, tag: tag });
    },
    callsFor: function (orderId) {
      return calls.filter(function (c) { return c.order_id === orderId; });
    },
    all: function () { return calls.slice(); },
  };
}

function _makeNotificationsStub() {
  var calls = [];
  return {
    enqueue: async function (payload) { calls.push(payload); },
    all: function () { return calls.slice(); },
  };
}

// ---- defineRule + listRules + update + archive -------------------------

async function _defineRuleHappyAndRefusals() {
  var q  = _makeQuery();
  var oe = orderEscalation.create({ query: q });

  var op = _uuid();
  var rule = await oe.defineRule({
    slug:                  "high-value-new-customer",
    conditions:            { total_minor_min: 100000, prior_orders_max: 0 },
    severity:              "warning",
    assigned_operator:     op,
    auto_tags:             ["vip-review", "high-value"],
    notification_template: "escalation.high-value-new",
  });
  check("defineRule slug",                  rule.slug === "high-value-new-customer");
  check("defineRule total_minor_min",       rule.conditions.total_minor_min === 100000);
  check("defineRule prior_orders_max",      rule.conditions.prior_orders_max === 0);
  check("defineRule severity",              rule.severity === "warning");
  check("defineRule assigned_operator",     rule.assigned_operator === op);
  check("defineRule auto_tags length",      rule.auto_tags.length === 2);
  check("defineRule notification_template", rule.notification_template === "escalation.high-value-new");
  check("defineRule archived_at null",      rule.archived_at === null);
  check("defineRule created_at integer",    Number.isInteger(rule.created_at));
  check("defineRule created_at == updated_at", rule.created_at === rule.updated_at);

  // Refusals
  await assert.rejects(oe.defineRule(),                                       /input object required/);
  await assert.rejects(oe.defineRule({
    slug: "bad slug!", conditions: { total_minor_min: 1 }, severity: "info",
  }), /slug/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: {}, severity: "info",
  }), /at least one of/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { unknown_key: 1 }, severity: "info",
  }), /unknown key/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { total_minor_min: -1 }, severity: "info",
  }), /total_minor_min/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { fraud_score_min: 150 }, severity: "info",
  }), /fraud_score_min/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { country_in: ["usa"] }, severity: "info",
  }), /country_in/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { payment_method_kind_in: ["CARD!"] }, severity: "info",
  }), /payment_method_kind_in/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { total_minor_min: 1 }, severity: "panic",
  }), /severity/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { total_minor_min: 1 }, severity: "info",
    auto_tags: ["bad tag!"],
  }), /auto_tags/);
  await assert.rejects(oe.defineRule({
    slug: "r1", conditions: { total_minor_min: 1 }, severity: "info",
    notification_template: "bad template!",
  }), /notification_template/);

  // Redefine refused
  await assert.rejects(oe.defineRule({
    slug: "high-value-new-customer",
    conditions: { total_minor_min: 1 }, severity: "info",
  }), /already exists/);

  // listRules surfaces the one rule we authored
  var listed = await oe.listRules();
  check("listRules returns the one rule",   listed.length === 1);

  // updateRule mutates conditions + severity + template
  var upd = await oe.updateRule("high-value-new-customer", {
    severity:              "critical",
    conditions:            { total_minor_min: 200000, prior_orders_max: 1 },
    notification_template: "escalation.high-value-v2",
  });
  check("updateRule severity",              upd.severity === "critical");
  check("updateRule conditions",            upd.conditions.total_minor_min === 200000);
  check("updateRule template",              upd.notification_template === "escalation.high-value-v2");

  // updateRule refusals
  await assert.rejects(oe.updateRule("high-value-new-customer", {}),         /at least one column/);
  await assert.rejects(oe.updateRule("high-value-new-customer", { slug: "x" }), /unsupported column/);
  await assert.rejects(oe.updateRule("nonexistent", { severity: "info" }),    /not found/);

  // archiveRule + listRules omits archived by default
  var arch = await oe.archiveRule("high-value-new-customer");
  check("archiveRule sets archived_at",     arch.archived_at != null);

  var activeOnly = await oe.listRules();
  check("listRules omits archived by default", activeOnly.length === 0);
  var withArchived = await oe.listRules({ include_archived: true });
  check("listRules include_archived surfaces it", withArchived.length === 1);

  // archiveRule idempotent
  var archAgain = await oe.archiveRule("high-value-new-customer");
  check("archiveRule idempotent",           archAgain.archived_at != null);

  await assert.rejects(oe.archiveRule("nothing-here"), /not found/);
}

// ---- evaluateOrder per-condition matching -------------------------------

async function _evaluateOrderPerCondition() {
  var q  = _makeQuery();
  var oe = orderEscalation.create({ query: q });

  await oe.defineRule({
    slug: "high-value", conditions: { total_minor_min: 100000 },
    severity: "warning", auto_tags: ["high-value"],
  });
  await oe.defineRule({
    slug: "us-only", conditions: { country_in: ["US"] },
    severity: "info", auto_tags: ["us-flag"],
  });
  await oe.defineRule({
    slug: "first-order", conditions: { prior_orders_max: 0 },
    severity: "info", auto_tags: ["first-time"],
  });
  await oe.defineRule({
    slug: "fraud-watch", conditions: { fraud_score_min: 80 },
    severity: "critical", auto_tags: ["fraud-watch"],
  });
  await oe.defineRule({
    slug: "refund-open", conditions: { refund_pending: true },
    severity: "warning", auto_tags: ["refund-attention"],
  });
  await oe.defineRule({
    slug: "card-only", conditions: { payment_method_kind_in: ["card", "paypal"] },
    severity: "info", auto_tags: ["card-payment"],
  });
  // Composite rule for the "high-value-new-customer" scenario from the spec
  await oe.defineRule({
    slug: "high-value-new-customer",
    conditions: { total_minor_min: 100000, prior_orders_max: 0 },
    severity: "critical", auto_tags: ["high-value", "new-customer-review"],
  });

  var orderId = _uuid();

  // total_minor_min match
  var r1 = await oe.evaluateOrder({
    order_id: orderId,
    order_snapshot: {
      total_minor: 250000, country: "DE", prior_orders: 5, fraud_score: 10,
      refund_pending: false, payment_method_kind: "ach",
    },
  });
  var slugs1 = r1.matched_rules.map(function (r) { return r.slug; });
  check("evaluate matches high-value",            slugs1.indexOf("high-value") !== -1);
  check("evaluate does not match us-only (DE)",   slugs1.indexOf("us-only") === -1);
  check("evaluate does not match first-order",    slugs1.indexOf("first-order") === -1);
  check("evaluate does not match fraud-watch",    slugs1.indexOf("fraud-watch") === -1);
  check("evaluate does not match card-only (ach)", slugs1.indexOf("card-only") === -1);
  check("evaluate aggregates auto_tags",          r1.tags_applied.indexOf("high-value") !== -1);

  // composite rule needs BOTH total AND prior_orders_max
  var r2 = await oe.evaluateOrder({
    order_id: orderId,
    order_snapshot: {
      total_minor: 250000, country: "US", prior_orders: 0, fraud_score: 5,
      refund_pending: false, payment_method_kind: "card",
    },
  });
  var slugs2 = r2.matched_rules.map(function (r) { return r.slug; });
  check("composite rule fires when both conditions hold",
    slugs2.indexOf("high-value-new-customer") !== -1);
  check("us-only fires for US order",             slugs2.indexOf("us-only") !== -1);
  check("first-order fires for prior_orders=0",   slugs2.indexOf("first-order") !== -1);
  check("card-only fires for card payment",       slugs2.indexOf("card-only") !== -1);
  check("tags_applied deduplicates",
    r2.tags_applied.filter(function (t) { return t === "high-value"; }).length === 1);

  // fraud + refund match
  var r3 = await oe.evaluateOrder({
    order_id: orderId,
    order_snapshot: {
      total_minor: 5000, country: "CA", prior_orders: 10, fraud_score: 95,
      refund_pending: true, payment_method_kind: "card",
    },
  });
  var slugs3 = r3.matched_rules.map(function (r) { return r.slug; });
  check("fraud-watch fires at score=95",          slugs3.indexOf("fraud-watch") !== -1);
  check("refund-open fires when pending=true",    slugs3.indexOf("refund-open") !== -1);
  check("high-value does not fire (5000<100000)", slugs3.indexOf("high-value") === -1);
  check("first-order does not fire (10>0)",       slugs3.indexOf("first-order") === -1);

  // condition referring to missing snapshot dimension never matches
  var r4 = await oe.evaluateOrder({
    order_id: orderId,
    order_snapshot: { total_minor: 250000 },         // no country / prior / fraud / payment
  });
  var slugs4 = r4.matched_rules.map(function (r) { return r.slug; });
  check("missing snapshot dim -> condition skipped", slugs4.indexOf("us-only") === -1);
  check("only the total-only rule matches",          slugs4.indexOf("high-value") !== -1 && slugs4.length === 1);

  // archived rule is skipped by evaluateOrder
  await oe.archiveRule("high-value");
  var rAfter = await oe.evaluateOrder({
    order_id: orderId,
    order_snapshot: { total_minor: 999999 },
  });
  check("archived rule no longer fires",
    rAfter.matched_rules.every(function (r) { return r.slug !== "high-value"; }));

  // evaluateOrder refusals
  await assert.rejects(oe.evaluateOrder(),                                   /input object required/);
  await assert.rejects(oe.evaluateOrder({ order_id: "not-a-uuid", order_snapshot: {} }), /order_id/);
  await assert.rejects(oe.evaluateOrder({ order_id: orderId, order_snapshot: "x" }), /order_snapshot/);
  await assert.rejects(oe.evaluateOrder({
    order_id: orderId, order_snapshot: { total_minor: -1 },
  }), /total_minor/);
  await assert.rejects(oe.evaluateOrder({
    order_id: orderId, order_snapshot: { fraud_score: 200 },
  }), /fraud_score/);
  await assert.rejects(oe.evaluateOrder({
    order_id: orderId, order_snapshot: { country: "usa" },
  }), /country/);
}

// ---- recordEscalation + side-effect stubs ------------------------------

async function _recordEscalationFiresHooks() {
  var q             = _makeQuery();
  var orderTags     = _makeOrderTagsStub();
  var notifications = _makeNotificationsStub();
  var oe = orderEscalation.create({
    query:         q,
    orderTags:     orderTags,
    notifications: notifications,
  });

  var op = _uuid();
  await oe.defineRule({
    slug:                  "vip-review",
    conditions:            { total_minor_min: 100000 },
    severity:              "warning",
    assigned_operator:     op,
    auto_tags:             ["vip-review", "manual-check"],
    notification_template: "escalation.vip-review",
  });

  var orderId = _uuid();
  var result = await oe.recordEscalation({
    order_id:          orderId,
    rule_slug:         "vip-review",
    severity:          "warning",
    assigned_operator: op,
    notes:             "Total above $1000 with no prior history.",
  });
  check("recordEscalation returns escalation row",      result.escalation != null);
  check("recordEscalation status=open",                 result.escalation.status === "open");
  check("recordEscalation severity",                    result.escalation.severity === "warning");
  check("recordEscalation order_id round-trip",         result.escalation.order_id === orderId);
  check("recordEscalation rule_slug round-trip",        result.escalation.rule_slug === "vip-review");
  check("recordEscalation notes round-trip",            result.escalation.notes === "Total above $1000 with no prior history.");
  check("recordEscalation resolved_at null",            result.escalation.resolved_at === null);

  // orderTags.applyTag was invoked for each auto_tag, on the given order
  var tagCalls = orderTags.callsFor(orderId);
  check("orderTags.applyTag invoked per tag",           tagCalls.length === 2);
  check("orderTags.applyTag tags match",
    tagCalls.map(function (c) { return c.tag; }).sort().join(",") === "manual-check,vip-review");
  check("recordEscalation tags_applied surfaces tags",  result.tags_applied.length === 2);
  check("recordEscalation tags_failed empty",           result.tags_failed.length === 0);

  // notifications.enqueue invoked with the template + operator + payload
  var noteCalls = notifications.all();
  check("notifications.enqueue invoked once",           noteCalls.length === 1);
  check("notifications recipient",                      noteCalls[0].recipient_id === op);
  check("notifications template",                       noteCalls[0].template === "escalation.vip-review");
  check("notifications payload carries escalation id",  noteCalls[0].payload.escalation_id === result.escalation.id);
  check("notifications payload carries severity",       noteCalls[0].payload.severity === "warning");
  check("notifications event_type",                     noteCalls[0].event_type === "order_escalation");
  check("recordEscalation notified=true",               result.notified === true);

  // Missing rule refused
  await assert.rejects(oe.recordEscalation({
    order_id: orderId, rule_slug: "no-such-rule",
    severity: "info", notes: "x",
  }), /not found/);

  // Recording without an assigned operator is allowed; notification is skipped.
  await oe.defineRule({
    slug: "unassigned-rule", conditions: { total_minor_min: 1 },
    severity: "info", auto_tags: ["needs-triage"],
    notification_template: "escalation.unassigned",
  });
  var noteCallsBefore = notifications.all().length;
  var unassigned = await oe.recordEscalation({
    order_id: orderId, rule_slug: "unassigned-rule",
    severity: "info",
    notes: "auto-tagged by orchestrator",
  });
  check("recordEscalation w/o operator persists",       unassigned.escalation.status === "open");
  check("recordEscalation w/o operator skips notify",   notifications.all().length === noteCallsBefore);
  check("recordEscalation w/o operator notified=false", unassigned.notified === false);

  // Refusals
  await assert.rejects(oe.recordEscalation(),           /input object required/);
  await assert.rejects(oe.recordEscalation({
    order_id: "not-a-uuid", rule_slug: "vip-review", severity: "info", notes: "x",
  }), /order_id/);
  await assert.rejects(oe.recordEscalation({
    order_id: orderId, rule_slug: "vip-review", severity: "boom", notes: "x",
  }), /severity/);
}

// ---- resolveEscalation + markAsFalsePositive FSM -----------------------

async function _resolveFsm() {
  var q  = _makeQuery();
  var oe = orderEscalation.create({ query: q });

  await oe.defineRule({
    slug: "any", conditions: { total_minor_min: 1 }, severity: "info",
  });
  var orderId = _uuid();
  var rec1 = await oe.recordEscalation({
    order_id: orderId, rule_slug: "any", severity: "info", notes: "n",
  });

  // resolveEscalation: open -> resolved
  var resolved = await oe.resolveEscalation({
    escalation_id: rec1.escalation.id,
    resolution:    "Confirmed legitimate. Closing.",
  });
  check("resolve transitions to resolved",       resolved.status === "resolved");
  check("resolve stamps resolution",             resolved.resolution === "Confirmed legitimate. Closing.");
  check("resolve stamps resolved_at",            Number.isInteger(resolved.resolved_at) && resolved.resolved_at > 0);

  // Re-resolve refused (not in open state)
  await assert.rejects(oe.resolveEscalation({
    escalation_id: rec1.escalation.id, resolution: "again",
  }), /not in open state/);

  // markAsFalsePositive: open -> false_positive
  var rec2 = await oe.recordEscalation({
    order_id: orderId, rule_slug: "any", severity: "info", notes: "n",
  });
  var fp = await oe.markAsFalsePositive({
    escalation_id: rec2.escalation.id,
    reason:        "Rule fires too aggressively — operator manually clears.",
  });
  check("markAsFalsePositive transitions",       fp.status === "false_positive");
  check("markAsFalsePositive stamps reason",     fp.resolution === "Rule fires too aggressively — operator manually clears.");
  check("markAsFalsePositive stamps resolved_at", Number.isInteger(fp.resolved_at));

  // Cross-transition refused
  await assert.rejects(oe.resolveEscalation({
    escalation_id: rec2.escalation.id, resolution: "trying after fp",
  }), /not in open state/);
  await assert.rejects(oe.markAsFalsePositive({
    escalation_id: rec1.escalation.id, reason: "trying after resolve",
  }), /not in open state/);

  // Unknown id refused
  await assert.rejects(oe.resolveEscalation({
    escalation_id: _uuid(), resolution: "x",
  }), /not found/);
  await assert.rejects(oe.markAsFalsePositive({
    escalation_id: _uuid(), reason: "x",
  }), /not found/);

  // Missing resolution / reason refused
  await assert.rejects(oe.resolveEscalation({ escalation_id: rec1.escalation.id }), /resolution/);
  await assert.rejects(oe.markAsFalsePositive({ escalation_id: rec1.escalation.id }), /reason/);
}

// ---- openEscalations filters + escalationsForOrder + metricsForRule ----

async function _openFiltersAndMetrics() {
  var q  = _makeQuery();
  var oe = orderEscalation.create({ query: q });

  var opA = _uuid();
  var opB = _uuid();
  await oe.defineRule({
    slug: "info-rule", conditions: { total_minor_min: 1 }, severity: "info",
    assigned_operator: opA,
  });
  await oe.defineRule({
    slug: "warning-rule", conditions: { total_minor_min: 1 }, severity: "warning",
    assigned_operator: opA,
  });
  await oe.defineRule({
    slug: "critical-rule", conditions: { total_minor_min: 1 }, severity: "critical",
    assigned_operator: opB,
  });

  var order1 = _uuid();
  var order2 = _uuid();

  var info = await oe.recordEscalation({
    order_id: order1, rule_slug: "info-rule", severity: "info",
    assigned_operator: opA, notes: "info note",
  });
  var warn = await oe.recordEscalation({
    order_id: order1, rule_slug: "warning-rule", severity: "warning",
    assigned_operator: opA, notes: "warning note",
  });
  var crit = await oe.recordEscalation({
    order_id: order2, rule_slug: "critical-rule", severity: "critical",
    assigned_operator: opB, notes: "critical note",
  });

  // openEscalations no filter -> 3 rows
  var allOpen = await oe.openEscalations();
  check("openEscalations returns 3 open rows",       allOpen.length === 3);

  // Filter by operator
  var opAOpen = await oe.openEscalations({ operator_id: opA });
  check("openEscalations operator filter -> 2",      opAOpen.length === 2);
  check("openEscalations operator filter excludes opB",
    opAOpen.every(function (r) { return r.assigned_operator === opA; }));

  // Filter by severity_min = warning (warning + critical, not info)
  var warnPlus = await oe.openEscalations({ severity_min: "warning" });
  check("openEscalations severity_min=warning -> 2", warnPlus.length === 2);
  check("openEscalations severity_min excludes info",
    warnPlus.every(function (r) { return r.severity !== "info"; }));

  // severity_min=critical -> only critical
  var critOnly = await oe.openEscalations({ severity_min: "critical" });
  check("openEscalations severity_min=critical -> 1", critOnly.length === 1);
  check("openEscalations severity_min critical row",  critOnly[0].id === crit.escalation.id);

  // Combined filter: opA + warning_min -> just the warning row
  var combo = await oe.openEscalations({ operator_id: opA, severity_min: "warning" });
  check("openEscalations combined filter -> 1",       combo.length === 1);
  check("openEscalations combined filter id",         combo[0].id === warn.escalation.id);

  // Resolve one and confirm it drops from open
  await oe.resolveEscalation({
    escalation_id: info.escalation.id, resolution: "ack",
  });
  var afterResolve = await oe.openEscalations();
  check("openEscalations drops resolved row",         afterResolve.length === 2);

  // escalationsForOrder includes resolved + open
  var order1All = await oe.escalationsForOrder(order1);
  check("escalationsForOrder returns both rows for order1", order1All.length === 2);
  check("escalationsForOrder DESC order_by occurred_at",
    order1All[0].occurred_at >= order1All[1].occurred_at);

  var order2All = await oe.escalationsForOrder(order2);
  check("escalationsForOrder isolates by order",      order2All.length === 1);

  // metricsForRule covers the open + resolved counts
  var now = Date.now();
  var metricsInfo = await oe.metricsForRule({
    slug: "info-rule", from: 0, to: now + 60000,
  });
  check("metrics info-rule fired count",              metricsInfo.fired === 1);
  check("metrics info-rule resolved count",           metricsInfo.resolved === 1);
  check("metrics info-rule open count",               metricsInfo.open === 0);
  check("metrics info-rule false_positive 0",         metricsInfo.false_positive === 0);
  check("metrics info-rule false_positive_bps 0",     metricsInfo.false_positive_bps === 0);

  // Mark the critical one false_positive and recompute
  await oe.markAsFalsePositive({
    escalation_id: crit.escalation.id, reason: "spurious",
  });
  var metricsCrit = await oe.metricsForRule({
    slug: "critical-rule", from: 0, to: now + 60000,
  });
  check("metrics critical-rule fp count",             metricsCrit.false_positive === 1);
  check("metrics critical-rule fp_bps 10000",         metricsCrit.false_positive_bps === 10000);

  // Refusals
  await assert.rejects(oe.openEscalations({ operator_id: "not-a-uuid" }), /operator_id/);
  await assert.rejects(oe.openEscalations({ severity_min: "bogus" }),     /severity/);
  await assert.rejects(oe.escalationsForOrder("not-a-uuid"),              /order_id/);
  await assert.rejects(oe.metricsForRule(),                               /input object required/);
  await assert.rejects(oe.metricsForRule({ slug: "info-rule", from: -1, to: 100 }), /from/);
  await assert.rejects(oe.metricsForRule({ slug: "info-rule", from: 100, to: 50 }), /to/);
}

// ---- monotonic-clock guarantee on occurred_at --------------------------

async function _monotonicOccurredAt() {
  var q  = _makeQuery();
  var oe = orderEscalation.create({ query: q });

  await oe.defineRule({
    slug: "fast", conditions: { total_minor_min: 1 }, severity: "info",
  });
  var orderId = _uuid();

  // Mint a burst of escalations back-to-back; the monotonic _now()
  // guarantees every occurred_at is strictly increasing even when the
  // wall clock returns the same millisecond twice.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var r = await oe.recordEscalation({
      order_id: orderId, rule_slug: "fast", severity: "info", notes: "n" + i,
    });
    ids.push(r.escalation);
  }
  for (var k = 1; k < ids.length; k += 1) {
    check("occurred_at strictly increasing #" + k,
      ids[k].occurred_at > ids[k - 1].occurred_at);
  }
}

async function run() {
  await _defineRuleHappyAndRefusals();
  await _evaluateOrderPerCondition();
  await _recordEscalationFiresHooks();
  await _resolveFsm();
  await _openFiltersAndMetrics();
  await _monotonicOccurredAt();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - order-escalation (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - order-escalation: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
