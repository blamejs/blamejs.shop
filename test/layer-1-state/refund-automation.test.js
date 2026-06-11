"use strict";
/**
 * refundAutomation — auto-refund eligibility + execution rules.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0143_refund_automation.sql. Stubbed `payment` + `customerRiskProfile`
 * handles let the gates verify composition without touching a
 * processor wire or a real risk store.
 *
 * Direct require of `lib/refund-automation.js` — the primitive isn't
 * wired into `lib/index.js` yet (entry-point edit is out of scope for
 * this ship; same posture as paymentRetries / dunning).
 *
 * Coverage:
 *   - defineAutoRule persists every column; refuses redefine
 *   - evaluateForRefundRequest happy path: small in-cap request matches
 *     and reports rule_matched
 *   - evaluateForRefundRequest amount cap: request_amount_minor over
 *     max_amount_minor falls through with amount_exceeds_rule_cap
 *   - requires_low_risk gate: customer reported as `high` → refused
 *     with customer_not_low_risk; missing handle → risk_profile_
 *     unavailable
 *   - max_refunds_per_customer_year cap: third request for a customer
 *     against a cap-of-2 rule falls through with
 *     customer_year_cap_exceeded
 *   - executeAutoRefund composes stub payment.refund + writes the
 *     auto_approved decision row
 *   - markManualOverride writes a fresh decision row, surfaces in
 *     listAudit-style query, requires a prior decision row
 *   - listRules / updateRule / archiveRule round-trips + cross-checks
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var refundAutomation = require("../../lib/refund-automation");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0143_refund_automation.sql");

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

// Stub payment handle — records every refund call so the gates can
// verify composition without depending on the actual payment-processor
// wire. Default result is `{ ok: true, refund_id: "re_stub" }`.
function _stubPayment(opts) {
  opts = opts || {};
  var nextResult = opts.defaultResult || { ok: true, refund_id: "re_stub_1" };
  var calls = [];
  return {
    calls: calls,
    setNextResult: function (r) { nextResult = r; },
    handle: {
      refund: async function (input) {
        calls.push({ method: "refund", input: input });
        return nextResult;
      },
    },
  };
}

// Stub customer risk handle. `bandFor(customer_id)` returns the
// operator-mapped band per the configured table; defaults to "low"
// when the customer isn't in the map (matches "no signal == low risk
// in the absence of evidence" — operators wanting the inverse author
// a defaultBand: "high" override at the riskProfile primitive layer).
function _stubRiskProfile(byCustomer) {
  byCustomer = byCustomer || {};
  return {
    handle: {
      bandFor: async function (customerId) {
        return Object.prototype.hasOwnProperty.call(byCustomer, customerId)
          ? byCustomer[customerId]
          : "low";
      },
    },
  };
}

// Stub PayPal handle — records every refund call (PayPal-shaped:
// `{ capture_id, amount_minor, currency }` + an idempotency key).
function _stubPaypal() {
  var calls = [];
  return {
    calls: calls,
    handle: {
      refund: async function (input, idem) {
        calls.push({ method: "refund", input: input, idem: idem });
        return { id: "PPREF-" + calls.length, status: "COMPLETED" };
      },
    },
  };
}

function _setup(stubOpts) {
  stubOpts = stubOpts || {};
  var q   = _makeQuery();
  var pay = _stubPayment(stubOpts.payment || {});
  var pp  = _stubPaypal();
  var risk = _stubRiskProfile(stubOpts.riskBands || {});
  var ra = refundAutomation.create({
    query:               q,
    payment:             pay.handle,
    paypal:              stubOpts.omitPaypal ? null : pp.handle,
    customerRiskProfile: stubOpts.omitRisk ? null : risk.handle,
  });
  return { query: q, ra: ra, payment: pay, paypal: pp, risk: risk };
}

// ---- defineAutoRule: happy path + refusals -----------------------------

async function _defineAutoRuleHappy() {
  var ctx = _setup();

  var rule = await ctx.ra.defineAutoRule({
    slug:                          "small-customer-requests",
    max_amount_minor:              5000,
    max_refunds_per_customer_year: 3,
    requires_low_risk:             true,
    eligible_reasons:              ["requested_by_customer"],
    currency_in_set:               ["USD"],
    priority:                      10,
  });
  check("defineAutoRule returns hydrated row",   typeof rule === "object" && rule != null);
  check("defineAutoRule slug",                   rule.slug === "small-customer-requests");
  check("defineAutoRule max_amount_minor",       rule.max_amount_minor === 5000);
  check("defineAutoRule cap",                    rule.max_refunds_per_customer_year === 3);
  check("defineAutoRule requires_low_risk",      rule.requires_low_risk === true);
  check("defineAutoRule eligible_reasons",       JSON.stringify(rule.eligible_reasons) === JSON.stringify(["requested_by_customer"]));
  check("defineAutoRule currency_in_set",        JSON.stringify(rule.currency_in_set) === JSON.stringify(["USD"]));
  check("defineAutoRule priority",               rule.priority === 10);
  check("defineAutoRule active default true",    rule.active === true);
  check("defineAutoRule archived_at null",       rule.archived_at === null);

  // Refuse redefine.
  await assert.rejects(
    ctx.ra.defineAutoRule({
      slug:                          "small-customer-requests",
      max_amount_minor:              1000,
      max_refunds_per_customer_year: 1,
      requires_low_risk:             false,
      eligible_reasons:              [],
      currency_in_set:               [],
    }),
    /already exists/,
  );

  // Bad slug / bad amount / bad cap / bad bool / bad reasons / bad currency.
  await assert.rejects(ctx.ra.defineAutoRule({
    slug: "BAD SLUG WITH SPACE",
    max_amount_minor: 100, max_refunds_per_customer_year: 1,
    requires_low_risk: false, eligible_reasons: [], currency_in_set: [],
  }), /slug must match/);
  await assert.rejects(ctx.ra.defineAutoRule({
    slug: "ok", max_amount_minor: 0,
    max_refunds_per_customer_year: 1,
    requires_low_risk: false, eligible_reasons: [], currency_in_set: [],
  }), /max_amount_minor/);
  await assert.rejects(ctx.ra.defineAutoRule({
    slug: "ok", max_amount_minor: 100,
    max_refunds_per_customer_year: 0,
    requires_low_risk: false, eligible_reasons: [], currency_in_set: [],
  }), /max_refunds_per_customer_year/);
  await assert.rejects(ctx.ra.defineAutoRule({
    slug: "ok", max_amount_minor: 100,
    max_refunds_per_customer_year: 1,
    requires_low_risk: "yes", eligible_reasons: [], currency_in_set: [],
  }), /requires_low_risk/);
  await assert.rejects(ctx.ra.defineAutoRule({
    slug: "ok", max_amount_minor: 100,
    max_refunds_per_customer_year: 1,
    requires_low_risk: false, eligible_reasons: ["bad\x00reason"], currency_in_set: [],
  }), /eligible_reasons/);
  await assert.rejects(ctx.ra.defineAutoRule({
    slug: "ok", max_amount_minor: 100,
    max_refunds_per_customer_year: 1,
    requires_low_risk: false, eligible_reasons: [], currency_in_set: ["usd"],
  }), /currency_in_set/);
}

// ---- evaluateForRefundRequest: happy path -------------------------------

async function _evaluateHappy() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "small-customer-requests",
    max_amount_minor:              5000,
    max_refunds_per_customer_year: 3,
    requires_low_risk:             false,
    eligible_reasons:              ["requested_by_customer"],
    currency_in_set:               ["USD"],
  });

  var v = await ctx.ra.evaluateForRefundRequest({
    order_id:             "order-1",
    customer_id:          "customer-1",
    request_amount_minor: 1500,
    reason:               "requested_by_customer",
    currency:             "USD",
  });
  check("evaluate eligible",                     v.eligible === true);
  check("evaluate applied_rule",                 v.applied_rule === "small-customer-requests");
  check("evaluate max_refund_minor",             v.max_refund_minor === 5000);
  check("evaluate requires_manual_review false", v.requires_manual_review === false);
  check("evaluate reasons rule_matched",         JSON.stringify(v.reasons) === JSON.stringify(["rule_matched"]));

  // No rules → manual_review with no_rule_matched.
  var ctx2 = _setup();
  var none = await ctx2.ra.evaluateForRefundRequest({
    order_id: "order-x", customer_id: "customer-x",
    request_amount_minor: 100, reason: "requested_by_customer",
  });
  check("evaluate no rules manual review",       none.eligible === false && none.requires_manual_review === true);
  check("evaluate no rules applied_rule null",   none.applied_rule === null);
  check("evaluate no rules reason no_rule_matched", none.reasons.indexOf("no_rule_matched") !== -1);
}

// ---- evaluateForRefundRequest: amount cap -------------------------------

async function _evaluateAmountCap() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "small-only",
    max_amount_minor:              1000,
    max_refunds_per_customer_year: 10,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });
  var v = await ctx.ra.evaluateForRefundRequest({
    order_id: "order-2", customer_id: "customer-2",
    request_amount_minor: 5000, reason: "requested_by_customer",
  });
  check("amount cap not eligible",               v.eligible === false);
  check("amount cap manual review",              v.requires_manual_review === true);
  check("amount cap reason",                     v.reasons.indexOf("amount_exceeds_rule_cap") !== -1);
  check("amount cap applied_rule still set",     v.applied_rule === "small-only");
}

// ---- evaluateForRefundRequest: requires_low_risk gate -------------------

async function _evaluateRequiresLowRisk() {
  var ctx = _setup({ riskBands: { "high-risk-customer": "high", "vip-customer": "low" } });
  await ctx.ra.defineAutoRule({
    slug:                          "low-risk-only",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 5,
    requires_low_risk:             true,
    eligible_reasons:              [],
    currency_in_set:               [],
  });

  // High-risk customer refused.
  var refused = await ctx.ra.evaluateForRefundRequest({
    order_id: "order-r1", customer_id: "high-risk-customer",
    request_amount_minor: 500, reason: "requested_by_customer",
  });
  check("high-risk refused",                     refused.eligible === false);
  check("high-risk reason",                      refused.reasons.indexOf("customer_not_low_risk") !== -1);

  // Low-risk customer accepted.
  var accepted = await ctx.ra.evaluateForRefundRequest({
    order_id: "order-r2", customer_id: "vip-customer",
    request_amount_minor: 500, reason: "requested_by_customer",
  });
  check("low-risk accepted",                     accepted.eligible === true);

  // Missing handle → risk_profile_unavailable.
  var ctx2 = _setup({ omitRisk: true });
  await ctx2.ra.defineAutoRule({
    slug:                          "low-risk-only",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 5,
    requires_low_risk:             true,
    eligible_reasons:              [],
    currency_in_set:               [],
  });
  var noHandle = await ctx2.ra.evaluateForRefundRequest({
    order_id: "order-r3", customer_id: "customer-r3",
    request_amount_minor: 500, reason: "requested_by_customer",
  });
  check("no risk handle refused",                noHandle.eligible === false);
  check("no risk handle reason",                 noHandle.reasons.indexOf("risk_profile_unavailable") !== -1);
}

// ---- evaluateForRefundRequest: per-customer annual cap ------------------

async function _evaluateCustomerYearCap() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "two-per-year",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 2,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });

  // First two requests execute and write auto_approved rows.
  var r1 = await ctx.ra.executeAutoRefund({
    order_id: "order-c1", customer_id: "customer-cap",
    amount_minor: 100, reason: "requested_by_customer",
  });
  check("first refund auto_approved",            r1.decision === "auto_approved");
  var r2 = await ctx.ra.executeAutoRefund({
    order_id: "order-c2", customer_id: "customer-cap",
    amount_minor: 100, reason: "requested_by_customer",
  });
  check("second refund auto_approved",           r2.decision === "auto_approved");

  // Third evaluation against the same customer hits the cap.
  var v3 = await ctx.ra.evaluateForRefundRequest({
    order_id: "order-c3", customer_id: "customer-cap",
    request_amount_minor: 100, reason: "requested_by_customer",
  });
  check("third evaluation refused",              v3.eligible === false);
  check("third reason customer_year_cap",        v3.reasons.indexOf("customer_year_cap_exceeded") !== -1);

  // executeAutoRefund refuses the over-cap request.
  await assert.rejects(
    ctx.ra.executeAutoRefund({
      order_id: "order-c4", customer_id: "customer-cap",
      amount_minor: 100, reason: "requested_by_customer",
    }),
    /customer_year_cap_exceeded/,
  );

  // A different customer is unaffected by the cap.
  var v4 = await ctx.ra.evaluateForRefundRequest({
    order_id: "order-c5", customer_id: "different-customer",
    request_amount_minor: 100, reason: "requested_by_customer",
  });
  check("different customer unaffected",         v4.eligible === true);
}

// ---- executeAutoRefund composes payment.refund --------------------------

async function _executeAutoRefundComposesPayment() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "default",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 5,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });
  var res = await ctx.ra.executeAutoRefund({
    order_id:       "order-exec-1",
    customer_id:    "customer-exec-1",
    amount_minor:   2500,
    reason:         "requested_by_customer",
    payment_intent: "pi_test_abc",
  });
  check("execute returns auto_approved",         res.decision === "auto_approved");
  check("execute amount preserved",              res.amount_minor === 2500);
  check("execute applied_rule",                  res.applied_rule === "default");
  check("execute monotonic decided_at",          typeof res.decided_at === "number" && res.decided_at > 0);
  check("execute payment_result captured",       res.payment_result != null);

  check("payment.refund called once",            ctx.payment.calls.length === 1);
  check("payment.refund payment_intent",         ctx.payment.calls[0].input.payment_intent === "pi_test_abc");
  check("payment.refund amount_minor",           ctx.payment.calls[0].input.amount_minor === 2500);
  check("payment.refund reason",                 ctx.payment.calls[0].input.reason === "requested_by_customer");
  check("payment.refund metadata applied_rule",  ctx.payment.calls[0].input.metadata.applied_rule === "default");

  // executeAutoRefund refuses a request that doesn't pass eligibility.
  await ctx.ra.archiveRule("default");
  await assert.rejects(
    ctx.ra.executeAutoRefund({
      order_id: "order-exec-2", customer_id: "customer-exec-2",
      amount_minor: 100, reason: "requested_by_customer",
    }),
    /did not pass auto-eligibility/,
  );

  // Bad input refusals.
  await assert.rejects(ctx.ra.executeAutoRefund(), /input object required/);
  await assert.rejects(ctx.ra.executeAutoRefund({
    order_id: "", customer_id: "c", amount_minor: 1, reason: "requested_by_customer",
  }), /order_id/);
  await assert.rejects(ctx.ra.executeAutoRefund({
    order_id: "o", customer_id: "c", amount_minor: -1, reason: "requested_by_customer",
  }), /amount_minor/);
}

// ---- executeAutoRefund routes PayPal-captured orders to the PayPal handle

async function _executeAutoRefundPaypalRouting() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "default",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 5,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });
  var res = await ctx.ra.executeAutoRefund({
    order_id:          "order-pp-1",
    customer_id:       "customer-pp-1",
    amount_minor:      2500,
    reason:            "requested_by_customer",
    provider:          "paypal",
    paypal_capture_id: "CAP-AUTO-1",
    currency:          "USD",
  });
  check("paypal execute auto_approved",          res.decision === "auto_approved");
  check("paypal handle called once",             ctx.paypal.calls.length === 1);
  check("stripe handle NOT called",              ctx.payment.calls.length === 0);
  check("paypal refund maps the capture id",     ctx.paypal.calls[0].input.capture_id === "CAP-AUTO-1");
  check("paypal refund maps amount + currency",
    ctx.paypal.calls[0].input.amount_minor === 2500 && ctx.paypal.calls[0].input.currency === "USD");
  check("paypal refund carries a per-decision idempotency key",
    typeof ctx.paypal.calls[0].idem === "string" && ctx.paypal.calls[0].idem.indexOf("auto-refund:") === 0);

  // Validation: a PayPal request must name the capture + currency.
  await assert.rejects(ctx.ra.executeAutoRefund({
    order_id: "order-pp-2", customer_id: "customer-pp-2",
    amount_minor: 100, reason: "requested_by_customer", provider: "paypal", currency: "USD",
  }), /paypal_capture_id/);
  await assert.rejects(ctx.ra.executeAutoRefund({
    order_id: "order-pp-3", customer_id: "customer-pp-3",
    amount_minor: 100, reason: "requested_by_customer", provider: "paypal", paypal_capture_id: "CAP-X",
  }), /currency/);
  await assert.rejects(ctx.ra.executeAutoRefund({
    order_id: "order-pp-4", customer_id: "customer-pp-4",
    amount_minor: 100, reason: "requested_by_customer", provider: "venmo",
  }), /provider/);

  // No PayPal handle wired: a PayPal request is REFUSED — never routed
  // through the Stripe handle with PayPal identifiers.
  var bare = _setup({ omitPaypal: true });
  await bare.ra.defineAutoRule({
    slug:                          "default",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 5,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });
  await assert.rejects(bare.ra.executeAutoRefund({
    order_id: "order-pp-5", customer_id: "customer-pp-5",
    amount_minor: 100, reason: "requested_by_customer",
    provider: "paypal", paypal_capture_id: "CAP-Y", currency: "USD",
  }), /no paypal handle is wired/);
  check("refusal never dialed the stripe handle", bare.payment.calls.length === 0);
}

// ---- markManualOverride -------------------------------------------------

async function _markManualOverride() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "small-only",
    max_amount_minor:              1000,
    max_refunds_per_customer_year: 1,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });

  // Refuses without a prior decision row.
  await assert.rejects(
    ctx.ra.markManualOverride({
      order_id: "missing-order", decision: "auto_approved",
      operator_id: "op-1", reason: "approved manually",
    }),
    /no prior decision row/,
  );

  // Falls through to manual_review (amount over cap). The evaluate
  // call itself doesn't audit — the operator's downstream
  // markManualOverride is what records the human verdict. To make a
  // prior row exist for the manual-override path we run an
  // auto_approved refund first against the small-only cap.
  var rec = await ctx.ra.executeAutoRefund({
    order_id: "order-mo-1", customer_id: "customer-mo-1",
    amount_minor: 500, reason: "requested_by_customer",
  });
  check("setup auto_approved exists",            rec.decision === "auto_approved");

  // Operator overrides — approves manually.
  var ov = await ctx.ra.markManualOverride({
    order_id:    "order-mo-1",
    decision:    "auto_approved",
    operator_id: "op-42",
    reason:      "approved after CSR review",
  });
  check("override id assigned",                  typeof ov.id === "string" && ov.id.length > 0);
  check("override decision",                     ov.decision === "auto_approved");
  check("override applied_rule null",            ov.applied_rule === null);
  check("override carries operator and reason",  ov.reason.indexOf("op-42") === 0);
  check("override customer_id pulled forward",   ov.customer_id === "customer-mo-1");

  // Decline path.
  var rec2 = await ctx.ra.executeAutoRefund({
    order_id: "order-mo-2", customer_id: "customer-mo-2",
    amount_minor: 500, reason: "requested_by_customer",
  });
  check("setup auto_approved 2 exists",          rec2.decision === "auto_approved");
  var dec = await ctx.ra.markManualOverride({
    order_id:    "order-mo-2",
    decision:    "declined",
    operator_id: "op-99",
    reason:      "fraud signal",
  });
  check("decline override",                      dec.decision === "declined");

  // Bad decision.
  await assert.rejects(
    ctx.ra.markManualOverride({
      order_id: "order-mo-1", decision: "approved",
      operator_id: "op-42", reason: "x",
    }),
    /decision/,
  );

  // Bad operator id.
  await assert.rejects(
    ctx.ra.markManualOverride({
      order_id: "order-mo-1", decision: "auto_approved",
      operator_id: "bad op id", reason: "x",
    }),
    /operator_id/,
  );
}

// ---- listRules / updateRule / archiveRule -------------------------------

async function _listUpdateArchive() {
  var ctx = _setup();
  await ctx.ra.defineAutoRule({
    slug:                          "rule-a",
    max_amount_minor:              1000,
    max_refunds_per_customer_year: 1,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
    priority:                      1,
  });
  await ctx.ra.defineAutoRule({
    slug:                          "rule-b",
    max_amount_minor:              2000,
    max_refunds_per_customer_year: 2,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
    priority:                      5,
  });

  var rules = await ctx.ra.listRules({ active_only: true });
  check("listRules two rows",                    rules.length === 2);
  check("listRules priority DESC first",         rules[0].slug === "rule-b");

  // Update rule-a max_amount_minor and priority.
  var updated = await ctx.ra.updateRule("rule-a", { max_amount_minor: 9999, priority: 10 });
  check("updateRule max_amount_minor",           updated.max_amount_minor === 9999);
  check("updateRule priority",                   updated.priority === 10);

  // updateRule refuses unknown column / unknown slug.
  await assert.rejects(ctx.ra.updateRule("rule-a", { bogus: 1 }), /unsupported column/);
  await assert.rejects(ctx.ra.updateRule("does-not-exist", { priority: 1 }), /not found/);

  // Archive + idempotent re-archive.
  var arch = await ctx.ra.archiveRule("rule-b");
  check("archiveRule archived_at set",           arch.archived_at != null);
  check("archiveRule active 0",                  arch.active === false);
  var arch2 = await ctx.ra.archiveRule("rule-b");
  check("archiveRule idempotent",                arch2.archived_at != null);

  // Archived rule no longer in active_only list.
  var live = await ctx.ra.listRules({ active_only: true });
  check("listRules active_only excludes archived", live.length === 1 && live[0].slug === "rule-a");

  // archiveRule on unknown slug refuses.
  await assert.rejects(ctx.ra.archiveRule("nope"), /not found/);

  // metricsForRule rollup.
  var ctx2 = _setup();
  await ctx2.ra.defineAutoRule({
    slug:                          "metrics-rule",
    max_amount_minor:              10000,
    max_refunds_per_customer_year: 10,
    requires_low_risk:             false,
    eligible_reasons:              [],
    currency_in_set:               [],
  });
  await ctx2.ra.executeAutoRefund({
    order_id: "order-m1", customer_id: "customer-m1",
    amount_minor: 1000, reason: "requested_by_customer",
  });
  await ctx2.ra.executeAutoRefund({
    order_id: "order-m2", customer_id: "customer-m2",
    amount_minor: 2500, reason: "requested_by_customer",
  });
  var m = await ctx2.ra.metricsForRule({
    slug: "metrics-rule",
    from: 0,
    to:   Date.now() + 60000,
  });
  check("metricsForRule auto_approved_count",    m.auto_approved_count === 2);
  check("metricsForRule total_refunded_minor",   m.total_refunded_minor === 3500);
  check("metricsForRule manual_review_count",    m.manual_review_count === 0);

  // metricsForRule refusals.
  await assert.rejects(ctx2.ra.metricsForRule({
    slug: "metrics-rule", from: 100, to: 50,
  }), /from must be <= to/);
}

async function run() {
  await _defineAutoRuleHappy();
  await _evaluateHappy();
  await _evaluateAmountCap();
  await _evaluateRequiresLowRisk();
  await _evaluateCustomerYearCap();
  await _executeAutoRefundComposesPayment();
  await _executeAutoRefundPaypalRouting();
  await _markManualOverride();
  await _listUpdateArchive();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - refund-automation (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - refund-automation: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
