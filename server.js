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
      // re-parsing. The text sub-parser opts in `text/csv` so the
      // admin bulk-import route reads the raw CSV bytes as a string
      // — bumped limit covers the 1 MiB import cap with headroom.
      r.use(b.middleware.bodyParser({
        text: {
          limit:        b.constants.BYTES.mib(2),
          contentTypes: ["text/plain", "text/csv"],
        },
      }));

      // Liveness + readiness — the Worker short-circuits /_/health
      // at the edge, but the container also responds so the
      // container's own Docker HEALTHCHECK probe lights up before
      // the Worker is in the picture (local dev, smoke).
      r.get("/_/health", function (_req, res) {
        res.json({ ok: true, container: true });
      });

      // Shared config primitive — operator-tunable runtime
      // configuration (tax rules, shipping services, brand name).
      // Built once at boot so the admin write-path and the storefront
      // read-path share the same 30s in-memory cache; admin writes
      // invalidate the entry for the read side.
      var config = catalog && cart ? bShop.config.create({}) : null;

      // Cursor HMAC key for order.listForCustomer — same derivation
      // pattern as catalog's cursor secret. Required in production
      // since v0.0.28 wired customer-account-scoped pagination.
      var orderCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("order-cursor", process.env.D1_BRIDGE_SECRET)
        : "order-cursor-secret-dev-only";

      // Reviews — opts in the storefront review display + submit routes
      // and the admin moderation routes. Single instance shared by both
      // surfaces. Cursor HMAC key derived like the others. The primitive
      // only needs the externalDb query handle.
      var reviewCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("review-cursor", process.env.D1_BRIDGE_SECRET)
        : "review-cursor-secret-dev-only";
      var reviews = (catalog && cart)
        ? bShop.reviews.create({ cursorSecret: reviewCursorSecret })
        : null;

      // Wishlist — opts in the storefront save toggle + /account/wishlist
      // page. Per-customer; cursor HMAC key derived like the others.
      var wishlistCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("wishlist-cursor", process.env.D1_BRIDGE_SECRET)
        : "wishlist-cursor-secret-dev-only";
      var wishlist = (catalog && cart)
        ? bShop.wishlist.create({ cursorSecret: wishlistCursorSecret })
        : null;

      // Save for later — move cart lines into a per-customer holding
      // list and back. Cursor HMAC key derived like the others.
      var saveForLaterCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("save-for-later-cursor", process.env.D1_BRIDGE_SECRET)
        : "save-for-later-cursor-secret-dev-only";
      var saveForLater = (catalog && cart)
        ? bShop.saveForLater.create({ cursorSecret: saveForLaterCursorSecret, catalog: catalog })
        : null;

      // Address book — per-customer saved addresses on /account/addresses.
      var addresses = (catalog && cart) ? bShop.addresses.create({}) : null;

      // Returns — customer self-serve RMA requests (/account/returns) +
      // operator moderation (/admin/returns). Cursor HMAC key like the
      // others. Single instance shared by both surfaces.
      var returnsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("returns-cursor", process.env.D1_BRIDGE_SECRET)
        : "returns-cursor-secret-dev-only";
      var returns = (catalog && cart)
        ? bShop.returns.create({ cursorSecret: returnsCursorSecret })
        : null;

      // Collections — operator-curated + smart product lists, surfaced
      // as public /collections browse pages. Needs the catalog handle
      // (smart collections walk the catalog) + a cursor secret.
      var collectionsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("collections-cursor", process.env.D1_BRIDGE_SECRET)
        : "collections-cursor-secret-dev-only";
      var collections = (catalog && cart)
        ? bShop.collections.create({ catalog: catalog, cursorSecret: collectionsCursorSecret })
        : null;

      // Recently viewed — the signed-in customer's browse history.
      // Views are recorded on the PDP and surfaced at
      // /account/recently-viewed. Composes the catalog handle for
      // product resolution.
      var recentlyViewed = (catalog && cart)
        ? bShop.recentlyViewed.create({ catalog: catalog })
        : null;

      // Tax + shipping default tables — kick in when the operator
      // hasn't seeded `tax.rules` / `shipping.services` in config.
      // Zero-rate tax + a single $0 standard shipping service keeps
      // the storefront browsable on a fresh deploy.
      var DEFAULT_TAX_RULES = [];
      var DEFAULT_SHIPPING_SERVICES = [
        { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 0 }] },
      ];
      var DEFAULT_SHIPPING_ID = "std";

      // Admin API — bearer-token-gated CRUD over catalog + orders +
      // refunds. Only mounts when ADMIN_API_KEY is present (operator
      // opts in by setting the secret). Stripe-backed refund routes
      // only mount when STRIPE_API_KEY is also present.
      if (catalog && cart && process.env.ADMIN_API_KEY) {
        var order   = bShop.order.create({ cursorSecret: orderCursorSecret });
        var payment = null;
        if (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
          payment = bShop.payment.create({
            apiKey:        process.env.STRIPE_API_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          });
        }
        // config is already constructed at the top of the routes
        // function (line 87) when catalog && cart are present; the
        // admin block reuses that handle.
        // R2 upload bridge — the admin /admin/media/upload route uses
        // this to push fetched image bytes through the Worker into the
        // bound R2 bucket. Wired only when the operator has set the
        // bridge credentials (same auth as the D1 bridge).
        var r2_bridge = null;
        if (process.env.D1_BRIDGE_URL && process.env.D1_BRIDGE_SECRET) {
          r2_bridge = bShop.r2Bridge.create({
            bridgeUrl:    process.env.D1_BRIDGE_URL,
            bridgeSecret: process.env.D1_BRIDGE_SECRET,
            bridgePath:   process.env.R2_BRIDGE_PATH || "/_/r2/put",
          });
        }
        var catalogImport = bShop.catalogImport.create({ catalog: catalog });
        bShop.admin.mount(r, {
          token:         process.env.ADMIN_API_KEY,
          catalog:       catalog,
          order:         order,
          payment:       payment,
          config:        config,
          r2_bridge:     r2_bridge,
          catalogImport: catalogImport,
          reviews:       reviews,
          returns:       returns,
        });
      }

      // Storefront — HTML pages for end customers. Mounts the
      // home / product / cart routes when the data layer is wired.
      // Falls back to a JSON identity ping when there's no D1
      // (local dev without a Worker bridge).
      if (catalog && cart) {
        // Optional file-backed theme. When SHOP_THEME is set, every
        // storefront page renders through `<themes>/<name>/*.html`
        // with the bundled `default` theme as the fallback chain.
        // Operators upload theme assets (CSS, fonts, images) to R2
        // under `themes/<name>/...`; the Worker's `/assets/themes/<name>/*`
        // pass-through serves them.
        var sfTheme = null;
        if (process.env.SHOP_THEME) {
          sfTheme = bShop.theme.create({
            themesDir: process.env.SHOP_THEMES_DIR || "./themes",
            name:      process.env.SHOP_THEME,
            fallback:  process.env.SHOP_THEME_FALLBACK || "default",
          });
        }
        // Build the optional checkout + payment + order deps when
        // Stripe is configured. Without these the storefront stays
        // browsable but checkout-routes don't mount.
        var sfDeps = { catalog: catalog, cart: cart };
        if (sfTheme) sfDeps.theme = sfTheme;
        // Customer accounts — opts the /account/* routes in. The
        // primitive only needs the externalDb query handle (which
        // ships with this deploy via `r2_bridge` / `D1_BRIDGE_URL`),
        // so wire it whenever the data layer is present.
        sfDeps.customers = bShop.customers.create({});
        // Newsletter signups — opts the /newsletter route in. The
        // primitive only needs the externalDb query handle (which
        // ships with this deploy via D1_BRIDGE_URL).
        sfDeps.newsletter = bShop.newsletter.create({});
        // Reviews display + submit. The submit route gates on a verified
        // purchase, which needs order reads — wire an order handle here
        // regardless of Stripe (order reads don't touch the payment SDK).
        // The checkout block below reuses this same handle.
        if (reviews) sfDeps.reviews = reviews;
        if (wishlist) sfDeps.wishlist = wishlist;
        if (saveForLater) sfDeps.saveForLater = saveForLater;
        if (addresses) sfDeps.addresses = addresses;
        if (returns) sfDeps.returns = returns;
        if (collections) sfDeps.collections = collections;
        if (recentlyViewed) sfDeps.recentlyViewed = recentlyViewed;
        sfDeps.order = bShop.order.create({ cursorSecret: orderCursorSecret });
        if (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
          var sfOrder = sfDeps.order;
          var sfPayment = bShop.payment.create({
            apiKey:        process.env.STRIPE_API_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          });
          // Tax + shipping wrappers that re-read the operator's
          // config on each call. The wrapped adapter is rebuilt per
          // request from the latest `tax.rules` / `shipping.services`
          // rows, so an operator PUT against `/admin/config/:key`
          // takes effect on the next checkout (modulo the config
          // primitive's 30s read cache). When the operator hasn't
          // seeded a value, the documented zero-rate defaults apply.
          var sfTax = {
            name: "configured",
            calculate: async function (ctx) {
              var rules = await config.get("tax.rules", DEFAULT_TAX_RULES);
              var adapter = bShop.tax.create({ rules: rules });
              return await adapter.calculate(ctx);
            },
          };
          var sfShipping = {
            name: "configured",
            rates: async function (ctx) {
              var services = await config.get("shipping.services", DEFAULT_SHIPPING_SERVICES);
              var adapter = bShop.shipping.create({ services: services });
              return await adapter.rates(ctx);
            },
          };
          var sfCheckout = bShop.checkout.create({
            catalog: catalog, cart: cart, pricing: bShop.pricing,
            tax: sfTax, shipping: sfShipping, payment: sfPayment, order: sfOrder,
          });
          sfDeps.payment           = sfPayment;
          sfDeps.checkout          = sfCheckout;
          // Resolve the storefront's selected_shipping_id fallback
          // from config; the resolver re-reads per checkout POST so
          // operator changes don't need a container restart.
          sfDeps.default_shipping_id = async function () {
            return await config.get("shipping.default_id", DEFAULT_SHIPPING_ID);
          };
          sfDeps.stripe_publishable_key = process.env.STRIPE_PUBLISHABLE_KEY || "";
        }
        bShop.storefront.mount(r, sfDeps);
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
