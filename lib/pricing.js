"use strict";
/**
 * @module shop.pricing
 * @title  Pricing primitive — pure functions over cart lines
 *
 * @intro
 *   Pure money math. No I/O, no database, no formatting that
 *   depends on environment — every primitive returns the same
 *   output for the same input.
 *
 *   All amounts are integer minor units (cents, pence) and carry
 *   their ISO 4217 currency code. The primitives refuse to add
 *   across currencies (a multi-currency cart is a programmer error
 *   the storefront should never construct); they throw rather than
 *   silently coerce.
 *
 *   v1 surface:
 *
 *     pricing.subtotal(lines)              → { amount_minor, currency, line_count }
 *     pricing.lineTotal(line)              → integer minor units
 *     pricing.totals(cart, lines, ctx)     → {
 *       subtotal_minor, tax_minor, shipping_minor, discount_minor,
 *       grand_total_minor, currency, breakdown: [...]
 *     }
 *     pricing.format(amount_minor, currency, opts?) → "$29.99"
 *
 *   Discounts / coupons land as a v1.x additive surface — the
 *   `totals()` shape already exposes `discount_minor` so storefront
 *   templates need no change when discount rules ship.
 */

var b = require("./vendor/blamejs");

var CURRENCY_RE = /^[A-Z]{3}$/;

function _assertCurrency(c) {
  if (typeof c !== "string" || !CURRENCY_RE.test(c)) {
    throw new TypeError("pricing: currency must be a 3-letter ISO 4217 code, got " + JSON.stringify(c));
  }
}

function _assertNonNegInt(n, label) {
  if (!Number.isInteger(n) || n < 0) {
    throw new TypeError("pricing: " + label + " must be a non-negative integer (minor units), got " + JSON.stringify(n));
  }
}

function _assertPositiveInt(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("pricing: " + label + " must be a positive integer, got " + JSON.stringify(n));
  }
}

/**
 * pricing.lineTotal({ qty, unit_amount_minor }) → integer minor units
 *
 * Safe over 32-bit JS integer range: a single line's total caps at
 * ~Number.MAX_SAFE_INTEGER cents = $90 trillion. Practical carts
 * have qty < 10K and unit < $10K, so a line is < $100M which is
 * well within safe-integer range. No BigInt needed at this scale.
 */
function lineTotal(line) {
  if (!line || typeof line !== "object") throw new TypeError("pricing.lineTotal: line object required");
  _assertPositiveInt(line.qty, "qty");
  _assertNonNegInt(line.unit_amount_minor, "unit_amount_minor");
  return line.qty * line.unit_amount_minor;
}

/**
 * pricing.subtotal(lines) → { amount_minor, currency, line_count }
 *
 * Sums up line totals. Refuses if lines mix currencies. Empty
 * arrays return amount_minor=0; currency in that case must be
 * supplied by the caller via the cart, not inferred from the
 * (empty) lines list.
 */
function subtotal(lines, opts) {
  if (!Array.isArray(lines)) throw new TypeError("pricing.subtotal: lines must be an array");
  if (lines.length === 0) {
    return { amount_minor: 0, currency: (opts && opts.currency) || null, line_count: 0 };
  }
  var currency = lines[0].unit_currency;
  _assertCurrency(currency);
  var total = 0;
  for (var i = 0; i < lines.length; i += 1) {
    var l = lines[i];
    if (l.unit_currency !== currency) {
      throw new TypeError("pricing.subtotal: line " + i + " currency " + JSON.stringify(l.unit_currency) +
                          " ≠ cart currency " + JSON.stringify(currency) + " — multi-currency carts are refused");
    }
    total += lineTotal(l);
  }
  return { amount_minor: total, currency: currency, line_count: lines.length };
}

/**
 * pricing.totals(cart, lines, ctx?) → totals breakdown
 *
 * ctx (all optional, defaults to zero):
 *   - tax_minor:      tax-engine output (from b.shop.tax later)
 *   - shipping_minor: shipping-engine output (from b.shop.shipping later)
 *   - discount_minor: applied discount (from coupons / member pricing)
 *
 * Returns the operator-facing breakdown that storefront + admin
 * templates render. Refuses if any minor-unit is negative or
 * non-integer.
 */
function totals(cart, lines, ctx) {
  if (!cart || typeof cart !== "object") throw new TypeError("pricing.totals: cart object required");
  _assertCurrency(cart.currency);
  ctx = ctx || {};
  var subRow = subtotal(lines, { currency: cart.currency });
  // If the cart has lines, the subtotal currency must match the
  // cart currency. (The lines' currency comes from the snapshot at
  // add-to-cart; in normal flow it equals the cart currency, but
  // the test catches drift early.)
  if (subRow.line_count > 0 && subRow.currency !== cart.currency) {
    throw new TypeError("pricing.totals: cart.currency " + JSON.stringify(cart.currency) +
                        " ≠ lines currency " + JSON.stringify(subRow.currency));
  }
  var tax      = ctx.tax_minor      == null ? 0 : ctx.tax_minor;
  var shipping = ctx.shipping_minor == null ? 0 : ctx.shipping_minor;
  var discount = ctx.discount_minor == null ? 0 : ctx.discount_minor;
  _assertNonNegInt(tax,      "tax_minor");
  _assertNonNegInt(shipping, "shipping_minor");
  _assertNonNegInt(discount, "discount_minor");
  if (discount > subRow.amount_minor) {
    throw new TypeError("pricing.totals: discount_minor (" + discount +
                        ") exceeds subtotal (" + subRow.amount_minor + ") — clamp at caller");
  }
  var grand = subRow.amount_minor - discount + tax + shipping;
  return {
    currency:          cart.currency,
    line_count:        subRow.line_count,
    subtotal_minor:    subRow.amount_minor,
    discount_minor:    discount,
    tax_minor:         tax,
    shipping_minor:    shipping,
    grand_total_minor: grand,
    breakdown: [
      { label: "subtotal", amount_minor:  subRow.amount_minor },
      { label: "discount", amount_minor: -discount },
      { label: "tax",      amount_minor:  tax },
      { label: "shipping", amount_minor:  shipping },
      { label: "total",    amount_minor:  grand },
    ],
  };
}

/**
 * pricing.format(amount_minor, currency, opts?) → localized string
 *
 * Composes the upstream `b.money` primitive so the storefront's
 * locale + currency rendering is consistent with the framework's
 * Money class. `b.money.fromMinorUnits(bigint, currency)` carries
 * the ISO 4217 exponent for free (JPY = 0, USD = 2, etc.) and
 * `.format(locale)` runs through `Intl.NumberFormat` with the
 * currency-correct minimum + maximum fraction digits.
 *
 * `opts.locale` overrides the default BCP 47 locale tag. Other
 * opts are reserved for future extension (locale-bound symbols /
 * format-as-units distinct from currency, etc.).
 */
function format(amountMinor, currency, opts) {
  _assertNonNegInt(amountMinor, "amount_minor");
  _assertCurrency(currency);
  opts = opts || {};
  var locale = opts.locale || "en-US";
  // b.money.fromMinorUnits accepts BigInt minor units; coerce the
  // Number-minor-unit at the boundary. Number is safe up to
  // ~9 × 10^15; practical cart totals are well below.
  var money = b.money.fromMinorUnits(BigInt(amountMinor), currency);
  return money.format(locale);
}

module.exports = {
  lineTotal: lineTotal,
  subtotal:  subtotal,
  totals:    totals,
  format:    format,
};
