"use strict";
/**
 * @module shop.storefront
 * @title  Storefront — server-rendered HTML for end customers
 *
 * @intro
 *   v1 ships a minimum viable storefront: read-only HTML routes
 *   for the home page (product list), the product detail page
 *   (PDP), and the cart view. Each renderer is a pure function
 *   returning an HTML string; `mount(router, deps)` wires the
 *   routes into a `b.router` instance and reads data via the
 *   provided catalog / cart primitives.
 *
 *   Templates are inline string templates with the same strict
 *   `{{var}}` renderer the email primitive uses — HTML-escaped
 *   substitution, refusal of unknown / unused placeholders at
 *   composition time. The full theme primitive (with file-backed
 *   templates via `b.template`, asset fingerprinting via
 *   `b.objectStore`, theme inheritance + override resolution) lands
 *   in v1.x; the inline shape exists so the storefront is
 *   demonstrable today.
 *
 *   POST routes (add-to-cart, checkout submit) land in the next
 *   patch alongside the Stripe Elements wiring — v0.0.8 is
 *   read-only HTML.
 */

var emailModule = require("./email");
var pricing      = require("./pricing");
var currencyDisplayModule = require("./currency-display");
var translationsModule = require("./translations");
var { AsyncLocalStorage } = require("node:async_hooks");   // allow:non-shop-require — Node-core per-request context (no npm dep); the framework itself composes it in db-role-context / log. No b.* request-context primitive exists to wrap it.

var b = require("./vendor/blamejs");

// Per-request locale context store. The storefront's locale middleware
// resolves the request's locale + chrome strings once and seeds this
// store; every `_wrap` call on the same request reads the resolved
// context back out without the ~30 renderers having to thread it through
// their opts. `enterWith` scopes the value to the request's async
// execution context (each inbound request runs its own `handle()` chain),
// so concurrent requests never see each other's locale. A renderer
// reached outside a request (a unit test calling `renderHome` directly)
// finds no store and falls back to the English baseline.
var _localeAls = new AsyncLocalStorage();

// Payment-webhook signatures (Stripe's HMAC, PayPal's, …) are computed over
// the EXACT raw request bytes, but the global JSON body-parser reparses and
// discards them. This middleware buffers the raw body for the given POST
// paths into `req.rawBody` BEFORE the body-parser runs, and pre-sets
// `req.body` so the parser short-circuits (its `req.body !== undefined`
// guard) instead of re-reading an already-drained stream. Mount it ahead of
// `b.middleware.bodyParser()`; the webhook handlers read `req.rawBody`.
function webhookRawBodyCapture(paths) {
  var pathSet = {};
  (paths || []).forEach(function (p) { pathSet[p] = true; });
  // Compose the framework's raw body-parser (req.body ← a Buffer of the
  // exact request bytes) instead of hand-reading the stream — it already
  // honours the router's await/next contract and the byte-limit cap.
  // Scoped to the webhook paths and mounted ahead of the global JSON parser:
  // payment webhooks verify the signature over the raw body, which the JSON
  // parser would reparse + discard. The JSON parser then skips these paths
  // via its own `req.body !== undefined` guard.
  var rawParser = b.middleware.bodyParser.raw({
    limit:        b.constants.BYTES.mib(1),
    contentTypes: ["application/json", "application/*"],
  });
  return function (req, res, next) {
    var path = String(req.url || "").split("?")[0];
    if ((req.method || "").toUpperCase() !== "POST" || !pathSet[path]) return next();
    return rawParser(req, res, next);
  };
}

// Re-use the strict renderer from the email primitive (same shape,
// same XSS guard, same unknown / unused refusal).
var _render = emailModule._render;

// ---- shared layout ------------------------------------------------------

// Visual identity reference: the framework ships with two
// reference ecommerce templates (Lager + odor-buyer-file in
// .template/) — the layout below adopts odor's monochrome-plus-
// orange-accent palette (#191919 / #fa4f09 / #ffffff) and
// Montserrat headlines as the default theme. Customers fork the
// theme later by overriding LAYOUT + the per-page templates; the
// theme primitive (v1.x) makes that swap a per-directory drop-in.
//
// Brand assets live under R2 at `brand/<file>` — the layout
// references `/assets/brand/logo.png` which the Worker resolves to
// the bound R2 bucket. The 1536×1024 source PNG is committed
// only to .template/ (local-only) and uploaded once via
// `wrangler r2 object put`.

// Cookie-consent banner — present in the chrome of every page (both
// the container render below and each worker/render/*.js LAYOUT, kept
// byte-identical). GDPR (EU 2016/679 art. 6 + 7) + ePrivacy (2002/58/EC
// art. 5(3)) demand informed, specific, opt-in consent BEFORE any non-
// strictly-necessary cookie / tracker is set, with default-deny on the
// toggleable categories and a withdraw path. The banner is a plain
// server-rendered form that POSTs to /consent — it works with no client
// JS at all (essential-only browsing, accept, reject, and the granular
// preference center are all reachable JS-off).
//
// Because the storefront's read pages are edge-cached for cookie-less
// visitors (worker/index.js `_edgeRenderCached`), the banner can't be
// server-conditionally omitted on a cached page — the cached HTML is one
// document shared across visitors. So the banner ships in every document
// and the dismissal is cookie-driven on the client: the consent island
// (themes/default/assets/js/consent.js) reads the non-sealed
// `shop_consent_set` flag cookie and hides the banner when a choice
// already exists. The authoritative decision lives in the sealed
// `shop_consent` cookie + the cookie-consent ledger (server-side); the
// flag cookie is a non-authoritative "has decided" hint that only drives
// banner visibility. Nothing in this block reflects a visitor-supplied
// value, so there is no interpolation and no escape surface.
//
// `hidden` is the default visible state inversion: the dialog renders
// visible for a visitor with no decision (JS-off included). The island
// adds `data-consent-decided` to <html> and the CSS hides the dialog,
// so a returning visitor never sees it. A visitor with JS disabled who
// has already decided sees the banner again — but every control still
// works server-side, so they re-confirm rather than hit a dead end.
var CONSENT_BANNER =
  "  <div class=\"consent-banner\" id=\"consent-banner\" role=\"dialog\" aria-modal=\"false\" aria-labelledby=\"consent-title\" aria-describedby=\"consent-desc\">\n" +
  "    <div class=\"consent-banner__inner\">\n" +
  "      <div class=\"consent-banner__copy\">\n" +
  "        <h2 class=\"consent-banner__title\" id=\"consent-title\">Your privacy choices</h2>\n" +
  "        <p class=\"consent-banner__desc\" id=\"consent-desc\">We use strictly-necessary cookies to run the shop (your session, security tokens, and this choice itself). Optional cookies — functional, analytics, marketing, and preferences — are off until you turn them on. You can change this any time from <a href=\"/cookies\">Manage cookies</a>.</p>\n" +
  "      </div>\n" +
  "      <form class=\"consent-banner__actions\" method=\"post\" action=\"/consent\">\n" +
  "        <input type=\"hidden\" name=\"return_to\" value=\"/\" data-consent-return>\n" +
  "        <button type=\"submit\" name=\"choice\" value=\"accept_all\" class=\"btn-primary consent-banner__btn\">Accept all</button>\n" +
  "        <button type=\"submit\" name=\"choice\" value=\"reject\" class=\"btn-ghost consent-banner__btn\">Reject non-essential</button>\n" +
  "        <a class=\"consent-banner__manage\" href=\"/cookies\">Manage preferences</a>\n" +
  "      </form>\n" +
  "    </div>\n" +
  "  </div>\n";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"{{lang}}\" dir=\"{{dir}}\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{og_description}}\">\n" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <meta name=\"theme-color\" content=\"#08080a\">\n" +
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\"RAW_CSS_INTEGRITY>\n" +
  "  <meta property=\"og:type\" content=\"{{og_type}}\">\n" +
  "  <meta property=\"og:site_name\" content=\"{{shop_name}}\">\n" +
  "  <meta property=\"og:title\" content=\"{{og_title}}\">\n" +
  "  <meta property=\"og:description\" content=\"{{og_description}}\">\n" +
  "  <meta property=\"og:image\" content=\"{{og_image}}\">\n" +
  "  <meta property=\"og:url\" content=\"{{og_url}}\">\n" +
  "  <meta name=\"twitter:card\" content=\"summary_large_image\">\n" +
  "  <meta name=\"twitter:title\" content=\"{{og_title}}\">\n" +
  "  <meta name=\"twitter:description\" content=\"{{og_description}}\">\n" +
  "  <meta name=\"twitter:image\" content=\"{{og_image}}\">\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#main\">{{skip_to_content}}</a>\n" +
  "RAW_ANNOUNCEMENT_BAR" +
  "\n" +
  "  <div class=\"utility-bar\" role=\"complementary\">\n" +
  "    <div class=\"utility-bar__inner\">\n" +
  "      <span class=\"utility-bar__pill\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> {{util_pill}}</span>\n" +
  "      <span class=\"utility-bar__msg\">{{util_msg}}</span>\n" +
  "      <a class=\"utility-bar__link\" href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">{{util_star}}</a>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "\n" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\" aria-label=\"{{shop_name}}\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"></a>\n" +
  "      <form class=\"site-search\" action=\"/search\" method=\"get\" role=\"search\">\n" +
  "        <div class=\"site-search__inner\">\n" +
  "          <label for=\"site-search-q\" class=\"skip-link\">{{search_label}}</label>\n" +
  "          <svg class=\"site-search__icon\" viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M21 21l-4.35-4.35M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg>\n" +
  "          <input id=\"site-search-q\" type=\"search\" name=\"q\" value=\"{{search_q}}\" placeholder=\"{{search_placeholder}}\" autocomplete=\"off\" spellcheck=\"false\" maxlength=\"200\">\n" +
  "          <button type=\"submit\">{{search_submit}}</button>\n" +
  "        </div>\n" +
  "      </form>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <a class=\"site-nav__link\" href=\"/\">{{nav_shop}}</a>\n" +
  "        <a class=\"site-nav__link\" href=\"/#framework\">{{nav_framework}}</a>\n" +
  "        <a class=\"site-nav__icon\" href=\"/account\" aria-label=\"{{nav_account}}\"><svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" aria-hidden=\"true\"><path d=\"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg></a>\n" +
  "        <a class=\"cart-pill\" href=\"/cart\" aria-label=\"{{nav_cart_aria}}\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M3 4h2l2.4 12.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.95-1.55L21 8H6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"10\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/><circle cx=\"17\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/></svg><span class=\"cart-pill__count\">{{cart_count}}</span></a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "\n" +
  "  <main id=\"main\">{{body}}</main>\n" +
  "\n" +
  "  <section class=\"newsletter-band\" aria-labelledby=\"newsletter-title\">\n" +
  "    <div class=\"newsletter-band__inner\">\n" +
  "      <div class=\"newsletter-band__copy\">\n" +
  "        <p class=\"eyebrow eyebrow--on-dark\">{{newsletter_eyebrow}}</p>\n" +
  "        <h2 id=\"newsletter-title\">{{newsletter_title}}</h2>\n" +
  "        <p class=\"newsletter-band__lede\">{{newsletter_lede}}</p>\n" +
  "      </div>\n" +
  "      <form class=\"newsletter-band__form\" method=\"post\" action=\"/newsletter\">\n" +
  "        <label class=\"skip-link\" for=\"newsletter-email\">{{newsletter_email}}</label>\n" +
  "        <input id=\"newsletter-email\" type=\"email\" name=\"email\" required placeholder=\"you@example.com\" autocomplete=\"email\">\n" +
  "        <button type=\"submit\">{{newsletter_submit}}</button>\n" +
  "      </form>\n" +
  "    </div>\n" +
  "  </section>\n" +
  "\n" +
  "  <footer class=\"site-footer\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <div class=\"site-footer__brand-col\">\n" +
  "        <img class=\"site-footer__logo\" src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\">\n" +
  "        <p class=\"site-footer__tagline\">{{footer_tagline}}</p>\n" +
  "        <ul class=\"site-footer__social\" aria-label=\"Project links\">\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\" aria-label=\"GitHub\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.4-1.3-1.8-1.3-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2a11 11 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.3v3.4c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "          <li><a href=\"https://npmjs.com/package/blamejs\" rel=\"noopener\" aria-label=\"npm\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M2 7v10h6v-7h3v7h11V7H2Zm15 8h-2v-5h-3v5h-1V9h6v6Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "          <li><a href=\"/feed.xml\" aria-label=\"RSS feed\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M5 4v3a13 13 0 0 1 13 13h3A16 16 0 0 0 5 4Zm0 6v3a7 7 0 0 1 7 7h3a10 10 0 0 0-10-10Zm1 7a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z\" fill=\"currentColor\"/></svg></a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>{{footer_shop_heading}}</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/\">{{footer_shop_all}}</a></li>\n" +
  "          <li><a href=\"/collections\">{{footer_shop_collections}}</a></li>\n" +
  "          <li><a href=\"/categories\">{{footer_shop_categories}}</a></li>\n" +
  "          <li><a href=\"/?sort=new\">{{footer_shop_new}}</a></li>\n" +
  "          <li><a href=\"/?sort=sale\">{{footer_shop_sale}}</a></li>\n" +
  "          <li><a href=\"/compare\">{{footer_shop_compare}}</a></li>\n" +
  "          <li><a href=\"/cart\">{{footer_shop_cart}}</a></li>\n" +
  "          <li><a href=\"/terms\">{{footer_shop_shipping}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>{{footer_framework_heading}}</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">{{footer_framework_source}}</a></li>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs\" rel=\"noopener\">{{footer_framework_core}}</a></li>\n" +
  "          <li><a href=\"/SECURITY.md\">{{footer_framework_security}}</a></li>\n" +
  "          <li><a href=\"/CHANGELOG.md\">{{footer_framework_changelog}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h4>{{footer_operators_heading}}</h4>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/account\">{{footer_operators_account}}</a></li>\n" +
  "          <li><a href=\"/orders\">{{footer_operators_orders}}</a></li>\n" +
  "          <li><a href=\"mailto:hello@blamejs.shop\">{{footer_operators_contact}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "    </div>\n" +
    "    RAW_CURRENCY_SWITCHER\n" +
    "    RAW_LOCALE_SWITCHER\n" +
  "    <div class=\"site-footer__copy\">\n" +
  "      <p>&copy; {{year}} {{shop_name}} — {{footer_copy_suffix}}</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/SECURITY.md\">{{footer_legal_security}}</a></li>\n" +
  "        <li><a href=\"/privacy\">{{footer_legal_privacy}}</a></li>\n" +
  "        <li><a href=\"/terms\">{{footer_legal_terms}}</a></li>\n" +
  "        <li><a href=\"/cookies\">{{footer_legal_cookies}}</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  CONSENT_BANNER +
  "RAW_CONSENT_SCRIPT" +
  "RAW_CART_COUNT_SCRIPT" +
  "RAW_ANNOUNCEMENT_SCRIPT" +
  "</body>\n" +
  "</html>\n";

// Default theme stylesheet URL. Operators pass `opts.theme_css` (or
// `opts.theme.assetUrl("css/main.css")` via the theme primitive) on
// each render call to override; absent that, every storefront page
// references the shipped default theme — so a fresh install renders
// styled out of the box without any wiring.
// Asset integrity + fingerprint + version manifest — sha384 digests and
// content-fingerprinted paths, baked at build time
// (scripts/generate-asset-manifest.js) and committed. Read here instead of
// hashing the files at render time so the integrity attribute and the
// fingerprinted URL are present in every runtime, including the container
// image and the edge Worker, neither of which ships the theme asset files
// to hash live. See lib/asset-manifest.json.
var _assetManifest = require("./asset-manifest.json");

// Content-fingerprinted asset URL — `/assets/themes/default/<fingerprinted>`,
// where the fingerprint embeds a hash of the asset bytes (`main.<hash>.css`).
// The hash IS the cache-buster, so no `?v=` query is appended: each URL maps
// one-to-one onto a byte-content. This makes the Worker/R2 deploy order
// irrelevant — a not-yet-synced asset 404s instead of poisoning SRI, and
// pages already in flight keep loading the old fingerprinted object that
// still exists in R2. An asset missing from the manifest (a custom operator
// theme whose bytes aren't ours to hash) falls back to its plain path.
function _assetUrl(relUnderThemeAssets) {
  var entry = _assetManifest.assets[relUnderThemeAssets];
  var fp    = (entry && entry.fingerprinted) || relUnderThemeAssets;
  return "/assets/themes/default/" + fp;
}

// The default theme stylesheet ships from R2 at its fingerprinted path.
var DEFAULT_THEME_CSS_URL = _assetUrl("css/main.css");

// Footer copyright year — resolved once at module load. It's a near-static
// value (changes once a year); a `new Date()` allocation on every page
// render was wasteful. Containers are long-lived and restart often enough
// that a year-boundary staleness window doesn't matter for a copyright line.
var _COPYRIGHT_YEAR = String(new Date().getUTCFullYear());

// Client "island" scripts are served as external assets (fingerprinted, same
// as the CSS), never inline — the storefront's strict `script-src 'self'`
// CSP blocks inline <script>, so an inline island silently fails in
// production. `'self'` allows these /assets/ files; the R2 asset sync
// (npm run sync-assets) uploads them alongside the stylesheets.

// Subresource Integrity for the static assets — the browser refuses to
// run/apply a resource whose served bytes don't match (defense against an
// R2/edge compromise or on-path injection). The sha384 digest (W3C SRI
// 1.0) is read from the build-time manifest keyed by the path under the
// default theme's asset root; an absent key (a custom operator theme,
// whose bytes aren't ours to hash) yields no attribute. Same-origin, so
// no `crossorigin` is required for the check to run.
function _assetSri(relUnderThemeAssets) {
  var entry = _assetManifest.assets[relUnderThemeAssets];
  return (entry && entry.integrity) || null;
}
function _islandScript(name, opts) {
  var sri = _assetSri("js/" + name);
  // Optional `id` (so an island can find its own <script> at runtime) and
  // `policy` (the active consent policy version, stamped for the consent
  // island to compare against the flag cookie). Both are charset-safe by
  // construction at the call site, so they go in without escaping.
  var idAttr     = (opts && opts.id)     ? " id=\"" + opts.id + "\"" : "";
  var policyAttr = (opts && opts.policy) ? " data-consent-policy=\"" + opts.policy + "\"" : "";
  return "<script" + idAttr + " src=\"" + _assetUrl("js/" + name) + "\"" +
    (sri ? " integrity=\"" + sri + "\"" : "") + " defer" + policyAttr + "></script>";
}

// ---- announcement bar --------------------------------------------------
//
// Sitewide operator promo/notice strip rendered at the top of every page
// (this container render + the worker/render/*.js LAYOUT mirror it). The
// active row is resolved per request from a short-TTL in-memory cache of
// the active announcements — NOT a per-request DB read — because the bar
// is page-top chrome on every route and the active set changes rarely
// (operator-managed). The cache is refreshed out-of-band (fire-and-forget)
// so a request never blocks on it; resolution is synchronous, which is why
// it can run in the same sync middleware that seeds the locale context
// (an async middleware's `enterWith` would not reach the handler).
//
// Dismissal mirrors the consent banner: the bar is always server-rendered;
// the `announcement.js` island hides any bar whose slug is listed in the
// plain `shop_ann_dismissed` cookie and sets that cookie on dismiss. A
// no-JS POST /announcements/:slug/dismiss records the durable dismissal +
// sets the same cookie. The cookie-driven hide is what keeps a dismissed
// bar from reappearing on an edge-cached page (the slug is in the markup;
// the island removes it client-side per the visitor's cookie).
var ANNOUNCEMENT_DISMISS_COOKIE = "shop_ann_dismissed";
var _BAR_THEME_RANK = { urgency: 3, promo: 2, info: 1, success: 0 };
var _BAR_TTL_MS = 30000;
var _annCache = { rows: [], at: 0, inflight: false };

// Refresh the active-announcement cache if it's older than the TTL. Async
// + fire-and-forget: the caller never awaits it, so a slow D1 read can't
// stall a page render — the request resolves against whatever the cache
// last held (empty on a cold first request, then populated within the TTL).
function _refreshAnnouncementCache(announcementBar) {
  if (!announcementBar) return;
  var now = Date.now();
  if (_annCache.inflight) return;
  if (now - _annCache.at < _BAR_TTL_MS && _annCache.at !== 0) return;
  _annCache.inflight = true;
  Promise.resolve()
    .then(function () { return announcementBar.listAnnouncements({ active_only: true }); })
    .then(function (rows) { _annCache.rows = Array.isArray(rows) ? rows : []; _annCache.at = Date.now(); })
    .catch(function () { /* drop-silent — keep serving the prior cache */ })
    .then(function () { _annCache.inflight = false; });
}

// Synchronous pick over the cached active rows: drop announcements whose
// audience the viewer doesn't match (segment is never matched here — the
// console doesn't offer it) and return the highest theme-rank survivor
// (urgency > promo > info > success), ties broken by the cache's own order
// (updated_at DESC, slug ASC from listAnnouncements).
//
// Dismissal is NOT filtered here: the bar is rendered identically for every
// viewer of an audience (so an edge-cached response is correct for all) and
// the announcement island hides any bar whose slug is in the visitor's
// `shop_ann_dismissed` cookie — exactly the consent-banner pattern. This
// keeps the container + edge renders byte-identical and the shared edge
// cache key (URL) sound.
function _resolveActiveAnnouncement(viewerKind) {
  var rows = _annCache.rows;
  if (!rows || !rows.length) return null;
  var best = null;
  var bestRank = -1;
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (row.audience === "logged_in" && viewerKind !== "logged_in") continue;
    if (row.audience === "guest"     && viewerKind !== "guest")     continue;
    if (row.audience === "segment") continue;
    var rank = _BAR_THEME_RANK[row.theme];
    if (rank == null) rank = -1;
    if (rank > bestRank) { best = row; bestRank = rank; }
  }
  return best;
}

// Parse the plain `shop_ann_dismissed` cookie into an array of slugs. The
// cookie is a comma-separated slug list (slugs are [a-z0-9-], so no
// escaping is needed); anything that isn't a well-shaped slug is ignored.
function _readDismissedSlugs(req) {
  var raw = _readCookie(req, ANNOUNCEMENT_DISMISS_COOKIE);
  if (!raw || typeof raw !== "string") return [];
  var out = [];
  var parts = raw.split(",");
  for (var i = 0; i < parts.length; i += 1) {
    var s = parts[i].trim();
    if (s && /^[a-z0-9-]{1,64}$/.test(s) && out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

// Render the bar markup for a hydrated announcement row. Returns "" for a
// null row so a no-announcement page renders unchanged. `currentColor`-free
// — the theme color comes from the `--<theme>` modifier class in main.css.
function _buildAnnouncementBar(row) {
  if (!row) return "";
  var esc = function (s) { return b.template.escapeHtml(String(s == null ? "" : s)); };
  var theme = _BAR_THEME_RANK[row.theme] != null ? row.theme : "info";
  var slug  = esc(row.slug);
  var link  = "";
  if (row.link_url && row.link_label) {
    // Defense-in-depth at the href sink: only emit the link for an https://
    // URL or a /-rooted absolute path (not protocol-relative `//`). The
    // lib's `_linkUrl` already enforces exactly this at write time, but
    // re-checking here means a `javascript:` / `data:` scheme can never
    // reach the rendered href even if a row ever arrived by another path —
    // HTML-escaping alone does not neutralise those schemes.
    var href = String(row.link_url);
    if (/^https:\/\//i.test(href) || (href.charAt(0) === "/" && href.charAt(1) !== "/")) {
      link = " <a class=\"announcement-bar__link\" href=\"" + esc(href) + "\">" + esc(row.link_label) + "</a>";
    }
  }
  var dismiss = "";
  if (row.dismissible) {
    dismiss =
      "<form class=\"announcement-bar__dismiss\" method=\"post\" action=\"/announcements/" + slug + "/dismiss\">" +
        "<input type=\"hidden\" name=\"return_to\" value=\"/\" data-announcement-return>" +
        "<button type=\"submit\" class=\"announcement-bar__x\" aria-label=\"Dismiss this announcement\">&times;</button>" +
      "</form>";
  }
  return "<aside class=\"announcement-bar announcement-bar--" + theme + "\" role=\"region\" aria-label=\"Store announcement\" data-announcement-slug=\"" + slug + "\">" +
           "<div class=\"announcement-bar__inner\">" +
             "<p class=\"announcement-bar__msg\">" + esc(row.message) + link + "</p>" +
             dismiss +
           "</div>" +
         "</aside>";
}

// Multi-currency display switcher — a GET form in the footer listing the
// operator's display currencies. Selecting one POSTs to /currency, which
// sets the sealed `shop_ccy` cookie and redirects back. The currently
// selected currency is pre-checked. Absent a presenter (feature not
// wired) the whole block is empty so older deploys render unchanged.
// `currencies` is the operator's allow-list; `selected` is the active
// display currency; `note` is the "charged in <base>" disclosure (present
// only when a non-base currency is active).
function _buildCurrencySwitcher(opts) {
  if (!opts || !Array.isArray(opts.currencies) || opts.currencies.length < 2) return "";
  var esc = function (s) { return b.template.escapeHtml(String(s)); };
  var selected = opts.selected || opts.currencies[0];
  var options = opts.currencies.map(function (c) {
    var sel = c === selected ? " selected" : "";
    return "<option value=\"" + esc(c) + "\"" + sel + ">" + esc(c) + "</option>";
  }).join("");
  // GET-action would expose the choice in the URL + cache key; a POST
  // keeps it in the sealed cookie and bypasses the edge cache via the
  // 303 redirect. `redirect_to` carries the current path so the visitor
  // lands back where they were. The form auto-submits via the island
  // script when present; without JS the explicit "Set" button submits.
  var noteHtml = opts.note
    ? "<p class=\"currency-switcher__note\">" + esc(opts.note) + "</p>"
    : "";
  return "<div class=\"currency-switcher\">\n" +
    "      <form class=\"currency-switcher__form\" method=\"post\" action=\"/currency\">\n" +
    "        <input type=\"hidden\" name=\"redirect_to\" value=\"" + esc(opts.redirect_to || "/") + "\">\n" +
    "        <label class=\"currency-switcher__label\" for=\"currency-select\">Display currency</label>\n" +
    "        <select id=\"currency-select\" name=\"currency\" class=\"currency-switcher__select\" data-currency-switcher>" + options + "</select>\n" +
    "        <button type=\"submit\" class=\"currency-switcher__btn\">Set</button>\n" +
    "      </form>\n" +
    "      " + noteHtml + "\n" +
    "    </div>";
}

// The per-request price formatter a renderer uses for every displayed
// price. When the route handler resolved a display-currency presenter and
// threaded it in as `opts.format_price`, that's used (it converts base →
// display currency + applies the display rounding rule). Otherwise the
// renderer falls back to `pricing.format` — identical to pre-feature
// behaviour, so an un-wired store or any renderer the route handler
// didn't thread keeps formatting in the catalog currency.
function _priceFormatter(opts) {
  return (opts && typeof opts.format_price === "function") ? opts.format_price : pricing.format;
}

// Lift the currency-switcher fields off a renderer's opts so they reach
// `_wrap` unchanged. Keeps the per-renderer `_wrap` call sites short.
function _currencyWrapOpts(opts) {
  return {
    currency_options:     opts.currency_options,
    currency_selected:    opts.currency_selected,
    currency_note:        opts.currency_note,
    currency_redirect_to: opts.currency_redirect_to,
  };
}

// Default locale context — the English chrome baseline, `lang="en"`,
// `dir="ltr"`, no switcher. Any page rendered without a resolved
// `locale_ctx` (an internal renderer that doesn't thread one, a deploy
// with no locale policy) falls back to this, so the chrome is always
// complete English — never a raw `{{key}}` and never a 500. The cart
// aria carries a literal `{count}` here because the baseline isn't tied
// to a request; `_wrap` interpolates the real count below.
var _DEFAULT_LOCALE_CTX = {
  lang:        "en",
  dir:         "ltr",
  chrome:      translationsModule.chromeDefaults(),
  switcher_html: "",
};

// Derive the absolute canonical + og:url for a request. Origin comes from
// the `Host` header the same way robots.txt/sitemap.xml resolve it (https
// is the only scheme the storefront serves on); the path is the request
// path. `canonical_url` strips the query (the canonical names the page,
// not a filtered/sorted view); `og_url` keeps the full URL so a share of
// a filtered listing unfurls to that exact view. A request with no Host
// header yields empty strings — the renderer then omits the absolute URLs
// rather than emit a host-less one. Defensive request-shape reader:
// returns defaults on any malformed input.
function _requestUrls(req) {
  var host = (req && req.headers && (req.headers.host || req.headers.Host)) || "";
  if (!host) return { canonical_url: "", og_url: "" };
  var origin = "https://" + host;
  var rawUrl = (req && typeof req.url === "string" && req.url.length) ? req.url : "/";
  // req.url may be path-only ("/products/x?y=1") or absolute; normalise
  // through URL with the derived origin as the base so either shape works.
  var path = "/";
  var search = "";
  try {
    var parsed = new URL(rawUrl, origin);
    path = parsed.pathname || "/";
    search = parsed.search || "";
  } catch (_e) {
    var qIdx = rawUrl.indexOf("?");
    path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
    search = qIdx === -1 ? "" : rawUrl.slice(qIdx);
    if (path.charCodeAt(0) !== 47 /* "/" */) path = "/";
  }
  return { canonical_url: origin + path, og_url: origin + path + search };
}

function _wrap(opts) {
  var themeCss = (opts && typeof opts.theme_css === "string" && opts.theme_css.length)
    ? opts.theme_css
    : DEFAULT_THEME_CSS_URL;
  // SRI for the stylesheet — only for the default theme CSS we ship (and
  // can hash); a custom operator-supplied `theme_css` is their asset with
  // an unknown body, so it's left without an integrity attribute.
  var cssSri = (themeCss === DEFAULT_THEME_CSS_URL) ? _assetSri("css/main.css") : null;
  var themeCssIntegrity = cssSri ? " integrity=\"" + cssSri + "\"" : "";
  // OpenGraph / Twitter Card defaults — every page sets reasonable
  // fallbacks; per-page renderers (PDP, etc.) can override via
  // `opts.og_*` for a product-specific share preview.
  var shopName = opts.shop_name || "blamejs.shop";
  var ogType        = opts.og_type        || "website";
  var ogTitle       = opts.og_title       || (opts.title ? opts.title + " — " + shopName : shopName);
  var ogDescription = opts.og_description || "Open-source ecommerce framework built on blamejs. Server-rendered HTML, post-quantum crypto, zero npm runtime dependencies.";
  var ogImage       = opts.og_image       || "/assets/brand/logo.png";
  // Absolute request URL drives both `og:url` (full URL incl. query) and
  // the canonical link (query stripped — the canonical names the page,
  // not the filtered/sorted view). Renderers thread `opts.canonical_url`
  // + `opts.og_url` (built by `_requestUrls` in the route handler); absent
  // them (a unit test calling the renderer directly), both stay empty
  // rather than emit a bogus host-less URL.
  var canonicalUrl = opts.canonical_url || "";
  var ogUrl         = opts.og_url       || canonicalUrl;
  // Multi-currency display switcher — populated only when the operator
  // configured >1 display currency (opts.currency_options). The block is
  // empty otherwise, so a single-currency store renders unchanged.
  var switcherHtml = _buildCurrencySwitcher({
    currencies:  opts.currency_options,
    selected:    opts.currency_selected,
    note:        opts.currency_note,
    redirect_to: opts.currency_redirect_to,
  });

  // Locale context — resolved per request by the storefront's locale
  // middleware and read back from the async-local store; an explicit
  // `opts.locale_ctx` (a renderer that threads its own) takes precedence.
  // Absent both, the English baseline applies. The chrome strings are
  // HTML-escaped by `_render` per substitution like every other
  // placeholder; the switcher form is raw HTML (already escaped at its
  // own build site) so it's spliced post-render like the body.
  var storeCtx = _localeAls.getStore();
  var localeCtx = (opts.locale_ctx && opts.locale_ctx.chrome)
    ? opts.locale_ctx
    : ((storeCtx && storeCtx.chrome) ? storeCtx : _DEFAULT_LOCALE_CTX);
  // Announcement bar — the active row is resolved by the sync request
  // middleware and carried on the locale ALS store; an explicit
  // `opts.announcement` (a renderer or unit test threading its own) wins.
  // Absent both, no bar renders.
  var announcementRow = (opts.announcement !== undefined)
    ? opts.announcement
    : ((storeCtx && storeCtx.announcement) || null);
  var announcementBarHtml = _buildAnnouncementBar(announcementRow);
  var announcementScript  = (announcementRow && announcementRow.dismissible)
    ? _islandScript("announcement.js", { id: "announcement-island" })
    : "";
  var chrome = localeCtx.chrome;
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  // The cart aria-label carries the count: when the resolved string is
  // the request-localised one it already has the count baked in; the
  // English baseline default ships a literal `{count}` we fill here so
  // the un-threaded fallback path still reads naturally.
  var cartAria = String(chrome.nav_cart_aria).replace("{count}", String(cartCount));

  var vars = {
    title:          opts.title,
    shop_name:      shopName,
    cart_count:     cartCount,
    year:           _COPYRIGHT_YEAR,
    search_q:       opts.search_q == null ? "" : opts.search_q,
    theme_css:           themeCss,
    og_type:        ogType,
    og_title:       ogTitle,
    og_description: ogDescription,
    og_image:       ogImage,
    og_url:         ogUrl,
    canonical_url:  canonicalUrl,
    lang:           localeCtx.lang || "en",
    dir:            localeCtx.dir  || "ltr",
    nav_cart_aria:  cartAria,
    body:           "RAW_BODY_PLACEHOLDER",
  };
  // Layer in every chrome string the LAYOUT references. `nav_cart_aria`
  // is handled above (it needs the count interpolated); the two
  // `locale_switcher_*` strings live only inside the switcher form
  // (spliced via RAW_LOCALE_SWITCHER), not in the LAYOUT body — the
  // strict `_render` refuses an unused placeholder, so they're skipped
  // here.
  var chromeKeys = Object.keys(chrome);
  for (var ci = 0; ci < chromeKeys.length; ci += 1) {
    var ck = chromeKeys[ci];
    if (ck === "nav_cart_aria" || ck === "locale_switcher_label" || ck === "locale_switcher_submit") continue;
    vars[ck] = chrome[ck];
  }

  return _render(LAYOUT, vars)
    .replace("RAW_CSS_INTEGRITY", themeCssIntegrity)
    .replace("RAW_ANNOUNCEMENT_BAR", announcementBarHtml)
    .replace("RAW_CONSENT_SCRIPT", _islandScript("consent.js", { id: "consent-island", policy: _activeConsentPolicy }))
    .replace("RAW_CART_COUNT_SCRIPT", _islandScript("cart-count.js", { id: "cart-count-island" }))
    .replace("RAW_ANNOUNCEMENT_SCRIPT", announcementScript)
    .replace("RAW_CURRENCY_SWITCHER", switcherHtml)
    .replace("RAW_LOCALE_SWITCHER", localeCtx.switcher_html || "")
    .replace("RAW_BODY_PLACEHOLDER", opts.body);
  // The body is RAW HTML (already rendered + escaped at the
  // per-fragment level). The placeholder swap is post-render so the
  // outer renderer's HTML-escape doesn't double-escape the inner
  // markup. `search_q` is HTML-escaped by the renderer like any
  // other placeholder, so a customer-supplied query like
  // `"><script>` lands as escaped text inside the input's `value`.
}

// ---- home --------------------------------------------------------------

// PRODUCT_CARD has two flavors composed at render time —
// `_buildProductCard()` picks between them based on whether the
// product carries a media row. The image-bearing card uses an
// anchor-wrapper so the whole tile is clickable; the text-only
// fallback keeps the existing link inside the card body.
var PRODUCT_CARD_IMAGE =
  "<a class=\"product-card\" href=\"/products/{{slug}}\">\n" +
  "  <figure class=\"product-card__media\">\n" +
  "    <img src=\"{{image_url}}\" alt=\"{{image_alt}}\" loading=\"lazy\">\n" +
  "  </figure>\n" +
  "  <div class=\"product-card__meta\">\n" +
  "    <h3 class=\"product-card__title\">{{title}}</h3>\n" +
  "    <p class=\"product-card__price\">{{price}}</p>\n" +
  "  </div>\n" +
  "</a>\n";

var PRODUCT_CARD =
  "<a class=\"product-card\" href=\"/products/{{slug}}\">\n" +
  "  <figure class=\"product-card__media product-card__media--placeholder\">\n" +
  "    <svg class=\"media-ph__svg\" viewBox=\"0 0 160 120\" aria-hidden=\"true\"><rect width=\"160\" height=\"120\" fill=\"none\"/><g stroke=\"currentColor\" stroke-opacity=\"0.18\" stroke-width=\"1\"><path d=\"M0 30 H160 M0 60 H160 M0 90 H160 M40 0 V120 M80 0 V120 M120 0 V120\"/></g><g fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M80 38 L104 50 L104 76 L80 88 L56 76 L56 50 Z\"/><path d=\"M56 50 L80 62 L104 50 M80 62 V88\" stroke=\"#C75BE8\"/><path d=\"M70 47 L74 50 L70 53\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M77 54 H86\" stroke=\"currentColor\" stroke-width=\"2\"/></g><text x=\"80\" y=\"106\" text-anchor=\"middle\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"9\" letter-spacing=\"1.5\" fill=\"#9b9ba7\">no image yet</text></svg>\n" +
  "  </figure>\n" +
  "  <div class=\"product-card__meta\">\n" +
  "    <h3 class=\"product-card__title\">{{title}}</h3>\n" +
  "    <p class=\"product-card__price\">{{price}}</p>\n" +
  "  </div>\n" +
  "</a>\n";

// Render-time picker. Image-bearing cards become the dominant
// surface as soon as a product carries media; text-only cards
// remain the fallback so a freshly-listed product doesn't render
// an empty image slot.
function _buildProductCard(p) {
  if (p.image_url) {
    return _render(PRODUCT_CARD_IMAGE, {
      title:     p.title,
      price:     p.price,
      slug:      p.slug,
      image_url: p.image_url,
      image_alt: p.image_alt || p.title,
    });
  }
  return _render(PRODUCT_CARD, {
    title: p.title,
    price: p.price,
    slug:  p.slug,
  });
}

var HOME_HERO =
  "<section class=\"hero hero--dark\">\n" +
  "  <div class=\"hero__bg\" aria-hidden=\"true\">\n" +
  "    <div class=\"hero__grid\"></div>\n" +
  "    <div class=\"hero__glow hero__glow--1\"></div>\n" +
  "    <div class=\"hero__glow hero__glow--2\"></div>\n" +
  "  </div>\n" +
  "  <div class=\"hero__inner\">\n" +
  "    <div class=\"hero__copy\">\n" +
  "      <p class=\"eyebrow eyebrow--on-dark\">~/blamejs.shop — secure commerce · v" + require("../package.json").version + "</p>\n" +
  "      <h1 class=\"hero__title\">Sell anything.<br>Trust <span class=\"glitch glitch--live\" data-text=\"nothing.\">nothing.</span><span class=\"term-cursor\" aria-hidden=\"true\"></span></h1>\n" +
  "      <p class=\"hero__lede\">An open-source, server-rendered ecommerce framework with post-quantum cryptography baked into every session, cart, and checkout. No client-side validation theater. No npm runtime dependencies. Just hardened HTML.</p>\n" +
  "      <div class=\"hero__cta\">\n" +
  "        <a href=\"#catalog\" class=\"btn-primary\">$ npx create-shop</a>\n" +
  "        <a href=\"https://github.com/blamejs/blamejs.shop\" class=\"btn-ghost btn-ghost--on-dark\" rel=\"noopener\">Read the threat model</a>\n" +
  "      </div>\n" +
  "      <dl class=\"hero__stats\">\n" +
  "        <div><dt>Products live</dt><dd>{{product_count}}</dd></div>\n" +
  "        <div><dt>npm runtime deps</dt><dd>0</dd></div>\n" +
  "        <div><dt>Default crypto</dt><dd>PQC</dd></div>\n" +
  "        <div><dt>License</dt><dd>Apache 2.0</dd></div>\n" +
  "      </dl>\n" +
  "    </div>\n" +
  "    <aside class=\"hero__card\" aria-label=\"Storefront preview\">\n" +
  "      <div class=\"hero__card-bar\">\n" +
  "        <span class=\"hero__card-dot hero__card-dot--r\"></span>\n" +
  "        <span class=\"hero__card-dot hero__card-dot--y\"></span>\n" +
  "        <span class=\"hero__card-dot hero__card-dot--g\"></span>\n" +
  "        <span class=\"hero__card-url\">blamejs.shop / order / o-42</span>\n" +
  "      </div>\n" +
  "      <pre class=\"hero__card-body\"><code><span class=\"tk-c\">// Server-rendered order page</span>\n" +
  "<span class=\"tk-k\">var</span> bShop = <span class=\"tk-f\">require</span>(<span class=\"tk-s\">\"./lib\"</span>);\n" +
  "\n" +
  "bShop.checkout.<span class=\"tk-f\">finalize</span>({\n" +
  "  cart_id:        <span class=\"tk-s\">\"c_2024\"</span>,\n" +
  "  payment_intent: <span class=\"tk-s\">\"pi_3RtA…\"</span>,\n" +
  "  cursor_secret:  <span class=\"tk-f\">b.crypto.namespaceHash</span>(\n" +
  "    <span class=\"tk-s\">\"order-cursor\"</span>, secret),\n" +
  "}).<span class=\"tk-f\">then</span>(<span class=\"tk-k\">function</span> (o) {\n" +
  "  res.<span class=\"tk-f\">setHeader</span>(<span class=\"tk-s\">\"content-type\"</span>,\n" +
  "    <span class=\"tk-s\">\"text/html; charset=utf-8\"</span>);\n" +
  "  res.<span class=\"tk-f\">end</span>(storefront.<span class=\"tk-f\">renderOrder</span>(o));\n" +
  "});</code></pre>\n" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n" +
  "\n" +
  "<section class=\"marquee\" aria-hidden=\"true\">\n" +
  "  <div class=\"marquee__track\">\n" +
  "    <span>ML-KEM-1024 key agreement</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>ML-DSA-65 signatures</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>XChaCha20-Poly1305 sealed sessions</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Argon2id passphrase hashing</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>SHAKE256 KDF</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Stripe-first payments</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>WebAuthn passkeys</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>SLSA L3 provenance</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Sigstore-keyless SBOM</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Trusted Types enforced</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Server-rendered HTML</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span>Zero npm runtime deps</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">ML-KEM-1024 key agreement</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">ML-DSA-65 signatures</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">XChaCha20-Poly1305 sealed sessions</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Argon2id passphrase hashing</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">SHAKE256 KDF</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Stripe-first payments</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">WebAuthn passkeys</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">SLSA L3 provenance</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Sigstore-keyless SBOM</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Trusted Types enforced</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Server-rendered HTML</span><span class=\"marquee__sep\">◆</span>\n" +
  "    <span aria-hidden=\"true\">Zero npm runtime deps</span><span class=\"marquee__sep\">◆</span>\n" +
  "  </div>\n" +
  "</section>\n" +
  "\n" +
  "RAW_FEATURED_CALLOUT\n" +
  "\n" +
  "<section class=\"collections\" aria-labelledby=\"collections-title\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Featured collections</p>\n" +
  "    <h2 id=\"collections-title\" class=\"section-head__title\">Shaped for a storefront that ships from day one.</h2>\n" +
  "    <p class=\"section-head__lede\">Drop products into any of these starting categories — or define your own taxonomy through the catalog admin and the framework will server-render the grids, filters, and PDP routes for free.</p>\n" +
  "  </header>\n" +
  "  <div class=\"collections__grid\">\n" +
  "    <a class=\"collection-card\" href=\"/search?q=tee\">\n" +
  "      <div class=\"collection-card__art collection-card__art--1\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M70 38 C74 44 86 44 90 38 L104 44 L112 58 L100 64 L96 58 L96 92 L64 92 L64 58 L60 64 L48 58 L56 44 Z\"/><path d=\"M71 40 C75 47 85 47 89 40\" stroke=\"#732A8D\" stroke-width=\"2\"/><path d=\"M73 76 H87\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-dasharray=\"2 3\"/></svg></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Apparel</h3>\n" +
  "        <p>Sized, colored, inventoried.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=edge\">\n" +
  "      <div class=\"collection-card__art collection-card__art--2\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"58\" y=\"38\" width=\"44\" height=\"44\" rx=\"4\"/><rect x=\"70\" y=\"50\" width=\"20\" height=\"20\" rx=\"2\" stroke=\"#732A8D\"/><circle cx=\"80\" cy=\"60\" r=\"3\" fill=\"#AD38DB\" stroke=\"none\"/><path d=\"M66 38 V30 M76 38 V30 M86 38 V30 M96 38 V30\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M66 82 V90 M76 82 V90 M86 82 V90 M96 82 V90\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M58 48 H50 M58 60 H50 M58 72 H50\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M102 48 H110 M102 60 H110 M102 72 H110\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Hardware</h3>\n" +
  "        <p>Serialized, warranty-tracked.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=license\">\n" +
  "      <div class=\"collection-card__art collection-card__art--3\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M60 74 C50 74 48 62 57 59 C56 47 73 43 79 53 C88 47 100 54 97 64 C107 65 107 74 99 74 Z\" stroke=\"#732A8D\"/><path d=\"M78 60 V86\"/><path d=\"M70 78 L78 88 L86 78\"/><path d=\"M64 98 H92\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Digital</h3>\n" +
  "        <p>License-key fulfillment.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=subscription\">\n" +
  "      <div class=\"collection-card__art collection-card__art--4\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M56 50 A26 26 0 0 1 104 56\"/><path d=\"M104 70 A26 26 0 0 1 56 64\"/><path d=\"M104 42 L106 57 L91 55\" stroke=\"#AD38DB\"/><path d=\"M56 78 L54 63 L69 65\" stroke=\"#AD38DB\"/><circle cx=\"80\" cy=\"60\" r=\"6\" stroke=\"#732A8D\"/><circle cx=\"80\" cy=\"60\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/></svg></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Subscriptions</h3>\n" +
  "        <p>Stripe-backed recurring.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=bundle\">\n" +
  "      <div class=\"collection-card__art collection-card__art--5\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M86 36 L106 44 L106 64 L86 72 L66 64 L66 44 Z\" stroke=\"#732A8D\"/><path d=\"M66 44 L86 52 L106 44 M86 52 V72\" stroke=\"#732A8D\"/><path d=\"M70 56 L90 64 L90 88 L70 96 L50 88 L50 64 Z\"/><path d=\"M50 64 L70 72 L90 64 M70 72 V96\"/><path d=\"M70 72 V96\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Bundles</h3>\n" +
  "        <p>Composite SKUs, atomic stock.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "    <a class=\"collection-card\" href=\"/search?q=gift\">\n" +
  "      <div class=\"collection-card__art collection-card__art--6\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"48\" y=\"48\" width=\"64\" height=\"42\" rx=\"6\"/><path d=\"M80 48 V90\" stroke=\"#732A8D\"/><path d=\"M80 48 C71 36 56 39 62 49 C57 52 61 57 71 53 C76 51 80 50 80 48 Z\"/><path d=\"M80 48 C89 36 104 39 98 49 C103 52 99 57 89 53 C84 51 80 50 80 48 Z\"/><circle cx=\"80\" cy=\"48\" r=\"2.4\" fill=\"#AD38DB\" stroke=\"none\"/><rect x=\"56\" y=\"70\" width=\"11\" height=\"8\" rx=\"1.6\" stroke=\"currentColor\" stroke-width=\"1.8\"/></svg></div>\n" +
  "      <div class=\"collection-card__meta\">\n" +
  "        <h3>Gift cards</h3>\n" +
  "        <p>PQC-signed redemption codes.</p>\n" +
  "      </div>\n" +
  "    </a>\n" +
  "  </div>\n" +
  "</section>\n" +
  "\n" +
  "<section id=\"framework\" class=\"framework-band\" aria-labelledby=\"framework-title\">\n" +
  "  <div class=\"framework-band__inner\">\n" +
  "    <div class=\"framework-band__copy\">\n" +
  "      <p class=\"eyebrow\">Built on blamejs</p>\n" +
  "      <h2 id=\"framework-title\">Every behavior on this site is a composed primitive.</h2>\n" +
  "      <p class=\"framework-band__lede\">Twenty-plus shop primitives — cart, catalog, payment, order, subscriptions, customers, webhooks, audit log, sealed sessions, signed cursors, problem-details, money math, FSMs — sit on a vendored blamejs core that ships hundreds more. They compose. Replacing one doesn't fork the others.</p>\n" +
  "      <a class=\"link-arrow\" href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">Read the source on GitHub <span aria-hidden=\"true\">→</span></a>\n" +
  "    </div>\n" +
  "    <ul class=\"framework-band__list\">\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">01</span>\n" +
  "        <h3>Server-rendered HTML</h3>\n" +
  "        <p>Every route renders a complete document at the origin. No client framework, no hydration spinner, no JavaScript required to read the page.</p>\n" +
  "      </li>\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">02</span>\n" +
  "        <h3>PQC-first crypto</h3>\n" +
  "        <p>ML-KEM-1024, ML-DSA-65, XChaCha20-Poly1305, SHAKE256, HKDF-SHA3-512, Argon2id. The application never reaches for AES-GCM, SHA-256, or classical ECDH on its own.</p>\n" +
  "      </li>\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">03</span>\n" +
  "        <h3>Zero runtime npm deps</h3>\n" +
  "        <p>One vendored framework, shipped byte-for-byte from a signed release tag. The tarball you install is the tarball that ran in CI.</p>\n" +
  "      </li>\n" +
  "      <li>\n" +
  "        <span class=\"framework-band__num\">04</span>\n" +
  "        <h3>Security defaults on</h3>\n" +
  "        <p>CSRF, fetch-metadata, origin, bot-guard, sealed cookies, Trusted Types, DoH, cookie-prefix policy — composed into the request lifecycle, not behind a feature flag.</p>\n" +
  "      </li>\n" +
  "    </ul>\n" +
  "  </div>\n" +
  "</section>\n";

var CATALOG_EMPTY =
  "<section id=\"catalog\" class=\"catalog-section\">\n" +
  "  <header class=\"section-head section-head--with-link\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Catalog</p>\n" +
  "      <h2 class=\"section-head__title\">The shop is open, waiting on its first listing.</h2>\n" +
  "      <p class=\"section-head__lede\">When you add a product through the admin API, it appears here in a server-rendered grid with filters, sorting, and a fully-routed PDP. Until then, this is the storefront shell.</p>\n" +
  "    </div>\n" +
  "    <a class=\"link-arrow\" href=\"/admin\">Open admin <span aria-hidden=\"true\">→</span></a>\n" +
  "  </header>\n" +
  "  <div class=\"catalog-empty\">\n" +
  "    <div class=\"catalog-empty__placeholder\" aria-hidden=\"true\">\n" +
  "      <span></span><span></span><span></span><span></span>\n" +
  "    </div>\n" +
  "    <div class=\"catalog-empty__copy\">\n" +
  "      <h3>Add the first product</h3>\n" +
  "      <p>The grid below renders as soon as a product is listed. Variants, prices, inventory levels, and tax categories are all wired up — you just supply the SKUs.</p>\n" +
  "      <pre class=\"catalog-empty__code\"><code>curl -X POST https://blamejs.shop/admin/products \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"title\": \"My first product\", \"slug\": \"first\" }'</code></pre>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

var CATALOG_HEAD =
  "<section id=\"catalog\" class=\"catalog-section\">\n" +
  "  <header class=\"section-head section-head--with-link\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Catalog</p>\n" +
  "      <h2 class=\"section-head__title\">Products in store</h2>\n" +
  "      <p class=\"section-head__lede\">Server-rendered listings — every card, price, and link arrived on the wire as complete HTML.</p>\n" +
  "    </div>\n" +
  "    <a class=\"link-arrow\" href=\"/?sort=new\">New arrivals <span aria-hidden=\"true\">→</span></a>\n" +
  "  </header>\n" +
  "  <div class=\"grid\">{{cards}}</div>\n" +
  "</section>\n";

function renderHome(opts) {
  if (!opts || !Array.isArray(opts.products)) throw new TypeError("storefront.renderHome: opts.products required");
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var title     = opts.title || "Shop";
  var assetPrefix = opts.asset_prefix || "/assets/";
  var fmt = _priceFormatter(opts);
  var products    = opts.products.map(function (p) {
    var priceStr = p.starting_price_minor != null
      ? fmt(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
    // Hero image — first media row attached to the product (the
    // route handler bundles it in via `p.hero_media`). Image-less
    // products render the text-only PRODUCT_CARD fallback below.
    var imageUrl = p.hero_media ? assetPrefix + p.hero_media.r2_key : null;
    var imageAlt = p.hero_media ? (p.hero_media.alt_text || p.title) : null;
    return {
      title:       p.title,
      description: p.description || "",
      price:       priceStr,
      slug:        p.slug,
      image_url:   imageUrl,
      image_alt:   imageAlt,
    };
  });
  if (opts.theme) {
    return opts.theme.render("home", {
      title:           title,
      shop_name:       shopName,
      cart_count:      cartCount,
      products:        products,
      has_products:    products.length > 0,
      asset_css_main:  opts.theme.assetUrl("css/main.css"),
    });
  }
  var cards = products.map(function (p) { return _buildProductCard(p); }).join("\n");
  var catalog = products.length === 0
    ? CATALOG_EMPTY
    : _render(CATALOG_HEAD, { cards: "RAW_CARDS_PLACEHOLDER" }).replace("RAW_CARDS_PLACEHOLDER", cards);
  // Live stat in the hero — operator-facing visitors see the
  // actual catalog size, not a stale hardcoded number. Falls back
  // to a typographic em-dash when the catalog hasn't been seeded.
  var heroProductCount = products.length === 0 ? "—" : String(products.length);

  // Featured-product callout — pick the first product that has
  // attached media. Surfaces a single product in a wider treatment
  // than the dense 6-tile collections grid below. Operators that
  // want a different selection rule (top-seller, newest, manually
  // pinned) wrap renderHome and override `opts.featured`.
  function _esc(s) { return b.template.escapeHtml(s); }
  var featuredProduct = null;
  if (opts.featured) {
    featuredProduct = opts.featured;
  } else {
    for (var fi = 0; fi < products.length; fi += 1) {
      if (products[fi].image_url) { featuredProduct = products[fi]; break; }
    }
  }
  var featuredHtml = "";
  if (featuredProduct) {
    var fpDesc = featuredProduct.description || "Server-rendered, PQC-secured, shipped from origin. Composed on the vendored blamejs framework.";
    featuredHtml =
      "<section class=\"featured-product\" aria-labelledby=\"featured-title\">\n" +
      "  <div class=\"featured-product__inner\">\n" +
      "    <a class=\"featured-product__media\" href=\"/products/" + _esc(featuredProduct.slug) + "\">\n" +
      "      <img src=\"" + _esc(featuredProduct.image_url) + "\" alt=\"" + _esc(featuredProduct.image_alt || featuredProduct.title) + "\" loading=\"lazy\">\n" +
      "    </a>\n" +
      "    <div class=\"featured-product__copy\">\n" +
      "      <p class=\"eyebrow\">Featured</p>\n" +
      "      <h2 id=\"featured-title\" class=\"featured-product__title\">" + _esc(featuredProduct.title) + "</h2>\n" +
      "      <p class=\"featured-product__lede\">" + _esc(fpDesc) + "</p>\n" +
      "      <p class=\"featured-product__price\">" + _esc(featuredProduct.price) + "</p>\n" +
      "      <a class=\"btn-primary\" href=\"/products/" + _esc(featuredProduct.slug) + "\">View product <span aria-hidden=\"true\">→</span></a>\n" +
      "    </div>\n" +
      "  </div>\n" +
      "</section>";
  }

  var hero = _render(HOME_HERO, { product_count: heroProductCount })
    .replace("RAW_FEATURED_CALLOUT", featuredHtml);
  // The hero + value band + catalog section give the home page a
  // designed surface even when no products are loaded yet —
  // visitors land on the storefront shell, not a tech demo.
  // Organization + WebSite JSON-LD — surfaces the storefront in Google's
  // knowledge-panel (logo + social) and registers the sitelinks search
  // box pointing at `/search?q=`. Mirrors the edge renderer
  // (`worker/render/home.js`) byte-for-byte so the structured data is
  // identical whichever substrate serves the home page. `_orgWebsiteJsonLd`
  // resolves the absolute base from the shop name (a bare host or a full
  // URL both normalise to `https://<host>`).
  var homeJsonLd = _orgWebsiteJsonLd(shopName);
  var body = hero + catalog + homeJsonLd;
  return _wrap(Object.assign({
    title:      title,
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    canonical_url: opts.canonical_url,
    og_url:        opts.og_url,
    og_description: "Shop the blamejs.shop catalog — an open-source, server-rendered storefront with post-quantum crypto and zero npm runtime dependencies.",
    body:       body,
  }, _currencyWrapOpts(opts)));
}

// Absolute origin (scheme + host, no trailing slash) for building
// fully-qualified structured-data URLs. Prefers the request-derived
// canonical URL's origin (matches the host the visitor reached); falls
// back to the shop-name host when the renderer is called without one (a
// unit test, or a theme path). A bare host shop name and a full `https://`
// value both normalise to `https://<host>`.
function _absoluteBase(canonicalUrl, shopName) {
  if (typeof canonicalUrl === "string" && canonicalUrl.length) {
    try {
      var parsed = new URL(canonicalUrl);
      return parsed.origin;
    } catch (_e) { /* fall through to the shop-name base */ }
  }
  return "https://" + String(shopName || "blamejs.shop").replace(/^https?:\/\//, "");
}

// Schema.org Organization + WebSite JSON-LD for the home page. Shared by
// the container `renderHome` and mirrored by the edge
// `worker/render/home.js` — keep the two byte-identical. The base URL is
// derived from the shop name (operators set SHOP_NAME to their host); a
// bare host and a full `https://` value both normalise to `https://<host>`.
function _orgWebsiteJsonLd(shopName) {
  var base = "https://" + String(shopName).replace(/^https?:\/\//, "");
  return _jsonLdScript({
    "@context": "https://schema.org",
    "@type":    "Organization",
    "name":     shopName,
    "url":      base,
    "logo":     base + "/assets/brand/logo.png",
    "sameAs":   ["https://github.com/blamejs/blamejs.shop"],
  }) +
  _jsonLdScript({
    "@context": "https://schema.org",
    "@type":    "WebSite",
    "name":     shopName,
    "url":      base,
    "potentialAction": {
      "@type":       "SearchAction",
      "target":      base + "/search?q={search_term_string}",
      "query-input": "required name=search_term_string",
    },
  });
}

// ---- search results -----------------------------------------------------

var SEARCH_HEADER =
  "<section class=\"search-page\">\n" +
  "  <header class=\"section-head section-head--with-link\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Search results</p>\n" +
  "      <h1 class=\"section-head__title\">{{title}}</h1>\n" +
  "      <p class=\"section-head__lede\">{{summary}}</p>\n" +
  "    </div>\n" +
  "    <a class=\"link-arrow\" href=\"/\">All products <span aria-hidden=\"true\">→</span></a>\n" +
  "  </header>\n" +
  "</section>\n";

var SEARCH_EMPTY =
  "<section class=\"search-empty\">\n" +
  "  <div class=\"search-empty__inner\">\n" +
  "    <p class=\"search-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><circle cx=\"90\" cy=\"58\" r=\"30\"/><path d=\"M112 80 L132 100\"/><path d=\"M80 52 L86 58 L80 64\" stroke=\"currentColor\" stroke-width=\"2.4\"/><path d=\"M92 64 H102\" stroke=\"currentColor\" stroke-width=\"2.4\"/><circle cx=\"46\" cy=\"34\" r=\"2\" fill=\"#732A8D\" stroke=\"none\"/><circle cx=\"146\" cy=\"44\" r=\"2\" fill=\"#732A8D\" stroke=\"none\"/></svg></p>\n" +
  "    <h2>{{heading}}</h2>\n" +
  "    <p>{{copy}}</p>\n" +
  "    {{clear_link}}\n" +
  "    <a href=\"/\" class=\"btn-ghost\">Browse the full catalog</a>\n" +
  "  </div>\n" +
  "</section>\n";

var SEARCH_CORRECTION =
  "<p class=\"search-correction\">Showing results for <strong>{{correction}}</strong>.</p>\n";

var FACET_GROUP_HEAD =
  "<fieldset class=\"facet-group\">\n" +
  "  <legend class=\"facet-group__title\">{{label}}</legend>\n" +
  "  <ul class=\"facet-group__options\">\n";

var FACET_OPTION =
  "<li class=\"facet-option\">\n" +
  "  <a class=\"facet-option__link{{selected_class}}\" href=\"{{href}}\" rel=\"nofollow\"{{aria_current}}>\n" +
  "    <span class=\"facet-option__box\" aria-hidden=\"true\">{{box}}</span>{{selected_cue}}\n" +
  "    <span class=\"facet-option__label\">{{label}}</span>\n" +
  "    <span class=\"facet-option__count\">{{count}}</span>\n" +
  "  </a>\n" +
  "</li>\n";

var FACET_CHIP =
  "<a class=\"facet-chip\" href=\"{{href}}\" rel=\"nofollow\">\n" +
  "  <span class=\"facet-chip__label\">{{label}}</span>\n" +
  "  <span class=\"facet-chip__x\" aria-hidden=\"true\">×</span>\n" +
  "  <span class=\"skip-link\">Remove filter</span>\n" +
  "</a>\n";

// Build a `/search?...` URL from a query + applied-filters map. Mirrors
// the edge renderer's `_searchUrl` so the container and worker emit
// byte-identical filter links. `URLSearchParams` percent-encodes every
// value; the strict `_render` HTML-escapes it again when it lands in an
// `href` attribute.
function _searchUrl(q, filters) {
  var sp = new URLSearchParams();
  if (typeof q === "string" && q.length) sp.set("q", q);
  var keys = Object.keys(filters).sort();
  for (var i = 0; i < keys.length; i += 1) {
    var vals = (filters[keys[i]] || []).slice().sort();
    for (var j = 0; j < vals.length; j += 1) sp.append(keys[i], vals[j]);
  }
  var qs = sp.toString();
  return qs.length ? "/search?" + qs : "/search";
}

function _toggleFilter(filters, key, value) {
  var next = {};
  var keys = Object.keys(filters);
  for (var i = 0; i < keys.length; i += 1) next[keys[i]] = filters[keys[i]].slice();
  var cur = next[key] || [];
  var at = cur.indexOf(value);
  if (at === -1) cur = cur.concat([value]);
  else cur = cur.slice(0, at).concat(cur.slice(at + 1));
  if (cur.length) next[key] = cur;
  else delete next[key];
  return next;
}

function _renderSearchFacets(facets, filters, q) {
  var groups = [];
  for (var f = 0; f < facets.length; f += 1) {
    var facet = facets[f];
    var optionsHtml = "";
    var rendered = 0;
    for (var o = 0; o < facet.options.length; o += 1) {
      var opt = facet.options[o];
      if (opt.count === 0 && !opt.selected) continue;
      optionsHtml += _render(FACET_OPTION, {
        href:           _searchUrl(q, _toggleFilter(filters, facet.key, opt.value)),
        selected_class: opt.selected ? " is-selected" : "",
        aria_current:   "RAW_ARIA",
        box:            opt.selected ? "✓" : "",
        selected_cue:   "RAW_CUE",
        label:          opt.label,
        count:          String(opt.count),
      }).replace("RAW_ARIA", opt.selected ? " aria-current=\"true\"" : "")
        .replace("RAW_CUE", opt.selected ? "<span class=\"sr-only\">Selected: </span>" : "");
      rendered += 1;
    }
    if (rendered === 0) continue;
    groups.push(_render(FACET_GROUP_HEAD, { label: facet.label }) + optionsHtml + "  </ul>\n</fieldset>\n");
  }
  if (!groups.length) return "";
  return "<aside class=\"search-facets\" aria-label=\"Filter results\">\n" +
    "<h2 class=\"search-facets__title\">Filter</h2>\n" +
    groups.join("") +
    "</aside>\n";
}

function _renderSearchChips(facets, filters, q) {
  var labelFor = {};
  for (var f = 0; f < facets.length; f += 1) {
    var byVal = {};
    for (var o = 0; o < facets[f].options.length; o += 1) byVal[facets[f].options[o].value] = facets[f].options[o].label;
    labelFor[facets[f].key] = { group: facets[f].label, values: byVal };
  }
  var chips = "";
  var any = false;
  var keys = Object.keys(filters).sort();
  for (var k = 0; k < keys.length; k += 1) {
    var meta = labelFor[keys[k]];
    var vals = filters[keys[k]] || [];
    for (var v = 0; v < vals.length; v += 1) {
      var valLabel = meta && meta.values[vals[v]] != null ? meta.values[vals[v]] : vals[v];
      var groupLabel = meta ? meta.group : keys[k];
      chips += _render(FACET_CHIP, {
        href:  _searchUrl(q, _toggleFilter(filters, keys[k], vals[v])),
        label: groupLabel + ": " + valLabel,
      });
      any = true;
    }
  }
  if (!any) return "";
  var clearAll = _render(
    "<a class=\"facet-chip facet-chip--clear\" href=\"{{href}}\" rel=\"nofollow\">Clear all filters</a>\n",
    { href: _searchUrl(q, {}) }
  );
  return "<div class=\"search-active-filters\" aria-label=\"Active filters\">\n" + chips + clearAll + "</div>\n";
}

// Hard caps mirroring `lib/search-facets.js`'s applied-filter
// validators so a hostile / stale URL can't blow the in-memory facet
// walk. Garbage values and unknown facet keys are dropped (not
// refused): a shopper landing on a link with a removed-facet param
// still gets a clean results page rather than a 500.
var SEARCH_MAX_FACET_KEYS   = 32;
var SEARCH_MAX_FACET_VALUES = 64;
var SEARCH_MAX_VALUE_LEN    = 256;
var SEARCH_CONTROL_BYTE_RE  = /[\x00-\x1f\x7f]/;

// Parse `?key=value` repeats off a parsed URL into the
// `{ facetKey: [value, ...] }` shape the searchFacets primitive
// consumes, keeping only keys that match a loaded facet definition and
// values that survive the length / control-byte guards. `facetDefs` is
// the `listFacets()` result.
function _parseSearchFilters(url, facetDefs) {
  var out = {};
  if (!url || !url.searchParams) return out;
  var known = {};
  for (var i = 0; i < facetDefs.length; i += 1) known[facetDefs[i].key] = true;
  var keyCount = 0;
  url.searchParams.forEach(function (rawVal, rawKey) {
    if (rawKey === "q") return;
    if (!Object.prototype.hasOwnProperty.call(known, rawKey)) return;
    if (typeof rawVal !== "string") return;
    if (!rawVal.length || rawVal.length > SEARCH_MAX_VALUE_LEN) return;
    if (SEARCH_CONTROL_BYTE_RE.test(rawVal)) return;
    if (!Object.prototype.hasOwnProperty.call(out, rawKey)) {
      if (keyCount >= SEARCH_MAX_FACET_KEYS) return;
      out[rawKey] = [];
      keyCount += 1;
    }
    var arr = out[rawKey];
    if (arr.length >= SEARCH_MAX_FACET_VALUES) return;
    if (arr.indexOf(rawVal) !== -1) return;
    arr.push(rawVal);
  });
  return out;
}

function renderSearch(opts) {
  if (!opts || typeof opts.q !== "string") throw new TypeError("storefront.renderSearch: opts.q (string) required");
  var products = Array.isArray(opts.products) ? opts.products : [];
  var facets   = Array.isArray(opts.facets) ? opts.facets : [];
  var filters  = (opts.filters && typeof opts.filters === "object") ? opts.filters : {};
  var hasFilters = Object.keys(filters).length > 0;
  var qTrim = opts.q.trim();
  var title, summary, emptyHeading, emptyCopy;
  if (qTrim.length === 0) {
    title        = "Search the catalog";
    summary      = "Use the search box in the header to look for a product by title, SKU, or description.";
    emptyHeading = "What are you looking for?";
    emptyCopy    = "Type a query in the header search to find products by title, SKU, or description.";
  } else if (products.length === 0) {
    title        = "No matches";
    summary      = "Nothing in the catalog matched “" + qTrim + "”.";
    emptyHeading = "We don't carry that yet";
    emptyCopy    = "Try a broader term, or browse every product on the home page.";
  } else {
    title   = "“" + qTrim + "”";
    summary = "Showing " + products.length + " match" + (products.length === 1 ? "" : "es") + " for your query.";
  }

  var correctionHtml = "";
  if (qTrim.length > 0 && typeof opts.corrected_query === "string" &&
      opts.corrected_query.length > 0 && opts.corrected_query !== qTrim) {
    correctionHtml = _render(SEARCH_CORRECTION, { correction: opts.corrected_query });
  }

  var facetsHtml = (qTrim.length > 0) ? _renderSearchFacets(facets, filters, opts.q) : "";
  var chipsHtml  = (qTrim.length > 0) ? _renderSearchChips(facets, filters, opts.q) : "";

  var header = _render(SEARCH_HEADER, { title: title, summary: summary });
  var resultsInner;
  if (products.length === 0) {
    var clearLink = hasFilters
      ? _render("<a href=\"{{href}}\" class=\"btn-ghost\">Clear filters</a>", { href: _searchUrl(opts.q, {}) })
      : "";
    resultsInner = _render(SEARCH_EMPTY, { heading: emptyHeading, copy: emptyCopy, clear_link: "RAW_CLEAR" })
      .replace("RAW_CLEAR", clearLink);
  } else {
    var assetPrefix = opts.asset_prefix || "/assets/";
    var fmt = _priceFormatter(opts);
    var cards = products.map(function (p) {
      var priceStr = p.starting_price_minor != null
        ? fmt(p.starting_price_minor, p.starting_price_currency || "USD")
        : "—";
      var imageUrl = p.hero_media ? assetPrefix + p.hero_media.r2_key : null;
      var imageAlt = p.hero_media ? (p.hero_media.alt_text || p.title) : null;
      return _buildProductCard({ title: p.title, price: priceStr, slug: p.slug, image_url: imageUrl, image_alt: imageAlt });
    }).join("\n");
    resultsInner = "<section class=\"search-grid\"><div class=\"grid\">" + cards + "</div></section>";
  }
  var body;
  if (facetsHtml.length > 0) {
    body = header + correctionHtml + chipsHtml +
      "<div class=\"search-layout\">" + facetsHtml +
      "<div class=\"search-layout__results\">" + resultsInner + "</div></div>";
  } else {
    body = header + correctionHtml + chipsHtml + resultsInner;
  }
  var searchShopName = opts.shop_name || "blamejs.shop";
  // Per-page meta description — mirrors the edge renderer.
  var searchMetaDescription = qTrim.length > 0
    ? ("Results for “" + qTrim + "” in the " + searchShopName + " catalog.")
    : ("Search the " + searchShopName + " catalog by title, SKU, or description.");
  return _wrap(Object.assign({
    title:      "Search",
    shop_name:  searchShopName,
    cart_count: opts.cart_count,
    search_q:   opts.q,
    theme_css: opts.theme_css,
    og_description: searchMetaDescription,
    canonical_url: opts.canonical_url,
    og_url:        opts.og_url,
    body:       body,
  }, _currencyWrapOpts(opts)));
}

// ---- product detail -----------------------------------------------------

// Cart-add form. CSRF defense rests on the `shop_sid` session
// cookie's SameSite=Lax attribute — a cross-site form POST won't
// carry the cookie, so any cross-site "add to cart" lands in a
// fresh anonymous session that the victim never sees. Token-based
// CSRF as defense-in-depth is added alongside the Stripe Elements
// payment route in the next patch.
var VARIANT_ROW =
  "<tr>\n" +
  "  <td class=\"variant-row__title\">{{title}}</td>\n" +
  "  <td class=\"variant-row__sku\"><code>{{sku}}</code></td>\n" +
  "  <td class=\"variant-row__price price\">{{price}}</td>\n" +
  "  <td class=\"variant-row__action\">\n" +
  "    <form method=\"post\" action=\"/cart/lines\">\n" +
  "      <input type=\"hidden\" name=\"variant_id\" value=\"{{variant_id}}\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" class=\"variant-row__qty\" aria-label=\"Quantity\">\n" +
  "      <button type=\"submit\" class=\"btn-primary btn-primary--sm\">Add to cart</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "</tr>\n";

// PDP buy-box. A single cart-add form posting `variant_id` + `qty` to
// /cart/lines (unchanged endpoint + field names). Multi-variant
// selection is server-rendered radio chips sharing `name="variant_id"`
// — the checked radio is what POSTs, so variant choice works with zero
// client JS. The lead price renders large + mono + violet; each chip
// carries its own price so a shopper sees per-variant pricing before
// they pick. Above twelve variants the chip wall gets unwieldy, so the
// existing compact variant table (VARIANT_ROW) is the fallback — it
// keeps a per-row add form, so the same endpoint contract holds.
// `variants` is the pre-formatted array [{ id, sku, title, price }]
// the renderers already build; `escAttr` is the path's HTML escaper.
// Mirrored byte-for-byte by worker/render/product.js#_buildBuyBox.
var BUYBOX_CHIP_LIMIT = 12;

function _buildBuyBox(variants, escAttr) {
  if (!variants || variants.length === 0) {
    return "<div class=\"pdp__variants\">\n" +
           "        <h2 class=\"pdp__variants-title\">Choose a variant</h2>\n" +
           "        <div class=\"table-scroll\">\n" +
           "          <table class=\"variant-table\">\n" +
           "            <thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
           "            <tbody><tr><td colspan=\"4\" class=\"empty\">No variants available.</td></tr></tbody>\n" +
           "          </table>\n" +
           "        </div>\n" +
           "      </div>";
  }

  var trustLine =
    "<div class=\"pdp__meta\">\n" +
    "        <span class=\"pdp__badge\"><img class=\"pdp__badge-mark\" src=\"/assets/brand/favicon.svg\" alt=\"\" aria-hidden=\"true\" width=\"22\" height=\"22\"> Post-quantum secured checkout · ML-KEM-1024 key agreement · ML-DSA-65 receipt signature.</span>\n" +
    "      </div>";

  // Many variants → keep the compact table (still a per-row add form).
  if (variants.length > BUYBOX_CHIP_LIMIT) {
    var rows = variants.map(function (v) {
      return _render(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
    }).join("");
    return "<div class=\"pdp__variants\">\n" +
           "        <h2 class=\"pdp__variants-title\">Choose a variant</h2>\n" +
           "        <div class=\"table-scroll\">\n" +
           "          <table class=\"variant-table\">\n" +
           "            <thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
           "            <tbody>" + rows + "</tbody>\n" +
           "          </table>\n" +
           "        </div>\n" +
           "      </div>\n" +
           "      " + trustLine;
  }

  var lead = variants[0];
  var single = variants.length === 1;
  var chips = "";
  if (!single) {
    for (var i = 0; i < variants.length; i += 1) {
      var v = variants[i];
      chips +=
        "<label class=\"pdp__badge\">" +
          "<input type=\"radio\" name=\"variant_id\" value=\"" + escAttr(v.id) + "\"" + (i === 0 ? " checked" : "") + ">" +
          " <span class=\"variant-row__title\">" + escAttr(v.title) + "</span>" +
          " <span class=\"variant-row__sku\"><code>" + escAttr(v.sku) + "</code></span>" +
          " <span class=\"variant-row__price price\">" + escAttr(v.price) + "</span>" +
        "</label>";
    }
  }

  var variantBlock = single
    ? "<p class=\"variant-row__sku\"><code>" + escAttr(lead.sku) + "</code></p>" +
      "<input type=\"hidden\" name=\"variant_id\" value=\"" + escAttr(lead.id) + "\">"
    : "<fieldset class=\"pdp__variants\">\n" +
      "          <legend class=\"pdp__variants-title\">Choose a variant</legend>\n" +
      "          <div class=\"pdp__meta\">" + chips + "</div>\n" +
      "        </fieldset>";

  return "<div class=\"pdp__buybox\">\n" +
         "        <p class=\"featured-product__price\">" + escAttr(lead.price) + "</p>\n" +
         "        <form method=\"post\" action=\"/cart/lines\">\n" +
         "          " + variantBlock + "\n" +
         "          <label class=\"pdp__variants-title\" for=\"buybox-qty\">Quantity</label>\n" +
         "          <input id=\"buybox-qty\" type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" class=\"variant-row__qty\" aria-label=\"Quantity\">\n" +
         "          <button type=\"submit\" class=\"btn-primary cart-page__checkout\">$ add to cart</button>\n" +
         "        </form>\n" +
         "      </div>\n" +
         "      " + trustLine;
}

// Resolve a product's availability + shipping shape from the variant
// list + (optional) inventory map the route loads. `in_stock` is true if
// ANY variant is buyable; a SKU with no inventory row counts as available
// (the never-block-on-missing-inventory stance the cart-hold path already
// takes). `requires_shipping` is true if ANY variant ships physically —
// an all-digital product (`requires_shipping = 0` on every variant)
// suppresses the "Ships in 1–2 business days" line. Returns a normalised
// `{ in_stock, requires_shipping }` so the two render paths drive the
// badge + JSON-LD from the same shape. Defensive request-shape reader:
// missing/garbage inputs resolve to the available + physical default.
function _resolveAvailability(variants, inventoryBySku) {
  variants = Array.isArray(variants) ? variants : [];
  var inv = (inventoryBySku && typeof inventoryBySku === "object") ? inventoryBySku : null;
  var anyTracked = false;
  var anyInStock = false;
  var requiresShipping = false;
  for (var i = 0; i < variants.length; i += 1) {
    var v = variants[i] || {};
    // requires_shipping defaults to physical (true) unless the column is
    // explicitly 0/false — matches the catalog default for tangible goods.
    if (v.requires_shipping === undefined || v.requires_shipping === null ||
        Number(v.requires_shipping) !== 0) {
      requiresShipping = true;
    }
    if (inv && Object.prototype.hasOwnProperty.call(inv, v.sku)) {
      anyTracked = true;
      var row = inv[v.sku];
      var available = row ? (Number(row.stock_on_hand) - Number(row.stock_held)) : 0;
      if (available > 0) anyInStock = true;
    }
  }
  return {
    // No tracked variant → the operator hasn't opted into stock tracking,
    // so the product reads as in stock (never-block stance).
    in_stock:          anyTracked ? anyInStock : true,
    requires_shipping: variants.length === 0 ? true : requiresShipping,
  };
}

// PDP availability badges, driven by the resolved availability shape so
// the displayed state matches the JSON-LD `availability`. Mirrored byte-
// for-byte by worker/render/product.js#_buildAvailability.
function _buildAvailability(availability) {
  var a = availability || { in_stock: true, requires_shipping: true };
  var stockBadge = a.in_stock
    ? "<span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> In stock</span>"
    : "<span class=\"pdp__badge pdp__badge--out\">Out of stock</span>";
  // The "Ships in 1–2 business days" line only applies to a physical good;
  // an all-digital product suppresses it (nothing ships).
  var shipBadge = a.requires_shipping
    ? "<span class=\"pdp__badge\">Ships in 1–2 business days</span>"
    : "<span class=\"pdp__badge\">Digital — delivered on purchase</span>";
  return "<div class=\"pdp__meta\">\n" +
         "        " + stockBadge + "\n" +
         "        " + shipBadge + "\n" +
         "        <span class=\"pdp__badge\">Stripe-secured checkout</span>\n" +
         "      </div>";
}

// Short shipping/returns line under the buy box pointing shoppers at the
// public policy page. Physical goods get a shipping-and-returns line; a
// digital-only product drops the shipping half (no parcel to return).
// Mirrored byte-for-byte by worker/render/product.js#_pdpShippingNote.
function _pdpShippingNote(availability) {
  var a = availability || { in_stock: true, requires_shipping: true };
  var copy = a.requires_shipping
    ? "Free returns within 30 days. "
    : "";
  return "<p class=\"pdp__shipping-note\">" + copy +
         "See our <a href=\"/terms\">shipping &amp; returns policy</a>.</p>";
}

var PRODUCT_PAGE =
  "<section class=\"pdp\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">{{title}}</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <div class=\"pdp__grid\">\n" +
  "    <div class=\"pdp__gallery\">RAW_GALLERY_PLACEHOLDER</div>\n" +
  "    <div class=\"pdp__info\">\n" +
  "      <p class=\"eyebrow\">Catalog product</p>\n" +
  "      <h1 class=\"pdp__title\">{{title}}</h1>\n" +
  "      <p class=\"pdp__description\">{{description}}</p>\n" +
  "      RAW_AVAILABILITY_PLACEHOLDER\n" +
  "      RAW_BUYBOX_PLACEHOLDER\n" +
  "      RAW_SHIPPING_NOTE_PLACEHOLDER\n" +
  "      RAW_QTYBREAK_PLACEHOLDER\n" +
  "      RAW_WISHLIST_PLACEHOLDER\n" +
  "      RAW_COMPARE_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </div>\n" +
  "  RAW_BUNDLES_PLACEHOLDER\n" +
  "  RAW_REVIEWS_PLACEHOLDER\n" +
  "  RAW_QA_PLACEHOLDER\n" +
  "</section>\n";

// PDP gallery markup — composed once per render call from the
// product's media rows. When media is present, the first row drives
// the main figure (with `alt_text` for a11y) and up to three more
// rows feed the thumbnail strip below it. When media is absent the
// gallery falls back to the existing letter-mark placeholder so a
// freshly-seeded product never renders an empty square.
function _buildPdpGallery(product, media, assetPrefix) {
  var prefix = assetPrefix || "/assets/";
  function _escAttr(s) { return b.template.escapeHtml(s); }
  if (!media || media.length === 0) {
    return "<figure class=\"pdp__media pdp__media--placeholder\" aria-hidden=\"true\">" +
             "<svg class=\"media-ph__svg\" viewBox=\"0 0 240 240\" aria-hidden=\"true\"><rect width=\"240\" height=\"240\" fill=\"none\"/><g stroke=\"currentColor\" stroke-opacity=\"0.10\" stroke-width=\"1\"><path d=\"M0 40 H240 M0 80 H240 M0 120 H240 M0 160 H240 M0 200 H240 M40 0 V240 M80 0 V240 M120 0 V240 M160 0 V240 M200 0 V240\"/></g><g fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M120 64 L162 80 L162 122 C162 152 144 168 120 178 C96 168 78 152 78 122 L78 80 Z\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M120 92 L146 105 L146 134 L120 147 L94 134 L94 105 Z\"/><path d=\"M94 105 L120 118 L146 105 M120 118 V147\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M107 101 L112 105 L107 109\" stroke=\"currentColor\" stroke-width=\"2.4\"/><path d=\"M116 110 H128\" stroke=\"currentColor\" stroke-width=\"2.4\"/></g><text x=\"120\" y=\"208\" text-anchor=\"middle\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"12\" letter-spacing=\"2\" fill=\"#6b6b78\">no image yet</text></svg>" +
           "</figure>" +
           "<ul class=\"pdp__thumbs\" aria-hidden=\"true\">" +
             "<li class=\"is-active\"></li><li></li><li></li><li></li>" +
           "</ul>";
  }
  var hero = media[0];
  var heroUrl = prefix + hero.r2_key;
  var heroAlt = hero.alt_text || product.title || "Product image";
  var heroImg = "<figure class=\"pdp__media pdp__media--image\">" +
                  "<img src=\"" + _escAttr(heroUrl) + "\" alt=\"" + _escAttr(heroAlt) + "\" loading=\"eager\">" +
                "</figure>";
  // Thumbnail strip — up to four slots, the active one is the hero.
  // Real thumbnails come from additional media rows; missing slots
  // render as dashed placeholders so the strip's grid doesn't
  // collapse on a single-image product.
  var thumbs = ["<li class=\"is-active\">" +
                  "<img src=\"" + _escAttr(heroUrl) + "\" alt=\"\">" +
                "</li>"];
  for (var i = 1; i < Math.min(media.length, 4); i += 1) {
    var t = media[i];
    var tUrl = prefix + t.r2_key;
    thumbs.push("<li><img src=\"" + _escAttr(tUrl) + "\" alt=\"\"></li>");
  }
  while (thumbs.length < 4) thumbs.push("<li></li>");
  return heroImg + "<ul class=\"pdp__thumbs\" aria-hidden=\"true\">" + thumbs.join("") + "</ul>";
}

// Accessible star glyph row — the precise figure rides in a visually-
// hidden label so a screen reader announces "4.3 out of 5 stars" while
// sighted users see the rounded glyph fill. Mirrors the edge renderer
// (`worker/render/product.js`) so both paths emit identical markup.
function _reviewStars(value, label) {
  var esc = b.template.escapeHtml;
  var filled = Math.round(value);
  if (filled < 0) filled = 0;
  if (filled > 5) filled = 5;
  var glyphs = "";
  for (var i = 1; i <= 5; i += 1) {
    glyphs += "<span class=\"star" + (i <= filled ? " star--on" : "") + "\">" +
      (i <= filled ? "★" : "☆") + "</span>";
  }
  return "<span class=\"stars\" aria-hidden=\"true\">" + glyphs + "</span>" +
         "<span class=\"sr-only\">" + esc(label) + "</span>";
}

function _reviewDate(ts) {
  var n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n).toISOString().slice(0, 10);
}

// Builds the PDP reviews block from the published aggregate + list.
// Renders the "no reviews yet" empty state when the product has none;
// `ctaHtml` is the operator/customer call-to-action (a "Write a review"
// link, or "Sign in to review", resolved by the route). Mirrors the
// edge renderer byte-for-byte so the two render paths stay in sync.
function _buildReviews(summary, reviews, ctaHtml) {
  var esc = b.template.escapeHtml;
  summary = summary || { count: 0, avg_rating: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };
  reviews = reviews || [];
  var count = Number(summary.count) || 0;

  var head;
  if (count > 0) {
    var avg = Number(summary.avg_rating) || 0;
    var avgStr = avg.toFixed(1);
    var dist = summary.distribution || {};
    var bars = "";
    for (var s = 5; s >= 1; s -= 1) {
      var n   = Number(dist[s]) || 0;
      var pct = count > 0 ? Math.round((n / count) * 100) : 0;
      bars +=
        "<li class=\"rating-bar\">" +
          "<span class=\"rating-bar__label\">" + s + " star</span>" +
          "<span class=\"rating-bar__track\"><span class=\"rating-bar__fill\" style=\"width:" + pct + "%\"></span></span>" +
          "<span class=\"rating-bar__count\">" + n + "</span>" +
        "</li>";
    }
    head =
      "<div class=\"reviews__summary\">" +
        "<div class=\"reviews__average\">" +
          "<span class=\"reviews__average-num\">" + esc(avgStr) + "</span>" +
          _reviewStars(avg, avgStr + " out of 5 stars") +
          "<span class=\"reviews__count\">" + count + (count === 1 ? " review" : " reviews") + "</span>" +
        "</div>" +
        "<ul class=\"reviews__distribution\">" + bars + "</ul>" +
      "</div>";
  } else {
    head = "<p class=\"reviews__empty\">No reviews yet. Be the first to review this product.</p>";
  }

  var list = "";
  for (var i = 0; i < reviews.length; i += 1) {
    var r = reviews[i];
    var rating = Number(r.rating) || 0;
    var verified = Number(r.verified_purchase) === 1
      ? "<span class=\"review__verified\">Verified buyer</span>"
      : "";
    var date = _reviewDate(r.created_at);
    var bodyHtml = r.body
      ? "<p class=\"review__body\">" + esc(String(r.body)) + "</p>"
      : "";
    list +=
      "<li class=\"review\">" +
        "<div class=\"review__head\">" +
          _reviewStars(rating, rating + " out of 5 stars") +
          "<h3 class=\"review__title\">" + esc(String(r.title || "")) + "</h3>" +
        "</div>" +
        "<div class=\"review__meta\">" + verified +
          (date ? "<time class=\"review__date\" datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
        "</div>" +
        bodyHtml +
      "</li>";
  }
  var listHtml = list ? "<ul class=\"reviews__list\">" + list + "</ul>" : "";

  return "<section class=\"reviews\" aria-labelledby=\"reviews-title\">" +
           "<h2 id=\"reviews-title\" class=\"reviews__heading\">Customer reviews</h2>" +
           head +
           listHtml +
           (ctaHtml || "") +
         "</section>";
}

// Builds the PDP "Bundle & save" rail from the offers the route
// resolved. Each offer carries its component list (with display
// titles + per-member quantity), the sum-of-parts list price, the
// bundle price, and the saving — every figure already formatted to a
// currency string by the route (price math stays server-side; the
// builder is pure string assembly so the container + edge renderers
// emit byte-identical markup). An unavailable offer (a member is
// archived / out of stock) renders disabled with a reason instead of
// the add form, so a customer never hits a broken atomic add. Returns
// "" when there are no offers so the PDP shows no empty rail. Mirrors
// the edge renderer (`worker/render/product.js#_buildBundles`).
function _buildBundles(offers) {
  return _renderBundles(offers, b.template.escapeHtml);
}

// Shared pure-string assembler. `esc` is the caller's HTML-escaper
// (b.template.escapeHtml in the container, escapeHtml at the edge) —
// both produce the same output, so the markup is identical across
// render paths.
function _renderBundles(offers, esc) {
  offers = offers || [];
  if (offers.length === 0) return "";
  var cards = "";
  for (var i = 0; i < offers.length; i += 1) {
    var o = offers[i];
    var members = "";
    for (var j = 0; j < o.components.length; j += 1) {
      var c = o.components[j];
      members +=
        "<li class=\"bundle-card__member\">" +
          "<span class=\"bundle-card__member-qty\">" + esc(String(c.quantity)) + "&times;</span> " +
          "<span class=\"bundle-card__member-title\">" + esc(String(c.title)) + "</span> " +
          "<code class=\"bundle-card__member-sku\">" + esc(String(c.sku)) + "</code>" +
        "</li>";
    }
    var pricing =
      "<div class=\"bundle-card__pricing\">" +
        "<span class=\"bundle-card__list\">Buy separately " + esc(o.list_total_str) + "</span>" +
        "<span class=\"bundle-card__price price\">Bundle price " + esc(o.amount_str) + "</span>" +
        (o.discount_str ? "<span class=\"bundle-card__save\">You save " + esc(o.discount_str) + "</span>" : "") +
      "</div>";
    var action;
    if (o.available) {
      action =
        "<form method=\"post\" action=\"/cart/bundle\" class=\"bundle-card__form\">" +
          "<input type=\"hidden\" name=\"bundle_sku\" value=\"" + esc(o.bundle_sku) + "\">" +
          "<button type=\"submit\" class=\"btn-primary btn-primary--sm\">Add bundle to cart</button>" +
        "</form>";
    } else {
      action =
        "<p class=\"bundle-card__unavailable\">" +
          esc(o.unavailable_reason || "This bundle is currently unavailable.") +
        "</p>";
    }
    cards +=
      "<article class=\"bundle-card" + (o.available ? "" : " bundle-card--unavailable") + "\">" +
        "<h3 class=\"bundle-card__title\">" + esc(String(o.title)) + "</h3>" +
        "<ul class=\"bundle-card__members\">" + members + "</ul>" +
        pricing +
        action +
      "</article>";
  }
  return "<section class=\"bundles\" aria-labelledby=\"bundles-title\">" +
           "<h2 id=\"bundles-title\" class=\"bundles__heading\">Bundle &amp; save</h2>" +
           "<div class=\"bundles__grid\">" + cards + "</div>" +
         "</section>";
}

// Builds the PDP quantity-break table for the displayed variant. Each
// row is a (range label, unit price) pair the route already resolved +
// formatted (the unit price comes from the quantity-discount
// primitive's tierBreakdown against the variant's list price — the math
// is server-side; the builder only lays out strings). Returns "" when
// the product has no active breaks so the PDP shows no empty table.
// Mirrors the edge renderer (`worker/render/product.js#_buildQtyBreaks`).
function _buildQtyBreaks(breaks) {
  return _renderQtyBreaks(breaks, b.template.escapeHtml);
}

function _renderQtyBreaks(breaks, esc) {
  breaks = breaks || [];
  if (breaks.length === 0) return "";
  var rows = "";
  for (var i = 0; i < breaks.length; i += 1) {
    var br = breaks[i];
    rows +=
      "<tr>" +
        "<td class=\"qty-break__range\">" + esc(String(br.label)) + "</td>" +
        "<td class=\"qty-break__unit price\">" + esc(String(br.unit_str)) + "</td>" +
      "</tr>";
  }
  return "<div class=\"qty-breaks\">" +
           "<h2 class=\"qty-breaks__title\">Buy more, save more</h2>" +
           "<div class=\"table-scroll\">" +
             "<table class=\"qty-break-table\">" +
               "<thead><tr><th>Quantity</th><th>Price each</th></tr></thead>" +
               "<tbody>" + rows + "</tbody>" +
             "</table>" +
           "</div>" +
           "<p class=\"qty-breaks__note\">Discount applies automatically in your cart.</p>" +
         "</div>";
}

var REVIEW_FORM_PAGE =
  "<section class=\"review-form-page\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li><a href=\"/products/{{slug}}\">{{title}}</a></li>\n" +
  "      <li aria-current=\"page\">Write a review</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <h1 class=\"review-form-page__title\">Review {{title}}</h1>\n" +
  "  RAW_NOTICE_PLACEHOLDER\n" +
  "  <form class=\"review-form\" method=\"post\" action=\"/products/{{slug}}/review\">\n" +
  "    <fieldset class=\"review-form__rating\">\n" +
  "      <legend>Your rating</legend>\n" +
  "      RAW_STARS_PLACEHOLDER\n" +
  "    </fieldset>\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Title</span>\n" +
  "      <input type=\"text\" name=\"title\" maxlength=\"120\" required autocomplete=\"off\">\n" +
  "    </label>\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Your review</span>\n" +
  "      <textarea name=\"body\" maxlength=\"4000\" rows=\"6\"></textarea>\n" +
  "    </label>\n" +
  "    <button type=\"submit\" class=\"btn-primary\">Submit review</button>\n" +
  "  </form>\n" +
  "</section>\n";

// Auth-gated review form. `opts.product` carries { title, slug };
// `opts.notice` is an optional error string rendered above the form
// (e.g. a validation rejection bounced back from POST).
function renderReviewForm(opts) {
  var esc = b.template.escapeHtml;
  var slug = opts.product.slug;
  var stars = "";
  for (var rv = 5; rv >= 1; rv -= 1) {
    stars +=
      "<label class=\"star-radio\">" +
        "<input type=\"radio\" name=\"rating\" value=\"" + rv + "\" required>" +
        "<span>" + rv + (rv === 1 ? " star" : " stars") + "</span>" +
      "</label>";
  }
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body = _render(REVIEW_FORM_PAGE, {
    title: opts.product.title,
    slug:  slug,
  })
    .replace("RAW_NOTICE_PLACEHOLDER", notice)
    .replace("RAW_STARS_PLACEHOLDER", stars);
  return _wrap({
    title:      "Review " + opts.product.title,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Generic single-message page for the review flow (purchase-gate
// refusal, submission thank-you). `cta` is an optional { href, label }.
function _reviewMessagePage(opts, heading, message, cta) {
  var esc = b.template.escapeHtml;
  var ctaHtml = cta
    ? "<a class=\"btn-primary\" href=\"" + esc(cta.href) + "\">" + esc(cta.label) + "</a>"
    : "";
  var body =
    "<section class=\"review-message\">" +
      "<h1 class=\"review-message__title\">" + esc(heading) + "</h1>" +
      "<p class=\"review-message__lede\">" + esc(message) + "</p>" +
      ctaHtml +
    "</section>";
  return _wrap({
    title:      heading,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Builds the PDP Product Q&A block from the published questions + their
// approved answers. Renders the "no questions yet" empty state when the
// product has none; `ctaHtml` is the "Ask a question" call-to-action
// (resolved by the route). Reuses the reviews section's theme classes
// so no new CSS ships. Mirrors the edge renderer
// (`worker/render/product.js`) byte-for-byte so both render paths stay
// in sync.
function _buildProductQa(questions, ctaHtml) {
  var esc = b.template.escapeHtml;
  questions = questions || [];

  var head;
  if (questions.length > 0) {
    head = "<p class=\"reviews__count\">" + questions.length +
      (questions.length === 1 ? " question answered" : " questions answered") + "</p>";
  } else {
    head = "<p class=\"reviews__empty\">No questions yet. Be the first to ask about this product.</p>";
  }

  var list = "";
  for (var i = 0; i < questions.length; i += 1) {
    var q = questions[i];
    var answers = q.answers || [];
    var answerHtml = "";
    for (var j = 0; j < answers.length; j += 1) {
      var a = answers[j];
      var who = Number(a.is_operator) === 1
        ? "<span class=\"review__verified\">Answered by the seller</span>"
        : (a.author === "system"
            ? "<span class=\"review__verified\">Automated answer</span>"
            : "<span class=\"review__verified\">Customer answer</span>");
      var pinned = Number(a.pinned) === 1
        ? "<span class=\"review__verified\">Top answer</span>"
        : "";
      answerHtml +=
        "<li class=\"review qa__answer\">" +
          "<div class=\"review__meta\">" + who + pinned + "</div>" +
          "<p class=\"review__body\">" + esc(String(a.body)) + "</p>" +
        "</li>";
    }
    var answerList = answerHtml
      ? "<ul class=\"reviews__list qa__answers\">" + answerHtml + "</ul>"
      : "<p class=\"reviews__empty\">Awaiting an answer.</p>";
    list +=
      "<li class=\"review qa__question\">" +
        "<div class=\"review__head\">" +
          "<h3 class=\"review__title\">" + esc(String(q.body)) + "</h3>" +
        "</div>" +
        answerList +
      "</li>";
  }
  var listHtml = list ? "<ul class=\"reviews__list\">" + list + "</ul>" : "";

  return "<section class=\"reviews qa\" aria-labelledby=\"qa-title\">" +
           "<h2 id=\"qa-title\" class=\"reviews__heading\">Questions &amp; answers</h2>" +
           head +
           listHtml +
           (ctaHtml || "") +
         "</section>";
}

var QA_FORM_PAGE =
  "<section class=\"review-form-page\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li><a href=\"/products/{{slug}}\">{{title}}</a></li>\n" +
  "      <li aria-current=\"page\">Ask a question</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <h1 class=\"review-form-page__title\">Ask about {{title}}</h1>\n" +
  "  RAW_NOTICE_PLACEHOLDER\n" +
  "  <form class=\"review-form\" method=\"post\" action=\"/products/{{slug}}/question\">\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Your question</span>\n" +
  "      <textarea name=\"body\" maxlength=\"4000\" rows=\"6\" required></textarea>\n" +
  "    </label>\n" +
  "    <button type=\"submit\" class=\"btn-primary\">Submit question</button>\n" +
  "  </form>\n" +
  "</section>\n";

// Auth-gated question form. `opts.product` carries { title, slug };
// `opts.notice` is an optional error string rendered above the form
// (e.g. a validation rejection bounced back from POST).
function renderQuestionForm(opts) {
  var esc = b.template.escapeHtml;
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body = _render(QA_FORM_PAGE, {
    title: opts.product.title,
    slug:  opts.product.slug,
  })
    .replace("RAW_NOTICE_PLACEHOLDER", notice);
  return _wrap({
    title:      "Ask about " + opts.product.title,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Generic single-message page for the Q&A flow (submission thank-you).
// `cta` is an optional { href, label }. Reuses the review-message
// layout classes.
function _qaMessagePage(opts, heading, message, cta) {
  var esc = b.template.escapeHtml;
  var ctaHtml = cta
    ? "<a class=\"btn-primary\" href=\"" + esc(cta.href) + "\">" + esc(cta.label) + "</a>"
    : "";
  var body =
    "<section class=\"review-message\">" +
      "<h1 class=\"review-message__title\">" + esc(heading) + "</h1>" +
      "<p class=\"review-message__lede\">" + esc(message) + "</p>" +
      ctaHtml +
    "</section>";
  return _wrap({
    title:      heading,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Remove control for a wishlist entry — a form POST back through the
// toggle route with `return_to` so the customer lands back on the
// account page (not the product PDP the default toggle returns to).
function _wishlistRemoveForm(productId, esc) {
  return "<form class=\"wishlist-item__remove\" method=\"post\" action=\"/wishlist/toggle\">" +
           "<input type=\"hidden\" name=\"product_id\" value=\"" + esc(productId) + "\">" +
           "<input type=\"hidden\" name=\"return_to\" value=\"/account/wishlist\">" +
           "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button>" +
         "</form>";
}

// Account "Saved items" page. `opts.items` is a resolved list:
// { product, hero_media } for live products, or { product: null,
// product_id } for entries whose product was archived/deleted (the
// wishlist row is orphan-tolerant by design — render "unavailable",
// never crash the listing).
function renderWishlist(opts) {
  var esc = b.template.escapeHtml;
  var items = opts.items || [];
  var prefix = opts.asset_prefix || "/assets/";
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    if (!it.product) {
      rowsHtml +=
        "<li class=\"wishlist-item wishlist-item--gone\">" +
          "<span class=\"wishlist-item__title\">This item is no longer available.</span>" +
          _wishlistRemoveForm(it.product_id, esc) +
        "</li>";
      continue;
    }
    var slug = esc(it.product.slug);
    var thumb = it.hero_media
      ? "<img src=\"" + esc(prefix + it.hero_media.r2_key) + "\" alt=\"" + esc(it.hero_media.alt_text || it.product.title) + "\" loading=\"lazy\">"
      : "<span class=\"wishlist-item__mark\" aria-hidden=\"true\">" + esc((it.product.title || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    rowsHtml +=
      "<li class=\"wishlist-item\">" +
        "<a class=\"wishlist-item__media\" href=\"/products/" + slug + "\">" + thumb + "</a>" +
        "<div class=\"wishlist-item__body\">" +
          "<a class=\"wishlist-item__title\" href=\"/products/" + slug + "\">" + esc(it.product.title) + "</a>" +
          "<a class=\"wishlist-item__view card-link\" href=\"/products/" + slug + "\">View product →</a>" +
        "</div>" +
        _wishlistRemoveForm(it.product.id, esc) +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"wishlist-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M100 104 C70 82 60 64 60 50 C60 38 70 32 80 34 C88 35 96 42 100 50 C104 42 112 35 120 34 C130 32 140 38 140 50 C140 64 130 82 100 104 Z\"/><path d=\"M100 90 C82 76 76 64 76 54\" stroke=\"currentColor\" stroke-opacity=\"0.45\" stroke-width=\"1.8\" stroke-dasharray=\"2 4\"/><path d=\"M132 86 V98 M126 92 H138\" stroke=\"#732A8D\" stroke-width=\"2\"/></svg></p>" +
        "<p class=\"account-empty__lede\">You haven't saved anything yet. Browse the shop and tap <strong>Save to wishlist</strong> on products you want to keep an eye on.</p>" +
        "<a class=\"btn-secondary\" href=\"/\">Browse the shop →</a>" +
      "</div>";
  // Success confirmation after a wishlist toggle, surfaced via
  // role="status". Driven by the ?ok=<kind> redirect marker; unknown
  // keys render nothing so a forged query can't inject copy.
  var WISHLIST_OK = { added: "Saved to your wishlist.", removed: "Removed from your wishlist." };
  var okMsg = WISHLIST_OK[opts.notice];
  var notice = okMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(okMsg) + "</p>"
    : "";
  var body =
    "<section class=\"account-wishlist\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Saved items</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-wishlist__title\">Saved items</h1>" +
      notice +
      inner +
    "</section>";
  return _wrap({
    title:      "Saved items",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Compare page notice banner — surfaced after a toggle / a full-basket
// refusal. The route passes a short message key; unknown keys render
// nothing so a forged `?notice=` query can't inject arbitrary copy.
var COMPARE_NOTICES = {
  added:   "Added to your comparison.",
  removed: "Removed from your comparison.",
  full:    "Your comparison is full (4 products max). Remove one to add another.",
  cleared: "Comparison cleared.",
};
function _compareNotice(key) {
  var msg = COMPARE_NOTICES[key];
  if (!msg) return "";
  return "<p class=\"compare-page__notice\" role=\"status\">" + b.template.escapeHtml(msg) + "</p>";
}

// Side-by-side comparison table. `opts.columns` is the resolved per-
// product column list in basket order:
//   { product_id, product, hero_media, price, available }
// where `product` is null for a product archived / deleted between the
// add and this render (orphan-tolerant — the column renders "no longer
// available" and a remove control, never crashes the table). `opts.rows`
// is the attribute matrix from product-compare's `compareTable`:
//   [ { attribute: { slug, label, format }, values_per_product: [...] } ]
// each `values_per_product` entry positionally aligned with `columns`.
// The currency/number/boolean formatting happens here (the display
// layer), not in the primitive.
function _compareCellValue(value, format) {
  var esc = b.template.escapeHtml;
  if (value == null) return "<span class=\"compare-cell--empty\" aria-hidden=\"true\">—</span><span class=\"sr-only\">Not specified</span>";
  if (format === "currency") {
    var minor = Number(value);
    if (!Number.isFinite(minor)) return esc(String(value));
    return esc(pricing.format(Math.round(minor), "USD"));
  }
  if (format === "boolean") {
    return value ? "Yes" : "No";
  }
  return esc(String(value));
}

function renderCompare(opts) {
  var esc = b.template.escapeHtml;
  var columns = opts.columns || [];
  var attrRows = opts.rows || [];
  var prefix = opts.asset_prefix || "/assets/";
  var notice = _compareNotice(opts.notice);

  if (!columns.length) {
    var empty =
      "<section class=\"compare-page\">" +
        "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
          "<li><a href=\"/\">Shop</a></li>" +
          "<li aria-current=\"page\">Compare</li>" +
        "</ol></nav>" +
        "<h1 class=\"compare-page__title\">Compare products</h1>" +
        notice +
        "<p class=\"compare-page__empty\">You haven't added anything to compare yet. Browse the shop and tap " +
          "<strong>Add to compare</strong> on up to four products to line them up side by side.</p>" +
        "<p><a class=\"btn-secondary\" href=\"/\">Browse the shop →</a></p>" +
      "</section>";
    return _wrap({
      title:      "Compare products",
      shop_name:  opts.shop_name || "blamejs.shop",
      cart_count: opts.cart_count == null ? 0 : opts.cart_count,
      theme_css:  opts.theme_css,
      body:       empty,
    });
  }

  // Per-column header cell — image + title + remove form. A column whose
  // product resolved out (archived / deleted) renders the gone-state
  // header and still offers the remove control so the shopper can clear
  // the dangling entry.
  function _headerCell(col) {
    var removeForm =
      "<form class=\"compare-col__remove\" method=\"post\" action=\"/compare/toggle\">" +
        "<input type=\"hidden\" name=\"product_id\" value=\"" + esc(col.product_id) + "\">" +
        "<input type=\"hidden\" name=\"return_to\" value=\"/compare\">" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button>" +
      "</form>";
    if (!col.product) {
      return "<th scope=\"col\" class=\"compare-col compare-col--gone\">" +
               "<span class=\"compare-col__title\">No longer available</span>" +
               removeForm +
             "</th>";
    }
    var slug = esc(col.product.slug);
    var thumb = col.hero_media
      ? "<img src=\"" + esc(prefix + col.hero_media.r2_key) + "\" alt=\"" + esc(col.hero_media.alt_text || col.product.title) + "\" loading=\"lazy\">"
      : "<span class=\"compare-col__mark\" aria-hidden=\"true\">" + esc((col.product.title || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    return "<th scope=\"col\" class=\"compare-col\">" +
             "<a class=\"compare-col__media\" href=\"/products/" + slug + "\">" + thumb + "</a>" +
             "<a class=\"compare-col__title\" href=\"/products/" + slug + "\">" + esc(col.product.title) + "</a>" +
             removeForm +
           "</th>";
  }

  var headerCells = "";
  for (var h = 0; h < columns.length; h += 1) headerCells += _headerCell(columns[h]);

  // Fixed display rows resolved directly (richer than the attribute
  // matrix): price + availability. Price for a gone column renders "—".
  function _priceCell(col) {
    if (!col.product) return "<td class=\"compare-cell compare-cell--gone\">—</td>";
    return "<td class=\"compare-cell\">" + esc(col.price || "—") + "</td>";
  }
  function _availCell(col) {
    if (!col.product) return "<td class=\"compare-cell compare-cell--gone\">—</td>";
    return col.available
      ? "<td class=\"compare-cell\"><span class=\"compare-cell__badge compare-cell__badge--ok\">In stock</span></td>"
      : "<td class=\"compare-cell\"><span class=\"compare-cell__badge\">Out of stock</span></td>";
  }
  var priceRow = "<tr><th scope=\"row\" class=\"compare-row-label\">Price</th>";
  var availRow = "<tr><th scope=\"row\" class=\"compare-row-label\">Availability</th>";
  for (var c = 0; c < columns.length; c += 1) {
    priceRow += _priceCell(columns[c]);
    availRow += _availCell(columns[c]);
  }
  priceRow += "</tr>";
  availRow += "</tr>";

  // Attribute matrix rows from the primitive. The `price` attribute is
  // already surfaced as the fixed Price row above, so skip its duplicate
  // here; every other attribute renders one row, one cell per column.
  var attrRowsHtml = "";
  for (var r = 0; r < attrRows.length; r += 1) {
    var ar = attrRows[r];
    if (ar.attribute && ar.attribute.slug === "price") continue;
    var label = (ar.attribute && ar.attribute.label) || "";
    var fmt = ar.attribute && ar.attribute.format;
    var cells = "";
    var vals = ar.values_per_product || [];
    for (var v = 0; v < columns.length; v += 1) {
      cells += "<td class=\"compare-cell\">" + _compareCellValue(vals[v], fmt) + "</td>";
    }
    attrRowsHtml += "<tr><th scope=\"row\" class=\"compare-row-label\">" + esc(label) + "</th>" + cells + "</tr>";
  }

  var clearForm =
    "<form class=\"compare-page__clear\" method=\"post\" action=\"/compare/clear\">" +
      "<button type=\"submit\" class=\"btn-ghost\">Clear comparison</button>" +
    "</form>";

  var body =
    "<section class=\"compare-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/\">Shop</a></li>" +
        "<li aria-current=\"page\">Compare</li>" +
      "</ol></nav>" +
      "<header class=\"compare-page__head\">" +
        "<h1 class=\"compare-page__title\">Compare products (" + columns.length + ")</h1>" +
        clearForm +
      "</header>" +
      notice +
      "<div class=\"table-scroll\">" +
        "<table class=\"compare-table\">" +
          "<thead><tr><th scope=\"col\" class=\"compare-row-label\"><span class=\"sr-only\">Attribute</span></th>" + headerCells + "</tr></thead>" +
          "<tbody>" + priceRow + availRow + attrRowsHtml + "</tbody>" +
        "</table>" +
      "</div>" +
    "</section>";

  return _wrap({
    title:      "Compare products",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Account "Saved for later" page. `opts.items` is a resolved list:
// { save, product, hero_media } for live products, or { save,
// product: null } when the variant/product behind a saved row was
// archived (orphan-tolerant — render "no longer available").
function renderSaved(opts) {
  var esc = b.template.escapeHtml;
  var items = opts.items || [];
  var prefix = opts.asset_prefix || "/assets/";
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    var save = it.save;
    var moveForm =
      "<form method=\"post\" action=\"/saved/" + esc(save.id) + "/move-to-cart\">" +
        "<button type=\"submit\" class=\"btn-secondary btn-secondary--sm\">Move to cart</button></form>";
    var removeForm =
      "<form method=\"post\" action=\"/saved/" + esc(save.id) + "/remove\">" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button></form>";
    if (!it.product) {
      // Archived/unavailable product — only Remove. Move-to-cart can't
      // succeed (no current price / stock), so don't offer it.
      rowsHtml +=
        "<li class=\"saved-item saved-item--gone\">" +
          "<span class=\"saved-item__title\">" + esc(save.sku) + " — no longer available</span>" +
          "<div class=\"saved-item__actions\">" + removeForm + "</div>" +
        "</li>";
      continue;
    }
    var actions = "<div class=\"saved-item__actions\">" + moveForm + removeForm + "</div>";
    var slug = esc(it.product.slug);
    var thumb = it.hero_media
      ? "<img src=\"" + esc(prefix + it.hero_media.r2_key) + "\" alt=\"" + esc(it.hero_media.alt_text || it.product.title) + "\" loading=\"lazy\">"
      : "<span class=\"saved-item__mark\" aria-hidden=\"true\">" + esc((it.product.title || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    var priceStr = pricing.format(Number(save.snapshot_price_minor) || 0, "USD");
    rowsHtml +=
      "<li class=\"saved-item\">" +
        "<a class=\"saved-item__media\" href=\"/products/" + slug + "\">" + thumb + "</a>" +
        "<div class=\"saved-item__body\">" +
          "<a class=\"saved-item__title\" href=\"/products/" + slug + "\">" + esc(it.product.title) + "</a>" +
          "<span class=\"saved-item__meta\">Qty " + (Number(save.quantity) || 1) + " &middot; " + esc(priceStr) + " <span class=\"saved-item__snapshot\">(saved price)</span></span>" +
        "</div>" +
        actions +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"saved-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M78 32 H122 V104 L100 88 L78 104 Z\"/><path d=\"M90 58 H110\" stroke=\"currentColor\" stroke-opacity=\"0.45\" stroke-width=\"1.8\" stroke-dasharray=\"2 4\"/><circle cx=\"138\" cy=\"46\" r=\"12\" stroke=\"#732A8D\" stroke-width=\"2\"/><path d=\"M138 40 V46 L143 49\" stroke=\"#732A8D\" stroke-width=\"2\"/></svg></p>" +
        "<p class=\"account-empty__lede\">Nothing saved for later. Use <strong>Save for later</strong> on a cart item to move it here without losing it.</p>" +
        "<a class=\"btn-secondary\" href=\"/cart\">View your cart →</a>" +
      "</div>";
  // Success confirmation after a saved-list mutation (currently the
  // Remove action), surfaced via role="status". Unknown ?ok=<kind> keys
  // render nothing so a forged query can't inject copy.
  var SAVED_OK = { removed: "Removed from your saved items.", moved: "Moved to your cart." };
  var savedMsg = SAVED_OK[opts.notice];
  var notice = savedMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(savedMsg) + "</p>"
    : "";
  var body =
    "<section class=\"account-saved\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Saved for later</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-saved__title\">Saved for later</h1>" +
      notice +
      inner +
    "</section>";
  return _wrap({
    title:      "Saved for later",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// One labelled text input for the address form. `required` and other
// attrs are passed through; `value` is pre-filled (escaped) for edit.
function _addrField(name, labelText, value, opts) {
  var esc = b.template.escapeHtml;
  opts = opts || {};
  var attrs = "";
  if (opts.required) attrs += " required";
  if (opts.maxlength) attrs += " maxlength=\"" + opts.maxlength + "\"";
  if (opts.pattern) attrs += " pattern=\"" + esc(opts.pattern) + "\"";
  if (opts.autocomplete) attrs += " autocomplete=\"" + esc(opts.autocomplete) + "\"";
  // The `*` is a color-only visual cue; pair it with a visually-hidden
  // "(required)" so a screen reader announces the field's requiredness.
  var req = opts.required ? " <span class=\"form-field__req\" aria-hidden=\"true\">*</span><span class=\"sr-only\">(required)</span>" : "";
  return "<label class=\"form-field\">" +
           "<span class=\"form-field__label\">" + esc(labelText) + req + "</span>" +
           "<input type=\"text\" name=\"" + esc(name) + "\" value=\"" + esc(value == null ? "" : String(value)) + "\"" + attrs + ">" +
         "</label>";
}

// Shared add/edit address form. `addr` pre-fills for edit (null = add).
function _addressForm(action, addr, submitLabel) {
  var esc = b.template.escapeHtml;
  addr = addr || {};
  function _checked(v) { return Number(v) === 1 ? " checked" : ""; }
  return "<form class=\"address-form form-stack\" method=\"post\" action=\"" + esc(action) + "\">" +
    _addrField("recipient_name", "Recipient name", addr.recipient_name, { required: true, maxlength: 120, autocomplete: "name" }) +
    _addrField("label", "Label (e.g. Home, Work)", addr.label, { maxlength: 60 }) +
    _addrField("company", "Company", addr.company, { maxlength: 120, autocomplete: "organization" }) +
    _addrField("street_line1", "Street address", addr.street_line1, { required: true, maxlength: 200, autocomplete: "address-line1" }) +
    _addrField("street_line2", "Apt / suite / unit", addr.street_line2, { maxlength: 200, autocomplete: "address-line2" }) +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("city", "City", addr.city, { required: true, maxlength: 120, autocomplete: "address-level2" }) +
      _addrField("region", "State / region", addr.region, { maxlength: 120, autocomplete: "address-level1" }) +
    "</div>" +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("postal_code", "Postal code", addr.postal_code, { required: true, maxlength: 32, autocomplete: "postal-code" }) +
      _addrField("country", "Country (ISO 3166-1)", addr.country || "US", { required: true, maxlength: 2, pattern: "[A-Za-z]{2}", autocomplete: "country" }) +
    "</div>" +
    _addrField("phone", "Phone", addr.phone, { maxlength: 40, autocomplete: "tel" }) +
    "<label class=\"address-form__check\"><input type=\"checkbox\" name=\"is_default_shipping\" value=\"1\"" + _checked(addr.is_default_shipping) + "> Default shipping address</label>" +
    "<label class=\"address-form__check\"><input type=\"checkbox\" name=\"is_default_billing\" value=\"1\"" + _checked(addr.is_default_billing) + "> Default billing address</label>" +
    "<button type=\"submit\" class=\"btn-primary\">" + esc(submitLabel) + "</button>" +
  "</form>";
}

// Account address book. `opts.addresses` is the customer's non-archived
// rows; `opts.edit` (when set) pre-fills the form for editing that row,
// otherwise the form is a blank "add" form.
function renderAddresses(opts) {
  var esc = b.template.escapeHtml;
  var list = opts.addresses || [];
  var rowsHtml = "";
  for (var i = 0; i < list.length; i += 1) {
    var a = list[i];
    var badges =
      (Number(a.is_default_shipping) === 1 ? "<span class=\"address-card__badge\">Default shipping</span>" : "") +
      (Number(a.is_default_billing) === 1 ? "<span class=\"address-card__badge\">Default billing</span>" : "");
    var lines = [a.recipient_name, a.company, a.street_line1, a.street_line2,
      [a.city, a.region, a.postal_code].filter(Boolean).join(", "), a.country, a.phone]
      .filter(function (x) { return x != null && String(x).length; })
      .map(function (x) { return "<span>" + esc(String(x)) + "</span>"; }).join("");
    rowsHtml +=
      "<li class=\"address-card\">" +
        (a.label ? "<p class=\"address-card__label\">" + esc(a.label) + "</p>" : "") +
        (badges ? "<p class=\"address-card__badges\">" + badges + "</p>" : "") +
        "<address class=\"address-card__body\">" + lines + "</address>" +
        "<div class=\"address-card__actions\">" +
          "<a class=\"btn-ghost btn-ghost--sm\" href=\"/account/addresses/" + esc(a.id) + "/edit\">Edit</a>" +
          (Number(a.is_default_shipping) === 1 ? "" : "<form method=\"post\" action=\"/account/addresses/" + esc(a.id) + "/default-shipping\"><button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Set default shipping</button></form>") +
          (Number(a.is_default_billing) === 1 ? "" : "<form method=\"post\" action=\"/account/addresses/" + esc(a.id) + "/default-billing\"><button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Set default billing</button></form>") +
          "<a class=\"btn-ghost btn-ghost--sm\" href=\"/account/addresses/" + esc(a.id) + "/remove\">Remove</a>" +
        "</div>" +
      "</li>";
  }
  var listHtml = rowsHtml
    ? "<ul class=\"address-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M100 110 C84 90 74 76 74 60 A26 26 0 0 1 126 60 C126 76 116 90 100 110 Z\"/><path d=\"M88 64 L100 52 L112 64 M91 61 V74 H109 V61\" stroke=\"#732A8D\" stroke-width=\"2.2\"/><path d=\"M97 74 V67 H103 V74\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></p>" +
        "<p class=\"account-empty__lede\">No saved addresses yet. Add one below to speed up checkout.</p>" +
      "</div>";
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  // Success confirmation after an address mutation (add / edit / remove /
  // set-default), surfaced at the top of the list via role="status" so a
  // screen reader announces it without stealing focus. Driven by the
  // ?ok=<kind> redirect the POST handlers set on success. A remove also
  // threads ?undo=<id> so the notice can offer a one-click un-archive.
  var undoForm = opts.undo_id
    ? " <form class=\"form-notice__undo\" method=\"post\" action=\"/account/addresses/" + esc(String(opts.undo_id)) + "/unarchive\">" +
        "<button type=\"submit\" class=\"btn-link\">Undo</button>" +
      "</form>"
    : "";
  var success = opts.success
    ? "<div class=\"form-notice form-notice--ok\" role=\"status\"><span>" + esc(String(opts.success)) + "</span>" + undoForm + "</div>"
    : "";
  var editing = opts.edit || null;
  var formHeading = editing ? "Edit address" : "Add an address";
  var formAction  = editing ? ("/account/addresses/" + editing.id) : "/account/addresses";
  var body =
    "<section class=\"account-addresses\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Addresses</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-addresses__title\">Addresses</h1>" +
      success +
      listHtml +
      "<h2 class=\"account-addresses__form-title\">" + esc(formHeading) + "</h2>" +
      notice +
      _addressForm(formAction, editing, editing ? "Save changes" : "Add address") +
    "</section>";
  return _wrap({
    title:      "Addresses",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Server-rendered confirmation step for removing a saved address. CSP
// forbids an inline confirm() dialog, so the destructive action is gated
// by a second page: a POST form that actually archives, plus a Cancel
// link back to the list. JS-off-native — no client script involved.
function renderAddressRemoveConfirm(opts) {
  var esc = b.template.escapeHtml;
  var a = opts.address || {};
  var lines = [a.recipient_name, a.company, a.street_line1, a.street_line2,
    [a.city, a.region, a.postal_code].filter(Boolean).join(", "), a.country, a.phone]
    .filter(function (x) { return x != null && String(x).length; })
    .map(function (x) { return "<span>" + esc(String(x)) + "</span>"; }).join("");
  var body =
    "<section class=\"account-confirm\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/addresses\">Addresses</a></li>" +
        "<li aria-current=\"page\">Remove address</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-confirm__title\">Remove this address?</h1>" +
      (a.label ? "<p class=\"address-card__label\">" + esc(a.label) + "</p>" : "") +
      "<address class=\"address-card__body\">" + lines + "</address>" +
      "<p class=\"account-confirm__lede\">This removes the address from your address book. " +
        "You can add it again later.</p>" +
      "<div class=\"account-confirm__actions\">" +
        "<form method=\"post\" action=\"/account/addresses/" + esc(a.id) + "/archive\">" +
          "<button type=\"submit\" class=\"btn-primary\">Remove address</button>" +
        "</form>" +
        "<a class=\"btn-ghost\" href=\"/account/addresses\">Cancel</a>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Remove address",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Storefront collection index — operator-curated + smart product lists.
function renderCollectionList(opts) {
  var esc = b.template.escapeHtml;
  var cols = opts.collections || [];
  var cardsHtml = "";
  for (var i = 0; i < cols.length; i += 1) {
    var c = cols[i];
    var media = c.hero_image_url
      ? "<figure class=\"collection-index-card__media\"><img src=\"" + esc((opts.asset_prefix || "/assets/") + c.hero_image_url) + "\" alt=\"" + esc(c.title) + "\" loading=\"lazy\"></figure>"
      : "<figure class=\"collection-index-card__media collection-index-card__media--empty\" aria-hidden=\"true\"></figure>";
    cardsHtml +=
      "<a class=\"collection-index-card\" href=\"/collections/" + esc(c.slug) + "\">" +
        media +
        "<div class=\"collection-index-card__meta\">" +
          "<h2 class=\"collection-index-card__title\">" + esc(c.title) + "</h2>" +
          (c.description ? "<p class=\"collection-index-card__desc\">" + esc(c.description) + "</p>" : "") +
        "</div>" +
      "</a>";
  }
  var inner = cardsHtml
    ? "<div class=\"collection-index-grid\">" + cardsHtml + "</div>"
    : "<p class=\"collection-empty\">No collections yet.</p>";
  var body =
    "<section class=\"collection-index\">" +
      "<header class=\"section-head\"><p class=\"eyebrow\">Browse</p>" +
        "<h1 class=\"section-head__title\">Collections</h1></header>" +
      inner +
    "</section>";
  return _wrap({
    title: "Collections", shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css, body: body,
  });
}

// A single collection's page — title + description + product grid. The
// route resolves each member product into the { slug, title, price,
// image_url } shape `_buildProductCard` expects.
function renderCollection(opts) {
  var esc = b.template.escapeHtml;
  var col = opts.collection;
  var products = opts.products || [];
  var cards = products.map(function (p) { return _buildProductCard(p); }).join("");
  var grid = cards
    ? "<div class=\"catalog-grid collection-grid\">" + cards + "</div>"
    : "<p class=\"collection-empty\">No products in this collection yet.</p>";
  var body =
    "<section class=\"collection-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/\">Shop</a></li>" +
        "<li><a href=\"/collections\">Collections</a></li>" +
        "<li aria-current=\"page\">" + esc(col.title) + "</li>" +
      "</ol></nav>" +
      "<header class=\"collection-page__head\">" +
        "<h1 class=\"collection-page__title\">" + esc(col.title) + "</h1>" +
        (col.description ? "<p class=\"collection-page__desc\">" + esc(col.description) + "</p>" : "") +
      "</header>" +
      grid +
    "</section>";
  return _wrap({
    title: col.title, shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css, body: body,
  });
}

// Storefront category index — the top-level category tree. Each card
// links into a category browse page. Reuses the collection-index card
// shell (same visual contract) so no new CSS ships. `opts.categories`
// is the hydrated [{ slug, title, description, hero_image_url }] list of
// active top-level categories (archived rows are dropped by the lib).
function renderCategoryIndex(opts) {
  var esc = b.template.escapeHtml;
  var cats = opts.categories || [];
  var cardsHtml = "";
  for (var i = 0; i < cats.length; i += 1) {
    var c = cats[i];
    var media = c.hero_image_url
      ? "<figure class=\"collection-index-card__media\"><img src=\"" + esc(_categoryHeroSrc(c.hero_image_url, opts.asset_prefix)) + "\" alt=\"" + esc(c.title) + "\" loading=\"lazy\"></figure>"
      : "<figure class=\"collection-index-card__media collection-index-card__media--empty\" aria-hidden=\"true\"></figure>";
    cardsHtml +=
      "<a class=\"collection-index-card\" href=\"/categories/" + esc(c.slug) + "\">" +
        media +
        "<div class=\"collection-index-card__meta\">" +
          "<h2 class=\"collection-index-card__title\">" + esc(c.title) + "</h2>" +
          (c.description ? "<p class=\"collection-index-card__desc\">" + esc(c.description) + "</p>" : "") +
        "</div>" +
      "</a>";
  }
  var inner = cardsHtml
    ? "<div class=\"collection-index-grid\">" + cardsHtml + "</div>"
    : "<p class=\"collection-empty\">No categories yet.</p>";
  var body =
    "<section class=\"collection-index\">" +
      "<header class=\"section-head\"><p class=\"eyebrow\">Browse</p>" +
        "<h1 class=\"section-head__title\">Categories</h1></header>" +
      inner +
    "</section>";
  return _wrap({
    title: "Categories", shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css,
    og_description: "Browse every product category in the " + (opts.shop_name || "blamejs.shop") + " catalog.",
    canonical_url: opts.canonical_url, og_url: opts.og_url,
    body: body,
  });
}

// A single category's page — breadcrumb (root -> current), title,
// optional description + hero, and a grid of the category's direct
// child sub-categories. `opts.breadcrumbs` is the root->current chain
// (the last entry is the current category, rendered as plain text);
// `opts.children` is the hydrated direct-child list (empty -> graceful
// empty state). Reuses the collection-page + collection-index card
// shells so no new CSS ships.
function renderCategory(opts) {
  var esc = b.template.escapeHtml;
  var cat = opts.category;
  var crumbs = opts.breadcrumbs || [];
  var children = opts.children || [];

  var crumbHtml = "<li><a href=\"/\">Shop</a></li><li><a href=\"/categories\">Categories</a></li>";
  for (var ci = 0; ci < crumbs.length; ci += 1) {
    var bc = crumbs[ci];
    if (ci === crumbs.length - 1) {
      crumbHtml += "<li aria-current=\"page\">" + esc(bc.title) + "</li>";
    } else {
      crumbHtml += "<li><a href=\"/categories/" + esc(bc.slug) + "\">" + esc(bc.title) + "</a></li>";
    }
  }

  // Hero reuses the collection-index card media shell (aspect-ratio +
  // object-fit cover) so no new CSS ships; it's a standalone figure
  // rather than a card link here.
  var hero = cat.hero_image_url
    ? "<figure class=\"collection-index-card__media\"><img src=\"" + esc(_categoryHeroSrc(cat.hero_image_url, opts.asset_prefix)) + "\" alt=\"" + esc(cat.title) + "\"></figure>"
    : "";

  var cardsHtml = "";
  for (var i = 0; i < children.length; i += 1) {
    var ch = children[i];
    var media = ch.hero_image_url
      ? "<figure class=\"collection-index-card__media\"><img src=\"" + esc(_categoryHeroSrc(ch.hero_image_url, opts.asset_prefix)) + "\" alt=\"" + esc(ch.title) + "\" loading=\"lazy\"></figure>"
      : "<figure class=\"collection-index-card__media collection-index-card__media--empty\" aria-hidden=\"true\"></figure>";
    cardsHtml +=
      "<a class=\"collection-index-card\" href=\"/categories/" + esc(ch.slug) + "\">" +
        media +
        "<div class=\"collection-index-card__meta\">" +
          "<h2 class=\"collection-index-card__title\">" + esc(ch.title) + "</h2>" +
          (ch.description ? "<p class=\"collection-index-card__desc\">" + esc(ch.description) + "</p>" : "") +
        "</div>" +
      "</a>";
  }
  var grid = cardsHtml
    ? "<div class=\"collection-index-grid\">" + cardsHtml + "</div>"
    : "<p class=\"collection-empty\">No sub-categories here yet.</p>";

  var body =
    "<section class=\"collection-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        crumbHtml +
      "</ol></nav>" +
      "<header class=\"collection-page__head\">" +
        "<h1 class=\"collection-page__title\">" + esc(cat.title) + "</h1>" +
        (cat.description ? "<p class=\"collection-page__desc\">" + esc(cat.description) + "</p>" : "") +
      "</header>" +
      hero +
      grid +
    "</section>";
  // Per-page meta description: the category's own description when set,
  // otherwise a "Shop {category}…" pitch.
  var catMetaDescription = (cat.description && String(cat.description).trim().length)
    ? String(cat.description)
    : ("Shop " + cat.title + " at " + (opts.shop_name || "blamejs.shop") + ".");
  return _wrap({
    title: cat.title, shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css,
    og_description: catMetaDescription,
    canonical_url: opts.canonical_url, og_url: opts.og_url,
    body: body,
  });
}

// Resolve a category hero_image_url into a renderable src. The lib gates
// hero_image_url to https:// OR a /-rooted absolute path at write time,
// so an absolute https URL or a /-rooted path is used as-is; any other
// value (a bare R2 key) is prefixed with the card asset prefix the same
// way collection hero media resolves.
function _categoryHeroSrc(url, assetPrefix) {
  if (typeof url !== "string" || !url.length) return "";
  if (url.charCodeAt(0) === 47 /* "/" */) return url;
  if (/^https:\/\//i.test(url)) return url;
  return (assetPrefix || "/assets/") + url;
}

// Account "Recently viewed" page — a newest-first grid of products the
// signed-in customer has opened, reusing the standard product card.
// `opts.products` is a resolved [{ slug, title, price, image_url,
// image_alt }] list (archived products are dropped before render, so
// the grid is orphan-tolerant). A "Clear history" control renders only
// when the list is non-empty.
function renderRecentlyViewed(opts) {
  var products = opts.products || [];
  var cards = products.map(function (p) { return _buildProductCard(p); }).join("");
  var grid = cards
    ? "<div class=\"catalog-grid recently-viewed-grid\">" + cards + "</div>"
    : "<p class=\"recently-viewed-empty\">You haven't viewed any products yet. As you browse the shop, the products you open show up here.</p>";
  var clear = cards
    ? "<form class=\"recently-viewed__clear\" method=\"post\" action=\"/account/recently-viewed/clear\">" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Clear history</button></form>"
    : "";
  var body =
    "<section class=\"account-recently-viewed\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Recently viewed</li>" +
      "</ol></nav>" +
      "<header class=\"account-recently-viewed__head\">" +
        "<h1 class=\"account-recently-viewed__title\">Recently viewed</h1>" +
        clear +
      "</header>" +
      grid +
    "</section>";
  return _wrap({
    title: "Recently viewed", shop_name: opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css, body: body,
  });
}

var RETURN_REASONS = [
  ["defective", "Defective / doesn't work"],
  ["wrong-item", "Wrong item received"],
  ["not-as-described", "Not as described"],
  ["no-longer-needed", "No longer needed"],
  ["damaged-in-transit", "Damaged in transit"],
  ["other", "Other"],
];

function _returnStatusBadge(status) {
  return "<span class=\"return-status return-status--" + b.template.escapeHtml(String(status)) + "\">" +
    b.template.escapeHtml(String(status)) + "</span>";
}

// Customer-facing return-request form for one order. `opts.order` is the
// order row, `opts.lines` its order_lines. `opts.notice` is an optional
// error bounced back from a failed POST.
function renderReturnForm(opts) {
  var esc = b.template.escapeHtml;
  var order = opts.order;
  var lines = opts.lines || [];
  var lineRows = "";
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    lineRows +=
      "<li class=\"return-line\">" +
        "<label class=\"return-line__pick\">" +
          "<input type=\"checkbox\" name=\"return_" + esc(l.id) + "\" value=\"1\">" +
          "<span class=\"return-line__sku\"><code>" + esc(l.sku) + "</code></span>" +
        "</label>" +
        "<label class=\"return-line__qty\">Qty to return " +
          "<input type=\"number\" name=\"qty_" + esc(l.id) + "\" value=\"" + (Number(l.qty) || 1) + "\" min=\"1\" max=\"" + (Number(l.qty) || 1) + "\">" +
          " <span class=\"return-line__of\">of " + (Number(l.qty) || 1) + "</span>" +
        "</label>" +
      "</li>";
  }
  var reasonOpts = RETURN_REASONS.map(function (r) {
    return "<option value=\"" + esc(r[0]) + "\">" + esc(r[1]) + "</option>";
  }).join("");
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body =
    "<section class=\"return-form-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/returns\">Returns</a></li>" +
        "<li aria-current=\"page\">Request a return</li>" +
      "</ol></nav>" +
      "<h1 class=\"return-form-page__title\">Request a return</h1>" +
      "<p class=\"return-form-page__order\">Order <code>" + esc(order.id) + "</code></p>" +
      notice +
      "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/orders/" + esc(order.id) + "/return\">" +
        "<fieldset class=\"return-form__lines\"><legend>Which items?</legend>" +
          "<ul class=\"return-line-list\">" + lineRows + "</ul>" +
        "</fieldset>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Reason</span>" +
          "<select name=\"reason\" required>" + reasonOpts + "</select></label>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Notes (optional)</span>" +
          "<textarea name=\"customer_notes\" maxlength=\"2000\" rows=\"4\"></textarea></label>" +
        "<button type=\"submit\" class=\"btn-primary\">Request return</button>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Request a return",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Customer's return-authorization list.
function renderReturns(opts) {
  var esc = b.template.escapeHtml;
  var rmas = opts.rmas || [];
  var rowsHtml = "";
  for (var i = 0; i < rmas.length; i += 1) {
    var r = rmas[i];
    var date = r.created_at ? new Date(Number(r.created_at)).toISOString().slice(0, 10) : "";
    rowsHtml +=
      "<li class=\"return-card\">" +
        "<div class=\"return-card__head\">" +
          "<code class=\"return-card__rma\">" + esc(r.rma_code) + "</code>" +
          _returnStatusBadge(r.status) +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(r.reason || "")) +
          (date ? " &middot; <time datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
          (Number(r.refund_amount_minor) > 0 ? " &middot; refund " + esc(pricing.format(Number(r.refund_amount_minor), r.refund_currency || "USD")) : "") +
        "</p>" +
        (r.status === "rejected" && r.rejected_reason ? "<p class=\"return-card__reject\">" + esc(String(r.rejected_reason)) + "</p>" : "") +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"return-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M66 64 L100 50 L134 64 L100 78 Z\"/><path d=\"M66 64 V92 L100 106 L134 92 V64 M100 78 V106\"/><path d=\"M100 36 A20 20 0 0 1 120 56\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M100 28 L100 40 L110 38\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M88 70 H112\" stroke=\"currentColor\" stroke-opacity=\"0.45\" stroke-width=\"1.8\" stroke-dasharray=\"2 4\"/></svg></p>" +
        "<p class=\"account-empty__lede\">No returns yet. Start one from an order in your account.</p>" +
        "<a class=\"btn-secondary\" href=\"/account/orders\">View your orders →</a>" +
      "</div>";
  // Success confirmation after submitting a return request. The RMA code
  // round-trips on the ?ok=<code> redirect so the notice can echo it back
  // — the operator-readable handle the customer references in support.
  // Validate the shape (RMA-YYMMDD-AAAAA) so a forged query can't inject
  // arbitrary copy into the status message.
  var notice = "";
  if (opts.rma_code && /^RMA-\d{6}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/.test(String(opts.rma_code))) {
    notice = "<p class=\"form-notice form-notice--ok\" role=\"status\">Return request received — RMA " +
      esc(String(opts.rma_code)) + ". We'll email you when it's reviewed.</p>";
  }
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Returns</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Returns</h1>" +
      notice +
      inner +
    "</section>";
  return _wrap({
    title:      "Returns",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Loyalty transaction-type pill — reuses the `pdp__badge` class the
// theme already styles. The type is one of the ledger's closed enum
// (earn / redeem / expire / adjust / tier-bonus).
function _loyaltyTxBadge(type) {
  var esc = b.template.escapeHtml;
  return "<span class=\"pdp__badge loyalty-tx--" + esc(String(type)) + "\">" + esc(String(type)) + "</span>";
}

// Human label for a reward `kind` + its value payload. Keeps the
// catalog row readable without leaking the raw value_json shape.
function _loyaltyRewardValue(reward) {
  var v = reward.value_json || {};
  if (reward.kind === "discount_percent") return (Number(v.percent) || 0) + "% off";
  if (reward.kind === "discount_amount")  return pricing.format(Number(v.amount_minor) || 0, "USD") + " off";
  if (reward.kind === "free_shipping")    return "Free shipping";
  if (reward.kind === "free_product")     return "Free product";
  return reward.kind;
}

// Earn-rule trigger → customer-facing phrase. Operators see slugs;
// customers see plain language. Unknown triggers fall back to the raw
// trigger so a future enum addition still renders something.
var LOYALTY_TRIGGER_LABELS = {
  per_dollar_spent:         "per $1 spent",
  per_purchase:             "per order",
  per_review:               "per review you write",
  per_referral_redeemed:    "per friend you refer",
  birthday:                 "on your birthday",
  signup_bonus:             "when you sign up",
  first_purchase:           "on your first order",
  abandoned_cart_recovered: "when you complete a saved cart",
};

// The signed-in customer's loyalty surface: balance + tier, how points
// are earned (active earn rules), the reward catalog (redeem control
// when wired), the earn/redeem ledger (paginated), and past
// redemptions. Reuses the account/returns layout classes — no new CSS.
function renderLoyalty(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var bal = opts.balance || { balance: 0, lifetime: 0, tier: "bronze" };
  var ratio = Number(opts.redemption_points_per_usd) || 100;

  var notice = opts.notice
    ? "<p class=\"form-notice" + (opts.notice_kind === "error" ? " form-notice--error" : "") + "\" role=\"alert\">" +
        esc(String(opts.notice)) + "</p>"
    : "";

  // Stats strip — balance / tier / lifetime / spendable value.
  var spendableValue = pricing.format(Math.floor((Number(bal.balance) || 0) * 100 / ratio), "USD");
  var stats =
    "<dl class=\"account-dash__stats\">" +
      "<div><dt>Points balance</dt><dd>" + esc(String(Number(bal.balance) || 0)) + "</dd></div>" +
      "<div><dt>Tier</dt><dd>" + esc(String(bal.tier || "bronze")) + "</dd></div>" +
      "<div><dt>Lifetime points</dt><dd>" + esc(String(Number(bal.lifetime) || 0)) + "</dd></div>" +
      "<div><dt>Worth</dt><dd>" + esc(spendableValue) + "</dd></div>" +
    "</dl>";

  // How points are earned.
  var rules = opts.earn_rules || [];
  var earnInner = "";
  for (var i = 0; i < rules.length; i += 1) {
    var rule = rules[i];
    var label = LOYALTY_TRIGGER_LABELS[rule.trigger] || rule.trigger;
    earnInner +=
      "<li class=\"return-card\"><div class=\"return-card__head\">" +
        "<span>" + esc(String(rule.points_per_unit)) + " points " + esc(label) + "</span>" +
      "</div></li>";
  }
  var earnSection = earnInner
    ? "<h2 class=\"pdp__variants-title\">How you earn points</h2><ul class=\"return-list\">" + earnInner + "</ul>"
    : "<h2 class=\"pdp__variants-title\">How you earn points</h2>" +
      "<p class=\"return-empty\">Earn points on every order — your balance grows as you shop.</p>";

  // Reward catalog + redeem control.
  var rewards = opts.rewards || [];
  var rewardSection = "";
  if (rewards.length) {
    var rewardItems = "";
    for (var r = 0; r < rewards.length; r += 1) {
      var rw = rewards[r];
      var affordable = (Number(bal.balance) || 0) >= Number(rw.point_cost);
      var action;
      if (opts.can_redeem) {
        action = "<form method=\"post\" action=\"/account/loyalty/redeem\">" +
          "<input type=\"hidden\" name=\"reward_slug\" value=\"" + esc(rw.slug) + "\">" +
          "<button type=\"submit\" class=\"btn-primary\"" + (affordable ? "" : " disabled") + ">" +
          (affordable ? "Redeem" : "Not enough points") + "</button></form>";
      } else {
        action = "";
      }
      rewardItems +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">" + esc(rw.title) + "</span>" +
          "<span class=\"pdp__badge\">" + esc(_loyaltyRewardValue(rw)) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(rw.point_cost)) + " points</p>" +
        action +
        "</li>";
    }
    rewardSection =
      "<h2 class=\"pdp__variants-title\">Redeem your points</h2>" +
      "<ul class=\"return-list\">" + rewardItems + "</ul>";
  }

  // Past redemptions.
  var reds = opts.redemptions || [];
  var redSection = "";
  if (reds.length) {
    var redItems = "";
    for (var d = 0; d < reds.length; d += 1) {
      var red = reds[d];
      var rdate = red.redeemed_at ? new Date(Number(red.redeemed_at)).toISOString().slice(0, 10) : "";
      redItems +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">" + esc(red.reward_slug) + "</span>" +
          "<span class=\"pdp__badge loyalty-tx--" + esc(String(red.status)) + "\">" + esc(String(red.status)) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(red.points_debited)) + " points" +
          (rdate ? " &middot; <time datetime=\"" + esc(rdate) + "\">" + esc(rdate) + "</time>" : "") +
          (red.coupon_code ? " &middot; code <code>" + esc(red.coupon_code) + "</code>" : "") +
        "</p></li>";
    }
    redSection = "<h2 class=\"pdp__variants-title\">Your redemptions</h2><ul class=\"return-list\">" + redItems + "</ul>";
  }

  // Earn/redeem ledger (paginated).
  var hist = opts.history || [];
  var histInner = "";
  for (var h = 0; h < hist.length; h += 1) {
    var tx = hist[h];
    var tdate = tx.occurred_at ? new Date(Number(tx.occurred_at)).toISOString().slice(0, 10) : "";
    var pts = Number(tx.points) || 0;
    var ptsStr = (pts > 0 ? "+" : "") + pts;
    histInner +=
      "<li class=\"return-card\"><div class=\"return-card__head\">" +
        _loyaltyTxBadge(tx.transaction_type) +
        "<span class=\"return-card__rma\">" + esc(ptsStr) + " points</span>" +
      "</div>" +
      "<p class=\"return-card__meta\">" + esc(String(tx.source || "")) +
        (tdate ? " &middot; <time datetime=\"" + esc(tdate) + "\">" + esc(tdate) + "</time>" : "") +
        (tx.notes ? " &middot; " + esc(String(tx.notes)) : "") +
      "</p></li>";
  }
  var historySection;
  if (histInner) {
    var more = opts.history_next_cursor != null
      ? "<p class=\"loyalty-more\"><a class=\"btn-secondary\" href=\"/account/loyalty?cursor=" +
          esc(String(opts.history_next_cursor)) + "\">Older activity</a></p>"
      : "";
    historySection = "<h2 class=\"pdp__variants-title\">Activity</h2><ul class=\"return-list\">" + histInner + "</ul>" + more;
  } else {
    historySection = "<h2 class=\"pdp__variants-title\">Activity</h2>" +
      "<p class=\"return-empty\">No points activity yet. Place an order to start earning.</p>";
  }

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Rewards</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Rewards</h1>" +
      notice +
      stats +
      rewardSection +
      earnSection +
      redSection +
      historySection +
    "</section>";

  return _wrap({
    title:      "Rewards",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Human-readable funnel stage for a referred friend. The referred
// email is stored hash-only, so a row never carries an address — the
// surface shows the stage + dates only.
var REFERRAL_STAGE_LABELS = {
  pending:     "Invited",
  visited:     "Visited",
  "signed-up": "Joined",
  converted:   "Converted",
};

// Initials for a leaderboard row — first letter of each whitespace-
// separated word in the display name, up to two, uppercased. Falls back
// to a neutral glyph when the name is empty / whitespace. NEVER renders
// the full name, the email (which is hash-only anyway), or the customer
// id — the public-ish leaderboard surface exposes rank + initials only.
function _referralInitials(displayName) {
  var s = String(displayName == null ? "" : displayName).trim();
  if (!s) return "–";
  var words = s.split(/\s+/);
  var out = "";
  for (var i = 0; i < words.length && out.length < 2; i += 1) {
    var w = words[i];
    if (w.length) out += w.charAt(0);
  }
  return out.toUpperCase() || "–";
}

// The signed-in customer's referral surface: their personal code +
// shareable link, the friends they've referred (funnel stage + dates,
// no PII), the reward funnel summary, and an in-account top-referrer
// leaderboard (rank + initials only — never names/emails/ids). Reuses
// the account/returns layout classes — no new CSS.
function renderReferrals(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;

  var notice = opts.notice
    ? "<p class=\"form-notice" + (opts.notice_kind === "error" ? " form-notice--error" : "") + "\" role=\"alert\">" +
        esc(String(opts.notice)) + "</p>"
    : "";

  // Code + shareable link. `code`/`link` are null until the customer
  // mints one (the empty state offers a Create-code button).
  var code = opts.code || null;
  var link = opts.link || null;
  var codeSection;
  if (code && link) {
    codeSection =
      "<dl class=\"account-dash__stats\">" +
        "<div><dt>Your referral code</dt><dd><code>" + esc(String(code)) + "</code></dd></div>" +
        "<div><dt>Friends converted</dt><dd>" + esc(String(Number(opts.completed_referrals) || 0)) + "</dd></div>" +
        "<div><dt>Friends joined</dt><dd>" + esc(String(Number(opts.invitations_signed_up) || 0)) + "</dd></div>" +
        "<div><dt>Friends invited</dt><dd>" + esc(String(Number(opts.invitations_total) || 0)) + "</dd></div>" +
      "</dl>" +
      "<h2 class=\"pdp__variants-title\">Share your link</h2>" +
      "<p class=\"return-card__meta\">Share this link with friends. Anyone who signs up through it and places their first order is counted here as your referral.</p>" +
      "<p><a class=\"btn-secondary\" href=\"" + esc(String(link)) + "\">" + esc(String(link)) + "</a></p>";
  } else {
    codeSection =
      "<p class=\"return-empty\">You don't have a referral code yet. Create one to start inviting friends.</p>" +
      "<form method=\"post\" action=\"/account/referrals/code\">" +
        "<div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Create my referral code</button></div>" +
      "</form>";
  }

  // Friends referred — funnel stage + dates, no identity.
  var friends = opts.invitations || [];
  var friendsSection;
  if (friends.length) {
    var items = "";
    for (var i = 0; i < friends.length; i += 1) {
      var f = friends[i];
      var stageLabel = REFERRAL_STAGE_LABELS[f.stage] || f.stage || "Invited";
      var when = f.invited_at ? new Date(Number(f.invited_at)).toISOString().slice(0, 10) : "";
      var converted = f.first_purchase_at
        ? new Date(Number(f.first_purchase_at)).toISOString().slice(0, 10)
        : "";
      items +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">Friend " + esc(String(i + 1)) + "</span>" +
          "<span class=\"pdp__badge referral-stage--" + esc(String(f.stage || "pending")) + "\">" + esc(stageLabel) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" +
          (when ? "Invited <time datetime=\"" + esc(when) + "\">" + esc(when) + "</time>" : "") +
          (converted ? " &middot; converted <time datetime=\"" + esc(converted) + "\">" + esc(converted) + "</time>" : "") +
        "</p></li>";
    }
    friendsSection = "<h2 class=\"pdp__variants-title\">Friends you've referred</h2><ul class=\"return-list\">" + items + "</ul>";
  } else {
    friendsSection = "<h2 class=\"pdp__variants-title\">Friends you've referred</h2>" +
      "<p class=\"return-empty\">No referrals yet. Share your link above to get started.</p>";
  }

  // In-account leaderboard — rank + initials only. The signed-in
  // customer's own row is marked "You".
  var board = opts.leaderboard || [];
  var boardSection = "";
  if (board.length) {
    var rows = "";
    for (var j = 0; j < board.length; j += 1) {
      var entry = board[j];
      var who = entry.is_you ? "You" : _referralInitials(entry.display_name);
      rows +=
        "<li class=\"return-card\"><div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">#" + esc(String(j + 1)) + " " + esc(who) + "</span>" +
          "<span class=\"pdp__badge\">" + esc(String(Number(entry.completed_referrals) || 0)) + " referred</span>" +
        "</div></li>";
    }
    boardSection = "<h2 class=\"pdp__variants-title\">Top referrers</h2><ul class=\"return-list\">" + rows + "</ul>";
  }

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Refer a friend</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Refer a friend</h1>" +
      notice +
      codeSection +
      friendsSection +
      boardSection +
    "</section>";

  return _wrap({
    title:      "Refer a friend",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Subscription status pill — mirrors `_returnStatusBadge`. The status
// string is one of Stripe's enum values (active, trialing, past_due,
// canceled, …), surfaced as a CSS-classed badge the theme can style.
function _subscriptionStatusBadge(status) {
  return "<span class=\"subscription-status subscription-status--" + b.template.escapeHtml(String(status)) + "\">" +
    b.template.escapeHtml(String(status)) + "</span>";
}

// A subscription is cancelable from the storefront while it's still
// billing — active or trialing, and not already wound down at period
// end. A canceled / past_due / incomplete row shows no Cancel control.
var CANCELABLE_SUB_STATUSES = ["active", "trialing", "past_due"];
function _subscriptionIsCancelable(sub) {
  return CANCELABLE_SUB_STATUSES.indexOf(sub.status) !== -1 && Number(sub.cancel_at_period_end) !== 1;
}

// Customer-facing subscription list. `opts.subscriptions` is an array of
// subscription rows, each optionally carrying a resolved `plan` (joined
// by the route). `opts.can_cancel` is false when the deploy has no
// payment handle wired — the list renders read-only with a note, since
// cancel composes Stripe. Empty state points at the catalog (creation is
// a separate Stripe-subscription-checkout surface, not built here).
function renderAccountSubscriptions(opts) {
  var esc = b.template.escapeHtml;
  var subs = opts.subscriptions || [];
  var canCancel = opts.can_cancel !== false;
  var rowsHtml = "";
  for (var i = 0; i < subs.length; i += 1) {
    var s = subs[i];
    var plan = s.plan || null;
    var planSummary = "";
    if (plan) {
      var every = Number(plan.interval_count) > 1
        ? "every " + Number(plan.interval_count) + " " + esc(String(plan.interval)) + "s"
        : "per " + esc(String(plan.interval));
      // Plans mirror Stripe's lowercase currency; pricing.format wants
      // the uppercase ISO 4217 code. A malformed currency / amount on a
      // row falls back to the interval-only summary rather than throwing
      // out of the renderer.
      var ccy = String(plan.currency || "usd").toUpperCase();
      var priceStr;
      try { priceStr = esc(pricing.format(Number(plan.amount_minor), ccy)) + " "; }
      catch (_e) { priceStr = ""; }
      planSummary = priceStr + every;
    } else {
      planSummary = "Plan unavailable";
    }
    var periodEnd = s.current_period_end
      ? new Date(Number(s.current_period_end)).toISOString().slice(0, 10)
      : "";
    var renewalNote = "";
    if (Number(s.cancel_at_period_end) === 1 && periodEnd) {
      renewalNote = "Ends <time datetime=\"" + esc(periodEnd) + "\">" + esc(periodEnd) + "</time>";
    } else if (periodEnd) {
      renewalNote = "Renews <time datetime=\"" + esc(periodEnd) + "\">" + esc(periodEnd) + "</time>";
    }
    var cancelControl = "";
    if (canCancel && _subscriptionIsCancelable(s)) {
      // The cancel decision (and its "immediate vs. at period end"
      // consequence) is confirmed on a dedicated page — CSP forbids an
      // inline confirm() dialog, so the destructive step is a second
      // server-rendered screen rather than a one-click POST.
      cancelControl =
        "<a class=\"btn-ghost btn-ghost--sm subscription-card__cancel-link\" href=\"/account/subscriptions/" + esc(s.id) + "/cancel\">Cancel subscription</a>";
    }
    rowsHtml +=
      "<li class=\"subscription-card\">" +
        "<div class=\"subscription-card__head\">" +
          "<span class=\"subscription-card__plan\">" + planSummary + "</span>" +
          _subscriptionStatusBadge(s.status) +
        "</div>" +
        (renewalNote ? "<p class=\"subscription-card__meta\">" + renewalNote + "</p>" : "") +
        cancelControl +
      "</li>";
  }
  var note = canCancel
    ? ""
    : "<p class=\"subscription-note\">Cancellation isn't available on this store yet. Contact support to make changes.</p>";
  var inner = rowsHtml
    ? note + "<ul class=\"subscription-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M74 30 H126 V104 L118 98 L110 104 L100 98 L90 104 L82 98 L74 104 Z\"/><path d=\"M86 48 H114 M86 62 H114\" stroke=\"#732A8D\" stroke-width=\"2.2\"/><path d=\"M86 76 H106\" stroke=\"currentColor\" stroke-opacity=\"0.45\" stroke-width=\"1.8\" stroke-dasharray=\"2 4\"/></svg></p>" +
        "<p class=\"account-empty__lede\">You have no active subscriptions.</p>" +
        "<a class=\"btn-secondary\" href=\"/\">Browse the shop →</a>" +
      "</div>";
  var body =
    "<section class=\"account-subscriptions\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Subscriptions</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-subscriptions__title\">Subscriptions</h1>" +
      (opts.notice ? "<p class=\"form-notice\" role=\"status\">" + esc(String(opts.notice)) + "</p>" : "") +
      inner +
    "</section>";
  return _wrap({
    title:      "Subscriptions",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Server-rendered confirmation step for canceling a subscription. CSP
// forbids an inline confirm() dialog, so the destructive choice is gated
// by this page: it spells out the period-end date and, for the
// "cancel immediately" path, the days of access forfeited. Two POST
// forms (at-period-end / immediate) plus a Cancel link back to the list.
// JS-off-native.
function renderSubscriptionCancelConfirm(opts) {
  var esc = b.template.escapeHtml;
  var s = opts.subscription || {};
  var plan = s.plan || null;
  var planSummary = "this subscription";
  if (plan) {
    var ccy = String(plan.currency || "usd").toUpperCase();
    var every = Number(plan.interval_count) > 1
      ? "every " + Number(plan.interval_count) + " " + String(plan.interval) + "s"
      : "per " + String(plan.interval);
    var priceStr = "";
    try { priceStr = pricing.format(Number(plan.amount_minor), ccy) + " "; } catch (_e) { priceStr = ""; }
    planSummary = priceStr + every;
  }
  var periodEndMs = Number(s.current_period_end) || 0;
  var periodEnd = periodEndMs ? new Date(periodEndMs).toISOString().slice(0, 10) : "";
  // Days of paid access forfeited if canceled immediately rather than at
  // period end — computed from now to the period boundary, floored at 0.
  var forfeitDays = 0;
  if (periodEndMs) {
    forfeitDays = Math.max(0, Math.ceil((periodEndMs - Date.now()) / b.constants.TIME.days(1)));
  }
  var periodLine = periodEnd
    ? "<p class=\"account-confirm__lede\">Your current period is paid through " +
        "<time datetime=\"" + esc(periodEnd) + "\">" + esc(periodEnd) + "</time>.</p>"
    : "";
  var atPeriodEndForm =
    "<form method=\"post\" action=\"/account/subscriptions/" + esc(s.id) + "/cancel\">" +
      "<p class=\"account-confirm__option\">Cancel at period end" +
        (periodEnd ? " — keep access until <time datetime=\"" + esc(periodEnd) + "\">" + esc(periodEnd) + "</time>, then it won't renew." : ", so it won't renew.") +
      "</p>" +
      "<button type=\"submit\" class=\"btn-primary\">Cancel at period end</button>" +
    "</form>";
  var immediateForm =
    "<form method=\"post\" action=\"/account/subscriptions/" + esc(s.id) + "/cancel\">" +
      "<input type=\"hidden\" name=\"immediate\" value=\"1\">" +
      "<p class=\"account-confirm__option\">Cancel immediately" +
        (forfeitDays > 0
          ? " — access ends now and you forfeit the remaining " + forfeitDays + " day" + (forfeitDays === 1 ? "" : "s") + " of this period."
          : " — access ends now.") +
      "</p>" +
      "<button type=\"submit\" class=\"btn-ghost\">Cancel immediately</button>" +
    "</form>";
  var body =
    "<section class=\"account-confirm\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/subscriptions\">Subscriptions</a></li>" +
        "<li aria-current=\"page\">Cancel</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-confirm__title\">Cancel " + esc(planSummary) + "?</h1>" +
      periodLine +
      "<div class=\"account-confirm__actions\">" +
        atPeriodEndForm +
        immediateForm +
        "<a class=\"btn-ghost\" href=\"/account/subscriptions\">Keep my subscription</a>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Cancel subscription",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Product-level "Save to wishlist" control + social-proof count.
// Byte-compatible with the edge renderer (`worker/render/product.js`)
// so both paths emit identical markup. Action-only label — the toggle
// route resolves add/remove server-side against the sealed session.
function _buildWishlist(productId, count) {
  var esc = b.template.escapeHtml;
  var n = Number(count) || 0;
  var countHtml = n > 0
    ? "<span class=\"wishlist__count\">" + n + (n === 1 ? " shopper saved this" : " shoppers saved this") + "</span>"
    : "";
  return "<div class=\"wishlist\">" +
           "<form class=\"wishlist__form\" method=\"post\" action=\"/wishlist/toggle\">" +
             "<input type=\"hidden\" name=\"product_id\" value=\"" + esc(productId) + "\">" +
             "<button type=\"submit\" class=\"btn-secondary wishlist__btn\">" +
               "<span class=\"wishlist__heart\" aria-hidden=\"true\">♡</span> Save to wishlist" +
             "</button>" +
           "</form>" +
           countHtml +
         "</div>";
}

// Product-level "Add to compare" control. Byte-compatible with the
// edge renderer (`worker/render/product.js`) so both paths emit
// identical markup. Action-only label — the toggle route resolves
// add/remove server-side against the sealed session, and a guest who
// has never compared anything still sees the same neutral control the
// edge cache serves. The link to the compare table sits beside the
// toggle so a shopper mid-basket can jump straight to the side-by-side
// view.
function _buildCompare(productId) {
  var esc = b.template.escapeHtml;
  return "<div class=\"compare\">" +
           "<form class=\"compare__form\" method=\"post\" action=\"/compare/toggle\">" +
             "<input type=\"hidden\" name=\"product_id\" value=\"" + esc(productId) + "\">" +
             "<button type=\"submit\" class=\"btn-secondary compare__btn\">" +
               "<span class=\"compare__icon\" aria-hidden=\"true\">⇄</span> Add to compare" +
             "</button>" +
           "</form>" +
           "<a class=\"compare__link card-link\" href=\"/compare\">View compare →</a>" +
         "</div>";
}

// Schema.org JSON-LD block. JSON.stringify covers the standard escapes;
// the `</` → `<\/` rewrite neutralises any literal `</script>` in a
// value. Mirrors the edge renderer's `jsonLdScript`.
function _jsonLdScript(data) {
  var serialised = JSON.stringify(data).replace(/<\/(?=script>)/gi, "<\\/");
  return "<script type=\"application/ld+json\">" + serialised + "</script>";
}

function renderProduct(opts) {
  if (!opts || !opts.product) throw new TypeError("storefront.renderProduct: opts.product required");
  var variants = opts.variants || [];
  var prices   = opts.prices   || {};   // { variant_id: { currency, amount_minor } }
  var shopName = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var description = opts.product.description || "";
  var fmt = _priceFormatter(opts);
  var rendered = variants.map(function (v) {
    var price = prices[v.id];
    var priceStr = price ? fmt(price.amount_minor, price.currency) : "—";
    var vTitle = v.title || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || "Default");
    return { id: v.id, sku: v.sku, title: vTitle, price: priceStr };
  });
  if (opts.theme) {
    return opts.theme.render("product", {
      title:          opts.product.title,
      shop_name:      shopName,
      cart_count:     cartCount,
      product:        { title: opts.product.title, description: description },
      variants:       rendered,
      has_variants:   rendered.length > 0,
      // Pre-rendered reviews block (internally HTML-escaped) for the
      // theme's `{{{ reviews_html }}}` raw slot. The bundled themes
      // include the slot; a custom theme opts in by adding it.
      reviews_html:   _buildReviews(opts.review_summary, opts.reviews, opts.review_cta),
      qa_html:        _buildProductQa(opts.qa_questions, opts.qa_cta),
      bundles_html:   _buildBundles(opts.bundle_offers),
      qty_breaks_html: _buildQtyBreaks(opts.qty_breaks),
      wishlist_html:  _buildWishlist(opts.product.id, opts.wishlist_count),
      compare_html:   _buildCompare(opts.product.id),
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  // Truthful availability + shipping shape — drives the on-page badges
  // AND the JSON-LD `availability` from the same resolved values so the
  // two never disagree. `opts.inventory` is the per-SKU map the route
  // loads ({ sku: { stock_on_hand, stock_held } }); absent it, the
  // product reads as in stock (never-block-on-missing-inventory stance).
  var availability = _resolveAvailability(variants, opts.inventory);
  var buyboxHtml = _buildBuyBox(rendered, b.template.escapeHtml);
  var availabilityHtml = _buildAvailability(availability);
  var shippingNoteHtml = _pdpShippingNote(availability);
  var galleryHtml = _buildPdpGallery(opts.product, opts.media || [], opts.asset_prefix || "/assets/");
  var reviewsHtml = _buildReviews(opts.review_summary, opts.reviews, opts.review_cta);
  var qaHtml = _buildProductQa(opts.qa_questions, opts.qa_cta);
  var bundlesHtml = _buildBundles(opts.bundle_offers);
  var qtyBreaksHtml = _buildQtyBreaks(opts.qty_breaks);
  var wishlistHtml = _buildWishlist(opts.product.id, opts.wishlist_count);
  var compareHtml = _buildCompare(opts.product.id);
  var body = _render(PRODUCT_PAGE, {
    title:        opts.product.title,
    description:  description,
  })
    .replace("RAW_GALLERY_PLACEHOLDER", galleryHtml)
    .replace("RAW_AVAILABILITY_PLACEHOLDER", availabilityHtml)
    .replace("RAW_BUYBOX_PLACEHOLDER", buyboxHtml)
    .replace("RAW_SHIPPING_NOTE_PLACEHOLDER", shippingNoteHtml)
    .replace("RAW_QTYBREAK_PLACEHOLDER", qtyBreaksHtml)
    .replace("RAW_WISHLIST_PLACEHOLDER", wishlistHtml)
    .replace("RAW_COMPARE_PLACEHOLDER", compareHtml)
    .replace("RAW_BUNDLES_PLACEHOLDER", bundlesHtml)
    .replace("RAW_REVIEWS_PLACEHOLDER", reviewsHtml)
    .replace("RAW_QA_PLACEHOLDER", qaHtml);
  // Product-specific OpenGraph + Twitter Card values so shares
  // unfurl as "Operator Tee — blamejs.shop" with the SVG hero, not
  // the default shop-level description + brand logo.
  var heroMedia = (opts.media && opts.media[0]) || null;
  var ogImage   = heroMedia ? ((opts.asset_prefix || "/assets/") + heroMedia.r2_key) : "/assets/brand/logo.png";
  // Absolute base for the BreadcrumbList `item` URLs — derived from the
  // PDP's own canonical (origin stripped of the /products/slug path) so
  // the structured-data trail carries fully-qualified URLs. Falls back to
  // the shop-name host when the renderer is called without a request URL.
  var absoluteBase = _absoluteBase(opts.canonical_url, shopName);

  // Product + AggregateOffer JSON-LD, with AggregateRating folded in
  // when published reviews exist. Kept byte-compatible with the edge
  // renderer so the structured data is identical whichever substrate
  // serves the PDP. AggregateRating is omitted (not null) at zero
  // reviews — Google rejects `reviewCount: 0`.
  var priceList = variants
    .map(function (v) { return prices[v.id] ? prices[v.id].amount_minor : null; })
    .filter(function (n) { return Number.isInteger(n); });
  var jsonLd = null;
  if (priceList.length > 0) {
    var lowMinor = Math.min.apply(null, priceList);
    var hiMinor  = Math.max.apply(null, priceList);
    var currency = (prices[variants[0].id] && prices[variants[0].id].currency) || "USD";
    var divisor  = currency === "JPY" || currency === "KRW" ? 1 : 100;
    var aggregateRating;
    if (opts.review_summary && Number(opts.review_summary.count) > 0) {
      aggregateRating = {
        "@type":       "AggregateRating",
        "ratingValue": (Number(opts.review_summary.avg_rating) || 0).toFixed(1),
        "reviewCount": Number(opts.review_summary.count),
        "bestRating":  5,
        "worstRating": 1,
      };
    }
    jsonLd = _jsonLdScript({
      "@context":        "https://schema.org",
      "@type":           "Product",
      "name":            opts.product.title,
      "description":     description || ("Browse " + opts.product.title + " on " + shopName + "."),
      "image":           heroMedia ? [ogImage] : undefined,
      "sku":             variants[0] && variants[0].sku,
      "aggregateRating": aggregateRating,
      "offers":          {
        "@type":         "AggregateOffer",
        "priceCurrency": currency,
        "lowPrice":      (lowMinor / divisor).toFixed(divisor === 1 ? 0 : 2),
        "highPrice":     (hiMinor  / divisor).toFixed(divisor === 1 ? 0 : 2),
        "offerCount":    variants.length,
        "availability":  availability.in_stock
          ? "https://schema.org/InStock"
          : "https://schema.org/OutOfStock",
      },
    });
  }
  var breadcrumbJsonLd = _jsonLdScript({
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Shop", "item": absoluteBase + "/" },
      { "@type": "ListItem", "position": 2, "name": opts.product.title, "item": absoluteBase + "/products/" + opts.product.slug },
    ],
  });
  jsonLd = (jsonLd || "") + breadcrumbJsonLd;

  return _wrap(Object.assign({
    title:          opts.product.title,
    shop_name:      shopName,
    cart_count:     cartCount,
    theme_css:      opts.theme_css,
    og_type:        "product",
    og_title:       opts.product.title + " — " + shopName,
    og_description: description || ("Browse " + opts.product.title + " on " + shopName + "."),
    og_image:       ogImage,
    canonical_url:  opts.canonical_url,
    og_url:         opts.og_url,
    body:           body + jsonLd,
  }, _currencyWrapOpts(opts)));
}

// ---- cart --------------------------------------------------------------

// Read-only line — shown on the order confirmation page. Same
// thumbnail + title + SKU chip pattern as CART_LINE_EDITABLE,
// minus the qty/remove forms. The product cell is still a
// slug-linked anchor so the customer can re-open the PDP from the
// order page.
var CART_LINE =
  "<tr>\n" +
  "  <td class=\"cart-line__product\">\n" +
  "    <a class=\"cart-line__product-link\" href=\"{{product_url}}\">\n" +
  "      RAW_ORDER_LINE_THUMB\n" +
  "      <span class=\"cart-line__product-meta\">\n" +
  "        <span class=\"cart-line__product-title\">{{product_title}}</span>\n" +
  "        <code class=\"cart-line__sku-chip\">{{sku}}</code>\n" +
  "      </span>\n" +
  "    </a>\n" +
  "  </td>\n" +
  "  <td data-label=\"Qty\">{{qty}}</td>\n" +
  "  <td class=\"price\" data-label=\"Unit\">{{unit}}</td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "</tr>\n";

// Editable cart line — shown on the /cart page. Includes an inline
// qty form (POST /cart/lines/:id/update) and a remove form (POST
// /cart/lines/:id/remove). HTML forms don't natively support
// PATCH/DELETE so the framework routes use POST with verb-suffix
// paths.
// Editable cart line. The first cell carries a small media tile +
// the product title + the SKU code chip below it; without media,
// the tile drops to a dashed-border placeholder so the row's grid
// doesn't collapse. `product_url` is the slug-linked anchor so the
// visitor can re-enter the PDP from the cart without retyping.
var CART_LINE_EDITABLE =
  "<tr>\n" +
  "  <td class=\"cart-line__product\">\n" +
  "    <a class=\"cart-line__product-link\" href=\"{{product_url}}\">\n" +
  "      RAW_CART_LINE_THUMB\n" +
  "      <span class=\"cart-line__product-meta\">\n" +
  "        <span class=\"cart-line__product-title\">{{product_title}}</span>\n" +
  "        <code class=\"cart-line__sku-chip\">{{sku}}</code>\n" +
  "      </span>\n" +
  "    </a>\n" +
  "  </td>\n" +
  "  <td class=\"cart-line__qty\" data-label=\"Qty\">\n" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/update\" class=\"cart-line__update\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"{{qty}}\" min=\"1\" max=\"99999\" class=\"cart-line__qty-input\" aria-label=\"Quantity\">\n" +
  "      <button type=\"submit\" class=\"cart-line__btn cart-line__btn--update\">Update</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "  <td class=\"price\" data-label=\"Price\">{{unit}}</td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "  <td class=\"cart-line__remove-cell\">\n" +
  "    RAW_CART_LINE_SAVE" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/remove\">\n" +
  "      <button type=\"submit\" class=\"cart-line__btn cart-line__btn--remove\" aria-label=\"Remove line\">Remove</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "</tr>\n";

// ---- checkout form + payment page + order confirmation -----------------

// The shipping-address fieldset for checkout. Reuses `_addrField` (the
// same labelled-input builder the account address book uses) so the
// checkout + saved-address forms collect an identical address shape.
// `p` pre-fills each field (from a signed-in customer's default shipping
// address); every value is escaped by `_addrField` / the email builder.
// Street line 1 + city are marked required for the common physical-goods
// path; the backend (checkout._shipTo) is authoritative and treats them
// as optional so a digital-only order still completes.
function _checkoutShippingFields(p) {
  p = p || {};
  var esc = b.template.escapeHtml;
  var email =
    "<label class=\"form-field\">" +
      "<span class=\"form-field__label\">Email <span class=\"form-field__req\" aria-hidden=\"true\">*</span><span class=\"sr-only\">(required)</span></span>" +
      "<input type=\"email\" name=\"email\" value=\"" + esc(p.email == null ? "" : String(p.email)) + "\" required autocomplete=\"email\">" +
    "</label>";
  return email +
    _addrField("name",  "Full name",      p.name,  { required: true, maxlength: 120, autocomplete: "name" }) +
    _addrField("line1", "Street address", p.line1, { required: true, maxlength: 200, autocomplete: "address-line1" }) +
    _addrField("line2", "Apt / suite / unit (optional)", p.line2, { maxlength: 200, autocomplete: "address-line2" }) +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("city",  "City", p.city, { required: true, maxlength: 120, autocomplete: "address-level2" }) +
      _addrField("state", "State / province code", p.state, { maxlength: 5, pattern: "[A-Za-z0-9]{1,5}", autocomplete: "address-level1" }) +
    "</div>" +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("postal",  "Postal code", p.postal, { maxlength: 16, autocomplete: "postal-code" }) +
      _addrField("country", "Country (ISO 3166-1)", p.country || "US", { required: true, maxlength: 2, pattern: "[A-Za-z]{2}", autocomplete: "country" }) +
    "</div>";
}

// Build the order's ship_to from a checkout POST body. Shared by the
// card-form POST and the PayPal create call so both persist an identical
// address shape. A blank field becomes `undefined` (omitted) rather than
// "" so checkout._shipTo's optional-field checks aren't tripped by an
// empty input; country + state are upper-cased to match the ISO
// validators, the free-text street/city fields are trimmed only.
function _shipToFromBody(body) {
  body = body || {};
  return {
    country: (body.country || "").toUpperCase(),
    state:   body.state ? String(body.state).toUpperCase() : undefined,
    postal:  body.postal || undefined,
    line1:   body.line1 ? String(body.line1).trim() : undefined,
    line2:   body.line2 ? String(body.line2).trim() : undefined,
    city:    body.city  ? String(body.city).trim()  : undefined,
  };
}

// Checkout mirrors the cart's two-column shell: the shipping form on the
// left, a sticky order-summary rail on the right. The summary lists the
// cart line items + the Subtotal, then the cart's exact honest microcopy
// — tax + shipping can't be computed until the address is entered, so no
// fabricated "Total" is shown. An "Edit cart" link near the summary lets
// the shopper change quantities without losing form data.
var CHECKOUT_PAGE =
  "<section class=\"checkout-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Checkout</p>\n" +
  "    <h1 class=\"section-head__title\">Shipping details</h1>\n" +
  "    <p class=\"section-head__lede\">Enter where the order should ship. Payment runs through Stripe on the next step.</p>\n" +
  "  </header>\n" +
  "  <div class=\"cart-page__grid\">\n" +
  "    <div class=\"checkout-page__form-col\">\n" +
  "      <form method=\"post\" action=\"/checkout\" class=\"form-stack\">\n" +
  "        RAW_INLINE_ERROR" +
  "        RAW_SHIPPING_FIELDS" +
  "        <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Gift card code <span class=\"small\">(optional)</span></span><input type=\"text\" name=\"gift_card_code\" autocomplete=\"off\" placeholder=\"XXXX-XXXX-XXXX-XXXX\" maxlength=\"24\"></label></div>\n" +
  "        <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Continue to payment <span aria-hidden=\"true\">→</span></button></div>\n" +
  "      </form>\n" +
  "    </div>\n" +
  "    <aside class=\"cart-page__summary\">\n" +
  "      <div class=\"checkout-page__summary-head\">\n" +
  "        <h2 class=\"pdp__variants-title\">Order summary</h2>\n" +
  "        <a href=\"/cart\" class=\"checkout-page__edit-cart\">Edit cart</a>\n" +
  "      </div>\n" +
  "      <ul class=\"checkout-page__lines\">RAW_SUMMARY_LINES</ul>\n" +
  "      <dl class=\"totals-list\">\n" +
  "        <div class=\"totals-list__grand\"><dt>Subtotal</dt><dd>{{subtotal}}</dd></div>\n" +
  "      </dl>\n" +
  "      <p class=\"cart-page__note\">Tax and shipping are calculated on the next step. Payment runs through Stripe.</p>\n" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n";

// One order-summary line item in the checkout rail: thumbnail + title +
// qty + line total, mirroring the cart row but compact. `l` is the raw
// cart line; `lookup` is the variant_id → { product, hero_media } map the
// route passes (same shape renderCart uses). Missing lookup entries fall
// back to the SKU title + a dashed placeholder tile.
function _checkoutSummaryLine(l, lookup, assetPrefix, fmt) {
  var esc = b.template.escapeHtml;
  var match = lookup[l.variant_id] || null;
  var prod  = match && match.product;
  var hero  = match && match.hero_media;
  var title = (prod && prod.title) || l.sku;
  var lineTotal = fmt(l.line_total_minor || (l.qty * l.unit_amount_minor), l.unit_currency);
  var thumb = (hero && hero.r2_key)
    ? "<span class=\"checkout-line__thumb\"><img src=\"" + esc(assetPrefix + hero.r2_key) + "\" alt=\"" + esc(hero.alt_text || title) + "\" loading=\"lazy\"></span>"
    : "<span class=\"checkout-line__thumb checkout-line__thumb--empty\" aria-hidden=\"true\"></span>";
  return "<li class=\"checkout-line\">" +
    thumb +
    "<span class=\"checkout-line__meta\">" +
      "<span class=\"checkout-line__title\">" + esc(title) + "</span>" +
      "<span class=\"checkout-line__qty\">Qty " + esc(String(l.qty)) + "</span>" +
    "</span>" +
    "<span class=\"checkout-line__total price\">" + esc(lineTotal) + "</span>" +
  "</li>";
}

// Redeem-points-at-checkout field — appended to the checkout form for a
// signed-in customer with a spendable balance. The customer types how
// many points to spend; the server caps the credit at the order total
// and at the balance (the `loyalty_redeem_points` field rides the same
// POST as the gift-card code). The max attribute is advisory client-
// side polish; the backend is authoritative.
function _loyaltyCheckoutField(bal, perUsd) {
  var esc = b.template.escapeHtml;
  var points = Number(bal.balance) || 0;
  var ratio = Number(perUsd) || 100;
  // Minor-unit value of the full balance (points / ratio dollars), for
  // the helper line. Floored to a whole point's worth.
  var worth = pricing.format(Math.floor((points * 100) / ratio), "USD");
  return "<div class=\"form-row\"><label class=\"form-field\">" +
    "<span class=\"form-field__label\">Redeem loyalty points <span class=\"small\">(optional)</span></span>" +
    "<input type=\"number\" name=\"loyalty_redeem_points\" min=\"0\" step=\"1\" max=\"" + points + "\" " +
    "inputmode=\"numeric\" autocomplete=\"off\" placeholder=\"0\">" +
    "<span class=\"form-field__req\">You have " + esc(String(points)) + " points (worth " + esc(worth) +
    ") &middot; " + esc(String(ratio)) + " points = $1</span>" +
    "</label></div>";
}

function renderCheckoutForm(opts) {
  if (!opts) throw new TypeError("storefront.renderCheckoutForm: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, currency: "USD" };
  var shopName = opts.shop_name || "blamejs.shop";
  var assetPrefix = opts.asset_prefix || "/assets/";
  var lookup = opts.product_lookup || {};
  var subtotal = pricing.format(totals.subtotal_minor, totals.currency);
  if (opts.theme) {
    return opts.theme.render("checkout", {
      title:          "Checkout",
      shop_name:      shopName,
      cart_count:     lines.length,
      subtotal:       subtotal,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  // Order-summary line items in the sticky rail — same thumbnail + title
  // pattern as the cart, compact. Formatted in the order's own currency
  // (the checkout total is computed server-side; no display-currency
  // conversion happens at this step).
  var summaryLines = lines.map(function (l) {
    return _checkoutSummaryLine(l, lookup, assetPrefix, pricing.format);
  }).join("");
  // A coded gift-card / loyalty error from a rejected POST re-renders the
  // form with the message inline (role="alert") rather than dead-ending on
  // a separate error page — the shopper fixes the bad code in place.
  var inlineError = opts.inline_error
    ? "<p class=\"auth-form__message auth-form__message--err\" role=\"alert\">" + b.template.escapeHtml(String(opts.inline_error)) + "</p>"
    : "";
  var body = _render(CHECKOUT_PAGE, { subtotal: subtotal })
    .replace("RAW_INLINE_ERROR", inlineError)
    .replace("RAW_SHIPPING_FIELDS", _checkoutShippingFields(opts.prefill))
    .replace("RAW_SUMMARY_LINES", summaryLines);
  // Signed-in customer with a spendable points balance — surface a
  // redeem-at-checkout field. The block is appended as raw HTML (the
  // balance + value are numbers we control, the conversion ratio is the
  // ledger's own constant) so it slots into the existing form via a
  // small client island that copies the field into the POST. Rendered
  // only when there's a balance to spend; absent that the checkout is
  // unchanged for guests + zero-balance customers.
  if (opts.loyalty_balance && opts.loyalty_balance.balance > 0) {
    body = body.replace(
      "</form>",
      _loyaltyCheckoutField(opts.loyalty_balance, opts.loyalty_points_per_usd) + "</form>",
    );
  }
  // When PayPal is configured, append its button below the card form. The
  // block is built as raw HTML (appended after the strict render) so the SDK
  // script + handlers survive; the client-id is the only interpolation and is
  // attribute-escaped. The PayPal button's createOrder/onApprove drive the
  // /checkout/paypal/create + /capture routes. (Operators must allow
  // www.paypal.com in their CSP script-src/frame-src, as for js.stripe.com.)
  if (opts.paypal_client_id) {
    body += _paypalCheckoutBlock(opts.paypal_client_id, totals.currency);
  }
  return _wrap({
    title:      "Checkout",
    shop_name:  shopName,
    cart_count: lines.length,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- gift-card balance check (customer-facing) -------------------------
//
// A bearer gift-card code is private — the page never confirms whether a
// code "exists". A recognized active card shows its balance; anything else
// (unknown, malformed, expired, voided, redeemed) shows the same generic
// "couldn't find a balance" message so the page is not a code-probing
// oracle. Server-rendered; the result re-renders the same page with the
// outcome inline.
var GIFT_CARD_PAGE =
  "<section class=\"checkout-page\" style=\"max-width:32rem;margin:0 auto;\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Gift cards</p>\n" +
  "    <h1 class=\"section-head__title\">Check a gift card balance</h1>\n" +
  "    <p class=\"section-head__lede\">Enter the code printed on your gift card to see what's left to spend. Apply it at checkout.</p>\n" +
  "  </header>\n" +
  "  RAW_RESULT" +
  "  <form method=\"post\" action=\"/gift-cards/balance\" class=\"form-stack\">\n" +
  "    <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Gift card code</span><input type=\"text\" name=\"code\" autocomplete=\"off\" placeholder=\"XXXX-XXXX-XXXX-XXXX\" maxlength=\"24\" required></label></div>\n" +
  "    <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Check balance</button></div>\n" +
  "  </form>\n" +
  "</section>\n";

function renderGiftCardBalance(opts) {
  opts = opts || {};
  var shopName = opts.shop_name || "blamejs.shop";
  var resultHtml = "";
  if (opts.balance != null) {
    var bal = pricing.format(opts.balance.balance_minor, opts.balance.currency);
    resultHtml =
      "<div class=\"checkout-summary\"><h3>Balance</h3><dl>" +
      "<div class=\"checkout-summary__total\"><dt>Available</dt><dd>" + b.template.escapeHtml(bal) + "</dd></div>" +
      "</dl></div>";
  } else if (opts.not_found) {
    resultHtml =
      "<p class=\"auth-form__message auth-form__message--err\">" +
      "We couldn't find a balance for that code. Check the characters and try again." +
      "</p>";
  }
  if (opts.theme) {
    return opts.theme.render("gift-card-balance", {
      title:          "Gift card balance",
      shop_name:      shopName,
      cart_count:     opts.cart_count == null ? 0 : opts.cart_count,
      result:         resultHtml,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = GIFT_CARD_PAGE.replace("RAW_RESULT", resultHtml);
  return _wrap({
    title:      "Gift card balance",
    shop_name:  shopName,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

function _paypalCheckoutBlock(clientId, currency) {
  var esc = b.template.escapeHtml;
  var cid = esc(String(clientId));
  var cur = esc(String(currency || "USD"));
  return "\n<div class=\"checkout-paypal\" style=\"max-width:32rem;margin:1.5rem auto 0;\">" +
    "<div class=\"pay-card__divider\"><span>or pay with PayPal</span></div>" +
    "<div id=\"paypal-button-container\"></div>" +
    "<p id=\"paypal-error\" class=\"auth-form__message auth-form__message--err\" hidden></p>" +
    "</div>" +
    "<script src=\"https://www.paypal.com/sdk/js?client-id=" + cid + "&currency=" + cur + "&intent=capture\"></script>" +
    "<script>(function(){" +
    "if(!window.paypal){return;}" +
    "var form=document.querySelector('.checkout-page form');" +
    "var errEl=document.getElementById('paypal-error');" +
    "function vals(){var d={};['email','name','line1','line2','city','country','state','postal'].forEach(function(k){var el=form&&form.elements[k];if(el){d[k]=el.value;}});return d;}" +
    "function showErr(m){if(errEl){errEl.hidden=false;errEl.textContent=m||'PayPal checkout could not be completed.';}}" +
    "paypal.Buttons({" +
    "onClick:function(_d,actions){if(form&&form.reportValidity&&!form.reportValidity()){return actions.reject();}return actions.resolve();}," +
    "createOrder:function(){return fetch('/checkout/paypal/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(vals())}).then(function(r){return r.json();}).then(function(d){if(!d.id){throw new Error(d.error||'create failed');}return d.id;});}," +
    "onApprove:function(data){return fetch('/checkout/paypal/capture',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paypal_order_id:data.orderID})}).then(function(r){return r.json();}).then(function(d){if(d.redirect){window.location.href=d.redirect;}else{showErr(d.error);}});}," +
    "onError:function(){showErr();}" +
    "}).render('#paypal-button-container');" +
    "})();</script>\n";
}

// Stripe Elements payment page — embeds Stripe.js + a minimal
// mount block. The publishable key is operator-supplied (env
// `STRIPE_PUBLISHABLE_KEY` → forwarded into the rendered HTML).
// The client_secret is per-order; never logged, never persisted.
var PAY_PAGE =
  "<section class=\"pay-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Secure checkout · Stripe</p>\n" +
  "    <h1 class=\"section-head__title\">Pay {{grand_total}}</h1>\n" +
  "    <p class=\"section-head__lede\">Order <code class=\"inline-code\">{{order_id}}</code> · the Stripe Payment Element is mounted below in a same-origin form.</p>\n" +
  "  </header>\n" +
  "  <div class=\"pay-card\">\n" +
  "    <div id=\"express-checkout\" class=\"pay-card__express\" hidden>\n" +
  "      <div id=\"express-checkout-element\"></div>\n" +
  "      <div class=\"pay-card__divider\"><span>or pay with card</span></div>\n" +
  "    </div>\n" +
  "    <div id=\"payment-element\" class=\"pay-card__element\"></div>\n" +
  "    <button id=\"submit\" type=\"button\" class=\"btn-primary pay-card__submit\">Pay {{grand_total}}</button>\n" +
  "    <p id=\"payment-message\" class=\"pay-card__message\"></p>\n" +
  "  </div>\n" +
  "  <script src=\"https://js.stripe.com/v3/\"></script>\n" +
  "  <script>\n" +
  "    (function () {\n" +
  "      var stripe = Stripe({{pk_json}});\n" +
  "      var elements = stripe.elements({ clientSecret: {{client_secret_json}}, appearance: { theme: \"stripe\" } });\n" +
  "      var returnUrl = window.location.origin + \"/orders/{{order_id}}\";\n" +
  "      var message = document.getElementById(\"payment-message\");\n" +
  "      function confirm() {\n" +
  "        message.textContent = \"Processing...\";\n" +
  "        return stripe.confirmPayment({ elements: elements, confirmParams: { return_url: returnUrl } }).then(function (result) {\n" +
  "          if (result.error) { message.textContent = result.error.message || \"Payment failed.\"; }\n" +
  "        });\n" +
  "      }\n" +
  "      // Express Checkout Element — renders Apple Pay / Google Pay /\n" +
  "      // Link wallet buttons when the device + the shop's registered\n" +
  "      // payment-method domain make them available. It confirms the\n" +
  "      // same PaymentIntent as the card form, so the webhook + order\n" +
  "      // FSM are identical. Hidden until Stripe reports an available\n" +
  "      // wallet so the divider never sits over an empty box.\n" +
  "      var ece = elements.create(\"expressCheckout\");\n" +
  "      ece.on(\"ready\", function (ev) {\n" +
  "        if (ev && ev.availablePaymentMethods) { document.getElementById(\"express-checkout\").hidden = false; }\n" +
  "      });\n" +
  "      ece.on(\"confirm\", function () { confirm(); });\n" +
  "      ece.mount(\"#express-checkout-element\");\n" +
  "      var paymentElement = elements.create(\"payment\");\n" +
  "      paymentElement.mount(\"#payment-element\");\n" +
  "      document.getElementById(\"submit\").addEventListener(\"click\", function () { confirm(); });\n" +
  "    })();\n" +
  "  </script>\n" +
  "</section>\n";

function renderPayPage(opts) {
  if (!opts || !opts.order)              throw new TypeError("storefront.renderPayPage: opts.order required");
  if (!opts.client_secret)               throw new TypeError("storefront.renderPayPage: opts.client_secret required");
  if (!opts.publishable_key)              throw new TypeError("storefront.renderPayPage: opts.publishable_key required");
  var shopName    = opts.shop_name || "blamejs.shop";
  var cartCount   = opts.cart_count == null ? 0 : opts.cart_count;
  var grandTotal  = pricing.format(opts.order.grand_total_minor, opts.order.currency);
  // Stripe.js and client_secret values must be JSON-encoded so the
  // template engine treats them as raw expressions (`{{{ }}}` /
  // post-render replace) rather than HTML-escaping the quotes. The
  // values are otherwise opaque to the renderer — no string
  // concatenation possible at this layer.
  var pkJson      = JSON.stringify(opts.publishable_key);
  var secretJson  = JSON.stringify(opts.client_secret);
  if (opts.theme) {
    return opts.theme.render("pay", {
      title:               "Pay",
      shop_name:           shopName,
      cart_count:          cartCount,
      order_id:            opts.order.id,
      grand_total:         grandTotal,
      pk_json:             pkJson,
      client_secret_json:  secretJson,
      asset_css_main:      opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = _render(PAY_PAGE, {
    order_id:           opts.order.id,
    grand_total:        grandTotal,
    pk_json:            "RAW_PK",
    client_secret_json: "RAW_SECRET",
  }).replace("RAW_PK",     pkJson)
    .replace("RAW_SECRET", secretJson);
  return _wrap({
    title:      "Pay",
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body,
  });
}

var ORDER_PAGE =
  "<section class=\"order-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Order confirmed</p>\n" +
  "    <h1 class=\"section-head__title\">Order <code class=\"inline-code\">{{order_id}}</code></h1>\n" +
  "    <p class=\"section-head__lede\">Status: <span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> {{status}}</span></p>\n" +
  "  </header>\n" +
  "  <div class=\"order-page__grid\">\n" +
  "    <div class=\"order-page__items\">\n" +
  "      <h2 class=\"pdp__variants-title\">Items</h2>\n" +
  "      <div class=\"table-scroll\">\n" +
  "        <table class=\"cart-table\">\n" +
  "          <thead><tr><th>Product</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>\n" +
  "          <tbody>{{line_rows}}</tbody>\n" +
  "        </table>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "    <aside class=\"order-page__totals\">\n" +
  "      <h2 class=\"pdp__variants-title\">Totals</h2>\n" +
  "      <dl class=\"totals-list\">\n" +
  "        <div><dt>Subtotal</dt><dd>{{subtotal}}</dd></div>\n" +
  "        <div><dt>Tax</dt><dd>{{tax}}</dd></div>\n" +
  "        <div><dt>Shipping</dt><dd>{{shipping}}</dd></div>\n" +
  "        <div class=\"totals-list__grand\"><dt>Total</dt><dd>{{total}}</dd></div>\n" +
  "      </dl>\n" +
  "    RAW_SHIP_TO</aside>\n" +
  "  </div>\n" +
  "</section>\n";

// Renders the order's shipping address as an <address> block for the
// confirmation page. Built from the stored `ship_to` (country/state/
// postal + line1/line2/city); shows whichever parts are present so a
// legacy order with only a country still renders, and a digital order
// with no address renders nothing. Every part is HTML-escaped.
function _shipToAddressBlock(s) {
  if (!s || typeof s !== "object") return "";
  var esc = b.template.escapeHtml;
  var cityLine = [s.city, s.state, s.postal]
    .filter(function (x) { return x != null && String(x).trim().length; })
    .map(String).join(", ");
  var parts = [s.line1, s.line2, cityLine, s.country]
    .filter(function (x) { return x != null && String(x).trim().length; })
    .map(function (x) { return "<span>" + esc(String(x)) + "</span>"; });
  if (!parts.length) return "";
  return "<div class=\"order-page__ship\">" +
    "<h2 class=\"pdp__variants-title\">Ship to</h2>" +
    "<address class=\"order-ship-address\">" + parts.join("") + "</address>" +
    "</div>";
}

function renderOrder(opts) {
  if (!opts || !opts.order) throw new TypeError("storefront.renderOrder: opts.order required");
  var o = opts.order;
  var lines = o.lines || [];
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var assetPrefix = opts.asset_prefix || "/assets/";
  // Same lookup shape as renderCart — { variant_id: { product, hero_media } }.
  // Route handler bundles it in; missing entries fall through to
  // SKU-as-title with the placeholder tile.
  var lookup = opts.product_lookup || {};
  var rendered = lines.map(function (l) {
    var match = lookup[l.variant_id] || null;
    var prod  = match && match.product;
    var hero  = match && match.hero_media;
    var imageUrl = hero ? assetPrefix + hero.r2_key : null;
    var imageAlt = hero ? (hero.alt_text || (prod && prod.title) || l.sku) : null;
    return {
      sku:            l.sku,
      qty:            String(l.qty),
      unit:           pricing.format(l.unit_amount_minor, l.unit_currency),
      total:          pricing.format(l.line_total_minor || (l.qty * l.unit_amount_minor), l.unit_currency),
      product_title:  (prod && prod.title) || l.sku,
      product_url:    prod ? ("/products/" + prod.slug) : "#",
      image_url:      imageUrl,
      image_alt:      imageAlt,
    };
  });
  var subtotal = pricing.format(o.subtotal_minor,    o.currency);
  var tax      = pricing.format(o.tax_minor,         o.currency);
  var shipping = pricing.format(o.shipping_minor,    o.currency);
  var total    = pricing.format(o.grand_total_minor, o.currency);
  var recs = opts.recommendations || [];
  if (opts.theme) {
    return opts.theme.render("order", {
      title:               "Order " + o.id,
      shop_name:           shopName,
      cart_count:          cartCount,
      order_id:            o.id,
      status:              o.status,
      lines:               rendered,
      has_lines:           rendered.length > 0,
      subtotal:            subtotal,
      tax:                 tax,
      shipping:            shipping,
      total:               total,
      ship_to:             o.ship_to || null,
      recommendations:     recs,
      has_recommendations: recs.length > 0,
      asset_css_main:      opts.theme.assetUrl("css/main.css"),
    });
  }
  function _orderEsc(s) { return b.template.escapeHtml(s); }
  var rows = rendered.map(function (l) {
    var thumb = l.image_url
      ? "<span class=\"cart-line__thumb\"><img src=\"" + _orderEsc(l.image_url) + "\" alt=\"" + _orderEsc(l.image_alt) + "\" loading=\"lazy\"></span>"
      : "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
    return _render(CART_LINE, {
      sku:            l.sku,
      qty:            l.qty,
      unit:           l.unit,
      total:          l.total,
      product_title:  l.product_title,
      product_url:    l.product_url,
    }).replace("RAW_ORDER_LINE_THUMB", thumb);
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No items.</td></tr>";
  var body = _render(ORDER_PAGE, {
    order_id:  o.id,
    status:    o.status,
    line_rows: "RAW_LINES",
    subtotal:  subtotal,
    tax:       tax,
    shipping:  shipping,
    total:     total,
  }).replace("RAW_LINES", rows).replace("RAW_SHIP_TO", _shipToAddressBlock(o.ship_to));
  // Post-purchase cross-sell rail — reuses the catalog grid + product-card
  // markup (so it inherits the storefront's card styling), rendered only
  // when the picker returned something.
  var railHtml = "";
  if (recs.length) {
    var railCards = recs.map(function (p) { return _buildProductCard(p); }).join("");
    railHtml =
      "<section class=\"catalog-section order-recommendations\">" +
        "<header class=\"section-head\"><h2 class=\"section-head__title\">Customers also bought</h2></header>" +
        "<div class=\"grid\">" + railCards + "</div>" +
      "</section>";
  }
  return _wrap({
    title:      "Order " + o.id,
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body + railHtml,
  });
}

var CART_PAGE =
  "<section class=\"cart-page\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">Cart</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "RAW_CART_NOTICE" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Your cart</p>\n" +
  "    <h1 class=\"section-head__title\">Review your items</h1>\n" +
  "  </header>\n" +
  "  <div class=\"cart-page__grid\">\n" +
  "    <div class=\"cart-page__items\">\n" +
  "      <div class=\"table-scroll\">\n" +
  "        <table class=\"cart-table\">\n" +
  "          <thead><tr><th>Product</th><th>Quantity</th><th>Unit</th><th>Total</th><th class=\"variant-table__action-h\">Action</th></tr></thead>\n" +
  "          <tbody>{{line_rows}}</tbody>\n" +
  "        </table>\n" +
  "      </div>\n" +
  "      <a href=\"/\" class=\"btn-ghost cart-page__continue\">← Continue shopping</a>\n" +
  "    </div>\n" +
  "    <aside class=\"cart-page__summary\">\n" +
  "      <h2 class=\"pdp__variants-title\">Order summary</h2>\n" +
  "      <dl class=\"totals-list\">\n" +
  "        <div><dt>Subtotal</dt><dd>{{subtotal}}</dd></div>\n" +
  "        <div class=\"totals-list__grand\"><dt>Total</dt><dd>{{total}}</dd></div>\n" +
  "      </dl>\n" +
  "RAW_CHECKOUT_CTA" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n";

// The "added to cart" status banner shown after a POST /cart/lines
// redirect (`?added=1`). role="status" so a screen reader announces it
// without stealing focus; the dismiss link drops the query param so a
// refresh doesn't re-announce. Container-only — the edge serves the
// cookie-less empty-cart view, never a post-add render.
var CART_ADDED_NOTICE =
  "  <p class=\"cart-page__added\" role=\"status\">\n" +
  "    <span>Added to cart.</span> <a href=\"/cart\">Dismiss</a>\n" +
  "  </p>\n";

var CART_EMPTY_PAGE =
  "<section class=\"cart-page cart-page--empty\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\">\n" +
  "    <ol>\n" +
  "      <li><a href=\"/\">Shop</a></li>\n" +
  "      <li aria-current=\"page\">Cart</li>\n" +
  "    </ol>\n" +
  "  </nav>\n" +
  "  <div class=\"cart-empty\">\n" +
  "    <div class=\"cart-empty__card\">\n" +
  "      <p class=\"cart-empty__icon\" aria-hidden=\"true\"><svg class=\"empty-illu\" viewBox=\"0 0 200 132\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.6\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M52 50 H66 L74 90 H128 L138 58 H72\"/><path d=\"M46 44 H56\" stroke=\"#732A8D\"/><circle cx=\"82\" cy=\"106\" r=\"7\"/><circle cx=\"120\" cy=\"106\" r=\"7\"/><path d=\"M84 72 H122\" stroke=\"currentColor\" stroke-opacity=\"0.45\" stroke-width=\"1.8\" stroke-dasharray=\"2 4\"/><path d=\"M150 38 L150 50 M144 44 L156 44\" stroke=\"#732A8D\" stroke-width=\"2\"/></svg></p>\n" +
  "      <p class=\"eyebrow cart-empty__eyebrow\">Cart</p>\n" +
  "      <h1 class=\"cart-empty__title\">Your cart is empty</h1>\n" +
  "      <p class=\"cart-empty__lede\">Browse the catalog and the products you add show up here. Items hold their price at add-time, not at checkout.</p>\n" +
  "      <div class=\"cart-empty__cta\">\n" +
  "        <a href=\"/\" class=\"btn-primary\">Browse products <span aria-hidden=\"true\">→</span></a>\n" +
  "        <a href=\"#site-search-q\" class=\"btn-ghost\">Find a specific product</a>\n" +
  "      </div>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

// Styled, recoverable error page for a cart/checkout dead-end (a bad add,
// a session that vanished, a non-coded checkout failure). Reuses the
// cart-empty card so the failure reads as a designed state, not raw text —
// with the human-readable reason + a recovery link. `opts.reason` is the
// message, `opts.back_href`/`opts.back_label` the recovery action (default
// "Back to cart"), and `opts.eyebrow` the kicker (default "Cart").
function renderCheckoutError(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var shopName  = opts.shop_name || "blamejs.shop";
  var eyebrow   = opts.eyebrow   || "Cart";
  var title     = opts.title_text || "Something went wrong";
  var reason    = opts.reason    || "We couldn't process that request. Your cart is saved — please try again.";
  var backHref  = opts.back_href  || "/cart";
  var backLabel = opts.back_label || "Back to cart";
  var secondary = opts.secondary_href
    ? " <a href=\"" + esc(opts.secondary_href) + "\" class=\"btn-ghost\">" + esc(opts.secondary_label || "Keep browsing") + "</a>"
    : " <a href=\"/\" class=\"btn-ghost\">Keep browsing</a>";
  var body =
    "<section class=\"cart-page cart-page--empty\"><div class=\"cart-empty\"><div class=\"cart-empty__card\">" +
      "<p class=\"eyebrow cart-empty__eyebrow\">" + esc(eyebrow) + "</p>" +
      "<h1 class=\"cart-empty__title\">" + esc(title) + "</h1>" +
      "<p class=\"cart-empty__lede\">" + esc(reason) + "</p>" +
      "<div class=\"cart-empty__cta\"><a class=\"btn-primary\" href=\"" + esc(backHref) + "\">" + esc(backLabel) + "</a>" + secondary + "</div>" +
    "</div></div></section>";
  return _wrap({
    title:      opts.title || "Checkout",
    shop_name:  shopName,
    theme_css:  opts.theme_css,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    body:       body,
  });
}

function renderCart(opts) {
  if (!opts) throw new TypeError("storefront.renderCart: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" };
  var shopName = opts.shop_name || "blamejs.shop";
  var assetPrefix = opts.asset_prefix || "/assets/";
  // `product_lookup` is { variant_id: { product, hero_media } } — the
  // route handler bundles it in. Lines without an entry render with
  // a dashed-placeholder tile + the SKU as the fallback title.
  var lookup  = opts.product_lookup || {};
  var fmt = _priceFormatter(opts);
  var rendered = lines.map(function (l) {
    var match  = lookup[l.variant_id] || null;
    var prod   = match && match.product;
    var hero   = match && match.hero_media;
    var imageUrl = hero ? assetPrefix + hero.r2_key : null;
    var imageAlt = hero ? (hero.alt_text || (prod && prod.title) || l.sku) : null;
    return {
      id:             l.id,
      sku:            l.sku,
      qty:            String(l.qty),
      unit:           fmt(l.unit_amount_minor, l.unit_currency),
      total:          fmt(l.qty * l.unit_amount_minor, l.unit_currency),
      product_title:  (prod && prod.title) || l.sku,
      product_url:    prod ? ("/products/" + prod.slug) : "#",
      image_url:      imageUrl,
      image_alt:      imageAlt,
    };
  });
  var subtotal = fmt(totals.subtotal_minor,    totals.currency);
  var total    = fmt(totals.grand_total_minor, totals.currency);
  if (opts.theme) {
    return opts.theme.render("cart", {
      title:          "Cart",
      shop_name:      shopName,
      cart_count:     lines.length,
      lines:          rendered,
      has_lines:      rendered.length > 0,
      subtotal:       subtotal,
      total:          total,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  function _escAttr(s) { return b.template.escapeHtml(s); }
  var body;
  if (rendered.length === 0) {
    body = CART_EMPTY_PAGE;
  } else {
    var canSave = !!opts.can_save;
    var rows = rendered.map(function (l) {
      var thumb = l.image_url
        ? "<span class=\"cart-line__thumb\"><img src=\"" + _escAttr(l.image_url) + "\" alt=\"" + _escAttr(l.image_alt) + "\" loading=\"lazy\"></span>"
        : "<span class=\"cart-line__thumb cart-line__thumb--empty\" aria-hidden=\"true\"></span>";
      // "Save for later" moves the line into the customer's saved list.
      // Rendered only when the feature is wired (and account auth is
      // present); the route itself enforces login, redirecting a guest
      // to sign in.
      var saveBtn = canSave
        ? "<form method=\"post\" action=\"/cart/lines/" + _escAttr(l.id) + "/save\"><button type=\"submit\" class=\"cart-line__btn cart-line__btn--save\">Save for later</button></form>"
        : "";
      return _render(CART_LINE_EDITABLE, {
        sku:            l.sku,
        qty:            l.qty,
        unit:           l.unit,
        total:          l.total,
        line_id:        l.id,
        product_title:  l.product_title,
        product_url:    l.product_url,
      }).replace("RAW_CART_LINE_THUMB", thumb).replace("RAW_CART_LINE_SAVE", saveBtn);
    }).join("");
    // Checkout CTA — only a live button when checkout is actually wired
    // (Stripe configured). Absent that, render a clear, disabled "not set
    // up" notice instead of a link that 404s. Backward-compatible: callers
    // that don't pass the flag (older tests) keep the button.
    var checkoutAvailable = opts.checkout_available !== false;
    var checkoutCta = checkoutAvailable
      ? "      <a href=\"/checkout\" class=\"btn-primary cart-page__checkout\">Continue to checkout <span aria-hidden=\"true\">→</span></a>\n" +
        "      <p class=\"cart-page__note\">Tax and shipping are calculated on the next step. Payment runs through Stripe.</p>\n"
      : "      <button type=\"button\" class=\"btn-primary cart-page__checkout\" disabled aria-disabled=\"true\">Checkout unavailable</button>\n" +
        "      <p class=\"cart-page__note cart-page__note--warn\" role=\"status\">Online checkout isn't set up for this store yet — payments aren't configured. Your cart is saved; please check back soon.</p>\n";
    // Post-add confirmation banner — rendered only on the `?added=1`
    // redirect from POST /cart/lines so the shopper gets explicit feedback
    // their item landed (the audit found the silent 303 left no cue).
    var notice = opts.added ? CART_ADDED_NOTICE : "";
    body = _render(CART_PAGE, {
      line_rows: "RAW_LINES",
      subtotal:  subtotal,
      total:     total,
    }).replace("RAW_LINES", rows).replace("RAW_CHECKOUT_CTA", checkoutCta).replace("RAW_CART_NOTICE", notice);
  }
  return _wrap(Object.assign({
    title:      "Cart",
    shop_name:  shopName,
    cart_count: lines.length,
    theme_css: opts.theme_css,
    body:       body,
  }, _currencyWrapOpts(opts)));
}

// ---- admin landing (HTML — the rest of /admin/* is JSON API) ----------

function renderAdminLanding(opts) {
  opts = opts || {};
  var body =
    "<section class=\"admin-landing\">" +
      "<header class=\"section-head\">" +
        "<p class=\"eyebrow\">Admin API</p>" +
        "<h1 class=\"section-head__title\">There's no admin GUI — operators talk to the framework over HTTP.</h1>" +
        "<p class=\"section-head__lede\">Every admin verb (create / update / archive / refund / restock) is a bearer-token-gated JSON endpoint under <code class=\"inline-code\">/admin/*</code>. Pair it with curl, an API client, or any internal ops console.</p>" +
      "</header>" +
      "<div class=\"admin-landing__grid\">" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">POST</p>" +
          "<h2>Create a product</h2>" +
          "<pre class=\"admin-card__code\"><code>curl -X POST $SHOP/admin/products \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"title\": \"Widget\", \"slug\": \"widget\" }'</code></pre>" +
        "</article>" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">GET</p>" +
          "<h2>Search products</h2>" +
          "<pre class=\"admin-card__code\"><code>curl $SHOP/admin/products/search?q=tee \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\"</code></pre>" +
        "</article>" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">POST</p>" +
          "<h2>Restock inventory</h2>" +
          "<pre class=\"admin-card__code\"><code>curl -X POST $SHOP/admin/inventory/OPR-TEE-BLK-L/restock \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"qty\": 25 }'</code></pre>" +
        "</article>" +
        "<article class=\"admin-card\">" +
          "<p class=\"admin-card__verb\">POST</p>" +
          "<h2>Issue a refund</h2>" +
          "<pre class=\"admin-card__code\"><code>curl -X POST $SHOP/admin/orders/$ID/refund \\\n  -H \"authorization: Bearer $ADMIN_API_KEY\" \\\n  -d '{ \"amount_minor\": 3200 }'</code></pre>" +
        "</article>" +
      "</div>" +
      "<aside class=\"admin-landing__note\">" +
        "<p><strong>Why no GUI?</strong> Treating the admin as an API keeps the surface area auditable — every state change lands as a request you can replay, log, and sign. Build the GUI your ops team needs; the framework stays out of the way.</p>" +
        "<p>Endpoint reference: <a href=\"https://github.com/blamejs/blamejs.shop/blob/main/lib/admin.js\" rel=\"noopener\" class=\"link-arrow\">lib/admin.js on GitHub <span aria-hidden=\"true\">→</span></a></p>" +
      "</aside>" +
    "</section>";
  return _wrap({
    title:      "Admin",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- newsletter thank-you ---------------------------------------------

function renderNewsletterThanks(opts) {
  opts = opts || {};
  // Two flavors: `new` (we just enrolled this address) and `dedup`
  // (the address was already on the list). Both render the same
  // shell with copy that tells the visitor what happened, so a
  // double-submit doesn't read as a quiet failure.
  var heading, lede;
  if (opts.status === "dedup") {
    heading = "You're already on the list.";
    lede    = "We had this address from a previous signup. Nothing changed — you'll get release notes the day they ship.";
  } else {
    heading = "You're on the list.";
    lede    = "We'll email you the day there's a new framework release, a security advisory, or a primitive worth knowing about. Nothing else.";
  }
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Newsletter</p>" +
        "<h1 class=\"newsletter-thanks__title\">" + heading + "</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + lede + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
          "<a href=\"https://github.com/blamejs/blamejs.shop\" class=\"btn-ghost\" rel=\"noopener\">Star on GitHub</a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Newsletter",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

function renderNewsletterError(opts) {
  opts = opts || {};
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Newsletter</p>" +
        "<h1 class=\"newsletter-thanks__title\">Couldn't enroll that address.</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + (opts.message || "Check the address and try again — only RFC-shape email addresses are accepted.") + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Newsletter",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- cookie preference center ------------------------------------------

// The four toggleable categories + their operator-facing copy, mirroring
// lib/cookie-consent.js's category taxonomy. Order is fixed so the page
// reads the same every render.
var CONSENT_CATEGORY_COPY = [
  { key: "functional",  name: "Functional",  desc: "Remember-me, locale, and currency-selector cookies that make the shop more convenient." },
  { key: "analytics",   name: "Analytics",   desc: "Aggregate, privacy-respecting usage measurement so we can see which pages help and which don't." },
  { key: "marketing",   name: "Marketing",   desc: "Advertising and retargeting pixels. Off unless you turn them on; a Do-Not-Track or Global Privacy Control signal keeps them off regardless." },
  { key: "preferences", name: "Preferences", desc: "Your saved UI tweaks — dark mode, list density, and similar non-essential settings." },
];

// The /cookies manage page. Pre-checks each toggle from the visitor's
// stored decision (all off when there's no decision yet — default-deny).
// `decision` is the shape `_readConsentDecision` returns, or null.
// `notice` is an optional operator-fixed confirmation string (e.g. after
// a save) — never a reflected visitor value.
function renderCookiePreferences(opts) {
  opts = opts || {};
  var decision = opts.decision || null;
  var noticeHtml = "";
  if (opts.notice === "saved") {
    noticeHtml = "<p class=\"consent-page__notice\" role=\"status\">Your cookie preferences were saved. They take effect immediately and you can change them again any time on this page.</p>";
  } else if (opts.notice === "invalid") {
    noticeHtml = "<p class=\"consent-page__notice\" role=\"alert\">That submission wasn't understood, so nothing changed. Choose your categories below and save again.</p>";
  }

  var cats = "";
  for (var i = 0; i < CONSENT_CATEGORY_COPY.length; i += 1) {
    var c = CONSENT_CATEGORY_COPY[i];
    var on = decision && decision.categories && decision.categories[c.key] === true;
    cats +=
      "<div class=\"consent-cat\">" +
        "<div class=\"consent-cat__head\">" +
          "<h2 class=\"consent-cat__name\">" + c.name + "</h2>" +
          "<label class=\"consent-toggle\">" +
            "<span class=\"skip-link\">Allow " + c.name + " cookies</span>" +
            "<input type=\"checkbox\" name=\"cat_" + c.key + "\" value=\"1\"" + (on ? " checked" : "") + ">" +
          "</label>" +
        "</div>" +
        "<p class=\"consent-cat__desc\">" + c.desc + "</p>" +
      "</div>";
  }

  var body =
    "<section class=\"consent-page\">" +
      "<p class=\"eyebrow\">Privacy</p>" +
      "<h1>Cookie preferences</h1>" +
      "<p class=\"consent-page__lede\">Strictly-necessary cookies — your session, security tokens, and this choice itself — are always on because the shop can't run without them. Everything below is optional and off by default.</p>" +
      noticeHtml +
      "<form method=\"post\" action=\"/consent\">" +
        "<input type=\"hidden\" name=\"return_to\" value=\"/cookies\">" +
        "<div class=\"consent-cat\">" +
          "<div class=\"consent-cat__head\">" +
            "<h2 class=\"consent-cat__name\">Strictly necessary</h2>" +
            "<span class=\"consent-cat__always\">Always on</span>" +
          "</div>" +
          "<p class=\"consent-cat__desc\">Session, CSRF protection, and your cookie choice. These can't be switched off.</p>" +
        "</div>" +
        cats +
        "<div class=\"consent-page__actions\">" +
          "<button type=\"submit\" name=\"choice\" value=\"granular\" class=\"btn-primary\">Save preferences</button>" +
          "<button type=\"submit\" name=\"choice\" value=\"accept_all\" class=\"btn-ghost\">Accept all</button>" +
          "<button type=\"submit\" name=\"choice\" value=\"reject\" class=\"btn-ghost\">Reject non-essential</button>" +
        "</div>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Cookie preferences",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- 404 ---------------------------------------------------------------

function renderNotFound(opts) {
  opts = opts || {};
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  if (opts.theme) {
    return opts.theme.render("notfound", {
      title:          "Not found",
      shop_name:      shopName,
      cart_count:     cartCount,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body =
    "<section class=\"not-found\">" +
      "<div class=\"not-found__inner\">" +
        "<p class=\"not-found__code\">404</p>" +
        "<h1 class=\"not-found__title\">That page slipped the catalog.</h1>" +
        "<p class=\"not-found__lede\">The URL didn't match any route on this storefront. The product might have moved, the slug might have changed, or the link might have been mistyped.</p>" +
        "<div class=\"not-found__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
          "<a href=\"/cart\" class=\"btn-ghost\">View your cart</a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Not found",
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- route mount -------------------------------------------------------
//
// Caller (server.js) hands us a b.router instance + the data deps.
// We mount the read-only HTML routes. POST routes for cart mutation
// land alongside Stripe Elements wiring in the next patch.

// Session-id cookie binding — carries the cart's session_id across
// requests. Plain HttpOnly + Secure + SameSite=Lax is sufficient here
// because the value (a UUID) is unguessable and grants ZERO authority
// — it's a routing key, not an authentication token. The cart itself
// transitions to `customer_id` on login via cart.setCustomer.
var SESSION_COOKIE_NAME = "shop_sid";

// Authenticated-customer cookie — carries an opaque sealed envelope
// `{ customer_id, exp }`, AEAD-encrypted via b.vault.seal so the
// cookie itself has no internal structure visible to a tampering
// network attacker. Cookie name `shop_auth`; HttpOnly + Secure +
// SameSite=Lax + Path=/. The vault key is the deployment's KEK; a
// rotated vault invalidates every outstanding auth cookie (operator-
// initiated logout-everywhere).
var AUTH_COOKIE_NAME    = "shop_auth";

// WebAuthn ceremony state cookie — short-lived envelope holding the
// random challenge + the ceremony-scoped metadata so register-finish /
// login-finish can verify the same challenge the browser was sent.
// Path-scoped to /account so it never leaks to other routes.
var CHALLENGE_COOKIE_NAME = "shop_auth_chal";

// Short-lived cookie carrying the Stripe PaymentIntent client_secret
// from POST /checkout to GET /pay/:order_id. Path-scoped to /pay/ +
// SameSite=Strict so it's only ever sent to the pay route.
var PAY_COOKIE_NAME = "shop_pay";

// Short-lived sealed cookie holding the in-flight OIDC sign-in state
// (provider + CSRF state + nonce + PKCE verifier) between the redirect
// to the identity provider and the callback. Path-scoped to /account;
// SameSite=Lax so it survives the provider's top-level GET redirect back.
var OAUTH_COOKIE_NAME = "shop_oauth";

// Short-lived sealed cookie naming the referral code an inbound visitor
// arrived through (set by the /r/:code landing). Read at account-creation
// to attribute the new customer to the referrer. Path "/" so it survives
// the visitor's navigation from the landing to the register / sign-in
// flow; SameSite=Lax so a top-level GET from a shared link carries it.
// Sealed so it can't be forged to mis-attribute a signup.
var REFERRAL_COOKIE_NAME = "shop_ref";

// Sealed cookie holding the visitor's chosen DISPLAY currency (ISO 4217).
// Display-only: the cart / order / payment currency is unchanged — this
// only selects which currency the price strings are rendered in. Sealed
// so a tampered value can't smuggle a non-allow-listed code past the
// reader; a garbage value reads as "unset" and the storefront renders in
// the base currency. Path "/" so the choice persists across the catalog.
var CURRENCY_COOKIE_NAME = "shop_ccy";

// Shape of a valid session id — mirrors cart.js's SESSION_ID_RE.
var SID_SHAPE_RE = /^[A-Za-z0-9_-]{16,64}$/;

// All cookie transport composes the framework's cookie primitive
// (`b.cookies`) — RFC 6265 parse/serialize, prefix invariants, and the
// vault-sealed read/write helpers — rather than hand-built Set-Cookie
// strings and manual header splitting. The jar is memoized; it only
// captures the vault reference (seal/unseal run lazily per call), so
// building it before vault.init() has completed is safe.
var _jar = null;
function _cookieJar() {
  if (!_jar) {
    _jar = b.cookies.create({
      vault:    b.vault,
      defaults: { httpOnly: true, secure: true, sameSite: "Lax", path: "/" },
    });
  }
  return _jar;
}

function _readCookie(req, name) {
  return _cookieJar().read(req, name);
}

function _readSidCookie(req) {
  // A cookie carrying anything but a well-shaped session id (a stale
  // value from an old deploy, a tampered cookie, garbage) reads as "no
  // session" rather than reaching cart.bySession — which throws on a
  // malformed id and would turn every page that renders the cart count
  // into a 500. The cookie grants zero authority, so dropping a
  // malformed one silently is safe.
  var v = _cookieJar().read(req, SESSION_COOKIE_NAME);
  return v && SID_SHAPE_RE.test(v) ? v : null;
}

function _setSidCookie(res, sid) {
  var T = b.constants.TIME;
  _cookieJar().write(res, SESSION_COOKIE_NAME, sid, { expires: new Date(Date.now() + T.days(30)) });
}

// Auth + WebAuthn-challenge cookies carry a vault-sealed JSON envelope.
// writeSealed/readSealed handle the seal + the on-wire prefix; the
// caller works in plain objects.
function _setAuthCookie(res, env) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, AUTH_COOKIE_NAME, JSON.stringify(env), { expires: new Date(Date.now() + T.days(14)) });
}
function _clearAuthCookie(res) {
  _cookieJar().clear(res, AUTH_COOKIE_NAME);
}
function _readAuthEnv(req) {
  var raw = _cookieJar().readSealed(req, AUTH_COOKIE_NAME);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

function _setChallengeCookie(res, env) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, CHALLENGE_COOKIE_NAME, JSON.stringify(env), { expires: new Date(Date.now() + T.minutes(5)), path: "/account" });
}
function _clearChallengeCookie(res) {
  _cookieJar().clear(res, CHALLENGE_COOKIE_NAME, { path: "/account" });
}
function _readChallengeEnv(req) {
  var raw = _cookieJar().readSealed(req, CHALLENGE_COOKIE_NAME);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// Referral-attribution cookie. Carries the code the visitor arrived
// through + when it was set, sealed so it can't be forged. Path "/" so
// it survives navigation from the landing through register / sign-in.
function _setReferralCookie(res, env) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, REFERRAL_COOKIE_NAME, JSON.stringify(env), { expires: new Date(Date.now() + T.days(30)) });
}
function _clearReferralCookie(res) {
  _cookieJar().clear(res, REFERRAL_COOKIE_NAME);
}
function _readReferralEnv(req) {
  var raw = _cookieJar().readSealed(req, REFERRAL_COOKIE_NAME);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (_e) { return null; }
}

// ---- cookie-consent cookies --------------------------------------------
//
// Two cookies carry a visitor's cookie-consent decision:
//
//   * `shop_consent`     — the authoritative decision, vault-sealed +
//                          HttpOnly. Holds { categories, policy_version,
//                          ts }. Read server-side to gate non-essential
//                          cookies/trackers and to pre-check the manage
//                          page's toggles. A tampered / truncated / stale
//                          value fails the seal and reads as "no decision"
//                          (the banner reshows) rather than throwing.
//   * `shop_consent_set` — a non-sealed, NON-HttpOnly "1" flag the consent
//                          island reads to hide the banner on edge-cached
//                          pages. Non-authoritative: it only drives banner
//                          visibility, never the actual cookie/tracker gate.
//
// The four toggleable categories mirror lib/cookie-consent.js's
// TOGGLEABLE_CATEGORIES; strictly-necessary is implicit-on and never
// stored here.
var CONSENT_COOKIE_NAME      = "shop_consent";
var CONSENT_FLAG_COOKIE_NAME = "shop_consent_set";
var CONSENT_TOGGLEABLE       = ["functional", "analytics", "marketing", "preferences"];

// The consent policy version visitors are being asked to consent to. A
// stored decision (sealed cookie) captured under an older version is no
// longer authoritative: the gate stops honoring it and the banner re-
// prompts, so an operator who materially changes their cookie policy and
// bumps the version re-collects consent rather than coasting on stale
// opt-ins. Mirrors lib/cookie-consent.js's `policy_version` charset so the
// value is safe to stamp into a cookie value and an HTML attribute; an
// out-of-charset / over-length / missing value falls back to "v1" (the
// initial version, matching the edge worker's stamped default). The active
// value is read live from `deps.cookieConsent.policyVersion` per request in
// the server gate (so a runtime bump takes effect immediately); the module
// snapshot drives the page-stamped value set once at mount.
var _activeConsentPolicy = "v1";
function _sanitizeConsentPolicy(v) {
  return (typeof v === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(v)) ? v : "v1";
}

// Persist a decision: the sealed authoritative cookie + the non-sealed
// flag. Both expire in 180 days — ICO / CNIL guidance treats ~6 months as
// the upper bound before a consent re-prompt; the cookie-consent ledger
// keeps the durable audit record regardless of cookie lifetime.
function _setConsentCookies(res, decision) {
  var T = b.constants.TIME;
  var exp = new Date(Date.now() + T.days(180));
  _cookieJar().writeSealed(res, CONSENT_COOKIE_NAME, JSON.stringify(decision), { expires: exp });
  // Not HttpOnly — the consent island must read it from document.cookie to
  // decide whether to hide the banner. Its value is the policy version the
  // decision was captured under (charset-constrained, no decision detail),
  // so the island can compare it to the active version stamped on its
  // <script> tag and re-prompt when the operator has bumped the policy. A
  // script-readable version string leaks nothing the server would act on.
  var flagVal = _sanitizeConsentPolicy(decision && decision.policy_version);
  _cookieJar().write(res, CONSENT_FLAG_COOKIE_NAME, flagVal, { expires: exp, httpOnly: false });
}

// The visitor's stored decision, or null when none / malformed / stale.
// Shape-validates the unsealed payload so a forged-but-unsealable or schema-
// drifted value reads as "no decision". `activePolicy` is the policy version
// currently in force (defaults to the module snapshot; the server routes
// pass the live `deps.cookieConsent.policyVersion`): a decision whose
// `policy_version` doesn't match it — including an unversioned legacy value
// — reads as "no decision" so the operator's policy bump re-collects consent
// rather than the gate honoring opt-ins captured under a superseded policy.
function _readConsentDecision(req, activePolicy) {
  var raw = _cookieJar().readSealed(req, CONSENT_COOKIE_NAME);
  if (raw === null) return null;
  var parsed;
  try { parsed = JSON.parse(raw); } catch (_e) { return null; }
  if (!parsed || typeof parsed !== "object" || !parsed.categories || typeof parsed.categories !== "object") {
    return null;
  }
  var active = (arguments.length > 1) ? _sanitizeConsentPolicy(activePolicy) : _activeConsentPolicy;
  if (parsed.policy_version !== active) return null;
  var cats = {};
  for (var i = 0; i < CONSENT_TOGGLEABLE.length; i += 1) {
    cats[CONSENT_TOGGLEABLE[i]] = parsed.categories[CONSENT_TOGGLEABLE[i]] === true;
  }
  return {
    categories:     cats,
    policy_version: parsed.policy_version,
    ts:             Number.isFinite(parsed.ts) ? parsed.ts : null,
  };
}

// Server-side gating hook. Returns true when `category` may emit a
// cookie / tag / pixel byte for this request. Strictly-necessary is
// always allowed; the four toggleable categories consult the stored
// decision (default-deny when absent). DNT / Sec-GPC collapse analytics
// + marketing to false regardless of the stored opt-in (browser-level
// opt-out wins — same rule the cookie-consent ledger records and
// honors). This is the single function a future analytics / marketing
// island gates its render on:
//
//   if (_consentAllows(req, "analytics", _liveConsentPolicy())) body += _islandScript("analytics.js");
//
// so a tracker is never injected into the document unless the visitor
// opted that category in.
function _consentAllows(req, category, activePolicy) {
  if (category === "strictly_necessary") return true;
  if (CONSENT_TOGGLEABLE.indexOf(category) === -1) return false;
  var decision = (arguments.length > 2)
    ? _readConsentDecision(req, activePolicy)
    : _readConsentDecision(req);
  if (!decision) return false;
  if ((category === "analytics" || category === "marketing") && _browserOptOut(req)) return false;
  return decision.categories[category] === true;
}

// DNT (Do-Not-Track) header set to "1". Defensive read — missing /
// garbage reads as "no signal".
function _dntSignal(req) {
  var h = (req && req.headers) || {};
  return String(h["dnt"] || h["DNT"] || "") === "1";
}

// Sec-GPC (Global Privacy Control) header set to "1".
function _gpcSignal(req) {
  var h = (req && req.headers) || {};
  return String(h["sec-gpc"] || h["Sec-GPC"] || "") === "1";
}

// Either DNT or GPC is an implicit deny for analytics + marketing.
function _browserOptOut(req) {
  return _dntSignal(req) || _gpcSignal(req);
}

// Coarse UA classifier for the consent ledger row — matches
// lib/cookie-consent.js's UA_CLASS_VALUES. Defensive: unknown / missing
// UA reads as "unknown".
function _uaClass(req) {
  var ua = String((req && req.headers && (req.headers["user-agent"] || req.headers["User-Agent"])) || "").toLowerCase();
  if (!ua) return "unknown";
  if (/bot|crawl|spider|slurp|bingpreview|headless/.test(ua)) return "bot";
  if (/ipad|tablet|kindle|playbook|silk/.test(ua)) return "tablet";
  if (/mobi|iphone|android.*mobile|phone/.test(ua)) return "mobile";
  if (/windows|macintosh|linux|cros|x11/.test(ua)) return "desktop";
  return "unknown";
}

var CCY_SHAPE_RE = /^[A-Z]{3}$/;

// The visitor's chosen display currency, or null. Sealed so the value
// can't be forged; a missing / malformed / mis-shaped value reads as null
// (→ base-currency display), never throws.
function _readCurrencyCookie(req) {
  var raw = _cookieJar().readSealed(req, CURRENCY_COOKIE_NAME);
  if (raw === null || !CCY_SHAPE_RE.test(raw)) return null;
  return raw;
}
function _setCurrencyCookie(res, code) {
  var T = b.constants.TIME;
  _cookieJar().writeSealed(res, CURRENCY_COOKIE_NAME, code, { expires: new Date(Date.now() + T.days(180)) });
}
function _clearCurrencyCookie(res) {
  _cookieJar().clear(res, CURRENCY_COOKIE_NAME);
}

// ---- locale cookie -----------------------------------------------------
//
// The visitor's locale choice rides an UNSEALED cookie. Unlike the
// session / auth / referral cookies, the locale carries no authority —
// it only selects which operator-configured, server-resolved locale the
// chrome renders in (every candidate is validated against the active
// policy's supported list; an unknown / garbage value resolves to the
// default locale). It is deliberately not vault-sealed so the value
// resolves IDENTICALLY on both render substrates: the edge Worker has no
// vault and couldn't unseal a sealed cookie, which would split the
// edge/container resolution. The framework cookie primitive still
// applies the RFC 6265 grammar, the `Secure` / `SameSite=Lax` / `Path=/`
// invariants, and (in production) the cookie-prefix policy. A read still
// shape-validates the value (BCP-47) before it reaches the resolver, so
// a tampered cookie is dropped, never trusted.
var LOCALE_COOKIE_NAME = "shop_locale";
// BCP-47 envelope mirror of localeRouter.LOCALE_RE — the cookie value is
// shape-checked before it's handed to the resolver so a hostile cookie
// can't smuggle a non-tag string through.
var LOCALE_COOKIE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/;
var LOCALE_COOKIE_MAX = 35;

function _readLocaleCookie(req) {
  var v = _cookieJar().read(req, LOCALE_COOKIE_NAME);
  if (!v || typeof v !== "string" || v.length > LOCALE_COOKIE_MAX) return null;
  return LOCALE_COOKIE_RE.test(v) ? v : null;
}

function _setLocaleCookie(res, locale) {
  var T = b.constants.TIME;
  _cookieJar().write(res, LOCALE_COOKIE_NAME, locale, { expires: new Date(Date.now() + T.days(365)) });
}

// ---- account-page renderers --------------------------------------------

var ACCOUNT_LOGIN_PAGE =
  "<section class=\"auth-page\">\n" +
  "  <div class=\"auth-card\">\n" +
  "    <p class=\"eyebrow\">Sign in</p>\n" +
  "    <h1 class=\"auth-card__title\">Welcome back</h1>\n" +
  "    <p class=\"auth-card__lede\">Enter your email and authenticate with your passkey. No password to type, no recovery email to click.</p>\n" +
  "    RAW_LOGIN_ERROR\n" +
  "    <form id=\"login-form\" method=\"post\" class=\"form-stack auth-form\">\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" id=\"email\" required autocomplete=\"email\" autofocus></label></div>\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Sign in with passkey</button></div>\n" +
  "      <p id=\"login-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    RAW_LOGIN_OAUTH\n" +
  "    <p class=\"auth-card__alt\">New here? <a href=\"/account/register\">Create an account →</a></p>\n" +
  "  </div>\n" +
  "  RAW_LOGIN_SCRIPT\n" +
  "</section>\n";

var LOGIN_ERROR_MESSAGES = {
  oauth:           "We couldn't complete that sign-in. Please try again.",
  "email-conflict": "That email already has an account — sign in with your passkey instead.",
};

function renderAccountLogin(opts) {
  opts = opts || {};
  var oauthButtons = "";
  if (opts.google_enabled) {
    oauthButtons += "<a class=\"btn-secondary auth-oauth__btn\" href=\"/account/login/google\">Continue with Google</a>";
  }
  if (opts.apple_enabled) {
    oauthButtons += "<a class=\"btn-secondary auth-oauth__btn\" href=\"/account/login/apple\">Continue with Apple</a>";
  }
  var oauthHtml = oauthButtons
    ? "<div class=\"auth-oauth\">" +
        "<div class=\"auth-oauth__divider\"><span>or</span></div>" +
        oauthButtons +
      "</div>"
    : "";
  var errHtml = (opts.error && LOGIN_ERROR_MESSAGES[opts.error])
    ? "<p class=\"auth-form__message auth-form__message--err\">" + b.template.escapeHtml(LOGIN_ERROR_MESSAGES[opts.error]) + "</p>"
    : "";
  var body = ACCOUNT_LOGIN_PAGE
    .replace("RAW_LOGIN_OAUTH", oauthHtml)
    .replace("RAW_LOGIN_ERROR", errHtml)
    .replace("RAW_LOGIN_SCRIPT", _islandScript("passkey-login.js"));
  return _wrap({
    title:      "Sign in",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       body,
  });
}

var ACCOUNT_REGISTER_PAGE =
  "<section class=\"auth-page\">\n" +
  "  <div class=\"auth-card\">\n" +
  "    <p class=\"eyebrow\">Create an account</p>\n" +
  "    <h1 class=\"auth-card__title\">Enroll a passkey</h1>\n" +
  "    <p class=\"auth-card__lede\">Accounts use a passkey on your device — no password to remember, no shared secret to phish.</p>\n" +
  "    <form id=\"reg-form\" method=\"post\" class=\"form-stack auth-form\">\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" id=\"email\" required autocomplete=\"email\" autofocus></label></div>\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Display name</span><input type=\"text\" name=\"display_name\" id=\"display_name\" maxlength=\"128\" required autocomplete=\"name\"></label></div>\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Create account &amp; enroll passkey</button></div>\n" +
  "      <p id=\"reg-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    <p class=\"auth-card__alt\">Already have one? <a href=\"/account/login\">Sign in →</a></p>\n" +
  "  </div>\n" +
  "  RAW_REGISTER_SCRIPT\n" +
  "</section>\n";

function renderAccountRegister(opts) {
  opts = opts || {};
  return _wrap({
    title:      "Create account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       ACCOUNT_REGISTER_PAGE.replace("RAW_REGISTER_SCRIPT", _islandScript("passkey-register.js")),
  });
}

var ACCOUNT_DASH_PAGE =
  "<section class=\"account-dash\">\n" +
  "  <header class=\"account-dash__head\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Account</p>\n" +
  "      <h1 class=\"section-head__title\">Hi, {{display_name}}</h1>\n" +
  "      <p class=\"section-head__lede\">Your orders + account controls. Every order ships from origin with a Stripe-secured receipt.</p>\n" +
  "    </div>\n" +
  "    <div class=\"account-dash__actions\">\n" +
  "      <a class=\"btn-secondary\" href=\"/account/wishlist\">Wishlist</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/saved\">Saved for later</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/recently-viewed\">Recently viewed</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/addresses\">Addresses</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/returns\">Returns</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/loyalty\">Rewards</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/referrals\">Refer a friend</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/subscriptions\">Subscriptions</a>\n" +
  // begin: profile + passkey management actions
  "      <a class=\"btn-secondary\" href=\"/account/profile\">Edit profile</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/passkeys\">Manage passkeys</a>\n" +
  // end: profile + passkey management actions
  "      <form method=\"post\" action=\"/account/logout\"><button type=\"submit\" class=\"btn-ghost\">Sign out</button></form>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <dl class=\"account-dash__stats\">\n" +
  "    <div><dt>Orders</dt><dd>{{order_count}}</dd></div>\n" +
  "    <div><dt>Lifetime spend</dt><dd>{{lifetime_spend}}</dd></div>\n" +
  "    <div><dt>Member since</dt><dd>{{member_since}}</dd></div>\n" +
  "    <div><dt>Passkeys</dt><dd>{{passkey_count}}</dd></div>\n" +
  "  </dl>\n" +
  "  <div class=\"account-dash__body\">\n" +
  "    <h2 class=\"pdp__variants-title\">Recent orders</h2>\n" +
  "    <div class=\"table-scroll\">\n" +
  "      <table class=\"account-orders-table\">\n" +
  "        <thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Total</th></tr></thead>\n" +
  "        <tbody>{{order_rows}}</tbody>\n" +
  "      </table>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n";

var ACCOUNT_DASH_ORDER_ROW =
  "<tr>\n" +
  "  <td data-label=\"Order\"><a href=\"/orders/{{order_id}}\" class=\"account-order__id\"><code>{{order_id_short}}</code></a></td>\n" +
  "  <td class=\"account-order__items\" data-label=\"Items\">RAW_ACCOUNT_ORDER_THUMBS</td>\n" +
  "  <td data-label=\"Status\"><span class=\"pdp__badge {{status_class}}\">{{status}}</span></td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "</tr>\n";

function renderAccount(opts) {
  if (!opts || !opts.customer) throw new TypeError("storefront.renderAccount: opts.customer required");
  var orders = opts.orders || [];
  var assetPrefix = opts.asset_prefix || "/assets/";
  var orderLookup = opts.order_product_lookup || {};   // { order_id: [{ product, hero_media }, ...] }
  var passkeyCount = opts.passkey_count == null ? 0 : opts.passkey_count;

  // Lifetime spend = sum of grand_total_minor across orders, in
  // the dominant currency (defaults to USD; mixed-currency
  // customers are rare in the demo but worth handling — we
  // fallback to "—" when currencies disagree so the stat doesn't
  // silently misrepresent the total).
  var currencies = new Set(orders.map(function (o) { return o.currency || "USD"; }));
  var lifetimeStr = "—";
  if (currencies.size <= 1) {
    var total = orders.reduce(function (acc, o) { return acc + (o.grand_total_minor || 0); }, 0);
    var ccy   = orders.length ? (orders[0].currency || "USD") : "USD";
    lifetimeStr = pricing.format(total, ccy);
  }

  // Member-since — earliest known order date, or "—" if none.
  // The customer row may carry a `created_at` epoch ms; if so
  // prefer that (it's authoritative).
  var memberSince = "—";
  if (opts.customer.created_at) {
    memberSince = new Date(opts.customer.created_at).toISOString().slice(0, 10);
  } else if (orders.length) {
    var earliest = orders.reduce(function (acc, o) {
      var t = o.created_at || Infinity;
      return t < acc ? t : acc;
    }, Infinity);
    if (isFinite(earliest)) memberSince = new Date(earliest).toISOString().slice(0, 10);
  }

  function _statusClass(s) {
    if (s === "completed" || s === "shipped" || s === "delivered") return "pdp__badge--ok";
    return "";
  }
  function _escAttr(s) { return b.template.escapeHtml(s); }

  var rows = orders.map(function (o) {
    var products = orderLookup[o.id] || [];
    var thumbs = products.slice(0, 4).map(function (entry) {
      if (entry && entry.hero_media) {
        return "<span class=\"account-order__thumb\"><img src=\"" + _escAttr(assetPrefix + entry.hero_media.r2_key) + "\" alt=\"" + _escAttr(entry.hero_media.alt_text || (entry.product && entry.product.title) || "") + "\" loading=\"lazy\"></span>";
      }
      return "<span class=\"account-order__thumb account-order__thumb--empty\" aria-hidden=\"true\"></span>";
    }).join("");
    if (!thumbs) thumbs = "<span class=\"account-order__thumb account-order__thumb--empty\" aria-hidden=\"true\"></span>";
    var moreCount = products.length > 4 ? "<span class=\"account-order__more\">+" + (products.length - 4) + "</span>" : "";
    return _render(ACCOUNT_DASH_ORDER_ROW, {
      order_id:       o.id,
      order_id_short: o.id.slice(0, 8),
      status:         o.status,
      status_class:   _statusClass(o.status),
      total:          pricing.format(o.grand_total_minor, o.currency),
    }).replace("RAW_ACCOUNT_ORDER_THUMBS", thumbs + moreCount);
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No orders yet. Browse the shop and your first order shows up here.</td></tr>";
  var body = _render(ACCOUNT_DASH_PAGE, {
    display_name:    opts.customer.display_name,
    order_count:     String(orders.length),
    lifetime_spend:  lifetimeStr,
    member_since:    memberSince,
    passkey_count:   String(passkeyCount),
    order_rows:      "RAW_ORDER_ROWS",
  }).replace("RAW_ORDER_ROWS", rows);
  return _wrap({
    title:      "Account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// ---- passkey management ------------------------------------------------
//
// The signed-in customer's enrolled WebAuthn credentials, each with a
// confirm-gated revoke, plus an "add another passkey" flow that reuses
// the same begin/finish ceremony the registration page drives (here
// bound to the AUTHED customer, so no email form is involved). Email is
// stored hash-only and a passkey is the account's sign-in method, so the
// list never leaks the address and the last-credential guard (enforced in
// the route, surfaced here) keeps a customer from locking themselves out.

// Map the WebAuthn transports hint to a short human label for the list.
function _transportLabel(t) {
  if (t === "internal") return "This device";
  if (t === "hybrid")   return "Phone / nearby device";
  if (t === "usb")      return "Security key (USB)";
  if (t === "nfc")      return "Security key (NFC)";
  if (t === "ble")      return "Security key (Bluetooth)";
  return t;
}

function renderPasskeys(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var list = opts.passkeys || [];
  // Only offer per-credential revoke when removing it still leaves the
  // customer a way back in — another passkey, OR a linked OAuth identity.
  // When this is the last credential and there's no federated fallback,
  // the revoke control is replaced by a disabled note so the customer
  // can't lock themselves out. The route enforces the same rule server-
  // side; this is the matching display.
  var canRevokeAny = list.length > 1 || (opts.has_oauth === true && list.length >= 1);
  var rowsHtml = "";
  for (var i = 0; i < list.length; i += 1) {
    var p = list[i];
    var transports = (p.transports ? String(p.transports).split(",") : [])
      .filter(Boolean)
      .map(function (t) { return "<span class=\"passkey-card__transport\">" + esc(_transportLabel(t)) + "</span>"; })
      .join("");
    var added = "";
    if (p.created_at) {
      added = "<p class=\"passkey-card__meta\">Added " + esc(new Date(p.created_at).toISOString().slice(0, 10)) + "</p>";
    }
    // The credential handle is opaque; show a short fingerprint so the
    // customer can tell two devices apart without exposing the full key.
    var fingerprint = p.credential_id ? esc(String(p.credential_id).slice(0, 12)) : esc(String(p.id).slice(0, 12));
    var actionCell = canRevokeAny
      ? "<a class=\"btn-ghost btn-ghost--sm\" href=\"/account/passkeys/" + esc(String(p.id)) + "/remove\">Revoke</a>"
      : "<span class=\"passkey-card__last\" title=\"This is your only way to sign in\">Only sign-in method</span>";
    rowsHtml +=
      "<li class=\"passkey-card\">" +
        "<div class=\"passkey-card__body\">" +
          "<p class=\"passkey-card__id\"><code>" + fingerprint + "…</code></p>" +
          (transports ? "<p class=\"passkey-card__transports\">" + transports + "</p>" : "") +
          added +
        "</div>" +
        "<div class=\"passkey-card__actions\">" + actionCell + "</div>" +
      "</li>";
  }
  var listHtml = rowsHtml
    ? "<ul class=\"passkey-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">No passkeys enrolled. Add one below so you can sign in from this device.</p>" +
      "</div>";
  // Success / notice banners, driven by the ?ok=<kind> PRG redirect.
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var success = opts.success
    ? "<div class=\"form-notice form-notice--ok\" role=\"status\"><span>" + esc(String(opts.success)) + "</span></div>"
    : "";
  // The "add another" control is an island-driven button (CSP forbids
  // inline script): it runs navigator.credentials.create against the
  // authed begin/finish endpoints. With JS off the button does nothing,
  // so it's framed as an enhancement, not the only path (a JS-off
  // customer who needs another device can re-register through the normal
  // flow — same credential lands on the same account by email).
  var addBlock =
    "<section class=\"passkey-add\">" +
      "<h2 class=\"account-addresses__form-title\">Add another passkey</h2>" +
      "<p class=\"passkey-add__lede\">Enroll a passkey on another device or security key so you can sign in from more than one place.</p>" +
      "<div class=\"form-actions\"><button type=\"button\" id=\"passkey-add-btn\" class=\"btn-primary\">Add a passkey</button></div>" +
      "<p id=\"passkey-add-message\" class=\"auth-form__message\"></p>" +
      "RAW_PASSKEY_ADD_SCRIPT" +
    "</section>";
  var body =
    "<section class=\"account-passkeys\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Passkeys</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-addresses__title\">Passkeys</h1>" +
      "<p class=\"section-head__lede\">Devices that can sign in to your account. Revoke any you no longer use.</p>" +
      success +
      notice +
      listHtml +
      addBlock +
    "</section>";
  body = body.replace("RAW_PASSKEY_ADD_SCRIPT", _islandScript("passkey-add.js"));
  return _wrap({
    title:      "Passkeys",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Server-rendered confirm step for revoking a passkey — CSP forbids an
// inline confirm() dialog, so the destructive action is gated behind a
// second page whose POST actually revokes. Mirrors renderAddressRemoveConfirm.
function renderPasskeyRemoveConfirm(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var p = opts.passkey || {};
  var fingerprint = p.credential_id ? esc(String(p.credential_id).slice(0, 12)) : esc(String(p.id).slice(0, 12));
  var added = p.created_at
    ? "<p class=\"passkey-card__meta\">Added " + esc(new Date(p.created_at).toISOString().slice(0, 10)) + "</p>"
    : "";
  var body =
    "<section class=\"account-confirm\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/passkeys\">Passkeys</a></li>" +
        "<li aria-current=\"page\">Revoke passkey</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-confirm__title\">Revoke this passkey?</h1>" +
      "<p class=\"passkey-card__id\"><code>" + fingerprint + "…</code></p>" +
      added +
      "<p class=\"account-confirm__lede\">The device holding this passkey will no longer be able to sign in. " +
        "Make sure you still have another way into your account before revoking.</p>" +
      "<div class=\"account-confirm__actions\">" +
        "<form method=\"post\" action=\"/account/passkeys/" + esc(String(p.id)) + "/revoke\">" +
          "<button type=\"submit\" class=\"btn-primary\">Revoke passkey</button>" +
        "</form>" +
        "<a class=\"btn-ghost\" href=\"/account/passkeys\">Cancel</a>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Revoke passkey",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- profile edit ------------------------------------------------------
//
// Display-name edit for the signed-in customer. Email is stored hash-only
// and is the OAuth account-linking key, so it's shown read-only (masked)
// and cannot be changed here — the primitive refuses an email patch until
// a verification ceremony exists. The form is a plain server-rendered
// POST with a PRG `?ok=updated` success notice, matching the addresses
// pattern.
function renderProfile(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var customer = opts.customer || {};
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var success = opts.success
    ? "<div class=\"form-notice form-notice--ok\" role=\"status\"><span>" + esc(String(opts.success)) + "</span></div>"
    : "";
  var displayValue = esc(String(customer.display_name == null ? "" : customer.display_name));
  var body =
    "<section class=\"account-profile\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Profile</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-addresses__title\">Edit profile</h1>" +
      success +
      notice +
      "<form method=\"post\" action=\"/account/profile\" class=\"form-stack\">" +
        "<div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Display name</span>" +
          "<input type=\"text\" name=\"display_name\" maxlength=\"128\" required autocomplete=\"name\" value=\"" + displayValue + "\"></label></div>" +
        "<div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span>" +
          "<input type=\"text\" value=\"Hidden for privacy — stored as a one-way hash\" disabled aria-describedby=\"email-note\"></label></div>" +
        "<p id=\"email-note\" class=\"form-field__hint\">Your email address is never stored in readable form, so it can't be changed or shown here. " +
          "Sign in with the address you registered.</p>" +
        "<div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary\">Save changes</button> " +
          "<a class=\"btn-ghost\" href=\"/account\">Cancel</a></div>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Edit profile",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- customer survey page ----------------------------------------------

// Render one survey question as a fieldset. Rating → a 0/1..max radio
// scale; select → radio options; free_text → a textarea. Field name is
// `q_<id>`; the post handler maps it back. All operator-authored strings
// are HTML-escaped at the sink.
function _surveyQuestion(q) {
  var esc = function (s) { return b.template.escapeHtml(String(s == null ? "" : s)); };
  var name = "q_" + esc(q.id);
  var req  = q.required ? " <abbr class=\"survey-req\" title=\"Required\">*</abbr>" : "";
  var control = "";
  if (q.kind === "rating") {
    var lo = (q.max >= 9) ? 0 : 1; // 0..10 for NPS-scale, else 1..max
    var scale = "";
    for (var n = lo; n <= q.max; n += 1) {
      scale += "<label class=\"survey-scale__opt\"><input type=\"radio\" name=\"" + name + "\" value=\"" + n + "\"" + (q.required ? " required" : "") + "><span>" + n + "</span></label>";
    }
    control = "<div class=\"survey-scale\">" + scale + "</div>";
  } else if (q.kind === "select") {
    var opts = "";
    for (var k = 0; k < q.options.length; k += 1) {
      var ov = esc(q.options[k]);
      opts += "<label class=\"survey-opt\"><input type=\"radio\" name=\"" + name + "\" value=\"" + ov + "\"" + (q.required ? " required" : "") + "> " + ov + "</label>";
    }
    control = "<div class=\"survey-opts\">" + opts + "</div>";
  } else {
    control = "<textarea name=\"" + name + "\" maxlength=\"" + (q.max || 2000) + "\"" + (q.required ? " required" : "") + "></textarea>";
  }
  return "<fieldset class=\"survey-q\"><legend>" + esc(q.label) + req + "</legend>" + control + "</fieldset>";
}

// The token survey page. `state` selects the panel: form (answerable),
// thankyou (just submitted), responded (already done), expired, closed, or
// notfound. The token is rendered into the form action so the POST carries
// it back (it's path-segment-safe — 43 base64url chars).
function renderSurveyPage(opts) {
  opts = opts || {};
  var esc = function (s) { return b.template.escapeHtml(String(s == null ? "" : s)); };
  var state = opts.state || "notfound";
  var body;
  if (state === "form") {
    var survey = opts.survey || {};
    var qs = (survey.questions || []).map(_surveyQuestion).join("");
    var notice = opts.notice ? "<p class=\"form-notice\">" + esc(opts.notice) + "</p>" : "";
    body =
      "<section class=\"survey-page\"><div class=\"survey-page__inner\">" +
        "<p class=\"eyebrow\">Your feedback</p>" +
        "<h1 class=\"survey-page__title\">" + esc(survey.title) + "</h1>" +
        notice +
        "<form class=\"survey-form\" method=\"post\" action=\"/survey/" + esc(opts.token) + "\">" +
          qs +
          "<div class=\"survey-form__actions\"><button class=\"btn-primary\" type=\"submit\">Submit feedback</button></div>" +
        "</form>" +
      "</div></section>";
  } else {
    var heads = {
      thankyou:  ["Thank you", "Your feedback's in — we appreciate you taking the time."],
      responded: ["Already answered", "This feedback link has already been used. Thank you."],
      expired:   ["This link has expired", "The feedback window for this survey has closed."],
      closed:    ["This survey is closed", "This feedback link is no longer active."],
      notfound:  ["Survey not found", "This feedback link isn't valid. Check the link from your email."],
    };
    var h = heads[state] || heads.notfound;
    body =
      "<section class=\"survey-page\"><div class=\"survey-page__inner survey-page__inner--msg\">" +
        "<h1 class=\"survey-page__title\">" + esc(h[0]) + "</h1>" +
        "<p class=\"survey-page__lede\">" + esc(h[1]) + "</p>" +
        "<a class=\"btn-ghost\" href=\"/\">Back to the shop</a>" +
      "</div></section>";
  }
  return _wrap({
    title:      opts.title || "Survey",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- business-hours page -----------------------------------------------

var _DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// The public /hours page. `opts.schedules` is an array of resolved
// schedules: { summary: { slug, timezone, days[7] }, is_open, next_open,
// next_close }. Renders each as a card with a live open/closed pill, the
// next transition, and the weekly grid. An empty list renders a friendly
// "not published yet" notice.
function renderHoursPage(opts) {
  opts = opts || {};
  var esc = function (s) { return b.template.escapeHtml(String(s == null ? "" : s)); };
  var schedules = opts.schedules || [];
  var body;
  if (!schedules.length) {
    body =
      "<section class=\"hours-page\"><div class=\"hours-page__inner hours-page__inner--msg\">" +
        "<h1 class=\"hours-page__title\">Hours</h1>" +
        "<p class=\"hours-page__lede\">Our hours haven't been published yet.</p>" +
        "<a class=\"btn-ghost\" href=\"/\">Back to the shop</a>" +
      "</div></section>";
  } else {
    var cards = schedules.map(function (s) {
      var pill = s.is_open
        ? "<span class=\"hours-status hours-status--open\">Open now</span>"
        : "<span class=\"hours-status hours-status--closed\">Closed</span>";
      var next = "";
      if (s.is_open && s.next_close) next = "Closes at " + esc(s.next_close.close);
      else if (!s.is_open && s.next_open) next = "Opens " + esc(s.next_open.date) + " at " + esc(s.next_open.open);
      var rows = "";
      var days = (s.summary && s.summary.days) || [];
      for (var d = 0; d < 7; d += 1) {
        var wins = days[d] || [];
        var hrs = wins.length
          ? wins.map(function (w) { return esc(w.open) + "–" + esc(w.close); }).join(", ")
          : "<span class=\"hours-table__closed\">Closed</span>";
        rows += "<tr><th scope=\"row\">" + _DOW_NAMES[d] + "</th><td>" + hrs + "</td></tr>";
      }
      return "<div class=\"hours-card\">" +
               "<div class=\"hours-card__head\"><h2>" + esc(s.summary.slug) + "</h2>" + pill + "</div>" +
               (next ? "<p class=\"hours-card__next\">" + next + "</p>" : "") +
               "<table class=\"hours-table\"><tbody>" + rows + "</tbody></table>" +
               "<p class=\"hours-card__tz\">Times shown in " + esc(s.summary.timezone) + ".</p>" +
             "</div>";
    }).join("");
    body =
      "<section class=\"hours-page\"><div class=\"hours-page__inner\">" +
        "<p class=\"eyebrow\">When we're around</p>" +
        "<h1 class=\"hours-page__title\">Hours</h1>" +
        "<div class=\"hours-grid\">" + cards + "</div>" +
      "</div></section>";
  }
  return _wrap({
    title:      "Hours",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

function mount(router, deps) {
  if (!router || typeof router.get !== "function") throw new TypeError("storefront.mount: router with .get() required");
  if (!deps || !deps.catalog || !deps.cart) throw new TypeError("storefront.mount: deps.catalog + deps.cart required");
  var shopName = (deps.config && deps.config.shop_name) || "blamejs.shop";
  // Optional theme — when supplied, every renderer below dispatches
  // to file-backed templates under <themesDir>/<name>/. When absent,
  // the inline-string templates above stay in force (operators on
  // older deploys keep their current look without a migration step).
  var theme = deps.theme || null;
  // Subscription self-management — opts in /account/subscriptions. The
  // cancel route additionally needs the payment handle (cancel composes
  // Stripe via the primitive); without it the list stays read-only.
  var subscriptions = deps.subscriptions || null;

  // Active cookie-consent policy version. `_liveConsentPolicy()` reads it
  // from the consent primitive per request so a runtime `policyVersion`
  // bump takes effect on the gate immediately, and refreshes the module
  // snapshot the page-stamp reads — the snapshot exists because the
  // module-level renderers (`_wrap`) don't close over `deps`, so consulting
  // the live version (every consent route does) keeps the stamped value in
  // step without threading it through every render call. Set once here so
  // the value is correct from the first render after boot.
  function _liveConsentPolicy() {
    _activeConsentPolicy = _sanitizeConsentPolicy(deps.cookieConsent && deps.cookieConsent.policyVersion);
    return _activeConsentPolicy;
  }
  _liveConsentPolicy();

  function _send(res, status, html) {
    res.status(status);
    res.setHeader && res.setHeader("content-type", "text/html; charset=utf-8");
    res.end ? res.end(html) : res.send(html);
  }

  // Defensive request-shape reader for the optional loyalty-points
  // redeem field on the checkout form. Returns undefined for missing /
  // empty / zero / non-numeric input (checkout treats undefined as "no
  // redemption"); a positive integer otherwise. The backend's
  // _resolveLoyaltyCredit is authoritative on balance + cap — this only
  // shapes the wire value so a blank field doesn't become a "0 points"
  // validation error.
  function _parseRedeemPoints(raw) {
    if (raw == null || raw === "") return undefined;
    var n = parseInt(String(raw), 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return n;
  }

  // Cart-count read shared across every handler that wraps a page in
  // the layout — the header's cart pill renders the count. Returns 0
  // for visitors with no session cookie. Defined at the top of mount
  // so the /admin landing + the onNotFound 404 handler (mounted
  // outside the `if (deps.customers)` block below) can reach it.
  async function _cartCountForReq(req) {
    var sid = _readSidCookie(req);
    if (!sid) return 0;
    var c = await deps.cart.bySession(sid);
    if (!c) return 0;
    var lines = await deps.cart.listLines(c.id);
    return lines.length;
  }

  // ---- multi-currency display -------------------------------------------
  //
  // Opt-in: wired only when the operator supplies `deps.currencyDisplay`
  // (an FX-rate cache instance) AND `deps.currency_display_options` (the
  // allow-list of display currencies, base first). Absent either, every
  // render call gets an empty currency bundle and prices stay in the base
  // currency exactly as before. `deps.currencyRounding` is optional —
  // present, it applies the per-currency display-increment rule (CHF 0.05,
  // SEK 0.10); absent, conversion uses banker's rounding only.
  var _ccyBase    = (deps.currency_base || "USD").toUpperCase();
  var _ccyOptions = Array.isArray(deps.currency_display_options)
    ? deps.currency_display_options.map(function (c) { return String(c).toUpperCase(); })
    : null;
  // The feature mounts (the /currency route + the per-request bundle)
  // whenever an FX instance is wired AND the boot-time allow-list names
  // >1 currency. The per-request `currency_config` resolver can narrow /
  // widen the live allow-list, but mounting is decided once at boot from
  // the seed so a single-currency store never registers the route.
  var _ccyEnabled = !!(deps.currencyDisplay && _ccyOptions && _ccyOptions.length > 1);
  var _ccyConfig  = typeof deps.currency_config === "function" ? deps.currency_config : null;

  // Per-request currency bundle merged into every render call's opts:
  //   format_price          — sync base→display formatter (or pricing.format)
  //   currency_options       — the switcher's option list
  //   currency_selected      — the visitor's active display currency
  //   currency_note          — "charged in <base>" disclosure (when converting)
  //   currency_redirect_to   — the path the switcher returns the visitor to
  // A read / conversion failure degrades to the base bundle (prices in the
  // base currency) — a broken FX backend never breaks a priced page.
  async function _currencyForReq(req) {
    if (!_ccyEnabled) return {};
    var path = String((req && req.url) || "/").split("?")[0] || "/";
    // Resolve the live base + allow-list (config override, else the boot
    // seed). A resolver failure falls back to the seed.
    var base = _ccyBase;
    var options = _ccyOptions;
    if (_ccyConfig) {
      try {
        var cfg = await _ccyConfig();
        if (cfg && cfg.base) base = cfg.base;
        if (cfg && Array.isArray(cfg.options) && cfg.options.length) options = cfg.options;
      } catch (_e) { /* keep the boot seed */ }
    }
    var bundle = {
      currency_options:     options,
      currency_selected:    base,
      currency_redirect_to: path,
    };
    var chosen = _readCurrencyCookie(req);
    try {
      var presenter = await currencyDisplayModule.loadPresenter({
        fx:              deps.currencyDisplay,
        rounding:        deps.currencyRounding || null,
        baseCurrency:    base,
        displayCurrency: chosen,
      });
      // The presenter only activates when the chosen currency is in the
      // live allow-list AND has a usable rate. A cookie naming a currency
      // the operator since removed from the list resolves to base.
      if (presenter && presenter.active && options.indexOf(presenter.displayCurrency) !== -1) {
        bundle.format_price      = presenter.format;
        bundle.currency_selected = presenter.displayCurrency;
        if (presenter.note) bundle.currency_note = presenter.note;
      }
    } catch (_e) {
      // FX / rounding backend unavailable — fall back to base display.
    }
    return bundle;
  }

  // ---- locale / i18n chrome ---------------------------------------------
  //
  // The storefront renders its UI chrome (nav, footer, search controls,
  // newsletter band, locale switcher) localised per request. The locale
  // is resolved the SAME way the edge Worker resolves it — cookie-first,
  // then `?lang=`, then Accept-Language, then the policy default — so a
  // visitor sees identical chrome whether the request is served at the
  // edge or by this container. The strings come from `b.i18n` over the
  // chrome catalog in `lib/translations.js`, layered with the operator's
  // `ui`/`chrome` translation rows; a missing key falls back to the
  // English baseline (never a raw key).
  //
  // `deps.chromeI18n` is the `b.i18n` instance (built once at boot via
  // translations.createChromeI18n with the operator's overrides). When
  // absent — a deploy with no locale policy seeded — the storefront
  // renders the English baseline and shows no switcher. `deps.localeRouter`
  // is the optional resolver; `deps.localeOptions` carries the default
  // locale + the active-locale list the switcher renders.
  var chromeI18n   = deps.chromeI18n   || null;
  var localeRouter = deps.localeRouter || null;
  var localeOptions = deps.localeOptions || {};
  var defaultLocale = localeOptions.defaultLocale || translationsModule.BASELINE_LOCALE;
  // Active locales the switcher offers: [{ tag, label }]. Operators
  // declare the label (the autonym — "Deutsch", "Français") in
  // localeOptions; absent that, the tag itself is the label.
  var activeLocales = Array.isArray(localeOptions.locales) ? localeOptions.locales : [];
  // Supported tags for the cookie/`?lang=` direct-match fast path.
  var supportedTags = activeLocales.map(function (l) { return l.tag; });
  // i18n RTL helper — `b.i18n.dir({ locale })` returns "rtl"/"ltr".
  function _dirFor(locale) {
    if (!chromeI18n) return "ltr";
    try { return chromeI18n.dir({ locale: locale }); } catch (_e) { return "ltr"; }
  }

  // Per-locale resolved chrome string set, memoised — the strings don't
  // change per request (only the cart count, interpolated at render
  // time), so resolve each locale once.
  var _chromeByLocale = Object.create(null);
  function _chromeFor(locale) {
    if (!chromeI18n) return translationsModule.chromeDefaults();
    if (_chromeByLocale[locale]) return _chromeByLocale[locale];
    var resolved = translationsModule.resolveChrome(chromeI18n, locale);
    _chromeByLocale[locale] = resolved;
    return resolved;
  }

  // Match a candidate tag against the supported set — the SAME rule the
  // locale-router uses: a case-insensitive direct hit, then a primary-
  // subtag match (`en-GB` candidate -> supported `en`). Returns the
  // matched supported tag (catalog casing) or null. Kept in-process so
  // resolution is synchronous — the middleware must seed the async-local
  // store within one synchronous tick (an `await` inside the middleware
  // would set the store in the awaited frame, not the request's).
  var _supportedLowerToTag = Object.create(null);
  for (var _si = 0; _si < supportedTags.length; _si += 1) {
    _supportedLowerToTag[String(supportedTags[_si]).toLowerCase()] = supportedTags[_si];
  }
  function _matchSupported(candidate) {
    if (!candidate) return null;
    var lowered = String(candidate).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(_supportedLowerToTag, lowered)) {
      return _supportedLowerToTag[lowered];
    }
    var primary = lowered.split("-")[0];
    if (Object.prototype.hasOwnProperty.call(_supportedLowerToTag, primary)) {
      return _supportedLowerToTag[primary];
    }
    return null;
  }

  // Parse an Accept-Language header into a q-sorted list of tags. A
  // garbage header yields an empty list (the resolver then falls to the
  // default). Mirrors the locale-router's parser shape.
  function _parseAcceptLanguage(raw) {
    if (typeof raw !== "string" || !raw.length || raw.length > 4096) return [];
    var out = [];
    var parts = raw.split(",");
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i].trim();
      if (!part) continue;
      var semi = part.indexOf(";");
      var tag = (semi === -1 ? part : part.slice(0, semi)).trim();
      var q = 1.0;
      if (semi !== -1) {
        var m = /q=([0-9.]+)/.exec(part.slice(semi + 1));
        if (m) { var n = parseFloat(m[1]); if (isFinite(n) && n >= 0 && n <= 1) q = n; }
      }
      if (tag === "*" || !LOCALE_COOKIE_RE.test(tag) || tag.length > LOCALE_COOKIE_MAX) continue;
      out.push({ tag: tag, q: q, order: i });
    }
    out.sort(function (a, c) { return a.q !== c.q ? c.q - a.q : a.order - c.order; });
    return out;
  }

  // Resolve the request's locale synchronously, in the SAME precedence
  // the edge Worker / locale-router use: an explicit `?lang=` choice,
  // then the persisted cookie, then the browser's Accept-Language list,
  // then the policy default. Only a tag that resolves into the active
  // supported set is honoured; anything else (unknown code, garbage
  // cookie) falls through to the default. Never throws.
  function _resolveRequestLocale(req) {
    var queryLocale = null;
    if (req.query && typeof req.query.lang === "string" &&
        LOCALE_COOKIE_RE.test(req.query.lang) && req.query.lang.length <= LOCALE_COOKIE_MAX) {
      queryLocale = req.query.lang;
    }
    var qMatch = _matchSupported(queryLocale);
    if (qMatch) return qMatch;

    var cMatch = _matchSupported(_readLocaleCookie(req));
    if (cMatch) return cMatch;

    var alHeader = req.headers && (req.headers["accept-language"] || req.headers["Accept-Language"]);
    var alList = _parseAcceptLanguage(alHeader);
    for (var i = 0; i < alList.length; i += 1) {
      var alMatch = _matchSupported(alList[i].tag);
      if (alMatch) return alMatch;
    }
    return defaultLocale;
  }

  // Best-effort: record the resolution in the locale-router's audit log
  // (locale_resolutions_log). Fire-and-forget — never awaited, never
  // blocks the request, never throws into the hot path. Wired only when
  // the locale-router is present.
  function _logResolution(req, locale) {
    if (!localeRouter || typeof localeRouter.resolveLocale !== "function") return;
    try {
      var hostHeader = (req.headers && (req.headers.host || req.headers.Host)) || "localhost";
      var p = localeRouter.resolveLocale({
        request: {
          host:            String(hostHeader),
          path:            req.pathname || (String(req.url || "/").split("?")[0]) || "/",
          cookie_locale:   locale,
          accept_language: undefined,
        },
      });
      if (p && typeof p.then === "function") p.then(function () {}, function () {});
    } catch (_e) { /* drop-silent — the audit log is non-critical */ }
  }

  // Build the server-rendered locale switcher form. A GET form (works
  // with JS off) that submits the chosen `lang` to /locale, which sets
  // the cookie and 303-redirects back to the page the visitor was on
  // (validated same-origin). Rendered only when there's more than one
  // active locale to choose between.
  function _switcherHtml(req, activeLocale, chrome) {
    if (activeLocales.length < 2) return "";
    var esc = b.template.escapeHtml;
    // `to` carries the current path+query so the redirect lands the
    // visitor back where they were. Validated server-side in /locale.
    var here = req.pathname || (String(req.url || "/").split("?")[0]) || "/";
    var options = activeLocales.map(function (l) {
      var sel = l.tag === activeLocale ? " selected" : "";
      return "<option value=\"" + esc(l.tag) + "\"" + sel + ">" + esc(l.label || l.tag) + "</option>";
    }).join("");
    return "" +
      "    <form class=\"locale-switcher\" method=\"get\" action=\"/locale\">\n" +
      "      <label class=\"locale-switcher__label\" for=\"locale-switcher-select\">" + esc(chrome.locale_switcher_label) + "</label>\n" +
      "      <input type=\"hidden\" name=\"to\" value=\"" + esc(here) + "\">\n" +
      "      <select id=\"locale-switcher-select\" class=\"locale-switcher__select\" name=\"lang\">" + options + "</select>\n" +
      "      <button class=\"locale-switcher__submit\" type=\"submit\">" + esc(chrome.locale_switcher_submit) + "</button>\n" +
      "    </form>\n";
  }

  // The per-request locale context the layout reads via the async-local
  // store. Resolved SYNCHRONOUSLY so the middleware can seed the store
  // within one tick. Shape: { locale, lang, dir, chrome, switcher_html }.
  // Never throws — any failure falls back to the default locale.
  function _localeCtx(req) {
    var locale = defaultLocale;
    try { locale = _resolveRequestLocale(req); } catch (_e) { locale = defaultLocale; }
    var chrome = _chromeFor(locale);
    return {
      locale:        locale,
      lang:          locale,
      dir:           _dirFor(locale),
      chrome:        chrome,
      switcher_html: _switcherHtml(req, locale, chrome),
    };
  }

  // Seed the per-request locale context into the async-local store so
  // every `_wrap` on this request reads the resolved chrome. The
  // middleware is SYNCHRONOUS: `AsyncLocalStorage.enterWith` only
  // propagates to the request's downstream handlers when it runs in the
  // same synchronous tick the router awaits — an `await` inside the
  // middleware would scope the store to the awaited frame, not the
  // request. Resolution is best-effort (falls back to the English
  // baseline). The audit-log write is fired off without awaiting so it
  // never blocks the render. Only mounted when the router exposes `.use`.
  if (typeof router.use === "function") {
    router.use(function localeMiddleware(req, _res, next) {
      try {
        var ctx = _localeCtx(req);
        _localeAls.enterWith(ctx);
        _logResolution(req, ctx.locale);
      } catch (_e) { /* drop-silent — baseline applies */ }
      next();
    });
  }

  // Announcement-bar resolution — synchronous, so its `enterWith` reaches
  // the page handler (an async middleware's would not). Runs AFTER the
  // locale middleware so it can extend that request's ALS context rather
  // than replace it. The active set comes from a short-TTL in-memory cache
  // refreshed out-of-band here (fire-and-forget — never blocks the render);
  // resolution itself reads the cache + the dismissed-slug cookie + a
  // coarse logged-in/guest signal (auth-cookie presence — exact identity
  // isn't needed to bucket audience). Best-effort: any failure drops the
  // bar, never the page.
  if (typeof router.use === "function" && deps.announcementBar) {
    router.use(function announcementMiddleware(req, _res, next) {
      try {
        _refreshAnnouncementCache(deps.announcementBar);
        var viewerKind = _cookieJar().read(req, AUTH_COOKIE_NAME) ? "logged_in" : "guest";
        var row = _resolveActiveAnnouncement(viewerKind);
        var cur = _localeAls.getStore() || {};
        _localeAls.enterWith(Object.assign({}, cur, { announcement: row }));
      } catch (_e) { /* drop-silent — no bar this request */ }
      next();
    });

    // Dismiss an announcement (no-JS path; the island intercepts the click
    // and stays on-page). Records the durable dismissal keyed on the
    // session id when one is present, always appends the slug to the plain
    // `shop_ann_dismissed` cookie (the cookie is what hides the bar on a
    // cached edge response), and 303-redirects to a validated same-origin
    // return path. Unknown slug / no session still sets the cookie + redirects
    // — a hostile or stale slug can never 500 the route.
    router.post("/announcements/:slug/dismiss", async function (req, res) {
      var slug = (req.params && typeof req.params.slug === "string") ? req.params.slug : "";
      var body = req.body || {};
      var to = (typeof body.return_to === "string") ? body.return_to : "/";
      if (to.charAt(0) !== "/" || to.charAt(1) === "/" || to.indexOf("\\") !== -1 || /[\x00-\x1f\x7f]/.test(to)) {
        to = "/";
      }
      if (/^[a-z0-9-]{1,64}$/.test(slug)) {
        // Durable record (best-effort — keyed on the cart session id; absent
        // a session the cookie still carries the dismissal for this browser).
        try {
          var sid = _readSidCookie(req);
          if (sid) await deps.announcementBar.recordDismissal({ slug: slug, session_id: sid });
        } catch (_e) { /* slug not found / no session — cookie still set below */ }
        // Append the slug to the dismissed-cookie set (deduped, capped).
        var slugs = _readDismissedSlugs(req);
        if (slugs.indexOf(slug) === -1) slugs.push(slug);
        if (slugs.length > 50) slugs = slugs.slice(slugs.length - 50);
        _cookieJar().write(res, ANNOUNCEMENT_DISMISS_COOKIE, slugs.join(","), {
          expires: new Date(Date.now() + b.constants.TIME.days(180)), httpOnly: false,
        });
      }
      res.status(303);
      res.setHeader && res.setHeader("location", to);
      return res.end ? res.end() : res.send("");
    });
  }

  // ---- customer survey (token-gated) ----------------------------------
  // The invitation token IS the access — no login. GET renders the survey
  // (or a state notice); POST records the response. Container-only (the
  // token page is never edge-cached). Resilient: an unknown/garbage token,
  // a used/expired/closed invitation, and a missing surveys table all
  // resolve to a clean state page, never a 500.
  if (deps.customerSurveys) {
    var _surveyCtx = function (_req) {
      return {
        shop_name: (deps.config && deps.config.shop_name) || "blamejs.shop",
        cart_count: 0,
        theme_css: (deps.theme && deps.theme.assetUrl) ? deps.theme.assetUrl("css/main.css") : DEFAULT_THEME_CSS_URL,
      };
    };

    router.get("/survey/:token", async function (req, res) {
      var token = (req.params && req.params.token) || "";
      var state = "notfound", survey = null;
      try {
        var preview = await deps.customerSurveys.previewByToken(token);
        if (preview) {
          survey = preview.survey;
          var inv = preview.invitation;
          if (inv.status === "responded")      state = "responded";
          else if (inv.status === "closed")    state = "closed";
          else if (inv.status === "expired" || Number(inv.expires_at) < Date.now()) state = "expired";
          else state = "form";
        }
      } catch (_e) { state = "notfound"; }
      var ctx = _surveyCtx(req);
      _send(res, state === "notfound" ? 404 : 200, renderSurveyPage({
        state: state, survey: survey, token: token,
        shop_name: ctx.shop_name, cart_count: ctx.cart_count, theme_css: ctx.theme_css,
      }));
    });

    router.post("/survey/:token", async function (req, res) {
      var token = (req.params && req.params.token) || "";
      var body = req.body || {};
      var ctx = _surveyCtx(req);
      // Resolve the survey first so we can re-render the form on a
      // validation error (and map the token to its questions).
      var preview = null;
      try { preview = await deps.customerSurveys.previewByToken(token); }
      catch (_e) { preview = null; }
      if (!preview) {
        return _send(res, 404, renderSurveyPage({ state: "notfound", token: token, shop_name: ctx.shop_name, theme_css: ctx.theme_css }));
      }
      // Build the answers object from the q_<id> fields, typed per question
      // kind (rating → integer, select/free_text → string). Blank fields are
      // omitted so optional questions stay unanswered.
      var answers = {};
      var questions = preview.survey.questions || [];
      for (var i = 0; i < questions.length; i += 1) {
        var q = questions[i];
        var raw = body["q_" + q.id];
        if (raw == null || raw === "") continue;
        if (q.kind === "rating") {
          var n = parseInt(raw, 10);
          if (isFinite(n)) answers[q.id] = n;
        } else {
          answers[q.id] = String(raw);
        }
      }
      try {
        await deps.customerSurveys.submitResponse({ token: token, answers: answers });
      } catch (e) {
        // Known terminal states → the matching notice; a validation
        // TypeError → re-render the form with the cleaned message.
        var code = e && e.code;
        if (code === "SURVEY_INVITATION_ALREADY_RESPONDED") return _send(res, 200, renderSurveyPage({ state: "responded", token: token, shop_name: ctx.shop_name, theme_css: ctx.theme_css }));
        if (code === "SURVEY_INVITATION_EXPIRED")           return _send(res, 200, renderSurveyPage({ state: "expired", token: token, shop_name: ctx.shop_name, theme_css: ctx.theme_css }));
        if (code === "SURVEY_INVITATION_CLOSED")            return _send(res, 200, renderSurveyPage({ state: "closed", token: token, shop_name: ctx.shop_name, theme_css: ctx.theme_css }));
        if (code === "SURVEY_INVITATION_NOT_FOUND")         return _send(res, 404, renderSurveyPage({ state: "notfound", token: token, shop_name: ctx.shop_name, theme_css: ctx.theme_css }));
        if (e instanceof TypeError) {
          return _send(res, 400, renderSurveyPage({
            state: "form", survey: preview.survey, token: token,
            notice: (e.message || "Please check your answers.").replace(/^customerSurveys[.:]\s*/, ""),
            shop_name: ctx.shop_name, theme_css: ctx.theme_css,
          }));
        }
        throw e;
      }
      _send(res, 200, renderSurveyPage({ state: "thankyou", token: token, shop_name: ctx.shop_name, theme_css: ctx.theme_css }));
    });
  }

  // ---- business hours (public /hours page) ----------------------------
  // Lists every active schedule with its weekly grid + a live open/closed
  // status computed at request time in the schedule's timezone. Container-
  // rendered (the status is time-of-day dependent, so it isn't edge-cached).
  // Resilient: a missing table / no schedules renders the "not published"
  // notice, never a 500.
  if (deps.businessHours) {
    router.get("/hours", async function (req, res) {
      var themeCss = (deps.theme && deps.theme.assetUrl) ? deps.theme.assetUrl("css/main.css") : DEFAULT_THEME_CSS_URL;
      var shopName = (deps.config && deps.config.shop_name) || "blamejs.shop";
      var resolved = [];
      try {
        var schedules = await deps.businessHours.listSchedules();
        var active = (schedules || []).filter(function (s) { return s.archived_at == null; });
        var now = Date.now();
        for (var i = 0; i < active.length; i += 1) {
          var slug = active[i].slug;
          var summary   = await deps.businessHours.weekSummary({ slug: slug });
          var isOpen    = await deps.businessHours.isOpenAt({ slug: slug, when: now });
          var nextOpen  = isOpen ? null : await deps.businessHours.nextOpenAt({ slug: slug, when: now });
          var nextClose = isOpen ? await deps.businessHours.nextCloseAt({ slug: slug, when: now }) : null;
          if (summary) resolved.push({ summary: summary, is_open: isOpen, next_open: nextOpen, next_close: nextClose });
        }
      } catch (_e) { resolved = []; /* table absent / read failure → "not published" */ }
      _send(res, 200, renderHoursPage({ schedules: resolved, shop_name: shopName, theme_css: themeCss }));
    });
  }

  // Persist a locale choice. A GET form (works with JS off) from the
  // footer switcher submits `lang` (the chosen tag) + `to` (the path to
  // return to). We validate the tag against the active locale set, set
  // the unsealed `shop_locale` cookie, and 303-redirect to the `to`
  // path — refusing anything that isn't a same-origin absolute path so
  // the redirect can't be turned into an open-redirect. Unknown / bad
  // `lang` still redirects (to "/" or the validated `to`) without
  // setting a cookie, so a hostile link can't 500 the route.
  router.get("/locale", function (req, res) {
    var q = req.query || {};
    var to = (typeof q.to === "string") ? q.to : "/";
    // Same-origin path only: must start with a single "/" (not "//" — a
    // protocol-relative URL — and not a scheme). Anything else falls
    // back to the home path.
    if (to.charAt(0) !== "/" || to.charAt(1) === "/" || to.indexOf("\\") !== -1 || /[\x00-\x1f\x7f]/.test(to)) {
      to = "/";
    }
    var lang = (typeof q.lang === "string") ? q.lang : "";
    if (lang && LOCALE_COOKIE_RE.test(lang) && lang.length <= LOCALE_COOKIE_MAX && supportedTags.indexOf(lang) !== -1) {
      _setLocaleCookie(res, lang);
    }
    res.status(303);
    res.setHeader && res.setHeader("location", to);
    return res.end ? res.end() : res.send("");
  });

  // Absolute shareable referral link for a code. Prefers the operator's
  // configured origin (deps.shop_origin / SHOP_ORIGIN) so the link is
  // stable across the edge/container split; falls back to the request's
  // Host header when no origin is configured (dev / single-host deploys).
  // The /r/<code> landing is container-served (not an edge route), so it
  // always reaches this primitive's attribution handler.
  function _referralLink(req, code) {
    var origin = deps.shop_origin
      ? String(deps.shop_origin).replace(/\/$/, "")
      : null;
    if (!origin) {
      var host = (req && req.headers && (req.headers.host || req.headers.Host)) || "";
      origin = host ? ("https://" + host) : "";
    }
    return origin + "/r/" + encodeURIComponent(code);
  }

  // The signed-in customer's sealed-cookie envelope, or null. Shared by
  // the PDP view recorder (mounted outside the `if (deps.customers)`
  // block) and the account routes inside it, so there's one auth-cookie
  // reader rather than a copy per call site. A missing / malformed /
  // expired cookie returns null — never throws.
  function _currentCustomerEnv(req) {
    var env = _readAuthEnv(req);
    if (!env || !env.customer_id || !env.exp || env.exp < Date.now()) return null;
    return env;
  }

  // Resolve a product id into the { slug, title, price, image_url,
  // image_alt } shape `_buildProductCard` expects. Returns null for an
  // archived / missing product so it drops out of any grid (collections,
  // recently-viewed). Shared so the decoration rule lives in one place.
  var _cardAssetPrefix = deps.asset_prefix || "/assets/";
  async function _decorateProductCard(pid) {
    var product = await deps.catalog.products.get(pid);
    if (!product || product.status !== "active") return null;
    var priceStr = "—";
    var variants = await deps.catalog.variants.listForProduct(pid);
    if (variants.length) {
      var pr = await deps.catalog.prices.current(variants[0].id, "USD");
      if (pr) priceStr = pricing.format(pr.amount_minor, pr.currency);
    }
    var media = await deps.catalog.media.listForProduct(pid);
    var hero = media.length ? media[0] : null;
    return {
      slug:      product.slug,
      title:     product.title,
      price:     priceStr,
      image_url: hero ? (_cardAssetPrefix + hero.r2_key) : null,
      image_alt: hero ? (hero.alt_text || product.title) : null,
    };
  }

  // Resolve the cart for this request — read session_id from the
  // sealed cookie, create one (and the cart) if absent. Returns
  // the cart row OR null when the cart was just created (caller can
  // use { sid, cart: null } to skip lookup).
  async function _getOrCreateCart(req, res, currency) {
    var sid = _readSidCookie(req);
    if (!sid) {
      sid = b.uuid.v7();
      _setSidCookie(res, sid);
    }
    var existing = await deps.cart.bySession(sid);
    if (existing) return { sid: sid, cart: existing };
    var created = await deps.cart.create(sid, { currency: currency || "USD" });
    return { sid: sid, cart: created };
  }

  // ---- bundle + quantity-discount pricing (server-authoritative) --------
  //
  // Every price below is recomputed from the catalog + the bundle /
  // quantity-discount primitives on each render. The client never
  // sends a price; the cart line's stored snapshot is the add-time
  // catalog price, and the quantity-break adjustment is reapplied each
  // time the cart renders (idempotent — the same line quantity always
  // yields the same adjusted unit), so a stale or forged client value
  // can't survive a round trip.

  // A pricing.priceFor(sku) adapter over the catalog, for
  // bundles.priceBundle. Returns the current price row in `currency`
  // (or null when a member SKU has no price configured, which the
  // caller treats as "bundle unavailable"). Memoized per call site so
  // a bundle that repeats a SKU only hits the catalog once.
  function _skuPricer(currency) {
    var cache = Object.create(null);
    return {
      priceFor: async function (sku) {
        if (cache[sku] !== undefined) return cache[sku];
        var variant = await deps.catalog.variants.bySku(sku);
        if (!variant) { cache[sku] = null; return null; }
        var price = await deps.catalog.prices.current(variant.id, currency);
        cache[sku] = price
          ? { amount_minor: price.amount_minor, currency: price.currency }
          : null;
        return cache[sku];
      },
    };
  }

  // Is a SKU buyable right now — a real, in-stock catalog variant?
  // A bundle with any unbuyable member is shown as unavailable so the
  // atomic add never half-completes. Inventory is optional: a SKU with
  // no inventory row is treated as available (the operator hasn't opted
  // into stock tracking for it), matching the rest of the storefront's
  // never-block-on-missing-inventory stance.
  async function _skuBuyable(sku) {
    var variant = await deps.catalog.variants.bySku(sku);
    if (!variant) return null;
    var inv = await deps.catalog.inventory.get(sku);
    if (inv && (inv.stock_on_hand - inv.stock_held) <= 0) return false;
    return variant;
  }

  // Resolve the "Bundle & save" offers for a product's variant SKUs.
  // For each bundle a SKU belongs to: price it (sum-of-parts vs bundle
  // price via the primitive's stored discount), check every member is
  // buyable, and shape the display offer the renderer consumes. An
  // unpriceable or unbuyable-member bundle is surfaced as unavailable
  // (never hidden silently — the customer sees why). Dedupes bundles
  // reachable via multiple variant SKUs. Drop-silent on a primitive
  // error so a bundles read failure can't 500 the PDP — the rail just
  // doesn't render (mirrors the reviews/Q&A degrade-to-empty stance).
  async function _resolveBundleOffers(variantSkus, currency, fmtPrice) {
    if (!deps.bundles) return [];
    var fmt = typeof fmtPrice === "function" ? fmtPrice : pricing.format;
    var seen = Object.create(null);
    var offers = [];
    try {
      for (var s = 0; s < variantSkus.length; s += 1) {
        var bundleList = await deps.bundles.bundlesForComponent(variantSkus[s]);
        for (var i = 0; i < bundleList.length; i += 1) {
          var bundle = bundleList[i];
          if (seen[bundle.bundle_sku]) continue;
          seen[bundle.bundle_sku] = true;

          // Decorate each member with a display title; flag unbuyable.
          var componentsOut = [];
          var allBuyable = true;
          for (var j = 0; j < bundle.components.length; j += 1) {
            var comp = bundle.components[j];
            var buyable = await _skuBuyable(comp.sku);
            if (!buyable) allBuyable = false;
            var memberVariant = buyable || (await deps.catalog.variants.bySku(comp.sku));
            var memberTitle = comp.sku;
            if (memberVariant) {
              var memberProduct = await deps.catalog.products.get(memberVariant.product_id);
              memberTitle = (memberProduct && memberProduct.title) || memberVariant.title || comp.sku;
            }
            componentsOut.push({ sku: comp.sku, quantity: comp.quantity, title: memberTitle });
          }

          var priced = null;
          try {
            priced = await deps.bundles.priceBundle({ bundle_sku: bundle.bundle_sku, pricing: _skuPricer(currency) });
          } catch (_e) {
            // A missing member price / mixed currency makes the bundle
            // unpriceable — surface it as unavailable rather than 500.
            priced = null;
          }

          var available = allBuyable && priced != null;
          var listMinor = priced ? priced.list_total_minor : 0;
          var amountMinor = priced ? priced.amount_minor : 0;
          var discountMinor = priced ? priced.discount_minor : 0;
          var cur = (priced && priced.currency) || currency;
          offers.push({
            bundle_sku:         bundle.bundle_sku,
            title:              bundle.title,
            components:         componentsOut,
            list_total_str:     fmt(listMinor, cur),
            amount_str:         fmt(amountMinor, cur),
            discount_str:       discountMinor > 0 ? fmt(discountMinor, cur) : null,
            available:          available,
            unavailable_reason: available
              ? null
              : (priced == null
                  ? "Pricing for this bundle isn't available right now."
                  : "One or more items in this bundle are out of stock."),
          });
        }
      }
    } catch (_e) {
      // Bundles table not migrated / read failure — degrade to no rail.
      return [];
    }
    return offers;
  }

  // Resolve the quantity-break table rows for a variant's SKU, against
  // its list price. Composes the quantity-discount primitive's
  // tierBreakdown with a sample unit = the variant's current price, so
  // the displayed "price each" matches what the cart will charge at
  // that quantity. Rows read as ascending ranges ("1–4", "5–9",
  // "10+"). Returns [] when no active sku-scoped tier set exists.
  // Drop-silent on a read failure so the PDP still renders.
  async function _resolveQtyBreaks(sku, unitMinor, currency, fmtPrice) {
    if (!deps.quantityDiscounts || unitMinor == null) return [];
    var fmt = typeof fmtPrice === "function" ? fmtPrice : pricing.format;
    var breakdown;
    try {
      breakdown = await deps.quantityDiscounts.tierBreakdown({
        scope:                   "sku",
        scope_id:                sku,
        sample_unit_price_minor: unitMinor,
      });
    } catch (_e) {
      return [];
    }
    var rows = breakdown.rows || [];
    if (rows.length === 0) return [];
    // Order by min_quantity ascending; build the implicit range each
    // tier covers (this tier's min up to the next tier's min minus 1,
    // open-ended on the last). The base price (below the first tier)
    // rides as the leading "1–(min-1)" row so the table shows the full
    // ladder including the undiscounted band.
    var sorted = rows.slice().sort(function (a, b2) { return a.min_quantity - b2.min_quantity; });
    var out = [];
    if (sorted[0].min_quantity > 1) {
      out.push({
        label:    "1–" + (sorted[0].min_quantity - 1),
        unit_str: fmt(unitMinor, currency),
      });
    }
    for (var i = 0; i < sorted.length; i += 1) {
      var t = sorted[i];
      var next = sorted[i + 1];
      var label = next ? (t.min_quantity + "–" + (next.min_quantity - 1)) : (t.min_quantity + "+");
      var unit = t.sample_discounted_unit_minor != null ? t.sample_discounted_unit_minor : unitMinor;
      out.push({ label: label, unit_str: fmt(unit, currency) });
    }
    return out;
  }

  // Reprice cart lines for display + totals by reapplying the active
  // quantity-break for each line's SKU at its current quantity. Returns
  // a shallow copy of each line with `unit_amount_minor` overwritten by
  // the discounted unit (the stored snapshot is never mutated — the
  // adjustment is recomputed every render, so it stays correct as the
  // quantity changes and as the operator edits tier schedules). When
  // the quantity-discount primitive isn't wired, the lines pass through
  // unchanged. Drop-silent per line so one unpriceable SKU can't break
  // the cart total.
  async function _repriceCartLines(lines) {
    if (!deps.quantityDiscounts) return lines;
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      var unit = l.unit_amount_minor;
      try {
        var variant = await deps.catalog.variants.get(l.variant_id);
        var applied = await deps.quantityDiscounts.applyToLine({
          line: {
            sku:              l.sku,
            quantity:         l.qty,
            unit_price_minor: l.unit_amount_minor,
            product_id:       variant ? variant.product_id : undefined,
          },
        });
        unit = applied.discounted_unit_minor;
      } catch (_e) {
        // Unpriceable line (no tier / bad shape) keeps its snapshot.
        unit = l.unit_amount_minor;
      }
      out.push(Object.assign({}, l, { unit_amount_minor: unit }));
    }
    return out;
  }

  // POST /currency — set (or clear) the visitor's display-currency choice.
  // Registered only when multi-currency display is wired. Display-only:
  // this NEVER touches the cart / order / payment currency — it sets the
  // sealed `shop_ccy` cookie that selects which currency price strings are
  // rendered in, then 303-redirects back so the new choice takes effect on
  // the next render. A choice outside the operator's allow-list clears the
  // cookie (→ base-currency display) rather than persisting a code the
  // switcher would never offer.
  if (_ccyEnabled) {
    router.post("/currency", function (req, res) {
      var body = req.body || {};
      var chosen = typeof body.currency === "string" ? body.currency.toUpperCase() : "";
      // `redirect_to` is constrained to a same-origin path (leading single
      // slash, no scheme / host / protocol-relative `//`) so the switcher
      // can't be turned into an open redirect.
      var rawTo = typeof body.redirect_to === "string" ? body.redirect_to : "/";
      var to = (/^\/(?!\/)/.test(rawTo)) ? rawTo : "/";
      if (chosen === _ccyBase || _ccyOptions.indexOf(chosen) === -1) {
        _clearCurrencyCookie(res);
      } else {
        _setCurrencyCookie(res, chosen);
      }
      res.status(303);
      res.setHeader && res.setHeader("location", to);
      return res.end ? res.end() : res.send("");
    });
  }

  router.get("/", async function (req, res) {
    var page = await deps.catalog.products.list({ status: "active", limit: 24 });
    // Best-effort "starting price" + "hero media" lookup. Each
    // product on the home grid carries its first variant's USD
    // price (when one exists) and its first attached media row
    // (when one exists). Both are best-effort — products without
    // a price render `—`; products without media render the
    // text-only PRODUCT_CARD fallback.
    var products = [];
    for (var i = 0; i < page.rows.length; i += 1) {
      var p = page.rows[i];
      var variants = await deps.catalog.variants.listForProduct(p.id);
      var startingPrice = null;
      if (variants.length) {
        var price = await deps.catalog.prices.current(variants[0].id, "USD");
        if (price) startingPrice = price;
      }
      var media = await deps.catalog.media.listForProduct(p.id);
      var heroMedia = media.length ? media[0] : null;
      products.push(Object.assign({}, p, {
        starting_price_minor:    startingPrice ? startingPrice.amount_minor : null,
        starting_price_currency: startingPrice ? startingPrice.currency      : "USD",
        hero_media:              heroMedia,
      }));
    }
    var ccy = await _currencyForReq(req);
    var html = renderHome(Object.assign({ products: products, shop_name: shopName, theme: theme }, _requestUrls(req), ccy));
    _send(res, 200, html);
  });

  // Decorate one product row with the display columns the search
  // cards need (first variant's price, first media) AND the facet
  // fields the searchFacets primitive computes against: `collection`
  // (array of collection slugs the product belongs to), `price_minor`
  // (the starting price), and `in_stock` (any variant with available
  // stock). Composes the wired catalog / collections primitives; a
  // collection facet only populates when `deps.collections` is present.
  async function _decorateForSearch(p) {
    var variants = await deps.catalog.variants.listForProduct(p.id);
    var startingPrice = null;
    var inStock = false;
    for (var vi = 0; vi < variants.length; vi += 1) {
      if (vi === 0) {
        var price = await deps.catalog.prices.current(variants[0].id, "USD");
        if (price) startingPrice = price;
      }
      var inv = await deps.catalog.inventory.get(variants[vi].sku);
      if (inv && (Number(inv.stock_on_hand) - Number(inv.stock_held)) > 0) inStock = true;
    }
    var media = await deps.catalog.media.listForProduct(p.id);
    var heroMedia = media.length ? media[0] : null;
    var collectionSlugs = [];
    if (deps.collections && typeof deps.collections.collectionsForProduct === "function") {
      var cols = await deps.collections.collectionsForProduct(p.id);
      for (var ci = 0; ci < cols.length; ci += 1) {
        if (cols[ci] && cols[ci].slug) collectionSlugs.push(cols[ci].slug);
      }
    }
    return Object.assign({}, p, {
      starting_price_minor:    startingPrice ? startingPrice.amount_minor : null,
      starting_price_currency: startingPrice ? startingPrice.currency      : "USD",
      hero_media:              heroMedia,
      collection:              collectionSlugs,
      price_minor:             startingPrice ? startingPrice.amount_minor : null,
      in_stock:                inStock,
    });
  }

  // Pull the facetable universe for a set of search terms: every
  // active product matching ANY term (canonical query + synonym
  // expansions) on title / description, decorated once. The
  // searchFacets primitive consumes this through a `catalog.list`
  // adapter and walks the rows in-memory for counts; the route reuses
  // the same rows for the narrowed result grid (one decoration pass,
  // no double round trip).
  async function _facetableUniverse(terms) {
    var byId = {};
    var rows = [];
    for (var ti = 0; ti < terms.length; ti += 1) {
      var term = typeof terms[ti] === "string" ? terms[ti].trim() : "";
      if (!term.length) continue;
      var page = await deps.catalog.products.search({ q: term, status: "active", limit: 100 });
      for (var i = 0; i < page.rows.length; i += 1) {
        var p = page.rows[i];
        if (byId[p.id]) continue;
        byId[p.id] = true;
        rows.push(await _decorateForSearch(p));
      }
    }
    return rows;
  }

  router.get("/search", async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var qRaw = url && url.searchParams.get("q");
    var q = typeof qRaw === "string" ? qRaw : "";
    // Cap at the validator's max length before handing to the
    // primitive — defends against a 10 MiB `?q=...` mass that would
    // otherwise round-trip through the LIKE escape function.
    if (q.length > 200) q = q.slice(0, 200);

    var products    = [];
    var facetGroups = [];
    var filters     = {};
    var correctedQ  = "";

    if (q.trim().length > 0) {
      // Synonym + typo rewrite expands the typed query into the
      // canonical term plus operator-curated expansions BEFORE the
      // product query runs. Without the dep, the raw query is the
      // only term.
      var terms = [];
      if (deps.searchSynonyms) {
        var rewrite = await deps.searchSynonyms.rewrite(q);
        correctedQ = rewrite.canonical;
        if (rewrite.canonical.length) terms.push(rewrite.canonical);
        for (var e = 0; e < rewrite.expansions.length; e += 1) terms.push(rewrite.expansions[e]);
      }
      if (!terms.length) terms.push(q.trim());

      if (deps.searchFacets) {
        // The universe is decorated once; the searchFacets catalog
        // adapter and the narrowed result grid share it. The facet
        // instance is created per-request bound to this request's
        // universe so concurrent searches never share a catalog
        // snapshot. `deps.searchFacets(catalog)` is the factory wired
        // in server.js (the searchFacets primitive's `create`, with
        // the DB query handle pre-bound).
        var universe = await _facetableUniverse(terms);
        var facetCatalog = {
          // The primitive narrows in-memory and drops the focal facet
          // per option, so the adapter ignores applied_filters and
          // returns the full matched universe every call.
          list: function () { return Promise.resolve({ rows: universe }); },
        };
        var sfInstance = deps.searchFacets(facetCatalog);
        var facetDefs = await sfInstance.listFacets({});
        filters = _parseSearchFilters(url, facetDefs);
        facetGroups = await sfInstance.getFacets({ query: q, applied_filters: filters });
        var preview = await sfInstance.previewQuery({ query: q, filters: filters, sample: 24 });
        products = preview.sample;
      } else {
        // No facet dep — flat search over the expanded terms.
        products = (await _facetableUniverse(terms)).slice(0, 24);
      }
    }

    var cartCount = await _cartCountForReq(req);
    var ccy = await _currencyForReq(req);
    _send(res, 200, renderSearch(Object.assign({
      q:               q,
      products:        products,
      facets:          facetGroups,
      filters:         filters,
      corrected_query: correctedQ,
      shop_name:       shopName,
      cart_count:      cartCount,
    }, _requestUrls(req), ccy)));
  });

  router.get("/products/:slug", async function (req, res) {
    var slug = req.params && req.params.slug;
    if (!slug) return _send(res, 400, renderNotFound({ shop_name: shopName, theme: theme }));
    var product = await deps.catalog.products.bySlug(slug);
    if (!product) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
    var variants = await deps.catalog.variants.listForProduct(product.id);
    var prices = {};
    // Per-SKU inventory map driving the truthful availability badge +
    // JSON-LD. Best-effort: a SKU with no inventory row (or a read
    // failure) is omitted from the map, which the renderer treats as
    // available — the never-block-on-missing-inventory stance the
    // cart-hold path already takes. Only populated when the operator has
    // wired the inventory primitive.
    var inventory = {};
    for (var i = 0; i < variants.length; i += 1) {
      var p = await deps.catalog.prices.current(variants[i].id, "USD");
      if (p) prices[variants[i].id] = p;
      if (deps.catalog.inventory && typeof deps.catalog.inventory.get === "function") {
        try {
          var invRow = await deps.catalog.inventory.get(variants[i].sku);
          if (invRow) inventory[variants[i].sku] = invRow;
        } catch (_e) { /* drop-silent — missing inventory reads as available */ }
      }
    }
    // Media — first row drives the hero image, the next three feed
    // the thumbnail strip. `listForProduct` is product-level only;
    // variant-level media (`listForVariant`) would feed a swap-on-
    // variant-select interaction we don't ship yet.
    var media = await deps.catalog.media.listForProduct(product.id);
    // Render cart count from the current session's cart, if any.
    var cartCount = await _cartCountForReq(req);
    // Published reviews aggregate + list. A failed read (e.g. the
    // reviews table not yet migrated) degrades to the empty state
    // rather than 500-ing the whole PDP — reviews are supplementary
    // to the buy path. Mirrors the edge renderer's missing-table
    // resilience.
    var reviewSummary, reviewRows, reviewCta;
    if (deps.reviews) {
      try {
        reviewSummary = await deps.reviews.summaryForProduct(product.id);
        reviewRows    = (await deps.reviews.listForProduct(product.id, { limit: 10 })).rows;
      } catch (_e) { reviewSummary = undefined; reviewRows = []; }
      // The form route enforces auth + the verified-purchase gate, so
      // the CTA links there unconditionally; logged-out shoppers get
      // redirected to login, non-purchasers get a clear "not eligible".
      reviewCta = "<a class=\"btn-secondary reviews__cta\" href=\"/products/" +
        b.template.escapeHtml(product.slug) + "/review\">Write a review</a>";
    }
    // Wishlist social-proof count — degrades to 0 on a read failure
    // (e.g. table not yet migrated) rather than 500-ing the PDP.
    var wishlistCount = 0;
    if (deps.wishlist) {
      try { wishlistCount = await deps.wishlist.countForProduct(product.id); }
      catch (_e) { wishlistCount = 0; }
    }
    // Published Q&A — approved questions + their approved answers. A
    // failed read (e.g. the product_qa tables not yet migrated) degrades
    // to the empty state rather than 500-ing the PDP — Q&A is
    // supplementary to the buy path, like reviews. Mirrors the edge
    // renderer's missing-table resilience.
    var qaQuestions, qaCta;
    if (deps.productQa) {
      qaQuestions = [];
      try {
        var qList = (await deps.productQa.questionsForProduct({ product_id: product.id, limit: 20 })).rows;
        for (var qi = 0; qi < qList.length; qi += 1) {
          var qrow = qList[qi];
          qrow.answers = await deps.productQa.answersForQuestion(qrow.id, { limit: 20 });
          qaQuestions.push(qrow);
        }
      } catch (_e) { qaQuestions = []; }
      // The form route enforces auth, so the CTA links there
      // unconditionally; logged-out shoppers get redirected to login.
      qaCta = "<a class=\"btn-secondary reviews__cta\" href=\"/products/" +
        b.template.escapeHtml(product.slug) + "/question\">Ask a question</a>";
    }
    // Log the view for a signed-in customer so it surfaces on their
    // "Recently viewed" account page. Drop-silent — a recording failure
    // (table not migrated, write contention) must never break the PDP
    // render. Guests aren't recorded here: their PDP is edge-cached with
    // no per-request container hop, so session-scoped guest history is a
    // separate opt-in (a client beacon) the storefront doesn't ship yet.
    if (deps.recentlyViewed && deps.customers) {
      var rvEnv = _currentCustomerEnv(req);
      if (rvEnv) {
        try { await deps.recentlyViewed.recordView({ customer_id: rvEnv.customer_id, product_id: product.id }); }
        catch (_e) { /* drop-silent — recently-viewed is supplementary to the buy path */ }
      }
    }
    // Bundle offers + quantity-break table. Both compose the
    // server-authoritative pricing primitives (the customer never sends
    // a price); both degrade to empty on a missing-table / read failure
    // so the buy path renders regardless. The quantity-break table is
    // built against the first variant's list price — the band a shopper
    // sees on the PDP matches what the cart charges at that quantity.
    var ccy = await _currencyForReq(req);
    var ccyFmt = ccy.format_price || null;
    var variantSkus = variants.map(function (v) { return v.sku; });
    var bundleOffers = await _resolveBundleOffers(variantSkus, "USD", ccyFmt);
    var firstVariant = variants[0] || null;
    var firstPrice = firstVariant ? prices[firstVariant.id] : null;
    var qtyBreaks = firstVariant && firstPrice
      ? await _resolveQtyBreaks(firstVariant.sku, firstPrice.amount_minor, firstPrice.currency, ccyFmt)
      : [];
    var html = renderProduct(Object.assign({
      product:        product,
      variants:       variants,
      prices:         prices,
      media:          media,
      inventory:      inventory,
      review_summary: reviewSummary,
      reviews:        reviewRows,
      review_cta:     reviewCta,
      qa_questions:   qaQuestions,
      qa_cta:         qaCta,
      bundle_offers:  bundleOffers,
      qty_breaks:     qtyBreaks,
      wishlist_count: wishlistCount,
      shop_name:      shopName,
      cart_count:     cartCount,
      theme:          theme,
    }, _requestUrls(req), ccy));
    _send(res, 200, html);
  });

  // Product compare — the guest-or-customer side-by-side basket. Mounts
  // when the productCompare primitive is wired. The basket is keyed on
  // the same `shop_sid` session cookie the cart uses (a routing key that
  // grants zero authority — the primitive namespace-hashes it before it
  // touches the database), so a shopper compares without authenticating;
  // a logged-in shopper's customer_id rides alongside so the operator's
  // account widget could resume the basket on another device. All three
  // routes (toggle / clear / view) are writes-or-session-reads, so they
  // live in the container — the edge forwards them (and any request
  // carrying shop_sid skips the edge cache, so the view always reflects
  // the live basket).
  if (deps.productCompare) {
    // Resolve the compare basket's session id. Reads the cart session
    // cookie; when `mint` is true and none exists, allocates one + sets
    // the cookie so the basket has a stable key across requests. A
    // read-only path (the view) passes mint=false and returns null when
    // there's no session — that renders the empty state without minting
    // a cookie on a bare GET.
    function _compareSid(req, res, mint) {
      var sid = _readSidCookie(req);
      if (sid) return sid;
      if (!mint) return null;
      sid = b.uuid.v7();
      _setSidCookie(res, sid);
      return sid;
    }

    function _compareRedirect(res, dest, notice) {
      var sep = dest.indexOf("?") === -1 ? "?" : "&";
      var to = notice ? (dest + sep + "notice=" + encodeURIComponent(notice)) : dest;
      res.status(303);
      res.setHeader && res.setHeader("location", to);
      return res.end ? res.end() : res.send("");
    }

    // POST /compare/toggle — add the product if it isn't in the basket,
    // remove it if it is. Idempotent (the primitive collapses a repeat
    // add / a remove of an absent id). Redirects to `return_to` when it's
    // a safe same-origin path (the compare page's per-column Remove uses
    // it), otherwise back to the product PDP (the canonical slug is
    // resolved from product_id, so a forged slug can't drive an open
    // redirect). No auth required — guests compare too.
    router.post("/compare/toggle", async function (req, res) {
      var productId = (req.body || {}).product_id;
      var sid = _compareSid(req, res, true);
      var custEnv = _currentCustomerEnv(req);
      var customerId = custEnv ? custEnv.customer_id : null;

      // Resolve the safe redirect destination up front so a validation
      // failure still lands the shopper somewhere sane.
      var rt = (req.body || {}).return_to;
      var dest = null;
      if (typeof rt === "string" && /^\/[^/]/.test(rt)) dest = rt;

      var notice;
      try {
        var list = await deps.productCompare.getCompareList({ session_id: sid });
        var inBasket = list.product_ids.indexOf(productId) !== -1;
        if (inBasket) {
          await deps.productCompare.removeFromCompare({ session_id: sid, product_id: productId });
          notice = "removed";
        } else {
          await deps.productCompare.addToCompare({ session_id: sid, product_id: productId, customer_id: customerId });
          notice = "added";
          // Best-effort impression telemetry — drop-silent, never block
          // the toggle on the merchandising ledger write.
          try {
            await deps.productCompare.recordImpression({ session_id: sid, product_id: productId, source_kind: "product_page" });
          } catch (_e) { /* drop-silent — impression telemetry is supplementary */ }
        }
      } catch (e) {
        if (e && e.code === "COMPARE_FULL") {
          // Cap reached — refuse the add with a notice rather than a
          // crash. The basket is unchanged; the shopper removes one to
          // make room.
          if (!dest) {
            var capProduct = null;
            try { capProduct = await deps.catalog.products.get(productId); } catch (_e2) { capProduct = null; }
            dest = capProduct ? ("/products/" + encodeURIComponent(capProduct.slug)) : "/compare";
          }
          return _compareRedirect(res, dest, "full");
        }
        // A malformed product id (or session id) is a client error.
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
      }

      if (!dest) {
        var product = null;
        try { product = await deps.catalog.products.get(productId); } catch (_e) { product = null; }
        dest = product ? ("/products/" + encodeURIComponent(product.slug)) : "/compare";
      }
      return _compareRedirect(res, dest, notice);
    });

    // POST /compare/clear — drop the whole basket. Idempotent (clearing
    // an empty basket is a no-op). Always redirects back to the compare
    // page so the shopper sees the emptied state.
    router.post("/compare/clear", async function (req, res) {
      var sid = _compareSid(req, res, false);
      if (sid) {
        try { await deps.productCompare.clearCompareList({ session_id: sid }); }
        catch (e) {
          if (!(e instanceof TypeError)) {
            res.status(500);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          // A malformed session cookie can't address a basket — treat
          // the clear as a no-op rather than a 400 (the cookie grants
          // zero authority; a stale/garbage value just means "no basket").
        }
      }
      return _compareRedirect(res, "/compare", "cleared");
    });

    // GET /compare — the side-by-side comparison table for the session's
    // basket. Empty basket → the friendly empty state. Each product id is
    // resolved through the catalog; a product archived / deleted between
    // the add and this render resolves out gracefully (the column renders
    // "no longer available" with a remove control). The attribute matrix
    // comes from the primitive's compareTable, fed a getProduct adapter
    // enriched with the product's first variant + current price so the
    // baked-in price/sku/weight attributes resolve against this catalog's
    // schema.
    router.get("/compare", async function (req, res) {
      var sid = _compareSid(req, res, false);
      var cartCount = await _cartCountForReq(req);
      // Read the post-toggle notice key from the query string the same
      // way the search route reads `?q=` — via the parsed URL, not
      // `req.query` (which the router only populates when a route
      // declares a query validator). renderCompare gates the key
      // against a fixed allowlist, so a forged value renders nothing.
      var compareUrl = req.url ? new URL(req.url, "http://localhost") : null;
      var noticeKey = compareUrl ? compareUrl.searchParams.get("notice") : null;

      if (!sid) {
        return _send(res, 200, renderCompare({
          columns: [], rows: [], shop_name: shopName, cart_count: cartCount,
          asset_prefix: _cardAssetPrefix, notice: noticeKey,
        }));
      }

      // Per-request product cache so the header-column decoration and the
      // attribute-matrix adapter don't double-fetch the same product.
      var enrichedCache = Object.create(null);
      async function _enrich(pid) {
        if (Object.prototype.hasOwnProperty.call(enrichedCache, pid)) return enrichedCache[pid];
        var result = { product: null, variant: null, price: null, hero_media: null, available: false };
        var product = null;
        // get() throws a TypeError on a malformed id; a basket can only
        // hold strict-UUID ids (the primitive sanitises on add), but stay
        // defensive — a bad id resolves to the gone-state column.
        try { product = await deps.catalog.products.get(pid); } catch (_e) { product = null; }
        if (product && product.status === "active") {
          result.product = product;
          var variants = await deps.catalog.variants.listForProduct(pid);
          if (variants.length) {
            result.variant = variants[0];
            var pr = await deps.catalog.prices.current(variants[0].id, "USD");
            if (pr) result.price = pricing.format(pr.amount_minor, pr.currency);
            // Availability — best-effort inventory read on the first
            // variant. A product with no inventory row reads as available
            // (operators who don't track stock still sell), an explicit
            // zero-on-hand reads as out of stock.
            try {
              var inv = await deps.catalog.inventory.get(variants[0].sku);
              result.available = !inv || (Number(inv.stock_on_hand) - Number(inv.stock_held)) > 0;
            } catch (_e) { result.available = true; }
          } else {
            result.available = false;
          }
          var media = await deps.catalog.media.listForProduct(pid);
          result.hero_media = media.length ? media[0] : null;
        }
        enrichedCache[pid] = result;
        return result;
      }

      var list = await deps.productCompare.getCompareList({ session_id: sid });
      var columns = [];
      for (var i = 0; i < list.product_ids.length; i += 1) {
        var pid = list.product_ids[i];
        var e = await _enrich(pid);
        columns.push({
          product_id: pid,
          product:    e.product,
          hero_media: e.hero_media,
          price:      e.price,
          available:  e.available,
        });
      }

      // Attribute matrix from the primitive. compareTable walks the
      // basket's product ids through the `catalog` adapter wired into the
      // primitive at create time (server.js) — that adapter enriches each
      // product with a `variants` array (price as `price_minor`, `weight`
      // from `weight_grams`) so the baked-in variant-sourced attributes
      // resolve against this catalog's column shape. compareTable refuses
      // (throws) when no catalog adapter was wired; a resolution failure
      // degrades to no attribute rows — the fixed Price/Availability rows
      // still render the side-by-side view.
      var attrRows = [];
      try {
        var table = await deps.productCompare.compareTable({ session_id: sid });
        attrRows = table.rows || [];
      } catch (_e) { attrRows = []; }

      _send(res, 200, renderCompare({
        columns:      columns,
        rows:         attrRows,
        shop_name:    shopName,
        cart_count:   cartCount,
        asset_prefix: _cardAssetPrefix,
        notice:       noticeKey,
      }));
    });
  }

  // Collections — operator-curated + smart product lists. Public browse
  // pages; mounted when the collections primitive is wired.
  if (deps.collections) {
    router.get("/collections", async function (req, res) {
      var cols = await deps.collections.list({ active_only: true });
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCollectionList({
        collections: cols, shop_name: shopName, cart_count: cartCount, asset_prefix: _cardAssetPrefix,
      }));
    });

    router.get("/collections/:slug", async function (req, res) {
      var slug = req.params && req.params.slug;
      // get() and productsIn() both throw on a malformed slug (the
      // primitive validates shape). A bad path segment is a 404, not a
      // 500 — the route is a defensive request-shape reader.
      var col, result;
      try {
        col = slug ? await deps.collections.get(slug) : null;
        if (!col || col.archived_at != null) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        result = await deps.collections.productsIn({ slug: slug, limit: 24 });
      } catch (e) {
        if (e instanceof TypeError) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        throw e;
      }
      var products = [];
      for (var i = 0; i < result.rows.length; i += 1) {
        var pid = result.rows[i].product_id || result.rows[i].id;
        var card = await _decorateProductCard(pid);
        if (card) products.push(card);
      }
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCollection({
        collection: col, products: products, shop_name: shopName, cart_count: cartCount,
      }));
    });
  }

  // Category navigation — the hierarchical category tree surfaced as
  // public browse pages. The index lists the top-level categories; each
  // category page renders its breadcrumb chain + direct child sub-
  // categories. Mounted when the categoryNavigation primitive is wired.
  if (deps.categoryNavigation) {
    router.get("/categories", async function (req, res) {
      // Top-level categories only (parent_slug omitted). The lib drops
      // archived rows from every read, so the index is fresh against the
      // active tree.
      var cats = await deps.categoryNavigation.categoriesByParent({});
      var active = [];
      for (var i = 0; i < cats.length; i += 1) {
        if (cats[i].active) active.push(cats[i]);
      }
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCategoryIndex(Object.assign({
        categories: active, shop_name: shopName, cart_count: cartCount, asset_prefix: _cardAssetPrefix,
      }, _requestUrls(req))));
    });

    router.get("/categories/:slug", async function (req, res) {
      var slug = req.params && req.params.slug;
      // getCategory() / breadcrumbsFor() / categoriesByParent() throw a
      // TypeError on a malformed slug shape (the primitive validates the
      // slug regex). A bad path segment, an unknown slug, or an archived
      // category is a 404, not a 500 — this is a defensive request-shape
      // reader.
      var cat, crumbs, children;
      try {
        cat = slug ? await deps.categoryNavigation.getCategory(slug) : null;
        if (!cat || !cat.active) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        crumbs = await deps.categoryNavigation.breadcrumbsFor({ slug: slug });
        children = await deps.categoryNavigation.categoriesByParent({ parent_slug: slug });
      } catch (e) {
        if (e instanceof TypeError) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        // A CATEGORY_NOT_FOUND from breadcrumbsFor / categoriesByParent
        // (e.g. the row was archived between reads) is also a 404.
        if (e && e.code === "CATEGORY_NOT_FOUND") return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        throw e;
      }
      // Only surface active sub-categories (the lib already drops archived
      // rows; this also hides operator-unpublished ones).
      var activeChildren = [];
      for (var i = 0; i < children.length; i += 1) {
        if (children[i].active) activeChildren.push(children[i]);
      }
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCategory(Object.assign({
        category: cat, breadcrumbs: crumbs, children: activeChildren,
        shop_name: shopName, cart_count: cartCount, asset_prefix: _cardAssetPrefix,
      }, _requestUrls(req))));
    });
  }

  // Nav cart-badge count for the cart-count island. Every storefront
  // chrome page server-renders the badge (0 on the cookie-less edge-cached
  // render); the island fetches this on load and corrects the number for a
  // visitor whose sealed `shop_sid` the edge can't read. JSON only — one
  // session lookup, no product hydration — and never cached (a per-session
  // value must not land in a shared cache).
  router.get("/cart/count", async function (req, res) {
    var count = await _cartCountForReq(req);
    res.status(200);
    res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "no-store");
    var payload = JSON.stringify({ count: count });
    return res.end ? res.end(payload) : res.send(payload);
  });

  router.get("/cart", async function (req, res) {
    var ccy = await _currencyForReq(req);
    var sid = _readSidCookie(req);
    // `?added=1` after a POST /cart/lines redirect — drives the
    // "Added to cart" status banner. Read from the parsed query when the
    // router populated it, else from the raw URL.
    var cartUrl = req.url ? new URL(req.url, "http://localhost") : null;
    var added = (req.query && req.query.added === "1") ||
      (cartUrl && cartUrl.searchParams.get("added") === "1") || false;
    if (!sid) {
      return _send(res, 200, renderCart(Object.assign({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName, theme: theme,
      }, ccy)));
    }
    var c = await deps.cart.bySession(sid);
    if (!c) {
      return _send(res, 200, renderCart(Object.assign({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName, theme: theme,
      }, ccy)));
    }
    var rawLines = await deps.cart.listLines(c.id);
    // Reapply the active quantity-break for each line at its current
    // quantity before totals — the unit price the customer sees on the
    // line, the line total, and the cart subtotal all reflect the break.
    // Recomputed every render (idempotent); the stored snapshot is never
    // mutated, so changing a line's quantity re-prices it automatically.
    var lines = await _repriceCartLines(rawLines);
    var totals = pricing.totals(c, lines, {});
    // Build the variant_id → { product, hero_media } lookup the
    // renderer uses to decorate each line with a thumbnail + title.
    // Cache by variant_id so a cart with the same variant twice
    // only hits the catalog once.
    var productLookup = {};
    for (var i = 0; i < lines.length; i += 1) {
      var vId = lines[i].variant_id;
      if (productLookup[vId]) continue;
      var v = await deps.catalog.variants.get(vId);
      if (!v) { productLookup[vId] = null; continue; }
      var prod = await deps.catalog.products.get(v.product_id);
      var media = await deps.catalog.media.listForProduct(v.product_id);
      productLookup[vId] = {
        product:    prod,
        hero_media: media.length ? media[0] : null,
      };
    }
    _send(res, 200, renderCart(Object.assign({
      lines:           lines,
      totals:          totals,
      product_lookup:  productLookup,
      can_save:        !!(deps.saveForLater && deps.customers),
      checkout_available: !!(deps.checkout && deps.order),
      added:           added,
      shop_name:       shopName,
      theme:           theme,
    }, ccy)));
  });

  // ---- checkout flow -------------------------------------------------
  //
  // GET  /checkout         — renders the shipping form
  // POST /checkout         — calls checkout.confirm; redirects to /pay/:order_id
  // GET  /pay/:order_id    — Stripe Elements payment page
  // GET  /orders/:order_id — order confirmation (post-purchase landing)
  //
  // The checkout / payment / order deps are optional in mount(); the
  // routes only register when supplied. This lets the framework boot
  // in pure-storefront mode (catalog + cart only) for stores that
  // are still configuring payment.
  //
  // When checkout ISN'T wired (no payment provider configured), mount a
  // graceful placeholder at /checkout so the cart link or a direct hit
  // renders a clear "not set up yet" page instead of a 404. The cart CTA
  // is already gated to a disabled notice (renderCart checkout_available),
  // but a direct navigation still needs a real response. GET + POST both
  // land here (a stale form POST shouldn't 404 either).
  if (!(deps.checkout && deps.order)) {
    var _checkoutUnavailable = function (req, res) {
      var body =
        "<section class=\"cart-page cart-page--empty\"><div class=\"cart-empty\"><div class=\"cart-empty__card\">" +
          "<p class=\"eyebrow cart-empty__eyebrow\">Checkout</p>" +
          "<h1 class=\"cart-empty__title\">Checkout isn't available yet</h1>" +
          "<p class=\"cart-empty__lede\">Online payments aren't set up for this store yet, so orders can't be completed right now. Your cart is saved — please check back soon.</p>" +
          "<div class=\"cart-empty__cta\"><a class=\"btn-primary\" href=\"/cart\">Back to cart</a> <a class=\"btn-ghost\" href=\"/\">Keep browsing</a></div>" +
        "</div></div></section>";
      // 503: the capability is unconfigured, not the request's fault — keeps
      // the page out of search indexes + signals "temporarily unavailable".
      _send(res, 503, _wrap({ title: "Checkout", shop_name: shopName, theme: theme, cart_count: 0, body: body }));
    };
    router.get("/checkout", _checkoutUnavailable);
    router.post("/checkout", _checkoutUnavailable);
  }

  if (deps.checkout && deps.order) {
    // Build the renderCheckoutForm() opts for an active cart `c`: repriced
    // lines, totals, the thumbnail lookup, and the signed-in customer's
    // loyalty balance + prefill. Shared by the GET handler and the POST
    // catch (so a rejected gift-card / loyalty code re-renders the same
    // form inline instead of dead-ending). `inlineError` is the optional
    // message to surface at the top of the form.
    async function _checkoutRenderOpts(req, c, lines, inlineError) {
      var totals = pricing.totals(c, lines, {});
      // variant_id → { product, hero_media } lookup for the summary
      // thumbnails + titles — same shape (and caching) the cart route uses.
      var checkoutLookup = {};
      for (var li = 0; li < lines.length; li += 1) {
        var lvId = lines[li].variant_id;
        if (checkoutLookup[lvId]) continue;
        var lv = await deps.catalog.variants.get(lvId);
        if (!lv) { checkoutLookup[lvId] = null; continue; }
        var lprod = await deps.catalog.products.get(lv.product_id);
        var lmedia = await deps.catalog.media.listForProduct(lv.product_id);
        checkoutLookup[lvId] = { product: lprod, hero_media: lmedia.length ? lmedia[0] : null };
      }
      // A signed-in customer drives two best-effort lookups, both keyed
      // off the same auth env: the loyalty balance (for the redeem field)
      // and the default shipping address (to pre-fill the form). Either
      // read failing (table not migrated, no saved address) degrades to
      // the un-prefilled / no-redeem checkout rather than 500-ing it.
      var coAuth = _currentCustomerEnv(req);
      var loyaltyBalance = null;
      if (deps.loyalty && coAuth) {
        try { loyaltyBalance = await deps.loyalty.balance(coAuth.customer_id); }
        catch (_e) { loyaltyBalance = null; }
      }
      var prefill = null;
      if (deps.addresses && coAuth) {
        try {
          var addrRows = await deps.addresses.listForCustomer(coAuth.customer_id, { limit: 50 });
          var pick = null;
          for (var ai = 0; ai < addrRows.length; ai += 1) {
            if (Number(addrRows[ai].is_default_shipping) === 1) { pick = addrRows[ai]; break; }
          }
          if (!pick && addrRows.length) pick = addrRows[0];
          if (pick) {
            prefill = {
              name:    pick.recipient_name,
              line1:   pick.street_line1,
              line2:   pick.street_line2,
              city:    pick.city,
              postal:  pick.postal_code,
              country: pick.country,
              // The saved `region` is free-text ("California"); checkout's
              // `state` is a short subdivision code. Carry it over only when
              // it already matches the code shape so we never pre-seed a
              // value the field's own pattern would reject.
              state:   (pick.region && /^[A-Za-z0-9]{1,5}$/.test(pick.region)) ? pick.region : undefined,
            };
          }
        } catch (_e) { prefill = null; }
      }
      return {
        lines: lines, totals: totals, shop_name: shopName, theme: theme,
        product_lookup: checkoutLookup,
        paypal_client_id: deps.paypal ? deps.paypal_client_id : null,
        loyalty_balance: loyaltyBalance,
        loyalty_points_per_usd: deps.loyalty ? deps.loyalty.REDEMPTION_POINTS_PER_USD : null,
        prefill: prefill,
        inline_error: inlineError || null,
      };
    }

    router.get("/checkout", async function (req, res) {
      var sid = _readSidCookie(req);
      if (!sid) return _send(res, 303, "<a href=\"/cart\">Cart is empty</a>"), res.setHeader && res.setHeader("location", "/cart");
      var c = await deps.cart.bySession(sid);
      if (!c) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var rawLines = await deps.cart.listLines(c.id);
      if (!rawLines.length) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      // Reprice the lines through the active quantity-break (same as the
      // cart page) so the summary's per-line totals + subtotal match what
      // the shopper saw on /cart.
      var lines = await _repriceCartLines(rawLines);
      _send(res, 200, renderCheckoutForm(await _checkoutRenderOpts(req, c, lines, null)));
    });

    router.post("/checkout", async function (req, res) {
      var body = req.body || {};
      var sid = _readSidCookie(req);
      if (!sid) {
        return _send(res, 400, renderCheckoutError({
          shop_name: shopName, theme: theme, eyebrow: "Checkout",
          title_text: "Your session expired",
          reason: "We couldn't find an active cart session. Open your cart and continue from there.",
        }));
      }
      var c = await deps.cart.bySession(sid);
      if (!c) {
        return _send(res, 400, renderCheckoutError({
          shop_name: shopName, theme: theme, eyebrow: "Checkout",
          title_text: "Your cart couldn't be found",
          reason: "We couldn't find an active cart for this session. Open your cart and continue from there.",
        }));
      }
      // Defensive cart-state guard — if the cart has already been
      // converted (e.g. duplicate-submit on POST refresh), redirect
      // to the most recent order for this session.
      if (c.status !== "active") {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var shipTo = _shipToFromBody(body);
      try {
        // default_shipping_id may be a literal string or an
        // operator-supplied async resolver (e.g. backed by the
        // config primitive) so re-reads happen per request without
        // a container restart.
        var defaultShipId;
        if (typeof deps.default_shipping_id === "function") {
          defaultShipId = await deps.default_shipping_id();
        } else {
          defaultShipId = deps.default_shipping_id;
        }
        var result = await deps.checkout.confirm({
          cart_id:              c.id,
          ship_to:              shipTo,
          selected_shipping_id: defaultShipId || "std",
          customer:             { email: body.email, name: body.name },
          gift_card_code:       body.gift_card_code || undefined,
          loyalty_redeem_points: _parseRedeemPoints(body.loyalty_redeem_points),
          idempotency_key:      "checkout:" + c.id + ":" + b.uuid.v7(),
        });
        // When a gift card fully covered the order there's no Stripe
        // intent — the order is already paid. Skip the pay-cookie +
        // pay page and land the customer straight on the confirmation.
        if (!result.payment_intent) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/orders/" + result.order.id);
          return res.end ? res.end() : res.send("");
        }
        // Set a short-lived pay cookie so /pay/:order_id can serve the
        // client_secret without re-running confirm. Scoped to /pay/ +
        // SameSite=Strict so it's only ever sent to the pay route.
        _cookieJar().write(res, PAY_COOKIE_NAME, result.payment_intent.client_secret, {
          expires: new Date(Date.now() + b.constants.TIME.minutes(15)), path: "/pay/", sameSite: "Strict",
        });
        res.status(303);
        res.setHeader && res.setHeader("location", "/pay/" + result.order.id);
        return res.end ? res.end() : res.send("");
      } catch (e) {
        // A bad customer input (malformed shape, a gift-card code, or a
        // loyalty-points request the customer entered that can't be
        // applied) is a 400, not a 500 — the gift-card errors carry a
        // GIFTCARD_* code and the loyalty errors a LOYALTY_* code so a
        // fat-fingered value re-prompts rather than 500-ing checkout.
        var code = (e && typeof e.code === "string") ? e.code : "";
        var msg = (e && e.message) || "checkout failed";
        // A coded gift-card / loyalty error is something the shopper can
        // fix in place — re-render the checkout form with the message
        // inline (preserving the cart + their prefilled fields where
        // possible) rather than dead-ending on a separate page.
        if (code.indexOf("GIFTCARD_") === 0 || code.indexOf("LOYALTY_") === 0) {
          try {
            var coLines = await _repriceCartLines(await deps.cart.listLines(c.id));
            if (coLines.length) {
              return _send(res, 400, renderCheckoutForm(await _checkoutRenderOpts(req, c, coLines, msg)));
            }
          } catch (_re) { /* fall through to the styled error page */ }
        }
        // A malformed address shape (TypeError) is still the shopper's to
        // fix; anything else is a server-side failure. Either way, render a
        // styled, recoverable page rather than raw text — back to the cart,
        // or back to the shipping form to re-enter the address.
        var clientErr = (e instanceof TypeError);
        return _send(res, clientErr ? 400 : 500, renderCheckoutError({
          shop_name: shopName, theme: theme, eyebrow: "Checkout",
          title_text: clientErr ? "We couldn't process your shipping details" : "Checkout didn't go through",
          reason: clientErr
            ? "Some shipping details couldn't be read: " + msg + " Go back and check the address fields."
            : "Something went wrong completing your order. Your cart is saved — please try again. (" + msg + ")",
          back_href: "/checkout", back_label: "Edit shipping",
          secondary_href: "/cart", secondary_label: "Back to cart",
        }));
      }
    });

    // PayPal express checkout (Orders v2). Mounts when the PayPal adapter is
    // wired. The pay-page PayPal button drives two AJAX calls: `create` opens
    // a PayPal order for the current cart (returns its id for the SDK to
    // approve in the popup); `capture` finalizes after approval and advances
    // the local order to paid. Both read the session cart; the button posts
    // the same ship_to fields the card form collects.
    if (deps.paypal) {
      router.post("/checkout/paypal/create", async function (req, res) {
        function _json(status, obj) {
          res.status(status);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var s = JSON.stringify(obj);
          return res.end ? res.end(s) : res.send(s);
        }
        var body = req.body || {};
        var sid = _readSidCookie(req);
        if (!sid) return _json(400, { error: "no-session" });
        var c = await deps.cart.bySession(sid);
        if (!c || c.status !== "active") return _json(409, { error: "no-active-cart" });
        var shipTo = _shipToFromBody(body);
        try {
          var defaultShipId = typeof deps.default_shipping_id === "function"
            ? await deps.default_shipping_id() : deps.default_shipping_id;
          var created = await deps.checkout.createPaypalOrder({
            cart_id:              c.id,
            ship_to:              shipTo,
            selected_shipping_id: body.selected_shipping_id || defaultShipId || "std",
            customer:             { email: body.email, name: body.name },
            gift_card_code:       body.gift_card_code || undefined,
            idempotency_key:      "paypal:" + c.id + ":" + b.uuid.v7(),
            return_url:           body.return_url || undefined,
            cancel_url:           body.cancel_url || undefined,
          });
          // Gift card fully covered the order — no PayPal order id to
          // approve. Tell the button to redirect straight to the
          // confirmation page instead of opening the PayPal popup.
          if (!created.paypal_order_id) {
            return _json(200, { paid_by_gift_card: true, order_id: created.order.id, redirect: "/orders/" + created.order.id });
          }
          // The PayPal JS SDK's createOrder expects `{ id }`.
          return _json(200, { id: created.paypal_order_id, order_id: created.order.id });
        } catch (e) {
          var gcErr = e && typeof e.code === "string" && e.code.indexOf("GIFTCARD_") === 0;
          return _json((e instanceof TypeError || gcErr) ? 400 : 502, { error: (e && e.message) || "paypal-create-failed" });
        }
      });

      router.post("/checkout/paypal/capture", async function (req, res) {
        function _json(status, obj) {
          res.status(status);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var s = JSON.stringify(obj);
          return res.end ? res.end(s) : res.send(s);
        }
        var body = req.body || {};
        var paypalOrderId = body.paypal_order_id || body.orderID || body.orderId;
        if (typeof paypalOrderId !== "string" || !paypalOrderId.length) return _json(400, { error: "paypal_order_id required" });
        try {
          var result = await deps.checkout.capturePaypalOrder(paypalOrderId);
          if (!result.order) return _json(404, { error: "order-not-found" });
          // Only redirect to the order page when the capture actually
          // completed (or the order is already paid). A non-completing capture
          // leaves the order pending — surface it as an error so the client
          // doesn't show success for an unpaid order.
          if (!result.handled && result.order.status !== "paid") {
            return _json(502, { error: "capture-incomplete", status: result.order.status });
          }
          return _json(200, { order_id: result.order.id, status: result.order.status, redirect: "/orders/" + result.order.id });
        } catch (e) {
          return _json(502, { error: (e && e.message) || "paypal-capture-failed" });
        }
      });
    }

    router.get("/pay/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      // Read the client_secret from the shop_pay cookie set on POST
      // /checkout. The cookie is scoped Path=/pay/ + SameSite=Strict
      // so it's only sent to the pay route and never cross-origin.
      var clientSecret = _readCookie(req, PAY_COOKIE_NAME);
      if (!clientSecret) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var pk = deps.stripe_publishable_key || "";
      if (!pk) {
        res.status(503);
        return res.end ? res.end("Stripe publishable key not configured") : res.send("Stripe publishable key not configured");
      }
      _send(res, 200, renderPayPage({
        order:           o,
        client_secret:   clientSecret,
        publishable_key: pk,
        shop_name:       shopName,
        theme:           theme,
      }));
    });

    router.get("/orders/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      // Ownership gate against IDOR: an order's confirmation page exposes
      // the customer's name, address, and line items by UUID alone. An order
      // that BELONGS to a customer (customer_id set) is viewable only by that
      // signed-in customer — anyone else (a different customer OR an
      // unauthenticated request) 404s rather than leaking it. A guest order
      // carries no customer_id and remains reachable via its unguessable URL
      // (the capability-URL model), so BOTH the just-placed-as-guest path AND
      // the signed-in-shopper-with-an-anonymous-cart path (checkout.confirm
      // derives the order from a cart that has no customer_id) still render
      // their own confirmation here.
      var orderAuth = _currentCustomerEnv(req);
      if (o.customer_id && (!orderAuth || o.customer_id !== orderAuth.customer_id)) {
        return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      }
      // Same variant_id → {product, hero_media} lookup pattern as the
      // cart route, applied to the order's frozen line items so the
      // post-checkout page shows what the customer bought visually.
      var productLookup = {};
      for (var i = 0; i < (o.lines || []).length; i += 1) {
        var vId = o.lines[i].variant_id;
        if (productLookup[vId]) continue;
        var v = await deps.catalog.variants.get(vId);
        if (!v) { productLookup[vId] = null; continue; }
        var prod = await deps.catalog.products.get(v.product_id);
        var media = await deps.catalog.media.listForProduct(v.product_id);
        productLookup[vId] = {
          product:    prod,
          hero_media: media.length ? media[0] : null,
        };
      }
      // "Customers also bought" rail — co-purchase signals anchored on the
      // order's own items (and excluding them, so we never recommend what
      // was just bought). Best-effort: a read failure (engine not wired /
      // tables not migrated) degrades to no rail rather than 500-ing the
      // confirmation page.
      var recommendations = [];
      if (deps.recommendations) {
        try {
          var orderProductIds = [];
          for (var li = 0; li < (o.lines || []).length; li += 1) {
            var look = productLookup[o.lines[li].variant_id];
            if (look && look.product && orderProductIds.indexOf(look.product.id) === -1) {
              orderProductIds.push(look.product.id);
            }
          }
          if (orderProductIds.length) {
            // recommendForCart aggregates the co-purchase signal across
            // EVERY purchased product (not just the first) and pivots the
            // category-popular fallback off the order's dominant
            // collection; it also self-excludes the order's own products,
            // so a multi-item order's rail reflects the whole order.
            var picks = await deps.recommendations.recommendForCart(orderProductIds, { limit: 4 });
            for (var pi = 0; pi < picks.length; pi += 1) {
              var card = await _decorateProductCard(picks[pi].product_id);
              if (card) recommendations.push(card);
            }
          }
        } catch (_e) { recommendations = []; }
      }
      _send(res, 200, renderOrder({
        order:           o,
        product_lookup:  productLookup,
        recommendations: recommendations,
        shop_name:       shopName,
        theme:           theme,
      }));
    });

    // Stripe webhook — the order-completion path. A PaymentIntent succeeds
    // asynchronously (the customer may close the tab before Stripe fires),
    // so the order's pending→paid transition lands here, not on the return
    // page. The body is verified over the RAW bytes (captured upstream by
    // webhookRawBodyCapture into req.rawBody); handleStripeEvent re-verifies
    // the signature, maps the event to an FSM transition, and dedupes
    // Stripe's re-deliveries. A bad signature is 400; a handler error is
    // 500 so Stripe retries; otherwise 200.
    router.post("/api/webhooks/stripe", async function (req, res) {
      // webhookRawBodyCapture set req.body to the exact bytes as a Buffer.
      var raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8")
        : (typeof req.body === "string" ? req.body : "");
      try {
        var result = await deps.checkout.handleStripeEvent({ headers: req.headers || {}, rawBody: raw });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
        var payload = JSON.stringify({ ok: true, handled: !!(result && result.handled) });
        return res.end ? res.end(payload) : res.send(payload);
      } catch (e) {
        if (e && e.code === "WEBHOOK_INVALID") {
          res.status(400);
          return res.end ? res.end("invalid signature") : res.send("");
        }
        // A real failure (e.g. an illegal FSM transition) — 500 so Stripe
        // retries the delivery rather than marking it permanently failed.
        res.status(500);
        return res.end ? res.end("handler error") : res.send("");
      }
    });

    // PayPal webhook — the async backstop for captures completed/refunded out
    // of band (the create/capture flow is primary). Verified server-to-server
    // through PayPal's API (handlePaypalEvent), so unlike Stripe there is no
    // edge HMAC pre-check; the raw body is captured upstream by
    // webhookRawBodyCapture. Mounts only when the PayPal adapter is wired.
    if (deps.paypal) {
      router.post("/api/webhooks/paypal", async function (req, res) {
        var raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8")
          : (typeof req.body === "string" ? req.body : "");
        try {
          var result = await deps.checkout.handlePaypalEvent({ headers: req.headers || {}, rawBody: raw });
          res.status(200);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var payload = JSON.stringify({ ok: true, handled: !!(result && result.handled) });
          return res.end ? res.end(payload) : res.send(payload);
        } catch (e) {
          if (e && e.code === "WEBHOOK_INVALID") {
            res.status(400);
            return res.end ? res.end("invalid signature") : res.send("");
          }
          res.status(500);
          return res.end ? res.end("handler error") : res.send("");
        }
      });
    }
  }

  // ---- gift-card balance check (customer-facing) ---------------------
  //
  // Mounts when deps.giftcards is wired. GET renders the lookup form;
  // POST looks the code up and re-renders with the balance (or a
  // generic not-found). The page is deliberately not a code-existence
  // oracle: unknown, malformed, expired, voided, and redeemed codes
  // all produce the same "couldn't find a balance" outcome.
  if (deps.giftcards) {
    router.get("/gift-cards", async function (req, res) {
      _send(res, 200, renderGiftCardBalance({
        shop_name: shopName, theme: theme, cart_count: await _cartCountForReq(req),
      }));
    });

    router.post("/gift-cards/balance", async function (req, res) {
      var body = req.body || {};
      var code = typeof body.code === "string" ? body.code : "";
      var balance = null;
      var notFound = true;
      try {
        var view = await deps.giftcards.balance(code);
        // Only an active card with a positive balance surfaces a
        // number — an expired / voided / fully-redeemed card is the
        // same dead end as an unknown code to the customer.
        if (view && view.status === "active") {
          balance = { balance_minor: view.balance_minor, currency: view.currency };
          notFound = false;
        }
      } catch (e) {
        // A malformed code throws TypeError at the canonicalizer —
        // swallow it into the same generic not-found. Any other error
        // (e.g. a DB fault) bubbles so it isn't masked as not-found.
        if (!(e instanceof TypeError)) throw e;
      }
      _send(res, 200, renderGiftCardBalance({
        shop_name: shopName, theme: theme, cart_count: await _cartCountForReq(req),
        balance: balance, not_found: notFound,
      }));
    });
  }

  // ---- customer accounts (passkey-only) ------------------------------
  //
  // Mount only when deps.customers is supplied (operator opts in by
  // wiring the customers primitive in server.js). The account routes
  // also depend on b.vault for sealed-cookie envelopes — the seal /
  // unseal calls throw `vault/not-initialized` at request time when
  // the operator hasn't supplied VAULT_PASSPHRASE; routes surface
  // that as 503 so the rest of the storefront stays up.
  if (deps.customers) {
    var rpName = shopName;
    var rpId   = deps.rpId || (deps.shop_origin ? new URL(deps.shop_origin).hostname : "localhost");
    var expectedOrigin = deps.shop_origin || ("https://" + rpId);

    function _b64u(buf) {
      return b.crypto.toBase64Url(buf);
    }

    function _currentCustomer(req) {
      return _currentCustomerEnv(req);
    }

    function _serviceUnavailable(res, msg) {
      res.status(503);
      return res.end ? res.end(msg) : res.send(msg);
    }

    // Attribute a freshly-created customer to the referrer named in the
    // sealed referral cookie, then clear the cookie so it can't attribute
    // a later signup. Guards:
    //   * no cookie / unknown / disabled code → no-op (silent)
    //   * self-referral (the code belongs to this customer) → no-op
    //   * already-attributed (trackSignup pins to the oldest pending
    //     invitation; a customer with one already pinned won't get a
    //     second) → no-op
    // Best-effort: a referrals failure never blocks the signup. Mounts
    // only when the referrals primitive is wired. The cookie is always
    // cleared (even on a guarded no-op) so a stale code doesn't linger.
    async function _attributeReferral(req, res, newCustomerId) {
      if (!deps.referrals) return;
      var env = null;
      try { env = _readReferralEnv(req); } catch (_e) { env = null; }
      // Clear regardless — one shot per signup.
      try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
      if (!env || !env.code) return;
      try {
        var row = await deps.referrals.byCode(env.code);
        if (!row || row.status !== "active") return;
        // Self-referral guard — a customer can't refer themselves.
        if (row.referrer_customer_id === newCustomerId) return;
        await deps.referrals.trackSignup({ code: env.code, customer_id: newCustomerId });
      } catch (_e) { /* drop-silent — attribution is best-effort, signup wins */ }
    }

    function _readJsonBody(req) {
      // b.middleware.bodyParser leaves JSON in req.body when the
      // request's content-type is application/json. Some test
      // harnesses POST a string body — fall back to JSON.parse.
      if (req.body && typeof req.body === "object") return req.body;
      if (typeof req.body === "string") {
        try { return JSON.parse(req.body); } catch (_e) { return {}; }
      }
      return {};
    }

    router.get("/account/login", async function (req, res) {
      var cartCount = await _cartCountForReq(req);
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      _send(res, 200, renderAccountLogin({
        shop_name:      shopName,
        cart_count:     cartCount,
        google_enabled: !!deps.oauthGoogle,
        apple_enabled:  !!deps.oauthApple,
        error:          url && url.searchParams.get("error"),
      }));
    });

    router.get("/account/register", async function (req, res) {
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderAccountRegister({ shop_name: shopName, cart_count: cartCount }));
    });

    router.post("/account/passkey/register-begin", async function (req, res) {
      try {
        var body = _readJsonBody(req);
        // Persist the customer row up-front. The address is the
        // registration's natural identifier — if enrollment fails
        // the customer can re-attempt with the same email; the
        // primitive's duplicate-refusal surfaces as a typed code.
        var existing = await deps.customers.byEmailHash(
          deps.customers.hashEmail(body.email),
        );
        var customer;
        if (existing) {
          customer = existing;
        } else {
          customer = await deps.customers.register({
            email:        body.email,
            display_name: body.display_name,
          });
        }
        var startOpts = await b.auth.passkey.startRegistration({
          rpName:           rpName,
          rpId:             rpId,
          userName:         customer.email_hash.slice(0, 16),
          userDisplayName:  customer.display_name,
          attestationType:  "none",
        });
        // Seal the ceremony state (challenge + customer_id) into the
        // shop_auth_chal cookie so register-finish verifies against
        // the same challenge without server-side state.
        _setChallengeCookie(res, {
          kind:           "register",
          customer_id:    customer.id,
          challenge:      startOpts.challenge,
          created_at:     Date.now(),
          // Whether THIS begin created the customer (vs reused an existing
          // row for a known email). register-finish gates referral
          // attribution on it — an existing customer re-enrolling a passkey
          // through a referral link must not be attributed to a referrer
          // (it isn't a new signup), mirroring the OIDC `rv.created` gate.
          is_new:         !existing,
        });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json");
        return res.end ? res.end(JSON.stringify(startOpts)) : res.send(JSON.stringify(startOpts));
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "register-begin failed") : res.send((e && e.message) || "register-begin failed");
      }
    });

    router.post("/account/passkey/register-finish", async function (req, res) {
      try {
        var env = _readChallengeEnv(req);
        if (!env) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        if (env.kind !== "register") {
          res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge");
        }
        var att = _readJsonBody(req);
        var rv = await b.auth.passkey.verifyRegistration({
          response:           att,
          expectedChallenge:  env.challenge,
          expectedOrigin:     expectedOrigin,
          expectedRPID:       rpId,
        });
        if (!rv || !rv.verified) {
          res.status(400); return res.end ? res.end("attestation refused") : res.send("attestation refused");
        }
        var info = rv.registrationInfo || {};
        var credentialId = info.credentialID || att.rawId || att.id;
        var publicKey    = info.credentialPublicKey;
        if (credentialId && typeof credentialId !== "string") credentialId = _b64u(credentialId);
        if (publicKey && typeof publicKey !== "string")       publicKey    = _b64u(publicKey);
        var transports = "";
        if (att.response && Array.isArray(att.response.transports)) {
          transports = att.response.transports.filter(function (t) { return /^[a-z]+$/.test(t); }).join(",");
        }
        await deps.customers.addPasskey(env.customer_id, {
          credential_id: credentialId,
          public_key:    publicKey,
          counter:       info.counter || 0,
          transports:    transports,
        });
        _clearChallengeCookie(res);
        _setAuthCookie(res, {
          customer_id: env.customer_id,
          exp:         Date.now() + b.constants.TIME.days(14),
        });
        // Attribute this signup to a referrer if the visitor arrived
        // through a /r/<code> link — ONLY for a genuinely new account
        // (env.is_new, stamped in register-begin). An existing customer
        // re-enrolling a passkey is not a new signup and must never be
        // attributed (that would let an existing user mint referral
        // credit by following their own/a friend's link), matching the
        // OIDC `rv.created` gate. Best-effort; never blocks the ceremony.
        if (env.is_new === true) {
          await _attributeReferral(req, res, env.customer_id);
        } else {
          try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
        }
        res.status(200);
        return res.end ? res.end("ok") : res.send("ok");
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "register-finish failed") : res.send((e && e.message) || "register-finish failed");
      }
    });

    router.post("/account/passkey/login-begin", async function (req, res) {
      try {
        var body = _readJsonBody(req);
        var hash = deps.customers.hashEmail(body.email);
        var customer = await deps.customers.byEmailHash(hash);
        // Even when the customer doesn't exist, return a valid-shaped
        // challenge with an empty allowCredentials list — the client
        // can't distinguish "no such address" from "wrong passkey",
        // protecting against email-enumeration.
        var allow = [];
        if (customer) {
          var pks = await deps.customers.listPasskeys(customer.id);
          allow = pks.map(function (p) {
            return {
              id:         p.credential_id,
              type:       "public-key",
              transports: p.transports ? p.transports.split(",") : undefined,
            };
          });
        }
        var startOpts = await b.auth.passkey.startAuthentication({
          rpId:                 rpId,
          allowCredentials:     allow,
          userVerification:     "preferred",
        });
        _setChallengeCookie(res, {
          kind:        "login",
          email_hash:  hash,
          challenge:   startOpts.challenge,
          created_at:  Date.now(),
        });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json");
        return res.end ? res.end(JSON.stringify(startOpts)) : res.send(JSON.stringify(startOpts));
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "login-begin failed") : res.send((e && e.message) || "login-begin failed");
      }
    });

    router.post("/account/passkey/login-finish", async function (req, res) {
      try {
        var env = _readChallengeEnv(req);
        if (!env) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        if (env.kind !== "login") { res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge"); }
        var assertion = _readJsonBody(req);
        var credentialId = assertion.id || assertion.rawId;
        if (!credentialId) { res.status(400); return res.end ? res.end("missing credential id") : res.send("missing credential id"); }
        var passkey = await deps.customers.getPasskeyByCredentialId(credentialId);
        if (!passkey) { res.status(401); return res.end ? res.end("unknown credential") : res.send("unknown credential"); }
        var customer = await deps.customers.get(passkey.customer_id);
        if (!customer) { res.status(401); return res.end ? res.end("unknown customer") : res.send("unknown customer"); }
        if (customer.email_hash !== env.email_hash) {
          // The login-begin email and the credential's customer
          // must agree — refuse cross-account credential reuse.
          res.status(401); return res.end ? res.end("credential / account mismatch") : res.send("credential / account mismatch");
        }
        var rv = await b.auth.passkey.verifyAuthentication({
          response:                assertion,
          expectedChallenge:       env.challenge,
          expectedOrigin:          expectedOrigin,
          expectedRPID:            rpId,
          authenticator: {
            credentialID:          passkey.credential_id,
            credentialPublicKey:   passkey.public_key,
            counter:               passkey.counter,
          },
        });
        if (!rv || !rv.verified) {
          res.status(401); return res.end ? res.end("assertion refused") : res.send("assertion refused");
        }
        // Persist the new counter value (clone-detection).
        var newCounter = (rv.authenticationInfo && rv.authenticationInfo.newCounter) || 0;
        try {
          await deps.customers.updatePasskeyCounter(passkey.id, newCounter);
        } catch (e) {
          if (e && e.code === "PASSKEY_COUNTER_REGRESSION") {
            res.status(401); return res.end ? res.end("counter regression — possible clone") : res.send("counter regression — possible clone");
          }
          throw e;
        }
        // Merge the anonymous cart into a customer-owned cart so
        // the shopper doesn't lose items on sign-in.
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        _clearChallengeCookie(res);
        _setAuthCookie(res, {
          customer_id: customer.id,
          exp:         Date.now() + b.constants.TIME.days(14),
        });
        res.status(200);
        return res.end ? res.end("ok") : res.send("ok");
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "login-finish failed") : res.send((e && e.message) || "login-finish failed");
      }
    });

    router.get("/account", async function (req, res) {
      var auth;
      try { auth = _currentCustomer(req); }
      catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        throw e;
      }
      if (!auth) {
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      var customer = await deps.customers.get(auth.customer_id);
      if (!customer) {
        _clearAuthCookie(res);
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      var orders = [];
      if (deps.order) {
        var page = await deps.order.listForCustomer(customer.id, { limit: 10 });
        orders = page.rows;
      }
      // Per-order product thumbnails. For each order, walk its
      // frozen lines, collapse to unique variant ids, then resolve
      // each through cached `catalog.variants.get` →
      // `catalog.products.get` + `catalog.media.listForProduct`.
      // The per-order list is capped at the first four entries the
      // renderer surfaces (with a "+N" overflow chip when there are
      // more) so a multi-line order doesn't blow up the table row.
      var orderProductLookup = {};
      var variantCache = {};
      for (var oi = 0; oi < orders.length; oi += 1) {
        var ord = orders[oi];
        var entries = [];
        var seen = {};
        for (var li = 0; li < (ord.lines || []).length; li += 1) {
          var vId = ord.lines[li].variant_id;
          if (seen[vId]) continue;
          seen[vId] = true;
          if (!variantCache[vId]) {
            var v = await deps.catalog.variants.get(vId);
            if (!v) { variantCache[vId] = null; continue; }
            var prod  = await deps.catalog.products.get(v.product_id);
            var media = await deps.catalog.media.listForProduct(v.product_id);
            variantCache[vId] = {
              product:    prod,
              hero_media: media.length ? media[0] : null,
            };
          }
          if (variantCache[vId]) entries.push(variantCache[vId]);
        }
        orderProductLookup[ord.id] = entries;
      }
      // Passkey count — how many devices the customer has enrolled.
      var passkeyCount = 0;
      try {
        var pks = await deps.customers.listPasskeys(customer.id);
        passkeyCount = Array.isArray(pks) ? pks.length : 0;
      } catch (_e) { /* drop-silent — primitive may not expose listPasskeys on every build */ }

      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderAccount({
        customer:              customer,
        orders:                orders,
        order_product_lookup:  orderProductLookup,
        passkey_count:         passkeyCount,
        shop_name:             shopName,
        cart_count:            cartCount,
      }));
    });

    router.post("/account/logout", function (_req, res) {
      _clearAuthCookie(res);
      res.status(303); res.setHeader && res.setHeader("location", "/");
      return res.end ? res.end() : res.send("");
    });

    // ---- passkey self-management + profile edit ----------------------
    //
    // The signed-in customer manages their own credentials: list enrolled
    // passkeys, revoke one (confirm-gated), or enroll another device. The
    // revoke is guarded so a customer can't strip away their last sign-in
    // method when they have no federated (OAuth) fallback — that would lock
    // them out. The add flow reuses the WebAuthn begin/finish ceremony the
    // registration page drives, but bound to the ALREADY-authed customer
    // (no email form), so a new credential always lands on the right
    // account.
    function _accountAuth(req, res) {
      var auth;
      try { auth = _currentCustomer(req); }
      catch (e) {
        if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
        throw e;
      }
      if (!auth) {
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        res.end ? res.end() : res.send("");
        return null;
      }
      return auth;
    }

    // Does this customer have a federated (OAuth) sign-in to fall back on?
    // Used as the "is it safe to revoke the last passkey" gate. Composes
    // the existing batched sign-in-methods aggregate (no bespoke query).
    async function _hasOAuthFallback(customerId) {
      var methods = await deps.customers.signInMethodsByCustomer([customerId]);
      var providers = methods.oauth[customerId];
      return Array.isArray(providers) && providers.length > 0;
    }

    function _passkeySuccessCopy(kind) {
      if (kind === "revoked") return "Passkey revoked.";
      if (kind === "added")   return "Passkey added.";
      return null;
    }

    async function _renderPasskeysPage(req, res, auth, notice, code) {
      var pks = await deps.customers.listPasskeys(auth.customer_id);
      var hasOAuth = await _hasOAuthFallback(auth.customer_id);
      var cartCount = await _cartCountForReq(req);
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var okKind = url ? url.searchParams.get("ok") : null;
      _send(res, code || 200, renderPasskeys({
        passkeys:   pks,
        has_oauth:  hasOAuth,
        notice:     notice || null,
        success:    _passkeySuccessCopy(okKind),
        shop_name:  shopName,
        cart_count: cartCount,
      }));
    }

    // Resolve a passkey by path id AND confirm it belongs to the authed
    // customer. A non-UUID segment or a credential owned by someone else
    // is a 404 — never a cross-customer reveal.
    async function _ownedPasskey(req, res, auth) {
      var pks;
      try { pks = await deps.customers.listPasskeys(auth.customer_id); }
      catch (e) { throw e; }
      var id = req.params && req.params.id;
      for (var i = 0; i < pks.length; i += 1) {
        if (pks[i].id === id) return pks[i];
      }
      _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      return null;
    }

    router.get("/account/passkeys", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      await _renderPasskeysPage(req, res, auth, null);
    });

    // Revoke is destructive + CSP forbids confirm(), so it routes through a
    // server-rendered confirm page; the POST that actually revokes lives
    // behind it.
    router.get("/account/passkeys/:id/remove", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      var pk = await _ownedPasskey(req, res, auth); if (!pk) return;
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderPasskeyRemoveConfirm({
        passkey:    pk,
        shop_name:  shopName,
        cart_count: cartCount,
      }));
    });

    router.post("/account/passkeys/:id/revoke", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      var pk = await _ownedPasskey(req, res, auth); if (!pk) return;
      // Last-credential guard: refuse to remove the only sign-in method
      // when there's no federated fallback — surface a clear notice rather
      // than silently locking the customer out.
      var pks = await deps.customers.listPasskeys(auth.customer_id);
      if (pks.length <= 1 && !(await _hasOAuthFallback(auth.customer_id))) {
        return _renderPasskeysPage(
          req, res, auth,
          "That's your only way to sign in — add another passkey (or link a Google / Apple account) before revoking this one.",
          409,
        );
      }
      try {
        await deps.customers.removePasskey(auth.customer_id, pk.id);
      } catch (e) {
        if (e instanceof TypeError) return _renderPasskeysPage(req, res, auth, (e && e.message) || "Could not revoke that passkey.", 400);
        throw e;
      }
      res.status(303); res.setHeader && res.setHeader("location", "/account/passkeys?ok=revoked");
      return res.end ? res.end() : res.send("");
    });

    // Add-another-passkey ceremony — same begin/finish shape as
    // registration, but for the AUTHED customer (no email form). The
    // challenge cookie carries kind "add" + the customer id; finish gates
    // on both so an add-finish can't be replayed against a register/login
    // challenge.
    router.post("/account/passkey/add-begin", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      try {
        var customer = await deps.customers.get(auth.customer_id);
        if (!customer) { res.status(401); return res.end ? res.end("unknown customer") : res.send("unknown customer"); }
        // Exclude already-enrolled credentials so the authenticator won't
        // create a duplicate on the same device.
        var existing = await deps.customers.listPasskeys(customer.id);
        var exclude = existing.map(function (p) {
          return {
            id:         p.credential_id,
            type:       "public-key",
            transports: p.transports ? p.transports.split(",") : undefined,
          };
        });
        var startOpts = await b.auth.passkey.startRegistration({
          rpName:           rpName,
          rpId:             rpId,
          userName:         customer.email_hash.slice(0, 16),
          userDisplayName:  customer.display_name,
          attestationType:  "none",
          excludeCredentials: exclude,
        });
        _setChallengeCookie(res, {
          kind:        "add",
          customer_id: customer.id,
          challenge:   startOpts.challenge,
          created_at:  Date.now(),
        });
        res.status(200);
        res.setHeader && res.setHeader("content-type", "application/json");
        return res.end ? res.end(JSON.stringify(startOpts)) : res.send(JSON.stringify(startOpts));
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "add-begin failed") : res.send((e && e.message) || "add-begin failed");
      }
    });

    router.post("/account/passkey/add-finish", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      try {
        var env = _readChallengeEnv(req);
        if (!env) { res.status(400); return res.end ? res.end("missing challenge") : res.send("missing challenge"); }
        if (env.kind !== "add") { res.status(400); return res.end ? res.end("bad challenge") : res.send("bad challenge"); }
        // The challenge must belong to the customer driving this request —
        // a stolen "add" challenge can't enroll a credential elsewhere.
        if (env.customer_id !== auth.customer_id) {
          res.status(403); return res.end ? res.end("challenge / account mismatch") : res.send("challenge / account mismatch");
        }
        var att = _readJsonBody(req);
        var rv = await b.auth.passkey.verifyRegistration({
          response:           att,
          expectedChallenge:  env.challenge,
          expectedOrigin:     expectedOrigin,
          expectedRPID:       rpId,
        });
        if (!rv || !rv.verified) {
          res.status(400); return res.end ? res.end("attestation refused") : res.send("attestation refused");
        }
        var info = rv.registrationInfo || {};
        var credentialId = info.credentialID || att.rawId || att.id;
        var publicKey    = info.credentialPublicKey;
        if (credentialId && typeof credentialId !== "string") credentialId = _b64u(credentialId);
        if (publicKey && typeof publicKey !== "string")       publicKey    = _b64u(publicKey);
        var transports = "";
        if (att.response && Array.isArray(att.response.transports)) {
          transports = att.response.transports.filter(function (t) { return /^[a-z]+$/.test(t); }).join(",");
        }
        try {
          await deps.customers.addPasskey(env.customer_id, {
            credential_id: credentialId,
            public_key:    publicKey,
            counter:       info.counter || 0,
            transports:    transports,
          });
        } catch (e) {
          if (e && e.code === "PASSKEY_DUPLICATE") {
            res.status(409); return res.end ? res.end("credential already registered") : res.send("credential already registered");
          }
          throw e;
        }
        _clearChallengeCookie(res);
        res.status(200);
        return res.end ? res.end("ok") : res.send("ok");
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "add-finish failed") : res.send((e && e.message) || "add-finish failed");
      }
    });

    // Profile edit — display-name only. Email is hash-only + the OAuth
    // linking key, so the primitive refuses an email change without a
    // verification ceremony; the form shows it read-only. PRG with a
    // ?ok=updated success notice, matching the addresses pattern.
    async function _renderProfilePage(req, res, auth, customer, notice, code) {
      var cartCount = await _cartCountForReq(req);
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var okKind = url ? url.searchParams.get("ok") : null;
      _send(res, code || 200, renderProfile({
        customer:   customer,
        notice:     notice || null,
        success:    okKind === "updated" ? "Profile updated." : null,
        shop_name:  shopName,
        cart_count: cartCount,
      }));
    }

    router.get("/account/profile", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      var customer = await deps.customers.get(auth.customer_id);
      if (!customer) {
        _clearAuthCookie(res);
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      await _renderProfilePage(req, res, auth, customer, null);
    });

    router.post("/account/profile", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      var customer = await deps.customers.get(auth.customer_id);
      if (!customer) {
        _clearAuthCookie(res);
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      var body = req.body || {};
      try {
        await deps.customers.update(auth.customer_id, { display_name: body.display_name });
      } catch (e) {
        if (e instanceof TypeError) {
          var merged = Object.assign({}, customer, { display_name: body.display_name });
          return _renderProfilePage(req, res, auth, merged, (e && e.message) || "Please check the form.", 400);
        }
        throw e;
      }
      res.status(303); res.setHeader && res.setHeader("location", "/account/profile?ok=updated");
      return res.end ? res.end() : res.send("");
    });

    // Sign in with Google (OIDC). Mounts when the operator wires an
    // `oauthGoogle` adapter (b.auth.oauth, google preset). The framework
    // adapter owns discovery + PKCE + ID-token verification (signature,
    // iss, aud, exp, nonce); this layer manages the sealed in-flight
    // state cookie and turns the verified identity into a shop session
    // via customers.signInWithOIDC (which gates account linking on a
    // verified email).
    if (deps.oauthGoogle) {
      router.get("/account/login/google", async function (req, res) {
        try {
          var a = await deps.oauthGoogle.authorizationUrl({ prompt: "select_account" });
          _cookieJar().writeSealed(res, OAUTH_COOKIE_NAME, JSON.stringify({
            provider: "google", state: a.state, nonce: a.nonce, verifier: a.verifier,
          }), { expires: new Date(Date.now() + b.constants.TIME.minutes(10)), path: "/account", sameSite: "Lax" });
          res.status(302);
          res.setHeader && res.setHeader("location", a.url);
          return res.end ? res.end() : res.send("");
        } catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return; }
          res.status(303); res.setHeader && res.setHeader("location", "/account/login?error=oauth");
          return res.end ? res.end() : res.send("");
        }
      });

      router.get("/account/auth/google/callback", async function (req, res) {
        function _toLogin(err) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/account/login" + (err ? "?error=" + err : ""));
          return res.end ? res.end() : res.send("");
        }
        var url   = req.url ? new URL(req.url, "http://localhost") : null;
        var code  = url && url.searchParams.get("code");
        var state = url && url.searchParams.get("state");
        if (!code || !state) return _toLogin("oauth");

        // Recover + clear the sealed sign-in state; the CSRF state must
        // match the value we issued (a forged callback is dropped here).
        var saved;
        try { var raw = _cookieJar().readSealed(req, OAUTH_COOKIE_NAME); saved = raw ? JSON.parse(raw) : null; }
        catch (_e) { saved = null; }
        _cookieJar().clear(res, OAUTH_COOKIE_NAME, { path: "/account" });
        if (!saved || saved.provider !== "google" || saved.state !== state) return _toLogin("oauth");

        var claims;
        try {
          var tokens = await deps.oauthGoogle.exchangeCode({ code: code, verifier: saved.verifier, nonce: saved.nonce });
          claims = tokens && tokens.claims;
        } catch (_e) { return _toLogin("oauth"); }
        if (!claims || !claims.sub) return _toLogin("oauth");

        var rv;
        try {
          rv = await deps.customers.signInWithOIDC({
            provider:       "google",
            subject:        String(claims.sub),
            email:          claims.email,
            email_verified: claims.email_verified === true,
            display_name:   claims.name,
          });
        } catch (e) {
          if (e && e.code === "OAUTH_EMAIL_UNVERIFIED_CONFLICT") return _toLogin("email-conflict");
          if (e instanceof TypeError) return _toLogin("oauth");
          throw e;
        }
        // Adopt the guest cart into the now-authenticated account so a
        // cart built before sign-in isn't lost — and so checkout.confirm
        // (which derives order.customer_id from cart.customer_id) attaches
        // the order to the customer. Mirrors the passkey login path.
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, rv.customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        // Claim prior guest orders placed under this email — ONLY because
        // the provider verified it (claims.email_verified). Links orders
        // with no owner yet whose recorded email hash matches; best-effort.
        if (claims.email_verified === true && claims.email && deps.order &&
            typeof deps.order.linkGuestOrdersByEmailHash === "function") {
          try {
            await deps.order.linkGuestOrdersByEmailHash(rv.customer.id, deps.customers.hashEmail(claims.email));
          } catch (_e) { /* best-effort reconciliation; sign-in succeeds regardless */ }
        }
        // Attribute a referral ONLY on a genuinely new account
        // (rv.created) — an existing customer signing in through Google
        // is not a new signup and must not be attributed to a referrer.
        if (rv.created === true) {
          await _attributeReferral(req, res, rv.customer.id);
        } else {
          try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
        }
        _setAuthCookie(res, { customer_id: rv.customer.id, exp: Date.now() + b.constants.TIME.days(14) });
        res.status(303); res.setHeader && res.setHeader("location", "/account");
        return res.end ? res.end() : res.send("");
      });
    }

    // Sign in with Apple (OIDC). Mounts when the operator wires an
    // `oauthApple` adapter (b.auth.oauth, apple preset). Two differences
    // from Google: (1) Apple uses response_mode=form_post, so the callback
    // is a POST whose `code`/`state` arrive in the form body, not the query
    // string; (2) Apple returns the user's name ONLY on the first
    // authorization, in a `user` form field (JSON) — never in the ID token
    // — so we read it from there and fall back to the (usually absent)
    // token name. Everything after the verified identity (sealed-state
    // check, sign-in, cart merge, guest-order reconciliation, auth cookie)
    // mirrors the Google path.
    if (deps.oauthApple) {
      router.get("/account/login/apple", async function (req, res) {
        try {
          var a = await deps.oauthApple.authorizationUrl({});
          // Apple returns via response_mode=form_post — a CROSS-SITE POST
          // from appleid.apple.com back to our callback. A SameSite=Lax
          // cookie is NOT sent on a cross-site POST navigation (Lax only
          // covers top-level GETs), so the sealed state would be lost and
          // every sign-in would fail. It must be SameSite=None; Secure.
          // (Google's callback is a GET, so Lax is fine there.)
          _cookieJar().writeSealed(res, OAUTH_COOKIE_NAME, JSON.stringify({
            provider: "apple", state: a.state, nonce: a.nonce, verifier: a.verifier,
          }), { expires: new Date(Date.now() + b.constants.TIME.minutes(10)), path: "/account", sameSite: "None", secure: true });
          res.status(302);
          res.setHeader && res.setHeader("location", a.url);
          return res.end ? res.end() : res.send("");
        } catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return; }
          res.status(303); res.setHeader && res.setHeader("location", "/account/login?error=oauth");
          return res.end ? res.end() : res.send("");
        }
      });

      router.post("/account/auth/apple/callback", async function (req, res) {
        function _toLogin(err) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/account/login" + (err ? "?error=" + err : ""));
          return res.end ? res.end() : res.send("");
        }
        // form_post: code + state (+ the first-auth `user` blob) are in the
        // request body, not the query string.
        var body  = req.body || {};
        var code  = body.code;
        var state = body.state;
        if (!code || !state) return _toLogin("oauth");

        var saved;
        try { var raw = _cookieJar().readSealed(req, OAUTH_COOKIE_NAME); saved = raw ? JSON.parse(raw) : null; }
        catch (_e) { saved = null; }
        _cookieJar().clear(res, OAUTH_COOKIE_NAME, { path: "/account" });
        if (!saved || saved.provider !== "apple" || saved.state !== state) return _toLogin("oauth");

        var claims;
        try {
          var tokens = await deps.oauthApple.exchangeCode({ code: code, verifier: saved.verifier, nonce: saved.nonce });
          claims = tokens && tokens.claims;
        } catch (_e) { return _toLogin("oauth"); }
        if (!claims || !claims.sub) return _toLogin("oauth");

        // Apple sends the display name only on first consent, as a JSON
        // `user` form field: { name: { firstName, lastName }, email }.
        var displayName = claims.name || null;
        if (typeof body.user === "string" && body.user.length) {
          try {
            var u = JSON.parse(body.user);
            if (u && u.name) {
              displayName = [u.name.firstName, u.name.lastName].filter(Boolean).join(" ") || displayName;
            }
          } catch (_e) { /* malformed user blob — fall back to the token name */ }
        }
        // Apple's email_verified arrives as a boolean OR the string "true".
        var emailVerified = claims.email_verified === true || claims.email_verified === "true";

        var rv;
        try {
          rv = await deps.customers.signInWithOIDC({
            provider:       "apple",
            subject:        String(claims.sub),
            email:          claims.email,
            email_verified: emailVerified,
            display_name:   displayName,
          });
        } catch (e) {
          if (e && e.code === "OAUTH_EMAIL_UNVERIFIED_CONFLICT") return _toLogin("email-conflict");
          if (e instanceof TypeError) return _toLogin("oauth");
          throw e;
        }
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, rv.customer.id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        if (emailVerified && claims.email && deps.order &&
            typeof deps.order.linkGuestOrdersByEmailHash === "function") {
          try {
            await deps.order.linkGuestOrdersByEmailHash(rv.customer.id, deps.customers.hashEmail(claims.email));
          } catch (_e) { /* best-effort reconciliation; sign-in succeeds regardless */ }
        }
        // Attribute a referral ONLY on a genuinely new account (rv.created)
        // — mirrors the Google path.
        if (rv.created === true) {
          await _attributeReferral(req, res, rv.customer.id);
        } else {
          try { _clearReferralCookie(res); } catch (_e) { /* best-effort */ }
        }
        _setAuthCookie(res, { customer_id: rv.customer.id, exp: Date.now() + b.constants.TIME.days(14) });
        res.status(303); res.setHeader && res.setHeader("location", "/account");
        return res.end ? res.end() : res.send("");
      });
    }

    // Wishlist — saved products scoped to the logged-in customer.
    // Mounts when the wishlist primitive is wired.
    if (deps.wishlist) {
      // POST /wishlist/toggle — add the product if not saved, remove it
      // if already saved. Login required (the wishlist is per-customer).
      // Redirects to `return_to` when it's a safe same-origin path
      // (the account page's Remove uses it), otherwise back to the
      // product PDP (the canonical slug is resolved from product_id, so
      // a forged slug can't drive an open redirect).
      router.post("/wishlist/toggle", async function (req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          return res.end ? res.end() : res.send("");
        }
        var productId = (req.body || {}).product_id;
        var removed = false;
        try {
          var already = await deps.wishlist.isWishlisted({ customer_id: auth.customer_id, product_id: productId });
          if (already) { await deps.wishlist.remove({ customer_id: auth.customer_id, product_id: productId }); removed = true; }
          else         await deps.wishlist.add({ customer_id: auth.customer_id, product_id: productId });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        var okKind = removed ? "removed" : "added";
        var rt = (req.body || {}).return_to;
        var dest;
        if (typeof rt === "string" && /^\/[^/]/.test(rt)) {
          // Only thread the success marker when returning to the wishlist
          // page (the PDP heart toggle is its own visible cue).
          dest = rt.indexOf("/account/wishlist") === 0 ? "/account/wishlist?ok=" + okKind : rt;
        } else {
          var product = null;
          try { product = await deps.catalog.products.get(productId); } catch (_e) { product = null; }
          dest = product ? ("/products/" + encodeURIComponent(product.slug)) : ("/account/wishlist?ok=" + okKind);
        }
        res.status(303); res.setHeader && res.setHeader("location", dest);
        return res.end ? res.end() : res.send("");
      });

      // GET /account/wishlist — the customer's saved items. Each entry
      // resolves its product + hero image; an entry whose product was
      // archived renders as "unavailable" (the row is orphan-tolerant).
      router.get("/account/wishlist", async function (req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          return res.end ? res.end() : res.send("");
        }
        var page = await deps.wishlist.listForCustomer(auth.customer_id, { limit: 50 });
        var items = [];
        for (var i = 0; i < page.rows.length; i += 1) {
          var entry = page.rows[i];
          var product = null;
          try { product = await deps.catalog.products.get(entry.product_id); } catch (_e) { product = null; }
          if (!product) { items.push({ product: null, product_id: entry.product_id }); continue; }
          var media = await deps.catalog.media.listForProduct(product.id);
          items.push({ product: product, hero_media: media.length ? media[0] : null });
        }
        var cartCount = await _cartCountForReq(req);
        var wlUrl = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderWishlist({
          items:        items,
          notice:       wlUrl ? wlUrl.searchParams.get("ok") : null,
          shop_name:    shopName,
          cart_count:   cartCount,
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });
    }

    // Save for later — move a cart line into a per-customer holding
    // list and back. Login required (the list is per-customer).
    if (deps.saveForLater) {
      function _savedAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // POST /cart/lines/:line_id/save — move the line out of the cart
      // into the customer's saved list. Redirects back to /cart.
      router.post("/cart/lines/:line_id/save", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        var sid = _readSidCookie(req);
        var cart = sid ? await deps.cart.bySession(sid) : null;
        if (!cart) {
          res.status(303); res.setHeader && res.setHeader("location", "/cart");
          return res.end ? res.end() : res.send("");
        }
        try {
          await deps.saveForLater.moveFromCart({
            customer_id: auth.customer_id,
            cart_id:     cart.id,
            line_id:     req.params && req.params.line_id,
          });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      });

      // GET /account/saved — the customer's saved-for-later list.
      router.get("/account/saved", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        var page = await deps.saveForLater.listForCustomer({ customer_id: auth.customer_id, limit: 50 });
        var items = [];
        for (var i = 0; i < page.rows.length; i += 1) {
          var row = page.rows[i];
          var product = null;
          if (row.variant_id) {
            try {
              var v = await deps.catalog.variants.get(row.variant_id);
              if (v) product = await deps.catalog.products.get(v.product_id);
            } catch (_e) { product = null; }
          }
          if (!product) { items.push({ save: row, product: null }); continue; }
          var media = await deps.catalog.media.listForProduct(product.id);
          items.push({ save: row, product: product, hero_media: media.length ? media[0] : null });
        }
        var cartCount = await _cartCountForReq(req);
        var savedUrl = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderSaved({
          items:        items,
          notice:       savedUrl ? savedUrl.searchParams.get("ok") : null,
          shop_name:    shopName,
          cart_count:   cartCount,
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });

      // POST /saved/:save_id/move-to-cart — move a saved row back into
      // the session cart (created if absent). Redirects to /cart.
      router.post("/saved/:save_id/move-to-cart", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        var resolved = await _getOrCreateCart(req, res, "USD");
        try {
          await deps.saveForLater.moveToCart({
            customer_id: auth.customer_id,
            save_id:     req.params && req.params.save_id,
            cart_id:     resolved.cart.id,
            // Reprice to the live catalog price so the cart never carries
            // a stale snapshot; the saved page shows the snapshot for
            // reference only.
            use_price:   "current",
          });
        } catch (e) {
          if (e instanceof TypeError) {
            res.status(400);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          // The cart enforces one line per (cart_id, variant_id). If the
          // shopper re-added this variant before moving the saved copy,
          // moveToCart's INSERT collides — but the end state they want
          // (variant in the cart) already holds. Drop the saved row and
          // treat it as success instead of surfacing a 500. The lib
          // leaves the save row intact on collision, so removing it here
          // is what completes the "move".
          if (/unique|constraint/i.test((e && e.message) || "")) {
            try {
              await deps.saveForLater.remove({ customer_id: auth.customer_id, save_id: req.params && req.params.save_id });
            } catch (_e) { /* drop-silent — the move is already effectively done */ }
            res.status(303); res.setHeader && res.setHeader("location", "/cart");
            return res.end ? res.end() : res.send("");
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      });

      // POST /saved/:save_id/remove — drop a saved row.
      router.post("/saved/:save_id/remove", async function (req, res) {
        var auth = _savedAuth(req, res);
        if (!auth) return;
        try {
          await deps.saveForLater.remove({ customer_id: auth.customer_id, save_id: req.params && req.params.save_id });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/saved?ok=removed");
        return res.end ? res.end() : res.send("");
      });
    }

    // Address book — per-customer saved addresses. Every by-id route
    // verifies the address belongs to the authed customer before acting
    // (the primitive operates by id alone, so ownership is enforced here
    // to prevent cross-customer access via a guessed id).
    if (deps.addresses) {
      function _addrAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }
      async function _ownedAddress(req, res, auth) {
        var addr;
        try {
          addr = await deps.addresses.get(req.params && req.params.id);
        } catch (e) {
          // `get` throws TypeError on a non-UUID id — a malformed path
          // segment is a 404, not a 500.
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!addr || addr.customer_id !== auth.customer_id || Number(addr.is_archived) === 1) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return addr;
      }
      // Map the ?ok=<kind> redirect marker the POST handlers set on
      // success to the human confirmation copy rendered (role="status")
      // at the top of the list. Unknown markers degrade to no notice.
      function _addrSuccessCopy(kind) {
        if (kind === "added")    return "Address saved.";
        if (kind === "updated")  return "Address updated.";
        if (kind === "removed")  return "Address removed.";
        if (kind === "restored") return "Address restored.";
        if (kind === "default-shipping") return "Default shipping address updated.";
        if (kind === "default-billing")  return "Default billing address updated.";
        return null;
      }
      async function _renderAddrPage(req, res, auth, editAddr, notice, code) {
        var rows = await deps.addresses.listForCustomer(auth.customer_id, { limit: 50 });
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var okKind = url ? url.searchParams.get("ok") : null;
        var success = _addrSuccessCopy(okKind);
        // An Undo control is only offered for a just-removed row, and only
        // when the ?undo=<id> marker round-trips a real owned address id.
        var undoId = (okKind === "removed" && url) ? url.searchParams.get("undo") : null;
        _send(res, code || 200, renderAddresses({
          addresses:  rows,
          edit:       editAddr || null,
          notice:     notice || null,
          success:    success,
          undo_id:    undoId || null,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      }
      function _addrInput(body, customerId) {
        return {
          customer_id:         customerId,
          label:               body.label,
          recipient_name:      body.recipient_name,
          company:             body.company,
          street_line1:        body.street_line1,
          street_line2:        body.street_line2,
          city:                body.city,
          region:              body.region,
          postal_code:         body.postal_code,
          country:             body.country,
          phone:               body.phone,
          // Checkboxes arrive as "1" when ticked, absent otherwise — the
          // primitive's _bool wants an integer, so coerce here.
          is_default_shipping: body.is_default_shipping === "1" ? 1 : 0,
          is_default_billing:  body.is_default_billing === "1" ? 1 : 0,
        };
      }

      router.get("/account/addresses", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        await _renderAddrPage(req, res, auth, null);
      });

      router.get("/account/addresses/:id/edit", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr = await _ownedAddress(req, res, auth); if (!addr) return;
        await _renderAddrPage(req, res, auth, addr);
      });

      router.post("/account/addresses", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        try {
          await deps.addresses.add(_addrInput(req.body || {}, auth.customer_id));
        } catch (e) {
          if (e instanceof TypeError) return _renderAddrPage(req, res, auth, null, (e && e.message) || "Please check the address.", 400);
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/addresses?ok=added");
        return res.end ? res.end() : res.send("");
      });

      router.post("/account/addresses/:id", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr = await _ownedAddress(req, res, auth); if (!addr) return;
        try {
          await deps.addresses.update(addr.id, _addrInput(req.body || {}, auth.customer_id));
        } catch (e) {
          if (e instanceof TypeError) {
            var merged = Object.assign({}, addr, _addrInput(req.body || {}, auth.customer_id));
            return _renderAddrPage(req, res, auth, merged, (e && e.message) || "Please check the address.", 400);
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/addresses?ok=updated");
        return res.end ? res.end() : res.send("");
      });

      function _addrAction(verb, okKind, fn) {
        router.post("/account/addresses/:id/" + verb, async function (req, res) {
          var auth = _addrAuth(req, res); if (!auth) return;
          var addr = await _ownedAddress(req, res, auth); if (!addr) return;
          try { await fn(addr.id); }
          catch (e) {
            res.status(e instanceof TypeError ? 400 : 500);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/addresses?ok=" + okKind);
          return res.end ? res.end() : res.send("");
        });
      }
      _addrAction("default-shipping", "default-shipping", function (id) { return deps.addresses.setDefaultShipping(id); });
      _addrAction("default-billing",  "default-billing",  function (id) { return deps.addresses.setDefaultBilling(id); });

      // Remove is destructive and CSP forbids a confirm() dialog, so it
      // routes through a server-rendered confirm page first; the POST that
      // actually archives lives behind that page. The list then surfaces a
      // success notice with an Undo (unarchive) control.
      router.get("/account/addresses/:id/remove", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr = await _ownedAddress(req, res, auth); if (!addr) return;
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderAddressRemoveConfirm({
          address:    addr,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      router.post("/account/addresses/:id/archive", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr = await _ownedAddress(req, res, auth); if (!addr) return;
        try { await deps.addresses.archive(addr.id); }
        catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/addresses?ok=removed&undo=" + encodeURIComponent(addr.id));
        return res.end ? res.end() : res.send("");
      });

      // Undo path for a just-removed address. Unlike the by-id routes
      // above, this one resolves the row WITH archived rows included (the
      // address is archived by definition here) but still enforces
      // customer ownership before un-archiving.
      router.post("/account/addresses/:id/unarchive", async function (req, res) {
        var auth = _addrAuth(req, res); if (!auth) return;
        var addr;
        try { addr = await deps.addresses.get(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return; }
          throw e;
        }
        if (!addr || addr.customer_id !== auth.customer_id) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        }
        try { await deps.addresses.unarchive(addr.id); }
        catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/addresses?ok=restored");
        return res.end ? res.end() : res.send("");
      });
    }

    // Subscription self-management — the signed-in customer views their
    // own recurring subscriptions and cancels them. The list mounts on
    // the subscriptions primitive alone; the cancel route additionally
    // needs the payment handle (cancel composes Stripe through
    // `subscriptions.subscriptions.cancel`, mirroring the admin gate). A
    // subscription is fetched + ownership-checked against the authed
    // customer before any cancel — a guessed/forged id never reaches
    // another customer's row. Creation (a Stripe subscription-checkout
    // flow) is a separate surface; this is the management view.
    if (subscriptions) {
      var subsCanCancel = !!deps.payment;

      function _subsAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // Resolve the customer's subscriptions and join each to its plan.
      // Plans are batched: one `plans.get` per distinct plan_id, cached
      // across rows, so a customer with many subscriptions on the same
      // plan costs one plan read, not one per subscription (no N+1). A
      // read failure (table not migrated) degrades to an empty list
      // rather than 500-ing the account page.
      async function _subsForCustomer(customerId) {
        var rows;
        try { rows = await subscriptions.subscriptions.list({ customer_id: customerId }); }
        catch (e) {
          if (e instanceof TypeError) return [];
          throw e;
        }
        var planCache = {};
        for (var i = 0; i < rows.length; i += 1) {
          var pid = rows[i].plan_id;
          if (pid != null && !Object.prototype.hasOwnProperty.call(planCache, pid)) {
            try { planCache[pid] = await subscriptions.plans.get(pid); }
            catch (_e) { planCache[pid] = null; }
          }
          rows[i].plan = pid != null ? planCache[pid] : null;
        }
        return rows;
      }

      // Load the subscription named in :id and confirm it belongs to the
      // signed-in customer. A malformed id (guardUuid TypeError), a
      // missing row, or another customer's subscription all return null
      // after sending a 404 — never a 500, never a cross-customer cancel.
      async function _ownedSubscription(req, res, auth) {
        var sub;
        try { sub = await subscriptions.subscriptions.get(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!sub || sub.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return sub;
      }

      router.get("/account/subscriptions", async function (req, res) {
        var auth = _subsAuth(req, res); if (!auth) return;
        var rows = await _subsForCustomer(auth.customer_id);
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var canceled = !!(url && url.searchParams.get("canceled"));
        _send(res, 200, renderAccountSubscriptions({
          subscriptions: rows,
          can_cancel:    subsCanCancel,
          notice:        canceled ? "Your subscription has been canceled." : null,
          shop_name:     shopName,
          cart_count:    cartCount,
        }));
      });

      // Cancel mounts only when payment is wired (cancel composes Stripe).
      // Without payment the list above stays read-only with a note.
      if (deps.payment) {
        // Confirmation step (GET) ahead of the destructive POST. Renders
        // the period-end date + the days-forfeited consequence of an
        // immediate cancel. A subscription that isn't cancelable
        // (already canceled / winding down) redirects back to the list.
        router.get("/account/subscriptions/:id/cancel", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          if (!_subscriptionIsCancelable(sub)) {
            res.status(303); res.setHeader && res.setHeader("location", "/account/subscriptions");
            return res.end ? res.end() : res.send("");
          }
          // Join the plan for the confirm-page summary (best-effort — a
          // missing plan degrades the heading to a generic phrase).
          if (sub.plan_id != null) {
            try { sub.plan = await subscriptions.plans.get(sub.plan_id); }
            catch (_e) { sub.plan = null; }
          }
          var cartCount = await _cartCountForReq(req);
          _send(res, 200, renderSubscriptionCancelConfirm({
            subscription: sub,
            shop_name:    shopName,
            cart_count:   cartCount,
          }));
        });

        router.post("/account/subscriptions/:id/cancel", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          // Default cancel-at-period-end (the customer keeps access through
          // the period they've paid for); the form opts into immediate via
          // the `immediate` checkbox.
          var atPeriodEnd = !((req.body || {}).immediate === "1");
          try {
            await subscriptions.subscriptions.cancel(sub.id, { at_period_end: atPeriodEnd });
          } catch (e) {
            // A bad id was already screened by _ownedSubscription; a
            // downstream TypeError (shape) bounces back to the list with a
            // notice rather than 500-ing.
            if (e instanceof TypeError) {
              res.status(303); res.setHeader && res.setHeader("location", "/account/subscriptions");
              return res.end ? res.end() : res.send("");
            }
            throw e;
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/subscriptions?canceled=1");
          return res.end ? res.end() : res.send("");
        });
      }
    }

    // Self-serve returns — a customer requests an RMA against one of
    // their own orders and tracks its status. Operators action it via
    // the admin /admin/returns queue. Needs the returns primitive + an
    // order handle (to load + ownership-check the order being returned).
    if (deps.returns && deps.order) {
      function _returnsAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }
      // Load the order named in :order_id and confirm it belongs to the
      // signed-in customer. A malformed id (guardUuid TypeError), a
      // missing order, or someone else's order all return 404 — never a
      // 500, never a leak of another customer's order.
      async function _ownedOrder(req, res, auth) {
        var order;
        try { order = await deps.order.get(req.params && req.params.order_id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!order || order.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return order;
      }

      router.get("/account/returns", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var page = await deps.returns.listForCustomer(auth.customer_id, { limit: 50 });
        var cartCount = await _cartCountForReq(req);
        var retUrl = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderReturns({
          rmas:       page.rows,
          rma_code:   retUrl ? retUrl.searchParams.get("ok") : null,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      router.get("/account/orders/:order_id/return", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var order = await _ownedOrder(req, res, auth); if (!order) return;
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderReturnForm({ order: order, lines: order.lines || [], shop_name: shopName, cart_count: cartCount }));
      });

      router.post("/account/orders/:order_id/return", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var order = await _ownedOrder(req, res, auth); if (!order) return;
        var body = req.body || {};
        var cartCount = await _cartCountForReq(req);
        // Build the return lines from the order's own lines (authoritative
        // sku/qty), keyed by the checkboxes the customer ticked — never
        // trust a client-supplied sku.
        var orderLines = order.lines || [];
        var picked = [];
        for (var i = 0; i < orderLines.length; i += 1) {
          var ol = orderLines[i];
          if (body["return_" + ol.id] !== "1") continue;
          var wanted = parseInt(body["qty_" + ol.id], 10);
          var qty = Number.isFinite(wanted) && wanted >= 1 && wanted <= ol.qty ? wanted : ol.qty;
          picked.push({ order_line_id: ol.id, sku: ol.sku, qty: qty });
        }
        if (picked.length === 0) {
          return _send(res, 400, renderReturnForm({
            order: order, lines: orderLines, notice: "Select at least one item to return.",
            shop_name: shopName, cart_count: cartCount,
          }));
        }
        var requested;
        try {
          requested = await deps.returns.request({
            order_id:       order.id,
            customer_id:    auth.customer_id,
            reason:         body.reason,
            customer_notes: body.customer_notes,
            lines:          picked,
          });
        } catch (e) {
          if (e instanceof TypeError) {
            return _send(res, 400, renderReturnForm({
              order: order, lines: orderLines, notice: (e && e.message) || "Please check your return request.",
              shop_name: shopName, cart_count: cartCount,
            }));
          }
          throw e;
        }
        // Round-trip the RMA code on the redirect so the list page can
        // confirm the request and echo the operator-readable handle.
        var rmaCode = requested && requested.rma_code ? requested.rma_code : "";
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/returns?ok=" + encodeURIComponent(rmaCode));
        return res.end ? res.end() : res.send("");
      });
    }

    // Loyalty — the signed-in customer's points balance + tier, the
    // earn/redeem ledger, how points are earned, and (when a reward
    // catalog + redemption primitive are wired) a redeem-a-reward
    // control. Login-gated; a read failure on any optional sub-read
    // degrades that section to empty rather than 500-ing the page.
    if (deps.loyalty) {
      function _loyaltyAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // Build the full /account/loyalty render context for a customer.
      // `opts2.cursor` is the optional history-page cursor (epoch-ms).
      // Each optional read (earn rules, reward catalog, redemptions) is
      // best-effort so a not-migrated table degrades that panel rather
      // than the page.
      async function _loyaltyView(req, auth, opts2) {
        opts2 = opts2 || {};
        var bal = await deps.loyalty.balance(auth.customer_id);
        var hist = await deps.loyalty.history(auth.customer_id, { limit: 20, cursor: opts2.cursor });
        var rules = [];
        if (deps.loyaltyEarnRules) {
          try { rules = await deps.loyaltyEarnRules.listRules({ active_only: true, limit: 50 }); }
          catch (_e) { rules = []; }
        }
        var rewards = [];
        var redemptions = [];
        if (deps.loyaltyRedemption) {
          try { rewards = await deps.loyaltyRedemption.listRewards({ active_only: true, limit: 50 }); }
          catch (_e) { rewards = []; }
          try {
            var rpage = await deps.loyaltyRedemption.redemptionsForCustomer(auth.customer_id, { limit: 20 });
            redemptions = rpage.rows;
          } catch (_e) { redemptions = []; }
        }
        var cartCount = await _cartCountForReq(req);
        return {
          balance:        bal,
          tiers:          deps.loyalty.TIERS,
          tier_thresholds: deps.loyalty.TIER_THRESHOLDS,
          redemption_points_per_usd: deps.loyalty.REDEMPTION_POINTS_PER_USD,
          history:        hist.rows,
          history_next_cursor: hist.next_cursor,
          earn_rules:     rules,
          rewards:        rewards,
          redemptions:    redemptions,
          can_redeem:     !!deps.loyaltyRedemption,
          notice:         opts2.notice || null,
          notice_kind:    opts2.notice_kind || null,
          shop_name:      shopName,
          cart_count:     cartCount,
        };
      }

      router.get("/account/loyalty", async function (req, res) {
        var auth = _loyaltyAuth(req, res); if (!auth) return;
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var cursorRaw = url && url.searchParams.get("cursor");
        var cursor;
        if (cursorRaw != null && cursorRaw !== "") {
          var n = parseInt(cursorRaw, 10);
          // A malformed cursor degrades to the first page (the lib
          // would TypeError on a non-integer) — never 500 the page.
          cursor = Number.isFinite(n) && n >= 0 ? n : undefined;
        }
        var view = await _loyaltyView(req, auth, { cursor: cursor });
        _send(res, 200, renderLoyalty(view));
      });

      // Redeem a reward from the catalog. Mounts only when the
      // redemption primitive is wired. The reward debits points via the
      // composed loyalty ledger; insufficient balance / cap reached /
      // not-redeemable surface as a 400 re-render, never a 500.
      if (deps.loyaltyRedemption) {
        router.post("/account/loyalty/redeem", async function (req, res) {
          var auth = _loyaltyAuth(req, res); if (!auth) return;
          var body = req.body || {};
          var rewardSlug = body.reward_slug;
          try {
            await deps.loyaltyRedemption.redeemForCustomer({
              customer_id: auth.customer_id,
              reward_slug: rewardSlug,
            });
          } catch (e) {
            // Customer-facing refusals (TypeError on a bad slug,
            // LOYALTY_INSUFFICIENT_BALANCE, REWARD_NOT_REDEEMABLE,
            // REDEMPTION_CAP_REACHED) re-render the page with the
            // reason; anything else propagates as a 500.
            var code = (e && typeof e.code === "string") ? e.code : "";
            var clientErr = (e instanceof TypeError)
              || code === "LOYALTY_INSUFFICIENT_BALANCE"
              || code === "REWARD_NOT_REDEEMABLE"
              || code === "REDEMPTION_CAP_REACHED";
            if (!clientErr) throw e;
            var msg;
            if (code === "LOYALTY_INSUFFICIENT_BALANCE") msg = "You don't have enough points for that reward yet.";
            else if (code === "REWARD_NOT_REDEEMABLE")   msg = "That reward isn't available right now.";
            else if (code === "REDEMPTION_CAP_REACHED")  msg = "You've reached the redemption limit for that reward.";
            else                                          msg = "We couldn't redeem that reward — please pick one from the list.";
            var failView = await _loyaltyView(req, auth, { notice: msg, notice_kind: "error" });
            return _send(res, 400, renderLoyalty(failView));
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/loyalty");
          return res.end ? res.end() : res.send("");
        });
      }
    }

    // Referrals — refer-a-friend. Three surfaces:
    //   * GET  /r/:code            — the attribution landing. Sets a
    //     short-lived sealed first-party cookie naming the code, records
    //     the visit, then 303s home. An unknown / malformed / disabled
    //     code is silently ignored (no cookie, no error to the visitor).
    //     Public — no sign-in. The cookie is read at account-creation to
    //     attribute the new customer to the referrer.
    //   * GET  /account/referrals — the signed-in customer's own code +
    //     shareable link, the friends they've referred (funnel stage,
    //     no PII), and the in-account top-referrer leaderboard.
    //   * POST /account/referrals/code — mint the customer's code (one
    //     active code per customer; idempotent on an existing one).
    // Attribution is FIRST-TOUCH: trackSignup pins the signup to the
    // oldest pending invitation under the code, and the landing only
    // overwrites the cookie when none is already set (below), so the
    // first referral link a visitor follows wins.
    if (deps.referrals) {
      function _referralsAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      // The attribution landing. The cookie is path "/" so it survives
      // the visitor's navigation to the register page, sealed so it
      // can't be forged to mis-attribute a signup, and short-lived
      // (30 days) so a stale link doesn't attribute a much-later signup.
      router.get("/r/:code", async function (req, res) {
        function _goHome() {
          res.status(303); res.setHeader && res.setHeader("location", "/");
          return res.end ? res.end() : res.send("");
        }
        var raw = req.params && req.params.code;
        // Resolve the code to a live row. A bad shape throws TypeError
        // inside byCode (canonicalization) — swallow it; the visitor
        // sees a clean redirect home, never an error tied to a guessed
        // code (no code-existence oracle).
        var row;
        try { row = await deps.referrals.byCode(raw); }
        catch (_e) { row = null; }
        if (!row || row.status !== "active") return _goHome();
        // First-touch: don't overwrite an existing referral cookie — the
        // first link the visitor followed keeps the attribution.
        var existing = null;
        try { existing = _readReferralEnv(req); } catch (_e) { existing = null; }
        if (!existing || !existing.code) {
          _setReferralCookie(res, { code: row.code, set_at: Date.now() });
        }
        // Record the visit on the funnel (best-effort — a tracking
        // failure must not block the redirect).
        try { await deps.referrals.trackVisit({ code: row.code }); }
        catch (_e) { /* drop-silent — the visit stat is non-critical */ }
        return _goHome();
      });

      // Build the /account/referrals render context. Each read is
      // best-effort so a not-migrated dependency degrades that panel
      // rather than 500-ing the page.
      async function _referralsView(req, auth, opts2) {
        opts2 = opts2 || {};
        var code = null, link = null;
        var stats = null;
        try { stats = await deps.referrals.statsForReferrer(auth.customer_id); }
        catch (_e) { stats = null; }
        if (stats && stats.codes && stats.codes.length) {
          // Surface ONLY an active code — the one /r/<code> will honor.
          // If every code is disabled, leave code/link null so the page
          // shows the "create a code" state rather than prompting the
          // customer to share a dead link they can't replace.
          var active = null;
          for (var i = 0; i < stats.codes.length; i += 1) {
            if (stats.codes[i].status === "active") { active = stats.codes[i]; break; }
          }
          if (active) {
            code = active.code;
            link = _referralLink(req, active.code);
          }
        }
        var invitations = [];
        try { invitations = await deps.referrals.invitationsForReferrer(auth.customer_id); }
        catch (_e) { invitations = []; }
        var leaderboard = [];
        if (deps.referralLeaderboard) {
          try {
            // Lifetime top referrers. The referrals primitive's own
            // leaderboard returns { referrer_customer_id, completed }; we
            // resolve each to initials for display (rank + initials only,
            // never names/emails/ids), and mark the signed-in customer.
            var top = await deps.referrals.leaderboard({ limit: 10 });
            for (var k = 0; k < top.length; k += 1) {
              var rid = top[k].referrer_customer_id;
              var dn = "";
              try {
                var cust = await deps.customers.get(rid);
                dn = (cust && cust.display_name) || "";
              } catch (_e) { dn = ""; }
              leaderboard.push({
                completed_referrals: top[k].completed_referrals,
                display_name:        dn,
                is_you:              rid === auth.customer_id,
              });
            }
          } catch (_e) { leaderboard = []; }
        }
        var cartCount = await _cartCountForReq(req);
        return {
          code:                  code,
          link:                  link,
          invitations:           invitations,
          leaderboard:           leaderboard,
          completed_referrals:   stats ? stats.completed_referrals : 0,
          invitations_total:     stats ? stats.invitations_total : 0,
          invitations_signed_up: stats ? stats.invitations_signed_up : 0,
          notice:                opts2.notice || null,
          notice_kind:           opts2.notice_kind || null,
          shop_name:             shopName,
          cart_count:            cartCount,
        };
      }

      router.get("/account/referrals", async function (req, res) {
        var auth = _referralsAuth(req, res); if (!auth) return;
        var view = await _referralsView(req, auth, {});
        _send(res, 200, renderReferrals(view));
      });

      router.post("/account/referrals/code", async function (req, res) {
        var auth = _referralsAuth(req, res); if (!auth) return;
        try {
          await deps.referrals.issueCode({ referrer_customer_id: auth.customer_id });
        } catch (e) {
          // An existing active code is the idempotent happy path — the
          // customer already has one, so just show the page. Any other
          // refusal re-renders with a generic notice; never a 500 for a
          // TypeError on the (cookie-derived) customer id.
          var code = (e && typeof e.code === "string") ? e.code : "";
          if (code !== "REFERRAL_CODE_ALREADY_ACTIVE" && !(e instanceof TypeError)) {
            throw e;
          }
          if (code !== "REFERRAL_CODE_ALREADY_ACTIVE") {
            var failView = await _referralsView(req, auth, {
              notice: "We couldn't create your referral code — please try again.",
              notice_kind: "error",
            });
            return _send(res, 400, renderReferrals(failView));
          }
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/referrals");
        return res.end ? res.end() : res.send("");
      });
    }

    // Recently viewed — the signed-in customer's newest-first browse
    // history. Views are recorded server-side on the (container-rendered)
    // PDP; this surface lets the customer review + clear that history.
    if (deps.recentlyViewed) {
      function _rvAuth(req, res) {
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        return auth;
      }

      router.get("/account/recently-viewed", async function (req, res) {
        var auth = _rvAuth(req, res); if (!auth) return;
        // A read failure (table not migrated) degrades to the empty
        // state rather than 500-ing the account page.
        var rows = [];
        try { rows = await deps.recentlyViewed.forCustomer(auth.customer_id, { limit: 24 }); }
        catch (_e) { rows = []; }
        var products = [];
        for (var i = 0; i < rows.length; i += 1) {
          var card = await _decorateProductCard(rows[i].product_id);
          if (card) products.push(card);
        }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderRecentlyViewed({ products: products, shop_name: shopName, cart_count: cartCount }));
      });

      router.post("/account/recently-viewed/clear", async function (req, res) {
        var auth = _rvAuth(req, res); if (!auth) return;
        try { await deps.recentlyViewed.purgeCustomer(auth.customer_id); }
        catch (_e) { /* drop-silent — a failed clear leaves history intact, no error surface needed */ }
        res.status(303); res.setHeader && res.setHeader("location", "/account/recently-viewed");
        return res.end ? res.end() : res.send("");
      });
    }

    // Product reviews — submission requires a logged-in customer AND a
    // verified purchase of the product (the gate, not just a badge).
    // Only mounts when both the reviews primitive and an order handle
    // (for the purchase check) are wired.
    if (deps.reviews && deps.order) {
      async function _reviewGateContext(req, res) {
        var slug = req.params && req.params.slug;
        var product = slug ? await deps.catalog.products.bySlug(slug) : null;
        if (!product) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        var cartCount = await _cartCountForReq(req);
        var purchased = await deps.order.hasPurchasedProduct(auth.customer_id, product.id);
        return { product: product, auth: auth, cartCount: cartCount, purchased: purchased };
      }

      function _reviewIneligible(res, ctx, code) {
        return _send(res, code, _reviewMessagePage(
          { shop_name: shopName, cart_count: ctx.cartCount },
          "Only verified buyers can review",
          "We can only accept a review for a product you've purchased. Make sure you're signed in with the account you ordered with.",
          { href: "/products/" + ctx.product.slug, label: "Back to product" },
        ));
      }

      router.get("/products/:slug/review", async function (req, res) {
        var ctx = await _reviewGateContext(req, res);
        if (!ctx) return;
        if (!ctx.purchased) return _reviewIneligible(res, ctx, 200);
        _send(res, 200, renderReviewForm({
          product:    { title: ctx.product.title, slug: ctx.product.slug },
          shop_name:  shopName,
          cart_count: ctx.cartCount,
        }));
      });

      router.post("/products/:slug/review", async function (req, res) {
        var ctx = await _reviewGateContext(req, res);
        if (!ctx) return;
        // Re-check the gate on write — a client can POST directly
        // without ever fetching the form.
        if (!ctx.purchased) return _reviewIneligible(res, ctx, 403);
        var body = req.body || {};
        try {
          await deps.reviews.submit({
            product_id:        ctx.product.id,
            customer_id:       ctx.auth.customer_id,
            rating:            parseInt(body.rating, 10),
            title:             body.title,
            body:              body.body,
            verified_purchase: 1,
          });
        } catch (e) {
          // Shape rejections bounce back to the form with the reason;
          // anything else is a real 500.
          if (e instanceof TypeError) {
            return _send(res, 400, renderReviewForm({
              product:    { title: ctx.product.title, slug: ctx.product.slug },
              notice:     (e && e.message) || "Please check your review and try again.",
              shop_name:  shopName,
              cart_count: ctx.cartCount,
            }));
          }
          throw e;
        }
        _send(res, 200, _reviewMessagePage(
          { shop_name: shopName, cart_count: ctx.cartCount },
          "Thanks for your review",
          "Your review has been submitted and is pending moderation. It will appear on the product page once an operator approves it.",
          { href: "/products/" + ctx.product.slug, label: "Back to product" },
        ));
      });
    }

    // Product Q&A — asking a question requires a logged-in customer (no
    // verified-purchase gate; any signed-in shopper can ask). The
    // question lands `pending` and surfaces on the PDP once an operator
    // approves it. Customer-authored answers aren't accepted from the
    // storefront — answering is an operator action in the admin console
    // (the lib models customer answers, but exposing a public answer
    // form invites an unmoderated reply surface we don't ship in v1;
    // operators post the authoritative answer). Only mounts when the
    // productQa primitive is wired.
    if (deps.productQa) {
      async function _qaGateContext(req, res) {
        var slug = req.params && req.params.slug;
        var product = slug ? await deps.catalog.products.bySlug(slug) : null;
        if (!product) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
        var auth;
        try { auth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") { _serviceUnavailable(res, "auth not configured"); return null; }
          throw e;
        }
        if (!auth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          res.end ? res.end() : res.send("");
          return null;
        }
        var cartCount = await _cartCountForReq(req);
        return { product: product, auth: auth, cartCount: cartCount };
      }

      router.get("/products/:slug/question", async function (req, res) {
        var ctx = await _qaGateContext(req, res);
        if (!ctx) return;
        _send(res, 200, renderQuestionForm({
          product:    { title: ctx.product.title, slug: ctx.product.slug },
          shop_name:  shopName,
          cart_count: ctx.cartCount,
        }));
      });

      router.post("/products/:slug/question", async function (req, res) {
        var ctx = await _qaGateContext(req, res);
        if (!ctx) return;
        var body = req.body || {};
        try {
          await deps.productQa.submitQuestion({
            product_id:  ctx.product.id,
            customer_id: ctx.auth.customer_id,
            body:        body.body,
          });
        } catch (e) {
          // Shape rejections bounce back to the form with the reason;
          // anything else is a real 500.
          if (e instanceof TypeError) {
            return _send(res, 400, renderQuestionForm({
              product:    { title: ctx.product.title, slug: ctx.product.slug },
              notice:     (e && e.message) || "Please check your question and try again.",
              shop_name:  shopName,
              cart_count: ctx.cartCount,
            }));
          }
          throw e;
        }
        _send(res, 200, _qaMessagePage(
          { shop_name: shopName, cart_count: ctx.cartCount },
          "Thanks for your question",
          "Your question has been submitted and is pending moderation. It will appear on the product page once an operator approves and answers it.",
          { href: "/products/" + ctx.product.slug, label: "Back to product" },
        ));
      });
    }
  }

  // POST /cart/lines — add a line. Reads variant_id + qty from the
  // form body (b.middleware.bodyParser parses it into req.body).
  // CSRF token validation is the responsibility of the csrfProtect
  // middleware mounted at the app level (server.js). Redirects to
  // /cart on success so a refresh doesn't re-submit the form.
  router.post("/cart/lines", async function (req, res) {
    var body = req.body || {};
    var variantId = body.variant_id;
    var qtyRaw    = body.qty;
    var qty       = parseInt(qtyRaw, 10);
    if (!variantId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      return _send(res, 400, renderCheckoutError({
        shop_name: shopName, theme: theme,
        title_text: "We couldn't add that item",
        reason: "The product or quantity in that request wasn't valid. Pick the item again from its page.",
        back_href: "/cart", back_label: "Back to cart",
      }));
    }
    var resolved = await _getOrCreateCart(req, res, "USD");
    try {
      await deps.cart.addLine(resolved.cart.id, { variant_id: variantId, qty: qty });
    } catch (e) {
      var addMsg = (e && e.message) || "Error";
      return _send(res, e instanceof TypeError ? 400 : 500, renderCheckoutError({
        shop_name: shopName, theme: theme,
        title_text: "We couldn't add that item",
        reason: (e instanceof TypeError)
          ? "That item couldn't be added: " + addMsg
          : "Something went wrong adding that item to your cart. Please try again.",
        back_href: "/cart", back_label: "Back to cart",
      }));
    }
    // `?added=1` so the cart page can confirm the item landed (the page
    // surfaces an "Added to cart" status banner). Still a 303 so a refresh
    // re-issues the GET, not the POST.
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart?added=1");
    res.end ? res.end() : res.send("");
  });

  // POST /cart/bundle — add every member of a bundle to the cart at the
  // bundle price, atomically. Reads `bundle_sku` from the form body.
  // The price is recomputed server-side from the catalog + the bundle
  // primitive (the client sends only the SKU, never a price). The
  // bundle discount is allocated across the member lines proportional
  // to each member's list contribution, so the cart subtotal equals the
  // bundle's quoted price; integer-cent remainder lands on the last
  // line. Mounted only when the bundles primitive is wired.
  if (deps.bundles) {
    router.post("/cart/bundle", async function (req, res) {
      var body = req.body || {};
      var bundleSku = body.bundle_sku;
      if (!bundleSku || typeof bundleSku !== "string") {
        res.status(400);
        return res.end ? res.end("Invalid request") : res.send("Invalid request");
      }
      var currency = "USD";
      // Resolve + price the bundle. A malformed sku throws TypeError
      // (→ 400); an unknown sku resolves to no bundle (→ 404).
      var bundle, leaves, priced;
      try {
        bundle = await deps.bundles.getBundle(bundleSku);
        if (!bundle) {
          res.status(404);
          return res.end ? res.end("Bundle not found") : res.send("Bundle not found");
        }
        leaves = await deps.bundles.expand({ bundle_sku: bundleSku, quantity: 1 });
        priced = await deps.bundles.priceBundle({ bundle_sku: bundleSku, pricing: _skuPricer(currency) });
      } catch (e) {
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "Invalid bundle") : res.send((e && e.message) || "Invalid bundle");
        }
        res.status(500);
        return res.end ? res.end("Error") : res.send("Error");
      }

      // Pre-flight: every leaf must resolve to a buyable variant + a
      // current price. All-or-nothing — if any member is unavailable,
      // add nothing and bounce back to the PDP with a notice (no
      // half-filled cart). `leaf.quantity` is the per-bundle demand.
      var members = [];
      for (var i = 0; i < leaves.length; i += 1) {
        var leaf = leaves[i];
        var variant = await _skuBuyable(leaf.sku);
        if (!variant) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/cart?bundle=unavailable");
          return res.end ? res.end() : res.send("");
        }
        var price = await deps.catalog.prices.current(variant.id, currency);
        if (!price) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/cart?bundle=unavailable");
          return res.end ? res.end() : res.send("");
        }
        members.push({
          variant_id:   variant.id,
          qty:          leaf.quantity,
          list_each:    price.amount_minor,
          list_line:    price.amount_minor * leaf.quantity,
        });
      }

      // Allocate the bundle total across members proportional to each
      // member's list contribution, then express each share as an integer
      // per-unit price. The cart stores one integer unit price per line and
      // charges qty*unit, so flooring a share to a per-unit price loses up
      // to (qty-1) cents on a multi-unit line. Those cents are added back
      // below so the cart subtotal equals the bundle price exactly — never
      // undercharging the advertised bundle.
      var listTotal = priced.list_total_minor;
      var bundleTotal = priced.amount_minor;
      var allocated = 0;
      for (var m = 0; m < members.length; m += 1) {
        var mem = members[m];
        var share = listTotal > 0
          ? Math.floor((bundleTotal * mem.list_line) / listTotal)
          : Math.floor(bundleTotal / members.length);
        mem.alloc_line = share;
        allocated += share;
      }
      // The proportional floor leaves a whole-cent remainder; park it on the
      // last member's line so the per-line allocations sum to the bundle
      // total exactly.
      if (members.length > 0) members[members.length - 1].alloc_line += (bundleTotal - allocated);

      // Convert each member's line allocation to a uniform integer per-unit
      // price (floor) and tally the cents lost to that floor across all
      // lines. A single-unit line (the usual bundle shape) absorbs the whole
      // shortfall exactly; failing that, the cents are returned in qty-sized
      // steps to the smallest-quantity lines, with any final sub-step residual
      // rounded up onto the smallest line — so the realized subtotal is never
      // below the quoted bundle price.
      var lostCents = 0;
      for (var u = 0; u < members.length; u += 1) {
        var me = members[u];
        me.unit = me.qty > 0 ? Math.floor(me.alloc_line / me.qty) : me.alloc_line;
        lostCents += me.alloc_line - (me.unit * me.qty);
      }
      if (lostCents > 0 && members.length > 0) {
        var byQty = members.slice().sort(function (a, b) { return a.qty - b.qty; });
        var single = null;
        for (var s = 0; s < byQty.length; s += 1) { if (byQty[s].qty === 1) { single = byQty[s]; break; } }
        if (single) {
          single.unit += lostCents;
        } else {
          for (var g = 0; g < byQty.length && lostCents > 0; g += 1) {
            while (lostCents >= byQty[g].qty) { byQty[g].unit += 1; lostCents -= byQty[g].qty; }
          }
          if (lostCents > 0) { byQty[0].unit += 1; lostCents = 0; }
        }
      }

      var resolved = await _getOrCreateCart(req, res, currency);
      try {
        for (var k = 0; k < members.length; k += 1) {
          var mk = members[k];
          await deps.cart.addLine(resolved.cart.id, {
            variant_id:        mk.variant_id,
            qty:               mk.qty,
            unit_amount_minor: mk.unit,
            unit_currency:     currency,
          });
        }
      } catch (e) {
        res.status(e instanceof TypeError ? 400 : 500);
        return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
      }
      res.status(303);
      res.setHeader && res.setHeader("location", "/cart");
      res.end ? res.end() : res.send("");
    });
  }

  // POST /cart/lines/:line_id/update — change qty on an existing
  // line. Form value `qty` is the new quantity (1..99). HTML forms
  // only support GET/POST so the verb is in the path.
  router.post("/cart/lines/:line_id/update", async function (req, res) {
    var lineId = req.params && req.params.line_id;
    var qty    = parseInt((req.body || {}).qty, 10);
    if (!lineId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    try {
      var updated = await deps.cart.updateLine(lineId, { qty: qty });
      if (!updated) {
        res.status(404);
        return res.end ? res.end("Line not found") : res.send("Line not found");
      }
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // POST /cart/lines/:line_id/remove — delete the line outright.
  router.post("/cart/lines/:line_id/remove", async function (req, res) {
    var lineId = req.params && req.params.line_id;
    if (!lineId) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    try {
      await deps.cart.removeLine(lineId);
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // Newsletter signup — POST /newsletter from the footer band.
  // Validates the address through `b.guardEmail`, idempotently
  // enrolls via the newsletter primitive (when wired), and renders
  // a designed thank-you page. Mount only when `deps.newsletter`
  // is present so operators that haven't wired the primitive get
  // a clean 404 instead of a misleading "thanks" response.
  if (deps.newsletter) {
    router.post("/newsletter", async function (req, res) {
      var body = req.body || {};
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      try {
        var result = await deps.newsletter.signup({
          email:  body.email,
          source: "storefront-footer",
        });
        return _send(res, 200, renderNewsletterThanks({
          shop_name:  shopName,
          cart_count: cartCount,
          status:     result.status,
        }));
      } catch (e) {
        // TypeError == operator-fault validation refusal; everything
        // else (D1 unreachable, vault hiccup) hits the 500 branch.
        var isInputError = e instanceof TypeError;
        return _send(res, isInputError ? 400 : 500, renderNewsletterError({
          shop_name:  shopName,
          cart_count: cartCount,
          message:    isInputError ? "That doesn't look like a valid email address. Check the format and try again." : null,
        }));
      }
    });
  }

  // ---- cookie consent -----------------------------------------------------
  //
  // GDPR (EU 2016/679 art. 6 + 7) + ePrivacy (2002/58/EC art. 5(3)) opt-in
  // for non-strictly-necessary cookies. The banner ships in the chrome of
  // every page (see CONSENT_BANNER in the layout); these two routes back
  // it. No auth, no client JS required — the banner form and the manage
  // page both work server-rendered for a guest with scripting disabled.
  //
  // The decision is written to a sealed first-party cookie (the gate) AND
  // recorded in the cookie-consent ledger (the audit trail) when the
  // primitive is wired. CSRF / origin / fetch-metadata defenses are the
  // framework middleware already on every POST — no per-route re-check.

  // Same-origin path guard for `return_to`. Accepts a single leading slash
  // followed by a non-slash (so `//evil.example` and absolute URLs are
  // refused), capping length defensively. Anything else collapses to the
  // safe default the caller passes.
  function _consentReturnTo(raw, fallback) {
    if (typeof raw === "string" && raw.length <= 512 && /^\/[^/]/.test(raw)) return raw;
    return fallback;
  }

  // Translate a posted choice + per-category checkboxes into the four
  // toggleable booleans. `accept_all` turns every category on; `reject`
  // turns every category off; `granular` reads each `cat_<key>` checkbox
  // (present + "1" == on, absent == off — the unchecked-by-default
  // ePrivacy shape). Returns null for an unknown choice so the caller can
  // 400 a malformed submit.
  function _consentCategoriesFromBody(body) {
    var choice = body && body.choice;
    var cats = { functional: false, analytics: false, marketing: false, preferences: false };
    if (choice === "accept_all") {
      cats.functional = cats.analytics = cats.marketing = cats.preferences = true;
      return cats;
    }
    if (choice === "reject") {
      return cats;
    }
    if (choice === "granular") {
      for (var i = 0; i < CONSENT_TOGGLEABLE.length; i += 1) {
        var k = CONSENT_TOGGLEABLE[i];
        cats[k] = body["cat_" + k] === "1";
      }
      return cats;
    }
    return null;
  }

  // Ensure a session id exists so the consent decision is keyed to a
  // stable (hashed-at-the-ledger) session. Reuses the existing shop_sid
  // cookie when present; mints one otherwise — consent is a guest-
  // reachable flow, so it can't assume a cart already created the sid.
  function _ensureSid(req, res) {
    var sid = _readSidCookie(req);
    if (!sid) {
      sid = b.uuid.v7();
      _setSidCookie(res, sid);
    }
    return sid;
  }

  // POST /consent — set the decision. Drives both the banner (Accept all /
  // Reject) and the manage page's granular save. Writes the sealed gate
  // cookie + the non-sealed flag cookie, records the decision in the
  // cookie-consent ledger (best-effort — a ledger hiccup never blocks the
  // decision from taking effect), then 303s back to a safe same-origin
  // return_to.
  router.post("/consent", async function (req, res) {
    var body = req.body || {};
    var cats = _consentCategoriesFromBody(body);
    var fromManage = (typeof body.return_to === "string" && body.return_to.indexOf("/cookies") === 0);

    // Malformed (unknown / missing choice) → 400. Re-render the manage
    // page so the visitor lands somewhere actionable rather than on a
    // bare error string.
    if (!cats) {
      var cartCount400 = 0;
      try { cartCount400 = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      return _send(res, 400, renderCookiePreferences({
        shop_name:  shopName,
        cart_count: cartCount400,
        theme:      theme,
        decision:   _readConsentDecision(req, _liveConsentPolicy()),
        notice:     "invalid",
      }));
    }

    var sid = _ensureSid(req, res);
    var decision = {
      categories:     cats,
      policy_version: _liveConsentPolicy(),
      ts:             Date.now(),
    };
    _setConsentCookies(res, decision);

    // Durable audit trail. The cookie-consent ledger hashes the session id
    // itself; we pass the raw sid + the browser DNT / GPC signals + a
    // coarse UA class so the operator can prove to a supervisory authority
    // both what was chosen and that a browser-level opt-out was honored.
    if (deps.cookieConsent) {
      try {
        await deps.cookieConsent.recordConsent({
          session_id: sid,
          categories: cats,
          ua_class:   _uaClass(req),
          dnt:        _dntSignal(req),
          gpc:        _gpcSignal(req),
        });
      } catch (_e) { /* drop-silent — the gate cookie is authoritative; the ledger write is the audit trail and must not block the decision */ }
    }

    var dest = _consentReturnTo(body.return_to, "/");
    res.status(303);
    res.setHeader && res.setHeader("location", fromManage ? "/cookies?saved=1" : dest);
    return res.end ? res.end() : res.send("");
  });

  // GET /cookies — the preference center. Linked from the footer's
  // "Manage cookies" and the banner's "Manage preferences". Pre-checks
  // each toggle from the stored decision (all off when none exists). The
  // `?saved=1` query renders a confirmation notice after a save 303.
  router.get("/cookies", async function (req, res) {
    var cartCount = 0;
    try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
    var saved = false;
    try {
      var u = new URL(req.url, "http://localhost");
      saved = u.searchParams.get("saved") === "1";
    } catch (_e) { saved = false; }
    return _send(res, 200, renderCookiePreferences({
      shop_name:  shopName,
      cart_count: cartCount,
      theme:      theme,
      decision:   _readConsentDecision(req, _liveConsentPolicy()),
      notice:     saved ? "saved" : null,
    }));
  });

  // robots.txt — minimal crawl policy. Allow everything except
  // the admin API + cart + account + checkout / pay / orders (these
  // are session-scoped or operator-only, no crawl value), and
  // point at the sitemap. Operators with stricter requirements
  // replace the file at the same path via R2 (the Worker's
  // static-asset bridge would serve it ahead of this route if a
  // `robots.txt` key exists in the bucket).
  router.get("/robots.txt", function (req, res) {
    res.status(200);
    res.setHeader && res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=3600");
    var hostHeader = req.headers && (req.headers.host || req.headers.Host) || "";
    var origin = hostHeader ? ("https://" + hostHeader) : "";
    var body =
      "User-agent: *\n" +
      "Allow: /\n" +
      "Disallow: /admin\n" +
      "Disallow: /cart\n" +
      "Disallow: /checkout\n" +
      "Disallow: /pay/\n" +
      "Disallow: /orders/\n" +
      "Disallow: /account\n" +
      (origin ? ("Sitemap: " + origin + "/sitemap.xml\n") : "");
    res.end ? res.end(body) : res.send(body);
  });

  // sitemap.xml — lists every active product slug + the home page
  // + the framework-API landing. Cached short (5 minutes) so a
  // catalog update propagates without an operator action. The XML
  // is hand-rolled (no node:xml dep) because the surface is
  // ~3 fields per row and the XML-escape is trivial.
  router.get("/sitemap.xml", async function (req, res) {
    // XML 1.0 §4.6 names `&apos;` for apostrophe but also accepts the
    // numeric reference `&#x27;` — which is what b.template.escapeHtml
    // emits, so the same primitive works for the sitemap.
    function _xmlEsc(s) { return b.template.escapeHtml(s); }
    var hostHeader = req.headers && (req.headers.host || req.headers.Host) || "";
    var origin = hostHeader ? ("https://" + hostHeader) : "";
    var urls = [];
    // The home page + the public legal pages. `/admin` is intentionally
    // omitted — robots.txt disallows it, so listing it in the sitemap
    // would contradict the crawl policy.
    urls.push({ loc: origin + "/",        changefreq: "daily",   priority: "1.0" });
    urls.push({ loc: origin + "/privacy", changefreq: "yearly",  priority: "0.3" });
    urls.push({ loc: origin + "/terms",   changefreq: "yearly",  priority: "0.3" });
    try {
      var page = await deps.catalog.products.list({ status: "active", limit: 1000 });
      for (var i = 0; i < page.rows.length; i += 1) {
        var p = page.rows[i];
        var lastmod = new Date(p.updated_at || p.created_at || Date.now()).toISOString().slice(0, 10);
        urls.push({
          loc:        origin + "/products/" + p.slug,
          lastmod:    lastmod,
          changefreq: "weekly",
          priority:   "0.8",
        });
      }
    } catch (_e) { /* drop-silent — catalog unreachable means sitemap drops product rows */ }
    // Active category browse pages, when the categoryNavigation primitive
    // is wired. `tree({})` returns the full nested active tree (archived
    // rows already dropped); we flatten it to one URL per category. Best-
    // effort — a read failure drops the category rows rather than 500-ing
    // the sitemap.
    if (deps.categoryNavigation && typeof deps.categoryNavigation.tree === "function") {
      try {
        var catTree = await deps.categoryNavigation.tree({});
        var stack = Array.isArray(catTree) ? catTree.slice() : [];
        while (stack.length) {
          var node = stack.pop();
          if (node && node.active && node.slug) {
            urls.push({ loc: origin + "/categories/" + node.slug, changefreq: "weekly", priority: "0.6" });
          }
          if (node && Array.isArray(node.children)) {
            for (var cj = 0; cj < node.children.length; cj += 1) stack.push(node.children[cj]);
          }
        }
      } catch (_e) { /* drop-silent — categories unreachable drops those rows */ }
    }
    // Active collection browse pages, when the collections primitive is
    // wired. Same best-effort discipline.
    if (deps.collections && typeof deps.collections.list === "function") {
      try {
        var cols = await deps.collections.list({ active_only: true });
        for (var coi = 0; coi < cols.length; coi += 1) {
          if (cols[coi] && cols[coi].slug) {
            urls.push({ loc: origin + "/collections/" + cols[coi].slug, changefreq: "weekly", priority: "0.6" });
          }
        }
      } catch (_e) { /* drop-silent — collections unreachable drops those rows */ }
    }
    var body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" +
               "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n";
    for (var u = 0; u < urls.length; u += 1) {
      var item = urls[u];
      body += "  <url>\n";
      body += "    <loc>" + _xmlEsc(item.loc) + "</loc>\n";
      if (item.lastmod) body += "    <lastmod>" + _xmlEsc(item.lastmod) + "</lastmod>\n";
      body += "    <changefreq>" + _xmlEsc(item.changefreq) + "</changefreq>\n";
      body += "    <priority>" + _xmlEsc(item.priority) + "</priority>\n";
      body += "  </url>\n";
    }
    body += "</urlset>\n";
    res.status(200);
    res.setHeader && res.setHeader("content-type", "application/xml; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=300");
    res.end ? res.end(body) : res.send(body);
  });

  // Designed admin landing — the rest of /admin/* is JSON. This
  // single GET gives footer links + curious visitors a designed
  // page explaining the API-only posture instead of a 404.
  router.get("/admin", async function (req, res) {
    var cartCount = 0;
    try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
    _send(res, 200, renderAdminLanding({
      shop_name:  shopName,
      cart_count: cartCount,
    }));
  });

  // Catch-all 404 — every unmatched route lands on the designed
  // not-found page (gradient 404 + back-to-shop CTA) inside the
  // standard layout, instead of the framework's default
  // `<h1>404 Not Found</h1>` text body. Wired via the router's
  // onNotFound hook so it covers GET/POST/HEAD uniformly.
  if (typeof router.onNotFound === "function") {
    router.onNotFound(async function (req, res) {
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      _send(res, 404, renderNotFound({
        shop_name:  shopName,
        cart_count: cartCount,
        theme:      theme,
      }));
    });
  }
}

module.exports = {
  mount:                 mount,
  webhookRawBodyCapture: webhookRawBodyCapture,
  renderHome:            renderHome,
  renderSearch:          renderSearch,
  renderProduct:         renderProduct,
  renderCart:            renderCart,
  renderCheckoutForm:    renderCheckoutForm,
  renderCheckoutError:   renderCheckoutError,
  renderGiftCardBalance: renderGiftCardBalance,
  renderPayPage:         renderPayPage,
  renderOrder:           renderOrder,
  renderAccountLogin:    renderAccountLogin,
  renderAccountRegister: renderAccountRegister,
  renderAccount:         renderAccount,
  renderPasskeys:        renderPasskeys,
  renderPasskeyRemoveConfirm: renderPasskeyRemoveConfirm,
  renderProfile:         renderProfile,
  renderAccountSubscriptions: renderAccountSubscriptions,
  renderCookiePreferences: renderCookiePreferences,
  renderNotFound:        renderNotFound,
  // Layout exposed so operators forking the framework can override.
  _wrap:                 _wrap,
  LAYOUT:                LAYOUT,
};
