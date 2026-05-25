"use strict";
/**
 * @module shop.taxRates
 * @title  Tax rates primitive — operator-managed per-jurisdiction rate
 *         table with scheduled effective dates
 *
 * @intro
 *   Distinct from the `tax` primitive (math + adapter surface +
 *   reverse-charge logic). This module is the SOURCE OF TRUTH for
 *   "what rate applies in jurisdiction X on date Y for category Z" —
 *   the rate table the operator's tax-update process writes into when
 *   a statutory change is published. A `rateFor` lookup returns the
 *   active rate (or null if none exists for that jurisdiction); the
 *   caller composes that with `tax.calculateExclusive` /
 *   `calculateInclusive` to actually compute the tax amount.
 *
 *   Rate selection at read time:
 *
 *     1. Most recent live row where
 *          effective_from <= on_date
 *          AND (effective_until IS NULL OR effective_until > on_date)
 *          AND archived_at IS NULL
 *          AND category = <requested category>
 *     2. If no category-specific row matches, repeat with category IS NULL
 *        (the jurisdiction's fallback rate).
 *     3. If still no row, return null. The caller decides whether to
 *        fall back to a zero rate or refuse the sale.
 *
 *   Overlap rule: two rows for the same (jurisdiction, category)
 *   whose [effective_from, effective_until) intervals intersect are
 *   refused at `defineRate` time. Operators superseding a future-dated
 *   row archive the existing row first (or supply a tighter
 *   `effective_until` on the existing row before defining the
 *   replacement).
 *
 *   Composes:
 *     - `b.guardUuid`    — UUID-shape validation for ids
 *     - `b.uuid.v7`      — row ids
 *
 *   Surface:
 *     defineRate({ jurisdiction, category?, rate_bps, effective_from,
 *                  effective_until?, source })
 *     rateFor({ jurisdiction, category?, on_date })
 *     listForJurisdiction({ jurisdiction, include_expired? })
 *     updateRate(rate_id, patch)
 *     archiveRate(rate_id, { reason? })
 *     bulkImport(rows)
 *     scheduledChanges({ from, to })
 *
 *   Storage:
 *     - `tax_rates` (migration `0058_tax_rates.sql`).
 *
 * @primitive taxRates
 * @related   b.guardUuid, b.uuid, shop.tax
 */

var b = require("./index").framework;

var JURISDICTION_RE = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/;
var MAX_CATEGORY_LEN = 64;
var CATEGORY_RE      = /^[a-z0-9][a-z0-9_-]{0,63}$/;
var MAX_BPS          = 10000;
var MAX_REASON_LEN   = 280;

var SOURCES = ["manual", "vies", "state_dept", "avalara"];

var ALLOWED_UPDATE_COLUMNS = Object.freeze([
  "rate_bps", "effective_until", "source",
]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("taxRates: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _jurisdiction(s) {
  if (typeof s !== "string" || !JURISDICTION_RE.test(s)) {
    throw new TypeError(
      "taxRates: jurisdiction must match /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/ " +
      "(ISO 3166-1 alpha-2 + optional ISO 3166-2 subdivision), got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _category(c) {
  if (c == null) return null;
  if (typeof c !== "string") {
    throw new TypeError("taxRates: category must be a string or null");
  }
  if (!c.length) return null;
  if (c.length > MAX_CATEGORY_LEN) {
    throw new TypeError("taxRates: category must be <= " + MAX_CATEGORY_LEN + " characters");
  }
  if (!CATEGORY_RE.test(c)) {
    throw new TypeError(
      "taxRates: category must match /^[a-z0-9][a-z0-9_-]{0,63}$/ — " +
      "lowercase alphanumerics with `_`/`-`, must not start with separator"
    );
  }
  return c;
}

function _rateBps(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_BPS) {
    throw new TypeError(
      "taxRates: rate_bps must be an integer 0.." + MAX_BPS + " (1 bp = 0.01%), got " +
      JSON.stringify(n)
    );
  }
  return n;
}

function _timestamp(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "taxRates: " + label + " must be a non-negative integer (ms epoch), got " +
      JSON.stringify(n)
    );
  }
  return n;
}

function _effectiveUntil(n, effFrom) {
  if (n == null) return null;
  _timestamp(n, "effective_until");
  if (n <= effFrom) {
    throw new TypeError(
      "taxRates: effective_until must be strictly greater than effective_from"
    );
  }
  return n;
}

function _source(s) {
  if (typeof s !== "string" || SOURCES.indexOf(s) === -1) {
    throw new TypeError("taxRates: source must be one of " + SOURCES.join(", "));
  }
  return s;
}

function _reason(r) {
  if (r == null) return null;
  if (typeof r !== "string") {
    throw new TypeError("taxRates: reason must be a string or null");
  }
  if (!r.length) return null;
  if (r.length > MAX_REASON_LEN) {
    throw new TypeError("taxRates: reason must be <= " + MAX_REASON_LEN + " characters");
  }
  return r;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getRaw(id) {
    var r = await query("SELECT * FROM tax_rates WHERE id = ?1", [id]);
    return r.rows[0] || null;
  }

  // Overlap check for (jurisdiction, category, effective_from,
  // effective_until). Two live (non-archived) rows for the same
  // (jurisdiction, category) intersect when:
  //
  //   existing.effective_from < new.effective_until
  //   AND (existing.effective_until IS NULL OR existing.effective_until > new.effective_from)
  //
  // `new.effective_until == null` is treated as +infinity. The
  // `ignoreId` parameter skips a row by id so `updateRate` can
  // re-check overlap against the row it's mutating.
  async function _findOverlap(j, c, effFrom, effUntil, ignoreId) {
    var newUntil = effUntil == null ? Number.MAX_SAFE_INTEGER : effUntil;
    var where  = ["jurisdiction = ?1", "archived_at IS NULL"];
    var params = [j];
    var idx = 2;
    if (c == null) {
      where.push("category IS NULL");
    } else {
      where.push("category = ?" + idx);
      params.push(c);
      idx += 1;
    }
    where.push("effective_from < ?" + idx);
    params.push(newUntil);
    idx += 1;
    where.push("(effective_until IS NULL OR effective_until > ?" + idx + ")");
    params.push(effFrom);
    idx += 1;
    if (ignoreId) {
      where.push("id != ?" + idx);
      params.push(ignoreId);
      idx += 1;
    }
    var sql = "SELECT id, effective_from, effective_until FROM tax_rates WHERE " +
              where.join(" AND ") + " LIMIT 1";
    var r = await query(sql, params);
    return r.rows[0] || null;
  }

  async function _insertOne(row) {
    await query(
      "INSERT INTO tax_rates " +
      "(id, jurisdiction, category, rate_bps, effective_from, effective_until, " +
      " source, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
      [
        row.id, row.jurisdiction, row.category, row.rate_bps,
        row.effective_from, row.effective_until, row.source, row.created_at,
      ],
    );
  }

  return {
    JURISDICTION_RE:        JURISDICTION_RE,
    SOURCES:                SOURCES.slice(),
    MAX_BPS:                MAX_BPS,
    MAX_CATEGORY_LEN:       MAX_CATEGORY_LEN,

    // Write one rate. Refuses if the new row would overlap an
    // existing live (non-archived) row for the same (jurisdiction,
    // category). The caller archives or shortens the existing row
    // first when superseding.
    defineRate: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxRates.defineRate: input object required");
      }
      var jurisdiction = _jurisdiction(input.jurisdiction);
      var category     = _category(input.category);
      var rateBps      = _rateBps(input.rate_bps);
      var effFrom      = _timestamp(input.effective_from, "effective_from");
      var effUntil     = _effectiveUntil(input.effective_until, effFrom);
      var source       = _source(input.source);

      var overlap = await _findOverlap(jurisdiction, category, effFrom, effUntil, null);
      if (overlap) {
        var err = new Error(
          "taxRates.defineRate: refused — overlaps existing rate " +
          overlap.id + " (effective_from=" + overlap.effective_from +
          ", effective_until=" + (overlap.effective_until == null ? "null" : overlap.effective_until) +
          "). Archive or shorten the existing row before defining the replacement."
        );
        err.code = "TAX_RATE_OVERLAP";
        err.overlap_id = overlap.id;
        throw err;
      }

      var id = b.uuid.v7();
      var ts = _now();
      await _insertOne({
        id:              id,
        jurisdiction:    jurisdiction,
        category:        category,
        rate_bps:        rateBps,
        effective_from:  effFrom,
        effective_until: effUntil,
        source:          source,
        created_at:      ts,
      });
      return await _getRaw(id);
    },

    // Resolve the active rate for a (jurisdiction, category, on_date)
    // tuple. Returns the row (or null when no live row covers the
    // requested moment). Category-specific rows take precedence over
    // the jurisdiction's NULL-category fallback.
    rateFor: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxRates.rateFor: input object required");
      }
      var jurisdiction = _jurisdiction(input.jurisdiction);
      var category     = _category(input.category);
      var onDate       = _timestamp(input.on_date, "on_date");

      // Phase 1: category-specific lookup (only when category is
      // supplied). The ORDER BY effective_from DESC + LIMIT 1 picks
      // the most recently-effective live row that covers on_date.
      if (category != null) {
        var rSpec = await query(
          "SELECT * FROM tax_rates " +
          "WHERE jurisdiction = ?1 AND category = ?2 " +
          "  AND archived_at IS NULL " +
          "  AND effective_from <= ?3 " +
          "  AND (effective_until IS NULL OR effective_until > ?3) " +
          "ORDER BY effective_from DESC LIMIT 1",
          [jurisdiction, category, onDate],
        );
        if (rSpec.rows.length) return rSpec.rows[0];
      }

      // Phase 2: NULL-category fallback for the jurisdiction.
      var rFall = await query(
        "SELECT * FROM tax_rates " +
        "WHERE jurisdiction = ?1 AND category IS NULL " +
        "  AND archived_at IS NULL " +
        "  AND effective_from <= ?2 " +
        "  AND (effective_until IS NULL OR effective_until > ?2) " +
        "ORDER BY effective_from DESC LIMIT 1",
        [jurisdiction, onDate],
      );
      return rFall.rows[0] || null;
    },

    // List every rate ever written for a jurisdiction (default skips
    // archived + expired rows; `include_expired: true` returns the
    // full history). Ordered most-recent first by effective_from for
    // operator dashboards.
    listForJurisdiction: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxRates.listForJurisdiction: input object required");
      }
      var jurisdiction = _jurisdiction(input.jurisdiction);
      var includeExpired = input.include_expired === true;
      var sql, params;
      if (includeExpired) {
        sql = "SELECT * FROM tax_rates WHERE jurisdiction = ?1 " +
              "ORDER BY effective_from DESC, id DESC";
        params = [jurisdiction];
      } else {
        var now = _now();
        sql = "SELECT * FROM tax_rates WHERE jurisdiction = ?1 " +
              "  AND archived_at IS NULL " +
              "  AND (effective_until IS NULL OR effective_until > ?2) " +
              "ORDER BY effective_from DESC, id DESC";
        params = [jurisdiction, now];
      }
      var r = await query(sql, params);
      return r.rows;
    },

    // Patch-style update — only ALLOWED_UPDATE_COLUMNS can be set.
    // jurisdiction + category + effective_from are immutable post-
    // creation (changing them would re-aim a historical attribution
    // row at a different cell and break the audit trail). To "move" a
    // row to a different jurisdiction or window, archive the existing
    // row and define a replacement.
    //
    // Mutating `effective_until` re-checks the overlap rule against
    // the row's effective_from + the new effective_until (with this
    // row excluded so it doesn't overlap itself).
    updateRate: async function (rateId, patch) {
      var id = _uuid(rateId, "rate_id");
      if (!patch || typeof patch !== "object") {
        throw new TypeError("taxRates.updateRate: patch object required");
      }
      var keys = Object.keys(patch);
      if (!keys.length) {
        throw new TypeError("taxRates.updateRate: patch must contain at least one column");
      }
      for (var i = 0; i < keys.length; i += 1) {
        if (ALLOWED_UPDATE_COLUMNS.indexOf(keys[i]) === -1) {
          throw new TypeError("taxRates.updateRate: column '" + keys[i] + "' not updatable");
        }
      }
      var current = await _getRaw(id);
      if (!current) return null;
      if (current.archived_at != null) {
        var refused = new Error("taxRates.updateRate: refused — rate is archived");
        refused.code = "TAX_RATE_ARCHIVED";
        throw refused;
      }

      var sets   = [];
      var params = [];
      var idx    = 1;
      function _set(col, val) {
        sets.push(col + " = ?" + idx);
        params.push(val);
        idx += 1;
      }
      if (patch.rate_bps != null) _set("rate_bps", _rateBps(patch.rate_bps));
      if (Object.prototype.hasOwnProperty.call(patch, "effective_until")) {
        var newUntil = patch.effective_until == null
          ? null
          : _effectiveUntil(patch.effective_until, Number(current.effective_from));
        // Re-check overlap with the row excluded from the search.
        var overlap = await _findOverlap(
          current.jurisdiction,
          current.category,
          Number(current.effective_from),
          newUntil,
          id
        );
        if (overlap) {
          var err = new Error(
            "taxRates.updateRate: refused — new effective_until overlaps existing rate " +
            overlap.id
          );
          err.code = "TAX_RATE_OVERLAP";
          err.overlap_id = overlap.id;
          throw err;
        }
        _set("effective_until", newUntil);
      }
      if (patch.source != null) _set("source", _source(patch.source));

      var ts = _now();
      _set("updated_at", ts);
      params.push(id);
      var sql = "UPDATE tax_rates SET " + sets.join(", ") + " WHERE id = ?" + idx;
      await query(sql, params);
      return await _getRaw(id);
    },

    // Soft-delete — stamp archived_at so the row stops participating
    // in `rateFor` lookups and in overlap checks for future
    // `defineRate` calls. The row stays on disk for audit.
    archiveRate: async function (rateId, archiveOpts) {
      var id = _uuid(rateId, "rate_id");
      archiveOpts = archiveOpts || {};
      // _reason validates shape; the value isn't persisted on the
      // tax_rates row itself (no column for it) — the operator's
      // audit log captures the reason out-of-band. Validating here
      // refuses oversized / non-string input at the door instead of
      // silently dropping it.
      _reason(archiveOpts.reason);
      var current = await _getRaw(id);
      if (!current) return null;
      if (current.archived_at != null) return current;
      var ts = _now();
      await query(
        "UPDATE tax_rates SET archived_at = ?1, updated_at = ?1 WHERE id = ?2",
        [ts, id],
      );
      return await _getRaw(id);
    },

    // Operator-bulk write — typically called by an import script
    // hydrating a paid-feed snapshot. Each row goes through the same
    // validation + overlap check as `defineRate`; the operation is
    // all-or-nothing per row (a row that fails validation throws
    // immediately and the caller decides whether to retry the
    // remaining rows). Returns the array of inserted row ids in input
    // order. Overlap detection runs against ALL prior rows, including
    // earlier rows in the same `bulkImport` call — two same-window
    // rows in the same payload are refused at the second row.
    bulkImport: async function (rows) {
      if (!Array.isArray(rows)) {
        throw new TypeError("taxRates.bulkImport: rows must be an array");
      }
      var ids = [];
      for (var i = 0; i < rows.length; i += 1) {
        var input = rows[i];
        if (!input || typeof input !== "object") {
          throw new TypeError("taxRates.bulkImport: rows[" + i + "] must be an object");
        }
        var jurisdiction = _jurisdiction(input.jurisdiction);
        var category     = _category(input.category);
        var rateBps      = _rateBps(input.rate_bps);
        var effFrom      = _timestamp(input.effective_from, "rows[" + i + "].effective_from");
        var effUntil     = _effectiveUntil(input.effective_until, effFrom);
        var source       = _source(input.source);

        var overlap = await _findOverlap(jurisdiction, category, effFrom, effUntil, null);
        if (overlap) {
          var err = new Error(
            "taxRates.bulkImport: rows[" + i + "] refused — overlaps existing rate " +
            overlap.id
          );
          err.code = "TAX_RATE_OVERLAP";
          err.overlap_id = overlap.id;
          err.row_index = i;
          throw err;
        }

        var id = b.uuid.v7();
        var ts = _now();
        await _insertOne({
          id:              id,
          jurisdiction:    jurisdiction,
          category:        category,
          rate_bps:        rateBps,
          effective_from:  effFrom,
          effective_until: effUntil,
          source:          source,
          created_at:      ts,
        });
        ids.push(id);
      }
      return ids;
    },

    // Return every live (non-archived) rate whose `effective_from`
    // OR `effective_until` falls inside [from, to]. Operator
    // scheduler hint: "what rate changes hit the till in this
    // window?". Each row is annotated with a `change_kind` of
    // `starts` (effective_from in window) or `ends`
    // (effective_until in window); a row whose both endpoints land
    // in the window appears twice (once per kind) so an operator's
    // calendar shows both bell-ringings.
    scheduledChanges: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("taxRates.scheduledChanges: input object required");
      }
      var from = _timestamp(input.from, "from");
      var to   = _timestamp(input.to,   "to");
      if (from > to) {
        throw new TypeError("taxRates.scheduledChanges: from must be <= to");
      }
      var r = await query(
        "SELECT * FROM tax_rates " +
        "WHERE archived_at IS NULL " +
        "  AND ( (effective_from >= ?1 AND effective_from <= ?2) " +
        "     OR (effective_until IS NOT NULL AND effective_until >= ?1 AND effective_until <= ?2) ) " +
        "ORDER BY effective_from ASC, id ASC",
        [from, to],
      );
      var out = [];
      for (var i = 0; i < r.rows.length; i += 1) {
        var row = r.rows[i];
        var startsIn = Number(row.effective_from) >= from && Number(row.effective_from) <= to;
        var endsIn   = row.effective_until != null &&
                       Number(row.effective_until) >= from &&
                       Number(row.effective_until) <= to;
        if (startsIn) {
          out.push(Object.assign({ change_kind: "starts", change_at: Number(row.effective_from) }, row));
        }
        if (endsIn) {
          out.push(Object.assign({ change_kind: "ends", change_at: Number(row.effective_until) }, row));
        }
      }
      // Stable secondary sort by change_at so the operator calendar
      // reads chronologically across both kinds.
      out.sort(function (a, b) {
        if (a.change_at !== b.change_at) return a.change_at - b.change_at;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return a.change_kind < b.change_kind ? -1 : (a.change_kind > b.change_kind ? 1 : 0);
      });
      return out;
    },
  };
}

module.exports = {
  create:           create,
  JURISDICTION_RE:  JURISDICTION_RE,
  SOURCES:          SOURCES.slice(),
  MAX_BPS:          MAX_BPS,
  MAX_CATEGORY_LEN: MAX_CATEGORY_LEN,
};
