"use strict";
/**
 * @module shop.searchSynonyms
 * @title  Search synonyms — query rewriting + typo correction for the
 *         storefront search input
 *
 * @intro
 *   Maps user-typed terms to canonical search vocabulary on every
 *   request to the storefront search box. Four kinds of rewrite are
 *   composed in a single pass:
 *
 *     1. Tokenise + lowercase + trim — splits the user query on
 *        whitespace and punctuation, lowercases everything, and
 *        drops empties. Refuses C0 control bytes and the zero-width
 *        / direction-override family so a hostile query can't smuggle
 *        invisible characters into an operator dashboard that renders
 *        the term inline.
 *     2. Stopword removal — drops short, low-signal terms ("the",
 *        "of", "and", …) so `the red widget` and `red widget` land
 *        on the same canonical query.
 *     3. Typo correction — equality lookup against the operator-
 *        curated `search_typos` table. Mis-spelt tokens are swapped
 *        for their corrections and the diff is reported back to the
 *        caller so the storefront can render "Showing results for
 *        <correction>" UX.
 *     4. English stemming — strips a tight allow-list of suffixes
 *        (`-s`, `-es`, `-ies` -> `-y`, `-ing`, `-ed`) so plurals and
 *        gerunds collapse to a single canonical stem. The stemmer is
 *        deliberately conservative: a heavier algorithm (Porter) over-
 *        normalises product names ("running shoes" -> "run shoe"
 *        loses the category distinction shoppers actually type).
 *
 *   Expansions — once the canonical query is built, the primitive
 *   walks every synonym group containing a canonical token and
 *   returns the additional terms the storefront search should also
 *   match against. `bidirectional` groups expand every member to
 *   every other member; `directional` groups rewrite leading members
 *   to the canonical (last) entry and the canonical entry expands to
 *   itself only.
 *
 *   `rewrite(query, opts)` is the hot path — the storefront calls it
 *   on every keystroke (autocomplete) and every full search. The
 *   primitive caches the loaded groups + typos + stopwords in-memory
 *   on the factory instance; any mutating call (`addGroup`, `addTypo`,
 *   `addStopword`, `removeStopword`, `updateGroup`, `deleteGroup`)
 *   invalidates the cache so the next rewrite re-loads. Cache load
 *   itself is async (it issues SELECT statements); `rewrite` is async
 *   so the load can be awaited transparently. The function is
 *   referentially transparent given the current state of the three
 *   tables.
 *
 *   `learnFromQueries({ from, to, min_count })` scans the
 *   `search_query_log` table (owned by `searchSuggestions`) for
 *   bigrams that frequently co-occur but aren't yet covered by a
 *   synonym group — surfaces candidate synonym pairs for the
 *   operator to triage. Returns suggestions only; never mutates state.
 *
 *   Composes:
 *     - `b.crypto.namespaceHash` — not used here; the primitive
 *       handles operator-curated vocabulary, not customer-side
 *       identifiers, so no hashing surface is needed.
 *     - `b.uuid.v7` — not used; the three tables key on operator-
 *       chosen identifiers (slug / misspelling / word) so a UUID
 *       would be a second key the operator has to memorise.
 *     - `b.safeSql.assertOneOf` / `quoteIdentifier` — column-
 *       allowlist guards on the partial-update path so a future
 *       refactor adding dynamic columns can't widen the attack
 *       surface to identifier injection.
 *
 *   Surface:
 *     - addGroup({ slug, kind, terms })
 *     - addTypo({ misspelling, correction })
 *     - addStopword(word) / removeStopword(word)
 *     - getGroup(slug) / listGroups({ kind?, limit?, offset? })
 *     - updateGroup(slug, patch) / deleteGroup(slug)
 *     - listTypos({ limit?, offset? }) / listStopwords({ limit?, offset? })
 *     - rewrite(query, { include_corrections?, max_expansions? })
 *     - learnFromQueries({ from, to, min_count })
 *
 *   Storage:
 *     - `search_synonym_groups`  (migration `0055_search_synonyms.sql`)
 *     - `search_typos`           (same migration)
 *     - `search_stopwords`       (same migration)
 *     - reads `search_query_log` (owned by `searchSuggestions`,
 *       migration `0030_search_suggestions.sql`)
 *
 * @primitive searchSynonyms
 * @related   b.safeSql, searchSuggestions
 */

var DEFAULT_EXPANSIONS_CAP   = 50;
var MAX_EXPANSIONS_CAP       = 500;
var DEFAULT_LIST_LIMIT       = 100;
var MAX_LIST_LIMIT           = 500;
var DEFAULT_LEARN_MIN_COUNT  = 5;
var DEFAULT_LEARN_LIMIT      = 50;
var MAX_TERMS_PER_GROUP      = 32;
var MAX_TERM_LEN             = 64;
var MAX_SLUG_LEN             = 64;
var MAX_QUERY_LEN            = 500;

var ALLOWED_KINDS         = ["bidirectional", "directional"];
var ALLOWED_GROUP_COLS    = ["kind", "terms_json"];

// Refuse C0 control bytes + DEL. Tokens are single-line search terms;
// any newline / tab in a synonym entry would either be malformed
// operator input or an attempt to smuggle separator-confusion payload
// into the search log.
var CONTROL_BYTE_RE = /[\x00-\x1f\x7f]/;
// Zero-width + direction-override family — same defense as
// `supportTickets`. Spelled with \u escapes so the file stays
// ESLint no-irregular-whitespace clean.
var ZERO_WIDTH_RE   = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// Slug shape — operator-chosen identifier on synonym groups. Same
// shape the rest of the shop uses: lowercase alnum + hyphen, must
// start with a letter, 1..MAX_SLUG_LEN.
var SLUG_RE = /^[a-z][a-z0-9-]*$/;

// Token splitter — anything that isn't an alphanumeric or hyphen
// becomes a token boundary. Hyphenated terms ("t-shirt") survive as
// one token; the synonym group authors map them through.
var TOKEN_SPLIT_RE = /[^a-z0-9-]+/g;

// Lazy framework handle — matches the pattern the rest of the shop
// primitives use; avoids the require cycle that would arise from
// importing `./index` at module-eval time.
var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- validators ---------------------------------------------------------

function _requireObject(input, fnLabel) {
  if (!input || typeof input !== "object") {
    throw new TypeError(fnLabel + ": input object required");
  }
}

function _slug(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError(fnLabel + ": slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(fnLabel + ": slug must match /^[a-z][a-z0-9-]*$/");
  }
  return s;
}

function _kind(s, fnLabel) {
  if (typeof s !== "string" || ALLOWED_KINDS.indexOf(s) === -1) {
    throw new TypeError(fnLabel + ": kind must be one of " + ALLOWED_KINDS.join(", "));
  }
  return s;
}

function _term(s, label, fnLabel) {
  if (typeof s !== "string") {
    throw new TypeError(fnLabel + ": " + label + " must be a string");
  }
  var trimmed = s.trim().toLowerCase();
  if (!trimmed.length) {
    throw new TypeError(fnLabel + ": " + label + " must be non-empty after trim");
  }
  if (trimmed.length > MAX_TERM_LEN) {
    throw new TypeError(fnLabel + ": " + label + " must be <= " + MAX_TERM_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(trimmed)) {
    throw new TypeError(fnLabel + ": " + label + " contains control bytes");
  }
  if (ZERO_WIDTH_RE.test(trimmed)) {
    throw new TypeError(fnLabel + ": " + label + " contains zero-width / direction-override characters");
  }
  return trimmed;
}

function _terms(input, fnLabel) {
  if (!Array.isArray(input)) {
    throw new TypeError(fnLabel + ": terms must be an array of strings");
  }
  if (input.length < 2) {
    throw new TypeError(fnLabel + ": terms must contain at least 2 entries");
  }
  if (input.length > MAX_TERMS_PER_GROUP) {
    throw new TypeError(fnLabel + ": terms must contain <= " + MAX_TERMS_PER_GROUP + " entries");
  }
  var out  = [];
  var seen = {};
  for (var i = 0; i < input.length; i += 1) {
    var t = _term(input[i], "terms[" + i + "]", fnLabel);
    if (seen[t]) {
      throw new TypeError(fnLabel + ": terms must not contain duplicates (got '" + t + "' twice)");
    }
    seen[t] = true;
    out.push(t);
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

function _maxExpansions(n, fnLabel) {
  if (n == null) return DEFAULT_EXPANSIONS_CAP;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_EXPANSIONS_CAP) {
    throw new TypeError(fnLabel + ": max_expansions must be an integer 1..." + MAX_EXPANSIONS_CAP);
  }
  return n;
}

function _epochMs(n, label, fnLabel) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(fnLabel + ": " + label + " must be a non-negative integer epoch-ms");
  }
  return n;
}

function _queryString(s, fnLabel) {
  if (typeof s !== "string") {
    throw new TypeError(fnLabel + ": query must be a string");
  }
  if (s.length > MAX_QUERY_LEN) {
    throw new TypeError(fnLabel + ": query must be <= " + MAX_QUERY_LEN + " characters");
  }
  return s;
}

// ---- tokeniser + stemmer + sanitiser ------------------------------------

// Strip control bytes + zero-width family from the user query before
// tokenising. The storefront search box accepts arbitrary user input
// so a hostile query must be cleaned, not refused — refusing would
// give attackers a denial-of-search vector against legitimate
// shoppers who happened to paste a stray BOM.
function _sanitiseQuery(s) {
  return s
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(
      // Zero-width + direction-override family — see ZERO_WIDTH_RE.
      new RegExp("[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]", "g"),
      ""
    );
}

function _tokenise(s) {
  // Lowercase, sanitise, split on non-alnum-hyphen, drop empties.
  var clean = _sanitiseQuery(s).toLowerCase();
  var raw   = clean.split(TOKEN_SPLIT_RE);
  var out   = [];
  for (var i = 0; i < raw.length; i += 1) {
    if (raw[i]) out.push(raw[i]);
  }
  return out;
}

// English stemming — conservative suffix strip. Order matters: longer
// suffixes are tried first so `-ing` doesn't get partially consumed
// by `-s`. Words shorter than 4 chars are returned as-is (collapsing
// `is` -> `i` would destroy more signal than it canonicalises).
function _stem(token) {
  if (token.length < 4) return token;
  if (token.length >= 5 && token.slice(-3) === "ies") return token.slice(0, -3) + "y";
  if (token.length >= 5 && token.slice(-3) === "ing") return token.slice(0, -3);
  if (token.length >= 4 && token.slice(-2) === "ed")  return token.slice(0, -2);
  if (token.length >= 4 && token.slice(-2) === "es")  return token.slice(0, -2);
  if (token.length >= 4 && token.slice(-1) === "s")   return token.slice(0, -1);
  return token;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }

  // In-memory caches. `null` means "not loaded yet"; the next rewrite
  // call hydrates from the DB. Every mutating call invalidates the
  // cache so subsequent rewrites see the new state.
  var _groupsCache    = null;   // [{ slug, kind, terms: [...] }]
  var _typosCache     = null;   // { misspelling: correction }
  var _stopwordsCache = null;   // { word: true }

  function _invalidate() {
    _groupsCache    = null;
    _typosCache     = null;
    _stopwordsCache = null;
  }

  async function _loadGroups() {
    if (_groupsCache) return _groupsCache;
    var rows = (await query(
      "SELECT slug, kind, terms_json FROM search_synonym_groups",
      []
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) {
      var terms;
      try { terms = JSON.parse(rows[i].terms_json); }
      catch (_e) { terms = []; }                                       // allow:empty-catch-swallow — malformed group is dropped so a hand-edited row can't crash rewrite
      if (!Array.isArray(terms) || !terms.length) continue;
      out.push({ slug: rows[i].slug, kind: rows[i].kind, terms: terms });
    }
    _groupsCache = out;
    return out;
  }

  async function _loadTypos() {
    if (_typosCache) return _typosCache;
    var rows = (await query(
      "SELECT misspelling, correction FROM search_typos",
      []
    )).rows;
    var out = {};
    for (var i = 0; i < rows.length; i += 1) {
      out[rows[i].misspelling] = rows[i].correction;
    }
    _typosCache = out;
    return out;
  }

  async function _loadStopwords() {
    if (_stopwordsCache) return _stopwordsCache;
    var rows = (await query("SELECT word FROM search_stopwords", [])).rows;
    var out = {};
    for (var i = 0; i < rows.length; i += 1) {
      out[rows[i].word] = true;
    }
    _stopwordsCache = out;
    return out;
  }

  function _hydrateGroup(row) {
    if (!row) return null;
    var terms;
    try { terms = JSON.parse(row.terms_json); }
    catch (_e) { terms = []; }                                         // allow:empty-catch-swallow — malformed JSON falls back to empty; the row id is still returned so the operator can re-author
    if (!Array.isArray(terms)) terms = [];
    return {
      slug:       row.slug,
      kind:       row.kind,
      terms:      terms,
      created_at: Number(row.created_at),
      updated_at: Number(row.updated_at),
    };
  }

  return {
    DEFAULT_EXPANSIONS_CAP: DEFAULT_EXPANSIONS_CAP,
    MAX_EXPANSIONS_CAP:     MAX_EXPANSIONS_CAP,

    addGroup: async function (input) {
      _requireObject(input, "searchSynonyms.addGroup");
      var slug  = _slug(input.slug, "searchSynonyms.addGroup");
      var kind  = _kind(input.kind, "searchSynonyms.addGroup");
      var terms = _terms(input.terms, "searchSynonyms.addGroup");
      var now   = Date.now();
      try {
        await query(
          "INSERT INTO search_synonym_groups " +
          "(slug, kind, terms_json, created_at, updated_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?4)",
          [slug, kind, JSON.stringify(terms), now]
        );
      } catch (e) {
        if (e && /UNIQUE|PRIMARY KEY|constraint/i.test(String(e.message || e))) {
          throw new TypeError("searchSynonyms.addGroup: slug already exists: " + slug);
        }
        throw e;
      }
      _invalidate();
      var row = (await query(
        "SELECT slug, kind, terms_json, created_at, updated_at " +
        "FROM search_synonym_groups WHERE slug = ?1 LIMIT 1",
        [slug]
      )).rows[0];
      return _hydrateGroup(row);
    },

    addTypo: async function (input) {
      _requireObject(input, "searchSynonyms.addTypo");
      var misspelling = _term(input.misspelling, "misspelling", "searchSynonyms.addTypo");
      var correction  = _term(input.correction,  "correction",  "searchSynonyms.addTypo");
      if (misspelling === correction) {
        throw new TypeError("searchSynonyms.addTypo: misspelling and correction must differ");
      }
      var now = Date.now();
      // Upsert so re-authoring a correction is a single call. Sqlite +
      // D1 both honour ON CONFLICT.
      await query(
        "INSERT INTO search_typos (misspelling, correction, created_at) " +
        "VALUES (?1, ?2, ?3) " +
        "ON CONFLICT(misspelling) DO UPDATE SET correction = excluded.correction",
        [misspelling, correction, now]
      );
      _invalidate();
      return { misspelling: misspelling, correction: correction };
    },

    addStopword: async function (word) {
      var w = _term(word, "word", "searchSynonyms.addStopword");
      var now = Date.now();
      await query(
        "INSERT INTO search_stopwords (word, added_at) VALUES (?1, ?2) " +
        "ON CONFLICT(word) DO NOTHING",
        [w, now]
      );
      _invalidate();
      return { word: w };
    },

    removeStopword: async function (word) {
      var w = _term(word, "word", "searchSynonyms.removeStopword");
      var r = await query("DELETE FROM search_stopwords WHERE word = ?1", [w]);
      _invalidate();
      return { removed: Number(r.rowCount || 0) > 0 };
    },

    getGroup: async function (slug) {
      var s = _slug(slug, "searchSynonyms.getGroup");
      var row = (await query(
        "SELECT slug, kind, terms_json, created_at, updated_at " +
        "FROM search_synonym_groups WHERE slug = ?1 LIMIT 1",
        [s]
      )).rows[0];
      return row ? _hydrateGroup(row) : null;
    },

    listGroups: async function (listOpts) {
      listOpts = listOpts || {};
      var limit  = _limit(listOpts.limit,  "searchSynonyms.listGroups");
      var offset = _offset(listOpts.offset, "searchSynonyms.listGroups");
      var rows;
      if (listOpts.kind !== undefined) {
        var k = _kind(listOpts.kind, "searchSynonyms.listGroups");
        rows = (await query(
          "SELECT slug, kind, terms_json, created_at, updated_at " +
          "FROM search_synonym_groups WHERE kind = ?1 " +
          "ORDER BY created_at DESC, slug DESC " +
          "LIMIT ?2 OFFSET ?3",
          [k, limit, offset]
        )).rows;
      } else {
        rows = (await query(
          "SELECT slug, kind, terms_json, created_at, updated_at " +
          "FROM search_synonym_groups " +
          "ORDER BY created_at DESC, slug DESC " +
          "LIMIT ?1 OFFSET ?2",
          [limit, offset]
        )).rows;
      }
      var out = [];
      for (var i = 0; i < rows.length; i += 1) out.push(_hydrateGroup(rows[i]));
      return out;
    },

    updateGroup: async function (slug, patch) {
      var s = _slug(slug, "searchSynonyms.updateGroup");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("searchSynonyms.updateGroup: patch object required");
      }
      var sets   = [];
      var params = [];
      var i = 1;
      function _addSet(col, val) {
        // Column allowlist — defense in depth against a future
        // refactor widening the dynamic-column surface.
        _b().safeSql.assertOneOf(col, ALLOWED_GROUP_COLS);
        sets.push(_b().safeSql.quoteIdentifier(col, "sqlite") + " = ?" + (i++));
        params.push(val);
      }
      if (patch.kind !== undefined) {
        _addSet("kind", _kind(patch.kind, "searchSynonyms.updateGroup"));
      }
      if (patch.terms !== undefined) {
        _addSet("terms_json", JSON.stringify(_terms(patch.terms, "searchSynonyms.updateGroup")));
      }
      if (sets.length === 0) {
        throw new TypeError("searchSynonyms.updateGroup: patch contained no updatable fields");
      }
      sets.push("updated_at = ?" + (i++));
      params.push(Date.now());
      params.push(s);
      var r = await query(
        "UPDATE search_synonym_groups SET " + sets.join(", ") + " WHERE slug = ?" + i,
        params
      );
      if (r.rowCount === 0) return null;
      _invalidate();
      var row = (await query(
        "SELECT slug, kind, terms_json, created_at, updated_at " +
        "FROM search_synonym_groups WHERE slug = ?1 LIMIT 1",
        [s]
      )).rows[0];
      return row ? _hydrateGroup(row) : null;
    },

    deleteGroup: async function (slug) {
      var s = _slug(slug, "searchSynonyms.deleteGroup");
      var r = await query("DELETE FROM search_synonym_groups WHERE slug = ?1", [s]);
      _invalidate();
      return { removed: Number(r.rowCount || 0) > 0 };
    },

    listTypos: async function (listOpts) {
      listOpts = listOpts || {};
      var limit  = _limit(listOpts.limit,  "searchSynonyms.listTypos");
      var offset = _offset(listOpts.offset, "searchSynonyms.listTypos");
      var rows = (await query(
        "SELECT misspelling, correction, created_at FROM search_typos " +
        "ORDER BY created_at DESC, misspelling DESC " +
        "LIMIT ?1 OFFSET ?2",
        [limit, offset]
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({
          misspelling: rows[i].misspelling,
          correction:  rows[i].correction,
          created_at:  Number(rows[i].created_at),
        });
      }
      return out;
    },

    listStopwords: async function (listOpts) {
      listOpts = listOpts || {};
      var limit  = _limit(listOpts.limit,  "searchSynonyms.listStopwords");
      var offset = _offset(listOpts.offset, "searchSynonyms.listStopwords");
      var rows = (await query(
        "SELECT word, added_at FROM search_stopwords " +
        "ORDER BY added_at DESC, word DESC " +
        "LIMIT ?1 OFFSET ?2",
        [limit, offset]
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push({ word: rows[i].word, added_at: Number(rows[i].added_at) });
      }
      return out;
    },

    rewrite: async function (q, rewriteOpts) {
      // Pure-function-shaped — referentially transparent given the
      // current cache state. `include_corrections` defaults to true
      // (the storefront wants the diff so it can render "Showing
      // results for <correction>" UX).
      _queryString(q, "searchSynonyms.rewrite");
      rewriteOpts = rewriteOpts || {};
      var includeCorrections = rewriteOpts.include_corrections !== false;
      var maxExpansions      = _maxExpansions(rewriteOpts.max_expansions, "searchSynonyms.rewrite");

      var loaded = await Promise.all([_loadGroups(), _loadTypos(), _loadStopwords()]);
      var groups    = loaded[0];
      var typos     = loaded[1];
      var stopwords = loaded[2];

      var inputTokens = _tokenise(q);
      if (!inputTokens.length) {
        return { canonical: "", expansions: [], corrections: [] };
      }

      var corrections = [];
      var canonicalTokens = [];
      for (var i = 0; i < inputTokens.length; i += 1) {
        var tok = inputTokens[i];

        // Stopword removal — silent drop. Stopwords don't generate a
        // correction (they're not "wrong", they're "noise") but the
        // diff between input and canonical surfaces the drop.
        if (stopwords[tok]) continue;

        // Typo correction — equality lookup. The correction is
        // already a lowercased + trimmed term at insert time, so we
        // can substitute directly.
        var corrected = tok;
        if (Object.prototype.hasOwnProperty.call(typos, tok)) {
          corrected = typos[tok];
          corrections.push({ from: tok, to: corrected, kind: "typo" });
        }

        // Conservative stemming — applied after typo correction so a
        // misspelled plural still routes through the typo table first.
        var stemmed = _stem(corrected);
        if (stemmed !== corrected) {
          // Stemming isn't a "correction" in the operator sense —
          // shoppers don't expect "Showing results for run" when they
          // typed "running" — so it's not added to the corrections
          // diff. The canonical token records the stem.
          canonicalTokens.push(stemmed);
        } else {
          canonicalTokens.push(corrected);
        }
      }

      // Surface stopword drops on the corrections diff when the
      // caller asked for the full diff. Compare normalised-but-not-
      // stemmed against the canonical, since the operator's expected
      // failure mode is "I typed something the search box ate."
      if (includeCorrections) {
        for (var d = 0; d < inputTokens.length; d += 1) {
          if (stopwords[inputTokens[d]]) {
            corrections.push({ from: inputTokens[d], to: "", kind: "stopword" });
          }
        }
      }

      var canonical = canonicalTokens.join(" ");

      // Expansions — for each canonical token, find every group it
      // belongs to and emit the group's expanded set. `bidirectional`
      // emits every other member; `directional` emits the canonical
      // (last) entry when a leading member matched, and emits all
      // leading members when the canonical matched.
      var expansionsSet = {};
      function _emit(term) {
        if (term === canonical) return;
        if (canonicalTokens.indexOf(term) !== -1) return;
        expansionsSet[term] = true;
      }
      for (var t = 0; t < canonicalTokens.length; t += 1) {
        var ct = canonicalTokens[t];
        for (var g = 0; g < groups.length; g += 1) {
          var grp = groups[g];
          var idx = grp.terms.indexOf(ct);
          if (idx === -1) continue;
          if (grp.kind === "bidirectional") {
            for (var b = 0; b < grp.terms.length; b += 1) {
              if (b !== idx) _emit(grp.terms[b]);
            }
          } else {
            // directional — last entry is canonical
            var canonIdx = grp.terms.length - 1;
            if (idx === canonIdx) {
              for (var lm = 0; lm < canonIdx; lm += 1) _emit(grp.terms[lm]);
            } else {
              _emit(grp.terms[canonIdx]);
            }
          }
        }
      }

      var expansions = Object.keys(expansionsSet);
      if (expansions.length > maxExpansions) {
        expansions = expansions.slice(0, maxExpansions);
      }

      return {
        canonical:   canonical,
        expansions:  expansions,
        corrections: includeCorrections ? corrections : [],
      };
    },

    learnFromQueries: async function (learnOpts) {
      _requireObject(learnOpts, "searchSynonyms.learnFromQueries");
      var from     = _epochMs(learnOpts.from, "from", "searchSynonyms.learnFromQueries");
      var to       = _epochMs(learnOpts.to,   "to",   "searchSynonyms.learnFromQueries");
      if (to < from) {
        throw new TypeError("searchSynonyms.learnFromQueries: to must be >= from");
      }
      var minCount = learnOpts.min_count == null
        ? DEFAULT_LEARN_MIN_COUNT
        : learnOpts.min_count;
      if (!Number.isInteger(minCount) || minCount <= 0) {
        throw new TypeError("searchSynonyms.learnFromQueries: min_count must be a positive integer");
      }
      var limit = _limit(learnOpts.limit, "searchSynonyms.learnFromQueries");
      if (limit > DEFAULT_LEARN_LIMIT && learnOpts.limit == null) limit = DEFAULT_LEARN_LIMIT;

      // Pull the query log window in one shot. The log is bounded by
      // the searchSuggestions retention sweep, so this is a small
      // working set in practice. We do the bigram aggregation in
      // memory rather than as a SQL pivot — sqlite + D1 don't have a
      // portable string-split, and the operator-callable pattern is
      // run on demand from a dashboard, not on the hot path.
      var rows = (await query(
        "SELECT query_normalized FROM search_query_log " +
        "WHERE occurred_at >= ?1 AND occurred_at <= ?2",
        [from, to]
      )).rows;

      // Build a co-occurrence map: for every pair of tokens that
      // appear in the same query, count how often they co-occur. A
      // candidate synonym pair is one that co-occurs >= min_count
      // times and isn't already covered by a synonym group / stopword
      // / typo.
      var groupsP    = _loadGroups();
      var typosP     = _loadTypos();
      var stopwordsP = _loadStopwords();
      var refs = await Promise.all([groupsP, typosP, stopwordsP]);
      var groups    = refs[0];
      var typos     = refs[1];
      var stopwords = refs[2];

      // Build a Set of every (a, b) where a and b are in the same
      // group — directional or bidirectional.
      var covered = {};
      function _coverPair(a, b) {
        if (a === b) return;
        covered[a + " " + b] = true;
        covered[b + " " + a] = true;
      }
      for (var g = 0; g < groups.length; g += 1) {
        var grpTerms = groups[g].terms;
        for (var a = 0; a < grpTerms.length; a += 1) {
          for (var b = a + 1; b < grpTerms.length; b += 1) {
            _coverPair(grpTerms[a], grpTerms[b]);
          }
        }
      }

      var pairCounts = {};                  // "a b" -> count (a < b lexicographically)
      var pairTermA  = {};                  // canonicalised first term
      var pairTermB  = {};                  // canonicalised second term
      for (var r = 0; r < rows.length; r += 1) {
        var qTokens = _tokenise(rows[r].query_normalized || "");
        // Drop stopwords + typo-correct so the bigram is on the
        // canonical vocabulary.
        var canonTokens = [];
        var seen = {};
        for (var ti = 0; ti < qTokens.length; ti += 1) {
          var tk = qTokens[ti];
          if (stopwords[tk]) continue;
          if (Object.prototype.hasOwnProperty.call(typos, tk)) tk = typos[tk];
          if (seen[tk]) continue;
          seen[tk] = true;
          canonTokens.push(tk);
        }
        for (var ii = 0; ii < canonTokens.length; ii += 1) {
          for (var jj = ii + 1; jj < canonTokens.length; jj += 1) {
            var ta = canonTokens[ii];
            var tb = canonTokens[jj];
            // Order the pair lexicographically so (a,b) and (b,a)
            // accumulate to the same key.
            if (ta > tb) { var tmp = ta; ta = tb; tb = tmp; }
            var key = ta + " " + tb;
            if (covered[key]) continue;
            pairCounts[key] = (pairCounts[key] || 0) + 1;
            pairTermA[key]  = ta;
            pairTermB[key]  = tb;
          }
        }
      }

      var keys = Object.keys(pairCounts);
      var suggestions = [];
      for (var k = 0; k < keys.length; k += 1) {
        if (pairCounts[keys[k]] >= minCount) {
          suggestions.push({
            terms:    [pairTermA[keys[k]], pairTermB[keys[k]]],
            count:    pairCounts[keys[k]],
          });
        }
      }
      suggestions.sort(function (x, y) {
        if (y.count !== x.count) return y.count - x.count;
        if (x.terms[0] < y.terms[0]) return -1;
        if (x.terms[0] > y.terms[0]) return 1;
        return x.terms[1] < y.terms[1] ? -1 : (x.terms[1] > y.terms[1] ? 1 : 0);
      });
      if (suggestions.length > limit) suggestions = suggestions.slice(0, limit);
      return suggestions;
    },
  };
}

module.exports = {
  create: create,
};
