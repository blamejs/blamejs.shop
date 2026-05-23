"use strict";
/**
 * searchFacets — storefront search filter chrome + analytics.
 *
 * Layer 1 against an in-memory node:sqlite database. The catalog is a
 * stub that returns a fixed product roster — the facet primitive's
 * job is to compute counts in-memory from whatever the catalog hands
 * back, so a real-catalog binding isn't needed to exercise the
 * primitive's contract.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/search-facets.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineFacet happy: categorical + numeric_range + boolean kinds
 *     persist with the right shape, defaults applied
 *   - defineFacet refusals: bad key shape, bad kind, missing buckets
 *     on numeric_range, buckets on a non-range kind, display_limit on
 *     a non-categorical kind, key collision, oversize / control-byte
 *     payloads
 *   - getFacets: count math against the catalog roster, categorical
 *     sorting + display_limit cap, numeric_range bucket mapping,
 *     boolean truthy / falsy split, selected flag, "leave focal facet
 *     unconstrained" intersection rule for applied_filters
 *   - previewQuery: total + sample for a candidate filter set,
 *     empty-filter passes everything through, applied filter narrows
 *   - recordFacetUse: appends an analytics row with the session id
 *     namespaceHashed under the documented namespace
 *   - listFacets / updateFacet / archiveFacet round-trip + cache
 *     invalidation
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var searchFacets = require("../../lib/search-facets");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIGS = ["0082_search_facets.sql"].map(function (f) {
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
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
  });
  return {
    db: db,
    query: async function (sql, params) {
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
    },
  };
}

// Catalog stub — a fixed product roster. The facet primitive walks
// the rows in-memory to compute counts; the catalog binding only has
// to honour the `list({ query, applied_filters, scope })` -> { rows }
// shape. `query` filtering on `title` is implemented here so the
// previewQuery / getFacets tests can verify the primitive consumes
// the query argument transparently.
function _makeCatalog(roster) {
  return {
    list: async function (opts) {
      opts = opts || {};
      var q = (opts.query || "").trim().toLowerCase();
      if (!q) return { rows: roster.slice() };
      var out = [];
      for (var i = 0; i < roster.length; i += 1) {
        var title = String(roster[i].title || "").toLowerCase();
        if (title.indexOf(q) !== -1) out.push(roster[i]);
      }
      return { rows: out };
    },
  };
}

var SAMPLE_ROSTER = [
  { id: "p1", title: "Nike Air Max",       tags: ["running", "shoes"], vendor: "Nike",   category: "shoes",    price_minor: 12000, in_stock: true  },
  { id: "p2", title: "Nike Pegasus",       tags: ["running"],          vendor: "Nike",   category: "shoes",    price_minor: 9000,  in_stock: true  },
  { id: "p3", title: "Adidas Ultraboost",  tags: ["running"],          vendor: "Adidas", category: "shoes",    price_minor: 18000, in_stock: false },
  { id: "p4", title: "Adidas Sambas",      tags: ["casual"],           vendor: "Adidas", category: "shoes",    price_minor: 11000, in_stock: true  },
  { id: "p5", title: "Puma Suede",         tags: ["casual"],           vendor: "Puma",   category: "shoes",    price_minor: 8000,  in_stock: true  },
  { id: "p6", title: "Nike Hoodie",        tags: ["apparel"],          vendor: "Nike",   category: "apparel",  price_minor: 6000,  in_stock: false },
  { id: "p7", title: "Adidas Track Pant",  tags: ["apparel"],          vendor: "Adidas", category: "apparel",  price_minor: 7500,  in_stock: true  },
  { id: "p8", title: "Puma Tee",           tags: ["apparel"],          vendor: "Puma",   category: "apparel",  price_minor: 3000,  in_stock: true  },
];

var PRICE_BUCKETS = [
  { label: "under-50",  min: null, max: 5000  },
  { label: "50-to-100", min: 5000, max: 10000 },
  { label: "100-plus",  min: 10000, max: null },
];

function _setup() {
  var qWrap   = _makeQuery();
  var catalog = _makeCatalog(SAMPLE_ROSTER);
  var sf      = searchFacets.create({ query: qWrap.query, catalog: catalog });
  return { query: qWrap.query, sf: sf, catalog: catalog };
}

async function _seedAll(sf) {
  await sf.defineFacet({ key: "vendor",   field: "vendor",   kind: "categorical", display_limit: 10 });
  await sf.defineFacet({ key: "category", field: "category", kind: "categorical" });
  await sf.defineFacet({ key: "tags",     field: "tags",     kind: "categorical" });
  await sf.defineFacet({ key: "price",    field: "price_minor", kind: "numeric_range", buckets: PRICE_BUCKETS });
  await sf.defineFacet({ key: "in-stock", field: "in_stock", kind: "boolean" });
}

async function _defineFacetHappyPath() {
  var ctx = _setup();
  var cat = await ctx.sf.defineFacet({
    key: "vendor", field: "vendor", kind: "categorical", display_limit: 25,
  });
  check("defineFacet: categorical returns key",        cat.key === "vendor");
  check("defineFacet: categorical kind stored",        cat.kind === "categorical");
  check("defineFacet: display_limit stored",            cat.display_limit === 25);
  check("defineFacet: buckets null for categorical",    cat.buckets === null);
  check("defineFacet: active default true",             cat.active === true);
  check("defineFacet: archived_at null on create",      cat.archived_at === null);
  check("defineFacet: created_at stamped",              Number.isInteger(cat.created_at) && cat.created_at > 0);

  var num = await ctx.sf.defineFacet({
    key: "price", field: "price_minor", kind: "numeric_range", buckets: PRICE_BUCKETS,
  });
  check("defineFacet: numeric_range kind stored",       num.kind === "numeric_range");
  check("defineFacet: buckets persisted",                Array.isArray(num.buckets) && num.buckets.length === 3);
  check("defineFacet: display_limit null for range",     num.display_limit === null);

  var bool = await ctx.sf.defineFacet({
    key: "in-stock", field: "in_stock", kind: "boolean",
  });
  check("defineFacet: boolean kind stored",              bool.kind === "boolean");
  check("defineFacet: boolean buckets null",             bool.buckets === null);

  // Collision is refused
  await assert.rejects(
    ctx.sf.defineFacet({ key: "vendor", field: "vendor", kind: "categorical" }),
    /key already exists/
  );
}

async function _defineFacetRefusals() {
  var ctx = _setup();
  await assert.rejects(ctx.sf.defineFacet(),                                                       /input object required/);
  await assert.rejects(ctx.sf.defineFacet({}),                                                     /key must be/);
  await assert.rejects(ctx.sf.defineFacet({ key: "BadCaps", field: "vendor", kind: "categorical" }), /key must match/);
  await assert.rejects(ctx.sf.defineFacet({ key: "9bad", field: "vendor", kind: "categorical" }),  /key must match/);
  await assert.rejects(ctx.sf.defineFacet({ key: "ok", field: "Vendor", kind: "categorical" }),    /field must match/);
  await assert.rejects(ctx.sf.defineFacet({ key: "ok", field: "vendor", kind: "junk" }),           /kind must be/);
  // numeric_range requires buckets
  await assert.rejects(ctx.sf.defineFacet({ key: "ok", field: "p", kind: "numeric_range" }),       /buckets/);
  // buckets on categorical refused
  await assert.rejects(
    ctx.sf.defineFacet({ key: "ok", field: "v", kind: "categorical", buckets: PRICE_BUCKETS }),
    /buckets only valid/
  );
  // display_limit on numeric_range refused
  await assert.rejects(
    ctx.sf.defineFacet({ key: "ok", field: "p", kind: "numeric_range", buckets: PRICE_BUCKETS, display_limit: 5 }),
    /display_limit only valid/
  );
  // Bucket validation — bad shape, duplicate labels, inverted bounds
  await assert.rejects(
    ctx.sf.defineFacet({ key: "ok", field: "p", kind: "numeric_range", buckets: [] }),
    /at least 1/
  );
  await assert.rejects(
    ctx.sf.defineFacet({ key: "ok", field: "p", kind: "numeric_range", buckets: [
      { label: "a", min: 0, max: 10 }, { label: "a", min: 10, max: 20 },
    ] }),
    /unique/
  );
  await assert.rejects(
    ctx.sf.defineFacet({ key: "ok", field: "p", kind: "numeric_range", buckets: [
      { label: "inverted", min: 100, max: 10 },
    ] }),
    /min must be < max/
  );
  // Catalog binding required at create-time
  assert.throws(function () {
    searchFacets.create({ query: ctx.query });
  }, /catalog with a \.list/);
}

async function _getFacetsCounts() {
  var ctx = _setup();
  await _seedAll(ctx.sf);

  var facets = await ctx.sf.getFacets({});
  // Lookup by key
  var byKey = {};
  for (var i = 0; i < facets.length; i += 1) byKey[facets[i].key] = facets[i];

  check("getFacets: returns all 5 facets",             facets.length === 5);
  check("getFacets: vendor facet present",             byKey.vendor && byKey.vendor.kind === "categorical");

  // Vendor counts — Nike=3, Adidas=3, Puma=2
  function _counts(opts) {
    var out = {};
    for (var i = 0; i < opts.length; i += 1) out[opts[i].value] = opts[i].count;
    return out;
  }
  var vendorCounts = _counts(byKey.vendor.options);
  check("getFacets: vendor Nike count 3",               vendorCounts.Nike === 3);
  check("getFacets: vendor Adidas count 3",             vendorCounts.Adidas === 3);
  check("getFacets: vendor Puma count 2",               vendorCounts.Puma === 2);
  check("getFacets: vendor sorted by count desc",       byKey.vendor.options[0].count >= byKey.vendor.options[2].count);

  // Tags counts — array-valued field, each row's tags contribute
  // independently. running=3, casual=2, apparel=3, shoes=1.
  var tagCounts = _counts(byKey.tags.options);
  check("getFacets: tags running count 3",              tagCounts.running === 3);
  check("getFacets: tags casual count 2",               tagCounts.casual === 2);
  check("getFacets: tags apparel count 3",              tagCounts.apparel === 3);
  check("getFacets: tags shoes count 1",                tagCounts.shoes === 1);

  // Price buckets — under-50: p8 (3000); 50-to-100: p2 (9000), p5 (8000),
  // p6 (6000), p7 (7500) = 4; 100-plus: p1 (12000), p3 (18000), p4 (11000) = 3
  var priceCounts = _counts(byKey.price.options);
  check("getFacets: price under-50 count 1",            priceCounts["under-50"] === 1);
  check("getFacets: price 50-to-100 count 4",           priceCounts["50-to-100"] === 4);
  check("getFacets: price 100-plus count 3",            priceCounts["100-plus"] === 3);

  // in-stock — 6 true, 2 false
  var stockCounts = _counts(byKey["in-stock"].options);
  check("getFacets: in-stock true count 6",             stockCounts["true"] === 6);
  check("getFacets: in-stock false count 2",            stockCounts["false"] === 2);

  // selected flag — none selected by default
  check("getFacets: nothing selected by default",
    facets.every(function (f) { return f.options.every(function (o) { return o.selected === false; }); }));
}

async function _getFacetsAppliedFilters() {
  var ctx = _setup();
  await _seedAll(ctx.sf);

  // Apply vendor=Nike — vendor counts MUST remain unchanged (focal
  // facet sees the unfiltered roster) while category counts should
  // narrow to Nike's products only.
  var facets = await ctx.sf.getFacets({
    applied_filters: { vendor: ["Nike"] },
  });
  var byKey = {};
  for (var i = 0; i < facets.length; i += 1) byKey[facets[i].key] = facets[i];

  function _counts(opts) {
    var out = {};
    for (var ii = 0; ii < opts.length; ii += 1) out[opts[ii].value] = opts[ii].count;
    return out;
  }

  var vendorCounts = _counts(byKey.vendor.options);
  check("getFacets: focal facet (vendor) NOT narrowed by its own filter",
    vendorCounts.Adidas === 3 && vendorCounts.Puma === 2);
  // category counts narrow — Nike has shoes (p1, p2) + apparel (p6)
  var catCounts = _counts(byKey.category.options);
  check("getFacets: category narrowed by vendor=Nike (shoes=2)",   catCounts.shoes === 2);
  check("getFacets: category narrowed by vendor=Nike (apparel=1)", catCounts.apparel === 1);

  // vendor=Nike option should have selected: true
  var nikeOpt = byKey.vendor.options.filter(function (o) { return o.value === "Nike"; })[0];
  check("getFacets: selected flag set on applied value",   nikeOpt && nikeOpt.selected === true);

  // Apply both vendor=Nike and category=apparel — tags should narrow
  // to apparel only.
  var f2 = await ctx.sf.getFacets({
    applied_filters: { vendor: ["Nike"], category: ["apparel"] },
  });
  var byKey2 = {};
  for (var j = 0; j < f2.length; j += 1) byKey2[f2[j].key] = f2[j];
  var tagCounts2 = _counts(byKey2.tags.options);
  check("getFacets: tags narrowed by vendor+category",     tagCounts2.apparel === 1);
  check("getFacets: tags shoes excluded under narrowed scope", tagCounts2.shoes == null);
}

async function _getFacetsDisplayLimit() {
  var ctx = _setup();
  await ctx.sf.defineFacet({
    key: "vendor", field: "vendor", kind: "categorical", display_limit: 2,
  });
  var facets = await ctx.sf.getFacets({});
  check("getFacets: display_limit caps option count",   facets[0].options.length === 2);
  // The two surfaced options are the highest-count pair (Nike=3,
  // Adidas=3) — ordering between ties is alphabetical.
  check("getFacets: capped options are the top-count entries",
    facets[0].options[0].count === 3 && facets[0].options[1].count === 3);
}

async function _previewQuery() {
  var ctx = _setup();
  await _seedAll(ctx.sf);

  // No filters — every product passes.
  var all = await ctx.sf.previewQuery({ filters: {} });
  check("previewQuery: empty filters returns full roster", all.total === SAMPLE_ROSTER.length);
  check("previewQuery: sample default cap",                 all.sample.length <= 10);

  // vendor=Nike — 3 products.
  var nike = await ctx.sf.previewQuery({ filters: { vendor: ["Nike"] } });
  check("previewQuery: vendor=Nike narrows to 3 products", nike.total === 3);
  check("previewQuery: sample respects total",             nike.sample.length === 3);

  // vendor=Nike + price 50-to-100 — Nike products in [5000, 10000):
  // p2 (9000) and p6 (6000).
  var combo = await ctx.sf.previewQuery({
    filters: { vendor: ["Nike"], price: ["50-to-100"] },
  });
  check("previewQuery: vendor + price intersection",       combo.total === 2);
  var comboIds = combo.sample.map(function (r) { return r.id; }).sort();
  check("previewQuery: sample carries the right product ids", comboIds.length === 2 && comboIds[0] === "p2" && comboIds[1] === "p6");

  // in-stock=true narrows to 6.
  var stock = await ctx.sf.previewQuery({ filters: { "in-stock": ["true"] } });
  check("previewQuery: boolean facet narrows correctly",   stock.total === 6);

  // Query text + filter — "nike" search + apparel narrows to p6.
  var q = await ctx.sf.previewQuery({ query: "nike", filters: { category: ["apparel"] } });
  check("previewQuery: query + filter combine",            q.total === 1 && q.sample[0].id === "p6");

  // Sample cap honoured
  var capped = await ctx.sf.previewQuery({ filters: {}, sample: 3 });
  check("previewQuery: sample cap honoured",               capped.sample.length === 3);
  check("previewQuery: total unaffected by sample cap",    capped.total === SAMPLE_ROSTER.length);

  // Bad inputs
  await assert.rejects(ctx.sf.previewQuery(),                                /input object required/);
  await assert.rejects(ctx.sf.previewQuery({ filters: "no" }),               /applied_filters must be an object/);
  await assert.rejects(ctx.sf.previewQuery({ filters: { v: "x" } }),         /must be an array of values/);
  await assert.rejects(ctx.sf.previewQuery({ filters: {}, sample: -1 }),     /sample must be/);
}

async function _recordFacetUseAndCrud() {
  var ctx = _setup();
  await _seedAll(ctx.sf);

  var r1 = await ctx.sf.recordFacetUse({ key: "vendor", value: "Nike",       session_id: "sess-abc-123" });
  var r2 = await ctx.sf.recordFacetUse({ key: "price",  value: "50-to-100",  session_id: "sess-abc-123" });
  check("recordFacetUse: returns id",                       typeof r1.id === "string" && r1.id.length > 0);
  check("recordFacetUse: returns different id per write",   r1.id !== r2.id);

  // Verify the row exists and the session id was hashed (i.e. not
  // stored as the raw "sess-abc-123" string).
  var rows = (await ctx.query(
    "SELECT facet_key, value, session_id_hash FROM search_facet_usage ORDER BY occurred_at ASC",
    []
  )).rows;
  check("recordFacetUse: 2 rows logged",                    rows.length === 2);
  check("recordFacetUse: facet_key + value stored",         rows[0].facet_key === "vendor" && rows[0].value === "Nike");
  check("recordFacetUse: session id hashed (not raw)",      rows[0].session_id_hash !== "sess-abc-123" && rows[0].session_id_hash.length > 16);
  // Same session id under the same namespace deterministically hashes
  // to the same digest — the two rows should share the digest.
  check("recordFacetUse: same session id hashes the same way", rows[0].session_id_hash === rows[1].session_id_hash);

  // Bad inputs
  await assert.rejects(ctx.sf.recordFacetUse(),                                              /input object required/);
  await assert.rejects(ctx.sf.recordFacetUse({ key: "", value: "x", session_id: "s" }),      /key must be/);
  await assert.rejects(ctx.sf.recordFacetUse({ key: "vendor", value: "", session_id: "s" }), /value must be/);
  await assert.rejects(ctx.sf.recordFacetUse({ key: "vendor", value: "x" }),                 /session_id must be/);

  // list / update / archive round trip
  var listed = await ctx.sf.listFacets({});
  check("listFacets: returns 5 active facets",              listed.length === 5);

  var patched = await ctx.sf.updateFacet("vendor", { display_limit: 5 });
  check("updateFacet: display_limit patched",               patched.display_limit === 5);
  check("updateFacet: updated_at advances",                 patched.updated_at >= patched.created_at);

  // Empty patch refused
  await assert.rejects(ctx.sf.updateFacet("vendor", {}),                         /no updatable fields/);
  // Unknown key returns null
  var miss = await ctx.sf.updateFacet("does-not-exist", { display_limit: 5 });
  check("updateFacet: returns null on unknown key",         miss === null);

  // Toggle active=false — getFacets drops the facet from output
  await ctx.sf.updateFacet("in-stock", { active: false });
  var after = await ctx.sf.getFacets({});
  check("updateFacet: active=false removes from getFacets", !after.some(function (f) { return f.key === "in-stock"; }));

  // archive
  var archived = await ctx.sf.archiveFacet("tags");
  check("archiveFacet: returns archived true",              archived.archived === true);
  var archivedAgain = await ctx.sf.archiveFacet("tags");
  check("archiveFacet: returns archived false on miss",     archivedAgain.archived === false);

  // listFacets default excludes archived
  var listed2 = await ctx.sf.listFacets({});
  check("listFacets: archived facet excluded by default",   !listed2.some(function (f) { return f.key === "tags"; }));
  var listed3 = await ctx.sf.listFacets({ include_archived: true });
  check("listFacets: include_archived surfaces archived",   listed3.some(function (f) { return f.key === "tags" && f.archived_at != null; }));
}

async function run() {
  await _defineFacetHappyPath();
  await _defineFacetRefusals();
  await _getFacetsCounts();
  await _getFacetsAppliedFilters();
  await _getFacetsDisplayLimit();
  await _previewQuery();
  await _recordFacetUseAndCrud();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — " + helpers.getChecks() + " check(s) passed");
  }, function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
