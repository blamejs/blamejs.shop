"use strict";
/**
 * @module shop.storefrontPages
 * @title  Storefront CMS pages — operator-authored Markdown with a publish FSM
 *
 * @intro
 *   Operator-authored static content surfaced at fixed slugs on the
 *   storefront — About, Shipping, Returns Policy, Privacy, Terms,
 *   the long-tail of pages that don't belong in the catalog but
 *   every shop needs.
 *
 *   Each page carries:
 *     - a stable URL-friendly `slug`,
 *     - a `title` shown in the page header and the `<title>` tag,
 *     - a `body` authored in a Markdown subset (paragraphs,
 *       headings, lists, links, inline code, emphasis, hard breaks),
 *     - optional `meta_description` + `meta_keywords` for SEO,
 *     - a `layout` token picked from a closed enum
 *       (default / wide / landing / legal),
 *     - a `status` FSM (draft → published → archived) with a
 *       restore path back to draft,
 *     - a monotonic `version` counter incremented on every update.
 *
 *   The publish FSM:
 *
 *     draft     ──publish──▶  published
 *     published ──unpublish─▶ draft
 *     published ──archive───▶ archived
 *     archived  ──restore───▶ draft
 *
 *     Every other transition is refused with an error that names the
 *     current state and the attempted action so an operator running
 *     a publish sweep can see exactly which page is wedged.
 *
 *   Composes:
 *     - `b.template.escapeHtml` — every text run from the operator-
 *       authored body lands as HTML-escaped output in `renderHtml`.
 *       The Markdown renderer never emits raw operator input.
 *     - `b.safeUrl.parse` — inline `[text](url)` link URLs pass the
 *       https-only allowlist (or `/`-rooted absolute paths). A link
 *       carrying `javascript:` / `data:` / protocol-relative `//host`
 *       is dropped from the rendered HTML and the anchor text falls
 *       back to inert escaped text.
 *
 *   Surface:
 *     - `create({ query })` — factory. `query` is optional; absent it,
 *       the primitive talks to `b.externalDb.query` directly.
 *     - `defineDraft({ slug, title, body, meta_description?,
 *                      meta_keywords?, layout })` — insert a row in
 *       `draft` status, version 1.
 *     - `publish(slug)` / `unpublish(slug)` / `archive(slug)` /
 *       `restore(slug)` — FSM transitions.
 *     - `update(slug, patch)` — patch any of the editable columns
 *       (title / body / meta_description / meta_keywords / layout),
 *       increments `version`.
 *     - `get(slug)` — any status. `getPublished(slug)` — published
 *       only (returns null for any other state).
 *     - `listPublished()` / `listDrafts()` / `listArchived()` —
 *       enumerate by FSM state. `listPublished` returns newest-
 *       published-first; the other two return creation-order.
 *     - `renderHtml({ slug })` — async; reads the page by slug and
 *       returns sanitized HTML from the Markdown body. The slug
 *       must exist or the call throws (`renderHtml` is config-tier:
 *       a missing slug is an operator bug). The render output never
 *       contains a live `<script>`, `<img onerror=...>`, or
 *       `javascript:` URL — every text run is escaped, every URL is
 *       URL-validated before it lands in the `href`.
 *
 *   Storage:
 *     - `storefront_pages` (migration `0059_storefront_pages.sql`).
 *
 * @primitive storefrontPages
 * @related   b.template.escapeHtml, b.safeUrl.parse
 */

var b = require("./index").framework;

var MAX_SLUG_LEN              = 80;
var MAX_TITLE_LEN             = 200;
var MAX_BODY_LEN              = 200000;
var MAX_META_DESCRIPTION_LEN  = 320;
var MAX_META_KEYWORDS_LEN     = 320;

var ALLOWED_LAYOUTS = Object.freeze([
  "default",
  "wide",
  "landing",
  "legal",
]);

var ALLOWED_STATUSES = Object.freeze([
  "draft",
  "published",
  "archived",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "body",
  "meta_description",
  "meta_keywords",
  "layout",
]);

// Slug shape mirrors the rest of the storefront primitives — alnum
// leading character, alnum + dot + hyphen + underscore tail, capped
// length. The slug reaches operator logs + the public storefront URL
// `/pages/<slug>`, so the shape stays narrow.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Refuse C0 control bytes + DEL in operator-authored strings. The
// body permits LF (Markdown is line-oriented); single-line fields
// refuse LF / CR so they can't smuggle a second line into a page
// header / meta tag.
var CONTROL_BYTE_LINE_RE  = /[\x00-\x1f\x7f]/;
var CONTROL_BYTE_BLOCK_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Zero-width / direction-override family — mirrors the promo-banners
// + gift-options catalogues. Spelled with \u-escapes so ESLint's
// no-irregular-whitespace stays happy.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("storefrontPages: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (≤ " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("storefrontPages: title must be a non-empty string ≤ " + MAX_TITLE_LEN + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("storefrontPages: title contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("storefrontPages: title contains zero-width / direction-override characters");
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_BODY_LEN) {
    throw new TypeError("storefrontPages: body must be a non-empty string ≤ " + MAX_BODY_LEN + " chars");
  }
  if (CONTROL_BYTE_BLOCK_RE.test(s)) {
    throw new TypeError("storefrontPages: body contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("storefrontPages: body contains zero-width / direction-override characters");
  }
  return s;
}

function _metaLine(s, label, maxLen) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > maxLen) {
    throw new TypeError("storefrontPages: " + label + " must be a string ≤ " + maxLen + " chars");
  }
  if (CONTROL_BYTE_LINE_RE.test(s)) {
    throw new TypeError("storefrontPages: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("storefrontPages: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _layout(s) {
  if (s == null) return "default";
  if (typeof s !== "string" || ALLOWED_LAYOUTS.indexOf(s) === -1) {
    throw new TypeError("storefrontPages: layout must be one of " + JSON.stringify(ALLOWED_LAYOUTS));
  }
  return s;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _hydrateRow(r) {
  if (!r) return null;
  return {
    slug:              r.slug,
    version:           Number(r.version),
    title:             r.title,
    body:              r.body,
    meta_description:  r.meta_description,
    meta_keywords:     r.meta_keywords,
    layout:            r.layout,
    status:            r.status,
    published_at:      r.published_at == null ? null : Number(r.published_at),
    archived_at:       r.archived_at  == null ? null : Number(r.archived_at),
    created_at:        Number(r.created_at),
    updated_at:        Number(r.updated_at),
  };
}

// ---- Markdown to HTML ---------------------------------------------------
//
// A minimal in-process Markdown subset, hand-written to keep the
// primitive in the zero-runtime-deps envelope. The subset is exactly
// what an operator authoring About / Shipping / Privacy / Terms
// needs:
//
//   # H1   ## H2   ### H3   #### H4   ##### H5   ###### H6
//   Paragraphs (blank-line separated)
//   - bulleted list      / * bulleted list
//   1. numbered list
//   `inline code`
//   **bold**     *italic*    _italic_
//   [link text](https://example.com/)   /   [text](/internal/path)
//   `>` blockquote
//   `---` horizontal rule
//
// Every text run is HTML-escaped via `b.template.escapeHtml`. Every
// link URL is validated via `b.safeUrl.parse` (https:// allowlist) OR
// accepted as a `/`-rooted absolute path. Any URL that fails the
// gate is dropped from the rendered HTML — the anchor text falls
// back to inert escaped text so a hostile body can't smuggle a
// `javascript:` URL into the storefront. The renderer does NOT
// support raw HTML pass-through; any `<` in the body lands as
// `&lt;` in the output. That's the whole defense against XSS:
// every operator-input byte is HTML-escaped before it reaches the
// `<main>` of the page.

function _esc(s) {
  return b.template.escapeHtml(s);
}

// Try the link URL through safeUrl (https-only) OR accept a `/`-rooted
// absolute path. Returns the URL if it passes, `null` if it doesn't.
// Protocol-relative `//host/...` is refused so a CDN mis-config can't
// downgrade an inline link.
function _safeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (CONTROL_BYTE_LINE_RE.test(url) || ZERO_WIDTH_RE.test(url)) return null;
  if (url.charCodeAt(0) === 47 /* "/" */) {
    if (url.length > 1 && url.charCodeAt(1) === 47) return null;
    if (url.indexOf("..") !== -1) return null;
    return url;
  }
  try {
    b.safeUrl.parse(url, { allowedProtocols: ["https:"] });
  } catch (_e) {
    return null;
  }
  return url;
}

// Inline renderer — walks a single line of Markdown and emits HTML.
// Order matters: inline code (`...`) consumes its content first so a
// pair of backticks around `**bold**` renders as `<code>**bold**</code>`,
// not `<code><strong>bold</strong></code>`. Then links, then bold,
// then italic. Every text run between matches is HTML-escaped.
function _renderInline(line) {
  var out = "";
  var i = 0;
  while (i < line.length) {
    var ch = line.charAt(i);
    // Inline code: `text` (no nesting, no escapes inside).
    if (ch === "`") {
      var end = line.indexOf("`", i + 1);
      if (end !== -1) {
        out += "<code>" + _esc(line.slice(i + 1, end)) + "</code>";
        i = end + 1;
        continue;
      }
    }
    // Link: [text](url)
    if (ch === "[") {
      var closeBracket = line.indexOf("]", i + 1);
      if (closeBracket !== -1 && line.charAt(closeBracket + 1) === "(") {
        var closeParen = line.indexOf(")", closeBracket + 2);
        if (closeParen !== -1) {
          var text = line.slice(i + 1, closeBracket);
          var url  = line.slice(closeBracket + 2, closeParen);
          var safe = _safeLinkUrl(url);
          if (safe) {
            // Render text through the inline pipeline too so a
            // `[**bold link**](https://...)` renders as expected. The
            // recursion is bounded by the slice — `text` is strictly
            // shorter than the input.
            out += '<a href="' + _esc(safe) + '">' + _renderInline(text) + "</a>";
          } else {
            // Drop the URL; render the anchor text as inert escaped
            // text. No `<a>` ever wraps an unsafe URL.
            out += _renderInline(text);
          }
          i = closeParen + 1;
          continue;
        }
      }
    }
    // Bold: **text**
    if (ch === "*" && line.charAt(i + 1) === "*") {
      var endBold = line.indexOf("**", i + 2);
      if (endBold !== -1) {
        out += "<strong>" + _renderInline(line.slice(i + 2, endBold)) + "</strong>";
        i = endBold + 2;
        continue;
      }
    }
    // Italic: *text* or _text_
    if (ch === "*" || ch === "_") {
      var endItalic = line.indexOf(ch, i + 1);
      if (endItalic !== -1 && endItalic !== i + 1) {
        out += "<em>" + _renderInline(line.slice(i + 1, endItalic)) + "</em>";
        i = endItalic + 1;
        continue;
      }
    }
    // Default: HTML-escape the character.
    out += _esc(ch);
    i += 1;
  }
  return out;
}

// Block renderer — splits the body on blank lines, classifies each
// block by its first character(s), and emits the matching HTML.
// Lists span contiguous lines starting with the same marker; the
// renderer accumulates them into a single <ul> / <ol>.
function _renderMarkdown(body) {
  var normalized = String(body).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var lines = normalized.split("\n");
  var out = [];
  var i = 0;
  while (i < lines.length) {
    var line = lines[i];
    // Blank line — skip.
    if (line.trim() === "") { i += 1; continue; }
    // Horizontal rule.
    if (/^-{3,}\s*$/.test(line)) {
      out.push("<hr />");
      i += 1;
      continue;
    }
    // Heading: # ... ###### (1-6 hashes + space).
    var hMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hMatch) {
      var level = hMatch[1].length;
      out.push("<h" + level + ">" + _renderInline(hMatch[2].trim()) + "</h" + level + ">");
      i += 1;
      continue;
    }
    // Blockquote — one or more consecutive `> ` lines.
    if (/^>\s?/.test(line)) {
      var quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push("<blockquote><p>" + _renderInline(quoteLines.join(" ")) + "</p></blockquote>");
      continue;
    }
    // Unordered list — one or more consecutive `- ` / `* ` lines.
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
    // Ordered list — one or more consecutive `<digits>. ` lines.
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
    // Paragraph — accumulate consecutive non-blank, non-block lines.
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

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // -- defineDraft -------------------------------------------------------

  async function defineDraft(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontPages.defineDraft: input object required");
    }
    var slug             = _slug(input.slug);
    var title            = _title(input.title);
    var body             = _body(input.body);
    var metaDescription  = _metaLine(input.meta_description, "meta_description", MAX_META_DESCRIPTION_LEN);
    var metaKeywords     = _metaLine(input.meta_keywords,    "meta_keywords",    MAX_META_KEYWORDS_LEN);
    var layout           = _layout(input.layout);

    var ts = _now();
    await query(
      "INSERT INTO storefront_pages (slug, version, title, body, meta_description, meta_keywords, " +
      "layout, status, published_at, archived_at, created_at, updated_at) " +
      "VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 'draft', NULL, NULL, ?7, ?7)",
      [slug, title, body, metaDescription, metaKeywords, layout, ts],
    );
    return await get(slug);
  }

  // -- get / getPublished -----------------------------------------------

  async function get(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM storefront_pages WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function getPublished(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM storefront_pages WHERE slug = ?1 AND status = 'published' LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  // -- list helpers -----------------------------------------------------

  async function listPublished() {
    var rows = (await query(
      "SELECT * FROM storefront_pages WHERE status = 'published' " +
      "ORDER BY published_at DESC, slug ASC",
      [],
    )).rows;
    return rows.map(_hydrateRow);
  }

  async function listDrafts() {
    var rows = (await query(
      "SELECT * FROM storefront_pages WHERE status = 'draft' " +
      "ORDER BY created_at ASC, slug ASC",
      [],
    )).rows;
    return rows.map(_hydrateRow);
  }

  async function listArchived() {
    var rows = (await query(
      "SELECT * FROM storefront_pages WHERE status = 'archived' " +
      "ORDER BY archived_at DESC, slug ASC",
      [],
    )).rows;
    return rows.map(_hydrateRow);
  }

  // -- update -----------------------------------------------------------
  //
  // Patch any subset of the editable columns (title / body /
  // meta_description / meta_keywords / layout). Every call increments
  // `version` so an operator can verify "the change I just made
  // landed" against the returned row. Status / FSM columns are NOT
  // editable here — they move via publish / unpublish / archive /
  // restore.

  async function update(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("storefrontPages.update: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("storefrontPages.update: patch must include at least one column");
    }

    var current = await get(slug);
    if (!current) {
      throw new TypeError("storefrontPages.update: slug " + JSON.stringify(slug) + " not found");
    }

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("storefrontPages.update: unsupported column " + JSON.stringify(col));
      }
      var v;
      if      (col === "title")            { v = _title(patch[col]); }
      else if (col === "body")             { v = _body(patch[col]); }
      else if (col === "meta_description") { v = _metaLine(patch[col], "meta_description", MAX_META_DESCRIPTION_LEN); }
      else if (col === "meta_keywords")    { v = _metaLine(patch[col], "meta_keywords",    MAX_META_KEYWORDS_LEN); }
      else /* layout */                    { v = _layout(patch[col]); }
      sets.push(col + " = ?" + idx);
      params.push(v);
      idx += 1;
    }

    // Bump version + stamp updated_at.
    sets.push("version = version + 1");
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;

    params.push(slug);
    var r = await query(
      "UPDATE storefront_pages SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("storefrontPages.update: slug " + JSON.stringify(slug) + " not found");
    }
    return await get(slug);
  }

  // -- FSM transitions --------------------------------------------------
  //
  // Each transition reads the current row, verifies the from-state is
  // legal for the requested action, and stamps the matching wall-
  // clock column. Illegal transitions throw with a message that names
  // both states so the operator can see what's wedged.

  function _requireState(current, slug, action, allowedFrom) {
    if (!current) {
      throw new TypeError("storefrontPages." + action + ": slug " + JSON.stringify(slug) + " not found");
    }
    if (allowedFrom.indexOf(current.status) === -1) {
      throw new TypeError(
        "storefrontPages." + action + ": slug " + JSON.stringify(slug) +
        " is in status " + JSON.stringify(current.status) +
        " — " + action + " requires status one of " + JSON.stringify(allowedFrom)
      );
    }
  }

  async function publish(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "publish", ["draft"]);
    var ts = _now();
    // First publish: stamp published_at. Re-publishing from draft
    // after an unpublish reuses the existing published_at so the
    // historical "first went live" timestamp stays stable. The
    // operator-facing model is "this slug went live on date X"; an
    // edit cycle in the middle doesn't reset that.
    var stampClause = current.published_at == null
      ? "published_at = ?1, "
      : "";
    var sql =
      "UPDATE storefront_pages SET status = 'published', " + stampClause +
      "archived_at = NULL, updated_at = ?1 WHERE slug = ?2 AND status = 'draft'";
    var r = await query(sql, [ts, slug]);
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("storefrontPages.publish: slug " + JSON.stringify(slug) + " transition race");
    }
    return await get(slug);
  }

  async function unpublish(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "unpublish", ["published"]);
    var ts = _now();
    var r = await query(
      "UPDATE storefront_pages SET status = 'draft', updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'published'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("storefrontPages.unpublish: slug " + JSON.stringify(slug) + " transition race");
    }
    return await get(slug);
  }

  async function archive(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "archive", ["published"]);
    var ts = _now();
    var r = await query(
      "UPDATE storefront_pages SET status = 'archived', archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'published'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("storefrontPages.archive: slug " + JSON.stringify(slug) + " transition race");
    }
    return await get(slug);
  }

  async function restore(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "restore", ["archived"]);
    var ts = _now();
    var r = await query(
      "UPDATE storefront_pages SET status = 'draft', archived_at = NULL, updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'archived'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("storefrontPages.restore: slug " + JSON.stringify(slug) + " transition race");
    }
    return await get(slug);
  }

  // -- renderHtml -------------------------------------------------------
  //
  // Reads the page by slug (any status — the route layer decides
  // whether to gate on `getPublished` first) and returns sanitized
  // HTML for the page body. The renderer never emits raw operator
  // input — every text run is HTML-escaped, every URL is checked
  // against `b.safeUrl.parse`, and any URL that doesn't pass the
  // gate is dropped (the anchor text falls back to inert escaped
  // text). The returned HTML is the *body* of the page — the
  // storefront route wraps it in the site layout.

  async function renderHtml(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("storefrontPages.renderHtml: input object required");
    }
    var slug = _slug(input.slug);
    var page = await get(slug);
    if (!page) {
      throw new TypeError("storefrontPages.renderHtml: slug " + JSON.stringify(slug) + " not found");
    }
    return _renderMarkdown(page.body);
  }

  return {
    MAX_SLUG_LEN:              MAX_SLUG_LEN,
    MAX_TITLE_LEN:             MAX_TITLE_LEN,
    MAX_BODY_LEN:              MAX_BODY_LEN,
    MAX_META_DESCRIPTION_LEN:  MAX_META_DESCRIPTION_LEN,
    MAX_META_KEYWORDS_LEN:     MAX_META_KEYWORDS_LEN,
    ALLOWED_LAYOUTS:           ALLOWED_LAYOUTS,
    ALLOWED_STATUSES:          ALLOWED_STATUSES,

    defineDraft:    defineDraft,
    publish:        publish,
    unpublish:      unpublish,
    archive:        archive,
    restore:        restore,
    update:         update,
    get:            get,
    getPublished:   getPublished,
    listPublished:  listPublished,
    listDrafts:     listDrafts,
    listArchived:   listArchived,
    renderHtml:     renderHtml,
  };
}

module.exports = {
  create:                    create,
  MAX_SLUG_LEN:              MAX_SLUG_LEN,
  MAX_TITLE_LEN:             MAX_TITLE_LEN,
  MAX_BODY_LEN:              MAX_BODY_LEN,
  MAX_META_DESCRIPTION_LEN:  MAX_META_DESCRIPTION_LEN,
  MAX_META_KEYWORDS_LEN:     MAX_META_KEYWORDS_LEN,
  ALLOWED_LAYOUTS:           ALLOWED_LAYOUTS,
  ALLOWED_STATUSES:          ALLOWED_STATUSES,
};
