"use strict";
/**
 * @module shop.searchFacets
 * @title  Search facets — filter-chip + facet-count surface for the
 *         storefront search results page
 *
 * @intro
 *   Storefront search results render the typical e-commerce filter
 *   chrome — "Brand: Nike (12), Adidas (8)", "Price: Under $25 (4),
 *   $25-$50 (9)", "In stock (15)". This primitive owns the two
 *   sides of that surface:
 *
 *     1. **Registry** — operators declare which product fields are
 *        facetable and what shape each facet takes. Three kinds are
 *        supported:
 *
 *          * `categorical`   — distinct values surfaced with their
 *            counts (e.g. tags, vendor, category). An optional
 *            `display_limit` caps how many options surface so a
 *            high-cardinality field doesn't blow the dropdown.
 *          * `numeric_range` — counts grouped into operator-defined
 *            buckets stored as `[{ label, min, max }]` (min
 *            inclusive, max exclusive; `null` on either side is
 *            unbounded). Used for prices, weights, ratings.
 *          * `boolean`       — two-option facet (true / false)
 *            keyed on a truthy field value. Used for "in stock",
 *            "on sale", "subscribable".
 *
 *     2. **Compute** — `getFacets` runs the registered facets
 *        against the catalog's matching products for a given query +
 *        applied filters, returning per-facet option lists with
 *        counts and selection state. Counts are computed in-memory
 *        against the catalog's flat row shape; the SQL aggregation
 *        path lives in the catalog primitive (which knows how to
 *        index the underlying field), not here. This split keeps
 *        the facet registry portable across whichever search
 *        backend the operator chooses.
 *
 *   `previewQuery({ query, filters })` returns the product count +
 *   a sample of matching products for a candidate filter
 *   combination — used by the storefront to render "Show 23 results"
 *   before the shopper commits the click.
 *
 *   `recordFacetUse({ key, value, session_id })` appends an
 *   analytics row. The session id is namespaceHashed under
 *   `"search-facet-session"` so the log never holds a recoverable
 *   customer-side identifier. Operator dashboards read the log to
 *   spot facets nobody touches (candidates for removal) and
 *   high-traffic values (candidates for promotion to the navigation
 *   chrome).
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — session id hashing on every
 *       analytics write.
 *     - `b.uuid.v7` — row id for usage log entries. Facet rows
 *       themselves are keyed on the operator-chosen `key` so the
 *       authoring UI can patch / archive by a stable handle.
 *     - `b.safeSql.assertOneOf` / `quoteIdentifier` — column
 *       allowlist guards on the partial-update path so a future
 *       refactor introducing dynamic column names can't widen the
 *       attack surface to identifier injection.
 *
 *   Surface:
 *     - defineFacet({ key, field, kind, buckets?, display_limit? })
 *     - listFacets({ include_archived?, limit?, offset? })
 *     - updateFacet(key, patch)
 *     - archiveFacet(key)
 *     - getFacets({ query?, applied_filters?, scope? })
 *     - previewQuery({ query?, filters })
 *     - recordFacetUse({ key, value, session_id })
 *
 *   Catalog contract — the operator passes a `catalog` to the
 *   factory. `catalog.list({ query, applied_filters, scope })` is
 *   the read shape; it must return
 *   `{ rows: [{ id, title?, tags?, vendor?, category?, price_minor?,
 *     in_stock?, ... }] }`. The primitive walks the rows in-memory
 *   to compute counts; a backend swap (D1 -> Postgres -> Algolia)
 *   only touches the catalog binding, not the facet registry.
 *
 *   Storage:
 *     - `search_facets`        (migration `0082_search_facets.sql`)
 *     - `search_facet_usage`   (same migration)
 *
 * @primitive searchFacets
 * @related   b.crypto.namespaceHash, b.uuid, b.safeSql, catalog
 */

var SESSION_NAMESPACE       = "search-facet-session";
var DEFAULT_LIST_LIMIT      = 100;
var MAX_LIST_LIMIT          = 500;
var DEFAULT_PREVIEW_SAMPLE  = 10;
var MAX_PREVIEW_SAMPLE      = 100;
var MAX_KEY_LEN             = 64;
var MAX_FIELD_LEN           = 64;
var MAX_VALUE_LEN           = 256;
var MAX_LABEL_LEN           = 128;
var MAX_BUCKETS             = 32;
var MAX_DISPLAY_LIMIT       = 1000;
var MAX_QUERY_LEN           = 500;
var MAX_FILTERS             = 32;
var MAX_FILTER_VALUES       = 64;

var ALLOWED_KINDS  = ["categorical", "numeric_range", "boolean"];
var ALLOWED_COLS   = ["field", "kind", "buckets_json", "display_limit", "active"];

// Refuse C0 control bytes + DEL on every operator-supplied string.
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;

// Operator-chosen identifier shape — lowercase alnum + hyphen +
// underscore, must start with a letter. Same shape the rest of the
// shop uses for `slug`-like surfaces.
var KEY_RE   = /^[a-z][a-z0-9_-]*$/;
// `field` may reference nested-ish catalog row keys but here we
// keep it to the same identifier shape so column-allowlist defenses
// further downstream don't have to special-case dotted paths.
var FIELD_RE = /^[a-z][a-z0-9_-]*$/;

var b = require("./index").framework;

// ---- validators ---------------------------------------------------------

function _requireObject(input, fnLabel) {
  if (!input || typeof input !== "object") {
    throw new TypeError(fnLabel + ": input object required");
  }
}

function _key(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": key must be a non-empty string");
  }
  if (s.length > MAX_KEY_LEN) {
    throw new TypeError(fnLabel + ": key must be <= " + MAX_KEY_LEN + " characters");
  }
  if (!KEY_RE.test(s)) {
    throw new TypeError(fnLabel + ": key must match /^[a-z][a-z0-9_-]*$/");
  }
  return s;
}

function _field(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": field must be a non-empty string");
  }
  if (s.length > MAX_FIELD_LEN) {
    throw new TypeError(fnLabel + ": field must be <= " + MAX_FIELD_LEN + " characters");
  }
  if (!FIELD_RE.test(s)) {
    throw new TypeError(fnLabel + ": field must match /^[a-z][a-z0-9_-]*$/");
  }
  return s;
}

function _kind(s, fnLabel) {
  if (typeof s !== "string" || ALLOWED_KINDS.indexOf(s) === -1) {
    throw new TypeError(fnLabel + ": kind must be one of " + ALLOWED_KINDS.join(", "));
  }
  return s;
}

function _displayLimit(n, fnLabel) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_DISPLAY_LIMIT) {
    throw new TypeError(fnLabel + ": display_limit must be an integer 1..." + MAX_DISPLAY_LIMIT);
  }
  return n;
}

function _label(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": bucket label must be a non-empty string");
  }
  if (s.length > MAX_LABEL_LEN) {
    throw new TypeError(fnLabel + ": bucket label must be <= " + MAX_LABEL_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError(fnLabel + ": bucket label must not contain control bytes");
  }
  return s;
}

function _bucketBound(n, label, fnLabel) {
  if (n == null) return null;
  if (typeof n !== "number" || !isFinite(n)) {
    throw new TypeError(fnLabel + ": bucket " + label + " must be a finite number or null");
  }
  return n;
}

function _buckets(input, fnLabel) {
  if (!Array.isArray(input)) {
    throw new TypeError(fnLabel + ": buckets must be an array of { label, min, max }");
  }
  if (input.length < 1) {
    throw new TypeError(fnLabel + ": buckets must contain at least 1 entry");
  }
  if (input.length > MAX_BUCKETS) {
    throw new TypeError(fnLabel + ": buckets must contain <= " + MAX_BUCKETS + " entries");
  }
  var out  = [];
  var seen = {};
  for (var i = 0; i < input.length; i += 1) {
    var bk = input[i];
    if (!bk || typeof bk !== "object") {
      throw new TypeError(fnLabel + ": buckets[" + i + "] must be an object");
    }
    var lab = _label(bk.label, fnLabel);
    if (seen[lab]) {
      throw new TypeError(fnLabel + ": bucket labels must be unique (got '" + lab + "' twice)");
    }
    seen[lab] = true;
    var min = _bucketBound(bk.min, "min",  fnLabel);
    var max = _bucketBound(bk.max, "max",  fnLabel);
    if (min != null && max != null && min >= max) {
      throw new TypeError(fnLabel + ": bucket '" + lab + "' min must be < max");
    }
    out.push({ label: lab, min: min, max: max });
  }
  return out;
}

function _limit(n, fnLabel) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError(fnLabel + ": limit must be an integer 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _offset(n, fnLabel) {
  if (n == null) return 0;
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(fnLabel + ": offset must be a non-negative integer");
  }
  return n;
}

function _sampleSize(n, fnLabel) {
  if (n == null) return DEFAULT_PREVIEW_SAMPLE;
  if (!Number.isInteger(n) || n < 0 || n > MAX_PREVIEW_SAMPLE) {
    throw new TypeError(fnLabel + ": sample must be an integer 0..." + MAX_PREVIEW_SAMPLE);
  }
  return n;
}

function _optQuery(s, fnLabel) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError(fnLabel + ": query must be a string or null");
  }
  if (s.length > MAX_QUERY_LEN) {
    throw new TypeError(fnLabel + ": query must be <= " + MAX_QUERY_LEN + " characters");
  }
  return s;
}

function _appliedFilters(input, fnLabel) {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError(fnLabel + ": applied_filters must be an object");
  }
  var keys = Object.keys(input);
  if (keys.length > MAX_FILTERS) {
    throw new TypeError(fnLabel + ": applied_filters must contain <= " + MAX_FILTERS + " keys");
  }
  var out = {};
  for (var i = 0; i < keys.length; i += 1) {
    var k = _key(keys[i], fnLabel);
    var v = input[keys[i]];
    if (!Array.isArray(v)) {
      throw new TypeError(fnLabel + ": applied_filters['" + k + "'] must be an array of values");
    }
    if (v.length > MAX_FILTER_VALUES) {
      throw new TypeError(fnLabel + ": applied_filters['" + k + "'] must contain <= " + MAX_FILTER_VALUES + " values");
    }
    var values = [];
    for (var j = 0; j < v.length; j += 1) {
      var raw = v[j];
      var s;
      if (typeof raw === "boolean") {
        s = raw ? "true" : "false";
      } else if (typeof raw === "number" && isFinite(raw)) {
        s = String(raw);
      } else if (typeof raw === "string") {
        s = raw;
      } else {
        throw new TypeError(fnLabel + ": applied_filters['" + k + "'][" + j + "] must be a string, number, or boolean");
      }
      if (s.length > MAX_VALUE_LEN) {
        throw new TypeError(fnLabel + ": applied_filters['" + k + "'][" + j + "] must be <= " + MAX_VALUE_LEN + " characters");
      }
      if (CONTROL_BYTE_RE.test(s)) {
        throw new TypeError(fnLabel + ": applied_filters['" + k + "'][" + j + "] must not contain control bytes");
      }
      values.push(s);
    }
    out[k] = values;
  }
  return out;
}

function _value(raw, fnLabel) {
  var s;
  if (typeof raw === "boolean") {
    s = raw ? "true" : "false";
  } else if (typeof raw === "number" && isFinite(raw)) {
    s = String(raw);
  } else if (typeof raw === "string") {
    s = raw;
  } else {
    throw new TypeError(fnLabel + ": value must be a string, number, or boolean");
  }
  if (!s.length) {
    throw new TypeError(fnLabel + ": value must be non-empty");
  }
  if (s.length > MAX_VALUE_LEN) {
    throw new TypeError(fnLabel + ": value must be <= " + MAX_VALUE_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError(fnLabel + ": value must not contain control bytes");
  }
  return s;
}

function _sessionId(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": session_id must be a non-empty string");
  }
  if (s.length > 256) {
    throw new TypeError(fnLabel + ": session_id must be <= 256 characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError(fnLabel + ": session_id must not contain control bytes");
  }
  return s;
}

// ---- in-memory facet computation ----------------------------------------

// Coerce an arbitrary field value into the array shape every facet
// counter walks. Tags-style array fields stay as arrays; scalar fields
// wrap into a single-element array. Missing / null / undefined fields
// produce an empty array (the row contributes no count to that facet).
function _coerceFieldValues(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function _stringifyValue(v) {
  if (v == null) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number")  return String(v);
  if (typeof v === "string")  return v;
  return null;
}

// `numeric_range` bucketing — a row's value lands in the first bucket
// whose [min, max) window contains it. Unbounded ends are honoured
// (null min = -Inf, null max = +Inf). Non-numeric values are dropped.
function _bucketOf(buckets, raw) {
  if (typeof raw !== "number" || !isFinite(raw)) return null;
  for (var i = 0; i < buckets.length; i += 1) {
    var bk = buckets[i];
    var minOk = bk.min == null || raw >= bk.min;
    var maxOk = bk.max == null || raw <  bk.max;
    if (minOk && maxOk) return bk.label;
  }
  return null;
}

// Apply an `applied_filters` set to one row. A row passes if every
// applied facet either selected one of the row's values (categorical
// / boolean) or selected a bucket containing the row's numeric value
// (numeric_range). Facets the operator didn't register are ignored
// rather than refused so a stale URL with a removed-facet param
// degrades gracefully.
function _rowPassesFilters(facetsByKey, row, filters) {
  var keys = Object.keys(filters);
  for (var i = 0; i < keys.length; i += 1) {
    var fk     = keys[i];
    var facet  = facetsByKey[fk];
    if (!facet) continue;
    var wanted = filters[fk];
    if (!wanted.length) continue;
    var fieldValues = _coerceFieldValues(row[facet.field]);
    if (facet.kind === "numeric_range") {
      var labels = [];
      for (var v = 0; v < fieldValues.length; v += 1) {
        var lab = _bucketOf(facet.buckets || [], fieldValues[v]);
        if (lab != null) labels.push(lab);
      }
      var hit = false;
      for (var w = 0; w < wanted.length; w += 1) {
        if (labels.indexOf(wanted[w]) !== -1) { hit = true; break; }
      }
      if (!hit) return false;
    } else if (facet.kind === "boolean") {
      // Boolean facets test truthiness of the field; the wanted
      // value is the stringified boolean ("true" / "false").
      var truthy = false;
      for (var t = 0; t < fieldValues.length; t += 1) {
        if (fieldValues[t]) { truthy = true; break; }
      }
      var asStr = truthy ? "true" : "false";
      if (wanted.indexOf(asStr) === -1) return false;
    } else {
      var stringified = [];
      for (var s = 0; s < fieldValues.length; s += 1) {
        var sv = _stringifyValue(fieldValues[s]);
        if (sv != null) stringified.push(sv);
      }
      var anyHit = false;
      for (var sw = 0; sw < wanted.length; sw += 1) {
        if (stringified.indexOf(wanted[sw]) !== -1) { anyHit = true; break; }
      }
      if (!anyHit) return false;
    }
  }
  return true;
}

function _countFacet(facet, rows, applied) {
  // For the facet currently being counted, drop ITS own constraint
  // from the applied set — otherwise a shopper who selects "Brand:
  // Nike" would only see "Brand: Nike (N)" with every other brand
  // dropped to 0. The standard e-commerce facet UX is "show every
  // other option's count as if this facet were unselected." Apply
  // every OTHER filter as a normal AND.
  var filtersWithoutSelf = {};
  var keys = Object.keys(applied);
  for (var i = 0; i < keys.length; i += 1) {
    if (keys[i] !== facet.key) filtersWithoutSelf[keys[i]] = applied[keys[i]];
  }
  // The walker uses the facet definition to interpret each
  // remaining filter; the caller supplies the registered facets
  // via the `facetsByKey` argument.
  return function (facetsByKey) {
    var matching = [];
    for (var r = 0; r < rows.length; r += 1) {
      if (_rowPassesFilters(facetsByKey, rows[r], filtersWithoutSelf)) {
        matching.push(rows[r]);
      }
    }
    // Now tabulate this facet's values.
    var counts = {};
    if (facet.kind === "numeric_range") {
      for (var n = 0; n < matching.length; n += 1) {
        var vals = _coerceFieldValues(matching[n][facet.field]);
        var seen = {};
        for (var nv = 0; nv < vals.length; nv += 1) {
          var lab = _bucketOf(facet.buckets || [], vals[nv]);
          if (lab == null || seen[lab]) continue;
          seen[lab] = true;
          counts[lab] = (counts[lab] || 0) + 1;
        }
      }
      var out = [];
      var bucketDefs = facet.buckets || [];
      for (var bi = 0; bi < bucketDefs.length; bi += 1) {
        out.push({ value: bucketDefs[bi].label, label: bucketDefs[bi].label, count: counts[bucketDefs[bi].label] || 0 });
      }
      return out;
    }
    if (facet.kind === "boolean") {
      var trueCount  = 0;
      var falseCount = 0;
      for (var m = 0; m < matching.length; m += 1) {
        var fv = _coerceFieldValues(matching[m][facet.field]);
        var anyTruthy = false;
        for (var fvi = 0; fvi < fv.length; fvi += 1) {
          if (fv[fvi]) { anyTruthy = true; break; }
        }
        if (anyTruthy) trueCount += 1;
        else           falseCount += 1;
      }
      return [
        { value: "true",  label: "Yes", count: trueCount  },
        { value: "false", label: "No",  count: falseCount },
      ];
    }
    // categorical
    for (var c = 0; c < matching.length; c += 1) {
      var cv = _coerceFieldValues(matching[c][facet.field]);
      var ckSeen = {};
      for (var ci = 0; ci < cv.length; ci += 1) {
        var sv = _stringifyValue(cv[ci]);
        if (sv == null || ckSeen[sv]) continue;
        ckSeen[sv] = true;
        counts[sv] = (counts[sv] || 0) + 1;
      }
    }
    var coKeys = Object.keys(counts);
    coKeys.sort(function (a, b) {
      if (counts[b] !== counts[a]) return counts[b] - counts[a];
      if (a < b) return -1;
      if (a > b) return 1;
      return 0;
    });
    var co = [];
    for (var k = 0; k < coKeys.length; k += 1) {
      co.push({ value: coKeys[k], label: coKeys[k], count: counts[coKeys[k]] });
    }
    if (facet.display_limit != null && co.length > facet.display_limit) {
      co = co.slice(0, facet.display_limit);
    }
    return co;
  };
}

function _hydrateFacet(row) {
  if (!row) return null;
  var buckets = null;
  if (row.buckets_json != null) {
    try { buckets = JSON.parse(row.buckets_json); }
    catch (_e) { buckets = null; }                                     // allow:empty-catch-swallow — malformed buckets fall back to null; the row is still surfaced so the operator can re-author
    if (!Array.isArray(buckets)) buckets = null;
  }
  return {
    key:           row.key,
    field:         row.field,
    kind:          row.kind,
    buckets:       buckets,
    display_limit: row.display_limit == null ? null : Number(row.display_limit),
    active:        Number(row.active) === 1,
    archived_at:   row.archived_at == null ? null : Number(row.archived_at),
    created_at:    Number(row.created_at),
    updated_at:    Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var catalog = opts.catalog || null;
  if (!catalog || typeof catalog.list !== "function") {
    throw new TypeError("searchFacets.create: catalog with a .list({ query, applied_filters, scope }) function required");
  }

  // In-memory facet registry cache — invalidated on every write.
  var _facetsCache = null;

  function _invalidate() { _facetsCache = null; }

  async function _loadFacets() {
    if (_facetsCache) return _facetsCache;
    var rows = (await query(
      "SELECT key, field, kind, buckets_json, display_limit, active, archived_at, created_at, updated_at " +
      "FROM search_facets WHERE archived_at IS NULL AND active = 1 " +
      "ORDER BY created_at ASC, key ASC",
      []
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var h = _hydrateFacet(rows[i]);
      if (h) out.push(h);
    }
    _facetsCache = out;
    return out;
  }

  return {
    SESSION_NAMESPACE: SESSION_NAMESPACE,
    ALLOWED_KINDS:     ALLOWED_KINDS.slice(),

    defineFacet: async function (input) {
      _requireObject(input, "searchFacets.defineFacet");
      var key   = _key(input.key, "searchFacets.defineFacet");
      var field = _field(input.field, "searchFacets.defineFacet");
      var kind  = _kind(input.kind, "searchFacets.defineFacet");
      var bucketsJson = null;
      var displayLimit = null;
      if (kind === "numeric_range") {
        if (input.buckets == null) {
          throw new TypeError("searchFacets.defineFacet: numeric_range requires buckets");
        }
        bucketsJson = JSON.stringify(_buckets(input.buckets, "searchFacets.defineFacet"));
      } else if (input.buckets != null) {
        throw new TypeError("searchFacets.defineFacet: buckets only valid for kind=numeric_range");
      }
      if (kind === "categorical") {
        displayLimit = _displayLimit(input.display_limit, "searchFacets.defineFacet");
      } else if (input.display_limit != null) {
        throw new TypeError("searchFacets.defineFacet: display_limit only valid for kind=categorical");
      }
      var now = Date.now();
      try {
        await query(
          "INSERT INTO search_facets " +
          "(key, field, kind, buckets_json, display_limit, active, archived_at, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, 1, NULL, ?6, ?6)",
          [key, field, kind, bucketsJson, displayLimit, now]
        );
      } catch (e) {
        if (e && /UNIQUE|PRIMARY KEY|constraint/i.test(String(e.message || e))) {
          throw new TypeError("searchFacets.defineFacet: key already exists: " + key);
        }
        throw e;
      }
      _invalidate();
      var row = (await query(
        "SELECT key, field, kind, buckets_json, display_limit, active, archived_at, created_at, updated_at " +
        "FROM search_facets WHERE key = ?1 LIMIT 1",
        [key]
      )).rows[0];
      return _hydrateFacet(row);
    },

    listFacets: async function (listOpts) {
      listOpts = listOpts || {};
      var includeArchived = listOpts.include_archived === true;
      var limit  = _limit(listOpts.limit,  "searchFacets.listFacets");
      var offset = _offset(listOpts.offset, "searchFacets.listFacets");
      var sql = "SELECT key, field, kind, buckets_json, display_limit, active, archived_at, created_at, updated_at " +
                "FROM search_facets ";
      if (!includeArchived) sql += "WHERE archived_at IS NULL ";
      sql += "ORDER BY created_at ASC, key ASC LIMIT ?1 OFFSET ?2";
      var rows = (await query(sql, [limit, offset])).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        var h = _hydrateFacet(rows[i]);
        if (h) out.push(h);
      }
      return out;
    },

    updateFacet: async function (key, patch) {
      var k = _key(key, "searchFacets.updateFacet");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("searchFacets.updateFacet: patch object required");
      }
      // Need the current kind so we can validate buckets / display_limit
      // against the right facet shape.
      var existing = (await query(
        "SELECT key, field, kind, buckets_json, display_limit, active, archived_at, created_at, updated_at " +
        "FROM search_facets WHERE key = ?1 LIMIT 1",
        [k]
      )).rows[0];
      if (!existing) return null;
      var effectiveKind = patch.kind === undefined ? existing.kind : _kind(patch.kind, "searchFacets.updateFacet");
      var sets   = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        b.safeSql.assertOneOf(col, ALLOWED_COLS);
        sets.push(b.safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (patch.field !== undefined) {
        _addSet("field", _field(patch.field, "searchFacets.updateFacet"));
      }
      if (patch.kind !== undefined) {
        _addSet("kind", effectiveKind);
      }
      if (patch.buckets !== undefined) {
        if (effectiveKind !== "numeric_range") {
          throw new TypeError("searchFacets.updateFacet: buckets only valid for kind=numeric_range");
        }
        _addSet("buckets_json", patch.buckets == null
          ? null
          : JSON.stringify(_buckets(patch.buckets, "searchFacets.updateFacet")));
      } else if (patch.kind !== undefined && effectiveKind !== "numeric_range") {
        // Switching away from numeric_range — null the buckets.
        _addSet("buckets_json", null);
      }
      if (patch.display_limit !== undefined) {
        if (effectiveKind !== "categorical") {
          throw new TypeError("searchFacets.updateFacet: display_limit only valid for kind=categorical");
        }
        _addSet("display_limit", _displayLimit(patch.display_limit, "searchFacets.updateFacet"));
      } else if (patch.kind !== undefined && effectiveKind !== "categorical") {
        _addSet("display_limit", null);
      }
      if (patch.active !== undefined) {
        if (typeof patch.active !== "boolean") {
          throw new TypeError("searchFacets.updateFacet: active must be a boolean");
        }
        _addSet("active", patch.active ? 1 : 0);
      }
      if (sets.length === 0) {
        throw new TypeError("searchFacets.updateFacet: patch contained no updatable fields");
      }
      sets.push("updated_at = ?" + (i++));
      params.push(Date.now());
      params.push(k);
      var r = await query(
        "UPDATE search_facets SET " + sets.join(", ") + " WHERE key = ?" + i,
        params
      );
      if (r.rowCount === 0) return null;
      _invalidate();
      var row = (await query(
        "SELECT key, field, kind, buckets_json, display_limit, active, archived_at, created_at, updated_at " +
        "FROM search_facets WHERE key = ?1 LIMIT 1",
        [k]
      )).rows[0];
      return row ? _hydrateFacet(row) : null;
    },

    archiveFacet: async function (key) {
      var k = _key(key, "searchFacets.archiveFacet");
      var now = Date.now();
      var r = await query(
        "UPDATE search_facets SET archived_at = ?1, active = 0, updated_at = ?1 " +
        "WHERE key = ?2 AND archived_at IS NULL",
        [now, k]
      );
      _invalidate();
      return { archived: Number(r.rowCount || 0) > 0 };
    },

    getFacets: async function (input) {
      input = input || {};
      var qStr    = _optQuery(input.query, "searchFacets.getFacets");
      var applied = _appliedFilters(input.applied_filters, "searchFacets.getFacets");
      var scope   = input.scope == null ? null : input.scope;
      if (scope != null && typeof scope !== "object") {
        throw new TypeError("searchFacets.getFacets: scope must be an object or null");
      }

      var facets = await _loadFacets();
      // Lookup map every counter consults when filtering rows for
      // the "leave-this-facet-unconstrained" view.
      var facetsByKey = {};
      for (var fi = 0; fi < facets.length; fi += 1) {
        facetsByKey[facets[fi].key] = facets[fi];
      }

      // Pull the matching rows ONCE — every facet counter walks the
      // same in-memory snapshot. The catalog binding owns the actual
      // search semantics (LIKE / FTS / external service); the facet
      // primitive only consumes the rows it returns.
      var matched = await catalog.list({
        query:            qStr,
        applied_filters:  {},                 // counts are computed by leaving the focal facet open; the per-facet walker drops the focal constraint before counting
        scope:            scope,
      });
      var rows = (matched && Array.isArray(matched.rows)) ? matched.rows : [];

      var out = [];
      for (var f = 0; f < facets.length; f += 1) {
        var facet = facets[f];
        var counter = _countFacet(facet, rows, applied);
        var options = counter(facetsByKey);
        var selectedSet = {};
        var selected = applied[facet.key] || [];
        for (var s = 0; s < selected.length; s += 1) selectedSet[selected[s]] = true;
        for (var o = 0; o < options.length; o += 1) {
          options[o].selected = selectedSet[options[o].value] === true;
        }
        out.push({
          key:     facet.key,
          label:   facet.key,
          kind:    facet.kind,
          options: options,
        });
      }
      return out;
    },

    previewQuery: async function (input) {
      _requireObject(input, "searchFacets.previewQuery");
      var qStr    = _optQuery(input.query, "searchFacets.previewQuery");
      var filters = _appliedFilters(input.filters, "searchFacets.previewQuery");
      var sample  = _sampleSize(input.sample, "searchFacets.previewQuery");

      var facets = await _loadFacets();
      var facetsByKey = {};
      for (var fi = 0; fi < facets.length; fi += 1) {
        facetsByKey[facets[fi].key] = facets[fi];
      }

      var matched = await catalog.list({
        query:           qStr,
        applied_filters: {},
        scope:           null,
      });
      var rows = (matched && Array.isArray(matched.rows)) ? matched.rows : [];

      var passing = [];
      for (var r = 0; r < rows.length; r += 1) {
        if (_rowPassesFilters(facetsByKey, rows[r], filters)) {
          passing.push(rows[r]);
        }
      }
      return {
        total:   passing.length,
        sample:  passing.slice(0, sample),
      };
    },

    recordFacetUse: async function (input) {
      _requireObject(input, "searchFacets.recordFacetUse");
      var key       = _key(input.key, "searchFacets.recordFacetUse");
      var value     = _value(input.value, "searchFacets.recordFacetUse");
      var sessionId = _sessionId(input.session_id, "searchFacets.recordFacetUse");
      var hashed    = b.crypto.namespaceHash(SESSION_NAMESPACE, sessionId);
      var id        = b.uuid.v7();
      var now       = Date.now();
      await query(
        "INSERT INTO search_facet_usage " +
        "(id, facet_key, value, session_id_hash, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, key, value, hashed, now]
      );
      return { id: id };
    },
  };
}

module.exports = {
  create: create,
};
