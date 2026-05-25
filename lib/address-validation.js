"use strict";
/**
 * @module shop.addressValidation
 * @title  Address validation + autocomplete proxy cache — stores
 *         operator-supplied normalization results so repeat lookups
 *         against the same address don't re-pay the carrier API.
 *
 * @intro
 *   The primitive does not call USPS / Smarty / Lob / Google / Melissa
 *   itself. The operator wires the actual provider call; this
 *   primitive is the storage + cache layer. The operator hands the
 *   primitive:
 *
 *     - `input`  — the raw address (or address-suggest prefix) the
 *                  user typed.
 *     - `normalized_address` — what the carrier normalized it to.
 *     - `deliverable` / `classification` / `dpv_match` — the
 *                  carrier's verdict.
 *     - `source` — which carrier produced the answer
 *                  (`usps / smarty / lob / google / melissa / manual`).
 *     - `expires_at` — operator-chosen ms-epoch when the cached row
 *                  goes stale and `lookupCached` should fall through
 *                  to a fresh provider call.
 *
 *   The same raw address must hit the same cache row, even when the
 *   operator's call site renders the input object with the keys in a
 *   different order or with a slightly different shape. The primitive
 *   derives `input_signature` from
 *
 *     b.crypto.namespaceHash("address-validation-input",
 *                            b.safeJson.canonical(input))
 *
 *   so map-order / whitespace fluctuation hashes identically. The
 *   schema's UNIQUE on `input_signature` makes `recordValidation` an
 *   upsert: a second call against the same signature overwrites the
 *   prior row (operators tuning expiry mid-flight get deterministic
 *   semantics).
 *
 *   Surface:
 *     recordValidation({ input, normalized_address, deliverable,
 *                        classification, dpv_match?, source,
 *                        order_id?, expires_at })
 *     lookupCached(input)
 *     recordSuggestion({ partial_input, suggestions, expires_at })
 *     lookupSuggestions(partial_input)
 *     cleanupExpired({ now? })
 *     metricsForSource({ slug, from, to })
 *     validationsForOrder(order_id)
 *
 *   Composes:
 *     - `b.crypto.namespaceHash`  — SHA3-512 of the canonical input
 *                                   under the address-validation
 *                                   namespace.
 *     - `b.safeJson.canonical`    — deterministic JSON serialization
 *                                   (keys sorted, no NaN / Infinity).
 *     - `b.uuid.v7`               — row PKs.
 *
 *   Storage:
 *     - `address_validations` + `address_suggestions_cache`
 *       (migration `0115_address_validation.sql`).
 *
 * @primitive addressValidation
 * @related   b.crypto, b.safeJson, b.uuid, shop.addresses, shop.geolocation
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var INPUT_NAMESPACE = "address-validation-input";

var SOURCES = Object.freeze([
  "usps", "smarty", "lob", "google", "melissa", "manual",
]);

var CLASSIFICATIONS = Object.freeze([
  "residential", "commercial", "po_box", "military", "unknown",
]);

var MAX_NORMALIZED_JSON_LEN = 16 * 1024;
var MAX_PARTIAL_INPUT_LEN   = 512;
var MAX_SUGGESTIONS_JSON_LEN = 32 * 1024;
var MAX_DPV_LEN             = 16;
var MAX_ORDER_ID_LEN        = 128;

// ---- validators ---------------------------------------------------------

function _input(value, label) {
  label = label || "input";
  if (value == null) {
    throw new TypeError("addressValidation: " + label + " is required");
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("addressValidation: " + label + " must be a plain object");
  }
  return value;
}

function _msEpoch(n, label) {
  if (typeof n !== "number" || !isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new TypeError(
      "addressValidation: " + label + " must be a non-negative integer ms-epoch"
    );
  }
  return n;
}

function _bool(v, label) {
  if (typeof v !== "boolean") {
    throw new TypeError("addressValidation: " + label + " must be a boolean");
  }
  return v;
}

function _source(s) {
  if (typeof s !== "string" || SOURCES.indexOf(s) === -1) {
    throw new TypeError(
      "addressValidation: source must be one of " + JSON.stringify(SOURCES) +
      ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _classification(s) {
  if (typeof s !== "string" || CLASSIFICATIONS.indexOf(s) === -1) {
    throw new TypeError(
      "addressValidation: classification must be one of " +
      JSON.stringify(CLASSIFICATIONS) + ", got " + JSON.stringify(s)
    );
  }
  return s;
}

function _dpvMatch(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("addressValidation: dpv_match must be a non-empty string or null");
  }
  if (s.length > MAX_DPV_LEN) {
    throw new TypeError(
      "addressValidation: dpv_match must be <= " + MAX_DPV_LEN + " characters"
    );
  }
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new TypeError("addressValidation: dpv_match must not contain control bytes");
  }
  return s;
}

function _orderId(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("addressValidation: order_id must be a non-empty string or null");
  }
  if (s.length > MAX_ORDER_ID_LEN) {
    throw new TypeError(
      "addressValidation: order_id must be <= " + MAX_ORDER_ID_LEN + " characters"
    );
  }
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new TypeError("addressValidation: order_id must not contain control bytes");
  }
  return s;
}

function _normalizedAddress(v) {
  if (v == null || typeof v !== "object" || Array.isArray(v)) {
    throw new TypeError(
      "addressValidation: normalized_address must be a plain object"
    );
  }
  var json;
  try { json = b.safeJson.canonical(v); }
  catch (e) {
    throw new TypeError(
      "addressValidation: normalized_address must be JSON-serializable — " + e.message
    );
  }
  if (json.length > MAX_NORMALIZED_JSON_LEN) {
    throw new TypeError(
      "addressValidation: normalized_address canonical-JSON must be <= " +
      MAX_NORMALIZED_JSON_LEN + " bytes"
    );
  }
  return json;
}

function _partialInput(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("addressValidation: partial_input must be a non-empty string");
  }
  if (s.length > MAX_PARTIAL_INPUT_LEN) {
    throw new TypeError(
      "addressValidation: partial_input must be <= " + MAX_PARTIAL_INPUT_LEN + " characters"
    );
  }
  if (/[\x00-\x1F\x7F]/.test(s)) {
    throw new TypeError("addressValidation: partial_input must not contain control bytes");
  }
  return s;
}

function _suggestions(v) {
  if (!Array.isArray(v)) {
    throw new TypeError("addressValidation: suggestions must be an array");
  }
  var json;
  try { json = b.safeJson.canonical(v); }
  catch (e) {
    throw new TypeError(
      "addressValidation: suggestions must be JSON-serializable — " + e.message
    );
  }
  if (json.length > MAX_SUGGESTIONS_JSON_LEN) {
    throw new TypeError(
      "addressValidation: suggestions canonical-JSON must be <= " +
      MAX_SUGGESTIONS_JSON_LEN + " bytes"
    );
  }
  return json;
}

function _now() { return Date.now(); }

// ---- signature helper --------------------------------------------------

function _signatureForInput(input) {
  _input(input, "input");
  var canonical;
  try { canonical = b.safeJson.canonical(input); }
  catch (e) {
    throw new TypeError(
      "addressValidation: input must be JSON-serializable — " + e.message
    );
  }
  return b.crypto.namespaceHash(INPUT_NAMESPACE, canonical);
}

// ---- row -> wire conversions -------------------------------------------

function _parseNormalized(raw) {
  try { return JSON.parse(raw); }
  catch (_e) {
    throw new Error(
      "addressValidation: normalized_address_json column is malformed JSON — storage corruption"
    );
  }
}

function _rowToValidation(row) {
  if (!row) return null;
  return {
    id:                  row.id,
    input_signature:     row.input_signature,
    normalized_address:  _parseNormalized(row.normalized_address_json),
    deliverable:         Number(row.deliverable) === 1,
    classification:      row.classification,
    dpv_match:           row.dpv_match == null ? null : row.dpv_match,
    source:              row.source,
    order_id:            row.order_id == null ? null : row.order_id,
    expires_at:          Number(row.expires_at),
    occurred_at:         Number(row.occurred_at),
  };
}

function _rowToSuggestion(row) {
  if (!row) return null;
  var parsed;
  try { parsed = JSON.parse(row.suggestions_json); }
  catch (_e) {
    throw new Error(
      "addressValidation: suggestions_json column is malformed JSON — storage corruption"
    );
  }
  return {
    id:            row.id,
    partial_input: row.partial_input,
    suggestions:   parsed,
    expires_at:    Number(row.expires_at),
    occurred_at:   Number(row.occurred_at),
  };
}

// ---- factory -----------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getValidationBySig(sig) {
    var r = await query(
      "SELECT * FROM address_validations WHERE input_signature = ?1",
      [sig],
    );
    return r.rows[0] || null;
  }

  async function _getSuggestionByInput(p) {
    var r = await query(
      "SELECT * FROM address_suggestions_cache WHERE partial_input = ?1",
      [p],
    );
    return r.rows[0] || null;
  }

  return {
    SOURCES:         SOURCES,
    CLASSIFICATIONS: CLASSIFICATIONS,

    // Stamp a normalization result against the input that produced it.
    // The schema's UNIQUE on input_signature makes this an upsert: a
    // second call against the same input overwrites the prior row.
    // Operators tune cache lifetime by raising / lowering `expires_at`
    // on each fresh write — the cache is operator-managed, not
    // primitive-managed.
    recordValidation: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("addressValidation.recordValidation: input object required");
      }
      var sig            = _signatureForInput(input.input);
      var normalizedJson = _normalizedAddress(input.normalized_address);
      var deliverable    = _bool(input.deliverable, "deliverable");
      var classification = _classification(input.classification);
      var dpvMatch       = _dpvMatch(input.dpv_match == null ? null : input.dpv_match);
      var source         = _source(input.source);
      var orderId        = _orderId(input.order_id == null ? null : input.order_id);
      var expiresAt      = _msEpoch(input.expires_at, "expires_at");
      var occurredAt     = input.occurred_at == null ? _now() : _msEpoch(input.occurred_at, "occurred_at");

      // Upsert. Existing row -> overwrite every operator-supplied
      // column AND refresh `occurred_at` so `metricsForSource` reflects
      // the latest provider call. The id stays stable so any external
      // reference doesn't dangle.
      var existing = await _getValidationBySig(sig);
      if (existing) {
        await query(
          "UPDATE address_validations SET " +
          "normalized_address_json = ?1, deliverable = ?2, classification = ?3, " +
          "dpv_match = ?4, source = ?5, order_id = ?6, expires_at = ?7, occurred_at = ?8 " +
          "WHERE input_signature = ?9",
          [
            normalizedJson, deliverable ? 1 : 0, classification,
            dpvMatch, source, orderId, expiresAt, occurredAt, sig,
          ],
        );
        return _rowToValidation(await _getValidationBySig(sig));
      }

      var id = b.uuid.v7();
      await query(
        "INSERT INTO address_validations " +
        "(id, input_signature, normalized_address_json, deliverable, classification, " +
        " dpv_match, source, order_id, expires_at, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        [
          id, sig, normalizedJson, deliverable ? 1 : 0, classification,
          dpvMatch, source, orderId, expiresAt, occurredAt,
        ],
      );
      return _rowToValidation(await _getValidationBySig(sig));
    },

    // Look up a cached validation by the raw input shape. Returns the
    // hydrated row when fresh, `null` when either no row exists OR the
    // row's `expires_at` is at-or-before now (expired rows are surfaced
    // as a cache miss so the caller falls through to a fresh provider
    // call). `cleanupExpired` actually deletes the row; this method
    // never mutates.
    lookupCached: async function (input) {
      var sig = _signatureForInput(input);
      var row = await _getValidationBySig(sig);
      if (!row) return null;
      var hydrated = _rowToValidation(row);
      if (hydrated.expires_at <= _now()) return null;
      return hydrated;
    },

    // Compute the cache signature for a raw input — exposed so
    // operators can pre-hash and key external storage off the same
    // shape without re-running the canonical-JSON pipeline.
    signatureFor: function (input) {
      return _signatureForInput(input);
    },

    // Autocomplete cache: a partial-input string -> array of
    // operator-opaque suggestion objects. Same upsert + expiry shape
    // as the validations table.
    recordSuggestion: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("addressValidation.recordSuggestion: input object required");
      }
      var partial         = _partialInput(input.partial_input);
      var suggestionsJson = _suggestions(input.suggestions);
      var expiresAt       = _msEpoch(input.expires_at, "expires_at");
      var occurredAt      = input.occurred_at == null ? _now() : _msEpoch(input.occurred_at, "occurred_at");

      var existing = await _getSuggestionByInput(partial);
      if (existing) {
        await query(
          "UPDATE address_suggestions_cache SET " +
          "suggestions_json = ?1, expires_at = ?2, occurred_at = ?3 " +
          "WHERE partial_input = ?4",
          [suggestionsJson, expiresAt, occurredAt, partial],
        );
        return _rowToSuggestion(await _getSuggestionByInput(partial));
      }

      var id = b.uuid.v7();
      await query(
        "INSERT INTO address_suggestions_cache " +
        "(id, partial_input, suggestions_json, expires_at, occurred_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, partial, suggestionsJson, expiresAt, occurredAt],
      );
      return _rowToSuggestion(await _getSuggestionByInput(partial));
    },

    lookupSuggestions: async function (partialInput) {
      var partial = _partialInput(partialInput);
      var row = await _getSuggestionByInput(partial);
      if (!row) return null;
      var hydrated = _rowToSuggestion(row);
      if (hydrated.expires_at <= _now()) return null;
      return hydrated;
    },

    // Delete every row in both tables whose expires_at has elapsed.
    // Returns `{ validations, suggestions, now }` so operators can
    // surface a "swept N stale entries" admin metric. Idempotent —
    // a second call immediately after the first returns zero counts.
    cleanupExpired: async function (input) {
      input = input || {};
      var now = input.now == null ? _now() : _msEpoch(input.now, "now");
      var rV = await query(
        "DELETE FROM address_validations WHERE expires_at <= ?1",
        [now],
      );
      var rS = await query(
        "DELETE FROM address_suggestions_cache WHERE expires_at <= ?1",
        [now],
      );
      return {
        validations: rV.rowCount != null ? Number(rV.rowCount) : 0,
        suggestions: rS.rowCount != null ? Number(rS.rowCount) : 0,
        now:         now,
      };
    },

    // Aggregate per-source counts over the [from, to] window keyed
    // on `occurred_at`. `slug` (the operator-facing arg name from the
    // spec) carries the source enum value; the result splits by
    // classification + deliverable so operators can spot a carrier
    // whose classification mix drifts.
    metricsForSource: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("addressValidation.metricsForSource: input object required");
      }
      var source = _source(input.slug);
      var from   = _msEpoch(input.from, "from");
      var to     = _msEpoch(input.to,   "to");
      if (to < from) {
        throw new TypeError("addressValidation.metricsForSource: to must be >= from");
      }
      var rows = (await query(
        "SELECT classification, deliverable, COUNT(*) AS row_count " +
        "FROM address_validations " +
        "WHERE source = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3 " +
        "GROUP BY classification, deliverable " +
        "ORDER BY classification ASC, deliverable ASC",
        [source, from, to],
      )).rows;
      var out = [];
      var total = 0;
      for (var i = 0; i < rows.length; i += 1) {
        var r = rows[i];
        var n = Number(r.row_count);
        total += n;
        out.push({
          source:         source,
          classification: r.classification,
          deliverable:    Number(r.deliverable) === 1,
          count:          n,
        });
      }
      return { source: source, from: from, to: to, total: total, buckets: out };
    },

    // Every validation row tagged with the given order_id, in
    // recorded-newest-first order. Operators present this list as the
    // audit trail for "show me every address normalization we paid
    // for on order X." Rows the operator never stamped with an
    // order_id are silently excluded.
    validationsForOrder: async function (orderId) {
      if (typeof orderId !== "string" || !orderId.length) {
        throw new TypeError("addressValidation.validationsForOrder: order_id must be a non-empty string");
      }
      if (orderId.length > MAX_ORDER_ID_LEN) {
        throw new TypeError(
          "addressValidation.validationsForOrder: order_id must be <= " + MAX_ORDER_ID_LEN + " characters"
        );
      }
      var rows = (await query(
        "SELECT * FROM address_validations WHERE order_id = ?1 " +
        "ORDER BY occurred_at DESC, id DESC",
        [orderId],
      )).rows;
      var out = [];
      for (var i = 0; i < rows.length; i += 1) {
        out.push(_rowToValidation(rows[i]));
      }
      return out;
    },
  };
}

module.exports = {
  create:          create,
  SOURCES:         SOURCES,
  CLASSIFICATIONS: CLASSIFICATIONS,
  INPUT_NAMESPACE: INPUT_NAMESPACE,
};
