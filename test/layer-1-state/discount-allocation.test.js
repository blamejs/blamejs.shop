"use strict";
/**
 * discountAllocation — per-line allocation of order-level discounts.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0129_discount_allocation.sql`.
 *
 * Coverage:
 *   - allocate proportional: 3 lines, distribute $20 across them by
 *     subtotal weight; sum invariant holds; remaining_minor correct
 *   - allocate equal: $10 across 4 lines; rounding remainder on the
 *     highest-subtotal line
 *   - allocate by_subtotal alias matches proportional
 *   - allocate by_quantity: weights by quantity not subtotal
 *   - sum invariant: every kind sums to discount_minor exactly across
 *     a stress sweep
 *   - half-even rounding remainder lands on highest-subtotal line
 *   - recordAllocation + allocationsForOrder round-trip
 *   - reverseAllocation distributes refund proportional to original
 *     breakdown; sum invariant holds
 *   - metricsForKind aggregates count + sum
 *   - input refusals for every public surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var discountAllocation = require("../../lib/discount-allocation");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0129_discount_allocation.sql");

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

function _sumAllocated(breakdown) {
  var s = 0;
  for (var i = 0; i < breakdown.length; i += 1) s += breakdown[i].allocated_minor;
  return s;
}

function _sumRefund(reverse) {
  var s = 0;
  for (var i = 0; i < reverse.length; i += 1) s += reverse[i].refund_minor;
  return s;
}

// ---- allocate proportional ---------------------------------------------

async function _proportional() {
  var da = discountAllocation.create({ query: _makeQuery() });

  // Order: $20.00 off, three lines at $30 / $50 / $20.
  // proportional shares of 2000 minor units against weights
  // [3000, 5000, 2000] (sum=10000): 600 / 1000 / 400.
  var breakdown = da.allocate({
    lines: [
      { line_id: "L1", subtotal_minor: 3000, quantity: 1 },
      { line_id: "L2", subtotal_minor: 5000, quantity: 1 },
      { line_id: "L3", subtotal_minor: 2000, quantity: 1 },
    ],
    discount_minor: 2000,
    kind:           "proportional",
  });

  check("proportional length",             breakdown.length === 3);
  check("proportional L1 allocated 600",   breakdown[0].allocated_minor === 600);
  check("proportional L2 allocated 1000",  breakdown[1].allocated_minor === 1000);
  check("proportional L3 allocated 400",   breakdown[2].allocated_minor === 400);
  check("proportional sum invariant",      _sumAllocated(breakdown) === 2000);
  check("proportional L1 remaining 2400",  breakdown[0].remaining_minor === 2400);
  check("proportional L2 remaining 4000",  breakdown[1].remaining_minor === 4000);
  check("proportional L3 remaining 1600",  breakdown[2].remaining_minor === 1600);
}

// ---- allocate equal ----------------------------------------------------

async function _equal() {
  var da = discountAllocation.create({ query: _makeQuery() });

  // $10 off, 4 lines: 1000 / 4 = 250 exact, no remainder.
  var even = da.allocate({
    lines: [
      { line_id: "L1", subtotal_minor: 2000, quantity: 1 },
      { line_id: "L2", subtotal_minor: 3000, quantity: 1 },
      { line_id: "L3", subtotal_minor: 4000, quantity: 1 },
      { line_id: "L4", subtotal_minor: 1000, quantity: 1 },
    ],
    discount_minor: 1000,
    kind:           "equal",
  });
  check("equal length",                    even.length === 4);
  for (var i = 0; i < even.length; i += 1) {
    check("equal share " + i + " = 250",   even[i].allocated_minor === 250);
  }
  check("equal sum invariant",             _sumAllocated(even) === 1000);

  // $10 off, 3 lines: 1000 / 3 = 333 + remainder 1 lands on
  // highest-subtotal line (L2 at 3000).
  var rem = da.allocate({
    lines: [
      { line_id: "L1", subtotal_minor: 2000, quantity: 1 },
      { line_id: "L2", subtotal_minor: 3000, quantity: 1 },
      { line_id: "L3", subtotal_minor: 1500, quantity: 1 },
    ],
    discount_minor: 1000,
    kind:           "equal",
  });
  check("equal remainder L1",              rem[0].allocated_minor === 333);
  check("equal remainder L2 (highest)",    rem[1].allocated_minor === 334);
  check("equal remainder L3",              rem[2].allocated_minor === 333);
  check("equal remainder sum",             _sumAllocated(rem) === 1000);
}

// ---- allocate by_subtotal alias ----------------------------------------

async function _bySubtotalAlias() {
  var da = discountAllocation.create({ query: _makeQuery() });
  var lines = [
    { line_id: "A", subtotal_minor: 1000, quantity: 1 },
    { line_id: "B", subtotal_minor: 2000, quantity: 1 },
    { line_id: "C", subtotal_minor: 3000, quantity: 1 },
  ];
  var prop = da.allocate({ lines: lines, discount_minor: 600, kind: "proportional" });
  var bsub = da.allocate({ lines: lines, discount_minor: 600, kind: "by_subtotal" });
  for (var i = 0; i < prop.length; i += 1) {
    check("by_subtotal alias matches proportional[" + i + "]",
      prop[i].allocated_minor === bsub[i].allocated_minor);
  }
  check("by_subtotal sum invariant",       _sumAllocated(bsub) === 600);
}

// ---- allocate by_quantity ----------------------------------------------

async function _byQuantity() {
  var da = discountAllocation.create({ query: _makeQuery() });

  // $12 off, qty weights [1, 2, 3] (sum=6): 200 / 400 / 600.
  // Note: subtotals are intentionally LOW for line C so we can prove
  // the share follows quantity not subtotal.
  var bq = da.allocate({
    lines: [
      { line_id: "A", subtotal_minor: 5000, quantity: 1 },
      { line_id: "B", subtotal_minor: 5000, quantity: 2 },
      { line_id: "C", subtotal_minor:  100, quantity: 3 },
    ],
    discount_minor: 1200,
    kind:           "by_quantity",
  });
  check("by_quantity A=200",               bq[0].allocated_minor === 200);
  check("by_quantity B=400",               bq[1].allocated_minor === 400);
  check("by_quantity C=600",               bq[2].allocated_minor === 600);
  check("by_quantity sum invariant",       _sumAllocated(bq) === 1200);
  // C's remaining clamps to zero because the discount exceeds the
  // line subtotal (100 - 600 < 0 -> 0).
  check("by_quantity C clamps remaining",  bq[2].remaining_minor === 0);
}

// ---- sum-invariant stress sweep ----------------------------------------

async function _sumInvariantSweep() {
  var da = discountAllocation.create({ query: _makeQuery() });
  var kinds = ["proportional", "equal", "by_subtotal", "by_quantity"];
  var totals = [1, 7, 13, 99, 100, 333, 1000, 9999, 12345, 100000];
  for (var k = 0; k < kinds.length; k += 1) {
    for (var t = 0; t < totals.length; t += 1) {
      var br = da.allocate({
        lines: [
          { line_id: "L1", subtotal_minor: 2500, quantity: 1 },
          { line_id: "L2", subtotal_minor: 7777, quantity: 4 },
          { line_id: "L3", subtotal_minor: 1234, quantity: 2 },
          { line_id: "L4", subtotal_minor: 6789, quantity: 3 },
          { line_id: "L5", subtotal_minor:  500, quantity: 1 },
          { line_id: "L6", subtotal_minor: 9999, quantity: 7 },
        ],
        discount_minor: totals[t],
        kind:           kinds[k],
      });
      check(
        "sum invariant " + kinds[k] + "/" + totals[t],
        _sumAllocated(br) === totals[t],
      );
    }
  }
}

// ---- half-even remainder on highest-subtotal line ----------------------

async function _remainderOnHighest() {
  var da = discountAllocation.create({ query: _makeQuery() });

  // $1 off (100 minor) over three equal-quantity lines with distinct
  // subtotals. Proportional weights [333, 666, 1] (sum=1000): floor
  // half-even shares are 33 / 67 / 0 (computed by b.money). Sum = 100,
  // no remainder. Use a payload that DOES produce a remainder:
  //
  // Weights [1, 1, 1] equal kind with total=1 across 3 lines:
  //   each line gets floor(1/3) = 0; remainder 1 lands on highest
  //   subtotal (L2).
  var br = da.allocate({
    lines: [
      { line_id: "small",  subtotal_minor: 100,  quantity: 1 },
      { line_id: "huge",   subtotal_minor: 9999, quantity: 1 },
      { line_id: "mid",    subtotal_minor: 500,  quantity: 1 },
    ],
    discount_minor: 1,
    kind:           "equal",
  });
  check("remainder small=0",               br[0].allocated_minor === 0);
  check("remainder huge=1 (highest)",      br[1].allocated_minor === 1);
  check("remainder mid=0",                 br[2].allocated_minor === 0);
  check("remainder sum",                   _sumAllocated(br) === 1);

  // Verify the "highest subtotal" picks the correct line when the
  // input order differs from the subtotal order.
  var br2 = da.allocate({
    lines: [
      { line_id: "X", subtotal_minor: 3333, quantity: 1 },
      { line_id: "Y", subtotal_minor:  100, quantity: 1 },
      { line_id: "Z", subtotal_minor: 1234, quantity: 1 },
    ],
    discount_minor: 10,
    kind:           "equal",
  });
  // 10 / 3 = 3 each, remainder 1. Highest subtotal is X (3333).
  check("remainder picks X (highest)",     br2[0].allocated_minor === 4);
  check("remainder Y normal",              br2[1].allocated_minor === 3);
  check("remainder Z normal",              br2[2].allocated_minor === 3);
  check("remainder sum 10",                _sumAllocated(br2) === 10);
}

// ---- recordAllocation + allocationsForOrder round-trip -----------------

async function _recordAndRetrieve() {
  var q = _makeQuery();
  var da = discountAllocation.create({ query: q });

  var lines = [
    { line_id: "L1", subtotal_minor: 3000, quantity: 1 },
    { line_id: "L2", subtotal_minor: 5000, quantity: 1 },
    { line_id: "L3", subtotal_minor: 2000, quantity: 1 },
  ];
  var br = da.allocate({ lines: lines, discount_minor: 2000, kind: "proportional" });

  var rec = await da.recordAllocation({
    order_id:        "order-1",
    discount_source: "coupon:WELCOME10",
    kind:            "proportional",
    breakdown:       br,
    total_minor:     2000,
  });
  check("recordAllocation has id",         typeof rec.id === "string" && rec.id.length > 0);
  check("recordAllocation order_id",       rec.order_id === "order-1");
  check("recordAllocation source",         rec.source === "coupon:WELCOME10");
  check("recordAllocation kind",           rec.kind === "proportional");
  check("recordAllocation total_minor",    rec.total_minor === 2000);
  check("recordAllocation applied_at int", Number.isInteger(rec.applied_at));

  // Second allocation, different source, same order.
  var br2 = da.allocate({ lines: lines, discount_minor: 500, kind: "equal" });
  await da.recordAllocation({
    order_id:        "order-1",
    discount_source: "auto_discount:weekend",
    kind:            "equal",
    breakdown:       br2,
    total_minor:     500,
  });

  var rows = await da.allocationsForOrder("order-1");
  check("allocationsForOrder length",      rows.length === 2);
  check("allocationsForOrder DESC order",  rows[0].applied_at >= rows[1].applied_at);
  check("allocationsForOrder breakdown",   Array.isArray(rows[0].breakdown));
  check("allocationsForOrder breakdown 3 entries",
    rows.find(function (r) { return r.source === "coupon:WELCOME10"; }).breakdown.length === 3);

  // Empty for unknown order.
  var none = await da.allocationsForOrder("no-such-order");
  check("allocationsForOrder unknown order empty", none.length === 0);

  // Sum invariant refused.
  await assert.rejects(
    da.recordAllocation({
      order_id:        "order-2",
      discount_source: "src",
      kind:            "proportional",
      breakdown:       [{ line_id: "L1", allocated_minor: 100, remaining_minor: 0 }],
      total_minor:     200,
    }),
    /breakdown sum/,
  );
}

// ---- reverseAllocation -------------------------------------------------

async function _reverse() {
  var q  = _makeQuery();
  var da = discountAllocation.create({ query: q });

  var lines = [
    { line_id: "L1", subtotal_minor: 3000, quantity: 1 },
    { line_id: "L2", subtotal_minor: 5000, quantity: 1 },
    { line_id: "L3", subtotal_minor: 2000, quantity: 1 },
  ];
  var br = da.allocate({ lines: lines, discount_minor: 2000, kind: "proportional" });
  // breakdown: 600 / 1000 / 400 (sum 2000)

  await da.recordAllocation({
    order_id:        "order-r",
    discount_source: "coupon:WELCOME10",
    kind:            "proportional",
    breakdown:       br,
    total_minor:     2000,
  });

  // Partial refund of $5 (500 minor) against the recorded breakdown.
  // Weights [600, 1000, 400] (sum 2000): shares 150 / 250 / 100.
  var rev = await da.reverseAllocation({
    order_id:     "order-r",
    source:       "coupon:WELCOME10",
    refund_minor: 500,
  });
  check("reverse has id",                  typeof rev.id === "string");
  check("reverse refund_minor",            rev.refund_minor === 500);
  check("reverse breakdown length",        rev.reverse_breakdown.length === 3);
  check("reverse L1 = 150",                rev.reverse_breakdown[0].refund_minor === 150);
  check("reverse L2 = 250",                rev.reverse_breakdown[1].refund_minor === 250);
  check("reverse L3 = 100",                rev.reverse_breakdown[2].refund_minor === 100);
  check("reverse sum invariant",           _sumRefund(rev.reverse_breakdown) === 500);

  // Full refund of the discount total returns the original allocation
  // exactly.
  var revFull = await da.reverseAllocation({
    order_id:     "order-r",
    source:       "coupon:WELCOME10",
    refund_minor: 2000,
  });
  check("reverse full L1 = 600",           revFull.reverse_breakdown[0].refund_minor === 600);
  check("reverse full L2 = 1000",          revFull.reverse_breakdown[1].refund_minor === 1000);
  check("reverse full L3 = 400",           revFull.reverse_breakdown[2].refund_minor === 400);
  check("reverse full sum invariant",      _sumRefund(revFull.reverse_breakdown) === 2000);

  // Unknown allocation refusal.
  await assert.rejects(
    da.reverseAllocation({
      order_id:     "no-such-order",
      source:       "coupon:WELCOME10",
      refund_minor: 100,
    }),
    /no allocation found/,
  );

  // Refund of 1 minor unit lands on the line with the largest
  // original allocation (L2 at 1000).
  var revTiny = await da.reverseAllocation({
    order_id:     "order-r",
    source:       "coupon:WELCOME10",
    refund_minor: 1,
  });
  check("reverse tiny L1 = 0",             revTiny.reverse_breakdown[0].refund_minor === 0);
  check("reverse tiny L2 = 1 (highest)",   revTiny.reverse_breakdown[1].refund_minor === 1);
  check("reverse tiny L3 = 0",             revTiny.reverse_breakdown[2].refund_minor === 0);
}

// ---- metricsForKind ----------------------------------------------------

async function _metrics() {
  var q  = _makeQuery();
  var da = discountAllocation.create({ query: q });

  var lines = [
    { line_id: "L1", subtotal_minor: 1000, quantity: 1 },
    { line_id: "L2", subtotal_minor: 2000, quantity: 1 },
  ];

  await da.recordAllocation({
    order_id:        "o1",
    discount_source: "c1",
    kind:            "proportional",
    breakdown:       da.allocate({ lines: lines, discount_minor: 100, kind: "proportional" }),
    total_minor:     100,
    applied_at:      1000,
  });
  await da.recordAllocation({
    order_id:        "o2",
    discount_source: "c2",
    kind:            "proportional",
    breakdown:       da.allocate({ lines: lines, discount_minor: 200, kind: "proportional" }),
    total_minor:     200,
    applied_at:      2000,
  });
  await da.recordAllocation({
    order_id:        "o3",
    discount_source: "c3",
    kind:            "equal",
    breakdown:       da.allocate({ lines: lines, discount_minor: 50, kind: "equal" }),
    total_minor:     50,
    applied_at:      3000,
  });

  var m = await da.metricsForKind({ kind: "proportional", from: 0, to: 10000 });
  check("metrics proportional count",      m.count === 2);
  check("metrics proportional sum",        m.sum_minor === 300);

  var mEq = await da.metricsForKind({ kind: "equal", from: 0, to: 10000 });
  check("metrics equal count",             mEq.count === 1);
  check("metrics equal sum",               mEq.sum_minor === 50);

  // Time window filter.
  var mWin = await da.metricsForKind({ kind: "proportional", from: 1500, to: 2500 });
  check("metrics proportional window",     mWin.count === 1);
  check("metrics proportional window sum", mWin.sum_minor === 200);

  // Empty window.
  var mNone = await da.metricsForKind({ kind: "by_quantity", from: 0, to: 10000 });
  check("metrics by_quantity none",        mNone.count === 0);
  check("metrics by_quantity none sum",    mNone.sum_minor === 0);
}

// ---- input refusals ----------------------------------------------------

async function _refusals() {
  var da = discountAllocation.create({ query: _makeQuery() });

  // allocate
  assert.throws(function () { da.allocate(); }, /input object required/);
  assert.throws(function () { da.allocate({ lines: [], discount_minor: 100, kind: "equal" }); }, /non-empty array/);
  assert.throws(function () {
    da.allocate({
      lines: [{ line_id: "L1", subtotal_minor: 100, quantity: 1 }],
      discount_minor: 0,
      kind: "equal",
    });
  }, /positive integer/);
  assert.throws(function () {
    da.allocate({
      lines: [{ line_id: "L1", subtotal_minor: 100, quantity: 1 }],
      discount_minor: 100,
      kind: "bogus",
    });
  }, /kind must be/);
  assert.throws(function () {
    da.allocate({
      lines: [
        { line_id: "L1", subtotal_minor: 100, quantity: 1 },
        { line_id: "L1", subtotal_minor: 200, quantity: 1 },
      ],
      discount_minor: 100,
      kind: "equal",
    });
  }, /duplicates an earlier line/);
  assert.throws(function () {
    da.allocate({
      lines: [{ line_id: "L1", subtotal_minor: -1, quantity: 1 }],
      discount_minor: 100,
      kind: "equal",
    });
  }, /subtotal_minor/);
  assert.throws(function () {
    da.allocate({
      lines: [{ line_id: "L1", subtotal_minor: 100, quantity: 0 }],
      discount_minor: 100,
      kind: "equal",
    });
  }, /quantity/);
  assert.throws(function () {
    da.allocate({
      lines: [{ line_id: "bad\nline", subtotal_minor: 100, quantity: 1 }],
      discount_minor: 100,
      kind: "equal",
    });
  }, /control bytes/);

  // recordAllocation
  await assert.rejects(da.recordAllocation(), /input object required/);
  await assert.rejects(
    da.recordAllocation({
      order_id: "", discount_source: "s", kind: "equal",
      breakdown: [{ line_id: "L1", allocated_minor: 1, remaining_minor: 0 }],
      total_minor: 1,
    }),
    /order_id/,
  );
  await assert.rejects(
    da.recordAllocation({
      order_id: "o", discount_source: "s", kind: "equal",
      breakdown: [], total_minor: 1,
    }),
    /non-empty array/,
  );

  // reverseAllocation
  await assert.rejects(da.reverseAllocation(), /input object required/);
  await assert.rejects(
    da.reverseAllocation({ order_id: "o", source: "s", refund_minor: 0 }),
    /positive integer/,
  );

  // metricsForKind
  await assert.rejects(da.metricsForKind(), /input object required/);
  await assert.rejects(
    da.metricsForKind({ kind: "equal", from: 100, to: 50 }),
    /to must be >= from/,
  );
  await assert.rejects(
    da.metricsForKind({ kind: "bogus", from: 0, to: 10 }),
    /kind must be/,
  );
}

async function run() {
  await _proportional();
  await _equal();
  await _bySubtotalAlias();
  await _byQuantity();
  await _sumInvariantSweep();
  await _remainderOnHighest();
  await _recordAndRetrieve();
  await _reverse();
  await _metrics();
  await _refusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - discount-allocation (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - discount-allocation: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
