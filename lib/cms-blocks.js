"use strict";
/**
 * @module shop.cmsBlocks
 * @title  CMS blocks — operator-editable content slots in storefront templates
 *
 * @intro
 *   A closed catalogue of operator-editable content slots embedded
 *   in the server-rendered storefront templates. Where storefront
 *   pages own whole URLs ("about", "shipping"), cms blocks own
 *   *fragments* that the templates reach for at render time:
 *
 *     header_announcement   — the strip rendered above the site nav.
 *     hero                  — the homepage hero copy block.
 *     category_hero         — the per-category-page hero copy.
 *     pdp_bottom            — the slot under the product-detail copy.
 *     footer_column         — operator-authored footer column copy.
 *     checkout_success      — the "thanks for ordering" body.
 *     inline                — generic fall-through for template-local
 *                              slots an operator wires up ad-hoc.
 *
 *   Each block carries:
 *     - a stable operator-chosen `key` (PK),
 *     - a `default_body` authored in a Markdown subset (the baseline
 *       rendered when no localization matches the requested locale),
 *     - a `layout` token from the closed enum above (so the template
 *       picks the matching wrapper),
 *     - an `archived_at` flag (archived blocks render as ""),
 *     - a list of `cms_block_localizations` rows, each carrying
 *       a `locale`, `body`, monotonic `version`, and an optional
 *       (publish_at, expire_at) window.
 *
 *   Version semantics:
 *     Every `setLocalized` call appends a new row with
 *     `version = MAX(version) + 1` for the (key, locale) pair. The
 *     renderer walks (key, locale) versions newest-first and picks
 *     the first row whose publish window covers `now`. Older
 *     versions stay queryable via `versionsForBlock` so an operator
 *     can roll back by re-authoring the previous body.
 *
 *   Locale fallback:
 *     `getRendered({ key, locale, now? })` walks BCP-47 subtags
 *     right-to-left — "fr-CA" tries "fr-CA", then "fr". If no
 *     localization matches (or the matching localization's publish
 *     window doesn't cover `now`), the renderer falls back to
 *     `default_body`. Archived blocks short-circuit to "".
 *
 *   Composes:
 *     - `b.template.escapeHtml` — every text run from the operator-
 *       authored body lands HTML-escaped in the rendered output. The
 *       in-process Markdown renderer never emits raw operator input.
 *     - `b.safeUrl.parse` — link URLs pass the https-only allowlist
 *       (or `/`-rooted absolute paths). javascript: / data: /
 *       protocol-relative `//host` URLs are dropped at render time;
 *       the anchor text falls back to inert escaped text.
 *     - `b.uuid.v7` — localization row ids.
 *
 *   Surface:
 *     - `create({ query?, translations? })` — factory. `query`
 *       defaults to `b.externalDb.query`. `translations` is an
 *       optional reference to the `translations` primitive instance
 *       so a future caller can compose locale chain helpers; the
 *       cmsBlocks primitive computes its own fallback chain locally.
 *     - `defineBlock({ key, default_body, layout })` — idempotent.
 *       New key inserts a block; existing key updates default_body
 *       + layout (and clears archived_at).
 *     - `setLocalized({ key, locale, body, publish_at?, expire_at? })`
 *       — appends a new version row for (key, locale).
 *     - `getRendered({ key, locale, now? })` — async; returns HTML
 *       for the block. Locale fallback + publish-window respected;
 *       archived blocks render "".
 *     - `listBlocks({ include_archived? })` — enumerate every block.
 *     - `archiveBlock(key)` — stamps archived_at; renderer returns
 *       "" for the block until the operator re-defines it.
 *     - `update(key, patch)` — patches default_body / layout only;
 *       refuses every other column.
 *     - `versionsForBlock({ key, locale })` — version history for a
 *       (key, locale) pair, newest first.
 *
 *   Storage:
 *     - `cms_blocks`               (migration `0079_cms_blocks.sql`).
 *     - `cms_block_localizations`  (same migration).
 *
 * @primitive cmsBlocks
 * @related   b.template.escapeHtml, b.safeUrl, b.uuid
 */

var MAX_KEY_LEN    = 80;
var MAX_BODY_LEN   = 50000;
var MAX_LOCALE_LEN = 35;     // BCP-47 cap is 35 chars

var ALLOWED_LAYOUTS = Object.freeze([
  "header_announcement",
  "hero",
  "category_hero",
  "pdp_bottom",
  "footer_column",
  "checkout_success",
  "inline",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "default_body",
  "layout",
]);

// Key shape mirrors the rest of the storefront primitives — alnum
// leading character, alnum + dot + hyphen + underscore tail, capped
// length. The key reaches operator logs + an admin URL so the shape
// stays narrow.
var KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// BCP-47 locale shape — language (2-3 letters) + optional subtags.
// Lowercase the input before matching against this regex so the
// fallback walker sees a stable canonical form.
var LOCALE_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

// Refuse C0 control bytes + DEL in operator-authored bodies. LF / CR
// / tab are allowed — operators author multi-line Markdown.

// Zero-width / direction-override family. Spelled with \u-escapes
// so ESLint's no-irregular-whitespace stays happy. Same defence as
// the rest of the shop primitives.

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- validators ---------------------------------------------------------

function _key(s) {
  if (typeof s !== "string" || !KEY_RE.test(s)) {
    throw new TypeError("cmsBlocks: key must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_KEY_LEN + " chars)");
  }
  return s;
}

function _body(s, label) {
  label = label || "body";
  if (typeof s !== "string" || !s.length || s.length > MAX_BODY_LEN) {
    throw new TypeError("cmsBlocks: " + label + " must be a non-empty string <= " + MAX_BODY_LEN + " chars");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("cmsBlocks: " + label + " contains control bytes");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("cmsBlocks: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _layout(s) {
  if (s == null) return "inline";
  if (typeof s !== "string" || ALLOWED_LAYOUTS.indexOf(s) === -1) {
    throw new TypeError("cmsBlocks: layout must be one of " + JSON.stringify(ALLOWED_LAYOUTS));
  }
  return s;
}

function _locale(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_LOCALE_LEN) {
    throw new TypeError("cmsBlocks: locale must be a non-empty BCP-47 string <= " + MAX_LOCALE_LEN + " chars");
  }
  var canonical = s.toLowerCase();
  if (!LOCALE_RE.test(canonical)) {
    throw new TypeError("cmsBlocks: locale " + JSON.stringify(s) + " is not a valid BCP-47 shape");
  }
  return canonical;
}

function _publishWindowField(v, label) {
  if (v == null) return null;
  if (typeof v !== "number" || !isFinite(v) || v < 0 || Math.floor(v) !== v) {
    throw new TypeError("cmsBlocks: " + label + " must be a non-negative integer epoch-ms (or null)");
  }
  return v;
}

function _now() { return Date.now(); }

// Walk a canonical BCP-47 locale right-to-left, dropping trailing
// subtags. "fr-ca" -> ["fr-ca", "fr"]. The default_body baseline is
// handled by the caller (this returns only the localization keys to
// search).
function _fallbackChain(locale) {
  var chain = [];
  var cur = locale;
  while (cur && cur.length) {
    chain.push(cur);
    var idx = cur.lastIndexOf("-");
    if (idx === -1) break;
    cur = cur.slice(0, idx);
  }
  return chain;
}

// ---- row hydration ------------------------------------------------------

function _hydrateBlockRow(r) {
  if (!r) return null;
  return {
    key:          r.key,
    default_body: r.default_body,
    layout:       r.layout,
    archived_at:  r.archived_at == null ? null : Number(r.archived_at),
    created_at:   Number(r.created_at),
    updated_at:   Number(r.updated_at),
  };
}

function _hydrateLocalizationRow(r) {
  if (!r) return null;
  return {
    id:         r.id,
    block_key:  r.block_key,
    locale:     r.locale,
    body:       r.body,
    version:    Number(r.version),
    publish_at: r.publish_at == null ? null : Number(r.publish_at),
    expire_at:  r.expire_at  == null ? null : Number(r.expire_at),
    created_at: Number(r.created_at),
  };
}

// ---- Markdown to HTML ---------------------------------------------------
//
// A minimal in-process Markdown subset, hand-written to keep the
// primitive in the zero-runtime-deps envelope. Mirrors the storefront
// pages renderer: paragraphs, headings, lists, links, inline code,
// emphasis. Every text run is HTML-escaped via `b.template.escapeHtml`.
// Every link URL passes through `b.safeUrl.parse` (https-only) OR an
// allow-list for `/`-rooted absolute paths. Any URL that fails the
// gate is dropped from the rendered HTML; the anchor text falls back
// to inert escaped text. Raw HTML in the body is never passed through
// — any `<` lands as `&lt;`.

function _esc(s) {
  return b.template.escapeHtml(s);
}

function _safeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (textGuard.hasCodepointThreat(url, { zeroWidth: "reject" })) return null;
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

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Optional translations primitive reference. The cmsBlocks
  // primitive computes its own locale fallback chain locally; the
  // handle is kept on the factory so a future caller can pipe
  // resource-level translations through the same render path
  // without re-plumbing the dependency.
  var translationsRef = opts.translations || null;
  void translationsRef;

  // -- defineBlock ------------------------------------------------------
  //
  // Idempotent. Inserts a new (key) row OR updates the default_body /
  // layout of an existing row (and clears archived_at so a previously-
  // retired key comes back alive). Localizations are not touched —
  // the operator can re-author a block's default copy without
  // disturbing the version history of any locale.

  async function defineBlock(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("cmsBlocks.defineBlock: input object required");
    }
    var key          = _key(input.key);
    var defaultBody  = _body(input.default_body, "default_body");
    var layout       = _layout(input.layout);
    var ts           = _now();

    var existing = await getBlock(key);
    if (existing) {
      await query(
        "UPDATE cms_blocks SET default_body = ?1, layout = ?2, archived_at = NULL, updated_at = ?3 WHERE key = ?4",
        [defaultBody, layout, ts, key],
      );
    } else {
      await query(
        "INSERT INTO cms_blocks (key, default_body, layout, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
        [key, defaultBody, layout, ts],
      );
    }
    return await getBlock(key);
  }

  // -- getBlock ---------------------------------------------------------

  async function getBlock(key) {
    _key(key);
    var r = (await query(
      "SELECT * FROM cms_blocks WHERE key = ?1 LIMIT 1",
      [key],
    )).rows[0];
    return _hydrateBlockRow(r);
  }

  // -- listBlocks -------------------------------------------------------

  async function listBlocks(input) {
    input = input || {};
    var includeArchived = input.include_archived === true;
    var sql = includeArchived
      ? "SELECT * FROM cms_blocks ORDER BY key ASC"
      : "SELECT * FROM cms_blocks WHERE archived_at IS NULL ORDER BY key ASC";
    var rows = (await query(sql, [])).rows;
    return rows.map(_hydrateBlockRow);
  }

  // -- archiveBlock -----------------------------------------------------

  async function archiveBlock(key) {
    _key(key);
    var existing = await getBlock(key);
    if (!existing) {
      throw new TypeError("cmsBlocks.archiveBlock: key " + JSON.stringify(key) + " not found");
    }
    var ts = _now();
    await query(
      "UPDATE cms_blocks SET archived_at = ?1, updated_at = ?1 WHERE key = ?2",
      [ts, key],
    );
    return await getBlock(key);
  }

  // -- update -----------------------------------------------------------

  async function update(key, patch) {
    _key(key);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("cmsBlocks.update: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("cmsBlocks.update: patch must include at least one column");
    }
    var existing = await getBlock(key);
    if (!existing) {
      throw new TypeError("cmsBlocks.update: key " + JSON.stringify(key) + " not found");
    }
    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("cmsBlocks.update: unsupported column " + JSON.stringify(col));
      }
      var v;
      if (col === "default_body") { v = _body(patch[col], "default_body"); }
      else /* layout */            { v = _layout(patch[col]); }
      sets.push(col + " = ?" + idx);
      params.push(v);
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(key);
    var r = await query(
      "UPDATE cms_blocks SET " + sets.join(", ") + " WHERE key = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError("cmsBlocks.update: key " + JSON.stringify(key) + " not found");
    }
    return await getBlock(key);
  }

  // -- setLocalized -----------------------------------------------------
  //
  // Append a new version row for (key, locale). The version number
  // is `MAX(version) + 1` across the existing rows for the pair (1
  // for the first localization). Publish window columns are
  // optional; null means "no bound."

  async function setLocalized(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("cmsBlocks.setLocalized: input object required");
    }
    var key       = _key(input.key);
    var locale    = _locale(input.locale);
    var body      = _body(input.body, "body");
    var publishAt = _publishWindowField(input.publish_at, "publish_at");
    var expireAt  = _publishWindowField(input.expire_at,  "expire_at");
    if (publishAt != null && expireAt != null && expireAt <= publishAt) {
      throw new TypeError("cmsBlocks.setLocalized: expire_at must be strictly greater than publish_at");
    }
    var existing = await getBlock(key);
    if (!existing) {
      throw new TypeError("cmsBlocks.setLocalized: key " + JSON.stringify(key) + " not found");
    }
    if (existing.archived_at != null) {
      throw new TypeError("cmsBlocks.setLocalized: key " + JSON.stringify(key) + " is archived; restore via defineBlock first");
    }

    var maxRow = (await query(
      "SELECT MAX(version) AS max_v FROM cms_block_localizations WHERE block_key = ?1 AND locale = ?2",
      [key, locale],
    )).rows[0];
    var nextVersion = maxRow && maxRow.max_v != null ? Number(maxRow.max_v) + 1 : 1;

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO cms_block_localizations (id, block_key, locale, body, version, publish_at, expire_at, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [id, key, locale, body, nextVersion, publishAt, expireAt, ts],
    );
    var row = (await query(
      "SELECT * FROM cms_block_localizations WHERE id = ?1 LIMIT 1",
      [id],
    )).rows[0];
    return _hydrateLocalizationRow(row);
  }

  // -- versionsForBlock -------------------------------------------------

  async function versionsForBlock(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("cmsBlocks.versionsForBlock: input object required");
    }
    var key    = _key(input.key);
    var locale = _locale(input.locale);
    var rows = (await query(
      "SELECT * FROM cms_block_localizations WHERE block_key = ?1 AND locale = ?2 " +
      "ORDER BY version DESC",
      [key, locale],
    )).rows;
    return rows.map(_hydrateLocalizationRow);
  }

  // -- getRendered ------------------------------------------------------
  //
  // Resolve the active body for (key, locale, now), render it to
  // HTML, and return the string. Resolution order:
  //
  //   1. Archived block        -> "" (short-circuit).
  //   2. Walk locale fallback chain (right-to-left subtag strip);
  //      for each candidate locale, read the highest-version row
  //      whose publish window covers `now`. First match wins.
  //   3. No localization matches -> render default_body.
  //
  // The publish window check: a row is active iff
  //   (publish_at IS NULL OR publish_at <= now) AND
  //   (expire_at  IS NULL OR expire_at  >  now).

  async function getRendered(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("cmsBlocks.getRendered: input object required");
    }
    var key    = _key(input.key);
    var locale = _locale(input.locale);
    var now    = input.now == null ? _now() : _publishWindowField(input.now, "now");

    var block = await getBlock(key);
    if (!block) {
      throw new TypeError("cmsBlocks.getRendered: key " + JSON.stringify(key) + " not found");
    }
    if (block.archived_at != null) return "";

    var chain = _fallbackChain(locale);
    for (var i = 0; i < chain.length; i += 1) {
      var candidate = chain[i];
      var rows = (await query(
        "SELECT * FROM cms_block_localizations WHERE block_key = ?1 AND locale = ?2 " +
        "AND (publish_at IS NULL OR publish_at <= ?3) " +
        "AND (expire_at  IS NULL OR expire_at  >  ?3) " +
        "ORDER BY version DESC LIMIT 1",
        [key, candidate, now],
      )).rows;
      if (rows.length) {
        return _renderMarkdown(rows[0].body);
      }
    }
    return _renderMarkdown(block.default_body);
  }

  return {
    MAX_KEY_LEN:        MAX_KEY_LEN,
    MAX_BODY_LEN:       MAX_BODY_LEN,
    MAX_LOCALE_LEN:     MAX_LOCALE_LEN,
    ALLOWED_LAYOUTS:    ALLOWED_LAYOUTS,

    defineBlock:        defineBlock,
    setLocalized:       setLocalized,
    getRendered:        getRendered,
    listBlocks:         listBlocks,
    archiveBlock:       archiveBlock,
    update:             update,
    versionsForBlock:   versionsForBlock,
    getBlock:           getBlock,
  };
}

module.exports = {
  create:           create,
  MAX_KEY_LEN:      MAX_KEY_LEN,
  MAX_BODY_LEN:     MAX_BODY_LEN,
  MAX_LOCALE_LEN:   MAX_LOCALE_LEN,
  ALLOWED_LAYOUTS:  ALLOWED_LAYOUTS,
};
