// Storefront CMS page renderer. Serves operator-authored content pages
// (About, Shipping, Returns, and the long tail every shop needs) at
// /pages/:slug, off the same minimal layout the policy pages use — these
// are read-once content surfaces, not a commerce page.
//
// The body is operator-authored Markdown. This module renders the same
// Markdown subset, with the same XSS defense, as the container-side
// primitive (lib/storefront-pages.js #_renderMarkdown): every text run is
// HTML-escaped via b.template.escapeHtml, and every inline link URL is
// validated (https:// allowlist via b.safeUrl.parse, or a /-rooted
// absolute path) before it reaches an href — a URL that fails the gate is
// dropped and the anchor text falls back to inert escaped text. Raw HTML
// in the body never passes through; any `<` lands as `&lt;`. The two
// substrates render the same body byte-for-byte so the page reads the
// same whether it's served from the edge or the container.
import { renderTemplate, assetUrl, stylesheetIntegrityAttr, CONSENT_BANNER, consentScriptTag, cartCountScriptTag, announcementBar, announcementScriptTag } from "./_lib.js";
import b from "../b.js";

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <meta name=\"description\" content=\"{{description}}\">\n" +
  "  RAW_META_KEYWORDS" +
  "  <link rel=\"canonical\" href=\"{{canonical_url}}\">\n" +
  "  <link rel=\"icon\" type=\"image/svg+xml\" href=\"/assets/brand/favicon.svg\">\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/favicon.png\">\n" +
  "  <link rel=\"apple-touch-icon\" href=\"/assets/brand/favicon.png\">\n" +
  "  <meta name=\"theme-color\" content=\"#08080a\">\n" +
  "  <link rel=\"stylesheet\" href=\"{{theme_css}}\"RAW_CSS_INTEGRITY>\n" +
  "  <meta name=\"robots\" content=\"index, follow\">\n" +
  "  <meta property=\"og:type\" content=\"website\">\n" +
  "  <meta property=\"og:title\" content=\"{{og_title}}\">\n" +
  "  <meta property=\"og:description\" content=\"{{description}}\">\n" +
  "  <meta property=\"og:url\" content=\"{{canonical_url}}\">\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#main\">Skip to content</a>\n" +
  "RAW_ANNOUNCEMENT_BAR" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\" aria-label=\"{{shop_name}}\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"></a>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <a class=\"site-nav__link\" href=\"/\">Shop</a>\n" +
  "        <a class=\"site-nav__link\" href=\"/cart\">Cart</a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <main id=\"main\" class=\"policy-page policy-page--{{layout}}\">\n" +
  "    <div class=\"policy-page__inner\">\n" +
  "      <p class=\"eyebrow\">{{eyebrow}}</p>\n" +
  "      <h1>{{title_h1}}</h1>\n" +
  "      <p class=\"policy-page__updated\">Last updated: {{updated}}</p>\n" +
  "      RAW_BODY_PLACEHOLDER\n" +
  "    </div>\n" +
  "  </main>\n" +
  "  <footer class=\"site-footer site-footer--minimal\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <p>&copy; {{year}} {{shop_name_footer}}</p>\n" +
  "      <ul>\n" +
  "        <li><a href=\"/privacy\">Privacy</a></li>\n" +
  "        <li><a href=\"/terms\">Terms</a></li>\n" +
  "        <li><a href=\"/cookies\">Manage cookies</a></li>\n" +
  "        <li><a href=\"https://github.com/blamejs/blamejs.shop\" rel=\"noopener\">Source</a></li>\n" +
  "      </ul>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  CONSENT_BANNER +
  "RAW_CONSENT_SCRIPT" +
  "RAW_CART_COUNT_SCRIPT" +
  "RAW_ANNOUNCEMENT_SCRIPT" +
  "</body>\n" +
  "</html>\n";

// Layout token is a closed enum at the source (the migration's CHECK
// constraint + the primitive's validator). Map it onto a body class so a
// future stylesheet can tune the wrapper; an unknown token degrades to
// "default" rather than emitting attacker-influenced markup.
var ALLOWED_LAYOUTS = { "default": true, wide: true, landing: true, legal: true };
function _layoutClass(layout) {
  return (typeof layout === "string" && ALLOWED_LAYOUTS[layout]) ? layout : "default";
}

function _isoDate(epochMs) {
  if (!Number.isInteger(epochMs)) return "—";
  return new Date(epochMs).toISOString().slice(0, 10);
}

// ---- Markdown subset → safe HTML ---------------------------------------
//
// A faithful copy of lib/storefront-pages.js's renderer so the edge and
// container substrates emit the same body for the same source. Every text
// run is escaped; every link URL is validated before it reaches an href.

function _esc(s) {
  return b.template.escapeHtml(s);
}

var _CONTROL_BYTE_LINE_RE = /[\x00-\x1f\x7f]/;
var _ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// True when `b.safeUrl.parse` accepts the URL under the https-only
// allowlist. The parse throws on a rejected scheme / shape; this wrapper
// turns that throw into a boolean so the link renderer stays a single
// expression (no catch-returns-null in the render path — that shape is
// reserved for the edge dispatcher's "not my route" signal).
function _passesHttpsParse(url) {
  var ok = true;
  try {
    b.safeUrl.parse(url, { allowedProtocols: ["https:"] });
  } catch (_e) {
    ok = false;
  }
  return ok;
}

// Accept an https:// URL (via safeUrl's allowlist) or a /-rooted absolute
// path; refuse everything else (javascript:/data:, protocol-relative
// //host, path traversal). Returns the URL when safe, null otherwise.
function _safeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (_CONTROL_BYTE_LINE_RE.test(url) || _ZERO_WIDTH_RE.test(url)) return null;
  if (url.charCodeAt(0) === 47 /* "/" */) {
    if (url.length > 1 && url.charCodeAt(1) === 47) return null;
    if (url.indexOf("..") !== -1) return null;
    return url;
  }
  return _passesHttpsParse(url) ? url : null;
}

function _renderInline(line) {
  var out = "";
  var i = 0;
  while (i < line.length) {
    var ch = line.charAt(i);
    if (ch === "`") {
      var end = line.indexOf("`", i + 1);
      if (end !== -1) {
        out += "<code>" + _esc(line.slice(i + 1, end)) + "</code>";
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      var closeBracket = line.indexOf("]", i + 1);
      if (closeBracket !== -1 && line.charAt(closeBracket + 1) === "(") {
        var closeParen = line.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          var text = line.slice(i + 1, closeBracket);
          var url  = line.slice(closeBracket + 2, closeParen);
          var safe = _safeLinkUrl(url);
          if (safe) {
            out += '<a href="' + _esc(safe) + '">' + _renderInline(text) + "</a>";
          } else {
            out += _renderInline(text);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }
    if (ch === "*" && line.charAt(i + 1) === "*") {
      var endBold = line.indexOf("**", i + 2);
      if (endBold !== -1) {
        out += "<strong>" + _renderInline(line.slice(i + 2, endBold)) + "</strong>";
        i = endBold + 2;
        continue;
      }
    }
    if (ch === "*" || ch === "_") {
      var endItalic = line.indexOf(ch, i + 1);
      if (endItalic !== -1 && endItalic !== i + 1) {
        out += "<em>" + _renderInline(line.slice(i + 1, endItalic)) + "</em>";
        i = endItalic + 1;
        continue;
      }
    }
    out += _esc(ch);
    i += 1;
  }
  return out;
}

function _renderMarkdown(body) {
  var normalized = String(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var lines = normalized.split("\n");
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    if (line.trim() === "") { i += 1; continue; }
    if (/^-{3,}\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }
    var hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      var level = hMatch[1].length;
      out.push("<h" + level + ">" + _renderInline(hMatch[2].trim()) + "</h" + level + ">");
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      var quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote><p>" + _renderInline(quoteLines.join(" ")) + "</p></blockquote>");
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      var ulItems = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        ulItems.push(lines[i].replace(/^[-*]\s+/, ""));
        i += 1;
      }
      var ulHtml = ulItems.map(function (item) {
        return "<li>" + _renderInline(item) + "</li>";
      }).join("");
      out.push("<ul>" + ulHtml + "</ul>");
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      var olItems = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        olItems.push(lines[i].replace(/^\d+\.\s+/, ""));
        i += 1;
      }
      var olHtml = olItems.map(function (item) {
        return "<li>" + _renderInline(item) + "</li>";
      }).join("");
      out.push("<ol>" + olHtml + "</ol>");
      continue;
    }
    var paraLines = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^[-*]\s+/.test(lines[i]) &&
      !/^\d+\.\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^-{3,}\s*$/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    out.push("<p>" + _renderInline(paraLines.join(" ")) + "</p>");
  }
  return out.join("\n");
}

// Render a published storefront page. `opts.page` is the row read by
// getPublishedPageBySlug (the caller has already gated on status, so this
// renders whatever it's handed). The Markdown body becomes the page's
// `<main>` content; the title drives the `<title>` + `<h1>`; the optional
// meta_description / meta_keywords surface in the `<head>`.
export function renderStorefrontPage(opts) {
  opts = opts || {};
  var page = opts.page;
  if (!page || typeof page !== "object") {
    throw new TypeError("renderStorefrontPage: opts.page required");
  }
  var shopName = opts.shopName || "blamejs.shop";
  var themeCss = opts.themeCss || assetUrl("css/main.css");
  var title    = page.title || "";
  var metaDesc = (page.meta_description != null && String(page.meta_description).length)
    ? String(page.meta_description)
    : title;
  var metaKeywords = (page.meta_keywords != null && String(page.meta_keywords).length)
    ? "<meta name=\"keywords\" content=\"" + b.template.escapeHtml(String(page.meta_keywords)) + "\">\n"
    : "";
  var bodyHtml = _renderMarkdown(page.body || "");

  return renderTemplate(LAYOUT, {
    title:            title,
    title_h1:         title,
    og_title:         title + " — " + shopName,
    shop_name:        shopName,
    shop_name_footer: shopName,
    description:      metaDesc,
    theme_css:        themeCss,
    eyebrow:          "Information",
    layout:           _layoutClass(page.layout),
    updated:          _isoDate(page.updated_at != null ? Number(page.updated_at) : null),
    canonical_url:    opts.canonicalUrl || "",
    year:             String(new Date().getUTCFullYear()),
  }).replace("RAW_META_KEYWORDS", metaKeywords)
    .replace("RAW_CSS_INTEGRITY", stylesheetIntegrityAttr(themeCss))
    .replace("RAW_ANNOUNCEMENT_BAR", announcementBar(opts.announcement || null))
    .replace("RAW_CONSENT_SCRIPT", consentScriptTag())
    .replace("RAW_CART_COUNT_SCRIPT", cartCountScriptTag())
    .replace("RAW_ANNOUNCEMENT_SCRIPT", (opts.announcement && opts.announcement.dismissible) ? announcementScriptTag() : "")
    .replace("RAW_BODY_PLACEHOLDER", bodyHtml);
}
