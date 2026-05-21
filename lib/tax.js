"use strict";
/**
 * @module shop.tax
 * @title  Tax primitive — pluggable adapter, operator-table built in
 *
 * @intro
 *   Pure-function tax computation against an operator-declared rule
 *   table. v1 ships the `operatorTable` adapter so the framework
 *   runs offline; the same `{ calculate(ctx) }` contract is what
 *   future Stripe Tax / TaxJar / Avalara adapters return — switching
 *   adapters is a one-line factory swap.
 *
 *   Rule shape:
 *
 *     {
 *       country:        "US",     // ISO 3166-1 alpha-2
 *       state?:         "CA",     // ISO 3166-2 subdivision code OR US state code
 *       postal_prefix?: "941",    // prefix match against shipTo.postal
 *       rate_bps:       875,      // 8.75% — basis points (1 bp = 0.01%)
 *     }
 *
 *   Match precedence (most specific first):
 *     1. country + state + postal_prefix
 *     2. country + state
 *     3. country
 *     4. fallback → rate_bps = 0 (no tax)
 *
 *   `calculate({ shipTo, lines, subtotal_minor })` returns the tax
 *   amount in minor units along with the matched rule (or fallback)
 *   so the storefront can show "Sales tax (CA 8.75%)" — `rate_bps`
 *   precision is preserved.
 *
 *   Tax is computed against `subtotal_minor` (post-discount,
 *   pre-shipping) — the pricing primitive's `totals()` shape. For
 *   v1, tax applies uniformly to every line; per-line category
 *   exemptions (food / digital / etc.) land in v1.x with an
 *   additive `lines[].tax_class` field.
 */

var COUNTRY_RE = /^[A-Z]{2}$/;
var STATE_RE   = /^[A-Z0-9]{1,5}$/;
var POSTAL_RE  = /^[A-Za-z0-9 -]{1,16}$/;
var MAX_BPS    = 10000;   // 100% — guards against typos like 87500

function _country(c, label) {
  if (typeof c !== "string" || !COUNTRY_RE.test(c)) {
    throw new TypeError("tax: " + label + " must be a 2-letter ISO 3166-1 country code (uppercase), got " + JSON.stringify(c));
  }
}
function _state(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !STATE_RE.test(s)) {
    throw new TypeError("tax: state must be 1-5 uppercase alphanumeric chars, got " + JSON.stringify(s));
  }
  return s;
}
function _postal(p) {
  if (p == null) return null;
  if (typeof p !== "string" || !POSTAL_RE.test(p)) {
    throw new TypeError("tax: postal must be 1-16 chars of [A-Za-z0-9 -], got " + JSON.stringify(p));
  }
  return p;
}
function _bps(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_BPS) {
    throw new TypeError("tax: rate_bps must be an integer 0..." + MAX_BPS + " (1 bp = 0.01%), got " + JSON.stringify(n));
  }
}
function _nonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("tax: " + label + " must be a non-negative integer (minor units)");
  }
}

function _validateRule(rule, i) {
  if (!rule || typeof rule !== "object") throw new TypeError("tax: rule[" + i + "] must be an object");
  _country(rule.country, "rule[" + i + "].country");
  if (rule.state !== undefined) _state(rule.state);
  if (rule.postal_prefix !== undefined) {
    if (typeof rule.postal_prefix !== "string" || !/^[A-Za-z0-9 -]{1,16}$/.test(rule.postal_prefix)) {
      throw new TypeError("tax: rule[" + i + "].postal_prefix must be 1-16 chars of [A-Za-z0-9 -]");
    }
  }
  _bps(rule.rate_bps);
}

// Compare two rules — higher specificity sorts first.
function _specificity(rule) {
  return (rule.country ? 1 : 0) + (rule.state ? 2 : 0) + (rule.postal_prefix ? 4 : 0);
}

function _matches(rule, shipTo) {
  if (rule.country !== shipTo.country) return false;
  if (rule.state && rule.state !== shipTo.state) return false;
  if (rule.postal_prefix) {
    if (!shipTo.postal) return false;
    if (shipTo.postal.indexOf(rule.postal_prefix) !== 0) return false;
  }
  return true;
}

function operatorTable(opts) {
  opts = opts || {};
  if (!Array.isArray(opts.rules)) throw new TypeError("tax.operatorTable: opts.rules must be an array");
  var rules = opts.rules.map(function (r, i) { _validateRule(r, i); return Object.freeze(Object.assign({}, r)); });
  // Pre-sort by specificity DESC so the first match wins.
  rules.sort(function (a, b) { return _specificity(b) - _specificity(a); });

  return {
    name: "operatorTable",
    calculate: async function (ctx) {
      if (!ctx || typeof ctx !== "object") throw new TypeError("tax.calculate: ctx object required");
      if (!ctx.shipTo || typeof ctx.shipTo !== "object") throw new TypeError("tax.calculate: ctx.shipTo required");
      _country(ctx.shipTo.country, "shipTo.country");
      if (ctx.shipTo.state)  _state(ctx.shipTo.state);
      if (ctx.shipTo.postal) _postal(ctx.shipTo.postal);
      _nonNegInt(ctx.subtotal_minor, "subtotal_minor");

      var matched = null;
      for (var i = 0; i < rules.length; i += 1) {
        if (_matches(rules[i], ctx.shipTo)) { matched = rules[i]; break; }
      }
      var rateBps = matched ? matched.rate_bps : 0;
      // tax = subtotal × bps / 10000, rounded to nearest minor unit.
      // Round-half-to-even (banker's) avoids systematic upward bias
      // across many small carts; Math.round in JS is round-half-up,
      // so we implement banker's by hand.
      var raw = ctx.subtotal_minor * rateBps / 10000;
      var floor = Math.floor(raw);
      var frac  = raw - floor;
      var tax;
      if (frac < 0.5)      tax = floor;
      else if (frac > 0.5) tax = floor + 1;
      else                 tax = (floor % 2 === 0) ? floor : floor + 1; // even
      return {
        tax_minor:    tax,
        rate_bps:     rateBps,
        jurisdiction: matched
          ? (matched.country + (matched.state ? "/" + matched.state : "") + (matched.postal_prefix ? "/" + matched.postal_prefix : ""))
          : "fallback",
      };
    },
  };
}

function create(opts) {
  // For v1 the only adapter is operatorTable. Future: stripeTax,
  // taxJar, avalara — each returns the same { name, calculate(ctx) }
  // shape so callers don't care which adapter is wired.
  opts = opts || {};
  if (opts.adapter && opts.adapter !== "operatorTable") {
    throw new TypeError("tax.create: unknown adapter " + JSON.stringify(opts.adapter) + " — only 'operatorTable' is supported in v1");
  }
  return operatorTable(opts);
}

module.exports = {
  create:        create,
  operatorTable: operatorTable,
  MAX_BPS:       MAX_BPS,
};
