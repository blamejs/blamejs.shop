"use strict";
/**
 * @module shop.currencyRounding
 * @title  Per-currency display rounding rules applied at checkout total
 *
 * @intro
 *   Switzerland retired the one- and two-rappen coins; CHF retail
 *   totals round to the nearest 0.05 ("Rappenrundung"). Sweden
 *   retired the öre coins; SEK totals round to the nearest 0.10. JPY
 *   has no minor unit at all (ISO 4217 exponent 0) — every total is
 *   already a whole yen, but operators selling JPY cross-border
 *   sometimes want a 100-yen rounding step for psychological pricing.
 *
 *   This primitive owns the *rounding* leg of multi-currency
 *   storefronts. Distinct from `currencyDisplay` (migration 0044),
 *   which caches FX rates and converts amounts between ISO 4217
 *   codes. FX answers "how much EUR is one USD"; rounding answers
 *   "what increment do I snap a final total to before I show it to
 *   the customer." A real Swiss checkout typically needs both — the
 *   storefront converts the catalog's USD price to CHF, then rounds
 *   the CHF total to the nearest 0.05 before display.
 *
 *   Rules are keyed by ISO 4217 currency code. Each rule names:
 *
 *     - `increment_minor` — the smallest unit step in the currency's
 *       OWN minor units. CHF nearest-0.05 → 5 (5 rappen). SEK
 *       nearest-0.10 → 10. JPY 100-yen step → 100. The identity rule
 *       (no rounding) is `increment_minor: 1`.
 *
 *     - `mode` — one of `half_up` / `half_even` / `half_down` /
 *       `ceiling` / `floor`. Most retail laws prescribe `half_up`
 *       (CHF Rappenrundung is half-up to the nearest 5 rappen).
 *       `half_even` is the "banker's rounding" default that matches
 *       the framework's `b.money` conversion path; available for
 *       operators who want both stages on the same convention.
 *
 *     - `applies_to` — one of `display_only` / `cart_total` /
 *       `line_total` / `all`. The `display_only` mode leaves the
 *       persisted order totals unrounded (so downstream FX / refund
 *       / tax math stays exact), and only the rendered figure carries
 *       the rounding. The other modes commit the rounding into the
 *       cart total, the per-line totals, or every monetary figure
 *       the rendering layer pulls.
 *
 *   Surface:
 *     - `defineRule({ currency, increment_minor, mode, applies_to })`
 *     - `getRule(currency)` / `listRules({ active_only? })`
 *     - `roundFor({ amount_minor, currency, kind })` →
 *         `{ original_minor, rounded_minor, adjustment_minor }`
 *       The `kind` argument names the call-site context
 *       (`display_only` / `cart_total` / `line_total` / `all`); the
 *       rule applies only when its `applies_to` matches the requested
 *       `kind` or is `all`. Mis-matched calls return the original
 *       amount untouched (adjustment 0) — operators can wire the
 *       function in at every render site without re-checking the
 *       active rule's scope.
 *     - `updateRule(currency, patch)` / `archiveRule(currency)`
 *     - `historyForCurrency({ currency, from?, to?, limit? })`
 *
 *   Composition:
 *     var rounding = bShop.currencyRounding.create({ query: q });
 *     await rounding.defineRule({
 *       currency:        "CHF",
 *       increment_minor: 5,
 *       mode:            "half_up",
 *       applies_to:      "cart_total",
 *     });
 *     var out = rounding.roundFor({
 *       amount_minor: 1287,   // CHF 12.87
 *       currency:     "CHF",
 *       kind:         "cart_total",
 *     });
 *     // { original_minor: 1287, rounded_minor: 1285, adjustment_minor: -2 }
 *
 *   Storage:
 *     - currency_rounding_rules + currency_rounding_log
 *       (migration 0132).
 *
 * @primitive currencyRounding
 * @related   shop.currencyDisplay, shop.pricing, b.money
 */

var b = require("./vendor/blamejs");

// ---- constants ----------------------------------------------------------

var MODES       = ["half_up", "half_even", "half_down", "ceiling", "floor"];
var APPLIES_TO  = ["display_only", "cart_total", "line_total", "all"];
var MAX_LIST_LIMIT = 500;

// ---- validators ---------------------------------------------------------

// Compose b.money's ISO 4217 catalog so the validator stays in sync
// with the framework's currency surface. A code the catalog refuses
// here would never round-trip through `b.money.fromMinorUnits`
// downstream either; throwing at the rule-define step surfaces the
// typo at config-time rather than at the first checkout that touches
// the bad code.
function _currency(code) {
  if (typeof code !== "string" || !/^[A-Z]{3}$/.test(code)) {
    throw new TypeError(
      "currencyRounding: currency must be a 3-letter uppercase ISO 4217 code, got " +
      JSON.stringify(code)
    );
  }
  var catalog = b.money.CURRENCIES;
  if (!Object.prototype.hasOwnProperty.call(catalog, code)) {
    throw new TypeError(
      "currencyRounding: currency " + JSON.stringify(code) +
      " is not in the ISO 4217 catalog"
    );
  }
  return code;
}

function _incrementMinor(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError(
      "currencyRounding: increment_minor must be a positive integer, got " +
      JSON.stringify(n)
    );
  }
  return n;
}

function _mode(m) {
  if (typeof m !== "string" || MODES.indexOf(m) === -1) {
    throw new TypeError(
      "currencyRounding: mode must be one of " + MODES.join(", ") + ", got " +
      JSON.stringify(m)
    );
  }
  return m;
}

function _appliesTo(a) {
  if (typeof a !== "string" || APPLIES_TO.indexOf(a) === -1) {
    throw new TypeError(
      "currencyRounding: applies_to must be one of " + APPLIES_TO.join(", ") +
      ", got " + JSON.stringify(a)
    );
  }
  return a;
}

function _amountMinor(n, label) {
  // amount_minor accepts zero and positive integers. A negative
  // amount (refund preview, adjustment) is uncommon at the rounding
  // step but not refused — operators occasionally preview rounding
  // for a credit memo before it lands.
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new TypeError(
      "currencyRounding: " + label + " must be an integer (minor units), got " +
      JSON.stringify(n)
    );
  }
  return n;
}

function _epochMs(ts, label) {
  if (ts == null) return null;
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError(
      "currencyRounding: " + label + " must be a non-negative integer epoch-ms, got " +
      JSON.stringify(ts)
    );
  }
  return ts;
}

function _limit(n, label) {
  if (n == null) return 100;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_LIST_LIMIT) {
    throw new TypeError(
      "currencyRounding: " + label + " must be an integer in [1, " + MAX_LIST_LIMIT + "]"
    );
  }
  return n;
}

// ---- rounding math ------------------------------------------------------

// Round `amount` (an integer in minor units, possibly negative) to
// the nearest multiple of `step` (positive integer) under the
// requested mode. Pure integer math — no float intermediates, no
// precision loss for any amount the storage layer can carry.
function _round(amount, step, mode) {
  if (step === 1) return amount;
  // Decompose into (quotient, remainder) with remainder always
  // non-negative in [0, step). JavaScript `%` mirrors the sign of
  // the dividend, which produces an off-by-one for negatives at the
  // tie boundary — normalise explicitly.
  var quot = Math.trunc(amount / step);
  var rem  = amount - quot * step;
  if (rem < 0) { quot -= 1; rem += step; }
  // `lower` is the largest multiple of step <= amount.
  var lower = quot * step;
  var upper = lower + step;
  if (rem === 0) return amount;

  if (mode === "floor")   return lower;
  if (mode === "ceiling") return upper;

  // Compare to the half-step. Use integer doubling to avoid a
  // fractional comparison: rem*2 vs step.
  var doubled = rem * 2;
  if (doubled < step) {
    // Below the half — every half-mode collapses to round-toward-lower.
    return lower;
  }
  if (doubled > step) {
    // Above the half — every half-mode collapses to round-toward-upper.
    return upper;
  }
  // Exactly on the half-step.
  if (mode === "half_up")   return amount >= 0 ? upper : lower;
  if (mode === "half_down") return amount >= 0 ? lower : upper;
  // half_even — pick whichever multiple is even.
  var lowerMultiple = quot;                       // lower / step
  if (lowerMultiple % 2 === 0) return lower;
  return upper;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }
  if (typeof query !== "function") {
    throw new TypeError("currencyRounding.create: query must be a function");
  }

  // Last-issued timestamp seen on a rule write, per currency. The
  // primitive guarantees a strictly-monotonic per-currency
  // updated_at sequence so a tied-millisecond update doesn't lose
  // ordering against the prior write. Same shape as the gift-card
  // ledger + store-credit ledger _resolveOccurredAt clamp.
  var lastTs = Object.create(null);

  function _now() { return Date.now(); }

  function _clamp(currency, requested) {
    var prior = lastTs[currency];
    var t = requested;
    if (prior != null && t <= prior) t = prior + 1;
    lastTs[currency] = t;
    return t;
  }

  async function _readByCurrency(currency) {
    var r = await query(
      "SELECT currency, increment_minor, mode, applies_to, active, " +
      "archived_at, created_at, updated_at " +
      "FROM currency_rounding_rules WHERE currency = ?1 LIMIT 1",
      [currency]
    );
    return r.rows[0] || null;
  }

  function _shapeRow(row) {
    if (!row) return null;
    return {
      currency:        row.currency,
      increment_minor: Number(row.increment_minor),
      mode:            row.mode,
      applies_to:      row.applies_to,
      active:          Number(row.active) === 1,
      archived_at:     row.archived_at == null ? null : Number(row.archived_at),
      created_at:      Number(row.created_at),
      updated_at:      Number(row.updated_at),
    };
  }

  async function defineRule(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyRounding.defineRule: input object required");
    }
    var currency  = _currency(input.currency);
    var increment = _incrementMinor(input.increment_minor);
    var mode      = _mode(input.mode);
    var appliesTo = _appliesTo(input.applies_to);

    var existing = await _readByCurrency(currency);
    if (existing && Number(existing.active) === 1) {
      throw new TypeError(
        "currencyRounding.defineRule: a rule for " + currency +
        " is already active; update or archive it first"
      );
    }
    var ts = _clamp(currency, _now());
    if (existing) {
      // A previously-archived rule for this currency exists. Refresh
      // it in place — the primary key is the currency code, so re-
      // defining is the operator's way of saying "re-activate with
      // these new parameters."
      await query(
        "UPDATE currency_rounding_rules SET increment_minor = ?1, mode = ?2, " +
        "applies_to = ?3, active = 1, archived_at = NULL, updated_at = ?4 " +
        "WHERE currency = ?5",
        [increment, mode, appliesTo, ts, currency]
      );
    } else {
      await query(
        "INSERT INTO currency_rounding_rules " +
        "(currency, increment_minor, mode, applies_to, active, archived_at, created_at, updated_at) " +
        "VALUES (?1, ?2, ?3, ?4, 1, NULL, ?5, ?6)",
        [currency, increment, mode, appliesTo, ts, ts]
      );
    }
    return _shapeRow(await _readByCurrency(currency));
  }

  async function getRule(currency) {
    var c = _currency(currency);
    return _shapeRow(await _readByCurrency(c));
  }

  async function listRules(input) {
    input = input || {};
    var activeOnly = input.active_only == null ? false : input.active_only;
    if (typeof activeOnly !== "boolean") {
      throw new TypeError("currencyRounding.listRules: active_only must be a boolean");
    }
    var limit = _limit(input.limit, "limit");
    var sql = "SELECT currency, increment_minor, mode, applies_to, active, " +
              "archived_at, created_at, updated_at FROM currency_rounding_rules";
    var params = [];
    if (activeOnly) {
      sql += " WHERE active = 1";
    }
    sql += " ORDER BY currency ASC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_shapeRow(r.rows[i]));
    return out;
  }

  async function updateRule(currency, patch) {
    var c = _currency(currency);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("currencyRounding.updateRule: patch object required");
    }
    var existing = await _readByCurrency(c);
    if (!existing) {
      throw new TypeError(
        "currencyRounding.updateRule: no rule exists for " + c
      );
    }
    if (Number(existing.active) !== 1) {
      throw new TypeError(
        "currencyRounding.updateRule: rule for " + c +
        " is archived; re-define it instead"
      );
    }
    var fields = [];
    var params = [];
    var idx = 1;
    if (Object.prototype.hasOwnProperty.call(patch, "increment_minor")) {
      fields.push("increment_minor = ?" + idx); idx += 1;
      params.push(_incrementMinor(patch.increment_minor));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "mode")) {
      fields.push("mode = ?" + idx); idx += 1;
      params.push(_mode(patch.mode));
    }
    if (Object.prototype.hasOwnProperty.call(patch, "applies_to")) {
      fields.push("applies_to = ?" + idx); idx += 1;
      params.push(_appliesTo(patch.applies_to));
    }
    if (fields.length === 0) {
      throw new TypeError(
        "currencyRounding.updateRule: patch must set at least one of " +
        "increment_minor / mode / applies_to"
      );
    }
    var ts = _clamp(c, _now());
    fields.push("updated_at = ?" + idx); idx += 1;
    params.push(ts);
    params.push(c);
    await query(
      "UPDATE currency_rounding_rules SET " + fields.join(", ") +
      " WHERE currency = ?" + idx,
      params
    );
    return _shapeRow(await _readByCurrency(c));
  }

  async function archiveRule(currency) {
    var c = _currency(currency);
    var existing = await _readByCurrency(c);
    if (!existing) {
      throw new TypeError(
        "currencyRounding.archiveRule: no rule exists for " + c
      );
    }
    if (Number(existing.active) !== 1) {
      // Idempotent: an already-archived rule re-archives as a no-op.
      return _shapeRow(existing);
    }
    var ts = _clamp(c, _now());
    await query(
      "UPDATE currency_rounding_rules SET active = 0, archived_at = ?1, " +
      "updated_at = ?2 WHERE currency = ?3",
      [ts, ts, c]
    );
    return _shapeRow(await _readByCurrency(c));
  }

  async function roundFor(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyRounding.roundFor: input object required");
    }
    var amount   = _amountMinor(input.amount_minor, "amount_minor");
    var currency = _currency(input.currency);
    var kind     = _appliesTo(input.kind);

    var row = await _readByCurrency(currency);
    if (!row || Number(row.active) !== 1) {
      // No active rule — pass through with adjustment zero. The
      // call-site can wire `roundFor` in at every render point
      // without re-checking the rule registry first.
      return {
        original_minor:   amount,
        rounded_minor:    amount,
        adjustment_minor: 0,
      };
    }
    var appliesTo = row.applies_to;
    if (appliesTo !== "all" && appliesTo !== kind) {
      // Active rule does not cover this call site — pass through.
      return {
        original_minor:   amount,
        rounded_minor:    amount,
        adjustment_minor: 0,
      };
    }
    var step    = Number(row.increment_minor);
    var mode    = row.mode;
    var rounded = _round(amount, step, mode);
    var adjust  = rounded - amount;

    // Audit-log the applied rounding. Drop-silent on a write failure
    // would lose the operator's reconciliation trail; let the error
    // bubble — the caller decides whether checkout still proceeds.
    var id = b.uuid.v7();
    var ts = _clamp(currency, _now());
    await query(
      "INSERT INTO currency_rounding_log " +
      "(id, currency, original_minor, rounded_minor, adjustment_minor, kind, occurred_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      [id, currency, amount, rounded, adjust, kind, ts]
    );
    return {
      original_minor:   amount,
      rounded_minor:    rounded,
      adjustment_minor: adjust,
    };
  }

  async function historyForCurrency(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("currencyRounding.historyForCurrency: input object required");
    }
    var currency = _currency(input.currency);
    var from     = _epochMs(input.from, "from");
    var to       = _epochMs(input.to,   "to");
    var limit    = _limit(input.limit, "limit");

    var sql = "SELECT id, currency, original_minor, rounded_minor, adjustment_minor, " +
              "kind, occurred_at FROM currency_rounding_log WHERE currency = ?1";
    var params = [currency];
    if (from != null) {
      sql += " AND occurred_at >= ?" + (params.length + 1);
      params.push(from);
    }
    if (to != null) {
      sql += " AND occurred_at <= ?" + (params.length + 1);
      params.push(to);
    }
    sql += " ORDER BY occurred_at DESC, id DESC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var r = await query(sql, params);
    var rows = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      rows.push({
        id:               row.id,
        currency:         row.currency,
        original_minor:   Number(row.original_minor),
        rounded_minor:    Number(row.rounded_minor),
        adjustment_minor: Number(row.adjustment_minor),
        kind:             row.kind,
        occurred_at:      Number(row.occurred_at),
      });
    }
    return rows;
  }

  return {
    MODES:               MODES.slice(),
    APPLIES_TO:          APPLIES_TO.slice(),
    defineRule:          defineRule,
    getRule:             getRule,
    listRules:           listRules,
    roundFor:            roundFor,
    updateRule:          updateRule,
    archiveRule:         archiveRule,
    historyForCurrency:  historyForCurrency,
  };
}

module.exports = {
  create:      create,
  MODES:       MODES,
  APPLIES_TO:  APPLIES_TO,
  round:       _round,   // pure rounding math exposed for direct composition
};
