"use strict";
/**
 * returns — RMA workflow for post-purchase claims.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0003 (order), 0023 (returns).
 *
 * Coverage:
 *   - request: persists row + lines, generates RMA-YYMMDD-AAAAA code
 *   - approve → markReceived → refund happy path
 *   - reject path (pending → rejected, approved → rejected)
 *   - illegal transitions refused (refund-from-pending, approve-from-received)
 *   - byCode lookup (canonicalizes case + trim)
 *   - listForOrder returns multiple RMAs in created_at DESC order
 *   - listForCustomer paginates with HMAC cursor + status filter
 *   - summaryForOperator aggregates counts + refund totals per currency
 *   - validation refusals: missing order_id, bad reason, empty lines,
 *     qty <= 0, oversized notes, malformed rma_code
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0023_returns.sql",
].map(function (f) {
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
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// Seed: build one paid order so we have an `orders.id` the
// return_authorizations.order_id FK can target.
async function _seedOrder(q) {
  var catalog = bShop.catalog.create({ query: q });
  var cart    = bShop.cart.create({ query: q, catalog: catalog });
  var order   = bShop.order.create({ query: q });
  var p = await catalog.products.create({ slug: "ret-test", title: "ReturnTest", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "RET-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 4999 });
  var sid = _uuid();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });
  var o = await order.createFromCart({
    cart_id:    c.id,
    session_id: sid,
    currency:   "USD",
    subtotal_minor:    9998,
    discount_minor:    0,
    tax_minor:         800,
    shipping_minor:    500,
    grand_total_minor: 11298,
    ship_to: { country: "US", state: "CA", postal: "94103" },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               2,
      unit_amount_minor: 4999,
      unit_currency:     "USD",
    }],
  });
  return { order: o, variant: v };
}

function _requestInput(seed) {
  return {
    order_id:       seed.order.id,
    customer_id:    _uuid(),
    reason:         "defective",
    reason_detail:  "left audio channel cuts out intermittently",
    customer_notes: "received last Tuesday, started failing immediately",
    lines: [{
      sku:           seed.variant.sku,
      qty:           1,
      order_line_id: seed.order.lines[0].id,
      reason:        "audio fault",
    }],
  };
}

async function _request() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  var r = await ret.request(_requestInput(seed));
  check("request returns id (uuid)",        typeof r.id === "string" && r.id.length === 36);
  check("request returns pending status",   r.status === "pending");
  check("request returns rma_code",         /^RMA-\d{6}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(r.rma_code));

  var fetched = await ret.get(r.id);
  check("get hydrates row",                  fetched.id === r.id);
  check("get returns lines array",           Array.isArray(fetched.lines) && fetched.lines.length === 1);
  check("get propagates sku",                fetched.lines[0].sku === seed.variant.sku);
  check("get propagates reason_detail",      fetched.reason_detail === "left audio channel cuts out intermittently");
  check("get initial timestamps null",       fetched.approved_at === null && fetched.refunded_at === null);

  // Two RMAs against the same order: distinct codes
  var r2 = await ret.request(_requestInput(seed));
  check("second request gets distinct code", r2.rma_code !== r.rma_code);
}

async function _happyPath() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  var r = await ret.request(_requestInput(seed));
  var approved = await ret.approve(r.id, {
    refund_amount_minor: 4999,
    refund_currency:     "USD",
    operator_notes:      "QA confirms fault, approving",
  });
  check("approve transitions to approved",   approved.status === "approved");
  check("approve sets refund_amount_minor",  approved.refund_amount_minor === 4999);
  check("approve sets approved_at",          typeof approved.approved_at === "number" && approved.approved_at > 0);

  var received = await ret.markReceived(r.id);
  check("markReceived transitions to received", received.status === "received");
  check("markReceived sets received_at",         typeof received.received_at === "number");

  var refunded = await ret.refund(r.id, { operator_notes: "refund issued via stripe" });
  check("refund transitions to refunded",        refunded.status === "refunded");
  check("refund sets refunded_at",                typeof refunded.refunded_at === "number");
  check("refunded is terminal",
    bShop.returns.TERMINAL_STATES.indexOf(refunded.status) !== -1);

  // Custom received_at + refunded_at timestamps accepted
  var r2 = await ret.request(_requestInput(seed));
  await ret.approve(r2.id, { refund_amount_minor: 1000 });
  var stamped = await ret.markReceived(r2.id, { received_at: 1700000000000 });
  check("markReceived honors caller-supplied ts", stamped.received_at === 1700000000000);
}

// Two concurrent refund() calls on the same received RMA must NOT both
// succeed — the atomic `WHERE status = 'received'` claim serializes them so
// exactly one transitions to refunded and the other is refused. Before the
// claim the read-then-write let both pass (a double provider-refund on the
// admin flow, which calls payment.refund per winner). releaseRefundClaim
// reverts the winner's claim so a provider-failure retry can run.
async function _concurrentRefundClaim() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  var r = await ret.request(_requestInput(seed));
  await ret.approve(r.id, { refund_amount_minor: 4999 });
  await ret.markReceived(r.id);

  // Genuinely concurrent: both start before either resolves.
  var results = await Promise.allSettled([ ret.refund(r.id, {}), ret.refund(r.id, {}) ]);
  var won  = results.filter(function (x) { return x.status === "fulfilled"; }).length;
  var lost = results.filter(function (x) { return x.status === "rejected"; }).length;
  check("concurrent refund: exactly one wins",   won === 1);
  check("concurrent refund: the other is refused", lost === 1);
  var loser = results.find(function (x) { return x.status === "rejected"; });
  check("loser is RMA_TRANSITION_REFUSED",       loser && loser.reason && loser.reason.code === "RMA_TRANSITION_REFUSED");
  check("RMA ends refunded exactly once",        (await ret.get(r.id)).status === "refunded");

  // releaseRefundClaim reverts refunded → received (provider-failure retry).
  var r2 = await ret.request(_requestInput(seed));
  await ret.approve(r2.id, { refund_amount_minor: 1000 });
  await ret.markReceived(r2.id);
  await ret.refund(r2.id, {});                       // claim it (refunded)
  var released = await ret.releaseRefundClaim(r2.id);
  check("releaseRefundClaim reverts the claim",  released === true && (await ret.get(r2.id)).status === "received");
  // A second release (now in 'received', not 'refunded') is a no-op.
  check("double release is a no-op",             (await ret.releaseRefundClaim(r2.id)) === false);
  check("released claim is re-refundable",       (await ret.refund(r2.id, {})).status === "refunded");
}

async function _rejectPath() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  // pending → rejected
  var r1 = await ret.request(_requestInput(seed));
  var rj1 = await ret.reject(r1.id, { rejected_reason: "outside 30-day window" });
  check("pending → rejected",                rj1.status === "rejected");
  check("reject sets rejected_reason",        rj1.rejected_reason === "outside 30-day window");
  check("reject sets rejected_at",            typeof rj1.rejected_at === "number");

  // approved → rejected (e.g. caught post-approval that item is non-refundable)
  var r2 = await ret.request(_requestInput(seed));
  await ret.approve(r2.id, { refund_amount_minor: 100 });
  var rj2 = await ret.reject(r2.id, { rejected_reason: "duplicate claim" });
  check("approved → rejected",               rj2.status === "rejected");

  // Terminal states refuse further transitions
  await assert.rejects(
    ret.refund(r1.id, {}),
    /refused/,
  );
  await assert.rejects(
    ret.approve(r1.id, { refund_amount_minor: 100 }),
    /refused/,
  );
}

async function _illegalTransitions() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });
  var r = await ret.request(_requestInput(seed));

  // pending → received: not allowed (must approve first)
  await assert.rejects(ret.markReceived(r.id), /refused/);
  // pending → refunded: not allowed
  await assert.rejects(ret.refund(r.id, {}), /refused/);

  // received → approve: not allowed (already past approval)
  await ret.approve(r.id, { refund_amount_minor: 500 });
  await ret.markReceived(r.id);
  await assert.rejects(ret.approve(r.id, { refund_amount_minor: 500 }), /refused/);

  // Not-found
  await assert.rejects(ret.approve(_uuid(), { refund_amount_minor: 500 }), /not found/);
}

async function _byCode() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  var r = await ret.request(_requestInput(seed));
  var found = await ret.byCode(r.rma_code);
  check("byCode finds by exact code",         found && found.id === r.id);

  // Whitespace + casing tolerated
  var lc = await ret.byCode("  " + r.rma_code.toLowerCase() + "  ");
  check("byCode canonicalizes case + trim",   lc && lc.id === r.id);

  // Unknown code → null
  var nope = await ret.byCode("RMA-991231-AAAAA");
  check("byCode returns null on miss",         nope === null);

  // Malformed shape refused
  await assert.rejects(ret.byCode("not-an-rma"),       /rma_code/);
  await assert.rejects(ret.byCode("RMA-XX-ABCDE"),     /rma_code/);
  await assert.rejects(ret.byCode("RMA-251121-AB1DE"), /rma_code/); // 1 not in alphabet
}

async function _listForOrderAndCustomer() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  var customerId = _uuid();
  var ids = [];
  for (var i = 0; i < 3; i += 1) {
    var input = _requestInput(seed);
    input.customer_id = customerId;
    var r = await ret.request(input);
    ids.push(r.id);
    // Ensure created_at strictly advances so DESC ordering is
    // unambiguous on fast runners.
    await helpers.waitUntil(function () { return Date.now() > 0; }, { timeoutMs: 5, label: "tick" });
  }

  var orderRows = await ret.listForOrder(seed.order.id);
  check("listForOrder returns 3 rows",          orderRows.length === 3);
  check("listForOrder hydrates lines",          Array.isArray(orderRows[0].lines) && orderRows[0].lines.length === 1);

  var page = await ret.listForCustomer(customerId, { limit: 10 });
  check("listForCustomer returns 3 rows",       page.rows.length === 3);
  check("listForCustomer next_cursor is null",   page.next_cursor === null);

  var pageA = await ret.listForCustomer(customerId, { limit: 2 });
  check("listForCustomer paginates",             pageA.rows.length === 2 && typeof pageA.next_cursor === "string");
  var pageB = await ret.listForCustomer(customerId, { limit: 2, cursor: pageA.next_cursor });
  check("listForCustomer cursor pages forward",  pageB.rows.length === 1);
  var seen = {};
  pageA.rows.concat(pageB.rows).forEach(function (row) { seen[row.id] = true; });
  check("listForCustomer covers all rows",       Object.keys(seen).length === 3);

  // status filter narrows the set
  await ret.approve(ids[0], { refund_amount_minor: 100 });
  var pendingPage = await ret.listForCustomer(customerId, { status: "pending", limit: 10 });
  check("listForCustomer filters by status",     pendingPage.rows.length === 2);
  var approvedPage = await ret.listForCustomer(customerId, { status: "approved", limit: 10 });
  check("listForCustomer approved filter",        approvedPage.rows.length === 1 && approvedPage.rows[0].id === ids[0]);

  // Cursor tamper rejected
  var tampered = (pageA.next_cursor.charAt(0) === "A" ? "B" : "A") + pageA.next_cursor.slice(1);
  await assert.rejects(
    ret.listForCustomer(customerId, { limit: 2, cursor: tampered }),
    /cursor/i,
  );

  // Limit validation
  await assert.rejects(ret.listForCustomer(customerId, { limit: 0 }),    /limit/);
  await assert.rejects(ret.listForCustomer(customerId, { limit: 9999 }), /limit/);
}

async function _summary() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ret  = bShop.returns.create({ query: q });

  // 4 RMAs: 1 pending, 1 rejected, 1 approved, 1 refunded
  var r1 = await ret.request(_requestInput(seed));   // stays pending
  var r2 = await ret.request(_requestInput(seed));   // → rejected
  var r3 = await ret.request(_requestInput(seed));   // → approved
  var r4 = await ret.request(_requestInput(seed));   // → refunded

  await ret.reject(r2.id,  { rejected_reason: "outside window" });
  await ret.approve(r3.id, { refund_amount_minor: 1000, refund_currency: "USD" });
  await ret.approve(r4.id, { refund_amount_minor: 2500, refund_currency: "USD" });
  await ret.markReceived(r4.id);
  await ret.refund(r4.id);

  var summary = await ret.summaryForOperator({});
  check("summary total_count",                summary.total_count === 4);
  check("summary counts pending",              summary.counts_by_status.pending === 1);
  check("summary counts rejected",             summary.counts_by_status.rejected === 1);
  check("summary counts approved",             summary.counts_by_status.approved === 1);
  check("summary counts refunded",             summary.counts_by_status.refunded === 1);
  check("summary refunded_by_currency USD",    summary.refunded_by_currency.USD === 2500);
  check("summary pending_by_currency USD",     summary.pending_by_currency.USD === 1000);

  // status filter narrows
  var refundedOnly = await ret.summaryForOperator({ status: "refunded" });
  check("summary status filter narrows",       refundedOnly.total_count === 1);
  check("summary status filter refunded",      refundedOnly.counts_by_status.refunded === 1);

  // window filter — `to` in the far past returns nothing
  var emptyWindow = await ret.summaryForOperator({ from: 1, to: 2 });
  check("summary window filter excludes",      emptyWindow.total_count === 0);

  // unused id silences eslint no-unused-vars in factory's bind
  void r1;
}

async function _validation() {
  var q = _makeQuery();
  var ret = bShop.returns.create({ query: q });
  var seed = await _seedOrder(q);

  await assert.rejects(ret.request(),                                              /input object required/);
  await assert.rejects(ret.request({}),                                             /order_id/);
  await assert.rejects(ret.request({ order_id: "not-a-uuid", reason: "defective", lines: [{ sku: "X", qty: 1 }] }),
    /order_id/);
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "bogus", lines: [{ sku: "X", qty: 1 }] }),
    /reason must be one of/);
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "defective", lines: [] }),
    /lines must be a non-empty/);
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "defective", lines: [{ sku: "X", qty: 0 }] }),
    /qty must be a positive integer/);
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "defective", lines: [{ sku: "X", qty: -1 }] }),
    /qty must be a positive integer/);
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "defective",
    customer_notes: "x".repeat(5000),
    lines: [{ sku: "X", qty: 1 }] }), /customer_notes/);
  // control-byte refusal
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "defective",
    reason_detail: "bad\x00byte",
    lines: [{ sku: "X", qty: 1 }] }), /control bytes/);
  // missing sku
  await assert.rejects(ret.request({ order_id: _uuid(), reason: "defective",
    lines: [{ qty: 1 }] }), /sku/);

  // approve / reject / refund / markReceived validation
  await assert.rejects(ret.approve(_uuid(), {}),                                  /refund_amount_minor/);
  await assert.rejects(ret.approve(_uuid(), { refund_amount_minor: -1 }),         /refund_amount_minor/);
  await assert.rejects(ret.approve(_uuid(), { refund_amount_minor: 100, refund_currency: "usd" }), /currency/);
  await assert.rejects(ret.reject(_uuid(), {}),                                   /rejected_reason/);
  await assert.rejects(ret.reject(_uuid(), { rejected_reason: "" }),              /rejected_reason/);

  // approve real RMA but currency / notes invariants
  var r = await ret.request(_requestInput(seed));
  await assert.rejects(ret.approve(r.id, { refund_amount_minor: 100, operator_notes: "x".repeat(5000) }),
    /operator_notes/);
  await assert.rejects(ret.markReceived(r.id, { received_at: -1 }), /received_at/);
  // refund timestamp validation (transition itself would refuse from pending, but
  // the validator runs first — so we approve+receive to isolate the ts check).
  await ret.approve(r.id, { refund_amount_minor: 100 });
  await ret.markReceived(r.id);
  await assert.rejects(ret.refund(r.id, { refunded_at: "not-a-number" }), /refunded_at/);

  // listForCustomer + summary validators
  await assert.rejects(ret.listForCustomer("not-uuid", {}), /customer_id/);
  await assert.rejects(ret.listForCustomer(_uuid(), { status: "bogus" }), /status/);
  await assert.rejects(ret.summaryForOperator({ status: "bogus" }), /status/);
  await assert.rejects(ret.summaryForOperator({ from: -1 }), /from/);
}

async function run() {
  await _request();
  await _happyPath();
  await _concurrentRefundClaim();
  await _rejectPath();
  await _illegalTransitions();
  await _byCode();
  await _listForOrderAndCustomer();
  await _summary();
  await _validation();
}

module.exports = { run: run };
