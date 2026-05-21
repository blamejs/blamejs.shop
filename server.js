"use strict";
/**
 * blamejs.shop application entry point.
 *
 *   node server.js
 *
 * On a fresh clone, run `bash scripts/vendor-update.sh blamejs latest`
 * once to populate `lib/vendor/blamejs/` before starting the server.
 *
 * Default boot is minimal: framework + healthcheck + placeholder home
 * route. When the deployment supplies D1_BRIDGE_URL + D1_BRIDGE_SECRET
 * (the Cloudflare Containers topology), the externalDb D1 backend is
 * wired so commerce primitives that land later can read/write
 * application data without further configuration.
 *
 * Required env (single-node defaults):
 *   PORT                       (default 8080)
 *   DATA_DIR                   (default ./data)
 *   VAULT_PASSPHRASE           (vault unlock — required by b.vault)
 *
 * Optional env (Cloudflare deploy):
 *   D1_BRIDGE_URL              Worker bridge URL (e.g. http://shop-worker)
 *   D1_BRIDGE_SECRET           shared secret matching the Worker's
 *                              D1_BRIDGE_SECRET binding
 *   D1_BRIDGE_PATH             override (default /_/db/query)
 */

var bShop = require("./lib");
var b     = bShop.framework;

var PORT     = parseInt(process.env.PORT || "8080", 10);
var DATA_DIR = process.env.DATA_DIR || "./data";

(async function main() {
  // Optional: wire a Cloudflare D1 backend when the deploy provides
  // bridge credentials. Initializes externalDb before createApp so
  // the framework's cluster-mode boot picks it up automatically.
  var catalog = null;
  var cart    = null;
  if (process.env.D1_BRIDGE_URL && process.env.D1_BRIDGE_SECRET) {
    var d1 = bShop.externaldbD1.create({
      mode:         "service-binding",
      bridgeUrl:    process.env.D1_BRIDGE_URL,
      bridgeSecret: process.env.D1_BRIDGE_SECRET,
      bridgePath:   process.env.D1_BRIDGE_PATH || "/_/db/query",
    });
    b.externalDb.init({ backends: { main: d1 } });
    // Cursor HMAC key — derived from the deployment-scoped bridge
    // secret via b.crypto.namespaceHash, which domain-separates the
    // derived value by the "catalog-cursor" prefix so a leak in one
    // namespace doesn't expose the other. Stable across container
    // restarts; rotating D1_BRIDGE_SECRET also rotates cursors.
    var cursorSecret = b.crypto.namespaceHash("catalog-cursor", process.env.D1_BRIDGE_SECRET);
    catalog = bShop.catalog.create({ cursorSecret: cursorSecret });
    cart    = bShop.cart.create({ catalog: catalog });
  }

  var app = await b.createApp({
    dataDir: DATA_DIR,
    routes: function (r) {
      // Body parser — populates req.body from form-encoded + JSON
      // request bodies. Mounted before any POST handler so the
      // storefront cart-write routes can read form fields without
      // re-parsing.
      r.use(b.middleware.bodyParser());

      // Liveness + readiness — the Worker short-circuits /_/health
      // at the edge, but the container also responds so the
      // container's own Docker HEALTHCHECK probe lights up before
      // the Worker is in the picture (local dev, smoke).
      r.get("/_/health", function (_req, res) {
        res.json({ ok: true, container: true });
      });

      // Admin API — bearer-token-gated CRUD over catalog + orders +
      // refunds. Only mounts when ADMIN_API_KEY is present (operator
      // opts in by setting the secret). Stripe-backed refund routes
      // only mount when STRIPE_API_KEY is also present.
      if (catalog && cart && process.env.ADMIN_API_KEY) {
        var order   = bShop.order.create({});
        var payment = null;
        if (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
          payment = bShop.payment.create({
            apiKey:        process.env.STRIPE_API_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          });
        }
        bShop.admin.mount(r, {
          token:   process.env.ADMIN_API_KEY,
          catalog: catalog,
          order:   order,
          payment: payment,
        });
      }

      // Storefront — HTML pages for end customers. Mounts the
      // home / product / cart routes when the data layer is wired.
      // Falls back to a JSON identity ping when there's no D1
      // (local dev without a Worker bridge).
      if (catalog && cart) {
        bShop.storefront.mount(r, { catalog: catalog, cart: cart });
      } else {
        r.get("/", function (_req, res) {
          res.json({
            name:    "blamejs-shop",
            version: require("./package.json").version,
            framework: {
              blamejs: require("./lib/vendor/MANIFEST.json").packages.blamejs.version,
            },
          });
        });
      }

      // Read-only public catalog API. Admin writes live behind
      // `lib/admin.js` (passkey + step-up) once that primitive
      // lands — until then writes are operator-only via direct
      // D1 access or the wrangler CLI.
      if (catalog) {
        // Helper: convert a thrown error to an RFC 9457 problem
        // document and send it. TypeError surfaces as a 400; any
        // other Error is a 500 with a stable problem `type` URN so
        // operators can grep for it.
        function _problemFromError(res, e) {
          var status = e instanceof TypeError ? 400 : 500;
          var problem = b.problemDetails.fromError(e, { status: status });
          b.problemDetails.respond(res, problem);
        }
        r.get("/api/catalog/products", async function (req, res) {
          try {
            var url    = new URL(req.url, "http://localhost");
            var limitS = url.searchParams.get("limit");
            var cursor = url.searchParams.get("cursor");
            var status = url.searchParams.get("status") || "active";
            var limit  = limitS == null ? 20 : parseInt(limitS, 10);
            var page   = await catalog.products.list({ status: status, limit: limit, cursor: cursor });
            res.json(page);
          } catch (e) { _problemFromError(res, e); }
        });

        r.get("/api/catalog/products/:slug", async function (req, res) {
          try {
            var product = await catalog.products.bySlug(req.params.slug);
            if (!product) {
              return b.problemDetails.send(res, {
                type:   "/problems/product-not-found",
                title:  "Product not found",
                status: 404,
                detail: "No product with slug " + JSON.stringify(req.params.slug),
              });
            }
            var variants = await catalog.variants.listForProduct(product.id);
            var media    = await catalog.media.listForProduct(product.id);
            res.json({ product: product, variants: variants, media: media });
          } catch (e) { _problemFromError(res, e); }
        });
      }
    },
  });

  // 0.0.0.0 so Cloudflare's container fabric can reach Node on
  // 10.0.0.1:PORT. Defaulting host omits inter-fabric reachability.
  var bound = await app.listen({ port: PORT, host: "0.0.0.0" });
  process.stderr.write("[server] listening on :" + bound.port + "\n");

  // Graceful shutdown — Cloudflare Containers sends SIGTERM with a
  // 10s grace period. Drain via b.appShutdown so in-flight requests
  // finish and any wired primitives (db, vault) flush before exit.
  var draining = false;
  function _drain(signal) {
    if (draining) return;
    draining = true;
    process.stderr.write("[server] " + signal + " received — draining\n");
    if (b.appShutdown && typeof b.appShutdown.drain === "function") {
      b.appShutdown.drain().then(function () { process.exit(0); }, function () { process.exit(1); });
    } else {
      bound.server.close(function () { process.exit(0); });
    }
  }
  process.on("SIGTERM", function () { _drain("SIGTERM"); });
  process.on("SIGINT",  function () { _drain("SIGINT");  });
})().catch(function (err) {
  process.stderr.write("[server] failed to start: " + (err && err.message || err) + "\n");
  if (err && err.stack) process.stderr.write(err.stack + "\n");
  process.exit(1);
});
