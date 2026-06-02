"use strict";
/**
 * Search decoration — edge ↔ container parity (the PERF-2 pin).
 *
 * The /search universe is decorated in BOTH substrates: the container
 * now drives `lib/catalog.js#batch.searchDecorate`; the Cloudflare
 * Worker drives `worker/data/catalog.js#searchFacetableProducts` (it
 * can't require a CommonJS leaf). The container helper was ported from
 * the edge function verbatim — same OR-of-LIKE term clause, same
 * collection_members `IN` (MANUAL membership only), same grouped-
 * inventory `IN`. If they drift, a visitor sees different search facet
 * counts depending on whether the edge or container served /search.
 *
 * This test runs both against the SAME in-memory node:sqlite seeded
 * from the live D1 migrations, and asserts the two row sets are
 * deep-equal: same id set, same `collection` arrays (manual-only on
 * BOTH — the PD-1 convergence), same `price_minor`, same `in_stock`.
 *
 * DEPLOY-BRICKER: this test imports worker/data/catalog.js, which is
 * EXCLUDED from the container build context (.dockerignore). The
 * fs.existsSync(edgePath) guard + early return BEFORE the import() is
 * mandatory — an unguarded worker import fails the in-image
 * `RUN node test/smoke.js`, fails the Docker build, and bricks every
 * container deploy. Copied from search-faceting-parity.test.js.
 */

var nodePath = require("node:path");
var nodeFs   = require("node:fs");
var nodeUrl  = require("node:url");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

function _migs() {
  return ["0001_catalog.sql", "0008_inventory_thresholds.sql", "0043_collections.sql"]
    .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });
}

// A minimal Cloudflare-D1-shaped binding over node:sqlite: `.prepare(sql)
// .bind(...args).all()/.first()`, returning the `{ results }` shape the
// edge data layer reads. The exact shim search-faceting-parity's sibling
// console tests use, so the edge SQL runs unchanged off the same DB the
// container helper queries.
function _d1Shim(db) {
  return {
    prepare: function (sql) {
      var bound = [];
      var api = {
        bind: function () { bound = Array.prototype.slice.call(arguments); return api; },
        all: async function () {
          var rows = db.prepare(sql).all.apply(db.prepare(sql), bound);
          return { results: rows };
        },
        first: async function () {
          var rows = db.prepare(sql).all.apply(db.prepare(sql), bound);
          return rows.length ? rows[0] : null;
        },
      };
      return api;
    },
  };
}

// Normalize a row set to the facet-relevant fields, sorted by id, with
// `collection` arrays sorted, so the deep-equal compares meaning not key
// order / array order.
function _normRows(rows) {
  return rows.map(function (r) {
    return {
      id:          r.id,
      collection:  (r.collection || []).slice().sort(),
      price_minor: r.price_minor != null ? r.price_minor : null,
      in_stock:    !!r.in_stock,
    };
  }).sort(function (a, b) { return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0); });
}

async function _run() {
  // worker/ is excluded from the container build context (.dockerignore),
  // so worker/data/catalog.js isn't present in the in-image smoke gate.
  // Skip the edge↔container parity there; the full-tree CI run (worker/
  // present) covers it. An unguarded worker import fails the in-image
  // `RUN node test/smoke.js`, fails the Docker build, and blocks every
  // container deploy.
  var edgePath = nodePath.resolve(__dirname, "..", "..", "worker", "data", "catalog.js");
  if (!nodeFs.existsSync(edgePath)) return;
  var edge = await import(nodeUrl.pathToFileURL(edgePath).href);

  var mem = helpers.memD1Query(_migs());
  var catalog = bShop.catalog.create({ query: mem.query });
  var db = mem.db;
  var d1 = _d1Shim(db);
  var now = Date.now();

  // A manual collection AND a smart collection. The smart collection's
  // members are NOT joined through collection_members (PD-1: manual only).
  await mem.query("INSERT INTO collections (slug, type, title, sort_strategy, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6)",
    ["manual-col", "manual", "Manual", "manual", now, now]);
  await mem.query("INSERT INTO collections (slug, type, title, rules_json, sort_strategy, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7)",
    ["smart-col", "smart", "Smart", JSON.stringify({ all: [], any: [] }), "newest", now, now]);

  // Products. "Widget Deluxe" is in BOTH a manual collection AND would
  // match a smart collection — both substrates must list ONLY the manual
  // slug. "Gadget Out" is fully out of stock (all variants sold out) →
  // in_stock:false. "Percent 100%" exercises the `%` LIKE metachar.
  // "Markup <b>tag</b>" carries raw HTML in the title (XSS-probe: the
  // data layer returns it raw, the renderer escapes).
  var widget = await catalog.products.create({ slug: "widget-deluxe", title: "Widget Deluxe", description: "a deluxe widget", status: "active" });
  var gadget = await catalog.products.create({ slug: "gadget-out", title: "Gadget Out widget", description: "sold out widget", status: "active" });
  var pct    = await catalog.products.create({ slug: "percent-100", title: "Percent 100% widget", description: "a literal percent widget", status: "active" });
  var markup = await catalog.products.create({ slug: "markup-tag", title: "Markup <b>tag</b> widget", description: "raw html widget", status: "active" });

  // Variants + prices + inventory.
  var wv = await catalog.variants.create(widget.id, { sku: "WID-1", position: 0 });
  await catalog.prices.set(wv.id, { currency: "USD", amount_minor: 5999 });
  await catalog.inventory.create("WID-1", { stock_on_hand: 10 });

  var gv = await catalog.variants.create(gadget.id, { sku: "GAD-1", position: 0 });
  await catalog.prices.set(gv.id, { currency: "USD", amount_minor: 3999 });
  await catalog.inventory.create("GAD-1", { stock_on_hand: 4 });
  // Hold all stock → sold out.
  await mem.query("UPDATE inventory SET stock_held = 4 WHERE sku = ?1", ["GAD-1"]);

  var pv = await catalog.variants.create(pct.id, { sku: "PCT-1", position: 0 });
  await catalog.prices.set(pv.id, { currency: "USD", amount_minor: 100 });
  await catalog.inventory.create("PCT-1", { stock_on_hand: 7 });

  var mv = await catalog.variants.create(markup.id, { sku: "MRK-1", position: 0 });
  await catalog.prices.set(mv.id, { currency: "USD", amount_minor: 2500 });

  // Manual membership: widget in manual-col only. A smart collection
  // (smart-col) carries RULES, not collection_members rows — neither
  // substrate evaluates those rules in the search-decorate path, so the
  // smart slug must NOT appear in the `collection` facet (PD-1: manual
  // membership only). This is the convergence: the old container path
  // ran collectionsForProduct (smart rules + manual), the edge ran
  // collection_members only; both now read manual-only.
  await mem.query("INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) VALUES (?1,?2,?3,?4,?5)",
    [bShop.framework.uuid.v7(), "manual-col", widget.id, 0, now]);

  // Run a set of term cases through both substrates.
  var cases = [
    { label: "all widgets", terms: ["widget"] },
    { label: "percent metachar", terms: ["100%"] },
    { label: "underscore metachar", terms: ["_idget"] },
    { label: "raw html title", terms: ["Markup"] },
    { label: "xss probe term", terms: ["<script>x</script>", "widget"] },
    { label: "dedup case-insensitive", terms: ["Widget", "widget", "WIDGET"] },
  ];

  for (var c = 0; c < cases.length; c += 1) {
    var cse = cases[c];
    var containerRows = (await catalog.batch.searchDecorate({ terms: cse.terms, currency: "USD" })).rows;
    var edgeRows      = (await edge.searchFacetableProducts(d1, { terms: cse.terms, currency: "USD" })).rows;
    assert.deepStrictEqual(_normRows(containerRows), _normRows(edgeRows),
      "searchDecorate parity (" + cse.label + ")");
    check("search-decorate parity (" + cse.label + ")", true);
  }

  // Targeted contract assertions on the "widget" case.
  var rows = (await catalog.batch.searchDecorate({ terms: ["widget"], currency: "USD" })).rows;
  var byId = {};
  for (var i = 0; i < rows.length; i += 1) byId[rows[i].id] = rows[i];

  // PD-1: widget is in a manual collection AND a smart collection —
  // ONLY the manual slug appears, on both sides (parity already pins both,
  // this pins the value).
  check("PD-1: manual-only collection facet", byId[widget.id].collection.length === 1 && byId[widget.id].collection[0] === "manual-col");

  // Out-of-stock product → in_stock:false; in-stock → true.
  check("out-of-stock product in_stock=false", byId[gadget.id].in_stock === false);
  check("in-stock product in_stock=true", byId[widget.id].in_stock === true);

  // price_minor is the integer minor-unit amount, passed through (no math).
  check("price_minor passthrough", byId[widget.id].price_minor === 5999 && byId[pct.id].price_minor === 100);

  // XSS / escape: the DATA layer returns the raw title (renderer escapes).
  // Neither double-escapes nor drops the markup.
  check("raw title returned unescaped (data path)", byId[markup.id].title === "Markup <b>tag</b> widget");

  // Percent metachar matches ONLY the literal-percent product.
  var pctRows = (await catalog.batch.searchDecorate({ terms: ["100%"], currency: "USD" })).rows;
  check("`%` metachar matches only the literal", pctRows.length === 1 && pctRows[0].id === pct.id);
}

module.exports = { run: _run };
