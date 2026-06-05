"use strict";
/**
 * Checkout through the LIVE security stack — the in-process twin of the CI
 * e2e job (test/e2e/drive-checkout.js). The CI job runs the standalone
 * serve.js; this runs the same composition in-process so smoke covers it
 * too (local + CI coverage without a Playwright dep).
 *
 * Unlike the other layer-2 tests (which disable bot-guard + rate-limit and
 * mount a thin dep set), this boots the SAME production middleware
 * composition server.js / test/e2e/serve.js use: the app-level CSRF /
 * fetch-metadata / body-parser auto-mounts are disabled and re-mounted
 * INSIDE the route chain via bShop.securityMiddleware.mountRouteGuards, with
 * the global rate limit + security headers on — the point is that the
 * SECURITY STACK IS ON. Asserts the CSRF double-submit token round-trips and
 * an order transitions pending → paid.
 *
 * Network: zero — every request lands on 127.0.0.1.
 *
 * NO worker/ import: imports only ../../lib + test/helpers + node builtins.
 * Do NOT add a worker/ require (it would need an fs.existsSync guard and
 * would brick the in-image smoke).
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
  "0004_shop_config.sql", "0206_orders_email_hash.sql"]
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
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "e2e-csrf-order" });

  var p = await catalog.products.create({ slug: "e2e-widget", title: "E2E Widget", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "E2E-CSRF-1", title: "Default" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2500 });
  await catalog.inventory.create("E2E-CSRF-1", { stock_on_hand: 100 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-e2e-csrf-"));
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Same composition as test/e2e/serve.js: disable the app-level auto-mounts
    // and re-mount the shop's configured copies inside routes() so the
    // security stack matches production exactly (the point of this test).
    middleware: {
      securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
      rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
      csrf:            false,
      bodyParser:      false,
      fetchMetadata:   false,
      cspNonce:        false,
    },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.securityMiddleware.mountRouteGuards(r);
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, order: order });

      // Stub-payment checkout (NOT a real PSP — Stripe can't run offline).
      // Registered after mountRouteGuards and NOT in EDGE_POST_PATHS, so the
      // double-submit CSRF gate applies. Reads the session cart, creates an
      // order via the wired order primitive, and drives the FSM to paid.
      r.post("/e2e/checkout", async function (req, res) {
        function _send(status, obj) {
          res.status(status);
          if (res.setHeader) res.setHeader("content-type", "application/json; charset=utf-8");
          var body = JSON.stringify(obj);
          if (res.end) res.end(body); else res.send(body);
        }
        try {
          var raw = req.headers && (req.headers.cookie || "");
          var m = /(?:^|;\s*)shop_sid=([^;]+)/.exec(raw || "");
          var sid = m ? decodeURIComponent(m[1]) : null;
          if (!sid) return _send(400, { error: "no-session" });
          var c = await cart.bySession(sid);
          if (!c) return _send(400, { error: "no-cart" });
          var lines = await cart.listLines(c.id);
          if (!lines.length) return _send(400, { error: "empty-cart" });
          var subtotal = lines.reduce(function (n, l) { return n + (l.unit_amount_minor || 0) * (l.qty || 0); }, 0);
          var created = await order.createFromCart({
            cart_id: c.id, session_id: c.session_id, currency: c.currency || "USD",
            lines: lines.map(function (l) {
              return { variant_id: l.variant_id, sku: l.sku, qty: l.qty,
                unit_amount_minor: l.unit_amount_minor, unit_currency: l.unit_currency || c.currency || "USD" };
            }),
            subtotal_minor: subtotal, discount_minor: 0, tax_minor: 0, shipping_minor: 0,
            grand_total_minor: subtotal, ship_to: { country: "US" },
            payment_intent_id: "pi_e2e_csrf_" + b.uuid.v7(),
          });
          var paid = await order.transition(created.id, "mark_paid", { metadata: { stub: true } });
          _send(200, { order_id: created.id, status: paid.status });
        } catch (e) {
          _send(500, { error: (e && e.message) || "checkout-failed" });
        }
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();

    // GET the PDP — seeds the session + CSRF cookie into the jar.
    var pdp = await helpers.httpRequest({ port: port, path: "/products/e2e-widget", jar: jar });
    check("pdp 200",                      pdp.status === 200);
    check("csrf cookie seeded",           !!(jar.get("csrf") || jar.get("__Host-csrf")));
    // Referrer-Policy regression guard: under `no-referrer`, browsers
    // serialize the Origin header as "null" on same-origin navigational
    // form POSTs, and the CSRF origin pre-check refuses "null" before the
    // token is read — 403-ing every real-browser form submit while
    // loopback tests (which send no Origin at all) stay green. The app
    // overrides the vendored default to `same-origin`; if a vendor refresh
    // or config change reinstates `no-referrer`, this fails first.
    check("referrer-policy is same-origin (origin-preserving)",
      (pdp.headers["referrer-policy"] || "") === "same-origin");
    var vm = /name="variant_id"\s+value="([^"]+)"/.exec(pdp.body);
    check("pdp exposes a variant_id",     !!vm);
    var variantId = vm[1];

    // A POST to the CSRF-protected checkout with the session cookie but a
    // mismatched token is rejected (403) — the guard is live. (A non-empty
    // bad token defeats the jar's auto-attach so the gate sees a real cookie
    // + a wrong token, proving it validates the token value.)
    var bad = await helpers.httpRequest({
      port: port, path: "/e2e/checkout", method: "POST", jar: jar,
      headers: { "x-csrf-token": "csrf-token-that-does-not-match" }, body: "",
    });
    check("bad-token checkout rejected (403)", bad.status === 403);

    // Add-to-cart (EDGE_POST_PATHS-exempt edge form) lands a line.
    var add = await helpers.httpRequest({
      port: port, path: "/cart/lines", method: "POST", jar: jar,
      form: { variant_id: variantId, qty: "2" },
    });
    check("add-to-cart accepted (303)",   add.status === 303);
    var cartView = await helpers.httpRequest({ port: port, path: "/cart", jar: jar });
    check("cart shows the line",          cartView.body.indexOf("E2E Widget") !== -1);

    // ---- Origin pre-check matrix (the real-browser shapes) --------------
    // The gate evaluates Origin BEFORE the token, so each refusal below must
    // be the "cross-origin" rejection — proving the origin defense fires —
    // while the accept case proves a browser's same-origin Origin round-
    // trips. Absent-Origin (every other request in this file) reaching the
    // token check is already proven by the bad-token 403 above.

    // A sandboxed-iframe / opaque-origin attacker sends the literal string
    // "null" — refused even WITH a valid jar-attached token.
    var nullOrigin = await helpers.httpRequest({
      port: port, path: "/e2e/checkout", method: "POST", jar: jar, body: "",
      headers: { origin: "null" },
    });
    check("null Origin refused (403)", nullOrigin.status === 403);
    check("null Origin refused by the ORIGIN gate, not the token gate",
      nullOrigin.body.indexOf("cross-origin") !== -1);

    // A cross-site forger's Origin — refused even with a valid token.
    var crossOrigin = await helpers.httpRequest({
      port: port, path: "/e2e/checkout", method: "POST", jar: jar, body: "",
      headers: { origin: "https://evil.example" },
    });
    check("cross-origin Origin refused (403)", crossOrigin.status === 403);
    check("cross-origin refused by the ORIGIN gate",
      crossOrigin.body.indexOf("cross-origin") !== -1);

    // Checkout WITH the jar-attached token AND a real browser's same-origin
    // Origin header (what `Referrer-Policy: same-origin` makes browsers send
    // on a navigational POST) → order created + transitioned. This is the
    // case the prod bug broke: it must pass the origin pre-check and then
    // the token check.
    var checkout = await helpers.httpRequest({
      port: port, path: "/e2e/checkout", method: "POST", jar: jar, body: "",
      headers: { origin: "http://127.0.0.1:" + port },
    });
    check("same-origin Origin + tokened checkout accepted (200)", checkout.status === 200);
    var out = JSON.parse(checkout.body);
    check("checkout returned an order_id", typeof out.order_id === "string" && out.order_id.length > 0);
    check("order transitioned to paid",    out.status === "paid");

    // Confirm at the primitive level the order really advanced past pending.
    var persisted = await order.get(out.order_id);
    check("persisted order is paid",       persisted && persisted.status === "paid");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
