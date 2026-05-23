"use strict";
/**
 * refundPolicy — operator-authored eligibility rules that decide
 * whether a refund request qualifies before the RMA workflow opens.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0090_refund_policy.sql`.
 *
 * Coverage:
 *   - definePolicy returns a hydrated row
 *   - definePolicy refuses bad slug / title / applies_to / refund_kind,
 *     invalid bps cross-checks, unknown exclusion axes, bad status
 *     entries, redefine
 *   - evaluate happy path: full-refund policy inside window with
 *     receipt -> eligible
 *   - evaluate refusal: request_date outside refund_window_days ->
 *     outside_refund_window
 *   - evaluate exclusions: category / vendor / sku / tag exclusion
 *     drops every matching line (all_lines_excluded), surviving lines
 *     keep the policy in scope
 *   - evaluate refund_kind cases: partial computes max_refund_minor =
 *     floor(total * bps / 10000); store_credit_only carries the same
 *     cap as full; no_refund returns eligible=false with the slug
 *   - evaluate restocking_fee_minor math: fee deducted from the cap;
 *     fee >= cap clamps to zero and reports
 *     restocking_fee_exceeds_refund
 *   - evaluate customer_status_in gate: matching status applies the
 *     policy; mismatched status refuses with customer_status_mismatch;
 *     guest with missing status refuses likewise
 *   - evaluate requires_receipt: missing receipt refuses with
 *     receipt_required
 *   - evaluate priority order: highest-priority eligible policy wins;
 *     lower-priority no_refund slot does not pre-empt
 *   - listPolicies active_only filter, updatePolicy refund_kind +
 *     bps cross-check, archivePolicy soft-delete + idempotency
 *   - auditEvaluation records eligible / denied / no_policy verdicts;
 *     listAudit round-trips the payload
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var refundPolicy = require("../../lib/refund-policy");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0090_refund_policy.sql");

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

// Calendar-day epoch helper. Picks midday UTC so day arithmetic stays
// boundary-clean across DST-naive inputs.
var DAY_MS = 24 * 60 * 60 * 1000;
function _day(n) { return n * DAY_MS + 12 * 60 * 60 * 1000; }

// ---- definePolicy: happy path ------------------------------------------

async function _definePolicyHappy() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  var p = await rp.definePolicy({
    slug:                  "default-30d",
    title:                 "Default 30-day refund",
    applies_to:            "all",
    refund_window_days:    30,
    exclusions:            { categories: ["final-sale"], skus: ["CUSTOM-1"] },
    refund_kind:           "full",
    restocking_fee_minor:  500,
    requires_receipt:      false,
    customer_status_in:    [],
    priority:              10,
  });

  check("definePolicy slug",                    p.slug === "default-30d");
  check("definePolicy title",                   p.title === "Default 30-day refund");
  check("definePolicy applies_to",              p.applies_to === "all");
  check("definePolicy refund_window_days",      p.refund_window_days === 30);
  check("definePolicy exclusions categories",   p.exclusions.categories.length === 1 && p.exclusions.categories[0] === "final-sale");
  check("definePolicy exclusions skus",         p.exclusions.skus.length === 1 && p.exclusions.skus[0] === "CUSTOM-1");
  check("definePolicy exclusions vendors empty", p.exclusions.vendors.length === 0);
  check("definePolicy exclusions tags empty",   p.exclusions.tags.length === 0);
  check("definePolicy refund_kind",             p.refund_kind === "full");
  check("definePolicy partial_bps null",        p.partial_refund_bps === null);
  check("definePolicy restocking_fee_minor",    p.restocking_fee_minor === 500);
  check("definePolicy requires_receipt false",  p.requires_receipt === false);
  check("definePolicy customer_status_in empty", p.customer_status_in.length === 0);
  check("definePolicy active default true",     p.active === true);
  check("definePolicy archived_at null",        p.archived_at === null);
  check("definePolicy priority",                p.priority === 10);
  check("definePolicy created_at integer",      Number.isInteger(p.created_at));

  var g = await rp.getPolicy("default-30d");
  check("getPolicy round-trips slug",           g.slug === "default-30d");

  var list = await rp.listPolicies();
  check("listPolicies returns the policy",      list.length === 1 && list[0].slug === "default-30d");
}

// ---- definePolicy: refusals --------------------------------------------

async function _definePolicyRefusals() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await assert.rejects(rp.definePolicy(), /input object required/);
  await assert.rejects(rp.definePolicy({
    slug: "Has Space", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
  }), /slug/);
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
  }), /title/);
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "unknown", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
  }), /applies_to/);
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: -1,
    refund_kind: "full", requires_receipt: false,
  }), /refund_window_days/);
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "unknown", requires_receipt: false,
  }), /refund_kind/);
  // partial without bps
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "partial", requires_receipt: false,
  }), /partial_refund_bps/);
  // full WITH bps
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", partial_refund_bps: 5000, requires_receipt: false,
  }), /partial_refund_bps/);
  // bps out of range
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "partial", partial_refund_bps: 10000, requires_receipt: false,
  }), /partial_refund_bps/);
  // unknown exclusion axis
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
    exclusions: { bogus: ["x"] },
  }), /exclusions/);
  // bad exclusion entry shape
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
    exclusions: { categories: ["has space"] },
  }), /exclusions\.categories/);
  // bad status entry
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
    customer_status_in: ["UPPER"],
  }), /customer_status_in/);
  // requires_receipt not a boolean
  await assert.rejects(rp.definePolicy({
    slug: "ok", title: "x", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: "yes",
  }), /requires_receipt/);

  // Successful define
  await rp.definePolicy({
    slug: "p1", title: "P1", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
  });
  await assert.rejects(rp.definePolicy({
    slug: "p1", title: "again", applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
  }), /already exists/);
}

// ---- evaluate: happy path ---------------------------------------------

async function _evaluateHappy() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "default-30d", title: "Default 30-day",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false, priority: 10,
  });

  var r = await rp.evaluate({
    order_id:          "order-1",
    order_total_minor: 5000,
    line_categories:   ["electronics"],
    line_vendors:      ["acme"],
    line_skus:         ["W-1"],
    line_tags:         ["new"],
    order_date:        _day(100),
    request_date:      _day(110),
    has_receipt:       true,
  });
  check("happy eligible",                   r.eligible === true);
  check("happy applied_policy",             r.applied_policy === "default-30d");
  check("happy refund_kind",                r.refund_kind === "full");
  check("happy max_refund_minor",           r.max_refund_minor === 5000);
  check("happy restocking_fee_minor",       r.restocking_fee_minor === 0);
  check("happy reasons contains matched",   r.reasons.indexOf("policy_matched") !== -1);
}

// ---- evaluate: outside refund window ----------------------------------

async function _evaluateOutsideWindow() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "default-30d", title: "Default 30-day",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false, priority: 10,
  });

  var r = await rp.evaluate({
    order_id:          "order-1",
    order_total_minor: 5000,
    line_categories:   ["electronics"],
    line_vendors:      ["acme"],
    line_skus:         ["W-1"],
    line_tags:         ["new"],
    order_date:        _day(100),
    request_date:      _day(140),                  // 40 days out
    has_receipt:       true,
  });
  check("outside-window eligible false",       r.eligible === false);
  check("outside-window applied_policy slug",  r.applied_policy === "default-30d");
  check("outside-window refund_kind",          r.refund_kind === "no_refund");
  check("outside-window max_refund_minor",     r.max_refund_minor === 0);
  check("outside-window reasons",              r.reasons.indexOf("outside_refund_window") !== -1);

  // Boundary: exactly N days = inside window.
  var rBoundary = await rp.evaluate({
    order_id:          "order-1",
    order_total_minor: 5000,
    line_categories:   ["electronics"],
    line_vendors:      ["acme"],
    line_skus:         ["W-1"],
    line_tags:         ["new"],
    order_date:        _day(100),
    request_date:      _day(130),                  // exactly 30 days
    has_receipt:       true,
  });
  check("boundary at window edge eligible",    rBoundary.eligible === true);

  // Just over: 31 days
  var rOver = await rp.evaluate({
    order_id:          "order-1",
    order_total_minor: 5000,
    line_categories:   ["electronics"],
    line_vendors:      ["acme"],
    line_skus:         ["W-1"],
    line_tags:         ["new"],
    order_date:        _day(100),
    request_date:      _day(131),
    has_receipt:       true,
  });
  check("31 days outside window",              rOver.eligible === false);
}

// ---- evaluate: exclusions on each axis --------------------------------

async function _evaluateExclusions() {
  // Category exclusion — every line in category 'final-sale' is dropped.
  var q1 = _makeQuery();
  var rp1 = refundPolicy.create({ query: q1 });
  await rp1.definePolicy({
    slug: "ex-cat", title: "Cat exclusion",
    applies_to: "all", refund_window_days: 30,
    exclusions: { categories: ["final-sale"] },
    refund_kind: "full", requires_receipt: false, priority: 10,
  });
  // Order with ALL final-sale lines -> all_lines_excluded.
  var rAllFinal = await rp1.evaluate({
    order_id: "o1", order_total_minor: 5000,
    line_categories: ["final-sale", "final-sale"],
    line_vendors:    ["a", "b"],
    line_skus:       ["S1", "S2"],
    line_tags:       ["t1", "t2"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("category exclusion all excluded",     rAllFinal.eligible === false);
  check("category exclusion reason",           rAllFinal.reasons.indexOf("all_lines_excluded") !== -1);
  // Mixed lines: one survives -> eligible.
  var rMixed = await rp1.evaluate({
    order_id: "o1", order_total_minor: 5000,
    line_categories: ["final-sale", "electronics"],
    line_vendors:    ["a", "b"],
    line_skus:       ["S1", "S2"],
    line_tags:       ["t1", "t2"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("category exclusion mixed eligible",   rMixed.eligible === true);

  // Vendor exclusion
  var q2 = _makeQuery();
  var rp2 = refundPolicy.create({ query: q2 });
  await rp2.definePolicy({
    slug: "ex-vendor", title: "Vendor exclusion",
    applies_to: "all", refund_window_days: 30,
    exclusions: { vendors: ["dropshipper-x"] },
    refund_kind: "full", requires_receipt: false, priority: 10,
  });
  var rVendor = await rp2.evaluate({
    order_id: "o2", order_total_minor: 3000,
    line_categories: ["c"], line_vendors: ["dropshipper-x"],
    line_skus: ["S"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("vendor exclusion refuses",            rVendor.eligible === false);
  check("vendor exclusion reason",             rVendor.reasons.indexOf("all_lines_excluded") !== -1);

  // SKU exclusion
  var q3 = _makeQuery();
  var rp3 = refundPolicy.create({ query: q3 });
  await rp3.definePolicy({
    slug: "ex-sku", title: "SKU exclusion",
    applies_to: "all", refund_window_days: 30,
    exclusions: { skus: ["CUSTOM-1"] },
    refund_kind: "full", requires_receipt: false, priority: 10,
  });
  var rSku = await rp3.evaluate({
    order_id: "o3", order_total_minor: 2000,
    line_categories: ["c"], line_vendors: ["v"],
    line_skus: ["CUSTOM-1"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("sku exclusion refuses",               rSku.eligible === false);

  // Tag exclusion
  var q4 = _makeQuery();
  var rp4 = refundPolicy.create({ query: q4 });
  await rp4.definePolicy({
    slug: "ex-tag", title: "Tag exclusion",
    applies_to: "all", refund_window_days: 30,
    exclusions: { tags: ["clearance"] },
    refund_kind: "full", requires_receipt: false, priority: 10,
  });
  var rTag = await rp4.evaluate({
    order_id: "o4", order_total_minor: 4000,
    line_categories: ["c"], line_vendors: ["v"],
    line_skus: ["S"], line_tags: ["clearance"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("tag exclusion refuses",               rTag.eligible === false);
}

// ---- evaluate: refund_kind cases --------------------------------------

async function _evaluateRefundKindCases() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  // partial 50% (5000 bps)
  await rp.definePolicy({
    slug: "p-partial", title: "Partial 50",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "partial", partial_refund_bps: 5000,
    requires_receipt: false, priority: 100,
  });
  var rPartial = await rp.evaluate({
    order_id: "o", order_total_minor: 4321,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("partial refund_kind",                rPartial.refund_kind === "partial");
  check("partial floor math",                 rPartial.max_refund_minor === Math.floor(4321 * 5000 / 10000));
  check("partial eligible",                   rPartial.eligible === true);

  // store_credit_only carries the full cap
  var q2  = _makeQuery();
  var rp2 = refundPolicy.create({ query: q2 });
  await rp2.definePolicy({
    slug: "p-sc", title: "Store credit only",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "store_credit_only", requires_receipt: false, priority: 10,
  });
  var rSc = await rp2.evaluate({
    order_id: "o", order_total_minor: 7000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("store_credit_only refund_kind",      rSc.refund_kind === "store_credit_only");
  check("store_credit_only cap is total",     rSc.max_refund_minor === 7000);
  check("store_credit_only eligible",         rSc.eligible === true);

  // no_refund kind — eligible=false but applied_policy carries slug
  var q3  = _makeQuery();
  var rp3 = refundPolicy.create({ query: q3 });
  await rp3.definePolicy({
    slug: "p-no", title: "Hard no",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "no_refund", requires_receipt: false, priority: 100,
  });
  var rNo = await rp3.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("no_refund eligible false",            rNo.eligible === false);
  check("no_refund applied_policy slug",       rNo.applied_policy === "p-no");
  check("no_refund refund_kind",               rNo.refund_kind === "no_refund");
  check("no_refund max_refund_minor",          rNo.max_refund_minor === 0);
  check("no_refund reasons",                   rNo.reasons.indexOf("refund_kind_no_refund") !== -1);
}

// ---- evaluate: restocking_fee_minor math ------------------------------

async function _evaluateRestockingFee() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "fee-policy", title: "Fee policy",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", restocking_fee_minor: 250, requires_receipt: false,
    priority: 10,
  });

  var r = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("restocking fee deducted",            r.max_refund_minor === 750);
  check("restocking fee surfaced",            r.restocking_fee_minor === 250);
  check("restocking fee reason",              r.reasons.indexOf("restocking_fee_applied") !== -1);
  check("restocking fee eligible",            r.eligible === true);

  // Fee >= total -> clamp to zero, eligible=false (no money to refund).
  var q2  = _makeQuery();
  var rp2 = refundPolicy.create({ query: q2 });
  await rp2.definePolicy({
    slug: "fee-bigger", title: "Fee >= total",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", restocking_fee_minor: 5000, requires_receipt: false,
    priority: 10,
  });
  var rClamp = await rp2.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("clamped fee max zero",                rClamp.max_refund_minor === 0);
  check("clamped fee eligible false",          rClamp.eligible === false);
  check("clamped fee reason",                  rClamp.reasons.indexOf("restocking_fee_exceeds_refund") !== -1);
}

// ---- evaluate: customer_status_in gate --------------------------------

async function _evaluateCustomerStatus() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "vip-only", title: "VIP only refund",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false,
    customer_status_in: ["vip", "loyalty_gold"], priority: 100,
  });

  var rVip = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    customer_status: "vip",
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("vip matches policy",                  rVip.eligible === true);

  var rRegular = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    customer_status: "regular",
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("non-vip refuses",                     rRegular.eligible === false);
  check("non-vip reason status_mismatch",      rRegular.reasons.indexOf("customer_status_mismatch") !== -1);

  // Guest (no customer_status) — status-gated policy also refuses.
  var rGuest = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("guest status_mismatch",               rGuest.reasons.indexOf("customer_status_mismatch") !== -1);
}

// ---- evaluate: requires_receipt gate ---------------------------------

async function _evaluateRequiresReceipt() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "receipt-req", title: "Receipt required",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: true, priority: 10,
  });

  var rNo = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: false,
  });
  check("no receipt refuses",                  rNo.eligible === false);
  check("no receipt reason",                   rNo.reasons.indexOf("receipt_required") !== -1);

  var rYes = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("with receipt eligible",               rYes.eligible === true);
}

// ---- evaluate: priority + no-policy fallback --------------------------

async function _evaluatePriority() {
  // High-priority partial-50, low-priority full. High wins.
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "low-full", title: "Low full",
    applies_to: "all", refund_window_days: 90,
    refund_kind: "full", requires_receipt: false, priority: 1,
  });
  await rp.definePolicy({
    slug: "high-partial", title: "High partial",
    applies_to: "all", refund_window_days: 90,
    refund_kind: "partial", partial_refund_bps: 5000,
    requires_receipt: false, priority: 100,
  });

  var r = await rp.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(110), has_receipt: true,
  });
  check("priority highest wins",                r.applied_policy === "high-partial");
  check("priority partial result",              r.max_refund_minor === 500);

  // No active policies at all -> no_policy_matched fallback.
  var q2  = _makeQuery();
  var rp2 = refundPolicy.create({ query: q2 });
  var rNone = await rp2.evaluate({
    order_id: "o", order_total_minor: 1000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  check("no policies fallback eligible false",  rNone.eligible === false);
  check("no policies applied_policy null",      rNone.applied_policy === null);
  check("no policies reason",                   rNone.reasons.indexOf("no_policy_matched") !== -1);
}

// ---- evaluate input refusals ------------------------------------------

async function _evaluateInputRefusals() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await assert.rejects(rp.evaluate(), /input object required/);
  await assert.rejects(rp.evaluate({
    order_id: "", order_total_minor: 0,
    line_categories: [], line_vendors: [], line_skus: [], line_tags: [],
    order_date: _day(100), request_date: _day(100), has_receipt: true,
  }), /order_id/);
  await assert.rejects(rp.evaluate({
    order_id: "o", order_total_minor: -1,
    line_categories: [], line_vendors: [], line_skus: [], line_tags: [],
    order_date: _day(100), request_date: _day(100), has_receipt: true,
  }), /order_total_minor/);
  await assert.rejects(rp.evaluate({
    order_id: "o", order_total_minor: 0,
    line_categories: "not-array", line_vendors: [], line_skus: [], line_tags: [],
    order_date: _day(100), request_date: _day(100), has_receipt: true,
  }), /line_categories/);
  await assert.rejects(rp.evaluate({
    order_id: "o", order_total_minor: 0,
    line_categories: [], line_vendors: [], line_skus: [], line_tags: [],
    order_date: _day(110), request_date: _day(100), has_receipt: true,
  }), /request_date/);
  await assert.rejects(rp.evaluate({
    order_id: "o", order_total_minor: 0,
    line_categories: [], line_vendors: [], line_skus: [], line_tags: [],
    order_date: _day(100), request_date: _day(105),
    has_receipt: "yes",
  }), /has_receipt/);
}

// ---- update + archive --------------------------------------------------

async function _updateAndArchive() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "u", title: "Original",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false, priority: 5,
  });

  var up = await rp.updatePolicy("u", {
    title: "Mutated",
    refund_kind: "partial",
    partial_refund_bps: 7500,
    restocking_fee_minor: 100,
    priority: 50,
    requires_receipt: true,
  });
  check("update title",                        up.title === "Mutated");
  check("update refund_kind",                  up.refund_kind === "partial");
  check("update partial_refund_bps",           up.partial_refund_bps === 7500);
  check("update restocking_fee_minor",         up.restocking_fee_minor === 100);
  check("update priority",                     up.priority === 50);
  check("update requires_receipt",             up.requires_receipt === true);

  // Cross-check: switching back to 'full' without clearing bps must
  // refuse (the primitive resolves the prospective shape and rejects
  // the inconsistent end state).
  await assert.rejects(rp.updatePolicy("u", { refund_kind: "full" }),
                       /partial_refund_bps/);

  // Clean transition: switch refund_kind=full AND clear bps in one
  // patch.
  var upFull = await rp.updatePolicy("u", {
    refund_kind: "full",
    partial_refund_bps: null,
  });
  check("update kind back to full",            upFull.refund_kind === "full");
  check("update bps cleared",                  upFull.partial_refund_bps === null);

  // Refusals
  await assert.rejects(rp.updatePolicy("u", {}), /at least one column/);
  await assert.rejects(rp.updatePolicy("u", { slug: "renamed" }), /unsupported column/);
  await assert.rejects(rp.updatePolicy("nonexistent", { title: "x" }), /not found/);

  // Archive
  var arch = await rp.archivePolicy("u");
  check("archive flips active to false",       arch.active === false);
  check("archive sets archived_at",            arch.archived_at != null);

  // Idempotent
  var archAgain = await rp.archivePolicy("u");
  check("archive idempotent",                  archAgain.archived_at != null);

  // active_only hides archived
  var actives = await rp.listPolicies({ active_only: true });
  check("active_only hides archived",          actives.length === 0);

  var all = await rp.listPolicies();
  check("default list shows archived",         all.length === 1);

  await assert.rejects(rp.archivePolicy("nothing"), /not found/);
}

// ---- auditEvaluation + listAudit --------------------------------------

async function _auditAndList() {
  var q  = _makeQuery();
  var rp = refundPolicy.create({ query: q });

  await rp.definePolicy({
    slug: "p", title: "P",
    applies_to: "all", refund_window_days: 30,
    refund_kind: "full", requires_receipt: false, priority: 10,
  });

  // Eligible
  var ok = await rp.evaluate({
    order_id: "order-aud", order_total_minor: 5000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  var aud1 = await rp.auditEvaluation({
    order_id:   "order-aud",
    evaluation: { order_total_minor: 5000 },
    verdict:    ok,
  });
  check("audit eligible decision",             aud1.decision === "eligible");
  check("audit applied slug",                  aud1.applied_slug === "p");

  // Denied (out of window)
  var denied = await rp.evaluate({
    order_id: "order-aud", order_total_minor: 5000,
    line_categories: ["c"], line_vendors: ["v"], line_skus: ["s"], line_tags: ["t"],
    order_date: _day(100), request_date: _day(200), has_receipt: true,
  });
  var aud2 = await rp.auditEvaluation({
    order_id: "order-aud", evaluation: { request_date: _day(200) }, verdict: denied,
  });
  check("audit denied decision",               aud2.decision === "denied");
  check("audit denied applied slug",           aud2.applied_slug === "p");

  // No policy
  var q2  = _makeQuery();
  var rp2 = refundPolicy.create({ query: q2 });
  var noP = await rp2.evaluate({
    order_id: "x", order_total_minor: 0,
    line_categories: [], line_vendors: [], line_skus: [], line_tags: [],
    order_date: _day(100), request_date: _day(105), has_receipt: true,
  });
  var aud3 = await rp2.auditEvaluation({
    order_id: "x", evaluation: {}, verdict: noP,
  });
  check("audit no_policy decision",            aud3.decision === "no_policy");
  check("audit no_policy slug null",           aud3.applied_slug === null);

  // listAudit
  var log = await rp.listAudit({ order_id: "order-aud" });
  check("listAudit returns two rows",          log.length === 2);
  check("listAudit DESC order",                log[0].occurred_at >= log[1].occurred_at);
  check("listAudit payload restored",          log[0].payload !== null && typeof log[0].payload === "object");
  check("listAudit decision present",          log[0].decision === "denied" || log[0].decision === "eligible");

  // listAudit refusals
  await assert.rejects(rp.listAudit({ order_id: "" }), /order_id/);
  await assert.rejects(rp.listAudit({ order_id: "ok", limit: 0 }), /limit/);

  // auditEvaluation refusals
  await assert.rejects(rp.auditEvaluation(), /input object required/);
  await assert.rejects(rp.auditEvaluation({ order_id: "x" }), /evaluation/);
  await assert.rejects(rp.auditEvaluation({ order_id: "x", evaluation: {} }), /verdict/);
}

async function run() {
  await _definePolicyHappy();
  await _definePolicyRefusals();
  await _evaluateHappy();
  await _evaluateOutsideWindow();
  await _evaluateExclusions();
  await _evaluateRefundKindCases();
  await _evaluateRestockingFee();
  await _evaluateCustomerStatus();
  await _evaluateRequiresReceipt();
  await _evaluatePriority();
  await _evaluateInputRefusals();
  await _updateAndArchive();
  await _auditAndList();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - refund-policy (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - refund-policy: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
