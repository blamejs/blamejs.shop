"use strict";
/**
 * inventory-allocations — soft-reserve holds for in-progress carts.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0034
 * (inventoryLocations: locations + stock + adjustments) and migration
 * 0152 (inventory_holds). The inventoryLocations primitive is wired
 * live — the holds primitive composes its adjustStock / stockForSku /
 * getLocation verbs to compute availability and to debit the shelf
 * on commit, so the audit log on inventory_adjustments reflects every
 * committed hold.
 *
 * Coverage:
 *   - holdForCart happy path: writes a row, decrements availableForSku
 *   - holdForCart refuses oversold quantity (committed - held < requested)
 *   - releaseHold restores availability + writes release_reason +
 *     released_at
 *   - releaseAllForCart bulk-releases every held row for the cart
 *   - commitHold composes inventoryLocations.adjustStock: shelf
 *     decremented, hold flipped to 'committed' with order_id +
 *     committed_at
 *   - extendHold pushes expires_at out by additional_ttl_seconds
 *   - cleanupExpiredHolds walks rows with expires_at <= now and
 *     flips status -> 'expired' (idempotent on a second run)
 *   - metricsForSku aggregates counts + quantity sums by status
 *   - factory refusals: missing inventoryLocations
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var inventoryAllocations = require("../../lib/inventory-allocations");
var inventoryLocations   = require("../../lib/inventory-locations");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0034_inventory_locations.sql",
  "0152_inventory_allocations.sql",
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
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  queryFn.__db = db;
  return queryFn;
}

// Minimal catalog stub for the locations primitive — only the
// factory checks it's an object.
function _stubCatalog() { return {}; }

// Build a fully-wired pair: an inventoryLocations svc seeded with
// two locations, and an inventoryAllocations svc that composes it.
async function _wire() {
  var q = _makeQuery();
  var locSvc = inventoryLocations.create({ query: q, catalog: _stubCatalog() });
  await locSvc.defineLocation({ code: "WH-EAST", name: "East Warehouse", type: "warehouse", priority: 1 });
  await locSvc.defineLocation({ code: "WH-WEST", name: "West Warehouse", type: "warehouse", priority: 5 });
  var allocSvc = inventoryAllocations.create({ query: q, inventoryLocations: locSvc });
  return { q: q, locSvc: locSvc, allocSvc: allocSvc };
}

async function _holdForCartHappyPath() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 20 });

  var avail0 = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("availableForSku initial committed",     avail0.committed === 20);
  check("availableForSku initial on_hold",       avail0.on_hold === 0);
  check("availableForSku initial available",     avail0.available === 20);

  var hold = await allocSvc.holdForCart({
    cart_id: "cart-abc", sku: "WDG-1", location_code: "WH-EAST", quantity: 5, ttl_seconds: 600,
  });
  check("holdForCart returns id",                typeof hold.id === "string" && hold.id.length > 0);
  check("holdForCart status held",               hold.status === "held");
  check("holdForCart quantity persists",         hold.quantity === 5);
  check("holdForCart ttl_seconds persists",      hold.ttl_seconds === 600);
  check("holdForCart expires_at = created+ttl",  hold.expires_at === hold.created_at + 600 * 1000);

  var avail1 = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("availableForSku reflects hold (held)",  avail1.on_hold === 5);
  check("availableForSku reflects hold (avail)", avail1.available === 15);
  check("availableForSku committed unchanged",   avail1.committed === 20);

  // A hold opened with location_code=null counts against location-
  // pinned reads too (pessimistic — the unpinned hold may yet land
  // at any location).
  var hold2 = await allocSvc.holdForCart({
    cart_id: "cart-xyz", sku: "WDG-1", quantity: 3,
  });
  check("holdForCart unpinned has null loc",     hold2.location_code === null);
  var avail2 = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("unpinned hold subtracts from pinned",   avail2.on_hold === 8 && avail2.available === 12);

  // Refusals
  await assert.rejects(allocSvc.holdForCart(),                                            /input object required/);
  await assert.rejects(allocSvc.holdForCart({ cart_id: "", sku: "WDG-1", quantity: 1 }),  /cart_id/);
  await assert.rejects(allocSvc.holdForCart({ cart_id: "c", sku: "",      quantity: 1 }), /sku/);
  await assert.rejects(allocSvc.holdForCart({ cart_id: "c", sku: "WDG-1", quantity: 0 }), /quantity/);
  await assert.rejects(allocSvc.holdForCart({ cart_id: "c", sku: "WDG-1", quantity: 1, ttl_seconds: 0 }),       /ttl_seconds/);
  await assert.rejects(allocSvc.holdForCart({ cart_id: "c", sku: "WDG-1", quantity: 1, location_code: "NOPE" }), /not found/);
}

async function _holdForCartRefusesOversold() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 5 });

  // First hold consumes all five
  await allocSvc.holdForCart({
    cart_id: "cart-a", sku: "WDG-1", location_code: "WH-EAST", quantity: 5,
  });

  // Second hold against the same SKU+loc should refuse — committed 5, held 5, available 0
  await assert.rejects(allocSvc.holdForCart({
    cart_id: "cart-b", sku: "WDG-1", location_code: "WH-EAST", quantity: 1,
  }), /insufficient available stock/);

  // Total-only check (no location_code) also refuses across the shelf
  await assert.rejects(allocSvc.holdForCart({
    cart_id: "cart-c", sku: "WDG-1", quantity: 1,
  }), /insufficient available stock/);
}

async function _releaseHoldRestoresAvailability() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 10 });
  var hold = await allocSvc.holdForCart({
    cart_id: "cart-a", sku: "WDG-1", location_code: "WH-EAST", quantity: 4,
  });
  var pre = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("pre-release available",                 pre.available === 6);

  var released = await allocSvc.releaseHold({ hold_id: hold.id, reason: "cart_abandoned" });
  check("releaseHold flips status",              released.status === "released");
  check("releaseHold captures release_reason",   released.release_reason === "cart_abandoned");
  check("releaseHold sets released_at",          typeof released.released_at === "number" && released.released_at > 0);

  var post = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("released hold restores availability",   post.available === 10 && post.on_hold === 0);

  // Refuse double-release
  await assert.rejects(allocSvc.releaseHold({ hold_id: hold.id, reason: "x" }),    /expected 'held'/);
  // Refuse unknown hold_id (UUID-shaped)
  await assert.rejects(allocSvc.releaseHold({
    hold_id: "00000000-0000-0000-0000-000000000000", reason: "x",
  }), /not found/);
  // Refuse bad hold_id shape
  await assert.rejects(allocSvc.releaseHold({ hold_id: "not-a-uuid", reason: "x" }), /hold_id/);
  // Refuse empty reason
  await assert.rejects(allocSvc.releaseHold({ hold_id: hold.id, reason: "" }),      /reason/);

  // releaseAllForCart bulk-flips every active hold
  var h1 = await allocSvc.holdForCart({ cart_id: "cart-b", sku: "WDG-1", location_code: "WH-EAST", quantity: 1 });
  var h2 = await allocSvc.holdForCart({ cart_id: "cart-b", sku: "WDG-1", location_code: "WH-EAST", quantity: 2 });
  var bulk = await allocSvc.releaseAllForCart({ cart_id: "cart-b", reason: "cart_emptied" });
  check("releaseAllForCart count",               bulk.released_count === 2);
  var h1After = (await allocSvc.holdsForCart("cart-b")).find(function (h) { return h.id === h1.id; });
  var h2After = (await allocSvc.holdsForCart("cart-b")).find(function (h) { return h.id === h2.id; });
  check("releaseAllForCart flips h1",            h1After.status === "released");
  check("releaseAllForCart flips h2",            h2After.status === "released");
  check("releaseAllForCart writes reason h1",    h1After.release_reason === "cart_emptied");

  // Idempotent on second call (no active rows left)
  var bulk2 = await allocSvc.releaseAllForCart({ cart_id: "cart-b", reason: "again" });
  check("releaseAllForCart idempotent count=0",  bulk2.released_count === 0);
}

async function _commitHoldComposesAdjustStock() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc, q = wired.q;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 10 });
  var hold = await allocSvc.holdForCart({
    cart_id: "cart-a", sku: "WDG-1", location_code: "WH-EAST", quantity: 3,
  });

  var committed = await allocSvc.commitHold({ hold_id: hold.id, order_id: "order-1" });
  check("commitHold flips status",               committed.status === "committed");
  check("commitHold sets order_id",              committed.committed_order_id === "order-1");
  check("commitHold sets committed_at",          typeof committed.committed_at === "number" && committed.committed_at > 0);

  // Shelf decremented via composed inventoryLocations.adjustStock
  var shelf = await locSvc.stockForSku("WDG-1");
  check("commitHold debits committed shelf",     shelf.total === 7);

  // Audit row landed via inventoryLocations._audit
  var auditRows = (await q(
    "SELECT * FROM inventory_adjustments WHERE sku = ?1 ORDER BY occurred_at ASC", ["WDG-1"],
  )).rows;
  // First adjustment was the setStock (+10); second is the commit (-3)
  check("audit row count after commit",          auditRows.length === 2);
  check("commit audit row is signed -3",         auditRows[1].delta === -3);
  check("commit audit row reason carries hold",  /hold-commit:/.test(auditRows[1].reason));
  check("commit audit row reason carries order", /order:order-1/.test(auditRows[1].reason));

  // availableForSku after commit: held -> 0 (the hold no longer
  // counts as held), committed -> 7
  var avail = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("post-commit on_hold = 0",               avail.on_hold === 0);
  check("post-commit committed = 7",             avail.committed === 7);
  check("post-commit available = 7",             avail.available === 7);

  // Refuse double-commit
  await assert.rejects(allocSvc.commitHold({ hold_id: hold.id, order_id: "order-2" }), /expected 'held'/);

  // Refuse commit on an unpinned hold (no location_code)
  var unpinned = await allocSvc.holdForCart({ cart_id: "cart-b", sku: "WDG-1", quantity: 1 });
  await assert.rejects(allocSvc.commitHold({ hold_id: unpinned.id, order_id: "order-3" }), /no location_code/);
}

async function _extendHoldUpdatesExpiresAt() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 10 });
  var hold = await allocSvc.holdForCart({
    cart_id: "cart-a", sku: "WDG-1", location_code: "WH-EAST", quantity: 2, ttl_seconds: 60,
  });
  var originalExpires = hold.expires_at;

  var extended = await allocSvc.extendHold({ hold_id: hold.id, additional_ttl_seconds: 120 });
  check("extendHold pushes expires_at",          extended.expires_at === originalExpires + 120 * 1000);
  check("extendHold preserves status",           extended.status === "held");
  check("extendHold preserves quantity",         extended.quantity === 2);

  // Refusals
  await assert.rejects(allocSvc.extendHold({ hold_id: hold.id, additional_ttl_seconds: 0 }),   /additional_ttl_seconds/);
  await assert.rejects(allocSvc.extendHold({ hold_id: hold.id, additional_ttl_seconds: -1 }),  /additional_ttl_seconds/);
  await assert.rejects(allocSvc.extendHold({
    hold_id: "00000000-0000-0000-0000-000000000000", additional_ttl_seconds: 30,
  }), /not found/);

  // Released holds can't be extended
  await allocSvc.releaseHold({ hold_id: hold.id, reason: "test" });
  await assert.rejects(allocSvc.extendHold({ hold_id: hold.id, additional_ttl_seconds: 30 }), /expected 'held'/);
}

async function _cleanupExpiredHoldsWalksAndFlips() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 50 });

  // Three holds with TTL=1s
  var h1 = await allocSvc.holdForCart({ cart_id: "c-1", sku: "WDG-1", location_code: "WH-EAST", quantity: 2, ttl_seconds: 1 });
  var h2 = await allocSvc.holdForCart({ cart_id: "c-2", sku: "WDG-1", location_code: "WH-EAST", quantity: 3, ttl_seconds: 1 });
  var h3 = await allocSvc.holdForCart({ cart_id: "c-3", sku: "WDG-1", location_code: "WH-EAST", quantity: 4, ttl_seconds: 86400 });

  // Walk with a clock far in the future for h1+h2 but not h3
  var future = h2.expires_at + 1000;
  var r = await allocSvc.cleanupExpiredHolds({ now: future });
  check("cleanupExpiredHolds count",             r.expired_count === 2);

  // Verify status flips on the two expired rows; h3 still 'held'
  var holds = await allocSvc.holdsForCart("c-1");
  check("expired hold h1 status",                holds[0].status === "expired");
  check("expired hold h1 release_reason",        holds[0].release_reason === "ttl_expired");
  check("expired hold h1 expired_at set",        typeof holds[0].expired_at === "number" && holds[0].expired_at > 0);

  var holds2 = await allocSvc.holdsForCart("c-2");
  check("expired hold h2 status",                holds2[0].status === "expired");

  var holds3 = await allocSvc.holdsForCart("c-3");
  check("non-expired hold h3 status",            holds3[0].status === "held");

  // Availability restored for the expired qty: committed 50, held
  // only h3=4, available 46
  var avail = await allocSvc.availableForSku({ sku: "WDG-1", location_code: "WH-EAST" });
  check("expired holds restore availability",    avail.on_hold === 4 && avail.available === 46);

  // Idempotent on second call
  var r2 = await allocSvc.cleanupExpiredHolds({ now: future });
  check("cleanupExpiredHolds idempotent count=0", r2.expired_count === 0);

  // unused parameter assertion to satisfy linter for h1/h3 captures
  check("hold ids unique",                       h1.id !== h3.id);
}

async function _metricsForSkuAggregates() {
  var wired = await _wire();
  var locSvc = wired.locSvc, allocSvc = wired.allocSvc;

  await locSvc.setStock({ sku: "WDG-1", location_code: "WH-EAST", quantity: 100 });

  var t0 = Date.now() - 1000;

  // Three held, one released, one committed
  await allocSvc.holdForCart({ cart_id: "c-a", sku: "WDG-1", location_code: "WH-EAST", quantity: 2 });
  var hReleased = await allocSvc.holdForCart({ cart_id: "c-b", sku: "WDG-1", location_code: "WH-EAST", quantity: 3 });
  var hCommit   = await allocSvc.holdForCart({ cart_id: "c-c", sku: "WDG-1", location_code: "WH-EAST", quantity: 4 });
  await allocSvc.holdForCart({ cart_id: "c-d", sku: "WDG-1", location_code: "WH-EAST", quantity: 5 });
  await allocSvc.holdForCart({ cart_id: "c-e", sku: "WDG-1", location_code: "WH-EAST", quantity: 6 });

  await allocSvc.releaseHold({ hold_id: hReleased.id, reason: "user_cancel" });
  await allocSvc.commitHold({ hold_id: hCommit.id,    order_id: "order-1" });

  var t1 = Date.now() + 60 * 60 * 1000;

  var m = await allocSvc.metricsForSku({ sku: "WDG-1", from: t0, to: t1 });
  check("metricsForSku sku echoed",              m.sku === "WDG-1");
  check("metricsForSku held count",              m.held.count === 3);
  check("metricsForSku held qty sum",            m.held.quantity === 2 + 5 + 6);
  check("metricsForSku released count",          m.released.count === 1);
  check("metricsForSku released qty",            m.released.quantity === 3);
  check("metricsForSku committed count",         m.committed.count === 1);
  check("metricsForSku committed qty",           m.committed.quantity === 4);
  check("metricsForSku expired count=0",         m.expired.count === 0);

  // Window that excludes everything → all zero
  var m2 = await allocSvc.metricsForSku({ sku: "WDG-1", from: 1, to: 2 });
  check("metricsForSku narrow window all zero",
    m2.held.count === 0 && m2.released.count === 0 &&
    m2.committed.count === 0 && m2.expired.count === 0);

  // Refusals
  await assert.rejects(allocSvc.metricsForSku(),                                            /input object required/);
  await assert.rejects(allocSvc.metricsForSku({ sku: "WDG-1", from: -1, to: 1 }),           /from/);
  await assert.rejects(allocSvc.metricsForSku({ sku: "WDG-1", from: 10, to: 5 }),           /to/);
  await assert.rejects(allocSvc.metricsForSku({ sku: "", from: 0, to: 1 }),                 /sku/);
}

async function _factoryRefusals() {
  // Missing inventoryLocations
  assert.throws(function () { inventoryAllocations.create({}); },                          /inventoryLocations/);
  assert.throws(function () { inventoryAllocations.create({ inventoryLocations: null }); }, /inventoryLocations/);
  // Partial inventoryLocations (missing required verbs)
  assert.throws(function () {
    inventoryAllocations.create({ inventoryLocations: { adjustStock: function () {} } });
  }, /inventoryLocations/);
}

async function run() {
  await _holdForCartHappyPath();
  await _holdForCartRefusesOversold();
  await _releaseHoldRestoresAvailability();
  await _commitHoldComposesAdjustStock();
  await _extendHoldUpdatesExpiresAt();
  await _cleanupExpiredHoldsWalksAndFlips();
  await _metricsForSkuAggregates();
  await _factoryRefusals();
}

module.exports = { run: run };
