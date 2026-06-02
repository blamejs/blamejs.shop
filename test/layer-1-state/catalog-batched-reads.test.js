"use strict";
/**
 * catalog.batch — N+1-collapsing read helpers pinned byte-identical
 * to the per-item path each replaces.
 *
 * Layer 1: every helper composes SQL against the externalDb backend,
 * run here against an in-memory node:sqlite loaded from the live D1
 * migration files (0001_catalog + 0008_inventory_thresholds +
 * 0043_collections) via the shared `helpers.memD1Query`. The batched
 * helpers exist to replace per-item container loops; this test asserts
 * the batched output deep-equals the per-item read it stands in for, so
 * the dual-rendered HTML/JSON-LD is unchanged. A field rename or shape
 * drift fails here, not in the live D1 hop.
 *
 * Coverage:
 *   - decoratedProducts / decoratedActive vs the per-product
 *     products.get + prices.current(first variant) + media.listForProduct[0]
 *   - variantsWithPrices vs variants.listForProduct + per-variant prices.current
 *   - inventoryForSkus (trimmed) + inventoryRowsForSkus (full) vs inventory.get
 *   - relatedSiblings vs the per-sibling decoration loop
 *   - variantsBySkus / variantsByIds / productsByIds maps
 *   - missing-table resilience (inventory dropped → {})
 *   - malformed id → TypeError at entry
 */

var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

function _migs() {
  return ["0001_catalog.sql", "0008_inventory_thresholds.sql", "0043_collections.sql"]
    .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });
}

// Build the per-product "decorated" shape the old home/related loop
// produced from products.get + prices.current(first variant) +
// media.listForProduct[0], so the batched helper can be diffed against it.
async function _perItemDecorated(catalog, productId, currency) {
  var prod = await catalog.products.get(productId);
  if (!prod) return null;
  var variants = await catalog.variants.listForProduct(productId);
  var startingPrice = null;
  if (variants.length) {
    var price = await catalog.prices.current(variants[0].id, currency);
    if (price) startingPrice = price;
  }
  var media = await catalog.media.listForProduct(productId);
  var hero = media.length ? media[0] : null;
  return {
    id:                      prod.id,
    slug:                    prod.slug,
    title:                   prod.title,
    description:             prod.description,
    status:                  prod.status,
    created_at:              prod.created_at,
    updated_at:              prod.updated_at,
    starting_price_minor:    startingPrice ? startingPrice.amount_minor : null,
    starting_price_currency: startingPrice ? startingPrice.currency : "USD",
    hero_media:              hero ? { r2_key: hero.r2_key, alt_text: hero.alt_text || "" } : null,
  };
}

async function _decoratedProducts() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });

  // p1: variant + price + media (the fully-decorated branch).
  var p1 = await catalog.products.create({ slug: "alpha", title: "Alpha", description: "first", status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "ALPHA-1", position: 0 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 1999 });
  await catalog.media.attach({ product_id: p1.id, r2_key: "media/alpha.webp", content_type: "image/webp", position: 0, alt_text: "Alpha shot" });
  // p2: variant, no price → null price; media present.
  var p2 = await catalog.products.create({ slug: "bravo", title: "Bravo", description: "second", status: "active" });
  await catalog.variants.create(p2.id, { sku: "BRAVO-1", position: 0 });
  await catalog.media.attach({ product_id: p2.id, r2_key: "media/bravo.webp", content_type: "image/webp", position: 0 });
  // p3: no variant, no media → all-null branch.
  var p3 = await catalog.products.create({ slug: "charlie", title: "Charlie", description: "third", status: "active" });

  var ids = [p1.id, p2.id, p3.id];
  var batchRes = await catalog.batch.decoratedProducts(ids, "USD");
  for (var i = 0; i < ids.length; i += 1) {
    var expected = await _perItemDecorated(catalog, ids[i], "USD");
    assert.deepStrictEqual(batchRes.byId[ids[i]], expected, "decoratedProducts row " + i + " matches per-item");
  }
  check("decoratedProducts byId covers all ids", Object.keys(batchRes.byId).length === 3);
  check("decoratedProducts p2 null price", batchRes.byId[p2.id].starting_price_minor === null && batchRes.byId[p2.id].starting_price_currency === "USD");
  check("decoratedProducts p3 null hero", batchRes.byId[p3.id].hero_media === null);
  check("decoratedProducts p1 hero alt preserved", batchRes.byId[p1.id].hero_media.alt_text === "Alpha shot");

  // decoratedActive mirrors the active product set (updated_at DESC, id DESC).
  var active = await catalog.batch.decoratedActive({ currency: "USD", limit: 24 });
  check("decoratedActive returns the active products", active.rows.length === 3);
  // Each active row equals its per-item decorated form.
  for (var a = 0; a < active.rows.length; a += 1) {
    var exp = await _perItemDecorated(catalog, active.rows[a].id, "USD");
    assert.deepStrictEqual(active.rows[a], exp, "decoratedActive row " + a + " matches per-item");
  }

  // Empty input → empty maps, no query.
  var empty = await catalog.batch.decoratedProducts([], "USD");
  check("decoratedProducts empty input → empty", empty.rows.length === 0 && Object.keys(empty.byId).length === 0);

  // Malformed id rejects at entry (validation preserved).
  await assert.rejects(catalog.batch.decoratedProducts(["not-a-uuid"], "USD"), /UUID/);
}

async function _variantsWithPrices() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  var p = await catalog.products.create({ slug: "vwp", title: "VWP", status: "active" });
  var v1 = await catalog.variants.create(p.id, { sku: "VWP-1", title: "One", options: { color: "red" }, position: 0 });
  var v2 = await catalog.variants.create(p.id, { sku: "VWP-2", title: "Two", options: { color: "blue" }, position: 1 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  // v2 has NO USD price → must be absent from the prices map.
  await catalog.prices.set(v2.id, { currency: "EUR", amount_minor: 2799 });

  var vwp = await catalog.batch.variantsWithPrices(p.id, "USD");
  var perItem = await catalog.variants.listForProduct(p.id);
  assert.deepStrictEqual(vwp.rows, perItem, "variantsWithPrices.rows deep-equals listForProduct (incl. parsed options)");

  // Per-variant prices map. Compare through JSON so the node:sqlite
  // null-prototype rows (`prices.current` reads `SELECT *`) and the
  // batched helper's constructed price objects compare by VALUE — the
  // shape D1 actually returns over the bridge in production (plain JSON
  // objects on both sides).
  var expectedPrices = {};
  for (var i = 0; i < perItem.length; i += 1) {
    var cur = await catalog.prices.current(perItem[i].id, "USD");
    if (cur) expectedPrices[perItem[i].id] = cur;
  }
  assert.deepStrictEqual(JSON.parse(JSON.stringify(vwp.prices)), JSON.parse(JSON.stringify(expectedPrices)),
    "variantsWithPrices.prices deep-equals per-variant prices.current map");
  check("variantsWithPrices omits unpriced variant", !Object.prototype.hasOwnProperty.call(vwp.prices, v2.id));
  check("variantsWithPrices keeps priced variant", vwp.prices[v1.id].amount_minor === 2999);
}

async function _inventoryForSkus() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  await catalog.inventory.create("INV-A", { stock_on_hand: 10 });
  await catalog.inventory.create("INV-B", { stock_on_hand: 0 });
  await catalog.inventory.setThreshold("INV-A", 3);

  // Trimmed shape (cart) — deep-equals the per-SKU inventory.get
  // restricted to {stock_on_hand, stock_held}.
  var trimmed = await catalog.batch.inventoryForSkus(["INV-A", "INV-B", "INV-MISSING"]);
  var expectedTrim = {};   // INV-MISSING is absent on purpose (no inventory row)
  var a = await catalog.inventory.get("INV-A");
  var bRow = await catalog.inventory.get("INV-B");
  expectedTrim["INV-A"] = { stock_on_hand: a.stock_on_hand, stock_held: a.stock_held };
  expectedTrim["INV-B"] = { stock_on_hand: bRow.stock_on_hand, stock_held: bRow.stock_held };
  assert.deepStrictEqual(trimmed, expectedTrim, "inventoryForSkus trimmed map matches per-SKU get");
  check("inventoryForSkus omits absent SKU (not {stock:0})", !Object.prototype.hasOwnProperty.call(trimmed, "INV-MISSING"));

  // Full-row shape (PDP) — deep-equals the per-SKU inventory.get full row.
  var full = await catalog.batch.inventoryRowsForSkus(["INV-A", "INV-B"]);
  assert.deepStrictEqual(full["INV-A"], a, "inventoryRowsForSkus full row matches inventory.get (INV-A)");
  assert.deepStrictEqual(full["INV-B"], bRow, "inventoryRowsForSkus full row matches inventory.get (INV-B)");
  check("inventoryRowsForSkus carries low_stock_threshold", full["INV-A"].low_stock_threshold === 3);
}

async function _relatedSiblings() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  var query = mem.query;
  var now = Date.now();

  // A manual collection with four members: the focal product + three
  // siblings (one inactive, excluded).
  await query("INSERT INTO collections (slug, type, title, sort_strategy, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ["box", "manual", "Box", "manual", now, now]);

  var focal = await catalog.products.create({ slug: "focal", title: "Focal", status: "active" });
  var sib1 = await catalog.products.create({ slug: "sib-1", title: "Sib One", status: "active" });
  var sib2 = await catalog.products.create({ slug: "sib-2", title: "Sib Two", status: "active" });
  var sibInactive = await catalog.products.create({ slug: "sib-x", title: "Sib X", status: "draft" });

  // sib1: variant + USD price + media (fully decorated card).
  var sv1 = await catalog.variants.create(sib1.id, { sku: "SIB1-1", position: 0 });
  await catalog.prices.set(sv1.id, { currency: "USD", amount_minor: 4999 });
  await catalog.media.attach({ product_id: sib1.id, r2_key: "media/sib1.webp", content_type: "image/webp", position: 0, alt_text: "S1" });
  // sib2: no price, no media (null branch).
  await catalog.variants.create(sib2.id, { sku: "SIB2-1", position: 0 });

  // Membership (position drives order). Use full uuids for member ids.
  var members = [
    [bShop.framework.uuid.v7(), "box", focal.id, 0],
    [bShop.framework.uuid.v7(), "box", sib1.id, 1],
    [bShop.framework.uuid.v7(), "box", sib2.id, 2],
    [bShop.framework.uuid.v7(), "box", sibInactive.id, 3],
  ];
  for (var m = 0; m < members.length; m += 1) {
    await query("INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) VALUES (?1,?2,?3,?4,?5)",
      [members[m][0], members[m][1], members[m][2], members[m][3], now]);
  }

  // Per-item oracle: the old _relatedProductsFor sibling loop.
  var siblingRows = (await query(
    "SELECT cm.product_id AS pid FROM collection_members cm " +
    "JOIN products p ON p.id = cm.product_id " +
    "WHERE cm.collection_slug = ?1 AND cm.product_id != ?2 AND p.status = 'active' " +
    "ORDER BY cm.position ASC, cm.product_id ASC LIMIT ?3",
    ["box", focal.id, 4],
  )).rows;
  var expected = [];
  for (var i = 0; i < siblingRows.length; i += 1) {
    var prod = await catalog.products.get(siblingRows[i].pid);
    var priceMinor = null;
    var priceCurrency = "USD";
    var variants = await catalog.variants.listForProduct(prod.id);
    if (variants.length) {
      var pr = await catalog.prices.current(variants[0].id, "USD");
      if (pr) { priceMinor = pr.amount_minor; priceCurrency = pr.currency; }
    }
    var media = await catalog.media.listForProduct(prod.id);
    var hero = media.length ? media[0] : null;
    expected.push({
      slug:           prod.slug,
      title:          prod.title,
      hero_r2_key:    hero ? hero.r2_key : null,
      hero_alt_text:  hero ? (hero.alt_text || prod.title) : null,
      price_minor:    priceMinor,
      price_currency: priceCurrency,
    });
  }

  var batched = await catalog.batch.relatedSiblings("box", focal.id, "USD", 4);
  assert.deepStrictEqual(batched, expected, "relatedSiblings deep-equals the per-sibling decoration loop");
  check("relatedSiblings excludes self + inactive", batched.length === 2);
  check("relatedSiblings order is membership position", batched[0].slug === "sib-1" && batched[1].slug === "sib-2");

  // Cap at limit.
  var capped = await catalog.batch.relatedSiblings("box", focal.id, "USD", 1);
  check("relatedSiblings caps at limit", capped.length === 1 && capped[0].slug === "sib-1");
}

async function _maps() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  var p = await catalog.products.create({ slug: "maps", title: "Maps", status: "active" });
  var v1 = await catalog.variants.create(p.id, { sku: "MAP-1", options: { a: 1 }, position: 0 });
  var v2 = await catalog.variants.create(p.id, { sku: "MAP-2", options: { a: 2 }, position: 1 });

  var bySku = await catalog.batch.variantsBySkus(["MAP-1", "MAP-2", "MAP-MISSING"]);
  assert.deepStrictEqual(bySku["MAP-1"], await catalog.variants.bySku("MAP-1"), "variantsBySkus matches bySku (MAP-1)");
  check("variantsBySkus parses options", bySku["MAP-2"].options.a === 2);
  check("variantsBySkus omits missing", !Object.prototype.hasOwnProperty.call(bySku, "MAP-MISSING"));

  var byId = await catalog.batch.variantsByIds([v1.id, v2.id]);
  assert.deepStrictEqual(byId[v1.id], await catalog.variants.get(v1.id), "variantsByIds matches get (v1)");
  check("variantsByIds parses options", byId[v2.id].options.a === 2);

  var prods = await catalog.batch.productsByIds([p.id]);
  assert.deepStrictEqual(prods[p.id], await catalog.products.get(p.id), "productsByIds matches products.get");
}

async function _missingTable() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  // Drop the inventory table → both inventory helpers degrade to {}.
  mem.db.prepare("DROP TABLE inventory").run();
  var trimmed = await catalog.batch.inventoryForSkus(["X"]);
  check("inventoryForSkus missing-table → {}", trimmed && Object.keys(trimmed).length === 0);
  var full = await catalog.batch.inventoryRowsForSkus(["X"]);
  check("inventoryRowsForSkus missing-table → {}", full && Object.keys(full).length === 0);

  // Drop collection_members → searchDecorate still returns rows (no
  // collection facet) rather than throwing.
  var p = await catalog.products.create({ slug: "mt", title: "Missing Table Probe", status: "active" });
  await catalog.variants.create(p.id, { sku: "MT-1", position: 0 });
  mem.db.prepare("DROP TABLE collection_members").run();
  var sd = await catalog.batch.searchDecorate({ terms: ["Missing Table Probe"], currency: "USD" });
  check("searchDecorate survives missing collection_members", sd.rows.length === 1 && Array.isArray(sd.rows[0].collection) && sd.rows[0].collection.length === 0);
}

async function run() {
  await _decoratedProducts();
  await _variantsWithPrices();
  await _inventoryForSkus();
  await _relatedSiblings();
  await _maps();
  await _missingTable();
}

module.exports = { run: run };
