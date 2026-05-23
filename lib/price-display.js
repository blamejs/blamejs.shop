"use strict";
/**
 * @module shop.priceDisplay
 * @title  Per-region price-display mode + per-customer overrides
 *
 * @intro
 *   The catalog stores one set of prices. Whether the storefront
 *   renders a line as `€12.00` (tax included — the EU B2C default) or
 *   `€10.00 + VAT` (tax excluded — the standard B2B presentation, and
 *   the US default) is a *display* decision, not a pricing one.
 *
 *   Operators declare per-country presentation defaults via
 *   `defineRule({ country, mode, customer_status_in? })`. The
 *   storefront calls `getModeFor({ country, customer_status? })` at
 *   render time and resolves with the precedence:
 *
 *     1. A per-customer override (set via `defineCustomerOverride`)
 *        always wins. B2B accounts trading in the EU often need
 *        pre-tax presentation even when the country defaults to
 *        tax-included; the customer-override table is the direct
 *        lever for that pin.
 *
 *     2. The country rule applies when either it has no
 *        `customer_status_in` filter (the country default), OR the
 *        request's `customer_status` is in the rule's filter list
 *        (the status-narrowed form).
 *
 *     3. No rule, no status match — `getModeFor` returns `null`,
 *        leaving the storefront free to pick its own fallback
 *        (typically `tax_excluded` for safety, since under-disclosing
 *        tax is the riskier failure mode than over-disclosing it).
 *
 *   The mode vocabulary is the SQL CHECK constraint's enum:
 *
 *     tax_included   — display gross (tax already in the figure)
 *     tax_excluded   — display net   (tax shown separately or omitted)
 *     both           — display both forms in a single label
 *
 *   `formatPrice({ amount_minor, currency, country, customer_status?,
 *                  locale })` resolves the mode, optionally composes
 *   the injected `tax` primitive's `calculateInclusive` /
 *   `calculateExclusive` to derive a `{ net, tax, gross }` breakdown,
 *   and returns a locale-aware display label via `b.money.format` so
 *   ISO 4217 exponent rules (JPY zero-decimal, BHD three-decimal)
 *   render correctly without per-currency special-casing.
 *
 *   `tax` resolution: when the operator wires a `tax` adapter
 *   (`{ calculateInclusive, calculateExclusive }`) the primitive
 *   composes against it AND looks up a per-country rate from the
 *   operator's injected `taxRates` map (or the optional `geolocation`
 *   handle's resolved country). When no tax adapter is wired the
 *   primitive returns the display label without a breakdown — useful
 *   for catalogs that don't apply tax at the storefront layer at all.
 *
 *   Composition:
 *
 *     var pd = priceDisplay.create({
 *       query:    q,
 *       tax:      bShop.tax,                          // optional
 *       taxRates: { DE: 1900, FR: 2000, US: 0 },      // optional
 *     });
 *     await pd.defineRule({ country: "DE", mode: "tax_included" });
 *     await pd.defineRule({
 *       country: "US", mode: "tax_excluded",
 *     });
 *     await pd.defineCustomerOverride({
 *       customer_id: "cus_b2b_42", mode: "tax_excluded",
 *     });
 *     var out = await pd.formatPrice({
 *       amount_minor:    12000,
 *       currency:        "EUR",
 *       country:         "DE",
 *       customer_status: "b2c",
 *       locale:          "de-DE",
 *     });
 *     // {
 *     //   display_minor: 12000,
 *     //   display_label: "120,00 €",
 *     //   tax_breakdown: { net: 10084, tax: 1916, gross: 12000 },
 *     // }
 *
 * @related shop.tax, shop.currencyDisplay, shop.geolocation
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var COUNTRY_RE       = /^[A-Z]{2}$/;
var CURRENCY_RE      = /^[A-Z]{3}$/;
var STATUS_RE        = /^[a-z0-9][a-z0-9_-]{0,31}$/;
var CUSTOMER_ID_RE   = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
var MAX_STATUSES     = 16;
var MAX_LIST_LIMIT   = 500;
var MAX_BPS          = 10000;
var MODES            = ["tax_included", "tax_excluded", "both"];
var ALLOWED_PATCH    = ["mode", "customer_status_in"];

// ---- validation helpers -------------------------------------------------

function _country(c, label) {
  if (typeof c !== "string" || !COUNTRY_RE.test(c)) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must be a 2-letter uppercase ISO 3166-1 country code, got " +
      JSON.stringify(c)
    );
  }
  return c;
}

function _currency(c, label) {
  if (typeof c !== "string" || !CURRENCY_RE.test(c)) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must be a 3-letter uppercase ISO 4217 code, got " +
      JSON.stringify(c)
    );
  }
  return c;
}

function _mode(m, label) {
  if (typeof m !== "string" || MODES.indexOf(m) === -1) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must be one of (" + MODES.join(", ") + "), got " +
      JSON.stringify(m)
    );
  }
  return m;
}

function _status(s, label) {
  if (typeof s !== "string" || !STATUS_RE.test(s)) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must match /[a-z0-9][a-z0-9_-]{0,31}/, got " +
      JSON.stringify(s)
    );
  }
  return s;
}

function _customerId(id, label) {
  if (typeof id !== "string" || !CUSTOMER_ID_RE.test(id)) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must match /[A-Za-z0-9][A-Za-z0-9_.-]{0,127}/, got " +
      JSON.stringify(id)
    );
  }
  return id;
}

function _statusList(list, label) {
  if (list == null) return null;
  if (!Array.isArray(list)) {
    throw new TypeError(
      "priceDisplay: " + label + " must be an array when present"
    );
  }
  if (list.length === 0) return null;
  if (list.length > MAX_STATUSES) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must contain at most " + MAX_STATUSES + " entries, got " + list.length
    );
  }
  var seen = {};
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    var s = _status(list[i], label + "[" + i + "]");
    if (seen[s]) continue;
    seen[s] = true;
    out.push(s);
  }
  return out;
}

function _nonNegInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must be a non-negative integer (minor units), got " +
      JSON.stringify(n)
    );
  }
  return n;
}

function _bps(n, label) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_BPS) {
    throw new TypeError(
      "priceDisplay: " + label +
      " must be an integer 0..." + MAX_BPS + " (1 bp = 0.01%), got " +
      JSON.stringify(n)
    );
  }
  return n;
}

function _locale(l) {
  if (l == null) return "en-US";
  if (typeof l !== "string" || l.length === 0) {
    throw new TypeError(
      "priceDisplay: locale must be a non-empty BCP 47 string, got " +
      JSON.stringify(l)
    );
  }
  return l;
}

// ---- row hydration ------------------------------------------------------

function _safeParseArray(s) {
  if (s == null) return null;
  try {
    var parsed = JSON.parse(s);
    if (Array.isArray(parsed)) return parsed.length ? parsed : null;
    return null;
  } catch (_e) {
    return null;
  }
}

function _hydrateRule(r) {
  if (!r) return null;
  return {
    country:             String(r.country),
    mode:                String(r.mode),
    customer_status_in:  _safeParseArray(r.customer_status_in_json),
    archived_at:         r.archived_at == null ? null : Number(r.archived_at),
    created_at:          Number(r.created_at),
    updated_at:          Number(r.updated_at),
  };
}

function _hydrateOverride(r) {
  if (!r) return null;
  return {
    customer_id: String(r.customer_id),
    mode:        String(r.mode),
    set_at:      Number(r.set_at),
  };
}

// ---- tax-rate lookup ----------------------------------------------------

// The operator wires either a static `taxRates` map (country -> bps),
// a function (country -> bps | Promise<bps>), or both a taxRates value
// AND a geolocation handle. When the request's country is missing the
// optional geolocation lookup fills it in; the taxRates map then
// resolves the bps for that country. A missing country in the map
// resolves to null — the primitive then returns the display label
// without a tax_breakdown.
async function _resolveRateBps(country, taxRates) {
  if (taxRates == null) return null;
  if (typeof taxRates === "function") {
    var r = await taxRates(country);
    if (r == null) return null;
    return _bps(r, "taxRates(" + country + ")");
  }
  if (typeof taxRates === "object") {
    if (!Object.prototype.hasOwnProperty.call(taxRates, country)) return null;
    var b = taxRates[country];
    if (b == null) return null;
    return _bps(b, "taxRates." + country);
  }
  throw new TypeError(
    "priceDisplay: taxRates must be an object (country -> bps), a function, or null"
  );
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) {
      return _b().externalDb.query(sql, params);
    };
  }
  var tax         = opts.tax || null;
  var taxRates    = opts.taxRates == null ? null : opts.taxRates;
  var geolocation = opts.geolocation || null;

  if (tax != null && typeof tax !== "object") {
    throw new TypeError("priceDisplay.create: tax must be an object handle when present");
  }
  if (tax != null) {
    if (typeof tax.calculateInclusive !== "function" ||
        typeof tax.calculateExclusive !== "function") {
      throw new TypeError(
        "priceDisplay.create: tax handle must expose calculateInclusive + calculateExclusive"
      );
    }
  }
  if (geolocation != null && typeof geolocation !== "object") {
    throw new TypeError(
      "priceDisplay.create: geolocation must be an object handle when present"
    );
  }

  function _now() { return Date.now(); }

  // ---- defineRule ----------------------------------------------------

  async function defineRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("priceDisplay.defineRule: input object required");
    }
    var country  = _country(input.country, "country");
    var mode     = _mode(input.mode, "mode");
    var statuses = _statusList(input.customer_status_in, "customer_status_in");

    // Refuse a redefine — operators should `updateRule` to mutate an
    // existing country. A blind INSERT against the country-PK column
    // would error at the SQL layer; the explicit precheck produces a
    // friendlier message.
    var existing = (await query(
      "SELECT country FROM price_display_rules WHERE country = ?1 LIMIT 1",
      [country]
    )).rows[0];
    if (existing) {
      throw new TypeError(
        "priceDisplay.defineRule: country " + JSON.stringify(country) +
        " already has a rule — use updateRule"
      );
    }

    var ts = _now();
    await query(
      "INSERT INTO price_display_rules (country, mode, customer_status_in_json, " +
      "archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, NULL, ?4, ?4)",
      [country, mode, statuses == null ? null : JSON.stringify(statuses), ts]
    );
    return await getRule(country);
  }

  // ---- getRule / listRules -------------------------------------------

  async function getRule(country) {
    _country(country, "country");
    var r = (await query(
      "SELECT * FROM price_display_rules WHERE country = ?1 LIMIT 1",
      [country]
    )).rows[0];
    return _hydrateRule(r);
  }

  async function listRules(listOpts) {
    listOpts = listOpts || {};
    var includeArchived = false;
    if (listOpts.include_archived != null) {
      if (typeof listOpts.include_archived !== "boolean") {
        throw new TypeError(
          "priceDisplay.listRules: include_archived must be a boolean"
        );
      }
      includeArchived = listOpts.include_archived;
    }
    var limit = listOpts.limit == null ? 100 : listOpts.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIST_LIMIT) {
      throw new TypeError(
        "priceDisplay.listRules: limit must be an integer in [1, " +
        MAX_LIST_LIMIT + "]"
      );
    }
    var sql;
    if (includeArchived) {
      sql = "SELECT * FROM price_display_rules ORDER BY country ASC LIMIT ?1";
    } else {
      sql = "SELECT * FROM price_display_rules WHERE archived_at IS NULL " +
            "ORDER BY country ASC LIMIT ?1";
    }
    var rows = (await query(sql, [limit])).rows;
    var out = [];
    for (var i = 0; i < rows.length; i += 1) out.push(_hydrateRule(rows[i]));
    return out;
  }

  // ---- updateRule ----------------------------------------------------

  async function updateRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("priceDisplay.updateRule: input object required");
    }
    var country = _country(input.country, "country");
    var patch   = input.patch;
    if (!patch || typeof patch !== "object") {
      throw new TypeError("priceDisplay.updateRule: patch object required");
    }
    var keys = Object.keys(patch);
    if (!keys.length) {
      throw new TypeError(
        "priceDisplay.updateRule: patch must include at least one column"
      );
    }
    var current = await getRule(country);
    if (!current) {
      throw new TypeError(
        "priceDisplay.updateRule: country " + JSON.stringify(country) +
        " has no rule"
      );
    }

    var sets   = [];
    var params = [];
    var idx    = 1;
    for (var i = 0; i < keys.length; i += 1) {
      var col = keys[i];
      if (ALLOWED_PATCH.indexOf(col) === -1) {
        throw new TypeError(
          "priceDisplay.updateRule: unsupported column " +
          JSON.stringify(col)
        );
      }
      if (col === "mode") {
        sets.push("mode = ?" + idx);
        params.push(_mode(patch[col], "mode"));
      } else /* customer_status_in */ {
        var v = _statusList(patch[col], "customer_status_in");
        sets.push("customer_status_in_json = ?" + idx);
        params.push(v == null ? null : JSON.stringify(v));
      }
      idx += 1;
    }
    sets.push("updated_at = ?" + idx);
    params.push(_now());
    idx += 1;
    params.push(country);

    var r = await query(
      "UPDATE price_display_rules SET " + sets.join(", ") +
      " WHERE country = ?" + idx,
      params
    );
    if (Number(r.rowCount || 0) === 0) {
      throw new TypeError(
        "priceDisplay.updateRule: country " + JSON.stringify(country) +
        " not found"
      );
    }
    return await getRule(country);
  }

  // ---- archiveRule ---------------------------------------------------

  async function archiveRule(country) {
    _country(country, "country");
    var ts = _now();
    var r = await query(
      "UPDATE price_display_rules SET archived_at = ?1, updated_at = ?1 " +
      "WHERE country = ?2 AND archived_at IS NULL",
      [ts, country]
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getRule(country);
      if (!existing) {
        throw new TypeError(
          "priceDisplay.archiveRule: country " + JSON.stringify(country) +
          " not found"
        );
      }
      // Idempotent — already archived. Return the existing row so a
      // sweep that archives every legacy country doesn't have to
      // special-case the ones a coworker already retired.
      return existing;
    }
    return await getRule(country);
  }

  // ---- customer overrides --------------------------------------------

  async function defineCustomerOverride(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError(
        "priceDisplay.defineCustomerOverride: input object required"
      );
    }
    var customerId = _customerId(input.customer_id, "customer_id");
    var mode       = _mode(input.mode, "mode");
    var ts         = _now();
    // Upsert — operators flip a customer's override in place without
    // having to clear-then-set. The row identity IS the customer_id;
    // re-issuing overwrites the mode + bumps set_at.
    await query(
      "INSERT INTO customer_price_display_overrides (customer_id, mode, set_at) " +
      "VALUES (?1, ?2, ?3) " +
      "ON CONFLICT(customer_id) DO UPDATE SET mode = excluded.mode, set_at = excluded.set_at",
      [customerId, mode, ts]
    );
    return await customerOverride(customerId);
  }

  async function clearCustomerOverride(input) {
    var customerId;
    if (typeof input === "string") {
      customerId = _customerId(input, "customer_id");
    } else if (input && typeof input === "object") {
      customerId = _customerId(input.customer_id, "customer_id");
    } else {
      throw new TypeError(
        "priceDisplay.clearCustomerOverride: customer_id or { customer_id } required"
      );
    }
    var r = await query(
      "DELETE FROM customer_price_display_overrides WHERE customer_id = ?1",
      [customerId]
    );
    return { cleared: Number(r.rowCount || 0) > 0, customer_id: customerId };
  }

  async function customerOverride(customerId) {
    _customerId(customerId, "customer_id");
    var r = (await query(
      "SELECT * FROM customer_price_display_overrides WHERE customer_id = ?1 LIMIT 1",
      [customerId]
    )).rows[0];
    return _hydrateOverride(r);
  }

  // ---- getModeFor ----------------------------------------------------
  //
  // Resolution precedence:
  //   1. customer-override row (when input.customer_id is supplied AND
  //      a row exists)
  //   2. country rule, when the rule has no customer_status_in filter
  //      OR the request's customer_status is in the filter list
  //   3. null (no rule applies — caller decides the fallback)
  //
  // Archived rules never apply; they're retained for historic-audit
  // reads via `listRules({ include_archived: true })`.

  async function getModeFor(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("priceDisplay.getModeFor: input object required");
    }
    var country = _country(input.country, "country");
    var status  = input.customer_status == null
      ? null
      : _status(input.customer_status, "customer_status");
    var customerId = input.customer_id == null
      ? null
      : _customerId(input.customer_id, "customer_id");

    if (customerId) {
      var ov = await customerOverride(customerId);
      if (ov) {
        return { mode: ov.mode, source: "customer_override" };
      }
    }
    var rule = await getRule(country);
    if (!rule || rule.archived_at != null) {
      return { mode: null, source: null };
    }
    if (rule.customer_status_in == null) {
      return { mode: rule.mode, source: "country_default" };
    }
    if (status && rule.customer_status_in.indexOf(status) !== -1) {
      return { mode: rule.mode, source: "customer_status" };
    }
    return { mode: null, source: null };
  }

  // ---- formatPrice ---------------------------------------------------
  //
  // Resolves the display mode, optionally composes the tax adapter for
  // a `{ net, tax, gross }` breakdown, and renders a locale-aware
  // display label via b.money.format. The amount_minor argument is the
  // catalog's stored value — the primitive interprets it AS the figure
  // matching the resolved mode (i.e. when mode is `tax_included` the
  // stored figure is the gross; when mode is `tax_excluded` it's the
  // net). Operators that store one canonical form and want to render
  // the other compose `convertAndFormat` upstream.

  async function formatPrice(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("priceDisplay.formatPrice: input object required");
    }
    _nonNegInt(input.amount_minor, "amount_minor");
    _currency(input.currency, "currency");
    var country = input.country;
    if (country == null && geolocation && typeof geolocation.resolveCountry === "function") {
      country = await geolocation.resolveCountry(input);
    }
    _country(country, "country");
    var status = input.customer_status == null
      ? null
      : _status(input.customer_status, "customer_status");
    var customerId = input.customer_id == null
      ? null
      : _customerId(input.customer_id, "customer_id");
    var locale = _locale(input.locale);

    var resolved = await getModeFor({
      country:         country,
      customer_status: status,
      customer_id:     customerId,
    });
    var mode = resolved.mode;

    // Locale-aware money rendering — delegate to b.money so the ISO
    // 4217 exponent (JPY 0, USD 2, BHD 3) is correct without local
    // bookkeeping. Mirrors currencyDisplay.format.
    var money = _b().money.fromMinorUnits(BigInt(input.amount_minor), input.currency);
    var displayLabel = money.format(locale);

    var out = {
      display_minor: input.amount_minor,
      display_label: displayLabel,
      mode:          mode,
      source:        resolved.source,
    };

    // No tax adapter wired OR no tax-rate resolvable for this country
    // — return the bare display. The storefront can still render the
    // line; it just lacks the inline net/tax/gross split.
    if (!tax || !mode || mode === "tax_excluded" && taxRates == null) {
      // Fall through — mode could still produce a label below; we
      // only short-circuit the breakdown computation.
    }

    if (tax && mode) {
      var rateBps = await _resolveRateBps(country, taxRates);
      if (rateBps != null) {
        if (mode === "tax_included") {
          var inc = tax.calculateInclusive({
            amount_minor: input.amount_minor,
            rate_bps:     rateBps,
            currency:     input.currency,
          });
          out.tax_breakdown = {
            net:   inc.net_minor,
            tax:   inc.tax_minor,
            gross: inc.gross_minor,
          };
        } else if (mode === "tax_excluded") {
          var exc = tax.calculateExclusive({
            amount_minor: input.amount_minor,
            rate_bps:     rateBps,
            currency:     input.currency,
          });
          out.tax_breakdown = {
            net:   exc.net_minor,
            tax:   exc.tax_minor,
            gross: exc.gross_minor,
          };
        } else /* both */ {
          // `both` renders two labels — the stored amount_minor is
          // treated as the gross by convention so the net + tax pair
          // is derivable without ambiguity. Operators that store net
          // for "both" callers extract the bps from the rule, recompute
          // the gross, and pass the gross in.
          var bo = tax.calculateInclusive({
            amount_minor: input.amount_minor,
            rate_bps:     rateBps,
            currency:     input.currency,
          });
          out.tax_breakdown = {
            net:   bo.net_minor,
            tax:   bo.tax_minor,
            gross: bo.gross_minor,
          };
          // Build a "both" label: "120,00 € incl. — 100,84 € ex."
          var netMoney = _b().money.fromMinorUnits(BigInt(bo.net_minor), input.currency);
          out.display_label = displayLabel + " incl. — " + netMoney.format(locale) + " ex.";
        }
      }
    }
    return out;
  }

  return {
    MODES:                   MODES.slice(),
    defineRule:              defineRule,
    getRule:                 getRule,
    listRules:               listRules,
    updateRule:              updateRule,
    archiveRule:             archiveRule,
    defineCustomerOverride:  defineCustomerOverride,
    clearCustomerOverride:   clearCustomerOverride,
    customerOverride:        customerOverride,
    getModeFor:              getModeFor,
    formatPrice:             formatPrice,
  };
}

module.exports = {
  create: create,
  MODES:  MODES.slice(),
};
