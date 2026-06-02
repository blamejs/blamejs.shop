// Storefront UI-chrome localisation — edge mirror of the container's
// chrome catalog in `lib/translations.js`.
//
// The Worker can't `require` the CommonJS `lib/translations.js` (it's an
// ESM bundle importing leaf modules), so — exactly like the search-facet
// edge mirror — this module re-implements the chrome string set + the
// b.i18n lookup semantics (subtag-strip fallback to the default locale)
// in pure ESM. A parity test pins this module's resolved output to
// `lib/translations.js`'s `resolveChrome`, so the two never drift: for a
// given locale + override set, the edge and the container emit identical
// chrome strings, byte for byte.
//
// The edge serves the storefront's DEFAULT locale only — any explicit
// locale choice rides the `shop_locale` cookie (or `?lang=`), and the
// Worker skips the edge cache + forwards those requests to the container,
// which renders the full localised page (including operator overrides and
// the reduced blog/policy chrome). So the edge resolves the default
// locale's baseline chrome; operator chrome overrides reach the visitor
// through the container path.

// Import escapeHtml from the b.js adapter (the validated leaf-module
// bridge) rather than `_lib.js` — `_lib.js` imports the asset manifest
// JSON, and keeping this module JSON-free lets the edge↔container parity
// test load it under Node's plain ESM loader without an import attribute.
import b from "../b.js";
function escapeHtml(s) { return b.template.escapeHtml(s); }

// The English baseline — byte-identical to `CHROME_DEFAULTS` in
// lib/translations.js. The parity test asserts this equality so an edit
// to one side that isn't mirrored to the other fails the build.
export var CHROME_DEFAULTS = Object.freeze({
  skip_to_content:    "Skip to content",

  util_pill:          "Open source · Apache 2.0",
  util_msg:           "Server-rendered HTML · post-quantum crypto on by default · zero npm runtime deps",
  util_star:          "Star on GitHub →",

  search_label:       "Search products",
  search_placeholder: "Search the catalog",
  search_submit:      "Search",

  nav_shop:           "Shop",
  nav_collections:    "Collections",
  nav_categories:     "Categories",
  nav_framework:      "Framework",
  nav_account:        "Account",
  nav_menu:           "Menu",
  nav_cart_aria:      "Cart, {count} items",

  newsletter_eyebrow: "Stay in the loop",
  newsletter_title:   "Get release notes the day they ship.",
  newsletter_lede:    "No marketing emails. A single short note when there's a new framework release, a security advisory, or a primitive worth knowing about.",
  newsletter_email:   "Email address",
  newsletter_submit:  "Subscribe",

  footer_tagline:     "An open-source shop framework — server-rendered HTML, zero npm runtime dependencies, security defaults on.",

  footer_shop_heading:    "Shop",
  footer_shop_all:        "All products",
  footer_shop_collections: "Collections",
  footer_shop_categories: "Categories",
  footer_shop_compare:    "Compare",
  footer_shop_cart:       "Cart",
  footer_shop_shipping:   "Shipping & returns",

  footer_framework_heading: "Framework",
  footer_framework_source:  "Source on GitHub",
  footer_framework_core:    "blamejs core",
  footer_framework_security: "Security policy",
  footer_framework_changelog: "Changelog",

  footer_operators_heading: "Your account",
  footer_operators_account: "Account",
  footer_operators_orders:  "Orders",
  footer_operators_contact: "Contact",

  footer_copy_suffix:  "built on blamejs · Apache 2.0 licensed.",
  footer_legal_security: "Security",
  footer_legal_privacy:  "Privacy",
  footer_legal_terms:    "Terms",
  footer_legal_cookies:  "Manage cookies",

  locale_switcher_label: "Language",
  locale_switcher_submit: "Go",
});

// BCP-47 language subtags whose default writing direction is RTL —
// mirrors b.i18n's RTL_LANGUAGES set (Unicode CLDR + W3C i18n).
var RTL_LANGUAGES = new Set(["ar", "fa", "he", "ur", "ps", "sd", "yi", "ckb", "dv"]);

// Resolve one chrome key for `locale` against the override map, walking
// the same chain b.i18n walks: the requested tag, then each subtag-strip
// (`pt-BR` → `pt`), then the default locale, then the English baseline.
// `overrides` is { "<locale>": { "<field>": "<value>" } }. A key absent
// from every layer returns the English baseline (never a raw key).
function _resolveKey(key, locale, defaultLocale, overrides) {
  var chain = [];
  var current = locale;
  while (current && chain.indexOf(current) === -1) {
    chain.push(current);
    var dash = current.lastIndexOf("-");
    if (dash === -1) break;
    current = current.slice(0, dash);
  }
  if (chain.indexOf(defaultLocale) === -1) chain.push(defaultLocale);
  for (var i = 0; i < chain.length; i += 1) {
    var loc = chain[i];
    if (overrides[loc] && Object.prototype.hasOwnProperty.call(overrides[loc], key) &&
        typeof overrides[loc][key] === "string") {
      return overrides[loc][key];
    }
  }
  // Default-locale baseline is the shipped English string.
  return CHROME_DEFAULTS[key];
}

// Resolve the full chrome string set for `locale`. The `nav_cart_aria`
// string keeps its literal `{count}` placeholder — the layout fills the
// live cart count, mirroring the container's `resolveChrome`.
export function resolveChrome(locale, opts) {
  opts = opts || {};
  var defaultLocale = opts.defaultLocale || "en";
  var overrides = opts.overrides || {};
  var out = {};
  var keys = Object.keys(CHROME_DEFAULTS);
  for (var i = 0; i < keys.length; i += 1) {
    out[keys[i]] = _resolveKey(keys[i], locale, defaultLocale, overrides);
  }
  return out;
}

export function dirFor(locale) {
  var primary = String(locale || "en").split("-")[0].toLowerCase();
  return RTL_LANGUAGES.has(primary) ? "rtl" : "ltr";
}

// BCP-47 tag envelope — the same shape lib/locale-router.js's LOCALE_RE
// accepts. A tag that fails this gate is dropped (never reaches an href),
// so a poked supported-list value can't inject markup.
var _LOCALE_TAG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

// Hostname envelope — bare host, no port. Defensive request-shape reader:
// a malformed host returns "" (no hreflang) rather than throwing into the
// render path.
var _HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Strip a leading `/<locale>` path segment when present. Mirrors
// lib/locale-router.js#_urlPrefixCandidate's leading-segment detection.
function _stripLeadingLocaleSegment(path) {
  var rest = path.charAt(0) === "/" ? path.slice(1) : path;
  if (!rest.length) return null;
  var slash = rest.indexOf("/");
  var seg = slash === -1 ? rest : rest.slice(0, slash);
  if (!seg.length || seg.length > 35 || !_LOCALE_TAG_RE.test(seg)) return null;
  return seg;
}

function _stripLeadingLocaleSubdomain(host) {
  if (host.indexOf(".") === -1) return null;
  var first = host.slice(0, host.indexOf("."));
  if (!first.length || first.length > 35 || !_LOCALE_TAG_RE.test(first)) return null;
  return first;
}

// Build the canonical URL for `locale` under a URL-shaped strategy. The
// byte-identical mirror of lib/locale-router.js#_canonicalForUrl — a
// parity test pins the two so they never drift. Returns null for a
// non-URL strategy (the caller emits no hreflang then).
function _canonicalForLocale(host, path, locale, strategy) {
  var lc = String(locale).toLowerCase();
  if (strategy === "url_prefix") {
    var prefix = _stripLeadingLocaleSegment(path);
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
    var sub = _stripLeadingLocaleSubdomain(host);
    var apex = sub ? host.slice(sub.length + 1) : host;
    return "https://" + lc + "." + apex + path;
  }
  return null;
}

// Build the `<link rel="alternate" hreflang>` block (with `x-default`) for
// a URL-shaped locale policy. Returns "" when the strategy is not
// url_prefix/subdomain, the supported list has fewer than two entries, or
// the host/path is malformed — so a single-locale or cookie-strategy store
// (and a hostile Host header) emits nothing. The href math is the
// byte-identical mirror of the container's, pinned by a parity test.
//
// Locale tags pass the envelope regex above and host/path are validated;
// every value is still escapeHtml'd defense-in-depth, matching the
// announcementBar href discipline.
export function alternateLinks(opts) {
  opts = opts || {};
  var strategy = opts.strategy;
  if (strategy !== "url_prefix" && strategy !== "subdomain") return "";
  var supported = Array.isArray(opts.supportedLocales) ? opts.supportedLocales : [];
  if (supported.length < 2) return "";
  var defaultLocale = opts.defaultLocale;
  if (typeof defaultLocale !== "string" || !_LOCALE_TAG_RE.test(defaultLocale)) return "";
  if (typeof opts.host !== "string" || typeof opts.path !== "string") return "";
  var host = opts.host.toLowerCase();
  var colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  if (!host.length || host.length > 253 || !_HOST_RE.test(host)) return "";
  var path = opts.path;
  if (!path.length || path.length > 2048 || path.charAt(0) !== "/") return "";
  if (/[\x00-\x1f\x7f]/.test(path)) return "";

  var out = "";
  for (var i = 0; i < supported.length; i += 1) {
    var tag = supported[i];
    if (typeof tag !== "string" || !_LOCALE_TAG_RE.test(tag)) continue;
    var href = _canonicalForLocale(host, path, tag, strategy);
    if (href == null) continue;
    out += "  <link rel=\"alternate\" hreflang=\"" + escapeHtml(tag) +
      "\" href=\"" + escapeHtml(href) + "\">\n";
  }
  if (!out) return "";
  var xDefault = _canonicalForLocale(host, path, defaultLocale, strategy);
  if (xDefault != null) {
    out += "  <link rel=\"alternate\" hreflang=\"x-default\" href=\"" +
      escapeHtml(xDefault) + "\">\n";
  }
  return out;
}

// Splice the resolved chrome strings + lang/dir into a canonical LAYOUT
// string. The LAYOUT carries `{{chrome_key}}` placeholders the same way
// the container's does; this fills them with the per-substitution
// HTML-escape `renderTemplate` would apply (so the markup is byte-
// identical to the container's). `cartCount` interpolates into the cart
// aria-label. Returns the LAYOUT with `RAW_LOCALE_SWITCHER`,
// `RAW_CSS_INTEGRITY`, and `RAW_BODY_PLACEHOLDER` left intact for the
// caller's existing splices.
//
// NOTE: the edge serves the default locale, so `switcherHtml` is empty
// unless a future edge build offers the switcher; the container renders
// the switcher (and any non-default locale) on the cache-bypass path.
export function localizeLayout(layout, opts) {
  var chrome = opts.chrome;
  var lang = opts.lang || "en";
  var dir = opts.dir || "ltr";
  var cartCount = opts.cartCount == null ? 0 : opts.cartCount;
  var cartAria = String(chrome.nav_cart_aria).replace("{count}", String(cartCount));

  var out = layout
    .replace("{{lang}}", escapeHtml(lang))
    .replace("{{dir}}", escapeHtml(dir))
    .replace("{{nav_cart_aria}}", escapeHtml(cartAria));

  var keys = Object.keys(chrome);
  for (var i = 0; i < keys.length; i += 1) {
    var k = keys[i];
    if (k === "nav_cart_aria" || k === "locale_switcher_label" || k === "locale_switcher_submit") continue;
    // Replace every occurrence — a chrome key can appear more than once
    // in the layout (it does not today, but stay robust).
    out = out.split("{{" + k + "}}").join(escapeHtml(chrome[k]));
  }
  // The edge default-locale render carries no switcher.
  out = out.replace("RAW_LOCALE_SWITCHER", opts.switcherHtml || "");
  return out;
}
