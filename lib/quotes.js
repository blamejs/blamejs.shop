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
 *   it elapses, `listExpired({ as_of })` surfaces the row so a
 *   cron / dunning job can transition it to `expired`.
 *
 *   `total_minor` is the operator-quoted grand total — the sum of
 *   the quote_lines line-totals plus `shipping_minor` + `tax_minor`.
 *   It is NULL until the operator has responded.
 *
 *   Composes:
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
 *
 *   Surface:
 *     requestQuote({ customer_id, lines?, cart?, message?,
 *                    delivery_terms?, payment_terms?, currency? })
 *     respondToQuote({ quote_id, line_prices, shipping_minor?,
 *                      tax_minor?, valid_until, currency,
 *                      operator_notes?, delivery_terms?,
 *                      payment_terms? })
 *     customerAccept({ quote_id, accepted_by_customer })
 *     customerReject({ quote_id, reject_reason? })
 *     cancelQuote({ quote_id, cancel_reason })
 *     convertToOrder({ quote_id, ship_to, session_id?, cart_id? })
 *     getQuote(quote_id)
 *     quotesForCustomer(customer_id, { status?, limit? })
 *     pendingResponse({ limit? })
 *     listExpired({ as_of })
 *
 *   Storage: `migrations-d1/0102_quotes.sql` — two tables, `quotes`
 *     + `quote_lines`. ON DELETE CASCADE from quote -> lines.
 *
 * @primitive quotes
 * @related   b.uuid, b.guardUuid, shop.cart, shop.order
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
      try {
        await query(
          "INSERT INTO quotes " +
          "(id, customer_id, status, delivery_terms, payment_terms, message, " +
          " operator_notes, shipping_minor, tax_minor, total_minor, currency, " +
          " valid_until, accepted_at, accepted_by_customer, rejected_at, reject_reason, " +
          " converted_at, converted_order_id, cancelled_at, cancel_reason, " +
          " created_at, updated_at) " +
          "VALUES (?1, ?2, 'requested', ?3, ?4, ?5, NULL, NULL, NULL, NULL, NULL, " +
          " NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?6, ?6)",
          [id, customerId, delivery, payment, message, ts],
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
      return await _hydrated(id);
    },

    // FSM: requested -> responded. Operator prices every quote line,
    // sets shipping + tax + grand total currency, and stamps an
    // expiry. The total_minor is computed from the priced lines +
    // shipping_minor + tax_minor; the caller doesn't pass it (and
    // can't override it — the math is the contract).
    respondToQuote: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("quotes.respondToQuote: input object required");
      }
      var quoteId = _id(input.quote_id, "quote_id");
      var currency = _currency(input.currency);
      var shipping = input.shipping_minor == null ? 0 : input.shipping_minor;
      var tax      = input.tax_minor      == null ? 0 : input.tax_minor;
      _moneyMinor(shipping, "shipping_minor");
      _moneyMinor(tax,      "tax_minor");
      var validUntil   = _ts(input.valid_until, "valid_until");
      var operatorNotes = _optLongText(input.operator_notes, "operator_notes", MAX_OPERATOR_NOTES_LEN);
      var delivery     = _optShortText(input.delivery_terms, "delivery_terms", MAX_TERMS_LEN);
      var payment      = _optShortText(input.payment_terms,  "payment_terms",  MAX_TERMS_LEN);

      var current = await _getQuoteRaw(quoteId);
      if (!current) {
        var miss = new Error("quotes.respondToQuote: quote " + quoteId + " not found");
        miss.code = "QUOTE_NOT_FOUND";
        throw miss;
      }
      if (current.status !== "requested") {
        var refused = new Error("quotes.respondToQuote: refused — quote is " + current.status +
          ", only requested quotes can be responded to");
        refused.code = "QUOTE_TRANSITION_REFUSED";
        throw refused;
      }

      var lines = await _getLinesRaw(quoteId);
      var lineSkus = lines.map(function (r) { return r.sku; });
      var pricesBySku = _validateLinePrices(input.line_prices, lineSkus);

      // valid_until must be strictly in the future. A past expiry on
      // a fresh response is operator error — the quote would be
      // expired the moment it lands.
      var ts = _now();
      if (validUntil <= ts) {
        throw new TypeError("quotes.respondToQuote: valid_until must be in the future");
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

      // Update header + each line. The line update sets
      // unit_price_minor + currency per-line so a future single-line
      // re-quote (out of scope here) has a place to land.
      await query(
        "UPDATE quotes SET status = 'responded', shipping_minor = ?1, " +
        "tax_minor = ?2, total_minor = ?3, currency = ?4, valid_until = ?5, " +
        "operator_notes = ?6, " +
        "delivery_terms = COALESCE(?7, delivery_terms), " +
        "payment_terms  = COALESCE(?8, payment_terms),  " +
        "updated_at = ?9 WHERE id = ?10",
        [shipping, tax, total, currency, validUntil, operatorNotes,
         delivery, payment, ts, quoteId],
      );
      for (var j = 0; j < lines.length; j += 1) {
        var line = lines[j];
        await query(
          "UPDATE quote_lines SET unit_price_minor = ?1, currency = ?2 WHERE id = ?3",
          [pricesBySku[line.sku], currency, line.id],
        );
      }
      return await _hydrated(quoteId);
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
      if (current.status !== "responded") {
        var refused = new Error("quotes.customerAccept: refused — quote is " + current.status +
          ", only responded quotes can be accepted");
        refused.code = "QUOTE_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      if (current.valid_until != null && Number(current.valid_until) <= ts) {
        var expired = new Error("quotes.customerAccept: refused — quote expired at " +
          Number(current.valid_until) + " (now " + ts + ")");
        expired.code = "QUOTE_EXPIRED";
        throw expired;
      }
      await query(
        "UPDATE quotes SET status = 'accepted', accepted_at = ?1, " +
        "accepted_by_customer = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, acceptedBy, quoteId],
      );
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
      if (current.status !== "responded") {
        var refused = new Error("quotes.customerReject: refused — quote is " + current.status +
          ", only responded quotes can be rejected");
        refused.code = "QUOTE_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      await query(
        "UPDATE quotes SET status = 'rejected', rejected_at = ?1, " +
        "reject_reason = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, reason, quoteId],
      );
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
      if (current.status !== "requested" && current.status !== "responded") {
        var refused = new Error("quotes.cancelQuote: refused — quote is " + current.status +
          ", only requested or responded quotes can be cancelled");
        refused.code = "QUOTE_TRANSITION_REFUSED";
        throw refused;
      }
      var ts = _now();
      await query(
        "UPDATE quotes SET status = 'cancelled', cancelled_at = ?1, " +
        "cancel_reason = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, reason, quoteId],
      );
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
      if (current.status !== "accepted") {
        var refused = new Error("quotes.convertToOrder: refused — quote is " + current.status +
          ", only accepted quotes can be converted");
        refused.code = "QUOTE_TRANSITION_REFUSED";
        throw refused;
      }

      var lines = await _getLinesRaw(quoteId);
      var ts = _now();
      var orderId;

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
        orderId = createdOrder && createdOrder.id;
        if (!orderId) {
          throw new Error("quotes.convertToOrder: order handle did not return an order id");
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

      await query(
        "UPDATE quotes SET status = 'converted', converted_at = ?1, " +
        "converted_order_id = ?2, updated_at = ?1 WHERE id = ?3",
        [ts, orderId, quoteId],
      );
      return await _hydrated(quoteId);
    },

    // Read a hydrated quote + its lines. Returns null on miss so the
    // caller-handler maps cleanly to HTTP 404.
    getQuote: async function (quoteId) {
      var id = _id(quoteId, "quote_id");
      return await _hydrated(id);
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

    // List responded quotes whose `valid_until` has elapsed. A cron
    // job walks the result and either fires `customerAccept` (rare —
    // requires the customer-side timing) or transitions each row to
    // expired via an operator-side step (out of scope here; the
    // operator updates the row directly to expired via
    // `markExpired` when they own the cron).
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
      if (current.status !== "responded") {
        var refused = new Error("quotes.markExpired: refused — quote is " + current.status +
          ", only responded quotes can expire");
        refused.code = "QUOTE_TRANSITION_REFUSED";
        throw refused;
      }
      if (current.valid_until == null || Number(current.valid_until) > asOf) {
        var notYet = new Error("quotes.markExpired: refused — quote " + quoteId +
          " has not yet expired (valid_until=" + current.valid_until + ", as_of=" + asOf + ")");
        notYet.code = "QUOTE_NOT_EXPIRED";
        throw notYet;
      }
      await query(
        "UPDATE quotes SET status = 'expired', updated_at = ?1 WHERE id = ?2",
        [asOf, quoteId],
      );
      return await _hydrated(quoteId);
    },
  };
}

module.exports = {
  create:            create,
  QUOTE_STATUSES:    QUOTE_STATUSES,
  TERMINAL_STATUSES: TERMINAL_STATUSES,
};
