"use strict";
/**
 * collections — operator-curated + smart-rule product lists.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * `migrations-d1/0043_collections.sql`. The catalog dependency is
 * injected via a lightweight mock so the test can stuff products
 * with the fields a smart-rule evaluator reads — `tags`, `vendor`,
 * `category`, `price_minor`, `inventory_count`, `created_at`,
 * `sales_rank` — without bending the live catalog migration into
 * shapes it doesn't own. The primitive treats the catalog as an
 * opaque enumerator + by-id getter; the mock satisfies that
 * contract.
 *
 * Pins:
 *   - defineManual happy path + slug collision refused
 *   - defineSmart with all/any rules persists + serialises
 *   - evaluateRules covers every op (eq/neq/contains/gt/gte/lt/lte/
 *     in/not_in/between)
 *   - rule validation refuses bad shape, wrong op-for-field
 *   - addProduct / removeProduct / reorderProducts (manual only)
 *   - membership writes refused on smart collections
 *   - productsIn manual: cursor pagination + tamper-refused cursor
 *   - productsIn smart: rules + each sort strategy
 *   - productsIn smart: offset cursor walks the matched list
 *   - collectionsForProduct: manual + smart unioned, archived hidden
 *   - update mutates allow-listed columns, refuses unknown
 *   - archive hides from active_only listing
 *   - factory refuses missing catalog
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var collections = require("../../lib/collections");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0043_collections.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Mock catalog: an in-memory product map keyed by id. `products.list`
// honours an opaque-string cursor that encodes the offset; the
// primitive treats `next_cursor` opaquely, so a JSON-encoded offset
// is the simplest contract that still exercises pagination.
function _makeMockCatalog(initial) {
  var store = Object.create(null);
  (initial || []).forEach(function (p) { store[p.id] = p; });

  function _allActive() {
    var out = [];
    var keys = Object.keys(store).sort();
    for (var i = 0; i < keys.length; i += 1) {
      var p = store[keys[i]];
      if (p.status === "active") out.push(p);
    }
    return out;
  }

  return {
    _add: function (p) { store[p.id] = p; },
    _get: function (id) { return store[id] || null; },
    products: {
      list: async function (opts) {
        opts = opts || {};
        var limit = opts.limit || 50;
        var offset = 0;
        if (opts.cursor != null) {
          try { offset = JSON.parse(opts.cursor).offset; }
          catch (_e) { offset = 0; }
        }
        var all = _allActive();
        var slice = all.slice(offset, offset + limit);
        var next = (offset + slice.length < all.length)
          ? JSON.stringify({ offset: offset + slice.length })
          : null;
        return { rows: slice, next_cursor: next };
      },
      get: async function (id) {
        return store[id] || null;
      },
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _mkProduct(overrides) {
  var base = {
    id:              _uuid(),
    title:           "Product",
    status:          "active",
    tags:            [],
    vendor:          "acme",
    category:        "general",
    price_minor:     1000,
    inventory_count: 10,
    created_at:      Date.now(),
    sales_rank:      0,
  };
  if (overrides) {
    Object.keys(overrides).forEach(function (k) { base[k] = overrides[k]; });
  }
  return base;
}

// ---- defineManual ------------------------------------------------------

async function _defineManualHappy() {
  var q = _makeQuery();
  var cat = _makeMockCatalog([]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  var def = await c.defineManual({
    slug: "summer-favorites",
    title: "Summer Favorites",
    description: "Hand-picked summer essentials",
    hero_image_url: "https://example.test/hero.jpg",
  });
  check("defineManual returns slug",                def.slug === "summer-favorites");
  check("defineManual type=manual",                 def.type === "manual");
  check("defineManual title",                       def.title === "Summer Favorites");
  check("defineManual description",                 def.description === "Hand-picked summer essentials");
  check("defineManual hero_image_url",              def.hero_image_url === "https://example.test/hero.jpg");
  check("defineManual rules=null",                  def.rules === null);
  check("defineManual default sort=manual",         def.sort_strategy === "manual");
  check("defineManual archived_at=null",            def.archived_at == null);

  var got = await c.get("summer-favorites");
  check("get round-trip",                            got && got.slug === "summer-favorites");
  check("get returns null on miss",                  (await c.get("nope")) === null);

  // Duplicate slug refuses
  await assert.rejects(c.defineManual({
    slug: "summer-favorites", title: "x",
  }), /already exists/);

  // Bad-shape input
  await assert.rejects(c.defineManual(),                 /input object required/);
  await assert.rejects(c.defineManual({}),               /slug/);
  await assert.rejects(c.defineManual({ slug: "BAD SLUG", title: "x" }), /slug/);
  await assert.rejects(c.defineManual({ slug: "ok", title: "" }), /title/);
  await assert.rejects(c.defineManual({ slug: "ok", title: "x", sort_strategy: "bogus" }), /sort_strategy/);
  await assert.rejects(c.defineManual({ slug: "ok", title: "x", hero_image_url: "ok\nbad" }), /control bytes/);
}

// ---- defineSmart -------------------------------------------------------

async function _defineSmartHappy() {
  var q = _makeQuery();
  var cat = _makeMockCatalog([]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  var def = await c.defineSmart({
    slug: "sale-under-50",
    title: "Sale under $50",
    rules: {
      all: [
        { field: "tags", op: "contains", value: "sale" },
        { field: "price_minor", op: "lt", value: 5000 },
      ],
    },
    sort_strategy: "price_asc",
  });
  check("defineSmart type=smart",                    def.type === "smart");
  check("defineSmart rules round-trip",              def.rules.all.length === 2);
  check("defineSmart rules.all[0].field",            def.rules.all[0].field === "tags");
  check("defineSmart sort_strategy=price_asc",       def.sort_strategy === "price_asc");

  // sort_strategy=manual refused on smart
  await assert.rejects(c.defineSmart({
    slug: "x", title: "x",
    rules: { all: [{ field: "tags", op: "contains", value: "x" }] },
    sort_strategy: "manual",
  }), /sort_strategy 'manual'/);

  // Missing sort_strategy refused
  await assert.rejects(c.defineSmart({
    slug: "x2", title: "x",
    rules: { all: [{ field: "tags", op: "contains", value: "x" }] },
  }), /sort_strategy is required/);

  // Empty rules refused (would match the whole catalog)
  await assert.rejects(c.defineSmart({
    slug: "x3", title: "x", rules: { all: [], any: [] }, sort_strategy: "newest",
  }), /at least one rule/);

  // Bad rule shape
  await assert.rejects(c.defineSmart({
    slug: "x4", title: "x",
    rules: { all: [{ field: "bogus_field", op: "eq", value: 1 }] },
    sort_strategy: "newest",
  }), /field must be one of/);
  await assert.rejects(c.defineSmart({
    slug: "x5", title: "x",
    rules: { all: [{ field: "tags", op: "bogus_op", value: 1 }] },
    sort_strategy: "newest",
  }), /op must be one of/);
  // contains on non-array field
  await assert.rejects(c.defineSmart({
    slug: "x6", title: "x",
    rules: { all: [{ field: "vendor", op: "contains", value: "x" }] },
    sort_strategy: "newest",
  }), /requires an array field/);
  // gt on non-numeric field
  await assert.rejects(c.defineSmart({
    slug: "x7", title: "x",
    rules: { all: [{ field: "tags", op: "gt", value: 1 }] },
    sort_strategy: "newest",
  }), /requires a numeric field/);
  // between with bad shape
  await assert.rejects(c.defineSmart({
    slug: "x8", title: "x",
    rules: { all: [{ field: "price_minor", op: "between", value: 50 }] },
    sort_strategy: "newest",
  }), /\[lo, hi\] numbers/);
  // in with non-array value
  await assert.rejects(c.defineSmart({
    slug: "x9", title: "x",
    rules: { all: [{ field: "vendor", op: "in", value: "acme" }] },
    sort_strategy: "newest",
  }), /'in'/);
}

// ---- evaluateRules covers every op -------------------------------------

async function _evaluateRulesAllOps() {
  var q = _makeQuery();
  var cat = _makeMockCatalog([]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  var p = _mkProduct({
    tags: ["sale", "new"],
    vendor: "acme",
    category: "shoes",
    price_minor: 4500,
    inventory_count: 7,
    created_at: 2_000_000_000_000,
  });

  // eq
  check("eq vendor=acme",                            c.evaluateRules({ rules: { all: [{ field: "vendor", op: "eq", value: "acme" }] }, product: p }) === true);
  check("eq vendor=other",                           c.evaluateRules({ rules: { all: [{ field: "vendor", op: "eq", value: "other" }] }, product: p }) === false);
  // neq
  check("neq category!=hats",                        c.evaluateRules({ rules: { all: [{ field: "category", op: "neq", value: "hats" }] }, product: p }) === true);
  // contains (array field)
  check("contains tags has 'sale'",                  c.evaluateRules({ rules: { all: [{ field: "tags", op: "contains", value: "sale" }] }, product: p }) === true);
  check("contains tags missing 'clearance'",         c.evaluateRules({ rules: { all: [{ field: "tags", op: "contains", value: "clearance" }] }, product: p }) === false);
  // gt/gte/lt/lte (numeric)
  check("gt price_minor > 4000",                     c.evaluateRules({ rules: { all: [{ field: "price_minor", op: "gt",  value: 4000 }] }, product: p }) === true);
  check("gte price_minor >= 4500",                   c.evaluateRules({ rules: { all: [{ field: "price_minor", op: "gte", value: 4500 }] }, product: p }) === true);
  check("lt price_minor < 4500 false",               c.evaluateRules({ rules: { all: [{ field: "price_minor", op: "lt",  value: 4500 }] }, product: p }) === false);
  check("lte price_minor <= 4500",                   c.evaluateRules({ rules: { all: [{ field: "price_minor", op: "lte", value: 4500 }] }, product: p }) === true);
  // in / not_in
  check("in vendor in [acme, foo]",                  c.evaluateRules({ rules: { all: [{ field: "vendor", op: "in",     value: ["acme", "foo"] }] }, product: p }) === true);
  check("not_in vendor not_in [foo]",                c.evaluateRules({ rules: { all: [{ field: "vendor", op: "not_in", value: ["foo"] }] }, product: p }) === true);
  check("not_in vendor not_in [acme] false",         c.evaluateRules({ rules: { all: [{ field: "vendor", op: "not_in", value: ["acme"] }] }, product: p }) === false);
  // between
  check("between 4000..5000",                        c.evaluateRules({ rules: { all: [{ field: "price_minor", op: "between", value: [4000, 5000] }] }, product: p }) === true);
  check("between 5000..6000 false",                  c.evaluateRules({ rules: { all: [{ field: "price_minor", op: "between", value: [5000, 6000] }] }, product: p }) === false);

  // ALL + ANY composition: must satisfy every ALL plus at least one ANY
  var rules = {
    all: [{ field: "vendor", op: "eq", value: "acme" }],
    any: [{ field: "tags", op: "contains", value: "sale" }, { field: "tags", op: "contains", value: "clearance" }],
  };
  check("all+any composed match",                    c.evaluateRules({ rules: rules, product: p }) === true);
  var p2 = _mkProduct({ vendor: "acme", tags: ["clearance"] });
  check("all+any other tag matches via any",         c.evaluateRules({ rules: rules, product: p2 }) === true);
  var p3 = _mkProduct({ vendor: "acme", tags: [] });
  check("all match but any fails -> false",          c.evaluateRules({ rules: rules, product: p3 }) === false);
  var p4 = _mkProduct({ vendor: "other", tags: ["sale"] });
  check("all fails -> false even when any matches",  c.evaluateRules({ rules: rules, product: p4 }) === false);

  // Empty any group -> vacuous true (constraint is in `all`)
  check("empty any vacuously true",                  c.evaluateRules({ rules: { all: [{ field: "vendor", op: "eq", value: "acme" }] }, product: p }) === true);

  // Empty all group -> vacuous true (constraint is in `any`)
  check("empty all + any matches",                   c.evaluateRules({ rules: { any: [{ field: "vendor", op: "eq", value: "acme" }] }, product: p }) === true);

  // contains on a product without the array field -> false (not crash)
  var noTags = _mkProduct({ tags: undefined });
  check("contains on missing array -> false",        c.evaluateRules({ rules: { all: [{ field: "tags", op: "contains", value: "sale" }] }, product: noTags }) === false);

  // Bad evaluateRules input
  await assert.rejects(async function () { c.evaluateRules(); }, /input object required/);
  await assert.rejects(async function () { c.evaluateRules({ rules: { all: [{ field: "tags", op: "contains", value: "x" }] } }); }, /product object required/);
}

// ---- manual membership writes ------------------------------------------

async function _manualMembership() {
  var q = _makeQuery();
  var cat = _makeMockCatalog([]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  await c.defineManual({ slug: "picks", title: "Editor Picks" });
  var p1 = _uuid(), p2 = _uuid(), p3 = _uuid();
  cat._add(_mkProduct({ id: p1, title: "Alpha" }));
  cat._add(_mkProduct({ id: p2, title: "Bravo" }));
  cat._add(_mkProduct({ id: p3, title: "Charlie" }));

  var a1 = await c.addProduct({ collection_slug: "picks", product_id: p1 });
  check("addProduct returns id",                    typeof a1.id === "string");
  check("addProduct auto-positions at 0",           a1.position === 0);
  var a2 = await c.addProduct({ collection_slug: "picks", product_id: p2 });
  check("addProduct second auto-positions at 1",    a2.position === 1);
  await c.addProduct({ collection_slug: "picks", product_id: p3 });

  // Duplicate add refused
  await assert.rejects(c.addProduct({ collection_slug: "picks", product_id: p1 }), /already a member/);

  // Bad position
  await assert.rejects(c.addProduct({ collection_slug: "picks", product_id: _uuid(), position: -1 }), /non-negative integer/);
  await assert.rejects(c.addProduct({ collection_slug: "picks", product_id: _uuid(), position: 1.5 }), /non-negative integer/);

  // Reorder: reverse the order
  await c.reorderProducts({
    collection_slug: "picks",
    ordered_product_ids: [p3, p2, p1],
  });
  var listed = await c.productsIn({ slug: "picks" });
  check("reorder p3 first",                          listed.rows[0].product_id === p3);
  check("reorder p2 middle",                         listed.rows[1].product_id === p2);
  check("reorder p1 last",                           listed.rows[2].product_id === p1);
  check("reorder positions densely 0..N-1",          listed.rows[0].position === 0 && listed.rows[1].position === 1 && listed.rows[2].position === 2);

  // Partial reorder refused
  await assert.rejects(c.reorderProducts({
    collection_slug: "picks", ordered_product_ids: [p3, p2],
  }), /every current member/);
  // Reorder with unknown product refused
  await assert.rejects(c.reorderProducts({
    collection_slug: "picks", ordered_product_ids: [p3, p2, _uuid()],
  }), /not a member/);
  // Duplicate id in reorder refused
  await assert.rejects(c.reorderProducts({
    collection_slug: "picks", ordered_product_ids: [p3, p3, p1],
  }), /duplicate/);

  // Remove
  var removed = await c.removeProduct({ collection_slug: "picks", product_id: p2 });
  check("removeProduct returns true",                removed === true);
  var listed2 = await c.productsIn({ slug: "picks" });
  check("removeProduct shrinks list",                listed2.rows.length === 2);
  var removedAgain = await c.removeProduct({ collection_slug: "picks", product_id: p2 });
  check("removeProduct second call returns false",   removedAgain === false);

  // ---- membership refused on smart ------------------------------------

  await c.defineSmart({
    slug: "sale-stuff", title: "Sale",
    rules: { all: [{ field: "tags", op: "contains", value: "sale" }] },
    sort_strategy: "newest",
  });
  await assert.rejects(c.addProduct({ collection_slug: "sale-stuff", product_id: p1 }), /smart collection/);
  await assert.rejects(c.removeProduct({ collection_slug: "sale-stuff", product_id: p1 }), /smart collection/);
  await assert.rejects(c.reorderProducts({ collection_slug: "sale-stuff", ordered_product_ids: [p1] }), /smart collection/);

  // Membership writes against unknown collection
  await assert.rejects(c.addProduct({ collection_slug: "no-such", product_id: p1 }), /not found/);

  // Archived collection refuses addProduct
  await c.archive("picks");
  await assert.rejects(c.addProduct({ collection_slug: "picks", product_id: _uuid() }), /archived/);
}

// ---- productsIn manual pagination + cursor tamper ----------------------

async function _manualPagination() {
  var q = _makeQuery();
  var cat = _makeMockCatalog([]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "page-secret" });

  await c.defineManual({ slug: "many", title: "Many" });
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var pid = _uuid();
    ids.push(pid);
    cat._add(_mkProduct({ id: pid, title: "P" + i }));
    await c.addProduct({ collection_slug: "many", product_id: pid });
  }

  var page1 = await c.productsIn({ slug: "many", limit: 2 });
  check("manual page1 rows",                         page1.rows.length === 2);
  check("manual page1 cursor present",               typeof page1.next_cursor === "string");
  var page2 = await c.productsIn({ slug: "many", limit: 2, cursor: page1.next_cursor });
  check("manual page2 rows",                         page2.rows.length === 2);
  check("manual page2 distinct",                     page1.rows[0].product_id !== page2.rows[0].product_id);
  var page3 = await c.productsIn({ slug: "many", limit: 2, cursor: page2.next_cursor });
  check("manual page3 last row",                     page3.rows.length === 1);
  check("manual page3 cursor null",                  page3.next_cursor === null);

  // Tampered cursor refused.
  var dot = page1.next_cursor.indexOf(".");
  var tampered = page1.next_cursor.slice(0, dot + 1) +
    page1.next_cursor.slice(dot + 1).split("").reverse().join("");
  if (tampered === page1.next_cursor) {
    tampered = page1.next_cursor.slice(0, dot + 1) + "AAAA" + page1.next_cursor.slice(dot + 1);
  }
  await assert.rejects(c.productsIn({ slug: "many", limit: 2, cursor: tampered }), /cursor/);

  // Cursor minted under a different secret refuses.
  var c2 = collections.create({ query: q, catalog: cat, cursorSecret: "other" });
  await assert.rejects(c2.productsIn({ slug: "many", limit: 2, cursor: page1.next_cursor }), /cursor/);

  // Bad limit
  await assert.rejects(c.productsIn({ slug: "many", limit: 0 }), /limit/);
  await assert.rejects(c.productsIn({ slug: "many", limit: 9999 }), /limit/);
  await assert.rejects(c.productsIn({ slug: "many", cursor: 42 }), /cursor must be an opaque string/);
}

// ---- productsIn smart with rules + each sort strategy ------------------

async function _smartProductsInSortStrategies() {
  var q = _makeQuery();
  var saleA = _mkProduct({ title: "Alpha sale",    tags: ["sale"], price_minor: 1000, created_at: 100, sales_rank: 5 });
  var saleB = _mkProduct({ title: "Charlie sale",  tags: ["sale"], price_minor: 4500, created_at: 300, sales_rank: 10 });
  var saleC = _mkProduct({ title: "Bravo sale",    tags: ["sale"], price_minor: 2500, created_at: 200, sales_rank: 1 });
  var noise = _mkProduct({ title: "Not on sale",   tags: ["regular"], price_minor: 1500, created_at: 400 });
  var cat = _makeMockCatalog([saleA, saleB, saleC, noise]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  await c.defineSmart({
    slug: "sale",
    title: "On Sale",
    rules: { all: [{ field: "tags", op: "contains", value: "sale" }] },
    sort_strategy: "price_asc",
  });

  var asc = await c.productsIn({ slug: "sale" });
  check("smart type=smart",                          asc.type === "smart");
  check("smart sort_strategy returned",              asc.sort_strategy === "price_asc");
  check("smart matched count = 3",                   asc.rows.length === 3);
  check("smart price_asc[0] = Alpha (1000)",         asc.rows[0].id === saleA.id);
  check("smart price_asc[1] = Bravo (2500)",         asc.rows[1].id === saleC.id);
  check("smart price_asc[2] = Charlie (4500)",       asc.rows[2].id === saleB.id);

  // price_desc
  await c.update("sale", { sort_strategy: "price_desc" });
  var desc = await c.productsIn({ slug: "sale" });
  check("smart price_desc[0] = Charlie",             desc.rows[0].id === saleB.id);

  // newest
  await c.update("sale", { sort_strategy: "newest" });
  var newest = await c.productsIn({ slug: "sale" });
  check("smart newest[0] = Charlie (created_at 300)", newest.rows[0].id === saleB.id);

  // alphabetical (title)
  await c.update("sale", { sort_strategy: "alphabetical" });
  var alpha = await c.productsIn({ slug: "sale" });
  check("smart alphabetical[0] = Alpha sale",        alpha.rows[0].id === saleA.id);
  check("smart alphabetical[1] = Bravo sale",        alpha.rows[1].id === saleC.id);
  check("smart alphabetical[2] = Charlie sale",      alpha.rows[2].id === saleB.id);

  // best_selling (sales_rank desc)
  await c.update("sale", { sort_strategy: "best_selling" });
  var best = await c.productsIn({ slug: "sale" });
  check("smart best_selling[0] = Charlie (rank 10)", best.rows[0].id === saleB.id);
  check("smart best_selling[1] = Alpha (rank 5)",    best.rows[1].id === saleA.id);

  // Smart cursor walks the matched list.
  await c.update("sale", { sort_strategy: "price_asc" });
  var sp1 = await c.productsIn({ slug: "sale", limit: 2 });
  check("smart cursor page1 rows",                   sp1.rows.length === 2);
  check("smart cursor page1 next present",           typeof sp1.next_cursor === "string");
  var sp2 = await c.productsIn({ slug: "sale", limit: 2, cursor: sp1.next_cursor });
  check("smart cursor page2 final row",              sp2.rows.length === 1);
  check("smart cursor page2 next null",              sp2.next_cursor === null);
  check("smart cursor page2 distinct from page1",    sp1.rows[0].id !== sp2.rows[0].id);
}

// ---- collectionsForProduct (manual + smart union) ----------------------

async function _collectionsForProduct() {
  var q = _makeQuery();
  var saleProd = _mkProduct({ title: "Sale item", tags: ["sale"], price_minor: 1500 });
  var plainProd = _mkProduct({ title: "Plain", tags: [] });
  var cat = _makeMockCatalog([saleProd, plainProd]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  await c.defineManual({ slug: "picks", title: "Picks" });
  await c.addProduct({ collection_slug: "picks", product_id: saleProd.id });
  await c.addProduct({ collection_slug: "picks", product_id: plainProd.id });
  await c.defineSmart({
    slug: "sale",
    title: "Sale",
    rules: { all: [{ field: "tags", op: "contains", value: "sale" }] },
    sort_strategy: "newest",
  });
  await c.defineSmart({
    slug: "cheap",
    title: "Cheap",
    rules: { all: [{ field: "price_minor", op: "lt", value: 2000 }] },
    sort_strategy: "price_asc",
  });

  var forSale = await c.collectionsForProduct(saleProd.id);
  var slugs = forSale.map(function (r) { return r.slug; }).sort();
  check("collectionsForProduct includes manual picks", slugs.indexOf("picks") >= 0);
  check("collectionsForProduct includes smart sale",   slugs.indexOf("sale") >= 0);
  check("collectionsForProduct includes smart cheap",  slugs.indexOf("cheap") >= 0);
  check("collectionsForProduct count = 3",             forSale.length === 3);

  var forPlain = await c.collectionsForProduct(plainProd.id);
  var plainSlugs = forPlain.map(function (r) { return r.slug; }).sort();
  check("plain in manual picks",                       plainSlugs.indexOf("picks") >= 0);
  check("plain in cheap (price < 2000)",               plainSlugs.indexOf("cheap") >= 0);
  check("plain NOT in sale (no sale tag)",             plainSlugs.indexOf("sale") < 0);

  // Archive picks — it should drop out of the reverse lookup.
  await c.archive("picks");
  var afterArchive = await c.collectionsForProduct(saleProd.id);
  var afterSlugs = afterArchive.map(function (r) { return r.slug; });
  check("archive hides from collectionsForProduct",    afterSlugs.indexOf("picks") < 0);
  // active_only filtering in list()
  var allList = await c.list({});
  var activeList = await c.list({ active_only: true });
  check("list() unfiltered includes archived",         allList.length >= 3);
  check("list({active_only}) excludes archived",       activeList.every(function (r) { return r.archived_at == null; }));
}

// ---- update + factory guards + production-cursorSecret ----------------

async function _updateAndArchiveAndFactory() {
  var q = _makeQuery();
  var cat = _makeMockCatalog([]);
  var c = collections.create({ query: q, catalog: cat, cursorSecret: "s" });

  // Empty patch refused
  await c.defineManual({ slug: "k", title: "k" });
  await assert.rejects(c.update("k", {}), /no updatable fields/);

  // Update missing returns null
  check("update missing returns null",               (await c.update("nope-z", { title: "x" })) === null);

  // Title-only update
  await new Promise(function (r) { setTimeout(r, 5); });   // allow:test-promise-settimeout-sleep — millisecond clock pulse for updated_at monotonicity
  var u1 = await c.update("k", { title: "new title" });
  check("update title patched",                      u1.title === "new title");

  // rules patch refused on manual
  await assert.rejects(c.update("k", { rules: { all: [{ field: "tags", op: "contains", value: "x" }] } }), /only valid for smart/);

  // Smart rules patch happy path
  await c.defineSmart({
    slug: "s1", title: "s",
    rules: { all: [{ field: "tags", op: "contains", value: "x" }] },
    sort_strategy: "newest",
  });
  var su = await c.update("s1", {
    rules: { all: [{ field: "tags", op: "contains", value: "sale" }, { field: "price_minor", op: "lt", value: 1000 }] },
  });
  check("smart update rules persists",               su.rules.all.length === 2);
  check("smart update rule value",                   su.rules.all[0].value === "sale");

  // sort_strategy=manual refused on smart via update
  await assert.rejects(c.update("s1", { sort_strategy: "manual" }), /sort_strategy 'manual'/);

  // archive twice — second call returns the row but doesn't re-stamp
  await c.archive("s1");
  var second = await c.archive("s1");
  check("archive twice returns row not null",        second && second.slug === "s1");
  // archive non-existent returns null
  check("archive missing returns null",              (await c.archive("never")) === null);

  // Factory guards
  assert.throws(function () { collections.create({}); },                            /catalog/);
  assert.throws(function () { collections.create({ catalog: {} }); },               /catalog/);
  assert.throws(function () { collections.create({ catalog: { products: {} } }); }, /catalog/);

  // Production requires cursorSecret
  var prev = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var threw = false;
    try { collections.create({ query: q, catalog: cat }); }
    catch (e) { threw = /cursorSecret/.test(e.message); }
    check("create throws in production without cursorSecret", threw === true);
    var prod = collections.create({ query: q, catalog: cat, cursorSecret: "real" });
    check("create accepts cursorSecret in production",        typeof prod.defineManual === "function");
  } finally {
    process.env.NODE_ENV = prev;
  }
}

async function run() {
  await _defineManualHappy();
  await _defineSmartHappy();
  await _evaluateRulesAllOps();
  await _manualMembership();
  await _manualPagination();
  await _smartProductsInSortStrategies();
  await _collectionsForProduct();
  await _updateAndArchiveAndFactory();
  console.log("collections: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("OK\n");
  }).catch(function (err) {
    process.stderr.write((err && err.stack || String(err)) + "\n");
    process.exit(1);
  });
}
