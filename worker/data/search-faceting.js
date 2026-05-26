// Edge-side faceting + synonym rewrite — pure functions, no DB.
//
// The storefront search page renders filter chrome (facet groups with
// counts) and expands the typed query through operator-curated synonym
// groups. The container owns the canonical implementations in
// `lib/search-facets.js` + `lib/search-synonyms.js`; the edge can't
// `require` a CommonJS leaf, so this ESM module mirrors the same
// algorithm against the same flat product-row shape. The
// `search-faceting-parity` layer-1 test pins this mirror to the lib's
// output so the two never drift.
//
// Row shape every counter walks (produced by `searchProductsFaceted`
// in `./catalog.js`):
//   { id, slug, title, ..., collection: [slug, ...],
//     price_minor: <int|null>, in_stock: <bool> }
//
// Facet definition shape (loaded from `search_facets`):
//   { key, field, kind: "categorical"|"numeric_range"|"boolean",
//     buckets: [{ label, min, max }]|null, display_limit: <int|null> }

// Coerce an arbitrary field value into the array shape every counter
// walks. Array fields (collection memberships) stay arrays; scalars
// wrap into a one-element array; null/undefined yields an empty array
// so the row contributes no count to that facet.
function _coerceFieldValues(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  return [raw];
}

function _stringifyValue(v) {
  if (v == null) return null;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return null;
}

// numeric_range bucketing — a value lands in the first bucket whose
// [min, max) window contains it. Unbounded ends honoured (null min =
// -Inf, null max = +Inf). Non-numeric values drop.
function _bucketOf(buckets, raw) {
  if (typeof raw !== "number" || !isFinite(raw)) return null;
  for (var i = 0; i < buckets.length; i += 1) {
    var bk = buckets[i];
    var minOk = bk.min == null || raw >= bk.min;
    var maxOk = bk.max == null || raw < bk.max;
    if (minOk && maxOk) return bk.label;
  }
  return null;
}

// Apply an applied-filters set to one row. A row passes if every
// applied facet either selected one of the row's values (categorical /
// boolean) or selected a bucket containing the row's numeric value
// (numeric_range). Facets the operator didn't register are ignored
// (a stale URL with a removed-facet param degrades gracefully).
export function rowPassesFilters(facetsByKey, row, filters) {
  var keys = Object.keys(filters);
  for (var i = 0; i < keys.length; i += 1) {
    var fk = keys[i];
    var facet = facetsByKey[fk];
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

// Count one facet's option distribution. The focal facet's own
// constraint is dropped before counting (standard e-commerce UX: "show
// every other option's count as if this facet were unselected"); every
// OTHER applied filter is a normal AND.
function _countFacet(facet, rows, applied, facetsByKey) {
  var filtersWithoutSelf = {};
  var aKeys = Object.keys(applied);
  for (var i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== facet.key) filtersWithoutSelf[aKeys[i]] = applied[aKeys[i]];
  }
  var matching = [];
  for (var r = 0; r < rows.length; r += 1) {
    if (rowPassesFilters(facetsByKey, rows[r], filtersWithoutSelf)) matching.push(rows[r]);
  }
  var counts = {};
  if (facet.kind === "numeric_range") {
    for (var n = 0; n < matching.length; n += 1) {
      var vals = _coerceFieldValues(matching[n][facet.field]);
      var seenN = {};
      for (var nv = 0; nv < vals.length; nv += 1) {
        var labN = _bucketOf(facet.buckets || [], vals[nv]);
        if (labN == null || seenN[labN]) continue;
        seenN[labN] = true;
        counts[labN] = (counts[labN] || 0) + 1;
      }
    }
    var outR = [];
    var bucketDefs = facet.buckets || [];
    for (var bi = 0; bi < bucketDefs.length; bi += 1) {
      outR.push({ value: bucketDefs[bi].label, label: bucketDefs[bi].label, count: counts[bucketDefs[bi].label] || 0 });
    }
    return outR;
  }
  if (facet.kind === "boolean") {
    var trueCount = 0;
    var falseCount = 0;
    for (var m = 0; m < matching.length; m += 1) {
      var fv = _coerceFieldValues(matching[m][facet.field]);
      var anyTruthy = false;
      for (var fvi = 0; fvi < fv.length; fvi += 1) {
        if (fv[fvi]) { anyTruthy = true; break; }
      }
      if (anyTruthy) trueCount += 1;
      else falseCount += 1;
    }
    return [
      { value: "true", label: "Yes", count: trueCount },
      { value: "false", label: "No", count: falseCount },
    ];
  }
  // categorical
  for (var c = 0; c < matching.length; c += 1) {
    var cv = _coerceFieldValues(matching[c][facet.field]);
    var ckSeen = {};
    for (var ci = 0; ci < cv.length; ci += 1) {
      var svC = _stringifyValue(cv[ci]);
      if (svC == null || ckSeen[svC]) continue;
      ckSeen[svC] = true;
      counts[svC] = (counts[svC] || 0) + 1;
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
}

// Compute every registered facet's option list + counts + selection
// state for the current result set. Mirrors
// `lib/search-facets.js#getFacets`. `rows` is the UNFILTERED matched
// set for the query (the per-facet counter drops the focal constraint
// itself), `applied` is the validated applied-filters object.
export function computeFacets(facets, rows, applied) {
  var facetsByKey = {};
  for (var fi = 0; fi < facets.length; fi += 1) facetsByKey[facets[fi].key] = facets[fi];
  var out = [];
  for (var f = 0; f < facets.length; f += 1) {
    var facet = facets[f];
    var options = _countFacet(facet, rows, applied, facetsByKey);
    var selectedSet = {};
    var selected = applied[facet.key] || [];
    for (var s = 0; s < selected.length; s += 1) selectedSet[selected[s]] = true;
    for (var o = 0; o < options.length; o += 1) {
      options[o].selected = selectedSet[options[o].value] === true;
    }
    out.push({ key: facet.key, label: facet.key, kind: facet.kind, options: options });
  }
  return out;
}

// Filter a row set down to those passing every applied facet — the
// final search result after facets narrow it. `facets` is the loaded
// definition list; `applied` the validated filters.
export function applyFilters(facets, rows, applied) {
  var facetsByKey = {};
  for (var fi = 0; fi < facets.length; fi += 1) facetsByKey[facets[fi].key] = facets[fi];
  var out = [];
  for (var r = 0; r < rows.length; r += 1) {
    if (rowPassesFilters(facetsByKey, rows[r], applied)) out.push(rows[r]);
  }
  return out;
}

// ---- synonym rewrite (mirror of lib/search-synonyms.js#rewrite) ----------

var TOKEN_SPLIT_RE = /[^a-z0-9-]+/g;
// Zero-width + direction-override family — spelled with \u escapes so
// the file stays no-irregular-whitespace clean.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]",
  "g"
);

function _sanitiseQuery(s) {
  return s
    .replace(/[\x00-\x1f\x7f]/g, " ")                                  // eslint-disable-line no-control-regex
    .replace(ZERO_WIDTH_RE, "");
}

function _tokenise(s) {
  var clean = _sanitiseQuery(s).toLowerCase();
  var raw = clean.split(TOKEN_SPLIT_RE);
  var out = [];
  for (var i = 0; i < raw.length; i += 1) {
    if (raw[i]) out.push(raw[i]);
  }
  return out;
}

// Conservative English stemming — same allow-list the lib uses.
function _stem(token) {
  if (token.length < 4) return token;
  if (token.length >= 5 && token.slice(-3) === "ies") return token.slice(0, -3) + "y";
  if (token.length >= 5 && token.slice(-3) === "ing") return token.slice(0, -3);
  if (token.length >= 4 && token.slice(-2) === "ed") return token.slice(0, -2);
  if (token.length >= 4 && token.slice(-2) === "es") return token.slice(0, -2);
  if (token.length >= 4 && token.slice(-1) === "s") return token.slice(0, -1);
  return token;
}

var MAX_EXPANSIONS_CAP = 50;

// Rewrite a user query into a canonical form + synonym expansions.
// Mirrors `lib/search-synonyms.js#rewrite` (stopword drop → typo
// correction → conservative stemming → group expansion). `vocab` is
// `{ groups: [{ kind, terms }], typos: { miss: corr }, stopwords:
// { word: true } }`. Returns `{ canonical, expansions, corrections }`.
export function rewriteQuery(q, vocab) {
  vocab = vocab || {};
  var groups = Array.isArray(vocab.groups) ? vocab.groups : [];
  var typos = vocab.typos || {};
  var stopwords = vocab.stopwords || {};

  var inputTokens = _tokenise(typeof q === "string" ? q : "");
  if (!inputTokens.length) return { canonical: "", expansions: [], corrections: [] };

  var corrections = [];
  var canonicalTokens = [];
  for (var i = 0; i < inputTokens.length; i += 1) {
    var tok = inputTokens[i];
    if (stopwords[tok]) continue;
    var corrected = tok;
    if (Object.prototype.hasOwnProperty.call(typos, tok)) {
      corrected = typos[tok];
      corrections.push({ from: tok, to: corrected, kind: "typo" });
    }
    var stemmed = _stem(corrected);
    canonicalTokens.push(stemmed !== corrected ? stemmed : corrected);
  }
  for (var d = 0; d < inputTokens.length; d += 1) {
    if (stopwords[inputTokens[d]]) corrections.push({ from: inputTokens[d], to: "", kind: "stopword" });
  }

  var canonical = canonicalTokens.join(" ");

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
      if (!Array.isArray(grp.terms)) continue;
      var idx = grp.terms.indexOf(ct);
      if (idx === -1) continue;
      if (grp.kind === "bidirectional") {
        for (var bb = 0; bb < grp.terms.length; bb += 1) {
          if (bb !== idx) _emit(grp.terms[bb]);
        }
      } else {
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
  if (expansions.length > MAX_EXPANSIONS_CAP) expansions = expansions.slice(0, MAX_EXPANSIONS_CAP);

  return { canonical: canonical, expansions: expansions, corrections: corrections };
}
