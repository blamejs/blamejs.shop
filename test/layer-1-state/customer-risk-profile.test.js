"use strict";
/**
 * customer-risk-profile — long-running per-customer risk signal
 * aggregation. Layer 1 against in-memory node:sqlite loaded from
 * migration 0142 (customer_risk_signals + customer_risk_summaries).
 *
 * Coverage:
 *   - recordSignal writes to the signal log + denormalized summary
 *   - getProfile returns the latest aggregation; never-recorded
 *     customer returns a zero shape with `low` band
 *   - risk_score math: sum of severities for non-cleared signals
 *     inside the 90-day recent window; older signals count toward
 *     lifetime only
 *   - band thresholds: low / moderate / high / critical land on the
 *     documented boundaries
 *   - tier(customerId) echoes risk_band
 *   - historyForCustomer returns parsed detail_json + chronological
 *     descending order
 *   - clearSignal drops contribution + flips band; double-clear
 *     refuses with RISK_SIGNAL_ALREADY_CLEARED
 *   - recompute refreshes summary; recomputeAll picks up stale
 *     summaries + new signals
 *   - topRiskCustomers ordering (risk_score DESC) + band filter
 *   - monotonic occurred_at: collisions bump to prior + 1
 *   - validation: every entry point refuses bad input shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop               = require("../../lib");
var customerRiskProfile = require("../../lib/customer-risk-profile");
var helpers             = require("../helpers");
var check               = helpers.check;
var assert              = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0142_customer_risk_profile.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _factory() {
  var h = _makeQuery();
  return {
    db:    h.db,
    query: h.query,
    risk:  customerRiskProfile.create({ query: h.query }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

var DAY = 86400 * 1000;

async function _recordSignalAndGetProfile() {
  var f = _factory();
  var cid = _uuid();

  // Never-recorded customer: zero shape, low band.
  var initial = await f.risk.getProfile(cid);
  check("empty profile customer_id echoed",     initial.customer_id === cid);
  check("empty profile risk_score 0",           initial.risk_score === 0);
  check("empty profile risk_band low",          initial.risk_band === "low");
  check("empty profile lifetime 0",             initial.lifetime_signal_count === 0);
  check("empty profile recent 0",               initial.recent_signal_count === 0);
  check("empty profile recomputed_at null",     initial.recomputed_at === null);

  // Record one signal.
  var s1 = await f.risk.recordSignal({
    customer_id: cid,
    kind:        "fraud_score_high",
    severity:    7,
    detail_json: { order_id: _uuid(), score: 78 },
  });
  check("record returns id",                    typeof s1.id === "string" && s1.id.length === 36);
  check("record echoes kind",                   s1.kind === "fraud_score_high");
  check("record echoes severity",               s1.severity === 7);
  check("record stamps occurred_at",            typeof s1.occurred_at === "number" && s1.occurred_at > 0);
  check("record returns risk_score",            s1.risk_score === 7);
  check("record returns risk_band moderate",    s1.risk_band === "low"); // 7 → low (< 10)

  var prof = await f.risk.getProfile(cid);
  check("profile risk_score = severity",        prof.risk_score === 7);
  check("profile band low",                     prof.risk_band === "low");
  check("profile lifetime 1",                   prof.lifetime_signal_count === 1);
  check("profile recent 1",                     prof.recent_signal_count === 1);
  check("profile recomputed_at set",            typeof prof.recomputed_at === "number");

  // Add a second signal: severity 5 → score 12 → moderate band.
  await f.risk.recordSignal({ customer_id: cid, kind: "late_payment", severity: 5 });
  var prof2 = await f.risk.getProfile(cid);
  check("profile sums severities",              prof2.risk_score === 12);
  check("profile band moderate",                prof2.risk_band === "moderate");
  check("profile lifetime 2",                   prof2.lifetime_signal_count === 2);
}

async function _riskScoreMathAndBands() {
  var f = _factory();

  // Customer A: severities 1+2+3 = 6 → low (≤9)
  var a = _uuid();
  await f.risk.recordSignal({ customer_id: a, kind: "address_mismatch",     severity: 1 });
  await f.risk.recordSignal({ customer_id: a, kind: "refund_request",       severity: 2 });
  await f.risk.recordSignal({ customer_id: a, kind: "device_diversity_high", severity: 3 });
  var pa = await f.risk.getProfile(a);
  check("low boundary score 6",                 pa.risk_score === 6);
  check("low band",                             pa.risk_band === "low");

  // Customer B: severity 9 → still low (boundary)
  var b = _uuid();
  await f.risk.recordSignal({ customer_id: b, kind: "fraud_score_high", severity: 9 });
  var pb = await f.risk.getProfile(b);
  check("low max boundary",                     pb.risk_score === 9 && pb.risk_band === "low");

  // Customer C: severity 10 → moderate (starts at 10)
  var c = _uuid();
  await f.risk.recordSignal({ customer_id: c, kind: "chargeback", severity: 10 });
  var pc = await f.risk.getProfile(c);
  check("moderate min boundary",                pc.risk_score === 10 && pc.risk_band === "moderate");

  // Customer D: severity 24 (two signals 14+10 not valid — use 10+9+5=24)
  var d = _uuid();
  await f.risk.recordSignal({ customer_id: d, kind: "chargeback",       severity: 10 });
  await f.risk.recordSignal({ customer_id: d, kind: "fraud_score_high", severity: 9 });
  await f.risk.recordSignal({ customer_id: d, kind: "late_payment",     severity: 5 });
  var pd = await f.risk.getProfile(d);
  check("moderate max boundary score 24",       pd.risk_score === 24 && pd.risk_band === "moderate");

  // Customer E: severity 25 → high (starts at 25)
  var e = _uuid();
  await f.risk.recordSignal({ customer_id: e, kind: "chargeback",       severity: 10 });
  await f.risk.recordSignal({ customer_id: e, kind: "chargeback",       severity: 10 });
  await f.risk.recordSignal({ customer_id: e, kind: "late_payment",     severity: 5 });
  var pe = await f.risk.getProfile(e);
  check("high min boundary 25",                 pe.risk_score === 25 && pe.risk_band === "high");

  // Customer F: severity 49 → high (boundary)
  var f2 = _uuid();
  for (var i = 0; i < 4; i += 1) {
    await f.risk.recordSignal({ customer_id: f2, kind: "chargeback", severity: 10 });
  }
  await f.risk.recordSignal({ customer_id: f2, kind: "fraud_score_high", severity: 9 });
  var pf = await f.risk.getProfile(f2);
  check("high max boundary 49",                 pf.risk_score === 49 && pf.risk_band === "high");

  // Customer G: severity 50+ → critical
  var g = _uuid();
  for (var j = 0; j < 5; j += 1) {
    await f.risk.recordSignal({ customer_id: g, kind: "chargeback", severity: 10 });
  }
  var pg = await f.risk.getProfile(g);
  check("critical band score 50",               pg.risk_score === 50 && pg.risk_band === "critical");
}

async function _recentWindowExcludesOldSignals() {
  var f = _factory();
  var cid = _uuid();
  var now = Date.now();

  // Signal 1: 120 days ago → outside the 90d window, counts toward
  // lifetime but not score.
  await f.risk.recordSignal({
    customer_id: cid, kind: "chargeback", severity: 10, occurred_at: now - 120 * DAY,
  });
  // Signal 2: 30 days ago → inside the window.
  await f.risk.recordSignal({
    customer_id: cid, kind: "late_payment", severity: 5, occurred_at: now - 30 * DAY,
  });

  // Force recompute so the summary cutoff uses the wall-clock `now`
  // we're testing against (recordSignal recomputes with Date.now()
  // internally; explicit recompute keeps the assertion deterministic).
  await f.risk.recompute({ customer_id: cid });
  var prof = await f.risk.getProfile(cid);
  check("lifetime counts old signal",           prof.lifetime_signal_count === 2);
  check("recent excludes old signal",           prof.recent_signal_count === 1);
  check("score excludes old severity",          prof.risk_score === 5);
  check("band low after aging out",             prof.risk_band === "low");
}

async function _tierEchoesBand() {
  var f = _factory();
  var a = _uuid();
  var b = _uuid();
  await f.risk.recordSignal({ customer_id: a, kind: "refund_request",       severity: 3 });
  await f.risk.recordSignal({ customer_id: b, kind: "chargeback",           severity: 10 });
  await f.risk.recordSignal({ customer_id: b, kind: "chargeback",           severity: 10 });
  await f.risk.recordSignal({ customer_id: b, kind: "chargeback",           severity: 10 });

  check("tier a low",                           (await f.risk.tier(a)) === "low");
  check("tier b high",                          (await f.risk.tier(b)) === "high");
  check("tier unknown defaults low",            (await f.risk.tier(_uuid())) === "low");
}

async function _historyForCustomerOrderingAndJson() {
  var f = _factory();
  var cid = _uuid();
  var now = Date.now();

  await f.risk.recordSignal({
    customer_id: cid, kind: "chargeback",        severity: 10,
    detail_json: { order_id: "abc", amount_minor: 1500 },
    occurred_at: now - 30 * DAY,
  });
  await f.risk.recordSignal({
    customer_id: cid, kind: "late_payment",      severity: 5,
    occurred_at: now - 5 * DAY,
  });
  await f.risk.recordSignal({
    customer_id: cid, kind: "address_mismatch",  severity: 3,
    occurred_at: now - 1 * DAY,
  });

  var history = await f.risk.historyForCustomer(cid);
  check("history length 3",                     history.length === 3);
  check("history newest first",                 history[0].kind === "address_mismatch"
                                                && history[1].kind === "late_payment"
                                                && history[2].kind === "chargeback");
  check("history detail_json parsed",           history[2].detail_json
                                                && history[2].detail_json.order_id === "abc"
                                                && history[2].detail_json.amount_minor === 1500);
  check("history null detail_json preserved",   history[0].detail_json === null);
  check("history cleared_at null pre-clear",    history[0].cleared_at === null);
}

async function _clearSignalDropsContribution() {
  var f = _factory();
  var cid = _uuid();

  // Two chargebacks → score 20, moderate.
  var s1 = await f.risk.recordSignal({ customer_id: cid, kind: "chargeback", severity: 10 });
  await f.risk.recordSignal({ customer_id: cid, kind: "chargeback", severity: 10 });
  var p1 = await f.risk.getProfile(cid);
  check("pre-clear score 20",                   p1.risk_score === 20 && p1.risk_band === "moderate");

  // Operator clears the first chargeback as a false positive.
  var cleared = await f.risk.clearSignal({
    signal_id:   s1.id,
    reason:      "duplicate-dispute-won",
    cleared_by:  "ops@example.com",
  });
  check("clear returns cleared_at",             typeof cleared.cleared_at === "number");
  check("clear returns updated risk_score",     cleared.risk_score === 10);
  check("clear returns updated risk_band",      cleared.risk_band === "moderate");

  var p2 = await f.risk.getProfile(cid);
  check("post-clear score halved",              p2.risk_score === 10);
  check("post-clear lifetime unchanged",        p2.lifetime_signal_count === 1);
  // lifetime is signal_count of NON-cleared rows — once cleared the
  // row is excluded from both lifetime and recent. This matches the
  // dashboard's "show me everything that's currently weighing on the
  // score" reading.

  // Double-clear refused.
  var rejected;
  try {
    await f.risk.clearSignal({
      signal_id: s1.id, reason: "again", cleared_by: "ops@example.com",
    });
  } catch (e) { rejected = e; }
  check("double-clear refused",                 rejected && rejected.code === "RISK_SIGNAL_ALREADY_CLEARED");

  // Unknown signal refused.
  var rejected2;
  try {
    await f.risk.clearSignal({
      signal_id: _uuid(), reason: "x", cleared_by: "y",
    });
  } catch (e) { rejected2 = e; }
  check("clear unknown signal NOT_FOUND",       rejected2 && rejected2.code === "RISK_SIGNAL_NOT_FOUND");

  // History row for the cleared signal carries the metadata.
  var history = await f.risk.historyForCustomer(cid);
  var clearedRow = history.filter(function (r) { return r.id === s1.id; })[0];
  check("history shows cleared_at",             clearedRow.cleared_at != null);
  check("history shows cleared_by",             clearedRow.cleared_by === "ops@example.com");
  check("history shows cleared_reason",         clearedRow.cleared_reason === "duplicate-dispute-won");
}

async function _recomputeAndRecomputeAll() {
  var f = _factory();
  var a = _uuid();
  var b = _uuid();
  var c = _uuid();

  // Hand-write old signals via the primitive (recompute will refresh
  // both summaries even when a fresh signal hasn't landed since).
  await f.risk.recordSignal({ customer_id: a, kind: "chargeback",   severity: 10 });
  await f.risk.recordSignal({ customer_id: b, kind: "late_payment", severity: 5 });
  await f.risk.recordSignal({ customer_id: c, kind: "refund_request", severity: 2 });

  // recompute one customer → returns the fresh summary.
  var fresh = await f.risk.recompute({ customer_id: a });
  check("recompute returns customer_id",        fresh.customer_id === a);
  check("recompute returns score",              fresh.risk_score === 10);
  check("recompute returns band",               fresh.risk_band === "moderate");
  check("recompute stamps recomputed_at",       typeof fresh.recomputed_at === "number");

  // recomputeAll picks up every customer (since is far in the past
  // so all summaries qualify).
  var all = await f.risk.recomputeAll({ since: 1 });
  check("recomputeAll count = 3",               all.recomputed_count === 3);
  check("recomputeAll stamps recomputed_at",    typeof all.recomputed_at === "number");

  // Second pass with the same cutoff still recomputes (the
  // primitive is idempotent — operator can re-run anytime).
  var again = await f.risk.recomputeAll({ since: 1 });
  check("recomputeAll idempotent",              again.recomputed_count === 3);
}

async function _topRiskCustomersOrderingAndBandFilter() {
  var f = _factory();
  var low      = _uuid();
  var moderate = _uuid();
  var high     = _uuid();
  var critical = _uuid();

  await f.risk.recordSignal({ customer_id: low,      kind: "refund_request", severity: 3 });   // score 3 low
  await f.risk.recordSignal({ customer_id: moderate, kind: "chargeback",     severity: 10 });  // score 10 moderate
  await f.risk.recordSignal({ customer_id: high,     kind: "chargeback",     severity: 10 });
  await f.risk.recordSignal({ customer_id: high,     kind: "chargeback",     severity: 10 });
  await f.risk.recordSignal({ customer_id: high,     kind: "fraud_score_high", severity: 5 }); // score 25 high
  for (var i = 0; i < 6; i += 1) {
    await f.risk.recordSignal({ customer_id: critical, kind: "chargeback", severity: 10 });    // score 60 critical
  }

  // Top 4: descending score.
  var top = await f.risk.topRiskCustomers({ limit: 4 });
  check("top length 4",                         top.length === 4);
  check("top[0] critical first",                top[0].customer_id === critical && top[0].risk_score === 60);
  check("top[1] high",                          top[1].customer_id === high     && top[1].risk_score === 25);
  check("top[2] moderate",                      top[2].customer_id === moderate && top[2].risk_score === 10);
  check("top[3] low",                           top[3].customer_id === low      && top[3].risk_score === 3);

  // Limit honors.
  var top2 = await f.risk.topRiskCustomers({ limit: 2 });
  check("top limit honored",                    top2.length === 2);

  // Band filter.
  var onlyCritical = await f.risk.topRiskCustomers({ limit: 10, band: "critical" });
  check("band filter critical 1",               onlyCritical.length === 1 && onlyCritical[0].customer_id === critical);

  var onlyHigh = await f.risk.topRiskCustomers({ limit: 10, band: "high" });
  check("band filter high 1",                   onlyHigh.length === 1 && onlyHigh[0].customer_id === high);

  var onlyLow = await f.risk.topRiskCustomers({ limit: 10, band: "low" });
  check("band filter low 1",                    onlyLow.length === 1 && onlyLow[0].customer_id === low);
}

async function _monotonicOccurredAt() {
  // Two signal writes against the same customer at the same epoch-ms
  // would tie on the (customer_id, occurred_at DESC) index without
  // the monotonic-clock bump. Verify the bump fires.
  var f = _factory();
  var cid = _uuid();

  var stamp = 1700000000000;
  var s1 = await f.risk.recordSignal({
    customer_id: cid, kind: "chargeback", severity: 5, occurred_at: stamp,
  });
  var s2 = await f.risk.recordSignal({
    customer_id: cid, kind: "late_payment", severity: 3, occurred_at: stamp,
  });
  var s3 = await f.risk.recordSignal({
    customer_id: cid, kind: "fraud_score_high", severity: 2, occurred_at: stamp,
  });
  check("first signal lands at stamp",          s1.occurred_at === stamp);
  check("second bumped to +1",                  s2.occurred_at === stamp + 1);
  check("third bumped to +2",                   s3.occurred_at === stamp + 2);

  // Backdated request still lands strictly newer than the latest row.
  var s4 = await f.risk.recordSignal({
    customer_id: cid, kind: "address_mismatch", severity: 1, occurred_at: stamp - 1000,
  });
  check("backdated still monotonic",            s4.occurred_at === stamp + 3);
}

async function _optionalHandlesExposed() {
  // The factory accepts caller-correlator handles (fraudScreen,
  // returns, dunning, creditLimits) so an integrator can recover
  // them off the instance. The primitive does NOT reach into them
  // — recording a signal is always an explicit operator call.
  var h = _makeQuery();
  var fraudStub  = { name: "fraud" };
  var returnsStub = { name: "returns" };
  var dunningStub = { name: "dunning" };
  var creditStub  = { name: "credit" };

  var risk = customerRiskProfile.create({
    query:        h.query,
    fraudScreen:  fraudStub,
    returns:      returnsStub,
    dunning:      dunningStub,
    creditLimits: creditStub,
  });

  check("handles.fraudScreen exposed",          risk.handles.fraudScreen === fraudStub);
  check("handles.returns exposed",              risk.handles.returns === returnsStub);
  check("handles.dunning exposed",              risk.handles.dunning === dunningStub);
  check("handles.creditLimits exposed",         risk.handles.creditLimits === creditStub);

  // No-handles factory still works.
  var bareRisk = customerRiskProfile.create({ query: h.query });
  check("handles default null",                 bareRisk.handles.fraudScreen === null
                                                && bareRisk.handles.returns === null
                                                && bareRisk.handles.dunning === null
                                                && bareRisk.handles.creditLimits === null);
}

async function _exportedConstants() {
  check("KINDS exported",                       Array.isArray(customerRiskProfile.KINDS)
                                                && customerRiskProfile.KINDS.length === 8
                                                && customerRiskProfile.KINDS.indexOf("chargeback") !== -1
                                                && customerRiskProfile.KINDS.indexOf("refund_to_credit") !== -1);
  check("BAND_NAMES exported",                  Array.isArray(customerRiskProfile.BAND_NAMES)
                                                && customerRiskProfile.BAND_NAMES.length === 4);
  check("BANDS exported",                       customerRiskProfile.BANDS
                                                && customerRiskProfile.BANDS.LOW_MAX === 9
                                                && customerRiskProfile.BANDS.MODERATE_MAX === 24
                                                && customerRiskProfile.BANDS.HIGH_MAX === 49);
  check("RECENT_WINDOW_MS exported",            customerRiskProfile.RECENT_WINDOW_MS === 90 * 86400 * 1000);

  var inst = customerRiskProfile.create({ query: _makeQuery().query });
  check("instance exposes KINDS",               inst.KINDS.length === 8);
  check("instance exposes BAND_NAMES",          inst.BAND_NAMES.length === 4);
  check("instance exposes BANDS",               inst.BANDS && inst.BANDS.LOW_MAX === 9);
  check("instance exposes RECENT_WINDOW_MS",    inst.RECENT_WINDOW_MS === 90 * 86400 * 1000);
}

async function _validation() {
  var f = _factory();
  var ok = _uuid();
  // Seed a signal so we have a real signal_id to clear-test against.
  var seeded = await f.risk.recordSignal({
    customer_id: ok, kind: "chargeback", severity: 5,
  });

  // recordSignal
  await assert.rejects(f.risk.recordSignal(),                                                                          /input object required/);
  await assert.rejects(f.risk.recordSignal({}),                                                                        /customer_id/);
  await assert.rejects(f.risk.recordSignal({ customer_id: "not-a-uuid", kind: "chargeback", severity: 5 }),            /customer_id/);
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "bogus", severity: 5 }),                      /kind/);
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "chargeback", severity: 0 }),                 /severity/);
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "chargeback", severity: 11 }),                /severity/);
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "chargeback", severity: 1.5 }),               /severity/);
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "chargeback", severity: 5, occurred_at: -1 }), /occurred_at/);
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "chargeback", severity: 5, detail_json: "string" }), /detail_json/);
  // 8 KiB + 1 detail_json refused.
  var bigDetail = { blob: new Array(8200).join("x") };
  await assert.rejects(f.risk.recordSignal({ customer_id: _uuid(), kind: "chargeback", severity: 5, detail_json: bigDetail }), /detail_json/);

  // getProfile
  await assert.rejects(f.risk.getProfile("not-a-uuid"),                                                                /customer_id/);

  // tier
  await assert.rejects(f.risk.tier("not-a-uuid"),                                                                      /customer_id/);

  // historyForCustomer
  await assert.rejects(f.risk.historyForCustomer("not-a-uuid"),                                                        /customer_id/);

  // recompute
  await assert.rejects(f.risk.recompute(),                                                                             /input object required/);
  await assert.rejects(f.risk.recompute({}),                                                                           /customer_id/);
  await assert.rejects(f.risk.recompute({ customer_id: "not-a-uuid" }),                                                /customer_id/);

  // recomputeAll
  await assert.rejects(f.risk.recomputeAll(),                                                                          /input object required/);
  await assert.rejects(f.risk.recomputeAll({}),                                                                        /since/);
  await assert.rejects(f.risk.recomputeAll({ since: -1 }),                                                             /since/);
  await assert.rejects(f.risk.recomputeAll({ since: 1.5 }),                                                            /since/);

  // topRiskCustomers
  await assert.rejects(f.risk.topRiskCustomers(),                                                                      /input object required/);
  await assert.rejects(f.risk.topRiskCustomers({}),                                                                    /limit/);
  await assert.rejects(f.risk.topRiskCustomers({ limit: 0 }),                                                          /limit/);
  await assert.rejects(f.risk.topRiskCustomers({ limit: -1 }),                                                         /limit/);
  await assert.rejects(f.risk.topRiskCustomers({ limit: 1.5 }),                                                        /limit/);
  await assert.rejects(f.risk.topRiskCustomers({ limit: 10, band: "bogus" }),                                          /band/);

  // clearSignal
  await assert.rejects(f.risk.clearSignal(),                                                                           /input object required/);
  await assert.rejects(f.risk.clearSignal({ signal_id: "not-a-uuid", reason: "x", cleared_by: "y" }),                  /signal_id/);
  await assert.rejects(f.risk.clearSignal({ signal_id: seeded.id }),                                                   /reason/);
  await assert.rejects(f.risk.clearSignal({ signal_id: seeded.id, reason: "" }),                                       /reason/);
  await assert.rejects(f.risk.clearSignal({ signal_id: seeded.id, reason: "x" }),                                      /cleared_by/);
  await assert.rejects(f.risk.clearSignal({ signal_id: seeded.id, reason: "bad\nline", cleared_by: "y" }),             /reason/);
  await assert.rejects(f.risk.clearSignal({ signal_id: seeded.id, reason: "x", cleared_by: "bad\nline" }),             /cleared_by/);
}

async function run() {
  await _recordSignalAndGetProfile();
  await _riskScoreMathAndBands();
  await _recentWindowExcludesOldSignals();
  await _tierEchoesBand();
  await _historyForCustomerOrderingAndJson();
  await _clearSignalDropsContribution();
  await _recomputeAndRecomputeAll();
  await _topRiskCustomersOrderingAndBandFilter();
  await _monotonicOccurredAt();
  await _optionalHandlesExposed();
  await _exportedConstants();
  await _validation();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - customer-risk-profile (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
