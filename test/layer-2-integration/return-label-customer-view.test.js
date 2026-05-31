"use strict";
/**
 * Return-shipping labels — end-to-end HTTP integration of the READ-ONLY
 * customer surface: a shopper sees the carrier + tracking number, a
 * download affordance, and the carrier-scan timeline for a return whose
 * operator has issued a prepaid return label, on the return status detail
 * (/account/returns/:id) and the label-download redirect
 * (/account/returns/:id/label).
 *
 * Wired over ONE in-memory `node:sqlite` DB loaded from the live
 * migrations (returns + return_labels) so a label the operator issues is
 * the same row the customer reads. Issuance is an operator action — the
 * test calls returnLabels.issueLabel directly to set up state; the
 * storefront only surfaces it read-only.
 *
 * Asserts:
 *   - a return WITH an issued label shows the carrier, the tracking
 *     number, a Download-return-label link, the live status, and the
 *     carrier-scan timeline;
 *   - the download route 302-redirects to the carrier label asset;
 *   - a return with NO issued label shows the neutral "no label yet"
 *     state (no error), and its download route 404s (nothing to fetch);
 *   - a FOREIGN customer cannot view (404) nor download (404) another
 *     customer's return label — the IDOR / ownership defense;
 *   - an unknown / malformed return id 404s on both routes (no 500);
 *   - no body leaks a raw error / stack on any path.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
            "0206_orders_email_hash.sql", "0006_customers.sql",
            "0004_shop_config.sql", "0023_returns.sql", "0052_return_labels.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
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

// Seed a paid order with one line for `customerId`. Returns the order id +
// the order_line id (the return form keys the line by id).
async function _seedOrder(query, customerId, variantId, sku) {
  var now = Date.now();
  var cartId = b.uuid.v7(); var orderId = b.uuid.v7(); var lineId = b.uuid.v7();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, now, now + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 2999, 0, 0, 0, 2999, NULL, '{}', ?5, ?5)",
    [orderId, cartId, customerId, b.uuid.v7(), now],
  );
  await query(
    "INSERT INTO order_lines (id, order_id, variant_id, sku, qty, unit_amount_minor, unit_currency, line_total_minor) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 2999, 'USD', 2999)",
    [lineId, orderId, variantId, sku],
  );
  return { orderId: orderId, lineId: lineId };
}

function _noLeak(body) {
  body = body || "";
  return body.indexOf("at Object.") === -1 &&
         body.indexOf("TypeError") === -1 &&
         body.indexOf("    at ") === -1;
}

async function _run() {
  var query          = _makeQuery();
  var catalog        = bShop.catalog.create({ query: query });
  var cart           = bShop.cart.create({ query: query, catalog: catalog });
  var order          = bShop.order.create({ query: query, cursorSecret: "rl-order" });
  var config         = bShop.config.create({ query: query });
  var customers       = bShop.customers.create({ query: query });
  var returns        = bShop.returns.create({ query: query, cursorSecret: "rl-returns" });
  var returnLabels   = bShop.returnLabels.create({ query: query, returns: returns });

  var product  = await catalog.products.create({ slug: "tee", title: "Tee", description: "x", status: "active" });
  var variant  = await catalog.variants.create(product.id, { sku: "TEE-L", options: { size: "L" } });

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  var seeded   = await _seedOrder(query, buyer, variant.id, variant.sku);

  // A return WITH an issued label: request → approve → issueLabel →
  // mark-shipped → mark-in-transit (so the timeline has multiple scans).
  var requested = await returns.request({
    order_id:    seeded.orderId,
    customer_id: buyer,
    reason:      "defective",
    lines:       [{ order_line_id: seeded.lineId, sku: variant.sku, qty: 1 }],
  });
  var labelledReturnId = requested.id;
  await returns.approve(labelledReturnId, { refund_amount_minor: 2999, refund_currency: "USD", operator_notes: "ok" });
  var CARRIER_URL = "https://labels.example.com/return-abc123.pdf";
  var issued = await returnLabels.issueLabel({
    return_id:       labelledReturnId,
    // The carrier is operator-supplied and the primitive only bounds its
    // length (it does not reject HTML), so the customer renderer MUST escape
    // it — a carrier carrying markup must not execute on the shopper's page.
    carrier:         "USPS<script>alert(1)</script>",
    service_level:   "Ground Advantage",
    weight_grams:    340,
    label_url:       CARRIER_URL,
    tracking_number: "9400111202509876543210",
    cost_minor:      795,
    currency:        "USD",
  });
  await returnLabels.markShipped({ label_id: issued.id });
  await returnLabels.markInTransit({ label_id: issued.id, location: "LAX hub" });

  // A SECOND return for the same buyer with NO label issued — the neutral
  // "no label yet" state.
  var noLabelReq = await returns.request({
    order_id:    seeded.orderId,
    customer_id: buyer,
    reason:      "no-longer-needed",
    lines:       [{ order_line_id: seeded.lineId, sku: variant.sku, qty: 1 }],
  });
  var noLabelReturnId = noLabelReq.id;

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-rl-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers, config: config,
        returns: returns, returnLabels: returnLabels, shop_name: "Return Label Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- the labelled return's detail surfaces the label + tracking -----
    var detail = await helpers.httpRequest({ port: port, path: "/account/returns/" + labelledReturnId, jar: buyerJar });
    check("labelled return detail -> 200",         detail.status === 200);
    check("detail shows the carrier",              detail.body.indexOf("USPS") !== -1);
    check("detail ESCAPES the operator carrier (no stored XSS)",
      detail.body.indexOf("<script>alert(1)</script>") === -1 &&
      detail.body.indexOf("&lt;script&gt;alert(1)&lt;/script&gt;") !== -1);
    check("detail shows the tracking number",      detail.body.indexOf("9400111202509876543210") !== -1);
    check("detail offers a download link",         detail.body.indexOf("/account/returns/" + labelledReturnId + "/label") !== -1);
    check("detail shows the live status",          detail.body.indexOf("On its way back") !== -1);
    check("detail shows a tracking timeline",      detail.body.indexOf("Label issued") !== -1 && detail.body.indexOf("In transit") !== -1);
    check("detail shows a scan location",          detail.body.indexOf("LAX hub") !== -1);
    check("detail does not leak the raw url",       detail.body.indexOf(CARRIER_URL) === -1);
    check("detail leaks no raw error",             _noLeak(detail.body));

    // ---- the download route redirects to the carrier asset -------------
    var dl = await helpers.httpRequest({ port: port, path: "/account/returns/" + labelledReturnId + "/label", jar: buyerJar });
    check("label download -> 302",                 dl.status === 302);
    check("download redirects to the carrier url", (dl.headers["location"] || "") === CARRIER_URL);
    check("download is private/no-store",          (dl.headers["cache-control"] || "").indexOf("no-store") !== -1);

    // ---- the no-label return shows the neutral state -------------------
    var neutral = await helpers.httpRequest({ port: port, path: "/account/returns/" + noLabelReturnId, jar: buyerJar });
    check("no-label return detail -> 200",         neutral.status === 200);
    check("no-label shows the neutral state",      neutral.body.indexOf("No label yet") !== -1);
    check("no-label offers no download link",      neutral.body.indexOf("/account/returns/" + noLabelReturnId + "/label") === -1);
    check("no-label leaks no raw error",           _noLeak(neutral.body));

    // …and its download route 404s (nothing to fetch yet).
    var neutralDl = await helpers.httpRequest({ port: port, path: "/account/returns/" + noLabelReturnId + "/label", jar: buyerJar });
    check("no-label download -> 404",              neutralDl.status === 404);
    check("no-label download leaks no raw error",  _noLeak(neutralDl.body));

    // ---- the list links each return to its detail ----------------------
    var list = await helpers.httpRequest({ port: port, path: "/account/returns", jar: buyerJar });
    check("returns list -> 200",                   list.status === 200);
    check("list links the labelled return detail", list.body.indexOf("/account/returns/" + labelledReturnId) !== -1);

    // ---- IDOR: a FOREIGN customer can't view nor download --------------
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });

    var foreignView = await helpers.httpRequest({ port: port, path: "/account/returns/" + labelledReturnId, jar: strangerJar });
    check("foreign return view -> 404",            foreignView.status === 404);
    check("foreign view leaks no raw error",       _noLeak(foreignView.body));

    var foreignDl = await helpers.httpRequest({ port: port, path: "/account/returns/" + labelledReturnId + "/label", jar: strangerJar });
    check("foreign label download -> 404",         foreignDl.status === 404);
    check("foreign download exposes no carrier url", (foreignDl.headers["location"] || "") === "" && foreignDl.body.indexOf(CARRIER_URL) === -1);
    check("foreign download leaks no raw error",   _noLeak(foreignDl.body));

    // ---- unknown / malformed return ids 404 on both routes -------------
    var bogus = "00000000-0000-7000-8000-000000000000";
    var unknownView = await helpers.httpRequest({ port: port, path: "/account/returns/" + bogus, jar: buyerJar });
    check("unknown return view -> 404",            unknownView.status === 404);
    check("unknown view leaks no raw error",       _noLeak(unknownView.body));

    var unknownDl = await helpers.httpRequest({ port: port, path: "/account/returns/" + bogus + "/label", jar: buyerJar });
    check("unknown label download -> 404",         unknownDl.status === 404);

    var malformedView = await helpers.httpRequest({ port: port, path: "/account/returns/not-a-uuid", jar: buyerJar });
    check("malformed return view -> 404",          malformedView.status === 404);
    check("malformed view is not a 500",           malformedView.status !== 500);
    check("malformed view leaks no raw error",     _noLeak(malformedView.body));

    var malformedDl = await helpers.httpRequest({ port: port, path: "/account/returns/not-a-uuid/label", jar: buyerJar });
    check("malformed label download -> 404",       malformedDl.status === 404);
    check("malformed download is not a 500",       malformedDl.status !== 500);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };

// Allow direct invocation.
if (require.main === module) {
  _run().then(function () {
    console.log("OK — return-label-customer-view (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — return-label-customer-view: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
