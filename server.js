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
  // createApp's secure defaults unlock TWO wrapped components at boot — the
  // vault AND the audit-signing keypair — and the framework reads their
  // passphrases from BLAMEJS_VAULT_PASSPHRASE / BLAMEJS_AUDIT_SIGNING_PASSPHRASE.
  // The deploy contract (docs/deploy-cloudflare.md + the header above)
  // documents a single operator secret, VAULT_PASSPHRASE. Without bridging it,
  // an operator who follows the docs sets a name the framework never reads;
  // the wrapped components have no passphrase source in a container (no TTY);
  // createApp throws — crash-looping the container so every write route
  // (add-to-cart, checkout, account, admin) is unreachable while edge-rendered
  // reads still work. Bridge the one documented secret onto both: the vault
  // passphrase is the secret as-is; the audit-signing passphrase is derived
  // from it, domain-separated via namespaceHash, so one operator secret
  // unlocks both with distinct key material. An explicitly-set BLAMEJS_*
  // always wins; the _FILE variant is honored for the vault path.
  if (process.env.VAULT_PASSPHRASE) {
    if (!process.env.BLAMEJS_VAULT_PASSPHRASE) {
      process.env.BLAMEJS_VAULT_PASSPHRASE = process.env.VAULT_PASSPHRASE;
    }
    if (!process.env.BLAMEJS_AUDIT_SIGNING_PASSPHRASE) {
      process.env.BLAMEJS_AUDIT_SIGNING_PASSPHRASE =
        b.crypto.namespaceHash("shop-audit-signing-passphrase", process.env.VAULT_PASSPHRASE);
    }
  }
  if (process.env.VAULT_PASSPHRASE_FILE && !process.env.BLAMEJS_VAULT_PASSPHRASE_FILE) {
    process.env.BLAMEJS_VAULT_PASSPHRASE_FILE = process.env.VAULT_PASSPHRASE_FILE;
  }

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

  // The operator-configured shop name (set via the admin setup wizard,
  // persisted to shop_config) drives the storefront header / page
  // titles + the admin header. Read once at boot — edits apply on the
  // next deploy. Falls back to the framework default when unconfigured.
  var bootShopName = "blamejs.shop";
  if (catalog && cart) {
    try { bootShopName = await bShop.config.create({}).get("shop.name", "blamejs.shop"); }
    catch (_e) { /* unconfigured — default */ }
  }

  var app = await b.createApp({
    dataDir: DATA_DIR,
    routes: function (r) {
      // Capture the raw body for payment webhooks BEFORE the JSON parser
      // consumes it — Stripe (and PayPal) verify the signature over the
      // exact bytes. Must precede bodyParser; the webhook handlers read
      // req.rawBody. Harmless for every other path (it only matches POSTs
      // to the listed webhook routes).
      r.use(bShop.storefront.webhookRawBodyCapture(["/api/webhooks/stripe", "/api/webhooks/paypal"]));

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

      // Loyalty — customer points balance + tier, the earn rules that
      // mint points on order events, and the reward catalog customers
      // redeem against. Three composed instances sharing one ledger:
      //   * `loyalty` owns the balance + the audited transaction trail.
      //   * `loyaltyEarnRules` composes `loyalty` so awardForEvent posts
      //     earned points straight to the balance; the order primitive
      //     fans the paid transition into it (earn-on-purchase).
      //   * `loyaltyRedemption` composes `loyalty` so redeeming a reward
      //     debits points + records the redemption.
      // No cursor secret — loyalty pagination cursors are opaque
      // epoch-ms offsets, not HMAC-tagged tuples.
      var loyalty = (catalog && cart) ? bShop.loyalty.create({}) : null;
      var loyaltyEarnRules = (catalog && cart)
        ? bShop.loyaltyEarnRules.create({ loyalty: loyalty })
        : null;
      var loyaltyRedemption = (catalog && cart)
        ? bShop.loyaltyRedemption.create({ loyalty: loyalty })
        : null;

      // Referrals — refer-a-friend with two-sided rewards. `referrals`
      // owns the per-customer code + the invitation funnel; the reward-
      // on-first-order credit rides the order primitive's paid transition
      // (wired below, like the loyalty earn fan-out). `referralLeaderboard`
      // sits on top to surface top-referrer rankings + tiered bonuses.
      // The shareable link points at the container-served /r/<code>
      // landing, which sets the attribution cookie and redirects home —
      // derived from SHOP_ORIGIN so the link is absolute when the operator
      // has set their origin (otherwise the primitive's default base is
      // overridden per request from the Host header inside the route).
      var referralLinkBase = process.env.SHOP_ORIGIN
        ? process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/r/"
        : null;
      var referrals = (catalog && cart)
        ? bShop.referrals.create(referralLinkBase ? { linkBase: referralLinkBase } : {})
        : null;
      var referralLeaderboard = (catalog && cart)
        ? bShop.referralLeaderboard.create({})
        : null;

      // Customers — passkey / OIDC accounts. Opts the storefront /account/*
      // routes in AND the read-only /admin/customers roster. Single instance
      // shared by both surfaces. Cursor HMAC key for the admin list derived
      // like the others. The primitive only needs the externalDb query handle.
      var customersCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customers-cursor", process.env.D1_BRIDGE_SECRET)
        : "customers-cursor-secret-dev-only";
      var customers = (catalog && cart)
        ? bShop.customers.create({ cursorSecret: customersCursorSecret })
        : null;

      // Product Q&A — opts in the storefront published-Q&A display + the
      // ask-a-question route, plus the admin moderation console. Single
      // instance shared by both surfaces. The primitive paginates with
      // opaque (occurred_at:id) cursors rather than HMAC-tagged tuples,
      // so it needs no cursor secret — only the externalDb query handle.
      // Wired with the live `customers` instance so an authenticated
      // questioner's customer_id is verified to exist before the row is
      // stamped.
      var productQa = (catalog && cart)
        ? bShop.productQA.create({ customers: customers })
        : null;

      // Outbound webhooks — operator-registered endpoints receive signed
      // (HMAC-SHA3-512) deliveries on order lifecycle events. One shared
      // instance: the order instances fan out transitions through it
      // (order.create({ webhooks })), and the admin console manages
      // endpoints + monitors deliveries. No external credentials — the
      // signing secret is generated per endpoint on create.
      var webhooks = (catalog && cart) ? bShop.webhooks.create({}) : null;

      // Gift cards — prepaid bearer balance redeemable at checkout, plus
      // the append-only ledger of credit/debit/expire events. The card
      // primitive owns the code + the balance snapshot; the ledger is
      // the audit trail surfaced in the admin console. Both only need
      // the externalDb query handle.
      var giftcards      = (catalog && cart) ? bShop.giftcards.create({}) : null;
      var giftCardLedger = (catalog && cart) ? bShop.giftCardLedger.create({}) : null;

      // Recommendations — operator-curated overrides + co-purchase /
      // category-popular / in-stock signals. Composes the catalog handle;
      // powers the post-purchase "Customers also bought" rail.
      var recommendations = (catalog && cart) ? bShop.recommendations.create({ catalog: catalog }) : null;

      // Collections — operator-curated + smart product lists, surfaced
      // as public /collections browse pages. Needs the catalog handle
      // (smart collections walk the catalog) + a cursor secret.
      var collectionsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("collections-cursor", process.env.D1_BRIDGE_SECRET)
        : "collections-cursor-secret-dev-only";
      var collections = (catalog && cart)
        ? bShop.collections.create({ catalog: catalog, cursorSecret: collectionsCursorSecret })
        : null;

      // Category navigation — the hierarchical category tree surfaced as
      // public /categories browse pages (index + per-category breadcrumb
      // + sub-category grid). Composes the catalog handle (held for the
      // product-count adjacency); the browse pages read only the tree.
      var categoryNavigation = (catalog && cart)
        ? bShop.categoryNavigation.create({ catalog: catalog })
        : null;

      // Recently viewed — the signed-in customer's browse history.
      // Views are recorded on the PDP and surfaced at
      // /account/recently-viewed. Composes the catalog handle for
      // product resolution.
      var recentlyViewed = (catalog && cart)
        ? bShop.recentlyViewed.create({ catalog: catalog })
        : null;

      // Stripe payment handle — shared by the admin refund + subscription
      // routes and the storefront subscription-cancel route, so there's
      // one Stripe client per boot. Wired only when both the API key and
      // webhook secret are present.
      var payment = (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET)
        ? bShop.payment.create({
            apiKey:        process.env.STRIPE_API_KEY,
            webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
          })
        : null;

      // Subscriptions — the recurring-offer catalog (/admin/subscription-
      // plans) plus the customer self-management surface
      // (/account/subscriptions). One instance shared by both: plan CRUD
      // + reads need only the DB; binding/canceling subscriptions composes
      // Stripe, so the shared payment handle is passed when it's wired.
      var subscriptions = (catalog && cart)
        ? bShop.subscriptions.create({ payment: payment })
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
        var order   = bShop.order.create({ cursorSecret: orderCursorSecret, webhooks: webhooks, loyaltyEarnRules: loyaltyEarnRules, referrals: referrals });
        // `payment` is the shared Stripe handle built at the top of the
        // routes function (null when Stripe isn't configured) — the
        // admin refund + subscription-cancel routes gate on it.
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
        // `subscriptions` is the shared instance built at the top of the
        // routes function — reused here for /admin/subscription-plans +
        // the admin cancel route, and by the storefront below.
        bShop.admin.mount(r, {
          token:         process.env.ADMIN_API_KEY,
          shop_name:     bootShopName,
          catalog:       catalog,
          order:         order,
          payment:       payment,
          config:        config,
          r2_bridge:     r2_bridge,
          catalogImport: catalogImport,
          reviews:       reviews,
          productQa:     productQa,
          returns:       returns,
          customers:     customers,
          subscriptions: subscriptions,
          giftcards:     giftcards,
          giftCardLedger: giftCardLedger,
          webhooks:      webhooks,
          collections:   collections,
          // Integration state map for /admin/integrations — "enabled" |
          // "action" (credentials present, a one-time operator action
          // still required) | "off". admin.js never reads process.env.
          // Stripe needs the publishable key too (the pay route hard-
          // fails without it). Wallets need Stripe AND a domain
          // registered with Stripe, which env can't attest — so they're
          // "action" (register your domain) once Stripe is ready, never
          // auto-"enabled".
          integrations: (function () {
            var stripeReady = !!(process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_PUBLISHABLE_KEY);
            var googleReady = !!(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.SHOP_ORIGIN);
            var appleReady  = !!(process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID &&
                                 process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY && process.env.SHOP_ORIGIN);
            // PayPal needs the credentials AND Stripe-backed checkout to be
            // live (checkout mounts under Stripe today), AND a webhook id +
            // the storefront button — so "action" once configured, not auto-on.
            var paypalReady = !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET && stripeReady);
            return {
              stripe:           stripeReady ? "enabled" : "off",
              express_checkout: stripeReady ? "action"  : "off",
              google_signin:    googleReady ? "enabled" : "off",
              apple_signin:     appleReady  ? "enabled" : "off",
              paypal:           paypalReady ? "action"  : "off",
            };
          })(),
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
        var sfDeps = { catalog: catalog, cart: cart, config: { shop_name: bootShopName } };
        if (sfTheme) sfDeps.theme = sfTheme;
        // Customer accounts — opts the /account/* routes in. Reuses the
        // single `customers` instance built above (also wired into the
        // admin roster), so both surfaces share one handle.
        sfDeps.customers = customers;
        // Sign in with Google (OIDC). Mounts the /account/login/google
        // routes only when the operator supplies the OAuth client +
        // SHOP_ORIGIN (for the exact redirect URI). The framework
        // adapter owns discovery + PKCE + ID-token verification.
        if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET && process.env.SHOP_ORIGIN) {
          try {
            sfDeps.oauthGoogle = b.auth.oauth.create({
              provider:     "google",
              clientId:     process.env.GOOGLE_OAUTH_CLIENT_ID,
              clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
              redirectUri:  process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/account/auth/google/callback",
            });
          } catch (_e) { /* misconfigured — leave Google sign-in disabled */ }
        }
        // Sign in with Apple (OIDC). Apple's OAuth client secret is itself
        // an ES256 JWT signed with the team's .p8 key — minted here at
        // boot from APPLE_TEAM_ID / APPLE_KEY_ID / APPLE_CLIENT_ID (the
        // Services ID) / APPLE_PRIVATE_KEY (.p8 PEM). The minted secret
        // lasts 150 days; a redeploy re-mints it well inside Apple's
        // 6-month ceiling. Apple posts the callback back (form_post), which
        // the storefront's POST /account/auth/apple/callback handles.
        if (process.env.APPLE_TEAM_ID && process.env.APPLE_KEY_ID &&
            process.env.APPLE_CLIENT_ID && process.env.APPLE_PRIVATE_KEY && process.env.SHOP_ORIGIN) {
          try {
            sfDeps.oauthApple = b.auth.oauth.create({
              provider:     "apple",
              clientId:     process.env.APPLE_CLIENT_ID,
              clientSecret: bShop.customers.mintAppleClientSecret({
                team_id:     process.env.APPLE_TEAM_ID,
                key_id:      process.env.APPLE_KEY_ID,
                client_id:   process.env.APPLE_CLIENT_ID,
                // The .p8 is multi-line PEM; allow \n-escaped single-line
                // env values (common in CI secret stores) too.
                private_key: process.env.APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
              }),
              redirectUri:  process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/account/auth/apple/callback",
            });
          } catch (_e) { /* misconfigured .p8 / IDs — leave Apple sign-in disabled */ }
        }
        // Newsletter signups — opts the /newsletter route in. The
        // primitive only needs the externalDb query handle (which
        // ships with this deploy via D1_BRIDGE_URL).
        sfDeps.newsletter = bShop.newsletter.create({});
        // Reviews display + submit. The submit route gates on a verified
        // purchase, which needs order reads — wire an order handle here
        // regardless of Stripe (order reads don't touch the payment SDK).
        // The checkout block below reuses this same handle.
        if (reviews) sfDeps.reviews = reviews;
        if (productQa) sfDeps.productQa = productQa;
        if (wishlist) sfDeps.wishlist = wishlist;
        if (saveForLater) sfDeps.saveForLater = saveForLater;
        if (addresses) sfDeps.addresses = addresses;
        if (returns) sfDeps.returns = returns;
        if (collections) sfDeps.collections = collections;
        if (categoryNavigation) sfDeps.categoryNavigation = categoryNavigation;
        if (recentlyViewed) sfDeps.recentlyViewed = recentlyViewed;
        if (recommendations) sfDeps.recommendations = recommendations;
        // Subscription self-management (/account/subscriptions) — the
        // shared instance. The list renders read-only without payment;
        // the cancel route mounts only when `sfDeps.payment` is wired
        // (set in the Stripe block below).
        if (subscriptions) sfDeps.subscriptions = subscriptions;
        // Gift cards — the customer balance-check page (/gift-cards) and
        // the redeem-at-checkout credit. Wired regardless of Stripe; the
        // balance page needs only the card primitive.
        if (giftcards) sfDeps.giftcards = giftcards;
        // Loyalty — the /account/loyalty page (balance + ledger + earn
        // rules + reward catalog), the redeem-a-reward action, and the
        // redeem-points-at-checkout credit. The earn-on-purchase award
        // is wired into the order primitive below (it fans the paid
        // transition into the earn rules), not into the storefront.
        if (loyalty) sfDeps.loyalty = loyalty;
        if (loyaltyEarnRules) sfDeps.loyaltyEarnRules = loyaltyEarnRules;
        if (loyaltyRedemption) sfDeps.loyaltyRedemption = loyaltyRedemption;
        // Referrals — the /account/referrals page (the customer's code +
        // shareable link, the friends they've referred + status, and the
        // rewards funnel), the /r/<code> attribution landing, and the
        // in-account top-referrer leaderboard. The reward-on-first-order
        // credit is wired into the order primitive below (it fans the paid
        // transition into referrals.trackPurchase), not into the storefront.
        // SHOP_ORIGIN gives the absolute shareable link; absent it, the
        // route falls back to the request Host header.
        if (referrals) sfDeps.referrals = referrals;
        if (referralLeaderboard) sfDeps.referralLeaderboard = referralLeaderboard;
        if (process.env.SHOP_ORIGIN) sfDeps.shop_origin = process.env.SHOP_ORIGIN;
        sfDeps.order = bShop.order.create({ cursorSecret: orderCursorSecret, webhooks: webhooks, loyaltyEarnRules: loyaltyEarnRules, referrals: referrals });
        if (process.env.STRIPE_API_KEY && process.env.STRIPE_WEBHOOK_SECRET) {
          var sfOrder = sfDeps.order;
          // Reuse the shared Stripe handle (built at the top of the routes
          // function under the same gate) so the storefront checkout +
          // subscription-cancel routes and the admin routes drive one
          // Stripe client per boot.
          var sfPayment = payment;
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
          // PayPal (Orders v2) adapter — wired when the operator supplies a
          // PayPal app's credentials. Distinct from Stripe; checkout exposes
          // create/capture/webhook PayPal methods only when this is present.
          // PAYPAL_ENV=live uses the production API; anything else is sandbox.
          var sfPaypal = null;
          if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
            try {
              sfPaypal = bShop.payment.create({
                adapter:   "paypal",
                clientId:  process.env.PAYPAL_CLIENT_ID,
                secret:    process.env.PAYPAL_SECRET,
                sandbox:   process.env.PAYPAL_ENV !== "live",
                webhookId: process.env.PAYPAL_WEBHOOK_ID || undefined,
              });
            } catch (_e) { sfPaypal = null; } // misconfigured — leave PayPal disabled
          }
          var sfCheckout = bShop.checkout.create({
            catalog: catalog, cart: cart, pricing: bShop.pricing,
            tax: sfTax, shipping: sfShipping, payment: sfPayment, order: sfOrder,
            customers: sfDeps.customers, paypal: sfPaypal,
            giftcards: giftcards, giftCardLedger: giftCardLedger,
            loyalty: loyalty,
          });
          sfDeps.payment           = sfPayment;
          sfDeps.paypal            = sfPaypal;
          sfDeps.paypal_client_id  = sfPaypal ? process.env.PAYPAL_CLIENT_ID : "";
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
