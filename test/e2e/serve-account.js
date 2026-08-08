"use strict";
/**
 * Local end-to-end account server — boots the REAL storefront with the
 * production middleware defaults (nothing disabled) on a node:sqlite
 * backend, wired for the AUTHED subscription self-management surface
 * (/account/subscriptions + the plan-change flow), so a real browser
 * (Playwright) can exercise the signed-in pages against the same security
 * stack a deploy runs.
 *
 * This is the gap test/e2e/serve.js (anonymous checkout) and the live
 * prod Playwright sweep both miss: the storefront's auth is passwordless
 * (WebAuthn / magic-link), so a browser can't get past the login screen
 * unaided, and every authed page stays unvalidated by a real browser.
 * Rather than add a login bypass endpoint, this prints the sealed
 * `shop_auth` cookie the framework ITSELF mints (helpers.authCookie ->
 * b.vault.seal); the driver injects it into the browser context. No
 * NODE_ENV bypass, no weakened middleware — the cookie is the exact
 * envelope a real sign-in would write.
 *
 *   node test/e2e/serve-account.js     # boots on PORT (default 8098)
 *
 * Prints, once listening:
 *   E2E_AUTH <customerId> <shop_auth_cookie_value>
 *   E2E_READY <port>
 *
 * Ephemeral temp data dir, torn down on SIGINT/SIGTERM.
 *
 * NO worker/ import: this file imports only ../helpers + ../../lib + node
 * builtins. The static-asset route below reads theme files straight from
 * themes/default/assets so the islands (cart-count / consent / search-
 * suggest) load with their real bytes + SRI — exactly what the Worker
 * serves out of R2 in production — so any console error the driver finds
 * is a REAL bug, not a missing-asset 404.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var helpers = require("../helpers");
var bShop = require("../../lib");
var b = bShop.framework;

var PORT = parseInt(process.env.E2E_PORT || "8098", 10);

var REPO_ROOT  = nodePath.resolve(__dirname, "..", "..");
var THEME_ROOT = nodePath.join(REPO_ROOT, "themes", "default", "assets");

// The authed subscription surface needs: the storefront-core tables every
// boot reads (catalog/cart/order + the order add-on columns), the
// customers table the auth cookie resolves against, the subscriptions
// tables, the billing invoice ledger (the proration charge an upgrade
// owes), the plan-change ledger itself, and the store-credit ledger +
// its per-customer SHA3-512 hash chain (a mid-cycle downgrade's owed
// credit). Loaded in numeric order, strict (a schema break fails the
// harness boot loudly) — the same list the layer-2 plan-change flow pins.
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
  "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql",
  "0206_orders_email_hash.sql", "0004_shop_config.sql",
  "0006_customers.sql",
  "0009_subscriptions.sql", "0045_subscription_controls.sql",
  "0066_subscription_billing.sql", "0083_plan_changes.sql",
  "0094_store_credit.sql",
  "0235_store_credit_ledger_chain.sql", "0236_store_credit_ledger_chain_fence.sql",
  "0239_subscriptions_plan_transition_claim.sql",
].map(function (n) { return nodePath.resolve(REPO_ROOT, "migrations-d1", n); });

// The asset manifest maps a theme asset path (`js/cart-count.js`) to its
// content-fingerprinted name (`js/cart-count.<hash>.js`) + SRI digest —
// the same source the renderers read to emit `<script src>`. The static
// route below reverses the map: a request for the fingerprinted URL finds
// the logical key, then serves the original bytes from disk (the
// fingerprinted file IS a byte-identical copy, so the SRI matches).
var ASSET_MANIFEST = require("../../lib/asset-manifest.json");

// Reverse index: fingerprinted-name -> logical key, built once.
var _fingerprintToKey = (function () {
  var idx = {};
  var assets = ASSET_MANIFEST.assets || {};
  Object.keys(assets).forEach(function (key) {
    var fp = assets[key] && assets[key].fingerprinted;
    if (fp) idx[fp] = key;
  });
  return idx;
})();

// Content types by extension — a wrong type makes the browser refuse the
// resource under strict MIME (a stylesheet served as text/plain is
// dropped; a script served as text/html is blocked). Mirrors the set
// scripts/sync-r2-assets.js uploads with.
var CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json",
  ".txt": "text/plain; charset=utf-8", ".xml": "application/xml",
};

// Resolve an `/assets/...` request path to an on-disk theme file, or null
// when it doesn't map. Two shapes the renderers emit:
//   /assets/themes/default/<fingerprinted>  -> themes/default/assets/<key>
//   /assets/brand/<file>                    -> themes/default/assets/brand/<file>
// The fingerprinted segment is reverse-mapped through the manifest; the
// plain brand path joins directly. The resolved absolute path is verified
// to stay inside THEME_ROOT (no `..` traversal escapes the asset root).
function _resolveAssetFile(urlPath) {
  var rel = null;
  var THEMED = "/assets/themes/default/";
  var BRAND  = "/assets/brand/";
  if (urlPath.indexOf(THEMED) === 0) {
    var fp = urlPath.slice(THEMED.length);
    rel = _fingerprintToKey[fp] || fp;   // fall back to the plain key (unhashed assets)
  } else if (urlPath.indexOf(BRAND) === 0) {
    rel = "brand/" + urlPath.slice(BRAND.length);
  } else {
    return null;
  }
  var abs = nodePath.resolve(THEME_ROOT, rel);
  var rootWithSep = THEME_ROOT.endsWith(nodePath.sep) ? THEME_ROOT : THEME_ROOT + nodePath.sep;
  if (abs !== THEME_ROOT && abs.indexOf(rootWithSep) !== 0) return null;
  return abs;
}

// Seed a USD subscription plan with an explicit amount + a non-empty
// stripe_price_id so the proration math is deterministic and the plan
// qualifies as a candidate. Returns the plan id.
async function _seedPlan(query, variantId, amountMinor) {
  var now = Date.now();
  var planId = b.uuid.v7();
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, 'month', 1, 'usd', ?4, 0, 1, ?5, ?5)",
    [planId, variantId, "price_" + planId.slice(0, 8), amountMinor, now],
  );
  return planId;
}

// Seed an ACTIVE subscription on `planId` owned by `customerId`, with a
// billing period spanning [periodStart, periodEnd]. Returns the sub id.
async function _seedSubscription(query, customerId, planId, periodStart, periodEnd) {
  var now = Date.now();
  var subId = b.uuid.v7();
  // v7 UUIDs share a timestamp prefix; the random tail keeps stripe ids unique.
  var stripeId = "sub_" + subId.replace(/-/g, "").slice(-16);
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?7, ?7)",
    [subId, customerId, planId, stripeId, periodStart, periodEnd, now],
  );
  return subId;
}

// Offline Stripe stand-in — exposes only `cancel` (no retrieve/update),
// so planChanges + subscriptions treat every row as shop-local and
// exercise the local store-credit / invoice settlement model. Keeps shape
// parity with the production composition (subscriptions wants a payment
// handle). A Stripe-CAPABLE stub (retrieve + update) would drive the
// Stripe-first path instead; the local path is the one a browser test of
// the proration COPY wants, since it's the path that renders charges /
// store-credit lines.
function _stubPayment() {
  return { subscriptions: { cancel: async function (id) { return { id: id, status: "canceled" }; } } };
}

(async function main() {
  var query     = helpers.memD1Query(MIGS).query;
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "e2e-account-order" });
  var customers = bShop.customers.create({ query: query });

  var payment             = _stubPayment();
  var subscriptions       = bShop.subscriptions.create({ query: query, payment: payment });
  var subscriptionBilling = bShop.subscriptionBilling.create({ query: query, subscriptions: subscriptions.subscriptions });
  var storeCredit         = bShop.storeCredit.create({ query: query });
  var planChanges         = bShop.planChanges.create({
    query:               query,
    subscriptions:       subscriptions.subscriptions,
    subscriptionBilling: subscriptionBilling,
    storeCredit:         storeCredit,
  });

  // One product + variant the plans hang off.
  var product = await catalog.products.create({ slug: "e2e-sub-box", title: "E2E Subscription Box", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "E2E-SUB-1", title: "Default" });

  // Three USD plans (cheap / current / premium) so the change page offers
  // both an upgrade (premium) and a downgrade (cheap) candidate. Only the
  // current plan's id is referenced again (the subscription hangs off it);
  // the cheap + premium plans need only EXIST in the catalog to surface as
  // candidates, so their ids are intentionally not captured (`_`-prefixed).
  var _planCheap   = await _seedPlan(query, variant.id, 1000);   // $10.00
  var planCurrent  = await _seedPlan(query, variant.id, 2000);   // $20.00
  var _planPremium = await _seedPlan(query, variant.id, 4000);   // $40.00

  // The signed-in customer. A real customers row is inserted with the
  // exact id the auth cookie carries (rather than relying on the cookie
  // alone) so the account surface resolves a genuine account. b.uuid.v7
  // matches the id shape register() would mint.
  var customerId = b.uuid.v7();
  var emailHash  = b.crypto.sha3Hash("e2e-subscriber@example.test");
  var nowTs = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [customerId, emailHash, "E2E Subscriber", nowTs],
  );

  // An ACTIVE subscription on the CURRENT plan, period centred on now
  // (start = now-15d, end = now+15d) so an immediate change prorates a
  // clean half-period. This is the subscription the driver changes to
  // premium.
  var DAY = 86400000;
  var subId = await _seedSubscription(query, customerId, planCurrent, nowTs - 15 * DAY, nowTs + 15 * DAY);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-e2e-account-"));
  // Production middleware defaults — bot-guard, global per-client-IP rate
  // limit, fetch-metadata cross-site isolation + origin guard, the tight
  // per-route limiters, and sealed cookies are ALL on, wired through the
  // same lib/security-middleware composition server.js uses. A real
  // browser exercises the same security stack a deploy runs; the change
  // form's `_csrf` token is auto-injected by the storefront's form
  // chokepoint, so the browser submits it natively.
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Disable createApp's app-level body-parser / fetch-metadata / CSP-nonce
    // / CSRF auto-mounts — the shop mounts its own configured copies + the
    // scoped CSRF inside routes() below, exactly as server.js does, so the
    // harness exercises the real production composition.
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

      // Static theme assets — serve the real island / stylesheet / brand
      // bytes the renderers reference, mirroring what the Worker serves
      // from R2. Path-scoped middleware under `/assets` (the router has no
      // glob route patterns — `:param` only — so a prefix-scoped `use` is
      // the catch-all shape). Registered BEFORE the route guards because in
      // production these are public static files the Worker serves straight
      // from R2 — they never reach the container's CSRF / bot-guard /
      // fetch-metadata stack. Serving them ahead of the guards here is the
      // faithful mirror (a guard 403 on a stylesheet would be a test
      // artifact, not a real condition). GET-only, read-only, scoped to
      // themes/default/assets: a path that doesn't map, or escapes the
      // asset root, falls through to the guards + storefront (404). Without
      // this, every island `<script src>` 404s and floods the console with
      // failed-fetch noise that masks real bugs; with it, a console error
      // is a genuine finding.
      r.use("/assets", function (req, res, next) {
        if (req.method !== "GET") return next();
        // The router exposes the parsed path on req.pathname (query
        // stripped); fall back to splitting req.url defensively.
        var urlPath = req.pathname || (req.url || "").split("?")[0] || "";
        var abs = _resolveAssetFile(urlPath);
        if (!abs) return next();
        var data;
        // try/read rather than existsSync-then-read: one syscall, no
        // TOCTOU window. ENOENT falls through to the storefront 404; any
        // other read error is surfaced as a 500 so a broken asset mount
        // is loud rather than a silent miss.
        try {
          data = nodeFs.readFileSync(abs);
        } catch (e) {
          if (e && e.code === "ENOENT") return next();
          res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          return res.end("asset read failed");
        }
        var ext = nodePath.extname(abs).toLowerCase();
        res.writeHead(200, {
          "content-type": CONTENT_TYPES[ext] || "application/octet-stream",
          // Long-lived: the URL is content-fingerprinted, so the bytes
          // never change under a given URL. Matches the Worker's R2 policy.
          "cache-control": "public, max-age=31536000, immutable",
          "content-length": data.length,
        });
        return res.end(data);
      });

      // The full production route-guard stack (bot-guard, fetch-metadata
      // cross-site isolation + origin guard, scoped double-submit CSRF, the
      // per-route limiters) — mounted exactly as server.js does, so every
      // page route below the asset server runs under the live security
      // stack a deploy runs.
      bShop.securityMiddleware.mountRouteGuards(r);

      bShop.storefront.mount(r, {
        catalog:             catalog,
        cart:                cart,
        order:               order,
        customers:           customers,
        subscriptions:       subscriptions,
        subscriptionBilling: subscriptionBilling,
        storeCredit:         storeCredit,
        planChanges:         planChanges,
        payment:             payment,
        config:              { shop_name: "blamejs.shop" },
      });
    },
  });
  var bound = await app.listen({ port: PORT, host: "127.0.0.1" });

  // The vault is initialized now (the app is booted), so authCookie can
  // seal. Print the auth material BEFORE E2E_READY so the driver captures
  // it from the same stdout stream. The cookie value is the on-wire
  // `shop_auth=<sealed>` string; the driver splits the name/value to
  // addCookies into the browser context.
  var authCookie = helpers.authCookie(b, customerId);
  console.log("E2E_AUTH " + customerId + " " + authCookie + " " + subId);
  console.log("E2E_READY " + bound.port + " /account/subscriptions");

  function _stop() {
    app.shutdown().then(function () {
      try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort cleanup */ }
      process.exit(0);
    });
  }
  process.on("SIGINT", _stop);
  process.on("SIGTERM", _stop);
})().catch(function (e) {
  // Re-throw rather than logging — a boot failure's message / stack can
  // carry passphrase-adjacent config, and this is a dev harness. Node's
  // default handler prints it to stderr and exits non-zero.
  process.exitCode = 1;
  throw e;
});
