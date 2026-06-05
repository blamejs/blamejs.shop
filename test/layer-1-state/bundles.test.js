"use strict";
/**
 * bundles — virtual composite SKUs (kit products).
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001_catalog.sql + 0002_cart.sql + 0032_bundles.sql. The catalog
 * primitive is composed live (using the same in-memory query) so the
 * variants.bySku lookup the primitive depends on exercises real SQL,
 * not a mock.
 *
 * Pins:
 *   - defineBundle happy path inserts both tables atomically
 *   - defineBundle refuses on missing component SKU
 *   - defineBundle refuses on cyclic reference (direct + via a child bundle)
 *   - defineBundle refuses on duplicate bundle_sku
 *   - expand resolves a single-level bundle with quantity multipliers
 *   - expand resolves a nested 2-level bundle, summing repeated leaves
 *   - expand refuses a 3-level chain
 *   - priceBundle with no discount sums child prices * qty
 *   - priceBundle with bps discount applies the floor-rounded delta
 *   - priceBundle refuses on mixed currencies
 *   - updateBundle partial update via column allow-list
 *   - updateBundle replaces components atomically
 *   - deleteBundle refuses when an active cart line references the bundle
 *   - deleteBundle succeeds once the active cart is converted
 *   - listBundles paginates with HMAC cursors; tampered cursor refused
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var bundles = require("../../lib/bundles");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0032_bundles.sql"].map(function (f) {
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
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Seed N product+variant rows so the bundles primitive's
// catalog.variants.bySku lookups resolve. Returns the SKUs created
// (also re-callable to grow the catalog mid-test).
async function _seedVariants(query, skus) {
  var catalog = bShop.catalog.create({ query: query });
  var p = await catalog.products.create({ slug: "p-" + Date.now(), title: "P", status: "active" });
  for (var i = 0; i < skus.length; i += 1) {
    await catalog.variants.create(p.id, { sku: skus[i] });
  }
  return catalog;
}

async function _seedActiveCart(query, catalog, sku) {
  // Insert a cart + cart_line directly. The deleteBundle reference
  // check only looks at cart_lines.sku, but the FK on
  // cart_lines.variant_id requires a real variants(id) row — borrow
  // any one from the seeded catalog so the constraint passes.
  var anyVariant = await query("SELECT id FROM variants LIMIT 1");
  if (!anyVariant.rows.length) throw new Error("_seedActiveCart: no variant in catalog");
  var variantId = anyVariant.rows[0].id;
  var cartId = bShop.framework.uuid.v7();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, NULL, 'USD', 'active', ?3, ?3, ?4)",
    [cartId, "sess-" + ts, ts, ts + 86400000],
  );
  await query(
    "INSERT INTO cart_lines (id, cart_id, variant_id, sku, qty, unit_amount_minor, unit_currency, added_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 1, 1000, 'USD', ?5, ?5)",
    [bShop.framework.uuid.v7(), cartId, variantId, sku, ts],
  );
  return cartId;
}

// ---- defineBundle happy path -------------------------------------------

async function _defineBundleHappy() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A-001", "B-002", "C-003"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "test-secret" });

  var def = await b.defineBundle({
    bundle_sku: "KIT-XYZ",
    title:      "XYZ Starter Kit",
    components: [
      { sku: "A-001", quantity: 2 },
      { sku: "B-002", quantity: 1 },
      { sku: "C-003", quantity: 3 },
    ],
    bundle_discount_bps: 500,
  });
  check("defineBundle returns bundle_sku",          def.bundle_sku === "KIT-XYZ");
  check("defineBundle stores title",                def.title === "XYZ Starter Kit");
  check("defineBundle stores discount_bps",         def.bundle_discount_bps === 500);
  check("defineBundle has 3 components",            def.components.length === 3);
  check("defineBundle preserves sort_order",        def.components[0].sku === "A-001" && def.components[0].sort_order === 0);

  var got = await b.getBundle("KIT-XYZ");
  check("getBundle round-trip",                     got && got.bundle_sku === "KIT-XYZ" && got.components.length === 3);
  check("getBundle returns null on miss",           (await b.getBundle("NOPE-404")) === null);

  // Re-defining the same SKU refuses.
  await assert.rejects(b.defineBundle({
    bundle_sku: "KIT-XYZ", title: "x", components: [{ sku: "A-001", quantity: 1 }],
  }), /already exists/);

  // Bundle SKU colliding with a catalog variant refuses.
  await assert.rejects(b.defineBundle({
    bundle_sku: "A-001", title: "collides", components: [{ sku: "B-002", quantity: 1 }],
  }), /collides/);
}

// ---- defineBundle refusals ---------------------------------------------

async function _defineBundleRefusals() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["X-1"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });

  // Missing component sku
  await assert.rejects(b.defineBundle({
    bundle_sku: "K-MISS", title: "miss", components: [{ sku: "DOES-NOT-EXIST", quantity: 1 }],
  }), /not found in catalog/);

  // Bad shape input
  await assert.rejects(b.defineBundle(),                       /input object required/);
  await assert.rejects(b.defineBundle({}),                     /bundle_sku/);
  await assert.rejects(b.defineBundle({ bundle_sku: "BAD KIT", title: "x", components: [{ sku: "X-1", quantity: 1 }] }), /bundle_sku must match/);
  await assert.rejects(b.defineBundle({ bundle_sku: "K-1", title: "", components: [{ sku: "X-1", quantity: 1 }] }), /title/);
  await assert.rejects(b.defineBundle({ bundle_sku: "K-1", title: "x", components: [] }), /non-empty array/);
  await assert.rejects(b.defineBundle({ bundle_sku: "K-1", title: "x", components: [{ sku: "X-1", quantity: 0 }] }), /quantity/);
  await assert.rejects(b.defineBundle({ bundle_sku: "K-1", title: "x", components: [{ sku: "X-1", quantity: 1 }, { sku: "X-1", quantity: 2 }] }), /duplicate/);
  await assert.rejects(b.defineBundle({ bundle_sku: "K-1", title: "x", components: [{ sku: "X-1", quantity: 1 }], bundle_discount_bps: 20000 }), /bundle_discount_bps/);
}

// ---- cycle detection ---------------------------------------------------

async function _defineBundleCycleRefused() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["LEAF-A", "LEAF-B"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });

  // Self-cycle — bundle references itself directly.
  await assert.rejects(b.defineBundle({
    bundle_sku: "CYC-1", title: "cyc", components: [{ sku: "CYC-1", quantity: 1 }],
  }), /cyclic reference/);

  // Define a normal bundle first
  await b.defineBundle({
    bundle_sku: "INNER", title: "inner", components: [{ sku: "LEAF-A", quantity: 1 }],
  });
  // Now define an OUTER bundle that contains INNER — legal (2 levels).
  await b.defineBundle({
    bundle_sku: "OUTER", title: "outer", components: [{ sku: "INNER", quantity: 1 }, { sku: "LEAF-B", quantity: 1 }],
  });

  // Attempting to make INNER reference OUTER (which already contains
  // INNER) would create a cycle INNER -> OUTER -> INNER.
  await assert.rejects(b.updateBundle("INNER", {
    components: [{ sku: "OUTER", quantity: 1 }],
  }), /cyclic reference|nesting exceeds/);
}

// ---- expand: single level ----------------------------------------------

async function _expandSingleLevel() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A", "B", "C"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });

  await b.defineBundle({
    bundle_sku: "KIT", title: "kit",
    components: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 1 }, { sku: "C", quantity: 3 }],
  });

  var flat = await b.expand({ bundle_sku: "KIT", quantity: 1 });
  check("expand single-level rows",                 flat.length === 3);
  // Sorted by sku (A, B, C)
  check("expand multiplier=1 A:2",                  flat[0].sku === "A" && flat[0].quantity === 2);
  check("expand multiplier=1 B:1",                  flat[1].sku === "B" && flat[1].quantity === 1);
  check("expand multiplier=1 C:3",                  flat[2].sku === "C" && flat[2].quantity === 3);

  var x5 = await b.expand({ bundle_sku: "KIT", quantity: 5 });
  check("expand multiplier=5 A:10",                 x5[0].quantity === 10);
  check("expand multiplier=5 B:5",                  x5[1].quantity === 5);
  check("expand multiplier=5 C:15",                 x5[2].quantity === 15);

  // Unknown bundle
  await assert.rejects(b.expand({ bundle_sku: "NOPE", quantity: 1 }), /not found/);
  // Zero / negative qty
  await assert.rejects(b.expand({ bundle_sku: "KIT", quantity: 0 }), /quantity/);
}

// ---- expand: nested 2-level + 3-level refused --------------------------

async function _expandNested() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["L1", "L2", "L3"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });

  // Inner contains two leaves
  await b.defineBundle({
    bundle_sku: "INNER", title: "inner",
    components: [{ sku: "L1", quantity: 1 }, { sku: "L2", quantity: 2 }],
  });
  // Outer contains the inner bundle (qty 3) + a direct leaf
  await b.defineBundle({
    bundle_sku: "OUTER", title: "outer",
    components: [{ sku: "INNER", quantity: 3 }, { sku: "L3", quantity: 1 }],
  });

  var flat = await b.expand({ bundle_sku: "OUTER", quantity: 1 });
  // L1 = 1 * 3 = 3, L2 = 2 * 3 = 6, L3 = 1
  check("expand nested 3 rows",                     flat.length === 3);
  var bySku = {}; flat.forEach(function (r) { bySku[r.sku] = r.quantity; });
  check("expand nested L1 = 1 * 3",                 bySku.L1 === 3);
  check("expand nested L2 = 2 * 3",                 bySku.L2 === 6);
  check("expand nested L3 = 1",                     bySku.L3 === 1);

  // With outer qty 2 the leaves double again
  var flat2 = await b.expand({ bundle_sku: "OUTER", quantity: 2 });
  var bySku2 = {}; flat2.forEach(function (r) { bySku2[r.sku] = r.quantity; });
  check("expand nested OUTER*2 L1 = 6",             bySku2.L1 === 6);
  check("expand nested OUTER*2 L2 = 12",            bySku2.L2 === 12);
  check("expand nested OUTER*2 L3 = 2",             bySku2.L3 === 2);

  // Build a 3-level chain by inserting directly into the tables,
  // bypassing the cycle walker — the SQL layer accepts it but
  // expand() refuses. This pins the runtime depth gate even if a
  // future migration introduces a different path that bypasses
  // defineBundle's check.
  await q("INSERT INTO bundles (bundle_sku, title, bundle_discount_bps, created_at, updated_at) VALUES ('LVL3','lvl3',NULL,1,1)");
  await q("INSERT INTO bundle_components (bundle_sku, sku, quantity, sort_order) VALUES ('LVL3','OUTER',1,0)");
  await assert.rejects(b.expand({ bundle_sku: "LVL3", quantity: 1 }), /nesting exceeds/);
}

// ---- priceBundle -------------------------------------------------------

function _stubPricing(prices) {
  return {
    priceFor: async function (sku) {
      if (!Object.prototype.hasOwnProperty.call(prices, sku)) return null;
      return prices[sku];
    },
  };
}

async function _priceBundleNoDiscount() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A", "B"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });
  await b.defineBundle({
    bundle_sku: "KIT", title: "kit",
    components: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 1 }],
  });
  var pricing = _stubPricing({
    A: { amount_minor: 1000, currency: "USD" },
    B: { amount_minor: 2500, currency: "USD" },
  });
  var res = await b.priceBundle({ bundle_sku: "KIT", pricing: pricing });
  check("priceBundle list_total",                   res.list_total_minor === 4500);
  check("priceBundle no-discount discount_minor",   res.discount_minor === 0);
  check("priceBundle amount_minor",                 res.amount_minor === 4500);
  check("priceBundle currency",                     res.currency === "USD");
}

async function _priceBundleWithDiscount() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A", "B"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });
  await b.defineBundle({
    bundle_sku: "KIT", title: "kit",
    bundle_discount_bps: 1500,    // 15%
    components: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 1 }],
  });
  var pricing = _stubPricing({
    A: { amount_minor: 1000, currency: "USD" },
    B: { amount_minor: 2500, currency: "USD" },
  });
  var res = await b.priceBundle({ bundle_sku: "KIT", pricing: pricing });
  // list = 2*1000 + 1*2500 = 4500. 15% of 4500 = 675 (integer).
  check("priceBundle disc list_total",              res.list_total_minor === 4500);
  check("priceBundle disc discount_minor",          res.discount_minor === 675);
  check("priceBundle disc amount_minor",            res.amount_minor === 3825);
  check("priceBundle disc bps preserved",           res.bundle_discount_bps === 1500);

  // Float-drift guard: with a large list total, a JS float multiply of
  // listTotal*bps overflows 2^53 and floors one cent high. listTotal =
  // 27048646413003 at 333 bps -> exact floor 900719925552, but the
  // float path yields 900719925553. The exact-BigInt path must floor to
  // 552.
  var qBig = _makeQuery();
  var catalogBig = await _seedVariants(qBig, ["A"]);
  var bBig = bundles.create({ query: qBig, catalog: catalogBig, cursorSecret: "s" });
  await bBig.defineBundle({
    bundle_sku: "KIT-BIG", title: "big kit",
    bundle_discount_bps: 333,
    components: [{ sku: "A", quantity: 1 }],
  });
  var bigList = 27048646413003;
  var pricingBig = _stubPricing({ A: { amount_minor: bigList, currency: "USD" } });
  var resBig = await bBig.priceBundle({ bundle_sku: "KIT-BIG", pricing: pricingBig });
  check("priceBundle large list_total",             resBig.list_total_minor === bigList);
  check("priceBundle large discount exact (floor)", resBig.discount_minor === 900719925552);
  check("priceBundle large amount_minor",           resBig.amount_minor === bigList - 900719925552);

  // Mixed currencies refused.
  var mixed = _stubPricing({
    A: { amount_minor: 1000, currency: "USD" },
    B: { amount_minor: 2500, currency: "EUR" },
  });
  await assert.rejects(b.priceBundle({ bundle_sku: "KIT", pricing: mixed }), /mixed currencies/);

  // Missing price for a component
  var partial = _stubPricing({ A: { amount_minor: 1000, currency: "USD" } });
  await assert.rejects(b.priceBundle({ bundle_sku: "KIT", pricing: partial }), /returned no row/);
}

// ---- updateBundle ------------------------------------------------------

async function _updateBundlePartial() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A", "B", "C"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });
  var def = await b.defineBundle({
    bundle_sku: "K", title: "old", components: [{ sku: "A", quantity: 1 }],
  });
  var t0 = def.updated_at;
  // Title-only patch
  await new Promise(function (r) { setTimeout(r, 5); });   // allow:test-promise-settimeout-sleep — guarantees updated_at advances on millisecond clocks
  var u1 = await b.updateBundle("K", { title: "new" });
  check("updateBundle title patched",               u1.title === "new");
  check("updateBundle updated_at advances",         u1.updated_at > t0);

  // Components-only patch
  var u2 = await b.updateBundle("K", {
    components: [{ sku: "B", quantity: 2 }, { sku: "C", quantity: 1 }],
  });
  check("updateBundle components replaced",         u2.components.length === 2);
  check("updateBundle components order preserved",  u2.components[0].sku === "B" && u2.components[1].sku === "C");

  // Empty patch refused
  await assert.rejects(b.updateBundle("K", {}), /no updatable fields/);

  // Patch on unknown bundle returns null
  var miss = await b.updateBundle("NOPE-Z", { title: "x" });
  check("updateBundle on missing returns null",     miss === null);

  // Components patch with missing component sku refused
  await assert.rejects(b.updateBundle("K", { components: [{ sku: "NOPE-X", quantity: 1 }] }), /not found in catalog/);
}

// ---- deleteBundle ------------------------------------------------------

async function _deleteBundleReferenced() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A", "B"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "s" });
  await b.defineBundle({
    bundle_sku: "REF-KIT", title: "ref", components: [{ sku: "A", quantity: 1 }],
  });

  // No references — delete succeeds.
  var deleted = await b.deleteBundle("REF-KIT");
  check("deleteBundle no-refs returns true",        deleted === true);
  check("deleteBundle removes row",                 (await b.getBundle("REF-KIT")) === null);

  // Re-create, drop an active cart_line at the bundle, and verify
  // the delete is refused.
  await b.defineBundle({
    bundle_sku: "REF-KIT", title: "ref", components: [{ sku: "A", quantity: 1 }],
  });
  var cartId = await _seedActiveCart(q, catalog, "REF-KIT");
  await assert.rejects(b.deleteBundle("REF-KIT"), /active cart line/);

  // Convert the cart — the reference is now historical. (cart_lines
  // stay on the row; the gate looks at carts.status.)
  await q("UPDATE carts SET status = 'converted', updated_at = ?1 WHERE id = ?2", [Date.now(), cartId]);
  var ok = await b.deleteBundle("REF-KIT");
  check("deleteBundle after cart converted",        ok === true);

  // extraReferenceCheck callback can also veto.
  var vetoed = bundles.create({
    query: q, catalog: catalog, cursorSecret: "s",
    extraReferenceCheck: async function (sku) { return sku === "VETOED"; },
  });
  await vetoed.defineBundle({
    bundle_sku: "VETOED", title: "v", components: [{ sku: "A", quantity: 1 }],
  });
  await assert.rejects(vetoed.deleteBundle("VETOED"), /external subscription/);
}

// ---- listBundles + cursor tamper-refused -------------------------------

async function _listBundlesPagination() {
  var q = _makeQuery();
  var catalog = await _seedVariants(q, ["A", "B", "C", "D", "E"]);
  var b = bundles.create({ query: q, catalog: catalog, cursorSecret: "list-secret" });

  // Insert 5 bundles with strictly monotonic updated_at so the cursor
  // tuple (updated_at, bundle_sku) deterministically orders them.
  for (var i = 0; i < 5; i += 1) {
    await b.defineBundle({
      bundle_sku: "K-" + i, title: "k" + i,
      components: [{ sku: ["A","B","C","D","E"][i], quantity: 1 }],
    });
    // Ensure subsequent rows land on a different millisecond. Pulse
    // the clock instead of sleeping — wall-clock dependence is the
    // shape we'd otherwise flake on.
    await new Promise(function (r) { setTimeout(r, 2); });   // allow:test-promise-settimeout-sleep — millisecond clock pulse for deterministic ordering
  }

  var page1 = await b.listBundles({ limit: 2 });
  check("listBundles page1 has 2 rows",             page1.rows.length === 2);
  check("listBundles page1 cursor present",         typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);

  var page2 = await b.listBundles({ limit: 2, cursor: page1.next_cursor });
  check("listBundles page2 has 2 rows",             page2.rows.length === 2);
  check("listBundles page2 different from page1",   page1.rows[0].bundle_sku !== page2.rows[0].bundle_sku);

  var page3 = await b.listBundles({ limit: 2, cursor: page2.next_cursor });
  check("listBundles page3 has remaining row",      page3.rows.length === 1);
  check("listBundles page3 no further cursor",      page3.next_cursor === null);

  // Tampered cursor — flip a byte in the tag half and confirm the
  // HMAC check refuses it. Mutate the base64url tag (after the `.`)
  // so the JSON state still parses but the tag fails the comparison.
  var dot = page1.next_cursor.indexOf(".");
  var tampered = page1.next_cursor.slice(0, dot + 1) +
    page1.next_cursor.slice(dot + 1).split("").reverse().join("");
  if (tampered === page1.next_cursor) {
    tampered = page1.next_cursor.slice(0, dot + 1) + "AAAA" + page1.next_cursor.slice(dot + 1);
  }
  await assert.rejects(b.listBundles({ limit: 2, cursor: tampered }), /cursor/);

  // Cursor from a different secret refuses.
  var b2 = bundles.create({ query: q, catalog: catalog, cursorSecret: "different-secret" });
  await assert.rejects(b2.listBundles({ limit: 2, cursor: page1.next_cursor }), /cursor/);

  // Bad limit + bad cursor type
  await assert.rejects(b.listBundles({ limit: 0 }),       /limit/);
  await assert.rejects(b.listBundles({ limit: 9999 }),    /limit/);
  await assert.rejects(b.listBundles({ cursor: 12345 }),  /cursor must be an opaque string/);
}

// ---- factory guards ----------------------------------------------------

async function _factoryGuards() {
  assert.throws(function () { bundles.create({}); },                            /catalog/);
  assert.throws(function () { bundles.create({ catalog: {} }); },               /catalog/);
  assert.throws(function () { bundles.create({ catalog: { variants: {} } }); }, /catalog/);
}

async function run() {
  await _defineBundleHappy();
  await _defineBundleRefusals();
  await _defineBundleCycleRefused();
  await _expandSingleLevel();
  await _expandNested();
  await _priceBundleNoDiscount();
  await _priceBundleWithDiscount();
  await _updateBundlePartial();
  await _deleteBundleReferenced();
  await _listBundlesPagination();
  await _factoryGuards();
}

module.exports = { run: run };
