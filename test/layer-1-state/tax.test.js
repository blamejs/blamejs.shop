"use strict";
/**
 * tax — operator-table adapter, rate-bps math, jurisdiction matching.
 *
 * Coverage:
 *   - rule validation (country, state, postal_prefix, rate_bps)
 *   - match precedence (postal > state > country > fallback)
 *   - banker's rounding (round-half-to-even)
 *   - shipTo validation
 *   - subtotal × bps / 10000 arithmetic
 *   - jurisdiction string format
 */

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var tax = bShop.tax;

async function _matchPrecedence() {
  var t = tax.create({
    rules: [
      { country: "US",                            rate_bps: 0    }, // fallback for US
      { country: "US", state: "CA",                rate_bps: 875  }, // CA 8.75%
      { country: "US", state: "CA", postal_prefix: "941", rate_bps: 925 }, // SF 9.25%
      { country: "US", state: "NY",                rate_bps: 800  },
      { country: "DE",                             rate_bps: 1900 },
    ],
  });

  // SF (941xx) — most specific
  var sf = await t.calculate({
    shipTo: { country: "US", state: "CA", postal: "94103" },
    subtotal_minor: 10000,
  });
  check("tax SF matches postal_prefix rule", sf.rate_bps === 925);
  check("tax SF jurisdiction string",        sf.jurisdiction === "US/CA/941");
  check("tax SF amount",                      sf.tax_minor === 925); // 10000 * 925 / 10000

  // LA (900xx) — falls to state rule
  var la = await t.calculate({
    shipTo: { country: "US", state: "CA", postal: "90001" },
    subtotal_minor: 10000,
  });
  check("tax LA falls to state rule",        la.rate_bps === 875);
  check("tax LA jurisdiction",                la.jurisdiction === "US/CA");

  // Texas — no rule, falls to country
  var tx = await t.calculate({
    shipTo: { country: "US", state: "TX", postal: "78701" },
    subtotal_minor: 10000,
  });
  check("tax TX falls to country fallback",  tx.rate_bps === 0);
  check("tax TX jurisdiction = country",      tx.jurisdiction === "US");

  // UK — no rule at all → fallback
  var uk = await t.calculate({
    shipTo: { country: "GB" },
    subtotal_minor: 10000,
  });
  check("tax GB falls to no-match fallback", uk.rate_bps === 0 && uk.jurisdiction === "fallback");
  check("tax fallback tax_minor is 0",        uk.tax_minor === 0);

  // Germany — country-only match
  var de = await t.calculate({
    shipTo: { country: "DE" },
    subtotal_minor: 10000,
  });
  check("tax DE 19% VAT",                     de.rate_bps === 1900 && de.tax_minor === 1900);
}

async function _bankersRounding() {
  // 10000 × 833 bps = 833 exactly — no rounding needed.
  // 1234 × 833 bps = 102.7922 → banker's rounds to 103.
  // 50 × 250 bps = 1.25 → banker's rounds to 2 (1.25 floor=1, frac=0.25 < 0.5 → 1)
  //   Wait — 0.25 < 0.5 so floor wins → 1. Let me recompute.
  // 50 × 500 bps = 2.5 → banker's: floor=2 (even) → 2.
  // 50 × 1500 bps = 7.5 → banker's: floor=7 (odd) → 8.
  var t = tax.create({ rules: [{ country: "US", rate_bps: 500 }] });
  var r1 = await t.calculate({ shipTo: { country: "US" }, subtotal_minor: 50 });
  check("banker's 2.5 → 2 (even)", r1.tax_minor === 2);

  var t2 = tax.create({ rules: [{ country: "US", rate_bps: 1500 }] });
  var r2 = await t2.calculate({ shipTo: { country: "US" }, subtotal_minor: 50 });
  check("banker's 7.5 → 8 (odd ↑ even)", r2.tax_minor === 8);

  // Normal case — 8.75% on $99.99 = $8.749125 → 8.75 → 875 minor units
  var t3 = tax.create({ rules: [{ country: "US", rate_bps: 875 }] });
  var r3 = await t3.calculate({ shipTo: { country: "US" }, subtotal_minor: 9999 });
  // 9999 * 875 / 10000 = 874.9125 → floor 874, frac .9125 > .5 → 875
  check("8.75% × $99.99 = $8.75",      r3.tax_minor === 875);

  // Zero subtotal → zero tax
  var r4 = await t3.calculate({ shipTo: { country: "US" }, subtotal_minor: 0 });
  check("zero subtotal yields zero tax", r4.tax_minor === 0);
}

async function _validation() {
  assert.throws(function () { tax.create({}); },                    /rules must be/);
  // Empty rules is valid (falls through to fallback for every shipTo).
  var empty = tax.create({ rules: [] });
  var fb = await empty.calculate({ shipTo: { country: "ZZ" }, subtotal_minor: 1000 });
  check("empty rules → fallback", fb.tax_minor === 0 && fb.jurisdiction === "fallback");

  assert.throws(function () { tax.create({ rules: [{}] }); },        /country must be/);
  assert.throws(function () { tax.create({ rules: [{ country: "us", rate_bps: 0 }] }); }, /country must be/);
  assert.throws(function () { tax.create({ rules: [{ country: "US", rate_bps: -1 }] }); }, /rate_bps must be/);
  assert.throws(function () { tax.create({ rules: [{ country: "US", rate_bps: 99999 }] }); }, /rate_bps must be/);
  assert.throws(function () { tax.create({ rules: [{ country: "US", rate_bps: 1.5 }] }); }, /rate_bps must be/);
  assert.throws(function () { tax.create({ adapter: "stripe", rules: [{ country: "US", rate_bps: 0 }] }); }, /unknown adapter/);

  var t = tax.create({ rules: [{ country: "US", rate_bps: 0 }] });
  await assert.rejects(t.calculate({}),                                                /shipTo required/);
  await assert.rejects(t.calculate({ shipTo: {}, subtotal_minor: 100 }),                /shipTo\.country/);
  await assert.rejects(t.calculate({ shipTo: { country: "US" }, subtotal_minor: -1 }), /subtotal_minor must be/);
}

async function run() {
  await _matchPrecedence();
  await _bankersRounding();
  await _validation();
}

module.exports = { run: run };
