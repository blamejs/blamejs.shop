"use strict";
/**
 * @module shop.translations
 * @title  Translations — per-resource localization table for the storefront
 *
 * @intro
 *   Per-resource translation rows for storefront localization.
 *   Operators add translations for product titles, descriptions,
 *   collection names, page bodies, banner copy, FAQ entries —
 *   anything the storefront renders as user-visible text. Each row
 *   is keyed by a (resource_kind, resource_id, locale, field) tuple
 *   so a single primitive owns the entire i18n table without
 *   foreign-keying into every downstream resource catalogue.
 *
 *   Locale fallback. `getTranslation` and `getForResource` walk a
 *   chain so a partial locale set still renders something: `fr-CA`
 *   falls back to `fr`, which falls back to `en` (the implicit
 *   site-default). Shoppers in Quebec see the Canadian-French copy
 *   when it's authored and the metropolitan French copy otherwise;
 *   only when neither exists does the English baseline render. The
 *   chain is computed by stripping subtags from right to left, with
 *   `en` appended as the final fallback (never duplicated when the
 *   requested locale is already `en`).
 *
 *   Write-time HTML escape. `setTranslation` and `bulkSet` run every
 *   value through `b.template.escapeHtml` before INSERT, so the
 *   stored row lands as inert text in the storefront HTML. Operator-
 *   intent newlines / paragraph breaks survive (the escape only
 *   rewrites the 5 HTML metacharacters); a hostile `<script>` in a
 *   product title cannot break out of its render context.
 *
 *   Atomicity. `bulkSet` validates every row before writing any. A
 *   bad row in the batch surfaces as a thrown TypeError with the
 *   row's index and the offending field, and zero rows land in the
 *   table — the validate-then-write pattern is the atomicity story
 *   D1 supports portably.
 *
 *   Composes:
 *     - `b.uuid.v7`            — row ids.
 *     - `b.template.escapeHtml` — write-site sanitiser on `value`.
 *
 *   Surface:
 *     - `setTranslation({ resource_kind, resource_id, locale, field,
 *                          value })`
 *     - `getTranslation({ resource_kind, resource_id, locale, field })`
 *     - `getForResource({ resource_kind, resource_id, locale })`
 *     - `removeTranslation({ resource_kind, resource_id, locale,
 *                             field? })`
 *     - `localesForResource({ resource_kind, resource_id })`
 *     - `bulkSet(rows)`
 *     - `missingTranslations({ resource_kind, locale, sample_size? })`
 *
 *   Storage:
 *     - `translations` (migration `0070_translations.sql`).
 *
 * @primitive translations
 * @related   b.template.escapeHtml, b.uuid
 */

var b = require("./index").framework;

var MAX_KIND_LEN          = 64;
var MAX_RESOURCE_ID_LEN   = 128;
var MAX_FIELD_LEN         = 64;
var MAX_LOCALE_LEN        = 35;     // BCP-47 cap is 35 chars
var MAX_VALUE_LEN         = 16384;  // 16 KiB — long enough for a page body, short enough to bound the row
var MAX_BULK_ROWS         = 1000;
var DEFAULT_SAMPLE_SIZE   = 100;
var MAX_SAMPLE_SIZE       = 1000;
var BASELINE_LOCALE       = "en";

// Resource kind / field share the same shape: operator-chosen slug
// of lowercase ASCII + digits + underscore. Underscores are kinder
// to Python / SQL identifiers downstream than hyphens are.
var KIND_FIELD_RE = /^[a-z][a-z0-9_]*$/;

// Resource id is opaque text from the underlying primitive's
// identifier shape — we tolerate a broader alphabet so a slug,
// uuid, or numeric id all fit through. Refuse whitespace + control
// bytes so a typo can't smuggle a separator into a downstream join.
var RESOURCE_ID_RE = /^[A-Za-z0-9._:-]+$/;

// BCP-47 locale shape — language (2-3 letters) + optional subtags.
// We normalise at the write site (lowercase language, uppercase
// region), then validate against this regex to refuse a free-form
// string the fallback walker can't interpret.
var LOCALE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

// Refuse C0 control bytes + DEL in `value`. Newline / CR / tab are
// allowed (operators author multi-line page bodies) — the rest of
// the C0 range would only reach the storefront as a smuggling
// payload or a copy-paste accident from a terminal.
var CONTROL_BYTE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

// Zero-width / direction-override family. Spelled with \u-escapes
// so ESLint's no-irregular-whitespace stays happy. Same defence the
// rest of the shop uses on operator-authored strings.
var ZERO_WIDTH_RE = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

// ---- validators ---------------------------------------------------------

function _requireObject(input, fnLabel) {
  if (!input || typeof input !== "object") {
    throw new TypeError(fnLabel + ": input object required");
  }
}

function _kind(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": resource_kind must be a non-empty string");
  }
  if (s.length > MAX_KIND_LEN) {
    throw new TypeError(fnLabel + ": resource_kind must be <= " + MAX_KIND_LEN + " characters");
  }
  if (!KIND_FIELD_RE.test(s)) {
    throw new TypeError(fnLabel + ": resource_kind must match /^[a-z][a-z0-9_]*$/");
  }
  return s;
}

function _resourceId(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": resource_id must be a non-empty string");
  }
  if (s.length > MAX_RESOURCE_ID_LEN) {
    throw new TypeError(fnLabel + ": resource_id must be <= " + MAX_RESOURCE_ID_LEN + " characters");
  }
  if (!RESOURCE_ID_RE.test(s)) {
    throw new TypeError(fnLabel + ": resource_id must match /^[A-Za-z0-9._:-]+$/");
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
  if (!KIND_FIELD_RE.test(s)) {
    throw new TypeError(fnLabel + ": field must match /^[a-z][a-z0-9_]*$/");
  }
  return s;
}

// Normalise + validate a BCP-47 locale. Language subtag is
// lowercased, region subtag (the first 2-letter or 3-digit subtag
// after the language) is uppercased, every other subtag is left
// as-is. The output is the canonical form the table stores.
function _locale(s, fnLabel) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError(fnLabel + ": locale must be a non-empty string");
  }
  if (s.length > MAX_LOCALE_LEN) {
    throw new TypeError(fnLabel + ": locale must be <= " + MAX_LOCALE_LEN + " characters");
  }
  var parts = s.split("-");
  if (!parts.length || !parts[0].length) {
    throw new TypeError(fnLabel + ": locale must be a BCP-47 tag (e.g. 'en', 'fr-CA')");
  }
  var lang = parts[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) {
    throw new TypeError(fnLabel + ": locale language subtag must be 2-3 letters");
  }
  var out = [lang];
  for (var i = 1; i < parts.length; i += 1) {
    var sub = parts[i];
    if (!sub.length || !/^[A-Za-z0-9]{2,8}$/.test(sub)) {
      throw new TypeError(fnLabel + ": locale subtag must be 2-8 alphanumeric characters");
    }
    // Region — 2 letters or 3 digits — uppercases.
    if (i === 1 && /^[A-Za-z]{2}$/.test(sub)) out.push(sub.toUpperCase());
    else if (i === 1 && /^[0-9]{3}$/.test(sub)) out.push(sub);
    else out.push(sub);
  }
  var canonical = out.join("-");
  if (!LOCALE_RE.test(canonical)) {
    throw new TypeError(fnLabel + ": locale must match BCP-47 shape");
  }
  return canonical;
}

function _value(s, fnLabel) {
  if (typeof s !== "string") {
    throw new TypeError(fnLabel + ": value must be a string");
  }
  if (!s.length) {
    throw new TypeError(fnLabel + ": value must be non-empty");
  }
  if (s.length > MAX_VALUE_LEN) {
    throw new TypeError(fnLabel + ": value must be <= " + MAX_VALUE_LEN + " characters");
  }
  if (CONTROL_BYTE_RE.test(s)) {
    throw new TypeError(fnLabel + ": value contains forbidden control bytes");
  }
  if (ZERO_WIDTH_RE.test(s)) {
    throw new TypeError(fnLabel + ": value contains zero-width / direction-override characters");
  }
  return s;
}

function _sampleSize(n, fnLabel) {
  if (n == null) return DEFAULT_SAMPLE_SIZE;
  if (!Number.isInteger(n) || n <= 0 || n > MAX_SAMPLE_SIZE) {
    throw new TypeError(fnLabel + ": sample_size must be an integer 1..." + MAX_SAMPLE_SIZE);
  }
  return n;
}

// Build the fallback chain for a locale. `fr-CA` -> ["fr-CA", "fr", "en"].
// `en-US` -> ["en-US", "en"]. `en` -> ["en"]. Baseline `en` is appended
// unless the requested locale is already `en` (or starts with `en-`,
// in which case `en` lands in the natural strip and we don't duplicate).
function _fallbackChain(canonical) {
  var chain = [canonical];
  var parts = canonical.split("-");
  while (parts.length > 1) {
    parts.pop();
    chain.push(parts.join("-"));
  }
  if (chain.indexOf(BASELINE_LOCALE) === -1) {
    chain.push(BASELINE_LOCALE);
  }
  return chain;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Pick the best-matching row from the candidates returned by an
  // IN(...) query, given the fallback chain. The DB hands us every
  // row whose locale appears in the chain; we pick the one that
  // appears earliest in the chain (the most specific match).
  function _bestByChain(rows, chain) {
    var best = null;
    var bestIdx = chain.length;
    for (var i = 0; i < rows.length; i += 1) {
      var idx = chain.indexOf(rows[i].locale);
      if (idx === -1) continue;
      if (idx < bestIdx) {
        best = rows[i];
        bestIdx = idx;
      }
    }
    return best;
  }

  // Render an `(?1, ?2, …)` placeholder run starting at offset `start`
  // for `n` arguments. Used by the IN(...) query that fetches every
  // candidate locale row in one shot.
  function _placeholders(n, start) {
    var out = [];
    for (var i = 0; i < n; i += 1) out.push("?" + (start + i));
    return out.join(", ");
  }

  async function setTranslation(input) {
    _requireObject(input, "translations.setTranslation");
    var kind   = _kind(input.resource_kind,       "translations.setTranslation");
    var rid    = _resourceId(input.resource_id,   "translations.setTranslation");
    var locale = _locale(input.locale,            "translations.setTranslation");
    var field  = _field(input.field,              "translations.setTranslation");
    var value  = _value(input.value,              "translations.setTranslation");
    var escaped = b.template.escapeHtml(value);
    var now = Date.now();
    var id  = b.uuid.v7();
    // UNIQUE(resource_kind, resource_id, locale, field) backs the
    // upsert — a re-authored translation overwrites in place.
    await query(
      "INSERT INTO translations " +
      "(id, resource_kind, resource_id, locale, field, value, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
      "ON CONFLICT(resource_kind, resource_id, locale, field) DO UPDATE SET " +
      "value = excluded.value, updated_at = excluded.updated_at",
      [id, kind, rid, locale, field, escaped, now]
    );
    var row = (await query(
      "SELECT id, resource_kind, resource_id, locale, field, value, updated_at " +
      "FROM translations " +
      "WHERE resource_kind = ?1 AND resource_id = ?2 AND locale = ?3 AND field = ?4 " +
      "LIMIT 1",
      [kind, rid, locale, field]
    )).rows[0];
    return _hydrate(row);
  }

  async function getTranslation(input) {
    _requireObject(input, "translations.getTranslation");
    var kind   = _kind(input.resource_kind,     "translations.getTranslation");
    var rid    = _resourceId(input.resource_id, "translations.getTranslation");
    var locale = _locale(input.locale,          "translations.getTranslation");
    var field  = _field(input.field,            "translations.getTranslation");
    var chain  = _fallbackChain(locale);

    var rows = (await query(
      "SELECT locale, value, updated_at FROM translations " +
      "WHERE resource_kind = ?1 AND resource_id = ?2 AND field = ?3 " +
      "AND locale IN (" + _placeholders(chain.length, 4) + ")",
      [kind, rid, field].concat(chain)
    )).rows;
    var best = _bestByChain(rows, chain);
    if (!best) return null;
    return {
      resource_kind:   kind,
      resource_id:     rid,
      requested_locale: locale,
      matched_locale:  best.locale,
      field:           field,
      value:           best.value,
      updated_at:      Number(best.updated_at),
    };
  }

  async function getForResource(input) {
    _requireObject(input, "translations.getForResource");
    var kind   = _kind(input.resource_kind,     "translations.getForResource");
    var rid    = _resourceId(input.resource_id, "translations.getForResource");
    var locale = _locale(input.locale,          "translations.getForResource");
    var chain  = _fallbackChain(locale);

    var rows = (await query(
      "SELECT locale, field, value, updated_at FROM translations " +
      "WHERE resource_kind = ?1 AND resource_id = ?2 " +
      "AND locale IN (" + _placeholders(chain.length, 3) + ")",
      [kind, rid].concat(chain)
    )).rows;
    // Group by field; for each field, pick the candidate earliest in
    // the chain. Fields not present in any locale don't appear in the
    // result (the caller falls back to the resource's native field).
    var byField = {};
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var existing = byField[r.field];
      var thisIdx  = chain.indexOf(r.locale);
      if (!existing || thisIdx < existing._idx) {
        byField[r.field] = {
          locale:     r.locale,
          value:      r.value,
          updated_at: Number(r.updated_at),
          _idx:       thisIdx,
        };
      }
    }
    var fields = {};
    var fieldNames = Object.keys(byField);
    for (var f = 0; f < fieldNames.length; f += 1) {
      var fname = fieldNames[f];
      fields[fname] = {
        value:          byField[fname].value,
        matched_locale: byField[fname].locale,
        updated_at:     byField[fname].updated_at,
      };
    }
    return {
      resource_kind:    kind,
      resource_id:      rid,
      requested_locale: locale,
      fields:           fields,
    };
  }

  async function removeTranslation(input) {
    _requireObject(input, "translations.removeTranslation");
    var kind   = _kind(input.resource_kind,     "translations.removeTranslation");
    var rid    = _resourceId(input.resource_id, "translations.removeTranslation");
    var locale = _locale(input.locale,          "translations.removeTranslation");
    var r;
    if (input.field === undefined || input.field === null) {
      r = await query(
        "DELETE FROM translations " +
        "WHERE resource_kind = ?1 AND resource_id = ?2 AND locale = ?3",
        [kind, rid, locale]
      );
    } else {
      var field = _field(input.field, "translations.removeTranslation");
      r = await query(
        "DELETE FROM translations " +
        "WHERE resource_kind = ?1 AND resource_id = ?2 AND locale = ?3 AND field = ?4",
        [kind, rid, locale, field]
      );
    }
    return { removed: Number(r.rowCount || 0) };
  }

  async function localesForResource(input) {
    _requireObject(input, "translations.localesForResource");
    var kind = _kind(input.resource_kind,     "translations.localesForResource");
    var rid  = _resourceId(input.resource_id, "translations.localesForResource");
    var rows = (await query(
      "SELECT DISTINCT locale FROM translations " +
      "WHERE resource_kind = ?1 AND resource_id = ?2 " +
      "ORDER BY locale ASC",
      [kind, rid]
    )).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(rows[i].locale);
    return out;
  }

  async function bulkSet(rows) {
    if (!Array.isArray(rows)) {
      throw new TypeError("translations.bulkSet: rows must be an array");
    }
    if (rows.length === 0) return { written: 0 };
    if (rows.length > MAX_BULK_ROWS) {
      throw new TypeError(
        "translations.bulkSet: rows must contain <= " + MAX_BULK_ROWS + " entries"
      );
    }
    var escapeHtml = b.template.escapeHtml;
    // Validate every row before writing any — the "atomicity" story
    // D1 supports portably. A bad row surfaces with its index and
    // offending field; zero rows reach the table.
    var normalized = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row !== "object") {
        throw new TypeError(
          "translations.bulkSet: row[" + i + "] must be an object"
        );
      }
      try {
        var kind   = _kind(row.resource_kind,     "translations.bulkSet");
        var rid    = _resourceId(row.resource_id, "translations.bulkSet");
        var locale = _locale(row.locale,          "translations.bulkSet");
        var field  = _field(row.field,            "translations.bulkSet");
        var value  = _value(row.value,            "translations.bulkSet");
        normalized.push({
          kind:   kind,
          rid:    rid,
          locale: locale,
          field:  field,
          value:  escapeHtml(value),
        });
      } catch (e) {
        throw new TypeError(
          "translations.bulkSet: row[" + i + "] — " + (e && e.message || "invalid")
        );
      }
    }
    var now = Date.now();
    var written = 0;
    for (var j = 0; j < normalized.length; j += 1) {
      var n  = normalized[j];
      var id = b.uuid.v7();
      await query(
        "INSERT INTO translations " +
        "(id, resource_kind, resource_id, locale, field, value, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) " +
        "ON CONFLICT(resource_kind, resource_id, locale, field) DO UPDATE SET " +
        "value = excluded.value, updated_at = excluded.updated_at",
        [id, n.kind, n.rid, n.locale, n.field, n.value, now]
      );
      written += 1;
    }
    return { written: written, updated_at: now };
  }

  // Report resources of a given kind that lack any translation in the
  // requested locale (or any fallback shorter than the requested
  // locale). The query enumerates distinct resource_ids that appear
  // for the kind in ANY locale, then subtracts the resource_ids that
  // already have at least one row in the locale's fallback chain.
  // `sample_size` caps the result so a dashboard query against a
  // catalogue of 100k SKUs doesn't drag a multi-MB response back.
  async function missingTranslations(input) {
    _requireObject(input, "translations.missingTranslations");
    var kind   = _kind(input.resource_kind, "translations.missingTranslations");
    var locale = _locale(input.locale,      "translations.missingTranslations");
    var sampleSize = _sampleSize(input.sample_size, "translations.missingTranslations");
    var chain = _fallbackChain(locale);

    // Pull every resource_id that has any row for this kind, then
    // filter out the ones already covered by the fallback chain. The
    // primitive doesn't know the full set of resources the operator
    // intends to translate (that lives in catalog / collections /
    // pages), so "missing" here means "the operator has translated
    // SOMETHING for this resource but not in the requested locale or
    // any of its ancestors."
    //
    // Operators who want "every product not yet translated" join the
    // catalog table against this primitive in their own dashboard
    // query — the cross-table fan-out is intentional, not a gap.
    var rows = (await query(
      "SELECT DISTINCT resource_id FROM translations " +
      "WHERE resource_kind = ?1 " +
      "AND resource_id NOT IN (" +
        "SELECT resource_id FROM translations " +
        "WHERE resource_kind = ?1 AND locale IN (" + _placeholders(chain.length, 2) + ")" +
      ") " +
      "ORDER BY resource_id ASC " +
      "LIMIT ?" + (2 + chain.length),
      [kind].concat(chain).concat([sampleSize])
    )).rows;
    var missing = [];
    for (var i = 0; i < rows.length; i += 1) missing.push(rows[i].resource_id);
    return {
      resource_kind:    kind,
      requested_locale: locale,
      fallback_chain:   chain,
      missing:          missing,
      sample_size:      sampleSize,
      truncated:        missing.length === sampleSize,
    };
  }

  return {
    setTranslation:      setTranslation,
    getTranslation:      getTranslation,
    getForResource:      getForResource,
    removeTranslation:   removeTranslation,
    localesForResource:  localesForResource,
    bulkSet:             bulkSet,
    missingTranslations: missingTranslations,
  };
}

function _hydrate(row) {
  if (!row) return null;
  return {
    id:            row.id,
    resource_kind: row.resource_kind,
    resource_id:   row.resource_id,
    locale:        row.locale,
    field:         row.field,
    value:         row.value,
    updated_at:    Number(row.updated_at),
  };
}

module.exports = {
  create:                  create,
  MAX_VALUE_LEN:           MAX_VALUE_LEN,
  MAX_BULK_ROWS:           MAX_BULK_ROWS,
  BASELINE_LOCALE:         BASELINE_LOCALE,
  DEFAULT_SAMPLE_SIZE:     DEFAULT_SAMPLE_SIZE,
};
