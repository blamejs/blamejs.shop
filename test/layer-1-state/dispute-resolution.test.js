"use strict";
/**
 * disputeResolution — payment-processor chargeback / dispute lifecycle.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0173_dispute_resolution.sql. Direct require of
 * `lib/dispute-resolution.js` — the primitive isn't wired into
 * `lib/index.js` yet (entry-point edit is out of scope for this ship;
 * same posture as refundAutomation / dunning).
 *
 * Coverage:
 *   - recordDispute persists every column; refuses redefine + bad input
 *   - addEvidence appends to the evidence log, refuses bad kinds, and
 *     refuses evidence on terminal-status disputes
 *   - submitResponse FSM: open → submitted; refuses out-of-state
 *   - recordProcessorDecision branches: submitted→won / submitted→lost /
 *     submitted→escalated / open→accepted / open→lost; refuses invalid
 *     transitions
 *   - markWriteoff: lost → written_off; refuses non-lost
 *   - openDisputes filter sorts by due_by ASC + filters by processor /
 *     kind
 *   - metricsForProcessor: win rate + total lost minor computed
 *     correctly
 *   - getDispute / disputesForOrder / historyForDispute round-trips
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var disputeResolution = require("../../lib/dispute-resolution");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0173_dispute_resolution.sql");

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

function _setup() {
  var q  = _makeQuery();
  var dr = disputeResolution.create({ query: q });
  return { query: q, dr: dr };
}

// Helper: open a dispute with sensible defaults so each test isn't a
// wall of boilerplate.
function _baseDispute(overrides) {
  var d = {
    dispute_id:   "dp_test_1",
    order_id:     "order-1",
    processor:    "stripe",
    kind:         "chargeback",
    amount_minor: 4500,
    currency:     "USD",
    reason_code:  "fraudulent",
    due_by:       Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  if (overrides) {
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) d[k] = overrides[k];
    }
  }
  return d;
}

// ---- recordDispute -----------------------------------------------------

async function _recordDispute() {
  var ctx = _setup();
  var d = await ctx.dr.recordDispute(_baseDispute());

  check("recordDispute returns hydrated row",  typeof d === "object" && d != null);
  check("recordDispute dispute_id",            d.dispute_id === "dp_test_1");
  check("recordDispute order_id",              d.order_id === "order-1");
  check("recordDispute processor",             d.processor === "stripe");
  check("recordDispute kind",                  d.kind === "chargeback");
  check("recordDispute amount_minor",          d.amount_minor === 4500);
  check("recordDispute currency",              d.currency === "USD");
  check("recordDispute reason_code",           d.reason_code === "fraudulent");
  check("recordDispute initial status open",   d.status === "open");
  check("recordDispute outcome null",          d.outcome === null);
  check("recordDispute opened_at set",         typeof d.opened_at === "number" && d.opened_at > 0);
  check("recordDispute due_by set",            typeof d.due_by === "number" && d.due_by > 0);
  check("recordDispute submitted_at null",     d.submitted_at === null);
  check("recordDispute decided_at null",       d.decided_at === null);
  check("recordDispute updated_at set",        typeof d.updated_at === "number" && d.updated_at > 0);

  // getDispute round-trips.
  var got = await ctx.dr.getDispute("dp_test_1");
  check("getDispute matches recorded",         got.dispute_id === d.dispute_id && got.status === "open");

  // disputesForOrder.
  var perOrder = await ctx.dr.disputesForOrder("order-1");
  check("disputesForOrder length",             perOrder.length === 1);
  check("disputesForOrder dispute_id",         perOrder[0].dispute_id === "dp_test_1");

  // Refuse redefine.
  await assert.rejects(
    ctx.dr.recordDispute(_baseDispute()),
    /already exists/,
  );

  // Bad inputs.
  await assert.rejects(ctx.dr.recordDispute(), /input object required/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "bad dispute id" })), /dispute_id/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", order_id: "" })), /order_id/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", processor: "Stripe" })), /processor/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", kind: "weird" })), /kind/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", amount_minor: -1 })), /amount_minor/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", currency: "usd" })), /currency/);
  await assert.rejects(ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", reason_code: "bad code with space" })), /reason_code/);

  // due_by < opened_at refused.
  await assert.rejects(
    ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_test_2", opened_at: 1000, due_by: 500 })),
    /due_by/,
  );
}

// ---- addEvidence -------------------------------------------------------

async function _addEvidence() {
  var ctx = _setup();
  await ctx.dr.recordDispute(_baseDispute());

  var ev1 = await ctx.dr.addEvidence({
    dispute_id: "dp_test_1",
    kind:       "signed_proof_of_delivery",
    blob_ref:   "s3://evidence/order-1/pod.pdf",
    notes:      "FedEx tracking 1234, signature on file",
  });
  check("addEvidence id assigned",             typeof ev1.id === "string" && ev1.id.length > 0);
  check("addEvidence kind",                    ev1.kind === "signed_proof_of_delivery");
  check("addEvidence blob_ref",                ev1.blob_ref === "s3://evidence/order-1/pod.pdf");
  check("addEvidence notes preserved",         ev1.notes === "FedEx tracking 1234, signature on file");
  check("addEvidence recorded_at set",         typeof ev1.recorded_at === "number" && ev1.recorded_at > 0);

  // Second evidence row gets a strictly-greater timestamp.
  var ev2 = await ctx.dr.addEvidence({
    dispute_id: "dp_test_1",
    kind:       "customer_communication",
    blob_ref:   "s3://evidence/order-1/email-thread.eml",
  });
  check("addEvidence monotonic recorded_at",   ev2.recorded_at > ev1.recorded_at);
  check("addEvidence notes optional",          ev2.notes === null);

  // historyForDispute sees both, in order.
  var hist = await ctx.dr.historyForDispute("dp_test_1");
  check("historyForDispute evidence count",    hist.evidence.length === 2);
  check("historyForDispute evidence order",    hist.evidence[0].id === ev1.id && hist.evidence[1].id === ev2.id);
  check("historyForDispute dispute present",   hist.dispute.dispute_id === "dp_test_1");
  check("historyForDispute responses empty",   hist.responses.length === 0);

  // Bad evidence kind.
  await assert.rejects(ctx.dr.addEvidence({
    dispute_id: "dp_test_1", kind: "screenshot", blob_ref: "x",
  }), /evidence kind/);

  // Missing dispute.
  await assert.rejects(ctx.dr.addEvidence({
    dispute_id: "dp_missing", kind: "other", blob_ref: "x",
  }), /not found/);

  // Empty blob_ref.
  await assert.rejects(ctx.dr.addEvidence({
    dispute_id: "dp_test_1", kind: "other", blob_ref: "",
  }), /blob_ref/);

  // Evidence refused after terminal state. Drive to `won` via submit +
  // decision and confirm the next addEvidence is refused.
  await ctx.dr.submitResponse({
    dispute_id: "dp_test_1",
    narrative:  "Goods delivered to verified billing address; signature attached.",
  });
  // Evidence still accepted while submitted.
  var ev3 = await ctx.dr.addEvidence({
    dispute_id: "dp_test_1",
    kind:       "shipping_label",
    blob_ref:   "s3://evidence/order-1/label.pdf",
  });
  check("addEvidence accepted while submitted", ev3.id != null);

  await ctx.dr.recordProcessorDecision({ dispute_id: "dp_test_1", outcome: "won" });
  await assert.rejects(ctx.dr.addEvidence({
    dispute_id: "dp_test_1", kind: "other", blob_ref: "x",
  }), /terminal status/);
}

// ---- submitResponse FSM ------------------------------------------------

async function _submitResponseFsm() {
  var ctx = _setup();
  await ctx.dr.recordDispute(_baseDispute());

  var res = await ctx.dr.submitResponse({
    dispute_id: "dp_test_1",
    narrative:  "The cardholder placed this order from a verified IP " +
                "address matching the billing zip; signed delivery " +
                "proof is attached as exhibit A.",
  });
  check("submitResponse id assigned",          typeof res.id === "string" && res.id.length > 0);
  check("submitResponse narrative preserved",  res.narrative.indexOf("verified IP") !== -1);
  check("submitResponse submitted_at set",     typeof res.submitted_at === "number" && res.submitted_at > 0);

  // Dispute moved to submitted.
  var after = await ctx.dr.getDispute("dp_test_1");
  check("submitResponse status submitted",     after.status === "submitted");
  check("submitResponse submitted_at on row",  after.submitted_at === res.submitted_at);

  // historyForDispute sees the response.
  var hist = await ctx.dr.historyForDispute("dp_test_1");
  check("historyForDispute response count",    hist.responses.length === 1);
  check("historyForDispute response id",       hist.responses[0].id === res.id);

  // Second submit refused — already submitted.
  await assert.rejects(
    ctx.dr.submitResponse({
      dispute_id: "dp_test_1",
      narrative:  "supplemental evidence after first submission",
    }),
    /requires status=open/,
  );

  // Empty narrative refused.
  var ctx2 = _setup();
  await ctx2.dr.recordDispute(_baseDispute());
  await assert.rejects(
    ctx2.dr.submitResponse({ dispute_id: "dp_test_1", narrative: "" }),
    /narrative/,
  );

  // Missing dispute.
  await assert.rejects(
    ctx2.dr.submitResponse({ dispute_id: "dp_missing", narrative: "x" }),
    /not found/,
  );
}

// ---- recordProcessorDecision branches ----------------------------------

async function _recordProcessorDecisionBranches() {
  // Branch 1: submitted → won.
  var c1 = _setup();
  await c1.dr.recordDispute(_baseDispute({ dispute_id: "dp_won" }));
  await c1.dr.submitResponse({ dispute_id: "dp_won", narrative: "we have signed delivery proof" });
  var won = await c1.dr.recordProcessorDecision({ dispute_id: "dp_won", outcome: "won" });
  check("decision won status",                 won.status === "won");
  check("decision won outcome",                won.outcome === "won");
  check("decision won decided_at set",         typeof won.decided_at === "number" && won.decided_at > 0);

  // Branch 2: submitted → lost.
  var c2 = _setup();
  await c2.dr.recordDispute(_baseDispute({ dispute_id: "dp_lost" }));
  await c2.dr.submitResponse({ dispute_id: "dp_lost", narrative: "fighting it" });
  var lost = await c2.dr.recordProcessorDecision({ dispute_id: "dp_lost", outcome: "lost" });
  check("decision lost status",                lost.status === "lost");
  check("decision lost outcome",               lost.outcome === "lost");

  // Branch 3: submitted → escalated.
  var c3 = _setup();
  await c3.dr.recordDispute(_baseDispute({ dispute_id: "dp_esc" }));
  await c3.dr.submitResponse({ dispute_id: "dp_esc", narrative: "fighting it" });
  var esc = await c3.dr.recordProcessorDecision({ dispute_id: "dp_esc", outcome: "escalated" });
  check("decision escalated status",           esc.status === "escalated");
  check("decision escalated outcome",          esc.outcome === "escalated");

  // Branch 4: open → accepted (operator concedes without responding).
  var c4 = _setup();
  await c4.dr.recordDispute(_baseDispute({ dispute_id: "dp_acc" }));
  var acc = await c4.dr.recordProcessorDecision({ dispute_id: "dp_acc", outcome: "accepted" });
  check("decision accepted status",            acc.status === "accepted");
  check("decision accepted outcome",           acc.outcome === "accepted");

  // Branch 5: open → lost (deadline ran out without a response).
  var c5 = _setup();
  await c5.dr.recordDispute(_baseDispute({ dispute_id: "dp_oloss" }));
  var oloss = await c5.dr.recordProcessorDecision({ dispute_id: "dp_oloss", outcome: "lost" });
  check("decision open→lost status",           oloss.status === "lost");

  // Invalid transitions refused.
  // accepted requires status=open.
  var c6 = _setup();
  await c6.dr.recordDispute(_baseDispute({ dispute_id: "dp_bad" }));
  await c6.dr.submitResponse({ dispute_id: "dp_bad", narrative: "submitted" });
  await assert.rejects(
    c6.dr.recordProcessorDecision({ dispute_id: "dp_bad", outcome: "accepted" }),
    /requires status=open/,
  );

  // won requires status=submitted.
  var c7 = _setup();
  await c7.dr.recordDispute(_baseDispute({ dispute_id: "dp_bad2" }));
  await assert.rejects(
    c7.dr.recordProcessorDecision({ dispute_id: "dp_bad2", outcome: "won" }),
    /requires status=submitted/,
  );

  // Second decision on already-decided dispute refused.
  await assert.rejects(
    c1.dr.recordProcessorDecision({ dispute_id: "dp_won", outcome: "lost" }),
    /requires status/,
  );

  // Bad outcome.
  await assert.rejects(
    c1.dr.recordProcessorDecision({ dispute_id: "dp_won", outcome: "tied" }),
    /outcome/,
  );

  // Missing dispute.
  await assert.rejects(
    c1.dr.recordProcessorDecision({ dispute_id: "dp_missing", outcome: "won" }),
    /not found/,
  );

  // markWriteoff path: lost → written_off.
  var wo = await c2.dr.markWriteoff({
    dispute_id:  "dp_lost",
    operator_id: "op-finance-1",
    reason:      "uncollectable; closed in monthly ledger reconciliation",
  });
  check("markWriteoff status written_off",     wo.status === "written_off");
  check("markWriteoff at set",                 typeof wo.written_off_at === "number" && wo.written_off_at > 0);
  check("markWriteoff by",                     wo.written_off_by === "op-finance-1");
  check("markWriteoff reason",                 wo.written_off_reason.indexOf("uncollectable") === 0);

  // markWriteoff refused on non-lost.
  await assert.rejects(
    c1.dr.markWriteoff({ dispute_id: "dp_won", operator_id: "op-1", reason: "x" }),
    /requires status=lost/,
  );

  // Bad operator id.
  await assert.rejects(
    c2.dr.markWriteoff({ dispute_id: "dp_lost", operator_id: "bad op id", reason: "x" }),
    /operator_id/,
  );
}

// ---- openDisputes filter -----------------------------------------------

async function _openDisputesFilter() {
  var ctx = _setup();
  var now = Date.now();
  // Three disputes with staggered due dates.
  await ctx.dr.recordDispute(_baseDispute({
    dispute_id: "dp_a", order_id: "order-A", processor: "stripe",
    kind: "chargeback", due_by: now + 5 * 86400000,
  }));
  await ctx.dr.recordDispute(_baseDispute({
    dispute_id: "dp_b", order_id: "order-B", processor: "stripe",
    kind: "inquiry", due_by: now + 1 * 86400000,
  }));
  await ctx.dr.recordDispute(_baseDispute({
    dispute_id: "dp_c", order_id: "order-C", processor: "adyen",
    kind: "chargeback", due_by: now + 3 * 86400000,
  }));

  // No filter — soonest deadline first.
  var all = await ctx.dr.openDisputes();
  check("openDisputes returns three",          all.length === 3);
  check("openDisputes soonest first",          all[0].dispute_id === "dp_b");
  check("openDisputes second",                 all[1].dispute_id === "dp_c");
  check("openDisputes last",                   all[2].dispute_id === "dp_a");

  // Filter by processor.
  var stripeOnly = await ctx.dr.openDisputes({ processor: "stripe" });
  check("openDisputes processor filter",       stripeOnly.length === 2);
  check("openDisputes processor filter order", stripeOnly[0].dispute_id === "dp_b" && stripeOnly[1].dispute_id === "dp_a");

  // Filter by kind.
  var inquiries = await ctx.dr.openDisputes({ kind: "inquiry" });
  check("openDisputes kind filter",            inquiries.length === 1 && inquiries[0].dispute_id === "dp_b");

  // Combined filter.
  var stripeChargebacks = await ctx.dr.openDisputes({ processor: "stripe", kind: "chargeback" });
  check("openDisputes combined filter",        stripeChargebacks.length === 1 && stripeChargebacks[0].dispute_id === "dp_a");

  // A decided dispute drops out of the open list.
  await ctx.dr.recordProcessorDecision({ dispute_id: "dp_b", outcome: "accepted" });
  var afterAccept = await ctx.dr.openDisputes();
  check("openDisputes excludes decided",       afterAccept.length === 2);
  var ids = afterAccept.map(function (d) { return d.dispute_id; });
  check("openDisputes excludes dp_b",          ids.indexOf("dp_b") === -1);

  // Limit cap.
  await assert.rejects(ctx.dr.openDisputes({ limit: 0 }), /limit/);
  await assert.rejects(ctx.dr.openDisputes({ limit: 1000 }), /limit/);

  // Submitted disputes still surface (status in {open, submitted}).
  await ctx.dr.submitResponse({ dispute_id: "dp_a", narrative: "fighting it" });
  var stillOpen = await ctx.dr.openDisputes();
  check("openDisputes includes submitted",     stillOpen.length === 2);
}

// ---- metricsForProcessor win rate --------------------------------------

async function _metricsForProcessorWinRate() {
  var ctx = _setup();
  var now = Date.now();

  // Five disputes against stripe: 2 won, 1 lost, 1 accepted, 1 still open.
  // win_rate = 2/(2+1+1) = 0.5.
  var seed = [
    { id: "dp_m1", outcome: "won",      amount: 1000 },
    { id: "dp_m2", outcome: "won",      amount: 2000 },
    { id: "dp_m3", outcome: "lost",     amount: 1500 },
    { id: "dp_m4", outcome: "accepted", amount: 500  },
    { id: "dp_m5", outcome: null,       amount: 3000 },
  ];
  for (var i = 0; i < seed.length; i += 1) {
    var s = seed[i];
    await ctx.dr.recordDispute(_baseDispute({
      dispute_id: s.id, amount_minor: s.amount, processor: "stripe",
    }));
    if (s.outcome === "won") {
      await ctx.dr.submitResponse({ dispute_id: s.id, narrative: "evidence attached" });
      await ctx.dr.recordProcessorDecision({ dispute_id: s.id, outcome: "won" });
    } else if (s.outcome === "lost") {
      await ctx.dr.submitResponse({ dispute_id: s.id, narrative: "fighting it" });
      await ctx.dr.recordProcessorDecision({ dispute_id: s.id, outcome: "lost" });
    } else if (s.outcome === "accepted") {
      await ctx.dr.recordProcessorDecision({ dispute_id: s.id, outcome: "accepted" });
    }
    // null → leave open
  }

  // Add a different-processor dispute that should NOT count.
  await ctx.dr.recordDispute(_baseDispute({
    dispute_id: "dp_adyen_1", processor: "adyen", amount_minor: 9999,
  }));

  var m = await ctx.dr.metricsForProcessor({
    processor: "stripe",
    from:      0,
    to:        now + 86400000,
  });
  check("metrics processor",                   m.processor === "stripe");
  check("metrics total_count",                 m.total_count === 5);
  check("metrics won_count",                   m.won_count === 2);
  check("metrics lost_count",                  m.lost_count === 1);
  check("metrics accepted_count",              m.accepted_count === 1);
  check("metrics open_count",                  m.open_count === 1);
  check("metrics decided_count",               m.decided_count === 4);
  check("metrics win_rate 0.5",                Math.abs(m.win_rate - 0.5) < 1e-9);
  check("metrics total_disputed_minor",        m.total_disputed_minor === 1000 + 2000 + 1500 + 500 + 3000);
  // total_lost_minor counts lost + accepted (both lost money).
  check("metrics total_lost_minor",            m.total_lost_minor === 1500 + 500);

  // Empty window → win_rate null.
  var empty = await ctx.dr.metricsForProcessor({
    processor: "stripe", from: 0, to: 1,
  });
  check("metrics empty total_count",           empty.total_count === 0);
  check("metrics empty win_rate null",         empty.win_rate === null);
  check("metrics empty decided_count",         empty.decided_count === 0);

  // from > to refused.
  await assert.rejects(
    ctx.dr.metricsForProcessor({ processor: "stripe", from: 100, to: 50 }),
    /from must be <= to/,
  );

  // Bad processor.
  await assert.rejects(
    ctx.dr.metricsForProcessor({ processor: "Stripe", from: 0, to: 1 }),
    /processor/,
  );
}

// ---- getDispute / disputesForOrder / historyForDispute round-trips -----

async function _readsRoundTrip() {
  var ctx = _setup();
  await ctx.dr.recordDispute(_baseDispute({ dispute_id: "dp_r1", order_id: "order-R" }));
  await ctx.dr.recordDispute(_baseDispute({
    dispute_id: "dp_r2", order_id: "order-R", kind: "inquiry", reason_code: "duplicate",
  }));

  // getDispute on unknown returns null.
  var miss = await ctx.dr.getDispute("dp_missing");
  check("getDispute missing returns null",     miss === null);

  // disputesForOrder returns both, ordered by opened_at DESC (newer first).
  var perOrder = await ctx.dr.disputesForOrder("order-R");
  check("disputesForOrder length",             perOrder.length === 2);
  // The second dispute was opened after the first → it sits at index 0.
  check("disputesForOrder DESC order",         perOrder[0].dispute_id === "dp_r2" && perOrder[1].dispute_id === "dp_r1");

  // disputesForOrder for unknown order → empty.
  var none = await ctx.dr.disputesForOrder("order-MISSING");
  check("disputesForOrder unknown empty",      none.length === 0);

  // historyForDispute on missing → null.
  var hist = await ctx.dr.historyForDispute("dp_missing");
  check("historyForDispute missing null",      hist === null);

  // historyForDispute with response + evidence.
  await ctx.dr.addEvidence({
    dispute_id: "dp_r1", kind: "receipt", blob_ref: "s3://r1/receipt.pdf",
  });
  await ctx.dr.submitResponse({ dispute_id: "dp_r1", narrative: "evidence attached" });
  var full = await ctx.dr.historyForDispute("dp_r1");
  check("historyForDispute full evidence",     full.evidence.length === 1);
  check("historyForDispute full responses",    full.responses.length === 1);
  check("historyForDispute full dispute",      full.dispute.status === "submitted");
}

async function run() {
  await _recordDispute();
  await _addEvidence();
  await _submitResponseFsm();
  await _recordProcessorDecisionBranches();
  await _openDisputesFilter();
  await _metricsForProcessorWinRate();
  await _readsRoundTrip();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - dispute-resolution (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - dispute-resolution: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
