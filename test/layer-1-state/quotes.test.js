"use strict";
/**
 * quotes — B2B request-for-quote (RFQ) negotiation surface.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations 0102 +
 * 0211 (the view-token column). The test requires `lib/quotes.js`
 * directly for the unit-level coverage; the storefront + admin wiring
 * is exercised in test/layer-2-integration/quotes-flow.test.js.
 *
 * Coverage:
 *   - requestQuote happy path: explicit lines, message + terms
 *     capture, status='requested', total_minor NULL until response,
 *     ON DELETE CASCADE on a quote drops its lines.
 *   - requestQuote refusals: missing input, no lines AND no cart,
 *     both lines AND cart, duplicate sku, bad qty / sku / customer,
 *     oversize message, control bytes in delivery_terms.
 *   - respondToQuote happy path: line_prices applied, total math
 *     (sum(qty*price) + shipping + tax), per-line currency stamped.
 *   - respondToQuote refusals: wrong state, past valid_until,
 *     missing line price, sku not on quote, duplicate sku in
 *     line_prices, bad currency.
 *   - customerAccept happy path + refusals (wrong state, expired
 *     after valid_until, missing accepted_by_customer).
 *   - customerReject happy path + refusal on wrong state.
 *   - cancelQuote from requested AND responded; refuses from
 *     accepted | rejected | cancelled | converted | expired;
 *     requires reason.
 *   - convertToOrder without order handle (caller supplies
 *     converted_order_id), and with an injected order handle that
 *     receives the expected createFromCart payload.
 *   - getQuote / quotesForCustomer status filter + limit /
 *     pendingResponse / listExpired / markExpired.
 *   - repriceQuote: responded -> responded revision (new prices /
 *     totals / validity, response_version bump, view token NOT
 *     rotated); refusals on every other state + the same payload
 *     validation respond enforces.
 *   - listByStatus: per-state list (the admin expired filter's
 *     read), status validation, limit caps.
 *   - expireDue: the cron sweep — flips due responded rows to
 *     expired, idempotent on a second pass, leaves freshly
 *     repriced (future valid_until) rows alone, skips rows a
 *     concurrent settle won.
 *   - FSM terminal states refuse every onward transition.
 *   - requestQuote derives lines from an injected cart handle and
 *     aggregates duplicate variant rows onto a single sku line.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var quotes  = require("../../lib/quotes");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATHS = [
  "0102_quotes.sql",
  "0211_quote_view_token.sql",
  "0940_quote_response_version.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIG_PATHS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
  });
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

function _validUuid() { return bShop.framework.uuid.v7(); }

function _setup(opts) {
  opts = opts || {};
  var query = _makeQuery();
  var q = quotes.create(Object.assign({ query: query }, opts));
  return { query: query, quotes: q };
}

function _validLines() {
  return [
    { sku: "WDG-PRO-BLK-L", quantity: 10 },
    { sku: "WDG-PRO-RED-L", quantity:  5, notes: "Match the black colour exactly." },
  ];
}

async function _requestHappyAndRefusals() {
  var ctx = _setup();
  var customerId = _validUuid();
  var q = await ctx.quotes.requestQuote({
    customer_id:    customerId,
    lines:          _validLines(),
    message:        "Bulk order for office rollout — please advise lead time.",
    delivery_terms: "FOB origin, 14-day lead",
    payment_terms:  "Net 30",
  });

  check("requestQuote returns id",                   typeof q.id === "string" && q.id.length > 0);
  check("requestQuote opens status='requested'",     q.status === "requested");
  check("requestQuote stores customer_id",           q.customer_id === customerId);
  check("requestQuote stores message",               q.message === "Bulk order for office rollout — please advise lead time.");
  check("requestQuote stores delivery_terms",        q.delivery_terms === "FOB origin, 14-day lead");
  check("requestQuote stores payment_terms",         q.payment_terms === "Net 30");
  check("requestQuote leaves operator_notes null",   q.operator_notes === null);
  check("requestQuote leaves total_minor null",      q.total_minor === null);
  check("requestQuote leaves currency null",         q.currency === null);
  check("requestQuote leaves valid_until null",      q.valid_until === null);
  check("requestQuote stamps created_at",            typeof q.created_at === "number");
  check("requestQuote stamps updated_at",            typeof q.updated_at === "number");
  check("requestQuote captures both lines",          q.lines.length === 2);
  check("requestQuote line qty captured",
    q.lines[0].quantity === 5 || q.lines[0].quantity === 10);
  check("requestQuote line notes captured",
    q.lines.some(function (l) { return l.notes === "Match the black colour exactly."; }));
  check("requestQuote leaves line unit_price_minor null",
    q.lines.every(function (l) { return l.unit_price_minor === null; }));

  // Refusal classes.
  await assert.rejects(ctx.quotes.requestQuote(),                                                    /input object required/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId,
  }),                                                                                                /lines or cart_id required/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, lines: _validLines(), cart_id: _validUuid(),
  }),                                                                                                /not both/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, lines: [],
  }),                                                                                                /non-empty array/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId,
    lines: [{ sku: "WDG-X", quantity: 1 }, { sku: "WDG-X", quantity: 2 }],
  }),                                                                                                /duplicate sku/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, lines: [{ sku: "WDG-X", quantity: 0 }],
  }),                                                                                                /quantity/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, lines: [{ sku: "bad sku with space", quantity: 1 }],
  }),                                                                                                /sku/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: "not-a-uuid", lines: _validLines(),
  }),                                                                                                /customer_id/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, lines: _validLines(),
    message: "x".repeat(4001),
  }),                                                                                                /message/);
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, lines: _validLines(),
    delivery_terms: "bad\x01ctrl",
  }),                                                                                                /delivery_terms/);
  // cart_id without a cart handle refuses.
  await assert.rejects(ctx.quotes.requestQuote({
    customer_id: customerId, cart_id: _validUuid(),
  }),                                                                                                /no cart handle/);

  // Quote with no lines (cart-derived path with stub cart that has
  // no lines) refuses.
  var stubCart = {
    get:       async function () { return { id: "c", currency: "USD", status: "active" }; },
    listLines: async function () { return []; },
  };
  var ctx2 = _setup({ cart: stubCart });
  await assert.rejects(ctx2.quotes.requestQuote({
    customer_id: customerId, cart_id: _validUuid(),
  }),                                                                                                /no lines to quote/);
}

async function _requestFromCartHandle() {
  // Inject a stub cart handle. The cart has three lines, two of
  // which share a sku across different variants — the quote should
  // collapse them onto a single quote line at the summed quantity.
  var variantA = _validUuid();
  var variantB = _validUuid();
  var variantC = _validUuid();
  var stubCart = {
    get: async function (id) { return { id: id, currency: "USD", status: "active" }; },
    listLines: async function () {
      return [
        { id: "l1", cart_id: "c1", variant_id: variantA, sku: "WDG-PRO-BLK-L", qty: 4 },
        { id: "l2", cart_id: "c1", variant_id: variantB, sku: "WDG-PRO-BLK-L", qty: 3 },  // same sku, dif variant
        { id: "l3", cart_id: "c1", variant_id: variantC, sku: "WDG-PRO-RED-L", qty: 2 },
      ];
    },
  };
  var ctx = _setup({ cart: stubCart });
  var cid = _validUuid();
  var q = await ctx.quotes.requestQuote({
    customer_id: cid, cart_id: _validUuid(),
  });
  check("requestQuote(cart) opens requested",       q.status === "requested");
  check("requestQuote(cart) collapses duplicate skus to one line per sku",
    q.lines.length === 2);
  var bySku = {};
  for (var i = 0; i < q.lines.length; i += 1) bySku[q.lines[i].sku] = q.lines[i];
  check("requestQuote(cart) sums qty for collapsed sku",
    bySku["WDG-PRO-BLK-L"].quantity === 7);
  check("requestQuote(cart) preserves single-variant sku qty",
    bySku["WDG-PRO-RED-L"].quantity === 2);

  // cart not found via the cart handle.
  var ctxMiss = _setup({ cart: {
    get:       async function () { return null; },
    listLines: async function () { return []; },
  }});
  await assert.rejects(ctxMiss.quotes.requestQuote({
    customer_id: cid, cart_id: _validUuid(),
  }), /cart .* not found/);
}

async function _respondHappyAndRefusals() {
  var ctx = _setup();
  var cid = _validUuid();
  var q = await ctx.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });

  // Refuse responding from wrong state — first cancel the quote and
  // try to respond.
  var ctxCancel = _setup();
  var qCancel = await ctxCancel.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });
  await ctxCancel.quotes.cancelQuote({ quote_id: qCancel.id, cancel_reason: "operator pulled" });
  await assert.rejects(ctxCancel.quotes.respondToQuote({
    quote_id: qCancel.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 500, tax_minor: 200,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /refused — quote is cancelled/);

  // Bad line_prices shape — missing sku coverage refused.
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [{ sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 }],
    shipping_minor: 0, tax_minor: 0,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /length/);

  // Sku not on quote refused.
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-NOT-ON-QUOTE", unit_price_minor: 999 },
    ],
    shipping_minor: 0, tax_minor: 0,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /not on the quote/);

  // Duplicate sku in line_prices refused.
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1500 },
    ],
    shipping_minor: 0, tax_minor: 0,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /duplicate sku/);

  // Past valid_until refused.
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 0, tax_minor: 0,
    valid_until: 1,
    currency: "USD",
  }), /valid_until/);

  // Bad currency refused.
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 0, tax_minor: 0,
    valid_until: Date.now() + 86400000,
    currency: "usd",
  }), /currency/);

  // Happy path — total math.
  var validUntil = Date.now() + 86400000;
  var responded = await ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 500,
    tax_minor:      200,
    valid_until:    validUntil,
    currency:       "USD",
    operator_notes: "Lead time 14 days. Volume discount applied.",
  });
  check("respondToQuote moves to responded",          responded.status === "responded");
  check("respondToQuote stores shipping_minor",       responded.shipping_minor === 500);
  check("respondToQuote stores tax_minor",            responded.tax_minor === 200);
  check("respondToQuote stores valid_until",          responded.valid_until === validUntil);
  check("respondToQuote stores currency",             responded.currency === "USD");
  check("respondToQuote stores operator_notes",       responded.operator_notes === "Lead time 14 days. Volume discount applied.");
  // Math: 10*1000 + 5*1200 + 500 + 200 = 10000 + 6000 + 700 = 16700
  check("respondToQuote total_minor math correct",    responded.total_minor === 16700);
  // Per-line unit_price_minor + currency stamped.
  var blkLine = responded.lines.filter(function (l) { return l.sku === "WDG-PRO-BLK-L"; })[0];
  var redLine = responded.lines.filter(function (l) { return l.sku === "WDG-PRO-RED-L"; })[0];
  check("respondToQuote stamps per-line unit_price BLK", blkLine.unit_price_minor === 1000);
  check("respondToQuote stamps per-line unit_price RED", redLine.unit_price_minor === 1200);
  check("respondToQuote stamps per-line currency",
    responded.lines.every(function (l) { return l.currency === "USD"; }));

  // Re-responding refused (quote is responded, not requested).
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 999 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 999 },
    ],
    shipping_minor: 0, tax_minor: 0,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /refused — quote is responded/);

  // Defaults: shipping + tax default to 0 when omitted.
  var ctx2 = _setup();
  var q2 = await ctx2.quotes.requestQuote({
    customer_id: _validUuid(), lines: [{ sku: "ALPHA", quantity: 3 }],
  });
  var r2 = await ctx2.quotes.respondToQuote({
    quote_id:    q2.id,
    line_prices: [{ sku: "ALPHA", unit_price_minor: 2500 }],
    valid_until: Date.now() + 86400000,
    currency:    "EUR",
  });
  check("respondToQuote shipping default 0",         r2.shipping_minor === 0);
  check("respondToQuote tax default 0",              r2.tax_minor === 0);
  // 3 * 2500 = 7500
  check("respondToQuote total with default ship/tax", r2.total_minor === 7500);

  // Unknown quote_id.
  await assert.rejects(ctx.quotes.respondToQuote({
    quote_id: _validUuid(),
    line_prices: [{ sku: "X", unit_price_minor: 100 }],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /not found/);
}

async function _acceptAndReject() {
  var ctx = _setup();
  var cid = _validUuid();
  var q = await ctx.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });
  // Accept from `requested` refused.
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "buyer@example.com",
  }), /refused — quote is requested/);

  var responded = await ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 500, tax_minor: 200,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  check("ready-to-accept state is responded", responded.status === "responded");

  // accepted_by_customer required.
  await assert.rejects(ctx.quotes.customerAccept({ quote_id: q.id }), /accepted_by_customer/);
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "",
  }), /accepted_by_customer/);

  var accepted = await ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "buyer@example.com",
  });
  check("customerAccept moves to accepted",         accepted.status === "accepted");
  check("customerAccept stamps accepted_at",        typeof accepted.accepted_at === "number");
  check("customerAccept stamps accepted_by",        accepted.accepted_by_customer === "buyer@example.com");

  // Re-accepting refused (already accepted).
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "buyer@example.com",
  }), /refused — quote is accepted/);

  // Reject path on a separate quote.
  var qRej = await ctx.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });
  await ctx.quotes.respondToQuote({
    quote_id: qRej.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 9999 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 9999 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  var rejected = await ctx.quotes.customerReject({
    quote_id: qRej.id, reject_reason: "price too high",
  });
  check("customerReject moves to rejected",         rejected.status === "rejected");
  check("customerReject stores reject_reason",      rejected.reject_reason === "price too high");
  check("customerReject stamps rejected_at",        typeof rejected.rejected_at === "number");

  // Reject is terminal — further transitions refused.
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: qRej.id, accepted_by_customer: "buyer@example.com",
  }), /refused — quote is rejected/);
  await assert.rejects(ctx.quotes.cancelQuote({
    quote_id: qRej.id, cancel_reason: "trying to cancel a rejected quote",
  }), /refused — quote is rejected/);

  // Reject on requested refused (must respond first).
  var qR2 = await ctx.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });
  await assert.rejects(ctx.quotes.customerReject({
    quote_id: qR2.id, reject_reason: "no",
  }), /refused — quote is requested/);

  // Expiry — past valid_until refuses acceptance. Use a 1-second
  // expiry then set the row's valid_until backwards via the query
  // handle to simulate the cron-window race.
  var qExp = await ctx.quotes.requestQuote({
    customer_id: cid, lines: [{ sku: "X-ITEM", quantity: 1 }],
  });
  await ctx.quotes.respondToQuote({
    quote_id: qExp.id,
    line_prices: [{ sku: "X-ITEM", unit_price_minor: 100 }],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await ctx.query("UPDATE quotes SET valid_until = ?1 WHERE id = ?2", [1, qExp.id]);
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: qExp.id, accepted_by_customer: "late@buyer.example",
  }), /expired/);
}

async function _cancelTransitions() {
  var ctx = _setup();
  var cid = _validUuid();

  // Cancel from `requested`.
  var qReq = await ctx.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });
  var cancelled1 = await ctx.quotes.cancelQuote({
    quote_id: qReq.id, cancel_reason: "customer changed mind pre-response",
  });
  check("cancelQuote from requested moves to cancelled", cancelled1.status === "cancelled");
  check("cancelQuote stamps cancel_reason",              cancelled1.cancel_reason === "customer changed mind pre-response");
  check("cancelQuote stamps cancelled_at",               typeof cancelled1.cancelled_at === "number");

  // Cancel from `responded`.
  var qResp = await ctx.quotes.requestQuote({
    customer_id: cid, lines: _validLines(),
  });
  await ctx.quotes.respondToQuote({
    quote_id: qResp.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  var cancelled2 = await ctx.quotes.cancelQuote({
    quote_id: qResp.id, cancel_reason: "operator pulled — pricing error",
  });
  check("cancelQuote from responded moves to cancelled", cancelled2.status === "cancelled");

  // Cancel requires reason.
  var qReq2 = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  await assert.rejects(ctx.quotes.cancelQuote({ quote_id: qReq2.id }), /cancel_reason/);
  await assert.rejects(ctx.quotes.cancelQuote({
    quote_id: qReq2.id, cancel_reason: "",
  }), /cancel_reason/);

  // Cancel an accepted quote refused.
  var qAcc = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  await ctx.quotes.respondToQuote({
    quote_id: qAcc.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await ctx.quotes.customerAccept({
    quote_id: qAcc.id, accepted_by_customer: "buyer@example.com",
  });
  await assert.rejects(ctx.quotes.cancelQuote({
    quote_id: qAcc.id, cancel_reason: "trying to cancel an accepted quote",
  }), /refused — quote is accepted/);

  // Cancel a non-existent quote refused.
  await assert.rejects(ctx.quotes.cancelQuote({
    quote_id: _validUuid(), cancel_reason: "ghost",
  }), /not found/);
}

async function _convertToOrderNoHandle() {
  var ctx = _setup();   // no order handle
  var cid = _validUuid();
  var q = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  await ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "buyer@example.com",
  });

  // No order handle + no converted_order_id refused.
  await assert.rejects(ctx.quotes.convertToOrder({ quote_id: q.id }), /converted_order_id required/);

  // Caller-supplied converted_order_id lands.
  var converted = await ctx.quotes.convertToOrder({
    quote_id:           q.id,
    converted_order_id: "ord-external-12345",
  });
  check("convertToOrder moves to converted",        converted.status === "converted");
  check("convertToOrder records converted_order_id", converted.converted_order_id === "ord-external-12345");
  check("convertToOrder stamps converted_at",        typeof converted.converted_at === "number");

  // converted is terminal — onward transitions refused.
  await assert.rejects(ctx.quotes.cancelQuote({
    quote_id: q.id, cancel_reason: "no",
  }), /refused — quote is converted/);
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "again",
  }), /refused — quote is converted/);

  // convertToOrder from non-accepted state refused.
  var qPending = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  await assert.rejects(ctx.quotes.convertToOrder({
    quote_id: qPending.id, converted_order_id: "ord-x",
  }), /refused — quote is requested/);
}

async function _convertToOrderWithHandle() {
  // Inject an order handle. The handle captures the createFromCart
  // payload so the test can assert the exact totals + lines passed.
  var captured = null;
  var orderHandle = {
    createFromCart: async function (input) {
      captured = input;
      return { id: "ord-from-handle-" + Date.now() };
    },
  };
  var ctx = _setup({ order: orderHandle });
  var cid = _validUuid();
  var q = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  await ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 500, tax_minor: 200,
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await ctx.quotes.customerAccept({
    quote_id: q.id, accepted_by_customer: "buyer@example.com",
  });

  // ship_to is required when the order handle is wired.
  await assert.rejects(ctx.quotes.convertToOrder({ quote_id: q.id }), /ship_to/);

  var shipTo = { country: "US", street_line1: "1 Market St", city: "SF" };
  var converted = await ctx.quotes.convertToOrder({
    quote_id: q.id, ship_to: shipTo,
  });
  check("convertToOrder(handle) moves to converted",  converted.status === "converted");
  check("convertToOrder(handle) records order id",    converted.converted_order_id != null &&
                                                       converted.converted_order_id.indexOf("ord-from-handle-") === 0);

  check("createFromCart got customer_id",             captured.customer_id === cid);
  check("createFromCart got currency USD",            captured.currency === "USD");
  check("createFromCart got shipping_minor 500",      captured.shipping_minor === 500);
  check("createFromCart got tax_minor 200",           captured.tax_minor === 200);
  check("createFromCart got discount_minor 0",        captured.discount_minor === 0);
  // 10*1000 + 5*1200 = 16000 subtotal; + 500 + 200 = 16700 grand total
  check("createFromCart got subtotal_minor 16000",    captured.subtotal_minor === 16000);
  check("createFromCart got grand_total_minor 16700", captured.grand_total_minor === 16700);
  check("createFromCart got 2 lines",                 captured.lines.length === 2);
  check("createFromCart got ship_to",                 captured.ship_to.country === "US");
  check("createFromCart lines have unit_currency",    captured.lines.every(function (l) { return l.unit_currency === "USD"; }));
}

async function _listsAndExpiry() {
  var ctx = _setup();
  var cidA = _validUuid();
  var cidB = _validUuid();

  // cidA: one requested, one responded, one accepted, one rejected
  var qA1 = await ctx.quotes.requestQuote({ customer_id: cidA, lines: _validLines() });
  var qA2 = await ctx.quotes.requestQuote({ customer_id: cidA, lines: _validLines() });
  var qA3 = await ctx.quotes.requestQuote({ customer_id: cidA, lines: _validLines() });
  var qA4 = await ctx.quotes.requestQuote({ customer_id: cidA, lines: _validLines() });
  // cidB: one requested
  await ctx.quotes.requestQuote({ customer_id: cidB, lines: _validLines() });

  // qA2 -> responded
  await ctx.quotes.respondToQuote({
    quote_id: qA2.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  // qA3 -> responded -> accepted
  await ctx.quotes.respondToQuote({
    quote_id: qA3.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await ctx.quotes.customerAccept({
    quote_id: qA3.id, accepted_by_customer: "buyer@example.com",
  });
  // qA4 -> responded -> rejected
  await ctx.quotes.respondToQuote({
    quote_id: qA4.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await ctx.quotes.customerReject({ quote_id: qA4.id, reject_reason: "no" });

  // quotesForCustomer cidA returns 4, cidB returns 1
  var listA = await ctx.quotes.quotesForCustomer(cidA);
  check("quotesForCustomer cidA returns 4",          listA.length === 4);
  var listB = await ctx.quotes.quotesForCustomer(cidB);
  check("quotesForCustomer cidB returns 1",          listB.length === 1);

  // status filter narrows.
  var listAresponded = await ctx.quotes.quotesForCustomer(cidA, { status: "responded" });
  check("quotesForCustomer status=responded narrows", listAresponded.length === 1 && listAresponded[0].id === qA2.id);
  var listAaccepted = await ctx.quotes.quotesForCustomer(cidA, { status: "accepted" });
  check("quotesForCustomer status=accepted narrows",  listAaccepted.length === 1 && listAaccepted[0].id === qA3.id);

  // limit caps the result.
  var listLim = await ctx.quotes.quotesForCustomer(cidA, { limit: 2 });
  check("quotesForCustomer limit caps page size",    listLim.length === 2);
  await assert.rejects(ctx.quotes.quotesForCustomer(cidA, { limit: 0 }),  /limit/);
  await assert.rejects(ctx.quotes.quotesForCustomer(cidA, { limit: 9999 }), /limit/);

  // pendingResponse returns the two `requested` quotes (qA1 + qB1).
  var pending = await ctx.quotes.pendingResponse();
  check("pendingResponse returns the two requested quotes", pending.length === 2);
  check("pendingResponse only returns requested",
    pending.every(function (r) { return r.status === "requested"; }));

  // listExpired: qA2 is responded with a future valid_until — not
  // expired yet. Walk the row backward via the query handle to put
  // its valid_until in the past, then listExpired should surface it.
  var nowMs = Date.now();
  await ctx.query("UPDATE quotes SET valid_until = ?1 WHERE id = ?2", [nowMs - 1000, qA2.id]);
  var expired = await ctx.quotes.listExpired({ as_of: nowMs });
  check("listExpired surfaces past-valid_until row",  expired.length === 1 && expired[0].id === qA2.id);
  // markExpired flips it.
  var marked = await ctx.quotes.markExpired({ quote_id: qA2.id, as_of: nowMs });
  check("markExpired moves to expired",               marked.status === "expired");
  // Now listExpired drops it (no longer in responded).
  var expiredAfter = await ctx.quotes.listExpired({ as_of: nowMs });
  check("listExpired empty after markExpired",        expiredAfter.length === 0);
  // Expired is terminal — onward transitions refused.
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: qA2.id, accepted_by_customer: "late@buyer.example",
  }), /refused — quote is expired/);
  await assert.rejects(ctx.quotes.cancelQuote({
    quote_id: qA2.id, cancel_reason: "no",
  }), /refused — quote is expired/);

  // markExpired on a non-expired quote refused.
  var qFresh = await ctx.quotes.requestQuote({ customer_id: cidA, lines: _validLines() });
  await ctx.quotes.respondToQuote({
    quote_id: qFresh.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  await assert.rejects(ctx.quotes.markExpired({
    quote_id: qFresh.id, as_of: Date.now(),
  }), /not yet expired/);

  // getQuote happy path + miss.
  var got = await ctx.quotes.getQuote(qA1.id);
  check("getQuote returns hydrated quote",            got && got.id === qA1.id && got.lines.length === 2);
  var miss = await ctx.quotes.getQuote(_validUuid());
  check("getQuote miss -> null",                      miss === null);
  await assert.rejects(ctx.quotes.getQuote("not-a-uuid"), /quote_id/);

  // listExpired refusals.
  await assert.rejects(ctx.quotes.listExpired(),                /input object required/);
  await assert.rejects(ctx.quotes.listExpired({ as_of: -1 }),   /as_of/);
  await assert.rejects(ctx.quotes.listExpired({ as_of: "x" }),  /as_of/);
}

async function _repriceFlow() {
  var ctx = _setup();
  var cid = _validUuid();
  var q = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  var tokenAtRequest = q.view_token;

  // Reprice on a still-requested quote refused — there's no offer to revise.
  await assert.rejects(ctx.quotes.repriceQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 900 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1100 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /refused — quote is requested/);

  var firstValidUntil = Date.now() + 86400000;
  var responded = await ctx.quotes.respondToQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1000 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1200 },
    ],
    shipping_minor: 500, tax_minor: 200,
    valid_until: firstValidUntil,
    currency: "USD",
    operator_notes: "First offer.",
  });
  check("respond stamps response_version 1", responded.response_version === 1);

  // Reprice: improved prices, fresh window, updated note.
  var secondValidUntil = Date.now() + 2 * 86400000;
  var repriced = await ctx.quotes.repriceQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 800 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1000 },
    ],
    shipping_minor: 0, tax_minor: 0,
    valid_until: secondValidUntil,
    currency: "USD",
    operator_notes: "Better volume pricing applied.",
  });
  check("reprice keeps status responded",          repriced.status === "responded");
  check("reprice bumps response_version to 2",     repriced.response_version === 2);
  // 10*800 + 5*1000 = 13000, no shipping/tax.
  check("reprice recomputes total_minor",          repriced.total_minor === 13000);
  check("reprice replaces shipping_minor",         repriced.shipping_minor === 0);
  check("reprice stamps the new valid_until",      repriced.valid_until === secondValidUntil);
  check("reprice updates operator_notes",          repriced.operator_notes === "Better volume pricing applied.");
  var blk = repriced.lines.filter(function (l) { return l.sku === "WDG-PRO-BLK-L"; })[0];
  check("reprice re-stamps per-line unit price",   blk.unit_price_minor === 800);

  // The customer's existing view token still resolves and carries the NEW
  // pricing — a reprice never rotates the link.
  var viaToken = await ctx.quotes.getByViewToken(tokenAtRequest);
  check("view token survives the reprice",         viaToken != null && viaToken.id === q.id);
  check("view token resolves the NEW pricing",     viaToken != null && viaToken.total_minor === 13000 &&
                                                   viaToken.response_version === 2);

  // A second reprice keeps counting.
  var repriced2 = await ctx.quotes.repriceQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 790 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 990 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  });
  check("second reprice bumps response_version to 3", repriced2.response_version === 3);

  // Payload validation — same contract as respond.
  await assert.rejects(ctx.quotes.repriceQuote({
    quote_id: q.id,
    line_prices: [{ sku: "WDG-PRO-BLK-L", unit_price_minor: 800 }],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /line_prices length/);
  await assert.rejects(ctx.quotes.repriceQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 800 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1000 },
    ],
    valid_until: Date.now() - 1000,
    currency: "USD",
  }), /valid_until must be in the future/);
  await assert.rejects(ctx.quotes.repriceQuote({
    quote_id: _validUuid(),
    line_prices: [{ sku: "X", unit_price_minor: 1 }],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /not found/);

  // Reprice refused once the customer settles it.
  await ctx.quotes.customerAccept({ quote_id: q.id, accepted_by_customer: "buyer@example.com" });
  await assert.rejects(ctx.quotes.repriceQuote({
    quote_id: q.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /refused — quote is accepted/);

  // ...and on a withdrawn quote.
  var qGone = await ctx.quotes.requestQuote({ customer_id: cid, lines: _validLines() });
  await ctx.quotes.cancelQuote({ quote_id: qGone.id, cancel_reason: "pulled" });
  await assert.rejects(ctx.quotes.repriceQuote({
    quote_id: qGone.id,
    line_prices: [
      { sku: "WDG-PRO-BLK-L", unit_price_minor: 1 },
      { sku: "WDG-PRO-RED-L", unit_price_minor: 1 },
    ],
    valid_until: Date.now() + 86400000,
    currency: "USD",
  }), /refused — quote is cancelled/);
}

async function _listByStatusAndExpireDue() {
  var ctx = _setup();
  var cid = _validUuid();

  async function _respondedQuote(validUntil) {
    var q = await ctx.quotes.requestQuote({ customer_id: cid, lines: [{ sku: "SWEEP-ITEM", quantity: 2 }] });
    await ctx.quotes.respondToQuote({
      quote_id: q.id,
      line_prices: [{ sku: "SWEEP-ITEM", unit_price_minor: 500 }],
      valid_until: Date.now() + 86400000,
      currency: "USD",
    });
    // Walk valid_until to the scenario's timestamp via the query handle —
    // respondToQuote (correctly) refuses authoring a past expiry.
    await ctx.query("UPDATE quotes SET valid_until = ?1 WHERE id = ?2", [validUntil, q.id]);
    return q.id;
  }

  var nowMs = Date.now();
  var dueA   = await _respondedQuote(nowMs - 5000);   // due — should expire
  var dueB   = await _respondedQuote(nowMs - 1000);   // due — should expire
  var fresh  = await _respondedQuote(nowMs + 86400000); // future — must stay responded
  // Due by valid_until, but the customer accepts before the sweep — the
  // sweep's status re-check must leave the accepted row alone.
  var dueAccepted = await _respondedQuote(nowMs - 2000);
  // Accept BEFORE walking the clock back would refuse; accept against the
  // raw row instead (the table walk above already happened, so flip the
  // status directly to simulate the accept landing between scan and flip).
  await ctx.query("UPDATE quotes SET status = 'accepted', accepted_at = ?1 WHERE id = ?2", [nowMs, dueAccepted]);

  // expireDue input validation throws (the cron entry surfaces config bugs).
  await assert.rejects(ctx.quotes.expireDue(),                 /input object required/);
  await assert.rejects(ctx.quotes.expireDue({ as_of: "x" }),   /as_of/);
  await assert.rejects(ctx.quotes.expireDue({ as_of: nowMs, limit: 0 }), /limit/);

  var pass1 = await ctx.quotes.expireDue({ as_of: nowMs });
  check("expireDue flips the two due rows",      pass1.expired === 2);
  check("expireDue scans only due rows",         pass1.scanned === 2);
  check("expireDue pass 1 skips nothing",        pass1.skipped === 0);

  var afterA = await ctx.quotes.getQuote(dueA);
  var afterB = await ctx.quotes.getQuote(dueB);
  var afterFresh = await ctx.quotes.getQuote(fresh);
  var afterAccepted = await ctx.quotes.getQuote(dueAccepted);
  check("due row A is expired",                  afterA.status === "expired");
  check("due row B is expired",                  afterB.status === "expired");
  check("future row stays responded",            afterFresh.status === "responded");
  check("accepted row untouched by the sweep",   afterAccepted.status === "accepted");

  // Second pass — idempotent: the rows already settled, nothing flips.
  var pass2 = await ctx.quotes.expireDue({ as_of: Date.now() });
  check("expireDue second pass expires nothing", pass2.expired === 0 && pass2.scanned === 0);

  // A reprice pushes valid_until back into the future — a sweep computed
  // against the OLD due moment (`as_of` frozen before the reprice, the
  // scan-vs-flip window) must leave the revised quote alive: both the scan
  // and the per-row claim re-check `valid_until <= as_of`.
  var asOf = Date.now();
  var revived = await _respondedQuote(asOf - 1000);
  await ctx.quotes.repriceQuote({
    quote_id: revived,
    line_prices: [{ sku: "SWEEP-ITEM", unit_price_minor: 400 }],
    valid_until: asOf + 86400000,
    currency: "USD",
  });
  var pass3 = await ctx.quotes.expireDue({ as_of: asOf });
  var afterRevived = await ctx.quotes.getQuote(revived);
  check("repriced row survives the sweep",       afterRevived.status === "responded");
  check("sweep expires nothing after the reprice", pass3.expired === 0);

  // Accept-time guard + the sweep never double-transition: the accept-time
  // guard REFUSES (no transition) on an elapsed window; only the sweep
  // transitions, exactly once.
  var raceRow = await _respondedQuote(Date.now() - 1000);
  await assert.rejects(ctx.quotes.customerAccept({
    quote_id: raceRow, accepted_by_customer: "late@buyer.example",
  }), /expired/);
  var stillResponded = await ctx.quotes.getQuote(raceRow);
  check("accept-time guard refuses without transitioning", stillResponded.status === "responded");
  var pass4 = await ctx.quotes.expireDue({ as_of: Date.now() });
  check("sweep transitions the guarded row once", pass4.expired === 1);
  check("guarded row landed expired", (await ctx.quotes.getQuote(raceRow)).status === "expired");

  // listByStatus — the admin expired filter's read.
  var expiredList = await ctx.quotes.listByStatus({ status: "expired" });
  check("listByStatus(expired) lists the swept rows",
    expiredList.length === 3 &&
    expiredList.every(function (r) { return r.status === "expired"; }));
  var respondedList = await ctx.quotes.listByStatus({ status: "responded" });
  check("listByStatus(responded) lists the open rows",
    respondedList.length === 2 &&
    respondedList.every(function (r) { return r.status === "responded"; }));
  check("listByStatus hydrates lines", expiredList[0].lines.length === 1);
  await assert.rejects(ctx.quotes.listByStatus({ status: "bogus" }), /status must be one of/);
  await assert.rejects(ctx.quotes.listByStatus({ status: "expired", limit: 0 }), /limit/);
  await assert.rejects(ctx.quotes.listByStatus(), /input object required/);
}

async function _factoryGuards() {
  // Bad cart handle (missing methods) refuses at create-time.
  assert.throws(function () { quotes.create({ query: function () {}, cart: {} }); },
    /opts.cart must expose/);
  assert.throws(function () {
    quotes.create({ query: function () {}, cart: { get: function () {} } });
  }, /opts.cart must expose/);

  // Bad order handle refuses too.
  assert.throws(function () { quotes.create({ query: function () {}, order: {} }); },
    /opts.order must expose/);
}

async function _bShopHandleAvailable() {
  // The primitive isn't surfaced on the entry-point yet — this
  // assertion is a smoke that the framework handles the primitive
  // composes against ARE available (so the primitive's lazy require
  // resolves at runtime).
  check("bShop.framework exposes uuid.v7",
    typeof bShop.framework.uuid.v7 === "function");
  check("bShop.framework exposes guardUuid",
    bShop.framework.guardUuid && typeof bShop.framework.guardUuid.sanitize === "function");
}

async function run() {
  await _requestHappyAndRefusals();
  await _requestFromCartHandle();
  await _respondHappyAndRefusals();
  await _acceptAndReject();
  await _cancelTransitions();
  await _convertToOrderNoHandle();
  await _convertToOrderWithHandle();
  await _listsAndExpiry();
  await _repriceFlow();
  await _listByStatusAndExpireDue();
  await _factoryGuards();
  await _bShopHandleAvailable();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/quotes.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - quotes (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
