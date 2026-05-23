"use strict";
/**
 * couponStacking — operator-authored rules that decide which coupon
 * codes (and which `quantityDiscounts`) may combine on the same order.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0067_coupon_stacking.sql`. The customerSegments handle
 * is injected as a hand-rolled stub that returns the membership the
 * test set up — exercising the optional-handle wiring without
 * pulling the full segment recompute pipeline in.
 *
 * Coverage:
 *   - definePolicy returns a hydrated row
 *   - definePolicy refuses unknown allow_combine keys, bad slug
 *   - definePolicy refuses redefine of the same slug
 *   - evaluate: single code, no policy → allowed
 *   - evaluate: multiple codes with allow_combine.with_other_codes →
 *     all applied up to max_codes_per_order
 *   - evaluate: with_other_codes = false → only first applied
 *   - evaluate: exclusive_codes blocks every other code
 *   - evaluate: max_codes_per_order caps applied list
 *   - evaluate: order_min_minor falls through to next policy
 *   - evaluate: customer_segment_in filter — only matching customer
 *     gets the policy applied
 *   - evaluate: quantity_discount stack refused when policy disallows
 *   - activePoliciesForCart returns the qualifying set
 *   - updatePolicy mutates fields, archivePolicy soft-deletes
 *   - factory guards on missing customerSegments handle when a
 *     segment-gated policy exists
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var couponStacking = require("../../lib/coupon-stacking");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0067_coupon_stacking.sql");

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

// Hand-rolled customerSegments stub. Keyed map of (customerId,
// segmentSlug) → bool. Mirrors the contract promo-banners +
// coupon-stacking both consume (`isMember(customer_id, segment_slug)`).
function _segmentsStub(memberships) {
  var calls = [];
  return {
    calls:    calls,
    isMember: async function (customerId, segmentSlug) {
      calls.push({ customer_id: customerId, segment_slug: segmentSlug });
      var k = customerId + "::" + segmentSlug;
      return memberships[k] === true;
    },
  };
}

// ---- definePolicy: happy path ------------------------------------------

async function _definePolicyHappy() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  var p = await cs.definePolicy({
    slug:                "default-stack",
    title:               "Default stacking",
    allow_combine:       { with_other_codes: true, with_quantity_discounts: true },
    max_codes_per_order: 3,
    exclusive_codes:     ["VIP-ONLY"],
    order_min_minor:     1000,
    customer_segment_in: ["vip"],
    priority:            10,
  });

  check("definePolicy returns slug",            p.slug === "default-stack");
  check("definePolicy returns title",           p.title === "Default stacking");
  check("definePolicy allow_combine restored",  p.allow_combine.with_other_codes === true && p.allow_combine.with_quantity_discounts === true);
  check("definePolicy max_codes_per_order",     p.max_codes_per_order === 3);
  check("definePolicy exclusive_codes",         p.exclusive_codes.length === 1 && p.exclusive_codes[0] === "VIP-ONLY");
  check("definePolicy order_min_minor",         p.order_min_minor === 1000);
  check("definePolicy customer_segment_in",     p.customer_segment_in.length === 1 && p.customer_segment_in[0] === "vip");
  check("definePolicy active default true",     p.active === true);
  check("definePolicy archived_at null",        p.archived_at === null);
  check("definePolicy priority preserved",      p.priority === 10);
  check("definePolicy created_at integer",      Number.isInteger(p.created_at));

  // getPolicy round-trips
  var g = await cs.getPolicy("default-stack");
  check("getPolicy round-trips slug",           g.slug === "default-stack");

  // listPolicies sees it
  var list = await cs.listPolicies();
  check("listPolicies returns the policy",      list.length === 1 && list[0].slug === "default-stack");
}

// ---- definePolicy: refusals --------------------------------------------

async function _definePolicyRefusals() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await assert.rejects(cs.definePolicy(), /input object required/);
  // Bad slug
  await assert.rejects(cs.definePolicy({
    slug: "Has Space", title: "x", allow_combine: {}, max_codes_per_order: 1,
  }), /slug/);
  // Bad title
  await assert.rejects(cs.definePolicy({
    slug: "ok", title: "", allow_combine: {}, max_codes_per_order: 1,
  }), /title/);
  // Unknown allow_combine key
  await assert.rejects(cs.definePolicy({
    slug: "ok", title: "x",
    allow_combine: { with_other_codes: true, bogus_key: true },
    max_codes_per_order: 1,
  }), /allow_combine/);
  // Bad max_codes_per_order (zero)
  await assert.rejects(cs.definePolicy({
    slug: "ok", title: "x", allow_combine: {}, max_codes_per_order: 0,
  }), /max_codes_per_order/);
  // Bad exclusive_codes entry (has space)
  await assert.rejects(cs.definePolicy({
    slug: "ok", title: "x", allow_combine: {}, max_codes_per_order: 1,
    exclusive_codes: ["bad code"],
  }), /exclusive_codes/);
  // Bad segment slug
  await assert.rejects(cs.definePolicy({
    slug: "ok", title: "x", allow_combine: {}, max_codes_per_order: 1,
    customer_segment_in: ["UPPER-CASE"],
  }), /customer_segment_in/);

  // Successful define
  await cs.definePolicy({
    slug: "p1", title: "Policy 1", allow_combine: {}, max_codes_per_order: 1,
  });
  // Redefine refused
  await assert.rejects(cs.definePolicy({
    slug: "p1", title: "again", allow_combine: {}, max_codes_per_order: 1,
  }), /already exists/);
}

// ---- evaluate: single code, no governing policy ------------------------

async function _evaluateSingleCodeNoPolicy() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  var r = await cs.evaluate({
    codes: ["WELCOME10"],
    cart:  { subtotal_minor: 5000 },
  });
  check("no-policy single-code allowed",         r.allowed === true);
  check("no-policy single-code applied",         r.applied.length === 1 && r.applied[0] === "WELCOME10");
  check("no-policy single-code refused empty",   r.refused.length === 0);

  // Multiple codes, no policy → first allowed, rest refused.
  var r2 = await cs.evaluate({
    codes: ["A", "B", "C"],
    cart:  { subtotal_minor: 5000 },
  });
  check("no-policy multi-code first applied",    r2.applied.length === 1 && r2.applied[0] === "A");
  check("no-policy multi-code rest refused",     r2.refused.length === 2);
  check("no-policy reason",                       r2.refused[0].reason === "no_policy_allows_stacking");

  // Empty codes → trivially allowed.
  var r3 = await cs.evaluate({ codes: [], cart: { subtotal_minor: 5000 } });
  check("empty codes allowed",                   r3.allowed === true && r3.applied.length === 0 && r3.refused.length === 0);
}

// ---- evaluate: allow_combine.with_other_codes --------------------------

async function _evaluateAllowOtherCodes() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await cs.definePolicy({
    slug: "permissive", title: "Permissive",
    allow_combine: { with_other_codes: true, with_quantity_discounts: true },
    max_codes_per_order: 5,
    priority: 10,
  });

  var r = await cs.evaluate({
    codes: ["A", "B", "C"],
    cart:  { subtotal_minor: 1000, has_quantity_discount: false },
  });
  check("permissive multi-code allowed",          r.allowed === true);
  check("permissive multi-code applied 3",        r.applied.length === 3);
  check("permissive multi-code applied order",    r.applied[0] === "A" && r.applied[1] === "B" && r.applied[2] === "C");
  check("permissive multi-code refused empty",    r.refused.length === 0);
}

// ---- evaluate: with_other_codes = false (default) ----------------------

async function _evaluateSingleCodePolicy() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await cs.definePolicy({
    slug: "single-only", title: "Single code only",
    allow_combine: { with_other_codes: false },
    max_codes_per_order: 1,
    priority: 10,
  });

  var r = await cs.evaluate({
    codes: ["A", "B"],
    cart:  { subtotal_minor: 1000 },
  });
  check("single-only first applied",              r.applied.length === 1 && r.applied[0] === "A");
  check("single-only rest refused",               r.refused.length === 1);
  check("single-only refusal reason",             r.refused[0].reason === "other_codes_not_allowed_to_stack");
}

// ---- evaluate: exclusive_codes block ----------------------------------

async function _evaluateExclusiveCodes() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await cs.definePolicy({
    slug: "exclusive-only", title: "Exclusive override",
    allow_combine: { with_other_codes: true, with_quantity_discounts: true },
    max_codes_per_order: 5,
    exclusive_codes: ["VIP-50"],
    priority: 100,
  });

  // VIP-50 in the basket — every other code refused with
  // exclusive_code_present.
  var r = await cs.evaluate({
    codes: ["VIP-50", "WELCOME10", "FREESHIP"],
    cart:  { subtotal_minor: 5000, has_quantity_discount: false },
  });
  check("exclusive code applied alone",           r.applied.length === 1 && r.applied[0] === "VIP-50");
  check("exclusive refuses other codes",          r.refused.length === 2);
  check("exclusive refusal reason",               r.refused[0].reason === "exclusive_code_present");
  check("exclusive top-level allowed",            r.allowed === true);

  // Exclusive + quantity discount on cart → also refused.
  var r2 = await cs.evaluate({
    codes: ["VIP-50", "EXTRA"],
    cart:  { subtotal_minor: 5000, has_quantity_discount: true },
  });
  check("exclusive + qd refuses qd stack",        r2.allowed === false);
  var sawQdRefusal = r2.refused.some(function (e) { return e.reason === "quantity_discount_stack_refused"; });
  check("exclusive + qd qd_refusal present",      sawQdRefusal === true);
}

// ---- evaluate: max_codes_per_order caps applied ------------------------

async function _evaluateMaxCodesCap() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await cs.definePolicy({
    slug: "cap-2", title: "Two codes max",
    allow_combine: { with_other_codes: true },
    max_codes_per_order: 2,
    priority: 10,
  });

  var r = await cs.evaluate({
    codes: ["A", "B", "C", "D"],
    cart:  { subtotal_minor: 1000 },
  });
  check("cap applied length is cap",              r.applied.length === 2);
  check("cap applied preserves order",            r.applied[0] === "A" && r.applied[1] === "B");
  check("cap over-cap refused count",             r.refused.length === 2);
  check("cap over-cap reason",                    r.refused[0].reason === "max_codes_per_order_exceeded");
  check("cap over-cap second reason",             r.refused[1].reason === "max_codes_per_order_exceeded");
}

// ---- evaluate: order_min_minor floor -----------------------------------

async function _evaluateOrderMinFloor() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  // High-priority policy gates at $100 (10000 minor units), permissive.
  await cs.definePolicy({
    slug: "big-cart", title: "Big cart stacking",
    allow_combine: { with_other_codes: true },
    max_codes_per_order: 5,
    order_min_minor: 10000,
    priority: 100,
  });
  // Lower-priority fallback at $0, restrictive.
  await cs.definePolicy({
    slug: "fallback", title: "Small cart",
    allow_combine: { with_other_codes: false },
    max_codes_per_order: 1,
    priority: 10,
  });

  // Small cart under floor — falls through to fallback. Two codes →
  // first applied, second refused.
  var rSmall = await cs.evaluate({
    codes: ["A", "B"],
    cart:  { subtotal_minor: 500 },
  });
  check("under-floor falls through",              rSmall.applied.length === 1 && rSmall.applied[0] === "A");
  check("under-floor fallback refuses second",    rSmall.refused.length === 1);
  check("under-floor refusal reason",             rSmall.refused[0].reason === "other_codes_not_allowed_to_stack");

  // Big cart over floor — big-cart policy governs. Both codes apply.
  var rBig = await cs.evaluate({
    codes: ["A", "B"],
    cart:  { subtotal_minor: 15000 },
  });
  check("over-floor big-cart applies both",       rBig.applied.length === 2);
  check("over-floor no refusals",                 rBig.refused.length === 0);
}

// ---- evaluate: customer_segment_in filter ------------------------------

async function _evaluateCustomerSegmentFilter() {
  var q = _makeQuery();
  var seg = _segmentsStub({
    "cust-vip::vip":      true,
    "cust-regular::vip":  false,
  });
  var cs = couponStacking.create({ query: q, customerSegments: seg });

  // VIP-only policy, permissive.
  await cs.definePolicy({
    slug: "vip-stack", title: "VIP stacking",
    allow_combine: { with_other_codes: true },
    max_codes_per_order: 5,
    customer_segment_in: ["vip"],
    priority: 100,
  });
  // Fallback, restrictive.
  await cs.definePolicy({
    slug: "fallback", title: "Fallback",
    allow_combine: { with_other_codes: false },
    max_codes_per_order: 1,
    priority: 10,
  });

  // VIP customer → vip-stack governs, both codes apply.
  var rVip = await cs.evaluate({
    codes:       ["A", "B"],
    cart:        { subtotal_minor: 1000 },
    customer_id: "cust-vip",
  });
  check("vip-segment governs vip customer",       rVip.applied.length === 2);
  check("vip-segment no refusals for vip",        rVip.refused.length === 0);

  // Regular customer → falls through to fallback policy.
  var rReg = await cs.evaluate({
    codes:       ["A", "B"],
    cart:        { subtotal_minor: 1000 },
    customer_id: "cust-regular",
  });
  check("regular customer falls through",         rReg.applied.length === 1);
  check("regular fallback refuses second",        rReg.refused.length === 1);

  // No customer_id → segment-gated policy is skipped.
  var rGuest = await cs.evaluate({
    codes: ["A", "B"],
    cart:  { subtotal_minor: 1000 },
  });
  check("guest skips segment-gated policy",       rGuest.applied.length === 1);

  // Stub recorded the membership lookups.
  check("segments stub was called",               seg.calls.length > 0);
}

// ---- evaluate: quantity discount stack rule ----------------------------

async function _evaluateQuantityDiscountRule() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  // Restrictive policy — does NOT allow quantity-discount stacking.
  await cs.definePolicy({
    slug: "no-qd-stack", title: "No qd stack",
    allow_combine: { with_other_codes: false, with_quantity_discounts: false },
    max_codes_per_order: 1,
    priority: 10,
  });

  // Cart has a quantity discount + a code is presented → refused.
  var rRefuse = await cs.evaluate({
    codes: ["WELCOME10"],
    cart:  { subtotal_minor: 1000, has_quantity_discount: true },
  });
  check("qd + code: allowed=false",                rRefuse.allowed === false);
  check("qd + code: code still applied",           rRefuse.applied.length === 1 && rRefuse.applied[0] === "WELCOME10");
  var sawQdRefusal = rRefuse.refused.some(function (e) { return e.reason === "quantity_discount_stack_refused"; });
  check("qd + code: qd refusal present",           sawQdRefusal === true);

  // Cart has no quantity discount → allowed.
  var rOk = await cs.evaluate({
    codes: ["WELCOME10"],
    cart:  { subtotal_minor: 1000, has_quantity_discount: false },
  });
  check("no-qd + code: allowed",                   rOk.allowed === true);
  check("no-qd + code: no qd refusal",             rOk.refused.length === 0);
}

// ---- activePoliciesForCart --------------------------------------------

async function _activePoliciesForCart() {
  var q = _makeQuery();
  var seg = _segmentsStub({ "cust-1::vip": true });
  var cs = couponStacking.create({ query: q, customerSegments: seg });

  await cs.definePolicy({
    slug: "p-high", title: "High", allow_combine: {}, max_codes_per_order: 1,
    order_min_minor: 5000, priority: 100,
  });
  await cs.definePolicy({
    slug: "p-mid", title: "Mid", allow_combine: {}, max_codes_per_order: 1,
    order_min_minor: 1000, priority: 50,
  });
  await cs.definePolicy({
    slug: "p-vip", title: "VIP", allow_combine: {}, max_codes_per_order: 1,
    customer_segment_in: ["vip"], priority: 200,
  });

  var qualSmall = await cs.activePoliciesForCart({ cart: { subtotal_minor: 100 } });
  check("activePolicies small cart: 0",            qualSmall.length === 0);

  var qualMid = await cs.activePoliciesForCart({ cart: { subtotal_minor: 2000 } });
  check("activePolicies mid cart: 1 (mid only)",   qualMid.length === 1 && qualMid[0].slug === "p-mid");

  var qualBig = await cs.activePoliciesForCart({ cart: { subtotal_minor: 9999 } });
  check("activePolicies big cart: 2 (high+mid)",   qualBig.length === 2);
  check("activePolicies big cart sorted desc",     qualBig[0].slug === "p-high" && qualBig[1].slug === "p-mid");

  var qualVip = await cs.activePoliciesForCart({ cart: { subtotal_minor: 9999 }, customer_id: "cust-1" });
  check("activePolicies vip customer: 3",          qualVip.length === 3);
  check("activePolicies vip first by priority",    qualVip[0].slug === "p-vip");
}

// ---- updatePolicy + archivePolicy -------------------------------------

async function _updateAndArchive() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await cs.definePolicy({
    slug: "u", title: "Original", allow_combine: {}, max_codes_per_order: 1, priority: 5,
  });

  // Mutate fields
  var up = await cs.updatePolicy("u", {
    title: "Mutated",
    allow_combine: { with_other_codes: true },
    max_codes_per_order: 3,
    priority: 20,
    exclusive_codes: ["VIP"],
  });
  check("updatePolicy title",                      up.title === "Mutated");
  check("updatePolicy allow_combine",              up.allow_combine.with_other_codes === true);
  check("updatePolicy max_codes_per_order",        up.max_codes_per_order === 3);
  check("updatePolicy priority",                   up.priority === 20);
  check("updatePolicy exclusive_codes",            up.exclusive_codes.length === 1 && up.exclusive_codes[0] === "VIP");

  // Empty patch refused
  await assert.rejects(cs.updatePolicy("u", {}), /at least one column/);
  // Unsupported column refused
  await assert.rejects(cs.updatePolicy("u", { slug: "renamed" }), /unsupported column/);
  // Missing slug refused
  await assert.rejects(cs.updatePolicy("nonexistent", { title: "x" }), /not found/);

  // Archive
  var archived = await cs.archivePolicy("u");
  check("archivePolicy returns archived row",      archived.archived_at != null);
  check("archivePolicy flips active to false",     archived.active === false);

  // Idempotent archive
  var archivedAgain = await cs.archivePolicy("u");
  check("archivePolicy idempotent",                archivedAgain.archived_at != null);

  // list active_only hides archived
  var actives = await cs.listPolicies({ active_only: true });
  check("listPolicies active_only hides archived", actives.length === 0);

  // list without filter shows it
  var all = await cs.listPolicies();
  check("listPolicies default shows archived",     all.length === 1);

  // archivePolicy on missing slug refused
  await assert.rejects(cs.archivePolicy("nothing"), /not found/);
}

// ---- segments handle guard --------------------------------------------

async function _segmentsHandleGuard() {
  var q = _makeQuery();
  // No customerSegments handle wired in.
  var cs = couponStacking.create({ query: q });

  await cs.definePolicy({
    slug: "vip-only", title: "VIP",
    allow_combine: { with_other_codes: true },
    max_codes_per_order: 3,
    customer_segment_in: ["vip"],
    priority: 100,
  });

  // Customer-bearing evaluate reaches the segment gate → must throw.
  await assert.rejects(cs.evaluate({
    codes:       ["A"],
    cart:        { subtotal_minor: 1000 },
    customer_id: "cust-1",
  }), /customerSegments handle/);

  // Guest evaluate skips the gate (segment-gated policies require a
  // customer_id), so the policy is filtered out and the fallback
  // path runs — single code allowed.
  var rGuest = await cs.evaluate({
    codes: ["A"],
    cart:  { subtotal_minor: 1000 },
  });
  check("guest evaluate skips segment guard",      rGuest.allowed === true && rGuest.applied.length === 1);

  // Wrong-shape segments handle (no isMember) also refused.
  var csBad = couponStacking.create({ query: q, customerSegments: {} });
  await assert.rejects(csBad.evaluate({
    codes:       ["A"],
    cart:        { subtotal_minor: 1000 },
    customer_id: "cust-1",
  }), /isMember/);
}

// ---- evaluate input refusals ------------------------------------------

async function _evaluateInputRefusals() {
  var q = _makeQuery();
  var cs = couponStacking.create({ query: q });

  await assert.rejects(cs.evaluate(),                               /input object required/);
  await assert.rejects(cs.evaluate({ codes: "not-array", cart: {} }), /codes must be an array/);
  await assert.rejects(cs.evaluate({ codes: [], cart: null }),       /cart object required/);
  await assert.rejects(cs.evaluate({
    codes: ["bad code"], cart: { subtotal_minor: 0 },
  }), /codes\[0\]/);
  await assert.rejects(cs.evaluate({
    codes: ["A", "A"], cart: { subtotal_minor: 0 },
  }), /duplicate/);
  await assert.rejects(cs.evaluate({
    codes: ["A"], cart: { subtotal_minor: -1 },
  }), /subtotal_minor/);
  await assert.rejects(cs.evaluate({
    codes: ["A"], cart: { subtotal_minor: 0 }, customer_id: "",
  }), /customer_id/);
}

async function run() {
  await _definePolicyHappy();
  await _definePolicyRefusals();
  await _evaluateSingleCodeNoPolicy();
  await _evaluateAllowOtherCodes();
  await _evaluateSingleCodePolicy();
  await _evaluateExclusiveCodes();
  await _evaluateMaxCodesCap();
  await _evaluateOrderMinFloor();
  await _evaluateCustomerSegmentFilter();
  await _evaluateQuantityDiscountRule();
  await _activePoliciesForCart();
  await _updateAndArchive();
  await _segmentsHandleGuard();
  await _evaluateInputRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK — coupon-stacking (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL — coupon-stacking: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
