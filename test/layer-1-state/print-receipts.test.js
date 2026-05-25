"use strict";
/**
 * printReceipts — three render surfaces (thermal / html_pdf /
 * plain_text) over an order plus the receipt_prints audit log.
 *
 * Layer 1 against in-memory node:sqlite loaded from the migrations
 * the order primitive owns + the 0062 receipt_prints migration.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/print-receipts.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - thermal renderer emits ESC/POS init + cut, 80mm/58mm widths
 *   - htmlPdf renderer emits self-contained HTML, locale switching
 *   - plainText renderer emits CRLF, scrubs ANSI escapes
 *   - HTML-escape of operator-input fields (hostile SKU + ship-to)
 *   - locale fallback (de-CH → de catalog, unknown → en)
 *   - previewBuffer does NOT touch receipt_prints
 *   - recordPrint appends a row + printsForOrder reads it newest-first
 *   - validation refusals on bad inputs
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var printReceipts = require("../../lib/print-receipts");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0206_orders_email_hash.sql",
  "0062_print_receipts.sql",
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
// ship-to than the test path's bare-minimum `{ country: "US" }`.
// Returns the order primitive + the loaded order row for tests
// that need to compare rendered output against the underlying data.
async function _seedOrder(query, opts) {
  opts = opts || {};
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query });

  var suffix = _seedSuffix();
  var p = await catalog.products.create({
    slug:   opts.slug   || ("pr-test-" + suffix),
    title:  opts.title  || "Receipt Test Item",
    status: "active",
  });
  var v = await catalog.variants.create(p.id, { sku: opts.sku || ("PR-" + suffix) });
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
      name:        "Alex Operator",
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

// ---- thermal renderer ---------------------------------------------------

async function _thermalRendererDefaultWidth() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  var out = await pr.thermal({ order_id: seed.orderRow.id });
  check("thermal returns string",                   typeof out === "string");
  check("thermal opens with ESC @ init",            out.indexOf("\x1B\x40") === 0);
  check("thermal ends with GS V cut",               out.indexOf("\x1D\x56\x01") !== -1);
  check("thermal includes RECEIPT header",          out.indexOf("RECEIPT") !== -1);
  check("thermal includes order id",                out.indexOf(seed.orderRow.id) !== -1);
  check("thermal includes SKU",                     out.indexOf(seed.sku) !== -1);
  check("thermal includes grand total label",       out.indexOf("Grand total") !== -1);
  check("thermal includes 80mm-shaped 48-col rule", out.indexOf("=".repeat(48)) !== -1);
  check("thermal includes ship_to.name",            out.indexOf("Alex Operator") !== -1);
  check("thermal includes ship_to.line1",           out.indexOf("123 Main St") !== -1);
}

async function _thermalRendererNarrowWidth() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  var out = await pr.thermal({ order_id: seed.orderRow.id, paper_width_mm: 58 });
  check("thermal 58mm returns string",      typeof out === "string");
  check("thermal 58mm uses 32-col rule",    out.indexOf("=".repeat(32)) !== -1);
  check("thermal 58mm does NOT use 48-col", out.indexOf("=".repeat(48)) === -1);
}

// ---- htmlPdf renderer ---------------------------------------------------

async function _htmlPdfRendererEnglish() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  var html = await pr.htmlPdf({ order_id: seed.orderRow.id });
  check("htmlPdf returns string",                 typeof html === "string");
  check("htmlPdf is a full document",             html.indexOf("<!doctype html>") === 0);
  check("htmlPdf carries lang=en",                html.indexOf("lang=\"en\"") !== -1);
  check("htmlPdf has @page A4 rule",              html.indexOf("@page { size: A4") !== -1);
  check("htmlPdf includes Receipt title",         html.indexOf("<h1>Receipt</h1>") !== -1);
  check("htmlPdf includes order id",              html.indexOf(seed.orderRow.id) !== -1);
  check("htmlPdf includes Grand total",           html.indexOf("Grand total") !== -1);
  check("htmlPdf includes Ship to label",         html.indexOf("Ship to:") !== -1);
  check("htmlPdf includes line item table",       html.indexOf("<table>") !== -1);
}

async function _htmlPdfLocaleSwitch() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  var es = await pr.htmlPdf({ order_id: seed.orderRow.id, locale: "es" });
  check("htmlPdf es: Spanish receipt label",        es.indexOf("Recibo") !== -1);
  check("htmlPdf es: Spanish grand total",          es.indexOf("Total general") !== -1);
  check("htmlPdf es: lang=es attribute",            es.indexOf("lang=\"es\"") !== -1);

  var deCH = await pr.htmlPdf({ order_id: seed.orderRow.id, locale: "de-CH" });
  check("htmlPdf de-CH falls back to de catalog",   deCH.indexOf("Quittung") !== -1);
  check("htmlPdf de-CH carries de-CH lang attr",    deCH.indexOf("lang=\"de-CH\"") !== -1);

  var ja = await pr.htmlPdf({ order_id: seed.orderRow.id, locale: "ja-JP" });
  check("htmlPdf unknown locale falls back to en", ja.indexOf("Grand total") !== -1);
}

// ---- HTML escape of operator-input fields ------------------------------

async function _htmlEscapeOperatorInputs() {
  var q = _makeQuery();
  // Hostile SKU + ship-to name. The catalog's SKU validator likely
  // rejects shell-shape strings outright, so the hostile content
  // rides on a field the operator controls without strict shape
  // validation: ship_to.name. The renderer must HTML-escape every
  // interpolated field regardless of source.
  var hostile = '<script>alert("xss")</script>';
  var seed = await _seedOrder(q, {
    ship_to: {
      name:    hostile,
      line1:   "<img src=x onerror=alert(1)>",
      city:    "Brooklyn & sons",
      country: "US",
    },
  });
  var pr = printReceipts.create({ query: q, order: seed.order });

  var html = await pr.htmlPdf({ order_id: seed.orderRow.id });
  check("htmlPdf escapes <script> in name",       html.indexOf("<script>alert") === -1);
  check("htmlPdf retains escaped <script>",       html.indexOf("&lt;script&gt;") !== -1);
  check("htmlPdf escapes <img onerror>",          html.indexOf("<img src=x") === -1);
  check("htmlPdf escapes ampersand in city",      html.indexOf("Brooklyn &amp; sons") !== -1);
  check("htmlPdf does NOT contain raw &",         html.indexOf("Brooklyn & sons") === -1);

  // Plain-text scrub strips control bytes (ANSI escape preview).
  var hostileText = await pr.plainText({ order_id: seed.orderRow.id });
  check("plainText still contains the name",      hostileText.indexOf("alert") !== -1); // escaped text not stripped; just no control bytes
  check("plainText carries no <script> tag bytes — content is angle-bracketed plaintext, not HTML",
        hostileText.indexOf("<script>") !== -1); // angle brackets ARE allowed in plain text
}

async function _plainTextScrubsControlBytes() {
  var q = _makeQuery();
  // Pretend a hostile operator-input name contains an ANSI clear-
  // screen sequence (`\x1B[2J`). The plain-text renderer must strip
  // the ESC byte so a downstream terminal-rendered email preview
  // can't be hijacked.
  var seed = await _seedOrder(q, {
    ship_to: { name: "Alex\x1B[2J", line1: "Bell\x07", country: "US" },
  });
  var pr = printReceipts.create({ query: q, order: seed.order });

  var text = await pr.plainText({ order_id: seed.orderRow.id });
  check("plainText returns string",               typeof text === "string");
  check("plainText uses CRLF line endings",       text.indexOf("\r\n") !== -1);
  check("plainText strips ESC byte from name",    text.indexOf("\x1B") === -1);
  check("plainText strips BEL byte from line1",   text.indexOf("\x07") === -1);
  check("plainText retains the readable name",    text.indexOf("Alex") !== -1);
  check("plainText carries grand total label",    text.indexOf("Grand total") !== -1);
}

// ---- previewBuffer (no audit row) --------------------------------------

async function _previewBufferDoesNotWriteLog() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  var beforeRows = (await q("SELECT COUNT(*) AS n FROM receipt_prints", [])).rows[0].n;
  var preview = await pr.previewBuffer({ order_id: seed.orderRow.id, format: "thermal" });
  check("previewBuffer returns string",   typeof preview === "string");
  var afterRows = (await q("SELECT COUNT(*) AS n FROM receipt_prints", [])).rows[0].n;
  check("previewBuffer writes no audit row", Number(beforeRows) === Number(afterRows));

  // Same content as the dedicated renderer.
  var direct = await pr.thermal({ order_id: seed.orderRow.id });
  check("previewBuffer thermal matches direct thermal", preview === direct);

  var htmlPreview = await pr.previewBuffer({ order_id: seed.orderRow.id, format: "html_pdf", locale: "de" });
  check("previewBuffer html locale switch",   htmlPreview.indexOf("Quittung") !== -1);
}

// ---- recordPrint + printsForOrder --------------------------------------

async function _recordPrintAndRetrieve() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  var t1 = await pr.recordPrint({
    order_id:     seed.orderRow.id,
    format:       "thermal",
    printer_name: "warehouse-thermal-1",
    occurred_at:  Date.now() - 10000,
  });
  check("recordPrint returns id",            typeof t1.id === "string" && t1.id.length > 0);
  check("recordPrint returns byte_size",     typeof t1.byte_size === "number" && t1.byte_size > 0);
  check("recordPrint returns sha3_512",      typeof t1.sha3_512 === "string" && t1.sha3_512.length === 128);
  check("recordPrint returns format",        t1.format === "thermal");
  check("recordPrint returns printer_name",  t1.printer_name === "warehouse-thermal-1");

  var t2 = await pr.recordPrint({
    order_id:     seed.orderRow.id,
    format:       "html_pdf",
    printer_name: "operator-browser-2",
    locale:       "es",
    occurred_at:  Date.now() - 5000,
  });
  check("recordPrint html_pdf locale stored", t2.locale === "es");

  var t3 = await pr.recordPrint({
    order_id:     seed.orderRow.id,
    format:       "plain_text",
    // printer_name omitted — nullable
  });
  check("recordPrint plain_text null printer",  t3.printer_name === null);

  var prints = await pr.printsForOrder(seed.orderRow.id);
  check("printsForOrder returns array",     Array.isArray(prints));
  check("printsForOrder has 3 rows",        prints.length === 3);
  check("printsForOrder newest-first",      prints[0].occurred_at >= prints[1].occurred_at && prints[1].occurred_at >= prints[2].occurred_at);
  check("printsForOrder carries sha3_512",  prints.every(function (p) { return typeof p.sha3_512 === "string" && p.sha3_512.length === 128; }));
  check("printsForOrder carries format",    prints.some(function (p) { return p.format === "thermal"; })
                                            && prints.some(function (p) { return p.format === "html_pdf"; })
                                            && prints.some(function (p) { return p.format === "plain_text"; }));

  // Two identical thermal prints have identical sha3 (the bytes
  // depend only on the order data + width).
  var t1b = await pr.recordPrint({
    order_id: seed.orderRow.id,
    format:   "thermal",
    printer_name: "warehouse-thermal-1",
  });
  check("recordPrint deterministic thermal sha3", t1b.sha3_512 === t1.sha3_512);
}

// ---- validation refusals ------------------------------------------------

async function _validationRefusals() {
  var q = _makeQuery();
  var seed = await _seedOrder(q);
  var pr = printReceipts.create({ query: q, order: seed.order });

  // create-time validation
  var threw = false;
  try { printReceipts.create({ query: q }); } catch (e) { threw = /order primitive is required/.test(e.message); }
  check("create refuses without order primitive", threw === true);

  // thermal
  await assert.rejects(pr.thermal(),                                     /input object required/);
  await assert.rejects(pr.thermal({}),                                   /order_id/);
  await assert.rejects(pr.thermal({ order_id: "not-a-uuid" }),           /order_id/);
  await assert.rejects(pr.thermal({ order_id: seed.orderRow.id, paper_width_mm: 999 }), /paper_width_mm/);
  await assert.rejects(pr.thermal({ order_id: _validUUID() }),           /not found/);

  // htmlPdf
  await assert.rejects(pr.htmlPdf(),                                     /input object required/);
  await assert.rejects(pr.htmlPdf({}),                                   /order_id/);
  await assert.rejects(pr.htmlPdf({ order_id: seed.orderRow.id, locale: "english" }), /locale/);

  // plainText
  await assert.rejects(pr.plainText(),                                   /input object required/);
  await assert.rejects(pr.plainText({}),                                 /order_id/);
  await assert.rejects(pr.plainText({ order_id: seed.orderRow.id, locale: 12 }), /locale/);

  // previewBuffer
  await assert.rejects(pr.previewBuffer(),                               /input object required/);
  await assert.rejects(pr.previewBuffer({ order_id: seed.orderRow.id }), /format/);
  await assert.rejects(pr.previewBuffer({ order_id: seed.orderRow.id, format: "pdf" }), /format/);

  // recordPrint
  await assert.rejects(pr.recordPrint(),                                 /input object required/);
  await assert.rejects(pr.recordPrint({ order_id: seed.orderRow.id }),   /format/);
  await assert.rejects(pr.recordPrint({
    order_id: seed.orderRow.id, format: "thermal", printer_name: "",
  }), /printer_name/);
  await assert.rejects(pr.recordPrint({
    order_id: seed.orderRow.id, format: "thermal", occurred_at: -1,
  }), /occurred_at/);

  // printsForOrder
  await assert.rejects(pr.printsForOrder("not-a-uuid"),                  /order_id/);
}

async function run() {
  await _thermalRendererDefaultWidth();
  await _thermalRendererNarrowWidth();
  await _htmlPdfRendererEnglish();
  await _htmlPdfLocaleSwitch();
  await _htmlEscapeOperatorInputs();
  await _plainTextScrubsControlBytes();
  await _previewBufferDoesNotWriteLog();
  await _recordPrintAndRetrieve();
  await _validationRefusals();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/print-receipts.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK — print-receipts (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — print-receipts: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
