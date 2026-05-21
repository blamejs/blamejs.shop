"use strict";
/**
 * @module shop.inventoryAlerts
 * @title  Inventory low-stock alerts
 *
 * @intro
 *   When a SKU's available stock (`stock_on_hand - stock_held`) drops
 *   below its configured threshold, the alert primitive writes an
 *   `inventory_alerts` row and fans out the signal. The fan-out has
 *   two channels:
 *
 *     1. `logger.warn` — always called. The default logger is
 *        `b.log` with a bound `component: "inventory-alerts"` field
 *        so the line lands in the same observability pipeline as the
 *        rest of the application.
 *     2. `webhooks.send("inventory.low_stock", payload)` — called
 *        when an outbound-webhooks dep is wired into the factory.
 *        Optional: when absent the log line is the only signal.
 *
 *   The primitive is paired with `catalog.inventory.setThreshold(sku,
 *   threshold)` (which writes the per-SKU threshold) and
 *   `catalog.inventory.checkLowStock(sku)` (a pure SELECT that
 *   returns `{ alert, available, threshold }`). Callers that have
 *   just mutated stock (the InventoryLock DO's decrement path, the
 *   `inventory.release` primitive, the admin restock route) invoke
 *   `check(sku)` to decide whether to fire.
 *
 *   The fire path is idempotent at the row level — every call writes
 *   a fresh `inventory_alerts` row keyed by a v7 UUID. Operators that
 *   want dedupe-by-day or rate-limit-per-SKU compose that on top via
 *   the outbound-webhooks dispatcher's own retry / dedupe policies.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function _validateSku(s) {
  if (typeof s !== "string" || !SKU_RE.test(s)) {
    throw new TypeError("inventory-alerts: sku must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (alnum + . _ -, ≤ 128 chars)");
  }
}

function _validateNonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-alerts: " + label + " must be a non-negative integer");
  }
}

function _validateLimit(n) {
  if (!Number.isInteger(n) || n <= 0 || n > 1000) {
    throw new TypeError("inventory-alerts: limit must be an integer in 1..1000");
  }
}

function _validateOffset(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("inventory-alerts: offset must be a non-negative integer");
  }
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  // Optional outbound-webhooks dep. When wired, `fire` calls
  // `webhooks.send(event, payload)` after the alert row is written.
  // The webhooks primitive lands in a sibling stacked release; until
  // it merges, this dep stays optional and the log line is the only
  // signal.
  var webhooks = opts.webhooks || null;
  if (webhooks && typeof webhooks.send !== "function") {
    throw new TypeError("inventory-alerts.create: opts.webhooks must expose a send(event, payload) method");
  }
  // Logger — defaults to `b.log` bound with a component tag so the
  // emitted lines are filterable in the aggregator. Tests inject a
  // collector logger; production wires the framework logger at boot.
  var logger;
  if (opts.logger) {
    if (typeof opts.logger.warn !== "function") {
      throw new TypeError("inventory-alerts.create: opts.logger must expose a warn(msg, extras) method");
    }
    logger = opts.logger;
  } else {
    var bLog = _b().log;
    logger = bLog.bind
      ? bLog.bind({ component: "inventory-alerts" })
      : bLog;
  }

  function _now() { return Date.now(); }

  return {
    // Pure pass-through to `catalog.inventory.checkLowStock(sku)` —
    // but the alert primitive exposes its own `check` so a caller
    // that only has the alert dep wired (e.g. the DO callback path
    // that POSTs to the container) doesn't have to also wire catalog.
    check: async function (sku) {
      _validateSku(sku);
      var r = await query(
        "SELECT stock_on_hand, stock_held, low_stock_threshold FROM inventory WHERE sku = ?1",
        [sku],
      );
      var row = r.rows[0];
      if (!row) return { alert: false, available: null, threshold: null };
      if (row.low_stock_threshold == null) {
        var availableNoThreshold = row.stock_on_hand - row.stock_held;
        return { alert: false, available: availableNoThreshold, threshold: null };
      }
      var available = row.stock_on_hand - row.stock_held;
      return {
        alert:     available < row.low_stock_threshold,
        available: available,
        threshold: row.low_stock_threshold,
      };
    },

    // Fire an alert: write the row, call the optional webhooks
    // dispatcher, and emit a log line. Returns the new alert row.
    fire: async function (sku, available, threshold) {
      _validateSku(sku);
      _validateNonNegInt(available, "available");
      _validateNonNegInt(threshold, "threshold");
      var id = _b().uuid.v7();
      var ts = _now();
      await query(
        "INSERT INTO inventory_alerts (id, sku, available_at_alert, threshold, fired_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5)",
        [id, sku, available, threshold, ts],
      );
      var payload = { sku: sku, available: available, threshold: threshold, fired_at: ts };
      // Webhooks fan-out — drop-silent at this boundary because the
      // alert row is already persisted; a downstream delivery
      // failure must not roll back the alert record.
      if (webhooks) {
        try { await webhooks.send("inventory.low_stock", payload); }
        catch (_e) { /* drop-silent — outbound delivery failure already routed via webhooks' own retry queue */ }
      }
      // Log line — always emitted, regardless of webhooks state.
      try {
        logger.warn("inventory.low_stock", {
          sku:       sku,
          available: available,
          threshold: threshold,
        });
      } catch (_e) { /* drop-silent — observability sink must never fail the alert path */ }
      return { id: id, sku: sku, available_at_alert: available, threshold: threshold, fired_at: ts };
    },

    // check + fire in one call. The common caller path: a stock
    // mutation just happened, ask "should we alert?" and fire if so.
    // Returns the alert row when fired, `null` when below-threshold
    // was not the case, and `null` when the SKU has no threshold
    // configured.
    checkAndFire: async function (sku) {
      var result = await this.check(sku);
      if (!result.alert) return null;
      return await this.fire(sku, result.available, result.threshold);
    },

    // Recent alerts, ordered by fired_at DESC. `limit` defaults to
    // 100; `offset` supports admin-UI pagination. `sku` optionally
    // narrows to a single SKU's history.
    list: async function (listOpts) {
      listOpts = listOpts || {};
      var limit  = listOpts.limit == null ? 100 : listOpts.limit;
      var offset = listOpts.offset == null ? 0   : listOpts.offset;
      _validateLimit(limit);
      _validateOffset(offset);
      var sku = listOpts.sku;
      if (sku !== undefined && sku !== null) {
        _validateSku(sku);
        var r1 = await query(
          "SELECT id, sku, available_at_alert, threshold, fired_at FROM inventory_alerts " +
          "WHERE sku = ?1 ORDER BY fired_at DESC LIMIT ?2 OFFSET ?3",
          [sku, limit, offset],
        );
        return r1.rows;
      }
      var r2 = await query(
        "SELECT id, sku, available_at_alert, threshold, fired_at FROM inventory_alerts " +
        "ORDER BY fired_at DESC LIMIT ?1 OFFSET ?2",
        [limit, offset],
      );
      return r2.rows;
    },
  };
}

module.exports = {
  create: create,
};
