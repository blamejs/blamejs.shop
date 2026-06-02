"use strict";
/**
 * Admin batched read helpers — pinned byte-identical to the per-item
 * path each replaces.
 *
 * Layer 1: SQL runs against an in-memory node:sqlite loaded from the
 * live D1 migration files via the shared `helpers.memD1Query`. These
 * back the admin console's product-detail price model (PERF-4) and the
 * collections-list size annotation (PERF-7); the test asserts the
 * batched output deep-equals the per-item read it stands in for, so the
 * rendered admin HTML is unchanged.
 *
 * Coverage:
 *   - catalog.batch.pricesForVariants vs the admin _productDetailModel
 *     per-variant → per-currency (prices.currencies + prices.current +
 *     prices.history) build, including a variant priced in two
 *     currencies with a superseded (closed) price in history, and a
 *     variant with no prices (empty currencies).
 *   - collections.countIn(slug) — exact COUNT(*) for a manual collection
 *     vs the member count; bounded preview for a smart collection.
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

// Build the per-variant price model exactly the way the admin
// _productDetailModel triple-nested loop did, so the batched helper can
// be diffed against it: for each variant, currencies ASC, and per
// currency { current: prices.current, history: prices.history }.
async function _perItemPricesByVariant(catalog, variantIds) {
  var out = {};
  for (var i = 0; i < variantIds.length; i += 1) {
    var vid = variantIds[i];
    var currencies = await catalog.prices.currencies(vid);
    var perCurrency = [];
    for (var j = 0; j < currencies.length; j += 1) {
      var cur = currencies[j];
      perCurrency.push({
        currency: cur,
        current:  await catalog.prices.current(vid, cur),
        history:  await catalog.prices.history(vid, cur),
      });
    }
    out[vid] = { currencies: perCurrency };
  }
  return out;
}

async function _pricesForVariants() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });

  var p = await catalog.products.create({ slug: "pfv", title: "PFV", status: "active" });
  // v1: priced in TWO currencies, USD with a superseded price in history
  // (set twice → the first row is closed, effective_until set).
  var v1 = await catalog.variants.create(p.id, { sku: "PFV-1", position: 0 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 1999 });   // closed by the next set
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 1799 });   // current USD
  await catalog.prices.set(v1.id, { currency: "EUR", amount_minor: 1699 });   // current EUR
  // v2: priced in ONE currency.
  var v2 = await catalog.variants.create(p.id, { sku: "PFV-2", position: 1 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 2999 });
  // v3: NO prices at all → must map to { currencies: [] }.
  var v3 = await catalog.variants.create(p.id, { sku: "PFV-3", position: 2 });

  var variantIds = [v1.id, v2.id, v3.id];
  var batched = await catalog.batch.pricesForVariants(variantIds);
  var expected = await _perItemPricesByVariant(catalog, variantIds);

  // Compare through JSON so the node:sqlite null-prototype rows (the
  // per-item reads do `SELECT *`) and the batched helper's grouped rows
  // compare by VALUE — the plain-JSON shape D1 returns over the bridge.
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(batched)),
    JSON.parse(JSON.stringify(expected)),
    "pricesForVariants deep-equals the per-variant×currency current+history build",
  );

  // Targeted assertions on the multi-currency + history branch.
  check("pricesForVariants covers every input variant", Object.keys(batched).length === 3);
  check("pricesForVariants v1 has two currencies ASC (EUR, USD)",
    batched[v1.id].currencies.length === 2 &&
    batched[v1.id].currencies[0].currency === "EUR" &&
    batched[v1.id].currencies[1].currency === "USD");
  var usd = batched[v1.id].currencies[1];
  check("pricesForVariants v1 USD current is the open (latest) row",
    usd.current && usd.current.amount_minor === 1799 && usd.current.effective_until == null);
  check("pricesForVariants v1 USD history is DESC and includes the closed row",
    usd.history.length === 2 &&
    usd.history[0].amount_minor === 1799 &&
    usd.history[1].amount_minor === 1999 &&
    usd.history[1].effective_until != null);
  check("pricesForVariants v3 (unpriced) → empty currencies",
    Array.isArray(batched[v3.id].currencies) && batched[v3.id].currencies.length === 0);

  // Empty input → empty map (no query).
  var empty = await catalog.batch.pricesForVariants([]);
  check("pricesForVariants empty input → {}", empty && Object.keys(empty).length === 0);

  // Malformed id rejects at entry (validation preserved).
  await assert.rejects(catalog.batch.pricesForVariants(["not-a-uuid"]), /UUID/);
}

async function _countIn() {
  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  var collections = bShop.collections.create({ query: mem.query, catalog: catalog, cursorSecret: "test-countin" });

  // Manual collection with three members.
  await collections.defineManual({ slug: "manual-col", title: "Manual" });
  var pa = await catalog.products.create({ slug: "ca-a", title: "A", status: "active" });
  var pb = await catalog.products.create({ slug: "ca-b", title: "B", status: "active" });
  var pc = await catalog.products.create({ slug: "ca-c", title: "C", status: "active" });
  await collections.addProduct({ collection_slug: "manual-col", product_id: pa.id });
  await collections.addProduct({ collection_slug: "manual-col", product_id: pb.id });
  await collections.addProduct({ collection_slug: "manual-col", product_id: pc.id });

  var manualCount = await collections.countIn("manual-col");
  // Oracle: the raw member count + the prior productsIn(...).rows.length.
  var memberRows = (await mem.query(
    "SELECT COUNT(*) AS n FROM collection_members WHERE collection_slug = ?1", ["manual-col"],
  )).rows[0].n;
  var prior = (await collections.productsIn({ slug: "manual-col", limit: 200 })).rows.length;
  check("countIn manual → { exact } with no approx key",
    manualCount.exact != null && manualCount.approx === undefined);
  check("countIn manual exact equals raw member count", manualCount.exact === Number(memberRows));
  check("countIn manual exact matches prior productsIn count", manualCount.exact === prior);
  check("countIn manual exact is 3", manualCount.exact === 3);

  // Empty manual collection → exact 0.
  await collections.defineManual({ slug: "empty-col", title: "Empty" });
  var emptyCount = await collections.countIn("empty-col");
  check("countIn empty manual → exact 0", emptyCount.exact === 0);

  // Smart collection: bounded preview count (matched set, capped). A
  // created_at >= 0 rule matches every active product (created_at is a
  // numeric column on each product row), so the preview count tracks the
  // active catalog.
  await collections.defineSmart({
    slug: "smart-col", title: "Smart",
    sort_strategy: "newest",
    rules: { all: [{ field: "created_at", op: "gte", value: 0 }] },
  });
  var smartCount = await collections.countIn("smart-col");
  var smartPrior = (await collections.productsIn({ slug: "smart-col", limit: 200 })).rows.length;
  check("countIn smart → { approx } with no exact key",
    smartCount.approx != null && smartCount.exact === undefined);
  check("countIn smart approx matches the bounded productsIn preview", smartCount.approx === smartPrior);

  // Unknown slug throws (caller maps to a 404 / degrades).
  await assert.rejects(collections.countIn("no-such-collection"), /not found/);
}

async function run() {
  await _pricesForVariants();
  await _countIn();
}

module.exports = { run: run };
