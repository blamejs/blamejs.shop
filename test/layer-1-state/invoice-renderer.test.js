"use strict";
/**
 * invoiceRenderer — formal accounting invoice render surface plus
 * the sequential invoice-number minter + audit log.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * the order primitive owns + the 0093 invoice-renderer migration +
 * the 0004 shop_config migration (the issuer block reads from
 * shop_config).
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/invoice-renderer.js` directly so the gate exists ahead of
 * the entry-point edit.
 *
 * Coverage:
 *   - nextInvoiceNumber mints sequential `INV-YYYY-NNNNNN`
 *   - independent counters per series
 *   - renderHtml emits self-contained HTML with operator + customer
 *     addresses, tax breakdown, payment terms, due date
 *   - HTML-escapes operator + customer-input fields (hostile ship-to)
 *   - locale switching (en / es / de) + de-CH falls back to de catalog
 *   - recordInvoice + invoicesForOrder round-trip
 *   - getInvoiceByNumber lookup
 *   - duplicate invoice_number write refuses with a readable error
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var invoiceRenderer  = require("../../lib/invoice-renderer");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql",
  "0093_invoice_renderer.sql",
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

var _seedCounter = 0;
function _seedSuffix() { _seedCounter += 1; return String(_seedCounter); }

async function _seedOrder(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });

  var suffix = _seedSuffix();
  var p = await catalog.products.create({
    slug:   opts.slug   || ("inv-test-" + suffix),
    title:  opts.title  || "Invoice Test Item",
    status: "active",
  });
  var v = await catalog.variants.create(p.id, { sku: opts.sku || ("INV-" + suffix) });
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
      name:        "Casey Buyer",
      line1:       "742 Evergreen Terrace",
      city:        "Springfield",
      region:      "OR",
      postal_code: "97477",
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

// Seed the operator (issuer) shop_config block. Optional — when not
// called, the renderer still works but the From block is empty.
async function _seedIssuer(query) {
  await query(
    "INSERT INTO shop_config (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
    ["invoice.issuer_name", JSON.stringify("Acme Shop LLC"), Date.now()],
  );
  await query(
    "INSERT INTO shop_config (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
    ["invoice.issuer_address_lines", JSON.stringify([
      "1 Industrial Way",
      "Brooklyn, NY 11201",
      "USA",
    ]), Date.now()],
  );
  await query(
    "INSERT INTO shop_config (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
    ["invoice.issuer_tax_id", JSON.stringify("EIN 12-3456789"), Date.now()],
  );
}

// ---- nextInvoiceNumber: sequential per-series ---------------------------

async function _sequentialDefaultSeries() {
  var q = _makeQuery();
  var ir = invoiceRenderer.create({ query: q, order: bShop.order.create({ query: q }) });

  var n1 = await ir.nextInvoiceNumber();
  var n2 = await ir.nextInvoiceNumber();
  var n3 = await ir.nextInvoiceNumber();

  check("nextInvoiceNumber returns object",   n1 && typeof n1 === "object");
  check("nextInvoiceNumber carries series",   n1.series === "DEFAULT");
  check("nextInvoiceNumber carries sequence", n1.sequence === 1);
  check("nextInvoiceNumber advances",         n2.sequence === 2 && n3.sequence === 3);

  // Shape: INV-YYYY-NNNNNN with 6-digit zero-padded sequence.
  var re = /^INV-\d{4}-\d{6}$/;
  check("nextInvoiceNumber shape matches INV-YYYY-NNNNNN", re.test(n1.invoice_number));
  check("nextInvoiceNumber zero-pads to 6 digits",         /-000001$/.test(n1.invoice_number));
  check("nextInvoiceNumber three increments distinct",     n1.invoice_number !== n2.invoice_number && n2.invoice_number !== n3.invoice_number);
}

async function _perSeriesIndependentCounters() {
  var q = _makeQuery();
  var ir = invoiceRenderer.create({ query: q, order: bShop.order.create({ query: q }) });

  var d1 = await ir.nextInvoiceNumber({ series: "DEFAULT" });
  var d2 = await ir.nextInvoiceNumber({ series: "DEFAULT" });
  var eu1 = await ir.nextInvoiceNumber({ series: "EU" });
  var d3 = await ir.nextInvoiceNumber({ series: "DEFAULT" });
  var eu2 = await ir.nextInvoiceNumber({ series: "EU" });

  check("DEFAULT series counts independently", d1.sequence === 1 && d2.sequence === 2 && d3.sequence === 3);
  check("EU series counts independently",      eu1.sequence === 1 && eu2.sequence === 2);
  check("EU series tagged",                    eu1.series === "EU");
  check("EU series invoice_number reflects sequence", /-000001$/.test(eu1.invoice_number));
}

// ---- renderHtml ---------------------------------------------------------

async function _renderHtmlBasics() {
  var q = _makeQuery();
  await _seedIssuer(q);
  var seed = await _seedOrder(q);
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  var r = await ir.renderHtml({ order_id: seed.orderRow.id });
  check("renderHtml returns object",                  r && typeof r === "object");
  check("renderHtml returns html string",             typeof r.html === "string" && r.html.length > 0);
  check("renderHtml minted invoice_number",           /^INV-\d{4}-\d{6}$/.test(r.invoice_number));
  check("renderHtml default series=DEFAULT",          r.series === "DEFAULT");
  check("renderHtml default due_days=30",             r.due_days === 30);
  check("renderHtml due_at is ~30 days out",          r.due_at - r.generated_at >= 29 * 24 * 60 * 60 * 1000);

  var html = r.html;
  check("html is a full document",          html.indexOf("<!doctype html>") === 0);
  check("html carries lang=en",             html.indexOf("lang=\"en\"") !== -1);
  check("html has @page A4 rule",           html.indexOf("@page { size: A4") !== -1);
  check("html title includes Invoice",      html.indexOf("<h1>Invoice</h1>") !== -1);
  check("html includes Invoice no. label",  html.indexOf("Invoice no.") !== -1);
  check("html includes invoice_number",     html.indexOf(r.invoice_number) !== -1);
  check("html includes Issued label",       html.indexOf("Issued") !== -1);
  check("html includes Due label",          html.indexOf("Due") !== -1);
  check("html includes Bill to label",      html.indexOf("Bill to") !== -1);
  check("html includes From label",         html.indexOf("From") !== -1);
  check("html includes Grand total",        html.indexOf("Grand total") !== -1);
  check("html includes Tax row",            html.indexOf("Tax") !== -1);
  check("html includes Payment terms",      html.indexOf("Payment terms") !== -1);
  check("html includes Net 30 terms",       html.indexOf("Net 30") !== -1);
  check("html includes issuer name",        html.indexOf("Acme Shop LLC") !== -1);
  check("html includes issuer address",     html.indexOf("1 Industrial Way") !== -1);
  check("html includes issuer tax id",      html.indexOf("EIN 12-3456789") !== -1);
  check("html includes customer name",      html.indexOf("Casey Buyer") !== -1);
  check("html includes customer address",   html.indexOf("742 Evergreen Terrace") !== -1);
  check("html includes line item SKU",      html.indexOf(seed.sku) !== -1);
}

async function _renderHtmlCustomDueDaysAndSeries() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  var r = await ir.renderHtml({ order_id: seed.orderRow.id, due_days: 14, series: "EU" });
  check("renderHtml respects due_days=14",  r.due_days === 14);
  check("renderHtml respects series=EU",    r.series === "EU");
  check("renderHtml html shows Net 14",     r.html.indexOf("Net 14") !== -1);

  // due_days=0 — invoice payable on issue.
  var r0 = await ir.renderHtml({ order_id: seed.orderRow.id, due_days: 0 });
  check("renderHtml due_days=0 allowed",    r0.due_days === 0);
  check("renderHtml due_days=0 shows Net 0", r0.html.indexOf("Net 0") !== -1);
}

async function _renderHtmlLocaleSwitching() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  var es = await ir.renderHtml({ order_id: seed.orderRow.id, locale: "es" });
  check("es: Spanish Invoice label",       es.html.indexOf("Factura") !== -1);
  check("es: Spanish grand total label",   es.html.indexOf("Total general") !== -1);
  check("es: Spanish payment terms",       es.html.indexOf("Condiciones de pago") !== -1);
  check("es: lang=es attribute",           es.html.indexOf("lang=\"es\"") !== -1);

  var deCH = await ir.renderHtml({ order_id: seed.orderRow.id, locale: "de-CH" });
  check("de-CH falls back to de catalog",  deCH.html.indexOf("Rechnung") !== -1);
  check("de-CH carries de-CH lang attr",   deCH.html.indexOf("lang=\"de-CH\"") !== -1);
  check("de: German payment terms",        deCH.html.indexOf("Zahlungsbedingungen") !== -1);

  var ja = await ir.renderHtml({ order_id: seed.orderRow.id, locale: "ja-JP" });
  check("unknown locale falls back to en", ja.html.indexOf("Grand total") !== -1);
}

// ---- HTML escape of operator + customer-input fields -------------------

async function _htmlEscapeHostileInput() {
  var q = _makeQuery();
  var hostile = '<script>alert("xss")</script>';
  // Hostile issuer name via shop_config (operator's own input field).
  await q(
    "INSERT INTO shop_config (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
    ["invoice.issuer_name", JSON.stringify(hostile), Date.now()],
  );
  await q(
    "INSERT INTO shop_config (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
    ["invoice.issuer_address_lines", JSON.stringify(["Line & Co", "<b>bold</b>"]), Date.now()],
  );
  // Hostile customer-input via ship_to.name + city (with ampersand).
  var seed = await _seedOrder(q, {
    ship_to: {
      name:    "<img src=x onerror=alert(1)>",
      line1:   "Evil & Co",
      city:    "Brooklyn & sons",
      country: "US",
    },
  });
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  var r = await ir.renderHtml({ order_id: seed.orderRow.id });
  check("escapes <script> in issuer name",     r.html.indexOf("<script>alert") === -1);
  check("retains escaped <script>",            r.html.indexOf("&lt;script&gt;") !== -1);
  check("escapes <img onerror> in ship name",  r.html.indexOf("<img src=x") === -1);
  check("escapes ampersand in city",           r.html.indexOf("Brooklyn &amp; sons") !== -1);
  check("does NOT contain raw ampersand pair", r.html.indexOf("Brooklyn & sons") === -1);
  check("escapes <b> in issuer address",       r.html.indexOf("<b>bold</b>") === -1);
  check("retains escaped <b> entity",          r.html.indexOf("&lt;b&gt;bold") !== -1);
}

// ---- recordInvoice + invoicesForOrder ----------------------------------

async function _recordAndRetrieve() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  // First render + mint number + record audit row.
  var r1 = await ir.renderHtml({ order_id: seed.orderRow.id });
  var bytes1 = Buffer.from(r1.html, "utf8");
  var sha1 = bShop.framework.crypto.sha3Hash(bytes1);
  var rec1 = await ir.recordInvoice({
    order_id:       seed.orderRow.id,
    invoice_number: r1.invoice_number,
    html_size:      bytes1.length,
    sha3_512:       sha1,
  });
  check("recordInvoice returns id",            typeof rec1.id === "string" && rec1.id.length > 0);
  check("recordInvoice preserves order_id",    rec1.order_id === seed.orderRow.id);
  check("recordInvoice preserves invoice_no",  rec1.invoice_number === r1.invoice_number);
  check("recordInvoice preserves html_size",   rec1.html_size === bytes1.length);
  check("recordInvoice preserves sha3_512",    rec1.sha3_512 === sha1);
  check("recordInvoice sha3 is 128 hex",       typeof rec1.sha3_512 === "string" && rec1.sha3_512.length === 128);

  // Second invoice on same order — sequence advances.
  var r2 = await ir.renderHtml({ order_id: seed.orderRow.id });
  check("second render mints next number",     r2.invoice_number !== r1.invoice_number);
  var bytes2 = Buffer.from(r2.html, "utf8");
  var sha2 = bShop.framework.crypto.sha3Hash(bytes2);
  var rec2 = await ir.recordInvoice({
    order_id:       seed.orderRow.id,
    invoice_number: r2.invoice_number,
    html_size:      bytes2.length,
    sha3_512:       sha2,
  });

  var invoices = await ir.invoicesForOrder(seed.orderRow.id);
  check("invoicesForOrder returns array",      Array.isArray(invoices));
  check("invoicesForOrder has 2 rows",         invoices.length === 2);
  check("invoicesForOrder newest-first",       invoices[0].generated_at >= invoices[1].generated_at);
  check("invoicesForOrder carries invoice_no", invoices.some(function (i) { return i.invoice_number === r1.invoice_number; }) &&
                                               invoices.some(function (i) { return i.invoice_number === r2.invoice_number; }));
  check("invoicesForOrder carries html_size",  invoices.every(function (i) { return typeof i.html_size === "number" && i.html_size > 0; }));
  check("invoicesForOrder carries sha3_512",   invoices.every(function (i) { return typeof i.sha3_512 === "string" && i.sha3_512.length === 128; }));

  // Duplicate invoice_number write refuses (UNIQUE constraint).
  var dupThrew = false;
  try {
    await ir.recordInvoice({
      order_id:       seed.orderRow.id,
      invoice_number: r1.invoice_number,
      html_size:      bytes1.length,
      sha3_512:       sha1,
    });
  } catch (e) { dupThrew = /already recorded/.test(e.message); }
  check("recordInvoice refuses duplicate invoice_number", dupThrew === true);

  // Reference rec2 to keep eslint quiet about the unused binding.
  check("rec2 returned an id",                 typeof rec2.id === "string" && rec2.id.length > 0);
}

// ---- getInvoiceByNumber -------------------------------------------------

async function _getInvoiceByNumberLookup() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  var r = await ir.renderHtml({ order_id: seed.orderRow.id });
  var bytes = Buffer.from(r.html, "utf8");
  var sha = bShop.framework.crypto.sha3Hash(bytes);
  await ir.recordInvoice({
    order_id:       seed.orderRow.id,
    invoice_number: r.invoice_number,
    html_size:      bytes.length,
    sha3_512:       sha,
  });

  var found = await ir.getInvoiceByNumber(r.invoice_number);
  check("getInvoiceByNumber found",            found !== null && typeof found === "object");
  check("getInvoiceByNumber carries order_id", found.order_id === seed.orderRow.id);
  check("getInvoiceByNumber carries sha3",     found.sha3_512 === sha);
  check("getInvoiceByNumber carries size",     found.html_size === bytes.length);

  var missing = await ir.getInvoiceByNumber("INV-1999-999999");
  check("getInvoiceByNumber missing → null",   missing === null);
}

// ---- validation refusals ------------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var ir = invoiceRenderer.create({ query: q, order: seed.order });

  // create-time validation
  var threw = false;
  try { invoiceRenderer.create({ query: q }); } catch (e) { threw = /order primitive is required/.test(e.message); }
  check("create refuses without order primitive", threw === true);

  // nextInvoiceNumber
  await assert.rejects(ir.nextInvoiceNumber({ series: "bad series!" }), /series/);
  await assert.rejects(ir.nextInvoiceNumber({ series: 12 }),            /series/);

  // renderHtml
  await assert.rejects(ir.renderHtml(),                                              /input object required/);
  await assert.rejects(ir.renderHtml({}),                                            /order_id/);
  await assert.rejects(ir.renderHtml({ order_id: "not-a-uuid" }),                    /order_id/);
  await assert.rejects(ir.renderHtml({ order_id: _validUUID() }),                    /not found/);
  await assert.rejects(ir.renderHtml({ order_id: seed.orderRow.id, locale: "english" }), /locale/);
  await assert.rejects(ir.renderHtml({ order_id: seed.orderRow.id, due_days: -1 }),  /due_days/);
  await assert.rejects(ir.renderHtml({ order_id: seed.orderRow.id, due_days: 999 }), /due_days/);
  await assert.rejects(ir.renderHtml({ order_id: seed.orderRow.id, due_days: 1.5 }), /due_days/);
  await assert.rejects(ir.renderHtml({ order_id: seed.orderRow.id, series: "" }),    /series/);

  // recordInvoice
  await assert.rejects(ir.recordInvoice(),                                           /input object required/);
  await assert.rejects(ir.recordInvoice({}),                                         /order_id/);
  await assert.rejects(ir.recordInvoice({
    order_id: seed.orderRow.id,
  }),                                                                                /invoice_number/);
  await assert.rejects(ir.recordInvoice({
    order_id: seed.orderRow.id, invoice_number: "X",
  }),                                                                                /html_size/);
  await assert.rejects(ir.recordInvoice({
    order_id: seed.orderRow.id, invoice_number: "X", html_size: 100,
  }),                                                                                /sha3_512/);
  await assert.rejects(ir.recordInvoice({
    order_id: seed.orderRow.id, invoice_number: "X", html_size: 100, sha3_512: "short",
  }),                                                                                /sha3_512/);
  await assert.rejects(ir.recordInvoice({
    order_id: seed.orderRow.id, invoice_number: "", html_size: 100,
    sha3_512: "a".repeat(128),
  }),                                                                                /invoice_number/);

  // invoicesForOrder
  await assert.rejects(ir.invoicesForOrder("not-a-uuid"),                            /order_id/);

  // getInvoiceByNumber
  await assert.rejects(ir.getInvoiceByNumber(""),                                    /invoice_number/);
  await assert.rejects(ir.getInvoiceByNumber(123),                                   /invoice_number/);
}

async function run() {
  await _sequentialDefaultSeries();
  await _perSeriesIndependentCounters();
  await _renderHtmlBasics();
  await _renderHtmlCustomDueDaysAndSeries();
  await _renderHtmlLocaleSwitching();
  await _htmlEscapeHostileInput();
  await _recordAndRetrieve();
  await _getInvoiceByNumberLookup();
  await _validationRefusals();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/invoice-renderer.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — invoice-renderer (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — invoice-renderer: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
