"use strict";
/**
 * inventory-snapshots — point-in-time inventory capture primitive.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0001
 * (catalog — provides the `inventory` table the single-bucket
 * snapshot path reads from), 0034 (inventory_locations + stock —
 * provides the per-location source for the multi-location snapshot
 * path), and 0065 (the snapshot tables this primitive owns).
 *
 * Coverage:
 *   - takeSnapshot single-bucket (no locations): reads catalog
 *     inventory, persists header + rows with location_code = NULL,
 *     stamps cached aggregates + canonical SHA3-512 hash
 *   - takeSnapshot multi-location: reads inventory_stock for the
 *     supplied location codes, persists per-(sku, location_code)
 *     rows, validates each location exists, refuses unknown codes
 *   - takeSnapshot sku narrowing: only listed SKUs land in the
 *     snapshot
 *   - takeSnapshot input refusals: bad label / reason / locations /
 *     skus / locations-without-dep
 *   - deltaBetween correctness: addition, removal, change,
 *     unchanged classification + signed delta
 *   - deltaBetween with sku filter narrows to one SKU across locs
 *   - summary aggregation: counts, total_units, hash_matches,
 *     stockout outlier flag
 *   - summary hash tamper detection: post-hoc row UPDATE flips
 *     hash_matches to false
 *   - listSnapshots ordering (taken_at DESC) + pagination via
 *     HMAC-tagged cursor + from/to bounds + bad-cursor refusal
 *   - purgeOlderThan time cutoff: deletes only snapshots older
 *     than the supplied days, returns count + ids
 *   - factory refusals: missing catalog, mis-shaped inventoryLocations,
 *     production-without-cursorSecret
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var invSnap = require("../../lib/inventory-snapshots");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0034_inventory_locations.sql",
  "0065_inventory_snapshots.sql",
].map(function (f) {
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
  var queryFn = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// Seed the catalog `inventory` table with a few SKUs so the single-
// bucket snapshot path has source rows to capture. The columns
// match the 0001_catalog schema (sku PK, stock_on_hand, stock_held,
// updated_at).
async function _seedCatalogInventory(query, seed) {
  var ts = Date.now();
  for (var i = 0; i < seed.length; i += 1) {
    await query(
      "INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
      [seed[i].sku, seed[i].qty, ts],
    );
  }
}

// Seed the inventory_locations + inventory_stock tables for the
// multi-location snapshot path. Schema matches 0034_inventory_locations.
async function _seedLocations(query, locations, stock) {
  var ts = Date.now();
  for (var i = 0; i < locations.length; i += 1) {
    await query(
      "INSERT INTO inventory_locations (code, name, type, priority, active, created_at, updated_at) " +
      "VALUES (?1, ?2, 'warehouse', ?3, 1, ?4, ?4)",
      [locations[i].code, locations[i].name || locations[i].code, locations[i].priority || 100, ts],
    );
  }
  for (var j = 0; j < stock.length; j += 1) {
    await query(
      "INSERT INTO inventory_stock (sku, location_code, quantity, updated_at) VALUES (?1, ?2, ?3, ?4)",
      [stock[j].sku, stock[j].location_code, stock[j].quantity, ts],
    );
  }
}

// Stub catalog handle. Only `inventory.get` is exercised by the
// snapshot primitive's factory shape-check; the snapshot path reads
// the inventory table directly via the injected query handle. The
// stub mirrors the real catalog.inventory.get shape so the factory
// shape-check passes.
function _stubCatalog(query) {
  return {
    inventory: {
      get: async function (sku) {
        var r = await query("SELECT * FROM inventory WHERE sku = ?1", [sku]);
        return r.rows[0] || null;
      },
    },
  };
}

// Stub inventoryLocations handle. Only `getLocation(code)` is
// exercised by takeSnapshot when the locations array is supplied.
function _stubLocations(query) {
  return {
    getLocation: async function (code) {
      var r = await query("SELECT * FROM inventory_locations WHERE code = ?1", [code]);
      return r.rows[0] ? { code: r.rows[0].code, name: r.rows[0].name } : null;
    },
  };
}

async function _takeSnapshotSingleBucket() {
  var q = _makeQuery();
  await _seedCatalogInventory(q, [
    { sku: "WDG-1", qty: 100 },
    { sku: "WDG-2", qty: 50 },
    { sku: "WDG-3", qty: 0 },
  ]);
  var snap = invSnap.create({ query: q, catalog: _stubCatalog(q) });

  var s = await snap.takeSnapshot({ label: "EOM-2026-05", reason: "month-end close" });
  check("takeSnapshot returns v7 uuid",      typeof s.id === "string" && s.id.length === 36);
  check("takeSnapshot persists label",        s.label === "EOM-2026-05");
  check("takeSnapshot sets sku_count",        s.sku_count === 3);
  check("takeSnapshot sets location_count=0", s.location_count === 0);
  check("takeSnapshot sums total_units",      s.total_units === 150);
  check("takeSnapshot writes sha3-512 hash",  typeof s.hash_sha3_512 === "string" && s.hash_sha3_512.length === 128);

  var full = await snap.getSnapshot(s.id);
  check("getSnapshot hydrates rows",          full.rows.length === 3);
  check("getSnapshot location_code is NULL",  full.rows.every(function (r) { return r.location_code == null; }));
  var bySku = {};
  full.rows.forEach(function (r) { bySku[r.sku] = r; });
  check("getSnapshot WDG-1 qty",              bySku["WDG-1"].quantity === 100);
  check("getSnapshot WDG-2 qty",              bySku["WDG-2"].quantity === 50);
  check("getSnapshot WDG-3 qty (zero)",       bySku["WDG-3"].quantity === 0);

  // Unknown snapshot id (well-formed UUID) returns null.
  var missing = await snap.getSnapshot(bShop.framework.uuid.v7());
  check("getSnapshot miss returns null",      missing === null);
}

async function _takeSnapshotMultiLocation() {
  var q = _makeQuery();
  await _seedLocations(q,
    [{ code: "WH-EAST" }, { code: "WH-WEST" }, { code: "STORE-NYC" }],
    [
      { sku: "WDG-1", location_code: "WH-EAST",   quantity: 60 },
      { sku: "WDG-1", location_code: "WH-WEST",   quantity: 40 },
      { sku: "WDG-2", location_code: "WH-EAST",   quantity: 20 },
      { sku: "WDG-2", location_code: "STORE-NYC", quantity: 5  },
    ],
  );
  var snap = invSnap.create({
    query:              q,
    catalog:            _stubCatalog(q),
    inventoryLocations: _stubLocations(q),
  });

  var s = await snap.takeSnapshot({
    label:     "multi-loc-baseline",
    locations: ["WH-EAST", "WH-WEST", "STORE-NYC"],
    reason:    "pre-migration baseline",
  });
  check("multi-loc sku_count",        s.sku_count === 2);
  check("multi-loc location_count",   s.location_count === 3);
  check("multi-loc total_units",      s.total_units === 60 + 40 + 20 + 5);

  var full = await snap.getSnapshot(s.id);
  check("multi-loc row count",        full.rows.length === 4);
  // Every row carries a real location_code.
  check("multi-loc no NULL locs",     full.rows.every(function (r) { return r.location_code != null; }));

  // Sku-narrowed snapshot: only WDG-1 lands.
  var s2 = await snap.takeSnapshot({
    label:     "wdg-1-only",
    locations: ["WH-EAST", "WH-WEST", "STORE-NYC"],
    skus:      ["WDG-1"],
  });
  var full2 = await snap.getSnapshot(s2.id);
  check("sku-narrowed row count",     full2.rows.length === 2);
  check("sku-narrowed sku",           full2.rows.every(function (r) { return r.sku === "WDG-1"; }));

  // Location subset: only WH-EAST captured.
  var s3 = await snap.takeSnapshot({
    label:     "east-only",
    locations: ["WH-EAST"],
  });
  var full3 = await snap.getSnapshot(s3.id);
  check("loc-subset row count",       full3.rows.length === 2);
  check("loc-subset sku_count",       s3.sku_count === 2);
  check("loc-subset location_count",  s3.location_count === 1);

  // Refuses an unknown location code up front (before persisting).
  await assert.rejects(snap.takeSnapshot({
    label:     "bad-loc",
    locations: ["WH-EAST", "NO-SUCH-LOC"],
  }), /not found/);
}

async function _takeSnapshotRefusals() {
  var q = _makeQuery();
  var snap = invSnap.create({ query: q, catalog: _stubCatalog(q) });

  await assert.rejects(snap.takeSnapshot(),                                         /input object required/);
  await assert.rejects(snap.takeSnapshot(null),                                     /input object required/);
  // Oversized label (129 chars)
  var bigLabel = new Array(130).join("x");
  await assert.rejects(snap.takeSnapshot({ label: bigLabel }),                      /label/);
  // Non-string reason
  await assert.rejects(snap.takeSnapshot({ reason: 12345 }),                        /reason/);
  // Locations not an array
  await assert.rejects(snap.takeSnapshot({ locations: "WH-EAST" }),                 /locations must be an array/);
  // Location code malformed
  await assert.rejects(snap.takeSnapshot({ locations: ["bad code with spaces"] }), /location/);
  // Locations supplied but inventoryLocations dep not wired
  await assert.rejects(snap.takeSnapshot({ locations: ["WH-EAST"] }),               /inventoryLocations dep not wired/);
  // Skus not an array
  await assert.rejects(snap.takeSnapshot({ skus: "WDG-1" }),                        /skus must be an array/);
  // Sku malformed
  await assert.rejects(snap.takeSnapshot({ skus: ["bad sku!"] }),                   /sku/);
  // taken_at must be non-negative integer epoch ms
  await assert.rejects(snap.takeSnapshot({ taken_at: -1 }),                          /taken_at/);
  await assert.rejects(snap.takeSnapshot({ taken_at: 1.5 }),                         /taken_at/);
}

async function _deltaBetween() {
  var q = _makeQuery();
  // From: WDG-1=100, WDG-2=50, WDG-3=10
  // To:   WDG-1=80   (changed down 20), WDG-2=50 (unchanged),
  //       WDG-3 removed, WDG-4=25 (added)
  await _seedCatalogInventory(q, [
    { sku: "WDG-1", qty: 100 },
    { sku: "WDG-2", qty: 50 },
    { sku: "WDG-3", qty: 10 },
  ]);
  var snap = invSnap.create({ query: q, catalog: _stubCatalog(q) });
  var fromSnap = await snap.takeSnapshot({ label: "before" });

  // Mutate the catalog inventory to simulate stock changes over time.
  await q("UPDATE inventory SET stock_on_hand = ?1 WHERE sku = ?2", [80, "WDG-1"]);
  await q("DELETE FROM inventory WHERE sku = ?1", ["WDG-3"]);
  await q("INSERT INTO inventory (sku, stock_on_hand, stock_held, updated_at) VALUES (?1, ?2, 0, ?3)",
    ["WDG-4", 25, Date.now()]);

  var toSnap = await snap.takeSnapshot({ label: "after" });

  var d = await snap.deltaBetween({ from_snapshot_id: fromSnap.id, to_snapshot_id: toSnap.id });
  check("delta from_snapshot_id echoed",      d.from_snapshot_id === fromSnap.id);
  check("delta to_snapshot_id echoed",         d.to_snapshot_id === toSnap.id);
  check("delta rows count",                    d.rows.length === 4);

  var byKey = {};
  d.rows.forEach(function (r) { byKey[r.sku] = r; });
  check("delta WDG-1 changed",                 byKey["WDG-1"].change === "changed" &&
                                                byKey["WDG-1"].delta === -20 &&
                                                byKey["WDG-1"].from_quantity === 100 &&
                                                byKey["WDG-1"].to_quantity === 80);
  check("delta WDG-2 unchanged",               byKey["WDG-2"].change === "unchanged" &&
                                                byKey["WDG-2"].delta === 0);
  check("delta WDG-3 removed",                 byKey["WDG-3"].change === "removed" &&
                                                byKey["WDG-3"].delta === -10);
  check("delta WDG-4 added",                   byKey["WDG-4"].change === "added" &&
                                                byKey["WDG-4"].delta === 25);

  // sku filter narrows to one SKU.
  var d2 = await snap.deltaBetween({
    from_snapshot_id: fromSnap.id,
    to_snapshot_id:   toSnap.id,
    sku:              "WDG-1",
  });
  check("delta sku-filter rows count",         d2.rows.length === 1);
  check("delta sku-filter sku",                d2.rows[0].sku === "WDG-1");

  // Refusals — unknown snapshot id
  await assert.rejects(snap.deltaBetween({
    from_snapshot_id: bShop.framework.uuid.v7(),
    to_snapshot_id:   toSnap.id,
  }), /not found/);
  // Malformed UUID
  await assert.rejects(snap.deltaBetween({
    from_snapshot_id: "not-a-uuid",
    to_snapshot_id:   toSnap.id,
  }), /snapshot_id/);
}

async function _summary() {
  var q = _makeQuery();
  await _seedCatalogInventory(q, [
    { sku: "WDG-1", qty: 100 },
    { sku: "WDG-2", qty: 50  },
    { sku: "WDG-OUT", qty: 0 },
  ]);
  var snap = invSnap.create({ query: q, catalog: _stubCatalog(q) });
  var s = await snap.takeSnapshot({ label: "summary-test" });

  var sum = await snap.summary(s.id);
  check("summary id",                   sum.id === s.id);
  check("summary sku_count",            sum.sku_count === 3);
  check("summary total_units",          sum.total_units === 150);
  check("summary hash_matches initial", sum.hash_matches === true);

  // Zero-quantity row appears as a stockout outlier.
  var stockouts = sum.outliers.filter(function (o) { return o.reason === "stockout"; });
  check("summary flags stockout outlier", stockouts.length === 1 && stockouts[0].sku === "WDG-OUT");

  // Tamper detection: hand-edit a snapshot row's quantity outside
  // the primitive. The recomputed hash should no longer match.
  await q("UPDATE inventory_snapshot_rows SET quantity = ?1 WHERE snapshot_id = ?2 AND sku = ?3",
    [999, s.id, "WDG-1"]);
  var sum2 = await snap.summary(s.id);
  check("summary detects tamper",         sum2.hash_matches === false);

  // Missing snapshot returns null.
  var missing = await snap.summary(bShop.framework.uuid.v7());
  check("summary miss returns null",      missing === null);
}

async function _listSnapshotsAndPagination() {
  var q = _makeQuery();
  await _seedCatalogInventory(q, [{ sku: "WDG-1", qty: 10 }]);
  var snap = invSnap.create({ query: q, catalog: _stubCatalog(q) });

  // Take five snapshots with monotonically increasing taken_at so
  // the DESC list order is deterministic.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var s = await snap.takeSnapshot({ label: "snap-" + i, taken_at: 1000 + i });
    ids.push(s.id);
  }

  var page = await snap.listSnapshots({ limit: 10 });
  check("list returns all five",            page.rows.length === 5);
  check("list orders by taken_at DESC",     page.rows[0].id === ids[4] && page.rows[4].id === ids[0]);
  check("list next_cursor null on last",    page.next_cursor === null);

  // Pagination: limit=2 splits across three pages.
  var pageA = await snap.listSnapshots({ limit: 2 });
  check("list limit=2 first page",          pageA.rows.length === 2 && typeof pageA.next_cursor === "string");
  var pageB = await snap.listSnapshots({ limit: 2, cursor: pageA.next_cursor });
  check("list cursor second page",          pageB.rows.length === 2 && typeof pageB.next_cursor === "string");
  var pageC = await snap.listSnapshots({ limit: 2, cursor: pageB.next_cursor });
  check("list cursor final page",           pageC.rows.length === 1 && pageC.next_cursor === null);
  var seen = {};
  pageA.rows.concat(pageB.rows).concat(pageC.rows).forEach(function (r) { seen[r.id] = true; });
  check("list pagination covers all rows",  Object.keys(seen).length === 5);

  // from / to bounds.
  var bounded = await snap.listSnapshots({ from: 1001, to: 1003, limit: 10 });
  check("list from/to bounds",              bounded.rows.length === 3);

  // Bad cursor → refused
  await assert.rejects(snap.listSnapshots({ cursor: "garbage" }), /cursor/);
  await assert.rejects(snap.listSnapshots({ cursor: 12345 }),     /cursor/);

  // Limit bounds
  await assert.rejects(snap.listSnapshots({ limit: 0 }),    /limit/);
  await assert.rejects(snap.listSnapshots({ limit: 9999 }), /limit/);
  // from / to validation
  await assert.rejects(snap.listSnapshots({ from: -1 }),    /from/);
  await assert.rejects(snap.listSnapshots({ to: 1.5 }),     /to/);
}

async function _purgeOlderThan() {
  var q = _makeQuery();
  await _seedCatalogInventory(q, [{ sku: "WDG-1", qty: 10 }]);
  var snap = invSnap.create({ query: q, catalog: _stubCatalog(q) });

  var nowMs = Date.now();
  // Three "old" snapshots: 100 / 60 / 40 days ago.
  // Two "recent" snapshots: 5 days ago + just now.
  var dayMs = 86400000;
  var snapshots = [];
  snapshots.push(await snap.takeSnapshot({ label: "old-100d", taken_at: nowMs - 100 * dayMs }));
  snapshots.push(await snap.takeSnapshot({ label: "old-60d",  taken_at: nowMs - 60  * dayMs }));
  snapshots.push(await snap.takeSnapshot({ label: "old-40d",  taken_at: nowMs - 40  * dayMs }));
  snapshots.push(await snap.takeSnapshot({ label: "recent-5d", taken_at: nowMs - 5  * dayMs }));
  snapshots.push(await snap.takeSnapshot({ label: "now",      taken_at: nowMs }));

  // Purge older than 30 days → removes the three old ones.
  var result = await snap.purgeOlderThan(30);
  check("purge removed three",         result.removed === 3);
  check("purge cutoff < now",          result.cutoff < nowMs);
  check("purge returns ids",           result.removed_ids.length === 3);

  // Two snapshots survive.
  var remaining = await snap.listSnapshots({ limit: 50 });
  check("purge leaves two survivors",  remaining.rows.length === 2);
  var labels = remaining.rows.map(function (r) { return r.label; }).sort();
  check("purge keeps recent-5d + now", labels[0] === "now" && labels[1] === "recent-5d");

  // FK CASCADE: the snapshot_rows for purged snapshots are gone.
  var orphanRows = await q("SELECT COUNT(*) AS n FROM inventory_snapshot_rows " +
    "WHERE snapshot_id NOT IN (SELECT id FROM inventory_snapshots)", []);
  check("purge cascades to rows",      orphanRows.rows[0].n === 0);

  // Bad days input
  await assert.rejects(snap.purgeOlderThan(-1),    /days/);
  await assert.rejects(snap.purgeOlderThan(1.5),   /days/);
  await assert.rejects(snap.purgeOlderThan("30"),  /days/);
}

async function _factoryRefusals() {
  // Missing catalog → refused
  assert.throws(function () { invSnap.create({}); },                                   /catalog/);
  assert.throws(function () { invSnap.create({ catalog: {} }); },                      /catalog/);
  assert.throws(function () { invSnap.create({ catalog: { inventory: {} } }); },       /catalog/);

  // Mis-shaped inventoryLocations refused
  var q = _makeQuery();
  var stubCat = _stubCatalog(q);
  assert.throws(function () {
    invSnap.create({ query: q, catalog: stubCat, inventoryLocations: {} });
  }, /inventoryLocations/);

  // Production-without-cursorSecret refused
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(function () { invSnap.create({ query: q, catalog: stubCat }); },
      /cursorSecret is required/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
  }
}

async function run() {
  await _takeSnapshotSingleBucket();
  await _takeSnapshotMultiLocation();
  await _takeSnapshotRefusals();
  await _deltaBetween();
  await _summary();
  await _listSnapshotsAndPagination();
  await _purgeOlderThan();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("inventory-snapshots.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("inventory-snapshots.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
