"use strict";
/**
 * catalog — products / variants / prices / inventory / media.
 *
 * Layer 1 because every catalog op composes a SQL statement against
 * the externalDb backend. The test runs against an in-memory
 * node:sqlite database loaded from the live D1 migration file
 * `migrations-d1/0001_catalog.sql`, so every CHECK constraint /
 * UNIQUE / FK declared in the schema is exercised end-to-end. If a
 * shipped statement breaks the schema it surfaces here, not in the
 * live D1 hop.
 *
 * Coverage:
 *   - products: create, get, bySlug, list (pagination + status
 *     filter), update, archive/restore
 *   - variants: create, get, bySku, listForProduct (sorted),
 *     update (multi-field), delete
 *   - prices: set (versioning closes prior), current, history
 *   - inventory: create, get, restock, release
 *   - media: attach (product + variant), listForProduct,
 *     listForVariant, delete
 *   - input validation: each shape that can throw TypeError
 *   - FK cascade on variant delete
 */

var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGRATION_PATH = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");

// In-memory node:sqlite query loaded from the live D1 migration, the
// shared `helpers.memD1Query` form (so this test and the batched-read
// tests exercise the same fixture). Returns the `{ rows, rowCount }`
// async query the catalog `create({ query })` factory binds.
function _makeQuery() {
  return helpers.memD1Query(MIGRATION_PATH).query;
}

async function _products() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });

  var p = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "The pro variant", status: "active" });
  check("product.create returns id",        typeof p.id === "string" && p.id.length === 36);
  check("product.create echoes status",     p.status === "active");
  check("product.create stamps timestamps", p.created_at > 0 && p.updated_at === p.created_at);

  var fetched = await catalog.products.get(p.id);
  check("product.get round-trips title", fetched.title === "Widget Pro");

  var bySlug = await catalog.products.bySlug("widget-pro");
  check("product.bySlug matches", bySlug.id === p.id);

  // get() validates the id shape first (b.guardUuid strict), so a
  // non-UUID throws — a valid-but-unknown UUID is the right input
  // to test the "row doesn't exist" path.
  var validButMissing = "00000000-0000-7000-8000-000000000000"; // RFC 9562 v7 nil-ish, valid shape
  var missing = await catalog.products.get(validButMissing);
  check("product.get returns null on miss", missing === null);
  await assert.rejects(catalog.products.get("nope-not-real"), /UUID/);

  var p2 = await catalog.products.create({ slug: "draft-thing", title: "Draft Thing" });
  check("product.create defaults status=draft", p2.status === "draft");

  var threw = false;
  try { await catalog.products.create({ slug: "widget-pro", title: "Dupe" }); }
  catch (_e) { threw = true; }
  check("product.create unique slug enforced", threw);

  await assert.rejects(catalog.products.create({ slug: "Has Spaces", title: "X" }),     /slug must match/);
  await assert.rejects(catalog.products.create({ slug: "widget",     title: "" }),       /title must be/);
  await assert.rejects(catalog.products.create({ slug: "widget",     title: "X", status: "junk" }), /status must be/);

  var u = await catalog.products.update(p.id, { title: "Widget Pro X", status: "active" });
  check("product.update changes title",     u.title === "Widget Pro X");
  check("product.update bumps updated_at",  u.updated_at >= u.created_at);

  var a = await catalog.products.archive(p.id);
  check("product.archive flips status", a.status === "archived");

  var r = await catalog.products.restore(p.id);
  check("product.restore flips status to draft", r.status === "draft");

  await assert.rejects(catalog.products.update(p.id, {}), /no updatable fields/);

  for (var k = 0; k < 5; k += 1) {
    await catalog.products.create({ slug: "x-" + k, title: "Thing " + k, status: "active" });
  }
  var page1 = await catalog.products.list({ status: "active", limit: 3 });
  check("list returns rows",            Array.isArray(page1.rows) && page1.rows.length === 3);
  check("list emits next_cursor",       typeof page1.next_cursor === "string" && page1.next_cursor.length > 0);
  var page2 = await catalog.products.list({ status: "active", limit: 3, cursor: page1.next_cursor });
  check("list paginates by tuple cursor", page2.rows.length > 0);
  var idsP1 = page1.rows.map(function (r) { return r.id; });
  var anyDupe = page2.rows.some(function (r) { return idsP1.indexOf(r.id) !== -1; });
  check("list pagination skips prior page", !anyDupe);
}

async function _search() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });

  await catalog.products.create({ slug: "blue-widget",   title: "Blue Widget",   description: "A sturdy widget in cobalt blue.",  status: "active" });
  await catalog.products.create({ slug: "red-widget",    title: "Red Widget",    description: "A sturdy widget in crimson red.",  status: "active" });
  await catalog.products.create({ slug: "green-gadget",  title: "Green Gadget",  description: "A gadget with eco-friendly trim.",  status: "active" });
  await catalog.products.create({ slug: "draft-thing",   title: "Draft Thing",   description: "Not yet published.",                  status: "draft" });
  await catalog.products.create({ slug: "old-thing",     title: "Old Thing",     description: "Discontinued.",                       status: "archived" });
  await catalog.products.create({ slug: "literal-100",   title: "Literal 100%",  description: "Contains a percent sign literally.",  status: "active" });

  var titleHit = await catalog.products.search({ q: "Widget", status: "active" });
  check("search matches by title",          titleHit.rows.length === 2);
  check("search returns next_cursor=null when under limit", titleHit.next_cursor === null);
  var slugs = titleHit.rows.map(function (r) { return r.slug; }).sort().join(",");
  check("search returns expected widgets",   slugs === "blue-widget,red-widget");

  var descHit = await catalog.products.search({ q: "eco-friendly", status: "active" });
  check("search matches by description",     descHit.rows.length === 1 && descHit.rows[0].slug === "green-gadget");

  var caseHit = await catalog.products.search({ q: "WIDGET", status: "active" });
  check("search is case-insensitive (upper q)", caseHit.rows.length === 2);
  var caseHit2 = await catalog.products.search({ q: "blue", status: "active" });
  check("search is case-insensitive (lower q vs mixed title)", caseHit2.rows.length === 1 && caseHit2.rows[0].slug === "blue-widget");

  var emptyHit = await catalog.products.search({ q: "   ", status: "active" });
  check("search empty (whitespace) q returns empty rows", Array.isArray(emptyHit.rows) && emptyHit.rows.length === 0 && emptyHit.next_cursor === null);
  var emptyHit2 = await catalog.products.search({ q: "", status: "active" });
  check("search empty (\"\") q returns empty rows",       emptyHit2.rows.length === 0);

  // LIKE-metacharacter escape: searching for `100%` matches only the
  // literal `100%` row, not every row (which a non-escaped `%` would
  // produce as a wildcard).
  var literalHit = await catalog.products.search({ q: "100%", status: "active" });
  check("search escapes `%` LIKE wildcard",  literalHit.rows.length === 1 && literalHit.rows[0].slug === "literal-100");
  var underscoreHit = await catalog.products.search({ q: "_idget", status: "active" });
  check("search escapes `_` LIKE wildcard",  underscoreHit.rows.length === 0);

  var noStatus = await catalog.products.search({ q: "Thing" });
  check("search without status returns draft + archived",
    noStatus.rows.length === 2 &&
    noStatus.rows.some(function (r) { return r.status === "draft";    }) &&
    noStatus.rows.some(function (r) { return r.status === "archived"; }));

  // Pagination: seed enough matches to overflow a small page.
  var catalog2 = bShop.catalog.create({ query: _makeQuery() });
  for (var i = 0; i < 7; i += 1) {
    await catalog2.products.create({ slug: "pageable-" + i, title: "Pageable Item " + i, description: "match-me", status: "active" });
  }
  var page1 = await catalog2.products.search({ q: "Pageable", limit: 3 });
  check("search paginates page1",            page1.rows.length === 3 && typeof page1.next_cursor === "string");
  var page2 = await catalog2.products.search({ q: "Pageable", limit: 3, cursor: page1.next_cursor });
  check("search paginates page2 distinct",   page2.rows.length === 3);
  var idsP1 = page1.rows.map(function (r) { return r.id; });
  var anyDupe = page2.rows.some(function (r) { return idsP1.indexOf(r.id) !== -1; });
  check("search pagination skips prior page", !anyDupe);

  await assert.rejects(catalog.products.search({ q: 42 }),                  /q must be a string/);
  await assert.rejects(catalog.products.search({ q: "a".repeat(201) }),    /≤ 200/);
  await assert.rejects(catalog.products.search({ q: "x", status: "junk" }), /status must be/);
  await assert.rejects(catalog.products.search({ q: "x", limit: 0 }),       /limit must be 1\.\.\./);
  await assert.rejects(catalog.products.search({ q: "x", limit: 1000 }),    /limit must be 1\.\.\./);
}

async function _variants() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var p = await catalog.products.create({ slug: "v-test", title: "VT", status: "active" });

  var v = await catalog.variants.create(p.id, {
    sku:               "VT-BLK-L",
    title:             "Black / Large",
    options:           { color: "black", size: "L" },
    weight_grams:      250,
    requires_shipping: true,
    position:          0,
  });
  check("variant.create returns id",        typeof v.id === "string" && v.id.length === 36);
  check("variant.options round-trips JSON", v.options.color === "black" && v.options.size === "L");
  check("variant.requires_shipping → INT",  v.requires_shipping === 1);

  var bySku = await catalog.variants.bySku("VT-BLK-L");
  check("variant.bySku matches", bySku.id === v.id);

  var threw = false;
  try { await catalog.variants.create(p.id, { sku: "VT-BLK-L" }); } catch (_e) { threw = true; }
  check("variant.create unique sku enforced", threw);

  await assert.rejects(catalog.variants.create(p.id, { sku: "spaces in sku" }), /sku must match/);

  await catalog.variants.create(p.id, { sku: "VT-BLK-M", position: 1 });
  await catalog.variants.create(p.id, { sku: "VT-BLK-S", position: 2 });
  var list = await catalog.variants.listForProduct(p.id);
  check("variant.listForProduct returns 3",          list.length === 3);
  check("variant.listForProduct sorted by position",
    list[0].sku === "VT-BLK-L" && list[1].sku === "VT-BLK-M" && list[2].sku === "VT-BLK-S");

  var u = await catalog.variants.update(v.id, { weight_grams: 300, options: { color: "black", size: "XL" } });
  check("variant.update changes weight",     u.weight_grams === 300);
  check("variant.update reserializes opts",  u.options.size === "XL");

  var ok = await catalog.variants.delete(v.id);
  check("variant.delete returns true",       ok === true);
  var gone = await catalog.variants.get(v.id);
  check("variant.delete actually removes",   gone === null);
}

async function _prices() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var p = await catalog.products.create({ slug: "pp", title: "PP", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "PP-1" });

  var p1 = await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2999 });
  check("price.set returns active row", p1.amount_minor === 2999 && p1.effective_until === null);
  var c1 = await catalog.prices.current(v.id, "USD");
  check("price.current returns latest", c1.amount_minor === 2999);

  var p2 = await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2499 });
  check("price.set closes prior",      p2.amount_minor === 2499);
  var c2 = await catalog.prices.current(v.id, "USD");
  check("price.current reflects new",  c2.amount_minor === 2499);

  var hist = await catalog.prices.history(v.id, "USD");
  check("price.history returns both rows",  hist.length === 2);
  check("price.history newest-first",        hist[0].amount_minor === 2499);
  check("price.history closes prior row",    hist[1].effective_until !== null);

  await catalog.prices.set(v.id, { currency: "EUR", amount_minor: 2799 });
  var usdNow = await catalog.prices.current(v.id, "USD");
  var eurNow = await catalog.prices.current(v.id, "EUR");
  check("price.current isolates currency", usdNow.amount_minor === 2499 && eurNow.amount_minor === 2799);

  var curs = await catalog.prices.currencies(v.id);
  check("price.currencies lists both, sorted", curs.length === 2 && curs[0] === "EUR" && curs[1] === "USD");
  var none = await catalog.prices.currencies(bShop.framework.uuid.v7());
  check("price.currencies empty for unpriced variant", none.length === 0);

  await assert.rejects(catalog.prices.set(v.id, { currency: "usd", amount_minor: 1 }),   /ISO 4217/);
  await assert.rejects(catalog.prices.set(v.id, { currency: "USD", amount_minor: -1 }),  /amount_minor must be a non-negative/);
  await assert.rejects(catalog.prices.set(v.id, { currency: "USD", amount_minor: 1.5 }), /amount_minor must be a non-negative/);
}

async function _inventory() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });

  var inv = await catalog.inventory.create("WDG-001", { stock_on_hand: 100 });
  check("inventory.create returns row", inv.stock_on_hand === 100 && inv.stock_held === 0);

  var got = await catalog.inventory.get("WDG-001");
  check("inventory.get returns row", got.stock_on_hand === 100);

  var miss = await catalog.inventory.get("NOT-A-SKU");
  check("inventory.get returns null on miss", miss === null);

  var restocked = await catalog.inventory.restock("WDG-001", 50);
  check("inventory.restock adds", restocked.stock_on_hand === 150);

  var released = await catalog.inventory.release("WDG-001", 5);
  check("inventory.release floors at 0 stock_held", released.stock_held === 0);

  await assert.rejects(catalog.inventory.restock("WDG-001", 0),  /qty must be a positive integer/);
  await assert.rejects(catalog.inventory.restock("WDG-001", -5), /qty must be a positive integer/);
}

async function _media() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var p = await catalog.products.create({ slug: "media-p", title: "MP", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "MP-1" });

  var m1 = await catalog.media.attach({
    product_id:   p.id,
    r2_key:       "media/mp/main.webp",
    content_type: "image/webp",
    width:        1200,
    height:       1200,
    position:     0,
    alt_text:     "Main shot",
  });
  check("media.attach returns id",      typeof m1.id === "string");
  check("media.attach echoes r2_key",   m1.r2_key === "media/mp/main.webp");

  var m2 = await catalog.media.attach({
    variant_id:   v.id,
    r2_key:       "media/mp/v1.webp",
    content_type: "image/webp",
    width:        800,
    height:       800,
  });
  check("media.attach variant-scoped works", m2.variant_id === v.id);

  var prodMedia = await catalog.media.listForProduct(p.id);
  check("media.listForProduct returns product-scoped", prodMedia.length === 1 && prodMedia[0].id === m1.id);

  var varMedia = await catalog.media.listForVariant(v.id);
  check("media.listForVariant returns variant-scoped", varMedia.length === 1 && varMedia[0].id === m2.id);

  var gotMedia = await catalog.media.get(m1.id);
  check("media.get returns the row", gotMedia && gotMedia.id === m1.id && gotMedia.product_id === p.id);
  var missMedia = await catalog.media.get(bShop.framework.uuid.v7());
  check("media.get returns null for unknown id", missMedia === null);

  var deleted = await catalog.media.delete(m1.id);
  check("media.delete returns true", deleted === true);
  var after = await catalog.media.listForProduct(p.id);
  check("media.delete actually removes", after.length === 0);

  await assert.rejects(catalog.media.attach({ r2_key: "x", content_type: "image/png" }),
    /one of product_id \/ variant_id/);
  await assert.rejects(catalog.media.attach({ product_id: p.id, r2_key: "../escape", content_type: "image/png" }),
    /must not contain '\.\.'/);
  await assert.rejects(catalog.media.attach({ product_id: p.id, r2_key: "ok", content_type: "not a mime" }),
    /content_type/);
}

async function _cascadeDelete() {
  var catalog = bShop.catalog.create({ query: _makeQuery() });
  var p = await catalog.products.create({ slug: "casc", title: "Casc", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "CASC-1" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 100 });
  await catalog.media.attach({ variant_id: v.id, r2_key: "k", content_type: "image/png" });

  await catalog.variants.delete(v.id);
  var c = await catalog.prices.current(v.id, "USD");
  check("price cascades on variant delete", c === null);
  var mv = await catalog.media.listForVariant(v.id);
  check("variant media cascades on variant delete", mv.length === 0);
}

async function run() {
  await _products();
  await _search();
  await _variants();
  await _prices();
  await _inventory();
  await _media();
  await _cascadeDelete();
}

module.exports = { run: run };
