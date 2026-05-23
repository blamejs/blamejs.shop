"use strict";
/**
 * packingSlips — warehouse pick-verification slip render surfaces +
 * audit log + per-location batched-print queue.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * the order primitive owns + the 0149 packing_slips migration.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/packing-slips.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Gift-options integration is exercised via a stub `getForOrder`
 * handle (not the gift-options primitive itself) so the slip
 * behavior is verifiable without coupling the slip suite to the
 * gift-options migration + wrap-catalog seed path.
 *
 * Coverage:
 *   - renderHtml emits self-contained HTML with header, ship-to,
 *     line items, totals, and an inline Code-128 barcode of the
 *     order_id
 *   - renderPdfPayload returns { order_id, paper_size, locale, html }
 *     with the correct @page rule per paper_size (letter / a4)
 *   - gift-message + recipient-name render with HTML-escape on
 *     hostile customer input
 *   - hide_prices=true strips Price + Total columns and the totals
 *     table from the slip
 *   - locale switching (en / es / de) + de-CH falls back to de
 *   - recordPrint + printsForOrder round-trip (newest-first)
 *   - enqueueForLocation + bulkRenderForLocation respect limit +
 *     FIFO ordering; idempotency guard refuses duplicate enqueue
 *   - dequeueForLocation removes the queue row
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var packingSlips  = require("../../lib/packing-slips");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql",
  "0149_packing_slips.sql",
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

function _validUUID() { return bShop.framework.uuid.v7(); }

// Monotonic counter so per-seed catalog identifiers (slug / sku)
// never collide on the catalog UNIQUE indexes when two seed calls
// land in the same UUIDv7 millisecond bucket.
var _seedCounter = 0;
function _seedSuffix() { _seedCounter += 1; return String(_seedCounter); }

// Seed an order with one line, populated totals, and a richer
// ship-to. Returns the order primitive + the loaded order row so
// tests that need both have a single seed call.
async function _seedOrder(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });

  var suffix = _seedSuffix();
  var p = await catalog.products.create({
    slug:   opts.slug   || ("ps-test-" + suffix),
    title:  opts.title  || "Packing Slip Test Item",
    status: "active",
  });
  var v = await catalog.variants.create(p.id, { sku: opts.sku || ("PS-" + suffix) });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2599 });

  var sessionId = _validUUID();
  var c = await cart.create(sessionId, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: v.id, qty: 2 });

  var o = await order.createFromCart({
    cart_id:           c.id,
    session_id:        sessionId,
    customer_id:       opts.customer_id || _validUUID(),
    currency:          "USD",
    subtotal_minor:    5198,
    discount_minor:    opts.discount_minor != null ? opts.discount_minor : 0,
    tax_minor:         420,
    shipping_minor:    695,
    grand_total_minor: 5198 + 420 + 695 - (opts.discount_minor || 0),
    ship_to:           opts.ship_to || {
      name:        "Alex Buyer",
      line1:       "123 Main St",
      line2:       "Apt 4B",
      city:        "Brooklyn",
      region:      "NY",
      postal_code: "11201",
      country:     "US",
    },
    lines: [{
      variant_id:        v.id,
      sku:               v.sku,
      qty:               2,
      unit_amount_minor: 2599,
      unit_currency:     "USD",
    }],
  });

  return { order: order, orderRow: o, sku: v.sku };
}

// Stub gift-options handle. The packing-slips primitive only calls
// `getForOrder(order_id)`; the stub returns a fixed row keyed by
// order_id so each test pins the gift shape it needs without
// dragging in the gift-options primitive's catalog + setForOrder
// surface.
function _giftStub(byOrderId) {
  return {
    getForOrder: async function (oid) {
      return byOrderId[oid] || null;
    },
  };
}

// ---- renderHtml --------------------------------------------------------

async function _renderHtmlBasics() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ps = packingSlips.create({ query: q, order: seed.order });

  var html = await ps.renderHtml({ order_id: seed.orderRow.id });
  check("renderHtml returns string",          typeof html === "string" && html.length > 0);
  check("html is a full document",            html.indexOf("<!doctype html>") === 0);
  check("html carries lang=en",               html.indexOf("lang=\"en\"") !== -1);
  check("html has @page letter rule",         html.indexOf("@page { size: letter") !== -1);
  check("html title includes Packing slip",   html.indexOf("<h1>Packing slip</h1>") !== -1);
  check("html includes Order label",          html.indexOf("Order") !== -1);
  check("html includes order id",             html.indexOf(seed.orderRow.id) !== -1);
  check("html includes Ship to label",        html.indexOf("Ship to") !== -1);
  check("html includes ship_to.name",         html.indexOf("Alex Buyer") !== -1);
  check("html includes ship_to.line1",        html.indexOf("123 Main St") !== -1);
  check("html includes Grand total label",    html.indexOf("Grand total") !== -1);
  check("html includes line item SKU",        html.indexOf(seed.sku) !== -1);
  check("html includes inline barcode SVG",   html.indexOf("<svg ") !== -1);
  check("html barcode aria-label",            html.indexOf("aria-label=\"barcode\"") !== -1);
  check("html barcode embeds order_id",       html.indexOf(">" + seed.orderRow.id + "<") !== -1);
  check("html includes Scan to verify",       html.indexOf("Scan to verify") !== -1);
}

async function _renderPdfPayloadPaperSize() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ps = packingSlips.create({ query: q, order: seed.order });

  var letter = await ps.renderPdfPayload({ order_id: seed.orderRow.id });
  check("renderPdfPayload returns object",       letter && typeof letter === "object");
  check("renderPdfPayload default paper=letter", letter.paper_size === "letter");
  check("renderPdfPayload default locale=en",    letter.locale === "en");
  check("renderPdfPayload returns html string",  typeof letter.html === "string" && letter.html.indexOf("<!doctype html>") === 0);
  check("renderPdfPayload letter @page rule",    letter.html.indexOf("@page { size: letter") !== -1);
  check("renderPdfPayload preserves order_id",   letter.order_id === seed.orderRow.id);

  var a4 = await ps.renderPdfPayload({ order_id: seed.orderRow.id, paper_size: "a4" });
  check("a4 paper_size carried through",         a4.paper_size === "a4");
  check("a4 html includes A4 @page rule",        a4.html.indexOf("@page { size: A4") !== -1);
  check("a4 html does NOT include letter rule",  a4.html.indexOf("@page { size: letter") === -1);

  await assert.rejects(ps.renderPdfPayload({ order_id: seed.orderRow.id, paper_size: "tabloid" }), /paper_size/);
  await assert.rejects(ps.renderPdfPayload({ order_id: seed.orderRow.id, paper_size: 4 }),         /paper_size/);
}

async function _renderHtmlLocaleSwitching() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ps = packingSlips.create({ query: q, order: seed.order });

  var es = await ps.renderHtml({ order_id: seed.orderRow.id, locale: "es" });
  check("es: Spanish slip label",       es.indexOf("Albaran") !== -1);
  check("es: Spanish grand total",      es.indexOf("Total general") !== -1);
  check("es: lang=es attribute",        es.indexOf("lang=\"es\"") !== -1);

  var deCH = await ps.renderHtml({ order_id: seed.orderRow.id, locale: "de-CH" });
  check("de-CH falls back to de catalog", deCH.indexOf("Lieferschein") !== -1);
  check("de-CH carries de-CH lang attr",  deCH.indexOf("lang=\"de-CH\"") !== -1);

  var ja = await ps.renderHtml({ order_id: seed.orderRow.id, locale: "ja-JP" });
  check("unknown locale falls back to en", ja.indexOf("Packing slip") !== -1);
}

// ---- gift-options integration ------------------------------------------

async function _renderHtmlGiftMessageAndRecipientEscape() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var hostileMessage = 'Happy birthday\n<script>alert("xss")</script>\n— Love & kisses';
  var hostileRecipient = '<img src=x onerror=alert(1)> Carol & Bob';
  var gift = _giftStub({});
  gift.byOrder = {};
  gift.byOrder[seed.orderRow.id] = {
    order_id:       seed.orderRow.id,
    gift_message:   hostileMessage,
    recipient_name: hostileRecipient,
    hide_prices:    false,
  };
  // Patch the stub's getForOrder to read from the local map so the
  // hostile-input row is what the renderer sees.
  gift.getForOrder = async function (oid) { return gift.byOrder[oid] || null; };

  var ps = packingSlips.create({ query: q, order: seed.order, giftOptions: gift });
  var html = await ps.renderHtml({ order_id: seed.orderRow.id });

  check("gift block renders gift_message label",   html.indexOf("Gift message") !== -1);
  check("gift block renders gift To label",        html.indexOf("<strong>To:</strong>") !== -1);
  check("hostile message <script> tag escaped",    html.indexOf("<script>alert") === -1);
  check("hostile message <script> retained escaped", html.indexOf("&lt;script&gt;") !== -1);
  check("hostile recipient <img> tag escaped",     html.indexOf("<img src=x") === -1);
  check("hostile recipient retained escaped",      html.indexOf("&lt;img src=x") !== -1);
  check("ampersand in message escaped",            html.indexOf("Love &amp; kisses") !== -1);
  check("ampersand in recipient escaped",          html.indexOf("Carol &amp; Bob") !== -1);
  check("does NOT contain raw recipient ampersand", html.indexOf("Carol & Bob") === -1);
  check("multi-line message splits on LF",         html.indexOf("Happy birthday") !== -1 &&
                                                   html.indexOf("— Love &amp; kisses") !== -1);
}

async function _renderHtmlHidePricesStripsMonetaryColumns() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var byOrder = {};
  byOrder[seed.orderRow.id] = {
    order_id:       seed.orderRow.id,
    gift_message:   null,
    recipient_name: null,
    hide_prices:    true,
  };
  var gift = { getForOrder: async function (oid) { return byOrder[oid] || null; } };

  var ps = packingSlips.create({ query: q, order: seed.order, giftOptions: gift });
  var html = await ps.renderHtml({ order_id: seed.orderRow.id });

  // The default-shape control render exposes the totals; the hide_prices
  // render is the same data with monetary columns stripped.
  var psNoGift = packingSlips.create({ query: q, order: seed.order });
  var fullHtml = await psNoGift.renderHtml({ order_id: seed.orderRow.id });

  check("control render shows Price column",       fullHtml.indexOf("Price") !== -1);
  check("control render shows totals block",       fullHtml.indexOf("Grand total") !== -1);
  check("control render shows USD amount",         fullHtml.indexOf("25.99 USD") !== -1);

  check("hide_prices strips Price column",         html.indexOf("Price") === -1);
  check("hide_prices strips Grand total label",    html.indexOf("Grand total") === -1);
  check("hide_prices strips Subtotal label",       html.indexOf("Subtotal") === -1);
  check("hide_prices strips USD amount",           html.indexOf("25.99 USD") === -1);
  check("hide_prices keeps SKU column",            html.indexOf(seed.sku) !== -1);
  check("hide_prices keeps Qty column",            html.indexOf("Qty") !== -1);
  check("hide_prices keeps barcode",               html.indexOf("<svg ") !== -1);
}

// ---- recordPrint + printsForOrder --------------------------------------

async function _recordPrintAndRetrieve() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ps = packingSlips.create({ query: q, order: seed.order });

  var html = await ps.renderHtml({ order_id: seed.orderRow.id });
  var bytes = Buffer.from(html, "utf8");
  var sha = bShop.framework.crypto.sha3Hash(bytes);

  var rec1 = await ps.recordPrint({
    order_id:     seed.orderRow.id,
    printer_name: "warehouse-east-1",
    sha3_512:     sha,
    byte_size:    bytes.length,
  });
  check("recordPrint returns id",              typeof rec1.id === "string" && rec1.id.length > 0);
  check("recordPrint preserves order_id",      rec1.order_id === seed.orderRow.id);
  check("recordPrint preserves printer_name",  rec1.printer_name === "warehouse-east-1");
  check("recordPrint preserves byte_size",     rec1.byte_size === bytes.length);
  check("recordPrint preserves sha3_512",      rec1.sha3_512 === sha);
  check("recordPrint timestamp is integer",    Number.isInteger(rec1.occurred_at));

  // Second print on the same order — printsForOrder returns both
  // newest-first.
  var rec2 = await ps.recordPrint({
    order_id:     seed.orderRow.id,
    printer_name: "warehouse-east-2",
    sha3_512:     sha,
    byte_size:    bytes.length,
  });
  check("rec2 has distinct id",                 rec2.id !== rec1.id);
  check("rec2 occurred_at strictly later",      rec2.occurred_at > rec1.occurred_at);

  var prints = await ps.printsForOrder(seed.orderRow.id);
  check("printsForOrder returns array",        Array.isArray(prints));
  check("printsForOrder returns 2 rows",       prints.length === 2);
  check("printsForOrder newest-first",         prints[0].occurred_at >= prints[1].occurred_at);
  check("printsForOrder carries printer_name", prints.some(function (r) { return r.printer_name === "warehouse-east-1"; }) &&
                                               prints.some(function (r) { return r.printer_name === "warehouse-east-2"; }));
  check("printsForOrder carries sha3_512",     prints.every(function (r) { return r.sha3_512 === sha; }));
  check("printsForOrder byte_size is number",  prints.every(function (r) { return typeof r.byte_size === "number" && r.byte_size === bytes.length; }));

  // Missing order — recordPrint refuses with a readable error.
  await assert.rejects(ps.recordPrint({
    order_id:     _validUUID(),
    printer_name: "warehouse-east-1",
    sha3_512:     sha,
    byte_size:    bytes.length,
  }), /not found/);
}

// ---- bulkRenderForLocation + enqueue / dequeue -------------------------

async function _bulkRenderForLocationFifoAndLimit() {
  var q = _makeQuery();
  var seed1 = await _seedOrder(q);
  var seed2 = await _seedOrder(q, { slug: "ps-bulk-2", sku: "PS-BULK-2" });
  var seed3 = await _seedOrder(q, { slug: "ps-bulk-3", sku: "PS-BULK-3" });
  var ps = packingSlips.create({ query: q, order: seed1.order });

  // Bulk-render against an empty queue returns [].
  var empty = await ps.bulkRenderForLocation({ location_code: "WH-EAST" });
  check("bulkRender empty queue returns []", Array.isArray(empty) && empty.length === 0);

  // Enqueue three orders at WH-EAST in a known order. The monotonic
  // clock guarantees strict ordering even when the calls land in the
  // same millisecond.
  var e1 = await ps.enqueueForLocation({ order_id: seed1.orderRow.id, location_code: "WH-EAST" });
  var e2 = await ps.enqueueForLocation({ order_id: seed2.orderRow.id, location_code: "WH-EAST" });
  var e3 = await ps.enqueueForLocation({ order_id: seed3.orderRow.id, location_code: "WH-EAST" });
  check("enqueue returns order_id",      e1.order_id === seed1.orderRow.id);
  check("enqueue returns location_code", e1.location_code === "WH-EAST");
  check("enqueue strict-monotonic queued_at", e1.queued_at < e2.queued_at && e2.queued_at < e3.queued_at);

  // Bulk render with default limit returns all three in FIFO order.
  var all = await ps.bulkRenderForLocation({ location_code: "WH-EAST" });
  check("bulk all returns 3",                  all.length === 3);
  check("bulk all FIFO order_id[0]",           all[0].order_id === seed1.orderRow.id);
  check("bulk all FIFO order_id[1]",           all[1].order_id === seed2.orderRow.id);
  check("bulk all FIFO order_id[2]",           all[2].order_id === seed3.orderRow.id);
  check("bulk all each carries html string",   all.every(function (r) { return typeof r.html === "string" && r.html.indexOf("<!doctype html>") === 0; }));
  check("bulk all html embeds matching order_id", all.every(function (r) { return r.html.indexOf(r.order_id) !== -1; }));

  // Limit=2 returns the two oldest only.
  var limited = await ps.bulkRenderForLocation({ location_code: "WH-EAST", limit: 2 });
  check("bulk limit=2 returns 2",              limited.length === 2);
  check("bulk limit=2 returns oldest two",     limited[0].order_id === seed1.orderRow.id && limited[1].order_id === seed2.orderRow.id);

  // Queueing at a different location is independent.
  var westEmpty = await ps.bulkRenderForLocation({ location_code: "WH-WEST" });
  check("bulk other location empty",           westEmpty.length === 0);

  // Idempotency guard: re-enqueue at same location refuses.
  var dupThrew = false;
  try {
    await ps.enqueueForLocation({ order_id: seed1.orderRow.id, location_code: "WH-EAST" });
  } catch (e) { dupThrew = /already queued/.test(e.message); }
  check("enqueue duplicate refuses",           dupThrew === true);

  // Same order at a DIFFERENT location is allowed (the operator
  // routes one box to each location for a split shipment).
  var splitEnq = await ps.enqueueForLocation({ order_id: seed1.orderRow.id, location_code: "WH-WEST" });
  check("enqueue same order at new location",  splitEnq.location_code === "WH-WEST");

  // Dequeue removes the row; subsequent bulk render skips it.
  var deq = await ps.dequeueForLocation({ order_id: seed1.orderRow.id, location_code: "WH-EAST" });
  check("dequeue returns dequeued=true",       deq.dequeued === true);

  var deqAgain = await ps.dequeueForLocation({ order_id: seed1.orderRow.id, location_code: "WH-EAST" });
  check("re-dequeue returns dequeued=false",   deqAgain.dequeued === false);

  var afterDequeue = await ps.bulkRenderForLocation({ location_code: "WH-EAST" });
  check("bulk after dequeue returns 2",        afterDequeue.length === 2);
  check("bulk after dequeue first is seed2",   afterDequeue[0].order_id === seed2.orderRow.id);
}

// ---- validation refusals -----------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ps = packingSlips.create({ query: q, order: seed.order });

  // create-time validation
  var threw = false;
  try { packingSlips.create({ query: q }); } catch (e) { threw = /order primitive is required/.test(e.message); }
  check("create refuses without order primitive", threw === true);

  var giftThrew = false;
  try { packingSlips.create({ query: q, order: seed.order, giftOptions: {} }); }
  catch (e) { giftThrew = /giftOptions must expose getForOrder/.test(e.message); }
  check("create refuses bad giftOptions handle",  giftThrew === true);

  // renderHtml
  await assert.rejects(ps.renderHtml(),                                              /input object required/);
  await assert.rejects(ps.renderHtml({}),                                            /order_id/);
  await assert.rejects(ps.renderHtml({ order_id: "not-a-uuid" }),                    /order_id/);
  await assert.rejects(ps.renderHtml({ order_id: _validUUID() }),                    /not found/);
  await assert.rejects(ps.renderHtml({ order_id: seed.orderRow.id, locale: "english" }), /locale/);

  // renderPdfPayload
  await assert.rejects(ps.renderPdfPayload(),                                        /input object required/);
  await assert.rejects(ps.renderPdfPayload({}),                                      /order_id/);
  await assert.rejects(ps.renderPdfPayload({ order_id: seed.orderRow.id, paper_size: "tabloid" }), /paper_size/);

  // recordPrint
  await assert.rejects(ps.recordPrint(),                                             /input object required/);
  await assert.rejects(ps.recordPrint({}),                                           /order_id/);
  await assert.rejects(ps.recordPrint({ order_id: seed.orderRow.id }),               /printer_name/);
  await assert.rejects(ps.recordPrint({
    order_id: seed.orderRow.id, printer_name: "",
  }),                                                                                /printer_name/);
  await assert.rejects(ps.recordPrint({
    order_id: seed.orderRow.id, printer_name: "ok",
  }),                                                                                /sha3_512/);
  await assert.rejects(ps.recordPrint({
    order_id: seed.orderRow.id, printer_name: "ok", sha3_512: "short",
  }),                                                                                /sha3_512/);
  await assert.rejects(ps.recordPrint({
    order_id: seed.orderRow.id, printer_name: "ok", sha3_512: "a".repeat(128),
  }),                                                                                /byte_size/);
  await assert.rejects(ps.recordPrint({
    order_id: seed.orderRow.id, printer_name: "ok", sha3_512: "a".repeat(128), byte_size: -1,
  }),                                                                                /byte_size/);

  // printsForOrder
  await assert.rejects(ps.printsForOrder("not-a-uuid"),                              /order_id/);

  // enqueueForLocation / dequeueForLocation
  await assert.rejects(ps.enqueueForLocation(),                                      /input object required/);
  await assert.rejects(ps.enqueueForLocation({}),                                    /order_id/);
  await assert.rejects(ps.enqueueForLocation({ order_id: seed.orderRow.id }),        /location_code/);
  await assert.rejects(ps.enqueueForLocation({
    order_id: seed.orderRow.id, location_code: "spaces not allowed",
  }),                                                                                /location_code/);
  await assert.rejects(ps.dequeueForLocation(),                                      /input object required/);
  await assert.rejects(ps.dequeueForLocation({ order_id: "not-a-uuid", location_code: "WH" }), /order_id/);

  // bulkRenderForLocation
  await assert.rejects(ps.bulkRenderForLocation(),                                   /input object required/);
  await assert.rejects(ps.bulkRenderForLocation({}),                                 /location_code/);
  await assert.rejects(ps.bulkRenderForLocation({ location_code: "WH", limit: 0 }),  /limit/);
  await assert.rejects(ps.bulkRenderForLocation({ location_code: "WH", limit: 9999 }), /limit/);
  await assert.rejects(ps.bulkRenderForLocation({ location_code: "WH", limit: 1.5 }), /limit/);
}

// ---- module run() export -----------------------------------------------

async function _runExportResolvesCleanly() {
  // Module-level `run()` is the framework-orchestrator lifecycle
  // hook — the primitive has no background workers, so the hook
  // resolves immediately with `{ ok: true }`.
  var moduleResult = await packingSlips.run();
  check("module run() resolves to { ok: true }", moduleResult && moduleResult.ok === true);

  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ps = packingSlips.create({ query: q, order: seed.order });
  var factoryResult = await ps.run();
  check("factory run() resolves to { ok: true }", factoryResult && factoryResult.ok === true);
}

async function run() {
  await _renderHtmlBasics();
  await _renderPdfPayloadPaperSize();
  await _renderHtmlLocaleSwitching();
  await _renderHtmlGiftMessageAndRecipientEscape();
  await _renderHtmlHidePricesStripsMonetaryColumns();
  await _recordPrintAndRetrieve();
  await _bulkRenderForLocationFifoAndLimit();
  await _validationRefusals();
  await _runExportResolvesCleanly();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/packing-slips.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — packing-slips (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — packing-slips: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
