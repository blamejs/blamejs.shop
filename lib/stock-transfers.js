"use strict";
/**
 * @module shop.stockTransfers
 * @title  Stock transfers — audited multi-step stock movement between locations
 *
 * @intro
 *   The `inventoryLocations` primitive ships
 *   `transferStock({ sku, from_location, to_location, quantity })` —
 *   an atomic two-row write that moves stock between locations
 *   instantly. That verb is correct when the operator is fixing a
 *   typo, or moving stock between two bins inside the same warehouse,
 *   where no "in transit" window exists.
 *
 *   This primitive is the COUNTERPART for moves that take physical
 *   time. A pallet leaves WH-EAST on Monday, lives on a truck for
 *   three days, lands at WH-WEST on Thursday. The operator wants:
 *
 *     - The origin shelf debited immediately, so storefront routing
 *       doesn't keep selling stock that's on a truck.
 *     - The destination shelf credited only when receiving scans
 *       confirm the qty.
 *     - A discrepancy flag when received qty != shipped qty (loss,
 *       damage, mis-pick at origin).
 *     - An audit trail of every state change with operator-supplied
 *       reasons so the variance reconciliation has a paper trail.
 *
 *   Lifecycle (six-state FSM):
 *
 *     openTransfer({ from_location, to_location, lines, expected_eta?, reason })
 *       Validates locations exist + are distinct, validates lines,
 *       confirms origin has enough stock for every line, then
 *       decrements origin via `inventoryLocations.adjustStock(-qty)`
 *       on each SKU. On any decrement failure (insufficient stock,
 *       unknown location) the prior decrements are reversed so the
 *       origin shelf is restored to its pre-call state. Returns
 *       `{ id, status: 'open', ... }`.
 *
 *     markShipped({ transfer_id, shipped_at?, carrier?, tracking_number? })
 *       open -> shipped. Captures carrier + tracking. shipped_at
 *       defaults to now.
 *
 *     markInTransit({ transfer_id, location?, occurred_at? })
 *       shipped -> in_transit (or no-op when already in_transit; the
 *       event log still captures the scan beat — operators read the
 *       event log to answer "where was the pallet on Tuesday?").
 *       `location` is the operator-supplied scan location (a
 *       transshipment hub code, free text — not constrained to the
 *       inventory_locations set). Appends an event row regardless.
 *
 *     markReceived({ transfer_id, received_lines, received_at })
 *       shipped|in_transit -> received. `received_lines` is the
 *       per-SKU `quantity_received` captured by the receiving scan.
 *       Refuses if any SKU in `received_lines` wasn't on the original
 *       transfer; missing SKUs in `received_lines` are treated as
 *       received=0 (operator forgot to scan, every shipped unit is
 *       discrepant — surfaces loudly at reconcile time).
 *
 *     reconcile({ transfer_id })
 *       received -> reconciled. Walks the lines: for each one credits
 *       the destination with `quantity_received` via
 *       `inventoryLocations.adjustStock(+qty)` and stores
 *       `discrepancy = quantity_shipped - quantity_received`. Lines
 *       with `quantity_received === 0` skip the destination credit
 *       (no money created). The discrepancy column is non-null on
 *       every line after reconcile — operators read it to drive the
 *       variance report.
 *
 *     markException({ transfer_id, reason })
 *       any non-terminal -> exception. Used when the pallet is lost
 *       or damaged. The origin stock has already been debited; the
 *       operator compensates via the existing
 *       `inventoryLocations.setStock` correction verb — the audit
 *       trail on `inventory_adjustments` captures the rationale and
 *       the variance report joins on `discrepanciesFor` for the
 *       per-transfer paper trail.
 *       Refuses if the transfer is already reconciled or in
 *       exception.
 *
 *   Reads:
 *     getTransfer(id)                             — hydrated header + lines
 *     listOpen({ from_location?, to_location? })  — non-terminal transfers
 *     transfersForLocation({ location_code, role: 'origin'|'destination',
 *                            limit?, cursor? })  — keyset-paginated
 *     discrepanciesFor(transfer_id)               — per-SKU diff
 *
 *   Composition:
 *     - b.uuid.v7              — transfer / line / event PKs (sortable)
 *     - b.guardUuid            — strict UUID validation on every transfer_id
 *     - b.pagination           — HMAC-tagged cursor for transfersForLocation
 *     - inventoryLocations     — the SOLE owner of stock mutation; this
 *                                primitive composes adjustStock to debit
 *                                origin / credit destination, never
 *                                writes to `inventory_stock` directly.
 *
 *   Three-tier input validation (use the discipline; don't write the
 *   labels): every public verb here is a defensive request-shape
 *   reader OR a config-time entry point. Both throw on bad input.
 *   The FSM transitions are operator-driven entry points — they
 *   throw on bad state too.
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var CODE_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKU_RE           = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CARRIER_RE       = /^[\S\s]{1,128}$/;
var TRACKING_RE      = /^[\S\s]{1,128}$/;
var SCAN_LOC_RE      = /^[\S\s]{1,128}$/;
var MAX_REASON       = 280;
var MAX_LINES        = 1000;
var MAX_LIST_LIMIT   = 200;

var TRANSFER_STATUSES = Object.freeze([
  "open", "shipped", "in_transit", "received", "reconciled", "exception",
]);
var TRANSFER_ROLES    = Object.freeze(["origin", "destination"]);
var TRANSFER_ORDER_KEY = ["opened_at:desc", "id:desc"];

// The transfer lifecycle, modelled on b.fsm — the same composition the order
// and quote primitives use (lib/order.js#_getOrderFsm, lib/quotes.js). The FSM
// is the single source of truth for which (status, event) pairs are legal:
// every status-changing verb replays the machine from the row's current status
// and asks whether the edge is allowed before it touches the database, so an
// illegal transition is refused identically regardless of which surface fired
// it. Each event name maps 1:1 to the verb that fires it:
//
//   ship       open                 -> shipped     (markShipped)
//   transit    shipped|in_transit   -> in_transit  (markInTransit; self-edge
//                                                    keeps the scan-beat log)
//   receive    shipped|in_transit   -> received    (markReceived)
//   reconcile  received             -> reconciled  (reconcile; credits dest)
//   except     open|shipped|in_transit|received
//                                   -> exception   (markException)
//
// Terminal states (reconciled, exception) declare no outgoing edge, so the
// machine itself refuses a double-reconcile / re-ship-after-exception without
// a hand-written status check.
var TRANSFER_TRANSITIONS = Object.freeze([
  { from: "open",       to: "shipped",    on: "ship" },
  { from: "shipped",    to: "in_transit", on: "transit" },
  { from: "in_transit", to: "in_transit", on: "transit" },
  { from: "shipped",    to: "received",   on: "receive" },
  { from: "in_transit", to: "received",   on: "receive" },
  { from: "received",   to: "reconciled", on: "reconcile" },
  { from: "open",       to: "exception",  on: "except" },
  { from: "shipped",    to: "exception",  on: "except" },
  { from: "in_transit", to: "exception",  on: "except" },
  { from: "received",   to: "exception",  on: "except" },
]);

var _transferFsm = null;
function _getTransferFsm() {
  if (_transferFsm) return _transferFsm;
  // b.fsm emits audit events under the 'fsm' namespace — register it
  // (idempotent) so the audit sink keeps the events instead of dropping them
  // with a noisy warning, exactly as the order/quote FSMs do.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent; ignore */ }
  _transferFsm = b.fsm.define({
    name:    "stock_transfer",
    initial: "open",
    states: {
      open:       {}, shipped:    {}, in_transit: {},
      received:   {}, reconciled: {}, exception:  {},
    },
    transitions: TRANSFER_TRANSITIONS.map(function (t) {
      return { from: t.from, to: t.to, on: t.on };
    }),
  });
  return _transferFsm;
}

// Validate one status-changing edge through the FSM. Returns true when the
// edge is legal from `fromStatus`, false otherwise. The verbs below use this
// to decide whether to issue the atomic claim-guard UPDATE — they keep
// throwing a TypeError on an illegal transition so the admin route's
// `e instanceof TypeError -> 400` mapping (admin.js#_transferAction) stays
// intact rather than surfacing a wrong-state as a 500.
function _canTransfer(fromStatus, event) {
  var fsm = _getTransferFsm();
  return fsm.restore({ state: fromStatus, history: [], context: {} }).can(event);
}

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("stock-transfers: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("stock-transfers: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("stock-transfers: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("stock-transfers: " + label + " must be a positive integer");
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("stock-transfers: " + label + " must be a non-negative integer");
  }
}
function _reason(s, label) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_REASON) {
    throw new TypeError("stock-transfers: " + (label || "reason") +
      " must be a string ≤ " + MAX_REASON + " chars");
  }
  return s;
}
function _carrier(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !CARRIER_RE.test(s) || s.length > 128) {
    throw new TypeError("stock-transfers: carrier must be a string ≤ 128 chars");
  }
  return s;
}
function _tracking(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !TRACKING_RE.test(s) || s.length > 128) {
    throw new TypeError("stock-transfers: tracking_number must be a string ≤ 128 chars");
  }
  return s;
}
function _scanLocation(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !SCAN_LOC_RE.test(s) || s.length > 128) {
    throw new TypeError("stock-transfers: location must be a string ≤ 128 chars");
  }
  return s;
}
function _ts(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("stock-transfers: " + label + " must be a non-negative integer (epoch ms)");
  }
  return n;
}
function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("stock-transfers: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // The inventoryLocations primitive is the sole owner of
  // `inventory_stock` mutations. This primitive composes its
  // adjustStock verb to debit origin / credit destination — refusing
  // to wire one through fails loud at boot rather than at first call.
  if (!opts.inventoryLocations ||
      typeof opts.inventoryLocations.adjustStock !== "function" ||
      typeof opts.inventoryLocations.getLocation !== "function" ||
      typeof opts.inventoryLocations.stockForSku !== "function") {
    throw new TypeError("stock-transfers.create: opts.inventoryLocations with " +
      "adjustStock + getLocation + stockForSku is required");
  }
  var locations = opts.inventoryLocations;
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged so an operator can't hand-
  // craft one to skip ahead or replay across deployments. Tests
  // inject a fixed dev string; production must supply an explicit
  // secret.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("stock-transfers.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "stock-transfers-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Validate the `lines` array shape at openTransfer time. Returns
  // normalized lines (defensive copies so the caller's object isn't
  // mutated downstream).
  function _validateOpenLines(rawLines) {
    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      throw new TypeError("stock-transfers.openTransfer: lines must be a non-empty array");
    }
    if (rawLines.length > MAX_LINES) {
      throw new TypeError("stock-transfers.openTransfer: lines must contain ≤ " + MAX_LINES + " entries");
    }
    var seen = Object.create(null);
    var normalized = [];
    for (var i = 0; i < rawLines.length; i += 1) {
      var l = rawLines[i];
      if (!l || typeof l !== "object") {
        throw new TypeError("stock-transfers.openTransfer: lines[" + i + "] must be an object");
      }
      _sku(l.sku);
      _positiveInt(l.quantity, "lines[" + i + "].quantity");
      if (seen[l.sku]) {
        throw new TypeError("stock-transfers.openTransfer: duplicate sku " +
          JSON.stringify(l.sku) + " in lines");
      }
      seen[l.sku] = true;
      normalized.push({ sku: l.sku, quantity: l.quantity });
    }
    return normalized;
  }

  // Persist one event-log row. Detail payload is JSON-serialized so
  // downstream readers parse one column instead of a polymorphic
  // per-event-type table.
  async function _writeEvent(transferId, eventType, scanLocation, detail, occurredAt) {
    var json = detail == null ? null : JSON.stringify(detail);
    await query(
      "INSERT INTO stock_transfer_events (id, transfer_id, event_type, location, detail_json, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [b.uuid.v7(), transferId, eventType, scanLocation, json, occurredAt],
    );
  }

  // Hydrate a transfer row + its lines + a parsed `lines` array.
  // Returns null on miss so the caller-handler maps cleanly to HTTP 404.
  async function _getHydrated(id) {
    var rRow = await query("SELECT * FROM stock_transfers WHERE id = ?1", [id]);
    if (!rRow.rows.length) return null;
    var transfer = rRow.rows[0];
    var rLines = await query(
      "SELECT * FROM stock_transfer_lines WHERE transfer_id = ?1 ORDER BY sku ASC",
      [id],
    );
    transfer.lines = rLines.rows;
    return transfer;
  }

  return {

    // Open a new transfer. Validates locations + lines, then debits
    // the origin shelf one SKU at a time via inventoryLocations.
    // adjustStock(-qty). If any debit fails, every prior debit is
    // restored so the origin shelf returns to its pre-call state and
    // no header row is persisted. Returns the hydrated transfer.
    openTransfer: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stock-transfers.openTransfer: input object required");
      }
      _code(input.from_location, "from_location");
      _code(input.to_location,   "to_location");
      if (input.from_location === input.to_location) {
        throw new TypeError("stock-transfers.openTransfer: from_location and to_location must differ");
      }
      var lines = _validateOpenLines(input.lines);
      var reason = _reason(input.reason);
      var expectedEta = _ts(input.expected_eta, "expected_eta");

      var fromLoc = await locations.getLocation(input.from_location);
      if (!fromLoc) {
        throw new TypeError("stock-transfers.openTransfer: from_location " +
          JSON.stringify(input.from_location) + " not found");
      }
      var toLoc = await locations.getLocation(input.to_location);
      if (!toLoc) {
        throw new TypeError("stock-transfers.openTransfer: to_location " +
          JSON.stringify(input.to_location) + " not found");
      }

      // Pre-flight: confirm origin has enough stock for every line
      // before debiting anything. Fails fast with a single clear
      // error rather than relying on adjustStock to refuse mid-loop
      // and forcing the compensating-restore path on the common case.
      for (var p = 0; p < lines.length; p += 1) {
        var ln = lines[p];
        var sfs = await locations.stockForSku(ln.sku);
        var atOrigin = 0;
        for (var q = 0; q < sfs.by_location.length; q += 1) {
          if (sfs.by_location[q].code === input.from_location) {
            atOrigin = sfs.by_location[q].quantity;
            break;
          }
        }
        if (atOrigin < ln.quantity) {
          throw new TypeError("stock-transfers.openTransfer: insufficient stock at " +
            input.from_location + " for sku " + ln.sku +
            " (have " + atOrigin + ", need " + ln.quantity + ")");
        }
      }

      var id = b.uuid.v7();
      var ts = _now();

      // Debit origin one line at a time. On failure (race with a
      // concurrent sale, for instance), restore every successful
      // debit so the operator can retry without phantom inventory
      // sitting in a half-opened transfer.
      var debited = [];
      try {
        for (var i = 0; i < lines.length; i += 1) {
          await locations.adjustStock({
            sku: lines[i].sku,
            location_code: input.from_location,
            delta: -lines[i].quantity,
            reason: "stock-transfer:open:" + id,
          });
          debited.push(lines[i]);
        }
      } catch (e) {
        for (var j = debited.length - 1; j >= 0; j -= 1) {
          try {
            await locations.adjustStock({
              sku: debited[j].sku,
              location_code: input.from_location,
              delta: debited[j].quantity,
              reason: "stock-transfer:open:rollback:" + id,
            });
          } catch (_e2) { /* drop-silent — the original error is what the caller needs to fix */ }
        }
        throw e;
      }

      // Persist the header + lines + open event. The FK + CASCADE
      // means a header-insert failure that lands AFTER the lines
      // insert is impossible — the header is the parent. Any DB
      // failure here also triggers the origin-restore compensating
      // path so the shelf returns to its pre-call state.
      try {
        await query(
          "INSERT INTO stock_transfers (id, from_location, to_location, status, reason, " +
          "expected_eta, opened_at) VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6)",
          [id, input.from_location, input.to_location, reason, expectedEta, ts],
        );
        for (var k = 0; k < lines.length; k += 1) {
          await query(
            "INSERT INTO stock_transfer_lines (id, transfer_id, sku, quantity_shipped) " +
            "VALUES (?1, ?2, ?3, ?4)",
            [b.uuid.v7(), id, lines[k].sku, lines[k].quantity],
          );
        }
        await _writeEvent(id, "open", input.from_location, {
          lines: lines, reason: reason,
        }, ts);
      } catch (e2) {
        try { await query("DELETE FROM stock_transfers WHERE id = ?1", [id]); }
        catch (_e3) { /* drop-silent — the original error is what the operator needs */ }
        for (var m = lines.length - 1; m >= 0; m -= 1) {
          try {
            await locations.adjustStock({
              sku: lines[m].sku,
              location_code: input.from_location,
              delta: lines[m].quantity,
              reason: "stock-transfer:open:rollback:" + id,
            });
          } catch (_e4) { /* drop-silent — original error is the operator's signal */ }
        }
        throw e2;
      }

      return await _getHydrated(id);
    },

    // open -> shipped. Captures carrier + tracking number. Refuses
    // if the transfer is not in 'open' state — markShipped twice is
    // not idempotent (operators that want a retry call getTransfer
    // first to see current state).
    markShipped: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stock-transfers.markShipped: input object required");
      }
      var id = _id(input.transfer_id, "transfer_id");
      var carrier  = _carrier(input.carrier);
      var tracking = _tracking(input.tracking_number);
      var shippedAt = input.shipped_at == null ? _now() : _ts(input.shipped_at, "shipped_at");
      var transfer = await _getHydrated(id);
      if (!transfer) {
        throw new TypeError("stock-transfers.markShipped: transfer " + id + " not found");
      }
      if (!_canTransfer(transfer.status, "ship")) {
        throw new TypeError("stock-transfers.markShipped: transfer is " + transfer.status +
          ", only open transfers can be shipped");
      }
      // Claim the open -> shipped transition atomically — the WHERE status
      // clause makes a concurrent double-ship a no-op for the loser.
      var claim = await query(
        "UPDATE stock_transfers SET status = 'shipped', shipped_at = ?1, " +
        "carrier = ?2, tracking_number = ?3 WHERE id = ?4 AND status = 'open'",
        [shippedAt, carrier, tracking, id],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("stock-transfers.markShipped: transfer " + id +
          " is no longer open (shipped by a concurrent call)");
      }
      await _writeEvent(id, "ship", transfer.from_location, {
        carrier: carrier, tracking_number: tracking,
      }, shippedAt);
      return await _getHydrated(id);
    },

    // shipped|in_transit -> in_transit. Idempotent on in_transit —
    // the event log still captures the scan beat so operators can
    // answer "where was the pallet on Tuesday?".
    markInTransit: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stock-transfers.markInTransit: input object required");
      }
      var id = _id(input.transfer_id, "transfer_id");
      var scanLoc = _scanLocation(input.location);
      var occurredAt = input.occurred_at == null ? _now() : _ts(input.occurred_at, "occurred_at");
      var transfer = await _getHydrated(id);
      if (!transfer) {
        throw new TypeError("stock-transfers.markInTransit: transfer " + id + " not found");
      }
      if (!_canTransfer(transfer.status, "transit")) {
        throw new TypeError("stock-transfers.markInTransit: transfer is " + transfer.status +
          ", only shipped or in_transit transfers can record an in_transit scan");
      }
      // Only the shipped -> in_transit edge flips status; the in_transit
      // self-edge is an idempotent scan-beat that just appends an event. Claim
      // the shipped -> in_transit flip with a WHERE status clause so two
      // concurrent first-scans don't both believe they advanced the row.
      if (transfer.status === "shipped") {
        await query(
          "UPDATE stock_transfers SET status = 'in_transit' WHERE id = ?1 AND status = 'shipped'",
          [id],
        );
      }
      await _writeEvent(id, "in_transit", scanLoc, null, occurredAt);
      return await _getHydrated(id);
    },

    // shipped|in_transit -> received. Captures per-SKU
    // quantity_received. SKUs not in `received_lines` are recorded
    // as received=0 (the operator forgot to scan; every shipped
    // unit will be flagged discrepant at reconcile time).
    markReceived: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stock-transfers.markReceived: input object required");
      }
      var id = _id(input.transfer_id, "transfer_id");
      if (!Array.isArray(input.received_lines)) {
        throw new TypeError("stock-transfers.markReceived: received_lines must be an array");
      }
      var receivedAt = input.received_at == null ? _now() : _ts(input.received_at, "received_at");
      // Validate received_lines shape up-front; build a sku -> qty
      // map for the per-line UPDATE pass.
      var rxMap = Object.create(null);
      for (var i = 0; i < input.received_lines.length; i += 1) {
        var rl = input.received_lines[i];
        if (!rl || typeof rl !== "object") {
          throw new TypeError("stock-transfers.markReceived: received_lines[" + i + "] must be an object");
        }
        _sku(rl.sku);
        _nonNegInt(rl.quantity_received, "received_lines[" + i + "].quantity_received");
        if (Object.prototype.hasOwnProperty.call(rxMap, rl.sku)) {
          throw new TypeError("stock-transfers.markReceived: duplicate sku " +
            JSON.stringify(rl.sku) + " in received_lines");
        }
        rxMap[rl.sku] = rl.quantity_received;
      }
      var transfer = await _getHydrated(id);
      if (!transfer) {
        throw new TypeError("stock-transfers.markReceived: transfer " + id + " not found");
      }
      if (!_canTransfer(transfer.status, "receive")) {
        throw new TypeError("stock-transfers.markReceived: transfer is " + transfer.status +
          ", only shipped or in_transit transfers can be received");
      }
      // Refuse SKUs that weren't on the original transfer. Missing
      // SKUs (in shipped lines but not received_lines) are not a
      // refusal — they end up with quantity_received = 0, which
      // shows up as a discrepancy at reconcile time.
      var shippedSkus = Object.create(null);
      for (var s = 0; s < transfer.lines.length; s += 1) {
        shippedSkus[transfer.lines[s].sku] = true;
      }
      var rxSkus = Object.keys(rxMap);
      for (var t = 0; t < rxSkus.length; t += 1) {
        if (!shippedSkus[rxSkus[t]]) {
          throw new TypeError("stock-transfers.markReceived: sku " + JSON.stringify(rxSkus[t]) +
            " was not on the original transfer");
        }
      }
      // Claim the (shipped|in_transit) -> received transition atomically
      // BEFORE writing the per-line received quantities. Two concurrent
      // receives both pass the read above, but only one UPDATE matches the
      // expected status — the loser refuses, so a single set of
      // quantity_received values lands and reconcile can't later credit twice.
      var priorStatus = transfer.status;
      var claim = await query(
        "UPDATE stock_transfers SET status = 'received', received_at = ?1 " +
        "WHERE id = ?2 AND status IN ('shipped', 'in_transit')",
        [receivedAt, id],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("stock-transfers.markReceived: transfer " + id +
          " is no longer shipped or in_transit (received by a concurrent call)");
      }
      // Walk every shipped line; write quantity_received (defaulting to 0 for
      // SKUs the operator didn't scan). Each write is idempotent (the same
      // quantity lands on a retry), so if a line throws the terminal claim is
      // rolled back to its prior status — the transfer stays eligible for
      // markReceived rather than stranding with partial / default quantities a
      // later reconcile would then credit against.
      try {
        for (var u = 0; u < transfer.lines.length; u += 1) {
          var line = transfer.lines[u];
          var got  = Object.prototype.hasOwnProperty.call(rxMap, line.sku) ? rxMap[line.sku] : 0;
          await query(
            "UPDATE stock_transfer_lines SET quantity_received = ?1 WHERE id = ?2",
            [got, line.id],
          );
        }
      } catch (e) {
        await query(
          "UPDATE stock_transfers SET status = ?1, received_at = NULL " +
          "WHERE id = ?2 AND status = 'received'",
          [priorStatus, id],
        );
        throw e;
      }
      await _writeEvent(id, "receive", transfer.to_location, {
        received_lines: input.received_lines,
      }, receivedAt);
      return await _getHydrated(id);
    },

    // received -> reconciled. Credits the destination per line and
    // stamps the discrepancy column. Lines with quantity_received=0
    // skip the destination credit (no money created).
    reconcile: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stock-transfers.reconcile: input object required");
      }
      var id = _id(input.transfer_id, "transfer_id");
      var transfer = await _getHydrated(id);
      if (!transfer) {
        throw new TypeError("stock-transfers.reconcile: transfer " + id + " not found");
      }
      // Refuse an illegal transition with a TypeError (kept for the route's
      // 400 mapping). The status read here is only a fast-fail / clear-message
      // path; the conditional claim-guard below is what actually serializes
      // two concurrent reconciles.
      if (!_canTransfer(transfer.status, "reconcile")) {
        throw new TypeError("stock-transfers.reconcile: transfer is " + transfer.status +
          ", only received transfers can be reconciled");
      }
      var ts = _now();
      // Claim the received -> reconciled transition atomically BEFORE crediting
      // the destination. Two concurrent reconciles both pass the read above,
      // but only one UPDATE matches `status = 'received'` — the loser gets
      // rowCount 0 and refuses, so the destination shelf is credited exactly
      // once. (Without this guard both calls would credit, minting phantom
      // inventory at the destination.)
      var claim = await query(
        "UPDATE stock_transfers SET status = 'reconciled', reconciled_at = ?1 " +
        "WHERE id = ?2 AND status = 'received'",
        [ts, id],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("stock-transfers.reconcile: transfer " + id +
          " is no longer received (already reconciled by a concurrent call) — refusing to double-credit");
      }
      var discrepancies = [];
      // Credit the destination one line at a time. The claim above flipped the
      // status, so a concurrent call can't reach this loop for the same
      // transfer. Each line is skipped once its discrepancy column is stamped,
      // so a retry (after the compensation below rolls the claim back) re-credits
      // ONLY the lines that hadn't landed yet — no double-credit on the lines
      // that already succeeded. If any line throws, the terminal claim is rolled
      // back to 'received' so the transfer stays eligible for another reconcile
      // that finishes the remaining credits, rather than stranding it.
      try {
        for (var i = 0; i < transfer.lines.length; i += 1) {
          var line = transfer.lines[i];
          if (line.discrepancy != null) continue;   // already credited on a prior attempt
          var rx   = line.quantity_received == null ? 0 : line.quantity_received;
          if (rx > 0) {
            await locations.adjustStock({
              sku: line.sku,
              location_code: transfer.to_location,
              delta: rx,
              reason: "stock-transfer:reconcile:" + id,
            });
          }
          var diff = line.quantity_shipped - rx;
          await query(
            "UPDATE stock_transfer_lines SET discrepancy = ?1 WHERE id = ?2",
            [diff, line.id],
          );
          if (diff !== 0) {
            discrepancies.push({
              sku:               line.sku,
              quantity_shipped:  line.quantity_shipped,
              quantity_received: rx,
              discrepancy:       diff,
            });
          }
        }
      } catch (e) {
        await query(
          "UPDATE stock_transfers SET status = 'received', reconciled_at = NULL " +
          "WHERE id = ?1 AND status = 'reconciled'",
          [id],
        );
        throw e;
      }
      await _writeEvent(id, "reconcile", transfer.to_location, {
        discrepancies: discrepancies,
      }, ts);
      return await _getHydrated(id);
    },

    // any non-terminal -> exception. Lost / damaged / disputed. The
    // origin stock has already been debited at open; the operator
    // compensates via a separate inventoryLocations.setStock
    // correction so the audit trail on inventory_adjustments carries
    // the rationale alongside the discrepanciesFor variance report.
    markException: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("stock-transfers.markException: input object required");
      }
      var id = _id(input.transfer_id, "transfer_id");
      var reason = _reason(input.reason, "exception reason");
      if (!reason.length) {
        throw new TypeError("stock-transfers.markException: reason must be a non-empty string");
      }
      var transfer = await _getHydrated(id);
      if (!transfer) {
        throw new TypeError("stock-transfers.markException: transfer " + id + " not found");
      }
      if (!_canTransfer(transfer.status, "except")) {
        throw new TypeError("stock-transfers.markException: transfer is " + transfer.status +
          ", terminal states cannot transition to exception");
      }
      var ts = _now();
      // Claim the non-terminal -> exception transition atomically. The WHERE
      // status clause refuses if a concurrent reconcile / exception already
      // moved the row to a terminal state.
      var claim = await query(
        "UPDATE stock_transfers SET status = 'exception', exception_reason = ?1 " +
        "WHERE id = ?2 AND status IN ('open', 'shipped', 'in_transit', 'received')",
        [reason, id],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("stock-transfers.markException: transfer " + id +
          " is no longer in a non-terminal state (settled by a concurrent call)");
      }
      await _writeEvent(id, "exception", null, { reason: reason }, ts);
      return await _getHydrated(id);
    },

    // Read a hydrated transfer or null on miss.
    getTransfer: async function (transferId) {
      var id = _id(transferId, "transfer_id");
      return await _getHydrated(id);
    },

    // List non-terminal transfers (open / shipped / in_transit /
    // received). Optionally scoped to one origin or destination.
    // Ordered by (opened_at DESC, id DESC) — operators read the
    // freshest transfers at the top.
    listOpen: async function (listOpts) {
      listOpts = listOpts || {};
      var hasFrom = listOpts.from_location !== undefined && listOpts.from_location !== null;
      var hasTo   = listOpts.to_location   !== undefined && listOpts.to_location   !== null;
      if (hasFrom) _code(listOpts.from_location, "from_location");
      if (hasTo)   _code(listOpts.to_location,   "to_location");
      var openStates = "('open','shipped','in_transit','received')";
      var sql, params;
      if (hasFrom && hasTo) {
        sql = "SELECT * FROM stock_transfers WHERE from_location = ?1 AND to_location = ?2 " +
              "AND status IN " + openStates + " ORDER BY opened_at DESC, id DESC";
        params = [listOpts.from_location, listOpts.to_location];
      } else if (hasFrom) {
        sql = "SELECT * FROM stock_transfers WHERE from_location = ?1 " +
              "AND status IN " + openStates + " ORDER BY opened_at DESC, id DESC";
        params = [listOpts.from_location];
      } else if (hasTo) {
        sql = "SELECT * FROM stock_transfers WHERE to_location = ?1 " +
              "AND status IN " + openStates + " ORDER BY opened_at DESC, id DESC";
        params = [listOpts.to_location];
      } else {
        sql = "SELECT * FROM stock_transfers WHERE status IN " + openStates +
              " ORDER BY opened_at DESC, id DESC";
        params = [];
      }
      var rows = (await query(sql, params)).rows;
      // Hydrate lines per row so the admin UI doesn't need a fan-out
      // fetch. For larger pages this is N+1 reads; the indexed
      // (transfer_id) lookup keeps each one cheap.
      for (var i = 0; i < rows.length; i += 1) {
        var rL = await query(
          "SELECT * FROM stock_transfer_lines WHERE transfer_id = ?1 ORDER BY sku ASC",
          [rows[i].id],
        );
        rows[i].lines = rL.rows;
      }
      return rows;
    },

    // Paginated list of transfers where `location_code` is either the
    // origin or destination (caller picks via `role`). Cursor is
    // HMAC-tagged so an operator can't tamper or replay across
    // orderKey changes. Mirrors the cursor shape used by
    // inventory-receive.list / order-notes.listForOrder.
    transfersForLocation: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("stock-transfers.transfersForLocation: opts object required");
      }
      _code(listOpts.location_code, "location_code");
      if (TRANSFER_ROLES.indexOf(listOpts.role) === -1) {
        throw new TypeError("stock-transfers.transfersForLocation: role must be one of " +
          TRANSFER_ROLES.join(", ") + ", got " + JSON.stringify(listOpts.role));
      }
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit);
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("stock-transfers.transfersForLocation: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(TRANSFER_ORDER_KEY)) {
            throw new TypeError("stock-transfers.transfersForLocation: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("stock-transfers.transfersForLocation: cursor — " + (e && e.message || "malformed"));
        }
      }
      var col = listOpts.role === "origin" ? "from_location" : "to_location";
      var sql, params;
      if (cursorVals) {
        sql = "SELECT * FROM stock_transfers WHERE " + col + " = ?1 AND " +
              "(opened_at < ?2 OR (opened_at = ?2 AND id < ?3)) " +
              "ORDER BY opened_at DESC, id DESC LIMIT ?4";
        params = [listOpts.location_code, cursorVals[0], cursorVals[1], limit];
      } else {
        sql = "SELECT * FROM stock_transfers WHERE " + col + " = ?1 " +
              "ORDER BY opened_at DESC, id DESC LIMIT ?2";
        params = [listOpts.location_code, limit];
      }
      var rows = (await query(sql, params)).rows;
      for (var i = 0; i < rows.length; i += 1) {
        var rL = await query(
          "SELECT * FROM stock_transfer_lines WHERE transfer_id = ?1 ORDER BY sku ASC",
          [rows[i].id],
        );
        rows[i].lines = rL.rows;
      }
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: TRANSFER_ORDER_KEY,
          vals:     [last.opened_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    // Per-SKU shipped/received/discrepancy view. Returns every line
    // on the transfer regardless of whether it has a discrepancy —
    // operators reading this verb want the full picture, including
    // the zero-diff lines, so the variance report doesn't omit the
    // "this part came through clean" rows.
    discrepanciesFor: async function (transferId) {
      var id = _id(transferId, "transfer_id");
      var transfer = await _getHydrated(id);
      if (!transfer) return null;
      var out = [];
      for (var i = 0; i < transfer.lines.length; i += 1) {
        var line = transfer.lines[i];
        var rx   = line.quantity_received == null ? null : line.quantity_received;
        var diff = line.discrepancy == null
          ? (rx == null ? null : line.quantity_shipped - rx)
          : line.discrepancy;
        out.push({
          sku:               line.sku,
          quantity_shipped:  line.quantity_shipped,
          quantity_received: rx,
          discrepancy:       diff,
        });
      }
      return out;
    },
  };
}

module.exports = {
  create:            create,
  TRANSFER_STATUSES: TRANSFER_STATUSES,
  TRANSFER_ROLES:    TRANSFER_ROLES,
};
