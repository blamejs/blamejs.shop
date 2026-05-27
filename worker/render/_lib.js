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

export function escapeAttr(s) {
  return b.template.escapeHtml(s);
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
// `</` → `<\/` rewrite neutralises any literal `</script>` that
// could appear in a value (Schema.org doesn't ship strings with
// HTML in the supported field set, but the rewrite is the canonical
// XSS defense for inline JSON-in-HTML and costs one regex pass).
export function jsonLdScript(data) {
  if (data == null || typeof data !== "object") {
    throw new TypeError("jsonLdScript: data must be a non-null object");
  }
  var serialised = JSON.stringify(data).replace(/<\/(?=script>)/gi, "<\\/");
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

export function formatPrice(minorUnits, currency) {
  if (!Number.isInteger(minorUnits)) {
    throw new TypeError("formatPrice: minorUnits must be an integer, got " + JSON.stringify(minorUnits));
  }
  if (typeof currency !== "string") {
    throw new TypeError("formatPrice: currency must be a string, got " + (currency === null ? "null" : typeof currency));
  }
  return b.money.of(BigInt(minorUnits), currency).format("en-US");
}
