"use strict";
/**
 * auto-replenish — scheduler-driven layer that turns reorder
 * threshold fires into auto-submitted POs against bound vendors.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0155
 * (auto_replenish_policies + auto_replenish_runs). The composed deps
 * (reorderThresholds, purchaseOrders, vendors) are stubbed at the
 * factory boundary — the primitive's contract with each is the narrow
 * verb set the factory checks.
 *
 * Coverage:
 *   - definePolicy: insert + patch-in-place semantics, slug refusals,
 *     min/max consistency refusals, schedule enum refusals
 *   - tickReplenishment composes stub reorderThresholds + stub
 *     purchaseOrders.createDraft + submitToVendor
 *   - approval_required holds the PO at draft (no submit composed)
 *   - min/max PO value gates emit `proposed` runs with typed reasons
 *   - max_concurrent_open_pos cap blocks the submit
 *   - replenishmentHistory windowed read + vendor + status filters
 *   - schedule cadence gating across ticks
 *   - factory shape + run() smoke
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var autoReplenish = require("../../lib/auto-replenish");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0155_auto_replenish.sql");

var HOUR_MS = 60 * 60 * 1000;
var DAY_MS  = 24 * HOUR_MS;

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE" || verb === "ALTER") {
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

// Stub for reorderThresholds — returns a configurable candidate set.
function _stubReorderThresholds(candidatesByVendor) {
  candidatesByVendor = candidatesByVendor || {};
  var calls = [];
  return {
    calls: calls,
    scanAll: async function (input) {
      calls.push(input || {});
      var vendorSlug = input && input.vendor_slug;
      var out = [];
      var keys = Object.keys(candidatesByVendor);
      for (var i = 0; i < keys.length; i += 1) {
        if (vendorSlug == null || keys[i] === vendorSlug) {
          var lines = candidatesByVendor[keys[i]];
          for (var j = 0; j < lines.length; j += 1) {
            var line = lines[j];
            out.push({
              threshold_id:   "thr-" + keys[i] + "-" + j,
              sku:            line.sku,
              location_code:  null,
              vendor_slug:    keys[i],
              current_stock:  line.current_stock || 0,
              min_stock:      line.min_stock || 0,
              suggested_qty:  line.suggested_qty,
              days_of_supply: null,
              lead_time_days: 7,
              unit_cost_minor: line.unit_cost_minor,
              currency:       line.currency || "USD",
            });
          }
        }
      }
      return out;
    },
  };
}

// Stub for purchaseOrders. Tracks createDraft + submitToVendor calls;
// listPOs returns a configurable open-PO list for the concurrent-cap
// check.
function _stubPurchaseOrders(opts) {
  opts = opts || {};
  var calls = { createDraft: [], submitToVendor: [], listPOs: [] };
  var nextId = 0;
  var openPOs = (opts.openPOs || []).slice();
  return {
    calls: calls,
    setOpenPOs: function (rows) { openPOs = rows.slice(); },
    createDraft: async function (input) {
      calls.createDraft.push(input);
      if (opts.throwOnCreateDraft) throw new Error(opts.throwOnCreateDraft);
      nextId += 1;
      var po = {
        id: "po-" + nextId, vendor_slug: input.vendor_slug, status: "draft",
        lines: input.lines.slice(),
      };
      // Newly drafted POs count toward the open total on subsequent
      // listPOs reads (matches the real PO primitive's behavior).
      openPOs.push(po);
      return po;
    },
    submitToVendor: async function (input) {
      calls.submitToVendor.push(input);
      if (opts.throwOnSubmit) throw new Error(opts.throwOnSubmit);
      for (var i = 0; i < openPOs.length; i += 1) {
        if (openPOs[i].id === input.po_id) {
          openPOs[i].status = "submitted";
        }
      }
      return { id: input.po_id, status: "submitted" };
    },
    listPOs: async function (input) {
      calls.listPOs.push(input);
      var status = input && input.status;
      var vendorSlug = input && input.vendor_slug;
      return openPOs.filter(function (p) {
        if (status != null && p.status !== status) return false;
        if (vendorSlug != null && p.vendor_slug !== vendorSlug) return false;
        return true;
      });
    },
  };
}

function _stubVendors(vendorMap) {
  vendorMap = vendorMap || {};
  return {
    getVendor: async function (slug) {
      return vendorMap[slug] || null;
    },
  };
}

// ---- 1. definePolicy insert + patch + refusals ------------------------

async function _testDefinePolicy() {
  var query = _makeQuery();
  var ar = autoReplenish.create({ query: query });

  var p = await ar.definePolicy({
    slug:                    "house-supplies",
    vendor_slug:             "acme-supplies",
    min_po_value_minor:      10000,
    max_po_value_minor:      1000000,
    max_concurrent_open_pos: 5,
    approval_required:       false,
    schedule:                "daily",
  });
  check("definePolicy returns shaped row",       p && p.slug === "house-supplies");
  check("vendor_slug echoed",                    p.vendor_slug === "acme-supplies");
  check("min_po_value_minor echoed",             p.min_po_value_minor === 10000);
  check("max_po_value_minor echoed",             p.max_po_value_minor === 1000000);
  check("max_concurrent_open_pos echoed",        p.max_concurrent_open_pos === 5);
  check("approval_required false echoed",        p.approval_required === false);
  check("schedule daily echoed",                 p.schedule === "daily");
  check("last_run_at null on new policy",        p.last_run_at === null);
  check("archived_at null on new policy",        p.archived_at === null);
  check("created_at integer",                    Number.isInteger(p.created_at));

  // Re-definePolicy on the same slug patches in place.
  var p2 = await ar.definePolicy({
    slug:                    "house-supplies",
    vendor_slug:             "acme-supplies",
    min_po_value_minor:      20000,
    max_po_value_minor:      2000000,
    max_concurrent_open_pos: 10,
    approval_required:       true,
    schedule:                "weekly",
  });
  check("redefining same slug patches in place", p2.slug === "house-supplies");
  check("patched min",                           p2.min_po_value_minor === 20000);
  check("patched max",                           p2.max_po_value_minor === 2000000);
  check("patched cap",                           p2.max_concurrent_open_pos === 10);
  check("patched approval_required true",        p2.approval_required === true);
  check("patched schedule weekly",               p2.schedule === "weekly");
  check("created_at preserved across patch",     p2.created_at === p.created_at);
  check("updated_at advanced",                   p2.updated_at >= p.updated_at);

  // Slug refusals.
  await assert.rejects(ar.definePolicy({
    slug: "BAD-UPPER", vendor_slug: null, min_po_value_minor: 0,
    max_po_value_minor: 100, max_concurrent_open_pos: 1,
    approval_required: false, schedule: "daily",
  }), /slug must match/);

  // Schedule enum refusal.
  await assert.rejects(ar.definePolicy({
    slug: "x", vendor_slug: null, min_po_value_minor: 0,
    max_po_value_minor: 100, max_concurrent_open_pos: 1,
    approval_required: false, schedule: "fortnightly",
  }), /schedule must be one of/);

  // min > max refusal.
  await assert.rejects(ar.definePolicy({
    slug: "x", vendor_slug: null, min_po_value_minor: 5000,
    max_po_value_minor: 1000, max_concurrent_open_pos: 1,
    approval_required: false, schedule: "daily",
  }), /max_po_value_minor.*must be ≥ min_po_value_minor/);

  // approval_required must be boolean.
  await assert.rejects(ar.definePolicy({
    slug: "x", vendor_slug: null, min_po_value_minor: 0,
    max_po_value_minor: 100, max_concurrent_open_pos: 1,
    approval_required: "yes", schedule: "daily",
  }), /approval_required must be a boolean/);

  // Concurrent cap > 0.
  await assert.rejects(ar.definePolicy({
    slug: "x", vendor_slug: null, min_po_value_minor: 0,
    max_po_value_minor: 100, max_concurrent_open_pos: 0,
    approval_required: false, schedule: "daily",
  }), /max_concurrent_open_pos/);

  // Round-trip getPolicy + listPolicies.
  var got = await ar.getPolicy("house-supplies");
  check("getPolicy returns the patched row",     got && got.max_po_value_minor === 2000000);
  var listed = await ar.listPolicies({});
  check("listPolicies returns one row",          listed.length === 1);

  // Filter by vendor_slug.
  await ar.definePolicy({
    slug: "office-supplies", vendor_slug: "globex", min_po_value_minor: 0,
    max_po_value_minor: 5000, max_concurrent_open_pos: 2,
    approval_required: true, schedule: "daily",
  });
  var byVendor = await ar.listPolicies({ vendor_slug: "globex" });
  check("listPolicies vendor filter narrows",    byVendor.length === 1);
  check("vendor filter row is globex",           byVendor[0].vendor_slug === "globex");

  // updatePolicy partial patch.
  var upd = await ar.updatePolicy("house-supplies", { max_concurrent_open_pos: 7 });
  check("updatePolicy patched cap",              upd.max_concurrent_open_pos === 7);
  check("other fields preserved",                upd.max_po_value_minor === 2000000);
  await assert.rejects(ar.updatePolicy("does-not-exist", { schedule: "daily" }),
    /not found/);

  // archivePolicy soft-deletes; listPolicies hides archived by default.
  var arc = await ar.archivePolicy("office-supplies");
  check("archivePolicy stamps archived_at",      Number.isInteger(arc.archived_at));
  var activeOnly = await ar.listPolicies({});
  check("archived policy hidden by default",     activeOnly.length === 1);
  var withArchived = await ar.listPolicies({ include_archived: true });
  check("include_archived returns both",         withArchived.length === 2);
  // Re-archiving is idempotent.
  var arc2 = await ar.archivePolicy("office-supplies");
  check("re-archive preserves stamp",            arc2.archived_at === arc.archived_at);
}

// ---- 2. tickReplenishment composes scan + create + submit -------------

async function _testTickComposes() {
  var query = _makeQuery();
  var rt = _stubReorderThresholds({
    "acme-supplies": [
      { sku: "WIDGET-A", suggested_qty: 50, unit_cost_minor: 200 }, // 50 * 200 = 10000
      { sku: "WIDGET-B", suggested_qty: 30, unit_cost_minor: 500 }, // 30 * 500 = 15000
    ],
  });
  var po = _stubPurchaseOrders();
  var ar = autoReplenish.create({
    query:             query,
    reorderThresholds: rt,
    purchaseOrders:    po,
  });

  await ar.definePolicy({
    slug:                    "acme-auto",
    vendor_slug:             "acme-supplies",
    min_po_value_minor:      1000,
    max_po_value_minor:      100000,
    max_concurrent_open_pos: 5,
    approval_required:       false,
    schedule:                "hourly",
  });

  var summaries = await ar.tickReplenishment({ now: Date.now() });
  check("tickReplenishment returned one summary",  summaries.length === 1);
  check("summary status submitted",                summaries[0].status === "submitted");
  check("summary po_id stamped",                   typeof summaries[0].po_id === "string");
  check("summary qty_proposed = 80",               summaries[0].qty_proposed === 80);
  check("summary qty_submitted = 80",              summaries[0].qty_submitted === 80);
  check("scanAll called once",                     rt.calls.length === 1);
  check("scanAll called with vendor_slug",         rt.calls[0].vendor_slug === "acme-supplies");
  check("createDraft called once",                 po.calls.createDraft.length === 1);
  check("createDraft carries vendor",              po.calls.createDraft[0].vendor_slug === "acme-supplies");
  check("createDraft carries 2 lines",             po.calls.createDraft[0].lines.length === 2);
  check("createDraft line preserves sku",          po.calls.createDraft[0].lines[0].sku === "WIDGET-A");
  check("createDraft notes mark auto-replenish",
    /^auto-replenish:acme-auto$/.test(po.calls.createDraft[0].notes));
  check("submitToVendor called once",              po.calls.submitToVendor.length === 1);
  check("submitToVendor carries submitted_by",
    /^auto-replenish:acme-auto$/.test(po.calls.submitToVendor[0].submitted_by));

  // last_run_at advanced; a tick at the same `now` should skip (the
  // hourly interval hasn't elapsed).
  var policyAfter = await ar.getPolicy("acme-auto");
  check("last_run_at stamped",                     Number.isInteger(policyAfter.last_run_at));

  rt.calls.length = 0;
  var second = await ar.tickReplenishment({ now: Date.now() });
  check("immediate re-tick skips policy",          second.length === 0);
  check("scanAll not called again",                rt.calls.length === 0);

  // Tick well past the hourly window — fires again.
  var future = Date.now() + 2 * HOUR_MS;
  var third = await ar.tickReplenishment({ now: future });
  check("future tick re-fires policy",             third.length === 1);
  check("future tick produced second PO",          po.calls.createDraft.length === 2);

  // Empty-candidate scan → skipped run with no-candidates.
  var queryB = _makeQuery();
  var rtEmpty = _stubReorderThresholds({});
  var poB = _stubPurchaseOrders();
  var arB = autoReplenish.create({
    query: queryB, reorderThresholds: rtEmpty, purchaseOrders: poB,
  });
  await arB.definePolicy({
    slug: "empty-policy", vendor_slug: "ghost-vendor",
    min_po_value_minor: 0, max_po_value_minor: 100000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });
  var sumB = await arB.tickReplenishment({ now: Date.now() });
  check("empty scan status skipped",               sumB[0].status === "skipped");
  check("empty scan fail_reason no-candidates",    sumB[0].fail_reason === "no-candidates");
  check("empty scan did not call createDraft",     poB.calls.createDraft.length === 0);
}

// ---- 3. approval_required holds PO at draft ---------------------------

async function _testApprovalRequiredHoldsDraft() {
  var query = _makeQuery();
  var rt = _stubReorderThresholds({
    "approved-vendor": [
      { sku: "ITEM-X", suggested_qty: 100, unit_cost_minor: 1000 },
    ],
  });
  var po = _stubPurchaseOrders();
  var ar = autoReplenish.create({
    query: query, reorderThresholds: rt, purchaseOrders: po,
  });

  await ar.definePolicy({
    slug:                    "approved-policy",
    vendor_slug:             "approved-vendor",
    min_po_value_minor:      1000,
    max_po_value_minor:      1000000,
    max_concurrent_open_pos: 10,
    approval_required:       true,
    schedule:                "daily",
  });

  var summaries = await ar.tickReplenishment({ now: Date.now() });
  check("approval_required: one summary",            summaries.length === 1);
  check("approval_required: status proposed",        summaries[0].status === "proposed");
  check("approval_required: po_id stamped",          typeof summaries[0].po_id === "string");
  check("approval_required: qty_submitted = 0",      summaries[0].qty_submitted === 0);
  check("approval_required: qty_proposed = 100",     summaries[0].qty_proposed === 100);
  check("approval_required: createDraft called",     po.calls.createDraft.length === 1);
  check("approval_required: submitToVendor NOT called",
    po.calls.submitToVendor.length === 0);
}

// ---- 4. min/max PO value gates ----------------------------------------

async function _testMinMaxGates() {
  // Under-min — group value is below the policy's min_po_value_minor.
  var queryA = _makeQuery();
  var rtA = _stubReorderThresholds({
    "small-vendor": [
      { sku: "TRINKET", suggested_qty: 5, unit_cost_minor: 100 }, // 500
    ],
  });
  var poA = _stubPurchaseOrders();
  var arA = autoReplenish.create({
    query: queryA, reorderThresholds: rtA, purchaseOrders: poA,
  });
  await arA.definePolicy({
    slug: "min-gate", vendor_slug: "small-vendor",
    min_po_value_minor: 10000, max_po_value_minor: 1000000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });

  var sumA = await arA.tickReplenishment({ now: Date.now() });
  check("under-min: one summary",                  sumA.length === 1);
  check("under-min: status proposed",              sumA[0].status === "proposed");
  check("under-min: fail_reason under-min-po-value",
    sumA[0].fail_reason === "under-min-po-value");
  check("under-min: po_id null",                   sumA[0].po_id === null);
  check("under-min: createDraft NOT called",       poA.calls.createDraft.length === 0);

  // Over-max — group value exceeds max_po_value_minor.
  var queryB = _makeQuery();
  var rtB = _stubReorderThresholds({
    "big-vendor": [
      { sku: "BULK-A", suggested_qty: 5000, unit_cost_minor: 1000 }, // 5,000,000
    ],
  });
  var poB = _stubPurchaseOrders();
  var arB = autoReplenish.create({
    query: queryB, reorderThresholds: rtB, purchaseOrders: poB,
  });
  await arB.definePolicy({
    slug: "max-gate", vendor_slug: "big-vendor",
    min_po_value_minor: 0, max_po_value_minor: 1000000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });

  var sumB = await arB.tickReplenishment({ now: Date.now() });
  check("over-max: status proposed",                sumB[0].status === "proposed");
  check("over-max: fail_reason over-max-po-value",
    sumB[0].fail_reason === "over-max-po-value");
  check("over-max: createDraft NOT called",         poB.calls.createDraft.length === 0);
}

// ---- 5. max_concurrent_open_pos cap blocks submit ---------------------

async function _testConcurrentCap() {
  var query = _makeQuery();
  var rt = _stubReorderThresholds({
    "capped-vendor": [
      { sku: "ITEM-K", suggested_qty: 10, unit_cost_minor: 1000 }, // 10000
    ],
  });
  // Pre-load three open POs against the vendor so the cap of 3 is at
  // its ceiling.
  var po = _stubPurchaseOrders({
    openPOs: [
      { id: "po-pre-1", vendor_slug: "capped-vendor", status: "submitted" },
      { id: "po-pre-2", vendor_slug: "capped-vendor", status: "confirmed" },
      { id: "po-pre-3", vendor_slug: "capped-vendor", status: "partially_received" },
    ],
  });
  var ar = autoReplenish.create({
    query: query, reorderThresholds: rt, purchaseOrders: po,
  });
  await ar.definePolicy({
    slug: "cap-policy", vendor_slug: "capped-vendor",
    min_po_value_minor: 0, max_po_value_minor: 100000,
    max_concurrent_open_pos: 3, approval_required: false, schedule: "daily",
  });

  var summaries = await ar.tickReplenishment({ now: Date.now() });
  check("cap reached: status proposed",             summaries[0].status === "proposed");
  check("cap reached: fail_reason cap",
    summaries[0].fail_reason === "concurrent-open-cap-reached");
  check("cap reached: createDraft NOT called",      po.calls.createDraft.length === 0);
  check("cap reached: listPOs was queried",         po.calls.listPOs.length >= 1);
}

// ---- 6. replenishmentHistory windowed read + filters ------------------

async function _testReplenishmentHistory() {
  var query = _makeQuery();
  var ar = autoReplenish.create({ query: query });

  await ar.definePolicy({
    slug: "hist-a", vendor_slug: "vendor-a", min_po_value_minor: 0,
    max_po_value_minor: 100000, max_concurrent_open_pos: 5,
    approval_required: false, schedule: "daily",
  });
  await ar.definePolicy({
    slug: "hist-b", vendor_slug: "vendor-b", min_po_value_minor: 0,
    max_po_value_minor: 100000, max_concurrent_open_pos: 5,
    approval_required: true, schedule: "daily",
  });

  // Stamp some run rows via the markPolicyTriggered surface.
  await ar.markPolicyTriggered({
    policy_slug: "hist-a", po_id: "po-aa-1", qty_proposed: 100, qty_submitted: 100,
  });
  await ar.markPolicyTriggered({
    policy_slug: "hist-a", po_id: "po-aa-2", qty_proposed: 50, qty_submitted: 50,
  });
  await ar.markPolicyTriggered({
    policy_slug: "hist-b", po_id: "po-bb-1", qty_proposed: 20, qty_submitted: 0,
  });

  var nowAfter = Date.now() + 60000;
  var all = await ar.replenishmentHistory({ from: 0, to: nowAfter });
  check("history returns all 3 rows",              all.length === 3);

  var aOnly = await ar.replenishmentHistory({
    from: 0, to: nowAfter, vendor_slug: "vendor-a",
  });
  check("history vendor-a filter returns 2",       aOnly.length === 2);
  check("every row is hist-a",
    aOnly.every(function (r) { return r.policy_slug === "hist-a"; }));

  var submittedOnly = await ar.replenishmentHistory({
    from: 0, to: nowAfter, status: "submitted",
  });
  check("history status=submitted returns 2",      submittedOnly.length === 2);

  var proposedOnly = await ar.replenishmentHistory({
    from: 0, to: nowAfter, status: "proposed",
  });
  check("history status=proposed returns 1",       proposedOnly.length === 1);
  check("proposed row from hist-b",                proposedOnly[0].policy_slug === "hist-b");

  // Inverted window refused.
  await assert.rejects(ar.replenishmentHistory({ from: 100, to: 50 }),
    /to .* must be ≥ from/);

  // markPolicyTriggered refusals.
  await assert.rejects(ar.markPolicyTriggered({
    policy_slug: "does-not-exist", po_id: null, qty_proposed: 1, qty_submitted: 1,
  }), /not found/);
  await assert.rejects(ar.markPolicyTriggered({
    policy_slug: "hist-a", po_id: null, qty_proposed: 5, qty_submitted: 10,
  }), /qty_submitted.*must be ≤ qty_proposed/);
}

// ---- 7. factory shape + vendor-archived + dep-missing -----------------

async function _testFactoryShapeAndEdges() {
  var query = _makeQuery();

  // Factory: optional deps must be objects when supplied.
  assert.throws(function () {
    autoReplenish.create({ query: query, reorderThresholds: "nope" });
  }, /reorderThresholds must be/);
  assert.throws(function () {
    autoReplenish.create({ query: query, purchaseOrders: "nope" });
  }, /purchaseOrders must be/);
  assert.throws(function () {
    autoReplenish.create({ query: query, vendors: "nope" });
  }, /vendors must be/);

  // Deps with the wrong shape are also refused.
  assert.throws(function () {
    autoReplenish.create({ query: query, reorderThresholds: { wrong: true } });
  }, /scanAll/);
  assert.throws(function () {
    autoReplenish.create({ query: query, purchaseOrders: { wrong: true } });
  }, /createDraft.*submitToVendor.*listPOs/);

  // Vendor-archived path: with vendors wired, an archived vendor
  // produces a skipped run with `vendor-archived`.
  var queryA = _makeQuery();
  var rtA = _stubReorderThresholds({
    "old-vendor": [{ sku: "X", suggested_qty: 5, unit_cost_minor: 1000 }],
  });
  var poA = _stubPurchaseOrders();
  var vendorsA = _stubVendors({
    "old-vendor": { slug: "old-vendor", status: "archived" },
  });
  var arA = autoReplenish.create({
    query: queryA, reorderThresholds: rtA, purchaseOrders: poA, vendors: vendorsA,
  });
  await arA.definePolicy({
    slug: "old-policy", vendor_slug: "old-vendor",
    min_po_value_minor: 0, max_po_value_minor: 100000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });
  var sumA = await arA.tickReplenishment({ now: Date.now() });
  check("archived vendor: status skipped",         sumA[0].status === "skipped");
  check("archived vendor: fail_reason",            sumA[0].fail_reason === "vendor-archived");
  check("archived vendor: scanAll NOT called",     rtA.calls.length === 0);

  // Missing reorderThresholds dep at tick time → failed run.
  var queryB = _makeQuery();
  var poB = _stubPurchaseOrders();
  var arB = autoReplenish.create({ query: queryB, purchaseOrders: poB });
  await arB.definePolicy({
    slug: "no-rt", vendor_slug: "v",
    min_po_value_minor: 0, max_po_value_minor: 100000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });
  var sumB = await arB.tickReplenishment({ now: Date.now() });
  check("missing reorderThresholds: status failed", sumB[0].status === "failed");
  check("missing reorderThresholds: fail_reason",
    sumB[0].fail_reason === "reorder-thresholds-dep-missing");

  // Missing purchaseOrders dep at tick time → failed run.
  var queryC = _makeQuery();
  var rtC = _stubReorderThresholds({});
  var arC = autoReplenish.create({ query: queryC, reorderThresholds: rtC });
  await arC.definePolicy({
    slug: "no-po", vendor_slug: "v",
    min_po_value_minor: 0, max_po_value_minor: 100000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });
  var sumC = await arC.tickReplenishment({ now: Date.now() });
  check("missing purchaseOrders: status failed",   sumC[0].status === "failed");
  check("missing purchaseOrders: fail_reason",
    sumC[0].fail_reason === "purchase-orders-dep-missing");

  // createDraft throws → failed run, no submit composed.
  var queryD = _makeQuery();
  var rtD = _stubReorderThresholds({
    "thrower": [{ sku: "Y", suggested_qty: 10, unit_cost_minor: 1000 }],
  });
  var poD = _stubPurchaseOrders({ throwOnCreateDraft: "downstream-rejected" });
  var arD = autoReplenish.create({
    query: queryD, reorderThresholds: rtD, purchaseOrders: poD,
  });
  await arD.definePolicy({
    slug: "thrower-policy", vendor_slug: "thrower",
    min_po_value_minor: 0, max_po_value_minor: 100000,
    max_concurrent_open_pos: 5, approval_required: false, schedule: "daily",
  });
  var sumD = await arD.tickReplenishment({ now: Date.now() });
  check("createDraft throw: status failed",         sumD[0].status === "failed");
  check("createDraft throw: fail_reason carries msg",
    /create-draft-failed/.test(sumD[0].fail_reason));

  // tickReplenishment input refusals.
  var arE = autoReplenish.create({ query: _makeQuery() });
  await assert.rejects(arE.tickReplenishment({ batch_size: 0 }),    /batch_size/);
  await assert.rejects(arE.tickReplenishment({ batch_size: 9999 }), /batch_size/);
  await assert.rejects(arE.tickReplenishment({ now: -1 }),          /now/);

  // Module-level exports.
  check("module exports run()",
    typeof autoReplenish.run === "function");
  check("module exports SCHEDULES",
    Array.isArray(autoReplenish.SCHEDULES) && autoReplenish.SCHEDULES.length === 3);
  check("module exports RUN_STATUSES",
    Array.isArray(autoReplenish.RUN_STATUSES) && autoReplenish.RUN_STATUSES.length === 4);
  check("module exports SCHEDULE_INTERVAL_MS",
    typeof autoReplenish.SCHEDULE_INTERVAL_MS === "object" &&
    autoReplenish.SCHEDULE_INTERVAL_MS.daily === DAY_MS);

  // Refusals at the request-shape readers.
  await assert.rejects(arE.replenishmentHistory(),                 /input object required/);
  await assert.rejects(arE.markPolicyTriggered(),                  /input object required/);
  await assert.rejects(arE.definePolicy(),                         /input object required/);
}

// ---- 8. module-level run() smoke --------------------------------------

async function _testRunSmoke() {
  var res = await autoReplenish.run();
  check("module.run() returns ok",  res && res.ok === true);
}

async function run() {
  await _testDefinePolicy();
  await _testTickComposes();
  await _testApprovalRequiredHoldsDraft();
  await _testMinMaxGates();
  await _testConcurrentCap();
  await _testReplenishmentHistory();
  await _testFactoryShapeAndEdges();
  await _testRunSmoke();
  console.log("auto-replenish.test.js: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: run };

if (require.main === module) {
  run().catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
