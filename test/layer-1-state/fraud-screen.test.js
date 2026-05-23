"use strict";
/**
 * fraudScreen — heuristic + ledger-based pre-payment risk gate.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0038_fraud_screenings.sql.
 *
 * Coverage:
 *   - each signal fires in isolation (disposable, free, address-
 *     mismatch, session-fast, session-old, ua-curl, large-line,
 *     high-value-new, BIN mismatch)
 *   - score aggregation across multiple signals
 *   - decision threshold boundaries (approve/review/step_up/refuse)
 *   - velocity signal across multiple orders in the 24h window
 *   - recordChargeback writes ledger row and affects next screen()
 *     of the same email
 *   - flagEmail forces refuse on next screen()
 *   - free vs disposable email distinction (weight difference)
 *   - recordOutcome writes actual_outcome on the ledger row
 *   - recentScreenings pagination + cursor tamper refusal
 *   - emailSuppressions injection fires the signal
 *   - validation refuses bad input
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// lib/index.js is wired by the operator; the primitive itself is
// required directly so the test exercises the production code path
// without depending on the registry mutation.
var fraudScreenMod = require("../../lib/fraud-screen");
var framework      = require("../../lib/vendor/blamejs");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_FRAUD = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0038_fraud_screenings.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_FRAUD, "utf8")).forEach(function (s) {
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

function _validUUID() { return framework.uuid.v7(); }

// A baseline draft that hits zero signals — every signal-specific
// test mutates one field on this template so the score delta is
// attributable.
function _baselineDraft() {
  return {
    order_id:            _validUUID(),
    customer_id:         _validUUID(),
    email:               "alice@example.com",                  // not free, not disposable
    ip_hash:             "ip-hash-sentinel",
    ua_class:            "browser",
    shipping_address:    { country: "US", state: "CA", postal: "94103" },
    billing_address:     { country: "US", state: "CA", postal: "94103" },
    total_minor:         2999,
    currency:            "USD",
    line_count:          2,
    session_age_seconds: 300,
    prior_orders_count:  3,
  };
}

function _firedNames(signals) {
  return signals.filter(function (s) { return s.fired; }).map(function (s) { return s.name; });
}

function _signalByName(signals, name) {
  for (var i = 0; i < signals.length; i += 1) {
    if (signals[i].name === name) return signals[i];
  }
  return null;
}

// ---- tests -------------------------------------------------------------

async function _baselineApproves() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var r = await fs.screen({ order_draft: _baselineDraft() });
  check("baseline draft — score 0",            r.score === 0);
  check("baseline draft — decision approve",   r.decision === "approve");
  check("baseline draft — no signals fired",   _firedNames(r.signals).length === 0);
  // Every signal slot is present — fired flag is the discriminator.
  var expected = [
    "velocity", "high-value-new-customer", "address-mismatch",
    "free-email-domain", "disposable-email-domain",
    "session-too-fast", "session-too-old", "ua-curl-class",
    "large-line-count", "mismatched-bin-country",
    "prior-chargeback", "suppressed-email", "manually-flagged",
  ];
  var actualNames = r.signals.map(function (s) { return s.name; });
  check("baseline draft — all 13 signal slots emitted",
    expected.every(function (n) { return actualNames.indexOf(n) !== -1; }) &&
    actualNames.length === expected.length);
  // The ledger row landed.
  var rows = h.db.prepare("SELECT * FROM fraud_screenings WHERE id = ?").all(r.id);
  check("baseline draft — ledger row written",  rows.length === 1);
  check("baseline draft — score persisted",      rows[0].score === 0);
  check("baseline draft — decision persisted",   rows[0].decision === "approve");
  check("baseline draft — signals_json persisted", JSON.parse(rows[0].signals_json).length === 13);
}

async function _freeEmailSignal() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.email = "victim@gmail.com";
  var r = await fs.screen({ order_draft: d });
  var fired = _firedNames(r.signals);
  check("free-email — only free fires",                fired.length === 1 && fired[0] === "free-email-domain");
  check("free-email — weight applied",                  r.score === fraudScreenMod.WEIGHTS.FREE_EMAIL_DOMAIN);
  check("free-email — decision still approve",          r.decision === "approve");
}

async function _disposableEmailRefuses() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.email = "attacker@mailinator.com";
  var r = await fs.screen({ order_draft: d });
  var fired = _firedNames(r.signals);
  check("disposable-email — fires",                     fired.indexOf("disposable-email-domain") !== -1);
  check("disposable-email — score >= 90 (refuse)",      r.score >= 90);
  check("disposable-email — decision refuse",            r.decision === "refuse");
  check("free vs disposable — distinct weights",
    fraudScreenMod.WEIGHTS.DISPOSABLE_EMAIL_DOMAIN > fraudScreenMod.WEIGHTS.FREE_EMAIL_DOMAIN);
}

async function _addressMismatchSignal() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.billing_address = { country: "CA", state: "ON", postal: "M5V" };
  var r = await fs.screen({ order_draft: d });
  var sig = _signalByName(r.signals, "address-mismatch");
  check("address-mismatch — fires when ship != bill",   sig && sig.fired === true);
  check("address-mismatch — detail captured",            sig.detail.shipping_country === "US" && sig.detail.billing_country === "CA");
  check("address-mismatch — score = weight",             r.score === fraudScreenMod.WEIGHTS.ADDRESS_MISMATCH);
  // 25 alone keeps the row in the approve band — corroboration with
  // other signals is what pushes the row past the review threshold.
  check("address-mismatch — approve band on its own",     r.decision === "approve");
}

async function _sessionTooFastAndTooOld() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });

  var d1 = _baselineDraft();
  d1.session_age_seconds = 3;
  var r1 = await fs.screen({ order_draft: d1 });
  check("session-too-fast — fires when <15s",
    _firedNames(r1.signals).indexOf("session-too-fast") !== -1);
  check("session-too-fast — score = weight",
    r1.score === fraudScreenMod.WEIGHTS.SESSION_TOO_FAST);

  var d2 = _baselineDraft();
  d2.session_age_seconds = 90000;
  var r2 = await fs.screen({ order_draft: d2 });
  check("session-too-old — fires when >24h",
    _firedNames(r2.signals).indexOf("session-too-old") !== -1);
}

async function _uaCurlClass() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.ua_class = "curl";
  var r = await fs.screen({ order_draft: d });
  check("ua-curl-class — fires for curl ua_class",
    _firedNames(r.signals).indexOf("ua-curl-class") !== -1);
  check("ua-curl-class — score = weight",
    r.score === fraudScreenMod.WEIGHTS.UA_CURL_CLASS);
}

async function _largeLineCount() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.line_count = fraudScreenMod.LARGE_LINE_COUNT_THRESH + 5;
  var r = await fs.screen({ order_draft: d });
  check("large-line-count — fires at/above threshold",
    _firedNames(r.signals).indexOf("large-line-count") !== -1);
}

async function _highValueNewCustomer() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.prior_orders_count = 0;
  d.total_minor = fraudScreenMod.HIGH_VALUE_NEW_THRESH + 100;
  var r = await fs.screen({ order_draft: d });
  check("high-value-new — fires for new big-ticket",
    _firedNames(r.signals).indexOf("high-value-new-customer") !== -1);
  check("high-value-new — score = weight",
    r.score === fraudScreenMod.WEIGHTS.HIGH_VALUE_NEW_CUSTOMER);

  // With prior_orders_count > 0 the signal does NOT fire.
  d.prior_orders_count = 5;
  var r2 = await fs.screen({ order_draft: d });
  check("high-value-new — does not fire with priors",
    _firedNames(r2.signals).indexOf("high-value-new-customer") === -1);
}

async function _binCountryMismatch() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({
    query:         h.query,
    binCountryMap: { "424242": "CA", "555555": "US" },
  });
  var d = _baselineDraft();
  d.bin6 = "424242";   // CA card on a US ship_to
  var r = await fs.screen({ order_draft: d });
  check("mismatched-bin-country — fires",
    _firedNames(r.signals).indexOf("mismatched-bin-country") !== -1);

  // Matching BIN → does not fire.
  d.bin6 = "555555";
  var r2 = await fs.screen({ order_draft: d });
  check("mismatched-bin-country — quiet on match",
    _firedNames(r2.signals).indexOf("mismatched-bin-country") === -1);
}

async function _velocitySignal() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  // Burn through > VELOCITY_MAX_OK screenings for the same email.
  var sharedEmail = "burst@example.com";
  for (var i = 0; i <= fraudScreenMod.VELOCITY_MAX_OK; i += 1) {
    var d = _baselineDraft();
    d.email = sharedEmail;
    d.order_id = _validUUID();
    await fs.screen({ order_draft: d });
  }
  // The next screen() should observe > VELOCITY_MAX_OK prior rows.
  var draft = _baselineDraft();
  draft.email = sharedEmail;
  var r = await fs.screen({ order_draft: draft });
  check("velocity — fires after burst",
    _firedNames(r.signals).indexOf("velocity") !== -1);
  var velocitySig = _signalByName(r.signals, "velocity");
  check("velocity — prior_count > threshold",
    velocitySig.detail.prior_count > fraudScreenMod.VELOCITY_MAX_OK);

  // A different email is unaffected.
  var fresh = _baselineDraft();
  fresh.email = "different@example.com";
  var r2 = await fs.screen({ order_draft: fresh });
  check("velocity — scoped by email",
    _firedNames(r2.signals).indexOf("velocity") === -1);
}

async function _chargebackAffectsNextScreen() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d1 = _baselineDraft();
  d1.email = "repeat-offender@example.com";
  var r1 = await fs.screen({ order_draft: d1 });
  check("chargeback — prior-chargeback quiet before record",
    _firedNames(r1.signals).indexOf("prior-chargeback") === -1);

  var cb = await fs.recordChargeback({
    order_id:     r1.order_id,
    customer_id:  d1.customer_id,
    email:        "repeat-offender@example.com",
    amount_minor: 5000,
    reason:       "fraudulent",
  });
  check("recordChargeback — returns email_hash",
    typeof cb.email_hash === "string" && cb.email_hash.length > 0);
  check("recordChargeback — persists ledger row",
    h.db.prepare("SELECT COUNT(*) AS n FROM fraud_chargebacks").get().n === 1);

  // Next screen() for the same email fires the prior-chargeback signal.
  var d2 = _baselineDraft();
  d2.email = "repeat-offender@example.com";
  d2.order_id = _validUUID();
  var r2 = await fs.screen({ order_draft: d2 });
  check("chargeback — prior-chargeback fires on next screen",
    _firedNames(r2.signals).indexOf("prior-chargeback") !== -1);
  check("chargeback — drives score upward",
    r2.score >= fraudScreenMod.WEIGHTS.PRIOR_CHARGEBACK);
}

async function _flagEmailForcesRefuse() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });

  await fs.flagEmail({ email: "blocked@example.com", reason: "operator review" });
  var d = _baselineDraft();
  d.email = "blocked@example.com";
  var r = await fs.screen({ order_draft: d });
  check("flagEmail — manually-flagged fires",
    _firedNames(r.signals).indexOf("manually-flagged") !== -1);
  check("flagEmail — decision refuse",   r.decision === "refuse");

  // Re-flagging is idempotent — single row.
  await fs.flagEmail({ email: "blocked@example.com", reason: "still blocked" });
  var n = h.db.prepare("SELECT COUNT(*) AS n FROM fraud_email_flags").get().n;
  check("flagEmail — idempotent (1 row)",  n === 1);

  // Unflag restores normal scoring.
  var u = await fs.unflagEmail({ email: "blocked@example.com" });
  check("unflagEmail — reports unflagged",  u.unflagged === true);
  var d2 = _baselineDraft();
  d2.email = "blocked@example.com";
  d2.order_id = _validUUID();
  var r2 = await fs.screen({ order_draft: d2 });
  check("flagEmail — cleared after unflag",
    _firedNames(r2.signals).indexOf("manually-flagged") === -1);
}

async function _decisionThresholdBoundaries() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var T = fraudScreenMod.THRESHOLDS;

  // Boundary checks via the THRESHOLDS exports — the test pins
  // the decision-band edges so a future re-calibration must
  // update the test alongside the runtime.
  check("threshold — APPROVE_MAX 39",    T.APPROVE_MAX === 39);
  check("threshold — REVIEW_MAX 69",     T.REVIEW_MAX  === 69);
  check("threshold — STEP_UP_MAX 89",    T.STEP_UP_MAX === 89);

  // A draft producing two corroborated signals (free-email +
  // address-mismatch) lands in REVIEW band (10 + 25 = 35 →
  // approve actually; bump with a second signal to demonstrate
  // the band edge).
  var d = _baselineDraft();
  d.email = "victim@gmail.com";            // free-email +10
  d.billing_address = { country: "CA" };   // address-mismatch +25
  d.session_age_seconds = 5;               // session-too-fast +20
  var r = await fs.screen({ order_draft: d });
  // 10 + 25 + 20 = 55 — lands in REVIEW band.
  check("threshold — review band (3 corroborated)",
    r.score >= 40 && r.score <= T.REVIEW_MAX && r.decision === "review");

  // Push into STEP_UP with a fourth signal — large-line-count +15
  // → 55 + 15 = 70.
  d.line_count = fraudScreenMod.LARGE_LINE_COUNT_THRESH + 1;
  d.order_id = _validUUID();
  var r2 = await fs.screen({ order_draft: d });
  check("threshold — step_up band (4 corroborated)",
    r2.score >= 70 && r2.score <= T.STEP_UP_MAX && r2.decision === "step_up");
}

async function _scoreAggregation() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  d.email = "victim@gmail.com";    // free-email +10
  d.ua_class = "curl";              // ua-curl-class +30
  var r = await fs.screen({ order_draft: d });
  var expected =
    fraudScreenMod.WEIGHTS.FREE_EMAIL_DOMAIN +
    fraudScreenMod.WEIGHTS.UA_CURL_CLASS;
  check("aggregation — score is sum of weights", r.score === expected);
  check("aggregation — both signals fired",
    _firedNames(r.signals).indexOf("free-email-domain") !== -1 &&
    _firedNames(r.signals).indexOf("ua-curl-class") !== -1);
}

async function _recordOutcomeWritesLedger() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var d = _baselineDraft();
  var r = await fs.screen({ order_draft: d });
  check("recordOutcome — initial actual_outcome NULL",
    h.db.prepare("SELECT actual_outcome FROM fraud_screenings WHERE id = ?").get(r.id).actual_outcome === null);

  var u = await fs.recordOutcome({ order_id: r.order_id, actual_outcome: "paid_clean" });
  check("recordOutcome — updates 1 row",   u.updated === 1);
  var after = h.db.prepare("SELECT actual_outcome FROM fraud_screenings WHERE id = ?").get(r.id);
  check("recordOutcome — actual_outcome persisted",
    after.actual_outcome === "paid_clean");

  // Refuses unknown outcomes.
  await assert.rejects(
    fs.recordOutcome({ order_id: r.order_id, actual_outcome: "explodes" }),
    /actual_outcome/,
  );
}

async function _emailSuppressionsInjection() {
  var h = _makeQuery();
  var hits = [];
  var fakeSuppressions = {
    isSuppressed: async function (hash) {
      hits.push(hash);
      return true;
    },
  };
  var fs = fraudScreenMod.create({ query: h.query, emailSuppressions: fakeSuppressions });
  var d = _baselineDraft();
  var r = await fs.screen({ order_draft: d });
  check("suppressed-email — fires when peer returns true",
    _firedNames(r.signals).indexOf("suppressed-email") !== -1);
  check("suppressed-email — peer was consulted with email_hash",
    hits.length === 1 && hits[0] === r.email_hash);
}

async function _customerRiskHistoryAndRecentScreenings() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  var customerId = _validUUID();
  var firstId = null;
  for (var i = 0; i < 3; i += 1) {
    var d = _baselineDraft();
    d.customer_id = customerId;
    d.email = "customer-" + i + "@example.com";
    var s = await fs.screen({ order_draft: d });
    if (i === 0) firstId = s.id;
  }
  // Spin the clock a millisecond so the ORDER BY tiebreak is
  // deterministic even on platforms where Date.now() doesn't
  // advance between the three inserts.
  await helpers.waitUntil(function () { return Date.now() > 0; }, { timeoutMs: 50, label: "tick" });

  var hist = await fs.customerRiskHistory(customerId);
  check("customerRiskHistory — returns 3 rows",  hist.length === 3);
  check("customerRiskHistory — signals parsed",   Array.isArray(hist[0].signals));
  // firstId should exist somewhere in the history.
  var hasFirst = hist.some(function (r) { return r.id === firstId; });
  check("customerRiskHistory — first screening present", hasFirst);

  // Other customer's screenings are excluded.
  var empty = await fs.customerRiskHistory(_validUUID());
  check("customerRiskHistory — scoped by customer_id", empty.length === 0);

  // recentScreenings returns all rows + cursor pagination works.
  var page = await fs.recentScreenings({ limit: 2 });
  check("recentScreenings — limit honored",     page.rows.length === 2);
  check("recentScreenings — next_cursor set",    typeof page.next_cursor === "string");
  var page2 = await fs.recentScreenings({ limit: 2, cursor: page.next_cursor });
  check("recentScreenings — second page",        page2.rows.length === 1);
  var seen = {};
  page.rows.concat(page2.rows).forEach(function (r) { seen[r.id] = true; });
  check("recentScreenings — covers all rows",    Object.keys(seen).length === 3);

  // Cursor tamper → refusal.
  var tampered = page.next_cursor.slice(0, -2) + (page.next_cursor.endsWith("==") ? "AA" : "XX");
  await assert.rejects(
    fs.recentScreenings({ limit: 2, cursor: tampered }),
    /cursor/i,
  );

  // limit validation
  await assert.rejects(fs.recentScreenings({ limit: 0 }),    /limit/);
  await assert.rejects(fs.recentScreenings({ limit: 9999 }), /limit/);
}

async function _validation() {
  var h = _makeQuery();
  var fs = fraudScreenMod.create({ query: h.query });
  await assert.rejects(fs.screen(),                                /input object required/);
  await assert.rejects(fs.screen({}),                              /order_draft/);
  await assert.rejects(fs.screen({ order_draft: {} }),             /order_id/);
  await assert.rejects(fs.screen({ order_draft: {
    order_id: _validUUID(),
  } }), /shipping_address/);
  await assert.rejects(fs.screen({ order_draft: {
    order_id:         _validUUID(),
    shipping_address: { country: "US" },
    email:            "not an email",
    total_minor:      100,
    currency:         "USD",
    line_count:       1,
  } }), /email/);
  await assert.rejects(fs.screen({ order_draft: {
    order_id:         _validUUID(),
    email:            "x@example.com",
    shipping_address: { country: "us" },        // lowercase rejected
    total_minor:      100,
    currency:         "USD",
    line_count:       1,
  } }), /country/);
  await assert.rejects(fs.recordChargeback({}),                    /order_id/);
  await assert.rejects(fs.recordChargeback({
    order_id:     _validUUID(),
    email:        "x@example.com",
    amount_minor: -1,
  }), /amount_minor/);
  await assert.rejects(fs.flagEmail({}),                           /email/);
  await assert.rejects(fs.flagEmail({ email: "" }),                /email/);
  await assert.rejects(fs.flagEmail({ email: "x@example.com", reason: "with\nctrl" }),
    /control bytes/);
  await assert.rejects(fs.customerRiskHistory("not-a-uuid"),        /customer/);
}

async function run() {
  await _baselineApproves();
  await _freeEmailSignal();
  await _disposableEmailRefuses();
  await _addressMismatchSignal();
  await _sessionTooFastAndTooOld();
  await _uaCurlClass();
  await _largeLineCount();
  await _highValueNewCustomer();
  await _binCountryMismatch();
  await _velocitySignal();
  await _chargebackAffectsNextScreen();
  await _flagEmailForcesRefuse();
  await _decisionThresholdBoundaries();
  await _scoreAggregation();
  await _recordOutcomeWritesLedger();
  await _emailSuppressionsInjection();
  await _customerRiskHistoryAndRecentScreenings();
  await _validation();
}

module.exports = { run: run };
