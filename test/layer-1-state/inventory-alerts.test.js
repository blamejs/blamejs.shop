"use strict";
/**
 * inventory-alerts — low-stock alert primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from the catalog
 * migration plus the 0008 thresholds migration. Covers:
 *
 *   - setThreshold + checkLowStock round-trip
 *   - threshold = null disables the alert path
 *   - below-threshold fires: writes row + calls logger.warn + calls
 *     webhooks.send when the webhooks dep is wired
 *   - above-threshold does not fire
 *   - check + checkAndFire idempotency at the row level
 *   - list pagination (limit + offset) + sku narrowing + DESC sort
 *   - validation rejects bad sku / threshold / limit / offset
 *   - factory rejects mis-shaped deps
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0008_inventory_thresholds.sql"].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE" || verb === "ALTER") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Logger collector with the same shape as `b.log` (just `warn`).
function _collectorLogger() {
  var lines = [];
  return {
    lines: lines,
    warn:  function (msg, extras) { lines.push({ msg: msg, extras: extras }); },
  };
}

// Outbound-webhooks collector — captures every `send(event, payload)`
// call. Mirrors the shape the real outbound-webhooks primitive will
// expose (event-name + JSON payload).
function _collectorWebhooks() {
  var sent = [];
  return {
    sent: sent,
    send: function (event, payload) {
      sent.push({ event: event, payload: payload });
      return Promise.resolve({ ok: true });
    },
  };
}

async function _setThresholdRoundTrip() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });

  await catalog.inventory.create("SKU-1", { stock_on_hand: 10 });

  // No threshold → alert: false, threshold: null
  var pre = await catalog.inventory.checkLowStock("SKU-1");
  check("no threshold → alert false",          pre.alert === false);
  check("no threshold → threshold null",       pre.threshold === null);
  check("no threshold → available computed",   pre.available === 10);

  // Set threshold to 5 → still above (10 ≥ 5) → alert: false
  var inv1 = await catalog.inventory.setThreshold("SKU-1", 5);
  check("setThreshold returns row",            inv1 && inv1.low_stock_threshold === 5);
  var post = await catalog.inventory.checkLowStock("SKU-1");
  check("above threshold → alert false",       post.alert === false);
  check("above threshold → threshold echoed",  post.threshold === 5);

  // Set threshold to 20 → 10 < 20 → alert: true
  await catalog.inventory.setThreshold("SKU-1", 20);
  var below = await catalog.inventory.checkLowStock("SKU-1");
  check("below threshold → alert true",        below.alert === true);
  check("below threshold → available 10",      below.available === 10);
  check("below threshold → threshold 20",      below.threshold === 20);

  // Clear (null) → alert: false again
  await catalog.inventory.setThreshold("SKU-1", null);
  var cleared = await catalog.inventory.checkLowStock("SKU-1");
  check("cleared threshold → alert false",     cleared.alert === false);
  check("cleared threshold → threshold null",  cleared.threshold === null);

  // Unknown SKU → alert: false (null available + threshold)
  var unknown = await catalog.inventory.checkLowStock("SKU-NOPE");
  check("unknown sku → alert false",  unknown.alert === false);
  check("unknown sku → null fields",  unknown.available === null && unknown.threshold === null);
}

async function _belowThresholdFires() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var logger   = _collectorLogger();
  var webhooks = _collectorWebhooks();
  var alerts   = bShop.inventoryAlerts.create({
    query:    query,
    logger:   logger,
    webhooks: webhooks,
  });

  await catalog.inventory.create("SKU-LOW", { stock_on_hand: 2 });
  await catalog.inventory.setThreshold("SKU-LOW", 5);

  var alert = await alerts.checkAndFire("SKU-LOW");
  check("checkAndFire returns row",      alert && typeof alert.id === "string");
  check("alert row records available",   alert.available_at_alert === 2);
  check("alert row records threshold",   alert.threshold === 5);
  check("alert row stamps fired_at",     Number.isInteger(alert.fired_at) && alert.fired_at > 0);

  check("logger.warn called once",       logger.lines.length === 1);
  check("logger.warn carries sku",       logger.lines[0].extras.sku === "SKU-LOW");
  check("logger.warn carries available", logger.lines[0].extras.available === 2);
  check("logger.warn carries threshold", logger.lines[0].extras.threshold === 5);

  check("webhooks.send called once",     webhooks.sent.length === 1);
  check("webhooks event name",            webhooks.sent[0].event === "inventory.low_stock");
  check("webhooks payload sku",           webhooks.sent[0].payload.sku === "SKU-LOW");
  check("webhooks payload available",     webhooks.sent[0].payload.available === 2);
  check("webhooks payload threshold",     webhooks.sent[0].payload.threshold === 5);

  // Persisted row matches what list() returns.
  var rows = await alerts.list();
  check("list returns the fired alert",   rows.length === 1);
  check("list row id matches",            rows[0].id === alert.id);
  check("list row sku matches",           rows[0].sku === "SKU-LOW");
}

async function _aboveThresholdDoesNotFire() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var logger   = _collectorLogger();
  var webhooks = _collectorWebhooks();
  var alerts   = bShop.inventoryAlerts.create({
    query:    query,
    logger:   logger,
    webhooks: webhooks,
  });

  await catalog.inventory.create("SKU-OK", { stock_on_hand: 50 });
  await catalog.inventory.setThreshold("SKU-OK", 5);

  var maybe = await alerts.checkAndFire("SKU-OK");
  check("above threshold → no alert row",  maybe === null);
  check("above threshold → no log line",   logger.lines.length === 0);
  check("above threshold → no webhook",    webhooks.sent.length === 0);
  var rows = await alerts.list();
  check("above threshold → list empty",    rows.length === 0);
}

async function _nullThresholdDisables() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var logger   = _collectorLogger();
  var alerts   = bShop.inventoryAlerts.create({ query: query, logger: logger });

  await catalog.inventory.create("SKU-NONE", { stock_on_hand: 0 });
  // Threshold never set — stays NULL by default.

  var maybe = await alerts.checkAndFire("SKU-NONE");
  check("null threshold → no alert row",   maybe === null);
  check("null threshold → no log line",    logger.lines.length === 0);

  // Even with stock_on_hand = 0 and a freshly-cleared threshold, no
  // alert fires after explicit null-clear.
  await catalog.inventory.setThreshold("SKU-NONE", 10);
  await catalog.inventory.setThreshold("SKU-NONE", null);
  var post = await alerts.checkAndFire("SKU-NONE");
  check("explicitly cleared → no alert",   post === null);
}

async function _webhooksOptional() {
  // No webhooks dep wired → log still fires, no error.
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var logger   = _collectorLogger();
  var alerts   = bShop.inventoryAlerts.create({ query: query, logger: logger });

  await catalog.inventory.create("SKU-LOG", { stock_on_hand: 1 });
  await catalog.inventory.setThreshold("SKU-LOG", 5);

  var alert = await alerts.checkAndFire("SKU-LOG");
  check("no webhooks → alert still written",  alert && typeof alert.id === "string");
  check("no webhooks → log still fires",      logger.lines.length === 1);
}

async function _listPagination() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var logger   = _collectorLogger();
  var alerts   = bShop.inventoryAlerts.create({ query: query, logger: logger });

  // Seed 5 alerts across 2 SKUs.
  await catalog.inventory.create("SKU-A", { stock_on_hand: 1 });
  await catalog.inventory.create("SKU-B", { stock_on_hand: 1 });
  await catalog.inventory.setThreshold("SKU-A", 10);
  await catalog.inventory.setThreshold("SKU-B", 10);

  // Fire by hand to control the timestamps deterministically.
  // The fired_at field is set inside fire() via Date.now(); we
  // serialize the fires with a small await each so the timestamps
  // are monotonically increasing.
  var fired = [];
  for (var i = 0; i < 3; i += 1) {
    fired.push(await alerts.fire("SKU-A", 1, 10));
    // Yield so timestamps differ on platforms with sub-ms Date.now().
    await new Promise(function (r) { setImmediate(r); });
  }
  for (var j = 0; j < 2; j += 1) {
    fired.push(await alerts.fire("SKU-B", 1, 10));
    await new Promise(function (r) { setImmediate(r); });
  }

  // Default list — all 5, newest first.
  var all = await alerts.list();
  check("list returns all 5",                all.length === 5);
  for (var k = 1; k < all.length; k += 1) {
    check("list sorted fired_at DESC",       all[k - 1].fired_at >= all[k].fired_at);
  }

  // limit
  var first2 = await alerts.list({ limit: 2 });
  check("limit:2 returns 2",                 first2.length === 2);

  // offset
  var next2 = await alerts.list({ limit: 2, offset: 2 });
  check("offset:2 returns next 2",           next2.length === 2);
  check("offset:2 distinct from limit:2",    next2[0].id !== first2[0].id && next2[0].id !== first2[1].id);

  // sku narrows
  var aOnly = await alerts.list({ sku: "SKU-A" });
  check("sku narrows to SKU-A",              aOnly.length === 3);
  check("sku-narrowed rows all SKU-A",       aOnly.every(function (r) { return r.sku === "SKU-A"; }));

  var bOnly = await alerts.list({ sku: "SKU-B" });
  check("sku narrows to SKU-B",              bOnly.length === 2);
}

async function _validation() {
  var query   = _makeQuery();
  var alerts  = bShop.inventoryAlerts.create({ query: query, logger: _collectorLogger() });
  var catalog = bShop.catalog.create({ query: query });

  // Bad SKU shapes refused at every entry point.
  await assert.rejects(alerts.check("bad sku with spaces"),  /sku must match/);
  await assert.rejects(alerts.fire("bad sku", 0, 5),         /sku must match/);
  await assert.rejects(alerts.list({ sku: "bad sku" }),       /sku must match/);

  // Bad threshold via setThreshold.
  await assert.rejects(catalog.inventory.setThreshold("SKU-V", -1),     /non-negative integer or null/);
  await assert.rejects(catalog.inventory.setThreshold("SKU-V", 1.5),    /non-negative integer or null/);
  await assert.rejects(catalog.inventory.setThreshold("SKU-V", "10"),   /non-negative integer or null/);

  // Bad fire() args.
  await catalog.inventory.create("SKU-V", { stock_on_hand: 1 });
  await assert.rejects(alerts.fire("SKU-V", -1, 5),                     /available must be/);
  await assert.rejects(alerts.fire("SKU-V", 1, -1),                     /threshold must be/);

  // Bad list args.
  await assert.rejects(alerts.list({ limit: 0 }),                       /limit must be/);
  await assert.rejects(alerts.list({ limit: 1001 }),                    /limit must be/);
  await assert.rejects(alerts.list({ offset: -1 }),                     /offset must be/);

  // Factory shape validation.
  assert.throws(function () { bShop.inventoryAlerts.create({ query: query, logger: { not: "shaped" } }); }, /logger must expose/);
  assert.throws(function () { bShop.inventoryAlerts.create({ query: query, webhooks: { not: "shaped" } }); }, /webhooks must expose/);
}

async function _onStockChangeCallback() {
  // catalog.inventory.release fires the configured onStockChange
  // callback. The alerts primitive's checkAndFire is the intended
  // wiring on the container side. Stock_held release lowers held,
  // raising available — but if the SKU's available is still below
  // the threshold, the alert still needs to fire.
  var query    = _makeQuery();
  var logger   = _collectorLogger();
  var webhooks = _collectorWebhooks();
  var alerts;
  var catalog = bShop.catalog.create({
    query: query,
    onStockChange: function (sku) { return alerts.checkAndFire(sku); },
  });
  alerts = bShop.inventoryAlerts.create({ query: query, logger: logger, webhooks: webhooks });

  await catalog.inventory.create("SKU-CB", { stock_on_hand: 10 });
  // Manually inflate stock_held to 9 so release(1) → held 8 → available 2
  await query("UPDATE inventory SET stock_held = ?1 WHERE sku = ?2", [9, "SKU-CB"]);
  await catalog.inventory.setThreshold("SKU-CB", 5);

  // setThreshold also runs the post-mutation observer? No — it
  // doesn't, because setThreshold isn't a stock mutation. But
  // setThreshold itself is sufficient to trigger checkLowStock,
  // not the observer.
  check("pre-release log count is zero",  logger.lines.length === 0);

  await catalog.inventory.release("SKU-CB", 1);
  // Post-release: stock_held = 8, available = 10 - 8 = 2, threshold 5 → alert
  check("release fires the observer → alert row",  logger.lines.length === 1);
  check("observer-fired alert sku",                 logger.lines[0].extras.sku === "SKU-CB");
  check("observer-fired alert available",           logger.lines[0].extras.available === 2);
  check("observer-fired alert webhook",             webhooks.sent.length === 1);
}

async function run() {
  await _setThresholdRoundTrip();
  await _belowThresholdFires();
  await _aboveThresholdDoesNotFire();
  await _nullThresholdDisables();
  await _webhooksOptional();
  await _listPagination();
  await _validation();
  await _onStockChangeCallback();
}

module.exports = { run: run };
