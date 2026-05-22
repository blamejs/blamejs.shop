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

// ---- VAT / GST primitives ----------------------------------------------
//
// Sales tax (US-style) is *added* to a displayed price: $10 + 8.75% =
// $10.875. VAT (EU) and GST (AU / CA / IN / NZ / SG) are typically
// *extracted* from a displayed price: a €10 line at 20% VAT means the
// operator receives €8.33 net + €1.67 VAT, not €10 + €2. The B2B
// "reverse charge" mechanism on intra-EU trade moves the VAT
// obligation to the buyer (the seller invoices zero VAT and documents
// the buyer's VAT ID); the buyer self-assesses + remits in their own
// member state.
//
// These helpers are *pure functions* — they don't touch the network
// and they don't talk to the operator-table adapter. They're the
// math + format-validation surface the storefront / invoice
// primitives compose against. The operator-table adapter still owns
// jurisdiction-rule selection.

// Banker's rounding (round-half-to-even) for non-negative `raw`.
// JS Math.round is round-half-up, which biases tax totals upward
// across many small carts; this matches the rounding mode the
// existing operatorTable adapter uses.
function _bankersRound(raw) {
  var floor = Math.floor(raw);
  var frac  = raw - floor;
  if (frac < 0.5) return floor;
  if (frac > 0.5) return floor + 1;
  return (floor % 2 === 0) ? floor : floor + 1;
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("tax: currency must be a 3-letter ISO 4217 code (uppercase), got " + JSON.stringify(c));
  }
}

/**
 * Extract VAT from a VAT-inclusive (gross) price.
 *
 *   tax   = round(gross * rate_bps / (10000 + rate_bps))
 *   net   = gross - tax
 *
 * Returns `{ net_minor, tax_minor, gross_minor, rate_bps }`. The
 * gross figure round-trips exactly (`net + tax === gross`) by
 * construction — `net` is derived from `tax`, not rounded
 * independently.
 *
 * Use when the storefront displays VAT-inclusive prices (the EU
 * default for B2C). Banker's rounding to even.
 */
function calculateInclusive(args) {
  if (!args || typeof args !== "object") throw new TypeError("tax.calculateInclusive: args object required");
  _nonNegInt(args.amount_minor, "amount_minor");
  _bps(args.rate_bps);
  _currency(args.currency);
  var gross = args.amount_minor;
  var rate  = args.rate_bps;
  var tax   = _bankersRound(gross * rate / (10000 + rate));
  return {
    net_minor:   gross - tax,
    tax_minor:   tax,
    gross_minor: gross,
    rate_bps:    rate,
  };
}

/**
 * Add VAT to a VAT-exclusive (net) price.
 *
 *   tax   = round(net * rate_bps / 10000)
 *   gross = net + tax
 *
 * Returns `{ net_minor, tax_minor, gross_minor, rate_bps }`. Use
 * when the storefront displays VAT-exclusive prices (the standard
 * B2B presentation, and the US-sales-tax shape). Banker's rounding
 * to even — same convention as `operatorTable.calculate`.
 */
function calculateExclusive(args) {
  if (!args || typeof args !== "object") throw new TypeError("tax.calculateExclusive: args object required");
  _nonNegInt(args.amount_minor, "amount_minor");
  _bps(args.rate_bps);
  _currency(args.currency);
  var net  = args.amount_minor;
  var rate = args.rate_bps;
  var tax  = _bankersRound(net * rate / 10000);
  return {
    net_minor:   net,
    tax_minor:   tax,
    gross_minor: net + tax,
    rate_bps:    rate,
  };
}

// ---- VAT ID format validation -------------------------------------------
//
// VAT IDs have country-specific formats. The well-known patterns
// below cover the EU-27 + GB + Switzerland. These regexes validate
// the *format* only — they do NOT confirm the VAT ID is registered
// or active. That requires a live HTTPS call to the EU VIES service
// (or the equivalent national registry), which this primitive
// deliberately does NOT make:
//
//   - Zero npm runtime deps (composing an HTTPS+XML client here is
//     out of scope for a math primitive).
//   - No SSRF surface in the tax math path.
//   - VIES is a soft availability commitment; operators that depend
//     on it need their own retry / cache / fallback policy, which
//     belongs in the operator's checkout pipeline, not in lib/tax.js.
//
// Operators are responsible for VIES live-checking before storing
// any buyer VAT ID. This primitive only refuses obviously-malformed
// IDs (wrong country prefix, wrong length, wrong character class).
//
// The format table is operator-extensible — assign to
// `tax.VAT_FORMATS["XX"]` (a RegExp) to add or override a country.
//
// References: each pattern matches the published national format
// rule; mixed alphanumeric positions (FR, ES, IE) are preserved.
var VAT_FORMATS = {
  AT: /^ATU[0-9]{8}$/,                                    // Austria — U + 8 digits
  BE: /^BE[01][0-9]{9}$/,                                 // Belgium — 10 digits starting 0 or 1
  BG: /^BG[0-9]{9,10}$/,                                  // Bulgaria — 9 or 10 digits
  CY: /^CY[0-9]{8}[A-Z]$/,                                // Cyprus — 8 digits + letter
  CZ: /^CZ[0-9]{8,10}$/,                                  // Czechia — 8-10 digits
  DE: /^DE[0-9]{9}$/,                                     // Germany — 9 digits
  DK: /^DK[0-9]{8}$/,                                     // Denmark — 8 digits
  EE: /^EE[0-9]{9}$/,                                     // Estonia — 9 digits
  EL: /^EL[0-9]{9}$/,                                     // Greece (EU-internal — Greece uses EL not GR)
  GR: /^EL[0-9]{9}$/,                                     // Greece alias — operators sometimes pass GR
  ES: /^ES[A-Z0-9][0-9]{7}[A-Z0-9]$/,                     // Spain — alpha/digit, 7 digits, alpha/digit
  FI: /^FI[0-9]{8}$/,                                     // Finland — 8 digits
  FR: /^FR[0-9A-HJ-NP-Z]{2}[0-9]{9}$/,                    // France — 2-char prefix (no I/O) + 9 digits
  HR: /^HR[0-9]{11}$/,                                    // Croatia — 11 digits
  HU: /^HU[0-9]{8}$/,                                     // Hungary — 8 digits
  IE: /^IE[0-9][0-9A-Z*+][0-9]{5}[A-Z]{1,2}$/,            // Ireland — 9-character mixed
  IT: /^IT[0-9]{11}$/,                                    // Italy — 11 digits
  LT: /^LT(?:[0-9]{9}|[0-9]{12})$/,                       // Lithuania — 9 or 12 digits
  LU: /^LU[0-9]{8}$/,                                     // Luxembourg — 8 digits
  LV: /^LV[0-9]{11}$/,                                    // Latvia — 11 digits
  MT: /^MT[0-9]{8}$/,                                     // Malta — 8 digits
  NL: /^NL[0-9]{9}B[0-9]{2}$/,                            // Netherlands — 9 digits + B + 2 digits
  PL: /^PL[0-9]{10}$/,                                    // Poland — 10 digits
  PT: /^PT[0-9]{9}$/,                                     // Portugal — 9 digits
  RO: /^RO[0-9]{2,10}$/,                                  // Romania — 2-10 digits
  SE: /^SE[0-9]{12}$/,                                    // Sweden — 12 digits
  SI: /^SI[0-9]{8}$/,                                     // Slovenia — 8 digits
  SK: /^SK[0-9]{10}$/,                                    // Slovakia — 10 digits
  // Non-EU, retained for the EU-adjacent operator surface:
  GB: /^GB(?:[0-9]{9}|[0-9]{12}|GD[0-9]{3}|HA[0-9]{3})$/, // United Kingdom — 9 / 12 digits or GD/HA + 3
  CH: /^CHE[0-9]{9}(?:MWST|TVA|IVA)?$/,                   // Switzerland — CHE + 9 digits, optional suffix
};

// EU-27 member-state country codes (for reverse-charge eligibility).
// GB is intentionally NOT included — Brexit removed the UK from the
// intra-EU reverse-charge mechanism. CH was never an EU member.
var EU_COUNTRY_CODES = [
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI",
  "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT",
  "NL", "PL", "PT", "RO", "SE", "SI", "SK",
];
var _EU_SET = EU_COUNTRY_CODES.reduce(function (acc, c) { acc[c] = true; return acc; }, {});

function _isEu(cc) {
  if (typeof cc !== "string") return false;
  return _EU_SET[cc] === true;
}

/**
 * Validate a VAT ID's *format* against the country's published
 * pattern. Returns `{ ok, country, vat_number, format }`:
 *
 *   ok          — true when the ID matches the country's regex
 *   country     — the country code (uppercase, normalised)
 *   vat_number  — the ID with the country prefix stripped
 *   format      — the regex source string, for diagnostics
 *
 * On a mismatch returns `{ ok: false, country, vat_number: null,
 * format }`. On an unknown country code throws — the caller asked
 * for validation against a country we don't have a pattern for, and
 * silently returning `{ ok: true }` would be unsafe.
 *
 * IMPORTANT: this is FORMAT validation only. It does NOT confirm
 * the VAT ID is registered, active, or assigned to the named buyer.
 * Operators MUST cross-check against VIES (https://ec.europa.eu/
 * taxation_customs/vies/) or the equivalent national registry
 * before relying on a VAT ID for reverse-charge invoicing. This
 * primitive is the cheap pre-filter, not the legal record-of-truth.
 *
 * Extend `tax.VAT_FORMATS["XX"] = /^XX.../` to register additional
 * country patterns at boot time.
 */
function validateVatId(vat_id, country_code) {
  if (typeof vat_id !== "string") {
    throw new TypeError("tax.validateVatId: vat_id must be a string, got " + JSON.stringify(vat_id));
  }
  if (typeof country_code !== "string" || !/^[A-Z]{2}$/.test(country_code)) {
    throw new TypeError("tax.validateVatId: country_code must be a 2-letter uppercase ISO 3166-1 code, got " + JSON.stringify(country_code));
  }
  var pattern = VAT_FORMATS[country_code];
  if (!pattern) {
    throw new TypeError("tax.validateVatId: no VAT format registered for country " + JSON.stringify(country_code) + " — extend tax.VAT_FORMATS to add one");
  }
  // Normalise: strip whitespace; uppercase. Many invoicing UIs let
  // operators paste "DE 123 456 789" or "de123456789" — accept both.
  var normalised = vat_id.replace(/\s+/g, "").toUpperCase();
  var matched = pattern.test(normalised);
  if (!matched) {
    return {
      ok:         false,
      country:    country_code,
      vat_number: null,
      format:     pattern.source,
    };
  }
  // The country prefix on EU/GB/CH VAT IDs is always the first 2-3
  // chars. We strip the matching country prefix from the front and
  // return the remainder as the bare VAT number.
  var prefix = normalised.indexOf(country_code) === 0 ? country_code : normalised.slice(0, 3);
  return {
    ok:         true,
    country:    country_code,
    vat_number: normalised.slice(prefix.length),
    format:     pattern.source,
  };
}

/**
 * Decide whether the intra-EU B2B reverse-charge mechanism applies
 * to the current transaction. Returns one of:
 *
 *   { rate_bps: 0, reverse_charge: true,  reason: "eu-b2b",
 *     seller: { country, vat_number }, buyer: { country, vat_number } }
 *
 *   { rate_bps: null, reverse_charge: false, reason: <why-not> }
 *
 * When the function returns `reverse_charge: true` the caller MUST
 * invoice with VAT zero AND document both VAT IDs on the invoice;
 * the buyer self-assesses + remits in their member state.
 *
 * Conditions (ALL must hold):
 *   1. Seller has a VAT ID AND its country is in EU_COUNTRY_CODES.
 *   2. Buyer has a VAT ID AND its country is in EU_COUNTRY_CODES.
 *   3. Both VAT IDs pass format validation.
 *   4. The buyer's billing country matches the buyer-VAT-ID country
 *      (a mismatch is a fraud red flag — the operator should refuse
 *      reverse charge and either charge the seller's rate or block
 *      checkout pending VIES confirmation).
 *
 * The `ctx` argument is reserved for future signals (e.g. a
 * cached VIES-confirmation flag the operator's storefront sets
 * after a successful live check). Today only the `vat_validated_at`
 * timestamp is honoured as an advisory field on the seller side.
 *
 * IMPORTANT: this primitive does NOT call VIES. The operator must
 * confirm the buyer's VAT ID against the EU VIES service (or
 * equivalent national registry) BEFORE relying on the
 * `reverse_charge: true` outcome to suppress VAT on an invoice.
 * Format-pass + VIES-fail is a fraud vector; the operator's
 * checkout pipeline owns the live check.
 */
function applyReverseCharge(args) {
  if (!args || typeof args !== "object") throw new TypeError("tax.applyReverseCharge: args object required");
  var ctx = args.ctx || {};
  var buyerCountry = args.buyer_country;
  if (typeof buyerCountry !== "string" || !/^[A-Z]{2}$/.test(buyerCountry)) {
    throw new TypeError("tax.applyReverseCharge: buyer_country must be a 2-letter uppercase ISO 3166-1 code, got " + JSON.stringify(buyerCountry));
  }
  var sellerVatId = args.seller_vat_id;
  var buyerVatId  = args.buyer_vat_id;

  // Both VAT IDs must be present. Missing either one means the
  // buyer is treated as a B2C consumer — charge the seller's rate.
  if (typeof sellerVatId !== "string" || !sellerVatId) {
    return { rate_bps: null, reverse_charge: false, reason: "missing-seller-vat-id" };
  }
  if (typeof buyerVatId !== "string" || !buyerVatId) {
    return { rate_bps: null, reverse_charge: false, reason: "missing-buyer-vat-id" };
  }

  // The seller's country prefix is the first 2 chars of the VAT ID.
  // CH starts CHE — handle that out-of-band.
  var sellerCountry = sellerVatId.slice(0, 2).toUpperCase();
  if (sellerCountry === "CH") sellerCountry = "CH";

  if (!_isEu(sellerCountry)) {
    return { rate_bps: null, reverse_charge: false, reason: "seller-not-eu" };
  }
  if (!_isEu(buyerCountry)) {
    return { rate_bps: null, reverse_charge: false, reason: "buyer-not-eu" };
  }

  // Both VAT IDs must format-validate.
  var sellerCheck;
  var buyerCheck;
  try { sellerCheck = validateVatId(sellerVatId, sellerCountry); }
  catch (_e) { return { rate_bps: null, reverse_charge: false, reason: "seller-vat-id-unknown-country" }; }
  if (!sellerCheck.ok) {
    return { rate_bps: null, reverse_charge: false, reason: "seller-vat-id-bad-format" };
  }

  // The buyer's VAT ID country prefix must match the declared
  // buyer_country. A mismatch is a red flag — the buyer may be
  // trying to invoice into the wrong jurisdiction.
  var buyerVatCountry = buyerVatId.slice(0, 2).toUpperCase();
  if (buyerVatCountry !== buyerCountry) {
    return { rate_bps: null, reverse_charge: false, reason: "buyer-vat-id-country-mismatch" };
  }
  try { buyerCheck = validateVatId(buyerVatId, buyerCountry); }
  catch (_e) { return { rate_bps: null, reverse_charge: false, reason: "buyer-vat-id-unknown-country" }; }
  if (!buyerCheck.ok) {
    return { rate_bps: null, reverse_charge: false, reason: "buyer-vat-id-bad-format" };
  }

  return {
    rate_bps:       0,
    reverse_charge: true,
    reason:         "eu-b2b",
    seller:         { country: sellerCountry, vat_number: sellerCheck.vat_number },
    buyer:          { country: buyerCountry,  vat_number: buyerCheck.vat_number },
    // Advisory: timestamp at which the operator last live-checked
    // VIES for the buyer (if supplied via ctx). The primitive does
    // not consume this — it's surfaced so downstream invoice
    // rendering can show "VIES-confirmed YYYY-MM-DD".
    vies_validated_at: typeof ctx.vies_validated_at === "string" ? ctx.vies_validated_at : null,
  };
}

/**
 * Render a `rate_bps` value as a human-readable percentage string,
 * locale-aware via `Intl.NumberFormat`. Returns:
 *
 *   format({ rate_bps: 2000 })                     -> "20.0%"
 *   format({ rate_bps: 550 })                      -> "5.5%"
 *   format({ rate_bps: 0, reverse_charge: true })  -> "0% (reverse charge)"
 *   format({ rate_bps: 2000, locale: "de-DE" })    -> "20,0 %"
 *   format({ rate_bps: 2000, locale: "fr-FR" })    -> "20,0 %" (or NBSP variant)
 *
 * Locale defaults to `"en-US"`. The `reverse_charge` annotation is
 * intentionally English-only in v1 — operator-facing accounting
 * strings ship in English on every storefront the framework
 * currently supports; localising the bracketed phrase lands when
 * the storefront primitive grows a translation surface.
 */
function format(args) {
  if (!args || typeof args !== "object") throw new TypeError("tax.format: args object required");
  _bps(args.rate_bps);
  if (args.locale !== undefined && args.locale !== null) {
    if (typeof args.locale !== "string" || args.locale.length === 0) {
      throw new TypeError("tax.format: locale must be a non-empty BCP 47 string");
    }
  }
  var locale = args.locale || "en-US";
  var nf;
  try {
    nf = new Intl.NumberFormat(locale, {
      style:                 "percent",
      minimumFractionDigits: 1,
      maximumFractionDigits: 2,
    });
  } catch (_e) {
    throw new TypeError("tax.format: locale " + JSON.stringify(locale) + " rejected by Intl.NumberFormat");
  }
  // Intl percent formatter expects a decimal fraction (0.2 → "20%").
  var rendered = nf.format(args.rate_bps / 10000);
  // Strip a redundant ".0" / ",0" when the rate is a whole percent
  // AND not the zero rate — "20.0%" reads naturally; "0.0%" reads
  // as a precision claim we don't intend. For 0% with the reverse-
  // charge flag we always render "0%" to keep the annotation
  // grammatical.
  if (args.reverse_charge === true && args.rate_bps === 0) {
    // Intl renders 0 as "0%" already in en-US but as "0 %" in de/fr;
    // we want a stable shape with the annotation.
    var zero = new Intl.NumberFormat(locale, {
      style:                 "percent",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0);
    return zero + " (reverse charge)";
  }
  return rendered;
}

module.exports = {
  create:              create,
  operatorTable:       operatorTable,
  MAX_BPS:             MAX_BPS,
  calculateInclusive:  calculateInclusive,
  calculateExclusive:  calculateExclusive,
  validateVatId:       validateVatId,
  applyReverseCharge:  applyReverseCharge,
  format:              format,
  VAT_FORMATS:         VAT_FORMATS,
  EU_COUNTRY_CODES:    EU_COUNTRY_CODES,
};
