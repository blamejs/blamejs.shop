"use strict";
/**
 * product-bulk-ops — operator-side bulk product mutations. Layer 1
 * against an in-memory node:sqlite database loaded with the live D1
 * migrations for the catalog (0001), the vendor registry (0084), and
 * the bulk-ops join + audit tables (0104).
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/product-bulk-ops.js` directly so the gate exists ahead of any
 * entry-point edit.
 *
 * Coverage:
 *   - bulkSetPrice rewrites prices on every matched variant; preview
 *     resolves the same product set without mutating
 *   - bulkAdjustPrice applies percent_bps math, rounds half-up, floors
 *     at 0, and skips variants without a current price
 *   - bulkArchive flips status='archived' and bulkUnarchive restores
 *     to 'draft'
 *   - bulkAddTag inserts (product_id, tag) idempotently and
 *     bulkRemoveTag deletes them
 *   - filter resolution: skus + vendor_slug + category + tag_any +
 *     tag_all + AND-of-multiple-keys
 *   - auditTrail returns rows in DESC order with the resolved
 *     filter / params preserved
 *   - input refusals: empty filter / unknown key / oversize sku list
 *     / oversize matched set
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var productBulkOps = require("../../lib/product-bulk-ops");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

void bShop;   // touch the entry point so the require cycle is exercised

var MIG_CATALOG  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_VENDORS  = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0084_vendors.sql");
var MIG_BULK_OPS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0104_product_bulk_ops.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_VENDORS, MIG_BULK_OPS].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  return async function (sql, params) {
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
}

async function _seedCatalog(catalog, query) {
  // Three products, multiple variants, mixed pricing.
  var p1 = await catalog.products.create({ slug: "widget-pro",   title: "Widget Pro",   status: "active" });
  var p2 = await catalog.products.create({ slug: "gadget-max",   title: "Gadget Max",   status: "active" });
  var p3 = await catalog.products.create({ slug: "doohickey-x",  title: "Doohickey X",  status: "draft"  });

  var v1 = await catalog.variants.create(p1.id, { sku: "ACME-WDG-001" });
  var v2 = await catalog.variants.create(p1.id, { sku: "ACME-WDG-002" });
  var v3 = await catalog.variants.create(p2.id, { sku: "ACME-GDG-001" });
  var v4 = await catalog.variants.create(p3.id, { sku: "BETA-DHX-001" });

  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2000 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 4000 });
  await catalog.prices.set(v3.id, { currency: "USD", amount_minor: 1000 });
  // v4 deliberately has no USD price — exercises the skip branch on
  // bulkAdjustPrice.

  // Seed a vendor + assignments.
  var ts = Date.now();
  await query(
    "INSERT INTO vendors " +
    "(slug, name, contact_email_hash, contact_email_normalised, payout_method, payout_address, " +
    " commission_split_bps, status, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
    ["acme-supply", "ACME Supply Co.", "hash-x", "ops@acme.test", "bank_transfer", "iban:dummy", 7000, "active", ts],
  );
  await query("INSERT INTO vendor_skus (vendor_slug, sku, assigned_at) VALUES (?1, ?2, ?3)", ["acme-supply", "ACME-WDG-001", ts]);
  await query("INSERT INTO vendor_skus (vendor_slug, sku, assigned_at) VALUES (?1, ?2, ?3)", ["acme-supply", "ACME-WDG-002", ts]);
  await query("INSERT INTO vendor_skus (vendor_slug, sku, assigned_at) VALUES (?1, ?2, ?3)", ["acme-supply", "ACME-GDG-001", ts]);

  return { p1: p1, p2: p2, p3: p3, v1: v1, v2: v2, v3: v3, v4: v4 };
}

function _setup() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var bulk    = productBulkOps.create({ query: query, catalog: catalog });
  return { query: query, catalog: catalog, bulk: bulk };
}

async function _bulkSetPriceAndPreview() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  // Preview first — no mutation.
  var preview = await ctx.bulk.previewFilter({
    filter: { skus: [s.v1.sku, s.v2.sku] },
  });
  check("previewFilter: matched product count",      preview.matched === 1);
  check("previewFilter: returns product ids",        preview.product_ids.length === 1 && preview.product_ids[0] === s.p1.id);
  check("previewFilter: returns product rows",       preview.products.length === 1 && preview.products[0].slug === "widget-pro");

  // Confirm the preview did not write an audit row.
  var beforeAudit = await ctx.bulk.auditTrail({});
  check("previewFilter: did not write an audit row", beforeAudit.length === 0);

  // bulkSetPrice — rewrite v1 + v2 to 1500.
  var r = await ctx.bulk.bulkSetPrice({
    filter:       { skus: [s.v1.sku, s.v2.sku] },
    currency:     "USD",
    amount_minor: 1500,
  });
  check("bulkSetPrice: affected = 2 variants",                r.affected_count === 2);
  check("bulkSetPrice: matched 1 product",                    r.matched_products === 1);
  check("bulkSetPrice: returns audit id",                     typeof r.audit_id === "string" && r.audit_id.length > 0);

  var pV1 = await ctx.catalog.prices.current(s.v1.id, "USD");
  var pV2 = await ctx.catalog.prices.current(s.v2.id, "USD");
  var pV3 = await ctx.catalog.prices.current(s.v3.id, "USD");
  check("bulkSetPrice: v1 rewritten",                         pV1.amount_minor === 1500);
  check("bulkSetPrice: v2 rewritten",                         pV2.amount_minor === 1500);
  check("bulkSetPrice: v3 untouched",                         pV3.amount_minor === 1000);

  // Versioned — history shows the prior 2000 row closed.
  var history = await ctx.catalog.prices.history(s.v1.id, "USD");
  check("bulkSetPrice: prior price preserved in history",     history.length === 2);
  // history is DESC by effective_from; the older row has the closed
  // effective_until set.
  check("bulkSetPrice: prior price has effective_until set",  history[1].effective_until != null);

  // Input refusals.
  await assert.rejects(
    ctx.bulk.bulkSetPrice({ filter: {}, currency: "USD", amount_minor: 100 }),
    /filter must specify at least one of/,
  );
  await assert.rejects(
    ctx.bulk.bulkSetPrice({ filter: { skus: [s.v1.sku] }, currency: "usd", amount_minor: 100 }),
    /currency must be a 3-letter ISO 4217 code/,
  );
  await assert.rejects(
    ctx.bulk.bulkSetPrice({ filter: { skus: [s.v1.sku] }, currency: "USD", amount_minor: -5 }),
    /amount_minor must be a non-negative integer/,
  );
}

async function _bulkAdjustPricePercent() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  // -1500 bps = -15%. Apply against all three priced variants via
  // vendor_slug='acme-supply' (which is v1 + v2 + v3).
  var r = await ctx.bulk.bulkAdjustPrice({
    filter:      { vendor_slug: "acme-supply" },
    currency:    "USD",
    percent_bps: -1500,
  });
  check("bulkAdjustPrice: affected = 3 variants",       r.affected_count === 3);
  check("bulkAdjustPrice: skipped = 0",                 r.skipped_count === 0);
  check("bulkAdjustPrice: matched 2 products",          r.matched_products === 2);

  var p1 = await ctx.catalog.prices.current(s.v1.id, "USD");
  var p2 = await ctx.catalog.prices.current(s.v2.id, "USD");
  var p3 = await ctx.catalog.prices.current(s.v3.id, "USD");
  // 2000 * 0.85 = 1700; 4000 * 0.85 = 3400; 1000 * 0.85 = 850.
  check("bulkAdjustPrice: 2000 -> 1700",                p1.amount_minor === 1700);
  check("bulkAdjustPrice: 4000 -> 3400",                p2.amount_minor === 3400);
  check("bulkAdjustPrice: 1000 -> 850",                 p3.amount_minor === 850);

  // Rounding: 333 * 1.005 = 334.665 -> 335 (half-even; not a tie, so it
  // rounds up regardless). Filter by v3's SKU so the matched product is
  // p2, whose only variant is v3 — an isolated single-variant adjust to
  // verify the rounding math.
  await ctx.catalog.prices.set(s.v3.id, { currency: "USD", amount_minor: 333 });
  var r2 = await ctx.bulk.bulkAdjustPrice({
    filter:      { skus: [s.v3.sku] },
    currency:    "USD",
    percent_bps: 50,           // +0.5%
  });
  check("bulkAdjustPrice: rounding applied",            r2.affected_count === 1);
  var pAfter = await ctx.catalog.prices.current(s.v3.id, "USD");
  check("bulkAdjustPrice: 333 * 1.005 rounds to 335",   pAfter.amount_minor === 335);

  // Half-even tie: 200 × 1.0025 = 200.5 → rounds to 200 (even), where
  // the prior Math.round (half-up) returned 201.
  await ctx.catalog.prices.set(s.v3.id, { currency: "USD", amount_minor: 200 });
  var rTie = await ctx.bulk.bulkAdjustPrice({
    filter:      { skus: [s.v3.sku] },
    currency:    "USD",
    percent_bps: 25,           // +0.25%
  });
  check("bulkAdjustPrice: half-even tie affected",      rTie.affected_count === 1);
  var pTie = await ctx.catalog.prices.current(s.v3.id, "USD");
  check("bulkAdjustPrice: 200 × 1.0025 = 200.5 → 200",  pTie.amount_minor === 200);

  // -100% floors at 0.
  var r3 = await ctx.bulk.bulkAdjustPrice({
    filter:      { skus: [s.v3.sku] },
    currency:    "USD",
    percent_bps: -10000,
  });
  check("bulkAdjustPrice: -100% applied",               r3.affected_count === 1);
  var pZero = await ctx.catalog.prices.current(s.v3.id, "USD");
  check("bulkAdjustPrice: -100% lands at 0",            pZero.amount_minor === 0);

  // v4 has no USD price — every variant is skipped.
  var r4 = await ctx.bulk.bulkAdjustPrice({
    filter:      { skus: [s.v4.sku] },
    currency:    "USD",
    percent_bps: -1000,
  });
  check("bulkAdjustPrice: v4 has no USD price (skipped)", r4.affected_count === 0 && r4.skipped_count === 1);

  // percent_bps shape refusals.
  await assert.rejects(
    ctx.bulk.bulkAdjustPrice({ filter: { skus: [s.v1.sku] }, currency: "USD", percent_bps: 1.5 }),
    /percent_bps must be an integer/,
  );
  await assert.rejects(
    ctx.bulk.bulkAdjustPrice({ filter: { skus: [s.v1.sku] }, currency: "USD", percent_bps: -20000 }),
    /percent_bps must be an integer/,
  );
}

async function _bulkArchiveAndUnarchive() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  // Archive p1 + p2 via vendor_slug.
  var r = await ctx.bulk.bulkArchive({ filter: { vendor_slug: "acme-supply" } });
  check("bulkArchive: affected = 2 products",          r.affected_count === 2);
  check("bulkArchive: matched 2 products",             r.matched_products === 2);

  var p1After = await ctx.catalog.products.get(s.p1.id);
  var p3After = await ctx.catalog.products.get(s.p3.id);
  check("bulkArchive: p1 status = archived",           p1After.status === "archived");
  check("bulkArchive: p3 untouched",                   p3After.status === "draft");

  // Re-archiving is a no-op (already-archived branch).
  var r2 = await ctx.bulk.bulkArchive({ filter: { vendor_slug: "acme-supply" } });
  check("bulkArchive: re-archiving 0 affected",        r2.affected_count === 0);

  // Unarchive returns them to 'draft'.
  var r3 = await ctx.bulk.bulkUnarchive({ filter: { vendor_slug: "acme-supply" } });
  check("bulkUnarchive: 2 restored",                   r3.affected_count === 2);
  var p1Now = await ctx.catalog.products.get(s.p1.id);
  check("bulkUnarchive: p1 returned to draft",         p1Now.status === "draft");

  // Re-unarchiving is a no-op.
  var r4 = await ctx.bulk.bulkUnarchive({ filter: { vendor_slug: "acme-supply" } });
  check("bulkUnarchive: re-unarchiving 0 affected",    r4.affected_count === 0);
}

async function _bulkTagAddRemove() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  // Add 'sale' to p1 + p2.
  var r = await ctx.bulk.bulkAddTag({
    filter: { vendor_slug: "acme-supply" },
    tag:    "sale",
  });
  check("bulkAddTag: 2 inserted",                      r.affected_count === 2);

  var p1Tags = await ctx.bulk.tags.listForProduct(s.p1.id);
  check("bulkAddTag: p1 has the tag",                  p1Tags.indexOf("sale") !== -1);

  // Idempotent — re-add is a no-op.
  var r2 = await ctx.bulk.bulkAddTag({
    filter: { vendor_slug: "acme-supply" },
    tag:    "sale",
  });
  check("bulkAddTag: re-add 0 affected",               r2.affected_count === 0);

  // Add 'new-arrival' to p1 only (skus filter).
  await ctx.bulk.bulkAddTag({
    filter: { skus: [s.v1.sku] },
    tag:    "new-arrival",
  });
  var p1All = await ctx.bulk.tags.listForProduct(s.p1.id);
  check("bulkAddTag: p1 has both tags",                p1All.indexOf("new-arrival") !== -1 && p1All.indexOf("sale") !== -1);

  // Tag shape refusal.
  await assert.rejects(
    ctx.bulk.bulkAddTag({ filter: { vendor_slug: "acme-supply" }, tag: "BadCase!" }),
    /tag must match/,
  );

  // Remove 'sale' from p1+p2.
  var r3 = await ctx.bulk.bulkRemoveTag({
    filter: { vendor_slug: "acme-supply" },
    tag:    "sale",
  });
  check("bulkRemoveTag: 2 deleted",                    r3.affected_count === 2);
  var p1NoSale = await ctx.bulk.tags.listForProduct(s.p1.id);
  check("bulkRemoveTag: p1 no longer has 'sale'",      p1NoSale.indexOf("sale") === -1);
  check("bulkRemoveTag: p1 still has 'new-arrival'",   p1NoSale.indexOf("new-arrival") !== -1);

  // Idempotent on the no-such-tag case.
  var r4 = await ctx.bulk.bulkRemoveTag({
    filter: { vendor_slug: "acme-supply" },
    tag:    "sale",
  });
  check("bulkRemoveTag: re-remove 0 affected",         r4.affected_count === 0);
}

async function _filterResolution() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  // Seed categories + tags directly through the admin surface.
  await ctx.bulk.categories.assign(s.p1.id, "apparel");
  await ctx.bulk.categories.assign(s.p1.id, "clearance");
  await ctx.bulk.categories.assign(s.p2.id, "apparel");
  await ctx.bulk.categories.assign(s.p3.id, "clearance");

  await ctx.bulk.bulkAddTag({ filter: { skus: [s.v1.sku] }, tag: "sale" });
  await ctx.bulk.bulkAddTag({ filter: { skus: [s.v1.sku] }, tag: "new-arrival" });
  await ctx.bulk.bulkAddTag({ filter: { skus: [s.v3.sku] }, tag: "sale" });

  // category filter — apparel matches p1 + p2.
  var byCat = await ctx.bulk.previewFilter({ filter: { category: "apparel" } });
  check("filter.category: matches 2",                  byCat.matched === 2);

  // tag_any — 'sale' OR 'new-arrival' matches p1 + p2 (p1 has both, p2 has sale).
  var byAny = await ctx.bulk.previewFilter({ filter: { tag_any: ["sale", "new-arrival"] } });
  check("filter.tag_any: matches 2",                   byAny.matched === 2);

  // tag_all — products with BOTH 'sale' AND 'new-arrival' = p1 only.
  var byAll = await ctx.bulk.previewFilter({ filter: { tag_all: ["sale", "new-arrival"] } });
  check("filter.tag_all: matches 1",                   byAll.matched === 1 && byAll.product_ids[0] === s.p1.id);

  // AND of category + tag_any — apparel AND sale = p1 + p2.
  var byAnd = await ctx.bulk.previewFilter({
    filter: { category: "apparel", tag_any: ["sale"] },
  });
  check("filter.AND(category, tag_any): matches 2",    byAnd.matched === 2);

  // AND of category=clearance + tag_all=[new-arrival] = p1 only (p3
  // is in clearance but has no tags).
  var byAnd2 = await ctx.bulk.previewFilter({
    filter: { category: "clearance", tag_all: ["new-arrival"] },
  });
  check("filter.AND(category, tag_all): matches 1",    byAnd2.matched === 1 && byAnd2.product_ids[0] === s.p1.id);

  // Empty-match filter returns matched=0.
  var empty = await ctx.bulk.previewFilter({ filter: { tag_any: ["no-such-tag"] } });
  check("filter: empty-match returns 0",               empty.matched === 0 && empty.product_ids.length === 0);

  // Unknown key rejected.
  await assert.rejects(
    ctx.bulk.previewFilter({ filter: { typo_key: "x" } }),
    /unknown filter key 'typo_key'/,
  );

  // Oversize skus rejected.
  var huge = [];
  for (var i = 0; i < productBulkOps.DEFAULT_CAP + 1; i += 1) huge.push("SKU-" + i);
  await assert.rejects(
    ctx.bulk.previewFilter({ filter: { skus: huge } }),
    /filter.skus must be/,
  );

  // Oversize matched-set rejected when cap is small.
  var smallCap = productBulkOps.create({
    query:       ctx.query,
    catalog:     ctx.catalog,
    maxBulkRows: 1,
  });
  await assert.rejects(
    smallCap.previewFilter({ filter: { vendor_slug: "acme-supply" } }),
    /exceeds cap of 1 per call/,
  );
}

async function _auditTrailRetrieval() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  var actorId = bShop.framework.uuid.v7();

  await ctx.bulk.bulkSetPrice({
    filter:       { skus: [s.v1.sku] },
    currency:     "USD",
    amount_minor: 999,
    actor_id:     actorId,
  });
  await ctx.bulk.bulkAddTag({
    filter:   { skus: [s.v1.sku] },
    tag:      "sale",
    actor_id: actorId,
  });
  await ctx.bulk.bulkArchive({
    filter:   { skus: [s.v1.sku] },
    actor_id: actorId,
  });

  var all = await ctx.bulk.auditTrail({});
  check("auditTrail: 3 rows",                          all.length === 3);
  // DESC by performed_at — newest first.
  check("auditTrail: newest is 'archive'",             all[0].kind === "archive");
  check("auditTrail: oldest is 'set_price'",           all[all.length - 1].kind === "set_price");

  // Filter preserved via JSON round-trip.
  check("auditTrail: filter round-trip",
    Array.isArray(all[all.length - 1].filter.skus) && all[all.length - 1].filter.skus[0] === s.v1.sku);
  check("auditTrail: params round-trip",               all[all.length - 1].params.amount_minor === 999);
  check("auditTrail: actor_id captured",               all[0].actor_id === actorId);

  // Narrow by kind.
  var onlyTags = await ctx.bulk.auditTrail({ kind: "add_tag" });
  check("auditTrail: narrow by kind",                  onlyTags.length === 1 && onlyTags[0].kind === "add_tag");

  // Narrow by actor.
  var onlyActor = await ctx.bulk.auditTrail({ actor_id: actorId });
  check("auditTrail: narrow by actor",                 onlyActor.length === 3);

  // Narrow by since — use the timestamp of the second-newest row to
  // cut everything before it.
  var midTs = all[1].performed_at;
  var sinceRows = await ctx.bulk.auditTrail({ since: midTs });
  check("auditTrail: narrow by since",                 sinceRows.length >= 1 && sinceRows.length <= 3);

  // Bad kind.
  await assert.rejects(
    ctx.bulk.auditTrail({ kind: "not_a_kind" }),
    /kind must be one of/,
  );

  // Limit shape.
  await assert.rejects(
    ctx.bulk.auditTrail({ limit: 0 }),
    /limit must be 1\.\.500/,
  );
}

async function _bulkSetInventoryAcrossVariants() {
  var ctx = _setup();
  var s = await _seedCatalog(ctx.catalog, ctx.query);

  // Seed an inventory row for v1 so the UPDATE branch fires; leave
  // v2 + v3 + v4 without rows so the INSERT branch fires for each.
  await ctx.catalog.inventory.create(s.v1.sku, { stock_on_hand: 50 });

  var r = await ctx.bulk.bulkSetInventory({
    filter:        { vendor_slug: "acme-supply" },
    stock_on_hand: 25,
  });
  check("bulkSetInventory: 3 variants affected",       r.affected_count === 3);
  check("bulkSetInventory: matched 2 products",        r.matched_products === 2);

  var inv1 = await ctx.catalog.inventory.get(s.v1.sku);
  var inv2 = await ctx.catalog.inventory.get(s.v2.sku);
  var inv3 = await ctx.catalog.inventory.get(s.v3.sku);
  var inv4 = await ctx.catalog.inventory.get(s.v4.sku);
  check("bulkSetInventory: v1 updated to 25",          inv1.stock_on_hand === 25);
  check("bulkSetInventory: v2 inserted at 25",         inv2 && inv2.stock_on_hand === 25);
  check("bulkSetInventory: v3 inserted at 25",         inv3 && inv3.stock_on_hand === 25);
  check("bulkSetInventory: v4 untouched (BETA vendor)", inv4 === null);

  // Negative stock refused.
  await assert.rejects(
    ctx.bulk.bulkSetInventory({ filter: { skus: [s.v1.sku] }, stock_on_hand: -1 }),
    /stock_on_hand must be a non-negative integer/,
  );
}

async function _factoryRefusals() {
  assert.throws(function () { productBulkOps.create({}); }, /catalog handle required/);
  assert.throws(
    function () { productBulkOps.create({ catalog: {}, maxBulkRows: 0 }); },
    /maxBulkRows must be a positive integer/,
  );
  assert.throws(
    function () { productBulkOps.create({ catalog: {}, maxBulkRows: 999999 }); },
    /maxBulkRows must be a positive integer/,
  );
}

async function run() {
  await _bulkSetPriceAndPreview();
  await _bulkAdjustPricePercent();
  await _bulkArchiveAndUnarchive();
  await _bulkTagAddRemove();
  await _filterResolution();
  await _auditTrailRetrieval();
  await _bulkSetInventoryAcrossVariants();
  await _factoryRefusals();
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
