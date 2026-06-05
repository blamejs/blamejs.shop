// Worker render helpers compose blamejs primitives through the
// `worker/b.js` adapter. Single import surface; the adapter is the
// validated bridge between the Worker substrate and the framework's
// leaf modules.
import b from "../b.js";
// Asset integrity + fingerprint + version manifest, bundled into the
// Worker. The edge has no filesystem to hash assets at request time, so
// the SRI digest + the content-fingerprinted path are read from this
// committed manifest — the byte-identical twin of lib/asset-manifest.json
// the container reads. Both runtimes therefore emit the same asset URLs.
import assetManifest from "../asset-manifest.json";

// Content-fingerprinted asset URL — `/assets/themes/default/<fingerprinted>`,
// where the fingerprint embeds a hash of the asset bytes (`main.<hash>.css`).
// The hash IS the cache-buster, so no `?v=` query is appended: each URL maps
// one-to-one onto a byte-content. This makes the Worker/R2 deploy order
// irrelevant — a not-yet-synced asset 404s instead of poisoning SRI, and
// pages already in flight keep loading the old fingerprinted object that
// still exists in R2. Mirrors lib/storefront.js `_assetUrl` byte-for-byte
// so the edge and the container emit identical asset URLs. An asset missing
// from the manifest (a custom operator theme) falls back to its plain path.
export function assetUrl(relUnderThemeAssets) {
  var entry = assetManifest.assets[relUnderThemeAssets];
  var fp    = (entry && entry.fingerprinted) || relUnderThemeAssets;
  return "/assets/themes/default/" + fp;
}

// Subresource Integrity for a default-theme asset — the sha384 digest
// (W3C SRI 1.0) from the manifest, or null for an asset we don't ship
// (a custom operator theme, whose bytes aren't ours to hash). Mirrors
// lib/storefront.js `_assetSri`.
export function assetSri(relUnderThemeAssets) {
  var entry = assetManifest.assets[relUnderThemeAssets];
  return (entry && entry.integrity) || null;
}

// `<link rel="stylesheet">` integrity attribute (with leading space) for a
// theme stylesheet URL — present only when the URL is the default theme CSS
// we ship and can hash; a custom operator-supplied `theme_css` is left
// without an integrity attribute. Mirrors the container's `_wrap` logic so
// the emitted tag is byte-identical across both renderers.
export function stylesheetIntegrityAttr(themeCssUrl) {
  var sri = (themeCssUrl === assetUrl("css/main.css")) ? assetSri("css/main.css") : null;
  return sri ? " integrity=\"" + sri + "\"" : "";
}

export function escapeHtml(s) {
  return b.template.escapeHtml(s);
}

// Splice a fully-rendered HTML fragment into `html` at the first
// occurrence of a literal `RAW_*` token, inserting the fragment LITERALLY.
//
// `String.prototype.replace(token, replacementString)` gives the
// replacement string special meaning to `$` sequences — `$$`, `$&`,
// `` $` `` (the text before the match), `$'` (the text after the match),
// `$1`. A page/blog body that contains a dollar followed by a backtick
// would otherwise splice the page HEAD into the body, and any other
// dollar sequence corrupts the output. The fragment is already
// escaped/rendered at its own build site, so this is purely about the
// replace mechanics: a REPLACER FUNCTION makes `String.replace` insert
// the return value verbatim, with no dollar interpretation. Mirrors the
// container's `_spliceRaw` so the two substrates stay byte-identical.
export function spliceRaw(html, token, fragment) {
  return html.replace(token, function () { return fragment == null ? "" : String(fragment); });
}

export function escapeAttr(s) {
  return b.template.escapeHtml(s);
}

// Absolute origin (scheme + host, no trailing slash) for building
// fully-qualified URLs in `<head>` metadata and structured data. Prefers
// the request-derived canonical URL's origin (matches the host the
// visitor reached); falls back to the shop-name host when called without
// one (a unit test, or a theme path). A bare host shop name and a full
// `https://` value both normalise to `https://<host>`. Mirrors the
// container's lib/storefront.js `_absoluteBase` so the two substrates emit
// identical absolute URLs.
export function absoluteBase(canonicalUrl, shopName) {
  if (typeof canonicalUrl === "string" && canonicalUrl.length) {
    try {
      return new URL(canonicalUrl).origin;
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
// crawler fetch). Mirrors the container's `_absolutizeOgImage`.
export function absolutizeOgImage(value, canonicalUrl, shopName) {
  var v = (value == null) ? "" : String(value);
  if (/^https?:\/\//i.test(v)) return v;
  if (v.charAt(0) !== "/") return v;
  var hasCanonical = typeof canonicalUrl === "string" && canonicalUrl.length > 0;
  if (!hasCanonical && /\s/.test(String(shopName == null ? "" : shopName))) return v;
  return absoluteBase(canonicalUrl, shopName) + v;
}

var PLACEHOLDER_RE = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;

function _isPlainObject(o) {
  if (o == null || typeof o !== "object") return false;
  var proto = Object.getPrototypeOf(o);
  return proto === null || proto === Object.prototype;
}

// Strict `{{name}}` substitution with HTML-escape per substitution
// and refusal of unknown / unused placeholders. The framework's
// `b.template.render` interpreter takes a path + viewsDir (file-
// backed) so doesn't apply to inline-string templates; we use its
// `escapeHtml` per-value escape for byte-identical output.
export function renderTemplate(tpl, vars) {
  if (typeof tpl !== "string") {
    throw new TypeError("renderTemplate: tpl must be a string, got " + (tpl === null ? "null" : typeof tpl));
  }
  if (!_isPlainObject(vars)) {
    throw new TypeError("renderTemplate: vars must be a plain object, got " + (vars === null ? "null" : typeof vars));
  }
  var seen = new Set();
  var out = tpl.replace(PLACEHOLDER_RE, function (_match, key) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new TypeError("renderTemplate: template references unknown variable {{" + key + "}}");
    }
    seen.add(key);
    var v = vars[key];
    if (v == null) return "";
    return b.template.escapeHtml(String(v));
  });
  var keys = Object.keys(vars);
  for (var i = 0; i < keys.length; i += 1) {
    if (!seen.has(keys[i])) {
      throw new TypeError("renderTemplate: template did not reference variable " + JSON.stringify(keys[i]));
    }
  }
  return out;
}

// HTML minifier — collapses inter-tag whitespace runs the templates
// carry for source readability. Preserves text content untouched
// (text never carries `>\s+<` boundaries), and explicitly skips
// `<pre>`, `<script>`, `<style>`, `<textarea>`, `<code>` blocks
// where whitespace IS semantically meaningful.
var WHITESPACE_PRESERVE_TAGS = ["pre", "script", "style", "textarea", "code"];
var PRESERVE_RE = new RegExp(
  "<(" + WHITESPACE_PRESERVE_TAGS.join("|") + ")\\b[^>]*>[\\s\\S]*?</\\1>",
  "gi"
);

export function minifyHtml(html) {
  if (typeof html !== "string") return html;
  // Stash preserve-tag blocks behind sentinel tokens so the collapse
  // pass doesn't touch them. The sentinel uses control-character
  // ranges that can't appear in operator-rendered HTML.
  var stashed = [];
  var stashedSrc = html.replace(PRESERVE_RE, function (m) {
    var idx = stashed.length;
    stashed.push(m);
    return "PRESERVE_" + idx + "";
  });
  // Collapse `> ... <` runs (whitespace between tags) to a single
  // space when the run contains a newline. Single-line indentation
  // shifts (e.g. `<a>...</a>  <b>` inline) stays intact.
  var collapsed = stashedSrc.replace(/>\s*\n\s*</g, "><");
  // Reinstate the preserved blocks.
  return collapsed.replace(/PRESERVE_(\d+)/g, function (_m, i) {
    return stashed[Number(i)];
  });
}

// Schema.org JSON-LD `<script type="application/ld+json">` block.
// `JSON.stringify` covers the standard escapes (`"` / `\`); the
// `</script` → `<\/script` rewrite neutralises any literal closing tag
// that could appear in a value. The HTML tokenizer ends a <script> on
// `</script` followed by whitespace, `/`, or `>`, so matching only the
// exact `</script>` byte sequence misses `</script `, `</script\n`,
// `</script/` — all of which still break out. Matching `</script` (any
// trailing byte) closes every variant. Schema.org doesn't ship strings
// with HTML in the supported field set, but the rewrite is the
// canonical defense for inline JSON-in-HTML and costs one regex pass.
// Mirrors the container renderer's `_jsonLdScript` byte-for-byte (this
// output is dual-rendered; the render-parity tests gate on the two
// agreeing).
export function jsonLdScript(data) {
  if (data == null || typeof data !== "object") {
    throw new TypeError("jsonLdScript: data must be a non-null object");
  }
  var serialised = JSON.stringify(data).replace(/<\/script/gi, "<\\/script");
  return "<script type=\"application/ld+json\">" + serialised + "</script>";
}

// Cookie-consent banner markup — the byte-identical twin of
// lib/storefront.js's CONSENT_BANNER. Lives here so every worker LAYOUT
// embeds the same chrome the container renders (the storefront's pages
// render in BOTH substrates; the banner must match across them). Static
// markup — nothing reflected, so no escape surface. The dismissal +
// return-to-current-page enhancement is the consent island
// (themes/default/assets/js/consent.js); JS-off visitors still get a
// fully working server-rendered form (POST /consent).
export var CONSENT_BANNER =
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

// PWA default manifest + service worker — the shipped fallback served at
// /manifest.webmanifest + /sw.js when the operator has not defined an
// active pwaManifest row. BOTH substrates serve these exact bytes (the edge
// has no DB-backed primitive; the container's DB-backed pwaManifest is the
// override), so the `<link rel="manifest">` in every layout never 404s on a
// fresh deploy. The default name is the project name (not interpolated, so
// the bytes are byte-identical edge↔container — a parity test pins them);
// an operator customizes via pwaManifest.defineManifest + setActive on the
// container path. The object/serialization here is the byte-identical twin
// of lib/storefront.js's PWA_DEFAULT_MANIFEST / PWA_DEFAULT_SW.
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
export var PWA_DEFAULT_MANIFEST = JSON.stringify(_PWA_DEFAULT_MANIFEST_OBJ, null, 2);

// Minimal pass-through service worker — a network-first navigation
// fallback to the home page so an offline navigation lands on a cached
// shell instead of the browser's error page. Self-contained; no precache
// (the default keeps install instant). Operators who want a precache list
// + per-rule runtime caching define an active SW via pwaManifest. Byte-
// identical to lib/storefront.js's PWA_DEFAULT_SW.
export var PWA_DEFAULT_SW =
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

// `<script>` tag for the consent island, resolved to its content-
// fingerprinted URL + SRI from the shared manifest — byte-identical to the
// container's `_islandScript("consent.js", { id, policy })`. The strict
// `script-src 'self'` CSP allows this same-origin external script (inline
// scripts are blocked). `defer` keeps it off the critical path. The
// `data-consent-policy` value is the active consent policy version the
// island compares against the flag cookie to decide whether to re-prompt;
// edge-rendered (cookie-less, cached) pages stamp the initial "v1" — bump
// it in lockstep with the container's policy version when the cookie policy
// materially changes.
export function consentScriptTag() {
  var sri = assetSri("js/consent.js");
  return "<script id=\"consent-island\" src=\"" + assetUrl("js/consent.js") + "\"" +
    (sri ? " integrity=\"" + sri + "\"" : "") + " defer data-consent-policy=\"v1\"></script>";
}

// `<script>` tag for the cart-count island — byte-identical to the
// container's `_islandScript("cart-count.js", { id })` (no policy attr).
// Always emitted: every storefront chrome page server-renders the nav
// cart badge (0 on the cookie-less edge render) and this island corrects
// it from `/cart/count`, a container route that unseals `shop_sid`. The
// strict `script-src 'self'` CSP allows the same-origin external file;
// `defer` keeps it off the critical path.
export function cartCountScriptTag() {
  var sri = assetSri("js/cart-count.js");
  return "<script id=\"cart-count-island\" src=\"" + assetUrl("js/cart-count.js") + "\"" +
    (sri ? " integrity=\"" + sri + "\"" : "") + " defer></script>";
}

// Announcement-bar markup for a resolved row — BYTE-IDENTICAL to the
// container's `_buildAnnouncementBar` (lib/storefront.js) so the edge +
// container outputs match (the asset-fingerprint parity test guards this).
// Returns "" for a null row so a no-announcement page renders unchanged.
var _BAR_THEMES = { urgency: 1, promo: 1, info: 1, success: 1 };
export function announcementBar(row) {
  if (!row) return "";
  var theme = _BAR_THEMES[row.theme] ? row.theme : "info";
  var slug  = escapeHtml(String(row.slug == null ? "" : row.slug));
  var link  = "";
  if (row.link_url && row.link_label) {
    // Defense-in-depth at the href sink — only https:// or a /-rooted path
    // (not protocol-relative `//`); mirrors the container's _buildAnnouncementBar
    // so the markup stays byte-identical. HTML-escaping does not neutralise a
    // `javascript:`/`data:` scheme, so it's validated, not just escaped.
    var href = String(row.link_url);
    if (/^https:\/\//i.test(href) || (href.charAt(0) === "/" && href.charAt(1) !== "/")) {
      link = " <a class=\"announcement-bar__link\" href=\"" + escapeHtml(href) + "\">" +
        escapeHtml(String(row.link_label)) + "</a>";
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
             "<p class=\"announcement-bar__msg\">" + escapeHtml(String(row.message == null ? "" : row.message)) + link + "</p>" +
             dismiss +
           "</div>" +
         "</aside>";
}

// `<script>` tag for the announcement island — byte-identical to the
// container's `_islandScript("announcement.js", { id })` (no policy attr).
export function announcementScriptTag() {
  var sri = assetSri("js/announcement.js");
  return "<script id=\"announcement-island\" src=\"" + assetUrl("js/announcement.js") + "\"" +
    (sri ? " integrity=\"" + sri + "\"" : "") + " defer></script>";
}

// Promo-banner markup for a resolved row — BYTE-IDENTICAL to the container's
// `_buildPromoBanner` (lib/storefront.js) so an edge-cached page and a
// container page render the same banner for the same placement + audience
// (the asset-fingerprint parity test guards this). Returns "" for a null row
// so an empty placement renders nothing. The CTA points at the container
// click-tracking route (`/promo/:slug/click`) — slug-only, no operator free
// text — so the link is identical on both substrates and the edge click
// simply navigates to the container counter.
export function promoBanner(row) {
  if (!row) return "";
  var esc = function (s) { return escapeHtml(String(s == null ? "" : s)); };
  var theme     = esc(row.theme || "info");
  var placement = esc(row.placement);
  var slug      = esc(row.slug);
  var parts = [];
  parts.push("<div class=\"promo-banner promo-banner--" + theme + " promo-banner--" + placement +
             "\" data-banner-slug=\"" + slug + "\">");
  if (row.image_url) {
    var img = String(row.image_url);
    if (/^https:\/\//i.test(img) || (img.charAt(0) === "/" && img.charAt(1) !== "/")) {
      parts.push("<img class=\"promo-banner__image\" src=\"" + esc(img) + "\" alt=\"\" />");
    }
  }
  parts.push("<div class=\"promo-banner__body\">");
  parts.push("<h2 class=\"promo-banner__headline\">" + esc(row.headline) + "</h2>");
  if (row.body) {
    var raw = String(row.body).replace(/\r\n/g, "\n").split("\n");
    while (raw.length && raw[raw.length - 1] === "") raw.pop();
    for (var i = 0; i < raw.length; i += 1) {
      parts.push("<p class=\"promo-banner__line\">" + esc(raw[i]) + "</p>");
    }
  }
  var href = String(row.cta_url == null ? "" : row.cta_url);
  if (/^https:\/\//i.test(href) || (href.charAt(0) === "/" && href.charAt(1) !== "/")) {
    parts.push("<a class=\"promo-banner__cta\" href=\"/promo/" + slug + "/click\" data-banner-slug=\"" + slug + "\">" +
               esc(row.cta_label) + "</a>");
  }
  parts.push("</div>");
  parts.push("</div>");
  return parts.join("");
}

// Resolve the pre-rendered promo-banner HTML for a placement from an opts
// map of resolved rows (keyed by placement), or "" when none is active.
export function promoBannerHtml(promoMap, placement) {
  if (!promoMap || typeof promoMap !== "object") return "";
  var row = promoMap[placement];
  return row ? promoBanner(row) : "";
}

export function formatPrice(minorUnits, currency) {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError("formatPrice: minorUnits must be an integer, got " + JSON.stringify(minorUnits));
  }
  if (typeof currency !== "string") {
    throw new TypeError("formatPrice: currency must be a string, got " + (currency === null ? "null" : typeof currency));
  }
  return b.money.of(BigInt(minorUnits), currency).format(_localeFor(currency, "en-US"));
}

// ---- multi-currency display (edge) --------------------------------------
//
// The edge renders DISPLAY-ONLY converted prices: the catalog's base
// price is shown in the visitor's chosen currency, but the cart / order /
// payment currency is unchanged (the container owns the charge path). The
// conversion math + the switcher markup are byte-identical to the
// container's lib/currency-display.js + lib/storefront.js so a page served
// from the edge and the same page served from the container render the
// same converted price string. The edge reads the FX rate + rounding rule
// from its direct D1 binding (see worker/data/currency.js); this module
// holds only the pure transforms.

var BPS_SCALE = 10000;

// Per-currency default BCP 47 locale — mirrors lib/currency-display.js's
// DEFAULT_LOCALE_BY_CURRENCY so "27,59 €" / "¥3,200" render identically
// across substrates.
var DEFAULT_LOCALE_BY_CURRENCY = {
  USD: "en-US", CAD: "en-CA", AUD: "en-AU", NZD: "en-NZ", SGD: "en-SG",
  HKD: "en-HK", INR: "en-IN", GBP: "en-GB", EUR: "de-DE", CHF: "de-CH",
  SEK: "sv-SE", NOK: "nb-NO", DKK: "da-DK", JPY: "ja-JP", KRW: "ko-KR",
  BRL: "pt-BR", MXN: "es-MX",
};

function _localeFor(currency, fallback) {
  return DEFAULT_LOCALE_BY_CURRENCY[currency] || fallback || "en-US";
}

// Integer basis-points → the decimal-shaped string b.money.convert's rate
// provider expects (9200 → "0.9200"). Mirrors lib/currency-display.js.
function _bpsToDecimal(bps) {
  var whole = Math.floor(bps / BPS_SCALE);
  var frac  = bps % BPS_SCALE;
  var fracStr = String(frac);
  while (fracStr.length < 4) fracStr = "0" + fracStr;
  return whole + "." + fracStr;
}

// Round `amount` (integer minor units) to the nearest multiple of `step`
// under `mode`. Byte-identical to lib/currency-rounding.js's `_round` so
// the display-increment rule (CHF 0.05, SEK 0.10) snaps the same way on
// both substrates. Pure integer math.
function _roundStep(amount, step, mode) {
  if (step === 1) return amount;
  var quot = Math.trunc(amount / step);
  var rem  = amount - quot * step;
  if (rem < 0) { quot -= 1; rem += step; }
  var lower = quot * step;
  var upper = lower + step;
  if (rem === 0) return amount;
  if (mode === "floor")   return lower;
  if (mode === "ceiling") return upper;
  var doubled = rem * 2;
  if (doubled < step) return lower;
  if (doubled > step) return upper;
  if (mode === "half_up")   return amount >= 0 ? upper : lower;
  if (mode === "half_down") return amount >= 0 ? lower : upper;
  if (quot % 2 === 0) return lower;
  return upper;
}

// Build the edge price formatter for one request. `ctx` is the resolved
// currency context (from worker/data/currency.js): { base, display,
// rateBps, rule, locale } — or null when no display conversion applies.
// The returned function has the same (minorUnits, currency) signature as
// `formatPrice`, so a renderer swaps `formatPrice` for it transparently.
// When `ctx` is null / inactive, it IS `formatPrice` (base-currency
// display). A price stored in a non-base currency is formatted as-is, not
// re-converted (no base→that rate is resolved this request).
export function makeFormatPrice(ctx) {
  if (!ctx || !ctx.active) return formatPrice;
  var base = ctx.base;
  var display = ctx.display;
  var rateBps = ctx.rateBps;
  var rule = ctx.rule || null;
  var locale = ctx.locale || _localeFor(display);
  return function (minorUnits, currency) {
    var cur = currency == null ? base : currency;
    if (!Number.isInteger(minorUnits)) {
      throw new TypeError("formatPrice: minorUnits must be an integer, got " + JSON.stringify(minorUnits));
    }
    if (cur !== base) {
      return b.money.of(BigInt(minorUnits), cur).format(_localeFor(cur, "en-US"));
    }
    var displayMinor;
    if (rateBps === BPS_SCALE) {
      displayMinor = minorUnits;
    } else {
      var money    = b.money.fromMinorUnits(BigInt(minorUnits), base);
      var rateStr  = _bpsToDecimal(rateBps);
      var provider = { rate: function () { return rateStr; } };
      displayMinor = Number(b.money.convert(money, display, provider).toMinorUnits());
    }
    if (rule && rule.increment_minor > 1 &&
        (rule.applies_to === "all" || rule.applies_to === "display_only")) {
      displayMinor = _roundStep(displayMinor, rule.increment_minor, rule.mode);
    }
    return b.money.fromMinorUnits(BigInt(displayMinor), display).format(locale);
  };
}

// The "charged in <base>" disclosure — byte-identical to the container's.
export function currencyDisclosure(displayCurrency, baseCurrency) {
  return "Prices shown in " + displayCurrency + "; you'll be charged in " + baseCurrency + ".";
}

// Currency-switcher footer block — byte-identical markup to the
// container's lib/storefront.js `_buildCurrencySwitcher`. `opts.currencies`
// is the operator's allow-list (>=2 to render); `opts.selected` the active
// display currency; `opts.note` the disclosure (when converting);
// `opts.redirect_to` the path the switcher returns the visitor to.
export function currencySwitcher(opts) {
  if (!opts || !Array.isArray(opts.currencies) || opts.currencies.length < 2) return "";
  var esc = function (s) { return b.template.escapeHtml(String(s)); };
  var selected = opts.selected || opts.currencies[0];
  var options = opts.currencies.map(function (c) {
    var sel = c === selected ? " selected" : "";
    return "<option value=\"" + esc(c) + "\"" + sel + ">" + esc(c) + "</option>";
  }).join("");
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
