"use strict";
/**
 * @module shop.blogArticles
 * @title  Blog articles — operator-published editorial storefront content
 *
 * @intro
 *   Editorial blog separate from `storefrontPages` (legal / about /
 *   shipping — the long-tail of fixed slots every shop carries). The
 *   blog is cadence-driven: posts shipped over time, attributed to an
 *   author, tagged for browsability, linked back to the catalog so a
 *   "five-mistakes-buying-X" post can surface the matching SKUs at
 *   the bottom of the article.
 *
 *   Each article carries:
 *     - a stable URL-friendly `slug` (the PK; appears in /blog/<slug>),
 *     - a `title` shown in the post header and the `<title>` tag,
 *     - a `body` authored in the in-process Markdown subset shared
 *       with cmsBlocks / knowledgeBase / storefrontPages,
 *     - an `author_id` referencing the operator's authors directory
 *       (this primitive does NOT own the author entity — author rows
 *       live wherever the operator chose to model the editorial team),
 *     - `tags` (free-form string array) for the "more like this" rail
 *       and the related-articles ranker,
 *     - `featured_product_ids` linking back to the catalog,
 *     - an optional `hero_image_url` (https-only, gated by
 *       `b.safeUrl.parse`),
 *     - `meta_description` + `meta_keywords` for the article's
 *       `<head>` SEO surface,
 *     - a `status` FSM (draft -> published -> archived) with a restore
 *       path back to draft.
 *
 *   The publish FSM:
 *
 *     draft     --publish--   published
 *     published --unpublish-- draft
 *     published --archive---  archived
 *     archived  --restore---  draft
 *
 *     Every other transition is refused with an error that names the
 *     current state and the attempted action so an operator running a
 *     publish sweep can see exactly which post is wedged.
 *
 *   Composes:
 *     - `b.template.escapeHtml` — every text run from the operator-
 *       authored body lands as HTML-escaped output in `renderHtml`.
 *     - `b.safeUrl.parse` — `hero_image_url` is https-only; inline
 *       `[text](url)` link URLs pass the https-only allowlist (or
 *       `/`-rooted absolute paths). A link carrying `javascript:` /
 *       `data:` / protocol-relative `//host` is dropped from the
 *       rendered HTML and the anchor text falls back to inert escaped
 *       text.
 *     - `b.crypto.namespaceHash` — session-id hashing on `recordView`.
 *     - `b.uuid.v7` — row ids on view-log rows.
 *     - `b.pagination` — HMAC-tagged tuple cursor for `listPublished`.
 *
 *   Monotonic per-process clock: two writes in the same millisecond
 *   would tie on `published_at` / `updated_at` and make a sort-by-
 *   timestamp read ambiguous. `_now` bumps to `prior + 1` on collision
 *   so the (published_at DESC, slug DESC) listPublished cursor +
 *   popularArticles aggregation carry a strict per-process ordering.
 *
 *   Surface:
 *     - `create({ query?, customers? })` — factory. `query` is
 *       optional; absent it the primitive talks to `b.externalDb.query`
 *       directly. `customers` is reserved for future cross-primitive
 *       composition (e.g. byline -> customer-of-record lookups).
 *     - `createDraft({ slug, title, body, author_id, tags?,
 *                      featured_product_ids?, hero_image_url?,
 *                      meta_description?, meta_keywords? })` — insert
 *       a row in `draft` status.
 *     - `publish(slug)` / `unpublish(slug)` / `archive(slug)` /
 *       `restore(slug)` — FSM transitions.
 *     - `update(slug, patch)` — patch any of the editable columns
 *       (title / body / author_id / tags / featured_product_ids /
 *       hero_image_url / meta_description / meta_keywords).
 *     - `get(slug)` — any status. `getPublished(slug)` — published
 *       only (returns null for any other state).
 *     - `listPublished({ tag?, cursor?, limit? })` — newest-published-
 *       first cursor-paginated.
 *     - `listDrafts()` / `listArchived()` — enumerate by FSM state.
 *     - `renderHtml({ slug })` — async; reads the post by slug and
 *       returns sanitized HTML from the Markdown body. Missing slug
 *       throws (renderHtml is config-tier: a missing slug is an
 *       operator bug).
 *     - `relatedArticles({ slug, limit? })` — top-N published posts
 *       ranked by tag-overlap with the requested slug (the requested
 *       slug itself is excluded; archived / unpublished excluded).
 *     - `byAuthor({ author_id, status?, limit? })` — every article
 *       attributed to an author.
 *     - `recordView({ slug, session_id? })` — append-only view log;
 *       bumps slug-wide view_count.
 *     - `popularArticles({ from, to, limit? })` — top-N over a closed
 *       time window.
 *
 *   Storage:
 *     - `blog_articles`, `blog_article_views` (migration
 *       `0189_blog_articles.sql`).
 *
 * @primitive blogArticles
 * @related   b.template.escapeHtml, b.safeUrl, b.crypto.namespaceHash,
 *            b.uuid.v7, b.pagination, shop.storefrontPages,
 *            shop.knowledgeBase, shop.cmsBlocks
 */

var MAX_SLUG_LEN              = 120;
var MAX_TITLE_LEN             = 200;
var MAX_BODY_LEN              = 200000;
var MAX_AUTHOR_ID_LEN         = 80;
var MAX_TAG_LEN               = 40;
var MAX_TAG_COUNT             = 24;
var MAX_FEATURED_PRODUCT_LEN  = 80;
var MAX_FEATURED_PRODUCT_COUNT = 24;
var MAX_HERO_IMAGE_URL_LEN    = 2048;
var MAX_META_DESCRIPTION_LEN  = 320;
var MAX_META_KEYWORDS_LEN     = 320;
var MAX_LIST_LIMIT            = 100;
var DEFAULT_LIST_LIMIT        = 25;
var MAX_RELATED_LIMIT         = 50;
var DEFAULT_RELATED_LIMIT     = 5;
var MAX_POPULAR_LIMIT         = 100;
var DEFAULT_POPULAR_LIMIT     = 10;
var MAX_BY_AUTHOR_LIMIT       = 200;
var DEFAULT_BY_AUTHOR_LIMIT   = 50;

var ALLOWED_STATUSES = Object.freeze([
  "draft",
  "published",
  "archived",
]);

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "body",
  "author_id",
  "tags",
  "featured_product_ids",
  "hero_image_url",
  "meta_description",
  "meta_keywords",
]);

var VIEW_NAMESPACE = "blog-article-view-session";

// listPublished cursor order: newest-published-first, slug as the
// stable tiebreaker so two posts published in the same millisecond
// still order deterministically.
var LIST_ORDER_KEY = ["published_at:desc", "slug:desc"];

// Slug shape mirrors knowledgeBase: lowercase alnum + dash, no
// leading/trailing dash, capped length. The slug reaches operator
// logs + the public storefront URL `/blog/<slug>`.
var SLUG_RE        = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var TAG_RE         = /^[a-z0-9][a-z0-9_-]*$/;
var AUTHOR_ID_RE   = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
var PRODUCT_ID_RE  = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

// Refuse C0 control bytes + DEL in operator-authored strings. The
// body permits LF (Markdown is line-oriented); single-line fields
// refuse LF / CR so they can't smuggle a second line into a post
// header / meta tag / hero-image attribute.

// Zero-width / direction-override family — spelled with \u-escapes so
// ESLint's no-irregular-whitespace stays happy.

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven writes can land in the same millisecond on fast
// machines. Bumping by 1ms on a tie keeps the timeline strictly
// increasing so the (published_at DESC, slug DESC) listPublished
// cursor + popularArticles aggregation return events in the order
// they were issued.

var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- validators --------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("blogArticles: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("blogArticles: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("blogArticles: slug must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_TITLE_LEN) {
    throw new TypeError("blogArticles: title must be a non-empty string <= " + MAX_TITLE_LEN + " chars");
  }
  textGuard.freeText(s, "blogArticles: title", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

function _body(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_BODY_LEN) {
    throw new TypeError("blogArticles: body must be a non-empty string <= " + MAX_BODY_LEN + " chars");
  }
  textGuard.freeText(s, "blogArticles: body", { zeroWidth: "reject" });
  return s;
}

function _authorId(s) {
  if (typeof s !== "string" || !s.length || s.length > MAX_AUTHOR_ID_LEN) {
    throw new TypeError("blogArticles: author_id must be a non-empty string <= " + MAX_AUTHOR_ID_LEN + " chars");
  }
  if (!AUTHOR_ID_RE.test(s)) {
    throw new TypeError("blogArticles: author_id must match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/");
  }
  return s;
}

function _tagList(input, label) {
  label = label || "tags";
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("blogArticles: " + label + " must be an array of strings");
  }
  if (input.length > MAX_TAG_COUNT) {
    throw new TypeError("blogArticles: " + label + " must contain <= " + MAX_TAG_COUNT + " entries");
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < input.length; i += 1) {
    var t = input[i];
    if (typeof t !== "string" || !t.length) {
      throw new TypeError("blogArticles: " + label + "[" + i + "] must be a non-empty string");
    }
    if (t.length > MAX_TAG_LEN) {
      throw new TypeError("blogArticles: " + label + "[" + i + "] must be <= " + MAX_TAG_LEN + " characters");
    }
    if (!TAG_RE.test(t)) {
      throw new TypeError("blogArticles: " + label + "[" + i + "] must match /^[a-z0-9][a-z0-9_-]*$/");
    }
    if (seen[t]) continue;
    seen[t] = 1;
    out.push(t);
  }
  return out;
}

function _featuredProductIds(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("blogArticles: featured_product_ids must be an array of strings");
  }
  if (input.length > MAX_FEATURED_PRODUCT_COUNT) {
    throw new TypeError("blogArticles: featured_product_ids must contain <= " + MAX_FEATURED_PRODUCT_COUNT + " entries");
  }
  var seen = Object.create(null);
  var out  = [];
  for (var i = 0; i < input.length; i += 1) {
    var p = input[i];
    if (typeof p !== "string" || !p.length) {
      throw new TypeError("blogArticles: featured_product_ids[" + i + "] must be a non-empty string");
    }
    if (p.length > MAX_FEATURED_PRODUCT_LEN) {
      throw new TypeError("blogArticles: featured_product_ids[" + i + "] must be <= " + MAX_FEATURED_PRODUCT_LEN + " characters");
    }
    if (!PRODUCT_ID_RE.test(p)) {
      throw new TypeError("blogArticles: featured_product_ids[" + i + "] must match /^[A-Za-z0-9][A-Za-z0-9._:-]*$/");
    }
    if (seen[p]) continue;
    seen[p] = 1;
    out.push(p);
  }
  return out;
}

// hero_image_url passes the same https-only / `/`-rooted-absolute
// gate as announcementBar's link_url. Protocol-relative
// `//host/img.png` is refused so a CDN mis-config can't downgrade
// the asset. `javascript:` / `data:` / `vbscript:` are refused by
// safeUrl's default protocol allowlist.
function _heroImageUrl(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("blogArticles: hero_image_url must be a non-empty string");
  }
  if (s.length > MAX_HERO_IMAGE_URL_LEN) {
    throw new TypeError("blogArticles: hero_image_url must be <= " + MAX_HERO_IMAGE_URL_LEN + " chars");
  }
  textGuard.freeText(s, "blogArticles: hero_image_url", { singleLine: "reject", zeroWidth: "reject" });
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError("blogArticles: hero_image_url protocol-relative `//host/...` refused — use absolute https://");
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("blogArticles: hero_image_url path must not contain '..'");
    }
    return s;
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError("blogArticles: hero_image_url — " + (e && e.message || "must be https:// or a /-rooted absolute path"));
  }
  return s;
}

function _metaLine(s, label, maxLen) {
  if (s == null) return null;
  if (typeof s !== "string" || s.length > maxLen) {
    throw new TypeError("blogArticles: " + label + " must be a string <= " + maxLen + " chars");
  }
  if (textGuard.hasCodepointThreat(s, { singleLine: "reject" })) {
    throw new TypeError("blogArticles: " + label + " contains control bytes (incl. CR/LF)");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("blogArticles: " + label + " contains zero-width / direction-override characters");
  }
  return s;
}

function _limit(n, max, def, label) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("blogArticles: " + label + " must be an integer 1..." + max);
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("blogArticles." + label + ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("blogArticles." + label + ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError("blogArticles." + label + ": from must be <= to");
  }
}

function _sessionIdRaw(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("blogArticles: session_id must be a non-empty string");
  }
  if (s.length > 256) {
    throw new TypeError("blogArticles: session_id must be <= 256 characters");
  }
  textGuard.freeText(s, "blogArticles: session_id", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

// ---- row hydration -----------------------------------------------------

function _safeJsonArray(s) {
  if (s == null) return [];
  try {
    var parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

function _hydrateRow(r) {
  if (!r) return null;
  return {
    slug:                  r.slug,
    title:                 r.title,
    body:                  r.body,
    author_id:             r.author_id,
    tags:                  _safeJsonArray(r.tags_json),
    featured_product_ids:  _safeJsonArray(r.featured_product_ids_json),
    hero_image_url:        r.hero_image_url == null ? null : r.hero_image_url,
    meta_description:      r.meta_description == null ? null : r.meta_description,
    meta_keywords:         r.meta_keywords    == null ? null : r.meta_keywords,
    status:                r.status,
    published_at:          r.published_at == null ? null : Number(r.published_at),
    archived_at:           r.archived_at  == null ? null : Number(r.archived_at),
    view_count:            Number(r.view_count) || 0,
    created_at:            Number(r.created_at),
    updated_at:            Number(r.updated_at),
  };
}

// ---- Markdown to HTML --------------------------------------------------
//
// Minimal in-process Markdown subset shared with cmsBlocks /
// knowledgeBase / storefrontPages. Every text run is HTML-escaped via
// `b.template.escapeHtml`; every link URL passes through
// `b.safeUrl.parse` (https-only) OR an allow-list for `/`-rooted
// absolute paths. Any URL that fails the gate is dropped from the
// rendered HTML; the anchor text falls back to inert escaped text.
// Raw HTML in the body is never passed through — any `<` lands as
// `&lt;`. That's the whole defense against XSS: every operator-input
// byte is HTML-escaped before it reaches the `<article>` of the page.

function _esc(s) {
  return b.template.escapeHtml(s);
}

function _safeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (textGuard.hasCodepointThreat(url, { singleLine: "reject", zeroWidth: "reject" })) return null;
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

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // `customers` is reserved for future cross-primitive composition
  // (e.g. byline -> customer-of-record lookups). The factory accepts
  // and ignores it today so existing call-sites that pass the
  // operator-wide customers handle don't fail when the wiring lands.
  var _customers = opts.customers || null;
  if (_customers != null && typeof _customers !== "object") {
    throw new TypeError("blogArticles.create: opts.customers must be a primitive instance or null");
  }

  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("blogArticles.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "blog-articles-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("blogArticles." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("blogArticles." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("blogArticles." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [Number(last.published_at), last.slug],
      forward:  true,
    }, cursorSecret);
  }

  // ---- createDraft ----------------------------------------------------

  async function createDraft(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("blogArticles.createDraft: input object required");
    }
    var slug                = _slug(input.slug);
    var title               = _title(input.title);
    var body                = _body(input.body);
    var authorId            = _authorId(input.author_id);
    var tags                = _tagList(input.tags, "tags");
    var featuredProductIds  = _featuredProductIds(input.featured_product_ids);
    var heroImageUrl        = _heroImageUrl(input.hero_image_url);
    var metaDescription     = _metaLine(input.meta_description, "meta_description", MAX_META_DESCRIPTION_LEN);
    var metaKeywords        = _metaLine(input.meta_keywords,    "meta_keywords",    MAX_META_KEYWORDS_LEN);

    // Refuse a re-insert against an existing slug — the operator
    // should call `update` instead. A silent overwrite would discard
    // the FSM state + the historical published_at stamp.
    var existing = await get(slug);
    if (existing) {
      var err = new Error("blogArticles.createDraft: slug " + JSON.stringify(slug) + " already exists");
      err.code = "BLOG_ARTICLE_EXISTS";
      throw err;
    }

    var ts = _now();
    await query(
      "INSERT INTO blog_articles (slug, title, body, author_id, tags_json, " +
      "featured_product_ids_json, hero_image_url, meta_description, meta_keywords, " +
      "status, published_at, archived_at, view_count, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'draft', NULL, NULL, 0, ?10, ?10)",
      [
        slug,
        title,
        body,
        authorId,
        JSON.stringify(tags),
        JSON.stringify(featuredProductIds),
        heroImageUrl,
        metaDescription,
        metaKeywords,
        ts,
      ],
    );
    return await get(slug);
  }

  // ---- get / getPublished --------------------------------------------

  async function get(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM blog_articles WHERE slug = ?1 LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  async function getPublished(slug) {
    _slug(slug);
    var r = (await query(
      "SELECT * FROM blog_articles WHERE slug = ?1 AND status = 'published' LIMIT 1",
      [slug],
    )).rows[0];
    return _hydrateRow(r);
  }

  // ---- list helpers ---------------------------------------------------

  // listPublished: newest-published-first cursor-paginated. Optional
  // tag filter walks the corpus and filters in JS (the operator-
  // facing blog stays small enough that the JS path is the right
  // tradeoff; pushing a JSON-array LIKE into SQLite buys nothing on a
  // corpus of this size and complicates the index plan).
  async function listPublished(listOpts) {
    listOpts = listOpts || {};
    var limit       = _limit(listOpts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, "limit");
    var cursorVals  = _decodeCursor(listOpts.cursor, "listPublished");
    var tagFilter   = listOpts.tag == null ? null : _tagList([listOpts.tag], "tag")[0];

    var where  = ["status = 'published'"];
    var params = [];
    var idx    = 1;

    if (cursorVals) {
      var pPublished = idx;
      var pSlug = idx + 1;
      where.push(
        "(published_at < ?" + pPublished + " OR " +
        "(published_at = ?" + pPublished + " AND slug < ?" + pSlug + "))"
      );
      params.push(cursorVals[0], cursorVals[1]);
      idx += 2;
    }
    // When the tag filter is active, fetch more rows than the limit
    // so the post-filter still yields `limit` rows for the cursor.
    // The corpus is editorial-sized; the over-fetch is bounded by
    // MAX_LIST_LIMIT.
    var fetchLimit = tagFilter ? Math.min(MAX_LIST_LIMIT, limit * 4) : limit;
    params.push(fetchLimit);
    var sql = "SELECT * FROM blog_articles WHERE " + where.join(" AND ") +
              " ORDER BY published_at DESC, slug DESC LIMIT ?" + idx;
    var r = await query(sql, params);

    var rows = r.rows;
    if (tagFilter) {
      rows = rows.filter(function (row) {
        return _safeJsonArray(row.tags_json).indexOf(tagFilter) !== -1;
      });
    }
    if (rows.length > limit) rows = rows.slice(0, limit);

    var hydrated   = rows.map(_hydrateRow);
    var nextCursor = _encodeNext(rows, limit);
    return { rows: hydrated, next_cursor: nextCursor };
  }

  async function listDrafts() {
    var rows = (await query(
      "SELECT * FROM blog_articles WHERE status = 'draft' " +
      "ORDER BY created_at ASC, slug ASC",
      [],
    )).rows;
    return rows.map(_hydrateRow);
  }

  async function listArchived() {
    var rows = (await query(
      "SELECT * FROM blog_articles WHERE status = 'archived' " +
      "ORDER BY archived_at DESC, slug ASC",
      [],
    )).rows;
    return rows.map(_hydrateRow);
  }

  // ---- update ---------------------------------------------------------
  //
  // Patch any subset of the editable columns. Status / FSM columns are
  // NOT editable here — they move via publish / unpublish / archive /
  // restore. updated_at is stamped on every successful patch.

  async function update(slug, patch) {
    _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("blogArticles.update: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError("blogArticles.update: patch must include at least one column");
    }

    var current = await get(slug);
    if (!current) {
      var nfErr = new Error("blogArticles.update: slug " + JSON.stringify(slug) + " not found");
      nfErr.code = "BLOG_ARTICLE_NOT_FOUND";
      throw nfErr;
    }

    var sets   = [];
    var params = [];
    var idx    = 1;

    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH_COLUMNS.indexOf(col) === -1) {
        throw new TypeError("blogArticles.update: unsupported column " + JSON.stringify(col));
      }
      var v;
      var dbCol = col;
      if      (col === "title")             { v = _title(patch[col]); }
      else if (col === "body")              { v = _body(patch[col]); }
      else if (col === "author_id")         { v = _authorId(patch[col]); }
      else if (col === "tags")              { v = JSON.stringify(_tagList(patch[col], "tags")); dbCol = "tags_json"; }
      else if (col === "featured_product_ids") {
        v = JSON.stringify(_featuredProductIds(patch[col]));
        dbCol = "featured_product_ids_json";
      }
      else if (col === "hero_image_url")    { v = _heroImageUrl(patch[col]); }
      else if (col === "meta_description")  { v = _metaLine(patch[col], "meta_description", MAX_META_DESCRIPTION_LEN); }
      else /* meta_keywords */              { v = _metaLine(patch[col], "meta_keywords",    MAX_META_KEYWORDS_LEN); }
      sets.push(dbCol + " = ?" + idx);
      params.push(v);
      idx += 1;
    }

    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;

    params.push(slug);
    var r = await query(
      "UPDATE blog_articles SET " + sets.join(", ") + " WHERE slug = ?" + idx,
      params,
    );
    if (Number(r.rowCount || 0) === 0) {
      var raceErr = new Error("blogArticles.update: slug " + JSON.stringify(slug) + " not found");
      raceErr.code = "BLOG_ARTICLE_NOT_FOUND";
      throw raceErr;
    }
    return await get(slug);
  }

  // ---- FSM transitions ------------------------------------------------
  //
  // Each transition reads the current row, verifies the from-state is
  // legal for the requested action, and stamps the matching wall-
  // clock column. Illegal transitions throw with a message naming
  // both states so the operator can see what's wedged.

  function _requireState(current, slug, action, allowedFrom) {
    if (!current) {
      var nfErr = new Error("blogArticles." + action + ": slug " + JSON.stringify(slug) + " not found");
      nfErr.code = "BLOG_ARTICLE_NOT_FOUND";
      throw nfErr;
    }
    if (allowedFrom.indexOf(current.status) === -1) {
      var bsErr = new Error(
        "blogArticles." + action + ": slug " + JSON.stringify(slug) +
        " is in status " + JSON.stringify(current.status) +
        " — " + action + " requires status one of " + JSON.stringify(allowedFrom)
      );
      bsErr.code = "BLOG_ARTICLE_BAD_STATE";
      throw bsErr;
    }
  }

  async function publish(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "publish", ["draft"]);
    var ts = _now();
    // First publish: stamp published_at. Re-publishing from draft
    // after an unpublish reuses the existing published_at so the
    // "this post went live on date X" timestamp stays stable across
    // edit cycles.
    var stampClause = current.published_at == null
      ? "published_at = ?1, "
      : "";
    var sql =
      "UPDATE blog_articles SET status = 'published', " + stampClause +
      "archived_at = NULL, updated_at = ?1 WHERE slug = ?2 AND status = 'draft'";
    var r = await query(sql, [ts, slug]);
    if (Number(r.rowCount || 0) === 0) {
      var raceErr = new Error("blogArticles.publish: slug " + JSON.stringify(slug) + " transition race");
      raceErr.code = "BLOG_ARTICLE_BAD_STATE";
      throw raceErr;
    }
    return await get(slug);
  }

  async function unpublish(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "unpublish", ["published"]);
    var ts = _now();
    var r = await query(
      "UPDATE blog_articles SET status = 'draft', updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'published'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var raceErr = new Error("blogArticles.unpublish: slug " + JSON.stringify(slug) + " transition race");
      raceErr.code = "BLOG_ARTICLE_BAD_STATE";
      throw raceErr;
    }
    return await get(slug);
  }

  async function archive(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "archive", ["published"]);
    var ts = _now();
    var r = await query(
      "UPDATE blog_articles SET status = 'archived', archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'published'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var raceErr = new Error("blogArticles.archive: slug " + JSON.stringify(slug) + " transition race");
      raceErr.code = "BLOG_ARTICLE_BAD_STATE";
      throw raceErr;
    }
    return await get(slug);
  }

  async function restore(slug) {
    _slug(slug);
    var current = await get(slug);
    _requireState(current, slug, "restore", ["archived"]);
    var ts = _now();
    var r = await query(
      "UPDATE blog_articles SET status = 'draft', archived_at = NULL, updated_at = ?1 " +
      "WHERE slug = ?2 AND status = 'archived'",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var raceErr = new Error("blogArticles.restore: slug " + JSON.stringify(slug) + " transition race");
      raceErr.code = "BLOG_ARTICLE_BAD_STATE";
      throw raceErr;
    }
    return await get(slug);
  }

  // ---- renderHtml -----------------------------------------------------
  //
  // Reads the post by slug (any status — the route layer decides
  // whether to gate on `getPublished` first) and returns sanitized
  // HTML for the post body. The renderer never emits raw operator
  // input — every text run is HTML-escaped, every URL is checked
  // against `b.safeUrl.parse`, and any URL that doesn't pass the
  // gate is dropped (the anchor text falls back to inert escaped
  // text). The returned HTML is the *body* of the post — the
  // storefront route wraps it in the site layout + hero image.

  async function renderHtml(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("blogArticles.renderHtml: input object required");
    }
    var slug = _slug(input.slug);
    var post = await get(slug);
    if (!post) {
      throw new TypeError("blogArticles.renderHtml: slug " + JSON.stringify(slug) + " not found");
    }
    return _renderMarkdown(post.body);
  }

  // ---- relatedArticles ------------------------------------------------
  //
  // Top-N published posts ranked by tag-overlap with the requested
  // slug. The requested slug itself is excluded; archived and
  // unpublished posts are excluded. Ties on overlap break on
  // published_at DESC (newer wins), then slug DESC (deterministic).
  //
  // The implementation reads every candidate row in JS rather than
  // pushing the ranker into SQL — the editorial corpus stays small
  // enough that the JS path is the right tradeoff and keeps the
  // primitive in the zero-runtime-deps envelope.

  async function relatedArticles(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("blogArticles.relatedArticles: input object required");
    }
    var slug = _slug(input.slug);
    var limit = _limit(input.limit, MAX_RELATED_LIMIT, DEFAULT_RELATED_LIMIT, "limit");

    var anchor = await get(slug);
    if (!anchor) return [];
    var anchorTags = anchor.tags || [];
    if (!anchorTags.length) return [];

    var r = await query(
      "SELECT * FROM blog_articles WHERE status = 'published' AND slug <> ?1",
      [slug],
    );

    var ranked = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      var candidateTags = _safeJsonArray(row.tags_json);
      var overlap = 0;
      for (var t = 0; t < anchorTags.length; t += 1) {
        if (candidateTags.indexOf(anchorTags[t]) !== -1) overlap += 1;
      }
      if (overlap > 0) {
        ranked.push({
          slug:          row.slug,
          title:         row.title,
          author_id:     row.author_id,
          tags:          candidateTags,
          published_at:  row.published_at == null ? null : Number(row.published_at),
          overlap:       overlap,
        });
      }
    }

    ranked.sort(function (a, b) {
      if (b.overlap !== a.overlap) return b.overlap - a.overlap;
      var ap = a.published_at == null ? 0 : a.published_at;
      var bp = b.published_at == null ? 0 : b.published_at;
      if (bp !== ap) return bp - ap;
      if (a.slug < b.slug) return 1;
      if (a.slug > b.slug) return -1;
      return 0;
    });

    return ranked.slice(0, limit);
  }

  // ---- byAuthor -------------------------------------------------------
  //
  // Every post attributed to an author. Defaults to published only;
  // pass `status: "all"` for every state, or one of the FSM states to
  // filter narrowly. Ordered newest-published-first (with created_at
  // as the fallback for draft / archived rows that haven't been
  // published).

  async function byAuthor(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("blogArticles.byAuthor: input object required");
    }
    var authorId = _authorId(input.author_id);
    var limit    = _limit(input.limit, MAX_BY_AUTHOR_LIMIT, DEFAULT_BY_AUTHOR_LIMIT, "limit");
    var status   = input.status == null ? "published" : input.status;
    if (status !== "all" && ALLOWED_STATUSES.indexOf(status) === -1) {
      throw new TypeError("blogArticles.byAuthor: status must be one of "
        + JSON.stringify(ALLOWED_STATUSES.concat(["all"])));
    }

    var sql;
    var params;
    if (status === "all") {
      sql = "SELECT * FROM blog_articles WHERE author_id = ?1 " +
            "ORDER BY COALESCE(published_at, created_at) DESC, slug DESC LIMIT ?2";
      params = [authorId, limit];
    } else {
      sql = "SELECT * FROM blog_articles WHERE author_id = ?1 AND status = ?2 " +
            "ORDER BY COALESCE(published_at, created_at) DESC, slug DESC LIMIT ?3";
      params = [authorId, status, limit];
    }
    var r = await query(sql, params);
    return r.rows.map(_hydrateRow);
  }

  // ---- recordView -----------------------------------------------------
  //
  // Append-only view log. session_id is hashed at the door; the raw
  // value never reaches storage. Bumps the slug-wide view_count.
  // Refuses if the slug doesn't exist (a view against a non-existent
  // post is an operator wiring bug, not a runtime no-op).

  async function recordView(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("blogArticles.recordView: input object required");
    }
    var slug = _slug(input.slug);
    var current = await get(slug);
    if (!current) {
      var nfErr = new Error("blogArticles.recordView: slug " + JSON.stringify(slug) + " not found");
      nfErr.code = "BLOG_ARTICLE_NOT_FOUND";
      throw nfErr;
    }
    var sessionHash = null;
    if (input.session_id != null) {
      sessionHash = b.crypto.namespaceHash(VIEW_NAMESPACE, _sessionIdRaw(input.session_id));
    }
    var ts = _now();
    await query(
      "INSERT INTO blog_article_views (id, slug, session_id_hash, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4)",
      [b.uuid.v7(), slug, sessionHash, ts],
    );
    await query(
      "UPDATE blog_articles SET view_count = view_count + 1 WHERE slug = ?1",
      [slug],
    );
    return { slug: slug, occurred_at: ts };
  }

  // ---- popularArticles ------------------------------------------------
  //
  // Top-N most-viewed posts over a closed time window. Views are
  // counted from blog_article_views.occurred_at against [from, to].
  // Archived + unpublished articles are filtered (a popular post that
  // got unpublished mid-window vanishes from the rail — the operator
  // un-published it for a reason). Sorted by view count DESC, then
  // slug DESC.

  async function popularArticles(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("blogArticles.popularArticles: input object required");
    }
    var from = input.from;
    var to   = input.to;
    _timestampRange(from, to, "popularArticles");
    var limit = _limit(input.limit, MAX_POPULAR_LIMIT, DEFAULT_POPULAR_LIMIT, "limit");

    var sql =
      "SELECT v.slug AS slug, COUNT(*) AS views " +
      "FROM blog_article_views v " +
      "JOIN blog_articles a ON a.slug = v.slug " +
      "WHERE v.occurred_at >= ?1 AND v.occurred_at <= ?2 " +
      "  AND a.status = 'published' " +
      "GROUP BY v.slug " +
      "ORDER BY views DESC, v.slug DESC " +
      "LIMIT ?3";
    var r = await query(sql, [from, to, limit]);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      out.push({ slug: row.slug, views: Number(row.views) });
    }
    return out;
  }

  return {
    MAX_SLUG_LEN:              MAX_SLUG_LEN,
    MAX_TITLE_LEN:             MAX_TITLE_LEN,
    MAX_BODY_LEN:              MAX_BODY_LEN,
    MAX_AUTHOR_ID_LEN:         MAX_AUTHOR_ID_LEN,
    MAX_TAG_LEN:               MAX_TAG_LEN,
    MAX_TAG_COUNT:             MAX_TAG_COUNT,
    MAX_FEATURED_PRODUCT_LEN:  MAX_FEATURED_PRODUCT_LEN,
    MAX_FEATURED_PRODUCT_COUNT: MAX_FEATURED_PRODUCT_COUNT,
    MAX_HERO_IMAGE_URL_LEN:    MAX_HERO_IMAGE_URL_LEN,
    MAX_META_DESCRIPTION_LEN:  MAX_META_DESCRIPTION_LEN,
    MAX_META_KEYWORDS_LEN:     MAX_META_KEYWORDS_LEN,
    MAX_LIST_LIMIT:            MAX_LIST_LIMIT,
    MAX_RELATED_LIMIT:         MAX_RELATED_LIMIT,
    MAX_POPULAR_LIMIT:         MAX_POPULAR_LIMIT,
    MAX_BY_AUTHOR_LIMIT:       MAX_BY_AUTHOR_LIMIT,
    ALLOWED_STATUSES:          ALLOWED_STATUSES,

    createDraft:       createDraft,
    publish:           publish,
    unpublish:         unpublish,
    archive:           archive,
    restore:           restore,
    update:            update,
    get:               get,
    getPublished:      getPublished,
    listPublished:     listPublished,
    listDrafts:        listDrafts,
    listArchived:      listArchived,
    renderHtml:        renderHtml,
    relatedArticles:   relatedArticles,
    byAuthor:          byAuthor,
    recordView:        recordView,
    popularArticles:   popularArticles,
  };
}

module.exports = {
  create:                     create,
  MAX_SLUG_LEN:               MAX_SLUG_LEN,
  MAX_TITLE_LEN:              MAX_TITLE_LEN,
  MAX_BODY_LEN:               MAX_BODY_LEN,
  MAX_AUTHOR_ID_LEN:          MAX_AUTHOR_ID_LEN,
  MAX_TAG_LEN:                MAX_TAG_LEN,
  MAX_TAG_COUNT:              MAX_TAG_COUNT,
  MAX_FEATURED_PRODUCT_LEN:   MAX_FEATURED_PRODUCT_LEN,
  MAX_FEATURED_PRODUCT_COUNT: MAX_FEATURED_PRODUCT_COUNT,
  MAX_HERO_IMAGE_URL_LEN:     MAX_HERO_IMAGE_URL_LEN,
  MAX_META_DESCRIPTION_LEN:   MAX_META_DESCRIPTION_LEN,
  MAX_META_KEYWORDS_LEN:      MAX_META_KEYWORDS_LEN,
  MAX_LIST_LIMIT:             MAX_LIST_LIMIT,
  MAX_RELATED_LIMIT:          MAX_RELATED_LIMIT,
  MAX_POPULAR_LIMIT:          MAX_POPULAR_LIMIT,
  MAX_BY_AUTHOR_LIMIT:        MAX_BY_AUTHOR_LIMIT,
  ALLOWED_STATUSES:           ALLOWED_STATUSES,
};
