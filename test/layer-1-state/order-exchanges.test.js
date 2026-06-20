"use strict";
/**
 * order-exchanges — customer-requested item swap FSM.
 *
 * Layer 1 against in-memory node:sqlite with migration 0164 loaded.
 * The optional dependencies (returns / order / inventoryAllocations)
 * are all stubbed locally so this test exercises the primitive in
 * isolation.
 *
 * Coverage:
 *   - requestExchange happy path + refusals (bad UUID, bad SKU, bad
 *     reason, bad qty, missing input object)
 *   - approveExchange happy path + records approver_id + opens an
 *     inventory hold via the injected stub
 *   - approveExchange hold failure rolls back (row stays pending)
 *   - rejectExchange from pending + from approved + records the
 *     reject_reason + refuses from terminal states
 *   - FSM walks the two arrival orderings (delivered-first then
 *     received-then-close, AND received-first then delivered-then-close)
 *   - closeExchange refuses when only one side has timestamps
 *   - markReplacementShipped captures tracking_number + carrier
 *   - exchangesForOrder + exchangesForCustomer + openExchanges +
 *     metricsForPeriod shape
 *   - factory refusals for malformed injected handles
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var orderExchanges = require("../../lib/order-exchanges");
var bShop          = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0164_order_exchanges.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  // The migration FK references `orders(id)`. Node's node:sqlite
  // refuses to CREATE a table whose FOREIGN KEY points at a missing
  // parent (and to INSERT against an FK whose parent row is absent),
  // so we stub a minimal `orders` table + disable FK enforcement for
  // the isolated layer-1 test. The full migration chain (with the
  // real orders table + FK enforcement) runs in the smoke suite.
  db.prepare("CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY)").run();
  db.prepare("PRAGMA foreign_keys = OFF").run();
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

function _uuid() { return bShop.framework.uuid.v7(); }

// inventoryAllocations stub — captures holdForCart calls so the test
// can assert the SKU + variant + qty without wiring the real
// allocations primitive (which carries its own migration footprint).
function _invAllocsStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    holdForCart: async function (input) {
      if (opts.fail) {
        var e = new Error("hold-failed: insufficient stock");
        e.code = "ALLOC_INSUFFICIENT";
        throw e;
      }
      calls.push(input);
      return {
        id:           "hold-" + (calls.length),
        cart_id:      input.cart_id,
        sku:          input.sku,
        quantity:     input.quantity,
        status:       "held",
      };
    },
    calls: calls,
  };
}

// order stub — answers listForCustomer from an operator-supplied map +
// exposes get() so the factory shape gate passes.
function _orderStub(opts) {
  opts = opts || {};
  var byCustomer = opts.byCustomer || {};
  return {
    get: async function (id) { return { id: id }; },
    listForCustomer: async function (customerId /* , listOpts */) {
      var rows = byCustomer[customerId] || [];
      return { rows: rows, next_cursor: null };
    },
  };
}

// returns stub — exposes request so the factory shape gate passes;
// the primitive itself never calls into this in v1, but operators
// composing both surfaces verify the wiring at boot.
function _returnsStub() {
  return {
    request: async function (input) { return { id: _uuid(), rma_code: "RMA-XXXXXX-XXXXX", input: input }; },
  };
}

function _validRequest() {
  return {
    order_id:        _uuid(),
    line_id:         _uuid(),
    return_sku:      "WIDGET-RED-M",
    return_qty:      1,
    replacement_sku: "WIDGET-RED-L",
    replacement_qty: 1,
    reason:          "wrong-size",
  };
}

async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = orderExchanges.create({
    query:                q,
    returns:              opts.returns || null,
    order:                opts.order   || null,
    inventoryAllocations: opts.inventoryAllocations || null,
  });
  return { q: q, svc: svc };
}

// ---- tests -------------------------------------------------------------

async function _requestExchangeShapeAndRefusals() {
  var w = await _wire();

  var req = _validRequest();
  var row = await w.svc.requestExchange(req);
  check("requestExchange returns row",      row && typeof row.id === "string");
  check("requestExchange status pending",   row.status === "pending");
  check("requestExchange order_id round-trip",     row.order_id === req.order_id);
  check("requestExchange line_id round-trip",      row.line_id  === req.line_id);
  check("requestExchange return_sku captured",     row.return_sku      === req.return_sku);
  check("requestExchange replacement_sku captured",row.replacement_sku === req.replacement_sku);
  check("requestExchange return_qty",              Number(row.return_qty)      === 1);
  check("requestExchange replacement_qty",         Number(row.replacement_qty) === 1);
  check("requestExchange reason",                  row.reason === "wrong-size");
  check("requestExchange created_at stamped",      Number(row.created_at) > 0);
  check("requestExchange updated_at stamped",      Number(row.updated_at) > 0);
  check("requestExchange variant_id null when not provided", row.replacement_variant_id == null);

  // Refusals
  await assert.rejects(w.svc.requestExchange(),                                                     /input object required/);
  await assert.rejects(w.svc.requestExchange({}),                                                   /order_id/);

  var bad = _validRequest(); bad.order_id = "not-a-uuid";
  await assert.rejects(w.svc.requestExchange(bad),                                                  /order_id/);

  bad = _validRequest(); bad.line_id = "not-a-uuid";
  await assert.rejects(w.svc.requestExchange(bad),                                                  /line_id/);

  bad = _validRequest(); bad.return_sku = "!!bad!!";
  await assert.rejects(w.svc.requestExchange(bad),                                                  /return_sku/);

  bad = _validRequest(); bad.replacement_sku = "";
  await assert.rejects(w.svc.requestExchange(bad),                                                  /replacement_sku/);

  bad = _validRequest(); bad.return_qty = 0;
  await assert.rejects(w.svc.requestExchange(bad),                                                  /return_qty/);

  bad = _validRequest(); bad.replacement_qty = -1;
  await assert.rejects(w.svc.requestExchange(bad),                                                  /replacement_qty/);

  bad = _validRequest(); bad.reason = "not-a-real-reason";
  await assert.rejects(w.svc.requestExchange(bad),                                                  /reason/);

  bad = _validRequest(); bad.replacement_variant_id = "not-a-uuid";
  await assert.rejects(w.svc.requestExchange(bad),                                                  /replacement_variant_id/);

  // With a variant id — round-trips
  var withVariant = _validRequest();
  withVariant.replacement_variant_id = _uuid();
  var rowV = await w.svc.requestExchange(withVariant);
  check("requestExchange variant_id round-trip", rowV.replacement_variant_id === withVariant.replacement_variant_id);
}

async function _approveExchangeOpensHold() {
  var inv = _invAllocsStub();
  var w = await _wire({ inventoryAllocations: inv });
  var req = _validRequest();
  var ex  = await w.svc.requestExchange(req);

  var approverId = _uuid();
  var approved = await w.svc.approveExchange(ex.id, { approver_id: approverId });
  check("approveExchange status approved",     approved.status === "approved");
  check("approveExchange approver_id",         approved.approver_id === approverId);
  check("approveExchange opened a hold",       inv.calls.length === 1);
  check("approveExchange hold sku",            inv.calls[0].sku === req.replacement_sku);
  check("approveExchange hold quantity",       inv.calls[0].quantity === req.replacement_qty);
  check("approveExchange hold cart_id = id",   inv.calls[0].cart_id === ex.id);

  // Cannot approve a non-pending exchange. The atomic claim
  // (status='pending' in the UPDATE's WHERE) refuses the re-approve
  // AND must not fire the exactly-once side-effect again — the hold
  // count stays at 1, proving no duplicate shelf pin on the loser path.
  await assert.rejects(w.svc.approveExchange(ex.id, { approver_id: approverId }),                   /refused/);
  check("re-approve does not double-open a hold", inv.calls.length === 1);

  // Refusals
  await assert.rejects(w.svc.approveExchange(ex.id),                                                /input object required/);
  await assert.rejects(w.svc.approveExchange(ex.id, {}),                                            /approver_id/);
  await assert.rejects(w.svc.approveExchange(_uuid(), { approver_id: approverId }),                 /not found/);
}

async function _approveExchangeHoldFailureRollsBack() {
  var inv = _invAllocsStub({ fail: true });
  var w = await _wire({ inventoryAllocations: inv });
  var ex = await w.svc.requestExchange(_validRequest());
  var approverId = _uuid();
  await assert.rejects(w.svc.approveExchange(ex.id, { approver_id: approverId }),                   /hold-failed/);
  // Row stays pending — approval did not land
  var after = await w.svc.getExchange(ex.id);
  check("hold failure keeps row pending",      after.status === "pending");
  check("hold failure does not set approver",  after.approver_id == null);
}

async function _rejectExchangeFromPendingAndApproved() {
  var w = await _wire();
  // From pending
  var ex1 = await w.svc.requestExchange(_validRequest());
  var op1 = _uuid();
  var rej1 = await w.svc.rejectExchange(ex1.id, {
    approver_id: op1, reject_reason: "policy disallows exchange after 60 days",
  });
  check("reject from pending status",        rej1.status === "rejected");
  check("reject from pending approver",      rej1.approver_id === op1);
  check("reject_reason captured",            rej1.reject_reason === "policy disallows exchange after 60 days");

  // From approved (different exchange)
  var inv = _invAllocsStub();
  var w2  = await _wire({ inventoryAllocations: inv });
  var ex2 = await w2.svc.requestExchange(_validRequest());
  var op2 = _uuid();
  await w2.svc.approveExchange(ex2.id, { approver_id: op2 });
  var rej2 = await w2.svc.rejectExchange(ex2.id, {
    approver_id: op2, reject_reason: "out of stock",
  });
  check("reject from approved status",       rej2.status === "rejected");

  // Reject from terminal refused
  await assert.rejects(w2.svc.rejectExchange(ex2.id, {
    approver_id: op2, reject_reason: "again",
  }), /refused/);

  // Refusals
  await assert.rejects(w.svc.rejectExchange(ex1.id, { approver_id: op1, reject_reason: "" }),       /reject_reason/);
}

async function _fsmDeliveredFirstPath() {
  // shipped -> delivered -> received -> closed
  var inv = _invAllocsStub();
  var w = await _wire({ inventoryAllocations: inv });
  var ex = await w.svc.requestExchange(_validRequest());
  var op = _uuid();
  await w.svc.approveExchange(ex.id, { approver_id: op });

  var shipped = await w.svc.markReplacementShipped(ex.id, {
    tracking_number: "1Z999AA10123456784", carrier: "UPS",
  });
  check("shipped status",            shipped.status === "shipped");
  check("shipped tracking captured", shipped.tracking_number === "1Z999AA10123456784");
  check("shipped carrier captured",  shipped.carrier === "UPS");
  check("shipped_at stamped",        Number(shipped.shipped_at) > 0);

  // Cannot close yet — neither delivered nor received is set, and the
  // FSM doesn't allow closeExchange from shipped at all
  await assert.rejects(w.svc.closeExchange(ex.id),                                                  /refused/);

  var delivered = await w.svc.markReplacementDelivered(ex.id, { delivered_at: Date.now() });
  check("delivered status",          delivered.status === "delivered");
  check("delivered_at stamped",      Number(delivered.delivered_at) > 0);

  // Cannot close yet — returned_at is still null
  await assert.rejects(w.svc.closeExchange(ex.id),                                                  /both_sides_required|both sides|delivered_at|returned_at/i);

  var received = await w.svc.markReturnReceived(ex.id, { returned_at: Date.now() });
  check("received status",           received.status === "received");
  check("returned_at stamped",       Number(received.returned_at) > 0);
  // delivered_at preserved (the row carries both timestamps)
  check("delivered_at preserved",    Number(received.delivered_at) > 0);

  var closed = await w.svc.closeExchange(ex.id);
  check("closed status",             closed.status === "closed");
  check("closed_at stamped",         Number(closed.closed_at) > 0);

  // Terminal — every further transition refused
  await assert.rejects(w.svc.markReturnReceived(ex.id),                                              /refused/);
  await assert.rejects(w.svc.closeExchange(ex.id),                                                  /refused/);
}

async function _fsmReceivedFirstPath() {
  // shipped -> received -> delivered -> closed
  var inv = _invAllocsStub();
  var w = await _wire({ inventoryAllocations: inv });
  var ex = await w.svc.requestExchange(_validRequest());
  var op = _uuid();
  await w.svc.approveExchange(ex.id, { approver_id: op });
  await w.svc.markReplacementShipped(ex.id, {
    tracking_number: "TRACK-XYZ", carrier: "DHL",
  });

  var received = await w.svc.markReturnReceived(ex.id, { returned_at: Date.now() });
  check("received-first status",       received.status === "received");

  // Cannot close yet — delivered_at still null
  await assert.rejects(w.svc.closeExchange(ex.id),                                                  /both_sides|delivered_at|returned_at/i);

  var delivered = await w.svc.markReplacementDelivered(ex.id, { delivered_at: Date.now() });
  check("delivered-from-received status", delivered.status === "delivered");

  var closed = await w.svc.closeExchange(ex.id, { closed_at: Date.now() });
  check("closed-from-received-first",     closed.status === "closed");
  check("closed_at custom honoured",      Number(closed.closed_at) > 0);
}

async function _closeExchangeRefusesIfOneSideMissing() {
  // From delivered, only delivered_at is set; closeExchange must
  // refuse with EXCHANGE_BOTH_SIDES_REQUIRED until returned_at lands.
  var inv = _invAllocsStub();
  var w = await _wire({ inventoryAllocations: inv });
  var ex = await w.svc.requestExchange(_validRequest());
  await w.svc.approveExchange(ex.id, { approver_id: _uuid() });
  await w.svc.markReplacementShipped(ex.id, { tracking_number: "T1", carrier: "X" });
  await w.svc.markReplacementDelivered(ex.id, { delivered_at: Date.now() });

  // delivered, but returned_at is null — close must refuse
  var threw = false;
  try {
    await w.svc.closeExchange(ex.id);
  } catch (e) {
    threw = true;
    check("close-incomplete error code", e.code === "EXCHANGE_BOTH_SIDES_REQUIRED");
  }
  check("close-incomplete threw",        threw === true);

  // Now land the return + close — succeeds
  await w.svc.markReturnReceived(ex.id, { returned_at: Date.now() });
  var closed = await w.svc.closeExchange(ex.id);
  check("close after both sides",        closed.status === "closed");
}

async function _readShapesAndOpenQueue() {
  var inv = _invAllocsStub();
  var customerId = _uuid();
  var orderA = _uuid();
  var orderB = _uuid();
  var orderC = _uuid();
  var ord = _orderStub({
    byCustomer: (function () { var m = {}; m[customerId] = [{ id: orderA }, { id: orderB }]; return m; })(),
  });
  var w = await _wire({ order: ord, inventoryAllocations: inv });

  // Three exchanges: two for customer (orderA, orderB), one for an
  // unrelated order (orderC) — to verify exchangesForCustomer
  // doesn't pick up the unrelated row.
  var reqA = _validRequest(); reqA.order_id = orderA;
  var reqB = _validRequest(); reqB.order_id = orderB;
  var reqC = _validRequest(); reqC.order_id = orderC;
  var exA = await w.svc.requestExchange(reqA);
  var exB = await w.svc.requestExchange(reqB);
  var exC = await w.svc.requestExchange(reqC);

  // getExchange / exchangesForOrder
  var fetched = await w.svc.getExchange(exA.id);
  check("getExchange returns row",          fetched && fetched.id === exA.id);
  var missing = await w.svc.getExchange(_uuid());
  check("getExchange miss returns null",    missing === null);

  // exchangesForOrder includes only that order
  var forA = await w.svc.exchangesForOrder(orderA);
  check("exchangesForOrder returns 1",      forA.length === 1 && forA[0].id === exA.id);

  // exchangesForCustomer reads through order.listForCustomer; only
  // orderA + orderB rows surface, orderC stays hidden
  var forCustomer = await w.svc.exchangesForCustomer(customerId);
  check("exchangesForCustomer count",       forCustomer.length === 2);
  var ids = forCustomer.map(function (r) { return r.id; }).sort();
  var expected = [exA.id, exB.id].sort();
  check("exchangesForCustomer ids",         ids[0] === expected[0] && ids[1] === expected[1]);

  // openExchanges — every non-terminal row
  var open = await w.svc.openExchanges();
  check("openExchanges sees all 3 pending", open.length === 3);

  // Approve A + reject C; openExchanges sees A (approved is
  // non-terminal) but not C (terminal)
  await w.svc.approveExchange(exA.id, { approver_id: _uuid() });
  await w.svc.rejectExchange(exC.id, { approver_id: _uuid(), reject_reason: "denied" });
  var open2 = await w.svc.openExchanges();
  check("openExchanges excludes rejected",  open2.length === 2);
  var openIds = open2.map(function (r) { return r.id; }).sort();
  var expectedOpen = [exA.id, exB.id].sort();
  check("openExchanges ids",                openIds[0] === expectedOpen[0] && openIds[1] === expectedOpen[1]);

  // openExchanges with status filter — pending only
  var openPending = await w.svc.openExchanges({ status: "pending" });
  check("openExchanges status=pending",     openPending.length === 1 && openPending[0].id === exB.id);

  // Terminal status filter refused
  await assert.rejects(w.svc.openExchanges({ status: "closed" }),                                    /terminal/);
  await assert.rejects(w.svc.openExchanges({ status: "rejected" }),                                  /terminal/);
  await assert.rejects(w.svc.openExchanges({ status: "bogus" }),                                     /status/);

  // exchangesForCustomer without `order` wired refuses
  var wBare = await _wire();
  await assert.rejects(wBare.svc.exchangesForCustomer(customerId),                                   /order must be wired/);
}

async function _metricsForPeriod() {
  var inv = _invAllocsStub();
  var w = await _wire({ inventoryAllocations: inv });
  var t0 = Date.now();

  // Open 3 exchanges; approve 1, reject 1, leave 1 pending
  var e1 = await w.svc.requestExchange(_validRequest());
  var e2 = await w.svc.requestExchange((function () { var r = _validRequest(); r.reason = "defective"; return r; })());
  var e3 = await w.svc.requestExchange((function () { var r = _validRequest(); r.reason = "wrong-item"; return r; })());

  await w.svc.approveExchange(e1.id, { approver_id: _uuid() });
  await w.svc.rejectExchange(e2.id, { approver_id: _uuid(), reject_reason: "policy" });
  // e3 stays pending
  void e3;

  var metrics = await w.svc.metricsForPeriod({ from: t0 - 1000, to: t0 + 60 * 60 * 1000 });
  check("metrics total_count",            metrics.total_count === 3);
  check("metrics counts_by_status pending",  metrics.counts_by_status.pending  === 1);
  check("metrics counts_by_status approved", metrics.counts_by_status.approved === 1);
  check("metrics counts_by_status rejected", metrics.counts_by_status.rejected === 1);
  check("metrics counts_by_status closed=0", metrics.counts_by_status.closed   === 0);
  check("metrics rejected_rate",          Math.abs(metrics.rejected_rate - (1 / 3)) < 1e-9);
  check("metrics closed_rate",            metrics.closed_rate === 0);
  check("metrics counts_by_reason wrong-size", metrics.counts_by_reason["wrong-size"] === 1);
  check("metrics counts_by_reason defective",  metrics.counts_by_reason["defective"]  === 1);
  check("metrics counts_by_reason wrong-item", metrics.counts_by_reason["wrong-item"] === 1);

  // Empty window — total 0 + all rates 0 (not NaN)
  var empty = await w.svc.metricsForPeriod({ from: t0 - 100000, to: t0 - 99000 });
  check("empty window total 0",          empty.total_count === 0);
  check("empty window closed_rate 0",    empty.closed_rate === 0);
  check("empty window rejected_rate 0",  empty.rejected_rate === 0);

  // Refusals
  await assert.rejects(w.svc.metricsForPeriod({ from: t0, to: t0 }),                                /to must be > from/);
  await assert.rejects(w.svc.metricsForPeriod({ from: 0, to: t0 }),                                 /from/);
}

async function _markShippedRefusalsAndTrackingShape() {
  var inv = _invAllocsStub();
  var w = await _wire({ inventoryAllocations: inv });
  var ex = await w.svc.requestExchange(_validRequest());

  // Cannot ship from pending
  await assert.rejects(w.svc.markReplacementShipped(ex.id, {
    tracking_number: "T", carrier: "X",
  }), /refused/);

  await w.svc.approveExchange(ex.id, { approver_id: _uuid() });

  // tracking_number / carrier required
  await assert.rejects(w.svc.markReplacementShipped(ex.id, {
    tracking_number: "", carrier: "X",
  }), /tracking_number/);
  await assert.rejects(w.svc.markReplacementShipped(ex.id, {
    tracking_number: "T", carrier: "",
  }), /carrier/);
  await assert.rejects(w.svc.markReplacementShipped(ex.id, {}),                                     /tracking_number/);
  await assert.rejects(w.svc.markReplacementShipped(ex.id),                                         /input object required/);

  // tracking_number over MAX_TRACKING_LEN refused
  var long = (new Array(130)).join("X");
  await assert.rejects(w.svc.markReplacementShipped(ex.id, {
    tracking_number: long, carrier: "X",
  }), /tracking_number/);

  // Custom shipped_at honoured
  var customTs = Date.now() - 1000;
  var shipped = await w.svc.markReplacementShipped(ex.id, {
    tracking_number: "T1", carrier: "FedEx", shipped_at: customTs,
  });
  check("custom shipped_at honoured", Number(shipped.shipped_at) === customTs);
}

async function _factoryRefusals() {
  // returns without request refused
  assert.throws(function () {
    orderExchanges.create({ query: function () {}, returns: {} });
  }, /request/);
  // order without get refused
  assert.throws(function () {
    orderExchanges.create({ query: function () {}, order: {} });
  }, /get/);
  // inventoryAllocations without holdForCart refused
  assert.throws(function () {
    orderExchanges.create({ query: function () {}, inventoryAllocations: {} });
  }, /holdForCart/);

  // With all valid stubs — factory builds
  var svc = orderExchanges.create({
    query:                function () {},
    returns:              _returnsStub(),
    order:                _orderStub(),
    inventoryAllocations: _invAllocsStub(),
  });
  check("factory returns service",  svc && typeof svc.requestExchange === "function");
  check("REASONS exposed",          Array.isArray(svc.REASONS) && svc.REASONS.indexOf("defective") !== -1);
  check("STATUSES exposed",         Array.isArray(svc.STATUSES) && svc.STATUSES.indexOf("closed") !== -1);
  check("TERMINAL_STATES exposed",  svc.TERMINAL_STATES.indexOf("closed") !== -1 &&
                                    svc.TERMINAL_STATES.indexOf("rejected") !== -1);
}

async function _monotonicClockEnforced() {
  // Two rapid requests against the same factory must produce
  // strictly increasing created_at timestamps even if Date.now()
  // ties — the monotonic clock pattern bumps by 1ms on a tie.
  var w = await _wire();
  var rows = [];
  for (var i = 0; i < 5; i += 1) {
    rows.push(await w.svc.requestExchange(_validRequest()));
  }
  for (var j = 1; j < rows.length; j += 1) {
    check("monotonic ts strictly increasing #" + j,
      Number(rows[j].created_at) > Number(rows[j - 1].created_at));
  }
}

async function run() {
  await _requestExchangeShapeAndRefusals();
  await _approveExchangeOpensHold();
  await _approveExchangeHoldFailureRollsBack();
  await _rejectExchangeFromPendingAndApproved();
  await _fsmDeliveredFirstPath();
  await _fsmReceivedFirstPath();
  await _closeExchangeRefusesIfOneSideMissing();
  await _readShapesAndOpenQueue();
  await _metricsForPeriod();
  await _markShippedRefusalsAndTrackingShape();
  await _factoryRefusals();
  await _monotonicClockEnforced();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("order-exchanges: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
