"use strict";
/**
 * Customer receipt download — HTTP integration of GET /orders/:id/receipt,
 * the "Download receipt" affordance on the order page. The receipt carries
 * the buyer's name, address, and line items, so the route is gated by the
 * SAME capability check as the order page itself (the IDOR/guest-access gate):
 *
 *   - an OWNED order is downloadable only by its signed-in owner;
 *   - a GUEST order needs a capability proof (placing-browser cookie, the
 *     emailed ?k= token, or a claim cookie);
 *   - anything else 404s, indistinguishable from a missing order, so a
 *     stranger can't pull a receipt by guessing a (timestamp-ordered) UUID.
 *
 * The document streams to the socket header-first, one chunk per batch, so a
 * large receipt never buffers whole in memory; the response is an HTML
 * attachment marked no-store (it contains personal data). A still-pending
 * (unpaid) order has nothing to receipt and bounces to the order page.
 *
 * This file also asserts the profile screen's honest email-change copy: the
 * customer's address is stored hash-only, so there is no plaintext to display
 * or edit — the screen explains the privacy stance rather than offering a
 * field that can't work.
 *
 * Network: zero — every request is on 127.0.0.1. NO worker/ import: only
 * ../../lib + test/helpers + node builtins.
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

// The signing key the storefront verifies ?k= against — same value the email
// factory mints links with (mirrors server.js wiring one derived secret into
// both).
var ORDER_ACCESS_SECRET = b.crypto.namespaceHash("order-access-token", "receipt-download-test-secret");

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql",
  "0206_orders_email_hash.sql",
  "0006_customers.sql",
  "0004_shop_config.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

function _teardownApp(handle) {
  if (!handle) return Promise.resolve();
  return Promise.resolve()
    .then(function () { return handle.app.shutdown(); })
    .catch(function () { /* best-effort */ })
    .then(function () { try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ } });
}

// Seed an order row directly (the access-gate test's owned-order shape). The
// `ship_to` block carries a name + address so the rendered receipt has
// personal data a leak test can assert on/against. `customerId` null mints a
// guest order. Returns the order id.
async function _seedOrder(query, customers, opts) {
  opts = opts || {};
  var orderId = b.uuid.v7();
  var cartId = b.uuid.v7();
  var status = opts.status || "paid";
  var customerId = opts.customer_id || null;
  var emailHash = opts.email ? customers.hashEmail(opts.email) : null;
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, Date.now(), Date.now() + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, subtotal_minor, " +
    "discount_minor, tax_minor, shipping_minor, grand_total_minor, payment_intent_id, ship_to_json, " +
    "customer_email_hash, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, 'USD', 3000, 0, 0, 0, 3000, NULL, ?6, ?7, ?8, ?8)",
    [
      orderId, cartId, customerId, b.uuid.v7(), status,
      JSON.stringify({ name: opts.name || "Buyer", country: "US", line1: opts.line1 || "1 Main St", city: "SF", region: "CA", postal_code: "94103" }),
      emailHash, Date.now(),
    ],
  );
  return orderId;
}

// Mint a structurally-valid emailed ?k= access token for an order, the way
// the email factory does (order-scoped HMAC-SHA3-512 tag + embedded expiry).
function _mintAccessToken(orderId, expMs) {
  var expB36 = Number(expMs).toString(36);
  var tag = b.crypto.hmacSha3(ORDER_ACCESS_SECRET, "order-access:v1:" + orderId + ":" + expB36).slice(0, 32);
  return expB36 + "." + tag;
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "receipt" });
  var customers = bShop.customers.create({ query: query });

  // The /orders/:id confirmation page route is gated on the checkout dep (it
  // is the post-checkout receipt page); wire a no-op tax/shipping + test
  // payment handle so the order page route mounts and the "Download receipt"
  // link assertion has a page to render. The receipt download route itself is
  // gated only on printReceipts.
  var tax      = bShop.tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  var shipping = bShop.shipping.create({ services: [{ id: "std", label: "Std", zones: [{ country: "US", flat_amount_minor: 0 }] }] });
  var payment  = bShop.payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_xxxxxxxx" });
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing, tax: tax, shipping: shipping, payment: payment, order: order,
  });

  // The SAME printReceipts instance the route renders through — built over
  // the shared order primitive (mirrors server.js, which reuses the admin
  // console's instance).
  var printReceipts = bShop.printReceipts.create({ order: order });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-rcpt-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, customers: customers,
        checkout: checkout, default_shipping_id: "std",
        order_access_secret: ORDER_ACCESS_SECRET,
        printReceipts: printReceipts,
        shop_name: "Receipt Shop",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var handle = { app: app, dataDir: dataDir };

  function _contentDisposition(res) {
    var cd = res.headers && res.headers["content-disposition"];
    return Array.isArray(cd) ? cd.join("; ") : (cd || "");
  }

  try {
    // ===================================================================
    // A. Owned order — signed-in owner downloads; everyone else 404s.
    // ===================================================================
    var ownerId = b.uuid.v7();
    await query(
      "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
      [ownerId, customers.hashEmail("owner@example.com"), "Owner", Date.now()],
    );
    var ownedId = await _seedOrder(query, customers, {
      customer_id: ownerId, email: "owner@example.com", name: "Owner", line1: "9 Owner Way", status: "paid",
    });

    var ownerJar = helpers.cookieJar();
    ownerJar.capture({ "set-cookie": [helpers.authCookie(b, ownerId)] });
    var ownerDl = await helpers.httpRequest({ port: port, path: "/orders/" + ownedId + "/receipt", jar: ownerJar });
    check("owner receipt download → 200",            ownerDl.status === 200);
    check("receipt is an HTML attachment",           /attachment; *filename="receipt-/.test(_contentDisposition(ownerDl)));
    check("receipt content-type is html",            String((ownerDl.headers || {})["content-type"] || "").indexOf("text/html") === 0);
    check("receipt is no-store (carries PII)",       String((ownerDl.headers || {})["cache-control"] || "").indexOf("no-store") !== -1);
    check("receipt nosniff",                         String((ownerDl.headers || {})["x-content-type-options"] || "") === "nosniff");
    // The body is the full streamed document — the helper concatenates every
    // res.write chunk, so a complete body proves the stream reassembles.
    check("receipt body is a complete HTML document", ownerDl.body.indexOf("<!doctype html>") === 0 &&
      ownerDl.body.indexOf("</html>") !== -1);
    check("receipt shows the buyer's address",        ownerDl.body.indexOf("9 Owner Way") !== -1);
    check("receipt filename carries the order id",    _contentDisposition(ownerDl).indexOf("receipt-" + ownedId) !== -1);

    // Anonymous request to the owned order's receipt → 404, no PII leak.
    var anonDl = await helpers.httpRequest({ port: port, path: "/orders/" + ownedId + "/receipt", jar: helpers.cookieJar() });
    check("anonymous owned-order receipt → 404",     anonDl.status === 404);
    check("404 leaks no address",                    anonDl.body.indexOf("9 Owner Way") === -1);

    // Signed-in NON-owner with the URL → 404 (owned-order IDOR gate holds).
    var nonOwnerJar = helpers.cookieJar();
    nonOwnerJar.capture({ "set-cookie": [helpers.authCookie(b, b.uuid.v7())] });
    var nonOwnerDl = await helpers.httpRequest({ port: port, path: "/orders/" + ownedId + "/receipt", jar: nonOwnerJar });
    check("non-owner receipt → 404",                 nonOwnerDl.status === 404);
    check("non-owner 404 leaks no address",          nonOwnerDl.body.indexOf("9 Owner Way") === -1);

    // ===================================================================
    // B. Guest order — emailed ?k= token authorizes the download.
    // ===================================================================
    var guestId = await _seedOrder(query, customers, {
      customer_id: null, email: "guest@example.com", name: "Guest", line1: "7 Guest Ln", status: "paid",
    });
    var seededGuest = await order.get(guestId);
    check("seeded order is a guest order (no owner)", seededGuest && !seededGuest.customer_id);

    // A bare-UUID anonymous request (no cookie, no token) → 404.
    var guestAnon = await helpers.httpRequest({ port: port, path: "/orders/" + guestId + "/receipt", jar: helpers.cookieJar() });
    check("guest receipt, no proof → 404",            guestAnon.status === 404);

    // A valid emailed token (fresh jar, any device) → 200; the body carries
    // the address; the open stamps an access cookie so a later token-less pull
    // keeps resolving.
    var token = _mintAccessToken(guestId, Date.now() + 86400000);
    var tokenJar = helpers.cookieJar();
    var guestTok = await helpers.httpRequest({
      port: port, path: "/orders/" + guestId + "/receipt?k=" + encodeURIComponent(token), jar: tokenJar,
    });
    check("guest receipt, emailed token → 200",       guestTok.status === 200);
    check("token receipt shows the address",          guestTok.body.indexOf("7 Guest Ln") !== -1);
    var stampedRcpt = (guestTok.headers && guestTok.headers["set-cookie"]) || [];
    check("token open stamped an access cookie",      String(stampedRcpt).indexOf("shop_oacc=") !== -1);
    var refreshGuest = await helpers.httpRequest({ port: port, path: "/orders/" + guestId + "/receipt", jar: tokenJar });
    check("post-token refresh (cookie) receipt → 200", refreshGuest.status === 200);

    // A tampered token → 404 (MAC mismatch).
    var lastCh = token.charAt(token.length - 1);
    var tampered = token.slice(0, -1) + (lastCh === "0" ? "1" : "0");
    var tamperedDl = await helpers.httpRequest({
      port: port, path: "/orders/" + guestId + "/receipt?k=" + encodeURIComponent(tampered), jar: helpers.cookieJar(),
    });
    check("tampered token receipt → 404",             tamperedDl.status === 404);

    // A token minted for a DIFFERENT order can't open this one (order-scoped).
    var otherToken = _mintAccessToken(b.uuid.v7(), Date.now() + 86400000);
    var wrongOrderDl = await helpers.httpRequest({
      port: port, path: "/orders/" + guestId + "/receipt?k=" + encodeURIComponent(otherToken), jar: helpers.cookieJar(),
    });
    check("other-order token receipt → 404",          wrongOrderDl.status === 404);

    // ===================================================================
    // C. Eligibility — a still-pending (unpaid) order has no receipt.
    // ===================================================================
    var pendingId = await _seedOrder(query, customers, {
      customer_id: ownerId, email: "owner@example.com", name: "Owner", status: "pending",
    });
    var pendingDl = await helpers.httpRequest({ port: port, path: "/orders/" + pendingId + "/receipt", jar: ownerJar });
    check("pending order receipt → 303 bounce",       pendingDl.status === 303 &&
      (pendingDl.headers.location || "").indexOf("/orders/" + pendingId) === 0);

    // A terminal off-ramp (cancelled) still gets a receipt — the buyer needs
    // the paperwork for a cancelled/refunded purchase.
    var cancelledId = await _seedOrder(query, customers, {
      customer_id: ownerId, email: "owner@example.com", name: "Owner", status: "cancelled",
    });
    var cancelledDl = await helpers.httpRequest({ port: port, path: "/orders/" + cancelledId + "/receipt", jar: ownerJar });
    check("cancelled order receipt → 200",            cancelledDl.status === 200);

    // ===================================================================
    // D. Malformed / unknown id → 404 (a missing receipt, never a 500).
    // ===================================================================
    var badIdDl = await helpers.httpRequest({ port: port, path: "/orders/not-a-uuid/receipt", jar: ownerJar });
    check("malformed id receipt → 404",               badIdDl.status === 404);
    var missingId = b.uuid.v7();
    var missingDl = await helpers.httpRequest({ port: port, path: "/orders/" + missingId + "/receipt", jar: ownerJar });
    check("unknown id receipt → 404",                 missingDl.status === 404);

    // ===================================================================
    // E. The order page renders the "Download receipt" link for the owner.
    // ===================================================================
    var ownerPage = await helpers.httpRequest({ port: port, path: "/orders/" + ownedId, jar: ownerJar });
    check("owner order page → 200",                   ownerPage.status === 200);
    check("order page offers Download receipt",       ownerPage.body.indexOf("Download receipt") !== -1 &&
      ownerPage.body.indexOf("/orders/" + ownedId + "/receipt") !== -1);

    // The pending order page does NOT offer the receipt link (nothing to
    // receipt yet).
    var pendingPage = await helpers.httpRequest({ port: port, path: "/orders/" + pendingId, jar: ownerJar });
    check("pending order page → 200",                 pendingPage.status === 200);
    check("pending order page hides Download receipt", pendingPage.body.indexOf(ownedId + "/receipt") === -1 &&
      pendingPage.body.indexOf(pendingId + "/receipt") === -1);
  } finally {
    if (handle) await _teardownApp(handle);
  }

  // =====================================================================
  // F. Profile screen — honest email-change copy (renderProfile unit).
  // =====================================================================
  var profileHtml = bShop.storefront.renderProfile({
    customer: { display_name: "Buyer" }, shop_name: "Receipt Shop",
  });
  // The email field is disabled and explains the hash-only stance, not a
  // limitation-apology.
  check("profile email field is disabled",          /name="display_name"/.test(profileHtml) &&
    /value="Stored as a one-way hash[^"]*"\s+disabled/.test(profileHtml));
  check("profile explains the one-way hash",         profileHtml.indexOf("one-way hash") !== -1);
  check("profile explains no plaintext to edit",     /no plaintext copy to display here or to edit/.test(profileHtml));
  check("profile points to re-registration",         profileHtml.indexOf("register a new account with it") !== -1);
  check("profile offers support order-link help",    profileHtml.indexOf("carried over to a new address") !== -1);
  // The stale single-sentence copy is gone.
  check("stale email copy removed",                  profileHtml.indexOf("Hidden for privacy — stored as a one-way hash") === -1);
}

module.exports = { run: _run };
