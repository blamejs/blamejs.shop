"use strict";
/**
 * Local end-to-end storefront server — boots the REAL storefront with the
 * production middleware defaults (nothing disabled) on a node:sqlite
 * backend, so a real browser (Playwright) can exercise add-to-cart,
 * checkout, etc. against the same security stack a deploy runs. This is
 * the gap the layer-2 integration tests miss: they disable bot-guard /
 * rate-limit and mount a thin dep set; here everything is on.
 *
 *   node test/e2e/serve.js            # boots on PORT (default 8099)
 *
 * Prints "E2E_READY <port>" once listening; seeds one product/variant so
 * /products/e2e-widget is live. Ephemeral temp data dir.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var helpers = require("../helpers");
var bShop = require("../../lib");
var b = bShop.framework;

var PORT = parseInt(process.env.E2E_PORT || "8099", 10);

// The storefront-core migrations only — helpers.memD1Query stays in its
// strict default here, so a schema break in any of these five fails the
// harness boot loudly instead of degrading.
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

(async function main() {
  var query   = helpers.memD1Query(MIGS).query;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "e2e-order" });

  var p = await catalog.products.create({ slug: "e2e-widget", title: "E2E Widget", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "E2E-1", title: "Default" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2500 });
  await catalog.inventory.create("E2E-1", { stock_on_hand: 100 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-e2e-"));
  // NOTE: production middleware defaults — bot-guard (createApp default),
  // the global per-client-IP rate limit, fetch-metadata cross-site
  // isolation + origin guard, the tight per-route limiters, and sealed
  // cookies are ALL on, wired through the same lib/security-middleware
  // composition server.js uses. This is the point: a real browser
  // exercises the same security stack a deploy runs.
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Disable createApp's app-level body-parser / fetch-metadata / CSP-nonce
    // / CSRF auto-mounts (v0.13.46+) — the shop mounts its own configured
    // copies + the scoped CSRF inside routes() below, exactly as server.js
    // does, so the harness exercises the real production composition.
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

      // Stub-payment checkout for the e2e driver — NOT a real PSP (Stripe
      // can't run offline). It exercises the SAME security stack the real
      // checkout does: registered AFTER mountRouteGuards, and NOT in
      // EDGE_POST_PATHS, so the double-submit CSRF gate applies (a tokenless
      // POST is rejected; the storefront-issued token round-trips). On a
      // tokened POST it reads the session cart, creates an order via the
      // wired order primitive's createFromCart, and drives the FSM
      // pending → paid — proving an order TRANSITION through the live stack.
      // This route lives ONLY in this test harness; production checkout goes
      // through deps.checkout.confirm (Stripe). No NODE_ENV bypass touches
      // real code.
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
          var subtotal = lines.reduce(function (n, l) {
            return n + (l.unit_amount_minor || 0) * (l.qty || 0);
          }, 0);
          var created = await order.createFromCart({
            cart_id:           c.id,
            session_id:        c.session_id,
            currency:          c.currency || "USD",
            lines: lines.map(function (l) {
              return {
                variant_id:        l.variant_id,
                sku:               l.sku,
                qty:               l.qty,
                unit_amount_minor: l.unit_amount_minor,
                unit_currency:     l.unit_currency || c.currency || "USD",
              };
            }),
            subtotal_minor:    subtotal,
            discount_minor:    0,
            tax_minor:         0,
            shipping_minor:    0,
            grand_total_minor: subtotal,
            ship_to:           { country: "US" },
            payment_intent_id: "pi_e2e_stub_" + b.uuid.v7(),
          });
          // Stub payment "succeeds" → drive the FSM into paid.
          var paid = await order.transition(created.id, "mark_paid", { metadata: { stub: true } });
          _send(200, { order_id: created.id, status: paid.status });
        } catch (e) {
          _send(500, { error: (e && e.message) || "checkout-failed" });
        }
      });
    },
  });
  var bound = await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log("E2E_READY " + bound.port + " /products/e2e-widget");

  function _stop() { app.shutdown().then(function () { try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ } process.exit(0); }); }
  process.on("SIGINT", _stop);
  process.on("SIGTERM", _stop);
})().catch(function (e) {
  // Re-throw rather than logging the error — a boot failure's message /
  // stack can carry passphrase-adjacent config, and this is a dev harness.
  // Node's default handler prints it to stderr and exits non-zero.
  process.exitCode = 1;
  throw e;
});
