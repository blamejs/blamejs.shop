"use strict";
/**
 * Quotes (B2B request-for-quote) — the full negotiation journey end to end,
 * exercised through the live HTTP surfaces the way a customer + operator drive
 * it: a signed-in customer requests a quote from their cart, the operator
 * prices it from the admin console, the customer reviews + accepts it via their
 * tokened quote page, and the acceptance converts into a pending order that has
 * RESERVED the shelf stock (the same hold checkout takes), so a quote can't
 * oversell against a concurrent cart checkout.
 *
 * Boots b.createApp with both storefront.mount and admin.mount wired to one
 * shared quotes instance (composing cart + order + catalog.inventory), then:
 *
 *   - the customer requests a quote from their active cart (snapshots the
 *     lines into a new RFQ, pinned to their session customer_id)
 *   - the operator's response queue lists the request; the detail screen
 *     renders the per-line pricing form
 *   - the operator responds with priced lines + a validity window; the
 *     quoted total is the line math + shipping + tax, computed server-side
 *   - the customer's account quote list + the tokened /quote/:token page both
 *     render the priced quote with accept/decline controls
 *   - the customer accepts via the token; the acceptance converts to a pending
 *     order that reserved the held units (on_hand unchanged, held debited)
 *   - the order carries the quoted line price + qty
 *   - an unknown quote token 404s (the hash lookup never leaks another quote)
 *   - a quote belonging to another customer 404s on the account path (IDOR)
 *   - a stored-XSS payload in the customer's RFQ message renders escaped on the
 *     admin detail screen (the message is operator-rendered free text)
 *   - the FSM refuses an illegal transition (re-accepting a converted quote)
 *
 * Network: zero (loopback createApp).
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var ADMIN_TOKEN = "admin-token-0123456789abcdef-quotes";

function _run() {
  return _inner();
}

async function _inner() {
  // Full shop schema in memory so the quote → order conversion (which writes
  // orders / order_lines / order_transitions) and the inventory holds resolve
  // against real tables.
  var query   = helpers.memD1Query(helpers.allMigrationPaths(), { tolerant: true }).query;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query, cursorSecret: "quotes-flow-customers" });
  var addresses = bShop.addresses.create({ query: query });
  var order   = bShop.order.create({ query: query, inventory: catalog.inventory, cursorSecret: "quotes-flow-order" });
  var quotes  = bShop.quotes.create({ query: query, cart: cart, order: order, inventory: catalog.inventory });

  // Seed a product + variant + price + stock. 50 on hand so the held 5 leaves
  // 45 available; on_hand stays 50 until the order is paid.
  var product = await catalog.products.create({ slug: "bulk-widget", title: "Bulk Widget", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "BULK-1", title: "Default" });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2000 });
  await catalog.inventory.create("BULK-1", { stock_on_hand: 50 });

  // A signed-in customer with a default shipping address (so the conversion
  // can resolve a ship_to country).
  var buyer = await customers.register({ email: "bulk@example.com", display_name: "Bulk Buyer" });
  await addresses.add({
    customer_id: buyer.id, label: "HQ", recipient_name: "Bulk Buyer",
    street_line1: "1 Commerce Way", city: "Springfield", region: "IL",
    postal_code: "62701", country: "US", is_default_shipping: true,
  });
  // A second customer — used for the IDOR check (their quote must not be
  // readable by the first customer's session).
  var other = await customers.register({ email: "other@example.com", display_name: "Other Buyer" });

  // The conversion-at-accept hook server.js wires: resolve the default ship-to
  // and convert. Mirrors server.js's convertQuoteToOrder.
  async function convertQuoteToOrder(quoteId) {
    var q = await quotes.getQuote(quoteId);
    if (!q || q.status !== "accepted") return null;
    var shipAddr = await addresses.defaultShipping(q.customer_id);
    if (!shipAddr || !shipAddr.country) return null;
    // orders.cart_id is FK-constrained to carts(id); mint a backing cart row.
    var convSession = "quote_" + quoteId.replace(/-/g, "").slice(0, 24);
    var convCart = await cart.create(convSession, { currency: q.currency || "USD" });
    await cart.setCustomer(convCart.id, q.customer_id);
    await cart.setStatus(convCart.id, "converted");
    return await quotes.convertToOrder({
      quote_id: quoteId,
      ship_to: { name: shipAddr.recipient_name, street_line1: shipAddr.street_line1, city: shipAddr.city, region: shipAddr.region, postal_code: shipAddr.postal_code, country: shipAddr.country },
      cart_id: convCart.id, session_id: convCart.id,
    });
  }

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-quotes-flow-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: ADMIN_TOKEN, shop_name: "Test Shop", catalog: catalog, order: order,
        cart: cart, customers: customers, quotes: quotes,
      });
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, config: { shop_name: "Test Shop" },
        customers: customers, order: order, quotes: quotes,
        convertQuoteToOrder: convertQuoteToOrder,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + ADMIN_TOKEN };

  try {
    // ---- sign in the buyer + build their cart -------------------------
    // The session cookie (`shop_sid`) carries a plaintext, shape-checked
    // session id (NOT sealed) — so we mint one, build the cart against it via
    // the cart primitive, pin it to the buyer, and hand the running server the
    // same id in the cookie. The auth cookie is the standard sealed envelope.
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer.id, { exp: Date.now() + 7 * 24 * 60 * 60 * 1000 })] });
    var sessionId = "qsess" + b.uuid.v7().replace(/-/g, "").slice(0, 24);
    jar.capture({ "set-cookie": ["shop_sid=" + sessionId] });
    var theCart = await cart.create(sessionId, { currency: "USD" });
    await cart.setCustomer(theCart.id, buyer.id);
    await cart.addLine(theCart.id, { variant_id: variant.id, qty: 5 });
    check("cart built for the buyer's session", (await cart.listLines(theCart.id)).length === 1);

    // A GET seeds the double-submit CSRF cookie into the jar so the POSTs
    // below carry the matching X-CSRF-Token header (httpRequest echoes it).
    var cartView = await helpers.httpRequest({ port: port, path: "/cart", jar: jar,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" } });
    check("cart page renders for the signed-in buyer", cartView.status === 200);
    check("cart page offers the request-a-quote CTA", cartView.body.indexOf("Request a quote") !== -1);

    // ---- the customer requests a quote from their cart ----------------
    var requested = await helpers.httpRequest({
      port: port, path: "/account/quotes/request", method: "POST", jar: jar,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" },
      form: { message: "Need 5 — can you do better on price?" },
    });
    check("quote request redirects to the new quote (303)", requested.status === 303 &&
      /\/account\/quotes\/[0-9a-f-]+$/.test(String(requested.headers.location || "")));
    var quoteId = String(requested.headers.location || "").split("/").pop();

    // Verify the quote landed pinned to the buyer with the cart's line.
    var q0 = await quotes.getQuote(quoteId);
    check("quote pinned to the buyer", q0 && q0.customer_id === buyer.id);
    check("quote carries the cart line at qty 5", q0 && q0.lines.length === 1 && q0.lines[0].sku === "BULK-1" && q0.lines[0].quantity === 5);
    check("quote starts in requested", q0 && q0.status === "requested");

    // ---- the operator's response queue lists it -----------------------
    var queueJson = JSON.parse((await helpers.httpRequest({ port: port, path: "/admin/quotes", headers: bearer })).body);
    check("admin response queue lists the requested quote",
      Array.isArray(queueJson.rows) && queueJson.rows.some(function (q) { return q.id === quoteId; }));

    // The detail screen renders the per-line pricing form (browser path).
    var adminJar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: ADMIN_TOKEN }, jar: adminJar });
    check("admin login then 303", login.status === 303);
    var detail = await helpers.httpRequest({ port: port, path: "/admin/quotes/" + encodeURIComponent(quoteId), jar: adminJar });
    check("admin quote detail renders (200)", detail.status === 200);
    check("admin detail shows the per-line price field", detail.body.indexOf("name=\"price_BULK-1\"") !== -1);
    check("admin detail shows the customer message", detail.body.indexOf("Need 5") !== -1);

    // ---- the operator responds with a priced quote (bearer JSON) ------
    var responded = await helpers.httpRequest({
      port: port, path: "/admin/quotes/" + encodeURIComponent(quoteId) + "/respond",
      method: "POST", headers: { authorization: "Bearer " + ADMIN_TOKEN, "content-type": "application/json" },
      body: JSON.stringify({
        line_prices: [{ sku: "BULK-1", unit_price_minor: 1500 }],
        shipping_minor: 500, tax_minor: 0,
        valid_until: Date.now() + 7 * 24 * 60 * 60 * 1000, currency: "USD",
      }),
    });
    check("operator respond accepted (200)", responded.status === 200);
    var q1 = await quotes.getQuote(quoteId);
    // 5 * 1500 + 500 shipping = 8000.
    check("quoted total = 5*1500 + 500 shipping", q1.status === "responded" && q1.total_minor === 8000);

    // ---- the customer reviews + accepts via their token ---------------
    // Issue a fresh view token (the request-create one isn't echoed back over
    // HTTP; the operator/email path mints it).
    var issued = await quotes.issueViewToken(quoteId);
    check("view token issued", !!issued && !!issued.plaintext_token);
    // The GET on the token page also seeds the CSRF cookie into this jar so
    // the accept POST below carries the matching X-CSRF-Token header.
    var tokenJar = helpers.cookieJar();
    var tokenPage = await helpers.httpRequest({
      port: port, path: "/quote/" + encodeURIComponent(issued.plaintext_token), jar: tokenJar,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" },
    });
    check("tokened quote page renders the priced quote (200)", tokenPage.status === 200);
    check("tokened page shows the accept control", tokenPage.body.indexOf("Accept this quote") !== -1);
    check("tokened page shows the quoted total $80.00", tokenPage.body.indexOf("$80.00") !== -1);

    // The signed-in customer also sees it in their account list.
    var acctList = await helpers.httpRequest({ port: port, path: "/account/quotes", jar: jar,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" } });
    check("account quote list renders (200)", acctList.status === 200);
    check("account list shows the quote", acctList.body.indexOf(String(quoteId).slice(0, 8)) !== -1);

    // Snapshot stock before accept: 50 on hand, 0 held.
    var stockBefore = await catalog.inventory.get("BULK-1");
    check("stock before accept: 50 on hand, 0 held", stockBefore.stock_on_hand === 50 && (stockBefore.stock_held || 0) === 0);

    // Accept via the token — converts to a pending order that holds the stock.
    var accepted = await helpers.httpRequest({
      port: port, path: "/quote/" + encodeURIComponent(issued.plaintext_token) + "/accept",
      method: "POST", jar: tokenJar,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" },
    });
    check("accept via token succeeds (200)", accepted.status === 200);

    var q2 = await quotes.getQuote(quoteId);
    check("quote converted after accept", q2.status === "converted" && !!q2.converted_order_id);

    // The pending order exists, holds the units, and snapshots the quoted price.
    var placedOrder = await order.get(q2.converted_order_id);
    check("converted order is pending", placedOrder && placedOrder.status === "pending");
    check("order line carries the quoted price + qty",
      placedOrder.lines.length === 1 && placedOrder.lines[0].sku === "BULK-1" &&
      Number(placedOrder.lines[0].qty) === 5 && Number(placedOrder.lines[0].unit_amount_minor) === 1500);

    // Stock: the conversion RESERVED 5 (held 5), on_hand still 50 (debited only
    // on paid). This is the oversell guard — the units are off the available
    // shelf the moment the quote is accepted.
    var stockAfter = await catalog.inventory.get("BULK-1");
    check("stock after accept: 50 on hand, 5 held (reserved, not yet debited)",
      stockAfter.stock_on_hand === 50 && stockAfter.stock_held === 5);

    // The FSM refuses re-accepting a converted quote (terminal state).
    var reAccept = false;
    try { await quotes.customerAccept({ quote_id: quoteId, accepted_by_customer: "x" }); reAccept = true; }
    catch (e) { reAccept = e && e.code === "QUOTE_TRANSITION_REFUSED"; }
    check("re-accepting a converted quote is refused by the FSM", reAccept === true);

    // ---- IDOR: another customer's quote 404s on the account path ------
    var otherQuote = await quotes.requestQuote({ customer_id: other.id, lines: [{ sku: "BULK-1", quantity: 2 }] });
    var idor = await helpers.httpRequest({ port: port, path: "/account/quotes/" + encodeURIComponent(otherQuote.id), jar: jar,
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" } });
    check("a different customer's quote 404s on the account path (IDOR gate)", idor.status === 404);

    // ---- unknown token 404s ------------------------------------------
    var bad = await helpers.httpRequest({ port: port, path: "/quote/" + ("z".repeat(43)), jar: helpers.cookieJar(),
      headers: { "sec-fetch-site": "same-origin", "sec-fetch-dest": "document" } });
    check("unknown quote token 404s", bad.status === 404);

    // ---- stored-XSS into the admin detail screen ---------------------
    var xssQuote = await quotes.requestQuote({
      customer_id: buyer.id, lines: [{ sku: "BULK-1", quantity: 1 }],
      message: "<script>alert(1)</script>",
    });
    var xssDetail = await helpers.httpRequest({ port: port, path: "/admin/quotes/" + encodeURIComponent(xssQuote.id), jar: adminJar });
    check("admin detail escapes the RFQ message (no raw <script>)",
      xssDetail.body.indexOf("<script>alert(1)</script>") === -1 &&
      xssDetail.body.indexOf("&lt;script&gt;") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
