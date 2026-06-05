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
var securityMiddleware = require("./security-middleware");
var giftRegistryModule = require("./gift-registry");

// Registry occasion values, sourced from the gift-registry primitive so the
// storefront's <select> options never drift from the column CHECK enum the
// migration enforces. The primitive is the single source of truth.
var REGISTRY_OCCASIONS = giftRegistryModule.OCCASIONS;
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

// Storefront error logger. Routes through the framework's structured
// log sink (not console) so operators can redirect / quiet / structured-
// log every emission point, and so the per-request id the createApp
// requestId middleware allocates is auto-bound to each line. Used by the
// 5xx auth-route handlers to record the real failure server-side while
// the client only ever sees a generic message + the correlating id.
var _log = b.log.create({});

// Generic 500 for an auth/ceremony route: log the real error server-side
// (correlated by the framework request id) and return a fixed message to
// the client so no internal error string (stack frame, DB column, vault
// internals) leaks. The request id — set by the createApp requestId
// middleware on req.requestId and echoed in the X-Request-Id response
// header — rides in the body so an operator can grep the logs for a
// customer's failed ceremony. `where` names the route for the log line
// only; it is not reflected to the client.
function _authServerError(req, res, e, where) {
  var rid = (req && req.requestId) || null;
  _log.error("storefront auth route failed", {
    route:      where,
    request_id: rid,
    err:        (e && e.message) || String(e),
  });
  res.status(500);
  var ref = rid ? " (ref " + rid + ")" : "";
  var msg = "Something went wrong. Please try again." + ref;
  return res.end ? res.end(msg) : res.send(msg);
}

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

// Splice a fully-rendered HTML fragment into `html` at the first
// occurrence of a literal `RAW_*` token, inserting the fragment LITERALLY.
//
// `String.prototype.replace(token, replacementString)` gives the
// replacement string special meaning to `$` sequences — `$$`, `$&`,
// `` $` `` (the text before the match), `$'` (the text after the match),
// `$1`. A page/blog body that contains a dollar followed by a backtick
// would otherwise splice the entire document HEAD into the body, and any
// other dollar sequence corrupts the output. The fragment is already
// escaped/rendered at its own build site, so this is purely about the
// replace mechanics: passing a REPLACER FUNCTION makes `String.replace`
// insert the return value verbatim, with no dollar interpretation. Use
// this for every dynamic (operator- or customer-supplied) fragment swap.
function _spliceRaw(html, token, fragment) {
  return html.replace(token, function () { return fragment == null ? "" : String(fragment); });
}

// ---- double-submit CSRF token injection ---------------------------------

// The container's authenticated state-changing forms (account /
// subscriptions / checkout / address / passkey-revoke / survey / …) carry a
// hidden `_csrf` field whose value matches the `__Host-csrf` / `csrf`
// double-submit cookie, so a real browser (and the e2e harness) submits a
// token the `csrfGuard` (lib/security-middleware) accepts. The token is
// resolved per request and stashed on the locale ALS by `localeMiddleware`,
// then read back here when the page HTML is assembled in `_wrap`.
//
// EDGE_POST_PATHS forms are skipped: those are the edge-cached, cookie-less,
// dual-rendered forms (cart-add, consent, currency, newsletter, wishlist /
// compare toggle, announcement dismiss) whose container twins must stay
// byte-identical to the edge copy (the render-parity gate). They keep their
// SameSite + fetch-metadata defense and are exempt from the token check, so
// tokening only the container copy would both break parity and 403 a no-JS
// edge submission. The exempt list is the SAME prefix set the guard exempts,
// imported from lib/security-middleware so the two never drift.
var _EDGE_POST_PATHS = securityMiddleware.EDGE_POST_PATHS;

// The escaper the storefront uses for every attribute interpolation
// (b.template.escapeHtml — attribute-safe; escapes & < > " '). Aliased so the
// rewrite reads as "escape this attribute value".
var _escAttr = b.template.escapeHtml;

function _actionIsEdgeExempt(action) {
  for (var i = 0; i < _EDGE_POST_PATHS.length; i += 1) {
    if (action.indexOf(_EDGE_POST_PATHS[i]) === 0) return true;
  }
  return false;
}

// Inject a hidden `_csrf` field into every container POST form in `html`
// whose action is NOT an EDGE_POST_PATHS prefix. Operates on the fully
// assembled page body: each `<form …>` open tag is parsed for its `method`
// (POST only — GET forms carry no ambient-credential CSRF risk) and `action`
// (an action covered by an edge prefix is left untouched for render-parity; a
// form with no action posts to the current container page, which is never
// edge-exempt, so it IS tokened). The token comes from the per-request locale
// ALS; absent a token (a renderer reached outside a request, or a request
// where the guard issued none) the field is omitted — there is nothing to
// submit and the guard would not be checking this request anyway.
//
// The hidden input is spliced immediately after the form's open tag so it is
// the first child (valid HTML; never lands between a `<select>`/`<option>`).
// The form's existing markup is preserved byte-for-byte.
function _injectCsrfFields(html, token) {
  if (!token || typeof html !== "string" || html.indexOf("<form") === -1) return html;
  var field = "<input type=\"hidden\" name=\"_csrf\" value=\"" + _escAttr(token) + "\">";
  // Match each form open tag: `<form` … `>` (non-greedy, no nested `>` —
  // attribute values here never contain a literal `>`). The replacer decides
  // per-tag whether to splice the field in.
  return html.replace(/<form\b[^>]*>/gi, function (openTag) {
    var method = openTag.match(/\bmethod\s*=\s*["']?([a-z]+)/i);
    // No method, or a non-POST method (GET / dialog) → leave untouched.
    if (!method || method[1].toLowerCase() !== "post") return openTag;
    var actionMatch = openTag.match(/\baction\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    var action = actionMatch ? (actionMatch[2] != null ? actionMatch[2]
                              : actionMatch[3] != null ? actionMatch[3]
                              : actionMatch[4]) : "";
    // Edge-exempt action (cart-add / consent / currency / newsletter / …) →
    // leave untouched so the container copy stays byte-identical to the edge.
    if (action && _actionIsEdgeExempt(action)) return openTag;
    return openTag + field;
  });
}

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
  "RAW_ROBOTS_META" +
  "RAW_HREFLANG" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"manifest\" href=\"/manifest.webmanifest\">\n" +
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
  "      RAW_PRIMARY_NAV\n" +
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
  "        <h2>{{footer_shop_heading}}</h2>\n" +
  "        <ul>\n" +
  "          <li><a href=\"/\">{{footer_shop_all}}</a></li>\n" +
  "          <li><a href=\"/collections\">{{footer_shop_collections}}</a></li>\n" +
  "          <li><a href=\"/categories\">{{footer_shop_categories}}</a></li>\n" +
  "          <li><a href=\"/compare\">{{footer_shop_compare}}</a></li>\n" +
  "          <li><a href=\"/cart\">{{footer_shop_cart}}</a></li>\n" +
  "          <li><a href=\"/terms\">{{footer_shop_shipping}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h2>{{footer_framework_heading}}</h2>\n" +
  "        <ul>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">{{footer_framework_source}}</a></li>\n" +
  "          <li><a href=\"https://github.com/blamejs/blamejs\" rel=\"noopener\">{{footer_framework_core}}</a></li>\n" +
  "          <li><a href=\"/SECURITY.md\">{{footer_framework_security}}</a></li>\n" +
  "          <li><a href=\"/CHANGELOG.md\">{{footer_framework_changelog}}</a></li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <div class=\"site-footer__col\">\n" +
  "        <h2>{{footer_operators_heading}}</h2>\n" +
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

// Whether the Collections / Categories routes are mounted (deps wired).
// The header links + the mobile-disclosure entries render only when their
// route exists, so a store that hasn't wired the primitive never shows a
// link that 404s. Set once at mount (alongside `_ccyEnabled`), read in the
// nav builder. Default true so a pure render of a page (a unit test calling
// `renderHome` without mounting) shows the full nav; the route-level
// conditional only suppresses a link when the mount explicitly lacks the dep.
var _hasCollections = true;
var _hasCategoryNav = true;

// The account-icon + cart-pill SVGs, lifted verbatim from the prior LAYOUT
// nav so the builder emits the same chrome. Kept byte-identical to the edge
// headers (worker/render/*.js).
var _NAV_ACCOUNT_SVG = "<svg viewBox=\"0 0 24 24\" width=\"20\" height=\"20\" aria-hidden=\"true\"><path d=\"M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg>";
var _NAV_CART_SVG    = "<svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\"><path d=\"M3 4h2l2.4 12.1a2 2 0 0 0 2 1.6h7.6a2 2 0 0 0 1.95-1.55L21 8H6\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/><circle cx=\"10\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/><circle cx=\"17\" cy=\"21\" r=\"1.4\" fill=\"currentColor\"/></svg>";
var _NAV_MENU_SVG    = "<svg viewBox=\"0 0 24 24\" width=\"22\" height=\"22\" aria-hidden=\"true\"><path d=\"M4 7h16M4 12h16M4 17h16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.75\" stroke-linecap=\"round\"/></svg>";

// Primary nav builder — a desktop link row (`.site-nav__links`) PLUS a
// CSP-safe <details>/<summary> disclosure (`.site-nav__menu`) carrying the
// same links for narrow viewports. The CSS shows one or the other by
// breakpoint (the inline row hides at <=48rem; the disclosure hides above
// it). No JS — the browser drives open/close. Collections / Categories
// render only when `hasCollections` / `hasCategories` (their routes mounted).
// All labels are chrome strings, escaped at the sink. Kept byte-identical to
// the static nav in every worker/render/*.js header (the edge renders the
// two extra links unconditionally — accepted divergence; the byte-compare
// test wires both container deps so the markup matches).
function _buildNavLinks(chrome, hasCollections, hasCategories, indent) {
  var esc = b.template.escapeHtml;
  return indent + "<a class=\"site-nav__link\" href=\"/\">" + esc(chrome.nav_shop) + "</a>\n" +
    (hasCollections ? indent + "<a class=\"site-nav__link\" href=\"/collections\">" + esc(chrome.nav_collections) + "</a>\n" : "") +
    (hasCategories ? indent + "<a class=\"site-nav__link\" href=\"/categories\">" + esc(chrome.nav_categories) + "</a>\n" : "") +
    indent + "<a class=\"site-nav__link\" href=\"/#framework\">" + esc(chrome.nav_framework) + "</a>\n";
}
function _buildPrimaryNav(chrome, cartCount, cartAria, hasCollections, hasCategories) {
  var esc = b.template.escapeHtml;
  return "<nav class=\"site-nav\" aria-label=\"Primary\">\n" +
    "        <div class=\"site-nav__links\">\n" +
    _buildNavLinks(chrome, hasCollections, hasCategories, "          ") +
    "        </div>\n" +
    "        <details class=\"site-nav__menu\">\n" +
    "          <summary class=\"site-nav__menu-toggle\" aria-label=\"" + esc(chrome.nav_menu) + "\">" + _NAV_MENU_SVG + "<span class=\"site-nav__menu-label\">" + esc(chrome.nav_menu) + "</span></summary>\n" +
    "          <div class=\"site-nav__drawer\">\n" +
    _buildNavLinks(chrome, hasCollections, hasCategories, "            ") +
    "          </div>\n" +
    "        </details>\n" +
    "        <a class=\"site-nav__icon\" href=\"/account\" aria-label=\"" + esc(chrome.nav_account) + "\">" + _NAV_ACCOUNT_SVG + "</a>\n" +
    "        <a class=\"cart-pill\" href=\"/cart\" aria-label=\"" + esc(cartAria) + "\">" + _NAV_CART_SVG + "<span class=\"cart-pill__count\">" + esc(String(cartCount)) + "</span></a>\n" +
    "      </nav>";
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
  // Absolute request URL drives both `og:url` (full URL incl. query) and
  // the canonical link (query stripped — the canonical names the page,
  // not the filtered/sorted view). Renderers thread `opts.canonical_url`
  // + `opts.og_url` (built by `_requestUrls` in the route handler); absent
  // them (a unit test calling the renderer directly), both stay empty
  // rather than emit a bogus host-less URL.
  var canonicalUrl = opts.canonical_url || "";
  var ogUrl         = opts.og_url       || canonicalUrl;
  // og:image / twitter:image carry a FULLY-QUALIFIED URL — a relative
  // `/assets/...` (the brand-logo default, or a product hero) is dropped by
  // every social-share crawler (Facebook / Slack / Twitter / iMessage) and
  // by Google's rich result. Absolutize against the page origin so the
  // share preview resolves; an operator-hosted `http(s)://` image passes
  // through unchanged. Every container page funnels through `_wrap`, so
  // this is the single absolutization site for the storefront's meta tags.
  var ogImage       = _absolutizeOgImage(opts.og_image || "/assets/brand/logo.png", canonicalUrl, shopName);
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
    body:           "RAW_BODY_PLACEHOLDER",
  };
  // Layer in every chrome string the LAYOUT references. The nav chrome
  // strings (`nav_shop` / `nav_collections` / `nav_categories` /
  // `nav_framework` / `nav_account` / `nav_menu` / `nav_cart_aria`) are
  // NOT referenced by the LAYOUT const — the nav is raw-spliced via
  // `RAW_PRIMARY_NAV` from `_buildPrimaryNav` so the Collections/Categories
  // links can render conditionally. The strict `_render` refuses an unused
  // placeholder, so those keys are skipped here. Likewise the two
  // `locale_switcher_*` strings live only inside the switcher form (spliced
  // via RAW_LOCALE_SWITCHER).
  var chromeKeys = Object.keys(chrome);
  for (var ci = 0; ci < chromeKeys.length; ci += 1) {
    var ck = chromeKeys[ci];
    if (ck === "nav_shop" || ck === "nav_collections" || ck === "nav_categories" ||
        ck === "nav_framework" || ck === "nav_account" || ck === "nav_menu" ||
        ck === "nav_cart_aria" ||
        ck === "locale_switcher_label" || ck === "locale_switcher_submit") continue;
    vars[ck] = chrome[ck];
  }

  // Per-page robots directive. Indexable pages (the default) emit no
  // robots meta — the absence means "index, follow". Pages the storefront
  // keeps out of search pass a directive:
  //   - `noindex` → `noindex,nofollow`. Session-scoped surfaces (cart /
  //     account) whose links are all session-scoped too, so there's
  //     nothing for a crawler to follow.
  //   - `noindex,follow` → `noindex,follow`. Internal search result pages
  //     are thin/duplicate indexable URLs (one per query + facet combo) —
  //     keep the query URL out of the index but let crawlers follow the
  //     product links the page lists.
  // It's a belt-and-suspenders pairing with the robots.txt Disallow + the
  // edge `x-robots-tag` header, so a directly-fetched page is also
  // self-describing. A noindex page needs no canonical (a crawler won't
  // index it to dedupe), so these pages don't thread a canonical_url.
  var robotsMeta = (opts.robots === "noindex,follow")
    ? "  <meta name=\"robots\" content=\"noindex,follow\">\n"
    : (opts.robots === "noindex")
      ? "  <meta name=\"robots\" content=\"noindex,nofollow\">\n"
      : "";

  // hreflang alternates — pre-rendered HTML seeded onto the locale ALS
  // store by `localeMiddleware` (kept synchronous so it reaches the
  // handler), or threaded explicitly by a renderer/unit test. Empty for a
  // single-locale store or a cookie/accept-language strategy (no URL-shaped
  // alternates to emit). Byte-identical to the edge's `alternateLinks`
  // output for the same (host, path, supported, default, strategy) — a
  // parity test pins the two.
  var hreflangHtml = (typeof opts.alternate_links === "string")
    ? opts.alternate_links
    : ((storeCtx && typeof storeCtx.alternate_links === "string") ? storeCtx.alternate_links : "");
  var assembled = _render(LAYOUT, vars)
    .replace("RAW_CSS_INTEGRITY", themeCssIntegrity)
    .replace("RAW_ROBOTS_META", robotsMeta)
    .replace("RAW_HREFLANG", hreflangHtml)
    .replace("RAW_CONSENT_SCRIPT", _islandScript("consent.js", { id: "consent-island", policy: _activeConsentPolicy }))
    .replace("RAW_CART_COUNT_SCRIPT", _islandScript("cart-count.js", { id: "cart-count-island" }))
    .replace("RAW_ANNOUNCEMENT_SCRIPT", announcementScript)
    .replace("RAW_CURRENCY_SWITCHER", switcherHtml)
    .replace("RAW_LOCALE_SWITCHER", localeCtx.switcher_html || "");
  // The announcement bar carries operator-supplied message text (HTML-
  // escaped, but `$` is not an escaped character), so splice it via the
  // replacer-function helper — a `$&` / `` $` `` / `$N` in the message must
  // land literally, not trigger `String.replace`'s dollar substitution.
  // Matches the edge renderers' `spliceRaw` so the dual-render stays
  // byte-consistent under a `$`-bearing announcement. See `_spliceRaw`.
  assembled = _spliceRaw(assembled, "RAW_ANNOUNCEMENT_BAR", announcementBarHtml);
  // Primary nav — a raw splice (post strict-render) so the chrome strings
  // it consumes (nav_shop / nav_collections / nav_categories /
  // nav_framework / nav_account / nav_menu / nav_cart_aria) need no LAYOUT
  // `{{}}` placeholder, and the Collections/Categories links render only
  // when their routes are mounted. Escaped values are spliced via the
  // replacer-function helper so a `$`-sequence lands literally.
  assembled = _spliceRaw(assembled, "RAW_PRIMARY_NAV",
    _buildPrimaryNav(chrome, cartCount, cartAria, _hasCollections, _hasCategoryNav));
  // The body is RAW HTML (already rendered + escaped at the
  // per-fragment level). The placeholder swap is post-render so the
  // outer renderer's HTML-escape doesn't double-escape the inner
  // markup, and routes through `_spliceRaw` so a body carrying a `$`
  // sequence (a blog/CMS post, a reflected query) is inserted literally
  // rather than triggering `String.replace`'s dollar-substitution.
  // `search_q` is HTML-escaped by the renderer like any
  // other placeholder, so a customer-supplied query like
  // `"><script>` lands as escaped text inside the input's `value`.
  //
  assembled = _spliceRaw(assembled, "RAW_BODY_PLACEHOLDER", opts.body);
  // Final pass: token the container's authenticated POST forms with the
  // per-request double-submit CSRF value (stashed on the locale ALS by
  // `localeMiddleware`). EDGE_POST_PATHS forms are skipped to preserve
  // render-parity with the edge copy — see `_injectCsrfFields`.
  return _injectCsrfFields(assembled, storeCtx && storeCtx.csrf_token);
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

// PDP "You may also like" rail. `related` is the pre-decorated card
// list [{ slug, title, price, image_url, image_alt }] the PDP renderer
// builds from the same-collection picks. Reuses the catalog grid +
// product-card markup so it inherits the storefront's card styling.
// Returns "" when there's nothing to show so the PDP renders no empty
// rail. Mirrored byte-for-byte by worker/render/product.js#_buildRelatedProducts.
function _buildRelatedProducts(related) {
  related = related || [];
  if (related.length === 0) return "";
  var cards = related.map(function (p) { return _buildProductCard(p); }).join("");
  return "<section class=\"catalog-section pdp-recommendations\" aria-labelledby=\"pdp-related-title\">" +
           "<header class=\"section-head\"><h2 id=\"pdp-related-title\" class=\"section-head__title\">You may also like</h2></header>" +
           "<div class=\"grid\">" + cards + "</div>" +
         "</section>";
}

// Home "Featured collections" band — the six decorative card-art SVGs
// lifted verbatim from the prior static band, indexed 1..6. The dynamic
// builder rotates through them by position so an operator's collections
// keep the band's designed look without per-collection iconography. Kept
// byte-identical to worker/render/home.js#COLLECTION_BAND_ART so the dual
// render agrees.
var COLLECTION_BAND_ART = [
  "<div class=\"collection-card__art collection-card__art--1\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M70 38 C74 44 86 44 90 38 L104 44 L112 58 L100 64 L96 58 L96 92 L64 92 L64 58 L60 64 L48 58 L56 44 Z\"/><path d=\"M71 40 C75 47 85 47 89 40\" stroke=\"#732A8D\" stroke-width=\"2\"/><path d=\"M73 76 H87\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-dasharray=\"2 3\"/></svg></div>",
  "<div class=\"collection-card__art collection-card__art--2\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"58\" y=\"38\" width=\"44\" height=\"44\" rx=\"4\"/><rect x=\"70\" y=\"50\" width=\"20\" height=\"20\" rx=\"2\" stroke=\"#732A8D\"/><circle cx=\"80\" cy=\"60\" r=\"3\" fill=\"#AD38DB\" stroke=\"none\"/><path d=\"M66 38 V30 M76 38 V30 M86 38 V30 M96 38 V30\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M66 82 V90 M76 82 V90 M86 82 V90 M96 82 V90\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M58 48 H50 M58 60 H50 M58 72 H50\" stroke=\"currentColor\" stroke-width=\"2\"/><path d=\"M102 48 H110 M102 60 H110 M102 72 H110\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>",
  "<div class=\"collection-card__art collection-card__art--3\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M60 74 C50 74 48 62 57 59 C56 47 73 43 79 53 C88 47 100 54 97 64 C107 65 107 74 99 74 Z\" stroke=\"#732A8D\"/><path d=\"M78 60 V86\"/><path d=\"M70 78 L78 88 L86 78\"/><path d=\"M64 98 H92\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>",
  "<div class=\"collection-card__art collection-card__art--4\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M56 50 A26 26 0 0 1 104 56\"/><path d=\"M104 70 A26 26 0 0 1 56 64\"/><path d=\"M104 42 L106 57 L91 55\" stroke=\"#AD38DB\"/><path d=\"M56 78 L54 63 L69 65\" stroke=\"#AD38DB\"/><circle cx=\"80\" cy=\"60\" r=\"6\" stroke=\"#732A8D\"/><circle cx=\"80\" cy=\"60\" r=\"1.6\" fill=\"currentColor\" stroke=\"none\"/></svg></div>",
  "<div class=\"collection-card__art collection-card__art--5\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M86 36 L106 44 L106 64 L86 72 L66 64 L66 44 Z\" stroke=\"#732A8D\"/><path d=\"M66 44 L86 52 L106 44 M86 52 V72\" stroke=\"#732A8D\"/><path d=\"M70 56 L90 64 L90 88 L70 96 L50 88 L50 64 Z\"/><path d=\"M50 64 L70 72 L90 64 M70 72 V96\"/><path d=\"M70 72 V96\" stroke=\"currentColor\" stroke-width=\"2\"/></svg></div>",
  "<div class=\"collection-card__art collection-card__art--6\" aria-hidden=\"true\"><svg class=\"collection-card__icon\" viewBox=\"0 0 160 120\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"48\" y=\"48\" width=\"64\" height=\"42\" rx=\"6\"/><path d=\"M80 48 V90\" stroke=\"#732A8D\"/><path d=\"M80 48 C71 36 56 39 62 49 C57 52 61 57 71 53 C76 51 80 50 80 48 Z\"/><path d=\"M80 48 C89 36 104 39 98 49 C103 52 99 57 89 53 C84 51 80 50 80 48 Z\"/><circle cx=\"80\" cy=\"48\" r=\"2.4\" fill=\"#AD38DB\" stroke=\"none\"/><rect x=\"56\" y=\"70\" width=\"11\" height=\"8\" rx=\"1.6\" stroke=\"currentColor\" stroke-width=\"1.8\"/></svg></div>",
];

// Home "Featured collections" band builder — operator collections (active,
// newest-curated first via collections.list, capped at 6) rendered as the
// existing collection-card grid. Each card links to /collections/<slug>;
// the decorative per-card art rotates through COLLECTION_BAND_ART by index.
// Returns "" when there are no collections to show — the caller drops the
// whole section, so a store with no collections shows hero → catalog with
// no empty band. Operator slug/title/description are escaped at the sink
// (escape-by-default; cross-customer free-text rendered to every visitor).
// A theme that owns its own home template never reaches this band; the
// data is still threaded so a theme can add a collections slot later.
// Kept byte-identical to worker/render/home.js#_buildCollectionsBand.
function _buildCollectionsBand(collections) {
  var esc = b.template.escapeHtml;
  var cols = Array.isArray(collections) ? collections.slice(0, 6) : [];
  if (cols.length === 0) return "";
  var cards = "";
  for (var i = 0; i < cols.length; i += 1) {
    var c = cols[i];
    var art = COLLECTION_BAND_ART[i % COLLECTION_BAND_ART.length];
    cards +=
      "    <a class=\"collection-card\" href=\"/collections/" + esc(c.slug) + "\">\n" +
      "      " + art + "\n" +
      "      <div class=\"collection-card__meta\">\n" +
      "        <h3>" + esc(c.title) + "</h3>\n" +
      (c.description ? "        <p>" + esc(c.description) + "</p>\n" : "") +
      "      </div>\n" +
      "    </a>\n";
  }
  return "<section class=\"collections\" aria-labelledby=\"collections-title\">\n" +
    "  <header class=\"section-head\">\n" +
    "    <p class=\"eyebrow\">Featured collections</p>\n" +
    "    <h2 id=\"collections-title\" class=\"section-head__title\">Browse the catalog by collection.</h2>\n" +
    "  </header>\n" +
    "  <div class=\"collections__grid\">\n" +
    cards +
    "  </div>\n" +
    "</section>\n";
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
  "RAW_COLLECTIONS_BAND\n" +
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
  "  <header class=\"section-head\">\n" +
  "    <div>\n" +
  "      <p class=\"eyebrow\">Catalog</p>\n" +
  "      <h2 class=\"section-head__title\">Products in store</h2>\n" +
  "      <p class=\"section-head__lede\">Server-rendered listings — every card, price, and link arrived on the wire as complete HTML.</p>\n" +
  "    </div>\n" +
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

  // Featured-collections band — operator collections (active, newest
  // first, capped at 6); the band is dropped entirely when there are
  // none. Spliced raw (replacer-function form, $-safe) since the
  // operator slug/title/description are escaped at the band's own sink.
  var collectionsBand = _buildCollectionsBand(opts.collections || []);
  var hero = _spliceRaw(
    _render(HOME_HERO, { product_count: heroProductCount })
      .replace("RAW_FEATURED_CALLOUT", featuredHtml),
    "RAW_COLLECTIONS_BAND", collectionsBand);
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

// Absolutize an og:image / twitter:image / JSON-LD image value against the
// page origin. A relative `/assets/...` path (the brand-logo default, or a
// hero R2 key joined onto the asset prefix) becomes `<origin>/assets/...`
// so every social-share crawler and rich-result fetch resolves it — a
// relative path is dropped by Facebook / Slack / Twitter / iMessage and by
// Google's product rich result. An already-absolute `http(s)://` value is
// left unchanged (an operator-hosted image), and a value that is neither a
// `/`-rooted path nor an absolute URL is returned as-is (nothing safe to
// prefix). Absolutizes only against a reliable origin: with a canonical URL
// the request origin is used; without one, the shop-name host is used ONLY
// when it is usable as a host (no whitespace) — a display-name shop such as
// "Test Shop" would otherwise emit an invalid "https://Test Shop/..." URL,
// so the path is left relative (it still resolves against the page on a
// crawler fetch). Mirrors the edge's worker/render/_lib.js `absolutizeOgImage`
// so the two substrates emit identical absolute image URLs.
function _absolutizeOgImage(value, canonicalUrl, shopName) {
  var v = (value == null) ? "" : String(value);
  if (/^https?:\/\//i.test(v)) return v;
  if (v.charAt(0) !== "/") return v;
  var hasCanonical = typeof canonicalUrl === "string" && canonicalUrl.length > 0;
  if (!hasCanonical && /\s/.test(String(shopName == null ? "" : shopName))) return v;
  return _absoluteBase(canonicalUrl, shopName) + v;
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

// The fixed search page size — the number of result cards one page of
// `/search` shows. Pages beyond the first are reached via `?page=N`
// links the pagination nav emits (the real total drives how many pages
// exist). Mirrors the edge renderer's SEARCH_PAGE_SIZE.
var SEARCH_PAGE_SIZE = 24;

// `/search?...` URL for a specific results page — the query + active
// filters carried forward (so paging preserves the facet state) with a
// `page` param appended for any page past the first. Page 1 omits the
// param so the canonical first page has one URL. Mirrors the edge
// renderer's `_searchPageUrl` byte-for-byte.
function _searchPageUrl(q, filters, page) {
  var base = _searchUrl(q, filters);
  if (page <= 1) return base;
  return base + (base.indexOf("?") === -1 ? "?" : "&") + "page=" + page;
}

var SEARCH_PAGE_LINK =
  "<li class=\"search-pagination__page\"><a class=\"search-pagination__link\" href=\"{{href}}\"{{aria_current}}>{{n}}</a></li>\n";

// Numbered prev/next pagination for the result grid. No-JS + SEO-
// friendly: every page is a real `?page=N` link carrying the active
// query + facets, `rel="prev"/"next"` mark the sequence, and the current
// page is `aria-current="page"`. Renders nothing for a single page (the
// default when a caller threads no total — keeps the unpaginated render
// byte-identical). `total` is the REAL match count (not the page slice
// length); `page` is the 1-based current page. Mirrors the edge
// renderer's `_renderSearchPagination` byte-for-byte.
function _renderSearchPagination(q, filters, total, page, pageSize) {
  var size = pageSize > 0 ? pageSize : SEARCH_PAGE_SIZE;
  var totalPages = Math.max(1, Math.ceil(total / size));
  if (totalPages <= 1) return "";
  var cur = page < 1 ? 1 : (page > totalPages ? totalPages : page);
  var prev = cur > 1
    ? _render("<a class=\"search-pagination__link search-pagination__prev\" href=\"{{href}}\" rel=\"prev\">Previous</a>\n",
        { href: _searchPageUrl(q, filters, cur - 1) })
    : "<span class=\"search-pagination__link search-pagination__prev is-disabled\" aria-disabled=\"true\">Previous</span>\n";
  var next = cur < totalPages
    ? _render("<a class=\"search-pagination__link search-pagination__next\" href=\"{{href}}\" rel=\"next\">Next</a>\n",
        { href: _searchPageUrl(q, filters, cur + 1) })
    : "<span class=\"search-pagination__link search-pagination__next is-disabled\" aria-disabled=\"true\">Next</span>\n";
  var pagesHtml = "";
  for (var n = 1; n <= totalPages; n += 1) {
    pagesHtml += _render(SEARCH_PAGE_LINK, {
      href:         _searchPageUrl(q, filters, n),
      aria_current: n === cur ? "RAW_ARIA" : "",
      n:            String(n),
    }).replace("RAW_ARIA", n === cur ? " aria-current=\"page\"" : "");
  }
  return "<nav class=\"search-pagination\" aria-label=\"Search results pages\">\n" +
    prev +
    "<ol class=\"search-pagination__pages\">\n" + pagesHtml + "</ol>\n" +
    next +
    "</nav>\n";
}

// The fixed collection page size — the number of product cards one page of
// `/collections/:slug` shows. Pages past the first are reached via the
// `?cursor=` trail the pagination nav emits. A collection is keyset/offset
// paginated by its lib (`collections.productsIn` returns an opaque,
// forward-only `next_cursor`); it exposes no total, so the page UI is a
// prev/next pair (not the numbered `/search` UI), reusing the same
// `search-pagination` shell + `rel="prev"/"next"` so no new CSS ships.
var COLLECTION_PAGE_SIZE = 24;

// Cursor characters are RFC 4648 base64url plus a single `.` tag separator —
// no `,`, `+`, `/`, or `=` — so a comma joins a list of page-start cursors
// into one URL-safe `?cursor=` value. This is the page trail: page 1 carries
// no `cursor`; each Next appends the page's `next_cursor`; each Previous
// drops the last entry. The current page starts at the trail's last cursor.
var COLLECTION_CURSOR_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Parse the `?cursor=` trail off a parsed URL into an array of opaque
// page-start cursors. A missing param is page 1 (empty trail). Each
// comma-separated entry must match the base64url`.`base64url cursor shape;
// any entry that doesn't is dropped, and a trail longer than a sane bound is
// truncated — a defensive request-shape reader that returns a clean trail
// (never throws) so a tampered / stale `?cursor=` degrades to a reachable
// page rather than a 500. The route additionally retries page 1 if the
// lib rejects the resolved start cursor's HMAC.
var COLLECTION_MAX_TRAIL = 512;
function _parseCollectionCursorTrail(url) {
  if (!url || !url.searchParams) return [];
  var raw = url.searchParams.get("cursor");
  if (raw == null || raw === "") return [];
  if (raw.length > COLLECTION_MAX_TRAIL * 200) return [];
  var parts = raw.split(",");
  var out = [];
  for (var i = 0; i < parts.length && out.length < COLLECTION_MAX_TRAIL; i += 1) {
    if (COLLECTION_CURSOR_RE.test(parts[i])) out.push(parts[i]);
  }
  return out;
}

// `/collections/:slug` URL for a given cursor trail. An empty trail is the
// bare collection page (page 1) so the first page has one canonical URL;
// otherwise the trail joins into the `?cursor=` param. Mirrors the search
// renderer's `_searchPageUrl` (page 1 omits the param).
function _collectionPageUrl(slug, trail) {
  var base = "/collections/" + encodeURIComponent(slug);
  if (!trail || !trail.length) return base;
  return base + "?cursor=" + trail.join(",");
}

// Prev/next pagination for a collection product grid. Reuses the
// `search-pagination` shell + `rel="prev"/"next"` + disabled-state spans
// so no new CSS ships and the markup matches the search nav. Renders
// nothing when there is neither a previous page (empty trail) nor a next
// page (`nextCursor == null`) — i.e. a single-page collection stays
// byte-identical to the unpaginated render. `trail` is the current page's
// cursor trail (the last entry is this page's start); `nextCursor` is the
// lib's opaque forward cursor for the following page (null on the last
// page).
function _renderCollectionPagination(slug, trail, nextCursor) {
  var esc = b.template.escapeHtml;
  var hasPrev = trail && trail.length > 0;
  var hasNext = nextCursor != null && nextCursor !== "";
  if (!hasPrev && !hasNext) return "";
  var prevTrail = hasPrev ? trail.slice(0, trail.length - 1) : [];
  var nextTrail = (trail || []).concat([nextCursor]);
  var prev = hasPrev
    ? _render("<a class=\"search-pagination__link search-pagination__prev\" href=\"{{href}}\" rel=\"prev\">Previous</a>\n",
        { href: esc(_collectionPageUrl(slug, prevTrail)) })
    : "<span class=\"search-pagination__link search-pagination__prev is-disabled\" aria-disabled=\"true\">Previous</span>\n";
  var next = hasNext
    ? _render("<a class=\"search-pagination__link search-pagination__next\" href=\"{{href}}\" rel=\"next\">Next</a>\n",
        { href: esc(_collectionPageUrl(slug, nextTrail)) })
    : "<span class=\"search-pagination__link search-pagination__next is-disabled\" aria-disabled=\"true\">Next</span>\n";
  return "<nav class=\"search-pagination collection-pagination\" aria-label=\"Collection pages\">\n" +
    prev +
    next +
    "</nav>\n";
}

// Read the 1-based `?page=N` results page off a parsed URL. A missing,
// non-integer, or sub-1 value reads as page 1 (the canonical first page);
// the upper bound is clamped against the real page count by `_clampPage`
// once the total is known. Defensive request-shape reader — returns the
// safe default for any garbage rather than throwing.
function _parsePageParam(url) {
  if (!url || !url.searchParams) return 1;
  var raw = url.searchParams.get("page");
  if (raw == null) return 1;
  if (!/^[0-9]{1,9}$/.test(raw)) return 1;
  var n = parseInt(raw, 10);
  return n >= 1 ? n : 1;
}

// Clamp a 1-based page to `[1, lastPage]` for a given total + page size.
// A `?page` past the end serves the last page (a stable, link-followable
// result) rather than an empty grid; a zero-result query stays on page 1.
function _clampPage(page, total, pageSize) {
  var size = pageSize > 0 ? pageSize : SEARCH_PAGE_SIZE;
  var lastPage = Math.max(1, Math.ceil(total / size));
  if (page < 1) return 1;
  if (page > lastPage) return lastPage;
  return page;
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
  // The result count copy + the page math run off the REAL match total —
  // the count of every product the query matched, not the length of the
  // page slice the renderer was handed. A caller that doesn't thread a
  // total (a unit test rendering one page directly) falls back to the page
  // length so the unpaginated render is unchanged.
  var pageSize    = (typeof opts.page_size === "number" && opts.page_size > 0) ? opts.page_size : SEARCH_PAGE_SIZE;
  var totalCount  = (typeof opts.total === "number" && opts.total >= 0) ? opts.total : products.length;
  var page        = (typeof opts.page === "number" && opts.page >= 1) ? Math.floor(opts.page) : 1;
  var qTrim = opts.q.trim();
  var title, summary, emptyHeading, emptyCopy;
  if (qTrim.length === 0) {
    title        = "Search the catalog";
    summary      = "Use the search box in the header to look for a product by title, SKU, or description.";
    emptyHeading = "What are you looking for?";
    emptyCopy    = "Type a query in the header search to find products by title, SKU, or description.";
  } else if (totalCount === 0) {
    title        = "No matches";
    summary      = "Nothing in the catalog matched “" + qTrim + "”.";
    emptyHeading = "We don't carry that yet";
    emptyCopy    = "Try a broader term, or browse every product on the home page.";
  } else {
    title   = "“" + qTrim + "”";
    summary = "Showing " + totalCount + " match" + (totalCount === 1 ? "" : "es") + " for your query.";
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
  // Pagination nav under the grid — `?page=N` links carrying the active
  // query + facets so paging never drops the filter state. Renders nothing
  // for a single page (the result count fits one page) or the empty / no-
  // query states. Driven by the real total, not the page slice length.
  var paginationHtml = (qTrim.length > 0 && totalCount > 0)
    ? _renderSearchPagination(opts.q, filters, totalCount, page, pageSize)
    : "";
  resultsInner += paginationHtml;
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
    // Internal search results are thin/duplicate indexable URLs (one per
    // query + facet combination) — keep the query URL out of the index
    // but let crawlers follow the product links the page lists.
    robots:     "noindex,follow",
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
// `availability` is the resolved `{ in_stock }` shape — when it reports
// out of stock the add-to-cart control renders disabled with an honest
// message instead of an active button, so the storefront never invites a
// purchase the cart-hold path would reject. Mirrored byte-for-byte by
// worker/render/product.js#_buildBuyBox.
var BUYBOX_CHIP_LIMIT = 12;

// Compute the PDP buy-box headline price string. `rendered` is the
// formatted-variant list ([{ id, sku, title, price }]); `variants` + the
// `prices` map ({ variant_id: { currency, amount_minor } }) carry the
// integer minor-units. Multi-variant products with >1 distinct price read
// "From <lowest>" (min over amount_minor, formatted once via `fmt`); a
// single-variant, no-price, or all-equal-price product keeps the lead
// variant's exact formatted price. Money discipline: the minimum is taken
// over integers, never over formatted strings; the result is formatted once.
// Kept byte-identical to worker/render/product.js#_buildHeadlinePrice.
function _buildHeadlinePrice(rendered, variants, prices, fmt) {
  var leadPrice = (rendered[0] && rendered[0].price) || "—";
  if (!Array.isArray(rendered) || rendered.length <= 1) return leadPrice;
  var lowMinor = null;
  var lowCurrency = null;
  for (var i = 0; i < variants.length; i += 1) {
    var p = prices && prices[variants[i].id];
    if (!p || !Number.isInteger(p.amount_minor)) continue;
    if (lowMinor === null || p.amount_minor < lowMinor) {
      lowMinor = p.amount_minor;
      lowCurrency = p.currency || "USD";
    }
  }
  if (lowMinor === null) return leadPrice;
  // All variants share one price → keep the exact figure (no "From").
  var allEqual = true;
  for (var j = 0; j < variants.length; j += 1) {
    var pj = prices && prices[variants[j].id];
    if (pj && Number.isInteger(pj.amount_minor) && pj.amount_minor !== lowMinor) { allEqual = false; break; }
  }
  if (allEqual) return leadPrice;
  return "From " + fmt(lowMinor, lowCurrency);
}

function _buildBuyBox(variants, escAttr, availability, headlinePrice) {
  var inStock = !availability || availability.in_stock !== false;
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

  // Out-of-stock add control: a disabled button + honest message,
  // reused across all three buy-box shapes so a sold-out product never
  // offers an active "add to cart" anywhere on the PDP.
  var soldOutBtn =
    "<button type=\"submit\" class=\"btn-primary cart-page__checkout\" disabled aria-disabled=\"true\">Out of stock</button>\n" +
    "          <p class=\"pdp__soldout-note\" role=\"status\">This item is currently out of stock.</p>";
  var soldOutRowBtn =
    "<button type=\"submit\" class=\"btn-primary btn-primary--sm\" disabled aria-disabled=\"true\">Out of stock</button>";

  // "Notify me when back in stock" — a cookie-less, edge-cache-safe form
  // posting to the DISTINCT CSRF-exempt action `/stock-alert/subscribe`
  // (NOT /products/:slug/notify — that would over-exempt the token-required
  // review + question POSTs). The action is in EDGE_POST_PATHS, so the
  // container's `_injectCsrfFields` leaves it un-tokened, keeping this markup
  // byte-identical to the worker twin. sku/variant are catalog data; escape
  // anyway (escape-by-default). DUAL-RENDER: this helper is byte-identical to
  // worker/render/product.js#_buildBuyBox._notifyForm.
  function _notifyForm(sku, variantId) {
    return "<form class=\"pdp__notify\" method=\"post\" action=\"/stock-alert/subscribe\">\n" +
           "          <input type=\"hidden\" name=\"sku\" value=\"" + escAttr(sku) + "\">\n" +
           (variantId ? "          <input type=\"hidden\" name=\"variant_id\" value=\"" + escAttr(variantId) + "\">\n" : "") +
           "          <label class=\"pdp__notify-label\" for=\"notify-email-" + escAttr(sku) + "\">Email me when this is back in stock</label>\n" +
           "          <input id=\"notify-email-" + escAttr(sku) + "\" type=\"email\" name=\"email\" required placeholder=\"you@example.com\" autocomplete=\"email\">\n" +
           "          <button type=\"submit\" class=\"btn-secondary btn-primary--sm\">Notify me</button>\n" +
           "        </form>";
  }

  // Many variants → keep the compact table (still a per-row add form).
  if (variants.length > BUYBOX_CHIP_LIMIT) {
    var rows = variants.map(function (v) {
      var row = _render(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
      // When the product is out of stock, swap each per-row add button for
      // the disabled control + a per-row notify form so no row offers an
      // active purchase but every sold-out SKU offers the alert.
      if (!inStock) {
        row = row.replace(
          "<button type=\"submit\" class=\"btn-primary btn-primary--sm\">Add to cart</button>",
          soldOutRowBtn + _notifyForm(v.sku, v.id));
      }
      return row;
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

  var addControl = inStock
    ? "<button type=\"submit\" class=\"btn-primary cart-page__checkout\">$ add to cart</button>"
    : soldOutBtn;

  // Out-of-stock chip/single buy box → the notify form sits OUTSIDE the
  // add-to-cart form (its own form element, distinct action), after the
  // sold-out control. Keyed to the LEAD variant's SKU — the chip radio does
  // not JS-swap the hidden field (Trusted Types / no innerHTML island), so a
  // shopper subscribes against the lead SKU. Documented limitation.
  var notifyBlock = inStock ? "" : ("\n        " + _notifyForm(lead.sku, lead.id));

  var headline = (headlinePrice != null && headlinePrice !== "") ? headlinePrice : lead.price;
  return "<div class=\"pdp__buybox\">\n" +
         "        <p class=\"featured-product__price\">" + escAttr(headline) + "</p>\n" +
         "        <form method=\"post\" action=\"/cart/lines\">\n" +
         "          " + variantBlock + "\n" +
         "          <label class=\"pdp__variants-title\" for=\"buybox-qty\">Quantity</label>\n" +
         "          <input id=\"buybox-qty\" type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" class=\"variant-row__qty\" aria-label=\"Quantity\">\n" +
         "          " + addControl + "\n" +
         "        </form>" + notifyBlock + "\n" +
         "      </div>\n" +
         "      " + trustLine;
}

// Resolve a product's availability + shipping shape from the variant
// list + (optional) inventory map the route loads. `in_stock` is true if
// ANY variant is buyable; a SKU with no inventory row counts as available
// (the never-block-on-missing-inventory stance the cart-hold path already
// takes). `requires_shipping` is true if ANY variant ships physically —
// an all-digital product (`requires_shipping = 0` on every variant)
// suppresses the "Ships in 1–2 business days" line. `low_stock` is the
// smallest still-buyable count across the tracked variants when that count
// sits at or below the variant's operator-configured `low_stock_threshold`
// (null when no tracked variant is low, or no threshold is set) — drives
// the honest "Only N left" nudge without hardcoding a global threshold.
// Returns a normalised `{ in_stock, requires_shipping, low_stock }` so the
// two render paths drive the badge + CTA + JSON-LD from the same shape.
// Defensive request-shape reader: missing/garbage inputs resolve to the
// available + physical default.
function _resolveAvailability(variants, inventoryBySku) {
  variants = Array.isArray(variants) ? variants : [];
  var inv = (inventoryBySku && typeof inventoryBySku === "object") ? inventoryBySku : null;
  var anyTracked = false;
  var anyInStock = false;
  var requiresShipping = false;
  var lowStock = null;
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
      // Low-stock nudge: only when this variant is still buyable AND the
      // operator set a threshold AND the count is at or below it. Track the
      // smallest such count so a multi-variant product nudges on its
      // scarcest in-stock variant.
      var threshold = row ? Number(row.low_stock_threshold) : NaN;
      if (available > 0 && Number.isFinite(threshold) && available <= threshold) {
        if (lowStock === null || available < lowStock) lowStock = available;
      }
    }
  }
  return {
    // No tracked variant → the operator hasn't opted into stock tracking,
    // so the product reads as in stock (never-block stance).
    in_stock:          anyTracked ? anyInStock : true,
    requires_shipping: variants.length === 0 ? true : requiresShipping,
    // Only surface a low-stock count when the product is actually in stock
    // — an out-of-stock product never shows "Only N left".
    low_stock:         (anyTracked ? anyInStock : true) ? lowStock : null,
  };
}

// PDP availability badges, driven by the resolved availability shape so
// the displayed state matches the JSON-LD `availability`. Mirrored byte-
// for-byte by worker/render/product.js#_buildAvailability.
function _buildAvailability(availability) {
  var a = availability || { in_stock: true, requires_shipping: true };
  var low = Number(a.low_stock);
  var stockBadge;
  if (!a.in_stock) {
    stockBadge = "<span class=\"pdp__badge pdp__badge--out\">Out of stock</span>";
  } else if (Number.isFinite(low) && low > 0) {
    // In stock but running low — an honest scarcity nudge driven by the
    // operator's configured threshold, not a hardcoded number.
    stockBadge = "<span class=\"pdp__badge pdp__badge--low\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> Only " + low + " left</span>";
  } else {
    stockBadge = "<span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> In stock</span>";
  }
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

// Pre-order CTA — replaces the add-to-cart buy box on a PDP whose lead SKU
// has an OPEN pre-order campaign (a SKU that isn't released yet, so it's not
// normally purchasable). `preorder` is the resolved shape the route loads:
//   { product_slug, release_date_iso, remaining_units (null = unlimited),
//     full_price_str, deposit_str (null when no deposit), sold_out,
//     reserve_form }
// A reservation is INTENT, not a charge — the form POSTs to the container
// /products/:slug/preorder route, which pins the reservation to the signed-in
// session customer and converts it into a regular (Stripe-gated) order at
// launch. The reserve POST is CSRF-protected + auth-gated, so the POST FORM is
// rendered ONLY by the container (where the per-request `_csrf` token is
// injected): `reserve_form` is true on the container render, false on the edge.
// The edge render shows the same pre-order info + a sign-in affordance instead
// of a token-less form — a logged-in customer's session-cookie request skips
// the edge cache and routes to the container, so they always reach the real
// (tokened) form; an anonymous edge visitor can't reserve anyway (the route
// 303s guests to login). This mirrors how cart-count / session chrome is
// handled on edge-cached pages. The non-form parts stay byte-identical to the
// edge builder. A sold-out campaign renders a disabled control + an honest
// note, mirroring the out-of-stock add control.
function _buildPreorderCta(preorder, escAttr) {
  var soldOut = !!preorder.sold_out;
  var remaining = preorder.remaining_units;
  var availLine = remaining == null
    ? "<p class=\"pdp__preorder-avail\" role=\"status\">Open for pre-order.</p>"
    : (remaining > 0
        ? "<p class=\"pdp__preorder-avail\" role=\"status\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> " + escAttr(String(remaining)) + " of " + escAttr(String(preorder.max_units_available)) + " reservations remaining.</p>"
        : "<p class=\"pdp__preorder-avail\" role=\"status\">All reservations are spoken for.</p>");
  var depositLine = preorder.deposit_str
    ? "<p class=\"pdp__preorder-deposit\">Reserve with a " + escAttr(preorder.deposit_str) + " deposit · " + escAttr(preorder.full_price_str) + " total at launch.</p>"
    : "<p class=\"pdp__preorder-deposit\">No payment due now · " + escAttr(preorder.full_price_str) + " charged when it ships.</p>";
  var head =
    "<div class=\"pdp__buybox pdp__buybox--preorder\">\n" +
    "        <p class=\"pdp__badge pdp__badge--preorder\">Pre-order · ships " + escAttr(preorder.release_date_iso) + "</p>\n" +
    "        <p class=\"featured-product__price\">" + escAttr(preorder.full_price_str) + "</p>\n" +
    "        " + availLine + "\n" +
    "        " + depositLine + "\n";
  // Sold-out: the same disabled control in both substrates (no POST either way).
  if (soldOut) {
    return head +
           "        <button type=\"submit\" class=\"btn-primary cart-page__checkout\" disabled aria-disabled=\"true\">Pre-orders full</button>\n" +
           "        <p class=\"pdp__soldout-note\" role=\"status\">Every pre-order reservation has been claimed.</p>\n" +
           "      </div>";
  }
  if (!preorder.reserve_form) {
    // Edge render — no per-session CSRF token here, so render a sign-in
    // affordance instead of a token-less POST form. A signed-in customer's
    // request skips the edge cache and gets the container form below.
    return head +
           "        <a class=\"btn-primary cart-page__checkout\" href=\"/account/login\">Sign in to reserve</a>\n" +
           "        <p class=\"pdp__preorder-note\">A reservation holds your unit. We charge through secure checkout when it launches.</p>\n" +
           "      </div>";
  }
  return head +
         "        <form method=\"post\" action=\"/products/" + escAttr(preorder.product_slug) + "/preorder\">\n" +
         "          <label class=\"pdp__variants-title\" for=\"preorder-qty\">Quantity</label>\n" +
         "          <input id=\"preorder-qty\" type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" class=\"variant-row__qty\" aria-label=\"Quantity\">\n" +
         "          <button type=\"submit\" class=\"btn-primary cart-page__checkout\">Reserve your pre-order</button>\n" +
         "          <p class=\"pdp__preorder-note\">A reservation holds your unit. We charge through secure checkout when it launches.</p>\n" +
         "        </form>\n" +
         "      </div>";
}

// Build the renderProduct `preorder` opts shape from a campaign row + the
// primitive's `availability` read + a price formatter. Returns null unless the
// campaign is OPEN (status 'active') — a launched / closed campaign is no
// longer reservable, so its PDP renders the standard buy box. Shared so the
// container route + the edge handler derive the identical shape and the
// dual-rendered CTA stays byte-consistent. `fmt(minor, currency)` is the
// page's price formatter; `slug` is the product (URL) slug the reserve form
// posts to.
function preorderCtaShape(campaign, availability, fmt, slug) {
  if (!campaign || campaign.status !== "active") return null;
  var remaining = availability ? availability.remaining_units : null;
  var max = campaign.max_units_available == null ? null : campaign.max_units_available;
  var deposit = Number(campaign.deposit_minor) || 0;
  return {
    product_slug:        slug,
    release_date_iso:    new Date(Number(campaign.launch_at)).toISOString().slice(0, 10),
    remaining_units:     remaining,
    max_units_available: max,
    full_price_str:      fmt(campaign.full_price_minor, campaign.currency),
    deposit_str:         deposit > 0 ? fmt(deposit, campaign.currency) : null,
    sold_out:            remaining != null && remaining <= 0,
    // The container injects the per-request `_csrf` token into POST forms, so
    // the container render carries the real reserve form. The edge twin
    // (worker/render/product.js#preorderCtaShape) sets this false and renders a
    // sign-in affordance — see _buildPreorderCta.
    reserve_form:        true,
  };
}

// The reserve-PRG banner, keyed off the closed ?preorder marker set so a
// forged query can never inject copy. Empty string for an absent / unknown
// marker. Mirrored byte-for-byte by worker/render/product.js#_buildPreorderNotice.
var _PREORDER_NOTICES = {
  reserved:    { kind: "ok",    copy: "Reserved. We'll email you when it ships and charge your card through secure checkout." },
  unavailable: { kind: "error", copy: "This pre-order couldn't be reserved — it may be full or closed. Nothing was charged." },
  closed:      { kind: "error", copy: "This pre-order is no longer open." },
};
function _buildPreorderNotice(marker) {
  var n = marker && Object.prototype.hasOwnProperty.call(_PREORDER_NOTICES, marker)
    ? _PREORDER_NOTICES[marker] : null;
  if (!n) return "";
  var cls = n.kind === "error" ? "form-notice form-notice--error" : "form-notice form-notice--ok";
  var role = n.kind === "error" ? "alert" : "status";
  return "<p class=\"" + cls + "\" role=\"" + role + "\">" + b.template.escapeHtml(n.copy) + "</p>\n      ";
}

// Map a thrown validator TypeError to the single form field it rejected, so a
// re-render can mark exactly that input with aria-invalid + a per-field error
// span (WCAG 3.3.1 Error Identification / 3.3.3 Error Suggestion) — IN ADDITION
// to the page-top role="alert" summary banner the routes already render.
//
// The shop's validators throw "<module>: <field> <reason>" (or
// "<module>.<method>: <field> <reason>") where the leading token after the
// prefix IS the form `name`. This reads that already-thrown error; it does NOT
// re-validate (the backend stays the single validator). `modulePrefix` is the
// thrower's prefix (e.g. "addresses", "reviews", "productQA", "supportTickets")
// and `formFields` is the set of `name`s the form actually renders, so an error
// on a non-form internal (e.g. customer_id) returns null — the page-top banner
// still shows, but no input is falsely marked.
//
// Returns { field, message } with the module prefix stripped from `message`
// (so the per-field span carries just the human reason), or null when the
// rejected token isn't one of this form's fields.
function _fieldFromValidatorError(e, modulePrefix, formFields) {
  var raw = (e && e.message) || "";
  var prefixRe = new RegExp("^" + modulePrefix + "(?:\\.\\w+)?:\\s+");
  var m = new RegExp("^" + modulePrefix + "(?:\\.\\w+)?:\\s+([a-z_]+)\\b").exec(raw);
  var field = m && m[1];
  if (!field || !formFields || !Object.prototype.hasOwnProperty.call(formFields, field)) return null;
  return { field: field, message: raw.replace(prefixRe, "") };
}

// Checkout's validators throw dotted container paths — "checkout:
// ship_to.<field> <reason>" / "checkout: customer.<field> <reason>" — so the
// shared extractor above (whose <field> token is undotted) can't map them to
// the checkout form's flat input names. This strips the container segment
// (and the em-dash separator the checkout messages carry) and maps the inner
// token to the form's fields; non-form internals return null so only the
// page-top banner shows for them.
var _CHECKOUT_FORM_FIELDS = {
  email: 1, name: 1, line1: 1, line2: 1, city: 1, state: 1, postal: 1, country: 1,
};
function _checkoutFieldFromError(e) {
  var raw = (e && e.message) || "";
  var m = /^checkout(?:\.\w+)?:\s+(?:ship_to|customer)\.([a-z_0-9]+)\b/.exec(raw);
  var field = m && m[1];
  if (!field || !Object.prototype.hasOwnProperty.call(_CHECKOUT_FORM_FIELDS, field)) return null;
  var message = raw.replace(/^checkout(?:\.\w+)?:\s+(?:ship_to|customer)\.[a-z_0-9]+\s*(?:—|-)?\s*/, "");
  return { field: field, message: message || "Please check this field." };
}

// Build the aria-invalid + aria-describedby attribute fragment for an input
// when `inv` (a { field, message } from _fieldFromValidatorError) names this
// field. Empty string otherwise. `idPrefix` + field is the static, escaped id.
function _fieldAriaAttr(idPrefix, name, inv) {
  if (!inv || inv.field !== name) return "";
  return " aria-invalid=\"true\" aria-describedby=\"" + b.template.escapeHtml(idPrefix + name) + "\"";
}

// Build the adjacent per-field error span (role="alert") for the rejected
// field; empty string otherwise. The reason is escaped operator-validator
// prose; the id is the static, escaped `idPrefix + name`.
function _fieldErrorSpan(idPrefix, name, inv) {
  if (!inv || inv.field !== name) return "";
  return "<span class=\"form-field__error\" id=\"" + b.template.escapeHtml(idPrefix + name) +
    "\" role=\"alert\">" + b.template.escapeHtml(inv.message == null ? "" : String(inv.message)) + "</span>";
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
  "</section>\n" +
  "RAW_RELATED_PLACEHOLDER";

// PDP gallery markup — composed once per render call from the
// product's media rows. A no-JS, CSS-`:checked` picker: every media row
// is rendered both as a hidden radio + a stacked main `<img>` (only the
// `:checked` radio's image is visible) and as a `<label for>` thumbnail
// (clicking/keyboard-activating it checks the radio → CSS swaps the
// visible image). The first image is selected on load. A single-image
// product renders just that image with no thumbnail strip; when media is
// absent the gallery falls back to the letter-mark placeholder so a
// freshly-seeded product never renders an empty square.
//
// Byte-identical to the edge renderer (`worker/render/product.js
// #_buildPdpGallery`) — keep the two in sync on every change.
function _buildPdpGallery(product, media, assetPrefix) {
  var prefix = assetPrefix || "/assets/";
  function _escAttr(s) { return b.template.escapeHtml(s); }
  if (!media || media.length === 0) {
    return "<figure class=\"pdp__media pdp__media--placeholder\" aria-hidden=\"true\">" +
             "<svg class=\"media-ph__svg\" viewBox=\"0 0 240 240\" aria-hidden=\"true\"><rect width=\"240\" height=\"240\" fill=\"none\"/><g stroke=\"currentColor\" stroke-opacity=\"0.10\" stroke-width=\"1\"><path d=\"M0 40 H240 M0 80 H240 M0 120 H240 M0 160 H240 M0 200 H240 M40 0 V240 M80 0 V240 M120 0 V240 M160 0 V240 M200 0 V240\"/></g><g fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"3\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><path d=\"M120 64 L162 80 L162 122 C162 152 144 168 120 178 C96 168 78 152 78 122 L78 80 Z\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M120 92 L146 105 L146 134 L120 147 L94 134 L94 105 Z\"/><path d=\"M94 105 L120 118 L146 105 M120 118 V147\" stroke=\"#732A8D\" stroke-width=\"2.4\"/><path d=\"M107 101 L112 105 L107 109\" stroke=\"currentColor\" stroke-width=\"2.4\"/><path d=\"M116 110 H128\" stroke=\"currentColor\" stroke-width=\"2.4\"/></g><text x=\"120\" y=\"208\" text-anchor=\"middle\" font-family=\"ui-monospace,Menlo,Consolas,monospace\" font-size=\"12\" letter-spacing=\"2\" fill=\"#6b6b78\">no image yet</text></svg>" +
           "</figure>";
  }
  var hero = media[0];
  var heroAlt = hero.alt_text || product.title || "Product image";
  // The CSS picker (main.css) maps :checked radios through nth-of-type(12),
  // so render at most that many — a thumbnail that checked a radio with no
  // matching visibility rule would blank the gallery. Twelve covers any
  // realistic product; keep this in lockstep with the rule count in main.css.
  var shown = media.length < 12 ? media.length : 12;
  var radios = "";
  var imgs = "";
  var thumbs = "";
  for (var i = 0; i < shown; i += 1) {
    var m = media[i];
    var url = prefix + m.r2_key;
    var id = "pdp-img-" + i;
    var checked = i === 0 ? " checked" : "";
    var alt = i === 0 ? heroAlt : (m.alt_text || product.title || "Product image");
    var loading = i === 0 ? "eager" : "lazy";
    radios += "<input class=\"pdp__radio\" type=\"radio\" name=\"pdp-img\" id=\"" + _escAttr(id) + "\"" + checked + ">";
    imgs += "<img class=\"pdp__img\" src=\"" + _escAttr(url) + "\" alt=\"" + _escAttr(alt) + "\" loading=\"" + loading + "\">";
    thumbs += "<li>" +
                "<label class=\"pdp__thumb\" for=\"" + _escAttr(id) + "\">" +
                  "<img src=\"" + _escAttr(url) + "\" alt=\"\">" +
                  "<span class=\"sr-only\">Show image " + (i + 1) + "</span>" +
                "</label>" +
              "</li>";
  }
  // Radios are siblings of the figure + thumbnail list (not nested), so a
  // checked radio can reach both the stacked images and the matching
  // thumbnail through the general-sibling combinator in CSS.
  var figure = "<figure class=\"pdp__media pdp__media--image pdp__media--gallery\">" + imgs + "</figure>";
  if (shown === 1) return radios + figure;
  return radios + figure + "<ul class=\"pdp__thumbs\">" + thumbs + "</ul>";
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
  "    <fieldset class=\"review-form__rating\"RAW_RATING_ARIA_PLACEHOLDER>\n" +
  "      <legend>Your rating</legend>\n" +
  "      RAW_STARS_PLACEHOLDER\n" +
  "      RAW_RATING_ERROR_PLACEHOLDER\n" +
  "    </fieldset>\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Title</span>\n" +
  "      <input type=\"text\" name=\"title\" maxlength=\"120\" required autocomplete=\"off\"RAW_TITLE_ARIA_PLACEHOLDER>\n" +
  "      RAW_TITLE_ERROR_PLACEHOLDER\n" +
  "    </label>\n" +
  "    <label class=\"form-field\">\n" +
  "      <span class=\"form-field__label\">Your review</span>\n" +
  "      <textarea name=\"body\" maxlength=\"4000\" rows=\"6\"RAW_BODY_ARIA_PLACEHOLDER></textarea>\n" +
  "      RAW_BODY_ERROR_PLACEHOLDER\n" +
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
  // On a validation re-render, mark the one rejected control. The rating is a
  // <fieldset> (the aria goes on the group, per the existing fieldset/legend
  // shape); title/body are ordinary inputs. ids are static "review-err-<name>".
  var inv = opts.invalid_field || null;
  var body = _render(REVIEW_FORM_PAGE, { title: opts.product.title, slug: slug })
    .replace("RAW_NOTICE_PLACEHOLDER", notice)
    .replace("RAW_STARS_PLACEHOLDER", stars);
  ["rating", "title", "body"].forEach(function (name) {
    body = _spliceRaw(body, "RAW_" + name.toUpperCase() + "_ARIA_PLACEHOLDER", _fieldAriaAttr("review-err-", name, inv));
    body = _spliceRaw(body, "RAW_" + name.toUpperCase() + "_ERROR_PLACEHOLDER", _fieldErrorSpan("review-err-", name, inv));
  });
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
  "      <textarea name=\"body\" maxlength=\"4000\" rows=\"6\" requiredRAW_BODY_ARIA_PLACEHOLDER></textarea>\n" +
  "      RAW_BODY_ERROR_PLACEHOLDER\n" +
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
  // Single field (`body`); on a re-render, mark it with aria-invalid + an
  // adjacent error span. id is the static "qa-err-body".
  var inv = opts.invalid_field || null;
  var body = _render(QA_FORM_PAGE, {
    title: opts.product.title,
    slug:  opts.product.slug,
  })
    .replace("RAW_NOTICE_PLACEHOLDER", notice);
  body = _spliceRaw(body, "RAW_BODY_ARIA_PLACEHOLDER", _fieldAriaAttr("qa-err-", "body", inv));
  body = _spliceRaw(body, "RAW_BODY_ERROR_PLACEHOLDER", _fieldErrorSpan("qa-err-", "body", inv));
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
  // The owner's share panel — a "Share this wishlist" control plus the
  // list of active share links each with a Revoke action. The route
  // builds the panel HTML (it owns the share-link reads); absent it (the
  // sharing primitive isn't wired, or a unit test calling the renderer
  // directly) the panel is empty so the page renders unchanged.
  var sharePanel = opts.share_panel || "";
  // Alert + digest opt-in panel (server-rendered, no client JS). The
  // route builds it (it owns the per-trigger / per-schedule prefs reads);
  // absent it (the alerts/digest primitives aren't wired, or a unit test
  // calling the renderer directly) the panel is empty.
  var prefsPanel = opts.prefs_panel || "";
  var body =
    "<section class=\"account-wishlist\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Saved items</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-wishlist__title\">Saved items</h1>" +
      notice +
      prefsPanel +
      sharePanel +
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

// The owner-side wishlist share panel (mounts on /account/wishlist). It
// renders a "Create a share link" control plus the owner's active share
// links, each with a status + view count and a Revoke form. `opts.shares`
// is the owner's links from `listSharesForOwner` (already scoped to the
// session customer by the route). A revoked / expired link still appears
// (greyed, no Revoke) so the owner sees the history; only an active link
// carries a Revoke control.
//
// The plaintext share token is surfaced EXACTLY ONCE — at create time, via
// `opts.fresh_url` (the full public URL of the just-minted link). The list
// rows never carry the URL because the token isn't persisted; the owner
// copies the link from this one-time confirmation. `opts.notice` surfaces a
// created/revoked confirmation via role="status".
var WISHLIST_SHARE_NOTICES = {
  created: "Share link created. Copy it below — it's shown only once.",
  revoked: "Share link revoked. The link no longer works.",
};
function _wishlistSharePanel(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var shares = opts.shares || [];
  var nowTs = Date.now();
  var rows = "";
  for (var i = 0; i < shares.length; i += 1) {
    var s = shares[i];
    var revoked = s.revoked_at != null;
    var expired = !revoked && s.expires_at != null && Number(s.expires_at) < nowTs;
    var inactive = revoked || expired;
    var statusLabel = revoked ? "Revoked" : (expired ? "Expired" : "Active");
    var statusCls = revoked ? "wishlist-share__status--revoked"
                  : (expired ? "wishlist-share__status--expired" : "wishlist-share__status--active");
    var revokeForm = inactive
      ? ""
      : "<form class=\"wishlist-share__revoke\" method=\"post\" action=\"/wishlist/share/" + esc(s.id) + "/revoke\">" +
          "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Revoke</button>" +
        "</form>";
    var viewN = Number(s.view_count) || 0;
    rows +=
      "<li class=\"wishlist-share" + (inactive ? " wishlist-share--inactive" : "") + "\">" +
        "<div class=\"wishlist-share__head\">" +
          "<span class=\"wishlist-share__status " + statusCls + "\">" + esc(statusLabel) + "</span>" +
          "<span class=\"wishlist-share__views\">" + esc(String(viewN)) + " view" + (viewN === 1 ? "" : "s") + "</span>" +
        "</div>" +
        revokeForm +
      "</li>";
  }
  var list = rows ? "<ul class=\"wishlist-share__list\">" + rows + "</ul>" : "";
  var noticeMsg = WISHLIST_SHARE_NOTICES[opts.notice];
  var notice = noticeMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(noticeMsg) + "</p>"
    : "";
  // The one-time URL block — present only on the create confirmation. A
  // read-only text field the owner can copy; it never re-renders after the
  // owner navigates away (the token isn't persisted).
  var freshUrl = opts.fresh_url
    ? "<div class=\"wishlist-share__fresh\">" +
        "<label class=\"wishlist-share__fresh-label\" for=\"wishlist-share-url\">Your share link</label>" +
        "<input id=\"wishlist-share-url\" class=\"wishlist-share__url\" type=\"text\" readonly value=\"" + esc(opts.fresh_url) + "\" " +
          "aria-label=\"Shareable wishlist link\" onfocus=\"this.select()\">" +
      "</div>"
    : "";
  return "<section class=\"wishlist-share-panel\" aria-labelledby=\"wishlist-share-heading\">" +
           "<h2 id=\"wishlist-share-heading\" class=\"wishlist-share-panel__title\">Share this wishlist</h2>" +
           "<p class=\"wishlist-share-panel__lede\">Create a link so friends and family can see what you're hoping for. The link shows your saved products only — it never reveals your account.</p>" +
           notice +
           freshUrl +
           "<form class=\"wishlist-share-panel__create\" method=\"post\" action=\"/wishlist/share\">" +
             "<button type=\"submit\" class=\"btn-secondary\">Create a share link</button>" +
           "</form>" +
           list +
         "</section>";
}

// The wishlist alert + digest opt-in panel (mounts on /account/wishlist
// when the alerts / digest primitives are wired). Server-rendered, no
// client JS: each toggle is a `<form method="post">` whose hidden `on`
// field flips on submit (the submit button carries the new state). The
// `_csrf` token is injected automatically by the `_wrap` form chokepoint
// (_injectCsrfFields) like every other container POST form — the panel
// emits no token itself.
//
//   opts.alerts   — [{ trigger, label, subscribed }] (subscribed drives
//                   the button's on/off action)
//   opts.digests  — [{ slug, label, enrolled, enrollment_id }]
//   opts.notice   — "alerts" | "digest" → a saved confirmation
//
// Every operator-controlled string (a schedule slug used as a label) is
// escaped via the storefront `esc()` path.
var WISHLIST_PREFS_NOTICES = {
  alerts: "Alert preferences saved.",
  digest: "Digest subscription updated.",
};
function _wishlistPrefsPanel(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var alerts  = opts.alerts  || [];
  var digests = opts.digests || [];
  if (alerts.length === 0 && digests.length === 0) return "";
  var noticeMsg = WISHLIST_PREFS_NOTICES[opts.notice];
  var notice = noticeMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(noticeMsg) + "</p>"
    : "";

  var alertRows = "";
  for (var i = 0; i < alerts.length; i += 1) {
    var a = alerts[i];
    var on = a.subscribed === true;
    // Submitting flips the state: a subscribed trigger posts on="" (off);
    // an unsubscribed one posts on="1".
    alertRows +=
      "<form class=\"wishlist-prefs__row\" method=\"post\" action=\"/account/wishlist/alerts\">" +
        "<input type=\"hidden\" name=\"trigger\" value=\"" + esc(a.trigger) + "\">" +
        "<input type=\"hidden\" name=\"on\" value=\"" + (on ? "" : "1") + "\">" +
        "<span class=\"wishlist-prefs__label\">" + esc(a.label || a.trigger) + "</span>" +
        "<span class=\"wishlist-prefs__state\">" + (on ? "On" : "Off") + "</span>" +
        // aria-label carries the trigger name — the visible "Turn off"/"Turn
        // on" alone is ambiguous to a screen reader walking a list of
        // identically-named buttons.
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\" aria-label=\"" + (on ? "Turn off " : "Turn on ") + esc(a.label || a.trigger) + "\">" + (on ? "Turn off" : "Turn on") + "</button>" +
      "</form>";
  }
  var alertsBlock = alertRows
    ? "<h3 class=\"wishlist-prefs__subhead\">Price-drop &amp; back-in-stock alerts</h3>" + alertRows
    : "";

  var digestRows = "";
  for (var j = 0; j < digests.length; j += 1) {
    var d = digests[j];
    var enrolled = d.enrolled === true;
    digestRows +=
      "<form class=\"wishlist-prefs__row\" method=\"post\" action=\"/account/wishlist/digest\">" +
        "<input type=\"hidden\" name=\"schedule_slug\" value=\"" + esc(d.slug) + "\">" +
        "<input type=\"hidden\" name=\"on\" value=\"" + (enrolled ? "" : "1") + "\">" +
        "<span class=\"wishlist-prefs__label\">" + esc(d.label || d.slug) + "</span>" +
        "<span class=\"wishlist-prefs__state\">" + (enrolled ? "Subscribed" : "Not subscribed") + "</span>" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\" aria-label=\"" + (enrolled ? "Unsubscribe from " : "Subscribe to ") + esc(d.label || d.slug) + "\">" + (enrolled ? "Unsubscribe" : "Subscribe") + "</button>" +
      "</form>";
  }
  var digestBlock = digestRows
    ? "<h3 class=\"wishlist-prefs__subhead\">Periodic wishlist digest</h3>" + digestRows
    : "";

  return "<section class=\"wishlist-prefs-panel\" aria-labelledby=\"wishlist-prefs-heading\">" +
           "<h2 id=\"wishlist-prefs-heading\" class=\"wishlist-prefs-panel__title\">Wishlist notifications</h2>" +
           "<p class=\"wishlist-prefs-panel__lede\">Choose how you'd like to hear about your saved items. We'll only email you if your store has email delivery configured.</p>" +
           notice +
           alertsBlock +
           digestBlock +
         "</section>";
}

// Public, no-auth shared-wishlist page (`GET /wishlist/shared/:token`). It
// renders ONLY the shared product cards (title, image, link to each PDP) —
// the owner's identity, the per-entry private notes, and the owner customer
// id are NEVER emitted, mirroring what the primitive's `viewShared` is
// trusted to surface to a giver. `opts.entries` is the `viewShared` entry
// list resolved to products; `opts.title` is the share's display title.
// Carries a noindex robots directive — a personal shared wishlist is not a
// page search engines should index. An unknown / revoked / expired token
// never reaches this renderer (the route 404s first via renderNotFound).
function renderSharedWishlist(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var items = opts.items || [];
  var prefix = opts.asset_prefix || "/assets/";
  var heading = (opts.title && String(opts.title).length) ? opts.title : "A shared wishlist";
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    if (!it.product) continue;   // archived/deleted product → drop the card (no owner data to leak)
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
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"wishlist-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">This wishlist is empty right now — nothing's been saved yet.</p>" +
        "<a class=\"btn-secondary\" href=\"/\">Browse the shop →</a>" +
      "</div>";
  var body =
    "<section class=\"account-wishlist\">" +
      "<p class=\"eyebrow\">Shared with you</p>" +
      "<h1 class=\"account-wishlist__title\">" + esc(heading) + "</h1>" +
      inner +
    "</section>";
  return _wrap({
    title:      heading,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    // A personal shared wishlist is not search-index material — keep it
    // out of the index. `noindex` maps to noindex,nofollow in _wrap; the
    // page needs no canonical (a crawler won't index it to dedupe).
    robots:     "noindex",
    body:       body,
  });
}

// ---- gift registry -------------------------------------------------------
//
// Owner side (renderRegistryList / renderRegistryManage) is gated on the
// session customer; the public giver view (renderRegistryPublic) takes no
// auth — the slug (resolved through the privacy gate) is the access.

// Human label for an occasion enum value. Unknown values fall back to the
// raw token (never throws) so a future migration that adds an occasion the
// renderer hasn't been taught still shows something readable.
var REGISTRY_OCCASION_LABELS = {
  wedding:      "Wedding",
  baby:         "Baby",
  housewarming: "Housewarming",
  birthday:     "Birthday",
  graduation:   "Graduation",
  anniversary:  "Anniversary",
  other:        "Other",
};
function _registryOccasionLabel(occasion) {
  return REGISTRY_OCCASION_LABELS[occasion] || (occasion || "Registry");
}

// Build a <select> of occasion options. `selected` highlights the current
// value (the edit form); absent it the first option is the browser default.
function _registryOccasionSelect(name, selected, esc) {
  var opts = "";
  for (var i = 0; i < REGISTRY_OCCASIONS.length; i += 1) {
    var v = REGISTRY_OCCASIONS[i];
    var sel = v === selected ? " selected" : "";
    opts += "<option value=\"" + esc(v) + "\"" + sel + ">" + esc(_registryOccasionLabel(v)) + "</option>";
  }
  return "<select name=\"" + esc(name) + "\" required>" + opts + "</select>";
}

// Build a <select> of privacy options with inline help text.
var REGISTRY_PRIVACY_LABELS = {
  private:  "Private — only you can see it",
  unlisted: "Unlisted — anyone with the link can see it",
  public:   "Public — discoverable in the shop",
};
function _registryPrivacySelect(name, selected, esc) {
  var order = ["unlisted", "public", "private"];
  var opts = "";
  for (var i = 0; i < order.length; i += 1) {
    var v = order[i];
    var sel = v === selected ? " selected" : "";
    opts += "<option value=\"" + esc(v) + "\"" + sel + ">" + esc(REGISTRY_PRIVACY_LABELS[v] || v) + "</option>";
  }
  return "<select name=\"" + esc(name) + "\" required>" + opts + "</select>";
}

// Owner-facing list of registries (`GET /account/registry`). `opts.rows` is
// each registry decoded by `listForOwner`, decorated with its `progress`
// rollup ({ overall_percent, total_desired, total_purchased }). The create
// form posts to /account/registry. `opts.notice` surfaces a created/closed/
// updated confirmation. A per-customer page — noindex.
var REGISTRY_LIST_NOTICES = {
  created: "Registry created. Add the items you're hoping for below.",
  closed:  "Registry closed. It's still viewable so you can send thank-you notes.",
  updated: "Registry updated.",
  removed: "Item removed from your registry.",
  added:   "Item added to your registry.",
};
function renderRegistryList(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var rows = opts.rows || [];
  var rowsHtml = "";
  for (var i = 0; i < rows.length; i += 1) {
    var r = rows[i];
    var reg = r.registry;
    var prog = r.progress || { overall_percent: 0, total_purchased: 0, total_desired: 0 };
    var statusBadge = reg.status === "closed"
      ? "<span class=\"registry-card__status registry-card__status--closed\">Closed</span>"
      : "<span class=\"registry-card__status registry-card__status--active\">Active</span>";
    rowsHtml +=
      "<li class=\"registry-card\">" +
        "<div class=\"registry-card__head\">" +
          "<a class=\"registry-card__title\" href=\"/account/registry/" + esc(reg.slug) + "\">" + esc(reg.title) + "</a>" +
          statusBadge +
        "</div>" +
        "<p class=\"registry-card__meta\">" + esc(_registryOccasionLabel(reg.occasion)) + " · " +
          esc(REGISTRY_PRIVACY_LABELS[reg.privacy] || reg.privacy) + "</p>" +
        "<p class=\"registry-card__progress\">" + esc(String(prog.overall_percent)) + "% fulfilled" +
          " (" + esc(String(prog.total_purchased)) + " of " + esc(String(prog.total_desired)) + ")</p>" +
        "<a class=\"card-link\" href=\"/account/registry/" + esc(reg.slug) + "\">Manage registry →</a>" +
      "</li>";
  }
  var list = rowsHtml
    ? "<ul class=\"registry-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">You haven't created a registry yet. Start one below for a wedding, a baby, a housewarming, or any occasion — then share the link with friends and family.</p>" +
      "</div>";
  var noticeMsg = REGISTRY_LIST_NOTICES[opts.notice];
  var notice = noticeMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(noticeMsg) + "</p>"
    : "";
  var errMsg = (typeof opts.error === "string" && opts.error.length) ? opts.error : "";
  var errBlock = errMsg
    ? "<p class=\"form-notice form-notice--err\" role=\"alert\">" + esc(errMsg) + "</p>"
    : "";
  // The slug field is operator-authored (lowercase alnum + dash) — the
  // backend validates it; the form pattern is a UX hint only (backend
  // remains authoritative, never the client).
  var createForm =
    "<section class=\"registry-create\" aria-labelledby=\"registry-create-heading\">" +
      "<h2 id=\"registry-create-heading\" class=\"registry-create__title\">Create a registry</h2>" +
      errBlock +
      "<form class=\"registry-create__form\" method=\"post\" action=\"/account/registry\">" +
        "<label class=\"field\"><span class=\"field__label\">Title</span>" +
          "<input type=\"text\" name=\"title\" required maxlength=\"200\" placeholder=\"Alice &amp; Bob's Wedding\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Registry link (lowercase letters, numbers, dashes)</span>" +
          "<input type=\"text\" name=\"slug\" required maxlength=\"200\" pattern=\"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\" placeholder=\"alice-and-bob-2026\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Recipient name</span>" +
          "<input type=\"text\" name=\"recipient_name\" required maxlength=\"200\" placeholder=\"Alice &amp; Bob\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Occasion</span>" +
          _registryOccasionSelect("occasion", "wedding", esc) + "</label>" +
        "<label class=\"field\"><span class=\"field__label\">Event date (optional)</span>" +
          "<input type=\"date\" name=\"event_date\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Who can see it</span>" +
          _registryPrivacySelect("privacy", "unlisted", esc) + "</label>" +
        "<button type=\"submit\" class=\"btn-primary\">Create registry</button>" +
      "</form>" +
    "</section>";
  var body =
    "<section class=\"account-registry\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Gift registry</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-registry__title\">Your gift registries</h1>" +
      notice +
      list +
      createForm +
    "</section>";
  return _wrap({
    title:      "Gift registry",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    // Per-customer management surface — keep it out of the index.
    robots:     "noindex",
    body:       body,
  });
}

// Owner-facing manage page for one registry (`GET /account/registry/:slug`).
// `opts.registry` is the decoded row; `opts.items` is each item decorated
// with { product, hero_media, purchased, remaining, desired }; `opts.share_url`
// is the absolute public URL (built from the request origin by the route).
// Carries the add-item / edit / close forms. Per-customer — noindex.
function renderRegistryManage(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var prefix = opts.asset_prefix || "/assets/";
  var reg = opts.registry || {};
  var items = opts.items || [];
  var closed = reg.status === "closed";
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    var media = it.hero_media
      ? "<img src=\"" + esc(prefix + it.hero_media.r2_key) + "\" alt=\"" + esc(it.hero_media.alt_text || (it.product && it.product.title) || it.sku) + "\" loading=\"lazy\">"
      : "<span class=\"registry-item__mark\" aria-hidden=\"true\">" + esc(((it.product && it.product.title) || it.sku || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    var titleHtml = it.product
      ? "<a class=\"registry-item__title\" href=\"/products/" + esc(it.product.slug) + "\">" + esc(it.product.title) + "</a>"
      : "<span class=\"registry-item__title\">" + esc(it.sku) + " (no longer in the catalog)</span>";
    var removeForm = closed ? "" :
      "<form class=\"registry-item__remove\" method=\"post\" action=\"/account/registry/" + esc(reg.slug) + "/items/" + esc(it.item_id) + "/remove\">" +
        "<button type=\"submit\" class=\"btn-ghost\">Remove</button>" +
      "</form>";
    rowsHtml +=
      "<li class=\"registry-item\">" +
        "<span class=\"registry-item__media\">" + media + "</span>" +
        "<div class=\"registry-item__body\">" +
          titleHtml +
          "<p class=\"registry-item__progress\">" + esc(String(it.purchased)) + " of " + esc(String(it.desired)) +
            " purchased · " + esc(String(it.remaining)) + " still needed</p>" +
        "</div>" +
        removeForm +
      "</li>";
  }
  var list = rowsHtml
    ? "<ul class=\"registry-item-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\"><p class=\"account-empty__lede\">No items yet. Add the products you're hoping for below.</p></div>";

  var addForm = closed ? "" :
    "<section class=\"registry-add\" aria-labelledby=\"registry-add-heading\">" +
      "<h2 id=\"registry-add-heading\" class=\"registry-add__title\">Add an item</h2>" +
      "<form class=\"registry-add__form\" method=\"post\" action=\"/account/registry/" + esc(reg.slug) + "/items\">" +
        "<label class=\"field\"><span class=\"field__label\">Product SKU</span>" +
          "<input type=\"text\" name=\"sku\" required maxlength=\"200\" placeholder=\"BLENDER-12CUP\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Quantity wanted</span>" +
          "<input type=\"number\" name=\"quantity_desired\" required min=\"1\" max=\"999\" value=\"1\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Priority (1 = most wanted)</span>" +
          "<input type=\"number\" name=\"priority\" min=\"1\" max=\"5\" value=\"3\"></label>" +
        "<button type=\"submit\" class=\"btn-secondary\">Add to registry</button>" +
      "</form>" +
    "</section>";

  var eventDateValue = (typeof reg.event_date === "number")
    ? new Date(reg.event_date).toISOString().slice(0, 10)
    : "";
  var editForm = closed ? "" :
    "<section class=\"registry-edit\" aria-labelledby=\"registry-edit-heading\">" +
      "<h2 id=\"registry-edit-heading\" class=\"registry-edit__title\">Registry details</h2>" +
      "<form class=\"registry-edit__form\" method=\"post\" action=\"/account/registry/" + esc(reg.slug) + "/edit\">" +
        "<label class=\"field\"><span class=\"field__label\">Title</span>" +
          "<input type=\"text\" name=\"title\" required maxlength=\"200\" value=\"" + esc(reg.title || "") + "\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Recipient name</span>" +
          "<input type=\"text\" name=\"recipient_name\" required maxlength=\"200\" value=\"" + esc(reg.recipient_name || "") + "\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Event date</span>" +
          "<input type=\"date\" name=\"event_date\" value=\"" + esc(eventDateValue) + "\"></label>" +
        "<label class=\"field\"><span class=\"field__label\">Who can see it</span>" +
          _registryPrivacySelect("privacy", reg.privacy, esc) + "</label>" +
        "<button type=\"submit\" class=\"btn-secondary\">Save details</button>" +
      "</form>" +
    "</section>";

  var closeForm = closed
    ? "<p class=\"registry-manage__closed-note\">This registry is closed. It stays viewable so you can review what arrived.</p>"
    : "<form class=\"registry-close__form\" method=\"post\" action=\"/account/registry/" + esc(reg.slug) + "/close\">" +
        "<button type=\"submit\" class=\"btn-ghost registry-close__btn\">Close this registry</button>" +
      "</form>";

  // The shareable public URL — shown only for a non-private registry (a
  // private registry isn't publicly viewable, so there's no link to share).
  var shareBlock = "";
  if (reg.privacy !== "private" && opts.share_url) {
    shareBlock =
      "<section class=\"registry-share\" aria-labelledby=\"registry-share-heading\">" +
        "<h2 id=\"registry-share-heading\" class=\"registry-share__title\">Share this registry</h2>" +
        "<p class=\"registry-share__lede\">Send this link to friends and family. They can see what you're hoping for and mark items as purchased — buyers stay anonymous unless they choose otherwise.</p>" +
        "<label class=\"registry-share__label\" for=\"registry-share-url\">Public link</label>" +
        "<input id=\"registry-share-url\" class=\"registry-share__url\" type=\"text\" readonly value=\"" + esc(opts.share_url) + "\" " +
          "aria-label=\"Public registry link\" onfocus=\"this.select()\">" +
      "</section>";
  } else if (reg.privacy === "private") {
    shareBlock = "<p class=\"registry-share__private-note\">This registry is private — no public link. Change it to unlisted or public above to share it.</p>";
  }

  var noticeMsg = REGISTRY_LIST_NOTICES[opts.notice];
  var notice = noticeMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(noticeMsg) + "</p>"
    : "";
  var errMsg = (typeof opts.error === "string" && opts.error.length) ? opts.error : "";
  var errBlock = errMsg
    ? "<p class=\"form-notice form-notice--err\" role=\"alert\">" + esc(errMsg) + "</p>"
    : "";

  var body =
    "<section class=\"account-registry-manage\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/registry\">Gift registry</a></li>" +
        "<li aria-current=\"page\">" + esc(reg.title || "Registry") + "</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-registry-manage__title\">" + esc(reg.title || "Registry") + "</h1>" +
      "<p class=\"account-registry-manage__meta\">" + esc(_registryOccasionLabel(reg.occasion)) + " · " +
        esc(REGISTRY_PRIVACY_LABELS[reg.privacy] || reg.privacy) + (closed ? " · Closed" : "") + "</p>" +
      notice +
      errBlock +
      shareBlock +
      list +
      addForm +
      editForm +
      closeForm +
    "</section>";
  return _wrap({
    title:      reg.title || "Registry",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

// Confirmation copy after a public giver action. Unknown keys render nothing
// so a forged ?ok= query can't inject arbitrary copy onto the page.
var REGISTRY_PUBLIC_NOTICES = {
  gifted: "Thank you! We've marked that item as purchased.",
};

// Public, no-auth giver view of a registry (`GET /registry/:slug`). The route
// resolves the registry ONLY through getBySlug (which honors the privacy
// gate — a private registry returns null and the route 404s); the owner's
// customer id + shipping address + buyer identities are NEVER carried into
// this shape (the route passes title/occasion/event_date + per-item desired /
// purchased / remaining counts + product cards only). Each not-yet-fulfilled
// item carries a "mark purchased" form (records a gift via purchaseItem —
// buyer anonymous by default) and an "add to cart" link so the giver can buy
// it normally through the regular cart/checkout. Carries a noindex robots
// directive — a personal registry is not search-index material.
function renderRegistryPublic(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var prefix = opts.asset_prefix || "/assets/";
  var reg = opts.registry || {};
  var items = opts.items || [];
  var heading = (reg.title && String(reg.title).length) ? reg.title : "A gift registry";
  var occasionLine = esc(_registryOccasionLabel(reg.occasion));
  if (typeof reg.event_date === "number") {
    var dt = new Date(reg.event_date);
    if (!isNaN(dt.getTime())) {
      occasionLine += " · " + esc(dt.toISOString().slice(0, 10));
    }
  }
  var rowsHtml = "";
  for (var i = 0; i < items.length; i += 1) {
    var it = items[i];
    var media = it.hero_media
      ? "<img src=\"" + esc(prefix + it.hero_media.r2_key) + "\" alt=\"" + esc(it.hero_media.alt_text || (it.product && it.product.title) || it.sku) + "\" loading=\"lazy\">"
      : "<span class=\"registry-item__mark\" aria-hidden=\"true\">" + esc(((it.product && it.product.title) || it.sku || "?").trim().charAt(0).toUpperCase() || "?") + "</span>";
    var titleHtml = it.product
      ? "<a class=\"registry-item__title\" href=\"/products/" + esc(it.product.slug) + "\">" + esc(it.product.title) + "</a>"
      : "<span class=\"registry-item__title\">" + esc(it.sku) + "</span>";
    // Progress line — desired vs already purchased. A fully-purchased item
    // shows a "fully gifted" badge and offers no purchase control.
    var fulfilled = it.remaining <= 0;
    var progressHtml = fulfilled
      ? "<p class=\"registry-item__progress registry-item__progress--done\">Fully gifted — thank you!</p>"
      : "<p class=\"registry-item__progress\">" + esc(String(it.purchased)) + " of " + esc(String(it.desired)) +
          " purchased · " + esc(String(it.remaining)) + " still needed</p>";
    // Giver controls: only for an item that's both buyable (resolves to a
    // catalog variant) and not yet fully gifted, and only while the registry
    // is active (a closed registry refuses purchaseItem).
    var controls = "";
    if (!fulfilled && reg.status === "active") {
      var markForm =
        "<form class=\"registry-item__gift\" method=\"post\" action=\"/registry/" + esc(reg.slug) + "/items/" + esc(it.item_id) + "/purchase\">" +
          "<input type=\"hidden\" name=\"quantity\" value=\"1\">" +
          "<label class=\"registry-item__reveal\"><input type=\"checkbox\" name=\"reveal\" value=\"1\"> Let the recipient see it was from me (requires sign-in)</label>" +
          "<button type=\"submit\" class=\"btn-secondary\">Mark as purchased</button>" +
        "</form>";
      var cartForm = it.variant_id
        ? "<form class=\"registry-item__cart\" method=\"post\" action=\"/cart/lines\">" +
            "<input type=\"hidden\" name=\"variant_id\" value=\"" + esc(it.variant_id) + "\">" +
            "<input type=\"hidden\" name=\"qty\" value=\"1\">" +
            "<button type=\"submit\" class=\"btn-ghost\">Add to cart</button>" +
          "</form>"
        : "";
      controls = "<div class=\"registry-item__actions\">" + cartForm + markForm + "</div>";
    }
    rowsHtml +=
      "<li class=\"registry-item\">" +
        "<span class=\"registry-item__media\">" + media + "</span>" +
        "<div class=\"registry-item__body\">" +
          titleHtml +
          progressHtml +
          controls +
        "</div>" +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"registry-item-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\"><p class=\"account-empty__lede\">This registry doesn't have any items yet — check back soon.</p>" +
        "<a class=\"btn-secondary\" href=\"/\">Browse the shop →</a></div>";
  var noticeMsg = REGISTRY_PUBLIC_NOTICES[opts.notice];
  var notice = noticeMsg
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(noticeMsg) + "</p>"
    : "";
  var messageBlock = (reg.message && String(reg.message).length)
    ? "<p class=\"registry-public__message\">" + esc(reg.message) + "</p>"
    : "";
  var body =
    "<section class=\"registry-public\">" +
      "<p class=\"eyebrow\">Gift registry</p>" +
      "<h1 class=\"registry-public__title\">" + esc(heading) + "</h1>" +
      "<p class=\"registry-public__meta\">" + occasionLine + "</p>" +
      messageBlock +
      notice +
      inner +
    "</section>";
  return _wrap({
    title:      heading,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    // A personal registry is not search-index material.
    robots:     "noindex",
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
  // On a validation re-render, the rejected field carries aria-invalid +
  // aria-describedby pointing at an adjacent error span (WCAG 3.3.1/3.3.3).
  // The id is a static prefix + field name (attacker-uncontrolled) but is
  // still escaped for defense-in-depth; the reason is operator-validator
  // prose, escaped via esc().
  var errSpan = "";
  if (opts.invalid) {
    attrs += " aria-invalid=\"true\" aria-describedby=\"" + esc(opts.error_id) + "\"";
    errSpan = "<span class=\"form-field__error\" id=\"" + esc(opts.error_id) +
      "\" role=\"alert\">" + esc(opts.error_msg == null ? "" : String(opts.error_msg)) + "</span>";
  }
  return "<label class=\"form-field\">" +
           "<span class=\"form-field__label\">" + esc(labelText) + req + "</span>" +
           "<input type=\"text\" name=\"" + esc(name) + "\" value=\"" + esc(value == null ? "" : String(value)) + "\"" + attrs + ">" +
           errSpan +
         "</label>";
}

// Shared add/edit address form. `addr` pre-fills for edit (null = add).
// `invalidField` (optional) is a { field, message } picked off the
// backend-thrown validator error so the one rejected input renders with
// aria-invalid + a per-field error span (WCAG 3.3.1/3.3.3). When null, every
// field renders byte-identically to the no-error path.
function _addressForm(action, addr, submitLabel, invalidField) {
  var esc = b.template.escapeHtml;
  addr = addr || {};
  function _checked(v) { return Number(v) === 1 ? " checked" : ""; }
  // Merge the per-field invalid marker into a field's opts when it is the one
  // the validator rejected. The id is a static "addr-err-<name>" so it is
  // attacker-uncontrolled.
  function _mark(name, opts) {
    if (invalidField && invalidField.field === name) {
      opts.invalid = true;
      opts.error_id = "addr-err-" + name;
      opts.error_msg = invalidField.message;
    }
    return opts;
  }
  return "<form class=\"address-form form-stack\" method=\"post\" action=\"" + esc(action) + "\">" +
    _addrField("recipient_name", "Recipient name", addr.recipient_name, _mark("recipient_name", { required: true, maxlength: 120, autocomplete: "name" })) +
    _addrField("label", "Label (e.g. Home, Work)", addr.label, _mark("label", { maxlength: 60 })) +
    _addrField("company", "Company", addr.company, _mark("company", { maxlength: 120, autocomplete: "organization" })) +
    _addrField("street_line1", "Street address", addr.street_line1, _mark("street_line1", { required: true, maxlength: 200, autocomplete: "address-line1" })) +
    _addrField("street_line2", "Apt / suite / unit", addr.street_line2, _mark("street_line2", { maxlength: 200, autocomplete: "address-line2" })) +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("city", "City", addr.city, _mark("city", { required: true, maxlength: 120, autocomplete: "address-level2" })) +
      _addrField("region", "State / region", addr.region, _mark("region", { maxlength: 120, autocomplete: "address-level1" })) +
    "</div>" +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("postal_code", "Postal code", addr.postal_code, _mark("postal_code", { required: true, maxlength: 32, autocomplete: "postal-code" })) +
      _addrField("country", "Country (ISO 3166-1)", addr.country || "US", _mark("country", { required: true, maxlength: 2, pattern: "[A-Za-z]{2}", autocomplete: "country" })) +
    "</div>" +
    _addrField("phone", "Phone", addr.phone, _mark("phone", { maxlength: 40, autocomplete: "tel" })) +
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
      _addressForm(formAction, editing, editing ? "Save changes" : "Add address", opts.invalid_field || null) +
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
    canonical_url: opts.canonical_url, og_url: opts.og_url,
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
  // Prev/next nav under the grid — the `?cursor=` trail carries the lib's
  // opaque forward cursor so a collection larger than one page is fully
  // reachable (the silent 24-cap truncation is the bug this closes). Renders
  // nothing for a single-page collection (no trail + no next cursor), so the
  // small-collection render is unchanged.
  var pagination = _renderCollectionPagination(
    col.slug,
    opts.cursor_trail || [],
    opts.next_cursor == null ? null : opts.next_cursor
  );
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
      pagination +
    "</section>";
  // BreadcrumbList JSON-LD mirroring the on-page `<nav class="breadcrumb">`
  // trail (Shop → Collections → this collection). Google's result panel
  // renders the trail above the title; the `item` URLs are absolute so the
  // structured data is fully-qualified. Mirrors the PDP's breadcrumb shape.
  var shopName = opts.shop_name || "blamejs.shop";
  var absoluteBase = _absoluteBase(opts.canonical_url, shopName);
  var breadcrumbJsonLd = _jsonLdScript({
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "Shop", "item": absoluteBase + "/" },
      { "@type": "ListItem", "position": 2, "name": "Collections", "item": absoluteBase + "/collections" },
      { "@type": "ListItem", "position": 3, "name": col.title, "item": absoluteBase + "/collections/" + col.slug },
    ],
  });
  return _wrap({
    title: col.title, shop_name: shopName,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css,
    body: body + breadcrumbJsonLd,
    canonical_url: opts.canonical_url, og_url: opts.og_url,
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
  var shopName = opts.shop_name || "blamejs.shop";
  var catMetaDescription = (cat.description && String(cat.description).trim().length)
    ? String(cat.description)
    : ("Shop " + cat.title + " at " + shopName + ".");
  // BreadcrumbList JSON-LD mirroring the on-page `<nav class="breadcrumb">`
  // chain (Shop → Categories → …root→current). Google's result panel
  // renders the trail above the title; the `item` URLs are absolute so the
  // structured data is fully-qualified. The breadcrumb chain's last entry
  // is the current category (rendered as plain text on-page), included here
  // as the trailing list item with its own URL. Mirrors the PDP shape.
  var absoluteBase = _absoluteBase(opts.canonical_url, shopName);
  var crumbItems = [
    { "@type": "ListItem", "position": 1, "name": "Shop", "item": absoluteBase + "/" },
    { "@type": "ListItem", "position": 2, "name": "Categories", "item": absoluteBase + "/categories" },
  ];
  for (var bi = 0; bi < crumbs.length; bi += 1) {
    crumbItems.push({
      "@type":    "ListItem",
      "position": bi + 3,
      "name":     crumbs[bi].title,
      "item":     absoluteBase + "/categories/" + crumbs[bi].slug,
    });
  }
  var breadcrumbJsonLd = _jsonLdScript({
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    "itemListElement": crumbItems,
  });
  return _wrap({
    title: cat.title, shop_name: shopName,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count, theme_css: opts.theme_css,
    og_description: catMetaDescription,
    canonical_url: opts.canonical_url, og_url: opts.og_url,
    body: body + breadcrumbJsonLd,
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
          "<a class=\"return-card__rma\" href=\"/account/returns/" + esc(String(r.id)) + "\"><code>" + esc(r.rma_code) + "</code></a>" +
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
        "<a class=\"btn-secondary\" href=\"/account/orders\">View your orders &rarr;</a>" +
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

// The signed-in customer's pickup (BOPIS) list. Each row links the parent
// order and shows the FSM status + the scheduled window. Reuses the
// return-card layout classes — no new CSS. location_code is operator free
// text; the status is a fixed FSM enum — both escaped at the sink.
function renderAccountPickups(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var list = opts.pickups || [];
  var rowsHtml = "";
  for (var i = 0; i < list.length; i += 1) {
    var p = list[i];
    var when = p.scheduled_window_start
      ? new Date(Number(p.scheduled_window_start)).toISOString().slice(0, 16).replace("T", " ")
      : "";
    rowsHtml +=
      "<li class=\"return-card\">" +
        "<div class=\"return-card__head\">" +
          "<a class=\"return-card__rma\" href=\"/orders/" + esc(String(p.order_id)) + "\"><code>" + esc(String(p.order_id).slice(0, 8)) + "</code></a>" +
          "<span class=\"return-status\">" + esc(_pickupStatusLabel(p.status)) + "</span>" +
        "</div>" +
        "<p class=\"return-card__meta\">" +
          "Location <code>" + esc(String(p.location_code)) + "</code>" +
          (when ? " &middot; <time>" + esc(when) + " UTC</time>" : "") +
        "</p>" +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"return-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">No pickups yet. Choose “pick up in store” at checkout to schedule one.</p>" +
        "<a class=\"btn-secondary\" href=\"/account/orders\">View your orders &rarr;</a>" +
      "</div>";
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Pickups</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Pickups</h1>" +
      inner +
    "</section>";
  return _wrap({
    title:      "Pickups",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

// Customer-facing phrasing for a return label's carrier-scan status. The
// return-labels module's FSM enum (issued / shipped / in_transit /
// delivered / exception) is operator/carrier vocabulary; these read for
// the shopper following their parcel back to the merchant.
var RETURN_LABEL_STATUS_LABELS = {
  issued:     "Label ready",
  shipped:    "Dropped off",
  in_transit: "On its way back",
  delivered:  "Delivered to us",
  exception:  "Delivery issue",
};

function _returnLabelStatusBadge(status) {
  var esc = b.template.escapeHtml;
  var label = RETURN_LABEL_STATUS_LABELS[status] || status;
  return "<span class=\"return-status return-status--" + esc(String(status)) + "\">" +
    esc(String(label)) + "</span>";
}

// Human label for a return_label_events row. The event_type mirrors the
// label FSM transitions (issued / shipped / in_transit / delivered /
// exception); these are the shopper-facing phrasings on the timeline.
var RETURN_LABEL_EVENT_LABELS = {
  issued:     "Label issued",
  shipped:    "Parcel dropped off",
  in_transit: "In transit",
  delivered:  "Delivered to the merchant",
  exception:  "Delivery exception",
};

// One return's status detail, including its return-shipping label (if one
// has been issued) and the carrier-scan timeline. Ownership-scoped: the
// route only renders this for a return whose customer_id matches the
// session customer, so the label + tracking reads are already gated.
//
// `opts.rma` is the return_authorizations row. `opts.label` is the most
// recent return_labels row (or null — a return with no label yet shows a
// neutral "no label" state, never an error). `opts.events` is the label's
// ordered return_label_events timeline (empty when there's no label).
// Reuses the account/returns layout classes — no new CSS.
function renderReturnDetail(opts) {
  var esc = b.template.escapeHtml;
  var rma = opts.rma;
  var label = opts.label || null;
  var events = opts.events || [];
  var date = rma.created_at ? new Date(Number(rma.created_at)).toISOString().slice(0, 10) : "";

  function _row(labelText, value) {
    return "<p class=\"return-card__meta\"><span class=\"form-field__label\">" + esc(labelText) + "</span> " +
      (value ? esc(String(value)) : "&mdash;") + "</p>";
  }

  var summaryRows = "";
  summaryRows += _row("Reason", rma.reason);
  if (date) summaryRows += _row("Requested", date);
  if (rma.status === "rejected" && rma.rejected_reason) {
    summaryRows += _row("Why it was declined", rma.rejected_reason);
  }
  if (Number(rma.refund_amount_minor) > 0) {
    summaryRows += _row("Refund", pricing.format(Number(rma.refund_amount_minor), rma.refund_currency || "USD"));
  }

  // The return-label panel. A return with no issued label shows a neutral
  // note (the label arrives once the operator approves + funds the return)
  // — never an error. A return WITH a label surfaces the carrier + tracking
  // number, a download/print affordance, the live status, and the timeline.
  var labelPanel;
  if (!label) {
    labelPanel =
      "<div class=\"return-card return-label-panel\">" +
        "<h2 class=\"return-card__subhead\">Return shipping label</h2>" +
        "<p class=\"return-card__meta return-label-panel__none\">No label yet. We'll add a prepaid return label here once your return is approved.</p>" +
      "</div>";
  } else {
    var carrierLine = label.carrier
      ? (esc(String(label.carrier)) + (label.service_level ? " &middot; " + esc(String(label.service_level)) : ""))
      : "";
    // The download is its own ownership-scoped route (GET
    // /account/returns/:id/label), which loads the return, re-checks
    // ownership, then redirects to the carrier label asset — the label_url
    // is never emitted in the page by id, so the affordance is a link to
    // the scoped route, not the raw carrier URL.
    var downloadHref = "/account/returns/" + esc(String(rma.id)) + "/label";

    var timelineRows = "";
    for (var i = 0; i < events.length; i += 1) {
      var ev = events[i];
      var evLabel = RETURN_LABEL_EVENT_LABELS[ev.event_type] || ev.event_type;
      var when = ev.occurred_at ? new Date(Number(ev.occurred_at)).toISOString().slice(0, 16).replace("T", " ") : "";
      var detail = "";
      try {
        var d = ev.detail_json ? JSON.parse(ev.detail_json) : {};
        if (d && d.location) detail = String(d.location);
        else if (d && d.exception) detail = String(d.exception);
      } catch (_e) { detail = ""; }
      timelineRows +=
        "<li class=\"return-timeline__event\">" +
          "<span class=\"return-timeline__label\">" + esc(String(evLabel)) + "</span>" +
          (detail ? " <span class=\"return-timeline__detail\">" + esc(detail) + "</span>" : "") +
          (when ? " <time class=\"return-timeline__when\" datetime=\"" + esc(when) + "\">" + esc(when) + "</time>" : "") +
        "</li>";
    }
    var timeline = timelineRows
      ? "<ol class=\"return-timeline\">" + timelineRows + "</ol>"
      : "";

    labelPanel =
      "<div class=\"return-card return-label-panel\">" +
        "<div class=\"return-card__head\">" +
          "<h2 class=\"return-card__subhead\">Return shipping label</h2>" +
          _returnLabelStatusBadge(label.status) +
        "</div>" +
        (carrierLine ? "<p class=\"return-card__meta\"><span class=\"form-field__label\">Carrier</span> " + carrierLine + "</p>" : "") +
        _row("Tracking number", label.tracking_number) +
        "<p class=\"return-label-panel__actions\">" +
          "<a class=\"btn-primary\" href=\"" + downloadHref + "\" rel=\"nofollow\">Download return label</a>" +
        "</p>" +
        (timeline ? "<h3 class=\"return-card__subhead\">Tracking</h3>" + timeline : "") +
      "</div>";
  }

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/returns\">Returns</a></li>" +
        "<li aria-current=\"page\">" + esc(String(rma.rma_code || "")) + "</li>" +
      "</ol></nav>" +
      "<div class=\"return-card__head\">" +
        "<h1 class=\"account-returns__title\">Return <code>" + esc(String(rma.rma_code || "")) + "</code></h1>" +
        _returnStatusBadge(rma.status) +
      "</div>" +
      "<div class=\"return-card\">" + summaryRows + "</div>" +
      labelPanel +
    "</section>";
  return _wrap({
    title:      "Return " + String(rma.rma_code || ""),
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Customer-facing reasons for an exchange. The values mirror the
// order-exchanges module's REASONS allow-list; the backend validates the
// submitted value against its own list, so a forged value is refused
// there. (No-longer-needed isn't an exchange reason — that's a return.)
var EXCHANGE_REASONS = [
  ["defective", "Defective / doesn't work"],
  ["wrong-item", "Wrong item received"],
  ["wrong-size", "Wrong size"],
  ["wrong-colour", "Wrong colour"],
  ["damaged-in-transit", "Damaged in transit"],
  ["not-as-described", "Not as described"],
  ["other", "Other"],
];

// Customer-facing phrasing for an exchange's FSM status. The module's
// enum (pending / approved / shipped / delivered / received / closed /
// rejected) is operator vocabulary; these read for the shopper.
var EXCHANGE_STATUS_LABELS = {
  pending:   "Requested",
  approved:  "Approved",
  shipped:   "Replacement shipped",
  delivered: "Replacement delivered",
  received:  "Return received",
  closed:    "Completed",
  rejected:  "Declined",
};

function _exchangeStatusBadge(status) {
  var esc = b.template.escapeHtml;
  var label = EXCHANGE_STATUS_LABELS[status] || status;
  return "<span class=\"return-status return-status--" + esc(String(status)) + "\">" +
    esc(String(label)) + "</span>";
}

// Customer-facing exchange-request form for one owned order. `opts.lines`
// is the order's order_lines, each decorated with `replacement_options`
// (the sibling variants of that line's product the shopper can swap to).
// `opts.notice` is an optional error bounced back from a failed POST.
// Reuses the returns-form layout classes — no new CSS.
function renderExchangeForm(opts) {
  var esc = b.template.escapeHtml;
  var order = opts.order;
  var lines = opts.lines || [];
  var lineRows = "";
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    var maxQty = Number(l.qty) || 1;
    var replOpts = (l.replacement_options || []).map(function (o) {
      return "<option value=\"" + esc(String(o.id)) + "\">" + esc(String(o.label)) + "</option>";
    }).join("");
    // A line with no resolvable sibling variants can't be exchanged for a
    // different option — offer a same-SKU swap (replace a defective unit)
    // so the line is never silently undisplayable.
    var replaceField = replOpts
      ? "<label class=\"return-line__qty\">Swap for " +
          "<select name=\"replacement_" + esc(l.id) + "\">" + replOpts + "</select>" +
        "</label>"
      : "<p class=\"return-line__of\">Same item, replacement unit.</p>";
    lineRows +=
      "<li class=\"return-line\">" +
        "<label class=\"return-line__pick\">" +
          "<input type=\"radio\" name=\"line_id\" value=\"" + esc(l.id) + "\"" + (i === 0 ? " checked" : "") + ">" +
          "<span class=\"return-line__sku\"><code>" + esc(l.sku) + "</code></span>" +
        "</label>" +
        "<label class=\"return-line__qty\">Qty to exchange " +
          "<input type=\"number\" name=\"qty_" + esc(l.id) + "\" value=\"1\" min=\"1\" max=\"" + maxQty + "\">" +
          " <span class=\"return-line__of\">of " + maxQty + "</span>" +
        "</label>" +
        replaceField +
      "</li>";
  }
  var reasonOpts = EXCHANGE_REASONS.map(function (r) {
    return "<option value=\"" + esc(r[0]) + "\">" + esc(r[1]) + "</option>";
  }).join("");
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body =
    "<section class=\"return-form-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/exchanges\">Exchanges</a></li>" +
        "<li aria-current=\"page\">Request an exchange</li>" +
      "</ol></nav>" +
      "<h1 class=\"return-form-page__title\">Request an exchange</h1>" +
      "<p class=\"return-form-page__order\">Order <code>" + esc(order.id) + "</code></p>" +
      notice +
      "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/orders/" + esc(order.id) + "/exchange\">" +
        "<fieldset class=\"return-form__lines\"><legend>Which item?</legend>" +
          "<ul class=\"return-line-list\">" + lineRows + "</ul>" +
        "</fieldset>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Reason</span>" +
          "<select name=\"reason\" required>" + reasonOpts + "</select></label>" +
        "<button type=\"submit\" class=\"btn-primary\">Request exchange</button>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Request an exchange",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// The signed-in customer's exchange list. `opts.exchanges` is the
// ownership-scoped set (already filtered to this customer's orders); each
// links to its status detail.
function renderExchanges(opts) {
  var esc = b.template.escapeHtml;
  var exchanges = opts.exchanges || [];
  var rowsHtml = "";
  for (var i = 0; i < exchanges.length; i += 1) {
    var x = exchanges[i];
    var date = x.created_at ? new Date(Number(x.created_at)).toISOString().slice(0, 10) : "";
    rowsHtml +=
      "<li class=\"return-card\">" +
        "<div class=\"return-card__head\">" +
          "<a class=\"return-card__rma\" href=\"/account/exchanges/" + esc(String(x.id)) + "\"><code>" + esc(String(x.id).slice(0, 8)) + "</code></a>" +
          _exchangeStatusBadge(x.status) +
        "</div>" +
        "<p class=\"return-card__meta\">" +
          esc(String(x.return_sku || "")) + " &rarr; " + esc(String(x.replacement_sku || "")) +
          (date ? " &middot; <time datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
        "</p>" +
        (x.status === "rejected" && x.reject_reason ? "<p class=\"return-card__reject\">" + esc(String(x.reject_reason)) + "</p>" : "") +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"return-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">No exchanges yet. Start one from an order in your account.</p>" +
        "<a class=\"btn-secondary\" href=\"/account/orders\">View your orders &rarr;</a>" +
      "</div>";
  var notice = opts.requested
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">Exchange request received — we'll review it and email you next steps.</p>"
    : "";
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Exchanges</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Exchanges</h1>" +
      notice +
      inner +
    "</section>";
  return _wrap({
    title:      "Exchanges",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// One exchange's status detail. Ownership-scoped (the route only renders
// this for an exchange whose parent order belongs to the session
// customer). Surfaces the swap, the reason, the live status, the
// rejection reason (if declined), and the outbound tracking number once
// the replacement has shipped.
function renderExchangeDetail(opts) {
  var esc = b.template.escapeHtml;
  var x = opts.exchange;
  var date = x.created_at ? new Date(Number(x.created_at)).toISOString().slice(0, 10) : "";
  var rows = "";
  function _row(label, value) {
    return "<p class=\"return-card__meta\"><span class=\"form-field__label\">" + esc(label) + "</span> " +
      (value ? esc(String(value)) : "&mdash;") + "</p>";
  }
  rows += _row("Item returned", x.return_sku + " ×" + x.return_qty);
  rows += _row("Replacement", x.replacement_sku + " ×" + x.replacement_qty);
  rows += _row("Reason", x.reason);
  if (date) rows += _row("Requested", date);
  if (x.status === "rejected" && x.reject_reason) rows += _row("Why it was declined", x.reject_reason);
  if (x.tracking_number) {
    rows += _row("Replacement tracking", x.carrier ? (x.carrier + " · " + x.tracking_number) : x.tracking_number);
  }
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/exchanges\">Exchanges</a></li>" +
        "<li aria-current=\"page\">" + esc(String(x.id).slice(0, 8)) + "</li>" +
      "</ol></nav>" +
      "<div class=\"return-card__head\">" +
        "<h1 class=\"account-returns__title\">Exchange <code>" + esc(String(x.id).slice(0, 8)) + "</code></h1>" +
        _exchangeStatusBadge(x.status) +
      "</div>" +
      "<div class=\"return-card\">" + rows + "</div>" +
    "</section>";
  return _wrap({
    title:      "Exchange " + String(x.id).slice(0, 8),
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Support ticket — the categories a shopper can pick when raising one,
// and the human label for each. The values mirror the support-tickets
// module's ALLOWED_CATEGORIES; the backend validates the submitted value
// against its own allow-list, so a forged value is refused there.
var SUPPORT_CATEGORIES = [
  ["pre_sale",        "Pre-sale question"],
  ["order_issue",     "Problem with an order"],
  ["shipping",        "Shipping / delivery"],
  ["billing",         "Billing"],
  ["refund",          "Refund"],
  ["account",         "My account"],
  ["complaint",       "Complaint"],
  ["feature_request", "Feature request"],
  ["other",           "Something else"],
];

// Customer-facing status word for a ticket. The module's status enum is
// operator vocabulary (new / in_progress / waiting_customer / resolved /
// closed / reopened); these are the shopper-facing phrasings.
var SUPPORT_STATUS_LABELS = {
  "new":              "Received",
  "in_progress":      "In progress",
  "waiting_customer": "Awaiting your reply",
  "resolved":         "Resolved",
  "closed":           "Closed",
  "reopened":         "Reopened",
};

function _supportStatusBadge(status) {
  var esc = b.template.escapeHtml;
  var label = SUPPORT_STATUS_LABELS[status] || status;
  return "<span class=\"return-status return-status--" + esc(String(status)) + "\">" +
    esc(String(label)) + "</span>";
}

function _supportCategoryLabel(value) {
  for (var i = 0; i < SUPPORT_CATEGORIES.length; i += 1) {
    if (SUPPORT_CATEGORIES[i][0] === value) return SUPPORT_CATEGORIES[i][1];
  }
  return value;
}

// The signed-in customer's support-ticket list. `opts.tickets` is the
// ownership-scoped set (already filtered to this customer); each links to
// its thread view.
function renderSupportList(opts) {
  var esc = b.template.escapeHtml;
  var tickets = opts.tickets || [];
  var rowsHtml = "";
  for (var i = 0; i < tickets.length; i += 1) {
    var t = tickets[i];
    var date = t.opened_at ? new Date(Number(t.opened_at)).toISOString().slice(0, 10) : "";
    rowsHtml +=
      "<li class=\"return-card\">" +
        "<div class=\"return-card__head\">" +
          "<a class=\"return-card__rma\" href=\"/account/support/" + esc(String(t.id)) + "\">" + esc(String(t.subject)) + "</a>" +
          _supportStatusBadge(t.status) +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(_supportCategoryLabel(t.category)) +
          (date ? " &middot; <time datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
        "</p>" +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"return-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">No support tickets yet. Raise one and we'll get back to you.</p>" +
      "</div>";
  var notice = "";
  if (opts.created) {
    notice = "<p class=\"form-notice form-notice--ok\" role=\"status\">Your ticket has been raised — we'll reply here.</p>";
  }
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Support</li>" +
      "</ol></nav>" +
      "<header class=\"account-recently-viewed__head\">" +
        "<h1 class=\"account-returns__title\">Support</h1>" +
        "<a class=\"btn-primary\" href=\"/account/support/new\">Raise a ticket</a>" +
      "</header>" +
      notice +
      inner +
    "</section>";
  return _wrap({
    title:      "Support",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// The new-ticket form. `opts.orders` is the signed-in customer's recent
// orders so they can attach one (optional). `opts.values` re-fills the
// form after a validation bounce; `opts.notice` is the error to show.
function renderSupportNew(opts) {
  var esc = b.template.escapeHtml;
  var v = opts.values || {};
  var orders = opts.orders || [];
  var categoryOpts = SUPPORT_CATEGORIES.map(function (c) {
    var sel = v.category === c[0] ? " selected" : "";
    return "<option value=\"" + esc(c[0]) + "\"" + sel + ">" + esc(c[1]) + "</option>";
  }).join("");
  var orderOptions = "<option value=\"\">No specific order</option>" +
    orders.map(function (o) {
      var sel = v.order_id === o.id ? " selected" : "";
      var when = o.created_at ? new Date(Number(o.created_at)).toISOString().slice(0, 10) : "";
      return "<option value=\"" + esc(String(o.id)) + "\"" + sel + ">" +
        esc(String(o.id).slice(0, 8)) + (when ? " · " + esc(when) : "") + "</option>";
    }).join("");
  var orderField = orders.length
    ? "<label class=\"form-field\"><span class=\"form-field__label\">Related order (optional)</span>" +
        "<select name=\"order_id\">" + orderOptions + "</select></label>"
    : "";
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  // On a validation re-render, mark the one rejected field with aria-invalid +
  // an adjacent error span (WCAG 3.3.1/3.3.3) via the shared field helpers.
  // `opts.invalid_field` is the { field, message } the route picked off the
  // backend-thrown error; ids are static "support-err-<name>".
  var inv = opts.invalid_field || null;
  function _supAria(name) { return _fieldAriaAttr("support-err-", name, inv); }
  function _supErr(name) { return _fieldErrorSpan("support-err-", name, inv); }
  var body =
    "<section class=\"return-form-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/support\">Support</a></li>" +
        "<li aria-current=\"page\">Raise a ticket</li>" +
      "</ol></nav>" +
      "<h1 class=\"return-form-page__title\">Raise a support ticket</h1>" +
      notice +
      "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/support\">" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Email for our reply</span>" +
          "<input type=\"email\" name=\"customer_email\" value=\"" + esc(v.customer_email == null ? "" : String(v.customer_email)) + "\" required autocomplete=\"email\" maxlength=\"254\"" + _supAria("customer_email") + ">" + _supErr("customer_email") + "</label>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Category</span>" +
          "<select name=\"category\" required" + _supAria("category") + ">" + categoryOpts + "</select>" + _supErr("category") + "</label>" +
        orderField +
        "<label class=\"form-field\"><span class=\"form-field__label\">Subject</span>" +
          "<input type=\"text\" name=\"subject\" value=\"" + esc(v.subject == null ? "" : String(v.subject)) + "\" required maxlength=\"200\"" + _supAria("subject") + ">" + _supErr("subject") + "</label>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">How can we help?</span>" +
          "<textarea name=\"body\" required maxlength=\"8000\" rows=\"6\"" + _supAria("body") + ">" + esc(v.body == null ? "" : String(v.body)) + "</textarea>" + _supErr("body") + "</label>" +
        "<button type=\"submit\" class=\"btn-primary\">Send</button>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Raise a ticket",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// One ticket's thread view. `opts.ticket` is the row, `opts.messages` the
// thread in created_at ASC. Internal operator notes (internal=1) are
// filtered out by the route before rendering — they never reach the
// customer. A non-closed ticket shows the reply box.
function renderSupportTicket(opts) {
  var esc = b.template.escapeHtml;
  var t = opts.ticket;
  var messages = opts.messages || [];
  var msgHtml = "";
  for (var i = 0; i < messages.length; i += 1) {
    var m = messages[i];
    var who = m.author === "operator" ? "Support" : m.author === "system" ? "System" : "You";
    var when = m.created_at ? new Date(Number(m.created_at)).toISOString().slice(0, 16).replace("T", " ") : "";
    msgHtml +=
      "<li class=\"support-msg support-msg--" + esc(String(m.author)) + "\">" +
        "<p class=\"support-msg__who\">" + esc(who) +
          (when ? " <time class=\"support-msg__when\" datetime=\"" + esc(when) + "\">" + esc(when) + "</time>" : "") + "</p>" +
        "<p class=\"support-msg__body\">" + esc(String(m.body)).replace(/\n/g, "<br>") + "</p>" +
      "</li>";
  }
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var replyOk = opts.replied
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">Your reply has been added.</p>"
    : "";
  var closed = t.status === "closed";
  var replyForm = closed
    ? "<p class=\"meta\">This ticket is closed. Raise a new one if you still need help.</p>"
    : "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/support/" + esc(String(t.id)) + "/reply\">" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Add a reply</span>" +
          "<textarea name=\"body\" required maxlength=\"8000\" rows=\"5\"></textarea></label>" +
        "<button type=\"submit\" class=\"btn-primary\">Send reply</button>" +
      "</form>";
  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/support\">Support</a></li>" +
        "<li aria-current=\"page\">Ticket</li>" +
      "</ol></nav>" +
      "<header class=\"account-recently-viewed__head\">" +
        "<h1 class=\"account-returns__title\">" + esc(String(t.subject)) + "</h1>" +
        _supportStatusBadge(t.status) +
      "</header>" +
      "<p class=\"return-card__meta\">" + esc(_supportCategoryLabel(t.category)) + "</p>" +
      replyOk + notice +
      "<ul class=\"support-thread\">" + msgHtml + "</ul>" +
      replyForm +
    "</section>";
  return _wrap({
    title:      String(t.subject),
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// ---- privacy & data (customer self-service DSR) ------------------------
//
// The signed-in customer files an export request (a copy of their data) OR
// a deletion request (erasure), sees their own request history, and
// downloads a fulfilled export bundle. Self-service FILES the request; an
// operator reviews + executes it from the admin queue (identity
// verification is a controller obligation under every jurisdiction). Every
// dynamic value — including the customer's own free-text deletion reason
// replayed in the history — is escaped (b.template.escapeHtml); the
// primitive bounds length but does NOT strip HTML.
var _DSR_JURISDICTIONS = [
  ["gdpr", "GDPR (EU / UK)"],
  ["ccpa", "CCPA (California)"],
  ["lgpd", "LGPD (Brazil)"],
  ["other", "Other"],
];
var _DSR_SCOPES = [
  ["full", "Everything we hold on you"],
  ["orders_only", "Orders only"],
  ["identity_only", "Profile + addresses only"],
];

function _dsrStatusBadge(status) {
  var esc = b.template.escapeHtml;
  return "<span class=\"pdp__badge dsr-status--" + esc(String(status)) + "\">" + esc(String(status)) + "</span>";
}

function renderAccountPrivacy(opts) {
  var esc = b.template.escapeHtml;
  var history = opts.history || [];
  var notice = "";
  if (opts.ok === "export") {
    notice = "<p class=\"form-notice form-notice--ok\" role=\"status\">Your data export request has been filed. We'll prepare it and let you know when it's ready to download.</p>";
  } else if (opts.ok === "deletion") {
    notice = "<p class=\"form-notice form-notice--ok\" role=\"status\">Your erasure request has been filed. We'll verify your identity and confirm once it's complete.</p>";
  } else if (opts.notice) {
    notice = "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>";
  }

  var jurisdictionOpts = _DSR_JURISDICTIONS.map(function (j) {
    return "<option value=\"" + esc(j[0]) + "\">" + esc(j[1]) + "</option>";
  }).join("");
  var scopeOpts = _DSR_SCOPES.map(function (s) {
    return "<option value=\"" + esc(s[0]) + "\">" + esc(s[1]) + "</option>";
  }).join("");

  var rowsHtml = "";
  for (var i = 0; i < history.length; i += 1) {
    var r = history[i];
    var date = r.requested_at ? new Date(Number(r.requested_at)).toISOString().slice(0, 10) : "";
    var kindLabel = r.request_kind === "export" ? "Data export" : "Erasure";
    var download = (r.request_kind === "export" && (r.status === "fulfilled" || r.status === "delivered"))
      ? " &middot; <a href=\"/account/privacy/" + esc(String(r.id)) + "/export.json\">Download</a>"
      : "";
    var reason = r.reason
      ? "<p class=\"return-card__meta\">Reason: " + esc(String(r.reason)) + "</p>"
      : "";
    rowsHtml +=
      "<li class=\"return-card\">" +
        "<div class=\"return-card__head\">" +
          "<span class=\"return-card__rma\">" + esc(kindLabel) + "</span>" +
          _dsrStatusBadge(r.status) +
        "</div>" +
        "<p class=\"return-card__meta\">" + esc(String(r.jurisdiction).toUpperCase()) +
          (date ? " &middot; <time datetime=\"" + esc(date) + "\">" + esc(date) + "</time>" : "") +
          download +
        "</p>" +
        reason +
      "</li>";
  }
  var historyInner = rowsHtml
    ? "<ul class=\"return-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\"><p class=\"account-empty__lede\">You haven't filed any privacy requests yet.</p></div>";

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Privacy &amp; data</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Privacy &amp; data</h1>" +
      "<p class=\"section-head__lede\">Request a copy of the personal data we hold on you, or ask us to erase it. " +
        "Most requests are completed within the statutory window (GDPR: one month; CCPA: 45 days; LGPD: 15 days).</p>" +
      notice +
      "<div class=\"panel\">" +
        "<h2 class=\"pdp__variants-title\">Request a copy of your data</h2>" +
        "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/privacy/export\">" +
          "<label class=\"form-field\"><span class=\"form-field__label\">Applicable law</span>" +
            "<select name=\"jurisdiction\" required>" + jurisdictionOpts + "</select></label>" +
          "<label class=\"form-field\"><span class=\"form-field__label\">What to include</span>" +
            "<select name=\"scope\" required>" + scopeOpts + "</select></label>" +
          "<button type=\"submit\" class=\"btn-primary\">Request my data</button>" +
        "</form>" +
      "</div>" +
      "<div class=\"panel\">" +
        "<h2 class=\"pdp__variants-title\">Erase your data</h2>" +
        "<p class=\"return-card__meta\">This files a request to permanently erase your personal data. " +
          "We'll verify your identity before acting on it.</p>" +
        "<a class=\"btn-secondary\" href=\"/account/delete\">Request erasure</a>" +
      "</div>" +
      "<h2 class=\"pdp__variants-title\">Your requests</h2>" +
      historyInner +
    "</section>";
  return _wrap({
    title:      "Privacy & data",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    body:       body,
  });
}

// Server-rendered erasure-confirm interstitial (the CSP forbids a client
// confirm()). Filing requires a non-empty reason + a jurisdiction. A Cancel
// link returns to the privacy page.
function renderAccountDelete(opts) {
  var esc = b.template.escapeHtml;
  var v = opts.values || {};
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var jurisdictionOpts = _DSR_JURISDICTIONS.map(function (j) {
    var sel = v.jurisdiction === j[0] ? " selected" : "";
    return "<option value=\"" + esc(j[0]) + "\"" + sel + ">" + esc(j[1]) + "</option>";
  }).join("");
  var body =
    "<section class=\"return-form-page\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/privacy\">Privacy &amp; data</a></li>" +
        "<li aria-current=\"page\">Erase my data</li>" +
      "</ol></nav>" +
      "<h1 class=\"return-form-page__title\">Request data erasure</h1>" +
      "<p class=\"form-notice\" role=\"note\">Filing this request asks us to permanently erase the personal data we hold on you. " +
        "Orders and other records we're legally required to keep are retained but de-linked from your identity. " +
        "We'll verify your identity before acting on it. This cannot be undone.</p>" +
      notice +
      "<form class=\"return-form form-stack\" method=\"post\" action=\"/account/delete\">" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Applicable law</span>" +
          "<select name=\"jurisdiction\" required>" + jurisdictionOpts + "</select></label>" +
        "<label class=\"form-field\"><span class=\"form-field__label\">Reason for your request</span>" +
          "<textarea name=\"reason\" required maxlength=\"4000\" rows=\"4\">" + esc(v.reason == null ? "" : String(v.reason)) + "</textarea></label>" +
        "<div class=\"actions-row\">" +
          "<button type=\"submit\" class=\"btn-primary\">File erasure request</button>" +
          "<a class=\"btn-secondary\" href=\"/account/privacy\">Cancel</a>" +
        "</div>" +
      "</form>" +
    "</section>";
  return _wrap({
    title:      "Erase my data",
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

// Store credit is account-bound and carries no per-row currency — the
// ledger stores integer minor units in the shop's single display
// currency. The storefront's other account surfaces (loyalty "worth",
// the order-history total fallback) format in USD, so the wallet does
// too; a future multi-currency store threads the resolved code in here.
var STORE_CREDIT_CURRENCY = "USD";

// A human label for the credit-row provenance enum
// (store_credit_ledger.source). Falls back to the raw code so a future
// source the renderer hasn't learned still shows something sensible.
var STORE_CREDIT_SOURCE_LABELS = {
  refund:             "Refund",
  goodwill:           "Goodwill",
  promotional:        "Promotion",
  manual:             "Manual adjustment",
  loyalty_redemption: "Loyalty redemption",
};

// A ledger row's amount, signed by its kind: credit adds (+), debit and
// expire subtract (−). The amount is always stored positive, so the
// sign comes from `kind`. The minor-unit amount is formatted through the
// shared `pricing.format` money helper (Intl-backed, ISO 4217 exponent),
// never hand-rolled.
function _storeCreditSignedAmount(row) {
  var minor = Number(row.amount_minor) || 0;
  var money = pricing.format(minor, STORE_CREDIT_CURRENCY);
  if (row.kind === "credit") return "+" + money;
  return "−" + money;   // U+2212 MINUS SIGN
}

// A ledger row's reason text. Credit rows carry an operator-authored
// free-form `source_ref` plus the provenance enum; expire rows carry the
// operator's justification in `source_ref` (the primitive writes the
// `reason` there). Debit rows settle an order and carry neither — they
// read as a plain "Spent". The caller escapes on output.
function _storeCreditReasonText(row) {
  if (row.kind === "credit") {
    var label = STORE_CREDIT_SOURCE_LABELS[row.source] || String(row.source || "Credit");
    return row.source_ref ? (label + " — " + String(row.source_ref)) : label;
  }
  if (row.kind === "expire") {
    return row.source_ref ? ("Expired — " + String(row.source_ref)) : "Expired";
  }
  return "Spent";   // debit — settles an order
}

// The signed-in customer's store-credit wallet: the current balance, an
// expiring-soon callout when any credit is within the warning window,
// and the credit/debit/expire ledger (paginated, newest first). A wallet
// with zero balance + no history renders a clean empty state, not an
// error. Read-only — granting/deducting is operator-only on the admin
// customer-detail screen. Every amount, reason, and date is escaped on
// output. Reuses the account/returns + loyalty layout classes — no new
// CSS.
function renderAccountStoreCredit(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;

  var balanceMinor = Number(opts.balance_minor) || 0;
  var balanceStr   = pricing.format(balanceMinor, STORE_CREDIT_CURRENCY);

  // Balance stat strip.
  var stats =
    "<dl class=\"account-dash__stats\">" +
      "<div><dt>Store credit</dt><dd>" + esc(balanceStr) + "</dd></div>" +
    "</dl>";

  // Expiring-soon callout — only when a credit row is inside the warning
  // window. Sums the exposed (still-spendable) amounts and names the
  // soonest deadline.
  var expiring = opts.expiring || [];
  var expiringSection = "";
  if (expiring.length) {
    var expMinor = 0;
    var soonest = null;
    for (var e = 0; e < expiring.length; e += 1) {
      expMinor += Number(expiring[e].amount_minor) || 0;
      var ea = Number(expiring[e].expires_at);
      if (isFinite(ea) && (soonest == null || ea < soonest)) soonest = ea;
    }
    var expStr  = pricing.format(expMinor, STORE_CREDIT_CURRENCY);
    var expDate = soonest != null ? new Date(soonest).toISOString().slice(0, 10) : "";
    expiringSection =
      "<p class=\"form-notice\" role=\"status\">" +
        esc(expStr) + " of your store credit expires soon" +
        (expDate ? " &mdash; use it by <time datetime=\"" + esc(expDate) + "\">" + esc(expDate) + "</time>" : "") +
      "</p>";
  }

  // The credit/debit/expire ledger, newest first.
  var hist = opts.history || [];
  var histInner = "";
  for (var h = 0; h < hist.length; h += 1) {
    var row = hist[h];
    var tdate = row.occurred_at ? new Date(Number(row.occurred_at)).toISOString().slice(0, 10) : "";
    var rowExpiry = (row.kind === "credit" && row.expires_at != null)
      ? new Date(Number(row.expires_at)).toISOString().slice(0, 10)
      : "";
    histInner +=
      "<li class=\"return-card\"><div class=\"return-card__head\">" +
        "<span class=\"pdp__badge store-credit-tx--" + esc(String(row.kind)) + "\">" + esc(String(row.kind)) + "</span>" +
        "<span class=\"return-card__rma\">" + esc(_storeCreditSignedAmount(row)) + "</span>" +
      "</div>" +
      "<p class=\"return-card__meta\">" + esc(_storeCreditReasonText(row)) +
        (tdate ? " &middot; <time datetime=\"" + esc(tdate) + "\">" + esc(tdate) + "</time>" : "") +
        (rowExpiry ? " &middot; expires <time datetime=\"" + esc(rowExpiry) + "\">" + esc(rowExpiry) + "</time>" : "") +
      "</p></li>";
  }
  var historySection;
  if (histInner) {
    var more = opts.history_next_cursor != null
      ? "<p class=\"loyalty-more\"><a class=\"btn-secondary\" href=\"/account/credit?cursor=" +
          esc(String(opts.history_next_cursor)) + "\">Older activity</a></p>"
      : "";
    historySection = "<h2 class=\"pdp__variants-title\">Activity</h2><ul class=\"return-list\">" + histInner + "</ul>" + more;
  } else {
    historySection = "<h2 class=\"pdp__variants-title\">Activity</h2>" +
      "<p class=\"return-empty\">No store credit yet. Refunds and goodwill credit will show up here.</p>";
  }

  var body =
    "<section class=\"account-returns\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Store credit</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Store credit</h1>" +
      stats +
      expiringSection +
      historySection +
    "</section>";

  return _wrap({
    title:      "Store credit",
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

// Local control-state, derived the same way subscriptionControls derives
// it — `cancelled_at` set ⇒ cancelled, else `paused_at` set ⇒ paused,
// else active. This is the lifecycle the self-manage controls act on; it
// rides alongside Stripe's `status` (the billing mirror), which the
// controls primitive never writes.
function _subscriptionControlState(sub) {
  if (sub.cancelled_at != null) return "cancelled";
  if (sub.paused_at != null)    return "paused";
  return "active";
}

// The 90-day reactivation grace mirrors subscriptionControls.REACTIVATE_
// GRACE_MS. A cancelled row is reactivatable from the storefront while
// the cancellation is inside that window; past it, the primitive refuses
// and the customer must re-subscribe.
var REACTIVATE_GRACE_MS = b.constants.TIME.days(90);
function _subscriptionIsReactivatable(sub) {
  return sub.cancelled_at != null && (Date.now() - Number(sub.cancelled_at)) <= REACTIVATE_GRACE_MS;
}

// The cadence-change <select> options — mirrors subscriptionControls.
// FREQUENCIES. Pre-selects the row's current frequency when set.
var SUB_FREQUENCIES = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"];
function _frequencyOptions(current) {
  var esc = b.template.escapeHtml;
  var out = "";
  for (var i = 0; i < SUB_FREQUENCIES.length; i += 1) {
    var f = SUB_FREQUENCIES[i];
    out += "<option value=\"" + f + "\"" + (f === current ? " selected" : "") + ">" + esc(f) + "</option>";
  }
  return out;
}

// Map the ?ok=<kind> self-manage redirect marker to confirmation copy
// rendered (role="status") at the top of the list. Unknown markers
// degrade to no notice so a forged query can't inject copy. The legacy
// ?canceled=1 marker keeps its own message (set by the route).
var SUBSCRIPTION_OK = {
  paused:    "Your subscription is paused.",
  resumed:   "Your subscription has resumed.",
  skipped:   "Your next shipment has been skipped.",
  quantity:  "Quantity updated.",
  frequency: "Delivery frequency updated.",
  reactivated: "Your subscription has been reactivated.",
};
function _subscriptionOkCopy(kind) {
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_OK, kind) ? SUBSCRIPTION_OK[kind] : null;
}

// Self-manage failures round-trip a fixed ?error=<code> so the list can
// echo a human message without reflecting an attacker-controlled string.
// Unknown codes → no notice.
var SUBSCRIPTION_ERR = {
  quantity:    "Enter a quantity of 1 or more.",
  frequency:   "Choose a valid delivery frequency.",
  state:       "That change isn't available for this subscription right now.",
  grace:       "This subscription was cancelled too long ago to reactivate. Start a new one instead.",
};
function _subscriptionErrorCopy(code) {
  if (code == null) return null;
  return Object.prototype.hasOwnProperty.call(SUBSCRIPTION_ERR, code) ? SUBSCRIPTION_ERR[code] : null;
}

// Customer-facing subscription list. `opts.subscriptions` is an array of
// subscription rows, each optionally carrying a resolved `plan` (joined
// by the route). `opts.can_cancel` is false when the deploy has no
// payment handle wired — the list renders read-only with a note, since
// cancel composes Stripe. `opts.self_manage` adds the pause / resume /
// skip / change-quantity / change-frequency / reactivate controls (wired
// only when the subscriptionControls primitive is available). Empty state
// points at the catalog (creation is a separate Stripe-subscription-
// checkout surface, not built here).
function renderAccountSubscriptions(opts) {
  var esc = b.template.escapeHtml;
  var subs = opts.subscriptions || [];
  var canCancel = opts.can_cancel !== false;
  var selfManage = opts.self_manage === true;
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
    var controlState = _subscriptionControlState(s);
    // Local-state meta line (paused / cancelled) so the customer sees the
    // self-managed cadence state distinct from the Stripe billing pill.
    var stateNote = "";
    if (selfManage && controlState === "paused") {
      if (s.paused_until != null) {
        var pUntil = new Date(Number(s.paused_until)).toISOString().slice(0, 10);
        stateNote = "Paused until <time datetime=\"" + esc(pUntil) + "\">" + esc(pUntil) + "</time>";
      } else {
        stateNote = "Paused";
      }
    } else if (selfManage && controlState === "cancelled") {
      stateNote = "Cancelled";
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
    // Self-manage controls — state-gated, mirroring the primitive's FSM
    // (active ⇒ pause / skip / change-qty / change-freq; paused ⇒ resume;
    // cancelled-within-grace ⇒ reactivate). Pause is confirm-gated like
    // cancel (a second server-rendered screen, no inline confirm()); the
    // reversible controls post directly. Quantity / frequency take input
    // validated server-side.
    var manageControls = "";
    if (selfManage) {
      var actId = esc(s.id);
      var ctrls = "";
      if (controlState === "active") {
        ctrls +=
          "<a class=\"btn-ghost btn-ghost--sm\" href=\"/account/subscriptions/" + actId + "/pause\">Pause</a>";
        ctrls +=
          "<form class=\"subscription-card__control\" method=\"post\" action=\"/account/subscriptions/" + actId + "/skip\">" +
            "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Skip next shipment</button>" +
          "</form>";
        ctrls +=
          "<form class=\"subscription-card__control subscription-card__control--qty\" method=\"post\" action=\"/account/subscriptions/" + actId + "/quantity\">" +
            "<label class=\"form-field form-field--inline\">" +
              "<span class=\"form-field__label\">Quantity</span>" +
              "<input type=\"number\" name=\"quantity\" min=\"1\" step=\"1\" value=\"" + esc(String(s.quantity == null ? 1 : s.quantity)) + "\" required>" +
            "</label>" +
            "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Update quantity</button>" +
          "</form>";
        ctrls +=
          "<form class=\"subscription-card__control subscription-card__control--freq\" method=\"post\" action=\"/account/subscriptions/" + actId + "/frequency\">" +
            "<label class=\"form-field form-field--inline\">" +
              "<span class=\"form-field__label\">Frequency</span>" +
              "<select name=\"frequency\" required>" + _frequencyOptions(s.frequency || null) + "</select>" +
            "</label>" +
            "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Update frequency</button>" +
          "</form>";
      } else if (controlState === "paused") {
        ctrls +=
          "<form class=\"subscription-card__control\" method=\"post\" action=\"/account/subscriptions/" + actId + "/resume\">" +
            "<button type=\"submit\" class=\"btn-primary btn-primary--sm\">Resume</button>" +
          "</form>";
      } else if (controlState === "cancelled" && _subscriptionIsReactivatable(s)) {
        ctrls +=
          "<form class=\"subscription-card__control\" method=\"post\" action=\"/account/subscriptions/" + actId + "/reactivate\">" +
            "<button type=\"submit\" class=\"btn-primary btn-primary--sm\">Reactivate</button>" +
          "</form>";
      }
      if (ctrls) manageControls = "<div class=\"subscription-card__manage\">" + ctrls + "</div>";
    }
    rowsHtml +=
      "<li class=\"subscription-card\">" +
        "<div class=\"subscription-card__head\">" +
          "<span class=\"subscription-card__plan\">" + planSummary + "</span>" +
          _subscriptionStatusBadge(s.status) +
        "</div>" +
        (renewalNote ? "<p class=\"subscription-card__meta\">" + renewalNote + "</p>" : "") +
        (stateNote ? "<p class=\"subscription-card__state\">" + stateNote + "</p>" : "") +
        manageControls +
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
  // The notice is either the success copy from a self-manage ?ok=<kind>
  // round-trip (role="status") or an error string the POST handler passes
  // back (role="alert"). The legacy cancel notice arrives as opts.notice.
  var noticeHtml = "";
  if (opts.error) {
    noticeHtml = "<p class=\"form-notice form-notice--error\" role=\"alert\">" + esc(String(opts.error)) + "</p>";
  } else if (opts.notice) {
    noticeHtml = "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(String(opts.notice)) + "</p>";
  }
  var body =
    "<section class=\"account-subscriptions\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Subscriptions</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-subscriptions__title\">Subscriptions</h1>" +
      noticeHtml +
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

// The customer's pre-order reservations (`GET /account/preorders`). Each row
// shows the campaign (the SKU's product context isn't loaded here — the
// campaign slug + release date + status are the durable identity), its
// release date, the reserved quantity, and the reservation status pill. An
// ACTIVE reservation offers a Cancel control (ownership-scoped POST); a
// converted (now an order) / cancelled reservation is read-only. `reservations`
// rows are decorated with `.campaign` by the route. JS-off-native.
function renderAccountPreorders(opts) {
  var esc = b.template.escapeHtml;
  var rows = opts.reservations || [];
  var rowsHtml = "";
  for (var i = 0; i < rows.length; i += 1) {
    var r = rows[i];
    var c = r.campaign || null;
    var releaseStr = c && c.launch_at
      ? new Date(Number(c.launch_at)).toISOString().slice(0, 10)
      : "";
    var priceStr = "";
    if (c) {
      try { priceStr = esc(pricing.format(Number(c.full_price_minor), String(c.currency || "USD"))) + " · "; }
      catch (_e) { priceStr = ""; }
    }
    var status = String(r.status || "active");
    var statusLabel = status === "converted" ? "Ordered" : status === "cancelled" ? "Canceled" : "Reserved";
    var releaseLine = releaseStr
      ? "Ships <time datetime=\"" + esc(releaseStr) + "\">" + esc(releaseStr) + "</time>"
      : "";
    var cancelControl = status === "active"
      ? "<form class=\"preorder-card__control\" method=\"post\" action=\"/account/preorders/" + esc(String(r.id)) + "/cancel\">" +
          "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Cancel reservation</button>" +
        "</form>"
      : "";
    rowsHtml +=
      "<li class=\"preorder-card preorder-card--" + esc(status) + "\">" +
        "<div class=\"preorder-card__head\">" +
          "<span class=\"preorder-card__title\">" + esc(c ? String(c.slug) : String(r.campaign_slug)) + "</span>" +
          "<span class=\"status-pill preorder-status--" + esc(status) + "\">" + esc(statusLabel) + "</span>" +
        "</div>" +
        "<p class=\"preorder-card__meta\">" + priceStr + "Qty " + esc(String(r.quantity)) + (releaseLine ? " · " + releaseLine : "") + "</p>" +
        cancelControl +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"preorder-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\">" +
        "<p class=\"account-empty__lede\">You have no pre-order reservations.</p>" +
        "<a class=\"btn-secondary\" href=\"/\">Browse the shop →</a>" +
      "</div>";
  var noticeHtml = opts.notice
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var body =
    "<section class=\"account-preorders\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Pre-orders</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-preorders__title\">Pre-orders</h1>" +
      noticeHtml +
      inner +
    "</section>";
  return _wrap({
    title:      "Pre-orders",
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

// Server-rendered confirmation step for pausing a subscription. Pause is
// a reversible-but-deliberate state change, so it gets the same confirm-
// GET → POST gate the cancel flow uses (CSP forbids an inline confirm()).
// The form posts straight back to /pause; a "Keep it active" link returns
// to the list. JS-off-native.
function renderSubscriptionPauseConfirm(opts) {
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
  var pauseForm =
    "<form method=\"post\" action=\"/account/subscriptions/" + esc(s.id) + "/pause\">" +
      "<p class=\"account-confirm__option\">Pausing holds your deliveries until you resume. No shipments go out and you won't be billed for the paused period; resume any time to pick back up.</p>" +
      "<button type=\"submit\" class=\"btn-primary\">Pause subscription</button>" +
    "</form>";
  var body =
    "<section class=\"account-confirm\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li><a href=\"/account/subscriptions\">Subscriptions</a></li>" +
        "<li aria-current=\"page\">Pause</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-confirm__title\">Pause " + esc(planSummary) + "?</h1>" +
      "<div class=\"account-confirm__actions\">" +
        pauseForm +
        "<a class=\"btn-ghost\" href=\"/account/subscriptions\">Keep it active</a>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Pause subscription",
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
// the `</script` → `<\/script` rewrite neutralises any literal closing
// tag in a value. The HTML tokenizer ends a <script> on `</script`
// followed by whitespace, `/`, or `>`, so matching only the exact
// `</script>` byte sequence misses `</script `, `</script\n`,
// `</script/` — all of which still break out. Matching `</script`
// (any trailing byte) closes every variant. Mirrors the edge
// renderer's `jsonLdScript` byte-for-byte (this output is dual-rendered
// edge + container; the render-parity tests gate on the two agreeing).
function _jsonLdScript(data) {
  var serialised = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
  return "<script type=\"application/ld+json\">" + serialised + "</script>";
}

// PWA default manifest + service worker — the shipped fallback served at
// /manifest.webmanifest + /sw.js when the operator has not defined an
// active pwaManifest row. BOTH substrates serve these exact bytes (the
// edge has no DB-backed primitive; the container's DB-backed pwaManifest is
// the override), so the `<link rel="manifest">` in every layout never 404s
// on a fresh deploy. The byte-identical twin of
// worker/render/_lib.js's PWA_DEFAULT_MANIFEST / PWA_DEFAULT_SW — a parity
// test pins them. An operator customizes via pwaManifest.defineManifest +
// setActive on the container path.
var _PWA_DEFAULT_MANIFEST_OBJ = {
  name:             "blamejs.shop",
  short_name:       "blamejs.shop",
  description:      "Open-source ecommerce framework built on blamejs — server-rendered HTML, post-quantum crypto, zero npm runtime dependencies.",
  start_url:        "/",
  scope:            "/",
  display:          "standalone",
  orientation:      "portrait",
  theme_color:      "#08080a",
  background_color: "#08080a",
  lang:             "en",
  dir:              "ltr",
  icons: [
    { src: "/assets/brand/favicon.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/assets/brand/favicon.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    { src: "/assets/brand/favicon.svg", sizes: "any",     type: "image/svg+xml", purpose: "any" }
  ]
};
var PWA_DEFAULT_MANIFEST = JSON.stringify(_PWA_DEFAULT_MANIFEST_OBJ, null, 2);

var PWA_DEFAULT_SW =
  "// service worker — shipped default (pass-through navigation fallback)\n" +
  "\"use strict\";\n" +
  "var CACHE_NAME = \"blamejs-shop-default-v1\";\n" +
  "self.addEventListener(\"install\", function (e) { self.skipWaiting(); });\n" +
  "self.addEventListener(\"activate\", function (e) {\n" +
  "  e.waitUntil(caches.keys().then(function (keys) {\n" +
  "    return Promise.all(keys.map(function (k) { if (k !== CACHE_NAME) return caches.delete(k); }));\n" +
  "  }).then(function () { return self.clients.claim(); }));\n" +
  "});\n" +
  "self.addEventListener(\"fetch\", function (e) {\n" +
  "  if (e.request.method !== \"GET\") return;\n" +
  "  if (e.request.mode === \"navigate\") {\n" +
  "    e.respondWith(fetch(e.request).catch(function () { return caches.match(\"/\"); }));\n" +
  "  }\n" +
  "});\n";

// QAPage JSON-LD from the PDP's published Q&A threads. Surfaces the
// question + its answers in Google's Q&A rich result. Emitted only when at
// least one question has at least one answer — Google rejects a QAPage
// whose Question carries neither an `acceptedAnswer` nor a
// `suggestedAnswer`. The first answer is the `acceptedAnswer`; the rest are
// `suggestedAnswer`. `q.body` / `a.body` are operator/customer free text —
// `_jsonLdScript` JSON.stringify's them (neutralizing quotes + the
// `</script` breakout), so they are NOT additionally HTML-escaped (JSON-LD
// is not HTML, by the documented `_jsonLdScript` contract — the same trust
// model as the Product JSON-LD `description`). The byte-identical twin of
// the edge's `worker/render/product.js#_buildQaPageJsonLd`; a parity test
// pins the two. Returns "" when there is nothing rich-result-eligible.
function _buildQaPageJsonLd(questions) {
  questions = questions || [];
  var mainEntity = [];
  for (var i = 0; i < questions.length; i += 1) {
    var q = questions[i];
    var answers = (q && q.answers) || [];
    if (answers.length === 0) continue;
    var question = {
      "@type":       "Question",
      "name":        String(q.body),
      "answerCount": answers.length,
      "acceptedAnswer": { "@type": "Answer", "text": String(answers[0].body) },
    };
    if (answers.length > 1) {
      var suggested = [];
      for (var j = 1; j < answers.length; j += 1) {
        suggested.push({ "@type": "Answer", "text": String(answers[j].body) });
      }
      question.suggestedAnswer = suggested;
    }
    mainEntity.push(question);
  }
  if (mainEntity.length === 0) return "";
  return _jsonLdScript({
    "@context":   "https://schema.org",
    "@type":      "QAPage",
    "mainEntity": mainEntity,
  });
}

// ---- hreflang alternates (URL-shaped locale policies) ------------------
//
// The href math + validation envelopes below are the byte-identical twin
// of worker/render/chrome-i18n.js's `alternateLinks` so the edge + the
// container emit the same `<link rel="alternate" hreflang>` block for the
// same (host, path, supported, default, strategy). A parity test pins the
// two. Both mirror lib/locale-router.js#_canonicalForUrl's prefix /
// subdomain substitution.
var _HREFLANG_TAG_RE  = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
var _HREFLANG_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

function _hreflangStripLeadingSegment(path) {
  var rest = path.charAt(0) === "/" ? path.slice(1) : path;
  if (!rest.length) return null;
  var slash = rest.indexOf("/");
  var seg = slash === -1 ? rest : rest.slice(0, slash);
  if (!seg.length || seg.length > 35 || !_HREFLANG_TAG_RE.test(seg)) return null;
  return seg;
}

function _hreflangStripLeadingSubdomain(host) {
  if (host.indexOf(".") === -1) return null;
  var first = host.slice(0, host.indexOf("."));
  if (!first.length || first.length > 35 || !_HREFLANG_TAG_RE.test(first)) return null;
  return first;
}

function _canonicalForLocaleUrl(host, path, locale, strategy) {
  var lc = String(locale).toLowerCase();
  if (strategy === "url_prefix") {
    var prefix = _hreflangStripLeadingSegment(path);
    var rest;
    if (prefix) {
      rest = path.slice(1 + prefix.length);
      if (rest.length === 0) rest = "/";
    } else {
      rest = path;
    }
    if (rest.charAt(0) !== "/") rest = "/" + rest;
    return "https://" + host + "/" + lc + (rest === "/" ? "" : rest);
  }
  if (strategy === "subdomain") {
    var sub = _hreflangStripLeadingSubdomain(host);
    var apex = sub ? host.slice(sub.length + 1) : host;
    return "https://" + lc + "." + apex + path;
  }
  return null;
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
  // "You may also like" rail — same-collection picks the route decorated
  // with each card's hero media + first-variant price (minor units). The
  // price string is formatted here with the page's own `fmt` so it tracks
  // the active currency context exactly as the buy-box prices do. Mirrors
  // the edge renderer (`worker/render/product.js`) so the section is
  // byte-identical across substrates. Built once, shared by the theme
  // branch's raw slot and the inline-template branch's placeholder.
  var relatedAssetPrefix = opts.asset_prefix || "/assets/";
  var relatedCards = (opts.related || []).map(function (r) {
    var priceStr = Number.isInteger(r.price_minor)
      ? fmt(r.price_minor, r.price_currency || "USD")
      : "—";
    return {
      slug:      r.slug,
      title:     r.title,
      price:     priceStr,
      image_url: r.hero_r2_key ? (relatedAssetPrefix + r.hero_r2_key) : null,
      image_alt: r.hero_r2_key ? (r.hero_alt_text || r.title) : null,
    };
  });
  var relatedHtml = _buildRelatedProducts(relatedCards);
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
      // Pre-rendered "You may also like" rail for the theme's
      // `{{{ related_html }}}` raw slot. Empty string when the product
      // has no same-collection siblings to show.
      related_html:   relatedHtml,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  // Truthful availability + shipping shape — drives the on-page badges
  // AND the JSON-LD `availability` from the same resolved values so the
  // two never disagree. `opts.inventory` is the per-SKU map the route
  // loads ({ sku: { stock_on_hand, stock_held } }); absent it, the
  // product reads as in stock (never-block-on-missing-inventory stance).
  var availability = _resolveAvailability(variants, opts.inventory);
  // An OPEN pre-order campaign for the lead SKU swaps the add-to-cart buy box
  // for the reservation CTA — a not-yet-released SKU isn't normally
  // purchasable, so the only honest action is to reserve a unit. The route
  // threads `opts.preorder_campaign` ({ campaign, remaining_units }) from a
  // live D1 read; the shape is built here with the page's own `fmt` so the
  // CTA's prices track the active currency context exactly as the buy-box
  // prices do, and the container + edge render byte-identically. Absent a
  // campaign (or a non-active one), the standard buy box renders unchanged.
  var preorderShape = opts.preorder_campaign
    ? preorderCtaShape(opts.preorder_campaign.campaign, { remaining_units: opts.preorder_campaign.remaining_units }, fmt, opts.product.slug)
    : null;
  // Multi-variant headline price — "From <lowest>" so the buy box never
  // advertises a price that isn't the cheapest buyable variant (variants[0]
  // may not be the cheapest). The minimum is computed over the integer
  // amount_minor map and formatted ONCE via the page's own `fmt` (never by
  // comparing formatted strings — "$9.99" < "$10.00" sorts wrong as text).
  // Single-variant, no-price, and all-equal-price products keep the lead
  // variant's exact price string ("From X" when there's only one X is
  // noise). Kept byte-identical to worker/render/product.js. See UX-5.
  var headlinePrice = _buildHeadlinePrice(rendered, variants, prices, fmt);
  var buyboxHtml = preorderShape
    ? _buildPreorderCta(preorderShape, b.template.escapeHtml)
    : _buildBuyBox(rendered, b.template.escapeHtml, availability, headlinePrice);
  // The reserve PRG lands the shopper back on the PDP with a fixed
  // ?preorder=<reserved|unavailable|closed> marker; the banner prepends the
  // buy box. The marker set is closed (built from a lookup, never the raw
  // query), so a forged query can't inject copy. Mirrored at the edge.
  buyboxHtml = _buildPreorderNotice(opts.preorder_notice) + buyboxHtml;
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
    .replace("RAW_QA_PLACEHOLDER", qaHtml)
    .replace("RAW_RELATED_PLACEHOLDER", relatedHtml);
  // Product-specific OpenGraph + Twitter Card values so shares
  // unfurl as "Operator Tee — blamejs.shop" with the SVG hero, not
  // the default shop-level description + brand logo.
  var heroMedia = (opts.media && opts.media[0]) || null;
  // Absolute base for the BreadcrumbList `item` URLs — derived from the
  // PDP's own canonical (origin stripped of the /products/slug path) so
  // the structured-data trail carries fully-qualified URLs. Falls back to
  // the shop-name host when the renderer is called without a request URL.
  var absoluteBase = _absoluteBase(opts.canonical_url, shopName);
  // og:image / twitter:image / the Product JSON-LD `image` all carry a
  // FULLY-QUALIFIED URL — a relative hero path (or the brand-logo default)
  // is dropped by social-share crawlers and by Google's product rich
  // result. Absolutize once here so the JSON-LD `image` (built below,
  // before `_wrap`) and the meta tags (`_wrap` re-runs the idempotent
  // absolutizer) both carry the resolved URL.
  var ogImage   = _absolutizeOgImage(
    heroMedia ? ((opts.asset_prefix || "/assets/") + heroMedia.r2_key) : "/assets/brand/logo.png",
    opts.canonical_url, shopName
  );

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
  // QAPage JSON-LD from the published Q&A (empty string when no question is
  // answered — Google rejects an answerless QAPage). Mirrors the edge.
  var qaPageJsonLd = _buildQaPageJsonLd(opts.qa_questions);
  jsonLd = (jsonLd || "") + breadcrumbJsonLd + qaPageJsonLd;

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
  "RAW_CART_LINE_STOCK" +
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
// address, or the shopper's own typed values on a validation re-render);
// every value is escaped by `_addrField` / the email builder.
// Street line 1 + city are marked required for the common physical-goods
// path, and the POST handler enforces the same set server-side via
// _requireCheckoutFields (backend validates, frontend displays). The
// service tier (checkout._shipTo) stays presence-optional so a non-form
// caller can still complete a digital-only order with a bare country.
function _checkoutShippingFields(p, inv) {
  p = p || {};
  var esc = b.template.escapeHtml;
  // Merge the per-field invalid marker (a { field, message } from
  // _checkoutFieldFromError) into a field's opts when it is the one the
  // backend validator rejected. Static "co-err-<name>" id — attacker-
  // uncontrolled. Mirrors _addressForm's _mark.
  function _mark(name, opts) {
    if (inv && inv.field === name) {
      opts.invalid = true;
      opts.error_id = "co-err-" + name;
      opts.error_msg = inv.message;
    }
    return opts;
  }
  var email =
    "<label class=\"form-field\">" +
      "<span class=\"form-field__label\">Email <span class=\"form-field__req\" aria-hidden=\"true\">*</span><span class=\"sr-only\">(required)</span></span>" +
      "<input type=\"email\" name=\"email\" value=\"" + esc(p.email == null ? "" : String(p.email)) + "\" required autocomplete=\"email\"" +
        _fieldAriaAttr("co-err-", "email", inv) + ">" +
      _fieldErrorSpan("co-err-", "email", inv) +
    "</label>";
  return email +
    _addrField("name",  "Full name",      p.name,  _mark("name",  { required: true, maxlength: 120, autocomplete: "name" })) +
    _addrField("line1", "Street address", p.line1, _mark("line1", { required: true, maxlength: 200, autocomplete: "address-line1" })) +
    _addrField("line2", "Apt / suite / unit (optional)", p.line2, _mark("line2", { maxlength: 200, autocomplete: "address-line2" })) +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("city",  "City", p.city, _mark("city", { required: true, maxlength: 120, autocomplete: "address-level2" })) +
      _addrField("state", "State / province code", p.state, _mark("state", { maxlength: 5, pattern: "[A-Za-z0-9]{1,5}", autocomplete: "address-level1" })) +
    "</div>" +
    "<div class=\"form-row form-row--inline\">" +
      _addrField("postal",  "Postal code", p.postal, _mark("postal", { maxlength: 16, autocomplete: "postal-code" })) +
      _addrField("country", "Country (ISO 3166-1)", p.country || "US", _mark("country", { required: true, maxlength: 2, pattern: "[A-Za-z]{2}", autocomplete: "country" })) +
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

// Required fields for the checkout FORM path, enforced before confirm so an
// empty field gets its own per-field error instead of a service-tier shape
// failure deeper in. The service tier (checkout._shipTo) keeps presence
// optional — a digital-only order legitimately ships nothing — but the
// storefront form marks email / name / line1 / city required, and the
// backend enforces the same contract (backend validates, frontend
// displays). US + Canada additionally need a region code and postal code:
// both feed destination tax math. Throws in the same "checkout:
// <container>.<field> — <message>" shape as the service tier so
// _checkoutFieldFromError maps each to its input. The PayPal create route
// shares _shipToFromBody but not this gate — its format errors surface
// through the same service-tier validators.
function _requireCheckoutFields(body, shipTo) {
  if (!body.email || !String(body.email).trim()) {
    throw new TypeError("checkout: customer.email — Enter your email address.");
  }
  if (!body.name || !String(body.name).trim()) {
    throw new TypeError("checkout: customer.name — Enter the recipient's full name.");
  }
  if (!shipTo.line1) throw new TypeError("checkout: ship_to.line1 — Enter a street address.");
  if (!shipTo.city)  throw new TypeError("checkout: ship_to.city — Enter a city.");
  if (shipTo.country === "US" || shipTo.country === "CA") {
    if (!shipTo.state) {
      throw new TypeError(shipTo.country === "US"
        ? "checkout: ship_to.state — Enter a US state or territory code (e.g. CA)."
        : "checkout: ship_to.state — Enter a Canadian province code (e.g. ON).");
    }
    if (!shipTo.postal) {
      throw new TypeError(shipTo.country === "US"
        ? "checkout: ship_to.postal — Enter a ZIP code."
        : "checkout: ship_to.postal — Enter a postal code.");
    }
  }
}

// Checkout mirrors the cart's two-column shell: the shipping form on the
// left, a sticky order-summary rail on the right. The summary lists the
// cart line items + a full Subtotal → tax → shipping → discount → Total
// breakdown, computed from the same tax/shipping primitives the charge
// runs through (estimated against the destination until the shopper
// submits an address; exact on the POST re-render of an entered address).
// An "Edit cart" link near the summary lets the shopper change quantities
// without losing form data.
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
  "RAW_TOTALS_ROWS" +
  "      </dl>\n" +
  "RAW_SUMMARY_NOTE" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n";

// Splice anchor for the optional checkout sub-blocks (pickup picker, gift
// options, loyalty redeem, CAPTCHA). They insert BEFORE this literal so
// they land inside the form, above the submit row — appending before
// "</form>" instead would orphan them below the CTA. Must stay
// byte-identical to the action-row line in CHECKOUT_PAGE above.
var CHECKOUT_ACTIONS_ANCHOR = "        <div class=\"form-actions\">";

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

// The gift message / recipient / hide-prices fields appended into the
// checkout form when the gift-options primitive is wired. These persist
// post-commit via setForOrder (they need the order id). The wrap itself is
// already a cart line (selected on /cart). All values are echoed nowhere
// pre-submit (empty inputs), so no escaping is needed here, but the labels
// are static framework copy. Returns "" when gift options aren't wired.
function _checkoutGiftFields(opts) {
  if (!opts.gift_enabled) return "";
  var hasWrap = !!opts.gift_wrap_sku_in_cart;
  return "<fieldset class=\"checkout-gift\">" +
    "<legend>Gift options</legend>" +
    (hasWrap
      ? "<p class=\"checkout-gift__note\">A gift wrap is in your cart. Add a message and recipient below.</p>"
      : "<p class=\"checkout-gift__note\">Sending this as a gift? Add a message and recipient. (Choose a gift wrap on the cart page.)</p>") +
    "<label class=\"form-field\"><span class=\"form-field__label\">Recipient name <span class=\"small\">(optional)</span></span>" +
      "<input type=\"text\" name=\"gift_recipient_name\" maxlength=\"120\" autocomplete=\"off\"></label>" +
    "<label class=\"form-field\"><span class=\"form-field__label\">Gift message <span class=\"small\">(optional)</span></span>" +
      "<textarea name=\"gift_message\" rows=\"3\" maxlength=\"500\" placeholder=\"Add a note for the recipient\"></textarea></label>" +
    "<label class=\"form-field form-field--check\"><input type=\"checkbox\" name=\"gift_hide_prices\" value=\"1\">" +
      "<span>Hide prices on the packing slip (gift receipt)</span></label>" +
    "</fieldset>";
}

// The "pick up in store" location picker appended into the checkout form
// when the click-and-collect primitive is wired AND at least one active
// pickup location exists. The default is ship-to-me (empty value); choosing
// a location schedules a pickup post-commit. location name/code are operator
// free text — escaped at the sink. Returns "" when no locations.
function _checkoutPickupPicker(opts) {
  var locs = opts.pickup_locations || [];
  if (!locs.length) return "";
  var esc = b.template.escapeHtml;
  var options = "<option value=\"\">Ship to my address</option>" +
    locs.map(function (l) {
      var addr = l.address || {};
      var addrLine = [addr.city, addr.country].filter(Boolean).map(String).join(", ");
      return "<option value=\"" + esc(String(l.code)) + "\">" +
        esc(String(l.name)) + (addrLine ? " — " + esc(addrLine) : "") + "</option>";
    }).join("");
  return "<fieldset class=\"checkout-pickup\">" +
    "<legend>Delivery method</legend>" +
    "<label class=\"form-field\"><span class=\"form-field__label\">How would you like to get your order?</span>" +
      "<select name=\"pickup_location_code\">" + options + "</select></label>" +
    "<p class=\"checkout-pickup__note\">Choose a store to pick up in person, or ship to your address. Shipping is still quoted on the total.</p>" +
    "</fieldset>";
}

function renderCheckoutForm(opts) {
  if (!opts) throw new TypeError("storefront.renderCheckoutForm: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, currency: "USD" };
  var shopName = opts.shop_name || "blamejs.shop";
  var assetPrefix = opts.asset_prefix || "/assets/";
  var lookup = opts.product_lookup || {};
  // Full totals breakdown when the route bundled one (`totals_detail` from
  // _estimateCartTotals); else a subtotal-only fallback so an un-wired
  // checkout still renders an honest Subtotal. Checkout formats in the
  // order's own currency (no display-currency conversion at the pay step).
  var detail = opts.totals_detail || {
    totals: totals, estimated: true, tax_resolved: false, shipping_resolved: false, shipping_label: null,
  };
  var dTotals = detail.totals || totals;
  var subtotal = pricing.format(dTotals.subtotal_minor, dTotals.currency);
  var grandTotal = pricing.format(
    dTotals.grand_total_minor == null ? dTotals.subtotal_minor : dTotals.grand_total_minor,
    dTotals.currency);
  // CAPTCHA widget block (no-op unless a provider is active for checkout).
  // Computed BEFORE the themed early-return so a themed checkout gets the
  // same challenge as the default render — otherwise a configured provider
  // would render a themed form with no widget yet have POST /checkout fail
  // closed on the missing token, breaking every themed-store checkout.
  var checkoutCaptcha = _captchaWidgetBlock(opts.captcha_kind, opts.captcha_public_key, true);
  if (opts.theme) {
    var themed = opts.theme.render("checkout", {
      title:          "Checkout",
      shop_name:      shopName,
      cart_count:     lines.length,
      subtotal:       subtotal,
      total:          grandTotal,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
    if (checkoutCaptcha) themed = themed.replace("</form>", checkoutCaptcha + "</form>");
    return themed;
  }
  // Order-summary line items in the sticky rail — same thumbnail + title
  // pattern as the cart, compact. Formatted in the order's own currency
  // (the checkout total is computed server-side; no display-currency
  // conversion happens at this step).
  var summaryLines = lines.map(function (l) {
    return _checkoutSummaryLine(l, lookup, assetPrefix, pricing.format);
  }).join("");
  var totalsRows = _buildCartTotalsRows(detail, pricing.format, subtotal, grandTotal);
  // Honest summary microcopy: an estimate finalizes at the address step;
  // an entered address reads as the exact total. Mirrors the cart CTA note.
  var summaryNote = detail.estimated
    ? "      <p class=\"cart-page__note\">Estimated tax and shipping for your destination; the exact total is confirmed when you continue. Payment runs through Stripe.</p>\n"
    : "      <p class=\"cart-page__note\">Total includes tax and shipping for the address above. Payment runs through Stripe.</p>\n";
  // A coded gift-card / loyalty error from a rejected POST re-renders the
  // form with the message inline (role="alert") rather than dead-ending on
  // a separate error page — the shopper fixes the bad code in place.
  var inlineError = opts.inline_error
    ? "<p class=\"auth-form__message auth-form__message--err\" role=\"alert\">" + b.template.escapeHtml(String(opts.inline_error)) + "</p>"
    : "";
  // Every RAW_* swap goes through _spliceRaw: the shipping fields echo
  // customer-typed values on a validation re-render and the summary lines
  // carry operator product titles — a `$&`/"$`" in either would corrupt
  // the document via String.replace dollar substitution. `opts.
  // invalid_field` (a { field, message } from _checkoutFieldFromError)
  // marks the one rejected input with aria-invalid + a per-field error
  // span; null renders the no-error form byte-identically.
  var body = _render(CHECKOUT_PAGE, {});
  body = _spliceRaw(body, "RAW_TOTALS_ROWS", totalsRows);
  body = _spliceRaw(body, "RAW_SUMMARY_NOTE", summaryNote);
  body = _spliceRaw(body, "RAW_INLINE_ERROR", inlineError);
  body = _spliceRaw(body, "RAW_SHIPPING_FIELDS", _checkoutShippingFields(opts.prefill, opts.invalid_field));
  body = _spliceRaw(body, "RAW_SUMMARY_LINES", summaryLines);
  // Pick-up-in-store picker, gift personalization, loyalty redeem, and the
  // CAPTCHA widget are spliced in ABOVE the submit action row — inside the
  // form in reading order, never after the CTA where they render as an
  // orphaned block below the button. Order: delivery method, gift options,
  // loyalty redeem, then the CAPTCHA directly above the button so its
  // hidden token field rides the form POST. Each builder returns "" when
  // its feature isn't wired, so an unconfigured store's checkout is
  // byte-identical. Spliced via _spliceRaw (never String.replace) so an
  // operator free-text location name carrying a `$` can't trip dollar
  // substitution. The loyalty block's balance + value are numbers we
  // control and the conversion ratio is the ledger's own constant; it
  // renders only when there's a balance to spend.
  var preActions = _checkoutPickupPicker(opts) + _checkoutGiftFields(opts);
  if (opts.loyalty_balance && opts.loyalty_balance.balance > 0) {
    preActions += _loyaltyCheckoutField(opts.loyalty_balance, opts.loyalty_points_per_usd);
  }
  // The route-scoped CSP that admits the CAPTCHA provider SDK host is set
  // by the GET/POST /checkout handlers.
  if (checkoutCaptcha) {
    preActions += checkoutCaptcha;
  }
  if (preActions) {
    body = _spliceRaw(body, CHECKOUT_ACTIONS_ANCHOR, preActions + CHECKOUT_ACTIONS_ANCHOR);
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

// PayPal Smart Buttons block, appended to the checkout form when PayPal is
// configured. The SDK `<script src>` is admitted by the checkout page's
// route-scoped CSP (the handler adds the "paypal" host set when
// deps.paypal_client_id is set); the create/capture glue lives in the
// external same-origin `paypal-checkout.js` island — NO inline `<script>`.
// client-id + currency ride attribute-escaped `data-*` attributes the island
// reads, never interpolated into executable script.
function _paypalCheckoutBlock(clientId, currency) {
  var esc = b.template.escapeHtml;
  var cid = esc(String(clientId));
  var cur = esc(String(currency || "USD"));
  return "\n<div class=\"checkout-paypal\" id=\"paypal-island\" data-paypal-client-id=\"" + cid + "\" data-currency=\"" + cur + "\" style=\"max-width:32rem;margin:1.5rem auto 0;\">" +
    "<div class=\"pay-card__divider\"><span>or pay with PayPal</span></div>" +
    "<div id=\"paypal-button-container\"></div>" +
    "<p id=\"paypal-error\" class=\"auth-form__message auth-form__message--err\" hidden></p>" +
    "</div>" +
    "<script src=\"https://www.paypal.com/sdk/js?client-id=" + cid + "&currency=" + cur + "&intent=capture\"></script>" +
    _islandScript("paypal-checkout.js") + "\n";
}

// CAPTCHA provider host the provider's challenge SDK is loaded from. The
// kind→URL map mirrors the well-known siteverify/api.js endpoints. Only the
// `api.js` SDK is rendered here; the siteverify call is server-side egress
// (server.js captchaVerify). All four kinds are covered so any operator-
// registered provider renders without a code change.
var _CAPTCHA_SDK = {
  turnstile:    "https://challenges.cloudflare.com/turnstile/v0/api.js",
  hcaptcha:     "https://js.hcaptcha.com/1/api.js",
  recaptcha_v2: "https://www.google.com/recaptcha/api.js?render=explicit",
  recaptcha_v3: "https://www.google.com/recaptcha/api.js?render=explicit",
};

// Map a captcha kind to the CSP_HOSTS key that admits its SDK host.
function _captchaCspKey(kind) {
  if (kind === "recaptcha_v2" || kind === "recaptcha_v3") return "recaptcha";
  return kind;  // turnstile | hcaptcha
}

// The CAPTCHA widget block: a mount div carrying the (escaped) kind +
// sitekey, the provider SDK `<script src>` (admitted by the route-scoped
// CSP the handler sets when a provider is active), the external `captcha.js`
// island that renders the widget + exposes the token, and a hidden field so
// the token rides a plain form POST (checkout). `withField` is false for the
// JSON-ceremony pages (login/register), which read the token via
// window.__captchaToken() instead. Returns "" when no provider is active —
// the unconfigured-store no-op.
function _captchaWidgetBlock(kind, sitekey, withField) {
  if (!kind || !sitekey) return "";
  var esc = b.template.escapeHtml;
  var sdk = _CAPTCHA_SDK[kind];
  if (!sdk) return "";
  var hidden = withField
    ? "<input type=\"hidden\" name=\"captcha_token\" id=\"captcha-token-field\" value=\"\">"
    : "";
  return "\n<div class=\"captcha-block\">" +
    "<div id=\"captcha-widget\" data-captcha-kind=\"" + esc(String(kind)) + "\" data-sitekey=\"" + esc(String(sitekey)) + "\"></div>" +
    hidden +
    "</div>" +
    "<script src=\"" + esc(sdk) + "\" async defer></script>" +
    _islandScript("captcha.js") + "\n";
}

// Stripe Elements payment page — loads Stripe.js (the only third-party
// script, admitted by the route-scoped CSP set on GET /pay/:order_id) and
// an external same-origin island (`pay.js`) that mounts the Payment Element.
// No inline `<script>`: the strict default CSP's
// `require-trusted-types-for 'script'` + the absence of `'unsafe-inline'`
// would block one. The publishable key (operator-supplied env
// `STRIPE_PUBLISHABLE_KEY`) and the per-order PaymentIntent client_secret
// ride HTML-attribute-escaped `data-*` attributes on the mount div — read
// by the island, never interpolated into executable script. The
// client_secret is per-order; never logged, never persisted.
var PAY_PAGE =
  "<section class=\"pay-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Secure checkout · Stripe</p>\n" +
  "    <h1 class=\"section-head__title\">Pay {{grand_total}}</h1>\n" +
  "    <p class=\"section-head__lede\">Order <code class=\"inline-code\">{{order_id}}</code> · the Stripe Payment Element is mounted below in a same-origin form.</p>\n" +
  "  </header>\n" +
  "  <div class=\"pay-card\" id=\"pay-island\" data-pk=\"{{pk}}\" data-cs=\"{{client_secret}}\" data-order=\"{{order_id}}\">\n" +
  "    <div id=\"express-checkout\" class=\"pay-card__express\" hidden>\n" +
  "      <div id=\"express-checkout-element\"></div>\n" +
  "      <div class=\"pay-card__divider\"><span>or pay with card</span></div>\n" +
  "    </div>\n" +
  "    <div id=\"payment-element\" class=\"pay-card__element\"></div>\n" +
  "    <button id=\"submit\" type=\"button\" class=\"btn-primary pay-card__submit\">Pay {{grand_total}}</button>\n" +
  "    <p id=\"payment-message\" class=\"pay-card__message\"></p>\n" +
  "  </div>\n" +
  "  <script src=\"https://js.stripe.com/v3/\"></script>\n" +
  "  RAW_PAY_SCRIPT\n" +
  "</section>\n";

function renderPayPage(opts) {
  if (!opts || !opts.order)              throw new TypeError("storefront.renderPayPage: opts.order required");
  if (!opts.client_secret)               throw new TypeError("storefront.renderPayPage: opts.client_secret required");
  if (!opts.publishable_key)              throw new TypeError("storefront.renderPayPage: opts.publishable_key required");
  var shopName    = opts.shop_name || "blamejs.shop";
  var cartCount   = opts.cart_count == null ? 0 : opts.cart_count;
  var grandTotal  = pricing.format(opts.order.grand_total_minor, opts.order.currency);
  // The publishable key + per-order client_secret ride HTML-attribute-
  // escaped `data-*` attributes on the mount div, read by the external
  // `pay.js` island — no inline `<script>`, no JS-literal interpolation. The
  // route-scoped CSP set on GET /pay/:order_id admits js.stripe.com.
  if (opts.theme) {
    return opts.theme.render("pay", {
      title:               "Pay",
      shop_name:           shopName,
      cart_count:          cartCount,
      order_id:            opts.order.id,
      grand_total:         grandTotal,
      pk:                  opts.publishable_key,
      client_secret:       opts.client_secret,
      pay_script:          opts.theme.assetUrl("js/pay.js"),
      asset_css_main:      opts.theme.assetUrl("css/main.css"),
    });
  }
  // {{pk}} / {{client_secret}} / {{order_id}} go through _render's
  // escape-by-default path (HTML-attribute-escaped), NOT the old RAW_*
  // JS-literal splice — they're attribute values now, not script literals.
  var body = _render(PAY_PAGE, {
    order_id:           opts.order.id,
    grand_total:        grandTotal,
    pk:                 opts.publishable_key,
    client_secret:      opts.client_secret,
  }).replace("RAW_PAY_SCRIPT", _islandScript("pay.js"));
  // Operator trust badges at the checkout placement (container-only — the pay
  // page isn't edge-cached). Pre-resolved + sanitized by the route; appended
  // after the pay card. Empty string when no badges / no dep.
  var payTrustBadges = typeof opts.trust_badges_html === "string" ? opts.trust_badges_html : "";
  return _wrap({
    title:      "Pay",
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body + payTrustBadges,
  });
}

var ORDER_PAGE =
  "<section class=\"order-page\">\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Order confirmed</p>\n" +
  "    <h1 class=\"section-head__title\">Order <code class=\"inline-code\">{{order_id}}</code></h1>\n" +
  "    <p class=\"section-head__lede\">Status: <span class=\"pdp__badge pdp__badge--ok\"><span class=\"dot dot--live\" aria-hidden=\"true\"></span> {{status}}</span></p>\n" +
  "  </header>\n" +
  "  RAW_REORDER_NOTICE" +
  "  <div class=\"order-page__grid\">\n" +
  "    <div class=\"order-page__items\">\n" +
  "      <h2 class=\"pdp__variants-title\">Items</h2>\n" +
  "      <div class=\"table-scroll\">\n" +
  "        <table class=\"cart-table\">\n" +
  "          <thead><tr><th>Product</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>\n" +
  "          <tbody>{{line_rows}}</tbody>\n" +
  "        </table>\n" +
  "      </div>\n" +
  "      RAW_ORDER_PICKUP" +
  "      RAW_ORDER_GIFT" +
  "      RAW_ORDER_ACTIONS" +
  "      RAW_ORDER_RATING" +
  "    </div>\n" +
  "    <aside class=\"order-page__totals\">\n" +
  "      RAW_ORDER_TIMELINE" +
  "      RAW_ORDER_TRACKING" +
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

// The customer-facing order lifecycle, in display order. Mirrors the
// happy-path edges of the order FSM (pending → paid → fulfilling →
// shipped → delivered); the terminal off-ramps (refunded / cancelled)
// are surfaced as a distinct final step rather than a position on the
// rail. Kept as a small ordered list so the timeline highlights every
// step up to and including the current status.
var ORDER_TIMELINE_STEPS = [
  { status: "pending",    label: "Order placed" },
  { status: "paid",       label: "Payment confirmed" },
  { status: "fulfilling", label: "Preparing your order" },
  { status: "shipped",    label: "Shipped" },
  { status: "delivered",  label: "Delivered" },
];

// A paid (or further-along) order is the customer's window to start a
// return; pending (unpaid) and the terminal off-ramps (cancelled /
// refunded) are not. Mirrors the operator-facing returns policy: you
// can't return what you haven't paid for or what's already refunded.
function _orderEligibleForReturn(status) {
  return status === "paid" || status === "fulfilling" ||
    status === "shipped" || status === "delivered";
}

// An exchange (swap the item for a different size / colour / unit at the
// same value) is offered on the same window as a return: a paid (or
// further-along) order, never a still-pending (unpaid) one nor the
// terminal off-ramps (cancelled / refunded). The customer ships the
// original back AND receives a replacement — no refund — so the window
// matches the goods being in the customer's hands.
function _orderEligibleForExchange(status) {
  return status === "paid" || status === "fulfilling" ||
    status === "shipped" || status === "delivered";
}

// Reorder is offered for any order that represents a real purchase the
// customer might want to repeat — paid through delivered, plus the
// terminal refunded/cancelled states (a cancelled or refunded order is a
// perfectly good "buy this again" candidate). Only a still-pending
// (never-paid) order is excluded, since its cart was never charged.
function _orderEligibleForReorder(status) {
  return status !== "pending";
}

// Cancel is offered only while the order is still pre-fulfillment: the
// order FSM (lib/order.js) accepts the `cancel` event from `pending`
// (awaiting capture) and `paid` (captured, not yet picked) only. Once
// the warehouse starts fulfilling — and through shipped / delivered —
// the order is no longer the customer's to cancel; the terminal off-ramps
// (cancelled / refunded) have no cancel edge either. Keeping this in lock-
// step with the FSM's cancel edges means the button never offers a
// transition the primitive would refuse. A cancel on a `paid` order does
// NOT void the captured charge — the FSM only moves the status — so a paid
// cancel leaves the operator to issue the refund from the console.
function _orderEligibleForCancel(status) {
  return status === "pending" || status === "paid";
}

// Render the lifecycle timeline. Every step up to and including the
// current status is marked done; the current step is also marked
// current. A terminal off-ramp (refunded / cancelled) collapses the rail
// to a single explanatory step so we never imply a cancelled order is
// "delivered". All labels are static framework copy (no operator input),
// but escaped at the sink for consistency with the rest of the file.
function _orderTimelineBlock(status) {
  var esc = b.template.escapeHtml;
  if (status === "cancelled" || status === "refunded") {
    var finalLabel = status === "cancelled" ? "Order cancelled" : "Order refunded";
    return "<div class=\"order-timeline order-timeline--terminal\">" +
      "<h2 class=\"pdp__variants-title\">Status</h2>" +
      "<ol class=\"order-timeline__steps\">" +
        "<li class=\"order-timeline__step is-current is-terminal\">" +
          "<span class=\"order-timeline__dot\" aria-hidden=\"true\"></span>" +
          "<span class=\"order-timeline__label\">" + esc(finalLabel) + "</span>" +
        "</li>" +
      "</ol></div>";
  }
  var currentIdx = -1;
  for (var i = 0; i < ORDER_TIMELINE_STEPS.length; i += 1) {
    if (ORDER_TIMELINE_STEPS[i].status === status) { currentIdx = i; break; }
  }
  var steps = ORDER_TIMELINE_STEPS.map(function (step, idx) {
    var done    = currentIdx >= 0 && idx <= currentIdx;
    var current = idx === currentIdx;
    var cls = "order-timeline__step" +
      (done ? " is-done" : "") + (current ? " is-current" : "");
    return "<li class=\"" + cls + "\">" +
      "<span class=\"order-timeline__dot\" aria-hidden=\"true\"></span>" +
      "<span class=\"order-timeline__label\">" + esc(step.label) + "</span>" +
      "</li>";
  }).join("");
  return "<div class=\"order-timeline\">" +
    "<h2 class=\"pdp__variants-title\">Status</h2>" +
    "<ol class=\"order-timeline__steps\">" + steps + "</ol></div>";
}

// Render the shipment + carrier-tracking panel from order-tracking's
// listForOrder() rows. Each shipment shows its carrier, status, the
// tracking number (linked to the carrier's public tracking URL when one
// is known), and the most-recent carrier event. Empty/absent shipments
// render nothing so a digital or not-yet-shipped order shows no panel.
function _orderTrackingBlock(shipments) {
  if (!Array.isArray(shipments) || !shipments.length) return "";
  var esc = b.template.escapeHtml;
  var cards = shipments.map(function (s) {
    var carrier = s.carrier === "other"
      ? (s.carrier_other_name || "Carrier")
      : s.carrier;
    var trackingHtml = "";
    if (s.tracking_number) {
      trackingHtml = s.tracking_url
        ? "<a class=\"order-shipment__track\" href=\"" + esc(String(s.tracking_url)) +
            "\" rel=\"noopener nofollow\" target=\"_blank\">" + esc(String(s.tracking_number)) + " ↗</a>"
        : "<span class=\"order-shipment__track\">" + esc(String(s.tracking_number)) + "</span>";
    }
    // Latest carrier event (events arrive oldest-first from listForOrder's
    // getShipment ordering; the panel's per-shipment events array, when
    // hydrated, is the same order — take the last).
    var events = Array.isArray(s.events) ? s.events : [];
    var latest = events.length ? events[events.length - 1] : null;
    var latestHtml = latest
      ? "<p class=\"order-shipment__event\">" +
          esc(String(latest.status)) +
          (latest.location ? " &middot; " + esc(String(latest.location)) : "") +
        "</p>"
      : "";
    return "<li class=\"order-shipment\">" +
      "<div class=\"order-shipment__head\">" +
        "<span class=\"order-shipment__carrier\">" + esc(String(carrier)) + "</span>" +
        "<span class=\"pdp__badge\">" + esc(String(s.status)) + "</span>" +
      "</div>" +
      (trackingHtml ? "<p class=\"order-shipment__tracking\">Tracking: " + trackingHtml + "</p>" : "") +
      latestHtml +
      "</li>";
  }).join("");
  return "<div class=\"order-tracking-panel\">" +
    "<h2 class=\"pdp__variants-title\">Tracking</h2>" +
    "<ul class=\"order-shipment-list\">" + cards + "</ul></div>";
}

// Request-a-return + Reorder affordances for an order, gated on its
// status. Reorder is a POST (it mutates the cart) carrying the order id
// in the path; Request-a-return links to the existing return form. The
// same builder feeds the order page and (via _orderRowActions) the
// dashboard rows so the eligibility rules live in one place.
function _orderActionsBlock(o) {
  var esc = b.template.escapeHtml;
  var btns = [];
  if (_orderEligibleForReorder(o.status)) {
    btns.push(
      "<form class=\"order-action\" method=\"post\" action=\"/orders/" + esc(String(o.id)) + "/reorder\">" +
        "<button type=\"submit\" class=\"btn-secondary\">Reorder</button>" +
      "</form>");
  }
  if (_orderEligibleForReturn(o.status)) {
    btns.push(
      "<a class=\"btn-secondary order-action\" href=\"/account/orders/" + esc(String(o.id)) + "/return\">Request a return</a>");
  }
  if (_orderEligibleForExchange(o.status)) {
    btns.push(
      "<a class=\"btn-secondary order-action\" href=\"/account/orders/" + esc(String(o.id)) + "/exchange\">Request an exchange</a>");
  }
  if (_orderEligibleForCancel(o.status)) {
    btns.push(
      "<form class=\"order-action\" method=\"post\" action=\"/orders/" + esc(String(o.id)) + "/cancel\">" +
        "<button type=\"submit\" class=\"btn-ghost\">Cancel order</button>" +
      "</form>");
  }
  if (!btns.length) return "";
  return "<div class=\"order-page__actions\">" + btns.join("") + "</div>";
}

// A post-purchase rating is offered on the same window a return is: a paid
// (or further-along) order, never a still-pending (unpaid) one nor the
// terminal off-ramps (cancelled / refunded). The order FSM has no
// `fulfilled` status — the post-payment states are paid / fulfilling /
// shipped / delivered — so the rating window mirrors _orderEligibleForReturn
// rather than gating on a status the primitive doesn't expose.
function _orderEligibleForRating(status) {
  return status === "paid" || status === "fulfilling" ||
    status === "shipped" || status === "delivered";
}

// The three rating axes the customer scores, in display order. Labels are
// static framework copy; the axis key matches the submitRating field name.
var ORDER_RATING_AXES = [
  { key: "shipping",  label: "Shipping",         field: "shipping_rating" },
  { key: "packaging", label: "Packaging",        field: "packaging_rating" },
  { key: "recommend", label: "Recommend us",     field: "recommend_rating" },
];

// 1–5 selector for one rating axis. Rendered as native radio buttons so the
// form works with no JavaScript and a screen reader announces each option.
// `field` is the submitRating field name; nothing here is operator/customer
// input, but the labels are escaped at the sink for consistency.
function _ratingAxisField(axis) {
  var esc = b.template.escapeHtml;
  var opts = "";
  for (var v = 1; v <= 5; v += 1) {
    opts +=
      "<label class=\"order-rating__option\">" +
        "<input type=\"radio\" name=\"" + esc(axis.field) + "\" value=\"" + v + "\" required>" +
        "<span>" + v + "</span>" +
      "</label>";
  }
  return "<fieldset class=\"order-rating__axis\">" +
    "<legend>" + esc(axis.label) + "</legend>" +
    "<div class=\"order-rating__scale\">" + opts + "</div>" +
    "</fieldset>";
}

// The rating form (eligible, not-yet-rated order). Posts to
// /orders/:id/rate; the container CSRF injection tokens it automatically
// (the action is not an EDGE_POST_PATHS prefix). A correction notice from a
// rejected submit (bad value / over-length comment / duplicate) renders
// above the form.
function _orderRatingForm(o, notice) {
  var esc = b.template.escapeHtml;
  var noticeHtml = notice
    ? "<p class=\"form-notice form-notice--err\" role=\"alert\">" + esc(String(notice)) + "</p>"
    : "";
  var axes = ORDER_RATING_AXES.map(_ratingAxisField).join("");
  return "<section class=\"order-rating order-rating--form\">" +
    "<h2 class=\"pdp__variants-title\">Rate this order</h2>" +
    "<p class=\"order-rating__lede\">How did the delivery go? Your feedback helps us improve.</p>" +
    noticeHtml +
    "<form class=\"form-stack\" method=\"post\" action=\"/orders/" + esc(String(o.id)) + "/rate\">" +
      axes +
      "<label class=\"form-field\"><span>Comment <small>(optional)</small></span>" +
        "<textarea name=\"comment\" rows=\"3\" maxlength=\"2000\" " +
          "placeholder=\"Tell us about your delivery experience\"></textarea></label>" +
      "<div class=\"order-page__actions\">" +
        "<button type=\"submit\" class=\"btn-primary\">Submit rating</button>" +
      "</div>" +
    "</form>" +
    "</section>";
}

// The submitted rating (the three scores) plus, when present, the
// customer's own comment and the operator's public reply. ESCAPE-BY-DEFAULT:
// the comment and the reply are spliced from the primitive's pre-escaped
// `comment_html` / `response_html` fields (escaped via b.template.escapeHtml
// at the primitive's render layer), NEVER the raw `comment` / `response_text`
// — so a `<script>`/`onerror` payload a customer typed is inert here. A
// flagged comment is suppressed (operators moderate via the admin queue).
function _orderRatingDisplay(rating) {
  var esc = b.template.escapeHtml;
  var scoreRows = ORDER_RATING_AXES.map(function (axis) {
    return "<div><dt>" + esc(axis.label) + "</dt>" +
      "<dd>" + esc(String(rating[axis.field])) + " / 5</dd></div>";
  }).join("");
  // comment_html is already escaped by the primitive — splice it, do not
  // re-escape (double-escaping would render visible entities) and never
  // reach for rating.comment (the raw, un-escaped string).
  var commentHtml = (rating.comment_html && !rating.comment_flagged)
    ? "<div class=\"order-rating__comment\"><h3>Your comment</h3>" +
        "<p>" + rating.comment_html + "</p></div>"
    : "";
  // response_html is the operator's public reply, also pre-escaped — splice
  // it, never rating.response_text.
  var responseHtml = rating.response_html
    ? "<div class=\"order-rating__response\"><h3>Our reply</h3>" +
        "<p>" + rating.response_html + "</p></div>"
    : "";
  return "<section class=\"order-rating order-rating--done\">" +
    "<h2 class=\"pdp__variants-title\">Your rating</h2>" +
    "<dl class=\"order-rating__scores\">" + scoreRows + "</dl>" +
    commentHtml +
    responseHtml +
    "</section>";
}

// Resolve the rating panel for the order page: the submitted rating (read-
// only display) when one exists, the submission form when the order is
// eligible and unrated, and nothing otherwise (a pending / cancelled /
// refunded order, or a renderer reached without the ratings primitive
// wired). `opts.rating` is the getRating row (or null); `opts.rating_notice`
// is a correction message echoed back onto a rejected submit.
function _orderRatingBlock(opts) {
  var o = opts.order;
  if (opts.rating) return _orderRatingDisplay(opts.rating);
  if (opts.rating_eligible && _orderEligibleForRating(o.status)) {
    return _orderRatingForm(o, opts.rating_notice || null);
  }
  return "";
}

// Map a ?rate_err= code (set by a rejected rating POST on its PRG redirect)
// to a clean, operator-safe correction message rendered above the rating
// form. Defensive request reader — an unknown / absent code yields no
// notice, never a raw error or a leak. The duplicate / value / length codes
// mirror the primitive's refusal classes without echoing its raw message.
function _ratingNoticeFor(code) {
  if (code === "dupe")    return "You've already rated this order.";
  if (code === "value")   return "Please give each rating a score from 1 to 5.";
  if (code === "comment") return "Your comment couldn't be saved — please shorten it and try again.";
  if (code === "input")   return "Please check your rating and try again.";
  return null;
}

// Human label for a pickup FSM status, for the customer order page.
function _pickupStatusLabel(status) {
  if (status === "scheduled") return "Scheduled for pickup";
  if (status === "ready")     return "Ready for pickup";
  if (status === "picked_up") return "Picked up";
  if (status === "no_show")   return "Missed pickup";
  if (status === "cancelled") return "Pickup cancelled";
  return status;
}

// Customer-facing pickup (BOPIS) status panel on /orders/:id. The window
// times come straight from the schedule row (operator-set epoch ms); the
// location_code is operator-defined free text — escaped at the sink.
// Returns "" when there's no schedule (the common no-pickup order).
function _orderPickupBlock(pickup) {
  if (!pickup) return "";
  var esc = b.template.escapeHtml;
  var when = "";
  if (pickup.scheduled_window_start) {
    var start = new Date(Number(pickup.scheduled_window_start));
    var end = pickup.scheduled_window_end ? new Date(Number(pickup.scheduled_window_end)) : null;
    when = "<p class=\"order-pickup__window\">Window: " + esc(start.toISOString().slice(0, 16).replace("T", " ")) +
      (end ? " – " + esc(end.toISOString().slice(11, 16)) : "") + " UTC</p>";
  }
  return "<section class=\"order-pickup\">" +
    "<h2 class=\"pdp__variants-title\">Pickup</h2>" +
    "<p class=\"order-pickup__status\"><span class=\"pdp__badge\">" + esc(_pickupStatusLabel(pickup.status)) + "</span></p>" +
    "<p class=\"order-pickup__loc\">Location: <code class=\"inline-code\">" + esc(String(pickup.location_code)) + "</code></p>" +
    when +
    "</section>";
}

// Customer-facing gift-options display on /orders/:id. The wrap_sku /
// gift_message / recipient_name are customer (and operator) free text —
// escaped at the sink. hide_prices is shown as a plain note. Returns ""
// when no gift options are set.
function _orderGiftBlock(gift) {
  if (!gift || (!gift.wrap_sku && !gift.gift_message && !gift.recipient_name && !gift.hide_prices)) return "";
  var esc = b.template.escapeHtml;
  var parts = [];
  if (gift.recipient_name) parts.push("<p class=\"order-gift__recipient\">To: " + esc(String(gift.recipient_name)) + "</p>");
  if (gift.wrap_sku)       parts.push("<p class=\"order-gift__wrap\">Gift wrap: <code class=\"inline-code\">" + esc(String(gift.wrap_sku)) + "</code></p>");
  if (gift.gift_message) {
    // The message may be multi-line — split on LF and escape each line.
    var lines = String(gift.gift_message).replace(/\r\n/g, "\n").split("\n")
      .map(function (ln) { return esc(ln); }).join("<br>");
    parts.push("<blockquote class=\"order-gift__message\">" + lines + "</blockquote>");
  }
  if (gift.hide_prices)    parts.push("<p class=\"order-gift__hide\">Prices hidden on the packing slip (gift receipt).</p>");
  return "<section class=\"order-gift\">" +
    "<h2 class=\"pdp__variants-title\">Gift options</h2>" + parts.join("") +
    "</section>";
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
  // Post-handoff shipment + carrier tracking (order-tracking.listForOrder
  // rows the route bundles in; absent / empty → no panel). The lifecycle
  // timeline + the Request-a-return / Reorder affordances are derived from
  // the order status alone, so they render even without tracking wired.
  var shipments    = opts.shipments || [];
  var timelineHtml = _orderTimelineBlock(o.status);
  var trackingHtml = _orderTrackingBlock(shipments);
  var actionsHtml  = _orderActionsBlock(o);
  // Post-purchase rating panel — container-only (session-gated). The route
  // passes the resolved getRating row (rating) + the eligibility/notice
  // flags; the edge render never does, so the panel is empty at the edge.
  var ratingHtml   = _orderRatingBlock(opts);
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
      timeline_html:       timelineHtml,
      tracking_html:       trackingHtml,
      pickup_html:         _orderPickupBlock(opts.pickup),
      gift_html:           _orderGiftBlock(opts.gift_options),
      actions_html:        actionsHtml,
      rating_html:         ratingHtml,
      can_return:          _orderEligibleForReturn(o.status),
      can_reorder:         _orderEligibleForReorder(o.status),
      can_cancel:          _orderEligibleForCancel(o.status),
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
  // Confirmation banner after a successful reorder (the POST redirects to
  // ?reordered=1). Static copy, no untrusted input — but the cart link
  // gives the customer a one-click path to the rebuilt cart.
  var reorderNotice = opts.reordered
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">Items from this order were added to your cart. <a href=\"/cart\">View cart →</a></p>"
    : "";
  // Confirmation banner after a successful cancel (the POST redirects to
  // ?cancelled=1). A paid order's captured charge is not auto-voided by the
  // cancel — the refund is the operator's call from the console — so the
  // copy stays neutral ("cancelled") rather than promising a refund the
  // status transition didn't perform.
  var cancelNotice = opts.cancelled
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">This order has been cancelled.</p>"
    : "";
  var body = _render(ORDER_PAGE, {
    order_id:  o.id,
    status:    o.status,
    line_rows: "RAW_LINES",
    subtotal:  subtotal,
    tax:       tax,
    shipping:  shipping,
    total:     total,
  }).replace("RAW_LINES", rows)
    .replace("RAW_REORDER_NOTICE", reorderNotice + cancelNotice)
    .replace("RAW_ORDER_TIMELINE", timelineHtml)
    .replace("RAW_ORDER_TRACKING", trackingHtml)
    .replace("RAW_ORDER_PICKUP", _orderPickupBlock(opts.pickup))
    .replace("RAW_ORDER_ACTIONS", actionsHtml)
    .replace("RAW_SHIP_TO", _shipToAddressBlock(o.ship_to));
  // The gift block carries customer free text (escaped, but a `$` in it would
  // still trip String.replace's dollar substitution) — splice it via the
  // replacer-function helper, never a replacement-string .replace.
  body = _spliceRaw(body, "RAW_ORDER_GIFT", _orderGiftBlock(opts.gift_options));
  // The rating panel carries customer/operator free text (already escaped
  // into comment_html / response_html, but a `$` in that text would still
  // trip String.replace's dollar substitution) — splice it via the
  // replacer-function helper, never a replacement-string .replace.
  body = _spliceRaw(body, "RAW_ORDER_RATING", ratingHtml);
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
  // Operator-authored trust badges at the order_confirmation placement
  // (container-only — this page isn't edge-cached). Pre-resolved + escaped by
  // the route (via _trustBadgesHtml); spliced raw so a `$` in a sanitized SVG
  // can't trip String.replace dollar substitution. Empty string when no badges
  // / no dep.
  var trustBadgesHtml = typeof opts.trust_badges_html === "string" ? opts.trust_badges_html : "";
  return _wrap({
    title:      "Order " + o.id,
    shop_name:  shopName,
    cart_count: cartCount,
    theme_css: opts.theme_css,
    body:       body + railHtml + trustBadgesHtml,
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
  "RAW_TOTALS_ROWS" +
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

// Build the order-summary `<dl>` rows shared by the cart + checkout
// totals lists. Renders Subtotal, an optional discount, tax, shipping,
// and the grand Total — composing the real tax/shipping/discount figures
// the pricing primitive computed for the destination. Each of tax +
// shipping is shown in one of two honest states:
//
//   - a real amount, under an "Estimated tax" / "Estimated shipping" /
//     "Estimated total" label while the destination isn't yet confirmed
//     by the shopper (so the figure is never read as the final charge);
//   - "Calculated at checkout" when no rule/zone matched the destination
//     (a labelled deferral, never a fabricated 0).
//
// `fmt` is the per-request price formatter (display-currency aware). When
// `t.estimated` is false (the checkout POST re-render of an entered
// address) the labels drop the "Estimated" prefix and the figures read
// as exact. `subtotalStr`/`totalStr` are pre-formatted so the caller
// controls display-currency conversion.
function _buildCartTotalsRows(t, fmt, subtotalStr, totalStr) {
  var totals    = t.totals;
  var estimated = !!t.estimated;
  var rows = "        <div><dt>Subtotal</dt><dd>" + subtotalStr + "</dd></div>\n";
  if (totals.discount_minor > 0) {
    rows += "        <div class=\"totals-list__discount\"><dt>Discount</dt><dd>−" +
      fmt(totals.discount_minor, totals.currency) + "</dd></div>\n";
  }
  // Tax row.
  var taxLabel = estimated ? "Estimated tax" : "Tax";
  if (t.tax_resolved) {
    rows += "        <div><dt>" + taxLabel + "</dt><dd>" + fmt(totals.tax_minor, totals.currency) + "</dd></div>\n";
  } else if (totals.tax_minor > 0) {
    // A non-zero tax with no jurisdiction match still reflects a real
    // computed figure — show it under the estimate label.
    rows += "        <div><dt>" + taxLabel + "</dt><dd>" + fmt(totals.tax_minor, totals.currency) + "</dd></div>\n";
  } else {
    rows += "        <div class=\"totals-list__pending\"><dt>Tax</dt><dd>Calculated at checkout</dd></div>\n";
  }
  // Shipping row.
  var shipLabel = estimated ? "Estimated shipping" : "Shipping";
  if (t.shipping_resolved) {
    var shipValue = totals.shipping_minor === 0 ? "Free" : fmt(totals.shipping_minor, totals.currency);
    rows += "        <div><dt>" + shipLabel + "</dt><dd>" + shipValue + "</dd></div>\n";
  } else {
    rows += "        <div class=\"totals-list__pending\"><dt>Shipping</dt><dd>Calculated at checkout</dd></div>\n";
  }
  // Grand total. On an estimate, label it so the figure is never read as
  // the committed charge before the address step.
  var totalLabel = estimated ? "Estimated total" : "Total";
  rows += "        <div class=\"totals-list__grand\"><dt>" + totalLabel + "</dt><dd>" + totalStr + "</dd></div>\n";
  return rows;
}

// The cart-page gift disclosure (CONTAINER-ONLY — the edge cart renders
// only the cookie-less empty shell, never a cart with lines, so this block
// is never reached at the edge; see [[storefront-dual-render]]). It offers a
// wrap <select> (POST /cart/gift adds the wrap as a real cart LINE so the
// fee flows through the quote + is charged) plus a remove control when a
// wrap is already in the cart. The message / recipient / hide-prices fields
// are collected at the checkout step (they need the order id to persist), so
// the cart block is the wrap selector only. Wrap titles are operator free
// text — escaped at the sink. Returns "" when no active wraps are defined.
function _cartGiftBlock(opts) {
  var wraps = opts.gift_wraps || [];
  if (!wraps.length) return "";
  var esc = b.template.escapeHtml;
  var current = opts.gift_wrap_in_cart || "";
  var options = "<option value=\"\">No gift wrap</option>" +
    wraps.map(function (w) {
      var feeStr = pricing.format(w.fee_minor, (opts.totals && opts.totals.currency) || "USD");
      return "<option value=\"" + esc(String(w.wrap_sku)) + "\"" +
        (w.wrap_sku === current ? " selected" : "") + ">" +
        esc(String(w.title)) + " (" + esc(feeStr) + ")</option>";
    }).join("");
  return "<section class=\"cart-gift\">" +
    "<details class=\"cart-gift__details\"" + (current ? " open" : "") + ">" +
      "<summary class=\"cart-gift__summary\">Add a gift wrap</summary>" +
      "<form method=\"post\" action=\"/cart/gift\" class=\"cart-gift__form\">" +
        "<label class=\"form-field\"><span>Gift wrap</span>" +
          "<select name=\"wrap_sku\">" + options + "</select>" +
        "</label>" +
        "<p class=\"cart-gift__note\">Add a gift message and recipient at checkout. The wrap fee is charged as a line on your order.</p>" +
        "<button type=\"submit\" class=\"btn-secondary\">Update gift wrap</button>" +
      "</form>" +
    "</details>" +
    "</section>";
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
  // Per-line stock state map (variant_id → "out" | "low" | "ok"), bundled
  // by the route handler. Absent for back-compat callers / the edge empty
  // cart — those lines render with no badge (the never-block stance).
  var lineStock = opts.line_stock || {};
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
      stock:          lineStock[l.variant_id] || "ok",
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
      // Real per-line availability badge — never a hardcoded "in stock".
      // Out-of-stock + low-stock surface a status pill so the shopper sees
      // the truth before they commit; an "ok" line shows nothing (the
      // implied default). `role="status"` so a screen reader announces it.
      var stockBadge = "";
      if (l.stock === "out") {
        stockBadge = "        <span class=\"cart-line__stock cart-line__stock--out\" role=\"status\">Out of stock</span>\n";
      } else if (l.stock === "low") {
        stockBadge = "        <span class=\"cart-line__stock cart-line__stock--low\" role=\"status\">Low stock</span>\n";
      }
      return _render(CART_LINE_EDITABLE, {
        sku:            l.sku,
        qty:            l.qty,
        unit:           l.unit,
        total:          l.total,
        line_id:        l.id,
        product_title:  l.product_title,
        product_url:    l.product_url,
      }).replace("RAW_CART_LINE_THUMB", thumb).replace("RAW_CART_LINE_STOCK", stockBadge).replace("RAW_CART_LINE_SAVE", saveBtn);
    }).join("");
    // Checkout CTA — only a live button when checkout is actually wired
    // (Stripe configured). Absent that, render a clear, disabled "not set
    // up" notice instead of a link that 404s. Backward-compatible: callers
    // that don't pass the flag (older tests) keep the button.
    var checkoutAvailable = opts.checkout_available !== false;
    // Truthful CTA note. When the route bundled an estimated totals
    // breakdown, say the figures are an estimate that finalizes once the
    // shipping address is entered — never the stale "calculated on the next
    // step" (which implied the cart total was just the subtotal). Without a
    // breakdown (back-compat caller), keep the prior note.
    var ctaNote;
    if (opts.totals_detail && opts.totals_detail.estimated) {
      ctaNote = "      <p class=\"cart-page__note\">Estimated tax and shipping shown above; the exact total is confirmed once you enter your shipping address. Payment runs through Stripe.</p>\n";
    } else if (opts.totals_detail) {
      ctaNote = "      <p class=\"cart-page__note\">Total includes tax and shipping for your address. Payment runs through Stripe.</p>\n";
    } else {
      ctaNote = "      <p class=\"cart-page__note\">Tax and shipping are calculated on the next step. Payment runs through Stripe.</p>\n";
    }
    var checkoutCta = checkoutAvailable
      ? "      <a href=\"/checkout\" class=\"btn-primary cart-page__checkout\">Continue to checkout <span aria-hidden=\"true\">→</span></a>\n" +
        ctaNote
      : "      <button type=\"button\" class=\"btn-primary cart-page__checkout\" disabled aria-disabled=\"true\">Checkout unavailable</button>\n" +
        "      <p class=\"cart-page__note cart-page__note--warn\" role=\"status\">Online checkout isn't set up for this store yet — payments aren't configured. Your cart is saved; please check back soon.</p>\n";
    // Post-add confirmation banner — rendered only on the `?added=1`
    // redirect from POST /cart/lines so the shopper gets explicit feedback
    // their item landed (the audit found the silent 303 left no cue).
    var notice = opts.added ? CART_ADDED_NOTICE : "";
    // The order-summary rows. When the route bundled a totals breakdown
    // (`totals_detail` from _estimateCartTotals), render the full Subtotal
    // → tax → shipping → discount → Total list with the destination's real
    // computed figures (estimate-labelled until the address step). Absent
    // that — a back-compat caller passing only `opts.totals` — fall back to
    // the bare Subtotal + Total list (byte-identical to the prior shape).
    var totalsRows;
    if (opts.totals_detail) {
      totalsRows = _buildCartTotalsRows(opts.totals_detail, fmt, subtotal, total);
    } else {
      totalsRows =
        "        <div><dt>Subtotal</dt><dd>" + subtotal + "</dd></div>\n" +
        "        <div class=\"totals-list__grand\"><dt>Total</dt><dd>" + total + "</dd></div>\n";
    }
    body = _render(CART_PAGE, {
      line_rows: "RAW_LINES",
    }).replace("RAW_LINES", rows)
      .replace("RAW_TOTALS_ROWS", totalsRows)
      .replace("RAW_CHECKOUT_CTA", checkoutCta)
      .replace("RAW_CART_NOTICE", notice);
    // CONTAINER-ONLY gift wrap disclosure, appended after the cart grid (a
    // separate <section>, never spliced into the shared CART_PAGE markup the
    // edge twin mirrors). Only reached for a cart with lines, which the edge
    // never renders. Spliced via the body concat (the block carries operator
    // free text already escaped; appending — not String.replace — so a `$`
    // in a wrap title can't trip dollar substitution).
    body = body + _cartGiftBlock(opts);
  }
  return _wrap(Object.assign({
    title:      "Cart",
    shop_name:  shopName,
    cart_count: lines.length,
    theme_css: opts.theme_css,
    // The cart is session-scoped and robots.txt-disallowed — keep it out
    // of the index with a noindex meta (matches the edge x-robots-tag on
    // the guest cart render), so a directly-crawled cart URL is self-
    // describing rather than relying on robots.txt alone.
    robots:     "noindex",
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
        "<p class=\"newsletter-thanks__lede\">" + b.template.escapeHtml(String(opts.message || "Check the address and try again — only RFC-shape email addresses are accepted.")) + "</p>" +
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

// ---- newsletter unsubscribe (CAN-SPAM / RFC 8058) ----------------------
//
// A marketing email's unsubscribe link points at GET /unsubscribe?token=…
// (a friendly confirm page) and List-Unsubscribe-Post fires a one-click
// POST /unsubscribe with the same token. Both are unauthenticated — the
// opaque, single-use, timing-safe token is the bearer — and CSRF-exempt
// (the mail-client POST carries no session). The token is never echoed
// back to the page; only its structured outcome is rendered.

// The confirm page (GET). A no-JS form POSTs the token back to
// /unsubscribe to perform the unsubscribe, so a visitor who followed the
// link sees a deliberate "yes, unsubscribe me" step rather than being
// unsubscribed by a link-prefetcher. The token rides in a hidden field
// (HTML-escaped) and is the only handle — no email address is shown.
function renderUnsubscribeConfirm(opts) {
  opts = opts || {};
  var token = typeof opts.token === "string" ? opts.token : "";
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Newsletter</p>" +
        "<h1 class=\"newsletter-thanks__title\">Unsubscribe from the list?</h1>" +
        "<p class=\"newsletter-thanks__lede\">Confirm below and we'll stop emailing this address. You can re-subscribe any time from the footer of the site.</p>" +
        "<form class=\"newsletter-unsub__form\" method=\"post\" action=\"/unsubscribe\">" +
          "<input type=\"hidden\" name=\"token\" value=\"" + _escAttr(token) + "\">" +
          "<div class=\"newsletter-thanks__cta\">" +
            "<button type=\"submit\" class=\"btn-primary\">Unsubscribe</button>" +
            "<a href=\"/\" class=\"btn-ghost\">Keep me subscribed</a>" +
          "</div>" +
        "</form>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Unsubscribe",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    // The confirm + result pages are token-bearer surfaces with no
    // canonical/indexable identity — keep them out of search (`noindex`
    // maps to noindex,nofollow in _wrap).
    robots:     "noindex",
    body:       body,
  });
}

// The POST outcome page. `opts.outcome` is one of the structured results
// the unsubscribe flow produces: "unsubscribed" (success — offers a
// re-subscribe form), "not-found" (invalid / unknown token), "already"
// (the token was already consumed — the address is already off the list),
// "expired" (the token's TTL lapsed). Every branch renders a clean,
// server-rendered page; no raw error is ever surfaced.
function renderUnsubscribeResult(opts) {
  opts = opts || {};
  var outcome = opts.outcome;
  var heading, lede, extra = "";
  if (outcome === "unsubscribed") {
    heading = "You're unsubscribed.";
    lede    = "This address won't receive any more newsletter email. Changed your mind? Re-subscribe below.";
    // Re-subscribe affordance — the storefront newsletter signup form,
    // pre-pointed at the footer band's POST /newsletter so a single click
    // (after typing the address) puts the visitor back on the list.
    extra =
      "<form class=\"newsletter-resub__form\" method=\"post\" action=\"/newsletter\">" +
        "<label class=\"skip-link\" for=\"resub-email\">Email address</label>" +
        "<input id=\"resub-email\" type=\"email\" name=\"email\" required placeholder=\"you@example.com\" autocomplete=\"email\">" +
        "<button type=\"submit\" class=\"btn-primary\">Re-subscribe</button>" +
      "</form>";
  } else if (outcome === "already") {
    heading = "Already unsubscribed.";
    lede    = "This link was already used — the address is off the list, so there's nothing more to do.";
  } else if (outcome === "expired") {
    heading = "That link has expired.";
    lede    = "Unsubscribe links are valid for a limited time. You're still on the list; use the unsubscribe link in a more recent email, or contact us and we'll remove you.";
  } else {
    // "not-found" + any unexpected code → the same generic, non-leaking
    // copy. A bad / unknown / malformed token can't be distinguished from
    // outside, by design.
    heading = "This link isn't valid.";
    lede    = "We couldn't match this unsubscribe link to a subscription. It may have already been used, or the link may be incomplete.";
  }
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Newsletter</p>" +
        "<h1 class=\"newsletter-thanks__title\">" + heading + "</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + lede + "</p>" +
        extra +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Unsubscribe",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    // Token-bearer outcome page — keep it out of search (`noindex` maps to
    // noindex,nofollow in _wrap).
    robots:     "noindex",
    body:       body,
  });
}

// ---- back-in-stock "Notify me" pages -----------------------------------
//
// Container-only (no edge twin) — these aren't edge-cached. Every page is
// server-rendered, no auth, escape-by-default. The thank-you page renders
// the SAME copy for new / already-pending / already-confirmed so the page
// never reveals whether the address was already subscribed beyond friendly
// copy. The confirm/unsubscribe pages render a clean outcome on a null/
// invalid result rather than a leak or a 500.

function renderStockAlertThanks(opts) {
  opts = opts || {};
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Back-in-stock alert</p>" +
        "<h1 class=\"newsletter-thanks__title\">Check your email.</h1>" +
        "<p class=\"newsletter-thanks__lede\">If that address can receive mail, we've sent a confirmation link. Click it and we'll email you once — the moment this item is back in stock. Already confirmed? You're all set.</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Back-in-stock alert",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

function renderStockAlertError(opts) {
  opts = opts || {};
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Back-in-stock alert</p>" +
        "<h1 class=\"newsletter-thanks__title\">Couldn't set that alert.</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + b.template.escapeHtml(String(opts.message || "Check the email address and try again — only RFC-shape email addresses are accepted.")) + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Back-in-stock alert",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

// The confirm-link landing page. `opts.outcome` is one of: "confirmed"
// (we just stamped confirmed_at), "already-notified" (the alert already
// fired — terminal), "invalid" (null / expired / unknown token). No token
// is echoed back; the outcome page reveals nothing beyond friendly copy.
function renderStockAlertConfirm(opts) {
  opts = opts || {};
  var heading, lede;
  if (opts.outcome === "confirmed") {
    heading = "You're all set.";
    lede    = "Your back-in-stock alert is confirmed. We'll email you once — the moment this item returns. Nothing else.";
  } else if (opts.outcome === "already-notified") {
    heading = "You've already been notified.";
    lede    = "This item was already back in stock and we emailed you about it. There's nothing more to do.";
  } else {
    heading = "This link is no longer valid.";
    lede    = "We couldn't match this confirmation link to an alert. It may have expired, or the link may be incomplete. You can set a fresh alert from the product page.";
  }
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Back-in-stock alert</p>" +
        "<h1 class=\"newsletter-thanks__title\">" + heading + "</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + lede + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Back-in-stock alert",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

// The unsubscribe confirm page (GET). A no-JS form POSTs the opaque,
// single-purpose bearer token back to /stock-alert/unsubscribe — a
// deliberate "yes, stop these alerts" step (no link-prefetcher
// unsubscribe). The token rides in a hidden field (HTML-escaped) and is
// the only handle — no email address or SKU is shown or carried, so the
// page reveals nothing about the subscription. The token IS the
// authorization (the action is in EDGE_POST_PATHS — CSRF-exempt — exactly
// like the newsletter one-click unsubscribe), so no session is needed.
function renderStockAlertUnsubscribeConfirm(opts) {
  opts = opts || {};
  var token = typeof opts.token === "string" ? opts.token : "";
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Back-in-stock alert</p>" +
        "<h1 class=\"newsletter-thanks__title\">Stop this alert?</h1>" +
        "<p class=\"newsletter-thanks__lede\">Confirm below and we'll cancel your back-in-stock alert for this item. You can set it again any time from the product page.</p>" +
        "<form class=\"newsletter-unsub__form\" method=\"post\" action=\"/stock-alert/unsubscribe\">" +
          "<input type=\"hidden\" name=\"token\" value=\"" + _escAttr(token) + "\">" +
          "<div class=\"newsletter-thanks__cta\">" +
            "<button type=\"submit\" class=\"btn-primary\">Stop this alert</button>" +
            "<a href=\"/\" class=\"btn-ghost\">Keep me subscribed</a>" +
          "</div>" +
        "</form>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Unsubscribe",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

// The unsubscribe outcome page (POST). Idempotent — a missing row reads as
// "you're unsubscribed" (re-clicking the link twice is not an error). A bad
// shape reads as the generic non-leaking copy.
function renderStockAlertUnsubscribeResult(opts) {
  opts = opts || {};
  var heading, lede;
  if (opts.outcome === "invalid") {
    heading = "This link isn't valid.";
    lede    = "We couldn't match this unsubscribe link to an alert. It may already have been used, or the link may be incomplete.";
  } else {
    heading = "You're unsubscribed.";
    lede    = "We won't email you about this item coming back in stock. Changed your mind? Set a fresh alert from the product page.";
  }
  var body =
    "<section class=\"newsletter-thanks\">" +
      "<div class=\"newsletter-thanks__card\">" +
        "<p class=\"eyebrow\">Back-in-stock alert</p>" +
        "<h1 class=\"newsletter-thanks__title\">" + heading + "</h1>" +
        "<p class=\"newsletter-thanks__lede\">" + lede + "</p>" +
        "<div class=\"newsletter-thanks__cta\">" +
          "<a href=\"/\" class=\"btn-primary\">Back to the shop <span aria-hidden=\"true\">→</span></a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Unsubscribe",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
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

// Cookie-prefix-hardened names for the two Path=/ session cookies. The
// `__Host-` prefix is a browser-enforced integrity marker (RFC 6265bis
// §4.1.3.2): a `__Host-`-named cookie is only stored when it was set
// Secure, Path=/, and with NO Domain — pinning it to the exact host over
// HTTPS, immune to subdomain / related-domain cookie injection + session
// fixation. Both cookies are already Path=/ with no Domain, so `__Host-`
// is the correct (strongest) prefix.
//
// The prefix moves in lockstep with the Secure attribute: a `__Host-`
// cookie is INVALID (silently dropped by the browser) without Secure, and
// Secure cookies are silently dropped over plain http. Local dev + the
// e2e harness run over http, so the cookie there must carry the BARE name
// (Secure off) or it would never store and every session would break. The
// public protocol — https in production where the Cloudflare Worker
// terminates TLS and forwards `x-forwarded-proto: https` to the container
// — drives the choice via `_secureForReq` below. Read sites resolve the
// prefixed name first and fall back to the bare name, so a request in
// either environment (or mid-rollout) still resolves its session.
var SESSION_COOKIE_NAME_SECURE = "__Host-" + SESSION_COOKIE_NAME;
var AUTH_COOKIE_NAME_SECURE    = "__Host-" + AUTH_COOKIE_NAME;

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

// Whether THIS request's PUBLIC connection is https — the single source
// of truth for both the Secure attribute and the cookie-prefix choice.
// The container socket behind the Cloudflare Worker may be plain http even
// when the visitor's connection is https, so the decision rides on the
// forwarded protocol the Worker sets (`x-forwarded-proto`); `trustProxy`
// opts that header in (the framework refuses the attacker-forgeable header
// otherwise). Direct dev / e2e connections have no forwarded header and a
// non-encrypted socket, so this returns false there and the bare-named,
// non-Secure cookie is emitted (a real browser drops a Secure cookie over
// http, so the bare name is what keeps dev/e2e sessions working).
function _secureForReq(req) {
  return b.requestHelpers.requestProtocol(req, { trustProxy: true }) === "https";
}

// Resolve the on-wire name for one of the prefix-hardened cookies. Secure
// requests (https) carry the `__Host-`-prefixed name; non-Secure requests
// (http dev/e2e) carry the bare name so the browser actually stores it.
function _sidCookieName(secure)  { return secure ? SESSION_COOKIE_NAME_SECURE : SESSION_COOKIE_NAME; }
function _authCookieName(secure) { return secure ? AUTH_COOKIE_NAME_SECURE    : AUTH_COOKIE_NAME; }

// Read a prefix-hardened cookie value resolving the prefixed name first
// and the bare name second, so a request resolves its session regardless
// of which environment wrote the cookie (or a mid-rollout request that
// still carries the old bare-named cookie). Returns the raw string or null.
function _readPrefixedCookie(req, secureName, bareName) {
  var v = _cookieJar().read(req, secureName);
  if (v !== null && v !== undefined) return v;
  return _cookieJar().read(req, bareName);
}
function _readPrefixedSealed(req, secureName, bareName) {
  var v = _cookieJar().readSealed(req, secureName);
  if (v !== null) return v;
  return _cookieJar().readSealed(req, bareName);
}

function _readSidCookie(req) {
  // A cookie carrying anything but a well-shaped session id (a stale
  // value from an old deploy, a tampered cookie, garbage) reads as "no
  // session" rather than reaching cart.bySession — which throws on a
  // malformed id and would turn every page that renders the cart count
  // into a 500. The cookie grants zero authority, so dropping a
  // malformed one silently is safe.
  var v = _readPrefixedCookie(req, SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME);
  return v && SID_SHAPE_RE.test(v) ? v : null;
}

function _setSidCookie(req, res, sid) {
  var T = b.constants.TIME;
  var secure = _secureForReq(req);
  // The jar defaults Path=/ and no Domain — exactly the `__Host-`
  // invariant. The explicit `secure` here moves the Secure attribute and
  // the prefixed name together: an https request gets `__Host-shop_sid`
  // with Secure; an http dev/e2e request gets `shop_sid` without Secure.
  _cookieJar().write(res, _sidCookieName(secure), sid, {
    expires: new Date(Date.now() + T.days(30)),
    secure:  secure,
  });
}

// Auth + WebAuthn-challenge cookies carry a vault-sealed JSON envelope.
// writeSealed/readSealed handle the seal + the on-wire prefix; the
// caller works in plain objects.
function _setAuthCookie(req, res, env) {
  var T = b.constants.TIME;
  var secure = _secureForReq(req);
  _cookieJar().writeSealed(res, _authCookieName(secure), JSON.stringify(env), {
    expires: new Date(Date.now() + T.days(14)),
    secure:  secure,
  });
}
function _clearAuthCookie(req, res) {
  // Expire-now must match the live request's protocol so the attributes
  // satisfy the prefix invariant: over https clear the `__Host-` name with
  // Secure+Path=/; over http clear the bare name. A request never carries
  // both names at once (the write side emits exactly one per protocol), so
  // clearing the protocol-matched name signs the visitor out.
  var secure = _secureForReq(req);
  _cookieJar().clear(res, _authCookieName(secure), { secure: secure });
}
function _readAuthEnv(req) {
  var raw = _readPrefixedSealed(req, AUTH_COOKIE_NAME_SECURE, AUTH_COOKIE_NAME);
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
  "      RAW_LOGIN_CAPTCHA\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Sign in with passkey</button></div>\n" +
  "      <p id=\"login-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    RAW_LOGIN_OAUTH\n" +
  "    RAW_LOGIN_MAGIC\n" +
  "    <p class=\"auth-card__alt\">New here? <a href=\"/account/register\">Create an account →</a></p>\n" +
  "  </div>\n" +
  "  RAW_LOGIN_SCRIPT\n" +
  "</section>\n";

var LOGIN_ERROR_MESSAGES = {
  oauth:           "We couldn't complete that sign-in. Please try again.",
  "email-conflict": "That email already has an account — sign in with your passkey instead.",
  link:            "That sign-in link is invalid or has expired. Request a fresh one.",
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
  var magicHtml = opts.magic_link_enabled
    ? "<p class=\"auth-card__alt\"><a href=\"/account/login/link\">Email me a sign-in link instead →</a></p>"
    : "";
  var body = ACCOUNT_LOGIN_PAGE
    .replace("RAW_LOGIN_OAUTH", oauthHtml)
    .replace("RAW_LOGIN_MAGIC", magicHtml)
    .replace("RAW_LOGIN_ERROR", errHtml)
    // Login captcha is gated separately (CAPTCHA_GATE_LOGIN): the widget
    // renders only when the operator has a provider active AND opted login
    // in (opts.captcha_kind set). For the JSON ceremony the token is read by
    // passkey-login.js via window.__captchaToken() — no hidden field.
    .replace("RAW_LOGIN_CAPTCHA", _captchaWidgetBlock(opts.captcha_kind, opts.captcha_public_key, false))
    .replace("RAW_LOGIN_SCRIPT", _islandScript("passkey-login.js"));
  return _wrap({
    title:      "Sign in",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       body,
  });
}

// Magic-link sign-in — a passwordless entry for shoppers without a
// passkey or a social login. The page is a single email field that POSTs
// to /account/login/link. The response is always the same enumeration-
// safe confirmation ("if an account exists, we've emailed a link")
// regardless of whether the address resolves — no account-existence
// oracle. Server-rendered, no client JS.
var ACCOUNT_MAGIC_LINK_PAGE =
  "<section class=\"auth-page\">\n" +
  "  <div class=\"auth-card\">\n" +
  "    <p class=\"eyebrow\">Sign in by email</p>\n" +
  "    <h1 class=\"auth-card__title\">Email me a sign-in link</h1>\n" +
  "    <p class=\"auth-card__lede\">No passkey or social login? Enter your email and we'll send a single-use link that signs you in.</p>\n" +
  "    RAW_MAGIC_LINK_NOTICE\n" +
  "    <form method=\"post\" action=\"/account/login/link\" class=\"form-stack auth-form\">\n" +
  "      <div class=\"form-row\"><label class=\"form-field\"><span class=\"form-field__label\">Email</span><input type=\"email\" name=\"email\" required autocomplete=\"email\" autofocus></label></div>\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Email me a link</button></div>\n" +
  "    </form>\n" +
  "    <p class=\"auth-card__alt\"><a href=\"/account/login\">← Back to sign in</a></p>\n" +
  "  </div>\n" +
  "</section>\n";

function renderMagicLinkPage(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  // The post-submit confirmation (sent=1) is the enumeration-safe message
  // — identical whether or not the address matched an account. The
  // unconfigured-mailer case carries its own honest notice.
  var noticeHtml = "";
  if (opts.sent) {
    noticeHtml = "<p class=\"form-notice form-notice--ok\" role=\"status\">If an account exists for that email, we've sent a sign-in link. Check your inbox.</p>";
  } else if (opts.unavailable) {
    noticeHtml = "<p class=\"auth-form__message auth-form__message--err\">Email sign-in isn't available on this store. Use a passkey or social login instead.</p>";
  }
  var body = ACCOUNT_MAGIC_LINK_PAGE.replace("RAW_MAGIC_LINK_NOTICE", noticeHtml);
  void esc;
  return _wrap({
    title:      "Email sign-in",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css:  opts.theme_css,
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
  "      RAW_REGISTER_CAPTCHA\n" +
  "      <div class=\"form-actions\"><button type=\"submit\" class=\"btn-primary auth-form__submit\">Create account &amp; enroll passkey</button></div>\n" +
  "      <p id=\"reg-message\" class=\"auth-form__message\"></p>\n" +
  "    </form>\n" +
  "    <p class=\"auth-card__alt\">Already have one? <a href=\"/account/login\">Sign in →</a></p>\n" +
  "  </div>\n" +
  "  RAW_REGISTER_SCRIPT\n" +
  "</section>\n";

function renderAccountRegister(opts) {
  opts = opts || {};
  // Signup captcha renders whenever the operator has an active provider
  // (opts.captcha_kind + opts.captcha_public_key). The token is read by
  // passkey-register.js via window.__captchaToken() — no hidden field on
  // the JSON ceremony. Absent a provider this is "" (unconfigured no-op).
  var body = ACCOUNT_REGISTER_PAGE
    .replace("RAW_REGISTER_CAPTCHA", _captchaWidgetBlock(opts.captcha_kind, opts.captcha_public_key, false))
    .replace("RAW_REGISTER_SCRIPT", _islandScript("passkey-register.js"));
  return _wrap({
    title:      "Create account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    body:       body,
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
  "      <a class=\"btn-secondary\" href=\"/account/exchanges\">Exchanges</a>\n" +
  "      RAW_PICKUPS_LINK\n" +
  "      RAW_PAYMENT_METHODS_LINK\n" +
  "      <a class=\"btn-secondary\" href=\"/account/support\">Support</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/loyalty\">Rewards</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/credit\">Store credit</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/referrals\">Refer a friend</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/subscriptions\">Subscriptions</a>\n" +
  "      RAW_PREORDER_LINK\n" +
  // begin: profile + passkey management actions
  "      <a class=\"btn-secondary\" href=\"/account/profile\">Edit profile</a>\n" +
  "      <a class=\"btn-secondary\" href=\"/account/privacy\">Privacy &amp; data</a>\n" +
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
  "        <thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead>\n" +
  "        <tbody>{{order_rows}}</tbody>\n" +
  "      </table>\n" +
  "    </div>\n" +
  "    <p class=\"account-dash__all-orders\"><a href=\"/account/orders\">View all orders &rarr;</a></p>\n" +
  "  </div>\n" +
  "</section>\n";

var ACCOUNT_DASH_ORDER_ROW =
  "<tr>\n" +
  "  <td data-label=\"Order\"><a href=\"/orders/{{order_id}}\" class=\"account-order__id\"><code>{{order_id_short}}</code></a></td>\n" +
  "  <td class=\"account-order__items\" data-label=\"Items\">RAW_ACCOUNT_ORDER_THUMBS</td>\n" +
  "  <td data-label=\"Status\"><span class=\"pdp__badge {{status_class}}\">{{status}}</span></td>\n" +
  "  <td class=\"price\" data-label=\"Total\">{{total}}</td>\n" +
  "  <td data-label=\"Actions\">RAW_ACCOUNT_ORDER_ACTIONS</td>\n" +
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
    // Per-row Reorder / Request-a-return affordances (status-gated, shared
    // with the order page + order-history list). Localized to this cell —
    // it does not touch the dashboard's header action nav.
    return _render(ACCOUNT_DASH_ORDER_ROW, {
      order_id:       o.id,
      order_id_short: o.id.slice(0, 8),
      status:         o.status,
      status_class:   _statusClass(o.status),
      total:          pricing.format(o.grand_total_minor, o.currency),
    }).replace("RAW_ACCOUNT_ORDER_THUMBS", thumbs + moreCount)
      .replace("RAW_ACCOUNT_ORDER_ACTIONS", _orderRowActions(o));
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"5\" class=\"empty\">No orders yet. Browse the shop and your first order shows up here.</td></tr>";
  var body = _render(ACCOUNT_DASH_PAGE, {
    display_name:    opts.customer.display_name,
    order_count:     String(orders.length),
    lifetime_spend:  lifetimeStr,
    member_since:    memberSince,
    passkey_count:   String(passkeyCount),
    order_rows:      "RAW_ORDER_ROWS",
  }).replace("RAW_ORDER_ROWS", rows)
    // The Pre-orders link only renders when the preorder primitive is wired
    // (the /account/preorders route is mounted) — a deploy without it never
    // links to a 404.
    .replace("RAW_PREORDER_LINK", opts.preorders_enabled
      ? "<a class=\"btn-secondary\" href=\"/account/preorders\">Pre-orders</a>"
      : "")
    // The Pickups + Payment-methods links render only when those routes are
    // mounted (the primitive is wired), so a deploy without them never links
    // to a 404.
    .replace("RAW_PICKUPS_LINK", opts.pickups_enabled
      ? "<a class=\"btn-secondary\" href=\"/account/pickups\">Pickups</a>"
      : "")
    .replace("RAW_PAYMENT_METHODS_LINK", opts.payment_methods_enabled
      ? "<a class=\"btn-secondary\" href=\"/account/payment-methods\">Payment methods</a>"
      : "");
  return _wrap({
    title:      "Account",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    theme_css: opts.theme_css,
    // The account dashboard is per-customer + robots.txt-disallowed — keep
    // it out of the index with a noindex meta rather than relying on the
    // crawl policy alone.
    robots:     "noindex",
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

// ---- saved payment methods --------------------------------------------
//
// The signed-in customer's vaulted cards (Stripe pm_… tokens — the shop
// never holds the PAN/CVV). Each card shows brand + last4 + expiry, a
// Default badge, a Set-default form, and a Remove form; an "Add a card"
// CTA links to the SetupIntent page. Brand/last4 are processor-supplied
// short strings but escaped at the sink for consistency.
function renderPaymentMethods(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var list = opts.payment_methods || [];
  var notice = opts.notice
    ? "<p class=\"form-notice form-notice--err\" role=\"alert\">" + esc(String(opts.notice)) + "</p>"
    : "";
  var success = opts.success
    ? "<p class=\"form-notice form-notice--ok\" role=\"status\">" + esc(String(opts.success)) + "</p>"
    : "";
  var rowsHtml = "";
  for (var i = 0; i < list.length; i += 1) {
    var pm = list[i];
    var isDefault = Number(pm.is_default) === 1 || pm.is_default === true;
    var expiry = (pm.exp_month != null && pm.exp_year != null)
      ? esc(String(pm.exp_month).padStart ? String(pm.exp_month).padStart(2, "0") : String(pm.exp_month)) + "/" + esc(String(pm.exp_year))
      : "";
    rowsHtml +=
      "<li class=\"pm-card\">" +
        "<div class=\"pm-card__head\">" +
          "<span class=\"pm-card__brand\">" + esc(String(pm.brand)) + " &middot; &middot;&middot;&middot;&middot; " + esc(String(pm.last4)) + "</span>" +
          (isDefault ? "<span class=\"pdp__badge pdp__badge--ok\">Default</span>" : "") +
        "</div>" +
        (expiry ? "<p class=\"pm-card__exp\">Expires " + expiry + "</p>" : "") +
        "<div class=\"pm-card__actions\">" +
          (isDefault ? "" :
            "<form method=\"post\" action=\"/account/payment-methods/" + esc(String(pm.id)) + "/default\">" +
              "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Set as default</button></form>") +
          "<form method=\"post\" action=\"/account/payment-methods/" + esc(String(pm.id)) + "/archive\">" +
            "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Remove</button></form>" +
        "</div>" +
      "</li>";
  }
  var inner = rowsHtml
    ? "<ul class=\"pm-list\">" + rowsHtml + "</ul>"
    : "<div class=\"account-empty\"><p class=\"account-empty__lede\">No saved cards yet. Add one for faster checkout.</p></div>";
  // "Add a card" CTA — only a live link when the add flow can actually
  // complete (the Stripe publishable key drives the SetupIntent Payment
  // Element on the add page). Absent it, render a disabled control + an
  // honest note instead of a link that dead-ends on the add page's 503.
  // Back-compat: callers that don't pass the flag keep the live link.
  var addCardAvailable = opts.add_card_available !== false;
  var ctaHtml = addCardAvailable
    ? "<a class=\"btn-primary\" href=\"/account/payment-methods/add\">Add a card</a>"
    : "<button type=\"button\" class=\"btn-primary\" disabled aria-disabled=\"true\">Add a card</button>" +
      "<p class=\"form-notice form-notice--warn\" role=\"status\">Adding a card isn't available on this store yet — card storage isn't fully configured. Your saved cards still work for checkout.</p>";
  var body =
    "<section class=\"account-payment-methods\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" +
        "<li><a href=\"/account\">Account</a></li>" +
        "<li aria-current=\"page\">Payment methods</li>" +
      "</ol></nav>" +
      "<h1 class=\"account-returns__title\">Payment methods</h1>" +
      success + notice +
      inner +
      "<div class=\"account-payment-methods__cta\">" +
        ctaHtml +
      "</div>" +
    "</section>";
  return _wrap({
    title:      "Payment methods",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
    body:       body,
  });
}

// The add-card page — a Stripe SetupIntent collected through the Payment
// Element. Mirrors the pay page: external Stripe.js (admitted by the
// route-scoped CSP set on GET) + the same-origin saved-card.js island. No
// inline script. The publishable key rides an HTML-attribute-escaped data-*
// attribute on the mount div, read by the island. The SetupIntent
// client_secret is fetched by the island from POST
// /account/payment-methods/setup-intent (so it's per-session, never cached
// in the page HTML).
var ADD_PAYMENT_METHOD_PAGE =
  "<section class=\"pay-page account-add-card\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>\n" +
  "    <li><a href=\"/account\">Account</a></li>\n" +
  "    <li><a href=\"/account/payment-methods\">Payment methods</a></li>\n" +
  "    <li aria-current=\"page\">Add a card</li>\n" +
  "  </ol></nav>\n" +
  "  <header class=\"section-head\">\n" +
  "    <p class=\"eyebrow\">Secure · Stripe</p>\n" +
  "    <h1 class=\"section-head__title\">Add a card</h1>\n" +
  "    <p class=\"section-head__lede\">Your card is stored securely with Stripe — this store never sees the full number.</p>\n" +
  "  </header>\n" +
  "  <div class=\"pay-card\" id=\"add-card-island\" data-pk=\"{{pk}}\">\n" +
  "    <form id=\"add-card-form\" method=\"post\" action=\"/account/payment-methods\">\n" +
  "      <input type=\"hidden\" name=\"setup_intent_id\" id=\"add-card-si\">\n" +
  "      <div id=\"payment-element\" class=\"pay-card__element\"></div>\n" +
  "      <button id=\"add-card-submit\" type=\"button\" class=\"btn-primary pay-card__submit\">Save card</button>\n" +
  "      <p id=\"add-card-message\" class=\"pay-card__message\" role=\"status\"></p>\n" +
  "    </form>\n" +
  "  </div>\n" +
  "  <script src=\"https://js.stripe.com/v3/\"></script>\n" +
  "  RAW_ADD_CARD_SCRIPT\n" +
  "</section>\n";

function renderAddPaymentMethod(opts) {
  opts = opts || {};
  if (!opts.publishable_key) throw new TypeError("storefront.renderAddPaymentMethod: opts.publishable_key required");
  var body = _render(ADD_PAYMENT_METHOD_PAGE, {
    pk: opts.publishable_key,
  }).replace("RAW_ADD_CARD_SCRIPT", _islandScript("saved-card.js"));
  return _wrap({
    title:      "Add a card",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:  opts.theme_css,
    robots:     "noindex",
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

// Compact per-row Reorder / Request-a-return affordances for an order
// table row (dashboard + order-history list). Shares the eligibility
// rules with the order page's _orderActionsBlock so a status that offers
// a return on the order page offers it in the row too. Reorder is a POST
// (mutates the cart); Request-a-return is a link to the form.
function _orderRowActions(o) {
  var esc = b.template.escapeHtml;
  var acts = [];
  if (_orderEligibleForReorder(o.status)) {
    acts.push(
      "<form method=\"post\" action=\"/orders/" + esc(String(o.id)) + "/reorder\" class=\"order-row-action\">" +
        "<button type=\"submit\" class=\"btn-ghost btn-ghost--sm\">Reorder</button>" +
      "</form>");
  }
  if (_orderEligibleForReturn(o.status)) {
    acts.push(
      "<a class=\"btn-ghost btn-ghost--sm order-row-action\" href=\"/account/orders/" + esc(String(o.id)) + "/return\">Return</a>");
  }
  if (!acts.length) return "<span class=\"meta\">—</span>";
  return "<div class=\"order-row-actions\">" + acts.join("") + "</div>";
}

var ORDER_LIST_PAGE =
  "<section class=\"account-orders\">\n" +
  "  <nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>\n" +
  "    <li><a href=\"/account\">Account</a></li>\n" +
  "    <li aria-current=\"page\">Orders</li>\n" +
  "  </ol></nav>\n" +
  "  <h1 class=\"account-orders__title\">Your orders</h1>\n" +
  "  <div class=\"table-scroll\">\n" +
  "    <table class=\"account-orders-table\">\n" +
  "      <thead><tr><th>Order</th><th>Placed</th><th>Status</th><th>Total</th><th>Actions</th></tr></thead>\n" +
  "      <tbody>{{order_rows}}</tbody>\n" +
  "    </table>\n" +
  "  </div>\n" +
  "  RAW_ORDER_LIST_PAGER" +
  "</section>\n";

// Full order-history list for the signed-in customer, backed by
// order.listForCustomer (cursor-paginated). Each row links to the order
// page and carries the per-row Reorder / Request-a-return affordances.
// An opaque next-cursor (when the page filled) renders a "Load more"
// link that threads ?cursor=. Empty history shows a designed empty state
// rather than a bare table.
function renderOrderList(opts) {
  opts = opts || {};
  var esc = b.template.escapeHtml;
  var orders = opts.orders || [];
  var rows = orders.map(function (o) {
    var placed = o.created_at ? new Date(Number(o.created_at)).toISOString().slice(0, 10) : "";
    var statusClass = (o.status === "completed" || o.status === "shipped" || o.status === "delivered")
      ? "pdp__badge--ok" : "";
    return "<tr>" +
      "<td data-label=\"Order\"><a class=\"account-order__id\" href=\"/orders/" + esc(String(o.id)) +
        "\"><code>" + esc(String(o.id).slice(0, 8)) + "</code></a></td>" +
      "<td data-label=\"Placed\">" + (placed ? "<time datetime=\"" + esc(placed) + "\">" + esc(placed) + "</time>" : "—") + "</td>" +
      "<td data-label=\"Status\"><span class=\"pdp__badge " + statusClass + "\">" + esc(String(o.status)) + "</span></td>" +
      "<td class=\"price\" data-label=\"Total\">" + esc(pricing.format(o.grand_total_minor, o.currency)) + "</td>" +
      "<td data-label=\"Actions\">" + _orderRowActions(o) + "</td>" +
      "</tr>";
  }).join("");
  var pager = "";
  if (!rows) {
    rows = "<tr><td colspan=\"5\" class=\"empty\">No orders yet. <a href=\"/\">Browse the shop →</a></td></tr>";
  } else if (opts.next_cursor) {
    pager = "<div class=\"account-orders__pager\">" +
      "<a class=\"btn-secondary\" href=\"/account/orders?cursor=" + esc(encodeURIComponent(String(opts.next_cursor))) +
      "\">Load more orders →</a></div>";
  }
  var body = _render(ORDER_LIST_PAGE, { order_rows: "RAW_ORDER_ROWS" })
    .replace("RAW_ORDER_ROWS", rows)
    .replace("RAW_ORDER_LIST_PAGER", pager);
  return _wrap({
    title:      "Your orders",
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
  var req  = q.required
    ? " <span class=\"survey-req\" aria-hidden=\"true\">*</span><span class=\"sr-only\">(required)</span>"
    : "";
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

// ---- help center (knowledge base) --------------------------------------
//
// The public /help reader: an index grouped by category, and a per-article
// page with the safely-rendered body, a breadcrumb, BreadcrumbList JSON-LD,
// and a "Was this helpful?" control. Container-rendered (not edge): the
// article body is the knowledgeBase primitive's own `body_html`, which it
// computes through the shared Markdown subset (every text run escaped via
// b.template.escapeHtml, every link URL gated by b.safeUrl) — so the page
// never emits unescaped operator HTML, and the renderer here only ever
// interpolates already-rendered, already-escaped fragments. The vote POST
// needs a per-session CSRF token, which the container already issues; the
// edge serves no per-session forms.

// The help index. `opts.groups` is an array of { category, articles: [...] }
// (each article: { slug, title }); `opts.popular` is an optional array of
// { slug, title }. An empty index renders a friendly notice. The body never
// carries operator HTML — titles are escaped at the sink.
function renderHelpIndex(opts) {
  opts = opts || {};
  var esc = function (s) { return b.template.escapeHtml(String(s == null ? "" : s)); };
  var groups = opts.groups || [];
  var shopName = opts.shop_name || "blamejs.shop";

  var body;
  if (!groups.length) {
    body =
      "<section class=\"help-page\"><div class=\"help-page__inner help-page__inner--msg\">" +
        "<p class=\"eyebrow\">Help center</p>" +
        "<h1 class=\"help-page__title\">Help center</h1>" +
        "<p class=\"help-page__lede\">No help articles have been published yet. Check back soon.</p>" +
        "<a class=\"btn-ghost\" href=\"/\">Back to the shop</a>" +
      "</div></section>";
  } else {
    var popular = opts.popular || [];
    var popularHtml = popular.length
      ? "<aside class=\"help-popular\"><h2 class=\"help-popular__title\">Popular articles</h2><ul class=\"help-popular__list\">" +
          popular.map(function (a) {
            return "<li><a href=\"/help/" + esc(encodeURIComponent(a.slug)) + "\">" + esc(a.title) + "</a></li>";
          }).join("") +
        "</ul></aside>"
      : "";
    var sections = groups.map(function (g) {
      var items = (g.articles || []).map(function (a) {
        return "<li class=\"help-list__item\"><a href=\"/help/" + esc(encodeURIComponent(a.slug)) + "\">" + esc(a.title) + "</a></li>";
      }).join("");
      return "<section class=\"help-category\">" +
               "<h2 class=\"help-category__title\">" + esc(g.category) + "</h2>" +
               "<ul class=\"help-list\">" + items + "</ul>" +
             "</section>";
    }).join("");
    body =
      "<section class=\"help-page\"><div class=\"help-page__inner\">" +
        "<p class=\"eyebrow\">Help center</p>" +
        "<h1 class=\"help-page__title\">How can we help?</h1>" +
        "<p class=\"help-page__lede\">Browse answers to common questions.</p>" +
        popularHtml +
        "<div class=\"help-categories\">" + sections + "</div>" +
      "</div></section>";
  }
  return _wrap({
    title:         "Help center",
    shop_name:     shopName,
    cart_count:    opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:     opts.theme_css,
    og_description: "Help center for " + shopName + " — answers to common questions.",
    canonical_url: opts.canonical_url,
    og_url:        opts.og_url,
    body:          body,
  });
}

// A single help article. `opts.article` is the hydrated knowledgeBase row —
// `body_html` is ALREADY the safely-rendered HTML (escaped + link-gated by
// the primitive), so it's spliced verbatim into the page (via spliceRaw, so
// a `$`-bearing body can't trip String.replace's dollar substitution). The
// breadcrumb is Help -> [category] -> title with a matching BreadcrumbList
// JSON-LD (mirrors the PDP / collection shape); the "Was this helpful?"
// control POSTs to /help/:slug/vote and is CSRF-tokened by `_wrap`.
function renderHelpArticle(opts) {
  opts = opts || {};
  var esc = function (s) { return b.template.escapeHtml(String(s == null ? "" : s)); };
  var article = opts.article;
  if (!article || typeof article !== "object") {
    throw new TypeError("storefront.renderHelpArticle: opts.article required");
  }
  var shopName = opts.shop_name || "blamejs.shop";
  var slugEnc  = esc(encodeURIComponent(article.slug));

  var crumbHtml =
    "<li><a href=\"/help\">Help</a></li>" +
    (article.category ? "<li><a href=\"/help?category=" + esc(encodeURIComponent(article.category)) + "\">" + esc(article.category) + "</a></li>" : "") +
    "<li aria-current=\"page\">" + esc(article.title) + "</li>";

  // The vote control. The form posts to the container path /help/:slug/vote
  // (never an edge-exempt prefix), so `_injectCsrfFields` stamps it with the
  // per-request double-submit token. `voted` re-renders the confirmation
  // after a vote; absent it, the two buttons render.
  var voteHtml;
  if (opts.voted) {
    voteHtml = "<p class=\"help-vote__thanks\">Thanks for your feedback.</p>";
  } else {
    voteHtml =
      "<form class=\"help-vote\" method=\"post\" action=\"/help/" + slugEnc + "/vote\">" +
        "<p class=\"help-vote__q\">Was this helpful?</p>" +
        "<div class=\"help-vote__actions\">" +
          "<button class=\"btn-ghost\" type=\"submit\" name=\"vote\" value=\"helpful\">Yes</button>" +
          "<button class=\"btn-ghost\" type=\"submit\" name=\"vote\" value=\"not_helpful\">No</button>" +
        "</div>" +
      "</form>";
  }

  var articleHtml =
    "<article class=\"help-article\">" +
      "<nav class=\"breadcrumb\" aria-label=\"Breadcrumb\"><ol>" + crumbHtml + "</ol></nav>" +
      "<header class=\"help-article__head\">" +
        "<p class=\"eyebrow\">Help</p>" +
        "<h1 class=\"help-article__title\">" + esc(article.title) + "</h1>" +
      "</header>" +
      "<div class=\"help-article__body\">RAW_HELP_BODY_PLACEHOLDER</div>" +
      "<footer class=\"help-article__foot\">" + voteHtml +
        "<p class=\"help-article__back\"><a href=\"/help\">&larr; Back to help center</a></p>" +
      "</footer>" +
    "</article>";
  // body_html is the primitive's already-escaped, already-link-gated render —
  // splice it literally so a `$`-bearing body can't trip dollar substitution.
  articleHtml = _spliceRaw(articleHtml, "RAW_HELP_BODY_PLACEHOLDER", String(article.body_html || ""));

  // BreadcrumbList JSON-LD mirroring the on-page breadcrumb. The `item` URLs
  // are absolute so the structured data is fully-qualified. Mirrors the PDP /
  // collection breadcrumb shape.
  var absoluteBase = _absoluteBase(opts.canonical_url, shopName);
  var crumbItems = [
    { "@type": "ListItem", "position": 1, "name": "Help", "item": absoluteBase + "/help" },
  ];
  var pos = 2;
  if (article.category) {
    crumbItems.push({
      "@type": "ListItem", "position": pos, "name": article.category,
      "item": absoluteBase + "/help?category=" + encodeURIComponent(article.category),
    });
    pos += 1;
  }
  crumbItems.push({
    "@type": "ListItem", "position": pos, "name": article.title,
    "item": absoluteBase + "/help/" + encodeURIComponent(article.slug),
  });
  var breadcrumbJsonLd = _jsonLdScript({
    "@context":        "https://schema.org",
    "@type":           "BreadcrumbList",
    "itemListElement": crumbItems,
  });

  return _wrap({
    title:         article.title,
    shop_name:     shopName,
    cart_count:    opts.cart_count == null ? 0 : opts.cart_count,
    theme_css:     opts.theme_css,
    og_description: "Help: " + article.title,
    og_type:       "article",
    canonical_url: opts.canonical_url,
    og_url:        opts.og_url,
    body:          articleHtml + breadcrumbJsonLd,
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
  // Pre-order reservations — opts in the PDP reserve route + the
  // /account/preorders surface. The PDP swaps the add-to-cart buy box for a
  // reservation CTA when the lead SKU has an OPEN campaign; the reserve POST
  // pins the reservation to the signed-in session customer (no charge — the
  // launch flow converts the reservation into a Stripe-gated order).
  var preorder = deps.preorder || null;

  // CAPTCHA gate (bot challenge at signup / login / checkout). Active ONLY
  // when the operator has registered a provider AND set CAPTCHA_PROVIDER_SLUG
  // (server.js resolves the provider row at boot into captchaKind +
  // captchaPublicKey). Absent any of that, every helper below is a no-op:
  // no widget renders, no token is verified, and the flows behave EXACTLY as
  // an unconfigured store. Signup + checkout challenge whenever a provider is
  // active; login challenges only when the operator also opts in
  // (deps.captchaLoginEnabled, the CAPTCHA_GATE_LOGIN flag) — passkey login
  // is already phishing-resistant.
  var captchaGate    = deps.captchaGate || null;
  var captchaSlug    = deps.captchaProviderSlug || "";
  var captchaKind    = deps.captchaKind || "";
  var captchaPubKey  = deps.captchaPublicKey || "";
  var captchaVerify  = (typeof deps.captchaVerify === "function") ? deps.captchaVerify : null;
  var captchaActive  = !!(captchaGate && captchaSlug && captchaKind && captchaPubKey && captchaVerify);
  var captchaLoginOn = captchaActive && !!deps.captchaLoginEnabled;

  // The CSP_HOSTS key (turnstile / hcaptcha / recaptcha) that admits the
  // active provider's SDK host on the scoped CSP, or null when inactive.
  var captchaCspKey  = captchaActive ? _captchaCspKey(captchaKind) : null;

  // Verify a submitted captcha token for a gate, recording the outcome.
  // Returns { ok, status, message } — ok=true means proceed; ok=false means
  // refuse with the given status + clean message. A no-op pass-through
  // (ok=true) when the gate is inactive for this flow, so callers wrap the
  // verify unconditionally and the unconfigured store never changes. The
  // session/ip hashing is the primitive's expectation (pre-hashed values);
  // we pass the raw session id (recordOutcome hashes it) + a hashed ip.
  async function _verifyCaptcha(req, gate, token) {
    if (!captchaActive) return { ok: true };
    // Inactive for login unless the operator opted in.
    if (gate === "other" && !captchaLoginOn) return { ok: true };
    var raw = (typeof token === "string") ? token.trim() : "";
    // Defensive request-shape reader: a missing / blank token fails CLOSED at
    // the caller — never hand a placeholder to the provider (whose acceptance
    // we don't control). Recorded as a failed outcome, refused with a clean
    // message. This is independent of provider behavior.
    var outcome;
    if (!raw) {
      outcome = { ok: false, score: null, reasons: ["missing_token"] };
    } else {
      try {
        outcome = await captchaGate.verifyToken({
          provider_slug: captchaSlug,
          token:         raw,
          verify:        captchaVerify,
        });
      } catch (_e) {
        // A bad provider-slug shape / config fault → "unavailable", same
        // posture as vault/not-initialized (503) rather than a raw leak.
        return { ok: false, status: 503, message: "Verification is temporarily unavailable. Please try again." };
      }
    }
    // Best-effort audit row; never blocks the request on a write failure.
    try {
      var ipHash = b.crypto.namespaceHash("captcha-ip", securityMiddleware.clientKey(req));
      await captchaGate.recordOutcome({
        provider_slug: captchaSlug,
        gate:          gate,
        ok:            !!outcome.ok,
        score:         outcome.score == null ? undefined : outcome.score,
        ip_hash:       ipHash,
      });
    } catch (_re) { /* drop-silent — audit write must never break the flow */ }
    if (!outcome.ok) {
      return { ok: false, status: 400, message: "Please complete the verification challenge and try again." };
    }
    return { ok: true };
  }

  // Set the route-scoped CSP that admits the active captcha provider host on
  // the auth pages — ONLY when the gate is active for that flow. When
  // inactive the strict default app-level CSP stays (no setHeader), so the
  // unconfigured store's auth pages are unchanged. `flow` is "signup" |
  // "login": login only admits the host when login is opted in.
  function _setAuthCaptchaCsp(res, flow) {
    if (!captchaCspKey) return;
    if (flow === "login" && !captchaLoginOn) return;
    if (res && res.setHeader) {
      res.setHeader("content-security-policy", securityMiddleware.scopedCsp([captchaCspKey]));
    }
  }

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

  // Header nav gating — the Collections / Categories links + their mobile-
  // disclosure entries render only when the matching routes are mounted
  // (deps wired). Module-scoped so `_buildPrimaryNav` (called from the
  // module-level `_wrap`, which doesn't close over `deps`) can read them,
  // matching the `_ccyEnabled` / `_activeConsentPolicy` pattern.
  _hasCollections = !!deps.collections;
  _hasCategoryNav = !!deps.categoryNavigation;

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

  // Resolve the active trust badges for a container-only placement and
  // concatenate each one's sanitized renderHtml. Fires an impression per
  // rendered badge (fire-and-forget — the counter is drop-silent on the hot
  // path; never await it into the response). Drop-silent on ANY read failure
  // (returns "") — badges are supplementary; an absent dep / unmigrated table
  // / read error must never 500 a checkout or order page. Placements wired
  // today: "checkout", "order_confirmation". The svg_payload was sanitized at
  // define time via b.guardSvg, so renderHtml's inline emit is safe.
  async function _trustBadgesHtml(placement, req) {
    if (!deps.trustBadges) return "";
    try {
      var active = await deps.trustBadges.activeForPlacement({ placement: placement });
      if (!Array.isArray(active) || active.length === 0) return "";
      var sid = null;
      try { sid = _readSidCookie(req); } catch (_e) { sid = null; }
      var parts = [];
      for (var i = 0; i < active.length; i += 1) {
        var slug = active[i].slug;
        var html;
        try { html = await deps.trustBadges.renderHtml({ slug: slug }); }
        catch (_e) { continue; /* drop-silent — skip a badge that fails to render */ }
        parts.push(html);
        // Fire-and-forget impression — the method is already drop-silent.
        try {
          var imp = deps.trustBadges.recordImpression({ slug: slug, placement: placement, session_id: sid || undefined });
          if (imp && typeof imp.then === "function") imp.then(function () {}, function () {});
        } catch (_e) { /* drop-silent — impression bump must not affect render */ }
      }
      if (!parts.length) return "";
      return "<section class=\"trust-badges trust-badges--" + b.template.escapeHtml(placement) +
             "\" aria-label=\"Trust badges\">" + parts.join("") + "</section>";
    } catch (_e) {
      return "";   // drop-silent — supplementary; never 500 the page
    }
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
    // Short-circuit the FX presenter hop for visitors who never picked a
    // currency, or chose the live base: `loadPresenter` returns an
    // INACTIVE base presenter in exactly those cases (currency-display:
    // requested unset / === baseCurrency → base presenter), so the bundle
    // is the base bundle above unchanged. Skipping the FX rate read +
    // presenter build on every base-currency render is the common-case
    // win — only resolve the presenter when the visitor chose a non-base
    // currency that could actually convert.
    if (chosen != null && chosen !== base) {
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

  // hreflang `<link rel="alternate">` block for a URL-shaped locale policy.
  // The byte-identical twin of the edge's `chrome-i18n.js#alternateLinks` —
  // an edge↔container parity test pins the two so they never drift. Returns
  // "" for a non-URL strategy (cookie / accept-language / single-locale) or
  // a malformed host/path, so most stores emit nothing. Synchronous so the
  // locale middleware can seed it onto the ALS store within one tick (an
  // `await` would scope the store to the awaited frame, not the request).
  function _alternateLinksHtml(host, path) {
    var strategy = localeOptions.strategy;
    if (strategy !== "url_prefix" && strategy !== "subdomain") return "";
    if (supportedTags.length < 2) return "";
    if (typeof defaultLocale !== "string" || !_HREFLANG_TAG_RE.test(defaultLocale)) return "";
    if (typeof host !== "string" || typeof path !== "string") return "";
    var h = host.toLowerCase();
    var colon = h.indexOf(":");
    if (colon !== -1) h = h.slice(0, colon);
    if (!h.length || h.length > 253 || !_HREFLANG_HOST_RE.test(h)) return "";
    if (!path.length || path.length > 2048 || path.charAt(0) !== "/") return "";
    if (/[\x00-\x1f\x7f]/.test(path)) return "";
    var esc = b.template.escapeHtml;
    var out = "";
    for (var i = 0; i < supportedTags.length; i += 1) {
      var tag = supportedTags[i];
      if (typeof tag !== "string" || !_HREFLANG_TAG_RE.test(tag)) continue;
      var href = _canonicalForLocaleUrl(h, path, tag, strategy);
      if (href == null) continue;
      out += "  <link rel=\"alternate\" hreflang=\"" + esc(tag) +
        "\" href=\"" + esc(href) + "\">\n";
    }
    if (!out) return "";
    var xDefault = _canonicalForLocaleUrl(h, path, defaultLocale, strategy);
    if (xDefault != null) {
      out += "  <link rel=\"alternate\" hreflang=\"x-default\" href=\"" +
        esc(xDefault) + "\">\n";
    }
    return out;
  }

  // The per-request locale context the layout reads via the async-local
  // store. Resolved SYNCHRONOUSLY so the middleware can seed the store
  // within one tick. Shape: { locale, lang, dir, chrome, switcher_html,
  // alternate_links }. Never throws — any failure falls back to the
  // default locale.
  function _localeCtx(req) {
    var locale = defaultLocale;
    try { locale = _resolveRequestLocale(req); } catch (_e) { locale = defaultLocale; }
    var chrome = _chromeFor(locale);
    var hostHeader = (req.headers && (req.headers.host || req.headers.Host)) || "";
    var reqPath = req.pathname || (String(req.url || "/").split("?")[0]) || "/";
    var alternateLinks = "";
    try { alternateLinks = _alternateLinksHtml(String(hostHeader), reqPath); } catch (_e) { alternateLinks = ""; }
    return {
      locale:          locale,
      lang:            locale,
      dir:             _dirFor(locale),
      chrome:          chrome,
      switcher_html:   _switcherHtml(req, locale, chrome),
      alternate_links: alternateLinks,
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
        // Stash the per-request double-submit CSRF token alongside the locale
        // context so `_wrap` can inject it into the container's authenticated
        // POST forms (see `_injectCsrfFields`). The guard issues the token on
        // GET and exposes it as `req.csrfToken`; absent one (cookie-less /
        // bearer request the guard skips) it rides as "" and no field is
        // injected — there is nothing to submit and the guard isn't checking.
        _localeAls.enterWith(Object.assign({}, ctx, { csrf_token: req.csrfToken || "" }));
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
        // Coarse logged-in/guest bucket from auth-cookie PRESENCE — resolve
        // the prefixed (`__Host-`, https/production) and bare (http/dev)
        // names so an https visitor isn't mis-bucketed as a guest.
        var viewerKind = _readPrefixedCookie(req, AUTH_COOKIE_NAME_SECURE, AUTH_COOKIE_NAME) ? "logged_in" : "guest";
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

  // ---- help center (knowledge base) -----------------------------------
  // The public self-serve help reader. GET /help is the category-grouped
  // index of PUBLISHED articles; GET /help/:slug is one article (its
  // body_html is the primitive's escaped + link-gated render); POST
  // /help/:slug/vote records a "was this helpful?" vote. Container-rendered
  // (the vote form carries a per-request CSRF token `_wrap` injects).
  // Resilient: a missing table / read failure renders the empty state or a
  // clean 404/notice, never a 500.
  if (deps.knowledgeBase) {
    var kb = deps.knowledgeBase;

    function _helpThemeCss() {
      return (theme && theme.assetUrl) ? theme.assetUrl("css/main.css") : DEFAULT_THEME_CSS_URL;
    }

    // The published-only article gate. getArticle returns a row in ANY
    // state (the primitive's getArticle is not status-filtered), so the
    // public route MUST refuse anything that isn't published + non-archived
    // — a draft or archived article is invisible to the storefront, exactly
    // like the blog / CMS-page reader. Returns the hydrated row when it's
    // publicly viewable, else null (the route 404s). A malformed slug throws
    // a TypeError in the primitive, which the caller maps to a 404.
    async function _kbPublishedArticle(slug, locale) {
      var row = await kb.getArticle({ slug: slug, locale: locale });
      if (!row) return null;
      if (row.published !== true) return null;
      if (row.archived_at != null) return null;
      return row;
    }

    router.get("/help", async function (req, res) {
      var urls = _requestUrls(req);
      var rendered;
      try {
        var cartCount = await _cartCountForReq(req);
        // Category filter (the breadcrumb links carry ?category=…). An
        // invalid value just falls back to the full index (the primitive
        // throws on a bad category, which we swallow to a no-filter list).
        var category = null;
        var q = req.query || {};
        if (typeof q.category === "string" && q.category.length) category = q.category;
        var listOpts = { published_only: true, limit: kb.MAX_LIST_LIMIT };
        if (category) listOpts.category = category;
        var listing;
        try { listing = await kb.listArticles(listOpts); }
        catch (_e) { listing = await kb.listArticles({ published_only: true, limit: kb.MAX_LIST_LIMIT }); }
        var rows = listing.rows || [];
        // Group by category, preserving the listArticles order (updated_at
        // DESC) within each group; categories appear in first-seen order.
        var order = [];
        var byCat = {};
        for (var i = 0; i < rows.length; i += 1) {
          var a = rows[i];
          var c = a.category || "general";
          if (!byCat[c]) { byCat[c] = []; order.push(c); }
          byCat[c].push({ slug: a.slug, title: a.title });
        }
        var groups = order.map(function (cc) { return { category: cc, articles: byCat[cc] }; });
        // Popular block — best-effort over a 30-day window; any failure just
        // drops the rail (it's a cheap nicety, not a contract).
        var popular = [];
        try {
          var titleBySlug = {};
          for (var pi = 0; pi < rows.length; pi += 1) titleBySlug[rows[pi].slug] = rows[pi].title;
          var to = Date.now();
          var from = to - b.constants.TIME.days(30);
          var pop = await kb.popularArticles({ from: from, to: to, limit: 5 });
          for (var k = 0; k < pop.length; k += 1) {
            if (titleBySlug[pop[k].slug]) popular.push({ slug: pop[k].slug, title: titleBySlug[pop[k].slug] });
          }
        } catch (_e2) { popular = []; }
        rendered = renderHelpIndex({
          groups: groups, popular: popular, shop_name: shopName, cart_count: cartCount,
          theme_css: _helpThemeCss(), canonical_url: urls.canonical_url, og_url: urls.og_url,
        });
      } catch (_e) {
        // Table absent / read failure → the empty state, never a 500.
        rendered = renderHelpIndex({
          groups: [], shop_name: shopName, cart_count: 0, theme_css: _helpThemeCss(),
          canonical_url: urls.canonical_url, og_url: urls.og_url,
        });
      }
      _send(res, 200, rendered);
    });

    router.get("/help/:slug", async function (req, res) {
      var slug = (req.params && req.params.slug) || "";
      var urls = _requestUrls(req);
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { cartCount = 0; }
      var article = null;
      try {
        article = await _kbPublishedArticle(slug);
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;   // a real error, not a bad slug
        article = null;                           // malformed slug → 404
      }
      if (!article) {
        return _send(res, 404, renderNotFound({
          what: "help article", shop_name: shopName, cart_count: cartCount, theme_css: _helpThemeCss(),
          canonical_url: urls.canonical_url, og_url: urls.og_url,
        }));
      }
      // Record the view (best-effort, drop-silent — analytics, never blocks
      // the render). A session id keys the per-session view namespace; absent
      // one the view still counts (session_id is optional on recordView).
      try {
        var sid = _readSidCookie(req);
        await kb.recordView(sid ? { slug: article.slug, session_id: sid } : { slug: article.slug });
      } catch (_e) { /* drop-silent — view tracking never breaks the page */ }
      _send(res, 200, renderHelpArticle({
        article: article, shop_name: shopName, cart_count: cartCount, theme_css: _helpThemeCss(),
        canonical_url: urls.canonical_url, og_url: urls.og_url,
      }));
    });

    // Record a helpfulness vote. CSRF-safe via the per-request double-submit
    // token `_wrap` injects into the form (the action is a container path,
    // never an EDGE_POST_PATHS prefix, so it IS tokened + checked). The vote
    // dedups per (slug, session) at the primitive's UNIQUE; a browser with no
    // session cookie yet gets one minted here so the dedup has a key. A bad
    // slug / unpublished article / bad vote value all degrade to a clean
    // response, never a 500.
    router.post("/help/:slug/vote", async function (req, res) {
      var slug = (req.params && req.params.slug) || "";
      var urls = _requestUrls(req);
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { cartCount = 0; }
      var body = req.body || {};
      var vote = (typeof body.vote === "string") ? body.vote : "";

      var article = null;
      try { article = await _kbPublishedArticle(slug); }
      catch (e) { if (!(e instanceof TypeError)) throw e; article = null; }
      if (!article) {
        return _send(res, 404, renderNotFound({
          what: "help article", shop_name: shopName, cart_count: cartCount, theme_css: _helpThemeCss(),
          canonical_url: urls.canonical_url, og_url: urls.og_url,
        }));
      }

      // A session id keys the vote dedup. Mint + set one when the browser
      // has none yet (a uuid v7 matches the session-id cookie shape), so a
      // first-time voter still records exactly one distinct-session vote.
      var sid = _readSidCookie(req);
      if (!sid) { sid = b.uuid.v7(); _setSidCookie(req, res, sid); }

      // Record the vote. An invalid vote value (neither helpful nor
      // not_helpful) re-renders the article with the buttons (the primitive
      // throws a TypeError); a duplicate vote collapses to a no-op at the
      // UNIQUE. Either way the voter sees the thank-you confirmation — the
      // page never leaks an error or a stack.
      try {
        await kb.recordVote({ slug: article.slug, session_id: sid, vote: vote });
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        return _send(res, 200, renderHelpArticle({
          article: article, shop_name: shopName, cart_count: cartCount, theme_css: _helpThemeCss(),
          canonical_url: urls.canonical_url, og_url: urls.og_url,
        }));
      }
      _send(res, 200, renderHelpArticle({
        article: article, voted: true, shop_name: shopName, cart_count: cartCount, theme_css: _helpThemeCss(),
        canonical_url: urls.canonical_url, og_url: urls.og_url,
      }));
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

  // "You may also like" picks for a PDP. Deterministic same-collection
  // query so the edge (worker/data/catalog.js#listRelatedProducts) and
  // the container produce the SAME ordered list and the rail renders
  // byte-identically wherever the PDP is served: the source product's
  // primary collection (lowest membership position), then the other
  // active members of that collection ordered by membership position
  // then product id, self excluded, capped at `limit`. The signal-based
  // recommendations engine (co-purchase + RANDOM filler) is intentionally
  // NOT used here — its order isn't reproducible at the edge, which has
  // no engine handle and can't replay RANDOM(). Each pick is decorated
  // with its first variant's current USD price (minor units) + first
  // media row; the renderer formats the price string with the page's own
  // currency formatter so the rail tracks the active display currency.
  // Best-effort: a read failure (tables not migrated) returns [] so the
  // PDP renders without the rail rather than 500-ing.
  async function _relatedProductsFor(productId, limit) {
    var query = function (sql, params) { return b.externalDb.query(sql, params); };
    try {
      var primary = (await query(
        "SELECT collection_slug FROM collection_members WHERE product_id = ?1 " +
        "ORDER BY position ASC, id ASC LIMIT 1",
        [productId],
      )).rows[0];
      if (!primary) return [];
      // The sibling decoration (price + hero media per pick) now lands
      // in one batched query instead of per-sibling `products.get` +
      // `variants.listForProduct` + `prices.current` +
      // `media.listForProduct`. The helper returns the exact
      // { slug, title, hero_r2_key, hero_alt_text, price_minor,
      // price_currency } card shape the rail renderer consumes, in the
      // same (membership position ASC, product_id ASC) order, self +
      // inactive excluded, capped at limit — mirroring the edge
      // listRelatedProducts.
      return await deps.catalog.batch.relatedSiblings(primary.collection_slug, productId, "USD", limit);
    } catch (_e) {
      return [];
    }
  }

  // Resolve the cart for this request — read session_id from the
  // sealed cookie, create one (and the cart) if absent. Returns
  // the cart row OR null when the cart was just created (caller can
  // use { sid, cart: null } to skip lookup).
  async function _getOrCreateCart(req, res, currency) {
    var sid = _readSidCookie(req);
    if (!sid) {
      sid = b.uuid.v7();
      _setSidCookie(req, res, sid);
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
      // First pass: collect every distinct bundle reachable from the
      // product's variant SKUs (deduped), preserving discovery order.
      var bundles = [];
      for (var s = 0; s < variantSkus.length; s += 1) {
        var bundleList = await deps.bundles.bundlesForComponent(variantSkus[s]);
        for (var i = 0; i < bundleList.length; i += 1) {
          if (seen[bundleList[i].bundle_sku]) continue;
          seen[bundleList[i].bundle_sku] = true;
          bundles.push(bundleList[i]);
        }
      }
      if (!bundles.length) return [];

      // Member-title batching: resolve every member SKU's variant + its
      // owning product in two batched reads instead of a per-member
      // `variants.bySku` + `products.get`. (The full single-query bundle
      // resolver the edge has — getBundlesForProduct — is deferred;
      // member-title batching is the cheap win without touching the
      // server-authoritative pricing path.)
      var memberSkus = [];
      for (var bi = 0; bi < bundles.length; bi += 1) {
        var comps = bundles[bi].components || [];
        for (var ci = 0; ci < comps.length; ci += 1) memberSkus.push(comps[ci].sku);
      }
      var memberVariantBySku = {};
      var memberProductById = {};
      if (deps.catalog.batch && typeof deps.catalog.batch.variantsBySkus === "function") {
        memberVariantBySku = await deps.catalog.batch.variantsBySkus(memberSkus);
        var memberProductIds = [];
        var pidSeen = Object.create(null);
        for (var ms in memberVariantBySku) {
          if (!Object.prototype.hasOwnProperty.call(memberVariantBySku, ms)) continue;
          var pid = memberVariantBySku[ms].product_id;
          if (pid && !pidSeen[pid]) { pidSeen[pid] = true; memberProductIds.push(pid); }
        }
        if (memberProductIds.length && typeof deps.catalog.batch.productsByIds === "function") {
          memberProductById = await deps.catalog.batch.productsByIds(memberProductIds);
        }
      }

      for (var b2 = 0; b2 < bundles.length; b2 += 1) {
        var bundle = bundles[b2];
        // Decorate each member with a display title; flag unbuyable.
        var componentsOut = [];
        var allBuyable = true;
        for (var j = 0; j < bundle.components.length; j += 1) {
          var comp = bundle.components[j];
          var buyable = await _skuBuyable(comp.sku);
          if (!buyable) allBuyable = false;
          // The prior path always read the member variant via bySku
          // (regardless of buyability) for the title; the batched map is
          // that same variant. Falls back to a per-SKU bySku only if the
          // batch surface is absent.
          var memberVariant = Object.prototype.hasOwnProperty.call(memberVariantBySku, comp.sku)
            ? memberVariantBySku[comp.sku]
            : (buyable || (await deps.catalog.variants.bySku(comp.sku)));
          var memberTitle = comp.sku;
          if (memberVariant) {
            var memberProduct = Object.prototype.hasOwnProperty.call(memberProductById, memberVariant.product_id)
              ? memberProductById[memberVariant.product_id]
              : (deps.catalog.batch && typeof deps.catalog.batch.variantsBySkus === "function"
                  ? null
                  : await deps.catalog.products.get(memberVariant.product_id));
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
    // The owning product_id per line drives the quantity-discount
    // product-scope match. Resolve every line's variant in one batched
    // id lookup instead of a per-line `variants.get`, keyed by the same
    // stable variant_id the line carries (so the resolved product_id is
    // byte-identical to the per-line read). Best-effort — a read failure
    // leaves the map empty and each line falls back to no product scope,
    // exactly as a per-line failure did before.
    var variantById = {};
    if (deps.catalog.batch && typeof deps.catalog.batch.variantsByIds === "function") {
      try {
        variantById = await deps.catalog.batch.variantsByIds(
          lines.map(function (l) { return l.variant_id; }),
        );
      } catch (_e) { variantById = {}; }
    }
    var out = [];
    for (var i = 0; i < lines.length; i += 1) {
      var l = lines[i];
      var unit = l.unit_amount_minor;
      try {
        var variant = variantById[l.variant_id] || null;
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

  // Resolve the destination the cart/checkout totals estimate against,
  // most-specific first: (1) the signed-in customer's default shipping
  // address, (2) the operator's `shop.estimate_destination` config, (3) a
  // bare `{ country: "US" }`. Every read is best-effort — a missing
  // address table, an unmigrated config row, or a malformed saved value
  // degrades to the next fallback rather than 500-ing the cart. The
  // returned shape is the `ship_to` the tax/shipping primitives consume,
  // plus `from_saved` so the renderer can say "estimated for your saved
  // address" vs "estimated for <country>". A garbage country code from
  // any source is dropped (→ the US default) so the estimate never throws
  // inside the primitive's strict validators.
  async function _estimateDestination(req) {
    function _normalize(d, fromSaved) {
      if (!d || typeof d !== "object") return null;
      var country = typeof d.country === "string" ? d.country.toUpperCase() : "";
      if (!/^[A-Z]{2}$/.test(country)) return null;
      var state = (typeof d.state === "string" && /^[A-Za-z0-9]{1,5}$/.test(d.state))
        ? d.state.toUpperCase() : undefined;
      var postal = (typeof d.postal === "string" && /^[A-Za-z0-9 -]{1,16}$/.test(d.postal))
        ? d.postal : undefined;
      return { ship_to: { country: country, state: state, postal: postal }, from_saved: !!fromSaved };
    }
    // (1) Signed-in customer's default shipping address.
    var coAuth = _currentCustomerEnv(req);
    if (deps.addresses && coAuth) {
      try {
        var rows = await deps.addresses.listForCustomer(coAuth.customer_id, { limit: 50 });
        var pick = null;
        for (var ai = 0; ai < rows.length; ai += 1) {
          if (Number(rows[ai].is_default_shipping) === 1) { pick = rows[ai]; break; }
        }
        if (!pick && rows.length) pick = rows[0];
        if (pick) {
          var n = _normalize({
            country: pick.country,
            // Saved `region` is free-text ("California"); _normalize only
            // carries it when it already matches the subdivision-code shape.
            state:   pick.region,
            postal:  pick.postal_code,
          }, true);
          if (n) return n;
        }
      } catch (_e) { /* fall through to config / default */ }
    }
    // (2) Operator-configured default destination.
    if (deps.config && typeof deps.config.get === "function") {
      try {
        var cfg = await deps.config.get("shop.estimate_destination", null);
        var c2 = _normalize(cfg, false);
        if (c2) return c2;
      } catch (_e) { /* fall through to the US default */ }
    }
    // (3) Bare US default — the storefront's documented estimate locale.
    return { ship_to: { country: "US" }, from_saved: false };
  }

  // Compute the cart/checkout totals the shopper sees BEFORE paying.
  // Composes the SAME tax + shipping primitives the charge runs through
  // (via checkout.quote, which prices tax against the pre-discount
  // subtotal + picks shipping rates for the destination), so the
  // displayed grand total agrees with what Stripe is later asked to
  // charge for that destination. Returns:
  //
  //   {
  //     totals,            // pricing.totals() breakdown (always present)
  //     estimated,         // true when tax/shipping are an estimate
  //                        //   (destination not yet confirmed by the shopper)
  //     tax_resolved,      // a tax rule matched the destination
  //     shipping_resolved, // a shipping service priced the destination
  //     shipping_label,    // the chosen estimate service's label, or null
  //     destination,       // { ship_to, from_saved } the estimate used
  //   }
  //
  // `opts.confirmed` marks a destination the shopper actually entered
  // (the checkout POST re-render) so the figures read as exact, not an
  // estimate. Degrades gracefully at every step: no checkout dep, a
  // quote failure, or no shipping zone match all fall back to a
  // subtotal-only breakdown with tax/shipping flagged unresolved — the
  // subtotal is always honest, and the renderer labels the rest
  // "calculated at checkout" rather than fabricating a number.
  async function _estimateCartTotals(req, c, lines, opts) {
    opts = opts || {};
    var base = pricing.totals(c, lines, {});   // subtotal-only, always valid
    var result = {
      totals:            base,
      estimated:         !opts.confirmed,
      tax_resolved:      false,
      shipping_resolved: false,
      shipping_label:    null,
      destination:       null,
    };
    if (!deps.checkout || typeof deps.checkout.quote !== "function") return result;
    var dest = opts.ship_to
      ? { ship_to: opts.ship_to, from_saved: false }
      : await _estimateDestination(req);
    result.destination = dest;
    try {
      // quote() without a selected_shipping_id returns the tax row + ALL
      // available shipping services without throwing on selection; we pick
      // the cheapest as the estimate so the shopper sees the lowest real
      // shipping figure for the destination (they choose the exact service
      // at the address step).
      var quote = await deps.checkout.quote({
        cart_id:  c.id,
        ship_to:  dest.ship_to,
      });
      var taxMinor = quote.totals.tax_minor;
      result.tax_resolved = quote.tax_rate_bps > 0 ||
        (quote.tax_jurisdiction && quote.tax_jurisdiction !== "fallback");
      var rates = Array.isArray(quote.shipping_rates) ? quote.shipping_rates : [];
      var cheapest = null;
      for (var i = 0; i < rates.length; i += 1) {
        if (cheapest === null || rates[i].amount_minor < cheapest.amount_minor) cheapest = rates[i];
      }
      var shippingMinor = 0;
      if (cheapest) {
        shippingMinor = cheapest.amount_minor;
        result.shipping_resolved = true;
        result.shipping_label = cheapest.label;
      }
      result.totals = pricing.totals(c, lines, {
        tax_minor:      taxMinor,
        shipping_minor: shippingMinor,
        discount_minor: quote.totals.discount_minor || 0,
      });
    } catch (_e) {
      // Quote failed (cart not active, primitive error) — keep the honest
      // subtotal-only breakdown; the renderer shows "calculated at
      // checkout" for the unresolved lines.
      return result;
    }
    return result;
  }

  // Per-line stock truth for the cart: maps each line's variant SKU to its
  // availability state so the cart can say "Low stock" / "Out of stock"
  // instead of an implied always-buyable. Best-effort — a SKU with no
  // inventory row (or a read failure) is treated as available, matching the
  // storefront's never-block-on-missing-inventory stance. Returns a map
  // keyed by variant_id → "out" | "low" | "ok". Low is the operator's
  // configured low-stock threshold (`shop.low_stock_threshold`, default 5)
  // applied to available-on-hand (stock_on_hand − stock_held).
  async function _cartLineStock(lines) {
    var out = {};
    if (!deps.catalog || !deps.catalog.batch || typeof deps.catalog.batch.inventoryForSkus !== "function") {
      return out;
    }
    var threshold = 5;
    if (deps.config && typeof deps.config.get === "function") {
      try {
        var t = await deps.config.get("shop.low_stock_threshold", 5);
        if (Number.isInteger(t) && t >= 0) threshold = t;
      } catch (_e) { /* keep the default */ }
    }
    // One batched inventory read keyed by SKU instead of a per-line
    // `inventory.get`. Drop-silent on a read failure — the empty map
    // means every line reads "ok", matching the prior per-line stance.
    var invBySku = {};
    try {
      invBySku = await deps.catalog.batch.inventoryForSkus(
        lines.map(function (l) { return l.sku; }).filter(function (s) { return !!s; }),
      );
    } catch (_e) { invBySku = {}; /* a read failure never blocks the cart */ }
    for (var i = 0; i < lines.length; i += 1) {
      var vId = lines[i].variant_id;
      if (Object.prototype.hasOwnProperty.call(out, vId)) continue;
      var sku = lines[i].sku;
      if (!sku) { out[vId] = "ok"; continue; }
      var inv = Object.prototype.hasOwnProperty.call(invBySku, sku) ? invBySku[sku] : null;
      if (!inv) { out[vId] = "ok"; continue; }
      var avail = Number(inv.stock_on_hand || 0) - Number(inv.stock_held || 0);
      out[vId] = avail <= 0 ? "out" : (avail <= threshold ? "low" : "ok");
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
    // One decorated query for the whole home grid: each active product
    // carries its first variant's USD price (when one exists) and its
    // first attached media row (when one exists), pre-joined via window
    // functions — the same shape `renderHome` consumes (products
    // without a price render `—`; products without media render the
    // text-only PRODUCT_CARD fallback). Replaces the prior 1 + 24×3
    // per-product fan-out over the D1 bridge. Order (updated_at DESC,
    // id DESC) matches the prior `products.list` order.
    var decorated = await deps.catalog.batch.decoratedActive({ currency: "USD", limit: 24 });
    var products = decorated.rows;
    // Featured-collections band data — active collections, newest-curated
    // first (collections.list orders updated_at DESC, slug DESC; the band
    // caps to 6). Best-effort: a band read failure degrades to no band, it
    // never blocks the home page. The band itself drops when the list is
    // empty, so an unwired collections dep also yields hero → catalog.
    var collections = [];
    if (deps.collections && typeof deps.collections.list === "function") {
      try {
        collections = await deps.collections.list({ active_only: true });
      } catch (_e) { collections = []; }
    }
    var ccy = await _currencyForReq(req);
    var html = renderHome(Object.assign({ products: products, collections: collections, shop_name: shopName, theme: theme }, _requestUrls(req), ccy));
    _send(res, 200, html);
  });

  // Pull the facetable universe for a set of search terms: every
  // active product matching ANY term (canonical query + synonym
  // expansions) on title / description, decorated once. The
  // searchFacets primitive consumes this through a `catalog.list`
  // adapter and walks the rows in-memory for counts; the route reuses
  // the same rows for the narrowed result grid (one decoration pass,
  // no double round trip). One batched query (an OR-of-LIKE term clause
  // + a collection_members `IN` + a grouped-inventory `IN`) replaces
  // the prior per-term search + per-row decoration fan-out, and aligns
  // the `collection` facet field with the edge: MANUAL collection
  // membership only (smart-collection rule matches no longer populate
  // the search facet — the edge has always faceted manual-only, so this
  // removes the cross-substrate drift). Order (updated_at DESC, id DESC)
  // matches the edge `searchFacetableProducts`.
  async function _facetableUniverse(terms) {
    return (await deps.catalog.batch.searchDecorate({ terms: terms, currency: "USD" })).rows;
  }

  // Operator-tunable rerank of the matched search universe through
  // searchRanking.applyToResults (pins first, then weighted score DESC).
  // The decorated rows carry `id` + `in_stock` (bool) + `price_minor` but NOT
  // `product_id`, which applyToResults requires — project each row with
  // `product_id: row.id` + a `signals` bag built from the decorated fields.
  // applyToResults returns rows that preserve every original field plus
  // product_id/_score/_pinned, so the returned array IS the reranked universe
  // (the renderer reads its existing fields; the extra keys are inert).
  //
  // NEVER-500: ranking is supplementary to search. A missing dep, no active
  // weight set, a bad/archived weight slug, or any throw → return the
  // original universe unchanged (drop-silent defensive read). applyToResults
  // with no active set + no slug is a safe no-op that preserves input order,
  // so the common "operator hasn't configured ranking" path is inert.
  //
  // NOT dual-render — the edge /search (worker/render/search.js) does NOT
  // rerank. Edge-cached search serves the default order; the container path
  // serves the ranked order. This deliberate non-parity matches the
  // synonyms/facets precedent (both container-only at the edge) — search order
  // is not a price/legal contract, so order differences are acceptable.
  async function _rerankUniverse(universe, query) {
    if (!deps.searchRanking || !Array.isArray(universe) || universe.length === 0) {
      return universe;
    }
    try {
      var projected = universe.map(function (r) {
        return Object.assign({}, r, {
          product_id: r.id,
          signals: {
            in_stock:  r.in_stock === true,
            // price_minor is a pass-through integer signal (never divided —
            // no money arithmetic); a null price contributes nothing.
            price_minor: (typeof r.price_minor === "number" && isFinite(r.price_minor)) ? r.price_minor : 0,
          },
        });
      });
      var ranked = await deps.searchRanking.applyToResults({
        query:   (typeof query === "string" && query.trim().length) ? query : null,
        results: projected,
      });
      return Array.isArray(ranked) && ranked.length === universe.length ? ranked : universe;
    } catch (_e) {
      // Bad weight slug, archived set, or any ranking failure → un-ranked
      // fallback. Never 500 the search page.
      return universe;
    }
  }

  router.get("/search", async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var qRaw = url && url.searchParams.get("q");
    var q = typeof qRaw === "string" ? qRaw : "";
    // Cap at the validator's max length before handing to the
    // primitive — defends against a 10 MiB `?q=...` mass that would
    // otherwise round-trip through the LIKE escape function.
    if (q.length > 200) q = q.slice(0, 200);

    // 1-based results page from `?page=N`. A missing / non-numeric /
    // out-of-low-range value reads as page 1; the upper bound is clamped
    // to the real page count once the total is known (below) so a `?page`
    // past the end serves the last page rather than an empty grid.
    var page = _parsePageParam(url);

    var products    = [];
    var facetGroups = [];
    var filters     = {};
    var correctedQ  = "";
    var totalCount  = 0;

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
        // Operator-tunable rerank — applied to the FULL matched universe
        // BEFORE the facet adapter windows it, so pins + weights reorder
        // across ALL pages (searchFacets.previewQuery filters in input order
        // and slices, preserving the reranked order). Container-only; never
        // 500s the search page (see _rerankUniverse).
        universe = await _rerankUniverse(universe, q);
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
        // First pass reads the REAL total so the result-count copy is
        // honest and the page can be clamped to the last page. The second
        // pass windows that page (offset/sample) over the full passing set
        // — pages past the first are reachable, not discarded at 24.
        var totalPreview = await sfInstance.previewQuery({ query: q, filters: filters, sample: 0 });
        totalCount = totalPreview.total;
        page = _clampPage(page, totalCount, SEARCH_PAGE_SIZE);
        var preview = await sfInstance.previewQuery({
          query:  q,
          filters: filters,
          sample:  SEARCH_PAGE_SIZE,
          offset:  (page - 1) * SEARCH_PAGE_SIZE,
        });
        products = preview.sample;
      } else {
        // No facet dep — flat search over the expanded terms. The full
        // matched universe gives the honest total; the page is the
        // windowed slice (the same page size the faceted path uses).
        var flatUniverse = await _facetableUniverse(terms);
        // Operator-tunable rerank before windowing — full control of order.
        flatUniverse = await _rerankUniverse(flatUniverse, q);
        totalCount = flatUniverse.length;
        page = _clampPage(page, totalCount, SEARCH_PAGE_SIZE);
        products = flatUniverse.slice((page - 1) * SEARCH_PAGE_SIZE, page * SEARCH_PAGE_SIZE);
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
      total:           totalCount,
      page:            page,
      page_size:       SEARCH_PAGE_SIZE,
      shop_name:       shopName,
      cart_count:      cartCount,
    }, _requestUrls(req), ccy)));
  });

  router.get("/products/:slug", async function (req, res) {
    var slug = req.params && req.params.slug;
    if (!slug) return _send(res, 400, renderNotFound({ shop_name: shopName, theme: theme }));
    var product = await deps.catalog.products.bySlug(slug);
    if (!product) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
    // Variants + their current USD price in one query (the LEFT JOIN
    // collapses the prior per-variant `prices.current` loop). `vwp.rows`
    // is byte-identical to `variants.listForProduct` (options parsed),
    // `vwp.prices` is the { variantId: priceRow } map the renderer +
    // first-variant pricing read.
    var vwp = await deps.catalog.batch.variantsWithPrices(product.id, "USD");
    var variants = vwp.rows;
    var prices = vwp.prices;
    // Per-SKU inventory map driving the truthful availability badge +
    // JSON-LD. One batched read keyed by SKU, full row (the availability
    // resolver reads `low_stock_threshold` for the "Only N left" nudge).
    // Best-effort: a SKU with no inventory row (or a read failure) is
    // omitted from the map, which the renderer treats as available — the
    // never-block-on-missing-inventory stance the cart-hold path already
    // takes. Only populated when the operator has wired the inventory
    // batch surface.
    var inventory = {};
    if (variants.length && deps.catalog.batch && typeof deps.catalog.batch.inventoryRowsForSkus === "function") {
      try {
        inventory = await deps.catalog.batch.inventoryRowsForSkus(variants.map(function (v) { return v.sku; }));
      } catch (_e) { inventory = {}; /* drop-silent — missing inventory reads as available */ }
    }
    // Render cart count from the current session's cart, if any.
    var cartCount = await _cartCountForReq(req);
    // The remaining supplementary PDP reads are independent of each
    // other, so they run concurrently (mirroring the edge's Promise.all
    // at worker/index.js). Each preserves its own degrade-to-empty
    // guard so a missing/unmigrated table never 500s the buy path.
    var reviewSummary, reviewRows, reviewCta;
    var wishlistCount = 0;
    var qaQuestions, qaCta;
    var media;
    await Promise.all([
      // Media — first row drives the hero image, the next three feed the
      // thumbnail strip. `listForProduct` is product-level only.
      (async function () {
        media = await deps.catalog.media.listForProduct(product.id);
      })(),
      // Published reviews aggregate + list.
      (async function () {
        if (!deps.reviews) return;
        try {
          reviewSummary = await deps.reviews.summaryForProduct(product.id);
          reviewRows    = (await deps.reviews.listForProduct(product.id, { limit: 10 })).rows;
        } catch (_e) { reviewSummary = undefined; reviewRows = []; }
        // The form route enforces auth + the verified-purchase gate, so
        // the CTA links there unconditionally; logged-out shoppers get
        // redirected to login, non-purchasers get a clear "not eligible".
        reviewCta = "<a class=\"btn-secondary reviews__cta\" href=\"/products/" +
          b.template.escapeHtml(product.slug) + "/review\">Write a review</a>";
      })(),
      // Wishlist social-proof count — degrades to 0 on a read failure.
      (async function () {
        if (!deps.wishlist) return;
        try { wishlistCount = await deps.wishlist.countForProduct(product.id); }
        catch (_e) { wishlistCount = 0; }
      })(),
      // Published Q&A — approved questions + their approved answers. The
      // answers for ALL questions land in one batched
      // `answersForQuestions` read (one D1 hop) instead of a per-question
      // loop, then are stitched back onto each question in order.
      (async function () {
        if (!deps.productQa) return;
        qaQuestions = [];
        try {
          var qList = (await deps.productQa.questionsForProduct({ product_id: product.id, limit: 20 })).rows;
          var answersByQ = await deps.productQa.answersForQuestions(
            qList.map(function (q) { return q.id; }),
            { limit: 20 },
          );
          for (var qi = 0; qi < qList.length; qi += 1) {
            var qrow = qList[qi];
            qrow.answers = answersByQ[qrow.id] || [];
            qaQuestions.push(qrow);
          }
        } catch (_e) { qaQuestions = []; }
        // The form route enforces auth, so the CTA links there
        // unconditionally; logged-out shoppers get redirected to login.
        qaCta = "<a class=\"btn-secondary reviews__cta\" href=\"/products/" +
          b.template.escapeHtml(product.slug) + "/question\">Ask a question</a>";
      })(),
    ]);
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
    // "You may also like" — same-collection picks (deterministic order,
    // mirrored at the edge). Best-effort inside the helper; an empty list
    // hides the rail.
    var related = await _relatedProductsFor(product.id, 4);
    // Pre-order campaign for the lead SKU — when an OPEN campaign exists, the
    // renderer swaps the add-to-cart buy box for the reservation CTA (release
    // date + remaining availability). One indexed read; degrades to "no
    // campaign" (the standard buy box) on a missing table / read failure so
    // the buy path renders regardless. Mirrors the edge resolution so the
    // dual-rendered CTA agrees across substrates.
    var preorderCampaign = null;
    if (deps.preorder && firstVariant) {
      try {
        var openCampaign = await deps.preorder.openCampaignForSku(firstVariant.sku);
        if (openCampaign) {
          var avail = await deps.preorder.availability({ slug: openCampaign.slug });
          preorderCampaign = { campaign: openCampaign, remaining_units: avail ? avail.remaining_units : null };
        }
      } catch (_e) { preorderCampaign = null; }
    }
    // The reserve PRG lands here with a ?preorder=<marker> the renderer maps
    // to a banner; only meaningful when a campaign is present.
    var pdpUrl = req.url ? new URL(req.url, "http://localhost") : null;
    var preorderNotice = pdpUrl ? pdpUrl.searchParams.get("preorder") : null;
    var html = renderProduct(Object.assign({
      product:        product,
      variants:       variants,
      prices:         prices,
      preorder_campaign: preorderCampaign,
      preorder_notice:   preorderNotice,
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
      related:        related,
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
      _setSidCookie(req, res, sid);
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
      _send(res, 200, renderCollectionList(Object.assign({
        collections: cols, shop_name: shopName, cart_count: cartCount, asset_prefix: _cardAssetPrefix,
      }, _requestUrls(req))));
    });

    router.get("/collections/:slug", async function (req, res) {
      var slug = req.params && req.params.slug;
      // get() throws a TypeError on a malformed slug (the primitive
      // validates shape). A bad path segment / unknown / archived
      // collection is a 404, not a 500 — the route is a defensive
      // request-shape reader.
      var col;
      try {
        col = slug ? await deps.collections.get(slug) : null;
        if (!col || col.archived_at != null) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      } catch (e) {
        if (e instanceof TypeError) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        throw e;
      }

      // `?cursor=` trail — the comma-joined list of page-start cursors. The
      // current page starts at the trail's last cursor (page 1 = empty
      // trail). Parsed defensively (garbage entries dropped); the lib still
      // HMAC-verifies the resolved start cursor, so a tampered-but-well-
      // shaped cursor is caught below and falls back to page 1 rather than
      // 500/404 — matching how `/search` treats a bad `?page=`.
      var url   = req.url ? new URL(req.url, "http://localhost") : null;
      var trail = _parseCollectionCursorTrail(url);
      var startCursor = trail.length ? trail[trail.length - 1] : null;

      var result;
      try {
        result = await deps.collections.productsIn({ slug: slug, limit: COLLECTION_PAGE_SIZE, cursor: startCursor });
      } catch (e2) {
        // A bad/stale/tampered cursor surfaces as a TypeError whose message
        // names the cursor. Behave like page 1 (a reachable, link-followable
        // result) instead of a 404 — the collection still exists. Any other
        // TypeError (an impossible slug change between get() and productsIn)
        // is a 404; non-TypeErrors propagate.
        if (e2 instanceof TypeError && /cursor/i.test(e2.message || "")) {
          trail = [];
          startCursor = null;
          result = await deps.collections.productsIn({ slug: slug, limit: COLLECTION_PAGE_SIZE, cursor: null });
        } else if (e2 instanceof TypeError) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        } else {
          throw e2;
        }
      }

      var products = [];
      for (var i = 0; i < result.rows.length; i += 1) {
        var pid = result.rows[i].product_id || result.rows[i].id;
        var card = await _decorateProductCard(pid);
        if (card) products.push(card);
      }
      var cartCount = await _cartCountForReq(req);
      _send(res, 200, renderCollection(Object.assign({
        collection: col, products: products, shop_name: shopName, cart_count: cartCount,
        cursor_trail: trail, next_cursor: result.next_cursor,
      }, _requestUrls(req))));
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
    // Real total before pay: compose the same tax + shipping primitives the
    // charge runs through (estimated against the shopper's saved/default
    // destination until they confirm an address at checkout). Falls back to
    // a subtotal-only breakdown — with tax/shipping labelled "calculated at
    // checkout" — when checkout isn't wired or no zone matches.
    var totalsDetail = await _estimateCartTotals(req, c, lines, {});
    var totals = totalsDetail.totals;
    // Truthful per-line stock state (out / low / ok) so the cart never
    // implies a sold-out line is buyable.
    var lineStock = await _cartLineStock(lines);
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
    // Gift options — the active wrap catalog for the cart-page gift UI, plus
    // which wrap (if any) is already in the cart as a line so the selector
    // can pre-select it. Drop-silent: an unmigrated gift_wraps table → no UI.
    var giftWraps = [];
    var giftWrapInCart = null;
    if (deps.giftOptions) {
      try {
        giftWraps = await deps.giftOptions.listWraps({ active_only: true });
        if (giftWraps.length) {
          // A wrap is "in the cart" when one of its variant SKUs matches a
          // cart line's sku — the wrap rides as a real line (see POST
          // /cart/gift), so removing it removes the line.
          var wrapSkuSet = {};
          for (var gi = 0; gi < giftWraps.length; gi += 1) wrapSkuSet[giftWraps[gi].wrap_sku] = true;
          for (var ci = 0; ci < lines.length; ci += 1) {
            if (wrapSkuSet[lines[ci].sku]) { giftWrapInCart = lines[ci].sku; break; }
          }
        }
      } catch (_e) { giftWraps = []; giftWrapInCart = null; }
    }
    _send(res, 200, renderCart(Object.assign({
      lines:           lines,
      totals:          totals,
      totals_detail:   totalsDetail,
      line_stock:      lineStock,
      product_lookup:  productLookup,
      can_save:        !!(deps.saveForLater && deps.customers),
      checkout_available: !!(deps.checkout && deps.order),
      gift_wraps:      giftWraps,
      gift_wrap_in_cart: giftWrapInCart,
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
    async function _checkoutRenderOpts(req, c, lines, inlineError, confirmedShipTo) {
      // Full totals breakdown the summary renders. When the shopper has
      // entered an address (the POST re-render passes `confirmedShipTo`),
      // compute the EXACT total against it (estimated:false); otherwise
      // estimate against the saved/default destination so the summary
      // still shows a real Subtotal → tax → shipping → Total rather than a
      // bare subtotal. Composes the same tax/shipping primitives the charge
      // runs through (via checkout.quote inside _estimateCartTotals).
      var totalsDetail = await _estimateCartTotals(req, c, lines, confirmedShipTo
        ? { ship_to: confirmedShipTo, confirmed: true }
        : {});
      var totals = totalsDetail.totals;
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
      // Gift options — does the cart carry a wrap line? When it does (or the
      // gift primitive is wired at all), surface the message/recipient/hide-
      // prices fields so the customer can personalize the gift; they persist
      // post-commit via setForOrder. Drop-silent on a read failure.
      var giftWrapSkuInCart = null;
      if (deps.giftOptions) {
        try {
          var coWraps = await deps.giftOptions.listWraps({ active_only: true });
          var coWrapSet = {};
          for (var wi = 0; wi < coWraps.length; wi += 1) coWrapSet[coWraps[wi].wrap_sku] = true;
          for (var cli = 0; cli < lines.length; cli += 1) {
            if (coWrapSet[lines[cli].sku]) { giftWrapSkuInCart = lines[cli].sku; break; }
          }
        } catch (_e) { giftWrapSkuInCart = null; }
      }
      // Click-and-collect — the active pickup locations for the "pick up in
      // store" option. Drop-silent: an unmigrated table → no picker.
      var pickupLocations = [];
      if (deps.clickAndCollect) {
        try { pickupLocations = await deps.clickAndCollect.availableLocations({ limit: 50 }); }
        catch (_e) { pickupLocations = []; }
      }
      return {
        lines: lines, totals: totals, totals_detail: totalsDetail,
        shop_name: shopName, theme: theme,
        product_lookup: checkoutLookup,
        paypal_client_id: deps.paypal ? deps.paypal_client_id : null,
        loyalty_balance: loyaltyBalance,
        loyalty_points_per_usd: deps.loyalty ? deps.loyalty.REDEMPTION_POINTS_PER_USD : null,
        gift_enabled: !!deps.giftOptions,
        gift_wrap_sku_in_cart: giftWrapSkuInCart,
        pickup_locations: pickupLocations,
        prefill: prefill,
        inline_error: inlineError || null,
        // CAPTCHA widget props — set only when a provider is active, so the
        // unconfigured checkout renders no widget (renderCheckoutForm treats
        // an absent kind/key as no-op).
        captcha_kind:        captchaActive ? captchaKind   : null,
        captcha_public_key:  captchaActive ? captchaPubKey : null,
      };
    }

    // Route-scoped CSP for the checkout pages: always admits Stripe; adds
    // PayPal when configured (the block only renders then) and the active
    // CAPTCHA provider host when the gate is active. Set per response so the
    // app-level strict CSP governs every other route untouched. When nothing
    // beyond Stripe applies it still scopes to ["stripe"] (the pay step needs
    // it). Computed from the SAME conditions that gate what the page renders.
    function _setCheckoutCsp(res) {
      var keys = ["stripe"];
      if (deps.paypal && deps.paypal_client_id) keys.push("paypal");
      if (captchaActive && captchaCspKey) keys.push(captchaCspKey);
      res.setHeader && res.setHeader("content-security-policy", securityMiddleware.scopedCsp(keys));
    }

    // Persist the gift options + schedule a store pickup for a just-placed
    // order. POST-COMMIT + drop-silent (each in its own try/catch): both run
    // AFTER the charge and never change the amount — the wrap fee was already
    // a real cart line in the quote. The wrap_sku written here is read off the
    // cart's wrap line (so getForOrder shows it on the order page); the
    // message/recipient/hide-prices come from the checkout form. A failure
    // must NOT roll back the paid order.
    async function _persistGiftAndPickup(cart, placedOrder, body) {
      if (!placedOrder || !placedOrder.id) return;
      // Gift options.
      if (deps.giftOptions) {
        try {
          var orderLines = placedOrder.lines || [];
          var wrapSku = null;
          // Find the wrap line on the placed order (its sku matches an active
          // wrap) so the order page can show "Gift wrap: <sku>".
          var activeWraps = await deps.giftOptions.listWraps({ active_only: true });
          var wrapSet = {};
          for (var i = 0; i < activeWraps.length; i += 1) wrapSet[activeWraps[i].wrap_sku] = true;
          for (var li = 0; li < orderLines.length; li += 1) {
            if (wrapSet[orderLines[li].sku]) { wrapSku = orderLines[li].sku; break; }
          }
          var giftMessage   = (typeof body.gift_message === "string" && body.gift_message.trim()) ? body.gift_message : null;
          var recipientName = (typeof body.gift_recipient_name === "string" && body.gift_recipient_name.trim()) ? body.gift_recipient_name : null;
          var hidePrices    = body.gift_hide_prices === "1" || body.gift_hide_prices === true || body.gift_hide_prices === "on";
          // Only write a row when there's something to record (a wrap line, a
          // message, a recipient, or a hide-prices toggle).
          if (wrapSku || giftMessage || recipientName || hidePrices) {
            await deps.giftOptions.setForOrder({
              order_id:       placedOrder.id,
              wrap_sku:       wrapSku || undefined,
              gift_message:   giftMessage || undefined,
              recipient_name: recipientName || undefined,
              hide_prices:    hidePrices,
            });
          }
        } catch (_e) { /* drop-silent — a gift-options failure must not roll back the paid order */ }
      }
      // Pickup scheduling — when the customer chose "pick up in store". A
      // default 1-hour window starting at the location's lead-time floor (the
      // primitive enforces lead time + capacity; a refusal is swallowed). v1
      // keeps shipping as quoted — the pickup choice doesn't suppress the
      // shipping charge (re-open if operators need that).
      if (deps.clickAndCollect) {
        var locationCode = typeof body.pickup_location_code === "string" ? body.pickup_location_code.trim() : "";
        if (locationCode) {
          try {
            var loc = await deps.clickAndCollect.getLocation(locationCode);
            if (loc) {
              var leadMs = Number(loc.lead_time_hours || 0) * b.constants.TIME.hours(1);
              // Start the window one minute past the lead-time floor so the
              // primitive's strict `< leadFloor` gate accepts it.
              var start = Date.now() + leadMs + b.constants.TIME.minutes(1);
              var end   = start + b.constants.TIME.hours(1);
              await deps.clickAndCollect.scheduleAtLocation({
                order_id:               placedOrder.id,
                location_code:          locationCode,
                scheduled_window_start: start,
                scheduled_window_end:   end,
              });
            }
          } catch (_e) { /* drop-silent — a scheduling failure must not roll back the paid order */ }
        }
      }
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
      _setCheckoutCsp(res);
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
      // CAPTCHA gate (no-op unless a provider is active for checkout). Verify
      // BEFORE the cart is converted — a failed challenge re-renders the form
      // with an inline correction, never starts the order. The form field is
      // `captcha_token` (rendered inside the checkout form).
      var coCaptcha = await _verifyCaptcha(req, "checkout_coupon", body.captcha_token);
      if (!coCaptcha.ok) {
        try {
          var capLines = await _repriceCartLines(await deps.cart.listLines(c.id));
          if (capLines.length && coCaptcha.status === 400) {
            _setCheckoutCsp(res);
            return _send(res, 400, renderCheckoutForm(await _checkoutRenderOpts(req, c, capLines, coCaptcha.message)));
          }
        } catch (_ce) { /* fall through to the styled error page */ }
        return _send(res, coCaptcha.status || 400, renderCheckoutError({
          shop_name: shopName, theme: theme, eyebrow: "Checkout",
          title_text: "Couldn't verify your request",
          reason: coCaptcha.message,
          back_href: "/checkout", back_label: "Back to checkout",
          secondary_href: "/cart", secondary_label: "Back to cart",
        }));
      }
      var shipTo = _shipToFromBody(body);
      try {
        _requireCheckoutFields(body, shipTo);
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
        // POST-COMMIT, drop-silent: gift options + pickup scheduling. Both
        // run AFTER the charge and DO NOT change the amount — the wrap FEE was
        // already a real cart line in the quote, so it's charged; only the
        // gift metadata (message/recipient/hide-prices) and the pickup
        // schedule land here. A failure must never roll back a paid order, so
        // each is its own try/catch (mirrors _recordAutoDiscounts).
        await _persistGiftAndPickup(c, result.order, body);
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
              // The shopper already entered an address on this POST — re-price
              // the summary against it (exact, not estimated) so the inline
              // re-render shows the same total the confirm path computed.
              var confirmedTo = (shipTo && /^[A-Z]{2}$/.test(shipTo.country)) ? shipTo : null;
              _setCheckoutCsp(res);
              return _send(res, 400, renderCheckoutForm(await _checkoutRenderOpts(req, c, coLines, msg, confirmedTo)));
            }
          } catch (_re) { /* fall through to the styled error page */ }
        }
        // A validation TypeError naming one of the form's own fields is the
        // shopper's to fix in place: re-render the shipping form with that
        // field marked (aria-invalid + adjacent error span) and every typed
        // value preserved. Guests have no saved-address prefill, so the POST
        // body is the only source of what they typed — echo it (escaped at
        // the field builder). Totals re-render as the estimate (confirmedTo
        // null): the rejected address can't be priced, and re-pricing
        // against it would just re-throw the same validator.
        if (e instanceof TypeError) {
          var invField = _checkoutFieldFromError(e);
          if (invField) {
            try {
              var vLines = await _repriceCartLines(await deps.cart.listLines(c.id));
              if (vLines.length) {
                _setCheckoutCsp(res);
                var vOpts = await _checkoutRenderOpts(req, c, vLines,
                  "Some shipping details need a correction — check the highlighted field.", null);
                vOpts.prefill = {
                  email: body.email, name: body.name,
                  line1: body.line1, line2: body.line2, city: body.city,
                  state: body.state, postal: body.postal, country: body.country,
                };
                vOpts.invalid_field = invField;
                return _send(res, 400, renderCheckoutForm(vOpts));
              }
            } catch (_re) { /* fall through to the styled error page */ }
          }
        }
        // A malformed address shape (TypeError) is still the shopper's to
        // fix; anything else is a server-side failure. Either way, render a
        // styled, recoverable page rather than raw text — back to the cart,
        // or back to the shipping form to re-enter the address.
        // Server-side failure detail (a PSP / TLS / upstream error string)
        // is operator material, not customer copy — it goes to the audit
        // sink; the page gets the generic recoverable message. TypeError
        // messages are this module's own validator prose and stay inline.
        var clientErr = (e instanceof TypeError);
        if (!clientErr) {
          b.audit.safeEmit({
            action:   "storefront.checkout.confirm.error",
            outcome:  "failure",
            metadata: { message: msg },
          });
        }
        return _send(res, clientErr ? 400 : 500, renderCheckoutError({
          shop_name: shopName, theme: theme, eyebrow: "Checkout",
          title_text: clientErr ? "We couldn't process your shipping details" : "Checkout didn't go through",
          reason: clientErr
            ? "Some shipping details couldn't be read: " + msg + " Go back and check the address fields."
            : "Something went wrong completing your order. Your cart is saved and nothing was charged — please try again in a moment.",
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
        // CAPTCHA gate — the same challenge POST /checkout runs (gate
        // "checkout_coupon"). Without it, a bot could bypass the card-checkout
        // challenge via the PayPal path. No-op when no provider is configured.
        var ppCaptcha = await _verifyCaptcha(req, "checkout_coupon", body.captcha_token);
        if (!ppCaptcha.ok) return _json(ppCaptcha.status || 400, { error: ppCaptcha.message || "captcha-required" });
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
      // A malformed (non-UUID) id makes order.get throw a TypeError; map it
      // to the same 404 as an unknown order rather than an uncaught 500.
      var o;
      try { o = await deps.order.get(orderId); }
      catch (e) { if (e instanceof TypeError) { o = null; } else throw e; }
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
      // Route-scoped CSP that admits js.stripe.com on script/connect/frame-src
      // (and Trusted Types stays on) so the Stripe SDK + the same-origin
      // pay.js island load — without relaxing the app-level strict CSP that
      // governs every OTHER route. setHeader OVERWRITES the app-level header
      // for this response only.
      //
      // KNOWN, NON-BLOCKING Trusted Types violation on this route (operator
      // follow-up, intentionally NOT fixed here). The app-level CSP carried
      // through verbatim by scopedCsp keeps `require-trusted-types-for
      // 'script'` + `trusted-types 'allow-duplicates' default`. Stripe.js v3
      // does NOT register a named Trusted Types policy of its own; instead it
      // expects the APPLICATION to define a `default` policy whose
      // createScriptURL vets Stripe's own hosts (per Stripe's integration
      // security guide). When Stripe.js dynamically injects its sub-resource
      // <script> (the frame-spawning performance path on *.js.stripe.com), the
      // browser refuses the TrustedScriptURL assignment because no `default`
      // policy is registered — the console logs "This document requires
      // 'TrustedScriptURL' assignment ... @ https://js.stripe.com/v3/". The
      // card form is unaffected: it loads from the STATIC <script
      // src="https://js.stripe.com/v3/"> tag, which is a direct HTML src (not
      // a JS-driven sink), so require-trusted-types-for does not gate it —
      // which is why card captures complete with the violation present. The
      // blocked path is Stripe's dynamic sub-frame/3DS loader.
      //
      // We do NOT loosen Trusted Types to silence it. Naming a Stripe policy
      // in the trusted-types directive does nothing (Stripe registers none);
      // the only fix Stripe documents is the app shipping a same-origin
      // `default` createScriptURL policy that allows js.stripe.com /
      // *.js.stripe.com AND widening this scoped CSP's script-src/frame-src to
      // *.js.stripe.com. A `default` TT policy is page-global (it vets EVERY
      // TrustedScriptURL/TrustedHTML/TrustedScript sink, including any future
      // app sink), so adopting it is a deliberate posture change, not a
      // drive-by — left as an operator follow-up. To reproduce + verify a fix,
      // pay with the Stripe 3-D Secure test card 4000002760003184 (forces an
      // authentication challenge, which exercises the dynamic challenge-frame
      // loader that trips this) and confirm the console violation is gone and
      // the challenge frame renders.
      res.setHeader && res.setHeader("content-security-policy", securityMiddleware.scopedCsp(["stripe"]));
      // Route-scoped Permissions-Policy that re-enables the `payment` feature
      // for this one response (same origin + the Stripe / Google Pay wallet
      // frames) so the Express Checkout Element's Google Pay / Apple Pay
      // buttons can use the Payment Request API. The app-level strict denylist
      // (payment=()) still governs every OTHER route; setHeader overwrites
      // only this response. Every other feature stays denied.
      res.setHeader && res.setHeader("permissions-policy", securityMiddleware.scopedPermissionsPolicy());
      // Operator trust badges at the checkout placement (container-only;
      // drop-silent → "" on any failure).
      var payTrustBadges = await _trustBadgesHtml("checkout", req);
      _send(res, 200, renderPayPage({
        order:           o,
        client_secret:   clientSecret,
        publishable_key: pk,
        shop_name:       shopName,
        theme:           theme,
        trust_badges_html: payTrustBadges,
      }));
    });

    router.get("/orders/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      // order.get runs _uuid(id), which THROWS a TypeError on a non-UUID id.
      // A malformed id is a missing record, not a server fault — map it to the
      // same 404 not-found path a well-formed-but-unknown id takes (mirrors
      // the reorder + cancel routes), never an uncaught 500.
      var o;
      try { o = await deps.order.get(orderId); }
      catch (e) { if (e instanceof TypeError) { o = null; } else throw e; }
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
      // Post-handoff shipment + carrier tracking. Best-effort: the
      // shipments table may not be migrated on every deploy, so a read
      // failure degrades to "no tracking panel" rather than 500-ing the
      // order page. getShipment hydrates each shipment's events, but
      // listForOrder doesn't — so fetch the full shipment per row to drive
      // the latest-event line. Bounded by the order's shipment count
      // (typically 1, a handful at most for split shipments).
      var shipments = [];
      if (deps.orderTracking) {
        try {
          var shipRows = await deps.orderTracking.listForOrder(o.id);
          for (var si = 0; si < shipRows.length; si += 1) {
            var full = await deps.orderTracking.getShipment(shipRows[si].id);
            shipments.push(full || shipRows[si]);
          }
        } catch (_e) { shipments = []; }
      }
      // Post-purchase fulfillment rating. Surfaced only on a signed-in
      // customer's OWN order (the IDOR gate above already proved
      // o.customer_id === orderAuth.customer_id when set) — a guest order
      // carries no owner, so the rating form/display is suppressed there.
      // Best-effort: an absent ratings primitive (or its table unmigrated)
      // degrades to "no rating panel" rather than 500-ing the order page.
      var ratingRow = null;
      var ratingEligible = false;
      if (deps.orderRatings && o.customer_id && orderAuth && o.customer_id === orderAuth.customer_id) {
        // Offer the rating surface only AFTER a successful read: an absent /
        // unmigrated ratings table degrades to "no rating panel" rather than
        // rendering a form whose POST would then 500 against the same missing
        // table. Eligibility also tracks the order-status window so the form
        // shows only when a submit would actually be accepted (the POST gates
        // on the same _orderEligibleForRating check).
        try {
          ratingRow = await deps.orderRatings.getRating({ order_id: o.id });
          ratingEligible = _orderEligibleForRating(o.status);
        } catch (_e) { ratingRow = null; ratingEligible = false; }
      }
      var ordUrl = req.url ? new URL(req.url, "http://localhost") : null;
      // Operator trust badges at the order_confirmation placement (container-
      // only; drop-silent → "" on any failure).
      var ordTrustBadges = await _trustBadgesHtml("order_confirmation", req);
      // Pickup (BOPIS) status — the IDOR gate above already proved ownership
      // (or this is a guest order on its capability URL). Drop-silent
      // defensive read: an unmigrated pickup table / bad shape → no panel.
      var pickup = null;
      if (deps.clickAndCollect) {
        try { pickup = await deps.clickAndCollect.getScheduleByOrder(o.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; pickup = null; }
      }
      // Gift options — the order's wrap / message / recipient / hide-prices.
      // Drop-silent: an unmigrated gift_options table / bad shape → no panel.
      var giftOptionsRow = null;
      if (deps.giftOptions) {
        try { giftOptionsRow = await deps.giftOptions.getForOrder(o.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; giftOptionsRow = null; }
      }
      _send(res, 200, renderOrder({
        order:           o,
        product_lookup:  productLookup,
        recommendations: recommendations,
        shipments:       shipments,
        pickup:          pickup,
        gift_options:    giftOptionsRow,
        trust_badges_html: ordTrustBadges,
        rating:          ratingRow,
        rating_eligible: ratingEligible,
        rating_notice:   ordUrl ? _ratingNoticeFor(ordUrl.searchParams.get("rate_err")) : null,
        reordered:       ordUrl ? ordUrl.searchParams.get("reordered") === "1" : false,
        cancelled:       ordUrl ? ordUrl.searchParams.get("cancelled") === "1" : false,
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
      // Login captcha is opt-in (CAPTCHA_GATE_LOGIN). The widget + the scoped
      // CSP that admits the provider host render only when login is opted in.
      _setAuthCaptchaCsp(res, "login");
      _send(res, 200, renderAccountLogin({
        shop_name:      shopName,
        cart_count:     cartCount,
        google_enabled: !!deps.oauthGoogle,
        apple_enabled:  !!deps.oauthApple,
        magic_link_enabled: !!(deps.customerPortal && deps.customerPortalEmail),
        error:          url && url.searchParams.get("error"),
        captcha_kind:        captchaLoginOn ? captchaKind   : null,
        captcha_public_key:  captchaLoginOn ? captchaPubKey : null,
      }));
    });

    router.get("/account/register", async function (req, res) {
      var cartCount = await _cartCountForReq(req);
      // Signup captcha renders whenever a provider is active; the scoped CSP
      // admits the provider host only then (no setHeader otherwise).
      _setAuthCaptchaCsp(res, "signup");
      _send(res, 200, renderAccountRegister({
        shop_name: shopName,
        cart_count: cartCount,
        captcha_kind:        captchaActive ? captchaKind   : null,
        captcha_public_key:  captchaActive ? captchaPubKey : null,
      }));
    });

    // ---- magic-link sign-in (passwordless email entry) ------------------
    //
    // A minimal passwordless login for shoppers without a passkey or a
    // social login. Composes the customer-portal primitive: createSession
    // mints a single-use, hashed-at-rest token; the link is emailed; the
    // GET redemption verifies (single-use) and sets the sealed shop_auth
    // cookie. The whole surface mounts only when BOTH the portal primitive
    // AND a transactional mailer are wired — absent either, /account/login/
    // link renders an "unavailable" state and passkey / OAuth are unchanged.
    if (deps.customerPortal && deps.customerPortalEmail) {
      // GET — the email-entry form.
      router.get("/account/login/link", async function (req, res) {
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderMagicLinkPage({
          shop_name:  shopName,
          cart_count: cartCount,
          sent:       url ? url.searchParams.get("sent") === "1" : false,
        }));
      });

      // POST — resolve the email to a customer, mint a portal session,
      // email the link. The response is ALWAYS the same enumeration-safe
      // confirmation (sent=1) regardless of whether the address matched —
      // no account-existence oracle. A bad-shaped email re-renders the
      // form. Every send is best-effort: a mailer failure still shows the
      // generic confirmation (the link simply doesn't arrive).
      router.post("/account/login/link", async function (req, res) {
        var body = req.body || {};
        var emailRaw = typeof body.email === "string" ? body.email : "";
        var customerId = null;
        // Resolve the customer by email hash. A malformed address (hashEmail
        // throws on bad shape) or a no-match both fall through to the
        // generic confirmation — no oracle.
        try {
          var hash = deps.customers.hashEmail(emailRaw);
          var cust = await deps.customers.byEmailHash(hash);
          if (cust && cust.id) customerId = cust.id;
        } catch (_e) { customerId = null; }

        if (customerId) {
          try {
            var minted = await deps.customerPortal.createSession({
              customer_id: customerId,
              scope:       "full",
            });
            // Build the absolute redemption link from this request's origin.
            var origin = "";
            try { origin = new URL(_requestUrls(req).canonical_url).origin; }
            catch (_e2) { origin = ""; }
            var linkUrl = origin + "/account/portal/" + encodeURIComponent(minted.plaintext_token);
            // The customer's plaintext address: the portal flow needs a
            // deliverable address. The customers store keeps only the hash,
            // so reuse the submitted address (the customer just typed it);
            // the email handle validates the address shape.
            await deps.customerPortalEmail.sendMagicLink({
              customer_email: emailRaw,
              link_url:       linkUrl,
            });
          } catch (_e3) { /* drop-silent — generic confirmation regardless */ }
        }
        // 303 to the GET with the generic confirmation flag.
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/login/link?sent=1");
        return res.end ? res.end() : res.send("");
      });

      // GET — redeem the magic-link token. verifyToken is single-use (flips
      // the row to consumed) and re-checks expiry; on success set the sealed
      // shop_auth cookie + 303 to /account. An unknown / expired / already-
      // used token bounces to login with a soft error (no oracle on why).
      router.get("/account/portal/:token", async function (req, res) {
        var token = (req.params && req.params.token) || "";
        var rv = null;
        try { rv = await deps.customerPortal.verifyToken(token); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
          rv = null;
        }
        if (!rv || !rv.customer_id) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/account/login?error=link");
          return res.end ? res.end() : res.send("");
        }
        // Adopt the guest cart into the now-authenticated account, mirroring
        // the OAuth / passkey login paths.
        var sid = _readSidCookie(req);
        if (sid) {
          try {
            var anonCart = await deps.cart.bySession(sid);
            if (anonCart) await deps.cart.setCustomer(anonCart.id, rv.customer_id);
          } catch (_e) { /* best-effort merge; sign-in itself succeeds */ }
        }
        _setAuthCookie(req, res, { customer_id: rv.customer_id, exp: Date.now() + b.constants.TIME.days(14) });
        res.status(303); res.setHeader && res.setHeader("location", "/account");
        return res.end ? res.end() : res.send("");
      });
    }

    router.post("/account/passkey/register-begin", async function (req, res) {
      try {
        var body = _readJsonBody(req);
        // CAPTCHA gate (no-op unless a provider is active). Verify the token
        // BEFORE creating the customer / minting a challenge — a failed
        // challenge refuses with a clean message and writes no customer row.
        var regCaptcha = await _verifyCaptcha(req, "signup", body.captcha_token);
        if (!regCaptcha.ok) {
          res.status(regCaptcha.status || 400);
          return res.end ? res.end(regCaptcha.message) : res.send(regCaptcha.message);
        }
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
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "register-begin failed") : res.send((e && e.message) || "register-begin failed");
        }
        return _authServerError(req, res, e, "register-begin");
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
        _setAuthCookie(req, res, {
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
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "register-finish failed") : res.send((e && e.message) || "register-finish failed");
        }
        return _authServerError(req, res, e, "register-finish");
      }
    });

    router.post("/account/passkey/login-begin", async function (req, res) {
      try {
        var body = _readJsonBody(req);
        // CAPTCHA gate (no-op unless a provider is active AND login is opted
        // in via CAPTCHA_GATE_LOGIN — passkey login is already phishing-
        // resistant). Recorded under gate "other" (the GATES enum has no
        // dedicated login member). Verified before any challenge is minted.
        var loginCaptcha = await _verifyCaptcha(req, "other", body.captcha_token);
        if (!loginCaptcha.ok) {
          res.status(loginCaptcha.status || 400);
          return res.end ? res.end(loginCaptcha.message) : res.send(loginCaptcha.message);
        }
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
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "login-begin failed") : res.send((e && e.message) || "login-begin failed");
        }
        return _authServerError(req, res, e, "login-begin");
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
        _setAuthCookie(req, res, {
          customer_id: customer.id,
          exp:         Date.now() + b.constants.TIME.days(14),
        });
        res.status(200);
        return res.end ? res.end("ok") : res.send("ok");
      } catch (e) {
        if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "login-finish failed") : res.send((e && e.message) || "login-finish failed");
        }
        return _authServerError(req, res, e, "login-finish");
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
        _clearAuthCookie(req, res);
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
        preorders_enabled:     !!preorder,
        pickups_enabled:       !!deps.clickAndCollect,
        payment_methods_enabled: !!(deps.paymentMethods && deps.payment),
        shop_name:             shopName,
        cart_count:            cartCount,
      }));
    });

    // Full order history for the signed-in customer, cursor-paginated.
    // The dashboard shows only the most-recent ten; this is the complete
    // list the "View your orders" link (and the returns empty-state CTA)
    // point at. Each row links to the order page + carries the per-row
    // Reorder / Request-a-return affordances. Mounted only when an order
    // handle is wired.
    if (deps.order) {
      router.get("/account/orders", async function (req, res) {
        var ordersAuth;
        try { ordersAuth = _currentCustomer(req); }
        catch (e) {
          if (e && e.code === "vault/not-initialized") return _serviceUnavailable(res, "auth not configured");
          throw e;
        }
        if (!ordersAuth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          return res.end ? res.end() : res.send("");
        }
        var listUrl = req.url ? new URL(req.url, "http://localhost") : null;
        var cursor  = listUrl ? listUrl.searchParams.get("cursor") : null;
        var page;
        try {
          page = await deps.order.listForCustomer(ordersAuth.customer_id, {
            limit:  20,
            cursor: cursor || undefined,
          });
        } catch (e) {
          // A tampered / malformed cursor throws TypeError — restart the
          // list from the top rather than 500-ing.
          if (!(e instanceof TypeError)) throw e;
          page = await deps.order.listForCustomer(ordersAuth.customer_id, { limit: 20 });
        }
        var listCartCount = await _cartCountForReq(req);
        _send(res, 200, renderOrderList({
          orders:      page.rows,
          next_cursor: page.next_cursor || null,
          shop_name:   shopName,
          cart_count:  listCartCount,
        }));
      });
    }

    router.post("/account/logout", function (req, res) {
      _clearAuthCookie(req, res);
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
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "add-begin failed") : res.send((e && e.message) || "add-begin failed");
        }
        return _authServerError(req, res, e, "add-begin");
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
        if (e instanceof TypeError) {
          res.status(400);
          return res.end ? res.end((e && e.message) || "add-finish failed") : res.send((e && e.message) || "add-finish failed");
        }
        return _authServerError(req, res, e, "add-finish");
      }
    });

    // ---- saved payment methods (Stripe SetupIntent vault) -------------
    //
    // List / set-default / archive a customer's saved cards, plus an add-card
    // flow over a Stripe SetupIntent (the shop never sees the PAN/CVV — only
    // the opaque pm_… token). Mounts only when BOTH the paymentMethods
    // primitive AND a Stripe payment handle are wired (the SetupIntent +
    // payment-method reads need Stripe). The list/set-default/archive
    // surfaces need no external JS; the add page reuses the route-scoped CSP +
    // an external same-origin island (saved-card.js), mirroring the pay page.
    if (deps.paymentMethods && deps.payment) {
      // IDOR GATE — paymentMethods.get/setDefault/archive are keyed by id
      // ALONE (no customer scope). Resolve the row by path id and confirm it
      // belongs to the authed customer; a foreign / unknown / malformed id is
      // a 404, never a cross-customer reveal or mutation. Mandatory before any
      // read/mutate. Mirrors _ownedPasskey.
      async function _ownedPaymentMethod(req, res, auth) {
        var id = req.params && req.params.id;
        var row;
        try { row = await deps.paymentMethods.get(id); }
        catch (e) {
          // A malformed id throws TypeError from the uuid guard — a 404, not
          // a 500 (a bad id is a missing record).
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!row || row.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return row;
      }

      async function _renderPaymentMethodsPage(req, res, auth, notice, code) {
        var rows = await deps.paymentMethods.listForCustomer(auth.customer_id);
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var okKind = url ? url.searchParams.get("ok") : null;
        var successCopy = null;
        if (okKind === "added")    successCopy = "Card saved.";
        if (okKind === "default")  successCopy = "Default card updated.";
        if (okKind === "archived") successCopy = "Card removed.";
        if (okKind === "exists")   successCopy = "That card is already on file.";
        _send(res, code || 200, renderPaymentMethods({
          payment_methods:   rows,
          notice:            notice || null,
          success:           successCopy,
          // The add-card page needs the Stripe publishable key for the
          // SetupIntent Payment Element; without it the add route 503s,
          // so render the disabled "Add a card" state rather than a link
          // into that dead end.
          add_card_available: !!deps.stripe_publishable_key,
          shop_name:         shopName,
          cart_count:        cartCount,
        }));
      }

      router.get("/account/payment-methods", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        await _renderPaymentMethodsPage(req, res, auth, null);
      });

      // The add-card page — loads Stripe.js (admitted by the route-scoped
      // CSP) + the saved-card.js island that mounts a SetupIntent Payment
      // Element. The publishable key rides a data-* attribute (no inline
      // script). Requires the publishable key; absent it, a 503 like the pay
      // page.
      router.get("/account/payment-methods/add", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var pk = deps.stripe_publishable_key || "";
        if (!pk) {
          return _send(res, 503, _wrap({
            title: "Add a card", shop_name: shopName, theme_css: undefined, cart_count: await _cartCountForReq(req),
            body: "<section class=\"account-returns\"><h1>Add a card</h1><p>Card storage isn't available right now.</p>" +
                  "<a class=\"btn-secondary\" href=\"/account/payment-methods\">Back</a></section>",
          }));
        }
        // Route-scoped CSP admits js.stripe.com (script/connect/frame) so the
        // SDK + the same-origin saved-card.js island load — without relaxing
        // the app-level strict CSP on any other route.
        res.setHeader && res.setHeader("content-security-policy", securityMiddleware.scopedCsp(["stripe"]));
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderAddPaymentMethod({
          publishable_key: pk,
          shop_name:       shopName,
          cart_count:      cartCount,
        }));
      });

      // Create (server-side) a SetupIntent for the shopper + return its
      // client_secret as JSON (CSRF-tokened; NOT an edge path). A fresh
      // Stripe Customer is minted per add (no stripe_customer_id column on
      // the customers table; Stripe dedupes by metadata/email) — acceptable
      // v1, documented in the build spec.
      router.post("/account/payment-methods/setup-intent", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        function _json(status, obj) {
          res.status(status);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var s = JSON.stringify(obj);
          return res.end ? res.end(s) : res.send(s);
        }
        try {
          var customer = await deps.payment.createCustomer({ metadata: { shop_customer_id: auth.customer_id } });
          if (!customer || !customer.id) return _json(502, { error: "customer-create-failed" });
          var si = await deps.payment.createSetupIntent({ customer: customer.id });
          if (!si || !si.client_secret) return _json(502, { error: "setup-intent-failed" });
          return _json(200, { client_secret: si.client_secret });
        } catch (e) {
          return _json(e instanceof TypeError ? 400 : 502, { error: (e && e.message) || "setup-intent-failed" });
        }
      });

      // After Elements confirms the SetupIntent client-side, the browser
      // POSTs the setup_intent_id back; the server reads it → the resulting
      // pm_… → its display fields → stores via paymentMethods.add. A
      // duplicate token (already on file) is an idempotent notice, not a 500.
      router.post("/account/payment-methods", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var body = req.body || {};
        var setupIntentId = typeof body.setup_intent_id === "string" ? body.setup_intent_id : "";
        if (!setupIntentId) return _renderPaymentMethodsPage(req, res, auth, "Couldn't add that card — please try again.", 400);
        try {
          var si = await deps.payment.retrieveSetupIntent(setupIntentId);
          var pmId = si && si.payment_method;
          if (!pmId) return _renderPaymentMethodsPage(req, res, auth, "That card couldn't be confirmed — please try again.", 400);
          var pm = await deps.payment.retrievePaymentMethod(pmId);
          var card = (pm && pm.card) || {};
          if (!card.brand || !card.last4) {
            return _renderPaymentMethodsPage(req, res, auth, "We couldn't read that card's details — please try again.", 400);
          }
          await deps.paymentMethods.add({
            customer_id:     auth.customer_id,
            processor:       "stripe",
            processor_token: pmId,
            brand:           card.brand,
            last4:           card.last4,
            exp_month:       Number(card.exp_month),
            exp_year:        Number(card.exp_year),
          });
        } catch (e) {
          if (e && e.code === "PAYMENT_METHOD_DUPLICATE_TOKEN") {
            res.status(303); res.setHeader && res.setHeader("location", "/account/payment-methods?ok=exists");
            return res.end ? res.end() : res.send("");
          }
          if (e instanceof TypeError) return _renderPaymentMethodsPage(req, res, auth, "That card couldn't be saved — please try again.", 400);
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/payment-methods?ok=added");
        return res.end ? res.end() : res.send("");
      });

      router.post("/account/payment-methods/:id/default", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var pm = await _ownedPaymentMethod(req, res, auth); if (!pm) return;
        try { await deps.paymentMethods.setDefault(pm.id); }
        catch (e) {
          if (e instanceof TypeError || (e && typeof e.code === "string" && e.code.indexOf("PAYMENT_METHOD_") === 0)) {
            return _renderPaymentMethodsPage(req, res, auth, "Couldn't set that as your default card.", 400);
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/payment-methods?ok=default");
        return res.end ? res.end() : res.send("");
      });

      router.post("/account/payment-methods/:id/archive", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var pm = await _ownedPaymentMethod(req, res, auth); if (!pm) return;
        try { await deps.paymentMethods.archive({ payment_method_id: pm.id, reason: "customer_request" }); }
        catch (e) {
          if (e instanceof TypeError || (e && typeof e.code === "string" && e.code.indexOf("PAYMENT_METHOD_") === 0)) {
            return _renderPaymentMethodsPage(req, res, auth, "Couldn't remove that card.", 400);
          }
          throw e;
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/payment-methods?ok=archived");
        return res.end ? res.end() : res.send("");
      });
    }

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
        _clearAuthCookie(req, res);
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      await _renderProfilePage(req, res, auth, customer, null);
    });

    router.post("/account/profile", async function (req, res) {
      var auth = _accountAuth(req, res); if (!auth) return;
      var customer = await deps.customers.get(auth.customer_id);
      if (!customer) {
        _clearAuthCookie(req, res);
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
        _setAuthCookie(req, res, { customer_id: rv.customer.id, exp: Date.now() + b.constants.TIME.days(14) });
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
        _setAuthCookie(req, res, { customer_id: rv.customer.id, exp: Date.now() + b.constants.TIME.days(14) });
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
        // Owner share panel — only when the sharing primitive is wired.
        // The share-link list read is SCOPED to the session customer's id,
        // so the owner only ever sees their own links. A reads failure
        // (missing table on a fresh deploy) degrades to no panel rather
        // than 500-ing the page.
        var sharePanel = "";
        if (deps.wishlistSharing) {
          // Scoped to the session customer — the panel read keys on the
          // signed-in customer's id, so the owner only ever sees their own
          // links (this list surface carries no path id, so no IDOR).
          var sessionOwnerId = auth.customer_id;
          var ownShares = [];
          try { ownShares = await deps.wishlistSharing.listSharesForOwner(sessionOwnerId); }
          catch (_e) { ownShares = []; }
          sharePanel = _wishlistSharePanel({
            shares: ownShares,
            notice: wlUrl ? wlUrl.searchParams.get("share") : null,
          });
        }
        // Alert + digest opt-in panel — only when those primitives are
        // wired (a mailer-configured deploy). The current per-trigger
        // opt-out + per-schedule enrollment state drives each toggle's
        // checked/unchecked render. A reads failure degrades to no panel
        // rather than 500-ing the page.
        var prefsPanel = await _buildWishlistPrefsPanel(
          auth.customer_id,
          wlUrl ? wlUrl.searchParams.get("prefs") : null,
        );
        _send(res, 200, renderWishlist({
          items:        items,
          notice:       wlUrl ? wlUrl.searchParams.get("ok") : null,
          prefs_panel:  prefsPanel,
          share_panel:  sharePanel,
          shop_name:    shopName,
          cart_count:   cartCount,
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });

      // Build the alert + digest opt-in panel for a signed-in customer.
      // Reads the current per-trigger opt-out state (isUnsubscribedFrom
      // Trigger, now exported) for each scannable alert trigger, and the
      // active-enrollment state per live digest schedule. Each read is
      // best-effort: a missing table / read error drops that section
      // rather than throwing. Returns "" when neither primitive is wired.
      async function _buildWishlistPrefsPanel(customerId, notice) {
        var alerts  = [];
        var digests = [];
        if (deps.wishlistAlerts) {
          var ALERT_TRIGGERS = [
            { trigger: "price_drop",    label: "Email me when a saved item drops in price" },
            { trigger: "back_in_stock", label: "Email me when a saved item is back in stock" },
          ];
          for (var i = 0; i < ALERT_TRIGGERS.length; i += 1) {
            var t = ALERT_TRIGGERS[i];
            var unsub = true;
            try { unsub = await deps.wishlistAlerts.isUnsubscribedFromTrigger(customerId, t.trigger); }
            catch (_e) { unsub = false; }
            alerts.push({ trigger: t.trigger, label: t.label, subscribed: !unsub });
          }
        }
        if (deps.wishlistDigest) {
          var schedules = [];
          try { schedules = await deps.wishlistDigest.listSchedules({ active_only: true }); }
          catch (_e) { schedules = []; }
          var enrollments = [];
          try { enrollments = await deps.wishlistDigest.enrollmentsForCustomer(customerId); }
          catch (_e) { enrollments = []; }
          var activeBySlug = {};
          for (var k = 0; k < enrollments.length; k += 1) {
            var en = enrollments[k];
            if (en.status === "active") activeBySlug[en.schedule_slug] = en.id;
          }
          for (var s = 0; s < schedules.length; s += 1) {
            var sch = schedules[s];
            var label = (sch.frequency === "weekly" ? "Weekly" : "Monthly") +
                        " digest (" + sch.slug + ")";
            digests.push({
              slug:          sch.slug,
              label:         label,
              enrolled:      Object.prototype.hasOwnProperty.call(activeBySlug, sch.slug),
              enrollment_id: activeBySlug[sch.slug] || null,
            });
          }
        }
        return _wishlistPrefsPanel({ alerts: alerts, digests: digests, notice: notice });
      }

      // POST /account/wishlist/alerts — flip a per-trigger alert opt-out.
      // Body { trigger, on }: a falsey `on` unsubscribes (insert opt-out
      // row); a truthy `on` re-subscribes (delete the opt-out row). Gated
      // on the session customer; CSRF rides the container form chokepoint.
      if (deps.wishlistAlerts) {
        router.post("/account/wishlist/alerts", async function (req, res) {
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
          var body = req.body || {};
          var trigger = body.trigger;
          var on = body.on === "1" || body.on === "on" || body.on === true;
          try {
            if (on) {
              await deps.wishlistAlerts.resubscribeToAlertKind({ customer_id: auth.customer_id, trigger: trigger });
            } else {
              await deps.wishlistAlerts.unsubscribeFromAlertKind({ customer_id: auth.customer_id, trigger: trigger });
            }
          } catch (e) {
            res.status(e instanceof TypeError ? 400 : 500);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/wishlist?prefs=alerts");
          return res.end ? res.end() : res.send("");
        });
      }

      // POST /account/wishlist/digest — enroll / pause a digest schedule.
      // Body { schedule_slug, on }: a truthy `on` enrolls; a falsey `on`
      // pauses the active enrollment for that slug (looked up via
      // enrollmentsForCustomer). Gated on the session customer.
      if (deps.wishlistDigest) {
        router.post("/account/wishlist/digest", async function (req, res) {
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
          var body = req.body || {};
          var scheduleSlug = body.schedule_slug;
          var on = body.on === "1" || body.on === "on" || body.on === true;
          try {
            if (on) {
              await deps.wishlistDigest.enrollCustomer({ customer_id: auth.customer_id, schedule_slug: scheduleSlug });
            } else {
              // Find the active enrollment for this slug and pause it.
              var enrollments = await deps.wishlistDigest.enrollmentsForCustomer(auth.customer_id);
              var target = null;
              for (var i = 0; i < enrollments.length; i += 1) {
                if (enrollments[i].schedule_slug === scheduleSlug && enrollments[i].status === "active") {
                  target = enrollments[i]; break;
                }
              }
              if (target) {
                await deps.wishlistDigest.pauseEnrollment({ enrollment_id: target.id, reason: "customer opted out" });
              }
            }
          } catch (e) {
            res.status(e instanceof TypeError ? 400 : 500);
            return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
          }
          res.status(303); res.setHeader && res.setHeader("location", "/account/wishlist?prefs=digest");
          return res.end ? res.end() : res.send("");
        });
      }
    }

    // ---- wishlist sharing -----------------------------------------------
    //
    // Owner-scoped share links on the customer's own wishlist, plus the
    // public, no-auth shared view a giver opens. Mounts only when the
    // sharing primitive is wired (it composes the wishlist primitive, so a
    // store with sharing also has the solo wishlist above).
    //
    // Owner side (gated on the session customer, CSRF-protected by the
    // container form chokepoint): create a share link, see active links,
    // revoke a link. Every owner action is scoped to the session customer —
    // the create keys on the signed-in customer's id; the revoke loads the
    // session customer's links by their id and refuses a link that isn't
    // the session customer's (clean 404, no IDOR).
    //
    // Public side (NO auth): `GET /wishlist/shared/:token` resolves the
    // wishlist ONLY through `viewShared(token)` — never by a guessable
    // wishlist/customer id — renders the saved products (redacting the
    // owner's identity + private notes), records the view, and 404s an
    // unknown / revoked / expired token. noindex (a personal wishlist isn't
    // index material).
    if (deps.wishlistSharing) {
      // Build the owner's share panel from links scoped to the session
      // customer. `opts.fresh_url` (the one-time URL of a just-created link)
      // and `opts.notice` (created / revoked) thread through to the panel.
      // A reads failure (missing table on a fresh deploy) degrades to a
      // panel with no list rather than throwing.
      async function _buildSharePanel(customerId, opts) {
        opts = opts || {};
        var shareRows = [];
        try { shareRows = await deps.wishlistSharing.listSharesForOwner(customerId); }
        catch (_e) { shareRows = []; }
        return _wishlistSharePanel({
          shares:    shareRows,
          notice:    opts.notice || null,
          fresh_url: opts.fresh_url || null,
        });
      }

      // Re-render the /account/wishlist page (used by the create POST so the
      // one-time share URL is shown inline, and on a revoke). Resolves the
      // same saved-items list the GET route renders.
      async function _renderWishlistWithPanel(req, res, customerId, panelOpts) {
        var page = await deps.wishlist.listForCustomer(customerId, { limit: 50 });
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
        var panel = await _buildSharePanel(customerId, panelOpts || {});
        _send(res, 200, renderWishlist({
          items:        items,
          share_panel:  panel,
          shop_name:    shopName,
          cart_count:   cartCount,
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      }

      // POST /wishlist/share — mint a share link for the SESSION customer's
      // wishlist. The link is owner-scoped (keyed on `auth.customer_id`);
      // the plaintext token is returned once and surfaced inline as the
      // public URL the owner copies (never persisted). `unlisted` is the
      // default privacy: link-bearer access, no friends-graph requirement,
      // not advertised. The page re-renders directly (200) rather than a
      // redirect so the one-time URL is shown.
      router.post("/wishlist/share", async function (req, res) {
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
        var created;
        try {
          created = await deps.wishlistSharing.createShareLink({
            owner_customer_id: auth.customer_id,
            privacy:           "unlisted",
          });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        // The full public URL the giver opens. Built from this request's
        // ORIGIN (scheme + host) so the one-time link is a correct absolute
        // URL — this POST lands on /wishlist/share, so trimming a path off
        // the canonical URL would mangle the link (and the token shows once).
        var shareOrigin = "";
        try { shareOrigin = new URL(_requestUrls(req).canonical_url).origin; }
        catch (_e) { shareOrigin = ""; /* unparseable — fall back to a host-relative link */ }
        var freshUrl = shareOrigin + "/wishlist/shared/" + encodeURIComponent(created.plaintext_token);
        await _renderWishlistWithPanel(req, res, auth.customer_id, { notice: "created", fresh_url: freshUrl });
      });

      // POST /wishlist/share/:share_id/revoke — revoke one of the SESSION
      // customer's share links. The primitive's revokeShareLink moves a link
      // by id alone (no owner notion), so the route owns the ownership
      // decision: it loads the session customer's own links and refuses a
      // share_id that isn't among them (clean 404). Without that scope, any
      // signed-in shopper could revoke another customer's link by guessing
      // its id (IDOR).
      router.post("/wishlist/share/:share_id/revoke", async function (req, res) {
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
        var shareId = (req.params && req.params.share_id) || "";
        // Ownership scope: the link must belong to the session customer.
        var owned = [];
        try { owned = await deps.wishlistSharing.listSharesForOwner(auth.customer_id); }
        catch (_e) { owned = []; }
        var match = null;
        for (var i = 0; i < owned.length; i += 1) {
          if (owned[i].id === shareId) { match = owned[i]; break; }
        }
        if (!match) {
          // Unknown id, malformed id, or a link owned by someone else all
          // resolve the same way — a clean 404, no act, no leak.
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        try {
          await deps.wishlistSharing.revokeShareLink({ link_id: shareId, reason: "owner revoked from account" });
        } catch (e) {
          res.status(e instanceof TypeError ? 400 : 500);
          return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/wishlist?share=revoked");
        return res.end ? res.end() : res.send("");
      });

      // GET /wishlist/shared/:token — the public, no-auth shared view. The
      // wishlist is resolved ONLY via viewShared(token); a giver with the
      // link sees the saved products (with the owner identity + private
      // notes redacted — the renderer emits product cards only). An unknown
      // / revoked / expired token 404s exactly like an unknown route. The
      // view is recorded best-effort (analytics for the owner) and never
      // blocks the render. noindex.
      router.get("/wishlist/shared/:token", async function (req, res) {
        var token = (req.params && req.params.token) || "";
        var view = null;
        try {
          view = await deps.wishlistSharing.viewShared({ token: token });
        } catch (_e) {
          // A malformed token (TypeError) and a not-found / revoked / expired
          // token (coded errors) all render the same 404 — no oracle on why.
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        // Record the open for the owner's view counter. Best-effort: a
        // record failure never breaks the giver's page.
        try { await deps.wishlistSharing.recordView({ token: token }); }
        catch (_e) { /* drop-silent — analytics, not the render path */ }
        // Resolve each shared entry to its product + hero image. The entry's
        // owner customer_id + private notes are NOT carried into the view
        // (the renderer emits product cards only) so the giver never sees
        // the owner's identity.
        var items = [];
        var entries = (view && view.entries) || [];
        for (var i = 0; i < entries.length; i += 1) {
          var product = null;
          try { product = await deps.catalog.products.get(entries[i].product_id); } catch (_e) { product = null; }
          if (!product) continue;
          var media = await deps.catalog.media.listForProduct(product.id);
          items.push({ product: product, hero_media: media.length ? media[0] : null });
        }
        _send(res, 200, renderSharedWishlist({
          items:        items,
          title:        (view && view.share && view.share.title) || "A shared wishlist",
          shop_name:    shopName,
          cart_count:   await _cartCountForReq(req),
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });
    }

    // ---- gift registry --------------------------------------------------
    //
    // Owner side (gated on the session customer, CSRF-protected by the
    // container form chokepoint): list the customer's registries with
    // progress, create one, then a per-registry manage page (add / remove
    // items, edit details, close) plus the shareable public URL. Every owner
    // route is scoped to the session customer — a registry whose
    // `owner_customer_id` isn't the signed-in customer resolves to a clean
    // 404 (no IDOR), because the gift-registry primitive moves a registry by
    // slug alone and has no notion of the requesting customer.
    //
    // Public side (NO auth): `GET /registry/:slug` resolves the registry ONLY
    // through `getBySlug(slug)` — never a guessable owner/registry id from the
    // path or query — and the route honors the privacy gate: a `private`
    // registry (and an unknown slug) 404s identically, with no existence
    // oracle. The view renders the title / occasion /
    // event date + per-item desired-vs-purchased counts + product links, and
    // NEVER carries the owner's customer id / shipping address or any buyer
    // identity into the page (the primitive's getBySlug surfaces items +
    // aggregate counts only; the per-buyer purchase rows stay owner-internal).
    // A giver marks an item purchased (records a gift via purchaseItem,
    // anonymous by default) or adds it to their own cart to buy normally.
    // noindex (a personal registry isn't index material).
    if (deps.giftRegistry) {
      // Load a registry the SESSION customer owns, or null. The primitive's
      // getRegistry moves by slug alone, so the route owns the ownership
      // decision: a registry whose owner_customer_id isn't the session
      // customer is treated identically to a missing one (clean 404, no
      // oracle on existence). A malformed slug throws inside the primitive's
      // slug validator — caught by the caller and mapped to a 404.
      async function _ownedRegistry(slug, customerId) {
        var reg;
        try { reg = await deps.giftRegistry.getRegistry(slug); }
        catch (_e) { return null; }   // malformed slug → not found
        if (!reg || reg.owner_customer_id !== customerId) return null;
        return reg;
      }

      // Resolve a registry item's sku to its catalog product + hero image +
      // buyable variant id. Returns { product, hero_media, variant_id } —
      // any field null when the sku no longer resolves (the item still shows,
      // with no buy control). Best-effort: a catalog read failure degrades to
      // an undecorated item rather than throwing.
      async function _decorateRegistryItem(item) {
        var out = {
          item_id:    item.id,
          sku:        item.sku,
          variant_id: null,
          product:    null,
          hero_media: null,
        };
        try {
          var variant = await deps.catalog.variants.bySku(item.sku);
          if (variant) {
            out.variant_id = variant.id;
            var product = await deps.catalog.products.get(variant.product_id);
            if (product && product.status === "active") {
              out.product = product;
              var media = await deps.catalog.media.listForProduct(product.id);
              out.hero_media = media.length ? media[0] : null;
            }
          }
        } catch (_e) { /* drop-silent — an undecorated item still renders */ }
        return out;
      }

      // GET /account/registry — the session customer's registries, each with
      // its progress rollup, plus the create form.
      router.get("/account/registry", async function (req, res) {
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
        var regs = [];
        try { regs = await deps.giftRegistry.listForOwner(auth.customer_id); }
        catch (_e) { regs = []; }
        var rows = [];
        for (var i = 0; i < regs.length; i += 1) {
          var prog = null;
          try { prog = await deps.giftRegistry.progressFor(regs[i].slug); }
          catch (_e) { prog = null; }
          rows.push({ registry: regs[i], progress: prog });
        }
        var listUrl = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderRegistryList({
          rows:         rows,
          notice:       listUrl ? listUrl.searchParams.get("ok") : null,
          shop_name:    shopName,
          cart_count:   await _cartCountForReq(req),
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });

      // POST /account/registry — create a registry owned by the session
      // customer. The owner id comes from the session, never the body, so a
      // shopper can only ever create a registry under their own id.
      router.post("/account/registry", async function (req, res) {
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
        var body = req.body || {};
        // event_date arrives as a yyyy-mm-dd string from <input type=date>;
        // convert to epoch-ms (midnight UTC) or null. A malformed value
        // becomes null rather than 400-ing — the date is optional.
        var eventDate = null;
        if (typeof body.event_date === "string" && body.event_date.length) {
          var parsed = Date.parse(body.event_date + "T00:00:00Z");
          if (!isNaN(parsed)) eventDate = parsed;
        }
        try {
          await deps.giftRegistry.createRegistry({
            owner_customer_id: auth.customer_id,
            slug:              String(body.slug || ""),
            title:             String(body.title || ""),
            recipient_name:    String(body.recipient_name || ""),
            occasion:          String(body.occasion || ""),
            privacy:           String(body.privacy || ""),
            event_date:        eventDate,
          });
        } catch (e) {
          // A bad slug / title / occasion / duplicate slug is operator error
          // (TypeError) — re-render the list with the message; anything else
          // is a 500.
          if (e instanceof TypeError) {
            var regs = [];
            try { regs = await deps.giftRegistry.listForOwner(auth.customer_id); }
            catch (_e2) { regs = []; }
            var rows = [];
            for (var i = 0; i < regs.length; i += 1) rows.push({ registry: regs[i], progress: null });
            return _send(res, 400, renderRegistryList({
              rows:         rows,
              error:        (e && e.message) || "We couldn't create that registry.",
              shop_name:    shopName,
              cart_count:   await _cartCountForReq(req),
              asset_prefix: deps.asset_prefix || "/assets/",
            }));
          }
          res.status(500);
          return res.end ? res.end("Error") : res.send("Error");
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/registry/" + encodeURIComponent(String(body.slug || "")) + "?ok=created");
        return res.end ? res.end() : res.send("");
      });

      // GET /account/registry/:slug — manage one registry the session
      // customer owns. A registry the customer doesn't own (or an unknown
      // slug) 404s.
      router.get("/account/registry/:slug", async function (req, res) {
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
        var slug = (req.params && req.params.slug) || "";
        var reg = await _ownedRegistry(slug, auth.customer_id);
        if (!reg) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        // Items + their progress. getBySlug returns items with their
        // purchased-aggregate; progressFor gives the remaining count.
        var view = null;
        try { view = await deps.giftRegistry.getBySlug(slug); }
        catch (_e) { view = null; }
        var prog = null;
        try { prog = await deps.giftRegistry.progressFor(slug); }
        catch (_e) { prog = null; }
        var remainingById = Object.create(null);
        var purchasedById = Object.create(null);
        var desiredById   = Object.create(null);
        if (prog && prog.items) {
          for (var p = 0; p < prog.items.length; p += 1) {
            remainingById[prog.items[p].item_id] = prog.items[p].remaining;
            purchasedById[prog.items[p].item_id] = prog.items[p].purchased;
            desiredById[prog.items[p].item_id]   = prog.items[p].quantity_desired;
          }
        }
        var items = [];
        var rawItems = (view && view.items) || [];
        for (var i = 0; i < rawItems.length; i += 1) {
          var dec = await _decorateRegistryItem(rawItems[i]);
          dec.desired   = desiredById[rawItems[i].id] != null ? desiredById[rawItems[i].id] : rawItems[i].quantity_desired;
          dec.purchased = purchasedById[rawItems[i].id] || 0;
          dec.remaining = remainingById[rawItems[i].id] != null ? remainingById[rawItems[i].id] : dec.desired;
          items.push(dec);
        }
        // The shareable public URL — built from this request's ORIGIN (scheme
        // + host), never by trimming a path off the canonical (this GET lands
        // on /account/registry/:slug, so a trim would mangle the link).
        var shareUrl = "";
        if (reg.privacy !== "private") {
          var origin = "";
          try { origin = new URL(_requestUrls(req).canonical_url).origin; }
          catch (_e) { origin = ""; }
          shareUrl = origin + "/registry/" + encodeURIComponent(reg.slug);
        }
        var manageUrl = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderRegistryManage({
          registry:     reg,
          items:        items,
          share_url:    shareUrl,
          notice:       manageUrl ? manageUrl.searchParams.get("ok") : null,
          shop_name:    shopName,
          cart_count:   await _cartCountForReq(req),
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });

      // POST /account/registry/:slug/items — add an item to a registry the
      // session customer owns. Ownership-scoped (404 on a foreign / unknown
      // registry).
      router.post("/account/registry/:slug/items", async function (req, res) {
        var auth = _registryAuthOrRedirect(req, res);
        if (!auth) return;
        var slug = (req.params && req.params.slug) || "";
        var reg = await _ownedRegistry(slug, auth.customer_id);
        if (!reg) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        var body = req.body || {};
        var qty = parseInt(body.quantity_desired, 10);
        var priorityRaw = parseInt(body.priority, 10);
        try {
          await deps.giftRegistry.addItem({
            registry_slug:    slug,
            sku:              String(body.sku || ""),
            quantity_desired: Number.isFinite(qty) ? qty : 0,
            priority:         Number.isFinite(priorityRaw) ? priorityRaw : 3,
          });
        } catch (e) {
          return _registryManageError(req, res, reg, e);
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/registry/" + encodeURIComponent(slug) + "?ok=added");
        return res.end ? res.end() : res.send("");
      });

      // POST /account/registry/:slug/items/:item_id/remove — archive an item
      // on a registry the session customer owns.
      router.post("/account/registry/:slug/items/:item_id/remove", async function (req, res) {
        var auth = _registryAuthOrRedirect(req, res);
        if (!auth) return;
        var slug = (req.params && req.params.slug) || "";
        var reg = await _ownedRegistry(slug, auth.customer_id);
        if (!reg) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        try {
          await deps.giftRegistry.removeItem({
            registry_slug: slug,
            item_id:       (req.params && req.params.item_id) || "",
          });
        } catch (e) {
          return _registryManageError(req, res, reg, e);
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/registry/" + encodeURIComponent(slug) + "?ok=removed");
        return res.end ? res.end() : res.send("");
      });

      // POST /account/registry/:slug/edit — update registry details
      // (title / recipient_name / event_date / privacy) on a registry the
      // session customer owns.
      router.post("/account/registry/:slug/edit", async function (req, res) {
        var auth = _registryAuthOrRedirect(req, res);
        if (!auth) return;
        var slug = (req.params && req.params.slug) || "";
        var reg = await _ownedRegistry(slug, auth.customer_id);
        if (!reg) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        var body = req.body || {};
        var patch = {
          title:          String(body.title || ""),
          recipient_name: String(body.recipient_name || ""),
          privacy:        String(body.privacy || ""),
        };
        if (typeof body.event_date === "string" && body.event_date.length) {
          var parsed = Date.parse(body.event_date + "T00:00:00Z");
          patch.event_date = isNaN(parsed) ? null : parsed;
        } else {
          patch.event_date = null;
        }
        try {
          await deps.giftRegistry.update(slug, patch);
        } catch (e) {
          return _registryManageError(req, res, reg, e);
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/registry/" + encodeURIComponent(slug) + "?ok=updated");
        return res.end ? res.end() : res.send("");
      });

      // POST /account/registry/:slug/close — close a registry the session
      // customer owns (the only FSM transition; refuses further mutation).
      router.post("/account/registry/:slug/close", async function (req, res) {
        var auth = _registryAuthOrRedirect(req, res);
        if (!auth) return;
        var slug = (req.params && req.params.slug) || "";
        var reg = await _ownedRegistry(slug, auth.customer_id);
        if (!reg) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        try {
          await deps.giftRegistry.closeRegistry(slug);
        } catch (e) {
          return _registryManageError(req, res, reg, e);
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/registry/" + encodeURIComponent(slug) + "?ok=closed");
        return res.end ? res.end() : res.send("");
      });

      // GET /registry/:slug — the public, no-auth giver view. Resolves the
      // registry ONLY through getBySlug (never a guessable owner/registry id),
      // then enforces the privacy gate in the route: a `private` registry
      // 404s exactly like an unknown slug — no existence oracle. The owner's
      // identity / shipping address / per-buyer purchase rows are NEVER
      // carried into this shape. noindex.
      router.get("/registry/:slug", async function (req, res) {
        var slug = (req.params && req.params.slug) || "";
        var view = null;
        try {
          view = await deps.giftRegistry.getBySlug(slug);
        } catch (_e) {
          // A malformed slug (TypeError) renders the same 404 as an unknown
          // one — no oracle on why.
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        // Honor the privacy gate: a missing registry AND a `private` one are
        // not publicly viewable — both 404 identically (no existence oracle).
        // `private` resolves only through the owner's /account/registry surface
        // (scoped to the session customer); `unlisted` + `public` are reachable
        // by anyone who knows the slug.
        if (!view || !view.registry || view.registry.privacy === "private") {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        var prog = null;
        try { prog = await deps.giftRegistry.progressFor(slug); }
        catch (_e) { prog = null; }
        var remainingById = Object.create(null);
        var purchasedById = Object.create(null);
        var desiredById   = Object.create(null);
        if (prog && prog.items) {
          for (var p = 0; p < prog.items.length; p += 1) {
            remainingById[prog.items[p].item_id] = prog.items[p].remaining;
            purchasedById[prog.items[p].item_id] = prog.items[p].purchased;
            desiredById[prog.items[p].item_id]   = prog.items[p].quantity_desired;
          }
        }
        var items = [];
        var rawItems = view.items || [];
        for (var i = 0; i < rawItems.length; i += 1) {
          var dec = await _decorateRegistryItem(rawItems[i]);
          dec.desired   = desiredById[rawItems[i].id] != null ? desiredById[rawItems[i].id] : rawItems[i].quantity_desired;
          dec.purchased = purchasedById[rawItems[i].id] || 0;
          dec.remaining = remainingById[rawItems[i].id] != null ? remainingById[rawItems[i].id] : dec.desired;
          items.push(dec);
        }
        var pubUrl = req.url ? new URL(req.url, "http://localhost") : null;
        // Build a redacted, public-safe registry view — only the fields a
        // giver may see (title / occasion / event_date / message / privacy /
        // status). The owner_customer_id + shipping_address_id are dropped
        // here so they can NEVER reach the rendered HTML.
        var reg = view.registry;
        var publicReg = {
          slug:       reg.slug,
          title:      reg.title,
          occasion:   reg.occasion,
          event_date: reg.event_date,
          message:    reg.message,
          privacy:    reg.privacy,
          status:     reg.status,
        };
        _send(res, 200, renderRegistryPublic({
          registry:     publicReg,
          items:        items,
          notice:       pubUrl ? pubUrl.searchParams.get("ok") : null,
          shop_name:    shopName,
          cart_count:   await _cartCountForReq(req),
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      });

      // POST /registry/:slug/items/:item_id/purchase — a giver records a gift
      // (marks the item purchased). This is the mark-purchased / record-a-gift
      // action the primitive's purchaseItem implements: it decrements the
      // remaining-needed qty and tracks who bought it (anonymous by default).
      // It carries NO payment — a giver who wants to actually buy the item
      // adds it to their cart (the per-item "Add to cart" form posts to
      // /cart/lines) and pays through the regular Stripe-gated checkout. A
      // dedicated registry-funds settlement (charge the giver, route the money
      // to the owner) is intentionally not wired: the normal cart/checkout path
      // already lets a giver buy a registry item end-to-end, so it only lands
      // if an operator needs registry-scoped fulfillment (ship-to-owner +
      // gift-message capture) the standard order flow doesn't cover. The action
      // is slug+item gated to the registry, NOT customer-scoped (a giver need
      // not be logged in); it is shape-safe — a closed registry, an
      // over-purchase, an unknown item, or a malformed slug all resolve to a
      // clean redirect
      // / 404, never a 500.
      router.post("/registry/:slug/items/:item_id/purchase", async function (req, res) {
        var slug = (req.params && req.params.slug) || "";
        var itemId = (req.params && req.params.item_id) || "";
        // Resolve through getBySlug so a private / unknown registry is never
        // purchasable (the same privacy gate the GET view uses) — a giver can
        // only act on a registry they could legitimately reach by link.
        var view = null;
        try { view = await deps.giftRegistry.getBySlug(slug); }
        catch (_e) { view = null; }
        // Same privacy gate as the GET view — a private (or unknown) registry
        // is never publicly purchasable.
        if (!view || !view.registry || view.registry.privacy === "private") {
          return _send(res, 404, renderNotFound({ shop_name: shopName, cart_count: await _cartCountForReq(req) }));
        }
        var body = req.body || {};
        var qty = parseInt(body.quantity, 10);
        if (!Number.isFinite(qty) || qty < 1) qty = 1;
        // `reveal` requires a signed-in giver — an anonymous reveal makes no
        // sense (there's no identity to surface). When the box is ticked and
        // the giver is logged in, attribute the gift to them; otherwise the
        // purchase is anonymous.
        var reveal = (body.reveal === "1" || body.reveal === "on" || body.reveal === true);
        var buyerId = null;
        if (reveal) {
          var giverAuth = null;
          try { giverAuth = _currentCustomer(req); } catch (_e) { giverAuth = null; }
          if (giverAuth && giverAuth.customer_id) buyerId = giverAuth.customer_id;
          else reveal = false;   // not signed in → fall back to anonymous
        }
        var purchaseInput = {
          registry_slug: slug,
          item_id:       itemId,
          quantity:      qty,
          reveal_buyer:  reveal,
        };
        if (buyerId) purchaseInput.buyer_customer_id = buyerId;
        try {
          await deps.giftRegistry.purchaseItem(purchaseInput);
        } catch (_e) {
          // A closed registry, an over-purchase, an archived / unknown item,
          // or a malformed slug/item id are all giver-recoverable: bounce
          // back to the public registry page (no item landed) rather than
          // 500. A truly unexpected error (non-TypeError, uncoded) still
          // surfaces as a redirect — the page re-render shows current state.
          res.status(303);
          res.setHeader && res.setHeader("location", "/registry/" + encodeURIComponent(slug));
          return res.end ? res.end() : res.send("");
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/registry/" + encodeURIComponent(slug) + "?ok=gifted");
        return res.end ? res.end() : res.send("");
      });

      // Shared owner-route auth gate: resolve the session customer or send the
      // redirect / 503 and return null. Mirrors the wishlist `_savedAuth`
      // shape so every owner registry write funnels through one check.
      function _registryAuthOrRedirect(req, res) {
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

      // Re-render the manage page with an inline error after a refused owner
      // mutation (a bad sku, a duplicate item, a closed-registry write). A
      // TypeError / coded over-purchase is operator-recoverable → 400 with the
      // message; anything else is a 500.
      async function _registryManageError(req, res, reg, e) {
        var status = (e instanceof TypeError || (e && e.code === "GIFT_REGISTRY_OVER_PURCHASE")) ? 400 : 500;
        // Reload current items so the error page shows live state.
        var items = [];
        try {
          var view = await deps.giftRegistry.getBySlug(reg.slug);
          var prog = await deps.giftRegistry.progressFor(reg.slug);
          var remById = Object.create(null), purById = Object.create(null), desById = Object.create(null);
          if (prog && prog.items) {
            for (var p = 0; p < prog.items.length; p += 1) {
              remById[prog.items[p].item_id] = prog.items[p].remaining;
              purById[prog.items[p].item_id] = prog.items[p].purchased;
              desById[prog.items[p].item_id] = prog.items[p].quantity_desired;
            }
          }
          var rawItems = (view && view.items) || [];
          for (var i = 0; i < rawItems.length; i += 1) {
            var dec = await _decorateRegistryItem(rawItems[i]);
            dec.desired   = desById[rawItems[i].id] != null ? desById[rawItems[i].id] : rawItems[i].quantity_desired;
            dec.purchased = purById[rawItems[i].id] || 0;
            dec.remaining = remById[rawItems[i].id] != null ? remById[rawItems[i].id] : dec.desired;
            items.push(dec);
          }
        } catch (_e) { items = []; }
        return _send(res, status, renderRegistryManage({
          registry:     reg,
          items:        items,
          error:        status === 400 ? ((e && e.message) || "We couldn't make that change.") : "Something went wrong. Please try again.",
          shop_name:    shopName,
          cart_count:   await _cartCountForReq(req),
          asset_prefix: deps.asset_prefix || "/assets/",
        }));
      }
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
      async function _renderAddrPage(req, res, auth, editAddr, notice, code, invalidField) {
        var rows = await deps.addresses.listForCustomer(auth.customer_id, { limit: 50 });
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var okKind = url ? url.searchParams.get("ok") : null;
        var success = _addrSuccessCopy(okKind);
        // An Undo control is only offered for a just-removed row, and only
        // when the ?undo=<id> marker round-trips a real owned address id.
        var undoId = (okKind === "removed" && url) ? url.searchParams.get("undo") : null;
        _send(res, code || 200, renderAddresses({
          addresses:     rows,
          edit:          editAddr || null,
          notice:        notice || null,
          success:       success,
          undo_id:       undoId || null,
          invalid_field: invalidField || null,
          shop_name:     shopName,
          cart_count:    cartCount,
        }));
      }
      // The address form's renderable fields, by `name`. An error on a
      // non-form internal (customer_id, address_id) returns null from the
      // shared extractor, so the page-top banner still shows but no input is
      // falsely marked.
      var _ADDR_FORM_FIELDS = {
        recipient_name: 1, label: 1, company: 1, street_line1: 1, street_line2: 1,
        city: 1, region: 1, postal_code: 1, country: 1, phone: 1,
      };
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
          if (e instanceof TypeError) {
            var inv = _fieldFromValidatorError(e, "addresses", _ADDR_FORM_FIELDS);
            return _renderAddrPage(req, res, auth, null, (e && e.message) || "Please check the address.", 400, inv);
          }
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
            var inv = _fieldFromValidatorError(e, "addresses", _ADDR_FORM_FIELDS);
            return _renderAddrPage(req, res, auth, merged, (e && e.message) || "Please check the address.", 400, inv);
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
      // Lifecycle controls (pause / resume / skip / change-qty / change-
      // freq / reactivate) mount only when the subscriptionControls
      // primitive is wired. Independent of Stripe — the controls write
      // local columns on the subscription row, not the upstream billing
      // state — so they're available even on a deploy with no payment
      // handle. The list above stays a read-only view when this is absent.
      var subControls = deps.subscriptionControls || null;

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
        // Success copy comes from either the legacy ?canceled=1 marker or
        // a self-manage ?ok=<kind> round-trip; an ?error message a control
        // POST bounces back surfaces as an alert. Unknown ?ok keys → no
        // notice (a forged query can't inject copy).
        var okKind = url ? url.searchParams.get("ok") : null;
        var notice = canceled
          ? "Your subscription has been canceled."
          : _subscriptionOkCopy(okKind);
        var errKind = url ? url.searchParams.get("error") : null;
        _send(res, 200, renderAccountSubscriptions({
          subscriptions: rows,
          can_cancel:    subsCanCancel,
          self_manage:   !!subControls,
          notice:        notice,
          error:         _subscriptionErrorCopy(errKind),
          shop_name:     shopName,
          cart_count:    cartCount,
        }));
      });

      // Self-manage lifecycle — pause / resume / skip / change-quantity /
      // change-frequency / reactivate. Each route owns its subscription
      // via the same ownership check the cancel flow uses (a forged/foreign
      // id 404s before any write), then composes the matching control
      // method with a `customer` actor. State-machine refusals from the
      // primitive (e.g. pause a cancelled sub) and shape errors bounce back
      // to the list with a fixed ?error code rather than 500-ing. Wired
      // independently of Stripe (the controls write local columns).
      if (subControls) {
        var SELF_ACTOR = { actor_type: "customer", actor_id: null };

        // Translate a control-method rejection into the list redirect.
        // Validation TypeErrors and FSM/grace refusals (which carry a
        // `code`) map to a fixed ?error; anything else rethrows (a real
        // 500, e.g. an unmigrated table on a misconfigured deploy).
        function _controlError(e) {
          if (e && e.code === "SUBSCRIPTION_REACTIVATE_GRACE_EXPIRED") return "grace";
          if (e && e.code === "SUBSCRIPTION_STATE_REFUSED")            return "state";
          if (e && e.code === "SUBSCRIPTION_NOT_FOUND")                return "state";
          if (e instanceof TypeError)                                   return "state";
          return null;
        }
        function _redirect(res, suffix) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/account/subscriptions" + suffix);
          return res.end ? res.end() : res.send("");
        }

        // Pause is confirm-gated (GET → POST), mirroring cancel — a
        // deliberate, reversible hold. The confirm page only renders for a
        // currently-active subscription; a paused/cancelled row bounces
        // back to the list.
        router.get("/account/subscriptions/:id/pause", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          if (_subscriptionControlState(sub) !== "active") return _redirect(res, "");
          if (sub.plan_id != null) {
            try { sub.plan = await subscriptions.plans.get(sub.plan_id); }
            catch (_e) { sub.plan = null; }
          }
          var cartCount = await _cartCountForReq(req);
          _send(res, 200, renderSubscriptionPauseConfirm({
            subscription: sub,
            shop_name:    shopName,
            cart_count:   cartCount,
          }));
        });

        router.post("/account/subscriptions/:id/pause", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          try {
            await subControls.pause({ subscription_id: sub.id, reason: "customer self-service pause", actor: SELF_ACTOR });
          } catch (e) {
            var code = _controlError(e); if (code == null) throw e;
            return _redirect(res, "?error=" + code);
          }
          return _redirect(res, "?ok=paused");
        });

        router.post("/account/subscriptions/:id/resume", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          try {
            await subControls.resume({ subscription_id: sub.id, reason: "customer self-service resume", actor: SELF_ACTOR });
          } catch (e) {
            var code = _controlError(e); if (code == null) throw e;
            return _redirect(res, "?error=" + code);
          }
          return _redirect(res, "?ok=resumed");
        });

        router.post("/account/subscriptions/:id/skip", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          try {
            await subControls.skipNext({ subscription_id: sub.id, count: 1, reason: "customer self-service skip", actor: SELF_ACTOR });
          } catch (e) {
            var code = _controlError(e); if (code == null) throw e;
            return _redirect(res, "?error=" + code);
          }
          return _redirect(res, "?ok=skipped");
        });

        router.post("/account/subscriptions/:id/quantity", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          // Backend validates: a non-positive / non-integer / missing value
          // is a client error → bounce with the quantity error code rather
          // than handing garbage to the primitive (which would throw a
          // TypeError mapped to a generic "state" message).
          var qty = parseInt(String((req.body || {}).quantity), 10);
          if (!Number.isInteger(qty) || qty <= 0) return _redirect(res, "?error=quantity");
          try {
            await subControls.changeQuantity({ subscription_id: sub.id, new_quantity: qty, reason: "customer self-service quantity change", actor: SELF_ACTOR });
          } catch (e) {
            if (e instanceof TypeError) return _redirect(res, "?error=quantity");
            var code = _controlError(e); if (code == null) throw e;
            return _redirect(res, "?error=" + code);
          }
          return _redirect(res, "?ok=quantity");
        });

        router.post("/account/subscriptions/:id/frequency", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          // Backend validates: reject anything outside the allowed cadence
          // enum before composing the primitive.
          var freq = String((req.body || {}).frequency || "");
          if (SUB_FREQUENCIES.indexOf(freq) === -1) return _redirect(res, "?error=frequency");
          try {
            await subControls.changeFrequency({ subscription_id: sub.id, new_frequency: freq, reason: "customer self-service frequency change", actor: SELF_ACTOR });
          } catch (e) {
            if (e instanceof TypeError) return _redirect(res, "?error=frequency");
            var code = _controlError(e); if (code == null) throw e;
            return _redirect(res, "?error=" + code);
          }
          return _redirect(res, "?ok=frequency");
        });

        router.post("/account/subscriptions/:id/reactivate", async function (req, res) {
          var auth = _subsAuth(req, res); if (!auth) return;
          var sub = await _ownedSubscription(req, res, auth); if (!sub) return;
          try {
            await subControls.reactivate({ subscription_id: sub.id, reason: "customer self-service reactivate", actor: SELF_ACTOR });
          } catch (e) {
            var code = _controlError(e); if (code == null) throw e;
            return _redirect(res, "?error=" + code);
          }
          return _redirect(res, "?ok=reactivated");
        });
      }

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

    // Pre-order reservations — the PDP reserve POST + the customer's
    // /account/preorders surface (list + cancel). A reservation is INTENT, not
    // a charge: reserve() writes a row pinned to the SIGNED-IN SESSION
    // customer (never a body/query id) + decrements the campaign's capacity;
    // the launch flow later converts it into a regular (Stripe-gated) order.
    // Mounts only when the preorder primitive is wired.
    if (preorder) {
      function _preorderAuth(req, res) {
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

      // Defensive request-shape reader for the reserve form's quantity. A
      // missing / non-numeric / non-positive value defaults to 1 so a no-JS
      // submit still reserves a unit; the primitive is authoritative on the
      // cap (it refuses an over-cap quantity), and a >99 paste clamps to 99 to
      // match the form's max attribute.
      function _preorderQty(raw) {
        var n = parseInt(String(raw == null ? "" : raw), 10);
        if (!Number.isFinite(n) || n <= 0) return 1;
        return n > 99 ? 99 : n;
      }

      // POST /products/:slug/preorder — reserve a unit of the lead SKU's OPEN
      // campaign. Auth-gated; the reservation is pinned to the session
      // customer (auth.customer_id), NEVER a body/query id. The campaign is
      // resolved from the product's lead SKU (not a client-supplied slug), so
      // a shopper can only reserve against the campaign the PDP actually
      // shows. Over-cap / closed / missing campaign → a clean 4xx PRG back to
      // the PDP with a fixed ?preorder error code (no raw error text).
      router.post("/products/:slug/preorder", async function (req, res) {
        var auth = _preorderAuth(req, res); if (!auth) return;
        var slug = req.params && req.params.slug;
        var enc = encodeURIComponent(slug || "");
        var product = slug ? await deps.catalog.products.bySlug(slug) : null;
        if (!product) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        var variants = await deps.catalog.variants.listForProduct(product.id);
        var lead = variants[0] || null;
        // No lead variant, or no OPEN campaign for it → there's nothing
        // reservable here; bounce to the PDP with the closed marker.
        var campaign = null;
        if (lead) {
          try { campaign = await preorder.openCampaignForSku(lead.sku); }
          catch (_e) { campaign = null; }
        }
        if (!campaign) {
          res.status(303); res.setHeader && res.setHeader("location", "/products/" + enc + "?preorder=closed");
          return res.end ? res.end() : res.send("");
        }
        var qty = _preorderQty((req.body || {}).qty);
        try {
          await preorder.reserve({
            campaign_slug: campaign.slug,
            customer_id:   auth.customer_id,
            quantity:      qty,
          });
        } catch (e) {
          // A capacity / closed-campaign / shape refusal is the customer's
          // problem to see, not a 500 — map every TypeError to a fixed
          // ?preorder error marker (the reason copy is rendered on the PDP,
          // never the raw message). Anything else rethrows (a real 500).
          if (!(e instanceof TypeError)) throw e;
          res.status(303); res.setHeader && res.setHeader("location", "/products/" + enc + "?preorder=unavailable");
          return res.end ? res.end() : res.send("");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/products/" + enc + "?preorder=reserved");
        return res.end ? res.end() : res.send("");
      });

      // Load the reservation named in :id and confirm it belongs to the
      // signed-in customer. A malformed id (guardUuid TypeError), a missing
      // row, or another customer's reservation all return 404 after sending
      // it — never a 500, never a cross-customer cancel. The reservation
      // primitive cancels by id alone, so the route owns the ownership
      // decision.
      async function _ownedReservation(req, res, auth) {
        var resv;
        try { resv = await preorder.getReservation(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!resv || resv.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return resv;
      }

      // The customer's reservations, decorated with each campaign's status +
      // release date so the list reads "Operator Tee — ships 2026-09-01 —
      // active". Campaigns are batched: one getCampaign per distinct slug,
      // cached across rows. A read failure (table not migrated) degrades to an
      // empty list rather than 500-ing the account page.
      async function _preordersForCustomer(customerId) {
        var rows;
        try { rows = await preorder.reservationsForCustomer(customerId); }
        catch (e) {
          if (e instanceof TypeError) return [];
          throw e;
        }
        var campaignCache = {};
        for (var i = 0; i < rows.length; i += 1) {
          var cslug = rows[i].campaign_slug;
          if (cslug != null && !Object.prototype.hasOwnProperty.call(campaignCache, cslug)) {
            try { campaignCache[cslug] = await preorder.getCampaign(cslug); }
            catch (_e) { campaignCache[cslug] = null; }
          }
          rows[i].campaign = cslug != null ? campaignCache[cslug] : null;
        }
        return rows;
      }

      router.get("/account/preorders", async function (req, res) {
        var auth = _preorderAuth(req, res); if (!auth) return;
        var rows = await _preordersForCustomer(auth.customer_id);
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var okKind = url ? url.searchParams.get("ok") : null;
        var notice = okKind === "canceled" ? "Your pre-order reservation has been canceled." : null;
        _send(res, 200, renderAccountPreorders({
          reservations: rows,
          notice:       notice,
          shop_name:    shopName,
          cart_count:   cartCount,
        }));
      });

      // POST /account/preorders/:id/cancel — cancel the customer's own active
      // reservation, freeing the held capacity. Ownership-scoped: a malformed
      // / unknown / foreign reservation id 404s before any write. A
      // non-active reservation (already converted / cancelled) is a clean PRG
      // back to the list, not a 500.
      router.post("/account/preorders/:id/cancel", async function (req, res) {
        var auth = _preorderAuth(req, res); if (!auth) return;
        var resv = await _ownedReservation(req, res, auth); if (!resv) return;
        try {
          await preorder.cancelReservation({ reservation_id: resv.id, reason: "customer-cancelled" });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          // Already converted/cancelled → nothing to do; bounce back clean.
          res.status(303); res.setHeader && res.setHeader("location", "/account/preorders");
          return res.end ? res.end() : res.send("");
        }
        res.status(303); res.setHeader && res.setHeader("location", "/account/preorders?ok=canceled");
        return res.end ? res.end() : res.send("");
      });
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

      // Load the return named in :id and confirm it belongs to the
      // signed-in customer. The return_authorizations row carries
      // `customer_id` directly, so ownership is a single comparison — no
      // transitive lookup. A malformed id (guardUuid TypeError), an unknown
      // return, or someone else's return ALL return 404 — never a 500,
      // never a cross-customer reveal. This is the gate the return detail
      // view + the label-download route funnel through, so a return label /
      // its tracking is never reachable by a return/label id alone.
      async function _ownedReturn(req, res, auth) {
        var rma;
        try { rma = await deps.returns.get(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!rma || rma.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return rma;
      }

      // The most-recent issued label for an owned return (or null). Returns
      // null when the label primitive isn't wired or no label has been
      // issued — the detail view renders the neutral "no label yet" state.
      // Best-effort on a read failure (tables not migrated) so the return
      // detail never 500s on a missing label table.
      async function _labelForReturn(returnId) {
        if (!deps.returnLabels) return null;
        try { return await deps.returnLabels.labelForReturn(returnId); }
        catch (e) { if (e instanceof TypeError) return null; throw e; }
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

      // One return's status detail, including its return-shipping label and
      // carrier-scan timeline once a label has been issued. Ownership-scoped
      // through _ownedReturn (foreign / unknown / malformed id → 404). A
      // return with no issued label renders a neutral "no label yet" state.
      router.get("/account/returns/:id", async function (req, res) {
        var auth = _returnsAuth(req, res); if (!auth) return;
        var rma = await _ownedReturn(req, res, auth); if (!rma) return;
        var label = await _labelForReturn(rma.id);
        var events = [];
        if (label && deps.returnLabels) {
          try { events = await deps.returnLabels.eventsForLabel(label.id); }
          catch (e) { if (!(e instanceof TypeError)) throw e; events = []; }
        }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderReturnDetail({
          rma:        rma,
          label:      label,
          events:     events,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      // Download / print the return label. Ownership-scoped: load + verify
      // the return belongs to the session customer (via _ownedReturn — a
      // foreign / unknown / malformed return id all 404 identically) BEFORE
      // resolving its label, then redirect to the carrier label asset. The
      // label_url is resolved server-side through the owning return, never
      // exposed by a bare label id, and a return with no issued label 404s
      // (there is nothing to download yet). Mounts only when the label
      // primitive is wired.
      if (deps.returnLabels) {
        router.get("/account/returns/:id/label", async function (req, res) {
          var auth = _returnsAuth(req, res); if (!auth) return;
          var rma = await _ownedReturn(req, res, auth); if (!rma) return;
          var label = await _labelForReturn(rma.id);
          if (!label || !label.label_url) {
            _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
            return;
          }
          // The carrier label asset is an already-validated HTTPS URL
          // (return-labels runs label_url through b.safeUrl on issue), so a
          // redirect can't smuggle a javascript:/credentialed target. The
          // shopper reaches the printable label through the scoped route,
          // never the raw URL by id.
          res.status(302);
          res.setHeader && res.setHeader("location", label.label_url);
          res.setHeader && res.setHeader("cache-control", "private, no-store");
          return res.end ? res.end() : res.send("");
        });
      }

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

    // Self-serve exchanges — a customer requests a same-value item SWAP
    // (different size / colour / unit) against one of their own orders and
    // tracks its status; operators action it via the admin /admin/exchanges
    // queue. Distinct from returns (which end in a refund): an exchange
    // ships the original back AND a replacement out, no money refunded.
    //
    // Ownership / IDOR: an order_exchanges row carries `order_id` but NOT
    // `customer_id` — the customer→order linkage lives on the order. So
    // every per-exchange / per-order route here loads the parent order and
    // refuses (clean 404) unless `order.customer_id === auth.customer_id`,
    // exactly like the returns + support gates. The exchange primitive
    // moves a row by id alone, so the route owns the ownership decision.
    if (deps.orderExchanges && deps.order) {
      function _exchangeAuth(req, res) {
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
      // signed-in customer. A malformed id (guardUuid TypeError), a missing
      // order, or someone else's order all return 404 — never a 500, never
      // a leak. This is the ownership gate the request form + POST funnel
      // through.
      async function _ownedOrderForExchange(req, res, auth) {
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

      // Load the exchange named in :id, then load its parent order and
      // confirm THAT order belongs to the signed-in customer. The exchange
      // row has no customer_id, so ownership is asserted transitively
      // through the order. A malformed id (TypeError), an unknown exchange,
      // an exchange whose order is gone, or an exchange owned by someone
      // else ALL return 404 — never a 500, never a cross-customer reveal.
      async function _ownedExchange(req, res, auth) {
        var exchange;
        try { exchange = await deps.orderExchanges.getExchange(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!exchange) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
        var order;
        try { order = await deps.order.get(exchange.order_id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!order || order.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return exchange;
      }

      // Resolve the sibling variants a line's product can be swapped to:
      // every active variant of the same product, labelled by its option
      // values (falling back to the SKU). Best-effort — absent the catalog
      // handle (or a read failure) the line offers a same-SKU swap.
      async function _replacementOptions(line) {
        if (!deps.catalog || !line || !line.variant_id) return [];
        try {
          var v = await deps.catalog.variants.get(line.variant_id);
          if (!v) return [];
          var siblings = await deps.catalog.variants.listForProduct(v.product_id);
          return (siblings || []).map(function (s) {
            var optLabel = s.options
              ? Object.keys(s.options).map(function (k) { return s.options[k]; }).join(" / ")
              : "";
            var label = (optLabel ? optLabel + " — " : "") + s.sku;
            return { id: s.id, sku: s.sku, label: label };
          });
        } catch (_e) { return []; }
      }

      // The customer's own exchange list, scoped to their orders. The
      // primitive resolves the customer→order linkage through the injected
      // order handle, so a foreign order's exchange never appears here.
      router.get("/account/exchanges", async function (req, res) {
        var auth = _exchangeAuth(req, res); if (!auth) return;
        var exchanges = [];
        try { exchanges = await deps.orderExchanges.exchangesForCustomer(auth.customer_id, { limit: 100 }); }
        catch (e) { if (!(e instanceof TypeError)) throw e; exchanges = []; }
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderExchanges({
          exchanges:  exchanges,
          requested:  url && url.searchParams.get("ok") === "1",
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      // One exchange's status detail. Ownership-scoped through the parent
      // order (foreign / unknown → 404).
      router.get("/account/exchanges/:id", async function (req, res) {
        var auth = _exchangeAuth(req, res); if (!auth) return;
        var exchange = await _ownedExchange(req, res, auth); if (!exchange) return;
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderExchangeDetail({ exchange: exchange, shop_name: shopName, cart_count: cartCount }));
      });

      // The exchange-request form for one of the customer's own orders,
      // gated on the same eligibility window as a return.
      router.get("/account/orders/:order_id/exchange", async function (req, res) {
        var auth = _exchangeAuth(req, res); if (!auth) return;
        var order = await _ownedOrderForExchange(req, res, auth); if (!order) return;
        var cartCount = await _cartCountForReq(req);
        if (!_orderEligibleForExchange(order.status)) {
          return _send(res, 400, renderExchangeForm({
            order: order, lines: [], notice: "This order isn't eligible for an exchange.",
            shop_name: shopName, cart_count: cartCount,
          }));
        }
        var lines = [];
        var orderLines = order.lines || [];
        for (var i = 0; i < orderLines.length; i += 1) {
          var ol = orderLines[i];
          lines.push(Object.assign({}, ol, { replacement_options: await _replacementOptions(ol) }));
        }
        _send(res, 200, renderExchangeForm({ order: order, lines: lines, shop_name: shopName, cart_count: cartCount }));
      });

      router.post("/account/orders/:order_id/exchange", async function (req, res) {
        var auth = _exchangeAuth(req, res); if (!auth) return;
        var order = await _ownedOrderForExchange(req, res, auth); if (!order) return;
        var body = req.body || {};
        var cartCount = await _cartCountForReq(req);

        // Re-decorate the lines so a failed POST re-renders the same form
        // (with the replacement pickers intact) rather than a bare page.
        async function _decoratedLines() {
          var out = [];
          var ols = order.lines || [];
          for (var i = 0; i < ols.length; i += 1) {
            out.push(Object.assign({}, ols[i], { replacement_options: await _replacementOptions(ols[i]) }));
          }
          return out;
        }
        function _badForm(notice, status) {
          return _decoratedLines().then(function (lines) {
            return _send(res, status || 400, renderExchangeForm({
              order: order, lines: lines, notice: notice,
              shop_name: shopName, cart_count: cartCount,
            }));
          });
        }

        if (!_orderEligibleForExchange(order.status)) {
          return _badForm("This order isn't eligible for an exchange.");
        }

        // Resolve the picked line from the order's OWN lines (authoritative
        // sku/qty) — never trust a client-supplied sku. The radio carries
        // the order_line id.
        var orderLines = order.lines || [];
        var picked = null;
        for (var i = 0; i < orderLines.length; i += 1) {
          if (orderLines[i].id === body.line_id) { picked = orderLines[i]; break; }
        }
        if (!picked) return _badForm("Pick the item you'd like to exchange.");

        var wantedQty = parseInt(body["qty_" + picked.id], 10);
        var maxQty = Number(picked.qty) || 1;
        var qty = Number.isFinite(wantedQty) && wantedQty >= 1 && wantedQty <= maxQty ? wantedQty : maxQty;

        // The replacement variant: the chosen sibling variant of the same
        // product. The select carries the variant id; resolve it back to a
        // sku through the catalog (never trust a client sku). Absent a
        // selection (a same-SKU swap — replace a defective unit) the
        // replacement defaults to the line's own sku/variant.
        var replacementSku = picked.sku;
        var replacementVariantId = picked.variant_id;
        var chosen = body["replacement_" + picked.id];
        if (chosen && deps.catalog) {
          // The replacement MUST be one of the sibling variants offered for
          // the purchased line's product. Validate the chosen id against the
          // same option set the form was built from (_replacementOptions) —
          // resolving it through a bare variants.get would accept ANY catalog
          // variant, letting a forged replacement_<id> swap a cheap item for
          // any variant in the catalog. The option carries the catalog-
          // resolved sku/id, so a client sku is never trusted.
          var options = await _replacementOptions(picked);
          var match = null;
          for (var oi = 0; oi < options.length; oi += 1) {
            if (options[oi].id === chosen) { match = options[oi]; break; }
          }
          if (!match) return _badForm("That replacement variant isn't available — pick another.");
          replacementSku = match.sku;
          replacementVariantId = match.id;
        }

        try {
          await deps.orderExchanges.requestExchange({
            order_id:               order.id,
            line_id:                picked.id,
            return_sku:             picked.sku,
            return_qty:             qty,
            replacement_sku:        replacementSku,
            replacement_variant_id: replacementVariantId,
            replacement_qty:        qty,
            reason:                 body.reason,
          });
        } catch (e) {
          if (e instanceof TypeError) {
            return _badForm((e && e.message || "").replace(/^order-exchanges[.:]\s*/, "") || "Please check your exchange request.");
          }
          throw e;
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/exchanges?ok=1");
        return res.end ? res.end() : res.send("");
      });
    }

    // Click-and-collect — the signed-in customer's pickup list. Scoped via
    // the primitive's customerSchedules, which resolves the customer→order
    // linkage through the shared order handle, so a foreign order's pickup
    // never appears here (the IDOR defense is the order-scoping). Mounts only
    // when the primitive is wired.
    if (deps.clickAndCollect) {
      router.get("/account/pickups", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var schedules = [];
        try { schedules = await deps.clickAndCollect.customerSchedules(auth.customer_id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; schedules = []; }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderAccountPickups({
          pickups:    schedules,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });
    }

    // Support tickets — the signed-in customer raises a ticket, lists
    // their own, reads a thread, and replies. EVERY route is login-gated
    // AND scoped to the session customer's id: the support primitive
    // stores `customer_id` on each ticket, so a ticket whose customer_id
    // doesn't match the signed-in shopper is a 404 (never a cross-customer
    // reveal — the IDOR defense). The raw email is never on disk, so the
    // intake form collects a reply-to address (the backend validates +
    // hashes it); the list / view / reply paths key on the session
    // customer_id alone, independent of any email.
    if (deps.supportTickets) {
      var support = deps.supportTickets;

      function _supportAuth(req, res) {
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

      // Load the ticket named in :id and confirm it belongs to the
      // signed-in customer. A malformed id (guardUuid TypeError from
      // support.get), a missing ticket, or a ticket owned by someone else
      // ALL return 404 — never a 500, never a leak of another customer's
      // ticket. This single helper is the ownership gate every per-ticket
      // route funnels through.
      async function _ownedTicket(req, res, auth) {
        var ticket;
        try { ticket = await support.get(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return null; }
          throw e;
        }
        if (!ticket || ticket.customer_id !== auth.customer_id) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return null;
        }
        return ticket;
      }

      // The customer's own ticket list, scoped to their session customer_id.
      router.get("/account/support", async function (req, res) {
        var auth = _supportAuth(req, res); if (!auth) return;
        var tickets = await support.listByCustomerId(auth.customer_id, { limit: 100 });
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderSupportList({
          tickets:    tickets,
          created:    url && url.searchParams.get("ok") === "1",
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      // The new-ticket form. Offers the customer's recent orders as an
      // optional attachment.
      router.get("/account/support/new", async function (req, res) {
        var auth = _supportAuth(req, res); if (!auth) return;
        var orders = [];
        if (deps.order) {
          try {
            var page = await deps.order.listForCustomer(auth.customer_id, { limit: 20 });
            orders = page.rows;
          } catch (_e) { orders = []; }
        }
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderSupportNew({
          orders:     orders,
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      // Create the ticket as the session customer. customer_id is pinned
      // to the session — never read off the form — so a shopper can only
      // ever open a ticket against their own account. An optional order_id
      // is accepted only after confirming the order belongs to this
      // customer (so a forged id can't attach a stranger's order); a
      // non-owned / unknown order is dropped silently rather than failing
      // the ticket. The backend validates subject / body / category /
      // email shape and surfaces a TypeError on bad input as a clean
      // re-render, never a 500.
      router.post("/account/support", async function (req, res) {
        var auth = _supportAuth(req, res); if (!auth) return;
        var body = req.body || {};
        var cartCount = await _cartCountForReq(req);

        async function _orders() {
          if (!deps.order) return [];
          try { return (await deps.order.listForCustomer(auth.customer_id, { limit: 20 })).rows; }
          catch (_e) { return []; }
        }

        // Only attach an order the requesting customer actually owns.
        var orderId;
        if (body.order_id && deps.order) {
          try {
            var ord = await deps.order.get(body.order_id);
            if (ord && ord.customer_id === auth.customer_id) orderId = ord.id;
          } catch (_e) { /* malformed / unknown order id — attach nothing */ }
        }

        var opened;
        try {
          opened = await support.open({
            customer_id:    auth.customer_id,
            customer_email: body.customer_email,
            subject:        body.subject,
            body:           body.body,
            category:       body.category,
            order_id:       orderId,
          });
        } catch (e) {
          if (e instanceof TypeError) {
            return _send(res, 400, renderSupportNew({
              orders:        await _orders(),
              values:        body,
              notice:        (e && e.message || "").replace(/^supportTickets[.:]\s*/, "") || "Please check your ticket and try again.",
              invalid_field: _fieldFromValidatorError(e, "supportTickets", { customer_email: 1, category: 1, subject: 1, body: 1 }),
              shop_name:     shopName,
              cart_count:    cartCount,
            }));
          }
          throw e;
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/support/" + encodeURIComponent(opened.id) + "?ok=1");
        return res.end ? res.end() : res.send("");
      });

      // One ticket's thread. Ownership-scoped (foreign / unknown → 404).
      // Internal operator notes are filtered out before render — the
      // customer never sees an internal=1 message.
      router.get("/account/support/:id", async function (req, res) {
        var auth = _supportAuth(req, res); if (!auth) return;
        var ticket = await _ownedTicket(req, res, auth); if (!ticket) return;
        var thread = await support.thread(ticket.id);
        var visible = (thread.messages || []).filter(function (m) { return Number(m.internal) !== 1; });
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderSupportTicket({
          ticket:     thread.ticket,
          messages:   visible,
          replied:    url && url.searchParams.get("ok") === "1",
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      // Append a customer reply. Ownership-scoped; refused on a closed
      // ticket (the backend rejects a closed-ticket reply with a typed
      // SUPPORT_TICKET_CLOSED error — surfaced as a 409 re-render, never a
      // 500). author is pinned to "customer".
      router.post("/account/support/:id/reply", async function (req, res) {
        var auth = _supportAuth(req, res); if (!auth) return;
        var ticket = await _ownedTicket(req, res, auth); if (!ticket) return;
        var body = req.body || {};
        var cartCount = await _cartCountForReq(req);

        // A closed ticket can't take a reply — short-circuit to a
        // re-render with a notice rather than calling the backend (which
        // would also refuse, but this keeps the message customer-readable).
        if (ticket.status === "closed") {
          var closedThread = await support.thread(ticket.id);
          return _send(res, 409, renderSupportTicket({
            ticket:     closedThread.ticket,
            messages:   (closedThread.messages || []).filter(function (m) { return Number(m.internal) !== 1; }),
            notice:     "This ticket is closed — raise a new one if you still need help.",
            shop_name:  shopName,
            cart_count: cartCount,
          }));
        }

        try {
          await support.reply({
            ticket_id: ticket.id,
            author:    "customer",
            author_id: auth.customer_id,
            body:      body.body,
          });
        } catch (e) {
          if (e instanceof TypeError || (e && e.code === "SUPPORT_TICKET_CLOSED")) {
            var againThread = await support.thread(ticket.id);
            var status = (e && e.code === "SUPPORT_TICKET_CLOSED") ? 409 : 400;
            return _send(res, status, renderSupportTicket({
              ticket:     againThread.ticket,
              messages:   (againThread.messages || []).filter(function (m) { return Number(m.internal) !== 1; }),
              notice:     (e && e.message || "").replace(/^supportTickets[.:]\s*/, "") || "Please check your reply and try again.",
              shop_name:  shopName,
              cart_count: cartCount,
            }));
          }
          throw e;
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/support/" + encodeURIComponent(ticket.id) + "?ok=1");
        return res.end ? res.end() : res.send("");
      });
    }

    // Privacy & data — the signed-in customer's self-service DSR surface.
    // Filing an export or deletion request pins customer_id to the SESSION
    // (never the form); requested_by is the fixed "customer-self-service"
    // string (the session env carries no email — _currentCustomerEnv returns
    // { customer_id, exp } only — and the primitive requires a non-empty
    // requested_by). Self-service FILES the request; an operator reviews +
    // executes it from /admin/dsr (PD-3). The export download is
    // ownership-scoped (a stranger → 404) and streams the bundle.
    if (deps.complianceExport && deps.customers) {
      var dsr         = deps.complianceExport;
      var dsrReaders  = deps.complianceExportReaders || {};
      var dsrSections = deps.complianceExportSections || {};
      var streamDsr   = deps.streamDsrBundle;

      router.get("/account/privacy", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var history = [];
        try { history = await dsr.auditForCustomer(auth.customer_id); } catch (_e) { history = []; }
        var cartCount = await _cartCountForReq(req);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _send(res, 200, renderAccountPrivacy({
          history:    history,
          ok:         url && url.searchParams.get("ok"),
          shop_name:  shopName,
          cart_count: cartCount,
        }));
      });

      // File a data-export request. customer_id is pinned to the session.
      // A bad enum (jurisdiction / scope) throws TypeError → a 400 re-render
      // with a notice, never a 500. No row is created on a bad enum (the
      // primitive validates before INSERT).
      router.post("/account/privacy/export", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var body = req.body || {};
        try {
          await dsr.requestExport({
            customer_id:  auth.customer_id,
            requested_by: "customer-self-service",
            jurisdiction: body.jurisdiction,
            scope:        body.scope,
          });
        } catch (e) {
          if (e instanceof TypeError) {
            var history = [];
            try { history = await dsr.auditForCustomer(auth.customer_id); } catch (_e2) { history = []; }
            var cc = await _cartCountForReq(req);
            return _send(res, 400, renderAccountPrivacy({
              history:    history,
              notice:     "Please choose a valid law and scope and try again.",
              shop_name:  shopName,
              cart_count: cc,
            }));
          }
          throw e;
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/privacy?ok=export");
        return res.end ? res.end() : res.send("");
      });

      router.get("/account/delete", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var cartCount = await _cartCountForReq(req);
        _send(res, 200, renderAccountDelete({ shop_name: shopName, cart_count: cartCount }));
      });

      // File a deletion request. customer_id is pinned to the session; this
      // FILES the request (status received) — it does NOT execute the erasure
      // (the operator reviews identity + runs processDeletion from the admin
      // queue). A bad enum / empty reason throws TypeError → a 400 re-render.
      router.post("/account/delete", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var body = req.body || {};
        try {
          await dsr.requestDeletion({
            customer_id:  auth.customer_id,
            requested_by: "customer-self-service",
            jurisdiction: body.jurisdiction,
            reason:       body.reason,
          });
        } catch (e) {
          if (e instanceof TypeError) {
            var cc = await _cartCountForReq(req);
            return _send(res, 400, renderAccountDelete({
              values:     body,
              notice:     "Please choose a valid law and give a reason, then try again.",
              shop_name:  shopName,
              cart_count: cc,
            }));
          }
          throw e;
        }
        res.status(303);
        res.setHeader && res.setHeader("location", "/account/privacy?ok=deletion");
        return res.end ? res.end() : res.send("");
      });

      // Ownership-scoped streaming export download. Resolve the row, verify
      // it belongs to THIS session customer (IDOR gate — a stranger / unknown
      // / malformed id → 404, never another customer's bundle), confirm it's
      // a fulfilled/delivered export, then stream. Status + ownership are
      // validated BEFORE the first write (the bundle streams header-first).
      router.get("/account/privacy/:id/export.json", async function (req, res) {
        var auth = _accountAuth(req, res); if (!auth) return;
        var row;
        try { row = await dsr.getRequest(req.params && req.params.id); }
        catch (e) {
          if (e instanceof TypeError) { _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme })); return; }
          throw e;
        }
        if (!row || row.customer_id !== auth.customer_id ||
            row.request_kind !== "export" ||
            (row.status !== "fulfilled" && row.status !== "delivered")) {
          _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
          return;
        }
        var sections = dsrSections[row.scope] || dsrSections.full || [];
        await streamDsr(res, dsrReaders, sections, row);
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

    // Store-credit wallet — the signed-in customer's READ-ONLY view of
    // their account-bound store credit. One surface:
    //   * GET /account/credit — the current balance, an expiring-soon
    //     callout, and the credit/debit/expire ledger (paginated). A
    //     browser gets the server-rendered page; an API client (Accept:
    //     application/json) gets the balance + ledger payload.
    //
    // SESSION-SCOPED, no IDOR surface: the route reads the customer id
    // from the signed-in session (`auth.customer_id`) and passes ONLY
    // that id to storeCredit.balance / .history / .expiringWithin. There
    // is no `:id` path param and the route never reads a customer id from
    // the query string or body, so a signed-in shopper can only ever see
    // their OWN wallet. Granting / deducting credit is operator-only on
    // the admin customer-detail screen — this surface writes nothing.
    if (deps.storeCredit) {
      function _storeCreditAuth(req, res) {
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

      // Build the /account/credit render context for the SESSION
      // customer. `opts2.cursor` is the optional history-page cursor
      // (epoch-ms). The expiring-soon read is best-effort so an
      // unmigrated table or a read error degrades that callout rather
      // than the page; balance + history are the core reads.
      async function _storeCreditView(req, auth, opts2) {
        opts2 = opts2 || {};
        var bal  = await deps.storeCredit.balance(auth.customer_id);
        var hist = await deps.storeCredit.history({
          customer_id: auth.customer_id,
          limit:       20,
          cursor:      opts2.cursor,
        });
        var expiring = [];
        try {
          expiring = await deps.storeCredit.expiringWithin({
            customer_id: auth.customer_id,
            days:        30,
          });
        } catch (_e) { expiring = []; }
        var cartCount = await _cartCountForReq(req);
        return {
          balance_minor:       bal.balance_minor,
          history:             hist.rows,
          history_next_cursor: hist.next_cursor,
          expiring:            expiring,
          shop_name:           shopName,
          cart_count:          cartCount,
        };
      }

      router.get("/account/credit", async function (req, res) {
        var auth = _storeCreditAuth(req, res); if (!auth) return;
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var cursorRaw = url && url.searchParams.get("cursor");
        var cursor;
        if (cursorRaw != null && cursorRaw !== "") {
          var n = parseInt(cursorRaw, 10);
          // A malformed cursor degrades to the first page (the lib would
          // TypeError on a non-integer) — never 500 the page.
          cursor = Number.isFinite(n) && n >= 0 ? n : undefined;
        }
        var view = await _storeCreditView(req, auth, { cursor: cursor });
        // Content negotiation: an API client (Accept: application/json)
        // gets the balance + ledger payload; a browser gets the rendered
        // wallet page. Both read the SAME session customer id.
        var accept = (req.headers && (req.headers.accept || req.headers.Accept)) || "";
        if (/\bapplication\/json\b/.test(String(accept))) {
          res.status(200);
          res.setHeader && res.setHeader("content-type", "application/json; charset=utf-8");
          var payload = JSON.stringify({
            balance_minor:       view.balance_minor,
            currency:            "USD",
            expiring:            view.expiring,
            ledger:              view.history,
            history_next_cursor: view.history_next_cursor,
          });
          return res.end ? res.end(payload) : res.send(payload);
        }
        _send(res, 200, renderAccountStoreCredit(view));
      });
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
              product:       { title: ctx.product.title, slug: ctx.product.slug },
              notice:        (e && e.message) || "Please check your review and try again.",
              invalid_field: _fieldFromValidatorError(e, "reviews", { rating: 1, title: 1, body: 1 }),
              shop_name:     shopName,
              cart_count:    ctx.cartCount,
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
              product:       { title: ctx.product.title, slug: ctx.product.slug },
              notice:        (e && e.message) || "Please check your question and try again.",
              invalid_field: _fieldFromValidatorError(e, "productQA", { body: 1 }),
              shop_name:     shopName,
              cart_count:    ctx.cartCount,
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

  // POST /orders/:id/reorder — rebuild a cart from a past order's frozen
  // lines. Top-level (needs only cart + order, not checkout) so the Reorder
  // affordance on the dashboard / order-history list works even on a store
  // without a payment provider configured. Login is NOT required — a guest
  // order's capability URL is the auth, mirroring the order page's own
  // ownership gate: an order that BELONGS to a customer is reorderable only
  // by that signed-in customer; a guest order (no customer_id) is
  // reorderable by anyone holding its URL. Each line's CURRENT catalog
  // price applies (cart.addLine reprices from the catalog) — never the
  // frozen historical price. Variants that no longer exist / are unbuyable
  // are skipped silently so a partly-discontinued order still reorders
  // what's still available. Eligibility gates out a never-paid pending
  // order (no captured purchase to repeat).
  if (deps.order) {
    router.post("/orders/:order_id/reorder", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      var o;
      try { o = orderId ? await deps.order.get(orderId) : null; }
      catch (e) { if (e instanceof TypeError) { o = null; } else throw e; }
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var reAuth = _currentCustomerEnv(req);
      if (o.customer_id && (!reAuth || o.customer_id !== reAuth.customer_id)) {
        return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      }
      if (!_orderEligibleForReorder(o.status)) {
        // A still-pending (never-paid) order has no captured purchase to
        // repeat — bounce back to its page rather than rebuild a cart from
        // an unpaid order.
        res.status(303);
        res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id));
        return res.end ? res.end() : res.send("");
      }
      var resolved = await _getOrCreateCart(req, res, o.currency || "USD");
      var lines = o.lines || [];
      for (var rli = 0; rli < lines.length; rli += 1) {
        var line = lines[rli];
        var wantQty = Number.isInteger(line.qty) && line.qty >= 1 ? line.qty : 1;
        if (wantQty > 99) wantQty = 99;
        try {
          await deps.cart.addLine(resolved.cart.id, { variant_id: line.variant_id, qty: wantQty });
        } catch (_e) {
          // Skip a discontinued / unbuyable / out-of-stock variant rather
          // than fail the whole reorder — the customer still gets a cart of
          // everything that's still available.
        }
      }
      // Back to the order page with a confirmation banner + a cart link
      // (PRG so a refresh doesn't re-add the lines).
      res.status(303);
      res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id) + "?reordered=1");
      return res.end ? res.end() : res.send("");
    });

    // POST /orders/:id/cancel — customer-initiated cancellation of an
    // order that hasn't been fulfilled yet. The order FSM (lib/order.js)
    // accepts the `cancel` event from `pending` and `paid` only; this
    // route gates on the same eligibility (_orderEligibleForCancel) so a
    // shipped / delivered / already-cancelled / refunded order can't be
    // cancelled here. Two refusals guard against IDOR: the order must
    // belong to the signed-in customer (a foreign or guest-owned order is
    // a clean 404, never acted on and never leaked), and only then is the
    // transition attempted. A cancel the FSM still refuses (a status that
    // raced past `paid` between the page render and the POST) maps to a
    // clean redirect back to the order rather than a 500. Cancelling a
    // `paid` order moves the status only — the captured charge is NOT
    // auto-voided by the transition, so the refund remains the operator's
    // action from the console.
    router.post("/orders/:order_id/cancel", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      // Cancel is a logged-in-customer action — resolve the session first
      // so an unauthenticated POST goes to login, never near the order.
      var cancelAuth = _currentCustomerEnv(req);
      if (!cancelAuth) {
        res.status(303); res.setHeader && res.setHeader("location", "/account/login");
        return res.end ? res.end() : res.send("");
      }
      var o;
      try { o = orderId ? await deps.order.get(orderId) : null; }
      catch (e) { if (e instanceof TypeError) { o = null; } else throw e; }
      // Ownership gate against IDOR: a missing order, a malformed id, an
      // order owned by another customer, OR a guest order with no owner
      // all 404 — the cancel never touches an order the caller doesn't own.
      if (!o || !o.customer_id || o.customer_id !== cancelAuth.customer_id) {
        return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      }
      // Eligibility gate mirrors the FSM's cancel edges (pending | paid).
      // A non-cancellable status (fulfilling / shipped / delivered /
      // cancelled / refunded) bounces back to the order page unchanged —
      // a clean 303, no transition attempted, no 500.
      if (!_orderEligibleForCancel(o.status)) {
        res.status(303);
        res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id));
        return res.end ? res.end() : res.send("");
      }
      try {
        await deps.order.transition(o.id, "cancel", { reason: "customer-requested" });
      } catch (e) {
        // The FSM refuses the event (a status that advanced out of the
        // cancellable window between render and POST). order.transition
        // tags the refusal with .code = ORDER_TRANSITION_REFUSED; surface
        // it as a clean redirect to the order page rather than a 500.
        if (e && e.code === "ORDER_TRANSITION_REFUSED") {
          res.status(303);
          res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id));
          return res.end ? res.end() : res.send("");
        }
        throw e;
      }
      // PRG back to the order page with a confirmation banner (a refresh
      // doesn't re-fire the cancel).
      res.status(303);
      res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id) + "?cancelled=1");
      return res.end ? res.end() : res.send("");
    });

    // POST /orders/:id/rate — a customer rates one of their OWN orders
    // (shipping / packaging / recommend, plus an optional comment). The
    // rating's customer_id is pinned to the SESSION customer — never a
    // form/query field — and the order_id is verified to belong to that
    // session before submitRating runs. Two refusals guard against IDOR: an
    // unauthenticated POST goes to login (never near an order), and a
    // foreign / guest-owned / unknown / malformed order is a clean 404
    // (never rated, never leaked). Bad input (rating out of [1,5], over-
    // length comment) and a duplicate submission map to a clean correction
    // redirect, never a 500 or a raw-error leak. Mounts only when the
    // ratings primitive is wired.
    if (deps.orderRatings) {
      router.post("/orders/:order_id/rate", async function (req, res) {
        var orderId = req.params && req.params.order_id;
        // Rating is a logged-in-customer action — resolve the session first
        // so an unauthenticated POST goes to login, never near the order.
        var rateAuth = _currentCustomerEnv(req);
        if (!rateAuth) {
          res.status(303); res.setHeader && res.setHeader("location", "/account/login");
          return res.end ? res.end() : res.send("");
        }
        var o;
        try { o = orderId ? await deps.order.get(orderId) : null; }
        catch (e) { if (e instanceof TypeError) { o = null; } else throw e; }
        // Ownership gate against IDOR: a missing order, a malformed id, an
        // order owned by another customer, OR a guest order with no owner
        // all 404 — the rating never touches an order the caller doesn't own.
        if (!o || !o.customer_id || o.customer_id !== rateAuth.customer_id) {
          return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
        }
        // Eligibility gate mirrors the rating window (paid → delivered). A
        // pending / cancelled / refunded order bounces back unchanged.
        if (!_orderEligibleForRating(o.status)) {
          res.status(303);
          res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id));
          return res.end ? res.end() : res.send("");
        }
        var body = req.body || {};
        // Defensive request-shape readers: the rating axes arrive as form
        // strings — coerce to integers so the primitive's strict [1,5]
        // integer validator sees a number (a blank / garbage field becomes
        // NaN, which the primitive refuses as a clean TypeError → "value").
        function _scoreField(raw) {
          // Whole-string integer only. parseInt would silently accept a
          // crafted "5abc" (→5) or "1.9" (→1) and persist a value the
          // shopper never chose; require the entire field to be digits so
          // anything else becomes NaN, which the primitive's strict [1,5]
          // validator refuses as a clean "value" correction.
          var s = String(raw == null ? "" : raw).trim();
          if (!/^-?\d+$/.test(s)) return NaN;
          var n = Number(s);
          return Number.isInteger(n) ? n : NaN;
        }
        function _rateRedirect(code) {
          res.status(303);
          res.setHeader && res.setHeader("location",
            "/orders/" + encodeURIComponent(o.id) + (code ? "?rate_err=" + code : ""));
          return res.end ? res.end() : res.send("");
        }
        var comment = typeof body.comment === "string" && body.comment.length ? body.comment : undefined;
        try {
          await deps.orderRatings.submitRating({
            order_id:         o.id,
            customer_id:      rateAuth.customer_id,   // session-pinned, never from the form
            shipping_rating:  _scoreField(body.shipping_rating),
            packaging_rating: _scoreField(body.packaging_rating),
            recommend_rating: _scoreField(body.recommend_rating),
            comment:          comment,
          });
        } catch (e) {
          // Coded errors first (a plain Error with .code), then the
          // primitive's TypeErrors — so a duplicate surfaces its own notice
          // rather than the generic bad-input one. Any of these is a clean
          // correction redirect, never a 500.
          if (e && e.code === "ORDER_RATING_ALREADY_EXISTS") return _rateRedirect("dupe");
          if (e instanceof TypeError) {
            // The comment validator's message names "comment"; everything
            // else is a rating-value problem. Either way, no raw leak.
            var isComment = /comment/.test(String(e.message || ""));
            return _rateRedirect(isComment ? "comment" : "value");
          }
          throw e;
        }
        // PRG back to the order page — the submitted rating now renders in
        // place of the form (a refresh doesn't re-submit).
        res.status(303);
        res.setHeader && res.setHeader("location", "/orders/" + encodeURIComponent(o.id));
        return res.end ? res.end() : res.send("");
      });
    }
  }

  // POST /cart/lines — add a line. Reads variant_id + qty from the
  // form body (b.middleware.bodyParser parses it into req.body).
  // Cross-site forgery of this state-changing POST is refused by the
  // app-level fetch-metadata gate (Sec-Fetch-Site) plus the SameSite
  // session cookie; both are wired in server.js via
  // lib/security-middleware. Redirects to /cart on success so a
  // refresh doesn't re-submit the form.
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

  // POST /cart/gift — set (or clear) the cart's gift wrap. The wrap rides as
  // a REAL cart line so its fee flows through pricing.totals and is charged
  // by checkout.confirm (NEVER a post-commit hook — that would mis-charge).
  // Selecting "No gift wrap" removes any wrap line. Selecting a wrap removes
  // any prior wrap line then adds the chosen one (qty 1, capped by
  // max_per_order). The message / recipient are collected at checkout (they
  // need the order id). Mounts only when the gift-options primitive is wired.
  if (deps.giftOptions) {
    router.post("/cart/gift", async function (req, res) {
      var body = req.body || {};
      var wrapSku = typeof body.wrap_sku === "string" ? body.wrap_sku.trim() : "";
      var resolved = await _getOrCreateCart(req, res, "USD");
      var cartId = resolved.cart.id;
      try {
        // Resolve the active wrap catalog so we know every wrap sku (to
        // remove a stale wrap line) and the selected wrap's cap.
        var wraps = await deps.giftOptions.listWraps({ active_only: true });
        var wrapBySku = {};
        for (var i = 0; i < wraps.length; i += 1) wrapBySku[wraps[i].wrap_sku] = wraps[i];
        // Remove any existing wrap line first (every active wrap's sku).
        var existingLines = await deps.cart.listLines(cartId);
        for (var li = 0; li < existingLines.length; li += 1) {
          if (wrapBySku[existingLines[li].sku]) {
            await deps.cart.removeLine(existingLines[li].id, cartId);
          }
        }
        // Add the selected wrap (when one was chosen + it's a real active
        // wrap). The wrap_sku is a real catalog variant; resolve its variant
        // id and add it as a line — the price snapshot comes from the catalog
        // price, so the fee is charged through the normal quote path.
        if (wrapSku && wrapBySku[wrapSku]) {
          var variant = await deps.catalog.variants.bySku(wrapSku);
          if (variant) {
            await deps.cart.addLine(cartId, { variant_id: variant.id, qty: 1 });
          }
        }
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        // A bad shape degrades to a silent no-op redirect rather than 500 —
        // the cart is still valid, the wrap just wasn't changed.
      }
      res.status(303);
      res.setHeader && res.setHeader("location", "/cart");
      return res.end ? res.end() : res.send("");
    });
  }

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
          // Exact BigInt floor — bundleTotal and list_line are integer
          // minor units; their product can exceed 2^53 on a large
          // bundle, so a JS float multiply would drift. BigInt division
          // truncates toward zero (floor for these non-negative values).
          ? Number((BigInt(bundleTotal) * BigInt(mem.list_line)) / BigInt(listTotal))
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
    // Resolve the requester's own session cart and scope the mutation
    // to it (same pattern as POST /cart/lines/:line_id/save). The line
    // id is rendered in every visitor's own cart HTML, so without this
    // a caller who learns another visitor's line id could change its
    // qty. A line that isn't in the caller's cart returns null → 404.
    var sid  = _readSidCookie(req);
    var cart = sid ? await deps.cart.bySession(sid) : null;
    if (!cart) {
      res.status(404);
      return res.end ? res.end("Line not found") : res.send("Line not found");
    }
    try {
      var updated = await deps.cart.updateLine(lineId, cart.id, { qty: qty });
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
    // Scope the delete to the requester's own session cart (same as the
    // update route) so a known-but-foreign line id can't delete another
    // visitor's line. No session cart → nothing of the caller's to
    // remove; redirect to /cart as the no-op success path.
    var sid  = _readSidCookie(req);
    var cart = sid ? await deps.cart.bySession(sid) : null;
    if (!cart) {
      res.status(303);
      res.setHeader && res.setHeader("location", "/cart");
      return res.end ? res.end() : res.send("");
    }
    try {
      await deps.cart.removeLine(lineId, cart.id);
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

    // Newsletter unsubscribe (CAN-SPAM one-click / RFC 8058).
    //
    // GET /unsubscribe?token=… renders a friendly confirm page; the
    // visitor clicks "Unsubscribe", which POSTs the token back. POST
    // /unsubscribe is also the List-Unsubscribe-Post one-click target a
    // mail client fires directly. The opaque, single-use, timing-safe
    // token is the bearer — no session, no auth — so the route is
    // CSRF-exempt (see EDGE_POST_PATHS) and reads each structured outcome
    // `consumeUnsubscribeToken` returns onto a clean server-rendered page.
    // The token is never echoed back beyond the confirm form's hidden
    // field; the outcome page reveals nothing about whether a token
    // existed, was already used, or expired beyond its own friendly copy.

    // Map a `consumeUnsubscribeToken` result code onto the outcome the
    // result page renders. The structured codes are stable; an unknown
    // code degrades to the generic "not valid" page rather than a 500.
    function _unsubscribeOutcome(result) {
      if (result && result.ok === true) return "unsubscribed";
      var code = result && result.error;
      if (code === "already-consumed") return "already";
      if (code === "expired")          return "expired";
      return "not-found";   // "not-found" + anything unexpected
    }

    router.get("/unsubscribe", async function (req, res) {
      var token = (req.query && typeof req.query.token === "string") ? req.query.token : "";
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      return _send(res, 200, renderUnsubscribeConfirm({
        shop_name:  shopName,
        cart_count: cartCount,
        token:      token,
      }));
    });

    router.post("/unsubscribe", async function (req, res) {
      var body = req.body || {};
      var token = typeof body.token === "string" ? body.token : "";
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      var outcome;
      try {
        // `consumeUnsubscribeToken` returns a structured result (it does
        // not throw on a bad/missing token — it returns `{ ok:false,
        // error:"not-found" }`). An empty token is handled the same way.
        var result = await deps.newsletter.consumeUnsubscribeToken(token);
        outcome = _unsubscribeOutcome(result);
      } catch (e) {
        // A real infrastructure fault (D1 unreachable) — record it server-
        // side and render the generic non-leaking page rather than a 500
        // that exposes internals on a public, unauthenticated route.
        _log.error("storefront unsubscribe failed", {
          route:      "/unsubscribe",
          request_id: (req && req.requestId) || null,
          err:        (e && e.message) || String(e),
        });
        outcome = "not-found";
      }
      return _send(res, 200, renderUnsubscribeResult({
        shop_name:  shopName,
        cart_count: cartCount,
        outcome:    outcome,
      }));
    });
  }

  // ---- back-in-stock "Notify me" ------------------------------------------
  //
  // The PDP buy box shows a "Notify me when back in stock" form on every
  // sold-out SKU (dual-rendered, edge-cache-safe). It posts to the distinct
  // CSRF-exempt action /stock-alert/subscribe (in EDGE_POST_PATHS). Double
  // opt-in: subscribe writes a pending row + returns a one-time plaintext
  // token, the confirmation email carries /stock-alert/confirm/<token>, and
  // the Worker cron sweep emails once when stock returns. Mount only when the
  // stockAlerts primitive is wired.
  if (deps.stockAlerts) {
    // Confirm-link base — SHOP_ORIGIN when present (set into sfDeps as
    // shop_origin in server.js), else the request Host (the email is best-
    // effort anyway; a relative path still resolves in a browser).
    function _stockAlertOrigin(req) {
      if (typeof deps.shop_origin === "string" && deps.shop_origin) {
        return deps.shop_origin.replace(/\/$/, "");
      }
      var host = req && req.headers && req.headers.host;
      return host ? "https://" + host : "";
    }

    router.post("/stock-alert/subscribe", async function (req, res) {
      var body = req.body || {};
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      try {
        var result = await deps.stockAlerts.subscribe({
          email:      body.email,
          sku:        body.sku,
          variant_id: (body.variant_id != null && body.variant_id !== "") ? body.variant_id : null,
        });
        // Only a brand-new subscription carries a plaintext token. Send the
        // confirmation email best-effort; a mailer hiccup must not 500 the
        // form (the row is already written). already-pending / already-
        // confirmed render the SAME thank-you copy — never reveal prior state.
        if (result && result.status === "subscribed" && result.confirmation_token && deps.email) {
          var origin = _stockAlertOrigin(req);
          var confirmUrl = origin + "/stock-alert/confirm/" + encodeURIComponent(result.confirmation_token);
          // One-click unsubscribe link — the per-row bearer token IS the
          // authorization (no email/sku tuple in the URL to guess).
          var unsubscribeUrl = origin + "/stock-alert/unsubscribe?token=" + encodeURIComponent(result.unsubscribe_token);
          // Resolve the product title for the SKU (cheap indexed read; drop-
          // silent → fall back to the SKU as the title).
          var titleForSku = body.sku;
          try {
            if (deps.catalog && deps.catalog.products && typeof deps.catalog.products.bySku === "function") {
              var prodForSku = await deps.catalog.products.bySku(body.sku);
              if (prodForSku && prodForSku.title) titleForSku = prodForSku.title;
            }
          } catch (_e) { /* drop-silent — fall back to the SKU as the title */ }
          try {
            await deps.email.sendStockAlertConfirmation({
              to:              body.email,
              product_title:   titleForSku,
              sku:             body.sku,
              confirm_url:     confirmUrl,
              unsubscribe_url: unsubscribeUrl,
            });
          } catch (_mailErr) { /* drop-silent — the row is written; the cron still fires on confirm */ }
        }
        return _send(res, 200, renderStockAlertThanks({ shop_name: shopName, cart_count: cartCount }));
      } catch (e) {
        // TypeError == operator/customer-fault input refusal (bad email / sku
        // shape) → 400 friendly page; everything else (D1 unreachable) → 500
        // non-leaking page.
        var isInputError = e instanceof TypeError;
        return _send(res, isInputError ? 400 : 500, renderStockAlertError({
          shop_name:  shopName,
          cart_count: cartCount,
          message:    isInputError ? "That doesn't look like a valid email address. Check the format and try again." : null,
        }));
      }
    });

    router.get("/stock-alert/confirm/:token", async function (req, res) {
      var token = req.params && req.params.token;
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      var outcome;
      try {
        var row = await deps.stockAlerts.confirm({ token: token });
        if (!row) outcome = "invalid";
        else if (row.notified_at != null) outcome = "already-notified";
        else outcome = "confirmed";
      } catch (e) {
        // A bad-shape token throws TypeError — render the generic non-leaking
        // "invalid" page rather than a 500 on a public, unauthenticated route.
        if (e instanceof TypeError) outcome = "invalid";
        else {
          _log.error("storefront stock-alert confirm failed", {
            route: "/stock-alert/confirm", request_id: (req && req.requestId) || null,
            err: (e && e.message) || String(e),
          });
          outcome = "invalid";
        }
      }
      return _send(res, 200, renderStockAlertConfirm({
        shop_name: shopName, cart_count: cartCount, outcome: outcome,
      }));
    });

    // Unsubscribe — by the opaque, single-purpose bearer token carried in
    // the email's `?token=` link (the same shape as the newsletter
    // one-click unsubscribe). The token IS the authorization, so knowing a
    // victim's email + a SKU is no longer enough to cancel their alert.
    // GET renders a friendly confirm page (no link-prefetcher unsubscribe);
    // POST validates the token and deletes the row. The route is CSRF-exempt
    // (EDGE_POST_PATHS) — the token is the bearer, there's no session.
    router.get("/stock-alert/unsubscribe", async function (req, res) {
      var q = (req.query && typeof req.query === "object") ? req.query : {};
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      return _send(res, 200, renderStockAlertUnsubscribeConfirm({
        shop_name:  shopName,
        cart_count: cartCount,
        token:      typeof q.token === "string" ? q.token : "",
      }));
    });

    router.post("/stock-alert/unsubscribe", async function (req, res) {
      var body = req.body || {};
      var token = typeof body.token === "string" ? body.token : "";
      var cartCount = 0;
      try { cartCount = await _cartCountForReq(req); } catch (_e) { /* drop-silent — empty cart fallback */ }
      var outcome;
      try {
        // `unsubscribeByToken` never throws on a token argument and returns
        // a uniform `{ removed }` for valid / unknown / bad-shape tokens —
        // no subscription-existence oracle. Every outcome renders the same
        // "you're unsubscribed" copy (re-clicking the link twice is fine).
        await deps.stockAlerts.unsubscribeByToken(token);
        outcome = "unsubscribed";
      } catch (e) {
        // Only a real infrastructure fault (D1 unreachable) lands here —
        // record it and render the generic non-leaking page rather than a
        // 500 that exposes internals on a public, unauthenticated route.
        outcome = "invalid";
        _log.error("storefront stock-alert unsubscribe failed", {
          route: "/stock-alert/unsubscribe", request_id: (req && req.requestId) || null,
          err: (e && e.message) || String(e),
        });
      }
      return _send(res, 200, renderStockAlertUnsubscribeResult({
        shop_name: shopName, cart_count: cartCount, outcome: outcome,
      }));
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
  // primitive is wired. Cross-site forgery of this POST is refused by the
  // app-level fetch-metadata gate (Sec-Fetch-Site) plus the SameSite
  // session cookie (both wired in server.js via lib/security-middleware)
  // — no per-route re-check.

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
      _setSidCookie(req, res, sid);
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
  // point at the sitemap. When the operator has defined per-bot rules
  // via robotsConfig, those drive the body instead; absent any rules
  // the hardcoded Disallow set is kept (robotsConfig's empty-table
  // branch emits `Allow: /` only, which would silently drop the
  // /admin disallow on a fresh deploy). Operators with stricter
  // requirements also replace the file at the same path via R2 (the
  // Worker's static-asset bridge serves it ahead of this route if a
  // `robots.txt` key exists in the bucket).
  router.get("/robots.txt", async function (req, res) {
    res.status(200);
    res.setHeader && res.setHeader("content-type", "text/plain; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=3600");
    var hostHeader = req.headers && (req.headers.host || req.headers.Host) || "";
    var origin = hostHeader ? ("https://" + hostHeader) : "";
    // The shipped fallback — the same Disallow set the edge robots.txt
    // emits, kept as the fresh-deploy default.
    var fallback =
      "User-agent: *\n" +
      "Allow: /\n" +
      "Disallow: /admin\n" +
      "Disallow: /cart\n" +
      "Disallow: /checkout\n" +
      "Disallow: /pay/\n" +
      "Disallow: /orders/\n" +
      "Disallow: /account\n" +
      (origin ? ("Sitemap: " + origin + "/sitemap.xml\n") : "");
    var body = fallback;
    // robotsConfig.render THROWS on a bad origin (no Host header) / bad
    // state; the route must never let that reach the response. Only honor
    // the operator's config when it actually carries rules — an empty
    // robots_rules table renders `Allow: /` only, weaker than the
    // hardcoded Disallow set. A read/render failure degrades to the
    // shipped fallback (drop-to-default), never a 500.
    if (deps.robotsConfig && origin) {
      try {
        var rules = await deps.robotsConfig.listRules({});
        if (Array.isArray(rules) && rules.length > 0) {
          body = await deps.robotsConfig.render({ origin_url: origin });
        }
      } catch (_e) { body = fallback; }
    }
    res.end ? res.end(body) : res.send(body);
  });

  // PWA web app manifest — served at /manifest.webmanifest (the
  // `<link rel="manifest">` every layout carries). When the operator has an
  // active pwaManifest row, its bytes serve; absent one (or on any read /
  // render failure — renderManifestJson THROWS PWA_NO_ACTIVE_MANIFEST when
  // no row is active) the shipped default serves (drop-to-default), so the
  // manifest link never 404s. The default bytes are byte-identical to the
  // edge's, so a cached edge read and a container read agree.
  router.get("/manifest.webmanifest", async function (req, res) {
    var body = PWA_DEFAULT_MANIFEST;
    if (deps.pwaManifest && typeof deps.pwaManifest.renderManifestJson === "function") {
      try { body = await deps.pwaManifest.renderManifestJson(); }
      catch (_e) { body = PWA_DEFAULT_MANIFEST; }
    }
    res.status(200);
    res.setHeader && res.setHeader("content-type", "application/manifest+json; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=3600");
    res.end ? res.end(body) : res.send(body);
  });

  // PWA service worker — served at /sw.js. Same drop-to-default discipline
  // as the manifest: the operator's active SW config serves when present,
  // else the shipped pass-through default (renderServiceWorkerJs THROWS
  // PWA_NO_ACTIVE_SW when none is active). Served same-origin under the
  // strict `script-src 'self'` CSP, so no CSP change is needed.
  router.get("/sw.js", async function (req, res) {
    var body = PWA_DEFAULT_SW;
    if (deps.pwaManifest && typeof deps.pwaManifest.renderServiceWorkerJs === "function") {
      try { body = await deps.pwaManifest.renderServiceWorkerJs(); }
      catch (_e) { body = PWA_DEFAULT_SW; }
    }
    res.status(200);
    res.setHeader && res.setHeader("content-type", "text/javascript; charset=utf-8");
    res.setHeader && res.setHeader("cache-control", "public, max-age=3600");
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
      // Page through the catalog via the cursor — `products.list` caps a
      // single page at the catalog's MAX_LIMIT (200), so a single
      // `limit: 1000` call would throw and silently drop EVERY product from
      // the sitemap. Walk pages until exhausted or the sitemap's per-file
      // 50k-URL ceiling, matching the edge sitemap's 50k cap.
      var SITEMAP_PRODUCT_CAP = 50000;
      var productCursor = null;
      var productCount = 0;
      do {
        var page = await deps.catalog.products.list({ status: "active", limit: 200, cursor: productCursor });
        for (var i = 0; i < page.rows.length && productCount < SITEMAP_PRODUCT_CAP; i += 1) {
          var p = page.rows[i];
          var lastmod = new Date(p.updated_at || p.created_at || Date.now()).toISOString().slice(0, 10);
          urls.push({
            loc:        origin + "/products/" + p.slug,
            lastmod:    lastmod,
            changefreq: "weekly",
            priority:   "0.8",
          });
          productCount += 1;
        }
        productCursor = page.next_cursor;
      } while (productCursor && productCount < SITEMAP_PRODUCT_CAP);
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
    // Published CMS pages (/pages/<slug>), when the storefrontPages
    // primitive is wired. `monthly` / 0.5 — operator content changes less
    // often than the catalog; the edge sitemap emits the same values.
    // Best-effort: a read failure drops the page rows rather than 500-ing.
    if (deps.storefrontPages && typeof deps.storefrontPages.listPublished === "function") {
      try {
        var cmsPages = await deps.storefrontPages.listPublished();
        for (var pgi = 0; pgi < cmsPages.length; pgi += 1) {
          var pg = cmsPages[pgi];
          if (pg && pg.slug) {
            var pgLast = new Date(pg.updated_at || pg.created_at || Date.now()).toISOString().slice(0, 10);
            urls.push({ loc: origin + "/pages/" + pg.slug, lastmod: pgLast, changefreq: "monthly", priority: "0.5" });
          }
        }
      } catch (_e) { /* drop-silent — CMS pages unreachable drops those rows */ }
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
  preorderCtaShape:      preorderCtaShape,
  renderCollectionList:  renderCollectionList,
  renderCollection:      renderCollection,
  renderCategoryIndex:   renderCategoryIndex,
  renderCategory:        renderCategory,
  renderCart:            renderCart,
  renderCheckoutForm:    renderCheckoutForm,
  renderCheckoutError:   renderCheckoutError,
  renderGiftCardBalance: renderGiftCardBalance,
  renderPayPage:         renderPayPage,
  renderOrder:           renderOrder,
  renderOrderList:       renderOrderList,
  renderAccountLogin:    renderAccountLogin,
  renderAccountRegister: renderAccountRegister,
  renderAccount:         renderAccount,
  renderPasskeys:        renderPasskeys,
  renderPasskeyRemoveConfirm: renderPasskeyRemoveConfirm,
  renderPaymentMethods:  renderPaymentMethods,
  renderAddPaymentMethod: renderAddPaymentMethod,
  renderAccountPickups:  renderAccountPickups,
  renderProfile:         renderProfile,
  renderAccountSubscriptions: renderAccountSubscriptions,
  renderCookiePreferences: renderCookiePreferences,
  renderSurveyPage:      renderSurveyPage,
  renderNewsletterError: renderNewsletterError,
  renderNotFound:        renderNotFound,
  // Layout exposed so operators forking the framework can override.
  _wrap:                 _wrap,
  LAYOUT:                LAYOUT,
};
