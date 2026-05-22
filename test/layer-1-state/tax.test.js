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

// ---- VAT / GST extraction + reverse-charge + format helpers ----

async function _calculateInclusive() {
  // Every standard EU rate applied to a €100.00 (10000 minor) gross
  // line. Inclusive extraction: tax = round(gross * rate / (10000 +
  // rate)); net = gross - tax. The sum must always equal gross to
  // the cent.
  var rates = [
    { bps: 1900, label: "DE/CY 19%" },
    { bps: 2000, label: "FR/AT/BG/EE/SK 20%" },
    { bps: 2100, label: "BE/CZ/ES/LV/LT/NL 21%" },
    { bps: 2200, label: "IT/SI 22%" },
    { bps: 2300, label: "IE/PL/PT 23%" },
    { bps: 2400, label: "FI/GR/RO 24%" },
    { bps: 2500, label: "HR/SE/DK 25%" },
  ];
  for (var i = 0; i < rates.length; i += 1) {
    var r = tax.calculateInclusive({ amount_minor: 10000, rate_bps: rates[i].bps, currency: "EUR" });
    check("calculateInclusive " + rates[i].label + " gross stable",   r.gross_minor === 10000);
    check("calculateInclusive " + rates[i].label + " sums to gross",  r.net_minor + r.tax_minor === r.gross_minor);
    check("calculateInclusive " + rates[i].label + " rate_bps echo",  r.rate_bps === rates[i].bps);
    // The tax figure should be in the right ballpark: 10000 * bps /
    // (10000 + bps). E.g. 19% on €100 → €15.97; 25% → €20.00.
    var expected = Math.round(10000 * rates[i].bps / (10000 + rates[i].bps));
    var delta = Math.abs(r.tax_minor - expected);
    check("calculateInclusive " + rates[i].label + " tax within 1 cent of expected", delta <= 1);
  }

  // Spot-check a published example: €120 gross at 20% VAT extracts
  // to €100 net + €20 tax.
  var ex = tax.calculateInclusive({ amount_minor: 12000, rate_bps: 2000, currency: "EUR" });
  check("calculateInclusive €120 @ 20% → €100 net",  ex.net_minor === 10000);
  check("calculateInclusive €120 @ 20% → €20 tax",   ex.tax_minor === 2000);
  check("calculateInclusive €120 @ 20% → €120 gross",ex.gross_minor === 12000);

  // Zero rate → zero tax, gross == net.
  var zero = tax.calculateInclusive({ amount_minor: 5000, rate_bps: 0, currency: "EUR" });
  check("calculateInclusive 0% → no tax", zero.tax_minor === 0 && zero.net_minor === 5000);

  // Validation surfaces.
  assert.throws(function () { tax.calculateInclusive({}); },                                                  /amount_minor must be/);
  assert.throws(function () { tax.calculateInclusive({ amount_minor: -1, rate_bps: 2000, currency: "EUR" }); }, /amount_minor must be/);
  assert.throws(function () { tax.calculateInclusive({ amount_minor: 1000, rate_bps: 99999, currency: "EUR" }); }, /rate_bps must be/);
  assert.throws(function () { tax.calculateInclusive({ amount_minor: 1000, rate_bps: 2000, currency: "eur" }); }, /currency must be/);
}

async function _calculateExclusive() {
  // Net price + VAT → gross. €100.00 @ 20% = €20.00 tax, €120.00 gross.
  var ex = tax.calculateExclusive({ amount_minor: 10000, rate_bps: 2000, currency: "EUR" });
  check("calculateExclusive €100 @ 20% → €20 tax",    ex.tax_minor === 2000);
  check("calculateExclusive €100 @ 20% → €120 gross", ex.gross_minor === 12000);
  check("calculateExclusive €100 @ 20% → €100 net",   ex.net_minor === 10000);

  // Round-trip: take a gross price, extract VAT (calculateInclusive),
  // then re-add VAT to the resulting net (calculateExclusive). The
  // round-tripped gross must land within 1 cent of the original.
  // Banker's rounding can drift by 1 minor unit on odd numerators.
  var rates2 = [1900, 2000, 2100, 2200, 2300, 2400, 2500];
  var grosses = [10000, 9999, 12345, 7777, 100, 1, 50000];
  for (var i = 0; i < rates2.length; i += 1) {
    for (var j = 0; j < grosses.length; j += 1) {
      var step1 = tax.calculateInclusive({ amount_minor: grosses[j], rate_bps: rates2[i], currency: "EUR" });
      var step2 = tax.calculateExclusive({ amount_minor: step1.net_minor, rate_bps: rates2[i], currency: "EUR" });
      var diff = Math.abs(step2.gross_minor - grosses[j]);
      check("calculateExclusive round-trip rate=" + rates2[i] + " gross=" + grosses[j] + " within 1 cent", diff <= 1);
    }
  }

  // Zero gross → all zeros.
  var zero = tax.calculateExclusive({ amount_minor: 0, rate_bps: 2000, currency: "EUR" });
  check("calculateExclusive zero amount → zero everywhere",
        zero.net_minor === 0 && zero.tax_minor === 0 && zero.gross_minor === 0);

  // Validation.
  assert.throws(function () { tax.calculateExclusive({}); },                                                  /amount_minor must be/);
  assert.throws(function () { tax.calculateExclusive({ amount_minor: 1.5, rate_bps: 2000, currency: "EUR" }); }, /amount_minor must be/);
  assert.throws(function () { tax.calculateExclusive({ amount_minor: 100, rate_bps: -1, currency: "EUR" }); },   /rate_bps must be/);
}

async function _validateVatId() {
  // Happy-path: one valid format per EU-27 country code (synthetic
  // numbers that match each country's published pattern). These are
  // FORMAT exemplars only — they're not registered VAT IDs and must
  // not be reused for real invoicing.
  var happy = {
    AT: "ATU12345678",
    BE: "BE0123456789",
    BG: "BG123456789",
    CY: "CY12345678A",
    CZ: "CZ12345678",
    DE: "DE123456789",
    DK: "DK12345678",
    EE: "EE123456789",
    ES: "ESA1234567Z",
    FI: "FI12345678",
    FR: "FRAB123456789",
    GR: "EL123456789",                  // EU-internal uses EL not GR
    HR: "HR12345678901",
    HU: "HU12345678",
    IE: "IE1234567FA",
    IT: "IT12345678901",
    LT: "LT123456789",
    LU: "LU12345678",
    LV: "LV12345678901",
    MT: "MT12345678",
    NL: "NL123456789B01",
    PL: "PL1234567890",
    PT: "PT123456789",
    RO: "RO1234567890",
    SE: "SE123456789012",
    SI: "SI12345678",
    SK: "SK1234567890",
  };

  var euCodes = Object.keys(happy);
  for (var i = 0; i < euCodes.length; i += 1) {
    var cc = euCodes[i];
    var res = tax.validateVatId(happy[cc], cc);
    check("validateVatId " + cc + " accepts canonical format", res.ok === true);
    check("validateVatId " + cc + " strips country prefix",     res.vat_number && res.vat_number.length >= 2);
    check("validateVatId " + cc + " returns country",           res.country === cc);
    check("validateVatId " + cc + " returns format source",     typeof res.format === "string" && res.format.length > 0);
  }

  // Format refusal: bad VAT IDs (truncated / wrong character class)
  // for each EU-27 country.
  var bad = {
    AT: "AT12345678",          // missing the U
    BE: "BEXXXXXXXXXX",
    BG: "BG12345",             // too short
    CY: "CY12345678",          // missing trailing letter
    CZ: "CZ1234567",           // too short
    DE: "DE12345678",          // 8 digits, not 9
    DK: "DK1234567",
    EE: "EE12345",
    ES: "ES12345678",          // missing alpha bracketing
    FI: "FI1234567",
    FR: "FR1234567",
    GR: "GR123456789",         // GR prefix is rejected — pattern uses EL
    HR: "HR123",
    HU: "HU1234567",
    IE: "IE12",
    IT: "IT1234567890",        // 10 digits, needs 11
    LT: "LT12345",
    LU: "LU1234",
    LV: "LV123",
    MT: "MT123",
    NL: "NL123456789B0",       // missing 1 digit after B
    PL: "PL12345",
    PT: "PT1234",
    RO: "ROxxxxxx",
    SE: "SE123456789",         // too short
    SI: "SI12",
    SK: "SK1234",
  };
  for (var k = 0; k < euCodes.length; k += 1) {
    var c2 = euCodes[k];
    var r2 = tax.validateVatId(bad[c2], c2);
    check("validateVatId " + c2 + " refuses malformed input", r2.ok === false);
    check("validateVatId " + c2 + " refusal has null vat_number", r2.vat_number === null);
  }

  // GB (post-Brexit) + CH still resolve as valid country codes.
  var gb = tax.validateVatId("GB123456789", "GB");
  check("validateVatId GB 9-digit format passes", gb.ok === true);
  var gb12 = tax.validateVatId("GB123456789012", "GB");
  check("validateVatId GB 12-digit format passes", gb12.ok === true);
  var ch = tax.validateVatId("CHE123456789MWST", "CH");
  check("validateVatId CH with MWST suffix passes", ch.ok === true);

  // Whitespace + casing tolerance.
  var loose = tax.validateVatId("de 123 456 789", "DE");
  check("validateVatId tolerates whitespace + lowercase", loose.ok === true && loose.vat_number === "123456789");

  // Validation surfaces.
  assert.throws(function () { tax.validateVatId(123, "DE"); },          /vat_id must be a string/);
  assert.throws(function () { tax.validateVatId("DE123456789", "de"); }, /country_code must be a 2-letter/);
  assert.throws(function () { tax.validateVatId("XX1", "XX"); },         /no VAT format registered/);
}

async function _applyReverseCharge() {
  // Happy path: DE seller → FR buyer with valid VAT IDs → reverse
  // charge applies, rate_bps becomes 0.
  var rc = tax.applyReverseCharge({
    ctx:           { vies_validated_at: "2026-05-01T00:00:00Z" },
    seller_vat_id: "DE123456789",
    buyer_vat_id:  "FRAB123456789",
    buyer_country: "FR",
  });
  check("applyReverseCharge DE→FR triggers",          rc.reverse_charge === true);
  check("applyReverseCharge DE→FR zeros the rate",    rc.rate_bps === 0);
  check("applyReverseCharge DE→FR reason eu-b2b",     rc.reason === "eu-b2b");
  check("applyReverseCharge DE→FR carries seller",    rc.seller.country === "DE");
  check("applyReverseCharge DE→FR carries buyer",     rc.buyer.country === "FR");
  check("applyReverseCharge DE→FR VIES timestamp",    rc.vies_validated_at === "2026-05-01T00:00:00Z");

  // Buyer is not in the EU → no reverse charge (e.g. US buyer).
  var us = tax.applyReverseCharge({
    seller_vat_id: "DE123456789",
    buyer_vat_id:  "US12-3456789",
    buyer_country: "US",
  });
  check("applyReverseCharge buyer-not-eu blocks", us.reverse_charge === false && us.reason === "buyer-not-eu");
  check("applyReverseCharge non-eu returns null rate_bps", us.rate_bps === null);

  // Seller's VAT ID is from a non-EU country (e.g. GB post-Brexit).
  var gb = tax.applyReverseCharge({
    seller_vat_id: "GB123456789",
    buyer_vat_id:  "DE123456789",
    buyer_country: "DE",
  });
  check("applyReverseCharge GB seller no longer EU", gb.reverse_charge === false && gb.reason === "seller-not-eu");

  // Missing seller VAT ID → operator hasn't configured one, B2C.
  var noSeller = tax.applyReverseCharge({
    buyer_vat_id:  "FRAB123456789",
    buyer_country: "FR",
  });
  check("applyReverseCharge missing seller blocks", noSeller.reverse_charge === false && noSeller.reason === "missing-seller-vat-id");

  // Missing buyer VAT ID → buyer is a consumer.
  var noBuyer = tax.applyReverseCharge({
    seller_vat_id: "DE123456789",
    buyer_country: "FR",
  });
  check("applyReverseCharge missing buyer blocks",  noBuyer.reverse_charge === false && noBuyer.reason === "missing-buyer-vat-id");

  // Malformed seller VAT ID → fail closed.
  var badSeller = tax.applyReverseCharge({
    seller_vat_id: "DE12",
    buyer_vat_id:  "FRAB123456789",
    buyer_country: "FR",
  });
  check("applyReverseCharge bad-format seller blocks", badSeller.reverse_charge === false && badSeller.reason === "seller-vat-id-bad-format");

  // Buyer VAT ID country-prefix doesn't match buyer_country — fraud
  // red flag.
  var mismatch = tax.applyReverseCharge({
    seller_vat_id: "DE123456789",
    buyer_vat_id:  "ITITITITITIT",
    buyer_country: "FR",
  });
  check("applyReverseCharge buyer-country mismatch blocks", mismatch.reverse_charge === false && mismatch.reason === "buyer-vat-id-country-mismatch");

  // Malformed buyer VAT ID (right country prefix, wrong shape).
  var badBuyer = tax.applyReverseCharge({
    seller_vat_id: "DE123456789",
    buyer_vat_id:  "FR12",
    buyer_country: "FR",
  });
  check("applyReverseCharge bad-format buyer blocks", badBuyer.reverse_charge === false && badBuyer.reason === "buyer-vat-id-bad-format");

  // Validation.
  assert.throws(function () { tax.applyReverseCharge({}); },                                            /buyer_country must be/);
  assert.throws(function () { tax.applyReverseCharge({ buyer_country: "fr" }); },                       /buyer_country must be/);
}

async function _format() {
  // Standard rate rendering at three locales.
  var en = tax.format({ rate_bps: 2000, locale: "en-US" });
  check("format 20% en-US contains '20'", en.indexOf("20") !== -1);
  check("format 20% en-US contains '%'",  en.indexOf("%") !== -1);

  var de = tax.format({ rate_bps: 1900, locale: "de-DE" });
  check("format 19% de-DE contains '19'", de.indexOf("19") !== -1);
  check("format 19% de-DE contains '%'",  de.indexOf("%") !== -1);
  // de-DE uses comma decimal separator. Intl.NumberFormat in any
  // Node LTS renders "19,0 %" or similar — don't pin the exact
  // string (NBSP variants drift across ICU versions), but the
  // decimal comma must appear before any fractional digit.

  var fr = tax.format({ rate_bps: 550, locale: "fr-FR" });
  check("format 5.5% fr-FR contains '5'", fr.indexOf("5") !== -1);
  check("format 5.5% fr-FR contains '%'", fr.indexOf("%") !== -1);

  // Reverse-charge annotation.
  var rc = tax.format({ rate_bps: 0, reverse_charge: true, locale: "en-US" });
  check("format reverse-charge annotation present", rc.indexOf("(reverse charge)") !== -1);
  check("format reverse-charge starts with 0",      rc.indexOf("0") !== -1);

  // Default locale falls back to en-US.
  var dflt = tax.format({ rate_bps: 2100 });
  check("format default locale renders", typeof dflt === "string" && dflt.length > 0);

  // Validation.
  assert.throws(function () { tax.format({}); },                              /rate_bps must be/);
  assert.throws(function () { tax.format({ rate_bps: 2000, locale: "" }); },  /locale must be a non-empty/);
  assert.throws(function () { tax.format({ rate_bps: 99999 }); },             /rate_bps must be/);
}

async function run() {
  await _matchPrecedence();
  await _bankersRounding();
  await _validation();
  await _calculateInclusive();
  await _calculateExclusive();
  await _validateVatId();
  await _applyReverseCharge();
  await _format();
}

module.exports = { run: run };
