"use strict";
/**
 * @module shop.inventorySnapshots
 * @title  Inventory snapshots — point-in-time inventory captures for
 *         audit + reconciliation
 *
 * @intro
 *   The catalog `inventory` table answers "right now"; the per-
 *   location `inventory_stock` table (from inventory-locations)
 *   answers "right now, broken down by warehouse." Neither answers
 *   "what did stock look like at close of business yesterday?" or
 *   "how did the count change between the EOM snapshot and today?"
 *
 *   This primitive captures a point-in-time copy of every (sku,
 *   location_code) -> quantity pair the operator cares about and
 *   pins it under an operator-chosen label. Subsequent snapshots
 *   are diffable: `deltaBetween(from, to)` walks both row sets and
 *   produces a per-key delta record showing additions / removals /
 *   net changes, plus an explicit no-change list when the caller
 *   wants to see what stayed flat.
 *
 *   Verbs:
 *     takeSnapshot({ label, locations?, skus?, reason })
 *       — Captures the current stock counts. With `locations` and a
 *         wired `inventoryLocations` handle, reads from
 *         `inventory_stock` and persists per-(sku, location_code)
 *         rows; otherwise reads from the catalog `inventory` table
 *         and persists with `location_code = NULL` (the "no per-
 *         location detail" sentinel). `skus` narrows the capture to
 *         the listed SKUs only (otherwise every SKU with a row in
 *         the source table is captured). Returns
 *         `{ id, label, taken_at, sku_count, location_count,
 *           total_units, hash_sha3_512 }`.
 *
 *     getSnapshot(snapshot_id)
 *       — Reads the snapshot header + hydrated rows. Returns null on
 *         miss so the caller-handler maps cleanly to HTTP 404.
 *
 *     listSnapshots({ from?, to?, limit?, cursor? })
 *       — Paginated list ordered (taken_at DESC, id DESC). `from` /
 *         `to` are inclusive epoch-ms bounds. Cursor is HMAC-tagged
 *         so an operator can't hand-craft one to skip ahead.
 *
 *     deltaBetween({ from_snapshot_id, to_snapshot_id, sku? })
 *       — Per-(sku, location_code) deltas. Each row is
 *         `{ sku, location_code, from_quantity, to_quantity, delta,
 *           change }` where `change` is one of:
 *         'added'     — present in `to`, not in `from`
 *         'removed'   — present in `from`, not in `to`
 *         'changed'   — present in both with different quantity
 *         'unchanged' — present in both with equal quantity
 *         When the optional `sku` filter is supplied only deltas for
 *         that SKU are returned (across every location_code).
 *
 *     summary(snapshot_id)
 *       — Aggregate counts + the SKUs flagged as outliers. An
 *         outlier is a row whose quantity is either zero (potential
 *         stockout) or above the 95th percentile of the snapshot
 *         (potential overstock). Returns
 *         `{ id, label, taken_at, sku_count, location_count,
 *           total_units, hash_sha3_512, hash_matches, outliers: [
 *           { sku, location_code, quantity, reason } ] }`.
 *         `hash_matches` recomputes the canonical hash from the
 *         stored rows so the caller can verify the snapshot hasn't
 *         been tampered with after the fact.
 *
 *     purgeOlderThan(days)
 *       — Deletes every snapshot whose `taken_at < now - days*86400000`.
 *         FK CASCADE drops the row table contents with the header.
 *         Returns the count of snapshots removed.
 *
 *   Composition:
 *     - b.uuid.v7        — snapshot + row PKs (sortable; B-tree locality)
 *     - b.guardUuid      — strict UUID validation on snapshot_id reads
 *     - b.pagination     — HMAC-tagged cursor for listSnapshots
 *     - b.crypto.sha3Hash — SHA3-512 canonical-row hash for tamper-evidence
 *     - catalog          — single-bucket inventory read source (required)
 *     - inventoryLocations (optional) — multi-location read source
 *
 *   Three-tier input validation discipline (use it, don't write the
 *   labels): every public verb here is a defensive request-shape
 *   reader OR a config-time entry point. Both throw on bad input.
 *   No drop-silent hot-path sinks — every snapshot creation is a
 *   deliberate operator action and a silent drop on bad input would
 *   ship a useless empty snapshot.
 */

var b = require("./vendor/blamejs");
var C = b.constants;

// ---- constants ----------------------------------------------------------

var SKU_RE              = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
var LOCATION_CODE_RE    = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
var LABEL_RE            = /^[\S\s]{0,128}$/;
var MAX_LABEL_LEN       = 128;
var MAX_REASON_LEN      = 4000;
var MAX_LIST_LIMIT      = 200;
var MAX_PURGE_DAYS      = 365 * 100;   // 100 years — practical sanity cap
var MAX_SKUS_PER_TAKE   = 50000;        // refuse pathological inputs
var MAX_LOCATIONS_PER_TAKE = 1000;
var OUTLIER_PERCENTILE  = 0.95;         // 95th percentile = "overstock"
var MAX_OUTLIERS        = 50;

var SNAPSHOT_ORDER_KEY  = ["taken_at:desc", "id:desc"];

// ---- validators ---------------------------------------------------------

function _id(s, label) {
  try {
    return b.guardUuid.sanitize(s, { profile: "strict" });
  } catch (e) {
    throw new TypeError("inventory-snapshots: " + label + " — " + (e && e.message || "invalid UUID"));
  }
}
function _label(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_LABEL_LEN || !LABEL_RE.test(s)) {
    throw new TypeError("inventory-snapshots: label must be a string ≤ " + MAX_LABEL_LEN + " chars");
  }
  return s;
}
function _reason(s) {
  if (s == null) return "";
  if (typeof s !== "string" || s.length > MAX_REASON_LEN) {
    throw new TypeError("inventory-snapshots: reason must be a string ≤ " + MAX_REASON_LEN + " chars");
  }
  return s;
}
function _sku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-snapshots: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..128 chars)");
  }
}
function _locationCode(s, label) {
  if (typeof s !== "string" || !LOCATION_CODE_RE.test(s)) {
    throw new TypeError("inventory-snapshots: " + (label || "location_code") +
      " must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, 1..64 chars)");
  }
}
function _limit(n, label) {
  if (!Number.isInteger(n) || n <= 0 || n > MAX_LIST_LIMIT) {
    throw new TypeError("inventory-snapshots: " + label + " must be an integer in 1..." + MAX_LIST_LIMIT);
  }
}
function _epochMs(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-snapshots: " + label + " must be a non-negative integer (epoch ms)");
  }
}
function _days(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PURGE_DAYS) {
    throw new TypeError("inventory-snapshots: days must be a non-negative integer ≤ " + MAX_PURGE_DAYS);
  }
}

function _now() { return Date.now(); }

// Canonical row hash: SHA3-512 over the newline-joined
// "<sku>|<location_or_->|<qty>" lines sorted by (sku, location_code).
// The deterministic ordering ensures the hash is reproducible
// regardless of which order the source rows arrived in. A NULL
// location_code is rendered as the literal "-" so the encoding is
// unambiguous between "row with location_code = NULL" and a row
// whose location_code is the string "null".
function _hashRows(rows) {
  var copy = rows.slice().sort(function (a, b) {
    if (a.sku < b.sku) return -1;
    if (a.sku > b.sku) return 1;
    var al = a.location_code == null ? "" : a.location_code;
    var bl = b.location_code == null ? "" : b.location_code;
    if (al < bl) return -1;
    if (al > bl) return 1;
    return 0;
  });
  var parts = [];
  for (var i = 0; i < copy.length; i += 1) {
    var loc = copy[i].location_code == null ? "-" : copy[i].location_code;
    parts.push(copy[i].sku + "|" + loc + "|" + copy[i].quantity);
  }
  return b.crypto.sha3Hash(parts.join("\n"));
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  if (!opts.catalog || !opts.catalog.inventory || typeof opts.catalog.inventory.get !== "function") {
    throw new TypeError("inventory-snapshots.create: opts.catalog with inventory.get(sku) required");
  }
  // The catalog handle is shape-checked at factory time so the boot
  // wiring fails loud when a caller forgets to thread it through. The
  // snapshot reads inventory data through the injected `query` handle
  // directly (catalog doesn't expose a "list every SKU" verb), so the
  // reference doesn't survive past the shape gate.
  // inventoryLocations is optional; when wired, takeSnapshot can
  // capture per-location detail by reading inventory_stock rows.
  // Factory holds the handle (rather than just reading the table)
  // so the boot wiring stays explicit — a snapshot taken against a
  // location list must have the locations primitive present to
  // validate the codes.
  var invLocations = opts.inventoryLocations || null;
  if (invLocations !== null) {
    if (typeof invLocations !== "object" || typeof invLocations.getLocation !== "function") {
      throw new TypeError("inventory-snapshots.create: opts.inventoryLocations, when supplied, must expose getLocation(code)");
    }
  }
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  // Pagination cursors are HMAC-tagged so an operator can't hand-
  // craft one to skip ahead or replay across deployments. The
  // secret must be stable for the deployment; rotating it
  // invalidates outstanding cursors (acceptable). Tests inject a
  // fixed dev string; production must supply an explicit secret.
  if (typeof opts.cursorSecret !== "string" || !opts.cursorSecret.length) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("inventory-snapshots.create: opts.cursorSecret is required in production");
    }
    opts.cursorSecret = "inventory-snapshots-cursor-secret-dev-only";
  }
  var cursorSecret = opts.cursorSecret;

  // Read source rows for a snapshot. When `locations` is supplied,
  // walks `inventory_stock` (multi-location). Otherwise walks the
  // catalog `inventory` table (single-bucket; location_code = null).
  // `skus` narrows both paths. Returns the normalized rows array
  // ready for insertion.
  async function _readSource(locations, skus) {
    var rows = [];
    if (locations) {
      // Multi-location capture. Validate every location code resolves
      // to a real location row up front (refuse the snapshot rather
      // than silently capture zero rows for a typo'd code).
      for (var li = 0; li < locations.length; li += 1) {
        var loc = await invLocations.getLocation(locations[li]);
        if (!loc) {
          throw new TypeError("inventory-snapshots.takeSnapshot: location " +
            JSON.stringify(locations[li]) + " not found");
        }
      }
      // Build the IN clause for locations + optional SKUs. Parameter
      // placeholders are ?1..?N so the operator-supplied codes can't
      // be SQL-injected.
      var params = [];
      var locPlaceholders = locations.map(function (c, i) { params.push(c); return "?" + (i + 1); }).join(",");
      var sql = "SELECT sku, location_code, quantity FROM inventory_stock WHERE location_code IN (" +
        locPlaceholders + ")";
      if (skus && skus.length) {
        var skuPlaceholders = skus.map(function (s, i) {
          params.push(s);
          return "?" + (locations.length + i + 1);
        }).join(",");
        sql += " AND sku IN (" + skuPlaceholders + ")";
      }
      sql += " ORDER BY sku ASC, location_code ASC";
      var r = await query(sql, params);
      for (var i = 0; i < r.rows.length; i += 1) {
        rows.push({
          sku:           r.rows[i].sku,
          location_code: r.rows[i].location_code,
          quantity:      r.rows[i].quantity,
        });
      }
      return rows;
    }
    // Single-bucket capture from the catalog inventory table.
    var sql2;
    var params2 = [];
    if (skus && skus.length) {
      var ph = skus.map(function (s, i) { params2.push(s); return "?" + (i + 1); }).join(",");
      sql2 = "SELECT sku, stock_on_hand AS quantity FROM inventory WHERE sku IN (" + ph + ") ORDER BY sku ASC";
    } else {
      sql2 = "SELECT sku, stock_on_hand AS quantity FROM inventory ORDER BY sku ASC";
    }
    var r2 = await query(sql2, params2);
    for (var j = 0; j < r2.rows.length; j += 1) {
      rows.push({
        sku:           r2.rows[j].sku,
        location_code: null,
        quantity:      r2.rows[j].quantity,
      });
    }
    return rows;
  }

  // Hydrate a snapshot header + its rows. Returns null on miss so
  // the caller-handler maps cleanly to HTTP 404.
  async function _getHydrated(id) {
    var hRow = await query("SELECT * FROM inventory_snapshots WHERE id = ?1", [id]);
    if (!hRow.rows.length) return null;
    var snapshot = hRow.rows[0];
    var rRows = await query(
      "SELECT * FROM inventory_snapshot_rows WHERE snapshot_id = ?1 " +
      "ORDER BY sku ASC, location_code ASC",
      [id],
    );
    snapshot.rows = rRows.rows;
    return snapshot;
  }

  // Count distinct location_codes (NULL counts as zero locations
  // since "single-bucket" snapshots carry no per-location detail).
  function _countLocations(rows) {
    var seen = {};
    var n = 0;
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].location_code == null) continue;
      if (!Object.prototype.hasOwnProperty.call(seen, rows[i].location_code)) {
        seen[rows[i].location_code] = true;
        n += 1;
      }
    }
    return n;
  }

  function _countSkus(rows) {
    var seen = {};
    var n = 0;
    for (var i = 0; i < rows.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(seen, rows[i].sku)) {
        seen[rows[i].sku] = true;
        n += 1;
      }
    }
    return n;
  }

  function _sumUnits(rows) {
    var t = 0;
    for (var i = 0; i < rows.length; i += 1) t += rows[i].quantity;
    return t;
  }

  return {

    // Capture a point-in-time copy of the current stock counts.
    // Persists the header + every row in one logical operation; if
    // any insert fails, the partial header is rolled back via a
    // compensating DELETE so the DB doesn't carry an orphaned
    // header forward.
    takeSnapshot: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-snapshots.takeSnapshot: input object required");
      }
      var label = _label(input.label);
      var reason = _reason(input.reason);

      // Validate the optional locations + skus arrays before
      // touching the source tables. An empty array is a separate
      // case from "undefined" — the operator may want to take a
      // snapshot scoped to zero locations (which produces an empty
      // multi-location snapshot, useful for testing); we still
      // refuse if the values themselves are malformed.
      var locations = input.locations;
      if (locations !== undefined && locations !== null) {
        if (!Array.isArray(locations)) {
          throw new TypeError("inventory-snapshots.takeSnapshot: locations must be an array of location codes");
        }
        if (locations.length > MAX_LOCATIONS_PER_TAKE) {
          throw new TypeError("inventory-snapshots.takeSnapshot: locations must contain ≤ " + MAX_LOCATIONS_PER_TAKE + " entries");
        }
        for (var li = 0; li < locations.length; li += 1) {
          _locationCode(locations[li], "locations[" + li + "]");
        }
        if (locations.length > 0 && !invLocations) {
          throw new TypeError("inventory-snapshots.takeSnapshot: locations supplied but inventoryLocations dep not wired into the factory");
        }
      } else {
        locations = null;
      }

      var skus = input.skus;
      if (skus !== undefined && skus !== null) {
        if (!Array.isArray(skus)) {
          throw new TypeError("inventory-snapshots.takeSnapshot: skus must be an array of SKU strings");
        }
        if (skus.length > MAX_SKUS_PER_TAKE) {
          throw new TypeError("inventory-snapshots.takeSnapshot: skus must contain ≤ " + MAX_SKUS_PER_TAKE + " entries");
        }
        for (var si = 0; si < skus.length; si += 1) {
          _sku(skus[si]);
        }
      } else {
        skus = null;
      }

      // Read the source rows BEFORE inserting the header so a bad
      // SKU / location reference fails up front instead of leaving
      // an empty header row behind.
      var sourceRows = await _readSource(locations, skus);

      var id = b.uuid.v7();
      var ts = _now();
      var takenAt = input.taken_at == null ? ts : input.taken_at;
      _epochMs(takenAt, "taken_at");

      var skuCount      = _countSkus(sourceRows);
      var locationCount = _countLocations(sourceRows);
      var totalUnits    = _sumUnits(sourceRows);
      var hash          = _hashRows(sourceRows);

      try {
        await query(
          "INSERT INTO inventory_snapshots (id, label, taken_at, reason, sku_count, " +
          "location_count, total_units, hash_sha3_512, created_at) " +
          "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
          [id, label, takenAt, reason, skuCount, locationCount, totalUnits, hash, ts],
        );
        for (var i = 0; i < sourceRows.length; i += 1) {
          var r = sourceRows[i];
          await query(
            "INSERT INTO inventory_snapshot_rows (id, snapshot_id, sku, location_code, quantity, captured_at) " +
            "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            [b.uuid.v7(), id, r.sku, r.location_code, r.quantity, ts],
          );
        }
      } catch (e) {
        // Best-effort rollback of the header + any rows that landed
        // before the failure (ON DELETE CASCADE on the FK clears the
        // rows). D1 doesn't expose a transaction handle to this
        // primitive, so the rollback is a compensating DELETE.
        try { await query("DELETE FROM inventory_snapshots WHERE id = ?1", [id]); }
        catch (_e2) { /* drop-silent — the original error is what the caller needs */ }
        throw e;
      }

      return {
        id:             id,
        label:          label,
        taken_at:       takenAt,
        sku_count:      skuCount,
        location_count: locationCount,
        total_units:    totalUnits,
        hash_sha3_512:  hash,
      };
    },

    // Read a snapshot + its hydrated rows. Returns null on miss so
    // the caller-handler maps cleanly to HTTP 404.
    getSnapshot: async function (snapshotId) {
      _id(snapshotId, "snapshot_id");
      return await _getHydrated(snapshotId);
    },

    // Paginated list ordered (taken_at DESC, id DESC). Cursor is
    // HMAC-tagged so an operator can't tamper or replay across
    // orderKey changes. `from` / `to` are inclusive epoch-ms bounds.
    listSnapshots: async function (listOpts) {
      listOpts = listOpts || {};
      if (listOpts.from != null) _epochMs(listOpts.from, "from");
      if (listOpts.to   != null) _epochMs(listOpts.to,   "to");
      var limit = listOpts.limit == null ? 50 : listOpts.limit;
      _limit(limit, "limit");
      var cursorVals = null;
      if (listOpts.cursor != null) {
        if (typeof listOpts.cursor !== "string") {
          throw new TypeError("inventory-snapshots.listSnapshots: cursor must be an opaque string or null");
        }
        try {
          var state = b.pagination.decodeCursor(listOpts.cursor, cursorSecret);
          if (JSON.stringify(state.orderKey) !== JSON.stringify(SNAPSHOT_ORDER_KEY)) {
            throw new TypeError("inventory-snapshots.listSnapshots: cursor orderKey mismatch");
          }
          cursorVals = state.vals;
        } catch (e) {
          if (e instanceof TypeError) throw e;
          throw new TypeError("inventory-snapshots.listSnapshots: cursor — " + (e && e.message || "malformed"));
        }
      }

      // Build the WHERE clause incrementally so each optional filter
      // (from / to / cursor) appends an indexed predicate. The
      // (taken_at DESC) index covers the ordering + the range
      // predicates without a sort step.
      var clauses = [];
      var params = [];
      var idx = 1;
      if (listOpts.from != null) {
        clauses.push("taken_at >= ?" + idx); params.push(listOpts.from); idx += 1;
      }
      if (listOpts.to != null) {
        clauses.push("taken_at <= ?" + idx); params.push(listOpts.to); idx += 1;
      }
      if (cursorVals) {
        clauses.push("(taken_at < ?" + idx + " OR (taken_at = ?" + idx + " AND id < ?" + (idx + 1) + "))");
        params.push(cursorVals[0]); idx += 1;
        params.push(cursorVals[1]); idx += 1;
      }
      var sql = "SELECT * FROM inventory_snapshots";
      if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
      sql += " ORDER BY taken_at DESC, id DESC LIMIT ?" + idx;
      params.push(limit);

      var rows = (await query(sql, params)).rows;
      var last = rows[rows.length - 1];
      var next = null;
      if (last && rows.length === limit) {
        next = b.pagination.encodeCursor({
          orderKey: SNAPSHOT_ORDER_KEY,
          vals:     [last.taken_at, last.id],
          forward:  true,
        }, cursorSecret);
      }
      return { rows: rows, next_cursor: next };
    },

    // Compare two snapshots row-by-row. Walks both row sets, keyed
    // by (sku, location_code), and emits one record per key with
    // the from-quantity, to-quantity, signed delta, and a `change`
    // classification ('added', 'removed', 'changed', 'unchanged').
    // The optional `sku` filter limits the result to a single SKU
    // (across every location_code it appears in).
    deltaBetween: async function (input) {
      if (!input || typeof input !== "object") {
        throw new TypeError("inventory-snapshots.deltaBetween: input object required");
      }
      _id(input.from_snapshot_id, "from_snapshot_id");
      _id(input.to_snapshot_id,   "to_snapshot_id");
      var skuFilter = null;
      if (input.sku != null) {
        _sku(input.sku);
        skuFilter = input.sku;
      }

      var fromSnap = await _getHydrated(input.from_snapshot_id);
      if (!fromSnap) {
        throw new TypeError("inventory-snapshots.deltaBetween: from_snapshot_id " +
          input.from_snapshot_id + " not found");
      }
      var toSnap = await _getHydrated(input.to_snapshot_id);
      if (!toSnap) {
        throw new TypeError("inventory-snapshots.deltaBetween: to_snapshot_id " +
          input.to_snapshot_id + " not found");
      }

      // Index each snapshot by its (sku, location_code) key. The
      // sentinel "\u0000" separator can't appear in a valid SKU or
      // location_code (both validate against alphanumeric +
      // ._- only) so the key is unambiguous.
      function _key(sku, loc) { return sku + "\u0000" + (loc == null ? "" : loc); }
      var fromMap = {};
      var toMap = {};
      var keys = {};
      var i;
      for (i = 0; i < fromSnap.rows.length; i += 1) {
        if (skuFilter && fromSnap.rows[i].sku !== skuFilter) continue;
        var k = _key(fromSnap.rows[i].sku, fromSnap.rows[i].location_code);
        fromMap[k] = fromSnap.rows[i];
        keys[k] = true;
      }
      for (i = 0; i < toSnap.rows.length; i += 1) {
        if (skuFilter && toSnap.rows[i].sku !== skuFilter) continue;
        var k2 = _key(toSnap.rows[i].sku, toSnap.rows[i].location_code);
        toMap[k2] = toSnap.rows[i];
        keys[k2] = true;
      }

      var keyList = Object.keys(keys);
      keyList.sort();
      var out = [];
      for (i = 0; i < keyList.length; i += 1) {
        var fk = fromMap[keyList[i]];
        var tk = toMap[keyList[i]];
        var sku = fk ? fk.sku : tk.sku;
        var loc = fk ? fk.location_code : tk.location_code;
        var fromQty = fk ? fk.quantity : 0;
        var toQty   = tk ? tk.quantity : 0;
        var change;
        if (!fk)            change = "added";
        else if (!tk)       change = "removed";
        else if (fromQty === toQty) change = "unchanged";
        else                change = "changed";
        out.push({
          sku:           sku,
          location_code: loc,
          from_quantity: fromQty,
          to_quantity:   toQty,
          delta:         toQty - fromQty,
          change:        change,
        });
      }
      return {
        from_snapshot_id: input.from_snapshot_id,
        to_snapshot_id:   input.to_snapshot_id,
        rows:             out,
      };
    },

    // Snapshot summary: aggregate counts + outlier flags + tamper-
    // evidence check via canonical-row hash recompute.
    summary: async function (snapshotId) {
      _id(snapshotId, "snapshot_id");
      var snap = await _getHydrated(snapshotId);
      if (!snap) return null;

      // Tamper-evidence: re-hash the persisted rows + compare to
      // the stored hash. A mismatch means an UPDATE landed against
      // the row table outside this primitive (or the row table was
      // partially restored from a backup) — either way the caller
      // needs to know before trusting the summary.
      var recomputed = _hashRows(snap.rows);
      var hashMatches = recomputed === snap.hash_sha3_512;

      // Outliers: zero-quantity rows (potential stockout) + rows in
      // the top 5% of the snapshot by quantity (potential overstock).
      // Capped at MAX_OUTLIERS to keep the response bounded even on
      // a snapshot with thousands of zero-stock rows.
      var quantities = snap.rows.map(function (r) { return r.quantity; }).sort(function (a, b) { return a - b; });
      var threshold = null;
      if (quantities.length > 0) {
        var idx = Math.floor(quantities.length * OUTLIER_PERCENTILE);
        if (idx >= quantities.length) idx = quantities.length - 1;
        threshold = quantities[idx];
      }
      var outliers = [];
      for (var i = 0; i < snap.rows.length && outliers.length < MAX_OUTLIERS; i += 1) {
        var r = snap.rows[i];
        if (r.quantity === 0) {
          outliers.push({
            sku:           r.sku,
            location_code: r.location_code,
            quantity:      r.quantity,
            reason:        "stockout",
          });
        } else if (threshold !== null && r.quantity >= threshold && quantities.length >= 20) {
          // Only flag overstock when the snapshot is large enough
          // for a percentile to be meaningful (< 20 rows and the
          // 95th percentile collapses to the max — every row gets
          // flagged, which is noise).
          outliers.push({
            sku:           r.sku,
            location_code: r.location_code,
            quantity:      r.quantity,
            reason:        "overstock",
          });
        }
      }

      return {
        id:             snap.id,
        label:          snap.label,
        taken_at:       snap.taken_at,
        sku_count:      snap.sku_count,
        location_count: snap.location_count,
        total_units:    snap.total_units,
        hash_sha3_512:  snap.hash_sha3_512,
        hash_matches:   hashMatches,
        outliers:       outliers,
      };
    },

    // Delete every snapshot older than `days`. FK CASCADE drops the
    // associated row table contents. Returns the count of snapshots
    // removed. `days = 0` deletes everything — operators that want
    // to wipe the snapshot history wholesale call with 0.
    purgeOlderThan: async function (days) {
      _days(days);
      var cutoff = _now() - C.TIME.days(days);
      // Read the ids first so the return shape can carry both the
      // count and the ids that were removed (operators occasionally
      // want to log "purged snapshots: a, b, c" for a compliance
      // trail). Cap the listed ids at MAX_LIST_LIMIT to keep the
      // response bounded; the count reflects the full delete.
      var listed = await query(
        "SELECT id FROM inventory_snapshots WHERE taken_at < ?1 ORDER BY taken_at ASC LIMIT ?2",
        [cutoff, MAX_LIST_LIMIT],
      );
      var ids = listed.rows.map(function (r) { return r.id; });
      var del = await query(
        "DELETE FROM inventory_snapshots WHERE taken_at < ?1",
        [cutoff],
      );
      return {
        removed:      Number(del.rowCount || 0),
        removed_ids:  ids,
        cutoff:       cutoff,
      };
    },
  };
}

module.exports = {
  create:               create,
  SNAPSHOT_ORDER_KEY:   SNAPSHOT_ORDER_KEY,
  OUTLIER_PERCENTILE:   OUTLIER_PERCENTILE,
};
