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

// ISO 3166-2 subdivision codes the shippingZones engine accepts (the
// country prefix stripped). The checkout ship_to.state field is wider
// (up to 5 chars) than a zone region (1-3), so a too-long / off-shape
// state is passed as a region-less lookup — country-only zones still
// match, and the engine never throws on an out-of-shape region.
var ZONE_REGION_RE = /^[A-Z0-9]{1,3}$/;

// Translate a checkout shipping ctx into shippingZones.rateFor params,
// run the lookup, and map any matching zone rows into the same
// { id, label, amount_minor } service shape the config-services
// adapter returns. Returns [] (so the caller falls back to the flat
// config-services table) when no zone covers the destination, no rate
// row matches, the cart currency can't be read, or the lookup throws.
//
// Pure read of operator-defined rate tables — it never reaches the
// order-total / tax / discount / payment math; it only sources the
// list of shipping services the shopper picks from. Any failure
// degrades to the fallback rather than surfacing a 5xx at the till.
async function _zoneShippingRates(shippingZones, ctx) {
  if (!shippingZones || !ctx || typeof ctx !== "object") return [];
  var shipTo = ctx.shipTo;
  if (!shipTo || typeof shipTo !== "object") return [];
  if (typeof shipTo.country !== "string") return [];

  // Currency rides on the cart lines (unit_currency), not on the ctx
  // root. Read it off the first line; absent a usable currency there's
  // nothing to match a zone rate against, so fall back.
  var lines = Array.isArray(ctx.lines) ? ctx.lines : [];

  // Mirror the flat adapter's digital-only gate (lib/shipping.js): a cart with
  // no shipping-requiring line must NOT be quoted physical zone rates. Return
  // empty so the fallback applies its digital-only (no-charge) path instead.
  var anyShippable = lines.some(function (l) {
    return l && (l.requires_shipping === undefined ? true : !!l.requires_shipping);
  });
  if (!anyShippable) return [];

  var currency = "";
  for (var ci = 0; ci < lines.length; ci += 1) {
    if (lines[ci] && typeof lines[ci].unit_currency === "string" && lines[ci].unit_currency) {
      currency = lines[ci].unit_currency.toUpperCase();
      break;
    }
  }
  if (!currency) return [];

  // Total parcel weight = sum of (per-variant weight * qty) over the
  // shipping-requiring lines. A line missing a weight contributes 0,
  // matching the flat-rate adapter's own weight accounting.
  var weightGrams = 0;
  for (var wi = 0; wi < lines.length; wi += 1) {
    var line = lines[wi];
    if (!line || line.requires_shipping === false) continue;
    var w = Number(line.weight_grams);
    var q = Number(line.qty);
    if (!isFinite(w) || w < 0) w = 0;
    if (!isFinite(q) || q < 1) q = 1;   // missing/degenerate qty defaults to 1, matching the flat adapter (l.qty || 1)
    weightGrams += Math.round(w) * Math.round(q);
  }

  var orderMinor = Number(ctx.subtotal_minor);
  if (!isFinite(orderMinor) || orderMinor < 0) orderMinor = 0;

  var region = (typeof shipTo.state === "string" && ZONE_REGION_RE.test(shipTo.state))
    ? shipTo.state
    : undefined;

  var rows;
  try {
    rows = await shippingZones.rateFor({
      destination_country: shipTo.country,
      destination_region:  region,
      weight_grams:        weightGrams,
      order_minor:         orderMinor,
      currency:            currency,
    });
  } catch (_e) {
    // Bad destination shape, out-of-range weight, or any engine error —
    // degrade to the config-services fallback, never a 5xx.
    return [];
  }
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // Map each zone rate row onto the checkout service shape. The id is
  // deterministic (zone slug + position in the already-sorted result)
  // so the same lookup re-run at confirm time resolves the shopper's
  // selected_shipping_id to the same rate.
  var out = [];
  for (var ri = 0; ri < rows.length; ri += 1) {
    var r = rows[ri];
    out.push({
      id:           "zone-" + r.zone_slug + "-" + ri,
      label:        r.service_label,
      amount_minor: r.rate_minor,
      free:         r.rate_minor === 0,
      jurisdiction: shipTo.country,
    });
  }
  return out;
}

async function main() {
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
    // Entropy floor on the bridge secret. The Worker route POST
    // /_/db/query is a single-statement SQL oracle on the live D1, and
    // the same secret authorizes /_/r2/put + /_/low-stock-alert, so a
    // weak/guessable secret hands an attacker the whole backend. Flag
    // anything shorter than 32 characters — the deploy recipe generates
    // `randomBytes(32).toString("base64url")` (43 chars), so a documented
    // deploy clears this comfortably. This is a loud boot WARNING rather
    // than a hard refusal: the live secret's length can't be verified out
    // of band at deploy time, so failing the boot on this check would risk
    // wedging an otherwise-healthy deploy. The warning keeps a weak secret
    // visible in the boot log; regenerate it to clear the warning.
    // Enforced only in production: local/e2e boot over http with short
    // test secrets and must keep working.
    if (process.env.NODE_ENV === "production" && process.env.D1_BRIDGE_SECRET.length < 32) {
      process.stderr.write(
        "[server] WARNING: D1_BRIDGE_SECRET is too short (" + process.env.D1_BRIDGE_SECRET.length +
        " chars) — it authorizes the worker DB/R2 bridge and should be at least 32 characters. " +
        "Regenerate with: node -e \"process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))\"\n",
      );
    }
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

  // i18n / locale routing — localises the storefront UI chrome (nav,
  // footer, search controls, newsletter band) + mounts the footer locale
  // switcher. The locale-router owns resolution (cookie / ?lang= /
  // Accept-Language / policy default); the translations primitive supplies
  // the chrome strings via b.i18n. Resolved here (before createApp, where
  // top-level await is available) and threaded into the storefront deps.
  // Wired only when the operator has seeded an active locale policy
  // (localeRouter.setActivePolicy) — absent that the storefront renders
  // the English baseline with no switcher, so a fresh deploy keeps working
  // with no extra configuration. Every read is best-effort: an unmigrated
  // locale / translations table degrades to English rather than blocking
  // boot. Resolution order matches the edge Worker (cookie → ?lang= →
  // Accept-Language → default) so both substrates agree.
  var localeWiring = null;
  if (catalog && cart) {
    try {
      var localeRouter = bShop.localeRouter.create({});
      var activePolicy = await localeRouter.activePolicy();
      if (activePolicy) {
        var defaultLocale = activePolicy.default_locale;
        var supportedLocales = activePolicy.supported_locales || [defaultLocale];
        // The switcher options: each supported tag + its display label
        // (the locale's autonym via Intl.DisplayNames, falling back to
        // the tag itself for an unrecognised tag).
        var localeList = supportedLocales.map(function (tag) {
          var label = tag;
          try {
            var dn = new Intl.DisplayNames([tag], { type: "language" });
            label = dn.of(tag) || tag;
          } catch (_e) { /* unknown tag — keep the tag as the label */ }
          return { tag: tag, label: label };
        });
        // Operator `ui`/`chrome` overrides for every supported locale,
        // layered over the shipped English baseline by b.i18n.
        var chromeOverrides = await bShop.translations.readChromeOverrides(
          function (sql, params) { return b.externalDb.query(sql, params); },
          supportedLocales
        );
        localeWiring = {
          localeRouter: localeRouter,
          chromeI18n:   bShop.translations.createChromeI18n({
            defaultLocale: defaultLocale,
            locales:       supportedLocales,
            overrides:     chromeOverrides,
          }),
          localeOptions: { defaultLocale: defaultLocale, locales: localeList },
        };
      }
    } catch (_e) { /* no locale policy / unmigrated table — English baseline */ }
  }

  var app = await b.createApp({
    dataDir: DATA_DIR,
    // Generous GLOBAL per-client-IP rate limit — the backstop against
    // credential / passkey spraying, gift-card balance brute-force,
    // checkout hammering, and unauthenticated row-flood writes. Keyed on
    // the real client IP (Cloudflare's cf-connecting-ip behind the
    // Worker, socket address for direct dev connections), NOT the socket
    // peer — behind the fabric every visitor shares the fabric's address,
    // so a socket-keyed global limit would throttle the whole store. The
    // tight per-route limiters + fetch-metadata gate mount inside routes()
    // below. createApp mounts this at the app level, ahead of routes().
    // createApp (v0.13.46+) wires several security middlewares ON by
    // default — cookies, CSP nonce, fetch-metadata, body parser, and CSRF.
    // The shop already mounts its OWN body parser (with the `text/csv`
    // sub-parser the admin CSV import needs) and fetch-metadata (configured
    // `allowMissing` + webhook exemptions), and mounts CSRF, inside routes()
    // below via `mountRouteGuards` — scoped so the edge-rendered, cookie-
    // less, dual-rendered forms are exempt. So disable createApp's app-level
    // duplicates and keep the shop's configured copies as the single source
    // of truth; `cspNonce` stays off to leave the existing strict-`'self'`
    // CSP unchanged. The cookie parser stays on (the scoped CSRF reads the
    // double-submit cookie through it). securityHeaders stays ON but drops
    // the inert Document-Policy header (the vendored default's legacy
    // feature tokens are unrecognized by current browsers — see
    // securityHeadersOpts); this also keeps the container header-consistent
    // with the edge, which sends no Document-Policy.
    middleware: {
      securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
      rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
      csrf:            false,
      bodyParser:      false,
      fetchMetadata:   false,
      cspNonce:        false,
    },
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

      // Request-lifecycle security guards — fetch-metadata (refuses
      // cross-site state-changing requests via Sec-Fetch-* without a
      // per-form token, the CSRF defense-in-depth on top of the
      // storefront's SameSite session cookie) + the tight per-client-IP
      // rate limiters on the abusable auth / POST endpoints (login,
      // passkey register, checkout, gift-card balance, register,
      // newsletter, review / question submit, survey). Both exempt the
      // payment webhook paths (cross-site by nature, HMAC-authenticated).
      // Mounted after bodyParser so the gate reads a fully-shaped request
      // and before any storefront / admin route.
      bShop.securityMiddleware.mountRouteGuards(r);

      // Liveness + readiness — the Worker short-circuits /_/health
      // at the edge, but the container also responds so the
      // container's own Docker HEALTHCHECK probe lights up before
      // the Worker is in the picture (local dev, smoke).
      r.get("/_/health", function (_req, res) {
        res.json({ ok: true, container: true });
      });

      // Abandoned-cart recovery — a scheduled pass that scans for carts
      // left idle past `shop.cart_recovery_after_hours` (default 4h),
      // enrolls the eligible ones (known customer + deliverable address
      // + no marketing-opt-out) into a multi-step nurture sequence, and
      // dispatches every step that has come due. The Worker cron POSTs
      // `/_/cart-recovery-tick` (below) once a minute; that handler runs
      // one bounded, drop-silent pass.
      //
      // Delivery is gated: the pass is INERT unless a mailer is wired
      // (SMTP_HOST + MAIL_FROM) AND a `resolveEmail` hook can turn a
      // cart's customer_id into a plaintext address. The customer record
      // stores only an email_hash (never the plaintext) and the carts
      // table carries no email column, so without an operator-supplied
      // resolver there is no deliverable address to recover — the pass
      // no-ops cleanly rather than scanning or sending. A guest cart
      // (no customer_id) likewise carries no address anywhere in the
      // schema and is skipped; guest-cart recovery re-opens the day a
      // guest checkout-email is persisted on the cart and fed through
      // the resolver.
      var cartRecoveryPass = null;
      if (catalog && cart) {
        // Build the transactional mailer only when the operator has
        // configured SMTP. Absent it, `recoveryEmail` stays null and the
        // pass gate keeps the cron quiet.
        var recoveryEmail = null;
        if (process.env.SMTP_HOST && process.env.MAIL_FROM) {
          var mailer = b.mail.create({
            transport: b.mail.transports.smtp({
              host: process.env.SMTP_HOST,
              port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT, 10) : 587,
              user: process.env.SMTP_USER || undefined,
              pass: process.env.SMTP_PASS || undefined,
            }),
            defaults: { from: process.env.MAIL_FROM },
          });
          recoveryEmail = bShop.email.create({ mailer: mailer });
        }

        // Operator-owned resolver: cart customer_id → deliverable
        // plaintext address. The default deploy has no plaintext-email
        // store (customers persist only the hash), so the stock resolver
        // returns null — which keeps the pass inert until an operator
        // wires their own address lookup here. Returning null is the
        // honest no-deliverable-address signal, not a silent failure.
        var recoveryResolveEmail = function (_candidate) {
          return Promise.resolve(null);
        };

        var recoveryEmailSuppressions = bShop.emailSuppressions.create({
          cursorSecret: process.env.D1_BRIDGE_SECRET
            ? b.crypto.namespaceHash("email-suppressions-cursor", process.env.D1_BRIDGE_SECRET)
            : "email-suppressions-cursor-dev-only",
        });

        // cart-abandonment's recentDetections paginates with an
        // HMAC-tagged cursor, so the primitive demands a cursorSecret in
        // production (it throws at boot otherwise). Derive it from the
        // bridge secret like every other shop cursor; the dev fallback
        // keeps local boots working.
        var abandonmentCursorSecret = process.env.D1_BRIDGE_SECRET
          ? b.crypto.namespaceHash("cart-abandonment-cursor", process.env.D1_BRIDGE_SECRET)
          : "cart-abandonment-cursor-secret-dev-only";

        cartRecoveryPass = bShop.cartRecoveryPass.create({
          cartAbandonment: bShop.cartAbandonment.create({
            cart:         cart,
            cursorSecret: abandonmentCursorSecret,
          }),
          cartRecovery:    bShop.cartRecovery.create({
            email:             recoveryEmail,
            emailSuppressions: recoveryEmailSuppressions,
          }),
          config:        bShop.config.create({}),
          consentLedger: bShop.consentLedger.create({}),
          cartUrlBase:   process.env.SHOP_ORIGIN
            ? process.env.SHOP_ORIGIN.replace(/\/$/, "") + "/cart"
            : null,
          resolveEmail:  recoveryResolveEmail,
        });
      }

      // Internal cron endpoint — the Worker's scheduled() handler POSTs
      // here once a minute over the SHOP service binding. Gated by the
      // shared D1_BRIDGE_SECRET header (same trust root as the SQL / R2
      // bridges) so a publicly-reachable URL can't drive the pass. The
      // pass itself is drop-silent (never throws); a failure surfaces as
      // `{ ok: false }` in the JSON body, not a 5xx that would mark the
      // cron run failed.
      r.post("/_/cart-recovery-tick", async function (req, res) {
        var got = req.headers && req.headers["x-d1-bridge-secret"];
        var want = process.env.D1_BRIDGE_SECRET || "";
        if (
          !want ||
          typeof got !== "string" ||
          got.length !== want.length ||
          !b.crypto.timingSafeEqual(got, want)
        ) {
          res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
          return;
        }
        if (!cartRecoveryPass) {
          res.json({ ok: true, enabled: false, reason: "cart recovery not composed (no catalog/cart)" });
          return;
        }
        var summary = await cartRecoveryPass.runPass();
        res.json(summary);
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

      // Multi-currency display — converts the catalog's base-currency
      // prices into the visitor's chosen currency for DISPLAY ONLY (the
      // cart / order / payment currency is unchanged). The FX-rate cache +
      // the per-currency display-rounding rule are read from D1 via the
      // externalDb handle this deploy already binds. Both primitives stay
      // resilient when their tables aren't migrated (degrade to base
      // display), so wiring them on a fresh deploy never breaks a priced
      // page. The operator's allow-list of display currencies (base first)
      // comes from `shop.currencies` config; absent it, no switcher
      // renders and every price stays in the base currency.
      var currencyDisplay  = (catalog && cart) ? bShop.currencyDisplay.create({}) : null;
      var currencyRounding = (catalog && cart) ? bShop.currencyRounding.create({}) : null;

      // Address book — per-customer saved addresses on /account/addresses.
      var addresses = (catalog && cart) ? bShop.addresses.create({}) : null;

      // Cookie consent — backs the GDPR / ePrivacy opt-in banner that
      // ships in the chrome of every storefront page, plus the /cookies
      // preference center and the POST /consent handler. The primitive is
      // the durable per-session audit ledger (hashed session id, per-
      // category decision, DNT / GPC honored); the storefront writes a
      // sealed first-party cookie as the runtime gate and records each
      // decision here for the audit trail. Only the externalDb query
      // handle is needed.
      var cookieConsent = (catalog && cart) ? bShop.cookieConsent.create({}) : null;

      // Returns — customer self-serve RMA requests (/account/returns) +
      // operator moderation (/admin/returns). Cursor HMAC key like the
      // others. Single instance shared by both surfaces.
      var returnsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("returns-cursor", process.env.D1_BRIDGE_SECRET)
        : "returns-cursor-secret-dev-only";
      var returns = (catalog && cart)
        ? bShop.returns.create({ cursorSecret: returnsCursorSecret })
        : null;

      // Support tickets — the customer-service ticketing surface. Opts in
      // the customer intake (/account/support) + the operator queue
      // (/admin/support). One instance shared by both surfaces. The
      // listForCustomer pagination cursor is HMAC-tagged, so the primitive
      // demands a cursorSecret in production (it throws at boot otherwise);
      // derive it from the bridge secret like every other shop cursor.
      var supportCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("support-tickets-cursor", process.env.D1_BRIDGE_SECRET)
        : "support-tickets-cursor-secret-dev-only";
      var supportTickets = (catalog && cart)
        ? bShop.supportTickets.create({ cursorSecret: supportCursorSecret })
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

      // Per-customer operator satellites surfaced on the customer detail
      // screen (/admin/customers/:id): the account-bound store-credit wallet
      // (grant / deduct, audited ledger), the operator-side CRM notes, and
      // the RFM segment membership (read-only — membership is rule-derived,
      // recomputed by the scheduler, not hand-assigned). Each defaults to the
      // externalDb bridge for its query handle; the two paginating primitives
      // derive an HMAC cursor key like the roster does.
      var storeCredit = (catalog && cart) ? bShop.storeCredit.create({}) : null;
      var customerNotesCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customer-notes-cursor", process.env.D1_BRIDGE_SECRET)
        : "customer-notes-cursor-secret-dev-only";
      var customerNotes = (catalog && cart)
        ? bShop.customerNotes.create({ cursorSecret: customerNotesCursorSecret })
        : null;
      var customerSegmentsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("customer-segments-cursor", process.env.D1_BRIDGE_SECRET)
        : "customer-segments-cursor-secret-dev-only";
      var customerSegments = (catalog && cart)
        ? bShop.customerSegments.create({ cursorSecret: customerSegmentsCursorSecret })
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

      // Order — the FSM-driven post-checkout record. ONE shared instance
      // drives the storefront account/order pages, the storefront checkout
      // confirm, and the admin console — so a transition fired from one
      // surface fans webhooks + loyalty + referrals identically regardless
      // of which surface triggered it. Built here (after webhooks /
      // loyaltyEarnRules / referrals exist) so both the admin block and the
      // storefront block reuse it instead of each standing up its own.
      var order = (catalog && cart)
        ? bShop.order.create({ cursorSecret: orderCursorSecret, webhooks: webhooks, loyaltyEarnRules: loyaltyEarnRules, referrals: referrals })
        : null;

      // Order tracking — the post-handoff shipment + carrier-event ledger.
      // Wired with the shared `order` instance so marking a shipment
      // delivered also drives the parent order's FSM to `delivered` without a
      // second operator call. Surfaced read-only on the customer order page
      // (status timeline + tracking link) and managed from the admin order
      // detail (attach a shipment, record carrier events). Boot stays
      // resilient: the instance is constructed unconditionally here, but
      // every route that reads it degrades to "no tracking yet" if the
      // shipments table hasn't been migrated.
      var orderTracking = (catalog && cart)
        ? bShop.orderTracking.create({ order: order })
        : null;

      // Fulfillment ops — the warehouse-side surfaces over the order +
      // shipment data. Pick lists consolidate open orders into an aisle-
      // sequenced picker route (composing order.get + orderTracking for
      // the on-complete shipment fan-out); shipping labels record a
      // carrier-minted label against a shipment; split shipments plan +
      // execute multi-parcel fulfillment (one orderTracking shipment per
      // parcel). All three only need the externalDb query handle plus the
      // shared order / orderTracking instances. Every admin route that
      // reads them degrades gracefully if the backing table is missing.
      var pickLists      = (catalog && cart && orderTracking)
        ? bShop.pickLists.create({ order: order, orderTracking: orderTracking })
        : null;
      var shippingLabels = (catalog && cart) ? bShop.shippingLabels.create({}) : null;
      var splitShipments = (catalog && cart && orderTracking)
        ? bShop.splitShipments.create({ order: order, orderTracking: orderTracking })
        : null;

      // Reporting + printable order documents — operator surfaces over the
      // existing order data. salesReports aggregates pure read-only SQL over
      // orders/order_lines for the /admin/reports screen; printReceipts +
      // packingSlips render print-optimized HTML documents for an order.
      // All three only need the externalDb query handle (+ the shared order
      // instance for the document renderers). The cursor HMAC key is derived
      // like the other primitives so production never falls back to the
      // dev-only placeholder.
      var salesReportsCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("sales-reports-cursor", process.env.D1_BRIDGE_SECRET)
        : "sales-reports-cursor-secret-dev-only";
      var salesReports  = (catalog && cart) ? bShop.salesReports.create({ cursorSecret: salesReportsCursorSecret }) : null;
      var printReceipts = (catalog && cart) ? bShop.printReceipts.create({ order: order }) : null;
      var packingSlips  = (catalog && cart) ? bShop.packingSlips.create({ order: order }) : null;

      // Gift cards — prepaid bearer balance redeemable at checkout, plus
      // the append-only ledger of credit/debit/expire events. The card
      // primitive owns the code + the balance snapshot; the ledger is
      // the audit trail surfaced in the admin console. Both only need
      // the externalDb query handle.
      var giftcards      = (catalog && cart) ? bShop.giftcards.create({}) : null;
      var giftCardLedger = (catalog && cart) ? bShop.giftCardLedger.create({}) : null;

      // Announcement bar — sitewide operator promo/notice strip. The
      // primitive resolves the highest-priority active announcement for a
      // viewer (theme rank urgency>promo>info>success) after audience +
      // dismissal gating; the storefront renders it as page-top chrome and
      // the admin console manages it. The console exposes the all / guest /
      // logged_in audiences; the primitive's segment audience needs an
      // isMember(customer_id, segment_slug) handle (the segments primitive
      // exposes segmentsForCustomer, not isMember) so it stays unexposed
      // until that adapter is wired — segment rows are simply not offered.
      var announcementBar = (catalog && cart) ? bShop.announcementBar.create({}) : null;

      // Customer surveys — token-gated NPS/CSAT/CES/custom feedback. The
      // storefront serves the token survey page (/survey/:token) + records
      // responses; the admin console defines surveys, issues invitations,
      // and reads the rollup. The invitation token is the access (no login).
      var customerSurveys = (catalog && cart) ? bShop.customerSurveys.create({}) : null;

      // Blog — operator-published editorial posts. The edge Worker serves
      // the customer-facing /blog index, /blog/:slug posts, the RSS feed,
      // and the sitemap entries, reading only published rows. The admin
      // console authors the posts: create as draft, edit, publish /
      // unpublish, archive / restore. A draft is invisible to the
      // storefront until it's published. Needs a cursor secret for the
      // published-list pagination, derived like the other primitives so
      // production never falls back to the dev-only placeholder.
      var blogCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("blog-articles-cursor", process.env.D1_BRIDGE_SECRET)
        : "blog-articles-cursor-secret-dev-only";
      var blog = (catalog && cart)
        ? bShop.blogArticles.create({ cursorSecret: blogCursorSecret })
        : null;

      // Knowledge base — the self-serve help center. The container serves
      // the customer-facing /help index + /help/:slug reader (reading only
      // published rows) and records the "was this helpful?" votes; the admin
      // console authors the articles: create as draft, edit, publish /
      // unpublish, archive. A draft / archived article is invisible to the
      // storefront. Needs a cursor secret for the article-list pagination,
      // derived like the other primitives so production never falls back to
      // the dev-only placeholder.
      var kbCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("knowledge-base-cursor", process.env.D1_BRIDGE_SECRET)
        : "knowledge-base-cursor-secret-dev-only";
      var knowledgeBase = (catalog && cart)
        ? bShop.knowledgeBase.create({ cursorSecret: kbCursorSecret })
        : null;

      // Storefront content pages — operator-authored Markdown documents
      // (About, Shipping, Returns, Privacy, Terms, the long tail every
      // shop needs) served at /pages/:slug. The edge Worker serves the
      // customer-facing page, reading only published rows; the admin
      // console authors them: create as draft, edit, publish / unpublish,
      // archive / restore. A draft is invisible to the storefront until
      // it's published.
      var storefrontPages = (catalog && cart) ? bShop.storefrontPages.create({}) : null;

      // Business hours — operator-defined open/close schedules surfaced on a
      // public /hours page (week grid + live open/closed) and managed from
      // the admin console. Timezone-aware; holidays + one-off exceptions
      // override the weekly base.
      var businessHours = (catalog && cart) ? bShop.businessHours.create({}) : null;

      // Recommendations — operator-curated overrides + co-purchase /
      // category-popular / in-stock signals. Composes the catalog handle;
      // powers the post-purchase "Customers also bought" rail.
      var recommendations = (catalog && cart) ? bShop.recommendations.create({ catalog: catalog }) : null;

      // Bundles — virtual kit SKUs surfaced on the PDP as a "Bundle &
      // save" rail with an atomic add-all-members action. Composes the
      // catalog handle (component SKUs resolve through it) + a cursor
      // secret for the operator-facing list. The storefront prices each
      // bundle server-side from the live catalog.
      var bundlesCursorSecret = process.env.D1_BRIDGE_SECRET
        ? b.crypto.namespaceHash("bundles-cursor", process.env.D1_BRIDGE_SECRET)
        : "bundles-cursor-secret-dev-only";
      var bundles = (catalog && cart)
        ? bShop.bundles.create({ catalog: catalog, cursorSecret: bundlesCursorSecret })
        : null;

      // Quantity discounts — automatic per-line price breaks ("buy 5,
      // save 10%"). Surfaced on the PDP as a quantity-break table and
      // applied server-side at cart render + checkout so the line +
      // cart totals reflect the break. Composes the catalog handle for
      // the sku-scope referential check.
      var quantityDiscounts = (catalog && cart)
        ? bShop.quantityDiscounts.create({ catalog: catalog })
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

      // Product compare — the side-by-side comparison basket behind the
      // PDP "Add to compare" toggle + the /compare table. The basket is
      // keyed on the storefront session cookie (namespace-hashed by the
      // primitive before it touches the database); a logged-in shopper's
      // customer_id rides alongside. compareTable resolves the attribute
      // matrix through this `catalog` adapter — `getProduct` returns the
      // product enriched with a `variants` array (the primitive's
      // variant-sourced attributes read `price_minor` / `weight` / `sku`
      // off the first variant) plus the current USD price, so the baked-in
      // price / sku / weight attributes resolve against this catalog's
      // column shape. A per-resolve failure degrades to a null product
      // (the table renders "—" / "no longer available"), never throws.
      var productCompare = (catalog && cart)
        ? bShop.productCompare.create({
            catalog: {
              getProduct: async function (productId) {
                var product = await catalog.products.get(productId);
                if (!product || product.status !== "active") return null;
                var variants = await catalog.variants.listForProduct(productId);
                var enrichedVariants = [];
                for (var vi = 0; vi < variants.length; vi += 1) {
                  var v = variants[vi];
                  var priceMinor = null;
                  var pr = await catalog.prices.current(v.id, "USD");
                  if (pr) priceMinor = pr.amount_minor;
                  enrichedVariants.push({
                    sku:         v.sku,
                    weight:      v.weight_grams,
                    price_minor: priceMinor,
                  });
                }
                return Object.assign({}, product, { variants: enrichedVariants });
              },
            },
          })
        : null;

      // Search synonyms — query rewriting (stopwords + typo correction
      // + stemming) and synonym expansion on the storefront search box.
      // One shared instance; the primitive caches the operator-curated
      // groups / typos / stopwords in memory and only needs the
      // externalDb query handle.
      var searchSynonyms = (catalog && cart) ? bShop.searchSynonyms.create({}) : null;

      // Search facets — filterable search-result chrome. The primitive
      // reads its facet registry off the DB (default externalDb query
      // handle) and computes counts in-memory against a per-request
      // product universe, so it's wired as a factory the storefront's
      // /search route calls with that request's catalog snapshot. This
      // keeps concurrent searches from sharing one catalog binding.
      var searchFacets = (catalog && cart)
        ? function (perRequestCatalog) { return bShop.searchFacets.create({ catalog: perRequestCatalog }); }
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
      // Customer + operator subscription lifecycle (pause / resume / skip /
      // change-quantity / change-frequency / reactivate) layered on the
      // shared `subscriptions` instance via its `.subscriptions` handle.
      // Self-management routes mount on /account/subscriptions; a missing /
      // unmigrated control table only surfaces when a route runs (degrades
      // to a notice), never at boot.
      var subscriptionControls = subscriptions
        ? bShop.subscriptionControls.create({ subscriptions: subscriptions.subscriptions })
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

      // Commerce-config primitives surfaced through the admin console:
      // the per-jurisdiction tax rate table, operator-defined shipping
      // zones, automatic (no-code) cart discounts, and the coupon-
      // stacking policies that gate code combination. All four compose
      // the default externalDb query handle (no cursor secret) and back
      // their own migrated tables; a missing / unmigrated table only
      // surfaces when the console route reads it (degrades to an empty
      // list / notice), never at boot.
      var taxRates       = (catalog && cart) ? bShop.taxRates.create({})       : null;
      var shippingZones  = (catalog && cart) ? bShop.shippingZones.create({})  : null;
      var autoDiscount   = (catalog && cart) ? bShop.autoDiscount.create({})   : null;
      var couponStacking = (catalog && cart) ? bShop.couponStacking.create({}) : null;
      // Per-line allocation of cart-level order discounts — back-office
      // bookkeeping that records how an order's discount split across its
      // lines, so a later partial refund knows each line's discounted
      // share. checkout writes a row post-commit (drop-silent) when an
      // order carried a discount; the admin console reads it back. A
      // missing / unmigrated table only surfaces when the console route
      // reads it (degrades to an empty list / notice), never at boot.
      var discountAllocation = (catalog && cart) ? bShop.discountAllocation.create({}) : null;

      // Sales tax filings — periodic remittance bookkeeping over completed
      // orders. Post-checkout reporting only: it reads orders that landed in
      // a filing window and re-derives the per-rate breakdown from the same
      // `taxRates` table the checkout reads, so the operator can reconcile
      // collected vs. owed tax and record the submission + payment to each
      // authority. Composes `taxRates` for the per-rate breakdown; a missing
      // sales_tax_filings table only surfaces when a console route reads it
      // (degrades to an empty list / notice), never at boot.
      var salesTaxFilings = (catalog && cart)
        ? bShop.salesTaxFilings.create({ taxRates: taxRates })
        : null;

      // Admin API — bearer-token-gated CRUD over catalog + orders +
      // refunds. Only mounts when ADMIN_API_KEY is present (operator
      // opts in by setting the secret). Stripe-backed refund routes
      // only mount when STRIPE_API_KEY is also present.
      if (catalog && cart && process.env.ADMIN_API_KEY) {
        // `order` is the shared FSM-driven record built at the top of the
        // routes function — reused here so an admin transition fans the same
        // webhooks / loyalty / referrals as a storefront-driven one.
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
          orderTracking: orderTracking,
          pickLists:      pickLists,
          shippingLabels: shippingLabels,
          splitShipments: splitShipments,
          salesReports:  salesReports,
          printReceipts: printReceipts,
          packingSlips:  packingSlips,
          payment:       payment,
          config:        config,
          r2_bridge:     r2_bridge,
          catalogImport: catalogImport,
          reviews:       reviews,
          productQa:     productQa,
          returns:       returns,
          supportTickets: supportTickets,
          customers:     customers,
          storeCredit:      storeCredit,
          customerNotes:    customerNotes,
          customerSegments: customerSegments,
          subscriptions: subscriptions,
          giftcards:     giftcards,
          giftCardLedger: giftCardLedger,
          webhooks:      webhooks,
          collections:   collections,
          announcementBar: announcementBar,
          customerSurveys: customerSurveys,
          blog:            blog,
          knowledgeBase:   knowledgeBase,
          storefrontPages: storefrontPages,
          businessHours:   businessHours,
          taxRates:        taxRates,
          shippingZones:   shippingZones,
          autoDiscount:    autoDiscount,
          couponStacking:  couponStacking,
          discountAllocation: discountAllocation,
          salesTaxFilings: salesTaxFilings,
          quantityDiscounts: quantityDiscounts,
          loyalty:           loyalty,
          loyaltyEarnRules:  loyaltyEarnRules,
          loyaltyRedemption: loyaltyRedemption,
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

        // i18n / locale routing — wired from the boot-time resolution
        // (`localeWiring`, built before createApp where `await` is
        // allowed). Present only when the operator has seeded an active
        // locale policy; absent that, the storefront renders the English
        // baseline with no switcher.
        if (localeWiring) {
          sfDeps.chromeI18n    = localeWiring.chromeI18n;
          sfDeps.localeRouter  = localeWiring.localeRouter;
          sfDeps.localeOptions = localeWiring.localeOptions;
        }
        // Reviews display + submit. The submit route gates on a verified
        // purchase, which needs order reads — wire an order handle here
        // regardless of Stripe (order reads don't touch the payment SDK).
        // The checkout block below reuses this same handle.
        if (reviews) sfDeps.reviews = reviews;
        if (productQa) sfDeps.productQa = productQa;
        if (wishlist) sfDeps.wishlist = wishlist;
        if (saveForLater) sfDeps.saveForLater = saveForLater;
        if (addresses) sfDeps.addresses = addresses;
        if (cookieConsent) sfDeps.cookieConsent = cookieConsent;
        if (returns) sfDeps.returns = returns;
        // Support tickets — the customer intake + thread (/account/support).
        if (supportTickets) sfDeps.supportTickets = supportTickets;
        if (collections) sfDeps.collections = collections;
        if (categoryNavigation) sfDeps.categoryNavigation = categoryNavigation;
        if (recentlyViewed) sfDeps.recentlyViewed = recentlyViewed;
        if (productCompare) sfDeps.productCompare = productCompare;
        if (recommendations) sfDeps.recommendations = recommendations;
        // Announcement bar — sitewide promo/notice chrome. The storefront
        // resolves + renders the active bar per request (page-top) and
        // mounts the dismiss route; the admin console manages the rows.
        if (announcementBar) sfDeps.announcementBar = announcementBar;
        // Customer surveys — the token survey page + response submit.
        if (customerSurveys) sfDeps.customerSurveys = customerSurveys;
        // Knowledge base — the public /help reader (index + article + vote).
        if (knowledgeBase) sfDeps.knowledgeBase = knowledgeBase;
        // Business hours — the public /hours page.
        if (businessHours) sfDeps.businessHours = businessHours;
        // Bundles + quantity discounts — the PDP "Bundle & save" rail +
        // atomic bundle add, and the quantity-break table + cart/checkout
        // repricing. Both price server-side from the live catalog.
        if (bundles) sfDeps.bundles = bundles;
        if (quantityDiscounts) sfDeps.quantityDiscounts = quantityDiscounts;
        // Search synonyms + facets — opt the /search route into query
        // expansion + filterable facet chrome. Synonyms is the shared
        // rewrite instance; facets is the per-request factory.
        if (searchSynonyms) sfDeps.searchSynonyms = searchSynonyms;
        if (searchFacets) sfDeps.searchFacets = searchFacets;
        // Subscription self-management (/account/subscriptions) — the
        // shared instance. The list renders read-only without payment;
        // the cancel route mounts only when `sfDeps.payment` is wired
        // (set in the Stripe block below).
        if (subscriptions) sfDeps.subscriptions = subscriptions;
        if (subscriptionControls) sfDeps.subscriptionControls = subscriptionControls;
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
        // Store credit — the read-only /account/credit wallet (balance +
        // expiring-soon callout + the credit/debit/expire ledger). The
        // SAME instance the admin customer-detail screen grants/deducts
        // against, so a customer sees exactly the balance the operator set.
        // The customer surface writes nothing; granting/deducting stays
        // operator-only on the admin console.
        if (storeCredit) sfDeps.storeCredit = storeCredit;
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
        // Reuse the shared order instance (also wired into the admin console)
        // so a transition fans webhooks / loyalty / referrals once, not twice.
        sfDeps.order = order;
        // Order tracking — the customer order page reads it for the shipment
        // status timeline + carrier tracking link. Optional: absent it (or
        // its table unmigrated), the order page renders without the panel.
        if (orderTracking) sfDeps.orderTracking = orderTracking;
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
              // Operator-defined shipping zones take precedence over the
              // flat config-services table WHEN a zone covers the
              // destination AND a rate row matches the (weight, order
              // value, currency) tuple. Anything else — no zones
              // defined, destination outside every zone, no matching
              // rate row, or any lookup error — falls through to the
              // config-services adapter unchanged, so a store with no
              // zones configured keeps its existing shipping quote.
              if (shippingZones) {
                var zoneServices = await _zoneShippingRates(shippingZones, ctx);
                if (zoneServices && zoneServices.length) {
                  return { services: zoneServices };
                }
              }
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
            loyalty: loyalty, quantityDiscounts: quantityDiscounts,
            autoDiscount: autoDiscount,
            discountAllocation: discountAllocation,
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
        // Multi-currency display wiring. The operator's display-currency
        // allow-list lives in `shop.currencies` config (base first); the
        // base settlement currency in `shop.base_currency` (default USD).
        // Resolved per request from the config primitive (30s read cache),
        // so an operator config change takes effect without a restart. The
        // switcher + display conversion only render when the allow-list
        // names >1 currency. SHOP_BASE_CURRENCY / SHOP_CURRENCIES env vars
        // seed the defaults when the operator hasn't written config rows.
        if (currencyDisplay) {
          var envBase = (process.env.SHOP_BASE_CURRENCY || "USD").toUpperCase();
          var envList = (process.env.SHOP_CURRENCIES || envBase)
            .split(",").map(function (s) { return s.trim().toUpperCase(); })
            .filter(function (s) { return /^[A-Z]{3}$/.test(s); });
          if (!envList.length) envList = [envBase];
          sfDeps.currencyDisplay          = currencyDisplay;
          sfDeps.currencyRounding         = currencyRounding;
          sfDeps.currency_base            = envBase;
          sfDeps.currency_display_options = envList;
          // Override per request from config rows when present (falls back
          // to the env-seeded defaults on a read miss / failure).
          sfDeps.currency_config = async function () {
            try {
              var base = await config.get("shop.base_currency", envBase);
              var list = await config.get("shop.currencies", envList);
              return {
                base:    (base || envBase).toUpperCase(),
                options: (Array.isArray(list) && list.length ? list : envList)
                  .map(function (c) { return String(c).toUpperCase(); }),
              };
            } catch (_e) {
              return { base: envBase, options: envList };
            }
          };
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
}

// Boot only when run as the entry point (`node server.js`). Requiring
// this file (the shipping-zone rate mapper is exercised in tests) must
// not start the listener.
if (require.main === module) {
  main().catch(function (err) {
    process.stderr.write("[server] failed to start: " + (err && err.message || err) + "\n");
    if (err && err.stack) process.stderr.write(err.stack + "\n");
    process.exit(1);
  });
}

module.exports = { _zoneShippingRates: _zoneShippingRates };
