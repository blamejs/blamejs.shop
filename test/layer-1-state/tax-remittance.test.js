"use strict";
/**
 * tax-remittance — per-jurisdiction payment tracking + reconciliation
 * against `salesTaxFilings`. Records the actual bank-side payment
 * (method, reference, settlement timestamp), reconciles paid totals
 * against filings, surfaces unpaid obligations + late remittances,
 * rolls up on-time-rate metrics, and amends a row with an
 * after-the-fact penalty.
 *
 * Layer 1 against in-memory node:sqlite with migration 0204 loaded.
 * The salesTaxFilings dependency is stubbed locally so this test
 * exercises the remittance primitive in isolation.
 *
 * Coverage:
 *   - recordRemittance happy path + payment_method enum gate
 *   - reconcileWithFiling under-payment / over-payment / exact
 *     variance math
 *   - remittancesForJurisdiction window filter + ordering
 *   - markVoided idempotency + reconcileWithFiling excludes voided
 *   - lateRemittances threshold against filing.due_date
 *   - recordPenalty attaches penalty + refuses on voided
 *   - metricsForJurisdiction on-time rate + totals
 *   - unpaidObligations sweeps overdue + short-paid filings
 *   - factory refuses bad salesTaxFilings handle shape
 *   - validation surface refusals on every entry point
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var taxRemittance = require("../../lib/tax-remittance");
var bShop         = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0204_tax_remittance.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

// salesTaxFilings stub. Holds an in-memory map of filing rows keyed by
// id; exposes getFiling + listFilings + upcomingDue so the primitive's
// composition surface is exercised exactly as the real handle would
// be. Operators of the test add filings via stub.put(filing).
function _filingsStub(initial) {
  var rows = Object.create(null);
  if (initial) {
    for (var i = 0; i < initial.length; i += 1) rows[initial[i].id] = initial[i];
  }
  return {
    put: function (f) { rows[f.id] = f; },
    getFiling: async function (id) { return rows[id] || null; },
    listFilings: async function (listOpts) {
      listOpts = listOpts || {};
      var out = [];
      var keys = Object.keys(rows);
      for (var k = 0; k < keys.length; k += 1) {
        var f = rows[keys[k]];
        if (listOpts.jurisdiction && f.jurisdiction !== listOpts.jurisdiction) continue;
        if (listOpts.status       && f.status       !== listOpts.status)       continue;
        out.push(f);
      }
      out.sort(function (a, b) { return a.due_date - b.due_date; });
      return out;
    },
    upcomingDue: async function (opts) {
      var horizon = opts.now + opts.days_ahead * 86400000;
      var keys = Object.keys(rows);
      var out  = [];
      for (var k = 0; k < keys.length; k += 1) {
        if (rows[keys[k]].due_date <= horizon) out.push(rows[keys[k]]);
      }
      return out;
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _filing(over) {
  over = over || {};
  return {
    id:                  over.id           || _uuid(),
    jurisdiction:        over.jurisdiction || "US-CA",
    kind:                over.kind         || "monthly",
    period_start:        over.period_start || 1700000000000,
    period_end:          over.period_end   || 1702592000000,
    due_date:            over.due_date     || 1703000000000,
    status:              over.status       || "submitted",
    tax_owed_minor:      over.tax_owed_minor      != null ? over.tax_owed_minor      : 100000,
    tax_collected_minor: over.tax_collected_minor != null ? over.tax_collected_minor : 100000,
  };
}

async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var stub = opts.filings || _filingsStub();
  var svc = taxRemittance.create({
    query:           q,
    salesTaxFilings: opts.includeFilings === false ? null : stub,
  });
  return { q: q, svc: svc, filings: stub };
}

// ---- recordRemittance + paymentMethod enum ------------------------------

async function _recordRemittanceShape() {
  var w = await _wire();
  var filing = _filing();
  w.filings.put(filing);

  var rem = await w.svc.recordRemittance({
    filing_id:      filing.id,
    jurisdiction:   "US-CA",
    amount_minor:   75000,
    currency:       "USD",
    payment_method: "wire",
    payment_ref:    "WIRE-2024-0001",
    paid_at:        1702800000000,
  });
  check("recordRemittance returns row",         rem && typeof rem.id === "string");
  check("recordRemittance status paid",         rem.status === "paid");
  check("recordRemittance amount captured",     rem.amount_minor === 75000);
  check("recordRemittance method captured",     rem.payment_method === "wire");
  check("recordRemittance currency captured",   rem.currency === "USD");
  check("recordRemittance payment_ref",         rem.payment_ref === "WIRE-2024-0001");
  check("recordRemittance paid_at",             rem.paid_at === 1702800000000);
  check("recordRemittance created_at stamp",    typeof rem.created_at === "number" && rem.created_at > 0);
  check("recordRemittance penalty null",        rem.penalty_minor === null);

  // getRemittance round-trip
  var got = await w.svc.getRemittance(rem.id);
  check("getRemittance round-trip",             got && got.id === rem.id && got.amount_minor === 75000);
  check("getRemittance miss returns null",      (await w.svc.getRemittance(_uuid())) === null);

  // payment_method enum gate — bogus method refused
  await assert.rejects(w.svc.recordRemittance({
    filing_id:      filing.id,
    jurisdiction:   "US-CA",
    amount_minor:   1,
    currency:       "USD",
    payment_method: "bitcoin",
    payment_ref:    "x",
    paid_at:        1702800000000,
  }), /payment_method/);

  // Every documented method accepted
  var methods = ["bank_transfer", "credit_card", "ach", "wire", "check"];
  for (var i = 0; i < methods.length; i += 1) {
    var r = await w.svc.recordRemittance({
      filing_id:      filing.id,
      jurisdiction:   "US-CA",
      amount_minor:   100,
      currency:       "USD",
      payment_method: methods[i],
      payment_ref:    "REF-" + methods[i],
      paid_at:        1702800000000 + i,
    });
    check("payment_method accepted: " + methods[i], r.payment_method === methods[i]);
  }
}

// ---- reconcileWithFiling variance math ----------------------------------

async function _reconcileVariance() {
  var w = await _wire();
  var filing = _filing({ tax_owed_minor: 100000 });
  w.filings.put(filing);

  // First remittance — under-payment
  var r1 = await w.svc.recordRemittance({
    filing_id:      filing.id,
    jurisdiction:   "US-CA",
    amount_minor:   60000,
    currency:       "USD",
    payment_method: "ach",
    payment_ref:    "ACH-A",
    paid_at:        1702800000000,
  });
  var rec1 = await w.svc.reconcileWithFiling({ remittance_id: r1.id });
  check("reconcile owed",              rec1.owed_minor === 100000);
  check("reconcile paid under",        rec1.paid_minor === 60000);
  check("reconcile variance positive", rec1.variance_minor === 40000);
  check("reconcile carries filing_id", rec1.filing_id === filing.id);

  // Second remittance — pushes total to exact match
  var r2 = await w.svc.recordRemittance({
    filing_id:      filing.id,
    jurisdiction:   "US-CA",
    amount_minor:   40000,
    currency:       "USD",
    payment_method: "ach",
    payment_ref:    "ACH-B",
    paid_at:        1702800100000,
  });
  var rec2 = await w.svc.reconcileWithFiling({ remittance_id: r2.id });
  check("reconcile paid exact",        rec2.paid_minor === 100000);
  check("reconcile variance zero",     rec2.variance_minor === 0);

  // Third remittance — over-payment
  var r3 = await w.svc.recordRemittance({
    filing_id:      filing.id,
    jurisdiction:   "US-CA",
    amount_minor:   5000,
    currency:       "USD",
    payment_method: "wire",
    payment_ref:    "WIRE-OVR",
    paid_at:        1702800200000,
  });
  var rec3 = await w.svc.reconcileWithFiling({ remittance_id: r3.id });
  check("reconcile paid over",         rec3.paid_minor === 105000);
  check("reconcile variance negative", rec3.variance_minor === -5000);

  // Void the overpayment — paid total drops back to 100000
  await w.svc.markVoided({ remittance_id: r3.id, reason: "wire reversed by bank" });
  var rec4 = await w.svc.reconcileWithFiling({ remittance_id: r1.id });
  check("reconcile excludes voided",   rec4.paid_minor === 100000 && rec4.variance_minor === 0);

  // Unknown remittance / filing surface errors
  await assert.rejects(w.svc.reconcileWithFiling({ remittance_id: _uuid() }),
    function (e) { return e.code === "TAX_REMITTANCE_NOT_FOUND"; });

  // Remittance whose filing the stub doesn't know about
  var orphan = await w.svc.recordRemittance({
    filing_id:      _uuid(),
    jurisdiction:   "US-CA",
    amount_minor:   1,
    currency:       "USD",
    payment_method: "check",
    payment_ref:    "CHK-ORPHAN",
    paid_at:        1702800000000,
  });
  await assert.rejects(w.svc.reconcileWithFiling({ remittance_id: orphan.id }),
    function (e) { return e.code === "TAX_REMITTANCE_FILING_NOT_FOUND"; });
}

// ---- remittancesForJurisdiction + markVoided idempotency ----------------

async function _remittancesForJurisdiction() {
  var w = await _wire();
  var f = _filing();
  w.filings.put(f);

  var rA = await w.svc.recordRemittance({
    filing_id: f.id, jurisdiction: "US-CA", amount_minor: 100, currency: "USD",
    payment_method: "ach", payment_ref: "A", paid_at: 1000,
  });
  var rB = await w.svc.recordRemittance({
    filing_id: f.id, jurisdiction: "US-CA", amount_minor: 200, currency: "USD",
    payment_method: "wire", payment_ref: "B", paid_at: 2000,
  });
  await w.svc.recordRemittance({
    filing_id: f.id, jurisdiction: "US-NY", amount_minor: 300, currency: "USD",
    payment_method: "check", payment_ref: "C", paid_at: 1500,
  });

  // Window [500, 2500) for US-CA — both rA + rB; ordered paid_at DESC
  var rows = await w.svc.remittancesForJurisdiction({
    jurisdiction: "US-CA", from: 500, to: 2500,
  });
  check("remittancesForJurisdiction count",      rows.length === 2);
  check("remittancesForJurisdiction order DESC", rows[0].id === rB.id && rows[1].id === rA.id);

  // Tighter window excludes rA
  var rowsTight = await w.svc.remittancesForJurisdiction({
    jurisdiction: "US-CA", from: 1500, to: 2500,
  });
  check("remittancesForJurisdiction tight",      rowsTight.length === 1 && rowsTight[0].id === rB.id);

  // markVoided idempotent
  var v1 = await w.svc.markVoided({ remittance_id: rA.id, reason: "duplicate posting" });
  check("markVoided status flips",   v1.status === "voided");
  check("markVoided reason stamped", v1.void_reason === "duplicate posting");
  check("markVoided voided_at set",  typeof v1.voided_at === "number" && v1.voided_at > 0);

  var v2 = await w.svc.markVoided({ remittance_id: rA.id, reason: "different reason" });
  check("markVoided idempotent",     v2.status === "voided" && v2.void_reason === "duplicate posting");

  // Voided row still appears in the window read
  var rowsWithVoid = await w.svc.remittancesForJurisdiction({
    jurisdiction: "US-CA", from: 500, to: 2500,
  });
  check("voided still visible",      rowsWithVoid.some(function (r) { return r.id === rA.id && r.status === "voided"; }));

  // markVoided refuses unknown
  await assert.rejects(w.svc.markVoided({ remittance_id: _uuid(), reason: "x" }),
    function (e) { return e.code === "TAX_REMITTANCE_NOT_FOUND"; });
}

// ---- lateRemittances ----------------------------------------------------

async function _lateRemittancesThreshold() {
  var w = await _wire();
  // Filing due 2024-01-15
  var fOnTime   = _filing({ jurisdiction: "US-CA", due_date: 1705276800000, tax_owed_minor: 1000 });
  var fSlightly = _filing({ jurisdiction: "US-CA", due_date: 1705276800000, tax_owed_minor: 1000 });
  var fVeryLate = _filing({ jurisdiction: "US-CA", due_date: 1705276800000, tax_owed_minor: 1000 });
  w.filings.put(fOnTime);
  w.filings.put(fSlightly);
  w.filings.put(fVeryLate);

  // On-time: paid exactly on due_date
  await w.svc.recordRemittance({
    filing_id: fOnTime.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "ach", payment_ref: "ON-TIME", paid_at: 1705276800000,
  });
  // 2 days late
  await w.svc.recordRemittance({
    filing_id: fSlightly.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "ach", payment_ref: "2-DAYS-LATE", paid_at: 1705276800000 + 2 * 86400000,
  });
  // 10 days late
  await w.svc.recordRemittance({
    filing_id: fVeryLate.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "wire", payment_ref: "10-DAYS-LATE", paid_at: 1705276800000 + 10 * 86400000,
  });

  // threshold = 1 day → catches both late
  var late1 = await w.svc.lateRemittances({
    as_of: 1705276800000 + 20 * 86400000, days_late_min: 1,
  });
  check("lateRemittances >= 1 day",   late1.length === 2);
  check("lateRemittances carries days_late", late1.every(function (r) { return typeof r.days_late === "number" && r.days_late >= 1; }));
  check("lateRemittances carries due_date",  late1.every(function (r) { return r.due_date === 1705276800000; }));

  // threshold = 7 days → only the 10-day late one
  var late7 = await w.svc.lateRemittances({
    as_of: 1705276800000 + 20 * 86400000, days_late_min: 7,
  });
  check("lateRemittances >= 7 days",  late7.length === 1 && late7[0].days_late === 10);

  // threshold = 30 days → none
  var lateNone = await w.svc.lateRemittances({
    as_of: 1705276800000 + 20 * 86400000, days_late_min: 30,
  });
  check("lateRemittances >= 30 days", lateNone.length === 0);
}

// ---- recordPenalty + voided refusal -------------------------------------

async function _recordPenaltyShape() {
  var w = await _wire();
  var f = _filing();
  w.filings.put(f);

  var rem = await w.svc.recordRemittance({
    filing_id: f.id, jurisdiction: "US-CA", amount_minor: 50000, currency: "USD",
    payment_method: "wire", payment_ref: "PEN-1", paid_at: 1702800000000,
  });
  check("recordRemittance no penalty initially", rem.penalty_minor === null);

  var withPen = await w.svc.recordPenalty({
    remittance_id: rem.id, penalty_minor: 5000, reason: "late payment 10 days past due",
  });
  check("recordPenalty amount",   withPen.penalty_minor === 5000);
  check("recordPenalty reason",   withPen.penalty_reason === "late payment 10 days past due");
  check("recordPenalty preserved amount", withPen.amount_minor === 50000);

  // recordPenalty can update the penalty (e.g. authority revises down)
  var revised = await w.svc.recordPenalty({
    remittance_id: rem.id, penalty_minor: 3000, reason: "revised after operator appeal",
  });
  check("recordPenalty revision",  revised.penalty_minor === 3000);
  check("recordPenalty new reason", revised.penalty_reason === "revised after operator appeal");

  // Zero penalty accepted (authority waived)
  var waived = await w.svc.recordPenalty({
    remittance_id: rem.id, penalty_minor: 0, reason: "waived",
  });
  check("recordPenalty zero accepted", waived.penalty_minor === 0);

  // recordPenalty refuses on voided
  await w.svc.markVoided({ remittance_id: rem.id, reason: "test" });
  await assert.rejects(w.svc.recordPenalty({
    remittance_id: rem.id, penalty_minor: 100, reason: "post-void",
  }), function (e) { return e.code === "TAX_REMITTANCE_VOIDED"; });

  // recordPenalty refuses unknown id
  await assert.rejects(w.svc.recordPenalty({
    remittance_id: _uuid(), penalty_minor: 1, reason: "x",
  }), function (e) { return e.code === "TAX_REMITTANCE_NOT_FOUND"; });
}

// ---- metricsForJurisdiction --------------------------------------------

async function _metricsOnTimeRate() {
  var w = await _wire();
  var fA = _filing({ jurisdiction: "US-CA", due_date: 1705000000000, tax_owed_minor: 1000 });
  var fB = _filing({ jurisdiction: "US-CA", due_date: 1705000000000, tax_owed_minor: 1000 });
  var fC = _filing({ jurisdiction: "US-CA", due_date: 1705000000000, tax_owed_minor: 1000 });
  var fD = _filing({ jurisdiction: "US-CA", due_date: 1705000000000, tax_owed_minor: 1000 });
  w.filings.put(fA); w.filings.put(fB); w.filings.put(fC); w.filings.put(fD);

  // On-time
  await w.svc.recordRemittance({
    filing_id: fA.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "ach", payment_ref: "A", paid_at: 1704000000000,
  });
  await w.svc.recordRemittance({
    filing_id: fB.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "ach", payment_ref: "B", paid_at: 1705000000000,
  });
  await w.svc.recordRemittance({
    filing_id: fC.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "ach", payment_ref: "C", paid_at: 1705000000000 + 86400000,
  });
  var remD = await w.svc.recordRemittance({
    filing_id: fD.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "wire", payment_ref: "D", paid_at: 1705000000000 + 3 * 86400000,
  });
  // Attach a penalty to remD
  await w.svc.recordPenalty({ remittance_id: remD.id, penalty_minor: 250, reason: "late" });

  var m = await w.svc.metricsForJurisdiction({
    jurisdiction: "US-CA", from: 1703000000000, to: 1706000000000,
  });
  check("metrics remittance_count",   m.remittance_count === 4);
  check("metrics voided_count",       m.voided_count === 0);
  check("metrics on_time_count",      m.on_time_count === 2);
  check("metrics late_count",         m.late_count === 2);
  check("metrics total_paid",         m.total_paid_minor === 4000);
  check("metrics total_penalty",      m.total_penalty_minor === 250);
  check("metrics on_time_rate 0.5",   m.on_time_rate === 0.5);

  // Empty window → on_time_rate defaults to 1
  var empty = await w.svc.metricsForJurisdiction({
    jurisdiction: "US-CA", from: 1, to: 2,
  });
  check("metrics empty count",        empty.remittance_count === 0);
  check("metrics empty rate 1.0",     empty.on_time_rate === 1);

  // Voiding a row drops it from paid totals + on/late buckets
  await w.svc.markVoided({ remittance_id: remD.id, reason: "reversed" });
  var m2 = await w.svc.metricsForJurisdiction({
    jurisdiction: "US-CA", from: 1703000000000, to: 1706000000000,
  });
  check("metrics voided_count post-void", m2.voided_count === 1);
  check("metrics total_paid post-void",   m2.total_paid_minor === 3000);
  check("metrics late_count post-void",   m2.late_count === 1);
}

// ---- unpaidObligations --------------------------------------------------

async function _unpaidObligationsSweep() {
  var w = await _wire();
  // Three filings — one paid in full, one partially paid, one
  // computed-but-untouched. due_date <= as_of for all three.
  var asOf = 1710000000000;
  var fPaid       = _filing({ id: _uuid(), due_date: asOf - 2000, tax_owed_minor: 1000, status: "submitted" });
  var fPartial    = _filing({ id: _uuid(), due_date: asOf - 1000, tax_owed_minor: 5000, status: "submitted" });
  var fUntouched  = _filing({ id: _uuid(), due_date: asOf - 500,  tax_owed_minor: 2500, status: "submitted" });
  var fDraft      = _filing({ id: _uuid(), due_date: asOf - 100,  tax_owed_minor: 0,    status: "draft" });
  w.filings.put(fPaid); w.filings.put(fPartial); w.filings.put(fUntouched); w.filings.put(fDraft);

  await w.svc.recordRemittance({
    filing_id: fPaid.id, jurisdiction: "US-CA", amount_minor: 1000, currency: "USD",
    payment_method: "ach", payment_ref: "FULL", paid_at: asOf - 1500,
  });
  await w.svc.recordRemittance({
    filing_id: fPartial.id, jurisdiction: "US-CA", amount_minor: 2000, currency: "USD",
    payment_method: "ach", payment_ref: "PART", paid_at: asOf - 1500,
  });

  var unpaid = await w.svc.unpaidObligations({ as_of: asOf });
  check("unpaidObligations count",                unpaid.length === 2);

  var byId = Object.create(null);
  unpaid.forEach(function (u) { byId[u.filing_id] = u; });
  check("unpaidObligations excludes fully-paid",  !byId[fPaid.id]);
  check("unpaidObligations includes partial",     !!byId[fPartial.id]);
  check("unpaidObligations partial variance",     byId[fPartial.id].variance_minor === 3000);
  check("unpaidObligations partial paid_minor",   byId[fPartial.id].paid_minor === 2000);
  check("unpaidObligations includes untouched",   !!byId[fUntouched.id]);
  check("unpaidObligations untouched variance",   byId[fUntouched.id].variance_minor === 2500);
  check("unpaidObligations skips draft",          !byId[fDraft.id]);
  check("unpaidObligations ordered by due_date",  unpaid[0].due_date <= unpaid[1].due_date);

  // jurisdiction filter
  var fNyc = _filing({ id: _uuid(), jurisdiction: "US-NY", due_date: asOf - 200, tax_owed_minor: 7000, status: "submitted" });
  w.filings.put(fNyc);
  var unpaidCa = await w.svc.unpaidObligations({ as_of: asOf, jurisdiction: "US-CA" });
  check("unpaidObligations jurisdiction filter", unpaidCa.every(function (u) { return u.jurisdiction === "US-CA"; }));
  var unpaidNy = await w.svc.unpaidObligations({ as_of: asOf, jurisdiction: "US-NY" });
  check("unpaidObligations US-NY only",          unpaidNy.length === 1 && unpaidNy[0].filing_id === fNyc.id);
}

// ---- factory refusals + validation surface ------------------------------

async function _factoryRefusalsAndValidation() {
  // Bad salesTaxFilings shape — missing getFiling
  assert.throws(function () {
    taxRemittance.create({ query: function () {}, salesTaxFilings: {} });
  }, /getFiling/);
  assert.throws(function () {
    taxRemittance.create({ query: function () {}, salesTaxFilings: { getFiling: "not-a-function" } });
  }, /getFiling/);

  // Reads that require filingsApi refuse when handle absent
  var wNoFilings = await _wire({ includeFilings: false });
  // recordRemittance still works (no filings dependency)
  var f = _filing();
  var rem = await wNoFilings.svc.recordRemittance({
    filing_id: f.id, jurisdiction: "US-CA", amount_minor: 100, currency: "USD",
    payment_method: "ach", payment_ref: "X", paid_at: 1,
  });
  check("recordRemittance works sans filings handle", rem && rem.status === "paid");

  // reconcileWithFiling refuses
  await assert.rejects(wNoFilings.svc.reconcileWithFiling({ remittance_id: rem.id }),
    function (e) { return e.code === "TAX_REMITTANCE_FILINGS_NOT_WIRED"; });
  await assert.rejects(wNoFilings.svc.unpaidObligations({ as_of: 1 }),
    function (e) { return e.code === "TAX_REMITTANCE_FILINGS_NOT_WIRED"; });
  await assert.rejects(wNoFilings.svc.lateRemittances({ as_of: 1, days_late_min: 1 }),
    function (e) { return e.code === "TAX_REMITTANCE_FILINGS_NOT_WIRED"; });
  await assert.rejects(wNoFilings.svc.metricsForJurisdiction({ jurisdiction: "US-CA", from: 0, to: 1 }),
    function (e) { return e.code === "TAX_REMITTANCE_FILINGS_NOT_WIRED"; });

  // Validation surface on entry points
  var w = await _wire();
  var goodFiling = _filing();
  w.filings.put(goodFiling);

  await assert.rejects(w.svc.recordRemittance(),                                       /input object required/);
  await assert.rejects(w.svc.recordRemittance({}),                                     /filing_id/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: "not-a-uuid" }),            /filing_id/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "lowercase" }),                                                       /jurisdiction/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: 0 }),                                          /amount_minor/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: -5 }),                                         /amount_minor/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: 1, currency: "us" }),                          /currency/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: 1, currency: "USD",
    payment_method: "bogus" }),                                                         /payment_method/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: 1, currency: "USD",
    payment_method: "ach", payment_ref: "" }),                                          /payment_ref/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: 1, currency: "USD",
    payment_method: "ach", payment_ref: "ok\x00ctrl", paid_at: 1 }),                    /control bytes/);
  await assert.rejects(w.svc.recordRemittance({ filing_id: goodFiling.id,
    jurisdiction: "US-CA", amount_minor: 1, currency: "USD",
    payment_method: "ach", payment_ref: "ok", paid_at: -1 }),                           /paid_at/);

  await assert.rejects(w.svc.remittancesForJurisdiction(),                              /input object required/);
  await assert.rejects(w.svc.remittancesForJurisdiction({ jurisdiction: "US-CA",
    from: 100, to: 100 }),                                                              /to must be > from/);

  await assert.rejects(w.svc.markVoided(),                                              /input object required/);
  await assert.rejects(w.svc.markVoided({ remittance_id: _uuid(), reason: "" }),        /reason/);

  await assert.rejects(w.svc.recordPenalty(),                                           /input object required/);
  await assert.rejects(w.svc.recordPenalty({ remittance_id: _uuid(),
    penalty_minor: -1, reason: "x" }),                                                  /penalty_minor/);

  await assert.rejects(w.svc.metricsForJurisdiction(),                                  /input object required/);
  await assert.rejects(w.svc.metricsForJurisdiction({ jurisdiction: "US-CA",
    from: 100, to: 50 }),                                                                /to must be > from/);

  await assert.rejects(w.svc.lateRemittances(),                                         /input object required/);
  await assert.rejects(w.svc.lateRemittances({ as_of: 1, days_late_min: -1 }),          /days_late_min/);

  await assert.rejects(w.svc.unpaidObligations(),                                       /input object required/);
}

// ---- exported constants ------------------------------------------------

async function _exportedConstants() {
  check("PAYMENT_METHODS exported", Array.isArray(taxRemittance.PAYMENT_METHODS)
                                     && taxRemittance.PAYMENT_METHODS.indexOf("wire") !== -1
                                     && taxRemittance.PAYMENT_METHODS.indexOf("check") !== -1);
  check("STATUSES exported",        Array.isArray(taxRemittance.STATUSES)
                                     && taxRemittance.STATUSES.indexOf("paid") !== -1
                                     && taxRemittance.STATUSES.indexOf("voided") !== -1);
  check("JURISDICTION_RE exported", taxRemittance.JURISDICTION_RE instanceof RegExp);
  check("CURRENCY_RE exported",     taxRemittance.CURRENCY_RE     instanceof RegExp);

  var q = _makeQuery();
  var svc = taxRemittance.create({ query: q });
  check("instance exposes PAYMENT_METHODS", svc.PAYMENT_METHODS.length === 5);
  check("instance exposes STATUSES",        svc.STATUSES.length === 2);
}

async function run() {
  await _recordRemittanceShape();
  await _reconcileVariance();
  await _remittancesForJurisdiction();
  await _lateRemittancesThreshold();
  await _recordPenaltyShape();
  await _metricsOnTimeRate();
  await _unpaidObligationsSweep();
  await _factoryRefusalsAndValidation();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("tax-remittance: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
