// Edge-side multi-currency display reads. The Worker holds a direct D1
// binding (`env.DB`), so it reads the FX rate + per-currency rounding rule
// itself rather than hopping to the container. The shapes mirror
// lib/currency-display.js (fx_rates) + lib/currency-rounding.js
// (currency_rounding_rules) so the converted price is byte-identical to
// the container render.
//
// DISPLAY-ONLY: nothing here touches the cart / order / payment currency.
// It resolves which currency the price STRINGS render in.
//
// Missing-table-resilient: a query that throws (the fx_rates /
// currency_rounding_rules tables not migrated on this deploy) reads as "no
// rate" / "no rule", so the edge degrades to base-currency display instead
// of 500-ing a priced page.

import b from "../b.js";

var BPS_SCALE = 10000;
var CCY_RE = /^[A-Z]{3}$/;

// The fresh FX rate (base→quote) in integer basis-points, or null when
// there's nothing usable: missing row, expired row, identity pair handled
// by the caller, or a query failure (table absent). `at` is epoch-ms for
// the freshness check (defaults to now).
async function _getRateBps(DB, base, quote, at) {
  var now = at == null ? Date.now() : at;
  var row = null;
  try {
    row = await DB
      .prepare("SELECT rate_bps, expires_at FROM fx_rates WHERE base_currency = ?1 AND quote_currency = ?2 LIMIT 1")
      .bind(base, quote)
      .first();
  } catch (_e) {
    // fx_rates table absent / query failure — treat as "no rate" so the
    // caller degrades to base-currency display. This is a data read, not
    // an edge route handler: a null here means "no usable rate", which the
    // caller renders as base display — it never escalates to the container.
    row = null;
  }
  if (!row) return null;
  if (Number(row.expires_at) < now) return null;
  return Number(row.rate_bps);
}

// The active display rounding rule for a currency, shaped like
// lib/currency-rounding.js's `_shapeRow` (only the fields the conversion
// needs), or null when none / archived / table absent.
async function _getRule(DB, currency) {
  var row = null;
  try {
    row = await DB
      .prepare("SELECT increment_minor, mode, applies_to, active FROM currency_rounding_rules WHERE currency = ?1 LIMIT 1")
      .bind(currency)
      .first();
  } catch (_e) {
    // currency_rounding_rules table absent / query failure — no rule. The
    // caller still converts (banker's rounding only); a data-read miss, not
    // an edge route escalation.
    row = null;
  }
  if (!row || Number(row.active) !== 1) return null;
  return {
    increment_minor: Number(row.increment_minor),
    mode:            row.mode,
    applies_to:      row.applies_to,
  };
}

// Read the visitor's chosen display currency from the sealed `shop_ccy`
// cookie. The edge can't unseal the cookie (the vault keychain lives in
// the container), so it reads the COOKIE PRESENCE + shape only via
// `b.cookies.parseSafe`: the sealed value isn't a bare ISO code, so the
// edge cannot trust it directly. Instead the edge keys its cache on the
// raw sealed value (see worker/index.js) and resolves the actual currency
// here ONLY when an unsealed hint is available. For the sealed-cookie
// deploy the edge falls through to the container for converted display
// (the container has the vault) — the edge serves base-currency display
// for cache-eligible anonymous visitors, and the switcher POST + the
// per-currency cookie make every subsequent navigation container-rendered
// for that visitor (the cookie is treated as cache-disqualifying, like the
// session cookie). This keeps the edge cache correct without leaking a
// EUR page to a USD visitor.
//
// `selectedCurrency` is therefore passed in by the caller when known
// (e.g. an unsealed deploy / test); absent it, the resolver returns the
// inactive (base) context.

// Resolve the full currency context for one edge request. Returns:
//   { active, base, display, rateBps, rule, locale, note, options, selected }
// `active` is false (base display) when: no chosen currency, chosen ==
// base, chosen not in the allow-list, or no usable FX rate.
export async function resolveCurrencyContext(DB, opts) {
  opts = opts || {};
  var base = (opts.base || "USD").toUpperCase();
  var options = Array.isArray(opts.options) && opts.options.length
    ? opts.options.map(function (c) { return String(c).toUpperCase(); })
    : [base];
  var chosen = typeof opts.selected === "string" ? opts.selected.toUpperCase() : null;

  var inactive = {
    active:   false,
    base:     base,
    display:  base,
    rateBps:  BPS_SCALE,
    rule:     null,
    locale:   null,
    note:     null,
    options:  options,
    selected: base,
  };

  if (!chosen || !CCY_RE.test(chosen) || chosen === base) return inactive;
  if (options.indexOf(chosen) === -1) return inactive;

  var rateBps = await _getRateBps(DB, base, chosen, opts.at);
  if (rateBps == null) return inactive;

  var rule = await _getRule(DB, chosen);

  return {
    active:   true,
    base:     base,
    display:  chosen,
    rateBps:  rateBps,
    rule:     rule,
    locale:   null, // _lib.makeFormatPrice fills the per-currency default
    note:     "Prices shown in " + chosen + "; you'll be charged in " + base + ".",
    options:  options,
    selected: chosen,
  };
}

// Whether a request carries the display-currency cookie at all. The edge
// treats a `shop_ccy`-bearing request as cache-disqualifying (like a
// session cookie) so a converted page never lands in the shared cache
// keyed only by URL. Uses `b.cookies.parseSafe` (no throw on bad input).
export function hasCurrencyCookie(request) {
  var cookieHeader = request.headers.get("cookie") || "";
  if (cookieHeader.length === 0) return false;
  var parsed = b.cookies.parseSafe(cookieHeader);
  return Object.prototype.hasOwnProperty.call(parsed.jar, "shop_ccy");
}
