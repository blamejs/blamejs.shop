"use strict";
/**
 * @module shop.operatorHelpCenter
 * @title  Operator help center — in-admin help articles indexed by
 *         admin-console section
 *
 * @intro
 *   `knowledgeBase` is the customer-facing FAQ; this primitive is the
 *   operator-facing equivalent. Articles answer "how do I issue a
 *   refund?", "where do I edit shipping zones?", "what does the
 *   approvals queue do?". Each article is indexed by the admin-console
 *   `section` it documents so the help drawer on any screen can
 *   surface articles relevant to that screen via
 *   `articlesForSection({ section, role })`.
 *
 *   Visibility is gated by `audience_roles` — a closed allow-list of
 *   `operatorRoles` permission tokens. An article is visible to an
 *   operator iff at least one of its `audience_roles` matches a
 *   permission token the operator's roles grant (empty `audience_roles`
 *   = visible to every operator). The allow-list is closed at THIS
 *   primitive layer — `defineArticle` refuses any token outside
 *   `operatorRoles.PERMISSIONS` so a typo doesn't silently produce an
 *   article that nobody can see.
 *
 *   Body is authored in the in-process Markdown subset shared with
 *   knowledgeBase / cmsBlocks / storefrontPages. Every text run is
 *   HTML-escaped via `b.template.escapeHtml`; every link URL passes
 *   through `b.safeUrl.parse` (https-only) OR an allow-list for
 *   `/`-rooted absolute paths. Raw HTML in the body never reaches the
 *   rendered output. The raw body lives in storage; the rendered HTML
 *   is computed on demand at read time.
 *
 *   `searchSuggest` ranks candidates with three weighted signals
 *   (mirrors knowledgeBase): title-token match (weight 3), section-
 *   token match (weight 2), body-token match (weight 1). Token
 *   equality is case-insensitive ASCII; tokens come from a non-
 *   alphanum split of the query after lower-casing. Archived
 *   articles never appear in the ranked output. When `role` is
 *   supplied, articles whose `audience_roles` exclude that
 *   permission are also filtered.
 *
 *   `recordHelpfulVote` is deduped at the (slug, operator_id) UNIQUE
 *   — a repeat vote from the same operator collapses to a no-op so
 *   the aggregate counters reflect distinct operators rather than
 *   refresh-loop noise.
 *
 *   Composes:
 *     - `b.template.escapeHtml`   — render-time text escape
 *     - `b.safeUrl.parse`         — render-time link gate (https://)
 *     - `b.guardUuid`             — strict UUID gate on every
 *                                   `operator_id`
 *     - `b.uuid.v7`               — row ids on votes + views
 *     - `b.pagination`            — HMAC-tagged tuple cursor for
 *                                   articlesForSection
 *     - `shop.operatorRoles`      — PERMISSIONS allow-list (closed at
 *                                   this layer)
 *
 *   Monotonic per-process clock: two writes in the same millisecond
 *   would tie on `updated_at` / `occurred_at` and make a sort-by-
 *   timestamp read ambiguous. `_now` bumps to `prior + 1` on
 *   collision so the (updated_at DESC, slug DESC) articlesForSection
 *   cursor + popularArticles aggregation carry a strict per-process
 *   ordering.
 *
 *   Surface:
 *     - defineArticle({ slug, title, body, section, related_actions?,
 *                       audience_roles? })
 *     - getArticle({ slug })
 *     - articlesForSection({ section, role?, cursor?, limit? })
 *     - searchSuggest({ query, role?, limit? })
 *     - recordView({ slug, operator_id })
 *     - recordHelpfulVote({ slug, operator_id, vote })
 *     - popularArticles({ from, to, role?, limit? })
 *     - archiveArticle(slug)
 *     - updateArticle(slug, patch)
 *     - listSections()
 *
 *   Storage:
 *     - operator_help_articles, operator_help_views,
 *       operator_help_votes (migration `0200_operator_help_center.sql`).
 *
 * @primitive operatorHelpCenter
 * @related   b.template.escapeHtml, b.safeUrl, b.guardUuid, b.uuid.v7,
 *            b.pagination, shop.operatorRoles, shop.knowledgeBase
 */

var operatorRoles = require("./operator-roles");

var MAX_SLUG_LEN          = 120;
var MAX_TITLE_LEN         = 200;
var MAX_BODY_LEN          = 32000;
var MAX_SECTION_LEN       = 80;
var MAX_ACTION_LEN        = 200;
var MAX_ACTION_COUNT      = 24;
var MAX_AUDIENCE_COUNT    = 24;
var MAX_QUERY_LEN         = 400;
var MAX_LIST_LIMIT        = 100;
var DEFAULT_LIST_LIMIT    = 25;
var MAX_POPULAR_LIMIT     = 100;
var DEFAULT_POPULAR_LIMIT = 10;
var MAX_SUGGEST_LIMIT     = 25;
var DEFAULT_SUGGEST_LIMIT = 5;

var ALLOWED_VOTES = ["helpful", "not_helpful"];

var LIST_ORDER_KEY = ["updated_at:desc", "slug:desc"];

var SLUG_RE    = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
var SECTION_RE = /^[a-z][a-z0-9_-]*$/;
var ACTION_RE  = /^[a-z0-9](?:[a-z0-9._/:-]*[a-z0-9])?$/;

var CONTROL_BYTE_BODY_RE   = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
var CONTROL_BYTE_STRICT_RE = /[\x00-\x1f\x7f]/;
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var SEARCH_WEIGHTS = Object.freeze({
  title:   3,
  section: 2,
  body:    1,
});

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title", "body", "section", "related_actions", "audience_roles",
]);

var b = require("./vendor/blamejs");

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
    throw new TypeError("operatorHelpCenter: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("operatorHelpCenter: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: slug must match /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/");
  }
  return s;
}

function _title(s) {
  if (typeof s !== "string") {
    throw new TypeError("operatorHelpCenter: title must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("operatorHelpCenter: title must be non-empty after trim");
  }
  if (s.length > MAX_TITLE_LEN) {
    throw new TypeError("operatorHelpCenter: title must be <= " + MAX_TITLE_LEN + " characters");
  }
  if (CONTROL_BYTE_STRICT_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: title contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: title contains zero-width / direction-override characters");
  }
  return s;
}

function _body(s) {
  if (typeof s !== "string") {
    throw new TypeError("operatorHelpCenter: body must be a string");
  }
  var trimmed = s.trim();
  if (!trimmed.length) {
    throw new TypeError("operatorHelpCenter: body must be non-empty after trim");
  }
  if (s.length > MAX_BODY_LEN) {
    throw new TypeError("operatorHelpCenter: body must be <= " + MAX_BODY_LEN + " characters");
  }
  if (CONTROL_BYTE_BODY_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: body contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: body contains zero-width / direction-override characters");
  }
  return s;
}

function _section(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("operatorHelpCenter: section must be a non-empty string");
  }
  if (s.length > MAX_SECTION_LEN) {
    throw new TypeError("operatorHelpCenter: section must be <= " + MAX_SECTION_LEN + " characters");
  }
  if (!SECTION_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: section must match /^[a-z][a-z0-9_-]*$/");
  }
  return s;
}

function _relatedActions(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("operatorHelpCenter: related_actions must be an array of strings");
  }
  if (input.length > MAX_ACTION_COUNT) {
    throw new TypeError("operatorHelpCenter: related_actions must contain <= " +
                        MAX_ACTION_COUNT + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var a = input[i];
    if (typeof a !== "string" || !a.length) {
      throw new TypeError("operatorHelpCenter: related_actions[" + i + "] must be a non-empty string");
    }
    if (a.length > MAX_ACTION_LEN) {
      throw new TypeError("operatorHelpCenter: related_actions[" + i + "] must be <= " +
                          MAX_ACTION_LEN + " characters");
    }
    if (!ACTION_RE.test(a)) {
      throw new TypeError("operatorHelpCenter: related_actions[" + i +
                          "] must match /^[a-z0-9](?:[a-z0-9._/:-]*[a-z0-9])?$/");
    }
    if (seen[a]) continue;
    seen[a] = 1;
    out.push(a);
  }
  return out;
}

function _audienceRoles(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new TypeError("operatorHelpCenter: audience_roles must be an array of permission tokens");
  }
  if (input.length > MAX_AUDIENCE_COUNT) {
    throw new TypeError("operatorHelpCenter: audience_roles must contain <= " +
                        MAX_AUDIENCE_COUNT + " entries");
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < input.length; i += 1) {
    var p = input[i];
    if (typeof p !== "string" || !p.length) {
      throw new TypeError("operatorHelpCenter: audience_roles[" + i + "] must be a non-empty string");
    }
    if (operatorRoles.PERMISSIONS.indexOf(p) === -1) {
      throw new TypeError("operatorHelpCenter: audience_roles[" + i + "] " +
                          JSON.stringify(p) + " is not in the operatorRoles permission allow-list");
    }
    if (seen[p]) continue;
    seen[p] = 1;
    out.push(p);
  }
  return out;
}

function _vote(s) {
  if (typeof s !== "string" || ALLOWED_VOTES.indexOf(s) === -1) {
    throw new TypeError("operatorHelpCenter: vote must be one of " + ALLOWED_VOTES.join(", "));
  }
  return s;
}

function _limit(n, max, def, label) {
  if (n == null) return def;
  if (!Number.isInteger(n) || n <= 0 || n > max) {
    throw new TypeError("operatorHelpCenter: " + label + " must be an integer 1..." + max);
  }
  return n;
}

function _timestampRange(from, to, label) {
  if (!Number.isInteger(from) || from < 0) {
    throw new TypeError("operatorHelpCenter." + label +
                        ": from must be a non-negative integer (ms epoch)");
  }
  if (!Number.isInteger(to) || to < 0) {
    throw new TypeError("operatorHelpCenter." + label +
                        ": to must be a non-negative integer (ms epoch)");
  }
  if (from > to) {
    throw new TypeError("operatorHelpCenter." + label + ": from must be <= to");
  }
}

function _queryStr(s) {
  if (typeof s !== "string") {
    throw new TypeError("operatorHelpCenter: query must be a string");
  }
  if (s.length > MAX_QUERY_LEN) {
    throw new TypeError("operatorHelpCenter: query must be <= " + MAX_QUERY_LEN + " characters");
  }
  if (CONTROL_BYTE_BODY_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("operatorHelpCenter: query contains control / zero-width bytes");
  }
  return s;
}

function _operatorId(s) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("operatorHelpCenter: operator_id — " + (e && e.message || "invalid UUID"));
  }
}

function _role(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("operatorHelpCenter: role must be a non-empty permission token");
  }
  if (operatorRoles.PERMISSIONS.indexOf(s) === -1) {
    throw new TypeError("operatorHelpCenter: role " + JSON.stringify(s) +
                        " is not in the operatorRoles permission allow-list");
  }
  return s;
}

// ---- Markdown to HTML --------------------------------------------------
//
// Minimal in-process Markdown subset mirroring knowledgeBase /
// cmsBlocks / storefrontPages: paragraphs, headings, lists, links,
// inline code, emphasis, blockquotes, horizontal rules. Every text
// run is HTML-escaped via b.template.escapeHtml. Every link URL
// passes through b.safeUrl.parse (https-only) OR an allow-list for
// "/"-rooted absolute paths. Any URL that fails the gate is dropped
// from the rendered HTML; the anchor text falls back to inert
// escaped text. Raw HTML in the body is never passed through.

function _esc(s) {
  return b.template.escapeHtml(s);
}

function _safeLinkUrl(url) {
  if (typeof url !== "string" || !url.length || url.length > 2048) return null;
  if (CONTROL_BYTE_BODY_RE.test(url) || ZERO_WIDTH_RE.test(url)) return null;
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

function _safeParseArray(json) {
  try {
    var v = JSON.parse(json || "[]");
    return Array.isArray(v) ? v : [];
  } catch (_e) {
    return [];
  }
}

function _hydrateRow(row) {
  if (!row) return null;
  return {
    slug:              row.slug,
    title:             row.title,
    body:              row.body,
    section:           row.section,
    related_actions:   _safeParseArray(row.related_actions_json),
    audience_roles:    _safeParseArray(row.audience_roles_json),
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

function _tokenize(s) {
  var lower = String(s).toLowerCase();
  var raw = lower.split(/[^a-z0-9]+/);
  var out = [];
  for (var i = 0; i < raw.length; i += 1) {
    if (raw[i].length >= 2) out.push(raw[i]);
  }
  return out;
}

// Audience-roles match: empty list means visible to every operator;
// otherwise the operator's role-token must be in the list. The
// caller resolves the operator's effective permission set; this
// primitive sees ONE token at a time (the most-privileged one the
// caller chose to filter by).
function _audienceVisible(audienceRoles, role) {
  if (!audienceRoles || !audienceRoles.length) return true;
  if (role == null) return true;
  return audienceRoles.indexOf(role) !== -1;
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("operatorHelpCenter.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "operator-help-center-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  function _decodeCursor(cursor, label) {
    if (cursor == null) return null;
    if (typeof cursor !== "string") {
      throw new TypeError("operatorHelpCenter." + label +
                          ": cursor must be an opaque string or null");
    }
    try {
      var state = b.pagination.decodeCursor(cursor, cursorSecret);
      if (JSON.stringify(state.orderKey) !== JSON.stringify(LIST_ORDER_KEY)) {
        throw new TypeError("operatorHelpCenter." + label + ": cursor orderKey mismatch");
      }
      return state.vals;
    } catch (e) {
      if (e instanceof TypeError) throw e;
      throw new TypeError("operatorHelpCenter." + label + ": cursor — " +
                          (e && e.message || "malformed"));
    }
  }

  async function _readRow(slug) {
    var r = await query(
      "SELECT * FROM operator_help_articles WHERE slug = ?1",
      [slug],
    );
    return r.rows[0] || null;
  }

  return {
    MAX_SLUG_LEN:          MAX_SLUG_LEN,
    MAX_TITLE_LEN:         MAX_TITLE_LEN,
    MAX_BODY_LEN:          MAX_BODY_LEN,
    MAX_SECTION_LEN:       MAX_SECTION_LEN,
    MAX_ACTION_LEN:        MAX_ACTION_LEN,
    MAX_ACTION_COUNT:      MAX_ACTION_COUNT,
    MAX_AUDIENCE_COUNT:    MAX_AUDIENCE_COUNT,
    MAX_QUERY_LEN:         MAX_QUERY_LEN,
    MAX_LIST_LIMIT:        MAX_LIST_LIMIT,
    MAX_POPULAR_LIMIT:     MAX_POPULAR_LIMIT,
    MAX_SUGGEST_LIMIT:     MAX_SUGGEST_LIMIT,
    ALLOWED_VOTES:         ALLOWED_VOTES.slice(),
    SEARCH_WEIGHTS:        Object.assign({}, SEARCH_WEIGHTS),
    PERMISSIONS:           operatorRoles.PERMISSIONS,

    // Idempotent insert / update of one article. Subsequent calls
    // for the same slug update title / body / section / related
    // actions / audience roles in place. Archived articles are
    // refused — the operator must author under a fresh slug.
    defineArticle: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.defineArticle: input object required");
      }
      var slug            = _slug(input.slug);
      var title           = _title(input.title);
      var body            = _body(input.body);
      var section         = _section(input.section);
      var relatedActions  = _relatedActions(input.related_actions);
      var audienceRoles   = _audienceRoles(input.audience_roles);
      var ts              = _now();

      var existing = await _readRow(slug);
      if (existing && existing.archived_at != null) {
        throw new TypeError(
          "operatorHelpCenter.defineArticle: slug '" + slug + "' is archived"
        );
      }

      if (existing) {
        await query(
          "UPDATE operator_help_articles " +
          "SET title = ?1, body = ?2, section = ?3, related_actions_json = ?4, " +
          "    audience_roles_json = ?5, updated_at = ?6 " +
          "WHERE slug = ?7",
          [title, body, section, JSON.stringify(relatedActions),
           JSON.stringify(audienceRoles), ts, slug],
        );
      } else {
        await query(
          "INSERT INTO operator_help_articles " +
          "(slug, title, body, section, related_actions_json, audience_roles_json, " +
          " archived_at, view_count, helpful_count, not_helpful_count, " +
          " created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 0, 0, 0, ?7, ?7)",
          [slug, title, body, section, JSON.stringify(relatedActions),
           JSON.stringify(audienceRoles), ts],
        );
      }
      return _hydrateRow(await _readRow(slug));
    },

    getArticle: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.getArticle: input object required");
      }
      var slug = _slug(input.slug);
      var row = await _readRow(slug);
      if (!row) return null;
      if (row.archived_at != null) return null;
      return _hydrateRow(row);
    },

    // Section-indexed list. Cursor-paginated by (updated_at DESC,
    // slug DESC) so a tampered cursor can't skip past rows the
    // caller isn't supposed to see. `role` (optional) is a single
    // operatorRoles permission token — articles whose audience_roles
    // is non-empty and excludes that token are filtered.
    articlesForSection: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.articlesForSection: input object required");
      }
      var section    = _section(input.section);
      var role       = input.role == null ? null : _role(input.role);
      var limit      = _limit(input.limit, MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT, "limit");
      var cursorVals = _decodeCursor(input.cursor, "articlesForSection");

      var where  = ["section = ?1", "archived_at IS NULL"];
      var params = [section];
      var idx    = 2;
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
      // Over-fetch by one extra qualifying row so we can detect
      // "more rows beyond this page" without short-paging the cursor.
      // Role filter can drop rows mid-scan, so when a role is
      // supplied we scan a wider window and keep going until we
      // either fill (limit + 1) visible rows or exhaust the window.
      // Cap is bounded — in-admin help corpora are dozens to hundreds
      // of articles, not millions.
      var scanLimit = role == null
        ? limit + 1
        : Math.min((limit + 1) * 4, MAX_LIST_LIMIT * 4);
      params.push(scanLimit);
      var sql = "SELECT * FROM operator_help_articles WHERE " + where.join(" AND ") +
                " ORDER BY updated_at DESC, slug DESC LIMIT ?" + idx;
      var r = await query(sql, params);

      var visibleRaw = [];
      var hasMore = false;
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var audience = _safeParseArray(row.audience_roles_json);
        if (_audienceVisible(audience, role)) {
          if (visibleRaw.length >= limit) { hasMore = true; break; }
          visibleRaw.push(row);
        }
      }
      var hydrated = visibleRaw.map(_hydrateRow);
      var nextCursor = null;
      if (hasMore && visibleRaw.length === limit) {
        var last = visibleRaw[visibleRaw.length - 1];
        nextCursor = b.pagination.encodeCursor({
          orderKey: LIST_ORDER_KEY,
          vals:     [Number(last.updated_at), last.slug],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: hydrated, next_cursor: nextCursor };
    },

    // Ranked search-suggest. Tokenizes the query, then scans every
    // non-archived article and computes a weighted score: title-
    // token match (weight 3) + section-token match (weight 2) +
    // body-token match (weight 1). Articles with score 0 are
    // excluded; ties break on slug DESC. When `role` is supplied,
    // articles whose audience_roles excludes it are filtered before
    // scoring.
    searchSuggest: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.searchSuggest: input object required");
      }
      var queryString = _queryStr(input.query);
      var tokens      = _tokenize(queryString);
      var limit       = _limit(input.limit, MAX_SUGGEST_LIMIT, DEFAULT_SUGGEST_LIMIT, "limit");
      var role        = input.role == null ? null : _role(input.role);

      if (!tokens.length) return [];

      var r = await query(
        "SELECT * FROM operator_help_articles WHERE archived_at IS NULL",
        [],
      );

      var ranked = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var audience = _safeParseArray(row.audience_roles_json);
        if (!_audienceVisible(audience, role)) continue;

        var titleTokens   = _tokenize(row.title);
        var sectionTokens = _tokenize(row.section);
        var bodyTokens    = _tokenize(row.body);

        var score = 0;
        for (var t = 0; t < tokens.length; t += 1) {
          var token = tokens[t];
          if (titleTokens.indexOf(token)   !== -1) score += SEARCH_WEIGHTS.title;
          if (sectionTokens.indexOf(token) !== -1) score += SEARCH_WEIGHTS.section;
          if (bodyTokens.indexOf(token)    !== -1) score += SEARCH_WEIGHTS.body;
        }
        if (score > 0) {
          ranked.push({
            slug:    row.slug,
            title:   row.title,
            section: row.section,
            score:   score,
          });
        }
      }

      ranked.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (a.slug < b.slug) return 1;
        if (a.slug > b.slug) return -1;
        return 0;
      });

      return ranked.slice(0, limit);
    },

    // Append-only view log. operator_id is a strict UUID. Bumps the
    // view_count counter on the article row so popularArticles can
    // sort by combined traffic without re-aggregating the views
    // table on every read.
    recordView: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.recordView: input object required");
      }
      var slug       = _slug(input.slug);
      var operatorId = _operatorId(input.operator_id);
      var row = await _readRow(slug);
      if (!row) {
        var err = new Error("operatorHelpCenter.recordView: slug '" + slug + "' not found");
        err.code = "OPERATOR_HELP_ARTICLE_NOT_FOUND";
        throw err;
      }
      if (row.archived_at != null) {
        var aErr = new Error("operatorHelpCenter.recordView: slug '" + slug + "' is archived");
        aErr.code = "OPERATOR_HELP_ARTICLE_ARCHIVED";
        throw aErr;
      }
      var ts = _now();
      await query(
        "INSERT INTO operator_help_views (id, slug, operator_id, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4)",
        [b.uuid.v7(), slug, operatorId, ts],
      );
      await query(
        "UPDATE operator_help_articles SET view_count = view_count + 1 WHERE slug = ?1",
        [slug],
      );
      return { slug: slug, operator_id: operatorId, occurred_at: ts };
    },

    // Vote: helpful / not_helpful. Deduped at (slug, operator_id)
    // via the UNIQUE constraint — a repeat vote from the same
    // operator collapses to a no-op. The first vote wins; flipping
    // requires the operator to clear (not exposed by design — the
    // helpfulness signal is "did the article work for you the first
    // time", not "what's your current opinion").
    recordHelpfulVote: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.recordHelpfulVote: input object required");
      }
      var slug       = _slug(input.slug);
      var operatorId = _operatorId(input.operator_id);
      var vote       = _vote(input.vote);
      var row = await _readRow(slug);
      if (!row) {
        var err = new Error("operatorHelpCenter.recordHelpfulVote: slug '" + slug + "' not found");
        err.code = "OPERATOR_HELP_ARTICLE_NOT_FOUND";
        throw err;
      }
      if (row.archived_at != null) {
        var aErr = new Error("operatorHelpCenter.recordHelpfulVote: slug '" + slug + "' is archived");
        aErr.code = "OPERATOR_HELP_ARTICLE_ARCHIVED";
        throw aErr;
      }
      var ts = _now();
      var inserted = await query(
        "INSERT OR IGNORE INTO operator_help_votes (id, slug, operator_id, vote, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [b.uuid.v7(), slug, operatorId, vote, ts],
      );
      var changed = inserted && (b.sql.casWon(inserted).won);
      if (changed) {
        var col = vote === "helpful" ? "helpful_count" : "not_helpful_count";
        await query(
          "UPDATE operator_help_articles SET " + col + " = " + col + " + 1 WHERE slug = ?1",
          [slug],
        );
      }
      return { slug: slug, operator_id: operatorId, vote: vote, recorded: !!changed };
    },

    // Top-N most-viewed articles over a closed [from, to] window.
    // Views are counted from operator_help_views.occurred_at.
    // Archived articles are filtered. When `role` is supplied,
    // articles whose audience_roles excludes that token are also
    // filtered. Sorted by view count DESC, slug DESC.
    popularArticles: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("operatorHelpCenter.popularArticles: input object required");
      }
      var from  = input.from;
      var to    = input.to;
      _timestampRange(from, to, "popularArticles");
      var limit = _limit(input.limit, MAX_POPULAR_LIMIT, DEFAULT_POPULAR_LIMIT, "limit");
      var role  = input.role == null ? null : _role(input.role);

      var sql =
        "SELECT v.slug AS slug, a.audience_roles_json AS audience_roles_json, " +
        "       COUNT(*) AS views " +
        "FROM operator_help_views v " +
        "JOIN operator_help_articles a ON a.slug = v.slug " +
        "WHERE v.occurred_at >= ?1 AND v.occurred_at <= ?2 " +
        "  AND a.archived_at IS NULL " +
        "GROUP BY v.slug " +
        "ORDER BY views DESC, v.slug DESC";
      var r = await query(sql, [from, to]);
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var audience = _safeParseArray(row.audience_roles_json);
        if (!_audienceVisible(audience, role)) continue;
        out.push({ slug: row.slug, views: Number(row.views) });
        if (out.length >= limit) break;
      }
      return out;
    },

    // Archive — sets archived_at tombstone. Archived articles are
    // hidden from every read surface (getArticle, articlesForSection,
    // searchSuggest, popularArticles, recordView, recordHelpfulVote).
    // Terminal in v1 — no de-archive surface; an operator who
    // archives by mistake re-authors under a fresh slug. Operator
    // demand for un-archive can be added later via a separate
    // surface; the storage column is in place.
    archiveArticle: async function (slug) {
      slug = _slug(slug);
      var existing = await _readRow(slug);
      if (!existing) {
        var err = new Error("operatorHelpCenter.archiveArticle: slug '" + slug + "' not found");
        err.code = "OPERATOR_HELP_ARTICLE_NOT_FOUND";
        throw err;
      }
      var ts = _now();
      await query(
        "UPDATE operator_help_articles SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
        [ts, slug],
      );
      return _hydrateRow(await _readRow(slug));
    },

    // Patch any subset of { title, body, section, related_actions,
    // audience_roles }. Slug is immutable. Refuses on archived rows
    // — operator must re-author under a fresh slug.
    updateArticle: async function (slug, patch) {
      slug = _slug(slug);
      if (!patch || typeof patch !== "object") {
        throw new TypeError("operatorHelpCenter.updateArticle: patch object required");
      }
      var existing = await _readRow(slug);
      if (!existing) {
        var err = new Error("operatorHelpCenter.updateArticle: slug '" + slug + "' not found");
        err.code = "OPERATOR_HELP_ARTICLE_NOT_FOUND";
        throw err;
      }
      if (existing.archived_at != null) {
        var aErr = new Error("operatorHelpCenter.updateArticle: slug '" + slug + "' is archived");
        aErr.code = "OPERATOR_HELP_ARTICLE_ARCHIVED";
        throw aErr;
      }

      // Reject any key outside the allow-list so a typo'd field
      // doesn't silently no-op.
      var patchKeys = Object.keys(patch);
      for (var k = 0; k < patchKeys.length; k += 1) {
        if (ALLOWED_PATCH_COLUMNS.indexOf(patchKeys[k]) === -1) {
          throw new TypeError(
            "operatorHelpCenter.updateArticle: patch key " +
            JSON.stringify(patchKeys[k]) +
            " is not in the allow-list (" + ALLOWED_PATCH_COLUMNS.join(", ") + ")"
          );
        }
      }

      var sets   = [];
      var params = [];
      var idx    = 1;

      if (patch.title !== undefined) {
        sets.push("title = ?" + idx); params.push(_title(patch.title)); idx += 1;
      }
      if (patch.body !== undefined) {
        sets.push("body = ?" + idx); params.push(_body(patch.body)); idx += 1;
      }
      if (patch.section !== undefined) {
        sets.push("section = ?" + idx); params.push(_section(patch.section)); idx += 1;
      }
      if (patch.related_actions !== undefined) {
        sets.push("related_actions_json = ?" + idx);
        params.push(JSON.stringify(_relatedActions(patch.related_actions))); idx += 1;
      }
      if (patch.audience_roles !== undefined) {
        sets.push("audience_roles_json = ?" + idx);
        params.push(JSON.stringify(_audienceRoles(patch.audience_roles))); idx += 1;
      }

      var ts = _now();
      sets.push("updated_at = ?" + idx); params.push(ts); idx += 1;
      params.push(slug);

      await query(
        "UPDATE operator_help_articles SET " + sets.join(", ") + " WHERE slug = ?" + idx,
        params,
      );
      return _hydrateRow(await _readRow(slug));
    },

    // Distinct sections currently in use (excluding archived rows).
    // Drives the help-drawer section picker so operators see only
    // sections that actually have articles.
    listSections: async function () {
      var r = await query(
        "SELECT DISTINCT section FROM operator_help_articles " +
        "WHERE archived_at IS NULL ORDER BY section ASC",
        [],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        out.push(r.rows[i].section);
      }
      return out;
    },
  };
}

module.exports = {
  create:             create,
  MAX_SLUG_LEN:       MAX_SLUG_LEN,
  MAX_TITLE_LEN:      MAX_TITLE_LEN,
  MAX_BODY_LEN:       MAX_BODY_LEN,
  MAX_SECTION_LEN:    MAX_SECTION_LEN,
  MAX_ACTION_LEN:     MAX_ACTION_LEN,
  MAX_ACTION_COUNT:   MAX_ACTION_COUNT,
  MAX_AUDIENCE_COUNT: MAX_AUDIENCE_COUNT,
  MAX_QUERY_LEN:      MAX_QUERY_LEN,
  MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
  MAX_POPULAR_LIMIT:  MAX_POPULAR_LIMIT,
  MAX_SUGGEST_LIMIT:  MAX_SUGGEST_LIMIT,
  ALLOWED_VOTES:      ALLOWED_VOTES.slice(),
  SEARCH_WEIGHTS:     Object.assign({}, SEARCH_WEIGHTS),
};
