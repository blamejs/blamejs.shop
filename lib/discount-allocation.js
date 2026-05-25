"use strict";
/**
 * @module shop.discountAllocation
 * @title  Discount-allocation primitive — distribute order-level
 *         discounts across order lines for accounting + refund precision.
 *
 * @intro
 *   An order carries an order-level discount: "$20 off the whole
 *   order", "15% off everything after the threshold". The lines
 *   underneath the order each carry their own subtotal + quantity.
 *   For accounting + refund precision the operator needs to know,
 *   for any one line, what slice of the order-level discount belongs
 *   to it — a partial refund of one line must remove that line's
 *   share of the discount, not the whole-order amount.
 *
 *   This primitive answers two questions:
 *
 *     1. Given lines + a discount + a kind, compute the per-line
 *        breakdown such that `sum(allocated_minor) === discount_minor`
 *        by construction. Rounding is half-even via the framework's
 *        Money class; the rounding remainder lands on the
 *        highest-subtotal line (deterministic, operator-readable —
 *        "the biggest line absorbs the cent").
 *
 *     2. Given a recorded allocation + a refund amount, walk the
 *        breakdown in reverse to compute the per-line refund shares
 *        proportional to the original allocation. The reverse
 *        breakdown is the audit trail proving the refund math came
 *        from the recorded breakdown — not a recomputation that
 *        could drift if the underlying subtotals were modified after
 *        the fact.
 *
 *   Surface:
 *
 *     - `allocate({ lines, discount_minor, kind })`
 *         Pure function. `lines` is `[{ line_id, subtotal_minor, quantity }]`.
 *         `kind` is one of `proportional` / `equal` / `by_subtotal` /
 *         `by_quantity`. Returns
 *         `[{ line_id, allocated_minor, remaining_minor }]` where the
 *         allocated values sum exactly to `discount_minor`.
 *
 *     - `recordAllocation({ order_id, discount_source, kind,
 *                           breakdown, total_minor, applied_at? })`
 *         Persists the breakdown as an audit row. Returns the
 *         hydrated row including the assigned id + applied_at.
 *
 *     - `allocationsForOrder(order_id)`
 *         Returns every recorded allocation against an order, newest
 *         first. Breakdown JSON is parsed.
 *
 *     - `reverseAllocation({ order_id, source, refund_minor,
 *                            occurred_at? })`
 *         Looks up the allocation row matching (order_id, source),
 *         walks its breakdown in reverse, computes per-line refund
 *         shares proportional to the original allocated_minor values,
 *         persists the reversal row, and returns the reverse
 *         breakdown. Rounding is half-even; the rounding remainder
 *         lands on the line with the largest original allocation.
 *
 *     - `metricsForKind({ kind, from, to })`
 *         Aggregates allocation totals + counts by kind across a
 *         time window. Returns `{ kind, count, sum_minor }`.
 *
 *   Composition:
 *     b.money.fromMinorUnits + .multiply([num, den]) carry the
 *     half-even rounding semantics. The primitive computes share
 *     numerators (line weight) + denominators (sum of weights) and
 *     delegates the rounded multiply to Money; the remainder is
 *     applied to the highest-subtotal line so the sum invariant
 *     holds without re-running the math.
 *
 *   Storage:
 *     - `discount_allocations` + `discount_reversals` (migration
 *       0129_discount_allocation.sql).
 *
 * @primitive discountAllocation
 * @related    b.money, b.uuid.v7, shop.refundPolicy, shop.couponStacking
 */

var b = require("./index").framework;

// ---- constants ----------------------------------------------------------

var KINDS = Object.freeze([
  "proportional",
  "equal",
  "by_subtotal",
  "by_quantity",
]);

var MAX_LINES         = 5000;
var MAX_SOURCE_LEN    = 200;
var MAX_LINE_ID_LEN   = 200;

// Source / line_id are operator-supplied correlation handles — refuse
// all control bytes (including CR/LF and tab) so a log-injection
// payload can't land in the audit-trail breakdown JSON.
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]*$/;

// The rounding currency is a placeholder; the math here is integer
// minor units and the half-even bump only depends on the rational
// remainder, not on the currency exponent. Picking a fixed code keeps
// the Money class from refusing the composition.
var ROUNDING_CURRENCY = "USD";

// ---- validators ---------------------------------------------------------

function _kind(k) {
  if (typeof k !== "string" || KINDS.indexOf(k) === -1) {
    throw new TypeError("discountAllocation: kind must be one of " + KINDS.join(", "));
  }
  return k;
}

function _positiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("discountAllocation: " + label + " must be a positive integer (minor units)");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("discountAllocation: " + label + " must be a non-negative integer");
  }
  return n;
}

function _shortString(s, label, max) {
  if (typeof s !== "string" || s.length === 0) {
    throw new TypeError("discountAllocation: " + label + " must be a non-empty string");
  }
  if (s.length > max) {
    throw new TypeError("discountAllocation: " + label + " must be <= " + max + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("discountAllocation: " + label + " must not contain control bytes");
  }
  return s;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("discountAllocation: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _validateLines(lines) {
  if (!Array.isArray(lines)) {
    throw new TypeError("discountAllocation: lines must be an array");
  }
  if (lines.length === 0) {
    throw new TypeError("discountAllocation: lines must be a non-empty array");
  }
  if (lines.length > MAX_LINES) {
    throw new TypeError("discountAllocation: lines must be <= " + MAX_LINES + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < lines.length; i += 1) {
    var L = lines[i];
    if (!L || typeof L !== "object") {
      throw new TypeError("discountAllocation: lines[" + i + "] must be an object");
    }
    var lineId   = _shortString(L.line_id, "lines[" + i + "].line_id", MAX_LINE_ID_LEN);
    var subtotal = _nonNegInt(L.subtotal_minor, "lines[" + i + "].subtotal_minor");
    var quantity = L.quantity;
    if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity <= 0) {
      throw new TypeError("discountAllocation: lines[" + i + "].quantity must be a positive integer");
    }
    if (Object.prototype.hasOwnProperty.call(seen, lineId)) {
      throw new TypeError("discountAllocation: lines[" + i + "].line_id duplicates an earlier line");
    }
    seen[lineId] = true;
    out.push({ line_id: lineId, subtotal_minor: subtotal, quantity: quantity, _idx: i });
  }
  return out;
}

// ---- allocation math (pure) --------------------------------------------

// Compute the per-line share via b.money's half-even rounded multiply.
// Given total `T`, weights `[w0, w1, ...]` summing to `W`, each share
// is `floor_half_even(T * wi / W)`. The shares may sum to slightly
// less than `T` (rounding gives back fractions); the remainder is
// applied to the line with the highest subtotal so the audit row's
// `allocated_minor` values sum exactly to `T`.
//
// "By quantity" weights use quantity; "equal" weights every line by
// `1` (so the share is `T / N` rounded); "by_subtotal" /
// "proportional" weight by subtotal. The remainder placement is
// always by highest subtotal — the operator's "the biggest line
// absorbs the cent" mental model holds for every kind.
function _shares(total, lines, kind) {
  var weights = new Array(lines.length);
  var sumWeight = 0n;
  for (var i = 0; i < lines.length; i += 1) {
    var w;
    if (kind === "equal") {
      w = 1;
    } else if (kind === "by_quantity") {
      w = lines[i].quantity;
    } else {
      // proportional / by_subtotal
      w = lines[i].subtotal_minor;
    }
    weights[i] = w;
    sumWeight += BigInt(w);
  }
  if (sumWeight === 0n) {
    // Every weight is zero — for by_subtotal/proportional this means
    // every line subtotal is zero. Fall back to equal-by-line so the
    // operator still gets a complete breakdown rather than a refusal
    // they have to special-case.
    for (var k = 0; k < weights.length; k += 1) {
      weights[k] = 1;
      sumWeight += 1n;
    }
  }

  var money = b.money;
  var totalMoney = money.fromMinorUnits(BigInt(total), ROUNDING_CURRENCY);
  var shares = new Array(lines.length);
  var allocated = 0n;
  for (var j = 0; j < lines.length; j += 1) {
    var share = totalMoney
      .multiply([BigInt(weights[j]), sumWeight])
      .toMinorUnits();
    shares[j] = share;
    allocated += share;
  }

  // Place the rounding remainder (positive or negative) on the line
  // with the highest subtotal_minor. Ties broken by original index so
  // the placement is deterministic across runtimes.
  var remainder = BigInt(total) - allocated;
  if (remainder !== 0n) {
    var bestIdx = 0;
    var bestSubtotal = lines[0].subtotal_minor;
    for (var m = 1; m < lines.length; m += 1) {
      if (lines[m].subtotal_minor > bestSubtotal) {
        bestSubtotal = lines[m].subtotal_minor;
        bestIdx = m;
      }
    }
    shares[bestIdx] = shares[bestIdx] + remainder;
  }
  return shares;
}

// Public allocate — composes _shares + emits the integer-shape
// breakdown the caller persists. Refuses negative remaining lines
// (the discount exceeds the line subtotal); the operator surfaces
// that as a refusal upstream when the discount value is too large
// for the order subtotal. Clamps to zero rather than going negative
// because the receipt-line "remaining" column shouldn't expose
// negative minor units to the storefront layer.
function _allocate(input) {
  if (!input || typeof input !== "object") {
    throw new TypeError("discountAllocation.allocate: input object required");
  }
  var lines    = _validateLines(input.lines);
  var discount = _positiveInt(input.discount_minor, "discount_minor");
  var kind     = _kind(input.kind);

  var shares = _shares(discount, lines, kind);
  var out = new Array(lines.length);
  for (var i = 0; i < lines.length; i += 1) {
    var allocated = Number(shares[i]);
    var remaining = lines[i].subtotal_minor - allocated;
    if (remaining < 0) remaining = 0;
    out[i] = {
      line_id:         lines[i].line_id,
      allocated_minor: allocated,
      remaining_minor: remaining,
    };
  }
  return out;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Two writes against the same order in the same millisecond would
  // tie on `applied_at` and make `allocationsForOrder` ordering
  // ambiguous. Bump the requested timestamp to `prior + 1` when it
  // would collide (or land older than the prior row, which an
  // out-of-order operator write could trigger). The result is a
  // strictly-monotonic per-order `applied_at` sequence.
  function _resolveAppliedAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _latestAppliedAt(orderId) {
    var r = await query(
      "SELECT applied_at FROM discount_allocations " +
      "WHERE order_id = ?1 ORDER BY applied_at DESC LIMIT 1",
      [orderId],
    );
    if (!r.rows.length) return null;
    return r.rows[0].applied_at;
  }

  async function _latestReversalAt(allocationId) {
    var r = await query(
      "SELECT occurred_at FROM discount_reversals " +
      "WHERE allocation_id = ?1 ORDER BY occurred_at DESC LIMIT 1",
      [allocationId],
    );
    if (!r.rows.length) return null;
    return r.rows[0].occurred_at;
  }

  async function recordAllocation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAllocation.recordAllocation: input object required");
    }
    var orderId   = _shortString(input.order_id, "order_id", MAX_LINE_ID_LEN);
    var source    = _shortString(input.discount_source, "discount_source", MAX_SOURCE_LEN);
    var kind      = _kind(input.kind);
    var total     = _positiveInt(input.total_minor, "total_minor");
    var breakdown = input.breakdown;
    if (!Array.isArray(breakdown) || breakdown.length === 0) {
      throw new TypeError("discountAllocation.recordAllocation: breakdown must be a non-empty array");
    }
    // Validate breakdown shape + the sum invariant. The persisted
    // row's audit value is only meaningful if `sum(allocated_minor)`
    // equals `total_minor` exactly; refuse the write rather than
    // silently store an inconsistent breakdown.
    var sum = 0;
    var seenIds = Object.create(null);
    for (var i = 0; i < breakdown.length; i += 1) {
      var row = breakdown[i];
      if (!row || typeof row !== "object") {
        throw new TypeError("discountAllocation.recordAllocation: breakdown[" + i + "] must be an object");
      }
      _shortString(row.line_id, "breakdown[" + i + "].line_id", MAX_LINE_ID_LEN);
      _nonNegInt(row.allocated_minor, "breakdown[" + i + "].allocated_minor");
      _nonNegInt(row.remaining_minor, "breakdown[" + i + "].remaining_minor");
      if (Object.prototype.hasOwnProperty.call(seenIds, row.line_id)) {
        throw new TypeError("discountAllocation.recordAllocation: breakdown[" + i + "].line_id duplicates an earlier row");
      }
      seenIds[row.line_id] = true;
      sum += row.allocated_minor;
    }
    if (sum !== total) {
      throw new TypeError(
        "discountAllocation.recordAllocation: breakdown sum (" + sum +
        ") does not equal total_minor (" + total + ")",
      );
    }
    var requested = _epochMs(input.applied_at, "applied_at");
    if (requested == null) requested = Date.now();
    var latest = await _latestAppliedAt(orderId);
    var ts = _resolveAppliedAt(requested, latest);

    var id = b.uuid.v7();
    await query(
      "INSERT INTO discount_allocations " +
      "(id, order_id, source, kind, total_minor, breakdown_json, applied_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      [id, orderId, source, kind, total, JSON.stringify(breakdown), ts],
    );
    return {
      id:             id,
      order_id:       orderId,
      source:         source,
      kind:           kind,
      total_minor:    total,
      breakdown:      breakdown.slice(),
      applied_at:     ts,
    };
  }

  async function allocationsForOrder(orderId) {
    _shortString(orderId, "order_id", MAX_LINE_ID_LEN);
    var r = await query(
      "SELECT id, order_id, source, kind, total_minor, breakdown_json, applied_at " +
      "FROM discount_allocations WHERE order_id = ?1 " +
      "ORDER BY applied_at DESC, id DESC",
      [orderId],
    );
    var rows = r.rows;
    var out = new Array(rows.length);
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      out[i] = {
        id:          row.id,
        order_id:    row.order_id,
        source:      row.source,
        kind:        row.kind,
        total_minor: row.total_minor,
        breakdown:   JSON.parse(row.breakdown_json),
        applied_at:  row.applied_at,
      };
    }
    return out;
  }

  // Reverse-walk an allocation: given a refund amount, distribute it
  // across the original breakdown proportional to each line's
  // `allocated_minor`. Half-even rounding via b.money; the rounding
  // remainder lands on the line with the largest original allocation
  // (the same "biggest line absorbs the cent" rule applied to the
  // reverse direction).
  function _reverseShares(refund, breakdown) {
    var weights = new Array(breakdown.length);
    var sumWeight = 0n;
    for (var i = 0; i < breakdown.length; i += 1) {
      weights[i] = breakdown[i].allocated_minor;
      sumWeight += BigInt(breakdown[i].allocated_minor);
    }
    if (sumWeight === 0n) {
      // Every original share was zero (shouldn't be possible because
      // recordAllocation refuses a sum-zero breakdown when total > 0,
      // but defensive). Spread evenly so the refund still produces a
      // complete breakdown.
      for (var k = 0; k < weights.length; k += 1) {
        weights[k] = 1;
        sumWeight += 1n;
      }
    }
    var money = b.money;
    var refundMoney = money.fromMinorUnits(BigInt(refund), ROUNDING_CURRENCY);
    var shares = new Array(breakdown.length);
    var allocated = 0n;
    for (var j = 0; j < breakdown.length; j += 1) {
      var share = refundMoney
        .multiply([BigInt(weights[j]), sumWeight])
        .toMinorUnits();
      shares[j] = share;
      allocated += share;
    }
    var remainder = BigInt(refund) - allocated;
    if (remainder !== 0n) {
      var bestIdx = 0;
      var bestAlloc = breakdown[0].allocated_minor;
      for (var m = 1; m < breakdown.length; m += 1) {
        if (breakdown[m].allocated_minor > bestAlloc) {
          bestAlloc = breakdown[m].allocated_minor;
          bestIdx = m;
        }
      }
      shares[bestIdx] = shares[bestIdx] + remainder;
    }
    return shares;
  }

  async function reverseAllocation(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAllocation.reverseAllocation: input object required");
    }
    var orderId = _shortString(input.order_id, "order_id", MAX_LINE_ID_LEN);
    var source  = _shortString(input.source,   "source",   MAX_SOURCE_LEN);
    var refund  = _positiveInt(input.refund_minor, "refund_minor");

    var r = await query(
      "SELECT id, breakdown_json, total_minor FROM discount_allocations " +
      "WHERE order_id = ?1 AND source = ?2 " +
      "ORDER BY applied_at DESC, id DESC LIMIT 1",
      [orderId, source],
    );
    if (!r.rows.length) {
      var err = new Error("discountAllocation.reverseAllocation: no allocation found for order_id + source");
      err.code = "DISCOUNT_ALLOCATION_NOT_FOUND";
      throw err;
    }
    var allocationId = r.rows[0].id;
    var breakdown    = JSON.parse(r.rows[0].breakdown_json);

    var shares = _reverseShares(refund, breakdown);
    var reverseBreakdown = new Array(breakdown.length);
    for (var i = 0; i < breakdown.length; i += 1) {
      reverseBreakdown[i] = {
        line_id:      breakdown[i].line_id,
        refund_minor: Number(shares[i]),
      };
    }

    var requested = _epochMs(input.occurred_at, "occurred_at");
    if (requested == null) requested = Date.now();
    var latest = await _latestReversalAt(allocationId);
    var ts = _resolveAppliedAt(requested, latest);

    var id = b.uuid.v7();
    await query(
      "INSERT INTO discount_reversals " +
      "(id, allocation_id, refund_minor, reverse_breakdown_json, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [id, allocationId, refund, JSON.stringify(reverseBreakdown), ts],
    );
    return {
      id:                 id,
      allocation_id:      allocationId,
      refund_minor:       refund,
      reverse_breakdown:  reverseBreakdown,
      occurred_at:        ts,
    };
  }

  async function metricsForKind(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("discountAllocation.metricsForKind: input object required");
    }
    var kind = _kind(input.kind);
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (from == null || to == null) {
      throw new TypeError("discountAllocation.metricsForKind: from + to required");
    }
    if (to < from) {
      throw new TypeError("discountAllocation.metricsForKind: to must be >= from");
    }
    var r = await query(
      "SELECT COUNT(*) AS cnt, COALESCE(SUM(total_minor), 0) AS total " +
      "FROM discount_allocations " +
      "WHERE kind = ?1 AND applied_at >= ?2 AND applied_at <= ?3",
      [kind, from, to],
    );
    var row = r.rows[0] || { cnt: 0, total: 0 };
    return {
      kind:      kind,
      from:      from,
      to:        to,
      count:     Number(row.cnt),
      sum_minor: Number(row.total),
    };
  }

  return {
    KINDS:                KINDS.slice(),
    allocate:             function (input) { return _allocate(input); },
    recordAllocation:     recordAllocation,
    allocationsForOrder:  allocationsForOrder,
    reverseAllocation:    reverseAllocation,
    metricsForKind:       metricsForKind,
  };
}

module.exports = {
  create: create,
  KINDS:  KINDS,
};
