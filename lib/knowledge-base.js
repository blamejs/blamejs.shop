"use strict";
/**
 * @module shop.knowledgeBase
 * @title  Knowledge base — self-serve customer help center
 *
 * @intro
 *   FAQ articles grouped by category, with locale fallback, search-
 *   suggest ranking, view tracking, and helpfulness voting. Composed
 *   by the supportTickets primitive's intake flow: the storefront
 *   calls `searchSuggest({ query })` against the customer's draft
 *   subject + body and surfaces ranked articles before the ticket
 *   form actually submits. A customer who finds their answer in the
 *   knowledge base closes the loop without ever opening a ticket.
 *
 *   Body is authored in the in-process Markdown subset shared with
 *   cmsBlocks / storefrontPages. Every text run is HTML-escaped via
 *   `b.template.escapeHtml`; every link URL passes through
 *   `b.safeUrl.parse` (https-only) OR an allow-list for `/`-rooted
 *   absolute paths. Raw HTML in the body never reaches the rendered
 *   output — any `<` lands as `&lt;`. The raw body lives in storage;
 *   the rendered HTML is computed on demand at read time.
 *
 *   Locale fallback walks the requested BCP-47 tag right-to-left,
 *   dropping trailing subtags, then falls back to the operator's
 *   configured default locale (`opts.defaultLocale`, default `en`).
 *   "fr-ca" -> ["fr-ca", "fr", "en"]. First (slug, locale) match
 *   wins.
 *
 *   Helpfulness voting is deduped at the (slug, session_id_hash)
 *   UNIQUE — a repeat vote from the same session collapses to a
 *   no-op so the aggregate counters reflect distinct sessions
 *   rather than refresh-loop noise. session_id is hashed via
 *   `b.crypto.namespaceHash("kb-vote-session", id)` (and the parallel
 *   "kb-view-session" namespace on view rows) so the raw session id
 *   never lands on disk.
 *
 *   `searchSuggest` ranks candidates with three weighted signals:
 *   title-token match (weight 3), tag-token match (weight 2), and
 *   body-token match (weight 1). Token equality is case-insensitive
 *   ASCII; tokens come from a /\s+/ split of the query after lower-
 *   casing. Archived + unpublished articles never appear in the
 *   ranked output.
 *
 *   Composes:
 *     - `b.template.escapeHtml`   — render-time text escape
 *     - `b.safeUrl.parse`         — render-time link gate (https://)
 *     - `b.crypto.namespaceHash`  — session-id hashing
 *     - `b.uuid.v7`               — row ids on votes + views
 *     - `b.pagination`            — HMAC-tagged tuple cursor for
 *                                   listArticles
 *
 *   Monotonic per-process clock: two writes in the same millisecond
 *   would tie on `updated_at` / `occurred_at` and make a sort-by-
 *   timestamp read ambiguous. `_now` bumps to `prior + 1` on
 *   collision so the (updated_at DESC, slug DESC) listArticles
 *   cursor + popularArticles aggregation carry a strict per-process
 *   ordering.
 *
 *   Surface:
 *     - defineArticle({ slug, title, body, category, tags?, locale,
 *                       published? })
 *     - getArticle({ slug, locale? })
 *     - listArticles({ category?, search?, published_only?, cursor?,
 *                      limit? })
 *     - updateArticle(slug, patch)
 *     - publishArticle(slug)
 *     - unpublishArticle(slug)
 *     - archiveArticle(slug)
 *     - recordView({ slug, session_id?, customer_id? })
 *     - recordVote({ slug, session_id, vote })
 *     - voteAggregateForArticle(slug)
 *     - popularArticles({ from, to, limit })
 *     - searchSuggest({ query, limit, locale?, category? })
 *
 *   Storage:
 *     - kb_articles, kb_views, kb_votes (migration
 *       `0162_knowledge_base.sql`).
 *
 * @primitive knowledgeBase
 * @related    b.template.escapeHtml, b.safeUrl, b.crypto.namespaceHash,
 *             b.uuid.v7, shop.supportTickets, shop.cmsBlocks
 */

var MAX_SLUG_LEN          = 120;
var MAX_TITLE_LEN         = 200;
var MAX_BODY_LEN          = 32000;
var MAX_CATEGORY_LEN      = 80;
var MAX_TAG_LEN           = 40;
var MAX_TAG_COUNT         = 24;
var MAX_LOCALE_LEN        = 35;
var MAX_QUERY_LEN         = 400;
var MAX_LIST_LIMIT        = 100;
var DEFAULT_LIST_LIMIT    = 25;
var MAX_POPULAR_LIMIT     = 100;
var DEFAULT_POPULAR_LIMIT = 10;
var MAX_SUGGEST_LIMIT     = 25;
var DEFAULT_SUGGEST_LIMIT = 5;

var VIEW_NAMESPACE = "kb-view-session";
var VOTE_NAMESPACE = "kb-vote-session";

var ALLOWED_VOTES = ["helpful", "not_helpful"];

var LIST_ORDER_KEY = ["updated_at:desc", "slug:desc"];

var SLUG_RE     = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var LOCALE_RE   = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;
var CATEGORY_RE = /^[a-z][a-z0-9_-]*$/;
var TAG_RE      = /^[a-z][a-z0-9_-]*$/;


var SEARCH_WEIGHTS = Object.freeze({
  title: 3,
  tag:   2,
  body:  1,
});

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- monotonic clock ---------------------------------------------------
//
// Operator-driven writes can land in the same millisecond on fast
// machines. Bumping by 1ms on a tie keeps the timeline strictly
// increasing so a sort-by-timestamp read returns events in the
// order they were issued.

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
    throw new TypeError("knowledgeBase: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("knowledgeBase: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("knowledgeBase: slug must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string") {
    throw new TypeError("knowledgeBase: title must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("knowledgeBase: title must be non-empty after trim");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("knowledgeBase: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  textGuard.freeText(s, "knowledgeBase: title", { singleLine: "reject", zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("knowledgeBase: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("knowledgeBase: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("knowledgeBase: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (textGuard.hasCodepointThreat(s)) {
    throw new TypeError("knowledgeBase: body contains control bytes");
  }
  textGuard.freeText(s, "knowledgeBase: body", { zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _category(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("knowledgeBase: category must be a non-empty string");
  }
  if (s.length > MAX_CATEGORY_LEN) {
    throw new TypeError("knowledgeBase: category must be <= " + MAX_CATEGORY_LEN + " characters");
  }
  if (!CATEGORY_RE.test(s)) {
    throw new TypeError("knowledgeBase: category must match /^[a-z][a-z0-9_-]*$/");
  }
  return s;
}

function _locale(s, label) {
  label = label || "locale";
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("knowledgeBase: " + label + " must be a non-empty string");
  }
  if (s.length > MAX_LOCALE_LEN) {
    throw new TypeError("knowledgeBase: " + label + " must be <= " + MAX_LOCALE_LEN + " characters");
  }
  var lower = s.toLowerCase();
  if (!LOCALE_RE.test(lower)) {
    throw new TypeError("knowledgeBase: " + label + " must be a BCP-47 tag (e.g. 'en', 'fr-ca')");
  }
  return lower;
}

function _tags(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("knowledgeBase: tags must be an array of strings");
  }
  if (input.length > MAX_TAG_COUNT) {
    throw new TypeError("knowledgeBase: tags must contain <= " + MAX_TAG_COUNT + " entries");
  }
  var seen = {};
  var out  = [];
  for (var i = 0; i < input.length; i += 1) {
    var t = input[i];
    if (typeof t !== "string" || !t.length) {
      throw new TypeError("knowledgeBase: tags[" + i + "] must be a non-empty string");
    }
    if (t.length > MAX_TAG_LEN) {
      throw new TypeError("knowledgeBase: tags[" + i + "] must be <= " + MAX_TAG_LEN + " characters");
    }
    if (!TAG_RE.test(t)) {
      throw new TypeError("knowledgeBase: tags[" + i + "] must match /^[a-z][a-z0-9_-]*$/");
    }
    if (seen[t]) continue;
    seen[t] = 1;
    out.push(t);
  }
  return out;
}

function _vote(s) {
  if (typeof s !== "string" || ALLOWED_VOTES.indexOf(s) === -1) {
    throw new TypeError("knowledgeBase: vote must be one of " + ALLOWED_VOTES.join(", "));
  }
  return s;
}

function _limit(n, max, def, label) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("knowledgeBase: " + label + " must be an integer 1..." + max);
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("knowledgeBase." + label + ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("knowledgeBase." + label + ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError("knowledgeBase." + label + ": from must be <= to");
  }
}

function _queryStr(s) {
  if (typeof s !== "string") {
    throw new TypeError("knowledgeBase: query must be a string");
  }
  if (s.length > MAX_QUERY_LEN) {
    throw new TypeError("knowledgeBase: query must be <= " + MAX_QUERY_LEN + " characters");
  }
  textGuard.freeText(s, "knowledgeBase: query", { zeroWidth: "reject", bidiMarks: "allow" });
  return s;
}

function _customerId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("knowledgeBase: customer_id — " + (e && e.message || "invalid UUID"));
  }
}

function _sessionIdRaw(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("knowledgeBase: session_id must be a non-empty string");
  }
  if (s.length > 256) {
    throw new TypeError("knowledgeBase: session_id must be <= 256 characters");
  }
  textGuard.freeText(s, "knowledgeBase: session_id", { singleLine: "reject", zeroWidth: "reject" });
  return s;
}

// ---- locale fallback ---------------------------------------------------
//
// Walk a canonical BCP-47 locale right-to-left, dropping trailing
// subtags, then append the configured default locale (when distinct).
// "fr-ca" + default "en" -> ["fr-ca", "fr", "en"].
function _fallbackChain(locale, defaultLocale) {
  var chain = [];
  var cur = locale;
  while (cur && cur.length) {
    chain.push(cur);
    var idx = cur.lastIndexOf("-");
    if (idx === -1) break;
    cur = cur.slice(0, idx);
  }
  if (defaultLocale && chain.indexOf(defaultLocale) === -1) {
    chain.push(defaultLocale);
  }
  return chain;
}

// ---- Markdown to HTML --------------------------------------------------
//
// Minimal in-process Markdown subset, hand-written to keep the
// primitive in the zero-runtime-deps envelope. Mirrors cmsBlocks /
// storefrontPages: paragraphs, headings, lists, links, inline code,
// emphasis, blockquotes, horizontal rules. Every text run is HTML-
// escaped via `b.template.escapeHtml`. Every link URL passes through
// `b.safeUrl.parse` (https-only) OR an allow-list for `/`-rooted
// absolute paths. Any URL that fails the gate is dropped from the
// rendered HTML; the anchor text falls back to inert escaped text.
// Raw HTML in the body is never passed through.

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

// ---- hydration ---------------------------------------------------------

function _hydrateRow(row) {
  if (!row) return null;
  var tags;
  try { tags = JSON.parse(row.tags_json || "[]"); }
  catch (_e) { tags = []; }
  return {
    slug:              row.slug,
    locale:            row.locale,
    title:             row.title,
    body:              row.body,
    category:          row.category,
    tags:              tags,
    published:         row.published === 1 || row.published === true,
    archived_at:       row.archived_at == null ? null : Number(row.archived_at),
    view_count:        Number(row.view_count) || 0,
    helpful_count:     Number(row.helpful_count) || 0,
    not_helpful_count: Number(row.not_helpful_count) || 0,
    created_at:        Number(row.created_at),
    updated_at:        Number(row.updated_at),
    body_html:         _renderMarkdown(row.body),
  };
}

// ---- search tokenizer --------------------------------------------------
//
// Lowercase + non-alphanum split + drop tokens shorter than 2
// chars. Keeps the ranker simple + locale-agnostic enough for the
// in-process search. Operator-supplied query strings are already
// gated by `_queryStr()` so no control bytes reach this far.

function _tokenize(s) {
  var lower = String(s).toLowerCase();
  var raw = lower.split(/[^a-z0-9]+/);
  var out = [];
  for (var i = 0; i < raw.length; i += 1) {
    if (raw[i].length >= 2) out.push(raw[i]);
  }
  return out;
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var defaultLocale = opts.defaultLocale == null
    ? "en"
    : _locale(opts.defaultLocale, "defaultLocale");

  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("knowledgeBase.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "knowledge-base-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("knowledgeBase." + label + ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("knowledgeBase." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("knowledgeBase." + label + ": cursor — " + (e && e.message || "malformed"));
    }
  }

  function _encodeNext(rows, limit) {
    var last = rows[rows.length - 1];
    if (!last || rows.length < limit) return null;
    return b.pagination.encodeCursor({
      orderKey: LIST_ORDER_KEY,
      vals:     [last.updated_at, last.slug],
      forward:  true,
    }, cursorSecret);
  }

  function _hashSession(namespace, sessionId) {
    return b.crypto.namespaceHash(namespace, sessionId);
  }

  async function _readExact(slug, locale) {
    var r = await query(
      "SELECT * FROM kb_articles WHERE slug = ?1 AND locale = ?2",
      [slug, locale],
    );
    return r.rows[0] || null;
  }

  async function _readAllLocales(slug) {
    var r = await query(
      "SELECT * FROM kb_articles WHERE slug = ?1",
      [slug],
    );
    return r.rows;
  }

  // Locale-aware single-article read. Walks the fallback chain;
  // returns the first non-archived row. Archived rows are filtered
  // even at the exact-locale match — once a slug is archived, no
  // locale survives. `published_only=true` additionally filters
  // unpublished rows.
  async function _readWithFallback(slug, locale, publishedOnly) {
    var chain = _fallbackChain(locale, defaultLocale);
    for (var i = 0; i < chain.length; i += 1) {
      var row = await _readExact(slug, chain[i]);
      if (!row) continue;
      if (row.archived_at != null) continue;
      if (publishedOnly && row.published !== 1) continue;
      return row;
    }
    return null;
  }

  return {
    MAX_SLUG_LEN:          MAX_SLUG_LEN,
    MAX_TITLE_LEN:         MAX_TITLE_LEN,
    MAX_BODY_LEN:          MAX_BODY_LEN,
    MAX_CATEGORY_LEN:      MAX_CATEGORY_LEN,
    MAX_TAG_LEN:           MAX_TAG_LEN,
    MAX_TAG_COUNT:         MAX_TAG_COUNT,
    MAX_LOCALE_LEN:        MAX_LOCALE_LEN,
    MAX_QUERY_LEN:         MAX_QUERY_LEN,
    MAX_LIST_LIMIT:        MAX_LIST_LIMIT,
    MAX_POPULAR_LIMIT:     MAX_POPULAR_LIMIT,
    MAX_SUGGEST_LIMIT:     MAX_SUGGEST_LIMIT,
    ALLOWED_VOTES:         ALLOWED_VOTES.slice(),
    SEARCH_WEIGHTS:        Object.assign({}, SEARCH_WEIGHTS),
    defaultLocale:         defaultLocale,

    // Idempotent insert / update of a single (slug, locale) row.
    // The first defineArticle for a slug establishes the canonical
    // category + tags; subsequent locale rows inherit those slug-
    // wide attributes — operator-supplied category/tags on a
    // localized re-author must match the existing slug, otherwise
    // the call is refused (mismatched metadata across locales is
    // an authoring bug). `published` defaults to false on first
    // insert; existing rows keep their current published flag
    // (use publishArticle / unpublishArticle to flip).
    defineArticle: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("knowledgeBase.defineArticle: input object required");
      }
      var slug     = _slug(input.slug);
      var title    = _title(input.title);
      var body     = _body(input.body);
      var category = _category(input.category);
      var tags     = _tags(input.tags);
      var locale   = _locale(input.locale);
      var ts       = _now();

      var existingAny = await _readAllLocales(slug);
      if (existingAny.length) {
        var canonical = existingAny[0];
        if (canonical.category !== category) {
          throw new TypeError(
            "knowledgeBase.defineArticle: category mismatch for slug '" + slug +
            "' (existing='" + canonical.category + "', supplied='" + category + "')"
          );
        }
        var canonTags;
        try { canonTags = JSON.parse(canonical.tags_json || "[]"); }
        catch (_e) { canonTags = []; }
        if (JSON.stringify(canonTags) !== JSON.stringify(tags)) {
          throw new TypeError(
            "knowledgeBase.defineArticle: tags mismatch for slug '" + slug +
            "' (slug-wide tags are set on first defineArticle and must match on every locale)"
          );
        }
        if (canonical.archived_at != null) {
          throw new TypeError(
            "knowledgeBase.defineArticle: slug '" + slug +
            "' is archived; call publishArticle to revive before defining additional locales"
          );
        }
      }

      var existingRow = await _readExact(slug, locale);
      if (existingRow) {
        await query(
          "UPDATE kb_articles " +
          "SET title = ?1, body = ?2, category = ?3, tags_json = ?4, updated_at = ?5 " +
          "WHERE slug = ?6 AND locale = ?7",
          [title, body, category, JSON.stringify(tags), ts, slug, locale],
        );
      } else {
        var published = input.published === true ? 1 : 0;
        await query(
          "INSERT INTO kb_articles " +
          "(slug, locale, title, body, category, tags_json, published, archived_at, " +
          " view_count, helpful_count, not_helpful_count, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, 0, 0, 0, ?8, ?8)",
          [slug, locale, title, body, category, JSON.stringify(tags), published, ts],
        );
      }
      var fresh = await _readExact(slug, locale);
      return _hydrateRow(fresh);
    },

    getArticle: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("knowledgeBase.getArticle: input object required");
      }
      var slug = _slug(input.slug);
      var locale = input.locale == null ? defaultLocale : _locale(input.locale);
      var row = await _readWithFallback(slug, locale, false);
      return _hydrateRow(row);
    },

    // Operator + storefront list view. Returns one row per slug
    // (the default-locale row when present). Filters by category +
    // search + published_only. Cursor-paginated by (updated_at DESC,
    // slug DESC) so a tampered cursor can't skip past rows the
    // caller isn't supposed to see. `search` does a case-insensitive
    // LIKE against title + body — for ranked suggestion use
    // `searchSuggest`.
    listArticles: async function (listOpts) {
      listOpts = listOpts || {};
      var limit       = _limit(listOpts.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, "limit");
      var cursorVals  = _decodeCursor(listOpts.cursor, "listArticles");
      var publishedOnly = listOpts.published_only === true;

      var where  = ["locale = ?1", "archived_at IS NULL"];
      var params = [defaultLocale];
      var idx    = 2;

      if (listOpts.category != null) {
        var category = _category(listOpts.category);
        where.push("category = ?" + idx);
        params.push(category);
        idx += 1;
      }
      if (publishedOnly) {
        where.push("published = 1");
      }
      if (listOpts.search != null) {
        var search = _queryStr(listOpts.search);
        var like = "%" + search.toLowerCase().replace(/[%_\\]/g, function (m) { return "\\" + m; }) + "%";
        where.push("(LOWER(title) LIKE ?" + idx + " ESCAPE '\\' OR LOWER(body) LIKE ?" + idx + " ESCAPE '\\')");
        params.push(like);
        idx += 1;
      }
      if (cursorVals) {
        var pUpdated = idx;
        var pSlug = idx + 1;
        where.push(
          "(updated_at < ?" + pUpdated + " OR " +
          "(updated_at = ?" + pUpdated + " AND slug < ?" + pSlug + "))"
        );
        params.push(cursorVals[0], cursorVals[1]);
        idx += 2;
      }
      params.push(limit);
      var sql = "SELECT * FROM kb_articles WHERE " + where.join(" AND ") +
                " ORDER BY updated_at DESC, slug DESC LIMIT ?" + idx;
      var r = await query(sql, params);
      var rows = r.rows.map(_hydrateRow);
      return { rows: rows, next_cursor: _encodeNext(r.rows, limit) };
    },

    // Patch an existing article. The patch envelope can contain any
    // subset of { title, body, locale, category, tags }. When
    // `locale` is supplied, only that locale row is patched;
    // otherwise the default-locale row is the target. category +
    // tags are slug-wide — patching them rewrites every locale row
    // for the slug.
    updateArticle: async function (slug, patch) {
      slug = _slug(slug);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("knowledgeBase.updateArticle: patch object required");
      }
      var locale = patch.locale == null ? defaultLocale : _locale(patch.locale);
      var existing = await _readExact(slug, locale);
      if (!existing) {
        var err = new Error("knowledgeBase.updateArticle: (slug='" + slug + "', locale='" + locale + "') not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      if (existing.archived_at != null) {
        var aErr = new Error("knowledgeBase.updateArticle: slug '" + slug + "' is archived");
        aErr.code = "KB_ARTICLE_ARCHIVED";
        throw aErr;
      }
      var ts = _now();
      var title = patch.title == null ? existing.title : _title(patch.title);
      var body  = patch.body  == null ? existing.body  : _body(patch.body);

      var rewriteSlugWide = patch.category != null || patch.tags !== undefined;
      var category = patch.category == null
        ? existing.category
        : _category(patch.category);
      var tagsJson;
      if (patch.tags === undefined) {
        tagsJson = existing.tags_json;
      } else {
        tagsJson = JSON.stringify(_tags(patch.tags));
      }

      await query(
        "UPDATE kb_articles SET title = ?1, body = ?2, updated_at = ?3 " +
        "WHERE slug = ?4 AND locale = ?5",
        [title, body, ts, slug, locale],
      );
      if (rewriteSlugWide) {
        await query(
          "UPDATE kb_articles SET category = ?1, tags_json = ?2, updated_at = ?3 " +
          "WHERE slug = ?4",
          [category, tagsJson, ts, slug],
        );
      }
      var fresh = await _readExact(slug, locale);
      return _hydrateRow(fresh);
    },

    publishArticle: async function (slug) {
      slug = _slug(slug);
      var rows = await _readAllLocales(slug);
      if (!rows.length) {
        var err = new Error("knowledgeBase.publishArticle: slug '" + slug + "' not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE kb_articles SET published = 1, archived_at = NULL, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      var fresh = await _readExact(slug, defaultLocale);
      if (!fresh) fresh = (await _readAllLocales(slug))[0];
      return _hydrateRow(fresh);
    },

    unpublishArticle: async function (slug) {
      slug = _slug(slug);
      var rows = await _readAllLocales(slug);
      if (!rows.length) {
        var err = new Error("knowledgeBase.unpublishArticle: slug '" + slug + "' not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE kb_articles SET published = 0, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      var fresh = await _readExact(slug, defaultLocale);
      if (!fresh) fresh = (await _readAllLocales(slug))[0];
      return _hydrateRow(fresh);
    },

    archiveArticle: async function (slug) {
      slug = _slug(slug);
      var rows = await _readAllLocales(slug);
      if (!rows.length) {
        var err = new Error("knowledgeBase.archiveArticle: slug '" + slug + "' not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE kb_articles SET archived_at = ?1, published = 0, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      var fresh = await _readExact(slug, defaultLocale);
      if (!fresh) fresh = (await _readAllLocales(slug))[0];
      return _hydrateRow(fresh);
    },

    // Append-only view log. session_id is hashed at the door; the
    // raw value never reaches storage. Bumps the slug-wide
    // view_count on every locale row so popularArticles sorts
    // by combined-locale traffic.
    recordView: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("knowledgeBase.recordView: input object required");
      }
      var slug = _slug(input.slug);
      var rows = await _readAllLocales(slug);
      if (!rows.length) {
        var err = new Error("knowledgeBase.recordView: slug '" + slug + "' not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      var sessionHash = null;
      if (input.session_id != null) {
        sessionHash = _hashSession(VIEW_NAMESPACE, _sessionIdRaw(input.session_id));
      }
      var customerId = null;
      if (input.customer_id != null) {
        customerId = _customerId(input.customer_id);
      }
      var ts = _now();
      await query(
        "INSERT INTO kb_views (id, slug, session_id_hash, customer_id, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [b.uuid.v7(), slug, sessionHash, customerId, ts],
      );
      await query(
        "UPDATE kb_articles SET view_count = view_count + 1 WHERE slug = ?1",
        [slug],
      );
      return { slug: slug, occurred_at: ts };
    },

    // Vote: helpful / not_helpful. Deduped at (slug, session_id_hash)
    // via the UNIQUE constraint — a repeat vote from the same session
    // collapses to a no-op. session_id is required (votes without a
    // session are anonymous spam in disguise — the FAQ reading flow
    // already has a session).
    recordVote: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("knowledgeBase.recordVote: input object required");
      }
      var slug    = _slug(input.slug);
      var session = _sessionIdRaw(input.session_id);
      var vote    = _vote(input.vote);
      var rows = await _readAllLocales(slug);
      if (!rows.length) {
        var err = new Error("knowledgeBase.recordVote: slug '" + slug + "' not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      var sessionHash = _hashSession(VOTE_NAMESPACE, session);
      var ts = _now();

      var inserted = await query(
        "INSERT OR IGNORE INTO kb_votes (id, slug, session_id_hash, vote, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [b.uuid.v7(), slug, sessionHash, vote, ts],
      );
      var changed = inserted && b.sql.casWon(inserted).won;
      if (changed) {
        var col = vote === "helpful" ? "helpful_count" : "not_helpful_count";
        await query(
          "UPDATE kb_articles SET " + col + " = " + col + " + 1 WHERE slug = ?1",
          [slug],
        );
      }
      return { slug: slug, vote: vote, recorded: !!changed };
    },

    voteAggregateForArticle: async function (slug) {
      slug = _slug(slug);
      var rows = await _readAllLocales(slug);
      if (!rows.length) {
        var err = new Error("knowledgeBase.voteAggregateForArticle: slug '" + slug + "' not found");
        err.code = "KB_ARTICLE_NOT_FOUND";
        throw err;
      }
      var r = rows[0];
      var helpful    = Number(r.helpful_count) || 0;
      var notHelpful = Number(r.not_helpful_count) || 0;
      var total      = helpful + notHelpful;
      return {
        slug:                slug,
        helpful_count:       helpful,
        not_helpful_count:   notHelpful,
        total_votes:         total,
        helpfulness_ratio:   total > 0 ? helpful / total : null,
      };
    },

    // Top-N most-viewed articles over a closed time window. Views
    // are counted from kb_views.occurred_at against [from, to].
    // Archived + unpublished articles are filtered. Sorted by view
    // count DESC, slug DESC.
    popularArticles: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("knowledgeBase.popularArticles: input object required");
      }
      var from = input.from;
      var to   = input.to;
      _timestampRange(from, to, "popularArticles");
      var limit = _limit(input.limit, MAX_POPULAR_LIMIT, DEFAULT_POPULAR_LIMIT, "limit");

      var sql =
        "SELECT v.slug AS slug, COUNT(*) AS views " +
        "FROM kb_views v " +
        "JOIN kb_articles a ON a.slug = v.slug AND a.locale = ?1 " +
        "WHERE v.occurred_at >= ?2 AND v.occurred_at <= ?3 " +
        "  AND a.archived_at IS NULL AND a.published = 1 " +
        "GROUP BY v.slug " +
        "ORDER BY views DESC, v.slug DESC " +
        "LIMIT ?4";
      var r = await query(sql, [defaultLocale, from, to, limit]);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        out.push({ slug: row.slug, views: Number(row.views) });
      }
      return out;
    },

    // Ranked search-suggest. Tokenizes the query, then scans every
    // published + non-archived article in the requested locale
    // (with default-locale fallback) and computes a weighted score:
    // title-token match (weight 3) + tag-token match (weight 2) +
    // body-token match (weight 1). Articles with score 0 are
    // excluded; ties break on slug DESC (deterministic).
    //
    // The implementation reads every candidate row in JS rather
    // than pushing the ranker into SQL — the corpus is FAQ-sized
    // (dozens to hundreds of articles) and the JS path keeps the
    // primitive in the zero-runtime-deps envelope. Operators with
    // very large knowledge bases can pre-filter via `category` to
    // bound the candidate set.
    searchSuggest: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("knowledgeBase.searchSuggest: input object required");
      }
      var queryString = _queryStr(input.query);
      var tokens      = _tokenize(queryString);
      var limit       = _limit(input.limit, MAX_SUGGEST_LIMIT, DEFAULT_SUGGEST_LIMIT, "limit");
      var locale      = input.locale == null ? defaultLocale : _locale(input.locale);
      var category;
      if (input.category != null) {
        category = _category(input.category);
      }

      if (!tokens.length) return [];

      var sql, params;
      if (category) {
        sql = "SELECT * FROM kb_articles WHERE archived_at IS NULL AND published = 1 AND category = ?1";
        params = [category];
      } else {
        sql = "SELECT * FROM kb_articles WHERE archived_at IS NULL AND published = 1";
        params = [];
      }
      var r = await query(sql, params);

      var bySlug = {};
      var chain = _fallbackChain(locale, defaultLocale);
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var pri = chain.indexOf(row.locale);
        if (pri === -1) continue;
        var current = bySlug[row.slug];
        if (!current || current._chainIdx > pri) {
          row._chainIdx = pri;
          bySlug[row.slug] = row;
        }
      }

      var ranked = [];
      var slugs = Object.keys(bySlug);
      for (var s = 0; s < slugs.length; s += 1) {
        var rowS = bySlug[slugs[s]];
        var titleTokens = _tokenize(rowS.title);
        var bodyTokens  = _tokenize(rowS.body);
        var tagList;
        try { tagList = JSON.parse(rowS.tags_json || "[]"); }
        catch (_e) { tagList = []; }

        var score = 0;
        for (var t = 0; t < tokens.length; t += 1) {
          var token = tokens[t];
          if (titleTokens.indexOf(token) !== -1) score += SEARCH_WEIGHTS.title;
          if (tagList.indexOf(token)     !== -1) score += SEARCH_WEIGHTS.tag;
          if (bodyTokens.indexOf(token)  !== -1) score += SEARCH_WEIGHTS.body;
        }
        if (score > 0) {
          ranked.push({
            slug:      rowS.slug,
            locale:    rowS.locale,
            title:     rowS.title,
            category:  rowS.category,
            score:     score,
          });
        }
      }

      ranked.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (a.slug < b.slug)    return 1;
        if (a.slug > b.slug)    return -1;
        return 0;
      });

      return ranked.slice(0, limit);
    },
  };
}

module.exports = {
  create:            create,
  MAX_SLUG_LEN:      MAX_SLUG_LEN,
  MAX_TITLE_LEN:     MAX_TITLE_LEN,
  MAX_BODY_LEN:      MAX_BODY_LEN,
  MAX_CATEGORY_LEN:  MAX_CATEGORY_LEN,
  MAX_TAG_LEN:       MAX_TAG_LEN,
  MAX_TAG_COUNT:     MAX_TAG_COUNT,
  MAX_LOCALE_LEN:    MAX_LOCALE_LEN,
  MAX_QUERY_LEN:     MAX_QUERY_LEN,
  MAX_LIST_LIMIT:    MAX_LIST_LIMIT,
  MAX_POPULAR_LIMIT: MAX_POPULAR_LIMIT,
  MAX_SUGGEST_LIMIT: MAX_SUGGEST_LIMIT,
  ALLOWED_VOTES:     ALLOWED_VOTES.slice(),
  SEARCH_WEIGHTS:    Object.assign({}, SEARCH_WEIGHTS),
};
