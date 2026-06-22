"use strict";
/**
 * @module shop.inventoryReceive
 * @title  Inventory receipts — bulk stock receipt with audit trail
 *
 * @intro
 *   The catalog inventory surface exposes per-SKU restock; operators
 *   receiving a shipment of stock want a single record that groups
 *   every line, persists who-received / what-supplier / what-PO /
 *   how-much-it-cost, and applies the whole batch as one atomic
 *   operation — and reverses the same way when a delivery turns out
 *   wrong. This primitive layers on top of catalog.inventory.restock
 *   so the catalog stays the single owner of stock mutation while
 *   the receipt record carries the audit trail.
 *
 *   Lifecycle:
 *
 *     draft({ reference, supplier?, received_by?, notes?, lines })
 *       → inserts a 'pending' receipt + every line in one DB pass.
 *         No stock mutation; lines are captured but the catalog's
 *         inventory table is untouched. Returns
 *         { id, status: 'pending', total_qty, total_value_minor }.
 *
 *     apply(receipt_id)
 *       → walks the lines and calls catalog.inventory.restock(sku, qty)
 *         for each one. If any restock throws, the whole apply is
 *         rolled back — every successful restock so far is undone via
 *         a direct UPDATE that decrements stock_on_hand by the same
 *         amount, and the receipt remains 'pending' so the operator
 *         can fix the offending line and retry. On success, the
 *         status transitions to 'applied'. Idempotent on 'applied':
 *         calling apply twice returns the same shape with
 *         applied_count = 0 and stock_changes = [].
 *
 *     reverse(receipt_id, { reason? })
 *       → walks the lines of an 'applied' receipt and reverses each
 *         one via a direct stock_on_hand decrement (catalog does not
 *         expose a public stock_on_hand decrement verb; restock with
 *         a negative qty is refused, by design). The reversal clamps
 *         at zero — a receipt can't drive stock negative even if the
 *         operator has decremented stock_on_hand by other means
 *         between apply and reverse. Status transitions to 'reversed'.
 *         Refuses if the receipt is not currently 'applied'.
 *
 *     get(id) / byReference(reference) / list({ status?, limit?, cursor? })
 *       → reads. list paginates over (received_at DESC, id DESC) via
 *         an HMAC-tagged cursor (b.pagination) so an operator can't
 *         hand-craft a cursor to skip ahead.
 *
 *   Composition:
 *     - b.uuid.v7        — receipt + line PKs (sortable; B-tree locality)
 *     - b.guardUuid      — strict UUID validation on receipt_id reads
 *     - b.pagination     — HMAC-tagged cursor for list()
 *     - catalog.inventory.restock — the one place stock_on_hand grows
 *
 *   The factory accepts an optional `query` (defaults to
 *   b.externalDb.query) and a required `catalog` handle so the
 *   primitive can stay decoupled from any specific catalog binding
 *   (tests inject an in-memory-SQLite-backed catalog + a stub
 *   restock; production wires the real catalog created at boot).
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var REFERENCE_RE    = /^[A-Za-z0-9][A-Za-z0-9._\/ -]{0,127}$/;
var CURRENCY_RE     = /^[A-Z]{3}$/;
var MAX_REF_LEN     = 128;
var MAX_SUPPLIER_LEN = 256;
var MAX_RECVBY_LEN  = 256;
var MAX_NOTES_LEN   = 4000;
var MAX_LINE_NOTES_LEN = 4000;
var MAX_LINES       = 1000;
var MAX_LIST_LIMIT  = 200;

var RECEIPT_STATUSES = Object.freeze(["pending", "applied", "reversed"]);
var RECEIPT_ORDER_KEY = ["received_at:desc", "id:desc"];

// The receipt lifecycle, modelled on b.fsm — the same composition the order /
// quote / stock-transfer primitives use. The FSM is the single source of truth
// for which (status, event) pairs are legal:
//
//   apply    pending -> applied    (apply; restocks every line)
//   reverse  applied -> reversed   (reverse; decrements every line back out)
//
// Terminal (reversed) declares no outgoing edge, so the machine itself refuses
// a reverse-after-reverse. `apply` on an already-'applied' receipt is a
// documented IDEMPOTENT no-op (returns { applied_count: 0 }) — apply() short-
// circuits to that no-op before consulting the machine, preserving the
// replay-safe contract callers depend on.
var RECEIPT_TRANSITIONS = Object.freeze([
  { from: "pending", to: "applied",  on: "apply" },
  { from: "applied", to: "reversed", on: "reverse" },
]);

var _receiptFsm = null;
function _getReceiptFsm() {
  if (_receiptFsm) return _receiptFsm;
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent; ignore */ }
  _receiptFsm = b.fsm.define({
    name:    "inventory_receipt",
    initial: "pending",
    states:  { pending: {}, applied: {}, reversed: {} },
    transitions: RECEIPT_TRANSITIONS.map(function (t) {
      return { from: t.from, to: t.to, on: t.on };
    }),
  });
  return _receiptFsm;
}

function _canReceipt(fromStatus, event) {
  var fsm = _getReceiptFsm();
  return fsm.restore({ state: fromStatus, history: [], context: {} }).can(event);
}

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("inventory-receive: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-receive: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
}
function _reference(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REF_LEN || !REFERENCE_RE.test(s)) {
    throw new TypeError("inventory-receive: reference must be a non-empty string ≤ " + MAX_REF_LEN +
      " chars matching /^[A-Za-z0-9][A-Za-z0-9._\\/ -]*$/");
  }
}
function _shortText(s, label, max) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > max) {
    throw new TypeError("inventory-receive: " + label + " must be a string ≤ " + max + " chars");
  }
  return s;
}
function _notes(s, label, max) {
  return _shortText(s, label, max);
}
function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("inventory-receive: currency must be a 3-letter ISO 4217 code (uppercase), got " + JSON.stringify(s));
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("inventory-receive: " + label + " must be a positive integer");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-receive: " + label + " must be a non-negative integer");
  }
}
function _limit(n, label) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("inventory-receive: " + label + " must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || !opts.catalog.inventory || typeof opts.catalog.inventory.restock !== "function") {
    throw new TypeError("inventory-receive.create: opts.catalog with inventory.restock(sku, qty) required");
  }
  var catalog = opts.catalog;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged so an operator can't hand-
  // craft one to skip ahead or replay across deployments. The
  // secret must be stable for the deployment; rotating it
  // invalidates outstanding cursors (acceptable). Tests inject a
  // fixed dev string; production must supply an explicit secret.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("inventory-receive.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "inventory-receive-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Validate the `lines` array shape. Returns the normalized lines
  // plus the cached totals so the draft insert doesn't have to
  // re-walk the array.
  function _validateLines(lines, currency) {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new TypeError("inventory-receive: lines must be a non-empty array");
    }
    if (lines.length > MAX_LINES) {
      throw new TypeError("inventory-receive: lines must contain ≤ " + MAX_LINES + " entries");
    }
    var totalQty   = 0;
    var totalValue = 0;
    var normalized = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      if (!l || typeof l !== "object") {
        throw new TypeError("inventory-receive: lines[" + i + "] must be an object");
      }
      _sku(l.sku);
      _positiveInt(l.qty_received, "lines[" + i + "].qty_received");
      var unitCost = l.unit_cost_minor == null ? 0 : l.unit_cost_minor;
      _nonNegInt(unitCost, "lines[" + i + "].unit_cost_minor");
      var unitCurrency = l.unit_cost_currency == null ? currency : l.unit_cost_currency;
      _currency(unitCurrency);
      var lineNotes = _notes(l.notes, "lines[" + i + "].notes", MAX_LINE_NOTES_LEN);
      totalQty   += l.qty_received;
      totalValue += l.qty_received * unitCost;
      normalized.push({
        sku:                l.sku,
        qty_received:       l.qty_received,
        unit_cost_minor:    unitCost,
        unit_cost_currency: unitCurrency,
        notes:              lineNotes,
      });
    }
    return { lines: normalized, total_qty: totalQty, total_value_minor: totalValue };
  }

  // Hydrate a receipt row with its lines + parsed numerics. Returns
  // null for an unknown id so the caller-handler can map to HTTP 404.
  async function _getHydrated(id) {
    var rRow = await query("SELECT * FROM inventory_receipts WHERE id = ?1", [id]);
    if (!rRow.rows.length) return null;
    var receipt = rRow.rows[0];
    var rLines = await query(
      "SELECT * FROM inventory_receipt_lines WHERE receipt_id = ?1 ORDER BY id ASC",
      [id],
    );
    receipt.lines = rLines.rows;
    return receipt;
  }

  return {
    // Create a pending receipt. All lines are inserted in the same
    // logical operation; if any line validates badly, the partial
    // header insert is rolled back via an explicit DELETE so the DB
    // doesn't carry an orphan pending receipt forward.
    draft: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-receive.draft: input object required");
      }
      _reference(input.reference);
      var supplier   = _shortText(input.supplier,    "supplier",    MAX_SUPPLIER_LEN);
      var receivedBy = _shortText(input.received_by, "received_by", MAX_RECVBY_LEN);
      var notes      = _notes(input.notes, "notes", MAX_NOTES_LEN);
      var totalCurrency = input.total_currency == null ? "USD" : input.total_currency;
      _currency(totalCurrency);
      var normalized = _validateLines(input.lines, totalCurrency);

      // Refuse the duplicate reference up front with a clean error
      // shape instead of relying on the UNIQUE constraint to throw a
      // raw SQLITE_CONSTRAINT — the catch path below still catches
      // any race-window dup, but the up-front check gives the
      // common case a descriptive message.
      var dup = await query(
        "SELECT id FROM inventory_receipts WHERE reference = ?1 LIMIT 1",
        [input.reference],
      );
      if (dup.rows.length) {
        throw new TypeError("inventory-receive.draft: reference " + JSON.stringify(input.reference) + " already exists");
      }

      var id = b.uuid.v7();
      var ts = _now();
      var receivedAt = input.received_at == null ? ts : input.received_at;
      if (!Number.isInteger(receivedAt) || receivedAt < 0) {
        throw new TypeError("inventory-receive.draft: received_at must be a non-negative integer (epoch ms)");
      }

      try {
        await query(
          "INSERT INTO inventory_receipts (id, reference, supplier, received_by, received_at, status, " +
          "total_qty, total_value_minor, total_currency, notes, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?8, ?9, ?10, ?10)",
          [
            id, input.reference, supplier, receivedBy, receivedAt,
            normalized.total_qty, normalized.total_value_minor, totalCurrency, notes, ts,
          ],
        );
        for (var i = 0; i < normalized.lines.length; i += 1) {
          var l = normalized.lines[i];
          await query(
            "INSERT INTO inventory_receipt_lines (id, receipt_id, sku, qty_received, " +
            "unit_cost_minor, unit_cost_currency, notes, created_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            [b.uuid.v7(), id, l.sku, l.qty_received, l.unit_cost_minor, l.unit_cost_currency, l.notes, ts],
          );
        }
      } catch (e) {
        // Best-effort rollback of the header + any lines that landed
        // before the failure (ON DELETE CASCADE on the FK clears the
        // lines). D1 doesn't expose a transaction handle to this
        // primitive, so the rollback is a compensating DELETE.
        try { await query("DELETE FROM inventory_receipts WHERE id = ?1", [id]); }
        catch (_e2) { /* drop-silent — the original error is what the caller needs */ }
        throw e;
      }

      return {
        id:                id,
        status:            "pending",
        total_qty:         normalized.total_qty,
        total_value_minor: normalized.total_value_minor,
      };
    },

    // Apply a pending receipt. Walks lines + calls
    // catalog.inventory.restock(sku, qty) for each. Idempotent on
    // 'applied'. If any restock throws, the partial mutations are
    // undone via direct stock_on_hand decrements and the receipt
    // stays 'pending' so the operator can fix + retry.
    apply: async function (receiptId) {
      _id(receiptId, "receipt id");
      var receipt = await _getHydrated(receiptId);
      if (!receipt) {
        throw new TypeError("inventory-receive.apply: receipt " + receiptId + " not found");
      }
      // Preserve the idempotent no-op on an already-'applied' receipt: the
      // FSM has no apply edge out of 'applied', so short-circuit here BEFORE
      // asserting the transition (regression-safe replay contract — callers
      // replay apply() without surprise).
      if (!_canReceipt(receipt.status, "apply")) {
        if (receipt.status === "applied") {
          return { id: receiptId, applied_count: 0, stock_changes: [] };
        }
        throw new TypeError("inventory-receive.apply: receipt is " + receipt.status + ", only pending receipts can be applied");
      }
      // Claim the pending -> applied transition atomically BEFORE restocking.
      // Two concurrent applies both pass the read above, but only one UPDATE
      // matches `status = 'pending'`; the loser sees rowCount 0 and returns the
      // idempotent no-op instead of double-restocking the catalog. (Without
      // this guard both calls would restock every line, inflating
      // stock_on_hand.)
      var ts = _now();
      var claim = await query(
        "UPDATE inventory_receipts SET status = 'applied', updated_at = ?1 WHERE id = ?2 AND status = 'pending'",
        [ts, receiptId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        // A concurrent call won the claim and is restocking (or already did).
        // Replay-safe no-op so the loser doesn't double-apply.
        return { id: receiptId, applied_count: 0, stock_changes: [] };
      }
      var stockChanges = [];
      var applied      = [];
      try {
        for (var i = 0; i < receipt.lines.length; i += 1) {
          var l = receipt.lines[i];
          await catalog.inventory.restock(l.sku, l.qty_received);
          applied.push({ sku: l.sku, qty: l.qty_received });
          stockChanges.push({ sku: l.sku, qty: l.qty_received });
        }
      } catch (e) {
        // Undo every successful restock so the database state matches the
        // pre-apply snapshot, then release the claim back to 'pending' so the
        // operator can fix the offending line and retry.
        for (var j = applied.length - 1; j >= 0; j -= 1) {
          try {
            await query(
              "UPDATE inventory SET stock_on_hand = MAX(0, stock_on_hand - ?1), updated_at = ?2 WHERE sku = ?3",
              [applied[j].qty, _now(), applied[j].sku],
            );
          } catch (_e3) { /* drop-silent — the original apply error is what the operator needs to fix */ }
        }
        try {
          await query(
            "UPDATE inventory_receipts SET status = 'pending', updated_at = ?1 WHERE id = ?2 AND status = 'applied'",
            [_now(), receiptId],
          );
        } catch (_e4) { /* drop-silent — the original apply error is the operator's signal */ }
        var err = new Error("inventory-receive.apply: restock failed — " + (e && e.message || e));
        err.cause = e;
        throw err;
      }
      return {
        id:            receiptId,
        applied_count: applied.length,
        stock_changes: stockChanges,
      };
    },

    // Reverse an applied receipt. Walks lines + decrements
    // stock_on_hand directly (catalog does not expose a public
    // stock_on_hand decrement verb — restock refuses negative qty
    // by design). The MAX(0, ...) clamp prevents driving stock
    // negative if the operator has further decremented the SKU via
    // an out-of-band path between apply and reverse.
    reverse: async function (receiptId, reverseOpts) {
      _id(receiptId, "receipt id");
      var reason = reverseOpts && reverseOpts.reason != null
        ? _shortText(reverseOpts.reason, "reason", MAX_NOTES_LEN)
        : "";
      var receipt = await _getHydrated(receiptId);
      if (!receipt) {
        throw new TypeError("inventory-receive.reverse: receipt " + receiptId + " not found");
      }
      if (!_canReceipt(receipt.status, "reverse")) {
        throw new TypeError("inventory-receive.reverse: receipt is " + receipt.status + ", only applied receipts can be reversed");
      }
      // Claim the applied -> reversed transition atomically BEFORE decrementing.
      // Two concurrent reverses both pass the read above, but only one UPDATE
      // matches `status = 'applied'`; the loser refuses, so the shelf is
      // decremented exactly once. (Without this guard both calls would
      // decrement every line, destroying unrelated base stock.)
      var claimTs = _now();
      var claim = await query(
        "UPDATE inventory_receipts SET status = 'reversed', updated_at = ?1 WHERE id = ?2 AND status = 'applied'",
        [claimTs, receiptId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("inventory-receive.reverse: receipt " + receiptId +
          " is no longer applied (reversed by a concurrent call)");
      }
      var stockChanges = [];
      var decremented  = [];
      try {
        for (var i = 0; i < receipt.lines.length; i += 1) {
          var l = receipt.lines[i];
          var ts = _now();
          // Capture how many units the decrement ACTUALLY removes: a prior
          // out-of-band decrement can leave stock below qty_received, so the
          // removable amount is floored at what's on hand. Recording the real
          // delta (not qty_received) is what makes a compensating add-back on
          // a mid-loop failure an exact inverse — the old `MAX(0,...)` clamp
          // removed fewer units than the compensation later added back, minting
          // phantom stock. `removed <= prior`, so the subtraction never goes
          // negative and the clamp is no longer needed.
          var priorRow = (await query(
            "SELECT stock_on_hand FROM inventory WHERE sku = ?1", [l.sku],
          )).rows[0];
          var prior   = priorRow ? Number(priorRow.stock_on_hand) : 0;
          var removed = Math.min(l.qty_received, prior);
          await query(
            "UPDATE inventory SET stock_on_hand = stock_on_hand - ?1, updated_at = ?2 WHERE sku = ?3",
            [removed, ts, l.sku],
          );
          decremented.push({ sku: l.sku, removed: removed });
          stockChanges.push({ sku: l.sku, qty: -removed });
        }
      } catch (e) {
        // Compensate the decrements that already landed and release the claim so
        // the receipt stays eligible for another reverse — otherwise a mid-loop
        // failure strands it 'reversed' with only a partial stock rollback that
        // the status check then refuses to retry.
        for (var c = 0; c < decremented.length; c += 1) {
          var dl = decremented[c];
          try {
            await query(
              "UPDATE inventory SET stock_on_hand = stock_on_hand + ?1, updated_at = ?2 WHERE sku = ?3",
              [dl.removed, _now(), dl.sku],
            );
          } catch (_compErr) { /* best-effort compensation; the claim release below restores retryability */ }
        }
        await query(
          "UPDATE inventory_receipts SET status = 'applied', updated_at = ?1 WHERE id = ?2 AND status = 'reversed'",
          [_now(), receiptId],
        );
        throw e;
      }
      // Append the reason into the receipt notes so the audit trail
      // carries the rationale. Operators that want a richer reversal
      // record compose on top — this primitive captures the minimal
      // useful signal.
      var newNotes = receipt.notes;
      if (reason.length) {
        var prefix = newNotes.length ? newNotes + "\n" : "";
        newNotes = prefix + "[reversed] " + reason;
        if (newNotes.length > MAX_NOTES_LEN) {
          newNotes = newNotes.slice(0, MAX_NOTES_LEN);
        }
      }
      // Status was already flipped to 'reversed' by the atomic claim above;
      // this write only stamps the reversal reason into the notes.
      var ts2 = _now();
      await query(
        "UPDATE inventory_receipts SET notes = ?1, updated_at = ?2 WHERE id = ?3",
        [newNotes, ts2, receiptId],
      );
      return {
        id:             receiptId,
        reversed_count: receipt.lines.length,
        stock_changes:  stockChanges,
      };
    },

    // Read a receipt + its hydrated lines. Returns null on miss so
    // the caller-handler maps cleanly to HTTP 404.
    get: async function (receiptId) {
      _id(receiptId, "receipt id");
      return await _getHydrated(receiptId);
    },

    // Operator lookup by the PO / receipt number they typed in.
    byReference: async function (reference) {
      _reference(reference);
      var r = await query(
        "SELECT id FROM inventory_receipts WHERE reference = ?1 LIMIT 1",
        [reference],
      );
      if (!r.rows.length) return null;
      return await _getHydrated(r.rows[0].id);
    },

    // Paginated list ordered (received_at DESC, id DESC). Cursor is
    // HMAC-tagged so an operator can't tamper or replay across
    // orderKey changes. Mirrors the cursor shape used by
    // order.listForCustomer / catalog.products.list.
    list: async function (listOpts) {
      listOpts = listOpts || {};
      var status = listOpts.status;
      if (status !== undefined && status !== null) {
        if (RECEIPT_STATUSES.indexOf(status) === -1) {
          throw new TypeError("inventory-receive.list: status must be one of " +
            RECEIPT_STATUSES.join(", ") + ", got " + JSON.stringify(status));
        }
      }
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit, "limit");
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("inventory-receive.list: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(RECEIPT_ORDER_KEY)) {
            throw new TypeError("inventory-receive.list: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("inventory-receive.list: cursor — " + (e && e.message || "malformed"));
        }
      }
      var sql, params;
      var hasStatus = status !== undefined && status !== null;
      if (hasStatus && cursorVals) {
        sql = "SELECT * FROM inventory_receipts WHERE status = ?1 AND " +
              "(received_at < ?2 OR (received_at = ?2 AND id < ?3)) " +
              "ORDER BY received_at DESC, id DESC LIMIT ?4";
        params = [status, cursorVals[0], cursorVals[1], limit];
      } else if (hasStatus) {
        sql = "SELECT * FROM inventory_receipts WHERE status = ?1 " +
              "ORDER BY received_at DESC, id DESC LIMIT ?2";
        params = [status, limit];
      } else if (cursorVals) {
        sql = "SELECT * FROM inventory_receipts WHERE " +
              "(received_at < ?1 OR (received_at = ?1 AND id < ?2)) " +
              "ORDER BY received_at DESC, id DESC LIMIT ?3";
        params = [cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM inventory_receipts " +
              "ORDER BY received_at DESC, id DESC LIMIT ?1";
        params = [limit];
      }
      var rows = (await query(sql, params)).rows;
      // Hydrate lines per row so the admin UI doesn't need a fan-out
      // fetch. For larger pages this is N+1 reads; the indexed
      // (receipt_id) lookup keeps each one cheap.
      for (var i = 0; i < rows.length; i += 1) {
        var rL = await query(
          "SELECT * FROM inventory_receipt_lines WHERE receipt_id = ?1 ORDER BY id ASC",
          [rows[i].id],
        );
        rows[i].lines = rL.rows;
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: RECEIPT_ORDER_KEY,
          vals:     [last.received_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },
  };
}

module.exports = {
  create:           create,
  RECEIPT_STATUSES: RECEIPT_STATUSES,
};
