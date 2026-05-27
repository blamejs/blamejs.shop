"use strict";
/**
 * @module shop.currencyDisplay
 * @title  Multi-currency display conversion + FX rate cache
 *
 * @intro
 *   The catalog's stored prices stay in their native currency. This
 *   primitive layers display-side conversion on top so a customer in
 *   Berlin sees the operator's USD catalog rendered in EUR (or JPY,
 *   GBP, etc.) without the operator re-pricing every SKU.
 *
 *   Rates land in `fx_rates` (one row per (base, quote) ISO 4217
 *   pair) with an integer basis-points encoding (`rate * 10000`) and
 *   an explicit `expires_at` TTL. Operators wire a feed -- ECB,
 *   openexchangerates, fixer.io, their treasury system -- against
 *   `b.httpClient` outside this primitive and call `.setRate` or
 *   `.bulkSetRates` with the result. The framework never reaches out
 *   to a rate feed itself; that's an operator choice with operator
 *   credentials.
 *
 *   `.convert` refuses if the source or destination currency isn't in
 *   the operator's `supportedCurrencies` allow-list -- a guard against
 *   typos rendering `"USD" -> "USS"` and silently returning whatever
 *   stale row a previous typo left behind. It also refuses (returns
 *   `null` with `stale: true`) when no row exists OR the row has
 *   expired -- staleness is never hidden from the caller, so the
 *   storefront can fall back to the catalog currency rather than
 *   showing an out-of-date converted price.
 *
 *   Conversion math composes `b.money.convert(money, toCurrency,
 *   rateProvider)` so rounding is half-to-even (banker's), consistent
 *   with `pricing.format` + the framework Money primitive. JPY (zero-
 *   decimal) and KRW (zero-decimal) round through the same path
 *   without any per-currency special-casing.
 *
 *   Display formatting (`.format`) wraps `Intl.NumberFormat` with the
 *   operator-supplied locale -- mirrors `pricing.format` but accepts
 *   `locale` explicitly so storefront i18n can pass the request's
 *   `Accept-Language` choice through.
 *
 *   Composition:
 *     var fx = bShop.currencyDisplay.create({ query: q });
 *     await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92, source: "ecb" });
 *     var out = await fx.convert({ amount_minor: 2999, from: "USD", to: "EUR" });
 *     // { converted_minor: 2759, rate_bps: 9200, stale: false }
 *     var html = await fx.convertAndFormat({
 *       amount_minor: 2999, from: "USD", to: "EUR", locale: "de-DE",
 *     });
 *     // { display: "27,59 €", rate_bps: 9200, stale: false }
 *
 * @related b.money.convert, pricing.format
 */

var b = require("./vendor/blamejs");
var C = b.constants;
var currencyRounding = require("./currency-rounding");

var CURRENCY_RE = /^[A-Z]{3}$/;
var DEFAULT_TTL_MS = C.TIME.days(1);
var DEFAULT_SUPPORTED = [
  "USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF",
  "SEK", "NOK", "DKK", "NZD", "INR", "BRL", "MXN",
  "SGD", "HKD", "KRW",
];
var BPS_SCALE = 10000;
var KNOWN_SOURCES_RE = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

function _assertCurrency(c, label) {
  if (typeof c !== "string" || !CURRENCY_RE.test(c)) {
    throw new TypeError(
      "currencyDisplay: " + label +
      " must be a 3-letter uppercase ISO 4217 code, got " +
      JSON.stringify(c)
    );
  }
}

function _assertNonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "currencyDisplay: " + label +
      " must be a non-negative integer (minor units), got " +
      JSON.stringify(n)
    );
  }
}

function _assertPositiveInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError(
      "currencyDisplay: " + label +
      " must be a positive integer, got " + JSON.stringify(n)
    );
  }
}

function _assertSupported(c, supported, label) {
  if (supported.indexOf(c) === -1) {
    throw new TypeError(
      "currencyDisplay: " + label + " " + JSON.stringify(c) +
      " is not in supportedCurrencies (" + supported.join(",") + ")"
    );
  }
}

function _assertSource(s) {
  if (typeof s !== "string" || !KNOWN_SOURCES_RE.test(s)) {
    throw new TypeError(
      "currencyDisplay: source must match /[a-z0-9][a-z0-9._-]*[a-z0-9]/, got " +
      JSON.stringify(s)
    );
  }
}

// Float-rate -> integer basis-points. Refuses NaN / Infinity / sub-bps
// positives (a rate of 1e-5 collapses to zero and loses all precision).
function _rateToBps(rate) {
  if (typeof rate !== "number" || !isFinite(rate) || rate <= 0) {
    throw new TypeError(
      "currencyDisplay: rate must be a positive finite number, got " +
      JSON.stringify(rate)
    );
  }
  var bps = Math.round(rate * BPS_SCALE);
  if (bps <= 0) {
    throw new TypeError(
      "currencyDisplay: rate " + rate +
      " is below the basis-point resolution (1/10000); refusing"
    );
  }
  return bps;
}

// Render an integer bps back to the decimal-shaped string `b.money.convert`
// expects from its rate provider. 9200 -> "0.9200" -- four fraction digits
// always so the rationalizer downstream sees a stable shape.
function _bpsToDecimal(bps) {
  var whole = Math.floor(bps / BPS_SCALE);
  var frac  = bps % BPS_SCALE;
  var fracStr = String(frac);
  while (fracStr.length < 4) fracStr = "0" + fracStr;
  return whole + "." + fracStr;
}

function _normalizeSupported(list) {
  if (list == null) return DEFAULT_SUPPORTED.slice();
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError(
      "currencyDisplay: supportedCurrencies must be a non-empty array"
    );
  }
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    _assertCurrency(list[i], "supportedCurrencies[" + i + "]");
    if (out.indexOf(list[i]) === -1) out.push(list[i]);
  }
  return out;
}

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  var defaultTtlMs = opts.defaultTtlMs == null ? DEFAULT_TTL_MS : opts.defaultTtlMs;
  if (typeof defaultTtlMs !== "number" || !isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
    throw new TypeError(
      "currencyDisplay.create: defaultTtlMs must be a positive number, got " +
      JSON.stringify(opts.defaultTtlMs)
    );
  }
  var supported = _normalizeSupported(opts.supportedCurrencies);

  function _now() { return Date.now(); }

  async function setRate(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyDisplay.setRate: input object required");
    }
    _assertCurrency(input.base,  "base");
    _assertCurrency(input.quote, "quote");
    _assertSupported(input.base,  supported, "base");
    _assertSupported(input.quote, supported, "quote");
    if (input.base === input.quote) {
      throw new TypeError(
        "currencyDisplay.setRate: base and quote must differ (identity rate is implicit)"
      );
    }
    var bps    = _rateToBps(input.rate);
    var source = input.source == null ? "manual" : input.source;
    _assertSource(source);
    var ttlMs  = input.ttlMs == null ? defaultTtlMs : input.ttlMs;
    if (typeof ttlMs !== "number" || !isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError(
        "currencyDisplay.setRate: ttlMs must be a positive number, got " +
        JSON.stringify(input.ttlMs)
      );
    }
    var fetchedAt = _now();
    var expiresAt = fetchedAt + ttlMs;
    // Upsert. The (base, quote) primary key collapses the operator's
    // re-fetch into an overwrite -- the row identity is the pair, not
    // the fetched_at timestamp.
    await query(
      "INSERT INTO fx_rates (base_currency, quote_currency, rate_bps, source, fetched_at, expires_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
      "ON CONFLICT(base_currency, quote_currency) DO UPDATE SET " +
      "rate_bps = excluded.rate_bps, source = excluded.source, " +
      "fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
      [input.base, input.quote, bps, source, fetchedAt, expiresAt]
    );
    return {
      base:       input.base,
      quote:      input.quote,
      rate_bps:   bps,
      source:     source,
      fetched_at: fetchedAt,
      expires_at: expiresAt,
    };
  }

  async function getRate(base, quote) {
    _assertCurrency(base,  "base");
    _assertCurrency(quote, "quote");
    var r = await query(
      "SELECT rate_bps, source, fetched_at, expires_at " +
      "FROM fx_rates WHERE base_currency = ?1 AND quote_currency = ?2 LIMIT 1",
      [base, quote]
    );
    var row = r.rows[0];
    if (!row) return null;
    return {
      rate_bps:   Number(row.rate_bps),
      source:     String(row.source),
      fetched_at: Number(row.fetched_at),
      expires_at: Number(row.expires_at),
      stale:      Number(row.expires_at) < _now(),
    };
  }

  async function convert(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyDisplay.convert: input object required");
    }
    _assertNonNegInt(input.amount_minor, "amount_minor");
    _assertCurrency(input.from, "from");
    _assertCurrency(input.to,   "to");
    _assertSupported(input.from, supported, "from");
    _assertSupported(input.to,   supported, "to");
    if (input.from === input.to) {
      return { converted_minor: input.amount_minor, rate_bps: BPS_SCALE, stale: false };
    }
    var at = input.at == null ? _now() : input.at;
    if (typeof at !== "number" || !isFinite(at)) {
      throw new TypeError(
        "currencyDisplay.convert: at must be a number (epoch-ms), got " +
        JSON.stringify(input.at)
      );
    }
    var rateRow = await getRate(input.from, input.to);
    if (!rateRow || rateRow.expires_at < at) {
      return { converted_minor: null, rate_bps: null, stale: true };
    }
    // Compose b.money.convert so the rounding step is the framework's
    // banker's-rounding implementation. Build a single-call rate
    // provider on the fly -- the framework expects a decimal-shaped
    // string from `.rate(from, to)`.
    var money = b.money.fromMinorUnits(BigInt(input.amount_minor), input.from);
    var rateStr = _bpsToDecimal(rateRow.rate_bps);
    var provider = { rate: function (_from, _to) { return rateStr; } };
    var converted = b.money.convert(money, input.to, provider);
    return {
      converted_minor: Number(converted.toMinorUnits()),
      rate_bps:        rateRow.rate_bps,
      stale:           false,
    };
  }

  function format(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyDisplay.format: input object required");
    }
    _assertNonNegInt(input.amount_minor, "amount_minor");
    _assertCurrency(input.currency, "currency");
    var locale = input.locale == null ? "en-US" : input.locale;
    if (typeof locale !== "string" || !locale.length) {
      throw new TypeError(
        "currencyDisplay.format: locale must be a non-empty string, got " +
        JSON.stringify(input.locale)
      );
    }
    // Mirror pricing.format -- delegate to b.money so the ISO 4217
    // exponent (JPY 0, USD 2, BHD 3) is correct without local
    // bookkeeping.
    var money = b.money.fromMinorUnits(BigInt(input.amount_minor), input.currency);
    return money.format(locale);
  }

  async function convertAndFormat(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyDisplay.convertAndFormat: input object required");
    }
    var locale = input.locale == null ? "en-US" : input.locale;
    var converted = await convert({
      amount_minor: input.amount_minor,
      from:         input.from,
      to:           input.to,
      at:           input.at,
    });
    if (converted.converted_minor == null) {
      return {
        display:  null,
        rate_bps: null,
        stale:    true,
      };
    }
    var display = format({
      amount_minor: converted.converted_minor,
      currency:     input.to,
      locale:       locale,
    });
    return {
      display:         display,
      converted_minor: converted.converted_minor,
      rate_bps:        converted.rate_bps,
      stale:           converted.stale,
    };
  }

  async function cleanupExpired(ts) {
    var cutoff = ts == null ? _now() : ts;
    if (typeof cutoff !== "number" || !isFinite(cutoff)) {
      throw new TypeError(
        "currencyDisplay.cleanupExpired: ts must be a number (epoch-ms), got " +
        JSON.stringify(ts)
      );
    }
    var r = await query(
      "DELETE FROM fx_rates WHERE expires_at < ?1",
      [cutoff]
    );
    return Number(r.rowCount || 0);
  }

  // Operator nightly-import path. Validates EVERY row before writing
  // any -- a bad row in the batch surfaces as a thrown TypeError with
  // the row's index and the offending field, and zero rows land in
  // the table. (D1 has no client-side transactions; the pre-flight
  // validate-then-write pattern is the atomicity story.)
  async function bulkSetRates(rows) {
    if (!Array.isArray(rows)) {
      throw new TypeError("currencyDisplay.bulkSetRates: rows must be an array");
    }
    if (rows.length === 0) return { written: 0 };
    var normalized = [];
    for (var i = 0; i < rows.length; i += 1) {
      var row = rows[i];
      if (!row || typeof row !== "object") {
        throw new TypeError(
          "currencyDisplay.bulkSetRates: row[" + i + "] must be an object"
        );
      }
      try {
        _assertCurrency(row.base,  "base");
        _assertCurrency(row.quote, "quote");
        _assertSupported(row.base,  supported, "base");
        _assertSupported(row.quote, supported, "quote");
        if (row.base === row.quote) {
          throw new TypeError(
            "base and quote must differ (identity rate is implicit)"
          );
        }
        var bps    = _rateToBps(row.rate);
        var source = row.source == null ? "manual" : row.source;
        _assertSource(source);
        var ttlMs  = row.ttlMs == null ? defaultTtlMs : row.ttlMs;
        if (typeof ttlMs !== "number" || !isFinite(ttlMs) || ttlMs <= 0) {
          throw new TypeError("ttlMs must be a positive number");
        }
        normalized.push({
          base:   row.base,
          quote:  row.quote,
          bps:    bps,
          source: source,
          ttlMs:  ttlMs,
        });
      } catch (e) {
        throw new TypeError(
          "currencyDisplay.bulkSetRates: row[" + i + "] — " +
          (e && e.message || "invalid")
        );
      }
    }
    var fetchedAt = _now();
    var written = 0;
    for (var j = 0; j < normalized.length; j += 1) {
      var n = normalized[j];
      var expiresAt = fetchedAt + n.ttlMs;
      await query(
        "INSERT INTO fx_rates (base_currency, quote_currency, rate_bps, source, fetched_at, expires_at) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT(base_currency, quote_currency) DO UPDATE SET " +
        "rate_bps = excluded.rate_bps, source = excluded.source, " +
        "fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
        [n.base, n.quote, n.bps, n.source, fetchedAt, expiresAt]
      );
      written += 1;
    }
    return { written: written, fetched_at: fetchedAt };
  }

  // Display-side read: the rate to use when rendering `base` prices in
  // `quote`, or null when there's nothing usable. Returns null (rather
  // than the stale-flagged row `getRate` returns) for a missing row, an
  // expired row, OR a quote outside the operator's allow-list — the three
  // cases the storefront treats identically: fall back to the base
  // currency. Missing-table-resilient: a query that throws (the
  // `fx_rates` table not migrated on this deploy) reads as "no rate", so
  // a storefront without the table degrades to base display rather than
  // 500-ing every priced page. The `at` epoch-ms parameter overrides
  // "now" for the freshness check (tests, deterministic replay).
  async function getRateForDisplay(base, quote, at) {
    _assertCurrency(base,  "base");
    _assertCurrency(quote, "quote");
    if (base === quote) return { rate_bps: BPS_SCALE, stale: false };
    if (supported.indexOf(quote) === -1) return null;
    var now = at == null ? _now() : at;
    var row;
    try {
      row = await getRate(base, quote);
    } catch (_e) {
      // fx_rates table absent / query failure — degrade to base display.
      return null;
    }
    if (!row || row.expires_at < now) return null;
    return { rate_bps: row.rate_bps, stale: false, source: row.source, fetched_at: row.fetched_at };
  }

  return {
    supportedCurrencies: supported.slice(),
    setRate:             setRate,
    getRate:             getRate,
    getRateForDisplay:   getRateForDisplay,
    convert:             convert,
    format:              format,
    convertAndFormat:    convertAndFormat,
    cleanupExpired:      cleanupExpired,
    bulkSetRates:        bulkSetRates,
  };
}

// ---- display presenter (request-scoped) ---------------------------------
//
// The storefront renders a price string at dozens of call sites (PDP,
// catalog grids, search cards, cart lines + totals). Those renderers are
// synchronous; the FX-rate + rounding-rule lookups are async D1 reads.
// The presenter resolves the rate + rule ONCE per request (`load`), then
// hands the renderers a synchronous `format(amount_minor, currency)` that
// converts the catalog's base-currency price into the visitor's chosen
// display currency and formats it for that currency's locale.
//
// This is DISPLAY-ONLY. The cart / order / payment currency is unchanged
// — `pricing.format` + the stored order totals remain authoritative for
// what the customer is charged. The presenter only transforms the string
// the customer reads. When the display currency is the base currency (or
// unset / unknown / has no usable FX rate), `format` is exactly
// `b.money.fromMinorUnits(...).format(locale)` over the base amount.

// Default BCP 47 locale per currency so a EUR price renders "27,59 €"
// and a JPY price renders "¥3,200" without the operator wiring a locale
// table. The visitor's Accept-Language can override via `opts.locale`.
var DEFAULT_LOCALE_BY_CURRENCY = {
  USD: "en-US", CAD: "en-CA", AUD: "en-AU", NZD: "en-NZ", SGD: "en-SG",
  HKD: "en-HK", INR: "en-IN", GBP: "en-GB", EUR: "de-DE", CHF: "de-CH",
  SEK: "sv-SE", NOK: "nb-NO", DKK: "da-DK", JPY: "ja-JP", KRW: "ko-KR",
  BRL: "pt-BR", MXN: "es-MX",
};

function _localeFor(currency, fallback) {
  return DEFAULT_LOCALE_BY_CURRENCY[currency] || fallback || "en-US";
}

// Pure base→display minor-unit conversion. Composes b.money.convert (the
// framework's banker's-rounding FX step, ISO 4217 exponent-aware) for the
// currency change, then the pure currency-rounding step for the display
// increment rule (CHF 0.05, SEK 0.10, …). No I/O, no audit-log write —
// the audit log is for committed checkout roundings, not the read-side
// display render. `rateBps` is the integer basis-points rate
// (rate * 10000); `rule` is the shaped rounding rule (or null for none).
function _convertMinorForDisplay(baseMinor, baseCurrency, displayCurrency, rateBps, rule) {
  var convertedMinor;
  if (baseCurrency === displayCurrency || rateBps === BPS_SCALE) {
    convertedMinor = baseMinor;
  } else {
    var money    = b.money.fromMinorUnits(BigInt(baseMinor), baseCurrency);
    var rateStr  = _bpsToDecimal(rateBps);
    var provider = { rate: function (_from, _to) { return rateStr; } };
    convertedMinor = Number(b.money.convert(money, displayCurrency, provider).toMinorUnits());
  }
  // Display-increment rounding — only when an active rule covers the
  // display-side render. The rule's `applies_to` is honoured: a rule
  // scoped to `cart_total` only does not touch a PDP price.
  if (rule && rule.increment_minor > 1 &&
      (rule.applies_to === "all" || rule.applies_to === "display_only")) {
    convertedMinor = currencyRounding.round(convertedMinor, rule.increment_minor, rule.mode);
  }
  return convertedMinor;
}

// Build a presenter for ONE request. `displayCurrency` is the visitor's
// chosen currency (from the sealed cookie); `baseCurrency` is the
// catalog's settlement currency (USD by default). Resolves the FX rate +
// rounding rule up front so the returned `format` is synchronous.
//
//   opts.fx              — a currencyDisplay.create() instance (FX reads)
//   opts.rounding        — a currencyRounding.create() instance (optional)
//   opts.displayCurrency — the visitor's choice (may be null / unknown)
//   opts.baseCurrency    — catalog settlement currency (default "USD")
//   opts.locale          — override the per-currency default locale
//   opts.at              — epoch-ms freshness override (tests)
//
// When the display currency equals the base, is unset, is unsupported, or
// has no usable FX rate, the presenter resolves to an INACTIVE presenter
// that formats in the base currency — never a broken / NaN price.
async function loadPresenter(opts) {
  opts = opts || {};
  var baseCurrency = opts.baseCurrency == null ? "USD" : opts.baseCurrency;
  _assertCurrency(baseCurrency, "baseCurrency");
  var requested = opts.displayCurrency;

  // No / garbage choice, or the base currency itself → base presenter.
  if (typeof requested !== "string" || !CURRENCY_RE.test(requested) || requested === baseCurrency) {
    return _basePresenter(baseCurrency, opts.locale);
  }
  if (!opts.fx || typeof opts.fx.getRateForDisplay !== "function") {
    return _basePresenter(baseCurrency, opts.locale);
  }
  // Outside the operator's allow-list → base presenter (and the switcher
  // never lists it, so this is the tampered-cookie path).
  if (opts.fx.supportedCurrencies && opts.fx.supportedCurrencies.indexOf(requested) === -1) {
    return _basePresenter(baseCurrency, opts.locale);
  }

  var rate = await opts.fx.getRateForDisplay(baseCurrency, requested, opts.at);
  if (!rate) {
    // No usable FX rate (missing / stale / table absent) → base display.
    return _basePresenter(baseCurrency, opts.locale);
  }

  var rule = null;
  if (opts.rounding && typeof opts.rounding.getRule === "function") {
    try {
      rule = await opts.rounding.getRule(requested);
      if (rule && !rule.active) rule = null;
    } catch (_e) {
      // currency_rounding_rules table absent / read failure — convert
      // without the display-increment step. Banker's rounding from the
      // FX step still applies, so the price is never broken.
      rule = null;
    }
  }

  var locale  = opts.locale || _localeFor(requested);
  var rateBps = rate.rate_bps;

  return {
    active:          true,
    baseCurrency:    baseCurrency,
    displayCurrency: requested,
    locale:          locale,
    note:            _disclosure(requested, baseCurrency),
    // Synchronous price renderer. `currency` is the price's stored
    // currency; when it matches the base we convert to the display
    // currency, otherwise we format it as-is (a price already quoted in
    // a non-base currency isn't re-converted — we have no base→that rate
    // resolved this request, and re-quoting it would be wrong).
    format: function (amountMinor, currency) {
      var cur = currency == null ? baseCurrency : currency;
      if (cur !== baseCurrency) {
        return b.money.fromMinorUnits(BigInt(amountMinor), cur).format(_localeFor(cur, "en-US"));
      }
      var displayMinor = _convertMinorForDisplay(amountMinor, baseCurrency, requested, rateBps, rule);
      return b.money.fromMinorUnits(BigInt(displayMinor), requested).format(locale);
    },
  };
}

// The pass-through presenter — `format` is byte-for-byte `pricing.format`
// (b.money over the stored amount + currency). Used whenever no display
// conversion applies, so every call site can use `presenter.format`
// unconditionally.
function _basePresenter(baseCurrency, localeOverride) {
  return {
    active:          false,
    baseCurrency:    baseCurrency,
    displayCurrency: baseCurrency,
    locale:          localeOverride || _localeFor(baseCurrency),
    note:            null,
    format: function (amountMinor, currency) {
      var cur = currency == null ? baseCurrency : currency;
      var loc = localeOverride || _localeFor(cur, "en-US");
      return b.money.fromMinorUnits(BigInt(amountMinor), cur).format(loc);
    },
  };
}

// The customer-facing disclosure shown near converted prices: the charge
// stays in the settlement currency even though the display is converted.
function _disclosure(displayCurrency, baseCurrency) {
  return "Prices shown in " + displayCurrency + "; you'll be charged in " + baseCurrency + ".";
}

module.exports = {
  create:                  create,
  loadPresenter:           loadPresenter,
  DEFAULT_TTL_MS:          DEFAULT_TTL_MS,
  DEFAULT_SUPPORTED:       DEFAULT_SUPPORTED,
  BPS_SCALE:               BPS_SCALE,
  DEFAULT_LOCALE_BY_CURRENCY: DEFAULT_LOCALE_BY_CURRENCY,
  // Pure conversion exposed so the edge worker computes byte-identical
  // display prices from the same rate + rule inputs.
  convertMinorForDisplay:  _convertMinorForDisplay,
  localeFor:               _localeFor,
  disclosure:              _disclosure,
};
