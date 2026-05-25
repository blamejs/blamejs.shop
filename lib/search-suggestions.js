/**
 * Search suggestions — autocomplete dropdown data for the storefront
 * search input. Visitors typing in the header search box expect three
 * categories side-by-side:
 *
 *   1. Top product matches by title / description prefix (sourced from
 *      the catalog primitive's existing `products.search` shape).
 *   2. Top recent popular queries other shoppers typed (aggregated
 *      from `search_query_log` over a 30-day window).
 *   3. Operator-curated featured suggestions (e.g. typing "free"
 *      surfaces "Free shipping over $50") from
 *      `featured_search_suggestions`.
 *
 * The route handler that exposes `GET /search/suggestions?q=…` is
 * wired by the storefront dispatcher separately — this primitive is
 * pure data: input shape validation, persistence, aggregation.
 *
 * Composes:
 *   - `b.crypto.namespaceHash` — every `session_id` value is hashed
 *     under namespace `"search-suggestions-session"` before any DB
 *     write. The log table never holds a recoverable customer-side
 *     identifier. Query text is NOT hashed (it's user-typed search
 *     text, not PII — operators rely on plaintext to spot zero-
 *     result terms and stock-gap signals).
 *   - `b.uuid.v7` — row id for both featured suggestions and query
 *     log entries.
 *   - `b.safeSql.assertOneOf` / `quoteIdentifier` — column
 *     allowlisting on the partial-update path so a future refactor
 *     introducing dynamic column names can't widen the attack
 *     surface to identifier injection.
 *
 * Surface:
 *   - `recordQuery({ q, session_id, result_count })` — append a row
 *     to `search_query_log`. Normalises `q` (lowercase + trim), hashes
 *     `session_id`, refuses empty / oversized queries and bad
 *     `result_count`. Returns `{ id }`.
 *   - `suggest({ q, limit? })` — returns `{ products, queries,
 *     featured }`. `products` runs through the catalog primitive's
 *     `products.search` (title + description prefix), restricted to
 *     `status: "active"`. `queries` aggregates the popular-query
 *     window (last 30 days). `featured` returns matching curated
 *     rows with `status='active'` and within their `(starts_at,
 *     expires_at)` window. `limit` (default 5) bounds each category
 *     independently.
 *   - `addFeatured({ prefix, display_text, link_url, priority?,
 *     starts_at?, expires_at? })` — operator-only. Inserts a row.
 *     Returns the new row.
 *   - `updateFeatured(id, patch)` — partial update. Allows
 *     `display_text`, `link_url`, `priority`, `starts_at`,
 *     `expires_at`, `status`. Returns the updated row, or `null` if
 *     the id didn't exist.
 *   - `deleteFeatured(id)` — operator-only. Returns
 *     `{ removed: boolean }`.
 *   - `popularQueries({ from?, to?, limit? })` — operator dashboard
 *     aggregate. Returns `[ { query_normalized, count, last_seen,
 *     zero_result_share } ]` sorted by count desc.
 *   - `cleanupOldQueries(ts)` — retention sweep; deletes rows with
 *     `occurred_at < ts`. Returns `{ removed: number }`.
 *
 * Storage:
 *   - `featured_search_suggestions` (migration
 *     `0030_search_suggestions.sql`).
 *   - `search_query_log` (same migration).
 *
 * @primitive searchSuggestions
 * @related   b.crypto.namespaceHash, b.uuid, catalog.products.search
 */

"use strict";

var SESSION_NAMESPACE     = "search-suggestions-session";
var DEFAULT_LIMIT         = 5;
var MAX_LIMIT             = 50;
var MAX_QUERY_LEN         = 200;
var MAX_PREFIX_LEN        = 100;
var MAX_DISPLAY_TEXT_LEN  = 200;
var MAX_LINK_URL_LEN      = 2048;
var MAX_RESULT_COUNT      = 1000000;
var b = require("./index").framework;
var POPULAR_WINDOW_MS     = b.constants.TIME.days(30);
var FEATURED_STATUSES     = ["active", "expired", "draft"];
var ALLOWED_FEATURED_COLS = [
  "prefix", "display_text", "link_url", "priority",
  "starts_at", "expires_at", "status",
];

function _requireObject(input, fnLabel) {
  if (!input || typeof input !== "object") {
    throw new TypeError(fnLabel + ": input object required");
  }
}

function _normalizeQuery(s, label) {
  if (typeof s !== "string") {
    throw new TypeError(label + ": q must be a string");
  }
  // Refuse control bytes so a malicious search term can't smuggle
  // header-injection-class content into operator dashboards that
  // render the term inline.
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError(label + ": q must not contain control bytes");
  }
  var trimmed = s.trim().toLowerCase();
  if (!trimmed.length) {
    throw new TypeError(label + ": q must be a non-empty string");
  }
  if (trimmed.length > MAX_QUERY_LEN) {
    throw new TypeError(label + ": q must be <= " + MAX_QUERY_LEN + " chars");
  }
  return trimmed;
}

function _normalizePrefix(s, label) {
  if (typeof s !== "string") {
    throw new TypeError(label + ": prefix must be a string");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError(label + ": prefix must not contain control bytes");
  }
  var trimmed = s.trim().toLowerCase();
  if (!trimmed.length) {
    throw new TypeError(label + ": prefix must be a non-empty string");
  }
  if (trimmed.length > MAX_PREFIX_LEN) {
    throw new TypeError(label + ": prefix must be <= " + MAX_PREFIX_LEN + " chars");
  }
  return trimmed;
}

function _displayText(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(label + ": display_text must be a non-empty string");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError(label + ": display_text must not contain control bytes");
  }
  if (s.length > MAX_DISPLAY_TEXT_LEN) {
    throw new TypeError(label + ": display_text must be <= " + MAX_DISPLAY_TEXT_LEN + " chars");
  }
  return s;
}

function _linkUrl(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(label + ": link_url must be a non-empty string");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError(label + ": link_url must not contain control bytes");
  }
  if (s.length > MAX_LINK_URL_LEN) {
    throw new TypeError(label + ": link_url must be <= " + MAX_LINK_URL_LEN + " chars");
  }
  // Refuse `javascript:` / `data:` / `vbscript:` schemes — these
  // would let a curated suggestion stage a script-in-href XSS the
  // moment a visitor clicks the dropdown row. The operator-facing
  // UI never legitimately needs these; the refusal is a hard wall,
  // not a configurable preference.
  if (/^\s*(javascript|data|vbscript):/i.test(s)) {
    throw new TypeError(label + ": link_url scheme refused");
  }
  return s;
}

function _priority(n, label) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0 || n > 1000000) {
    throw new TypeError(label + ": priority must be a non-negative integer <= 1000000");
  }
  return n;
}

function _epochMs(n, label, fnLabel) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(fnLabel + ": " + label + " must be a non-negative integer epoch-ms");
  }
  return n;
}

function _optEpochMs(n, label, fnLabel) {
  if (n == null) return null;
  return _epochMs(n, label, fnLabel);
}

function _limit(n, fnLabel) {
  if (n == null) return DEFAULT_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIMIT) {
    throw new TypeError(fnLabel + ": limit must be 1..." + MAX_LIMIT);
  }
  return n;
}

function _sessionId(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": session_id must be a non-empty string");
  }
  if (s.length > 256) {
    throw new TypeError(fnLabel + ": session_id must be <= 256 chars");
  }
  if (/[\x00-\x1f\x7f]/.test(s)) {
    throw new TypeError(fnLabel + ": session_id must not contain control bytes");
  }
  return s;
}

function _resultCount(n, fnLabel) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0 || n > MAX_RESULT_COUNT) {
    throw new TypeError(fnLabel + ": result_count must be a non-negative integer <= " + MAX_RESULT_COUNT);
  }
  return n;
}

function _featuredStatus(s, fnLabel) {
  if (FEATURED_STATUSES.indexOf(s) === -1) {
    throw new TypeError(fnLabel + ": status must be one of " + FEATURED_STATUSES.join(", "));
  }
  return s;
}

function _id(id, fnLabel) {
  if (typeof id !== "string" || !id.length) {
    throw new TypeError(fnLabel + ": id must be a non-empty string");
  }
  return id;
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog = opts.catalog || null;

  function _featuredByPrefix(qLower, limit, now) {
    // Featured rows are pinned to a specific lowercased prefix. The
    // typical match is "is this prefix exactly what the customer
    // typed so far?" — i.e. the row's prefix equals the leading
    // chars of `q`. To honour both directions (customer typed
    // `free` and the row prefix is `free`; customer typed `f` and
    // the row prefix is `free` so the operator's promo surfaces
    // early) we match either way:
    //   * `prefix = q` — exact prefix hit
    //   * `prefix LIKE q || '%'` — customer typed less than the
    //     full prefix; surface the row as soon as it's an
    //     unambiguous extension of what they've typed
    // Active + non-expired only. Ordered by priority DESC then
    // created_at DESC so an operator-pinned row wins ties.
    var pattern = qLower.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
    return query(
      "SELECT id, prefix, display_text, link_url, priority, " +
      "starts_at, expires_at, status, created_at, updated_at " +
      "FROM featured_search_suggestions " +
      "WHERE status = 'active' " +
      "AND starts_at <= ?1 " +
      "AND (expires_at IS NULL OR expires_at > ?1) " +
      "AND (prefix = ?2 OR prefix LIKE ?3 ESCAPE '\\') " +
      "ORDER BY priority DESC, created_at DESC, id DESC " +
      "LIMIT ?4",
      [now, qLower, pattern, limit],
    );
  }

  function _popularByPrefix(qLower, limit, sinceTs) {
    // Popular queries aggregate over the recent window. The
    // `query_normalized` column is already lowercased + trimmed at
    // the write site, so the LIKE pattern matches the column
    // directly. Escape clause neutralises LIKE metachars so a
    // search containing `%` or `_` matches the literal character.
    var pattern = qLower.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_") + "%";
    return query(
      "SELECT query_normalized, COUNT(*) AS count, MAX(occurred_at) AS last_seen " +
      "FROM search_query_log " +
      "WHERE occurred_at >= ?1 " +
      "AND query_normalized LIKE ?2 ESCAPE '\\' " +
      "GROUP BY query_normalized " +
      "ORDER BY count DESC, last_seen DESC " +
      "LIMIT ?3",
      [sinceTs, pattern, limit],
    );
  }

  return {
    SESSION_NAMESPACE: SESSION_NAMESPACE,
    POPULAR_WINDOW_MS: POPULAR_WINDOW_MS,

    recordQuery: async function (input) {
      _requireObject(input, "searchSuggestions.recordQuery");
      var qNorm        = _normalizeQuery(input.q, "searchSuggestions.recordQuery");
      var sessionId    = _sessionId(input.session_id, "searchSuggestions.recordQuery");
      var resultCount  = _resultCount(input.result_count, "searchSuggestions.recordQuery");
      var sessionHash  = b.crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
      var id           = b.uuid.v7();
      var now          = Date.now();
      await query(
        "INSERT INTO search_query_log " +
        "(id, query_normalized, session_id_hash, result_count, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, qNorm, sessionHash, resultCount, now],
      );
      return { id: id };
    },

    suggest: async function (input) {
      input = input || {};
      var qNorm   = _normalizeQuery(input.q, "searchSuggestions.suggest");
      var limit   = _limit(input.limit, "searchSuggestions.suggest");
      var now     = Date.now();
      var sinceTs = now - POPULAR_WINDOW_MS;

      // Featured + popular run as independent queries against this
      // primitive's own tables. Product matches delegate to the
      // catalog primitive's existing `products.search` shape so the
      // dropdown stays consistent with what `/search?q=…` would
      // return (case-insensitive title + description LIKE, status
      // active only).
      var featuredP = _featuredByPrefix(qNorm, limit, now);
      var popularP  = _popularByPrefix(qNorm, limit, sinceTs);
      var productsP;
      if (catalog && catalog.products && typeof catalog.products.search === "function") {
        productsP = catalog.products.search({ q: qNorm, status: "active", limit: limit });
      } else {
        productsP = Promise.resolve({ rows: [], next_cursor: null });
      }

      var resolved = await Promise.all([featuredP, popularP, productsP]);
      var featuredR = resolved[0];
      var popularR  = resolved[1];
      var productsR = resolved[2];

      var queries = [];
      for (var i = 0; i < popularR.rows.length; i += 1) {
        var row = popularR.rows[i];
        queries.push({
          query_normalized: row.query_normalized,
          count:            Number(row.count),
          last_seen:        Number(row.last_seen),
        });
      }
      var featured = [];
      for (var j = 0; j < featuredR.rows.length; j += 1) {
        var f = featuredR.rows[j];
        featured.push({
          id:           f.id,
          prefix:       f.prefix,
          display_text: f.display_text,
          link_url:     f.link_url,
          priority:     Number(f.priority),
          starts_at:    Number(f.starts_at),
          expires_at:   f.expires_at == null ? null : Number(f.expires_at),
          status:       f.status,
        });
      }
      // The catalog primitive returns `{ rows, next_cursor }`; the
      // dropdown only consumes the rows array. Pass through as-is
      // so the route handler can render the same shape it would
      // get from a `/search` request.
      var products = Array.isArray(productsR && productsR.rows) ? productsR.rows : [];
      return {
        products: products,
        queries:  queries,
        featured: featured,
      };
    },

    addFeatured: async function (input) {
      _requireObject(input, "searchSuggestions.addFeatured");
      var prefix      = _normalizePrefix(input.prefix, "searchSuggestions.addFeatured");
      var displayText = _displayText(input.display_text, "searchSuggestions.addFeatured");
      var linkUrl     = _linkUrl(input.link_url, "searchSuggestions.addFeatured");
      var priority    = _priority(input.priority, "searchSuggestions.addFeatured");
      var now         = Date.now();
      var startsAt    = input.starts_at == null
        ? now
        : _epochMs(input.starts_at, "starts_at", "searchSuggestions.addFeatured");
      var expiresAt   = _optEpochMs(input.expires_at, "expires_at", "searchSuggestions.addFeatured");
      if (expiresAt != null && expiresAt <= startsAt) {
        throw new TypeError("searchSuggestions.addFeatured: expires_at must be > starts_at");
      }
      var status      = input.status == null ? "active" : _featuredStatus(input.status, "searchSuggestions.addFeatured");
      var id          = b.uuid.v7();
      await query(
        "INSERT INTO featured_search_suggestions " +
        "(id, prefix, display_text, link_url, priority, starts_at, expires_at, status, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        [id, prefix, displayText, linkUrl, priority, startsAt, expiresAt, status, now],
      );
      var row = (await query(
        "SELECT * FROM featured_search_suggestions WHERE id = ?1 LIMIT 1",
        [id],
      )).rows[0];
      return row || null;
    },

    updateFeatured: async function (id, patch) {
      _id(id, "searchSuggestions.updateFeatured");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("searchSuggestions.updateFeatured: patch object required");
      }
      var sets   = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        // Defense in depth — the column literal here is hand-
        // written, but route every dynamic identifier through the
        // safeSql allowlist so a future refactor that widens the
        // column set can't smuggle identifier injection past the
        // gate.
        b.safeSql.assertOneOf(col, ALLOWED_FEATURED_COLS);
        sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (patch.prefix !== undefined) {
        _addSet("prefix", _normalizePrefix(patch.prefix, "searchSuggestions.updateFeatured"));
      }
      if (patch.display_text !== undefined) {
        _addSet("display_text", _displayText(patch.display_text, "searchSuggestions.updateFeatured"));
      }
      if (patch.link_url !== undefined) {
        _addSet("link_url", _linkUrl(patch.link_url, "searchSuggestions.updateFeatured"));
      }
      if (patch.priority !== undefined) {
        _addSet("priority", _priority(patch.priority, "searchSuggestions.updateFeatured"));
      }
      if (patch.starts_at !== undefined) {
        _addSet("starts_at", _epochMs(patch.starts_at, "starts_at", "searchSuggestions.updateFeatured"));
      }
      if (patch.expires_at !== undefined) {
        _addSet("expires_at", patch.expires_at == null
          ? null
          : _epochMs(patch.expires_at, "expires_at", "searchSuggestions.updateFeatured"));
      }
      if (patch.status !== undefined) {
        _addSet("status", _featuredStatus(patch.status, "searchSuggestions.updateFeatured"));
      }
      if (sets.length === 0) {
        // No-op update — callers shouldn't rely on a heartbeat
        // updated_at flip from an empty patch; throw so the caller
        // is explicit about intent.
        throw new TypeError("searchSuggestions.updateFeatured: patch contained no updatable fields");
      }
      sets.push("updated_at = ?" + (i++));
      params.push(Date.now());
      params.push(id);
      var r = await query(
        "UPDATE featured_search_suggestions SET " + sets.join(", ") + " WHERE id = ?" + i,
        params,
      );
      if (r.rowCount === 0) return null;
      var row = (await query(
        "SELECT * FROM featured_search_suggestions WHERE id = ?1 LIMIT 1",
        [id],
      )).rows[0];
      return row || null;
    },

    deleteFeatured: async function (id) {
      _id(id, "searchSuggestions.deleteFeatured");
      var r = await query(
        "DELETE FROM featured_search_suggestions WHERE id = ?1",
        [id],
      );
      return { removed: Number(r.rowCount || 0) > 0 };
    },

    popularQueries: async function (popOpts) {
      popOpts = popOpts || {};
      var now    = Date.now();
      var from   = popOpts.from == null
        ? now - POPULAR_WINDOW_MS
        : _epochMs(popOpts.from, "from", "searchSuggestions.popularQueries");
      var to     = popOpts.to == null
        ? now
        : _epochMs(popOpts.to, "to", "searchSuggestions.popularQueries");
      if (to < from) {
        throw new TypeError("searchSuggestions.popularQueries: to must be >= from");
      }
      var limit  = _limit(popOpts.limit, "searchSuggestions.popularQueries");
      var rows = (await query(
        "SELECT query_normalized, " +
        "COUNT(*) AS count, " +
        "MAX(occurred_at) AS last_seen, " +
        "SUM(CASE WHEN result_count = 0 THEN 1 ELSE 0 END) AS zero_count " +
        "FROM search_query_log " +
        "WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
        "GROUP BY query_normalized " +
        "ORDER BY count DESC, last_seen DESC " +
        "LIMIT ?3",
        [from, to, limit],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var count = Number(rows[i].count);
        var zero  = Number(rows[i].zero_count || 0);
        out.push({
          query_normalized:   rows[i].query_normalized,
          count:              count,
          last_seen:          Number(rows[i].last_seen),
          zero_result_share:  count === 0 ? 0 : zero / count,
        });
      }
      return out;
    },

    cleanupOldQueries: async function (ts) {
      if (!Number.isInteger(ts) || ts < 0) {
        throw new TypeError("searchSuggestions.cleanupOldQueries: ts must be a non-negative integer epoch-ms");
      }
      var r = await query(
        "DELETE FROM search_query_log WHERE occurred_at < ?1",
        [ts],
      );
      return { removed: Number(r.rowCount || 0) };
    },
  };
}

module.exports = {
  create: create,
};
