"use strict";
/**
 * shipping-insurance — per-shipment third-party parcel insurance
 * (Shipsurance / Loop / U-PIC / Route). Layer 1 against in-memory
 * node:sqlite with migration 0166 loaded.
 *
 * The shippingLabels dependency is stubbed locally so this test
 * exercises the primitive in isolation (compositional wiring is
 * covered by the smoke suite).
 *
 * Coverage:
 *   - defineProvider create + update + activity flag
 *   - quoteInsurance math (basis-point math, premium floor, ceil
 *     rounding, currency / floor / ceiling gates, archived/inactive
 *     refusal)
 *   - quoteInsurance shippingLabels gate when wired
 *   - purchaseInsurance happy path + UNIQUE (provider, shipment)
 *     refusal + premium snapshot
 *   - fileClaim FSM gate (active only) + claim_window auto-expire +
 *     claimed_amount cap
 *   - markClaimApproved + markClaimDenied terminal-only path
 *   - claimsForInsurance + insurancesForOrder ordering
 *   - metricsForProvider rollup math
 *   - factory refusals: bad shippingLabels shape
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var shippingInsurance = require("../../lib/shipping-insurance");
var bShop             = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0166_shipping_insurance.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// Simple shippingLabels stub — answers labelsForShipment from an
// operator-supplied map. Used to exercise the gate that refuses
// quoting against a shipment with no minted label.
function _shippingLabelsStub(labelsByShipment) {
  return {
    labelsForShipment: async function (shipmentId) {
      return labelsByShipment[shipmentId] || [];
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = shippingInsurance.create({
    query:           q,
    shippingLabels:  opts.shippingLabels || null,
  });
  return { q: q, svc: svc };
}

async function _defineProvider() {
  var w = _wire();
  var prov = await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });
  check("defineProvider returns row",     prov && prov.code === "shipsurance");
  check("defineProvider rate",            prov.premium_rate_bps === 150);
  check("defineProvider active=true",     prov.active === true);
  check("defineProvider archived null",   prov.archived_at == null);

  // Update in place — change rate, keep code
  var updated = await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance Inc.",
    premium_rate_bps: 200, premium_min_minor: 100,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 60, currency: "USD",
  });
  check("defineProvider update name",     updated.name === "Shipsurance Inc.");
  check("defineProvider update rate",     updated.premium_rate_bps === 200);
  check("defineProvider update window",   updated.claim_window_days === 60);

  // Refusals
  await assert.rejects(w.svc.defineProvider(),                                /input object required/);
  await assert.rejects(w.svc.defineProvider({}),                              /code/);
  await assert.rejects(w.svc.defineProvider({ code: "shipsurance", name: "x",
    premium_rate_bps: -1, premium_min_minor: 0,
    min_declared_value_minor: 0, max_declared_value_minor: 1000,
    claim_window_days: 30, currency: "USD" }),                                /premium_rate_bps/);
  await assert.rejects(w.svc.defineProvider({ code: "shipsurance", name: "x",
    premium_rate_bps: 100, premium_min_minor: 0,
    min_declared_value_minor: 0, max_declared_value_minor: 1000,
    claim_window_days: 0, currency: "USD" }),                                 /claim_window_days/);
  await assert.rejects(w.svc.defineProvider({ code: "shipsurance", name: "x",
    premium_rate_bps: 100, premium_min_minor: 0,
    min_declared_value_minor: 0, max_declared_value_minor: 1000,
    claim_window_days: 30, currency: "us" }),                                 /currency/);
  await assert.rejects(w.svc.defineProvider({ code: "shipsurance", name: "x",
    premium_rate_bps: 100, premium_min_minor: 0,
    min_declared_value_minor: 5000, max_declared_value_minor: 1000,
    claim_window_days: 30, currency: "USD" }),                                />= min_declared_value_minor/);
}

async function _quoteInsuranceMath() {
  var w = _wire();
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });

  // declared_value = $100.00 (10000 minor units), rate = 1.50% (150 bps)
  // Expected premium = 10000 * 150 / 10000 = 150 minor = $1.50
  var q1 = await w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 10000, currency: "USD",
  });
  check("quote premium 10000@150bps", q1.premium_minor === 150);
  check("quote returns currency",     q1.currency === "USD");
  check("quote returns window days",  q1.claim_window_days === 90);

  // Floor applied: declared = 100 minor, rate = 150 bps
  // Raw = 100 * 150 / 10000 = 1.5 -> ceil -> 2 minor
  // premium_min_minor = 95, so floor wins -> 95
  var q2 = await w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 100, currency: "USD",
  });
  check("quote premium floor",        q2.premium_minor === 95);

  // Ceiling rounding: declared = 6667 minor, rate = 150 bps
  // Raw = 6667 * 150 / 10000 = 100.005 -> ceil -> 101 minor (no floor wins)
  var q3 = await w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 6667, currency: "USD",
  });
  check("quote ceil rounding",        q3.premium_minor === 101);

  // Large value: $5000 = 500000 minor, rate = 150 bps -> 7500 minor = $75
  var q4 = await w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 500000, currency: "USD",
  });
  check("quote large value",          q4.premium_minor === 7500);

  // Floor refusal
  await assert.rejects(w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 50, currency: "USD",
  }), /below provider floor/);

  // Ceiling refusal
  await assert.rejects(w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 1000000, currency: "USD",
  }), /exceeds provider ceiling/);

  // Currency mismatch
  await assert.rejects(w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 10000, currency: "EUR",
  }), /does not match provider currency/);

  // Unknown provider
  await assert.rejects(w.svc.quoteInsurance({
    provider_code: "no-such", declared_value_minor: 10000, currency: "USD",
  }), /not found/);

  // Inactive provider
  await w.svc.defineProvider({
    code: "loop", name: "Loop", premium_rate_bps: 200, premium_min_minor: 100,
    min_declared_value_minor: 100, max_declared_value_minor: 1000000,
    claim_window_days: 30, currency: "USD", active: false,
  });
  await assert.rejects(w.svc.quoteInsurance({
    provider_code: "loop", declared_value_minor: 10000, currency: "USD",
  }), /not active/);
}

async function _quoteInsuranceShipmentGate() {
  // When shippingLabels is wired and shipment_id is supplied, the
  // gate refuses on a shipment with no minted label.
  var shipA = _uuid();
  var shipB = _uuid();
  var labelsStub = _shippingLabelsStub({});
  labelsStub.labelsForShipment = (function (orig) {
    return async function (id) {
      if (id === shipA) return [{ id: "label-1" }];
      return [];
    };
  })(labelsStub.labelsForShipment);

  var w = _wire({ shippingLabels: labelsStub });
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });

  // shipA has a label — quote succeeds
  var okQuote = await w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 10000, currency: "USD",
    shipment_id: shipA,
  });
  check("quote with shipment + label", okQuote.premium_minor === 150);

  // shipB has no label — refused
  await assert.rejects(w.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 10000, currency: "USD",
    shipment_id: shipB,
  }), /no shipping label/);

  // Without shippingLabels handle, the gate is skipped (the
  // storefront is responsible for the existence check)
  var wBare = _wire();
  await wBare.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });
  var bareQuote = await wBare.svc.quoteInsurance({
    provider_code: "shipsurance", declared_value_minor: 10000, currency: "USD",
    shipment_id: shipB,
  });
  check("bare quote no labels handle",  bareQuote.premium_minor === 150);
}

async function _purchaseInsurance() {
  var w = _wire();
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });

  var shipmentId = _uuid();
  var orderId    = _uuid();
  var customerId = _uuid();
  var ins = await w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: shipmentId,
    order_id: orderId, customer_id: customerId,
    declared_value_minor: 10000, currency: "USD",
    external_policy_id: "SHP-12345-ABC",
  });
  check("purchase returns id",          typeof ins.id === "string" && ins.id.length > 0);
  check("purchase status active",       ins.status === "active");
  check("purchase premium snapshot",    ins.premium_minor === 150);
  check("purchase external policy",     ins.external_policy_id === "SHP-12345-ABC");
  check("purchase claim window set",    typeof ins.claim_window_ends_at === "number" &&
                                         ins.claim_window_ends_at > Date.now());

  // Re-purchase same (provider, shipment) refused
  await assert.rejects(w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: shipmentId,
    order_id: orderId, customer_id: customerId,
    declared_value_minor: 10000, currency: "USD",
  }), /already insured/);

  // Different provider for same shipment — allowed (belt-and-braces)
  await w.svc.defineProvider({
    code: "loop", name: "Loop",
    premium_rate_bps: 200, premium_min_minor: 100,
    min_declared_value_minor: 100, max_declared_value_minor: 1000000,
    claim_window_days: 60, currency: "USD",
  });
  var insLoop = await w.svc.purchaseInsurance({
    provider_code: "loop", shipment_id: shipmentId,
    order_id: orderId, customer_id: customerId,
    declared_value_minor: 10000, currency: "USD",
  });
  check("overlay purchase loop",        insLoop.status === "active");
  check("overlay premium @200bps",      insLoop.premium_minor === 200);
  check("overlay no external policy",   insLoop.external_policy_id === null);

  // Refusals
  await assert.rejects(w.svc.purchaseInsurance(),                             /input object required/);
  await assert.rejects(w.svc.purchaseInsurance({
    provider_code: "no-such", shipment_id: _uuid(),
    order_id: _uuid(), customer_id: _uuid(),
    declared_value_minor: 10000, currency: "USD",
  }), /not found/);
  await assert.rejects(w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: _uuid(),
    order_id: _uuid(), customer_id: _uuid(),
    declared_value_minor: 10000, currency: "EUR",
  }), /does not match provider currency/);
}

async function _fileClaimFsm() {
  var w = _wire();
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });
  var ins = await w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: _uuid(),
    order_id: _uuid(), customer_id: _uuid(),
    declared_value_minor: 10000, currency: "USD",
  });

  // Happy path — lost claim
  var claim = await w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "lost",
    claimed_amount_minor: 8000,
    evidence: { carrier_last_scan: "2026-05-01T10:00:00Z", photos: [] },
  });
  check("fileClaim returns id",         typeof claim.id === "string" && claim.id.length > 0);
  check("fileClaim status filed",       claim.status === "filed");
  check("fileClaim type lost",          claim.claim_type === "lost");
  check("fileClaim amount",             claim.claimed_amount_minor === 8000);
  check("fileClaim evidence hydrated",  claim.evidence.carrier_last_scan === "2026-05-01T10:00:00Z");

  // Second claim allowed (damaged) — provider may reimburse for both
  var claim2 = await w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "damaged",
    claimed_amount_minor: 2000,
  });
  check("second fileClaim allowed",     claim2.status === "filed" && claim2.claim_type === "damaged");

  // claimed_amount > declared refused
  await assert.rejects(w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "stolen",
    claimed_amount_minor: 20000,
  }), /exceeds declared_value_minor/);

  // Bad claim_type refused
  await assert.rejects(w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "bogus",
    claimed_amount_minor: 100,
  }), /claim_type must be one of/);

  // Unknown insurance refused
  await assert.rejects(w.svc.fileClaim({
    insurance_id: _uuid(), claim_type: "lost",
    claimed_amount_minor: 100,
  }), /not found/);
}

async function _fileClaimWindowExpiry() {
  // Auto-expire on read — purchase with a 1-day window, manually
  // backdate claim_window_ends_at to simulate the window having
  // elapsed, then fileClaim must refuse with "expired".
  var w = _wire();
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 1, currency: "USD",
  });
  var ins = await w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: _uuid(),
    order_id: _uuid(), customer_id: _uuid(),
    declared_value_minor: 10000, currency: "USD",
  });

  // Backdate the claim window to the past (simulating ~30 days
  // post-window for a 1-day window).
  w.q.__db.prepare(
    "UPDATE shipping_insurances SET claim_window_ends_at = ?1 WHERE id = ?2",
  ).run(Date.now() - 60 * 60 * 1000, ins.id);

  await assert.rejects(w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "lost",
    claimed_amount_minor: 1000,
  }), /only active insurances accept new claims/);

  // The insurance row now landed in `expired` (auto-expire on read)
  var nowExpired = await w.svc.getInsurance(ins.id);
  check("auto-expired status",          nowExpired.status === "expired");
  check("expired_at stamped",           typeof nowExpired.expired_at === "number" &&
                                         nowExpired.expired_at > 0);
}

async function _markClaimApprovedAndDenied() {
  var w = _wire();
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });
  var ins = await w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: _uuid(),
    order_id: _uuid(), customer_id: _uuid(),
    declared_value_minor: 10000, currency: "USD",
  });

  var claimA = await w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "lost",
    claimed_amount_minor: 8000,
  });
  var claimB = await w.svc.fileClaim({
    insurance_id: ins.id, claim_type: "damaged",
    claimed_amount_minor: 2000,
  });

  // Approve A with a depreciated payout (insurer's adjuster paid less)
  var approved = await w.svc.markClaimApproved({
    claim_id: claimA.id, payout_minor: 7500,
  });
  check("approved status",              approved.status === "approved");
  check("approved payout",              approved.payout_minor === 7500);
  check("approved resolved_at",         typeof approved.resolved_at === "number" &&
                                         approved.resolved_at > 0);

  // Re-approve refused (terminal)
  await assert.rejects(w.svc.markClaimApproved({
    claim_id: claimA.id, payout_minor: 1000,
  }), /only filed claims can move to approved/);

  // payout > declared refused
  await assert.rejects(w.svc.markClaimApproved({
    claim_id: claimB.id, payout_minor: 20000,
  }), /exceeds declared_value_minor/);

  // Deny B
  var denied = await w.svc.markClaimDenied({
    claim_id: claimB.id, denial_reason: "Insufficient evidence - no photos",
  });
  check("denied status",                denied.status === "denied");
  check("denied reason",                denied.denial_reason === "Insufficient evidence - no photos");
  check("denied resolved_at",           typeof denied.resolved_at === "number" &&
                                         denied.resolved_at > 0);

  // Re-deny refused (terminal)
  await assert.rejects(w.svc.markClaimDenied({
    claim_id: claimB.id, denial_reason: "again",
  }), /only filed claims can move to denied/);

  // Unknown claim refused
  await assert.rejects(w.svc.markClaimApproved({
    claim_id: _uuid(), payout_minor: 100,
  }), /not found/);
  await assert.rejects(w.svc.markClaimDenied({
    claim_id: _uuid(), denial_reason: "x",
  }), /not found/);
}

async function _readsAndMetrics() {
  var w = _wire();
  await w.svc.defineProvider({
    code: "shipsurance", name: "Shipsurance",
    premium_rate_bps: 150, premium_min_minor: 95,
    min_declared_value_minor: 100, max_declared_value_minor: 500000,
    claim_window_days: 90, currency: "USD",
  });
  var orderId = _uuid();
  var customerId = _uuid();
  var shipA = _uuid();
  var shipB = _uuid();
  var insA = await w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: shipA,
    order_id: orderId, customer_id: customerId,
    declared_value_minor: 10000, currency: "USD",
  });
  var insB = await w.svc.purchaseInsurance({
    provider_code: "shipsurance", shipment_id: shipB,
    order_id: orderId, customer_id: customerId,
    declared_value_minor: 20000, currency: "USD",
  });

  // insurancesForOrder returns both, ordered by created_at ASC
  var perOrder = await w.svc.insurancesForOrder(orderId);
  check("insurancesForOrder count",      perOrder.length === 2);
  check("insurancesForOrder ordering",   perOrder[0].id === insA.id &&
                                         perOrder[1].id === insB.id);

  // getInsurance returns hydrated row
  var fetched = await w.svc.getInsurance(insA.id);
  check("getInsurance hydrated",         fetched.id === insA.id &&
                                         fetched.declared_value_minor === 10000);
  var miss = await w.svc.getInsurance(_uuid());
  check("getInsurance miss returns null", miss === null);

  // claimsForInsurance — file three claims, verify ordering
  var claim1 = await w.svc.fileClaim({
    insurance_id: insA.id, claim_type: "lost", claimed_amount_minor: 1000,
  });
  var claim2 = await w.svc.fileClaim({
    insurance_id: insA.id, claim_type: "damaged", claimed_amount_minor: 2000,
  });
  var claim3 = await w.svc.fileClaim({
    insurance_id: insA.id, claim_type: "stolen", claimed_amount_minor: 3000,
  });
  await w.svc.markClaimApproved({ claim_id: claim1.id, payout_minor: 900 });
  await w.svc.markClaimDenied({ claim_id: claim2.id, denial_reason: "no evidence" });

  var claims = await w.svc.claimsForInsurance(insA.id);
  check("claimsForInsurance count",      claims.length === 3);
  check("claimsForInsurance ordering",   claims[0].id === claim1.id &&
                                         claims[1].id === claim2.id &&
                                         claims[2].id === claim3.id);
  check("claim1 approved",               claims[0].status === "approved" && claims[0].payout_minor === 900);
  check("claim2 denied",                 claims[1].status === "denied");
  check("claim3 still filed",            claims[2].status === "filed");

  // metricsForProvider — sum premiums, count claim statuses
  var now = Date.now();
  var metrics = await w.svc.metricsForProvider({
    provider_code: "shipsurance", from: 0, to: now + 60000,
  });
  check("metrics provider",              metrics.provider_code === "shipsurance");
  check("metrics active count",          metrics.active_count === 2);
  check("metrics total premium",         metrics.total_premium_minor ===
                                         insA.premium_minor + insB.premium_minor);
  check("metrics claims filed",          metrics.claims_filed_count === 1);
  check("metrics claims approved",       metrics.claims_approved_count === 1);
  check("metrics claims denied",         metrics.claims_denied_count === 1);
  check("metrics total payout",          metrics.total_payout_minor === 900);

  // metricsForProvider window refusal
  await assert.rejects(w.svc.metricsForProvider({
    provider_code: "shipsurance", from: now, to: now - 1,
  }), /from must be <= to/);
}

async function _factoryRefusals() {
  // shippingLabels without labelsForShipment refused
  assert.throws(function () {
    shippingInsurance.create({ query: function () {}, shippingLabels: {} });
  }, /labelsForShipment/);
}

async function run() {
  await _defineProvider();
  await _quoteInsuranceMath();
  await _quoteInsuranceShipmentGate();
  await _purchaseInsurance();
  await _fileClaimFsm();
  await _fileClaimWindowExpiry();
  await _markClaimApprovedAndDenied();
  await _readsAndMetrics();
  await _factoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("shipping-insurance: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
