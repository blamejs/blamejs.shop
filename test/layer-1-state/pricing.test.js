"use strict";
/**
 * pricing — pure-function money math.
 *
 * Layer 1 (state-bearing not by I/O but by per-line snapshots).
 *
 * Coverage:
 *   - lineTotal: qty × unit_amount_minor
 *   - subtotal: sums lines, refuses currency mix
 *   - totals: subtotal − discount + tax + shipping
 *   - format: localized currency rendering (USD, EUR, JPY zero-decimal)
 *   - validation: every minor-unit field is integer + non-negative
 */

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var pricing = bShop.pricing;

function _line(qty, unit, cur) {
  return { qty: qty, unit_amount_minor: unit, unit_currency: cur || "USD" };
}

async function _lineTotal() {
  check("lineTotal 1 × $0",        pricing.lineTotal(_line(1, 0))    === 0);
  check("lineTotal 3 × $9.99",     pricing.lineTotal(_line(3, 999))  === 2997);
  check("lineTotal 100 × $1.00",   pricing.lineTotal(_line(100, 100)) === 10000);

  assert.throws(function () { pricing.lineTotal(_line(0, 100)); },    /qty/);
  assert.throws(function () { pricing.lineTotal(_line(-1, 100)); },   /qty/);
  assert.throws(function () { pricing.lineTotal(_line(1, -1)); },     /unit_amount_minor/);
  assert.throws(function () { pricing.lineTotal(_line(1, 1.5)); },    /unit_amount_minor/);
  assert.throws(function () { pricing.lineTotal(); },                  /line object required/);
}

async function _subtotal() {
  var empty = pricing.subtotal([], { currency: "USD" });
  check("subtotal of empty cart is 0",     empty.amount_minor === 0);
  check("subtotal of empty cart line_count 0", empty.line_count === 0);
  check("subtotal of empty cart echoes currency from opts", empty.currency === "USD");

  var lines = [_line(2, 2999), _line(1, 2499)];   // $29.99 × 2 + $24.99 = $84.97
  var s = pricing.subtotal(lines);
  check("subtotal sums lines",        s.amount_minor === 8497);
  check("subtotal infers currency",    s.currency === "USD");
  check("subtotal line_count",         s.line_count === 2);

  // Multi-currency refused
  var mixed = [_line(1, 100, "USD"), _line(1, 100, "EUR")];
  assert.throws(function () { pricing.subtotal(mixed); }, /multi-currency carts are refused/);
}

async function _totals() {
  var cart = { currency: "USD" };
  var lines = [_line(2, 2999)];   // subtotal = 5998

  // Zero everything else
  var t0 = pricing.totals(cart, lines);
  check("totals defaults tax/shipping/discount to 0",  t0.tax_minor === 0 && t0.shipping_minor === 0 && t0.discount_minor === 0);
  check("totals grand = subtotal when zero else",      t0.grand_total_minor === 5998);
  check("totals breakdown carries 5 rows",              t0.breakdown.length === 5);
  check("totals breakdown discount is negative",        t0.breakdown[1].amount_minor === 0);

  // With tax + shipping + discount
  var t1 = pricing.totals(cart, lines, {
    tax_minor:      540,    // ~9% sales tax
    shipping_minor: 695,    // flat shipping
    discount_minor: 500,    // $5 off
  });
  check("totals applies discount before tax+shipping",
    t1.grand_total_minor === (5998 - 500 + 540 + 695));   // 6733
  check("totals echoes line_count", t1.line_count === 1);

  // Discount > subtotal → throws (clamping is caller's job)
  assert.throws(function () {
    pricing.totals(cart, lines, { discount_minor: 99999 });
  }, /exceeds subtotal/);

  // Cart currency must match lines currency
  assert.throws(function () {
    pricing.totals({ currency: "EUR" }, [_line(1, 100, "USD")]);
  }, /lines currency/);
}

async function _format() {
  check("format USD 2999",     pricing.format(2999,  "USD") === "$29.99");
  check("format USD 0",         pricing.format(0,     "USD") === "$0.00");
  check("format EUR 1099 en",   pricing.format(1099,  "EUR") === "€10.99");
  // JPY is a zero-decimal currency — amount_minor IS yen
  check("format JPY 1500",      pricing.format(1500,  "JPY") === "¥1,500");

  assert.throws(function () { pricing.format(-1, "USD"); },  /amount_minor must be a non-negative/);
  assert.throws(function () { pricing.format(100, "usd"); }, /ISO 4217/);
  assert.throws(function () { pricing.format(1.5, "USD"); }, /amount_minor must be a non-negative/);
}

async function run() {
  await _lineTotal();
  await _subtotal();
  await _totals();
  await _format();
}

module.exports = { run: run };
