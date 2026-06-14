"use strict";
/**
 * @module shop.inventoryWriteoffs
 * @title  Inventory write-offs — operator-recorded stock removal for
 *         damage / loss / shrinkage / expiry / recall / sample / QC /
 *         theft
 *
 * @intro
 *   The shelf decrements every time a unit leaves the building. Most
 *   exits go through a sale (the checkout primitive composes
 *   inventoryLocations.adjustStock with the order id as the audit
 *   reason). The remaining exits — broken-on-receipt damage, expired
 *   yogurt, samples handed to an influencer, the pallet that walked
 *   off the loading dock — need an operator-attested record so the
 *   shrinkage report has a paper trail and the COGS attribution
 *   doesn't silently leak into a generic "adjustment".
 *
 *   This primitive is the verb for that record. One row per
 *   write-off, eight enumerated reasons, optional location-scope, and
 *   two composition seams: inventoryLocations (always wired — the
 *   primitive refuses without it because every write-off MUST debit
 *   the shelf) and costLayers (optional — wired by operators running
 *   COGS reporting so the cost-impact column carries a real number).
 *
 *   Surface:
 *
 *     recordWriteoff({ sku, location_code?, quantity, reason, actor,
 *                      notes?, occurred_at? })
 *       Validates input + checks the reason is in the enumerated set
 *       above. Debits stock via `inventoryLocations.adjustStock(-qty)`
 *       (refuses upstream if the shelf doesn't have enough). When
 *       costLayers is wired, also calls `costLayers.consumeForSale`
 *       with a synthetic order_id (`writeoff:<id>`) + line_id (`1`)
 *       so the destroyed stock attributes against existing cost
 *       layers — operators reading COGS-for-period reports see the
 *       shrinkage cost surface there too. The cost-impact value
 *       lands on the writeoff row so the dashboard joins one table
 *       to render the loss dollar figure. When costLayers refuses
 *       (no on-hand layers, currency drift), the inventory debit is
 *       reversed so the shelf doesn't disagree with the write-off
 *       record — operators see a clean refusal rather than a half-
 *       committed row.
 *
 *     getWriteoff(id)
 *       Hydrated row or null on miss. guardUuid validates shape.
 *
 *     listWriteoffs({ from?, to?, reason?, location_code?, limit?,
 *                     cursor? })
 *       Paginated read. Defaults to occurred_at DESC ordering.
 *       Optional filters compose with AND. Cursor is HMAC-tagged so
 *       an operator can't tamper with it.
 *
 *     costImpactForPeriod({ from, to, reason? })
 *       Sums `cost_impact_minor` across non-reversed rows whose
 *       occurred_at falls in `[from, to)`. Returns per-reason +
 *       grand-total. Refuses when the in-period rows span multiple
 *       currencies — the operator must reconcile (mixed-currency
 *       totals are meaningless without an FX conversion the
 *       primitive doesn't own).
 *
 *     reverseWriteoff({ id, reason })
 *       Restores stock via `inventoryLocations.adjustStock(+qty)`.
 *       When costLayers was wired AND a cost-impact was recorded,
 *       composes `costLayers.recordReversal({ order_id, line_id })`
 *       so the cost layer pool gets the unit back at its original
 *       per-unit cost. Marks the row `status='reversed'` with the
 *       operator-supplied reason + a reversed_at timestamp. Refuses
 *       on already-reversed rows (no double-reverse).
 *
 *   Composition:
 *     - b.uuid.v7              — writeoff PK (sortable UUID v7)
 *     - b.guardUuid            — strict UUID validation on every id
 *     - b.pagination           — HMAC-tagged cursor for listWriteoffs
 *     - inventoryLocations     — sole owner of inventory_stock
 *                                mutation; this primitive composes
 *                                adjustStock to debit / restore.
 *     - costLayers (optional)  — when present, owns the cost-impact
 *                                accounting.
 *
 *   Strict-monotonic clock: per-SKU `occurred_at` is bumped to
 *   `prior + 1` when the operator-supplied (or `Date.now()`) value
 *   would tie or land older than the most recent write-off for the
 *   same SKU. Two write-offs in the same millisecond don't collide
 *   on the timeline — `listWriteoffs` ordering is unambiguous.
 *
 *   Three-tier input validation (use the discipline; don't write the
 *   labels): every public verb is a config-time entry point OR a
 *   defensive request-shape reader. Both throw on bad input. No
 *   drop-silent hot-path sinks.
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var CODE_RE         = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var SKU_RE          = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var ACTOR_RE        = /^[\S\s]{1,256}$/;
var PRINTABLE_RE    = /^[^\x00-\x08\x0b\x0c\x0e-\x1f\x7f]+$/;
var MAX_NOTES       = 4096;
var MAX_REASON_TEXT = 280;
var MAX_LIST_LIMIT  = 200;

var WRITEOFF_REASONS = Object.freeze([
  "damaged", "lost", "shrinkage", "expired",
  "recall", "sample", "quality_control", "theft",
]);
var WRITEOFF_STATUSES = Object.freeze(["recorded", "reversed"]);
var WRITEOFF_ORDER_KEY = ["occurred_at:desc", "id:desc"];

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("inventory-writeoffs: " + (label || "id") +
      " — " + (e && e.message || "invalid UUID"));
  }
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-writeoffs: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
  return s;
}
function _code(s, label) {
  if (typeof s !== "string" || !CODE_RE.test(s)) {
    throw new TypeError("inventory-writeoffs: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
  return s;
}
function _optCode(s, label) {
  if (s == null) return null;
  return _code(s, label);
}
function _positiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("inventory-writeoffs: " + label + " must be a positive integer");
  }
  return n;
}
function _reason(s) {
  if (typeof s !== "string" || WRITEOFF_REASONS.indexOf(s) === -1) {
    throw new TypeError("inventory-writeoffs: reason must be one of " +
      WRITEOFF_REASONS.join(", ") + ", got " + JSON.stringify(s));
  }
  return s;
}
function _actor(s) {
  if (typeof s !== "string" || !ACTOR_RE.test(s) || s.length > 256) {
    throw new TypeError("inventory-writeoffs: actor must be a non-empty string ≤ 256 chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("inventory-writeoffs: actor must not contain control bytes other than tab/newline/CR");
  }
  return s;
}
function _notes(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("inventory-writeoffs: notes must be a string or null");
  }
  if (s.length > MAX_NOTES) {
    throw new TypeError("inventory-writeoffs: notes must be ≤ " + MAX_NOTES + " chars");
  }
  if (s.length && !PRINTABLE_RE.test(s)) {
    throw new TypeError("inventory-writeoffs: notes must not contain control bytes other than tab/newline/CR");
  }
  return s;
}
function _reverseReason(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("inventory-writeoffs: reverse reason must be a non-empty string");
  }
  if (s.length > MAX_REASON_TEXT) {
    throw new TypeError("inventory-writeoffs: reverse reason must be ≤ " + MAX_REASON_TEXT + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("inventory-writeoffs: reverse reason must not contain control bytes other than tab/newline/CR");
  }
  return s;
}
function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("inventory-writeoffs: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}
function _limit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("inventory-writeoffs: limit must be an integer in 1..." + MAX_LIST_LIMIT);
  }
  return n;
}

function _now() { return Date.now(); }

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  // inventoryLocations is mandatory — every write-off MUST debit the
  // shelf, so wiring without it is a misconfigured operator boot.
  if (!opts.inventoryLocations ||
      typeof opts.inventoryLocations.adjustStock !== "function") {
    throw new TypeError("inventory-writeoffs.create: opts.inventoryLocations with adjustStock is required");
  }
  var locations = opts.inventoryLocations;
  // costLayers is optional — when wired, every recordWriteoff also
  // calls consumeForSale to attribute COGS-equivalent cost; without
  // it, cost_impact_minor stays NULL and costImpactForPeriod returns
  // a zero-total for the period.
  var costLayers = opts.costLayers != null ? opts.costLayers : null;
  if (costLayers !== null) {
    if (typeof costLayers.consumeForSale !== "function" ||
        typeof costLayers.recordReversal !== "function") {
      throw new TypeError("inventory-writeoffs.create: opts.costLayers must expose consumeForSale + recordReversal when wired");
    }
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged so an operator can't tamper or
  // replay across deployments. Tests inject a fixed dev string;
  // production must supply an explicit secret.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("inventory-writeoffs.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "inventory-writeoffs-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Latest occurred_at for a SKU; null when the SKU has no prior
  // write-off. Used by the strict-monotonic clock so two write-offs
  // in the same millisecond don't tie on the timeline ordering key.
  async function _latestWriteoffTs(sku) {
    var r = await query(
      "SELECT MAX(occurred_at) AS ts FROM inventory_writeoffs WHERE sku = ?1",
      [sku],
    );
    if (!r.rows.length || r.rows[0].ts == null) return null;
    return r.rows[0].ts;
  }

  function _resolveOccurredAt(requestedTs, latestTs) {
    if (latestTs == null) return requestedTs;
    if (requestedTs > latestTs) return requestedTs;
    return latestTs + 1;
  }

  async function _getWriteoffRow(id) {
    var r = await query("SELECT * FROM inventory_writeoffs WHERE id = ?1", [id]);
    if (!r.rows.length) return null;
    return r.rows[0];
  }

  return {

    // Record a write-off. Validates input, debits the shelf via
    // inventoryLocations.adjustStock, and (when costLayers is wired)
    // composes consumeForSale so the cost-impact column carries a
    // real COGS-equivalent value. Returns the hydrated row.
    recordWriteoff: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-writeoffs.recordWriteoff: input object required");
      }
      var sku       = _sku(input.sku);
      var locCode   = _optCode(input.location_code, "location_code");
      var quantity  = _positiveInt(input.quantity, "quantity");
      var reason    = _reason(input.reason);
      var actor     = _actor(input.actor);
      var notes     = _notes(input.notes);
      var requested = _epochMs(input.occurred_at, "occurred_at");
      if (requested == null) requested = _now();
      var latestTs  = await _latestWriteoffTs(sku);
      var occurredAt = _resolveOccurredAt(requested, latestTs);

      var id = b.uuid.v7();

      // Debit the shelf first. When location_code is null we don't
      // touch a specific shelf — the operator is recording a "global"
      // write-off (catalog-level shrinkage adjustment with no per-
      // location accounting). When location_code is set, the
      // adjustStock refuses if the shelf doesn't have enough; that
      // refusal propagates with no compensating action needed
      // because no row has been written yet.
      if (locCode !== null) {
        await locations.adjustStock({
          sku:           sku,
          location_code: locCode,
          delta:         -quantity,
          reason:        "writeoff:" + reason + ":" + id,
          // Operator shrinkage must not over-debit the shelf below the
          // outstanding paid holds for this SKU — a later commitHold
          // would otherwise fail with the hold stranded.
          respect_holds: true,
        });
      }

      // Attribute COGS-equivalent cost when costLayers is wired. The
      // synthetic order_id `writeoff:<id>` keeps the cost-layer
      // attribution discoverable from this primitive (reverseWriteoff
      // composes recordReversal with the same id pair to restore
      // layers cleanly).
      var costImpactMinor = null;
      var currency        = null;
      if (costLayers !== null) {
        try {
          var consumed = await costLayers.consumeForSale({
            sku:         sku,
            quantity:    quantity,
            order_id:    "writeoff:" + id,
            line_id:     "1",
            occurred_at: occurredAt,
          });
          costImpactMinor = consumed.total_cogs_minor;
          currency        = consumed.currency;
        } catch (e) {
          // The cost-layer pool refused (no on-hand layers yet, or
          // currency drift across layers). Restore the shelf debit
          // so the storefront doesn't disagree with the write-off
          // record, then surface the original refusal — the operator
          // either records a receipt first or reconciles currency
          // before retrying.
          if (locCode !== null) {
            try {
              await locations.adjustStock({
                sku:           sku,
                location_code: locCode,
                delta:         quantity,
                reason:        "writeoff:rollback:" + id,
              });
            } catch (_e2) { /* drop-silent — the original cost-layer error is the operator's signal */ }
          }
          throw e;
        }
      }

      try {
        await query(
          "INSERT INTO inventory_writeoffs " +
          "(id, sku, location_code, quantity, reason, actor, notes, " +
          " cost_impact_minor, currency, status, occurred_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'recorded', ?10)",
          [id, sku, locCode, quantity, reason, actor, notes,
            costImpactMinor, currency, occurredAt],
        );
      } catch (e3) {
        // The header row failed to land. Restore the cost-layer
        // consumption AND the shelf debit so the system returns to
        // its pre-call state.
        if (costLayers !== null) {
          try {
            await costLayers.recordReversal({
              order_id: "writeoff:" + id,
              line_id:  "1",
              reason:   "writeoff:rollback:" + id,
            });
          } catch (_e4) { /* drop-silent — the original DB error is the operator's signal */ }
        }
        if (locCode !== null) {
          try {
            await locations.adjustStock({
              sku:           sku,
              location_code: locCode,
              delta:         quantity,
              reason:        "writeoff:rollback:" + id,
            });
          } catch (_e5) { /* drop-silent — the original DB error is the operator's signal */ }
        }
        throw e3;
      }

      return await _getWriteoffRow(id);
    },

    // Hydrated row or null on miss.
    getWriteoff: async function (writeoffId) {
      var id = _id(writeoffId, "id");
      return await _getWriteoffRow(id);
    },

    // Paginated read with optional filters. Ordered by
    // (occurred_at DESC, id DESC) — the most recent write-offs at
    // the top, deterministic tie-break on id for cursor stability.
    listWriteoffs: async function (listOpts) {
      listOpts = listOpts || {};
      var from    = _epochMs(listOpts.from, "from");
      var to      = _epochMs(listOpts.to,   "to");
      var reasonF = null;
      if (listOpts.reason != null) reasonF = _reason(listOpts.reason);
      var locF    = null;
      if (listOpts.location_code != null) locF = _code(listOpts.location_code, "location_code");
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit);

      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("inventory-writeoffs.listWriteoffs: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(WRITEOFF_ORDER_KEY)) {
            throw new TypeError("inventory-writeoffs.listWriteoffs: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("inventory-writeoffs.listWriteoffs: cursor — " +
            (e && e.message || "malformed"));
        }
      }

      // Build the WHERE clause incrementally so omitted filters land
      // no parameter at all (clean explain plan vs. always-passing
      // `?1 IS NULL OR col = ?1` shape).
      var clauses = [];
      var params  = [];
      var idx     = 1;
      if (from != null) { clauses.push("occurred_at >= ?" + idx); params.push(from); idx += 1; }
      if (to   != null) { clauses.push("occurred_at <  ?" + idx); params.push(to);   idx += 1; }
      if (reasonF != null) { clauses.push("reason = ?" + idx); params.push(reasonF); idx += 1; }
      if (locF    != null) { clauses.push("location_code = ?" + idx); params.push(locF); idx += 1; }
      if (cursorVals) {
        clauses.push("(occurred_at < ?" + idx + " OR (occurred_at = ?" + idx + " AND id < ?" + (idx + 1) + "))");
        params.push(cursorVals[0]); idx += 1;
        params.push(cursorVals[1]); idx += 1;
      }
      var where = clauses.length ? "WHERE " + clauses.join(" AND ") + " " : "";
      params.push(limit);
      var sql = "SELECT * FROM inventory_writeoffs " + where +
                "ORDER BY occurred_at DESC, id DESC LIMIT ?" + idx;
      var rows = (await query(sql, params)).rows;
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: WRITEOFF_ORDER_KEY,
          vals:     [last.occurred_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    // Sum cost_impact_minor over the period, optionally narrowed by
    // reason. Reversed rows are excluded (the operator un-did them;
    // they didn't actually cost anything). Mixed-currency rows are
    // refused — the operator reconciles before pulling a meaningful
    // total. Returns per-reason + grand-total.
    costImpactForPeriod: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-writeoffs.costImpactForPeriod: input object required");
      }
      var from = _epochMs(input.from, "from");
      var to   = _epochMs(input.to,   "to");
      if (from == null || to == null) {
        throw new TypeError("inventory-writeoffs.costImpactForPeriod: from and to are required (epoch-ms)");
      }
      if (to <= from) {
        throw new TypeError("inventory-writeoffs.costImpactForPeriod: to must be > from");
      }
      var reasonF = null;
      if (input.reason != null) reasonF = _reason(input.reason);

      var clauses = ["occurred_at >= ?1", "occurred_at < ?2",
        "status = 'recorded'", "cost_impact_minor IS NOT NULL"];
      var params  = [from, to];
      if (reasonF != null) {
        clauses.push("reason = ?3");
        params.push(reasonF);
      }
      var sql = "SELECT reason, currency, SUM(cost_impact_minor) AS total " +
                "FROM inventory_writeoffs WHERE " + clauses.join(" AND ") +
                " GROUP BY reason, currency ORDER BY reason ASC";
      var rows = (await query(sql, params)).rows;

      // Currency-coherence gate: every grouped row in the period must
      // share the same currency, or the grand-total is meaningless.
      // When the operator hasn't recorded any cost-impact rows yet
      // (no costLayers wiring, or all writeoffs had no on-hand
      // layers), the rowset is empty and the answer is a zero-total.
      var currency = null;
      var byReason = [];
      var grandTotal = 0;
      for (var i = 0; i < rows.length; i += 1) {
        if (currency == null) currency = rows[i].currency;
        else if (rows[i].currency !== currency) {
          throw new TypeError("inventory-writeoffs.costImpactForPeriod: rows in period " +
            "span multiple currencies (" + currency + ", " + rows[i].currency +
            ") — reconcile before reporting");
        }
        // SQLite SUM() returns the integer as a JS number when in
        // range; coerce defensively in case the underlying driver
        // hands back a BigInt for very large totals.
        var t = typeof rows[i].total === "bigint" ? Number(rows[i].total) : rows[i].total;
        byReason.push({ reason: rows[i].reason, total_cogs_minor: t });
        grandTotal += t;
      }
      return {
        from:                  from,
        to:                    to,
        by_reason:             byReason,
        total_cost_impact_minor: grandTotal,
        currency:              currency,
      };
    },

    // Restore a write-off. Adds stock back via
    // inventoryLocations.adjustStock(+qty); when the original write-
    // off had a cost-impact attribution, composes
    // costLayers.recordReversal with the same synthetic order_id /
    // line_id pair so the cost-layer pool gets the unit back at its
    // original per-unit cost. Marks the row reversed + stamps
    // reversed_at / reverse_reason. Refuses on already-reversed
    // rows (no double-reverse).
    reverseWriteoff: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-writeoffs.reverseWriteoff: input object required");
      }
      var id = _id(input.id, "id");
      var reason = _reverseReason(input.reason);
      var row = await _getWriteoffRow(id);
      if (!row) {
        throw new TypeError("inventory-writeoffs.reverseWriteoff: writeoff " + id + " not found");
      }
      if (row.status !== "recorded") {
        throw new TypeError("inventory-writeoffs.reverseWriteoff: writeoff " + id +
          " is " + row.status + ", only recorded writeoffs can be reversed");
      }
      // A cost-impact attribution with costLayers unwired is an operator
      // misconfiguration — refuse up front BEFORE claiming the row, so the
      // claim only happens on a reversal we can actually complete.
      if (row.cost_impact_minor != null && costLayers === null) {
        throw new TypeError("inventory-writeoffs.reverseWriteoff: writeoff " + id +
          " carries a cost-impact attribution but costLayers is not wired — " +
          "rewire costLayers before reversing this row");
      }

      // Claim the recorded -> reversed transition atomically BEFORE restoring
      // the shelf or the cost-layer pool. Two concurrent reverses both pass the
      // read above, but only one UPDATE matches `status = 'recorded'`; the
      // loser refuses, so the shelf restore + cost-layer reversal each run
      // exactly once. (Without this guard both calls would restore stock and
      // record a cost-layer reversal, double-restoring.)
      var ts = _now();
      var claim = await query(
        "UPDATE inventory_writeoffs SET status = 'reversed', reversed_at = ?1, " +
        "reverse_reason = ?2 WHERE id = ?3 AND status = 'recorded'",
        [ts, reason, id],
      );
      if (Number(claim.rowCount || 0) !== 1) {
        throw new TypeError("inventory-writeoffs.reverseWriteoff: writeoff " + id +
          " is no longer recorded (reversed by a concurrent call)");
      }

      // Compensating release of the claim — flips the row back to 'recorded'
      // so the operator can retry once they've fixed the side-effect failure.
      async function _releaseClaim() {
        try {
          await query(
            "UPDATE inventory_writeoffs SET status = 'recorded', reversed_at = NULL, " +
            "reverse_reason = NULL WHERE id = ?1 AND status = 'reversed'",
            [id],
          );
        } catch (_e0) { /* drop-silent — the side-effect error is the operator's signal */ }
      }

      // Restore the shelf. Mirrors the recordWriteoff logic: when
      // location_code is null the original write-off didn't touch a
      // specific shelf, so nothing to restore.
      if (row.location_code != null) {
        try {
          await locations.adjustStock({
            sku:           row.sku,
            location_code: row.location_code,
            delta:         row.quantity,
            reason:        "writeoff:reverse:" + id,
          });
        } catch (e1) {
          await _releaseClaim();
          throw e1;
        }
      }
      // Restore the cost layer pool when the original write-off attributed
      // COGS. On failure, undo the shelf restore + release the claim so the
      // operator sees a clean refusal rather than a half-applied reversal.
      if (row.cost_impact_minor != null) {
        try {
          await costLayers.recordReversal({
            order_id: "writeoff:" + id,
            line_id:  "1",
            reason:   reason,
          });
        } catch (e) {
          if (row.location_code != null) {
            try {
              await locations.adjustStock({
                sku:           row.sku,
                location_code: row.location_code,
                delta:         -row.quantity,
                reason:        "writeoff:reverse:rollback:" + id,
              });
            } catch (_e2) { /* drop-silent — the costLayers error is the operator's signal */ }
          }
          await _releaseClaim();
          throw e;
        }
      }
      return await _getWriteoffRow(id);
    },
  };
}

module.exports = {
  create:              create,
  WRITEOFF_REASONS:    WRITEOFF_REASONS,
  WRITEOFF_STATUSES:   WRITEOFF_STATUSES,
};
