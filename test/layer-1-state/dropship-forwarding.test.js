"use strict";
/**
 * dropship-forwarding — general-purpose drop-ship vendor binding +
 * per-order forward-to-vendor record.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0154
 * (dropship_bindings + dropship_forwardings).
 *
 * Coverage:
 *   - bindSkuToVendor happy path: persists row, returns shape
 *   - bindSkuToVendor refusals: bad sku / vendor_slug / cost_minor
 *     / currency / lead_time_days / return_policy; rebind refused
 *   - forwardOrder writes one row per (order, vendor, sku)
 *   - forwardOrder surfaces unbound + archived SKUs separately
 *   - FSM transitions: queued -> accepted -> shipped -> delivered
 *     (timestamps + vendor_ref + carrier + tracking_number set)
 *   - FSM transitions: queued -> failed, accepted -> failed,
 *     shipped -> returned, delivered -> returned (terminal beats)
 *   - FSM refusal from terminal state (failed / returned)
 *   - metricsForVendor aggregates counts + avg ship latency across
 *     the closed [from, to) window
 *   - factory wires optional vendors handle and refuses bind
 *     against an unknown slug when the handle is wired
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

// Require the module directly so this test stays independent of
// `lib/index.js` export ordering (the operator wires the primitive
// into the package surface manually after the patch lands).
var dropshipForwarding = require("../../lib/dropship-forwarding");
var bShop              = require("../../lib");
var helpers            = require("../helpers");
var check              = helpers.check;
var assert             = helpers.assert;

var MIGS = ["0154_dropship_forwarding.sql"].map(function (f) {
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

function _orderId() { return bShop.framework.uuid.v7(); }

function _validBinding(extras) {
  var base = {
    sku:            "DS-TOOL-7",
    vendor_slug:    "acme-tools",
    cost_minor:     2500,
    currency:       "USD",
    lead_time_days: 5,
    return_policy:  "30-day return, customer pays return shipping",
  };
  if (extras) {
    for (var k in extras) {
      if (Object.prototype.hasOwnProperty.call(extras, k)) base[k] = extras[k];
    }
  }
  return base;
}

function _addr(extras) {
  var a = { country: "US", postal: "94105", line1: "1 Market St", city: "San Francisco" };
  if (extras) {
    for (var k in extras) {
      if (Object.prototype.hasOwnProperty.call(extras, k)) a[k] = extras[k];
    }
  }
  return a;
}

async function _bindSkuToVendorHappyPath() {
  var q = _makeQuery();
  var ds = dropshipForwarding.create({ query: q });

  var bound = await ds.bindSkuToVendor(_validBinding());
  check("bindSkuToVendor returns row",         bound && bound.sku === "DS-TOOL-7");
  check("bindSkuToVendor persists vendor",     bound.vendor_slug === "acme-tools");
  check("bindSkuToVendor persists cost_minor", bound.cost_minor === 2500);
  check("bindSkuToVendor persists currency",   bound.currency === "USD");
  check("bindSkuToVendor persists lead_time",  bound.lead_time_days === 5);
  check("bindSkuToVendor persists policy",     bound.return_policy.indexOf("30-day return") === 0);
  check("bindSkuToVendor not archived",        bound.archived_at == null);
  check("bindSkuToVendor stamps created_at",   typeof bound.created_at === "number" && bound.created_at > 0);
  check("bindSkuToVendor created==updated",    bound.created_at === bound.updated_at);

  // Refuse rebind via bindSkuToVendor.
  await assert.rejects(ds.bindSkuToVendor(_validBinding()),                                /already bound/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "other-vendor" })), /already bound/);
}

async function _bindSkuToVendorRefusals() {
  var q = _makeQuery();
  var ds = dropshipForwarding.create({ query: q });

  // Bad sku shape
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ sku: "" })),               /sku/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ sku: "has spaces" })),     /sku/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ sku: null })),             /sku/);

  // Bad vendor_slug
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "" })),       /vendor_slug/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "ACME" })),   /vendor_slug/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "-foo" })),   /vendor_slug/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "foo-" })),   /vendor_slug/);

  // Bad cost_minor
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ cost_minor: -1 })),        /cost_minor/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ cost_minor: 1.5 })),       /cost_minor/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ cost_minor: "10" })),      /cost_minor/);

  // Bad currency
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ currency: "usd" })),       /currency/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ currency: "EURO" })),      /currency/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ currency: "" })),          /currency/);

  // Bad lead_time_days
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ lead_time_days: -1 })),    /lead_time_days/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ lead_time_days: 1000 })),  /lead_time_days/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ lead_time_days: 1.5 })),   /lead_time_days/);

  // Bad return_policy
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ return_policy: "" })),     /return_policy/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ return_policy: null })),   /return_policy/);
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ return_policy: "ok\x00bad" })), /return_policy/);

  // Bad input shape
  await assert.rejects(ds.bindSkuToVendor(),                                         /input object required/);
  await assert.rejects(ds.bindSkuToVendor(null),                                     /input object required/);
}

async function _forwardOrderWritesPerVendor() {
  var q = _makeQuery();
  var ds = dropshipForwarding.create({ query: q });
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-A", vendor_slug: "acme-tools" }));
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-B", vendor_slug: "acme-tools" }));
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-C", vendor_slug: "globex"     }));

  // Bind an SKU then mark it archived to exercise the archived
  // surfacing branch.
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-ARCHIVED", vendor_slug: "globex" }));
  await q("UPDATE dropship_bindings SET archived_at = ?1 WHERE sku = ?2", [Date.now(), "DS-ARCHIVED"]);

  var orderId = _orderId();
  var result = await ds.forwardOrder({
    order_id: orderId,
    lines: [
      { sku: "DS-A",        quantity: 2, shipping_address: _addr() },
      { sku: "DS-B",        quantity: 1, shipping_address: _addr() },
      { sku: "DS-C",        quantity: 3, shipping_address: _addr({ country: "CA" }) },
      { sku: "DS-NOPE",     quantity: 1, shipping_address: _addr() },
      { sku: "DS-ARCHIVED", quantity: 4, shipping_address: _addr() },
    ],
  });
  check("forwardOrder writes per-vendor row",    result.forwarding_ids.length === 3);
  check("forwardOrder surfaces unbound",         result.unbound_skus.length === 1 && result.unbound_skus[0] === "DS-NOPE");
  check("forwardOrder surfaces archived",        result.archived_skus.length === 1 && result.archived_skus[0] === "DS-ARCHIVED");

  var rows = await ds.forwardingsForOrder(orderId);
  check("forwardingsForOrder returns three",     rows.length === 3);
  check("forwardings all queued",                rows.every(function (r) { return r.status === "queued"; }));

  var bySku = {};
  rows.forEach(function (r) { bySku[r.sku] = r; });
  check("DS-A forwarding present",               !!bySku["DS-A"] && bySku["DS-A"].vendor_slug === "acme-tools");
  check("DS-A quantity persisted",               bySku["DS-A"].quantity === 2);
  check("DS-A address round-trip",               bySku["DS-A"].shipping_address.country === "US");
  check("DS-C vendor is globex",                 bySku["DS-C"].vendor_slug === "globex");
  check("DS-C address per-line",                 bySku["DS-C"].shipping_address.country === "CA");

  // forwardOrder bad inputs
  await assert.rejects(ds.forwardOrder(),                                          /input object required/);
  await assert.rejects(ds.forwardOrder({ order_id: "not-a-uuid", lines: [] }),     /order_id/);
  await assert.rejects(ds.forwardOrder({ order_id: _orderId() }),                  /lines/);
  await assert.rejects(ds.forwardOrder({ order_id: _orderId(), lines: [] }),       /non-empty/);
  await assert.rejects(ds.forwardOrder({
    order_id: _orderId(),
    lines: [{ sku: "DS-A", quantity: 0, shipping_address: _addr() }],
  }),                                                                              /quantity/);
  await assert.rejects(ds.forwardOrder({
    order_id: _orderId(),
    lines: [{ sku: "DS-A", quantity: 1, shipping_address: { country: "us" } }],
  }),                                                                              /country/);
  await assert.rejects(ds.forwardOrder({
    order_id: _orderId(),
    lines: [{ sku: "DS-A", quantity: 1, shipping_address: null }],
  }),                                                                              /shipping_address/);

  // pendingForwardings includes queued rows
  var pending = await ds.pendingForwardings({});
  check("pendingForwardings returns all queued", pending.length === 3);
  var pendingAcme = await ds.pendingForwardings({ vendor_slug: "acme-tools" });
  check("pendingForwardings filter by vendor",   pendingAcme.length === 2 &&
                                                  pendingAcme.every(function (r) { return r.vendor_slug === "acme-tools"; }));
  await assert.rejects(ds.pendingForwardings({ vendor_slug: "BAD" }),              /vendor_slug/);
  await assert.rejects(ds.pendingForwardings({ limit: 0 }),                        /limit/);
  await assert.rejects(ds.pendingForwardings({ limit: 9999 }),                     /limit/);
}

async function _fsmHappyPath() {
  var q = _makeQuery();
  var ds = dropshipForwarding.create({ query: q });
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-A" }));

  var orderId = _orderId();
  var result = await ds.forwardOrder({
    order_id: orderId,
    lines:    [{ sku: "DS-A", quantity: 1, shipping_address: _addr() }],
  });
  var fid = result.forwarding_ids[0];

  // queued -> accepted
  var accepted = await ds.markVendorAccepted({
    forwarding_id: fid,
    vendor_ref:    "ACME-PO-12345",
    eta:           Date.now() + 5 * 24 * 60 * 60 * 1000,
  });
  check("accept transitions to accepted",         accepted.status === "accepted");
  check("accept stores vendor_ref",               accepted.vendor_ref === "ACME-PO-12345");
  check("accept stores eta",                      typeof accepted.eta === "number" && accepted.eta > 0);

  // accepted -> shipped
  var shipped = await ds.markVendorShipped({
    forwarding_id:   fid,
    carrier:         "FedEx",
    tracking_number: "1Z999AA10123456784",
  });
  check("ship transitions to shipped",            shipped.status === "shipped");
  check("ship stores carrier",                    shipped.carrier === "FedEx");
  check("ship stores tracking_number",            shipped.tracking_number === "1Z999AA10123456784");
  check("ship stamps shipped_at",                 typeof shipped.shipped_at === "number" && shipped.shipped_at > 0);

  // shipped -> delivered
  var delivered = await ds.markVendorDelivered({ forwarding_id: fid });
  check("deliver transitions to delivered",       delivered.status === "delivered");
  check("deliver stamps delivered_at",            typeof delivered.delivered_at === "number" && delivered.delivered_at > 0);

  // delivered -> returned (terminal allowed leg)
  var returned = await ds.markVendorReturned({ forwarding_id: fid });
  check("return transitions to returned",         returned.status === "returned");
  check("return stamps returned_at",              typeof returned.returned_at === "number" && returned.returned_at > 0);

  // returned is terminal — every transition refused
  await assert.rejects(ds.markVendorAccepted({ forwarding_id: fid, vendor_ref: "x" }),
                                                                                  /refused|transition/);
  await assert.rejects(ds.markVendorShipped({ forwarding_id: fid, carrier: "x", tracking_number: "y" }),
                                                                                  /refused|transition/);
  await assert.rejects(ds.markVendorDelivered({ forwarding_id: fid }),
                                                                                  /refused|transition/);
  await assert.rejects(ds.markVendorFailed({ forwarding_id: fid, reason: "x" }),
                                                                                  /refused|transition/);
  await assert.rejects(ds.markVendorReturned({ forwarding_id: fid }),
                                                                                  /refused|transition/);
}

async function _fsmFailAndReturnBranches() {
  var q = _makeQuery();
  var ds = dropshipForwarding.create({ query: q });
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-A" }));

  // queued -> failed
  var r1 = await ds.forwardOrder({
    order_id: _orderId(),
    lines:    [{ sku: "DS-A", quantity: 1, shipping_address: _addr() }],
  });
  var failed1 = await ds.markVendorFailed({
    forwarding_id: r1.forwarding_ids[0],
    reason:        "vendor out of stock",
  });
  check("queued -> failed",                       failed1.status === "failed");
  check("fail stores reason",                     failed1.fail_reason === "vendor out of stock");
  check("fail stamps failed_at",                  typeof failed1.failed_at === "number" && failed1.failed_at > 0);

  // accepted -> failed
  var r2 = await ds.forwardOrder({
    order_id: _orderId(),
    lines:    [{ sku: "DS-A", quantity: 1, shipping_address: _addr() }],
  });
  await ds.markVendorAccepted({ forwarding_id: r2.forwarding_ids[0], vendor_ref: "REF-2" });
  var failed2 = await ds.markVendorFailed({
    forwarding_id: r2.forwarding_ids[0],
    reason:        "warehouse fire",
  });
  check("accepted -> failed",                     failed2.status === "failed");

  // shipped -> returned (skipping delivered — direct return-on-carrier)
  var r3 = await ds.forwardOrder({
    order_id: _orderId(),
    lines:    [{ sku: "DS-A", quantity: 1, shipping_address: _addr() }],
  });
  await ds.markVendorAccepted({ forwarding_id: r3.forwarding_ids[0], vendor_ref: "REF-3" });
  await ds.markVendorShipped({
    forwarding_id:   r3.forwarding_ids[0],
    carrier:         "UPS",
    tracking_number: "TRACK-3",
  });
  var ret3 = await ds.markVendorReturned({ forwarding_id: r3.forwarding_ids[0] });
  check("shipped -> returned",                    ret3.status === "returned");

  // Unknown forwarding id refused
  await assert.rejects(ds.markVendorAccepted({
    forwarding_id: bShop.framework.uuid.v7(),
    vendor_ref:    "x",
  }),                                                                              /not found/);

  // Bad-shape refusals
  await assert.rejects(ds.markVendorAccepted(),                                    /input object required/);
  await assert.rejects(ds.markVendorAccepted({ forwarding_id: "not-a-uuid", vendor_ref: "x" }),
                                                                                   /forwarding_id/);
  await assert.rejects(ds.markVendorAccepted({
    forwarding_id: r1.forwarding_ids[0], vendor_ref: "",
  }),                                                                              /vendor_ref/);
  await assert.rejects(ds.markVendorShipped({
    forwarding_id: r1.forwarding_ids[0], carrier: "x", tracking_number: "",
  }),                                                                              /tracking_number/);
  await assert.rejects(ds.markVendorShipped({
    forwarding_id: r1.forwarding_ids[0], carrier: "", tracking_number: "x",
  }),                                                                              /carrier/);
  await assert.rejects(ds.markVendorFailed({
    forwarding_id: r1.forwarding_ids[0], reason: "",
  }),                                                                              /reason/);
}

async function _metricsForVendorWindow() {
  var q = _makeQuery();
  var ds = dropshipForwarding.create({ query: q });
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-A", vendor_slug: "acme-tools" }));
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-B", vendor_slug: "acme-tools" }));
  await ds.bindSkuToVendor(_validBinding({ sku: "DS-C", vendor_slug: "globex"     }));

  var t0 = Date.now();

  // Two acme rows: one shipped, one failed
  var r1 = await ds.forwardOrder({
    order_id: _orderId(),
    lines:    [{ sku: "DS-A", quantity: 1, shipping_address: _addr() }],
  });
  await ds.markVendorAccepted({ forwarding_id: r1.forwarding_ids[0], vendor_ref: "PO-1" });
  await ds.markVendorShipped({
    forwarding_id:   r1.forwarding_ids[0],
    carrier:         "FedEx",
    tracking_number: "T-1",
  });

  var r2 = await ds.forwardOrder({
    order_id: _orderId(),
    lines:    [{ sku: "DS-B", quantity: 1, shipping_address: _addr() }],
  });
  await ds.markVendorFailed({ forwarding_id: r2.forwarding_ids[0], reason: "OOS" });

  // One globex row, queued only (should NOT appear in acme metrics)
  await ds.forwardOrder({
    order_id: _orderId(),
    lines:    [{ sku: "DS-C", quantity: 1, shipping_address: _addr() }],
  });

  var t1 = Date.now() + 60 * 1000;

  var m = await ds.metricsForVendor({ slug: "acme-tools", from: t0 - 1, to: t1 });
  check("metrics returns slug",                   m.slug === "acme-tools");
  check("metrics total counts acme only",         m.total === 2);
  check("metrics shipped count",                  m.counts.shipped === 1);
  check("metrics failed count",                   m.counts.failed === 1);
  check("metrics queued count is 0",              m.counts.queued === 0);
  check("metrics delivered count is 0",           m.counts.delivered === 0);
  check("metrics avg_ship_latency_ms reported",   typeof m.avg_ship_latency_ms === "number" && m.avg_ship_latency_ms >= 0);
  check("metrics shipped_for_latency",            m.shipped_for_latency === 1);

  // Window that excludes all rows -> empty metrics
  var mEmpty = await ds.metricsForVendor({ slug: "acme-tools", from: t1 + 1000, to: t1 + 2000 });
  check("empty-window total is 0",                mEmpty.total === 0);
  check("empty-window latency is null",           mEmpty.avg_ship_latency_ms === null);

  // Vendor with no rows -> empty metrics
  var mGhost = await ds.metricsForVendor({ slug: "ghost-vendor", from: t0 - 1, to: t1 });
  check("ghost-vendor total is 0",                mGhost.total === 0);

  // Bad input
  await assert.rejects(ds.metricsForVendor(),                                      /input object required/);
  await assert.rejects(ds.metricsForVendor({ slug: "BAD", from: 0, to: 1 }),       /slug/);
  await assert.rejects(ds.metricsForVendor({ slug: "acme-tools", from: -1, to: 1 }), /from/);
  await assert.rejects(ds.metricsForVendor({ slug: "acme-tools", from: 100, to: 100 }), /to must be > from/);
  await assert.rejects(ds.metricsForVendor({ slug: "acme-tools", from: 200, to: 100 }), /to must be > from/);
}

async function _vendorsHandleAndReads() {
  // When the operator wires a vendors handle, bindSkuToVendor
  // refuses against an unknown / archived slug.
  var q = _makeQuery();
  var fakeVendors = {
    _state: {
      "acme-tools": { slug: "acme-tools", status: "active"   },
      "old-vendor": { slug: "old-vendor", status: "archived" },
    },
    getVendor: async function (slug) { return this._state[slug] || null; },
  };
  var ds = dropshipForwarding.create({ query: q, vendors: fakeVendors });

  // Unknown vendor refused
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "ghost" })),
                                                                                   /not found in vendors registry/);
  // Archived vendor refused
  await assert.rejects(ds.bindSkuToVendor(_validBinding({ vendor_slug: "old-vendor" })),
                                                                                   /archived/);
  // Known active vendor accepted
  var bound = await ds.bindSkuToVendor(_validBinding({ sku: "DS-A", vendor_slug: "acme-tools" }));
  check("bind against known vendor succeeds",     bound.vendor_slug === "acme-tools");

  // getForwarding miss returns null
  var miss = await ds.getForwarding(bShop.framework.uuid.v7());
  check("getForwarding miss returns null",        miss === null);

  // getForwarding round-trip
  var orderId = _orderId();
  var r = await ds.forwardOrder({
    order_id: orderId,
    lines:    [{ sku: "DS-A", quantity: 1, shipping_address: _addr() }],
  });
  var fwd = await ds.getForwarding(r.forwarding_ids[0]);
  check("getForwarding round-trip",               fwd && fwd.id === r.forwarding_ids[0]);
  check("getForwarding hydrates address",         fwd.shipping_address.country === "US");

  // Bad uuid refusals on reads
  await assert.rejects(ds.getForwarding("not-a-uuid"),                             /forwarding_id/);
  await assert.rejects(ds.forwardingsForOrder("not-a-uuid"),                       /order_id/);

  // FSM definition is exposed for downstream callers that want to
  // mirror the state set without re-deriving the transitions
  check("FORWARDING_STATUSES exported",           dropshipForwarding.FORWARDING_STATUSES.length === 6);
  check("FSM exposes shape",                      typeof dropshipForwarding._getDropshipFsm === "function");
}

async function run() {
  await _bindSkuToVendorHappyPath();
  await _bindSkuToVendorRefusals();
  await _forwardOrderWritesPerVendor();
  await _fsmHappyPath();
  await _fsmFailAndReturnBranches();
  await _metricsForVendorWindow();
  await _vendorsHandleAndReads();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("dropship-forwarding tests OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (err) {
    process.stderr.write("dropship-forwarding tests FAIL: " + (err && err.stack || err) + "\n");
    process.exitCode = 1;
  });
}
