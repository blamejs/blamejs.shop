"use strict";
/**
 * print-on-demand — supplier-agnostic SKU binding + per-order
 * forward-to-supplier fulfillment record.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0001
 * (catalog — the variants table that bindSku checks against) and
 * migration 0040 (pod_bindings + pod_fulfillments).
 *
 * Coverage:
 *   - bindSku happy path: persists row, returns shape
 *   - bindSku refusal when sku missing from catalog
 *   - bindSku refusal on unknown supplier (enum gate)
 *   - bindSku refusal on rebind without unbind
 *   - updateBinding patches allowed columns, refuses others
 *   - unbindSku removes the row, idempotent on second call
 *   - costForOrder aggregates total + per-supplier
 *   - costForOrder surfaces unbound SKUs without crashing
 *   - forwardOrder writes one pending row per supplier on the order
 *   - forwardOrder unbound_skus surfaced separately
 *   - FSM transitions: pending → submitted → shipped (timestamps set)
 *   - FSM transitions: pending → cancelled, submitted → failed
 *   - FSM refusal when transitioning from terminal state
 *   - fulfillmentsForOrder ordered ASC by created_at
 *   - listBindings filtered by supplier with cursor pagination
 *   - factory refuses missing catalog handle
 *   - factory refuses missing cursorSecret in production
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0040_print_on_demand.sql"].map(function (f) {
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

// Seed a real product + variant for each requested SKU so the
// catalog.variants.bySku gate inside bindSku resolves. Returns the
// stub catalog handle the primitive expects.
async function _seedCatalog(query, skus) {
  var productId = bShop.framework.uuid.v7();
  var ts = Date.now();
  await query(
    "INSERT INTO products (id, slug, title, status, created_at, updated_at) " +
    "VALUES (?1, 'pod-test', 'POD Test', 'active', ?2, ?2)",
    [productId, ts],
  );
  for (var i = 0; i < skus.length; i += 1) {
    await query(
      "INSERT INTO variants (id, product_id, sku, title, options_json, weight_grams, " +
      "requires_shipping, position, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, '', '{}', 0, 1, 0, ?4, ?4)",
      [bShop.framework.uuid.v7(), productId, skus[i], ts],
    );
  }
  return {
    variants: {
      bySku: async function (sku) {
        var r = await query("SELECT * FROM variants WHERE sku = ?1", [sku]);
        return r.rows[0] || null;
      },
    },
  };
}

function _orderId() { return bShop.framework.uuid.v7(); }

function _validBinding(extras) {
  var base = {
    sku:                 "TEE-BLK-L",
    supplier:            "printful",
    supplier_product_id: "12345",
    supplier_variant_id: "67890",
    artwork_url:         "https://cdn.example.com/art/tee-blk-l.png",
    position:            { x: 0, y: 0, w: 12, h: 16, dpi: 300 },
    colorway:            "dark",
    cost_minor:          1200,
  };
  if (extras) {
    for (var k in extras) {
      if (Object.prototype.hasOwnProperty.call(extras, k)) base[k] = extras[k];
    }
  }
  return base;
}

async function _bindSkuHappyPath() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });

  var bound = await pod.bindSku(_validBinding());
  check("bindSku returns row",              bound && bound.sku === "TEE-BLK-L");
  check("bindSku persists supplier",        bound.supplier === "printful");
  check("bindSku persists supplier_product",bound.supplier_product_id === "12345");
  check("bindSku persists supplier_variant",bound.supplier_variant_id === "67890");
  check("bindSku persists artwork_url",     bound.artwork_url === "https://cdn.example.com/art/tee-blk-l.png");
  check("bindSku persists cost_minor",      bound.cost_minor === 1200);
  check("bindSku persists colorway",        bound.colorway === "dark");
  check("bindSku persists position",        bound.position && bound.position.dpi === 300);

  var fetched = await pod.getBinding("TEE-BLK-L");
  check("getBinding round-trip",            fetched && fetched.sku === "TEE-BLK-L");

  // Refuse rebind via bindSku — caller must unbind first.
  await assert.rejects(pod.bindSku(_validBinding()),                /already bound/);
}

async function _bindSkuRefusals() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });

  // SKU not in catalog — refused
  await assert.rejects(pod.bindSku(_validBinding({ sku: "DOES-NOT-EXIST" })), /not found in catalog/);

  // Unknown supplier — enum refusal
  await assert.rejects(pod.bindSku(_validBinding({ supplier: "alibaba" })),    /supplier must be one of/);
  await assert.rejects(pod.bindSku(_validBinding({ supplier: "" })),           /supplier/);
  await assert.rejects(pod.bindSku(_validBinding({ supplier: null })),         /supplier/);

  // Missing required fields
  await assert.rejects(pod.bindSku(_validBinding({ supplier_product_id: "" })), /supplier_product_id/);
  await assert.rejects(pod.bindSku(_validBinding({ supplier_variant_id: "" })), /supplier_variant_id/);
  await assert.rejects(pod.bindSku(_validBinding({ artwork_url: "" })),         /artwork_url/);

  // Bad cost_minor
  await assert.rejects(pod.bindSku(_validBinding({ cost_minor: -1 })),          /cost_minor/);
  await assert.rejects(pod.bindSku(_validBinding({ cost_minor: 1.5 })),         /cost_minor/);

  // Bad position shape
  await assert.rejects(pod.bindSku(_validBinding({ position: { x: -1 } })),     /position\.x/);
  await assert.rejects(pod.bindSku(_validBinding({ position: "wat" })),         /position/);

  // Bad sku shape
  await assert.rejects(pod.bindSku(_validBinding({ sku: "" })),                  /sku/);
  await assert.rejects(pod.bindSku(_validBinding({ sku: "has spaces" })),        /sku/);

  // Bad input shape
  await assert.rejects(pod.bindSku(),                                            /input object required/);
  await assert.rejects(pod.bindSku(null),                                        /input object required/);
}

async function _updateBindingAndUnbind() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });
  await pod.bindSku(_validBinding());

  var patched = await pod.updateBinding("TEE-BLK-L", { cost_minor: 1500, colorway: "light" });
  check("updateBinding patches cost_minor",  patched.cost_minor === 1500);
  check("updateBinding patches colorway",    patched.colorway === "light");

  var patched2 = await pod.updateBinding("TEE-BLK-L", {
    supplier: "printify",
    supplier_product_id: "PFY-1",
  });
  check("updateBinding patches supplier",    patched2.supplier === "printify");
  check("updateBinding patches sup_prod_id", patched2.supplier_product_id === "PFY-1");

  // Disallowed column refused (sku is the PK; created_at is immutable)
  await assert.rejects(pod.updateBinding("TEE-BLK-L", { sku: "OTHER" }),         /not in allowlist|allowed|sku/);
  await assert.rejects(pod.updateBinding("TEE-BLK-L", { created_at: 0 }),        /not in allowlist|allowed|created_at/);

  // Empty patch refused
  await assert.rejects(pod.updateBinding("TEE-BLK-L", {}),                       /at least one allowed column/);

  // Unknown sku refused
  await assert.rejects(pod.updateBinding("UNKNOWN", { cost_minor: 100 }),        /not bound/);

  // Unbind removes the row
  var removed = await pod.unbindSku("TEE-BLK-L");
  check("unbindSku returns true on remove", removed === true);
  var gone = await pod.getBinding("TEE-BLK-L");
  check("unbindSku clears the row",         gone === null);

  // Idempotent: unbind again is a no-op
  var second = await pod.unbindSku("TEE-BLK-L");
  check("unbindSku idempotent",             second === false);
}

async function _costForOrderAggregation() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L", "TEE-WHT-M", "POSTER-A2", "UNBOUND-SKU"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });

  await pod.bindSku(_validBinding({ sku: "TEE-BLK-L", supplier: "printful", cost_minor: 1200 }));
  await pod.bindSku(_validBinding({ sku: "TEE-WHT-M", supplier: "printful", cost_minor: 1100 }));
  await pod.bindSku(_validBinding({ sku: "POSTER-A2", supplier: "gelato",   cost_minor: 800,
                                    supplier_product_id: "GE-1", supplier_variant_id: "GE-V" }));

  var costs = await pod.costForOrder([
    { sku: "TEE-BLK-L",  qty: 2 },  // 1200 * 2 = 2400
    { sku: "TEE-WHT-M",  qty: 1 },  // 1100 * 1 = 1100
    { sku: "POSTER-A2",  qty: 3 },  //  800 * 3 = 2400
    { sku: "UNBOUND-SKU", qty: 1 }, // 0; surfaced on unbound
  ]);
  check("costForOrder total",                  costs.total_cost_minor === 2400 + 1100 + 2400);
  check("costForOrder printful sum",           costs.by_supplier.printful.cost_minor === 2400 + 1100);
  check("costForOrder printful line_count",    costs.by_supplier.printful.line_count === 2);
  check("costForOrder gelato sum",             costs.by_supplier.gelato.cost_minor === 2400);
  check("costForOrder gelato line_count",      costs.by_supplier.gelato.line_count === 1);
  check("costForOrder unbound_skus",           costs.unbound_skus.length === 1 && costs.unbound_skus[0] === "UNBOUND-SKU");

  // Bad input shapes
  await assert.rejects(pod.costForOrder([]),                                     /non-empty array/);
  await assert.rejects(pod.costForOrder([{ sku: "TEE-BLK-L", qty: 0 }]),         /qty/);
  await assert.rejects(pod.costForOrder([{ sku: "TEE-BLK-L", qty: -1 }]),        /qty/);
  await assert.rejects(pod.costForOrder([{ sku: "TEE-BLK-L" }]),                 /qty/);
}

async function _forwardOrderHappyPath() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L", "POSTER-A2", "UNBOUND-SKU"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });

  await pod.bindSku(_validBinding({ sku: "TEE-BLK-L", supplier: "printful" }));
  await pod.bindSku(_validBinding({ sku: "POSTER-A2", supplier: "gelato",
                                    supplier_product_id: "GE-1", supplier_variant_id: "GE-V" }));

  var orderId = _orderId();
  var result = await pod.forwardOrder({
    order_id:         orderId,
    shipping_address: { country: "US", postal: "94105" },
    lines: [
      { sku: "TEE-BLK-L",  qty: 2 },
      { sku: "POSTER-A2",  qty: 1 },
      { sku: "UNBOUND-SKU", qty: 4 },
    ],
  });
  check("forwardOrder returns ids array",       Array.isArray(result.fulfillment_ids) && result.fulfillment_ids.length === 2);
  check("forwardOrder surfaces unbound",        result.unbound_skus.length === 1 && result.unbound_skus[0] === "UNBOUND-SKU");

  var rows = await pod.fulfillmentsForOrder(orderId);
  check("fulfillmentsForOrder returns two",     rows.length === 2);
  check("fulfillments status pending",          rows.every(function (r) { return r.status === "pending"; }));

  var bySupplier = {};
  rows.forEach(function (r) { bySupplier[r.supplier] = r; });
  check("printful fulfillment present",         !!bySupplier.printful);
  check("gelato fulfillment present",           !!bySupplier.gelato);
  check("printful lines bundled",               bySupplier.printful.lines.length === 1 &&
                                                bySupplier.printful.lines[0].sku === "TEE-BLK-L" &&
                                                bySupplier.printful.lines[0].qty === 2);
  check("gelato lines bundled",                 bySupplier.gelato.lines.length === 1 &&
                                                bySupplier.gelato.lines[0].sku === "POSTER-A2");
  check("fulfillment shipping round-trip",      bySupplier.printful.shipping.country === "US");

  // forwardOrder bad inputs
  await assert.rejects(pod.forwardOrder(),                                                  /input object required/);
  await assert.rejects(pod.forwardOrder({ order_id: "not-a-uuid" }),                        /order_id/);
  await assert.rejects(pod.forwardOrder({ order_id: _orderId(), shipping_address: {}, lines: [] }), /country/);
  await assert.rejects(pod.forwardOrder({
    order_id: _orderId(), shipping_address: { country: "US" }, lines: [],
  }),                                                                                       /non-empty array/);
}

async function _fulfillmentFsmTransitions() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });
  await pod.bindSku(_validBinding());

  var orderId = _orderId();
  var forwarded = await pod.forwardOrder({
    order_id:         orderId,
    shipping_address: { country: "US" },
    lines:            [{ sku: "TEE-BLK-L", qty: 1 }],
  });
  var fid = forwarded.fulfillment_ids[0];

  // pending → submitted
  var submitted = await pod.markFulfillmentSubmitted({
    pod_fulfillment_id: fid,
    supplier_order_id:  "PF-ORDER-99",
  });
  check("submit transitions to submitted",      submitted.status === "submitted");
  check("submit stores supplier_order_id",      submitted.supplier_order_id === "PF-ORDER-99");
  check("submit stamps submitted_at",           typeof submitted.submitted_at === "number" && submitted.submitted_at > 0);

  // submitted → shipped
  var shipped = await pod.markFulfillmentShipped({
    pod_fulfillment_id: fid,
    tracking_number:    "1Z999AA10123456784",
    carrier:            "UPS",
  });
  check("ship transitions to shipped",          shipped.status === "shipped");
  check("ship stores tracking_number",          shipped.tracking_number === "1Z999AA10123456784");
  check("ship stores carrier",                  shipped.carrier === "UPS");
  check("ship stamps shipped_at",               typeof shipped.shipped_at === "number" && shipped.shipped_at > 0);

  // shipped is terminal — submit / ship / fail / cancel all refused
  await assert.rejects(pod.markFulfillmentSubmitted({ pod_fulfillment_id: fid, supplier_order_id: "x" }),
                                                                                /refused|transition/);
  await assert.rejects(pod.markFulfillmentFailed({ pod_fulfillment_id: fid, error: "too late" }),
                                                                                /refused|transition/);
  await assert.rejects(pod.markFulfillmentCancelled({ pod_fulfillment_id: fid }),
                                                                                /refused|transition/);
}

async function _fulfillmentCancelAndFail() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-BLK-L"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });
  await pod.bindSku(_validBinding());

  // Cancel from pending
  var f1 = await pod.forwardOrder({
    order_id: _orderId(), shipping_address: { country: "US" },
    lines: [{ sku: "TEE-BLK-L", qty: 1 }],
  });
  var cancelled = await pod.markFulfillmentCancelled({
    pod_fulfillment_id: f1.fulfillment_ids[0],
    reason:             "customer changed mind",
  });
  check("cancel transitions to cancelled",      cancelled.status === "cancelled");
  check("cancel persists reason in error col",  cancelled.error && cancelled.error.indexOf("customer changed mind") !== -1);

  // Fail from submitted
  var f2 = await pod.forwardOrder({
    order_id: _orderId(), shipping_address: { country: "US" },
    lines: [{ sku: "TEE-BLK-L", qty: 1 }],
  });
  await pod.markFulfillmentSubmitted({
    pod_fulfillment_id: f2.fulfillment_ids[0],
    supplier_order_id:  "PF-FAIL-1",
  });
  var failed = await pod.markFulfillmentFailed({
    pod_fulfillment_id: f2.fulfillment_ids[0],
    error:              "artwork rejected — DPI too low",
  });
  check("fail transitions to failed",           failed.status === "failed");
  check("fail persists error",                  failed.error === "artwork rejected — DPI too low");

  // Unknown fulfillment id refused
  await assert.rejects(pod.markFulfillmentSubmitted({
    pod_fulfillment_id: bShop.framework.uuid.v7(), supplier_order_id: "x",
  }),                                                                            /not found/);

  // Bad-shape refusals
  await assert.rejects(pod.markFulfillmentSubmitted(),                           /input object required/);
  await assert.rejects(pod.markFulfillmentShipped({ pod_fulfillment_id: "not-a-uuid",
                                                    tracking_number: "x", carrier: "y" }),
                                                                                /pod_fulfillment_id/);
  await assert.rejects(pod.markFulfillmentShipped({
    pod_fulfillment_id: f1.fulfillment_ids[0], tracking_number: "", carrier: "y",
  }),                                                                            /tracking_number/);
}

async function _fulfillmentsForOrderOrdering() {
  var q = _makeQuery();
  var catalog = await _seedCatalog(q, ["TEE-A", "TEE-B", "TEE-C"]);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });
  await pod.bindSku(_validBinding({ sku: "TEE-A", supplier: "printful" }));
  await pod.bindSku(_validBinding({ sku: "TEE-B", supplier: "printify" }));
  await pod.bindSku(_validBinding({ sku: "TEE-C", supplier: "gelato",
                                    supplier_product_id: "G-1", supplier_variant_id: "G-V" }));

  var orderId = _orderId();
  // forwardOrder writes one row per supplier present on the order.
  // The forward loop iterates Object.keys(perSupplier) in insertion
  // order, so we'll get printful → printify → gelato in that order
  // (the bucket fills in line-order).
  var result = await pod.forwardOrder({
    order_id:         orderId,
    shipping_address: { country: "US" },
    lines: [
      { sku: "TEE-A", qty: 1 },
      { sku: "TEE-B", qty: 1 },
      { sku: "TEE-C", qty: 1 },
    ],
  });
  check("three suppliers → three rows",         result.fulfillment_ids.length === 3);

  var rows = await pod.fulfillmentsForOrder(orderId);
  check("fulfillmentsForOrder length",          rows.length === 3);
  // Ordering is by created_at ASC, id ASC. Each row was written
  // in sequence so created_at is monotonically non-decreasing and
  // the v7 ids tie-break in insertion order.
  for (var i = 1; i < rows.length; i += 1) {
    check("ordered ASC at row " + i,
      rows[i].created_at > rows[i - 1].created_at ||
      (rows[i].created_at === rows[i - 1].created_at && rows[i].id > rows[i - 1].id));
  }

  // pendingFulfillments returns all three with no filter
  var pendingAll = await pod.pendingFulfillments({});
  check("pendingFulfillments all",              pendingAll.length === 3);
  // Filter by supplier
  var pendingPf = await pod.pendingFulfillments({ supplier: "printful" });
  check("pendingFulfillments supplier filter",  pendingPf.length === 1 && pendingPf[0].supplier === "printful");

  // pendingFulfillments bad inputs
  await assert.rejects(pod.pendingFulfillments({ supplier: "weird" }),            /supplier/);
  await assert.rejects(pod.pendingFulfillments({ limit: 0 }),                     /limit/);
  await assert.rejects(pod.pendingFulfillments({ limit: 9999 }),                  /limit/);

  // getFulfillment round-trip
  var one = await pod.getFulfillment(result.fulfillment_ids[0]);
  check("getFulfillment round-trip",            one && one.id === result.fulfillment_ids[0]);
  var missing = await pod.getFulfillment(bShop.framework.uuid.v7());
  check("getFulfillment miss returns null",     missing === null);

  // fulfillmentsForOrder bad inputs
  await assert.rejects(pod.fulfillmentsForOrder("not-a-uuid"),                    /order_id/);
}

async function _listBindingsPagination() {
  var q = _makeQuery();
  var skus = ["AA-1", "AA-2", "BB-1", "BB-2", "BB-3"];
  var catalog = await _seedCatalog(q, skus);
  var pod = bShop.printOnDemand.create({ query: q, catalog: catalog });

  // Two suppliers: printful for AA-* (2 rows), printify for BB-* (3 rows)
  await pod.bindSku(_validBinding({ sku: "AA-1", supplier: "printful" }));
  await pod.bindSku(_validBinding({ sku: "AA-2", supplier: "printful" }));
  await pod.bindSku(_validBinding({ sku: "BB-1", supplier: "printify" }));
  await pod.bindSku(_validBinding({ sku: "BB-2", supplier: "printify" }));
  await pod.bindSku(_validBinding({ sku: "BB-3", supplier: "printify" }));

  // No filter — all 5
  var all = await pod.listBindings({ limit: 10 });
  check("listBindings all",                     all.rows.length === 5);
  check("listBindings ordered sku ASC",         all.rows[0].sku === "AA-1" && all.rows[4].sku === "BB-3");
  check("listBindings hydrates position",       all.rows[0].position && typeof all.rows[0].position === "object");
  check("listBindings no next on last page",    all.next_cursor === null);

  // Supplier filter
  var pf = await pod.listBindings({ supplier: "printful", limit: 10 });
  check("listBindings supplier filter (pf)",    pf.rows.length === 2);
  var pfy = await pod.listBindings({ supplier: "printify", limit: 10 });
  check("listBindings supplier filter (pfy)",   pfy.rows.length === 3);

  // Pagination: limit=2 against printify (3 rows) → split across two pages
  var pageA = await pod.listBindings({ supplier: "printify", limit: 2 });
  check("listBindings page A",                  pageA.rows.length === 2 && typeof pageA.next_cursor === "string");
  var pageB = await pod.listBindings({ supplier: "printify", limit: 2, cursor: pageA.next_cursor });
  check("listBindings page B",                  pageB.rows.length === 1);
  var seen = {};
  pageA.rows.concat(pageB.rows).forEach(function (r) { seen[r.sku] = true; });
  check("listBindings pagination covers all",   Object.keys(seen).length === 3);

  // Bad inputs
  await assert.rejects(pod.listBindings({ cursor: "garbage" }),                   /cursor/);
  await assert.rejects(pod.listBindings({ cursor: 12345 }),                       /cursor/);
  await assert.rejects(pod.listBindings({ supplier: "weird" }),                   /supplier/);
  await assert.rejects(pod.listBindings({ limit: 0 }),                            /limit/);
  await assert.rejects(pod.listBindings({ limit: 9999 }),                         /limit/);
}

async function _factoryRefusals() {
  // Missing catalog → refused
  assert.throws(function () { bShop.printOnDemand.create({}); },                  /catalog/);
  assert.throws(function () { bShop.printOnDemand.create({ catalog: {} }); },     /catalog/);
  assert.throws(function () {
    bShop.printOnDemand.create({ catalog: { variants: {} } });
  },                                                                              /bySku/);

  // Production-without-cursorSecret → refused
  var origEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    var stubCatalog = { variants: { bySku: async function () { return null; } } };
    assert.throws(function () { bShop.printOnDemand.create({ catalog: stubCatalog }); },
      /cursorSecret is required/);
  } finally {
    if (origEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origEnv;
  }
}

async function run() {
  await _bindSkuHappyPath();
  await _bindSkuRefusals();
  await _updateBindingAndUnbind();
  await _costForOrderAggregation();
  await _forwardOrderHappyPath();
  await _fulfillmentFsmTransitions();
  await _fulfillmentCancelAndFail();
  await _fulfillmentsForOrderOrdering();
  await _listBindingsPagination();
  await _factoryRefusals();
}

module.exports = { run: run };
