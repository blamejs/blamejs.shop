"use strict";
/**
 * @module shop.stockReceipts
 * @title  Stock receipts — customer-facing proof-of-receipt via QR
 *
 * @intro
 *   Every shipped order's packing slip prints a QR code that resolves
 *   to a single-use plaintext token. When the customer scans the QR on
 *   arrival, the storefront walks them through a checklist of the
 *   order's line items: confirm received, flag damaged, or leave a
 *   line pending until they finish unpacking. The primitive records
 *   every scan event (audit trail), tracks per-line state with
 *   partial-quantity support, and on `completeReceipt` composes the
 *   optional `loyaltyEarnRules` handle to award goods-received points.
 *
 *   FSM (receipt token):
 *
 *     issued --recordReceiptScan--> scanned --completeReceipt--> completed
 *           \                                  ^
 *            \--(expires_at < now)--> expired |
 *
 *     `completed` and `expired` are terminal. The first scan flips the
 *     row to `scanned`; subsequent scans append to the event log
 *     without re-flipping the FSM. `completeReceipt` refuses on
 *     `issued` (the customer must scan first) and on `expired` /
 *     `completed`.
 *
 *   FSM (per-line state):
 *
 *     pending --markLineReceived--> received
 *            \--markLineDamaged --> damaged
 *            \--mixed quantities--> partial   (when received > 0 AND damaged > 0)
 *
 *   Token plaintext:
 *     32 random bytes from `b.crypto.generateBytes`, rendered as 43-
 *     char base64url (no padding). Returned EXACTLY ONCE from
 *     `issueReceiptToken`; only the SHA3-512 namespace-hash lands on
 *     `stock_receipt_tokens.token_hash`. `recordReceiptScan` re-hashes
 *     the presented token and looks up — wrong tokens surface as
 *     not-found rather than leaking timing information.
 *
 *   Composes:
 *     - `b.crypto.generateBytes`   — uniform 32-byte plaintext draw.
 *     - `b.crypto.namespaceHash`   — SHA3-512 hash under the
 *                                    `stock-receipt-token` namespace,
 *                                    and per-scan UA / IP hashing so
 *                                    audit reads don't carry raw PII.
 *     - `b.crypto.timingSafeEqual` — constant-time hex compare on
 *                                    recordReceiptScan.
 *     - `b.guardUuid`              — strict UUID gate on order_id /
 *                                    receipt id reads.
 *     - `b.uuid.v7`                — receipt token + scan row PKs
 *                                    (lexicographic + monotonic so
 *                                    audit reads sort cleanly).
 *     - `loyaltyEarnRules` (optional) — when wired, `completeReceipt`
 *                                    calls `evaluateForEvent({
 *                                    trigger: "per_purchase", ... })`
 *                                    once the line checklist is
 *                                    closed. Failures are drop-silent
 *                                    — the receipt is complete
 *                                    regardless of whether the points
 *                                    landed.
 *
 *   Storage: `migrations-d1/0177_stock_receipts.sql` —
 *     `stock_receipt_tokens` + `stock_receipt_scans` (FK CASCADE) +
 *     `stock_receipt_line_states` (FK CASCADE).
 *
 * @primitive stockReceipts
 * @related   b.crypto, b.uuid, b.guardUuid, loyaltyEarnRules
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}
var C = _b().constants;

// ---- constants ----------------------------------------------------------

var TOKEN_NAMESPACE         = "stock-receipt-token";
var UA_NAMESPACE            = "stock-receipt-user-agent";
var IP_NAMESPACE            = "stock-receipt-client-ip";

var TOKEN_BYTE_LEN          = 32;
var TOKEN_PLAINTEXT_LEN     = 43;
var TOKEN_PLAINTEXT_RE      = /^[A-Za-z0-9_-]{43}$/;

var SKU_RE                  = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var MAX_REASON_LEN          = 500;
var MAX_UA_LEN              = 1024;
var MAX_IP_LEN              = 64;
var MAX_LIST_LIMIT          = 500;
var MAX_LINES               = 200;

var DEFAULT_EXPIRES_HOURS   = 24 * 30;          // 30 days
var MIN_EXPIRES_HOURS       = 1;
var MAX_EXPIRES_HOURS       = 24 * 365;         // 1 year

var RECEIPT_STATUSES        = Object.freeze([
  "issued", "scanned", "completed", "expired",
]);
var LINE_STATES             = Object.freeze([
  "pending", "received", "damaged", "partial",
]);

var CONTROL_BYTE_RE         = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// ---- monotonic clock ----------------------------------------------------
//
// FSM transitions + scan events land on epoch-ms timestamps. The
// receipt's first scan can land in the same millisecond as a follow-
// up scan from a re-opened tab; strict-monotonic ordering guarantees
// `scanned_at` is distinct row-by-row so a chronological dashboard
// sort returns events in the order they were issued.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _orderId(s) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("stockReceipts: order_id — " + (e && e.message || "invalid UUID")); }
}

function _uuid(s, label) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("stockReceipts: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("stockReceipts: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("stockReceipts: " + label + " must be a positive integer");
  }
  return n;
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("stockReceipts: " + label + " must be a non-negative integer");
  }
  return n;
}

function _expiresInHours(n) {
  if (n == null) return DEFAULT_EXPIRES_HOURS;
  if (!Number.isInteger(n) || n < MIN_EXPIRES_HOURS || n > MAX_EXPIRES_HOURS) {
    throw new TypeError("stockReceipts: expires_in_hours must be an integer in [" +
                        MIN_EXPIRES_HOURS + ", " + MAX_EXPIRES_HOURS + "]");
  }
  return n;
}

function _limit(n) {
  if (n == null) return 50;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("stockReceipts: limit must be an integer in [1, " + MAX_LIST_LIMIT + "]");
  }
  return n;
}

function _reason(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_REASON_LEN) {
    throw new TypeError("stockReceipts: reason must be a non-empty string <= " + MAX_REASON_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("stockReceipts: reason must not contain control bytes");
  }
  return s;
}

function _canonicalToken(input) {
  if (typeof input !== "string" || !input.length) {
    throw new TypeError("stockReceipts: token must be a non-empty string");
  }
  if (!TOKEN_PLAINTEXT_RE.test(input)) {
    throw new TypeError("stockReceipts: token must be 43 base64url characters");
  }
  return input;
}

function _uaOpt(s) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > MAX_UA_LEN) {
    throw new TypeError("stockReceipts: user_agent must be a string <= " + MAX_UA_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("stockReceipts: user_agent must not contain control bytes");
  }
  return s;
}

function _ipOpt(s) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > MAX_IP_LEN) {
    throw new TypeError("stockReceipts: client_ip must be a string <= " + MAX_IP_LEN + " chars");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("stockReceipts: client_ip must not contain control bytes");
  }
  return s;
}

function _linesArray(arr) {
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new TypeError("stockReceipts: lines must be a non-empty array");
  }
  if (arr.length > MAX_LINES) {
    throw new TypeError("stockReceipts: lines must contain <= " + MAX_LINES + " entries");
  }
  var seen = Object.create(null);
  var out = [];
  for (var i = 0; i < arr.length; i += 1) {
    var ln = arr[i];
    if (!ln || typeof ln !== "object") {
      throw new TypeError("stockReceipts: lines[" + i + "] must be an object");
    }
    var sku = _sku(ln.sku);
    if (seen[sku]) {
      throw new TypeError("stockReceipts: lines[" + i + "].sku duplicates a previous entry");
    }
    seen[sku] = true;
    var qty = _positiveInt(ln.quantity_expected, "lines[" + i + "].quantity_expected");
    out.push({ sku: sku, quantity_expected: qty });
  }
  return out;
}

// ---- token generation + hashing -----------------------------------------

function _generateToken() {
  var buf = _b().crypto.generateBytes(TOKEN_BYTE_LEN);
  return _b().crypto.toBase64Url(buf);
}

function _hashToken(canonical) {
  return _b().crypto.namespaceHash(TOKEN_NAMESPACE, canonical);
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // order is optional — when wired, issueReceiptToken can look up the
  // expected line items from order.getById so the operator doesn't
  // have to re-supply them inline. Absent, the caller passes `lines`
  // explicitly.
  var orderPrim = opts.order || null;
  if (orderPrim && typeof orderPrim.getById !== "function") {
    throw new TypeError("stockReceipts.create: opts.order must expose a getById(id) method");
  }

  // loyaltyEarnRules is optional — when wired, completeReceipt fires
  // a per_purchase award once the customer closes the checklist.
  // Failures are drop-silent (the receipt is complete regardless of
  // whether the loyalty award landed).
  var loyaltyEarnRules = opts.loyaltyEarnRules || null;
  if (loyaltyEarnRules && typeof loyaltyEarnRules.evaluateForEvent !== "function") {
    throw new TypeError("stockReceipts.create: opts.loyaltyEarnRules must expose an evaluateForEvent(input) method");
  }

  // ---- internal helpers -------------------------------------------------

  async function _receiptRowById(id) {
    var r = await query("SELECT * FROM stock_receipt_tokens WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _receiptRowByOrder(orderId) {
    var r = await query(
      "SELECT * FROM stock_receipt_tokens WHERE order_id = ?1",
      [orderId],
    );
    return r.rows[0] || null;
  }

  async function _receiptRowByTokenHash(hash) {
    var r = await query(
      "SELECT * FROM stock_receipt_tokens WHERE token_hash = ?1",
      [hash],
    );
    return r.rows[0] || null;
  }

  async function _linesForReceipt(receiptId) {
    var r = await query(
      "SELECT * FROM stock_receipt_line_states WHERE receipt_id = ?1 ORDER BY sku ASC",
      [receiptId],
    );
    return r.rows;
  }

  function _decodeReceipt(row, lines) {
    if (!row) return null;
    return {
      id:                row.id,
      order_id:          row.order_id,
      status:            row.status,
      expires_at:        Number(row.expires_at),
      issued_at:         Number(row.issued_at),
      first_scanned_at:  row.first_scanned_at != null ? Number(row.first_scanned_at) : null,
      completed_at:      row.completed_at     != null ? Number(row.completed_at)     : null,
      created_at:        Number(row.created_at),
      updated_at:        Number(row.updated_at),
      lines:             lines || [],
    };
  }

  function _decodeLine(row) {
    return {
      sku:                row.sku,
      quantity_expected:  Number(row.quantity_expected),
      quantity_received:  Number(row.quantity_received),
      quantity_damaged:   Number(row.quantity_damaged),
      state:              row.state,
      damage_reason:      row.damage_reason,
      updated_at:         Number(row.updated_at),
    };
  }

  function _decodeScan(row) {
    return {
      id:               row.id,
      receipt_id:       row.receipt_id,
      scanned_at:       Number(row.scanned_at),
      user_agent_hash:  row.user_agent_hash,
      client_ip_hash:   row.client_ip_hash,
    };
  }

  async function _hydrate(row) {
    if (!row) return null;
    var lines = await _linesForReceipt(row.id);
    return _decodeReceipt(row, lines.map(_decodeLine));
  }

  // Per-row terminal-state guard. A `scanned` row whose expires_at has
  // passed reads as terminal (refuse markLineReceived, etc.). The FSM
  // never auto-flips the row to `expired` mid-call — that's a job for
  // a future sweep — but the read-side guard prevents post-expiry
  // mutations.
  function _isLive(row, nowTs) {
    if (row.status === "completed" || row.status === "expired") return false;
    if (Number(row.expires_at) < nowTs) return false;
    return true;
  }

  // ---- issueReceiptToken -----------------------------------------------

  async function issueReceiptToken(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("stockReceipts.issueReceiptToken: input object required");
    }
    var orderId      = _orderId(input.order_id);
    var lines        = _linesArray(input.lines);
    var expiresHours = _expiresInHours(input.expires_in_hours);

    // Re-issuance: an existing row for this order is overwritten in
    // place (the prior token_hash is replaced atomically, the scan
    // log persists). Refuse if the row is already `completed` — the
    // customer's audit trail is closed.
    var existing = await _receiptRowByOrder(orderId);
    if (existing && existing.status === "completed") {
      throw new TypeError("stockReceipts.issueReceiptToken: order " + orderId +
                          " has a completed receipt; no re-issuance");
    }

    var id        = existing ? existing.id : _b().uuid.v7();
    var plaintext = _generateToken();
    var tokenHash = _hashToken(plaintext);
    var nowTs     = _now();
    var expiresAt = nowTs + C.TIME.hours(expiresHours);

    if (existing) {
      await query(
        "UPDATE stock_receipt_tokens " +
        "SET token_hash = ?1, status = 'issued', expires_at = ?2, " +
        "first_scanned_at = NULL, completed_at = NULL, updated_at = ?3 " +
        "WHERE id = ?4",
        [tokenHash, expiresAt, nowTs, id],
      );
      // Replace the line states atomically — operators who re-issue
      // after editing the packing slip get a fresh checklist.
      await query("DELETE FROM stock_receipt_line_states WHERE receipt_id = ?1", [id]);
    } else {
      await query(
        "INSERT INTO stock_receipt_tokens " +
        "(id, order_id, token_hash, status, expires_at, issued_at, " +
        " first_scanned_at, completed_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, 'issued', ?4, ?5, NULL, NULL, ?5, ?5)",
        [id, orderId, tokenHash, expiresAt, nowTs],
      );
    }

    for (var i = 0; i < lines.length; i += 1) {
      var ln = lines[i];
      await query(
        "INSERT INTO stock_receipt_line_states " +
        "(receipt_id, sku, quantity_expected, quantity_received, quantity_damaged, " +
        " state, damage_reason, updated_at) " +
        "VALUES (?1, ?2, ?3, 0, 0, 'pending', NULL, ?4)",
        [id, ln.sku, ln.quantity_expected, nowTs],
      );
    }

    // Plaintext token is returned EXACTLY ONCE here. Subsequent reads
    // of the receipt row never see it again — the storage column
    // carries only the SHA3-512 namespace-hash. The picker embeds the
    // plaintext in the QR rendered on the packing slip and discards it.
    return {
      receipt_id:      id,
      order_id:        orderId,
      plaintext_token: plaintext,
      status:          "issued",
      expires_at:      expiresAt,
      issued_at:       nowTs,
      lines:           lines.map(function (l) {
        return {
          sku:               l.sku,
          quantity_expected: l.quantity_expected,
          quantity_received: 0,
          quantity_damaged:  0,
          state:             "pending",
        };
      }),
    };
  }

  // ---- recordReceiptScan -----------------------------------------------

  async function recordReceiptScan(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("stockReceipts.recordReceiptScan: input object required");
    }
    var token = _canonicalToken(input.token);
    var ua    = _uaOpt(input.user_agent);
    var ip    = _ipOpt(input.client_ip);

    var hash    = _hashToken(token);
    var receipt = await _receiptRowByTokenHash(hash);
    if (!receipt) {
      var miss = new Error("stockReceipts.recordReceiptScan: receipt not found");
      miss.code = "STOCK_RECEIPT_NOT_FOUND";
      throw miss;
    }

    // Constant-time hex compare on the matched row's hash — belt-
    // and-braces over the SQL = match.
    if (!_b().crypto.timingSafeEqual(receipt.token_hash, hash)) {
      var mismatch = new Error("stockReceipts.recordReceiptScan: receipt not found");
      mismatch.code = "STOCK_RECEIPT_NOT_FOUND";
      throw mismatch;
    }

    var nowTs = _now();
    if (receipt.status === "completed") {
      var done = new Error("stockReceipts.recordReceiptScan: receipt already completed");
      done.code = "STOCK_RECEIPT_COMPLETED";
      throw done;
    }
    if (receipt.status === "expired" || Number(receipt.expires_at) < nowTs) {
      var expired = new Error("stockReceipts.recordReceiptScan: receipt has expired");
      expired.code = "STOCK_RECEIPT_EXPIRED";
      throw expired;
    }

    var scanId = _b().uuid.v7();
    var uaHash = ua != null ? _b().crypto.namespaceHash(UA_NAMESPACE, ua) : null;
    var ipHash = ip != null ? _b().crypto.namespaceHash(IP_NAMESPACE, ip) : null;

    await query(
      "INSERT INTO stock_receipt_scans " +
      "(id, receipt_id, scanned_at, user_agent_hash, client_ip_hash) " +
      "VALUES (?1, ?2, ?3, ?4, ?5)",
      [scanId, receipt.id, nowTs, uaHash, ipHash],
    );

    // First scan flips the receipt FSM `issued -> scanned`. Subsequent
    // scans append the event without re-flipping (the timestamp on
    // `first_scanned_at` is sticky for audit purposes).
    if (receipt.status === "issued") {
      await query(
        "UPDATE stock_receipt_tokens " +
        "SET status = 'scanned', first_scanned_at = ?1, updated_at = ?1 " +
        "WHERE id = ?2",
        [nowTs, receipt.id],
      );
    } else {
      await query(
        "UPDATE stock_receipt_tokens SET updated_at = ?1 WHERE id = ?2",
        [nowTs, receipt.id],
      );
    }

    var fresh = await _hydrate(await _receiptRowById(receipt.id));
    return {
      scan_id:    scanId,
      receipt:    fresh,
      scanned_at: nowTs,
    };
  }

  // ---- markLineReceived ------------------------------------------------

  async function markLineReceived(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("stockReceipts.markLineReceived: input object required");
    }
    var receiptId = _uuid(input.receipt_id, "receipt_id");
    var sku       = _sku(input.sku);
    var qty       = input.quantity_received == null
      ? null
      : _nonNegInt(input.quantity_received, "quantity_received");

    var nowTs   = _now();
    var receipt = await _receiptRowById(receiptId);
    if (!receipt) {
      throw new TypeError("stockReceipts.markLineReceived: receipt " + receiptId + " not found");
    }
    if (!_isLive(receipt, nowTs)) {
      throw new TypeError("stockReceipts.markLineReceived: receipt status is " +
                          receipt.status + " (or expired); only scanned receipts can mark lines");
    }
    if (receipt.status !== "scanned") {
      throw new TypeError("stockReceipts.markLineReceived: receipt status is " +
                          receipt.status + "; customer must scan the QR before marking lines");
    }

    var lineRow = (await query(
      "SELECT * FROM stock_receipt_line_states WHERE receipt_id = ?1 AND sku = ?2",
      [receiptId, sku],
    )).rows[0];
    if (!lineRow) {
      throw new TypeError("stockReceipts.markLineReceived: sku " + JSON.stringify(sku) +
                          " is not in the receipt's line set");
    }

    var expected = Number(lineRow.quantity_expected);
    var received = qty == null ? expected : qty;
    if (received > expected) {
      throw new TypeError("stockReceipts.markLineReceived: quantity_received " + received +
                          " exceeds quantity_expected " + expected + " for sku " + JSON.stringify(sku));
    }

    // Mixed state: if the line already has damaged quantity recorded,
    // received + damaged must not exceed expected, and the line state
    // becomes `partial` rather than `received` (the line isn't fully
    // received because some quantity was damaged).
    var damaged = Number(lineRow.quantity_damaged);
    if (received + damaged > expected) {
      throw new TypeError("stockReceipts.markLineReceived: received " + received +
                          " + damaged " + damaged + " exceeds quantity_expected " + expected +
                          " for sku " + JSON.stringify(sku));
    }
    var newState;
    if (damaged > 0 && received > 0) {
      newState = "partial";
    } else if (damaged > 0) {
      // received == 0 and damaged > 0 — keep the line damaged
      newState = "damaged";
    } else {
      newState = received === expected ? "received" : "partial";
    }

    await query(
      "UPDATE stock_receipt_line_states " +
      "SET quantity_received = ?1, state = ?2, updated_at = ?3 " +
      "WHERE receipt_id = ?4 AND sku = ?5",
      [received, newState, nowTs, receiptId, sku],
    );
    await query(
      "UPDATE stock_receipt_tokens SET updated_at = ?1 WHERE id = ?2",
      [nowTs, receiptId],
    );
    return await _hydrate(await _receiptRowById(receiptId));
  }

  // ---- markLineDamaged -------------------------------------------------

  async function markLineDamaged(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("stockReceipts.markLineDamaged: input object required");
    }
    var receiptId = _uuid(input.receipt_id, "receipt_id");
    var sku       = _sku(input.sku);
    var qty       = input.quantity_damaged == null
      ? null
      : _nonNegInt(input.quantity_damaged, "quantity_damaged");
    var reason    = _reason(input.reason);

    var nowTs   = _now();
    var receipt = await _receiptRowById(receiptId);
    if (!receipt) {
      throw new TypeError("stockReceipts.markLineDamaged: receipt " + receiptId + " not found");
    }
    if (!_isLive(receipt, nowTs)) {
      throw new TypeError("stockReceipts.markLineDamaged: receipt status is " +
                          receipt.status + " (or expired); only scanned receipts can mark lines");
    }
    if (receipt.status !== "scanned") {
      throw new TypeError("stockReceipts.markLineDamaged: receipt status is " +
                          receipt.status + "; customer must scan the QR before marking lines");
    }

    var lineRow = (await query(
      "SELECT * FROM stock_receipt_line_states WHERE receipt_id = ?1 AND sku = ?2",
      [receiptId, sku],
    )).rows[0];
    if (!lineRow) {
      throw new TypeError("stockReceipts.markLineDamaged: sku " + JSON.stringify(sku) +
                          " is not in the receipt's line set");
    }

    var expected = Number(lineRow.quantity_expected);
    var damaged  = qty == null ? expected : qty;
    if (damaged > expected) {
      throw new TypeError("stockReceipts.markLineDamaged: quantity_damaged " + damaged +
                          " exceeds quantity_expected " + expected + " for sku " + JSON.stringify(sku));
    }

    var received = Number(lineRow.quantity_received);
    if (received + damaged > expected) {
      throw new TypeError("stockReceipts.markLineDamaged: received " + received +
                          " + damaged " + damaged + " exceeds quantity_expected " + expected +
                          " for sku " + JSON.stringify(sku));
    }
    var newState;
    if (received > 0 && damaged > 0) {
      newState = "partial";
    } else if (received > 0) {
      // damaged == 0 — keep the line received
      newState = received === expected ? "received" : "partial";
    } else {
      newState = damaged === expected ? "damaged" : "partial";
    }

    await query(
      "UPDATE stock_receipt_line_states " +
      "SET quantity_damaged = ?1, damage_reason = ?2, state = ?3, updated_at = ?4 " +
      "WHERE receipt_id = ?5 AND sku = ?6",
      [damaged, reason, newState, nowTs, receiptId, sku],
    );
    await query(
      "UPDATE stock_receipt_tokens SET updated_at = ?1 WHERE id = ?2",
      [nowTs, receiptId],
    );
    return await _hydrate(await _receiptRowById(receiptId));
  }

  // ---- completeReceipt -------------------------------------------------

  async function completeReceipt(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("stockReceipts.completeReceipt: input object required");
    }
    var receiptId  = _uuid(input.receipt_id, "receipt_id");
    var customerId = input.customer_id != null
      ? _uuid(input.customer_id, "customer_id")
      : null;

    var nowTs   = _now();
    var receipt = await _receiptRowById(receiptId);
    if (!receipt) {
      throw new TypeError("stockReceipts.completeReceipt: receipt " + receiptId + " not found");
    }
    if (receipt.status === "completed") {
      var done = new Error("stockReceipts.completeReceipt: receipt already completed");
      done.code = "STOCK_RECEIPT_COMPLETED";
      throw done;
    }
    if (receipt.status === "expired" || Number(receipt.expires_at) < nowTs) {
      var expired = new Error("stockReceipts.completeReceipt: receipt has expired");
      expired.code = "STOCK_RECEIPT_EXPIRED";
      throw expired;
    }
    if (receipt.status !== "scanned") {
      throw new TypeError("stockReceipts.completeReceipt: receipt status is " +
                          receipt.status + "; customer must scan before completing");
    }

    var lines = (await _linesForReceipt(receiptId)).map(_decodeLine);

    await query(
      "UPDATE stock_receipt_tokens " +
      "SET status = 'completed', completed_at = ?1, updated_at = ?1 " +
      "WHERE id = ?2",
      [nowTs, receiptId],
    );

    var summary = {
      total_lines:       lines.length,
      received_lines:    0,
      damaged_lines:     0,
      partial_lines:     0,
      pending_lines:     0,
      total_quantity_received: 0,
      total_quantity_damaged:  0,
    };
    for (var i = 0; i < lines.length; i += 1) {
      var ln = lines[i];
      if (ln.state === "received")      summary.received_lines += 1;
      else if (ln.state === "damaged")  summary.damaged_lines  += 1;
      else if (ln.state === "partial")  summary.partial_lines  += 1;
      else                              summary.pending_lines  += 1;
      summary.total_quantity_received += ln.quantity_received;
      summary.total_quantity_damaged  += ln.quantity_damaged;
    }

    // Compose loyaltyEarnRules — drop-silent on failure. The
    // receipt is complete regardless of whether the loyalty award
    // landed; an operator audit reads the loyalty_earn_log to find
    // misses. We fire `per_purchase` keyed by the order_id so the
    // dedup UNIQUE on (rule_slug, customer_id, trigger_event_ref)
    // protects against re-completion (which can't happen anyway —
    // completed is terminal — but defends a future re-completion
    // path against double-award).
    var loyaltyResult = null;
    if (loyaltyEarnRules && customerId) {
      try {
        loyaltyResult = await loyaltyEarnRules.evaluateForEvent({
          trigger:           "per_purchase",
          customer_id:       customerId,
          trigger_event_ref: "stock-receipt:" + receipt.order_id,
          occurred_at:       nowTs,
          metadata: {
            order_id:                receipt.order_id,
            receipt_id:              receiptId,
            received_lines:          summary.received_lines,
            damaged_lines:           summary.damaged_lines,
            total_quantity_received: summary.total_quantity_received,
          },
        });
      } catch (_e) { /* drop-silent — loyalty failure must not roll back completion */ }
    }

    var fresh = await _hydrate(await _receiptRowById(receiptId));
    return {
      receipt:        fresh,
      summary:        summary,
      loyalty_result: loyaltyResult,
      completed_at:   nowTs,
    };
  }

  // ---- getReceiptByToken -----------------------------------------------

  async function getReceiptByToken(token) {
    var canonical = _canonicalToken(token);
    var hash      = _hashToken(canonical);
    var row       = await _receiptRowByTokenHash(hash);
    if (!row) return null;
    if (!_b().crypto.timingSafeEqual(row.token_hash, hash)) return null;
    return await _hydrate(row);
  }

  // ---- receiptsForOrder ------------------------------------------------

  async function receiptsForOrder(orderId) {
    var id  = _orderId(orderId);
    var row = await _receiptRowByOrder(id);
    if (!row) return [];
    return [await _hydrate(row)];
  }

  // ---- recentScans -----------------------------------------------------

  async function recentScans(listOpts) {
    listOpts = listOpts || {};
    var limit = _limit(listOpts.limit);
    var rows;
    if (listOpts.receipt_id != null) {
      var rid = _uuid(listOpts.receipt_id, "receipt_id");
      rows = (await query(
        "SELECT * FROM stock_receipt_scans WHERE receipt_id = ?1 " +
        "ORDER BY scanned_at DESC, id DESC LIMIT ?2",
        [rid, limit],
      )).rows;
    } else {
      rows = (await query(
        "SELECT * FROM stock_receipt_scans " +
        "ORDER BY scanned_at DESC, id DESC LIMIT ?1",
        [limit],
      )).rows;
    }
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_decodeScan(rows[i]));
    return out;
  }

  return {
    RECEIPT_STATUSES:        RECEIPT_STATUSES.slice(),
    LINE_STATES:             LINE_STATES.slice(),
    TOKEN_NAMESPACE:         TOKEN_NAMESPACE,
    TOKEN_PLAINTEXT_LEN:     TOKEN_PLAINTEXT_LEN,
    DEFAULT_EXPIRES_HOURS:   DEFAULT_EXPIRES_HOURS,

    issueReceiptToken:       issueReceiptToken,
    recordReceiptScan:       recordReceiptScan,
    markLineReceived:        markLineReceived,
    markLineDamaged:         markLineDamaged,
    completeReceipt:         completeReceipt,
    getReceiptByToken:       getReceiptByToken,
    receiptsForOrder:        receiptsForOrder,
    recentScans:             recentScans,
  };
}

module.exports = {
  create:                  create,
  RECEIPT_STATUSES:        RECEIPT_STATUSES,
  LINE_STATES:             LINE_STATES,
  TOKEN_NAMESPACE:         TOKEN_NAMESPACE,
  TOKEN_PLAINTEXT_LEN:     TOKEN_PLAINTEXT_LEN,
  DEFAULT_EXPIRES_HOURS:   DEFAULT_EXPIRES_HOURS,
};
