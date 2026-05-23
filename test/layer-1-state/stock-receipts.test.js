"use strict";
/**
 * stock-receipts — customer-facing scanned proof-of-receipt via QR
 * on a packing slip. Single-use plaintext-token issuance + scan
 * audit + per-line checklist FSM + completion summary composing the
 * optional loyaltyEarnRules handle.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0177.
 *
 * Coverage:
 *   - issueReceiptToken: plaintext token returned EXACTLY ONCE +
 *     storage row carries only the SHA3-512 hash; re-issuance
 *     replaces the row + line states; refuses re-issuance on a
 *     completed receipt
 *   - recordReceiptScan: FSM `issued -> scanned` on the first scan,
 *     subsequent scans append the event log without re-flipping;
 *     wrong token surfaces as not-found; expired/completed refused
 *   - markLineReceived / markLineDamaged: partial-quantity tracking,
 *     mixed states resolve to `partial`, refuses on receipts not yet
 *     scanned or already completed/expired
 *   - completeReceipt: FSM `scanned -> completed`, composes
 *     loyaltyEarnRules.evaluateForEvent with order_id keyed
 *     trigger_event_ref; failures are drop-silent
 *   - getReceiptByToken / receiptsForOrder / recentScans reads
 *   - factory refusals: bad order / loyaltyEarnRules shape
 *   - expired token refused at recordReceiptScan + at line marks
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var stockReceipts = require("../../lib/stock-receipts");
var bShop         = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0177_stock_receipts.sql");

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

// Simple loyaltyEarnRules stub — captures evaluateForEvent calls so
// the test can assert the composed payload shape without wiring the
// real primitive (which carries its own migration footprint).
function _loyaltyStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    evaluateForEvent: async function (input) {
      if (opts.fail) throw new Error("loyalty-down");
      calls.push(input);
      return { ok: true, points_awarded: opts.points == null ? 10 : opts.points };
    },
    calls: calls,
  };
}

function _orderId()    { return bShop.framework.uuid.v7(); }
function _customerId() { return bShop.framework.uuid.v7(); }

async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = stockReceipts.create({
    query:            q,
    loyaltyEarnRules: opts.loyaltyEarnRules || null,
  });
  return { q: q, svc: svc };
}

function _validLines() {
  return [
    { sku: "WDG-1", quantity_expected: 3 },
    { sku: "GZM-2", quantity_expected: 1 },
  ];
}

// ---- issueReceiptToken plaintext-once -----------------------------------

async function _issueReceiptTokenPlaintextOnce() {
  var w = await _wire();
  var orderId = _orderId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(),
  });
  check("issueReceiptToken returns receipt_id",     typeof issued.receipt_id === "string" && issued.receipt_id.length > 0);
  check("issueReceiptToken returns plaintext_token", typeof issued.plaintext_token === "string");
  check("issueReceiptToken plaintext length 43",    issued.plaintext_token.length === 43);
  check("issueReceiptToken plaintext shape",        /^[A-Za-z0-9_-]{43}$/.test(issued.plaintext_token));
  check("issueReceiptToken status issued",          issued.status === "issued");
  check("issueReceiptToken order_id round-trip",    issued.order_id === orderId);
  check("issueReceiptToken expires_at > issued_at", issued.expires_at > issued.issued_at);
  check("issueReceiptToken returns 2 lines",        issued.lines.length === 2);
  check("issueReceiptToken line 0 pending",         issued.lines[0].state === "pending");
  check("issueReceiptToken line 0 quantity",        issued.lines[0].quantity_expected === 3);

  // Storage row carries ONLY the hash — never the plaintext.
  var raw = w.q.__db.prepare("SELECT * FROM stock_receipt_tokens WHERE id = ?").get(issued.receipt_id);
  check("storage carries token_hash",           typeof raw.token_hash === "string" && raw.token_hash.length > 0);
  check("storage hash != plaintext",            raw.token_hash !== issued.plaintext_token);
  check("storage hash matches namespaceHash",   raw.token_hash ===
    bShop.framework.crypto.namespaceHash(stockReceipts.TOKEN_NAMESPACE, issued.plaintext_token));

  // Plaintext column does NOT exist on the row.
  var cols = w.q.__db.prepare("PRAGMA table_info(stock_receipt_tokens)").all();
  var colNames = cols.map(function (c) { return c.name; });
  check("no plaintext column on stock_receipt_tokens", colNames.indexOf("plaintext_token") === -1 &&
                                                       colNames.indexOf("token") === -1);

  // Re-issuance replaces the prior token + line states atomically. The
  // receipt_id is stable; the plaintext + hash rotate.
  var reIssued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: [{ sku: "WDG-1", quantity_expected: 5 }],
  });
  check("re-issuance returns same receipt_id",     reIssued.receipt_id === issued.receipt_id);
  check("re-issuance plaintext differs",           reIssued.plaintext_token !== issued.plaintext_token);
  var reRaw = w.q.__db.prepare("SELECT * FROM stock_receipt_tokens WHERE id = ?").get(issued.receipt_id);
  check("re-issuance hash differs",                reRaw.token_hash !== raw.token_hash);
  check("re-issuance line states replaced",        reIssued.lines.length === 1 && reIssued.lines[0].quantity_expected === 5);

  // Old plaintext token no longer matches.
  await assert.rejects(
    w.svc.recordReceiptScan({ token: issued.plaintext_token }),
    function (err) { return err && err.code === "STOCK_RECEIPT_NOT_FOUND"; },
  );
}

// ---- recordReceiptScan FSM ----------------------------------------------

async function _recordReceiptScanFsm() {
  var w = await _wire();
  var orderId = _orderId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(),
  });

  // First scan flips FSM `issued -> scanned`.
  var scan1 = await w.svc.recordReceiptScan({
    token: issued.plaintext_token,
    user_agent: "Mozilla/5.0 (iPhone)",
    client_ip:  "203.0.113.4",
  });
  check("first scan returns scan_id",        typeof scan1.scan_id === "string" && scan1.scan_id.length > 0);
  check("first scan flips FSM",              scan1.receipt.status === "scanned");
  check("first scan stamps first_scanned_at", typeof scan1.receipt.first_scanned_at === "number" &&
                                              scan1.receipt.first_scanned_at > 0);

  // UA + IP hashed (never stored plaintext).
  var raw1 = w.q.__db.prepare("SELECT * FROM stock_receipt_scans WHERE id = ?").get(scan1.scan_id);
  check("user_agent_hash not raw",           raw1.user_agent_hash != null &&
                                             raw1.user_agent_hash !== "Mozilla/5.0 (iPhone)");
  check("client_ip_hash not raw",            raw1.client_ip_hash != null &&
                                             raw1.client_ip_hash !== "203.0.113.4");

  // Subsequent scan appends without re-flipping (sticky timestamp).
  var firstAt = scan1.receipt.first_scanned_at;
  var scan2 = await w.svc.recordReceiptScan({ token: issued.plaintext_token });
  check("second scan keeps status scanned",  scan2.receipt.status === "scanned");
  check("second scan keeps first_scanned_at", scan2.receipt.first_scanned_at === firstAt);
  check("second scan distinct scan_id",      scan2.scan_id !== scan1.scan_id);

  // Wrong token surfaces as not-found (constant-time compare).
  var bogus = "A".repeat(43);
  await assert.rejects(
    w.svc.recordReceiptScan({ token: bogus }),
    function (err) { return err && err.code === "STOCK_RECEIPT_NOT_FOUND"; },
  );

  // Bad token shape rejected at the validator.
  await assert.rejects(w.svc.recordReceiptScan({ token: "short" }),       /token/);
  await assert.rejects(w.svc.recordReceiptScan({ token: "" }),            /token/);
  await assert.rejects(w.svc.recordReceiptScan(),                          /input object required/);
}

// ---- markLineReceived ---------------------------------------------------

async function _markLineReceived() {
  var w = await _wire();
  var orderId = _orderId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(),
  });

  // Cannot mark before scan.
  await assert.rejects(
    w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "WDG-1" }),
    /must scan the QR/,
  );

  await w.svc.recordReceiptScan({ token: issued.plaintext_token });

  // Default qty == expected; line becomes `received`.
  var r1 = await w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "WDG-1" });
  var line1 = r1.lines.filter(function (l) { return l.sku === "WDG-1"; })[0];
  check("markLineReceived state received",        line1.state === "received");
  check("markLineReceived qty defaults expected", line1.quantity_received === 3);

  // Partial qty -> `partial`.
  var r2 = await w.svc.markLineReceived({
    receipt_id: issued.receipt_id, sku: "GZM-2", quantity_received: 0,
  });
  var line2 = r2.lines.filter(function (l) { return l.sku === "GZM-2"; })[0];
  // received == 0 and damaged == 0 — should be partial (not yet received)
  check("markLineReceived zero qty partial",      line2.state === "partial");
  check("markLineReceived qty 0 captured",        line2.quantity_received === 0);

  // Over-quantity refused.
  await assert.rejects(
    w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "WDG-1", quantity_received: 99 }),
    /exceeds quantity_expected/,
  );

  // Unknown sku refused.
  await assert.rejects(
    w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "UNKNOWN" }),
    /not in the receipt's line set/,
  );

  // Validation surface.
  await assert.rejects(w.svc.markLineReceived(),                                          /input object required/);
  await assert.rejects(w.svc.markLineReceived({ receipt_id: "x", sku: "WDG-1" }),         /receipt_id/);
  await assert.rejects(w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "!!" }), /sku/);
}

// ---- markLineDamaged ----------------------------------------------------

async function _markLineDamaged() {
  var w = await _wire();
  var orderId = _orderId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(),
  });
  await w.svc.recordReceiptScan({ token: issued.plaintext_token });

  // Full damage of a line.
  var r1 = await w.svc.markLineDamaged({
    receipt_id: issued.receipt_id, sku: "GZM-2",
    reason: "Box crushed in transit, item bent.",
  });
  var line2 = r1.lines.filter(function (l) { return l.sku === "GZM-2"; })[0];
  check("markLineDamaged state damaged",     line2.state === "damaged");
  check("markLineDamaged qty defaults expected", line2.quantity_damaged === 1);
  check("markLineDamaged reason captured",   line2.damage_reason === "Box crushed in transit, item bent.");

  // Mixed: 2 received + 1 damaged of a 3-line -> `partial`.
  await w.svc.markLineReceived({
    receipt_id: issued.receipt_id, sku: "WDG-1", quantity_received: 2,
  });
  var r2 = await w.svc.markLineDamaged({
    receipt_id: issued.receipt_id, sku: "WDG-1", quantity_damaged: 1,
    reason: "One unit's packaging torn.",
  });
  var mixed = r2.lines.filter(function (l) { return l.sku === "WDG-1"; })[0];
  check("mixed state partial",               mixed.state === "partial");
  check("mixed received tracked",            mixed.quantity_received === 2);
  check("mixed damaged tracked",             mixed.quantity_damaged === 1);

  // Over-quantity refused.
  await assert.rejects(
    w.svc.markLineDamaged({
      receipt_id: issued.receipt_id, sku: "WDG-1", quantity_damaged: 99,
      reason: "Whole package lost.",
    }),
    /exceeds quantity_expected/,
  );

  // received + damaged > expected refused. WDG-1 currently has
  // received=2, damaged=1 (expected=3). Asking damaged=3 would push
  // received(2) + damaged(3) = 5 > expected(3).
  await assert.rejects(
    w.svc.markLineDamaged({
      receipt_id: issued.receipt_id, sku: "WDG-1", quantity_damaged: 3,
      reason: "Try to over-mark beyond received.",
    }),
    /exceeds quantity_expected/,
  );

  // Validation surface.
  await assert.rejects(w.svc.markLineDamaged(),                                            /input object required/);
  await assert.rejects(
    w.svc.markLineDamaged({ receipt_id: issued.receipt_id, sku: "WDG-1" }),
    /reason/,
  );
  await assert.rejects(
    w.svc.markLineDamaged({ receipt_id: issued.receipt_id, sku: "WDG-1", reason: "" }),
    /reason/,
  );
}

// ---- completeReceipt composes loyaltyEarnRules --------------------------

async function _completeReceiptComposesLoyalty() {
  var loy = _loyaltyStub();
  var w = await _wire({ loyaltyEarnRules: loy });
  var orderId    = _orderId();
  var customerId = _customerId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(),
  });
  await w.svc.recordReceiptScan({ token: issued.plaintext_token });
  await w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "WDG-1" });
  await w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "GZM-2" });

  // Cannot complete a not-scanned receipt — already covered by FSM
  // guard; here we cover the happy path.
  var done = await w.svc.completeReceipt({
    receipt_id: issued.receipt_id, customer_id: customerId,
  });
  check("completeReceipt status completed",          done.receipt.status === "completed");
  check("completeReceipt stamps completed_at",       typeof done.receipt.completed_at === "number" &&
                                                     done.receipt.completed_at > 0);
  check("completeReceipt summary lines",             done.summary.total_lines === 2);
  check("completeReceipt summary received_lines",    done.summary.received_lines === 2);
  check("completeReceipt summary total_qty_received", done.summary.total_quantity_received === 4);

  // loyaltyEarnRules composed.
  check("loyalty evaluateForEvent called",           loy.calls.length === 1);
  check("loyalty trigger per_purchase",              loy.calls[0].trigger === "per_purchase");
  check("loyalty customer_id forwarded",             loy.calls[0].customer_id === customerId);
  check("loyalty dedup key keyed by order_id",       loy.calls[0].trigger_event_ref === "stock-receipt:" + orderId);
  check("loyalty metadata order_id",                 loy.calls[0].metadata.order_id === orderId);
  check("loyalty_result attached",                   done.loyalty_result && done.loyalty_result.ok === true);

  // Re-complete refused.
  await assert.rejects(
    w.svc.completeReceipt({ receipt_id: issued.receipt_id, customer_id: customerId }),
    function (err) { return err && err.code === "STOCK_RECEIPT_COMPLETED"; },
  );

  // Re-issuance on completed refused.
  await assert.rejects(
    w.svc.issueReceiptToken({ order_id: orderId, lines: _validLines() }),
    /completed receipt/,
  );

  // Mark on completed refused.
  await assert.rejects(
    w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "WDG-1" }),
    /receipt status is completed/,
  );

  // loyalty drop-silent on failure.
  var loyFail = _loyaltyStub({ fail: true });
  var w2 = await _wire({ loyaltyEarnRules: loyFail });
  var issued2 = await w2.svc.issueReceiptToken({
    order_id: _orderId(), lines: _validLines(),
  });
  await w2.svc.recordReceiptScan({ token: issued2.plaintext_token });
  await w2.svc.markLineReceived({ receipt_id: issued2.receipt_id, sku: "WDG-1" });
  await w2.svc.markLineReceived({ receipt_id: issued2.receipt_id, sku: "GZM-2" });
  var done2 = await w2.svc.completeReceipt({
    receipt_id: issued2.receipt_id, customer_id: _customerId(),
  });
  check("completion survives loyalty failure",       done2.receipt.status === "completed");
  check("loyalty_result null on failure",            done2.loyalty_result === null);

  // No customer_id -> no loyalty call attempted.
  var loy3 = _loyaltyStub();
  var w3 = await _wire({ loyaltyEarnRules: loy3 });
  var issued3 = await w3.svc.issueReceiptToken({
    order_id: _orderId(), lines: [{ sku: "WDG-1", quantity_expected: 1 }],
  });
  await w3.svc.recordReceiptScan({ token: issued3.plaintext_token });
  await w3.svc.markLineReceived({ receipt_id: issued3.receipt_id, sku: "WDG-1" });
  var done3 = await w3.svc.completeReceipt({ receipt_id: issued3.receipt_id });
  check("no customer_id skips loyalty",              loy3.calls.length === 0);
  check("completion still lands without customer",   done3.receipt.status === "completed");
}

// ---- expired token refused ----------------------------------------------

async function _expiredTokenRefused() {
  var w = await _wire();
  var orderId = _orderId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(), expires_in_hours: 1,
  });

  // Hand-stamp expires_at into the past.
  w.q.__db.prepare("UPDATE stock_receipt_tokens SET expires_at = ? WHERE id = ?")
       .run(Date.now() - 1000, issued.receipt_id);

  // recordReceiptScan refused with expired code.
  await assert.rejects(
    w.svc.recordReceiptScan({ token: issued.plaintext_token }),
    function (err) { return err && err.code === "STOCK_RECEIPT_EXPIRED"; },
  );

  // Hand-flip status to `scanned` to set up the post-scan path.
  w.q.__db.prepare(
    "UPDATE stock_receipt_tokens SET status = 'scanned', first_scanned_at = ? WHERE id = ?",
  ).run(Date.now() - 500, issued.receipt_id);

  // markLineReceived refused on expired (the FSM allows `scanned` but
  // the freshness guard intercepts).
  await assert.rejects(
    w.svc.markLineReceived({ receipt_id: issued.receipt_id, sku: "WDG-1" }),
    /or expired/,
  );

  // completeReceipt refused on expired.
  await assert.rejects(
    w.svc.completeReceipt({ receipt_id: issued.receipt_id }),
    function (err) { return err && err.code === "STOCK_RECEIPT_EXPIRED"; },
  );
}

// ---- reads (getReceiptByToken / receiptsForOrder / recentScans) ---------

async function _reads() {
  var w = await _wire();
  var orderId = _orderId();
  var issued = await w.svc.issueReceiptToken({
    order_id: orderId, lines: _validLines(),
  });

  // getReceiptByToken hits.
  var got = await w.svc.getReceiptByToken(issued.plaintext_token);
  check("getReceiptByToken returns receipt",   got && got.id === issued.receipt_id);
  check("getReceiptByToken returns lines",     got.lines.length === 2);

  // Wrong token -> null.
  var miss = await w.svc.getReceiptByToken("Z".repeat(43));
  check("getReceiptByToken miss returns null", miss === null);

  // Bad token shape -> throw.
  await assert.rejects(w.svc.getReceiptByToken("bad"),                                    /token/);

  // receiptsForOrder hits + miss.
  var hits = await w.svc.receiptsForOrder(orderId);
  check("receiptsForOrder returns 1",          hits.length === 1 && hits[0].order_id === orderId);
  var none = await w.svc.receiptsForOrder(_orderId());
  check("receiptsForOrder miss returns []",    Array.isArray(none) && none.length === 0);

  // recentScans (none yet).
  var empty = await w.svc.recentScans();
  check("recentScans empty",                   Array.isArray(empty) && empty.length === 0);

  // Scan twice; recentScans returns both.
  await w.svc.recordReceiptScan({ token: issued.plaintext_token });
  await w.svc.recordReceiptScan({ token: issued.plaintext_token });
  var scans = await w.svc.recentScans({ limit: 10 });
  check("recentScans returns 2",               scans.length === 2);
  check("recentScans ordered desc",            scans[0].scanned_at >= scans[1].scanned_at);

  // recentScans filtered by receipt_id.
  var byReceipt = await w.svc.recentScans({ receipt_id: issued.receipt_id });
  check("recentScans by receipt_id",           byReceipt.length === 2 &&
                                               byReceipt[0].receipt_id === issued.receipt_id);

  // recentScans validation.
  await assert.rejects(w.svc.recentScans({ limit: 0 }),                                   /limit/);
  await assert.rejects(w.svc.recentScans({ receipt_id: "x" }),                            /receipt_id/);
}

// ---- factory refusals ---------------------------------------------------

async function _factoryRefusals() {
  // loyaltyEarnRules without evaluateForEvent refused.
  assert.throws(function () {
    stockReceipts.create({ query: function () {}, loyaltyEarnRules: {} });
  }, /evaluateForEvent/);

  // order without getById refused.
  assert.throws(function () {
    stockReceipts.create({ query: function () {}, order: { transition: function () {} } });
  }, /getById/);

  // issueReceiptToken validation.
  var w = await _wire();
  await assert.rejects(w.svc.issueReceiptToken(),                                          /input object required/);
  await assert.rejects(w.svc.issueReceiptToken({ order_id: "x", lines: _validLines() }),    /order_id/);
  await assert.rejects(w.svc.issueReceiptToken({
    order_id: _orderId(), lines: [],
  }),                                                                                       /non-empty array/);
  await assert.rejects(w.svc.issueReceiptToken({
    order_id: _orderId(), lines: [{ sku: "WDG-1", quantity_expected: 0 }],
  }),                                                                                       /quantity_expected/);
  await assert.rejects(w.svc.issueReceiptToken({
    order_id: _orderId(),
    lines: [{ sku: "WDG-1", quantity_expected: 1 }, { sku: "WDG-1", quantity_expected: 1 }],
  }),                                                                                       /duplicates a previous entry/);
  await assert.rejects(w.svc.issueReceiptToken({
    order_id: _orderId(), lines: _validLines(), expires_in_hours: 0,
  }),                                                                                       /expires_in_hours/);
  await assert.rejects(w.svc.issueReceiptToken({
    order_id: _orderId(), lines: _validLines(), expires_in_hours: 999999,
  }),                                                                                       /expires_in_hours/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("RECEIPT_STATUSES exported",       Array.isArray(stockReceipts.RECEIPT_STATUSES)
                                            && stockReceipts.RECEIPT_STATUSES.indexOf("issued") !== -1
                                            && stockReceipts.RECEIPT_STATUSES.indexOf("scanned") !== -1
                                            && stockReceipts.RECEIPT_STATUSES.indexOf("completed") !== -1
                                            && stockReceipts.RECEIPT_STATUSES.indexOf("expired") !== -1);
  check("LINE_STATES exported",            Array.isArray(stockReceipts.LINE_STATES)
                                            && stockReceipts.LINE_STATES.indexOf("pending") !== -1
                                            && stockReceipts.LINE_STATES.indexOf("received") !== -1);
  check("TOKEN_NAMESPACE exported",        typeof stockReceipts.TOKEN_NAMESPACE === "string"
                                            && stockReceipts.TOKEN_NAMESPACE.length > 0);
  check("TOKEN_PLAINTEXT_LEN 43",          stockReceipts.TOKEN_PLAINTEXT_LEN === 43);
  check("DEFAULT_EXPIRES_HOURS exported",  typeof stockReceipts.DEFAULT_EXPIRES_HOURS === "number");

  var inst = stockReceipts.create({ query: _makeQuery() });
  check("instance exposes RECEIPT_STATUSES", inst.RECEIPT_STATUSES.length === stockReceipts.RECEIPT_STATUSES.length);
  check("instance exposes LINE_STATES",      inst.LINE_STATES.length === stockReceipts.LINE_STATES.length);
}

async function run() {
  await _issueReceiptTokenPlaintextOnce();
  await _recordReceiptScanFsm();
  await _markLineReceived();
  await _markLineDamaged();
  await _completeReceiptComposesLoyalty();
  await _expiredTokenRefused();
  await _reads();
  await _factoryRefusals();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("ok - stock-receipts (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
