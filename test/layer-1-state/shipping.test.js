"use strict";
/**
 * shipping — operator-table adapter, zone matching, rate quotes.
 *
 * Coverage:
 *   - flat-amount zone
 *   - per-gram zone with base + min/max clamping
 *   - free_over_threshold flips amount → 0
 *   - zone specificity precedence (postal > state > country)
 *   - digital-only services for carts with no shippable lines
 *   - shippable services filtered when cart is digital-only
 *   - rule validation
 */

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var shipping = bShop.shipping;

function _line(qty, weight, requires) {
  return { qty: qty, weight_grams: weight, requires_shipping: requires == null ? true : requires };
}

async function _flatRate() {
  var s = shipping.create({
    services: [{
      id:    "standard",
      label: "Standard (3-5 days)",
      zones: [{ country: "US", flat_amount_minor: 695 }],
    }],
  });
  var q = await s.rates({
    shipTo: { country: "US", postal: "94103" },
    lines: [_line(1, 250)],
    subtotal_minor: 2999,
  });
  check("flat rate returns service",       q.services.length === 1);
  check("flat rate amount",                 q.services[0].amount_minor === 695);
  check("flat rate label echoes",            q.services[0].label === "Standard (3-5 days)");
  check("total grams reported",              q.total_grams === 250);
}

async function _perGramWithBase() {
  var s = shipping.create({
    services: [{
      id:    "express",
      label: "Express (1-2 days)",
      zones: [{ country: "US", per_gram_minor: 2, base_minor: 500, min_amount_minor: 695, max_amount_minor: 9995 }],
    }],
  });
  // 3 × 500g + 1 × 100g = 1600g. base 500 + 2×1600 = 3700.
  var q = await s.rates({
    shipTo: { country: "US" },
    lines: [_line(3, 500), _line(1, 100)],
    subtotal_minor: 5000,
  });
  check("per-gram amount = base + g×rate", q.services[0].amount_minor === 3700);

  // Light cart hits min floor
  var q2 = await s.rates({
    shipTo: { country: "US" },
    lines: [_line(1, 10)],   // base 500 + 20 = 520 → below min 695
    subtotal_minor: 100,
  });
  check("per-gram clamps to min", q2.services[0].amount_minor === 695);

  // Heavy cart hits max ceiling
  var q3 = await s.rates({
    shipTo: { country: "US" },
    lines: [_line(1, 100000)],   // base 500 + 200000 = 200500 → above max 9995
    subtotal_minor: 100,
  });
  check("per-gram clamps to max", q3.services[0].amount_minor === 9995);
}

async function _freeOverThreshold() {
  var s = shipping.create({
    services: [{
      id:               "standard",
      label:            "Standard",
      zones:            [{ country: "US", flat_amount_minor: 695 }],
      free_over_minor:  7500,
    }],
  });
  var paid = await s.rates({ shipTo: { country: "US" }, lines: [_line(1, 100)], subtotal_minor: 7499 });
  check("not free below threshold", paid.services[0].amount_minor === 695 && paid.services[0].free === false);

  var free = await s.rates({ shipTo: { country: "US" }, lines: [_line(1, 100)], subtotal_minor: 7500 });
  check("free at threshold",         free.services[0].amount_minor === 0 && free.services[0].free === true);
}

async function _zoneSpecificity() {
  var s = shipping.create({
    services: [{
      id:    "standard",
      label: "Standard",
      zones: [
        { country: "US",                            flat_amount_minor: 995  },
        { country: "US", state: "CA",                flat_amount_minor: 695  },
        { country: "US", state: "CA", postal_prefix: "941", flat_amount_minor: 395 },
      ],
    }],
  });
  // SF — most specific
  var sf = await s.rates({ shipTo: { country: "US", state: "CA", postal: "94103" }, lines: [_line(1, 100)], subtotal_minor: 1000 });
  check("SF picks 941xx zone", sf.services[0].amount_minor === 395);

  // LA — falls to state
  var la = await s.rates({ shipTo: { country: "US", state: "CA", postal: "90001" }, lines: [_line(1, 100)], subtotal_minor: 1000 });
  check("LA picks CA zone",     la.services[0].amount_minor === 695);

  // TX — falls to country
  var tx = await s.rates({ shipTo: { country: "US", state: "TX" }, lines: [_line(1, 100)], subtotal_minor: 1000 });
  check("TX picks US zone",     tx.services[0].amount_minor === 995);

  // UK — no zone, service omitted
  var uk = await s.rates({ shipTo: { country: "GB" }, lines: [_line(1, 100)], subtotal_minor: 1000 });
  check("GB has no zone — service omitted", uk.services.length === 0);
}

async function _digitalOnly() {
  var s = shipping.create({
    services: [
      { id: "standard",  label: "Standard",  zones: [{ country: "US", flat_amount_minor: 695 }] },
      { id: "no-ship",   label: "Digital delivery", digital_only: true, zones: [{ country: "US", flat_amount_minor: 0 }] },
    ],
  });
  // Physical line — standard offered, digital filtered out
  var phys = await s.rates({ shipTo: { country: "US" }, lines: [_line(1, 100, true)], subtotal_minor: 2999 });
  check("physical cart: standard offered",  phys.services.length === 1 && phys.services[0].id === "standard");

  // Digital-only cart — digital service offered, standard filtered out
  var digi = await s.rates({ shipTo: { country: "US" }, lines: [_line(1, 0, false)], subtotal_minor: 2999 });
  check("digital cart: digital-only offered", digi.services.length === 1 && digi.services[0].id === "no-ship");
  check("digital cart: total_grams = 0",       digi.total_grams === 0);
}

async function _validation() {
  assert.throws(function () { shipping.create({}); },                                                       /services must be a non-empty/);
  assert.throws(function () { shipping.create({ services: [] }); },                                          /services must be a non-empty/);
  assert.throws(function () { shipping.create({ services: [{ id: "Bad ID" }] }); },                          /service id must match/);
  assert.throws(function () { shipping.create({ services: [{ id: "ok", label: "" }] }); },                   /label/);
  assert.throws(function () { shipping.create({ services: [{ id: "ok", label: "L" }] }); },                 /zones must be a non-empty/);
  assert.throws(function () { shipping.create({ services: [{ id: "ok", label: "L", zones: [{}] }] }); },     /country/);
  assert.throws(function () { shipping.create({ services: [{ id: "ok", label: "L", zones: [{ country: "US" }] }] }); }, /flat_amount_minor or per_gram_minor/);
  assert.throws(function () { shipping.create({ services: [{ id: "ok", label: "L", zones: [{ country: "US", flat_amount_minor: 100, per_gram_minor: 2 }] }] }); }, /cannot declare both/);

  var s = shipping.create({ services: [{ id: "ok", label: "L", zones: [{ country: "US", flat_amount_minor: 100 }] }] });
  await assert.rejects(s.rates({}),                                          /shipTo required/);
  await assert.rejects(s.rates({ shipTo: {}, lines: [], subtotal_minor: 0 }), /shipTo\.country/);
  await assert.rejects(s.rates({ shipTo: { country: "US" }, subtotal_minor: 0 }), /lines must be an array/);
}

async function run() {
  await _flatRate();
  await _perGramWithBase();
  await _freeOverThreshold();
  await _zoneSpecificity();
  await _digitalOnly();
  await _validation();
}

module.exports = { run: run };
