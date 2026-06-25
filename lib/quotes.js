"use strict";
/**
 * @module shop.quotes
 * @title  Quotes — B2B request-for-quote (RFQ) negotiation surface
 *
 * @intro
 *   A quote is a multi-step negotiation between a customer and the
 *   operator. The customer submits an RFQ with N requested lines
 *   (SKU + quantity + optional per-line notes); the operator
 *   responds with line prices + shipping + tax + an expiry; the
 *   customer either accepts (quote converts to an order at the
 *   quoted prices), rejects, or lets it expire.
 *
 *   This is distinct from the cart "quote" snapshot. That is a
 *   read-only view of a live cart at current catalog prices — no
 *   negotiation, no per-line operator response, no acceptance
 *   contract. The `quotes` table backs the full negotiation
 *   lifecycle and is the artifact the operator and the customer
 *   both reference when honouring an agreed price.
 *
 *   FSM:
 *
 *     requested -> responded -> accepted -> converted   (happy path)
 *                          |
 *                          +-> responded              (reprice — operator revises the offer)
 *                          +-> rejected               (customer says no)
 *                          +-> expired                (valid_until passed)
 *                          +-> cancelled              (cancelled before accept)
 *
 *     requested -> cancelled                          (cancelled pre-response)
 *
 *     accepted   -> cancelled                         (refused — accept is binding)
 *     converted  -> *                                 (terminal)
 *     rejected   -> *                                 (terminal)
 *     expired    -> *                                 (terminal)
 *
 *   `valid_until` is the operator-set expiry timestamp (ms). After
 *   it elapses, `listExpired({ as_of })` surfaces the row and
 *   `expireDue({ as_of })` — driven by the worker cron's
 *   `/_/quote-expiry-tick` — transitions each due row to `expired`
 *   through the same atomic status claim every other verb uses, so
 *   a concurrent accept / reprice and the sweep can never both win.
 *
 *   `response_version` counts the operator's pricing passes:
 *   `respondToQuote` stamps 1, each `repriceQuote` on a
 *   still-responded quote increments it. The customer's view-token
 *   link is NOT rotated by a reprice — the link they already hold
 *   resolves the same row and renders the new pricing.
 *
 *   `total_minor` is the operator-quoted grand total — the sum of
 *   the quote_lines line-totals plus `shipping_minor` + `tax_minor`.
 *   It is NULL until the operator has responded.
 *
 *   Composes:
 *     - b.fsm            — the quote lifecycle machine. Every status
 *                          change replays the machine from the row's
 *                          current status and asks it whether the edge
 *                          is legal before touching the database, so an
 *                          illegal transition is refused the same way
 *                          regardless of which surface fired it.
 *     - b.uuid.v7        — quote + line PKs (sortable; B-tree locality)
 *     - b.guardUuid      — strict UUID validation on every quote_id +
 *                          customer_id read
 *     - cart (optional)  — when injected, `requestQuote({ cart: ... })`
 *                          can derive the RFQ lines from an existing
 *                          cart's line set instead of an explicit
 *                          `lines` array.
 *     - order (optional) — when injected, `convertToOrder` composes
 *                          `order.createFromCart` to land the
 *                          accepted quote as a `pending` order. When
 *                          absent, `convertToOrder` still records the
 *                          status flip + the converted_order_id the
 *                          caller supplies, leaving the actual order
 *                          creation to the caller.
 *     - inventory (opt)  — when injected alongside `order`,
 *                          `convertToOrder` reserves shelf stock per
 *                          quote line BEFORE creating the pending order
 *                          (the same atomic hold checkout.confirm
 *                          takes), so a quote can't oversell against a
 *                          concurrent cart checkout. The pending order
 *                          owns the holds and settles them on its own
 *                          paid / cancelled edge.
 *
 *   Surface:
 *     requestQuote({ customer_id, lines?, cart?, message?,
 *                    delivery_terms?, payment_terms?, currency? })
 *     respondToQuote({ quote_id, line_prices, shipping_minor?,
 *                      tax_minor?, valid_until, currency,
 *                      operator_notes?, delivery_terms?,
 *                      payment_terms? })
 *     repriceQuote({ quote_id, line_prices, shipping_minor?,
 *                    tax_minor?, valid_until, currency,
 *                    operator_notes?, delivery_terms?,
 *                    payment_terms? })
 *     customerAccept({ quote_id, accepted_by_customer })
 *     customerReject({ quote_id, reject_reason? })
 *     cancelQuote({ quote_id, cancel_reason })
 *     convertToOrder({ quote_id, ship_to, session_id?, cart_id? })
 *     getQuote(quote_id)
 *     quotesForCustomer(customer_id, { status?, limit? })
 *     pendingResponse({ limit? })
 *     listByStatus({ status, limit? })
 *     listExpired({ as_of, limit? })
 *     expireDue({ as_of, limit? })
 *     markExpired({ quote_id, as_of })
 *
 *   Storage: `migrations-d1/0102_quotes.sql` — two tables, `quotes`
 *     + `quote_lines`. ON DELETE CASCADE from quote -> lines.
 *     `0227_quote_response_version.sql` adds the response_version
 *     revision counter.
 *
 * @primitive quotes
 * @related   b.fsm, b.uuid, b.guardUuid, shop.cart, shop.order
 */

var MAX_LINES              = 1000;
var MAX_QUANTITY           = 1000000;        // 1M units per line sanity cap
var MAX_UNIT_PRICE_MINOR   = 100000000000;   // 1e11 minor units sanity cap
var MAX_TOTAL_MINOR        = 1000000000000;  // 1e12 minor units sanity cap on shipping/tax/total
var MAX_SKU_LEN            = 128;
var MAX_MESSAGE_LEN        = 4000;
var MAX_OPERATOR_NOTES_LEN = 4000;
var MAX_TERMS_LEN          = 280;
var MAX_LINE_NOTES_LEN     = 1000;
var MAX_REJECT_REASON_LEN  = 280;
var MAX_CANCEL_REASON_LEN  = 280;
var MAX_ACCEPTED_BY_LEN    = 256;
var DEFAULT_LIMIT          = 50;
var MAX_LIMIT              = 500;

var SKU_RE      = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var CURRENCY_RE = /^[A-Z]{3}$/;

// View-token material for the customer-facing quote page (/quote/:token).
// 32 random bytes -> 43-char base64url plaintext, stored only as its SHA3-512
// namespace hash (never the plaintext) so a read of the quotes table never
// yields a working link. Mirrors the survey-invitation token discipline.
var VIEW_TOKEN_BYTE_LEN  = 32;
var VIEW_TOKEN_NAMESPACE = "shop.quotes.view-token:v1";
var VIEW_TOKEN_RE        = /^[A-Za-z0-9_-]{43}$/;

// Control bytes + zero-width / direction-override family. Operator-
// rendered text fields refuse these to keep the downstream dashboard /
// printout safe from header-injection + visual-spoofing attacks. CR/LF
// are allowed inside multi-line free-text fields (message,
// operator_notes, line.notes); single-line fields (terms, reject /
// cancel reason, accepted_by) refuse them too.
var CONTROL_BYTE_RE             = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_MULTILINE_RE   = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var QUOTE_STATUSES = Object.freeze([
  "requested", "responded", "accepted", "rejected",
  "expired", "cancelled", "converted",
]);
var TERMINAL_STATUSES = Object.freeze([
  "rejected", "expired", "cancelled", "converted",
]);

var b = require("./vendor/blamejs");

// The quote lifecycle, modelled on b.fsm — the same composition the order
// primitive uses (lib/order.js#_getOrderFsm). The FSM is the single source of
// truth for which (status, event) pairs are legal: every status-changing verb
// below replays the machine from the row's current status and asks it whether
// the edge is allowed before it touches the database, so an illegal transition
// is refused identically whether it arrives via the customer surface, the
// operator console, or the cron. Each event name maps 1:1 to the verb that
// fires it:
//
//   respond   requested            -> responded   (operator prices the quote)
//   reprice   responded            -> responded   (operator revises the offer)
//   accept    responded            -> accepted    (customer accepts)
//   reject    responded            -> rejected    (customer declines)
//   cancel    requested|responded  -> cancelled   (either side pulls it)
//   expire    responded            -> expired     (valid_until elapsed)
//   convert   accepted             -> converted   (lands a pending order)
//
// Terminal states declare no outgoing edge, so the machine itself refuses a
// double-accept / convert-after-cancel without a hand-written status check.
var QUOTE_TRANSITIONS = Object.freeze([
  { from: "requested", to: "responded", on: "respond" },
  { from: "requested", to: "cancelled", on: "cancel" },
  { from: "responded", to: "responded", on: "reprice" },
  { from: "responded", to: "accepted",  on: "accept" },
  { from: "responded", to: "rejected",  on: "reject" },
  { from: "responded", to: "cancelled", on: "cancel" },
  { from: "responded", to: "expired",   on: "expire" },
  { from: "accepted",  to: "converted", on: "convert" },
]);

var _quoteFsm = null;
function _getQuoteFsm() {
  if (_quoteFsm) return _quoteFsm;
  // b.fsm emits audit events under the 'fsm' namespace — register it
  // (idempotent) so the audit sink keeps the events instead of dropping them
  // with a noisy warning, exactly as the order FSM does.
  try { b.audit.registerNamespace("fsm"); } catch (_e) { /* idempotent; ignore */ }
  _quoteFsm = b.fsm.define({
    name:    "quote",
    initial: "requested",
    states: {
      requested: {}, responded: {}, accepted: {},
      rejected:  {}, expired:   {}, cancelled: {}, converted: {},
    },
    transitions: QUOTE_TRANSITIONS.map(function (t) {
      return { from: t.from, to: t.to, on: t.on };
    }),
  });
  return _quoteFsm;
}

// Validate one status-changing edge through the FSM. `event` is the verb name
// above; `fromStatus` is the row's CURRENT status. Returns the resolved
// to-status on success. Throws a coded QUOTE_TRANSITION_REFUSED Error when the
// machine refuses the edge (terminal state, wrong source state, or unknown
// event) so the caller maps it to a uniform 409 regardless of which guard
// tripped — the same shape the hand-rolled status checks used to throw.
// `target` resolves the destination state side-effect-free (no audit emit, no
// state mutation) and returns null on an illegal edge — so it is BOTH the gate
// and the to-status resolver in one call, read off the single FSM source of
// truth rather than a parallel transition-table walk that could drift from it.
function _assertTransition(fromStatus, event, verbLabel) {
  var fsm = _getQuoteFsm();
  var instance = fsm.restore({ state: fromStatus, history: [], context: {} });
  var toStatus = instance.target(event);
  if (toStatus == null) {
    var refused = new Error("quotes." + verbLabel + ": refused — quote is " +
      fromStatus + ", cannot " + event);
    refused.code = "QUOTE_TRANSITION_REFUSED";
    throw refused;
  }
  return toStatus;
}

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("quotes: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}

function _sku(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("quotes: sku must be a non-empty string");
  }
  if (s.length > MAX_SKU_LEN) {
    throw new TypeError("quotes: sku must be <= " + MAX_SKU_LEN + " characters");
  }
  if (!SKU_RE.test(s)) {
    throw new TypeError("quotes: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/");
  }
  return s;
}

function _currency(s) {
  if (typeof s !== "string" || !CURRENCY_RE.test(s)) {
    throw new TypeError("quotes: currency must be a 3-letter uppercase ISO-4217 code");
  }
  return s;
}

function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("quotes: " + label + " must be a positive integer");
  }
}

function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("quotes: " + label + " must be a non-negative integer");
  }
}

function _quantity(n, label) {
  _positiveInt(n, label);
  if (n > MAX_QUANTITY) {
    throw new TypeError("quotes: " + label + " must be <= " + MAX_QUANTITY);
  }
}

function _unitPrice(n, label) {
  _nonNegInt(n, label);
  if (n > MAX_UNIT_PRICE_MINOR) {
    throw new TypeError("quotes: " + label + " must be <= " + MAX_UNIT_PRICE_MINOR);
  }
}

function _moneyMinor(n, label) {
  _nonNegInt(n, label);
  if (n > MAX_TOTAL_MINOR) {
    throw new TypeError("quotes: " + label + " must be <= " + MAX_TOTAL_MINOR);
  }
}

function _ts(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("quotes: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _optShortText(s, label, max) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("quotes: " + label + " must be a string");
  }
  if (!s.length) {
    throw new TypeError("quotes: " + label + " must be a non-empty string when provided");
  }
  if (s.length > max) {
    throw new TypeError("quotes: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError("quotes: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("quotes: " + label + " contains zero-width / direction-override bytes");
  }
  return s;
}

function _optLongText(s, label, max) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("quotes: " + label + " must be a string");
  }
  if (!s.length) {
    throw new TypeError("quotes: " + label + " must be a non-empty string when provided");
  }
  if (s.length > max) {
    throw new TypeError("quotes: " + label + " must be <= " + max + " characters");
  }
  if (CONTROL_BYTE_MULTILINE_RE.test(s)) {
    throw new TypeError("quotes: " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("quotes: " + label + " contains zero-width / direction-override bytes");
  }
  return s;
}

function _requiredShortText(s, label, max) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("quotes: " + label + " must be a non-empty string");
  }
  return _optShortText(s, label, max);
}

function _status(s) {
  if (typeof s !== "string" || QUOTE_STATUSES.indexOf(s) === -1) {
    throw new TypeError("quotes: status must be one of " + QUOTE_STATUSES.join(", "));
  }
  return s;
}

function _now() { return Date.now(); }

// Mint a fresh view-token plaintext. Routes through b.crypto's linear-time
// base64url encoder (no ReDoS-shaped padding strip), like the survey tokens.
function _mintViewToken() {
  return b.crypto.toBase64Url(b.crypto.generateBytes(VIEW_TOKEN_BYTE_LEN));
}

// Canonicalize + shape-check a presented token before it ever touches the
// database. Returns the canonical string; throws on a malformed token so a
// garbage value can't widen the hash lookup.
function _canonicalViewToken(input) {
  if (typeof input !== "string" || !VIEW_TOKEN_RE.test(input)) {
    throw new TypeError("quotes: view token must be 43 base64url characters");
  }
  return input;
}

function _hashViewToken(canonical) {
  return b.crypto.namespaceHash(VIEW_TOKEN_NAMESPACE, canonical);
}

// Validate + normalize the requested-lines array. Refuses duplicate
// SKUs — the same SKU twice is a quantity-merge concern, not a
// per-line decision; the customer should send a single line at the
// combined quantity.
function _validateRequestedLines(lines, label) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new TypeError("quotes: " + label + " must be a non-empty array");
  }
  if (lines.length > MAX_LINES) {
    throw new TypeError("quotes: " + label + " must contain <= " + MAX_LINES + " entries");
  }
  var seen = Object.create(null);
  var normalized = [];
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    if (!l || typeof l !== "object") {
      throw new TypeError("quotes: " + label + "[" + i + "] must be an object");
    }
    var sku = _sku(l.sku);
    _quantity(l.quantity, label + "[" + i + "].quantity");
    var notes = _optLongText(l.notes, label + "[" + i + "].notes", MAX_LINE_NOTES_LEN);
    if (seen[sku]) {
      throw new TypeError("quotes: duplicate sku " + JSON.stringify(sku) + " in " + label);
    }
    seen[sku] = true;
    normalized.push({
      sku:      sku,
      quantity: l.quantity,
      notes:    notes,
    });
  }
  return normalized;
}

// Validate the operator's line_prices payload. The shape mirrors the
// requested lines — one entry per sku-on-the-quote — with a
// `unit_price_minor`. Every quote line must be priced; partial
// pricing is refused (the customer can't accept a half-priced quote).
function _validateLinePrices(linePrices, lineSkus) {
  if (!Array.isArray(linePrices) || linePrices.length === 0) {
    throw new TypeError("quotes: line_prices must be a non-empty array");
  }
  if (linePrices.length !== lineSkus.length) {
    throw new TypeError("quotes: line_prices length " + linePrices.length +
      " does not match quote line count " + lineSkus.length);
  }
  var skuSet = Object.create(null);
  for (var i = 0; i < lineSkus.length; i += 1) skuSet[lineSkus[i]] = true;
  var seen = Object.create(null);
  var byKey = Object.create(null);
  for (var j = 0; j < linePrices.length; j += 1) {
    var lp = linePrices[j];
    if (!lp || typeof lp !== "object") {
      throw new TypeError("quotes: line_prices[" + j + "] must be an object");
    }
    var sku = _sku(lp.sku);
    _unitPrice(lp.unit_price_minor, "line_prices[" + j + "].unit_price_minor");
    if (!skuSet[sku]) {
      throw new TypeError("quotes: line_prices sku " + JSON.stringify(sku) +
        " not on the quote");
    }
    if (seen[sku]) {
      throw new TypeError("quotes: duplicate sku " + JSON.stringify(sku) + " in line_prices");
    }
    seen[sku] = true;
    byKey[sku] = lp.unit_price_minor;
  }
  return byKey;
}

// ---- row hydration ------------------------------------------------------

function _hydrateQuote(row) {
  if (!row) return null;
  return {
    id:                   row.id,
    customer_id:          row.customer_id,
    status:               row.status,
    delivery_terms:       row.delivery_terms == null ? null : row.delivery_terms,
    payment_terms:        row.payment_terms == null ? null : row.payment_terms,
    message:              row.message == null ? null : row.message,
    operator_notes:       row.operator_notes == null ? null : row.operator_notes,
    shipping_minor:       row.shipping_minor       == null ? null : Number(row.shipping_minor),
    tax_minor:            row.tax_minor            == null ? null : Number(row.tax_minor),
    total_minor:          row.total_minor          == null ? null : Number(row.total_minor),
    currency:             row.currency == null ? null : row.currency,
    response_version:     row.response_version == null ? null : Number(row.response_version),
    valid_until:          row.valid_until == null ? null : Number(row.valid_until),
    accepted_at:          row.accepted_at == null ? null : Number(row.accepted_at),
    accepted_by_customer: row.accepted_by_customer == null ? null : row.accepted_by_customer,
    rejected_at:          row.rejected_at == null ? null : Number(row.rejected_at),
    reject_reason:        row.reject_reason == null ? null : row.reject_reason,
    converted_at:         row.converted_at == null ? null : Number(row.converted_at),
    converted_order_id:   row.converted_order_id == null ? null : row.converted_order_id,
    cancelled_at:         row.cancelled_at == null ? null : Number(row.cancelled_at),
    cancel_reason:        row.cancel_reason == null ? null : row.cancel_reason,
    created_at:           Number(row.created_at),
    updated_at:           Number(row.updated_at),
  };
}

function _hydrateLine(row) {
  return {
    id:               row.id,
    quote_id:         row.quote_id,
    sku:              row.sku,
    quantity:         Number(row.quantity),
    notes:            row.notes == null ? null : row.notes,
    unit_price_minor: row.unit_price_minor == null ? null : Number(row.unit_price_minor),
    currency:         row.currency == null ? null : row.currency,
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional cart handle — when wired, `requestQuote({ cart_id })`
  // can derive the RFQ lines from the cart instead of the caller
  // supplying an explicit `lines` array. The handle must expose
  // `get(cart_id)` + `listLines(cart_id)`.
  var cartHandle = opts.cart || null;
  if (cartHandle && (typeof cartHandle.get !== "function" ||
                     typeof cartHandle.listLines !== "function")) {
    throw new TypeError("quotes.create: opts.cart must expose get + listLines when provided");
  }
  // Optional order handle — when wired, `convertToOrder` composes
  // `order.createFromCart` to land the accepted quote as a `pending`
  // order. When absent, `convertToOrder` records the status flip +
  // requires the caller to supply `converted_order_id` directly.
  var orderHandle = opts.order || null;
  if (orderHandle && typeof orderHandle.createFromCart !== "function") {
    throw new TypeError("quotes.create: opts.order must expose createFromCart when provided");
  }
  // Optional inventory handle — when wired ALONGSIDE the order handle,
  // `convertToOrder` reserves shelf stock for each quote line BEFORE
  // creating the pending order, exactly as checkout.confirm does: the
  // pending order then OWNS those holds and settles them on its own
  // paid / cancelled FSM edges (decrement on paid, release on cancel),
  // so a quote-driven order can't oversell against a concurrent cart
  // checkout. Insufficient stock on any line rolls back every hold the
  // pass placed and refuses the conversion with a coded
  // QUOTE_INSUFFICIENT_STOCK error. Must expose hold(sku, qty) +
  // release(sku, qty), the same shape catalog.inventory exposes. Absent
  // it (or absent the order handle) conversion lands no holds — the
  // in-house-pipeline posture where the operator owns stock truth.
  var inventoryHandle = opts.inventory || null;
  if (inventoryHandle && (typeof inventoryHandle.hold !== "function" ||
                          typeof inventoryHandle.release !== "function")) {
    throw new TypeError("quotes.create: opts.inventory must expose hold + release when provided");
  }

  async function _getQuoteRaw(id) {
    var r = await query("SELECT * FROM quotes WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  async function _getLinesRaw(quoteId) {
    var r = await query(
      "SELECT * FROM quote_lines WHERE quote_id = ?1 ORDER BY sku ASC",
      [quoteId],
    );
    return r.rows;
  }

  async function _hydrated(id) {
    var q = await _getQuoteRaw(id);
    if (!q) return null;
    var lines = await _getLinesRaw(id);
    var out = _hydrateQuote(q);
    out.lines = lines.map(_hydrateLine);
    return out;
  }

  // Reserve shelf stock for every quote line before the conversion creates
  // the pending order — the same atomic conditional-UPDATE hold checkout uses
  // (`inventory.hold(sku, qty)`). An un-tracked SKU (hold → null) is unlimited
  // and passes through; a `held:false` result means the line oversells, so we
  // roll back every hold this pass already placed and refuse the conversion
  // with a coded error. Returns the placed-holds list and a per-sku held-qty
  // map so the order lines can record `stock_held_qty` (the order's paid edge
  // debits exactly those units; its cancel edge releases them). No-op (empty)
  // when no inventory handle is wired.
  async function _placeQuoteHolds(lines) {
    var placed = [];
    var heldBySku = Object.create(null);
    if (!inventoryHandle) return { placed: placed, heldBySku: heldBySku };
    for (var i = 0; i < lines.length; i += 1) {
      var sku = lines[i].sku;
      var qty = Number(lines[i].quantity);
      var res = await inventoryHandle.hold(sku, qty);
      if (res == null) continue;            // un-tracked SKU — unlimited
      if (res.held) {
        heldBySku[sku] = (heldBySku[sku] || 0) + qty;
        placed.push({ sku: sku, qty: qty });
        continue;
      }
      await _releaseQuoteHolds(placed);
      var refused = new Error("quotes.convertToOrder: refused — sku " + sku +
        " does not have " + qty + " unit(s) available to fulfil the quote");
      refused.code = "QUOTE_INSUFFICIENT_STOCK";
      refused.sku  = sku;
      throw refused;
    }
    return { placed: placed, heldBySku: heldBySku };
  }

  // Best-effort release of a set of placed holds — the rollback path. Drop-
  // silent per hold so a release failure never masks the error that triggered
  // the rollback. Runs ONLY when no pending order was created; once the order
  // exists it owns its holds (settled on its own paid / cancel edge).
  async function _releaseQuoteHolds(holds) {
    if (!inventoryHandle || !Array.isArray(holds)) return;
    for (var i = 0; i < holds.length; i += 1) {
      try { await inventoryHandle.release(holds[i].sku, holds[i].qty); }
      catch (_e) { /* drop-silent — rollback best-effort */ }
    }
  }

  // Shared body of respondToQuote (event "respond", requested -> responded)
  // and repriceQuote (event "reprice", responded -> responded). Validates the
  // full pricing payload, asks the FSM whether the edge is legal for the
  // row's CURRENT status, recomputes the totals server-side, then claims the
  // transition atomically (`AND status = <the legal from-state>`) so a
  // concurrent accept / reject / cancel / expire sweep and this write can
  // never both commit. respond stamps response_version = 1; reprice
  // increments it (COALESCE'd so a row priced before the column shipped
  // lands on 2). Neither path touches view_token_hash — the customer's
  // existing link keeps working and renders the latest pricing.
  async function _applyQuoteResponse(input, event, verbLabel) {
    if (!input || typeof input !== "object") {
      throw new TypeError("quotes." + verbLabel + ": input object required");
    }
    var quoteId = _id(input.quote_id, "quote_id");
    var currency = _currency(input.currency);
    var shipping = input.shipping_minor == null ? 0 : input.shipping_minor;
    var tax      = input.tax_minor      == null ? 0 : input.tax_minor;
    _moneyMinor(shipping, "shipping_minor");
    _moneyMinor(tax,      "tax_minor");
    var validUntil    = _ts(input.valid_until, "valid_until");
    var operatorNotes = _optLongText(input.operator_notes, "operator_notes", MAX_OPERATOR_NOTES_LEN);
    var delivery      = _optShortText(input.delivery_terms, "delivery_terms", MAX_TERMS_LEN);
    var payment       = _optShortText(input.payment_terms,  "payment_terms",  MAX_TERMS_LEN);

    var current = await _getQuoteRaw(quoteId);
    if (!current) {
      var miss = new Error("quotes." + verbLabel + ": quote " + quoteId + " not found");
      miss.code = "QUOTE_NOT_FOUND";
      throw miss;
    }
    _assertTransition(current.status, event, verbLabel);
    // The FSM only declares this event from one source state (respond:
    // requested, reprice: responded); having passed the assert, the row's
    // current status IS that state — it pins the atomic claim below.
    var fromStatus = current.status;

    var lines = await _getLinesRaw(quoteId);
    var lineSkus = lines.map(function (r) { return r.sku; });
    var pricesBySku = _validateLinePrices(input.line_prices, lineSkus);

    // valid_until must be strictly in the future. A past expiry on
    // a fresh response / revision is operator error — the quote would
    // be expired the moment it lands.
    var ts = _now();
    if (validUntil <= ts) {
      throw new TypeError("quotes." + verbLabel + ": valid_until must be in the future");
    }

    // Compute totals from the priced lines + shipping + tax. Math
    // is integer-only; sum is bounded by MAX_LINES *
    // MAX_QUANTITY * MAX_UNIT_PRICE_MINOR which fits Number.
    var subtotal = 0;
    for (var i = 0; i < lines.length; i += 1) {
      var qty = Number(lines[i].quantity);
      var price = pricesBySku[lines[i].sku];
      subtotal += qty * price;
    }
    var total = subtotal + shipping + tax;
    _moneyMinor(total, "total_minor");

    // Update header + each line. The line update sets unit_price_minor +
    // currency per-line. The header UPDATE claims the transition atomically
    // (`AND status = ?`) so a concurrent settle can't both commit against
    // the same row — for reprice that same clause also means an accept that
    // lands first wins and the revision refuses instead of clobbering the
    // accepted price.
    var versionSql = event === "respond" ? "1" : "COALESCE(response_version, 1) + 1";
    var claim = await query(
      "UPDATE quotes SET status = 'responded', shipping_minor = ?1, " +
      "tax_minor = ?2, total_minor = ?3, currency = ?4, valid_until = ?5, " +
      "operator_notes = ?6, " +
      "response_version = " + versionSql + ", " +
      "delivery_terms = COALESCE(?7, delivery_terms), " +
      "payment_terms  = COALESCE(?8, payment_terms),  " +
      "updated_at = ?9 WHERE id = ?10 AND status = ?11",
      [shipping, tax, total, currency, validUntil, operatorNotes,
       delivery, payment, ts, quoteId, fromStatus],
    );
    if (Number(claim.rowCount || 0) !== 1) {
      var raced = new Error("quotes." + verbLabel + ": refused — quote " + quoteId +
        " is no longer in the " + fromStatus + " state (settled by a concurrent call)");
      raced.code = "QUOTE_TRANSITION_REFUSED";
      throw raced;
    }
    for (var j = 0; j < lines.length; j += 1) {
      var line = lines[j];
      await query(
        "UPDATE quote_lines SET unit_price_minor = ?1, currency = ?2 WHERE id = ?3",
        [pricesBySku[line.sku], currency, line.id],
      );
    }
    return await _hydrated(quoteId);
  }

  return {
    QUOTE_STATUSES:    QUOTE_STATUSES.slice(),
    TERMINAL_STATUSES: TERMINAL_STATUSES.slice(),
    MAX_LINES:         MAX_LINES,
    MAX_QUANTITY:      MAX_QUANTITY,

    // Customer submits the RFQ. Captures `customer_id`, the requested
    // lines (either explicit via `lines` or derived from an injected
    // cart via `cart_id`), and optional message + terms preferences.
    // No prices yet — that's `respondToQuote`'s job.
    requestQuote: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.requestQuote: input object required");
      }
      var customerId = _id(input.customer_id, "customer_id");
      var message    = _optLongText(input.message, "message", MAX_MESSAGE_LEN);
      var delivery   = _optShortText(input.delivery_terms, "delivery_terms", MAX_TERMS_LEN);
      var payment    = _optShortText(input.payment_terms,  "payment_terms",  MAX_TERMS_LEN);

      // Resolve the line set. Explicit `lines` takes precedence; if
      // absent, fall back to deriving from `cart_id` via the injected
      // cart handle. Refuse both-present (operator ambiguity) and
      // neither-present (no input to quote against).
      var hasLines  = input.lines  !== undefined && input.lines  !== null;
      var hasCartId = input.cart_id !== undefined && input.cart_id !== null;
      if (hasLines && hasCartId) {
        throw new TypeError("quotes.requestQuote: pass lines OR cart_id, not both");
      }
      if (!hasLines && !hasCartId) {
        throw new TypeError("quotes.requestQuote: lines or cart_id required");
      }
      var lines;
      if (hasLines) {
        lines = _validateRequestedLines(input.lines, "lines");
      } else {
        if (!cartHandle) {
          throw new TypeError("quotes.requestQuote: cart_id supplied but no cart handle is wired");
        }
        var cartId = _id(input.cart_id, "cart_id");
        var cartRow = await cartHandle.get(cartId);
        if (!cartRow) {
          var noCart = new Error("quotes.requestQuote: cart " + cartId + " not found");
          noCart.code = "QUOTE_CART_NOT_FOUND";
          throw noCart;
        }
        var cartLines = await cartHandle.listLines(cartId);
        if (!cartLines || cartLines.length === 0) {
          throw new TypeError("quotes.requestQuote: cart " + cartId + " has no lines to quote");
        }
        // Cart lines are keyed by variant; aggregate by sku so the
        // operator-facing quote groups duplicate variants of the
        // same sku.
        var bySku = Object.create(null);
        var ordered = [];
        for (var i = 0; i < cartLines.length; i += 1) {
          var cl = cartLines[i];
          var sku = _sku(cl.sku);
          var qty = Number(cl.qty);
          if (!Number.isInteger(qty) || qty <= 0) {
            throw new TypeError("quotes.requestQuote: cart line for sku " +
              JSON.stringify(sku) + " has invalid qty " + cl.qty);
          }
          if (bySku[sku] == null) {
            bySku[sku] = qty;
            ordered.push(sku);
          } else {
            bySku[sku] += qty;
          }
        }
        var derived = [];
        for (var k = 0; k < ordered.length; k += 1) {
          derived.push({ sku: ordered[k], quantity: bySku[ordered[k]] });
        }
        lines = _validateRequestedLines(derived, "lines");
      }

      var id = b.uuid.v7();
      var ts = _now();
      // Mint the customer-facing view token up front so the request flow can
      // hand the customer their link immediately (and an operator console
      // detail can re-issue it). Only the hash lands in the row; the plaintext
      // rides back on the return value and is never stored.
      var viewTokenPlain = _mintViewToken();
      var viewTokenHash  = _hashViewToken(viewTokenPlain);
      try {
        await query(
          "INSERT INTO quotes " +
          "(id, customer_id, status, delivery_terms, payment_terms, message, " +
          " operator_notes, shipping_minor, tax_minor, total_minor, currency, " +
          " valid_until, accepted_at, accepted_by_customer, rejected_at, reject_reason, " +
          " converted_at, converted_order_id, cancelled_at, cancel_reason, " +
          " view_token_hash, created_at, updated_at) " +
          "VALUES (?1, ?2, 'requested', ?3, ?4, ?5, NULL, NULL, NULL, NULL, NULL, " +
          " NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?7, ?6, ?6)",
          [id, customerId, delivery, payment, message, ts, viewTokenHash],
        );
        for (var j = 0; j < lines.length; j += 1) {
          var l = lines[j];
          await query(
            "INSERT INTO quote_lines " +
            "(id, quote_id, sku, quantity, notes, unit_price_minor, currency) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)",
            [b.uuid.v7(), id, l.sku, l.quantity, l.notes],
          );
        }
      } catch (e) {
        // Best-effort rollback — D1 doesn't expose a transaction
        // handle to this primitive, so the compensating DELETE drops
        // the header + ON DELETE CASCADE clears any landed lines.
        try { await query("DELETE FROM quotes WHERE id = ?1", [id]); }
        catch (_e2) { /* drop-silent — the original error is what the caller needs */ }
        throw e;
      }
      var hydrated = await _hydrated(id);
      // Surface the plaintext token once on the create result so the caller
      // can build the /quote/:token link without a second round-trip.
      if (hydrated) hydrated.view_token = viewTokenPlain;
      return hydrated;
    },

    // FSM: requested -> responded. Operator prices every quote line,
    // sets shipping + tax + grand total currency, and stamps an
    // expiry. The total_minor is computed from the priced lines +
    // shipping_minor + tax_minor; the caller doesn't pass it (and
    // can't override it — the math is the contract). Stamps
    // response_version = 1 (the first pricing pass).
    respondToQuote: async function (input) {
      return await _applyQuoteResponse(input, "respond", "respondToQuote");
    },

    // FSM: responded -> responded (the reprice edge). Operator revises
    // a quote the customer hasn't settled yet — improved line prices,
    // fresh shipping / tax / validity window, an updated note. Same
    // payload contract as respondToQuote (every line re-priced; the
    // math is the contract), refused with QUOTE_TRANSITION_REFUSED on
    // any other state so a settled (accepted / declined / expired /
    // withdrawn) quote can never be silently re-opened. Increments
    // response_version so the revision is visible on the row, and
    // deliberately leaves view_token_hash untouched — the link the
    // customer already holds keeps resolving and renders the new
    // pricing.
    repriceQuote: async function (input) {
      return await _applyQuoteResponse(input, "reprice", "repriceQuote");
    },

    // FSM: responded -> accepted. Customer accepts the operator's
    // quoted terms. If valid_until has elapsed at the moment of
    // acceptance, the call refuses — the operator may want to
    // re-quote at fresh prices.
    customerAccept: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.customerAccept: input object required");
      }
      var quoteId = _id(input.quote_id, "quote_id");
      var acceptedBy = _requiredShortText(input.accepted_by_customer,
        "accepted_by_customer", MAX_ACCEPTED_BY_LEN);
      var current = await _getQuoteRaw(quoteId);
      if (!current) {
        var miss = new Error("quotes.customerAccept: quote " + quoteId + " not found");
        miss.code = "QUOTE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(current.status, "accept", "customerAccept");
      var ts = _now();
      if (current.valid_until != null && Number(current.valid_until) <= ts) {
        var expired = new Error("quotes.customerAccept: refused — quote expired at " +
          Number(current.valid_until) + " (now " + ts + ")");
        expired.code = "QUOTE_EXPIRED";
        throw expired;
      }
      // Claim the responded -> accepted transition atomically. The in-memory
      // FSM assert above only checks the row we read; the `AND status =
      // 'responded'` clause is what serializes a concurrent double-accept (two
      // customerAccept calls on one responded quote) and a withdraw-vs-accept
      // race (an operator cancelQuote running alongside) — only one wins, so a
      // single accept lands and a later convert can't fire twice.
      var claim = await query(
        "UPDATE quotes SET status = 'accepted', accepted_at = ?1, " +
        "accepted_by_customer = ?2, updated_at = ?1 WHERE id = ?3 AND status = 'responded'",
        [ts, acceptedBy, quoteId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        var raced = new Error("quotes.customerAccept: refused — quote " + quoteId +
          " is no longer responded (accepted, rejected, or withdrawn by a concurrent call)");
        raced.code = "QUOTE_TRANSITION_REFUSED";
        throw raced;
      }
      return await _hydrated(quoteId);
    },

    // FSM: responded -> rejected. Customer declines. Reason is
    // optional; an operator who needs a reason for analytics requires
    // it at the storefront input layer.
    customerReject: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.customerReject: input object required");
      }
      var quoteId = _id(input.quote_id, "quote_id");
      var reason = _optShortText(input.reject_reason, "reject_reason", MAX_REJECT_REASON_LEN);
      var current = await _getQuoteRaw(quoteId);
      if (!current) {
        var miss = new Error("quotes.customerReject: quote " + quoteId + " not found");
        miss.code = "QUOTE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(current.status, "reject", "customerReject");
      var ts = _now();
      // Claim the responded -> rejected transition atomically so a concurrent
      // accept / cancel can't both commit against the same responded quote.
      var claim = await query(
        "UPDATE quotes SET status = 'rejected', rejected_at = ?1, " +
        "reject_reason = ?2, updated_at = ?1 WHERE id = ?3 AND status = 'responded'",
        [ts, reason, quoteId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        var raced = new Error("quotes.customerReject: refused — quote " + quoteId +
          " is no longer responded (settled by a concurrent call)");
        raced.code = "QUOTE_TRANSITION_REFUSED";
        throw raced;
      }
      return await _hydrated(quoteId);
    },

    // FSM: requested|responded -> cancelled. Either side (operator or
    // customer) pulls the quote before acceptance. Accepted quotes
    // can't be cancelled through this surface — once both sides
    // agreed, the unwind is a commercial conversation routed through
    // the order/refund flow after `convertToOrder`. Terminal states
    // refuse cancellation outright.
    cancelQuote: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.cancelQuote: input object required");
      }
      var quoteId = _id(input.quote_id, "quote_id");
      var reason  = _requiredShortText(input.cancel_reason, "cancel_reason", MAX_CANCEL_REASON_LEN);
      var current = await _getQuoteRaw(quoteId);
      if (!current) {
        var miss = new Error("quotes.cancelQuote: quote " + quoteId + " not found");
        miss.code = "QUOTE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(current.status, "cancel", "cancelQuote");
      var ts = _now();
      // Claim the (requested|responded) -> cancelled transition atomically.
      // The `AND status IN (...)` clause closes the withdraw-vs-accept race:
      // an operator cancelQuote and a customer customerAccept on the same
      // responded quote can't both commit — whichever UPDATE lands first wins,
      // and the loser refuses instead of silently clobbering the other side's
      // transition (a cancel clobbering an accept would otherwise kill an
      // order the operator thought was live, and vice-versa).
      var claim = await query(
        "UPDATE quotes SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2, updated_at = ?1 WHERE id = ?3 AND status IN ('requested', 'responded')",
        [ts, reason, quoteId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        var raced = new Error("quotes.cancelQuote: refused — quote " + quoteId +
          " is no longer cancellable (accepted, rejected, or settled by a concurrent call)");
        raced.code = "QUOTE_TRANSITION_REFUSED";
        throw raced;
      }
      return await _hydrated(quoteId);
    },

    // FSM: accepted -> converted. The accepted quote becomes a
    // pending order at the quoted prices. When the `order` handle is
    // wired, composes `order.createFromCart` to land the order and
    // captures the resulting `order_id` on the quote row. When
    // absent, the caller supplies `converted_order_id` directly so
    // the operator pipeline retains the order-creation step.
    convertToOrder: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.convertToOrder: input object required");
      }
      var quoteId = _id(input.quote_id, "quote_id");
      var current = await _getQuoteRaw(quoteId);
      if (!current) {
        var miss = new Error("quotes.convertToOrder: quote " + quoteId + " not found");
        miss.code = "QUOTE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(current.status, "convert", "convertToOrder");

      var ts = _now();
      // Claim the accepted -> converted transition atomically BEFORE placing
      // inventory holds or creating the pending order. The in-memory FSM
      // `_assertTransition` above only answers "is this edge legal for the row
      // I read?" — two concurrent convertToOrder calls both read 'accepted'
      // and both pass it. The conditional UPDATE is the real serialization
      // point: only one matches `status = 'accepted'`, so only one mints holds
      // + an order. (Without it both would create a pending order + double the
      // inventory holds from a single accepted quote.) converted_order_id is
      // backfilled once the order id is known; on any failure the claim is
      // released back to 'accepted' so the operator can retry.
      var claim = await query(
        "UPDATE quotes SET status = 'converted', converted_at = ?1, updated_at = ?1 " +
        "WHERE id = ?2 AND status = 'accepted'",
        [ts, quoteId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        var raced = new Error("quotes.convertToOrder: refused — quote " + quoteId +
          " is no longer accepted (converted by a concurrent call)");
        raced.code = "QUOTE_TRANSITION_REFUSED";
        throw raced;
      }

      // Release the claim back to 'accepted' so a retry is possible after a
      // downstream (hold / order-creation) failure leaves no order behind.
      async function _releaseConvertClaim() {
        try {
          await query(
            "UPDATE quotes SET status = 'accepted', converted_at = NULL, updated_at = ?1 " +
            "WHERE id = ?2 AND status = 'converted' AND converted_order_id IS NULL",
            [_now(), quoteId],
          );
        } catch (_e0) { /* drop-silent — the downstream error is the caller's signal */ }
      }

      var lines = await _getLinesRaw(quoteId);
      var orderId;

      try {
      if (orderHandle) {
        // The order primitive requires cart_id + session_id as
        // UUID-shape inputs. For a quote-driven order, the operator
        // supplies a synthetic cart_id + session_id (typically the
        // same UUID — the quote is acting as the "cart" here) so the
        // order row carries a stable pointer back to the
        // negotiation surface.
        if (!input.ship_to || typeof input.ship_to !== "object") {
          throw new TypeError("quotes.convertToOrder: ship_to object required when order handle is wired");
        }
        var cartId    = _id(input.cart_id    || quoteId, "cart_id");
        var sessionId = _id(input.session_id || quoteId, "session_id");

        // Reserve shelf stock for the whole quote before the order lands.
        // Throws QUOTE_INSUFFICIENT_STOCK (after rolling back its own holds)
        // if any line oversells — no order is created, no holds strand. A
        // no-op returning empty maps when no inventory handle is wired.
        var holdResult = await _placeQuoteHolds(lines);
        var placedHolds = holdResult.placed;
        var heldBySku   = holdResult.heldBySku;
        // From here until the order is committed, any throw must release the
        // holds this conversion placed — once createFromCart succeeds the
        // pending order owns them (its paid/cancel edge settles them) and a
        // blanket release would double-free / eat a concurrent shopper's hold.
        var orderCreated = false;
        try {
          var subtotal = 0;
          var orderLines = [];
          for (var i = 0; i < lines.length; i += 1) {
            var line = lines[i];
            var qty   = Number(line.quantity);
            var price = Number(line.unit_price_minor);
            subtotal += qty * price;
            orderLines.push({
              // The order primitive validates variant_id as a UUID.
              // The quote primitive doesn't track variant_id (a quote
              // is SKU-grained, not variant-grained), so synthesize a
              // deterministic UUID per (quote, line) tuple. The
              // operator's variant resolution happens upstream of the
              // quote surface; the order line snapshots the sku +
              // qty + price the customer accepted.
              variant_id:        line.id,
              sku:               line.sku,
              qty:               qty,
              unit_amount_minor: price,
              unit_currency:     current.currency,
              // Units this line reserved above (0 for an un-tracked SKU) so
              // the pending order settles exactly the holds it owns.
              stock_held_qty:    heldBySku[line.sku] ? qty : 0,
            });
          }
          var shipping = current.shipping_minor == null ? 0 : Number(current.shipping_minor);
          var tax      = current.tax_minor      == null ? 0 : Number(current.tax_minor);
          var grand    = subtotal + shipping + tax;

          var createdOrder = await orderHandle.createFromCart({
            cart_id:           cartId,
            session_id:        sessionId,
            customer_id:       current.customer_id,
            currency:          current.currency,
            subtotal_minor:    subtotal,
            discount_minor:    0,
            tax_minor:         tax,
            shipping_minor:    shipping,
            grand_total_minor: grand,
            ship_to:           input.ship_to,
            lines:             orderLines,
          });
          orderCreated = true;
          orderId = createdOrder && createdOrder.id;
          if (!orderId) {
            throw new Error("quotes.convertToOrder: order handle did not return an order id");
          }
        } catch (e) {
          if (!orderCreated) await _releaseQuoteHolds(placedHolds);
          throw e;
        }
      } else {
        // Caller supplies converted_order_id when no order handle is
        // wired. This is the in-house-pipeline-owns-orders posture.
        if (input.converted_order_id == null) {
          throw new TypeError("quotes.convertToOrder: converted_order_id required when no order handle is wired");
        }
        if (typeof input.converted_order_id !== "string" || !input.converted_order_id.length) {
          throw new TypeError("quotes.convertToOrder: converted_order_id must be a non-empty string");
        }
        orderId = input.converted_order_id;
      }
      } catch (eConvert) {
        // The claim already flipped status to 'converted'; nothing downstream
        // produced an order, so release it back to 'accepted' for a retry.
        await _releaseConvertClaim();
        throw eConvert;
      }

      // Status + converted_at were claimed atomically above; backfill the
      // resolved order id onto the (already-converted) quote.
      await query(
        "UPDATE quotes SET converted_order_id = ?1, updated_at = ?2 WHERE id = ?3",
        [orderId, _now(), quoteId],
      );
      return await _hydrated(quoteId);
    },

    // Read a hydrated quote + its lines. Returns null on miss so the
    // caller-handler maps cleanly to HTTP 404.
    getQuote: async function (quoteId) {
      var id = _id(quoteId, "quote_id");
      return await _hydrated(id);
    },

    // Mint (or rotate) the customer-facing view token for a quote and return
    // the PLAINTEXT once — the caller renders it into the link / email and
    // never persists it. Only the SHA3-512 hash lands in the row, so the
    // plaintext is unrecoverable from storage. Idempotent-by-rotation: each
    // call mints a fresh token, invalidating any prior link. Returns null on
    // an unknown quote so the caller maps to 404.
    issueViewToken: async function (quoteId) {
      var id = _id(quoteId, "quote_id");
      var current = await _getQuoteRaw(id);
      if (!current) return null;
      var plaintext = _mintViewToken();
      var ts = _now();
      await query(
        "UPDATE quotes SET view_token_hash = ?1, updated_at = ?2 WHERE id = ?3",
        [_hashViewToken(plaintext), ts, id],
      );
      return { quote_id: id, plaintext_token: plaintext };
    },

    // Resolve a quote by its presented view token. Shape-checks the token,
    // hashes it, looks up the row by hash, then constant-time-compares the
    // stored hash before returning the hydrated quote — so a malformed or
    // non-matching token yields null (the route maps that to 404,
    // indistinguishable from a missing quote). Never accepts a quote id here:
    // the token is the only key this path honours.
    getByViewToken: async function (token) {
      var canon;
      try { canon = _canonicalViewToken(token); }
      catch (_e) { return null; }
      var hash = _hashViewToken(canon);
      var r = await query("SELECT * FROM quotes WHERE view_token_hash = ?1", [hash]);
      var row = r.rows[0];
      if (!row || row.view_token_hash == null) return null;
      if (!b.crypto.timingSafeEqual(row.view_token_hash, hash)) return null;
      var out = _hydrateQuote(row);
      out.lines = (await _getLinesRaw(row.id)).map(_hydrateLine);
      return out;
    },

    // List quotes for a given customer. Optional `status` narrows the
    // result; `limit` caps the page size. Sorted by updated_at DESC
    // so the customer's freshest activity surfaces first.
    quotesForCustomer: async function (customerId, listOpts) {
      var cid = _id(customerId, "customer_id");
      listOpts = listOpts || {};
      var hasStatus = listOpts.status !== undefined && listOpts.status !== null;
      if (hasStatus) _status(listOpts.status);
      var limit = listOpts.limit == null ? DEFAULT_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("quotes.quotesForCustomer: limit must be 1..." + MAX_LIMIT);
      }
      var sql, params;
      if (hasStatus) {
        sql = "SELECT * FROM quotes WHERE customer_id = ?1 AND status = ?2 " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?3";
        params = [cid, listOpts.status, limit];
      } else {
        sql = "SELECT * FROM quotes WHERE customer_id = ?1 " +
              "ORDER BY updated_at DESC, id DESC LIMIT ?2";
        params = [cid, limit];
      }
      var r = await query(sql, params);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var hydrated = _hydrateQuote(r.rows[i]);
        hydrated.lines = (await _getLinesRaw(r.rows[i].id)).map(_hydrateLine);
        out.push(hydrated);
      }
      return out;
    },

    // List quotes awaiting the operator's response. Sorted by
    // created_at ASC so the longest-waiting quote lands at the top
    // of the operator queue.
    pendingResponse: async function (listOpts) {
      listOpts = listOpts || {};
      var limit = listOpts.limit == null ? DEFAULT_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("quotes.pendingResponse: limit must be 1..." + MAX_LIMIT);
      }
      var r = await query(
        "SELECT * FROM quotes WHERE status = 'requested' " +
        "ORDER BY created_at ASC, id ASC LIMIT ?1",
        [limit],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var hydrated = _hydrateQuote(r.rows[i]);
        hydrated.lines = (await _getLinesRaw(r.rows[i].id)).map(_hydrateLine);
        out.push(hydrated);
      }
      return out;
    },

    // List quotes in one lifecycle state, newest activity first — the
    // operator console's status filter (e.g. the expired view that shows
    // what the cron sweep transitioned). Validated against QUOTE_STATUSES
    // so a garbage status throws rather than silently matching nothing.
    listByStatus: async function (listOpts) {
      if (!listOpts || typeof listOpts !== "object") {
        throw new TypeError("quotes.listByStatus: input object required");
      }
      var status = _status(listOpts.status);
      var limit = listOpts.limit == null ? DEFAULT_LIMIT : listOpts.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("quotes.listByStatus: limit must be 1..." + MAX_LIMIT);
      }
      var r = await query(
        "SELECT * FROM quotes WHERE status = ?1 " +
        "ORDER BY updated_at DESC, id DESC LIMIT ?2",
        [status, limit],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var hydrated = _hydrateQuote(r.rows[i]);
        hydrated.lines = (await _getLinesRaw(r.rows[i].id)).map(_hydrateLine);
        out.push(hydrated);
      }
      return out;
    },

    // List responded quotes whose `valid_until` has elapsed. A cron
    // job walks the result and either fires `customerAccept` (rare —
    // requires the customer-side timing) or transitions each row to
    // expired via an operator-side step (`expireDue` is that sweep;
    // `markExpired` is the single-row flip when the operator owns the
    // cron).
    listExpired: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.listExpired: input object required");
      }
      var asOf = _ts(input.as_of, "as_of");
      var limit = input.limit == null ? DEFAULT_LIMIT : input.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("quotes.listExpired: limit must be 1..." + MAX_LIMIT);
      }
      var r = await query(
        "SELECT * FROM quotes WHERE status = 'responded' " +
        "AND valid_until IS NOT NULL AND valid_until <= ?1 " +
        "ORDER BY valid_until ASC, id ASC LIMIT ?2",
        [asOf, limit],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var hydrated = _hydrateQuote(r.rows[i]);
        hydrated.lines = (await _getLinesRaw(r.rows[i].id)).map(_hydrateLine);
        out.push(hydrated);
      }
      return out;
    },

    // One bounded expiry sweep — the worker cron's `/_/quote-expiry-tick`
    // drives this once a minute. Scans up to `limit` responded quotes whose
    // valid_until has elapsed as of `as_of` and flips each to expired
    // through an atomic conditional UPDATE that re-checks BOTH the status
    // AND the elapsed expiry, so:
    //   - two overlapping ticks can't double-transition a row (the loser's
    //     UPDATE matches nothing and is counted as skipped, not an error);
    //   - a customer accept / reject / operator cancel that lands between
    //     the scan and the flip wins — the flip refuses;
    //   - a reprice that lands in that window and pushes valid_until back
    //     into the future also wins — the `valid_until <= as_of` re-check
    //     keeps a freshly revised quote alive.
    // Per-row failures never abort the pass; the summary reports what
    // happened. Input validation throws (a cron caller with a bad clock /
    // batch size is a config bug to surface, not to swallow).
    expireDue: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.expireDue: input object required");
      }
      var asOf = _ts(input.as_of, "as_of");
      var limit = input.limit == null ? DEFAULT_LIMIT : input.limit;
      if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
        throw new TypeError("quotes.expireDue: limit must be 1..." + MAX_LIMIT);
      }
      // The machine is the single source of truth for the expire edge — the
      // sweep's `status = 'responded'` claims below encode the same source
      // state, and this assert keeps them honest if the FSM ever changes.
      _assertTransition("responded", "expire", "expireDue");
      var r = await query(
        "SELECT id FROM quotes WHERE status = 'responded' " +
        "AND valid_until IS NOT NULL AND valid_until <= ?1 " +
        "ORDER BY valid_until ASC, id ASC LIMIT ?2",
        [asOf, limit],
      );
      var expired = 0;
      var skipped = 0;
      for (var i = 0; i < r.rows.length; i += 1) {
        var claim = await query(
          "UPDATE quotes SET status = 'expired', updated_at = ?1 " +
          "WHERE id = ?2 AND status = 'responded' " +
          "AND valid_until IS NOT NULL AND valid_until <= ?3",
          [asOf, r.rows[i].id, asOf],
        );
        if (Number(claim.rowCount || 0) === 1) expired += 1;
        else skipped += 1;
      }
      return { scanned: r.rows.length, expired: expired, skipped: skipped };
    },

    // Operator-side expiry flip. Walks a single quote whose
    // valid_until has elapsed and moves it from responded -> expired.
    // Refuses if the quote is not in the responded state or if the
    // expiry has not yet passed.
    markExpired: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.markExpired: input object required");
      }
      var quoteId = _id(input.quote_id, "quote_id");
      var asOf    = _ts(input.as_of, "as_of");
      var current = await _getQuoteRaw(quoteId);
      if (!current) {
        var miss = new Error("quotes.markExpired: quote " + quoteId + " not found");
        miss.code = "QUOTE_NOT_FOUND";
        throw miss;
      }
      _assertTransition(current.status, "expire", "markExpired");
      if (current.valid_until == null || Number(current.valid_until) > asOf) {
        var notYet = new Error("quotes.markExpired: refused — quote " + quoteId +
          " has not yet expired (valid_until=" + current.valid_until + ", as_of=" + asOf + ")");
        notYet.code = "QUOTE_NOT_EXPIRED";
        throw notYet;
      }
      // Claim the responded -> expired transition atomically so a concurrent
      // accept / cancel can't both commit against the same responded quote.
      var claim = await query(
        "UPDATE quotes SET status = 'expired', updated_at = ?1 WHERE id = ?2 AND status = 'responded'",
        [asOf, quoteId],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        var raced = new Error("quotes.markExpired: refused — quote " + quoteId +
          " is no longer responded (settled by a concurrent call)");
        raced.code = "QUOTE_TRANSITION_REFUSED";
        throw raced;
      }
      return await _hydrated(quoteId);
    },
  };
}

module.exports = {
  create:            create,
  QUOTE_STATUSES:    QUOTE_STATUSES,
  TERMINAL_STATUSES: TERMINAL_STATUSES,
};
