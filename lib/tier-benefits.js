"use strict";
/**
 * @module shop.tierBenefits
 * @title  Tier-benefits primitive — per-loyalty-tier perks (free
 *         shipping, percent off, early access, priority support,
 *         exclusive products, birthday bonuses).
 *
 * @intro
 *   A loyalty tier (bronze / silver / gold / platinum, or whatever
 *   ladder the operator runs) carries persistent perks. The
 *   `loyalty` primitive answers "what tier is this customer on?";
 *   this primitive answers "what does that tier unlock?". The
 *   storefront uses it to render perk badges and gate early-access
 *   drops; checkout uses it to decide whether free-shipping or
 *   percent-off applies before computing totals.
 *
 *   Distinct from `loyaltyRedemption` (which spends points for a
 *   one-shot coupon). Tier benefits cost nothing to "use" and don't
 *   decrement any balance — they're continuous perks the customer
 *   enjoys as long as their lifetime points keep them at the tier.
 *
 *   Composition:
 *     var tb = bShop.tierBenefits.create({ query: q, loyalty: loy });
 *     await tb.defineBenefit({
 *       slug:   "platinum-free-ship",
 *       tier:   "platinum",
 *       kind:   "free_shipping",
 *       value:  { min_order_minor: 5000 },
 *     });
 *     var perks = await tb.benefitsForCustomer(custId);
 *     // [{ slug:"platinum-free-ship", tier:"platinum",
 *     //    kind:"free_shipping", value:{...}, conditions:null }]
 *
 *   Kinds:
 *
 *     - `free_shipping`    — value `{ min_order_minor?: N }`.
 *     - `percent_off`      — value `{ percent: 1-100 }`.
 *     - `early_access`     — value `{ hours: 1-720 }`.
 *     - `priority_support` — value `{ sla_minutes: 1-10080 }`.
 *     - `exclusive_access` — value `{ collection_slug: "vip" }`.
 *     - `birthday_bonus`   — value `{ points?: N }` or
 *                            `{ percent_off?: 1-100 }` (exactly one).
 *
 *   Conditions (optional, on every kind):
 *
 *     - `min_order_minor: N`            — apply only if subtotal >= N.
 *     - `currencies: ["USD",...]`       — restrict by currency.
 *     - `regions: ["US","CA",...]`      — restrict by region code.
 *     - `starts_at: ms, ends_at: ms`    — time-window gate.
 *
 *   `benefitsForTier(tier)` and `benefitsForCustomer(customer_id,
 *   ctx?)` filter the live (non-archived) set against the supplied
 *   context envelope. `benefitsForCustomer` resolves the customer's
 *   tier by calling `loyalty.tierForCustomer(customer_id)` (or
 *   `loyalty.balance(customer_id).tier` when the loyalty handle
 *   doesn't expose `tierForCustomer`).
 *
 *   `recordUsage` writes a usage event; `usageForBenefit` lists
 *   events for one benefit (optionally filtered by customer);
 *   `metricsForBenefit` aggregates count + sum(savings_minor).
 *
 *   Monotonic per-process clock: two writes in the same millisecond
 *   would tie on `occurred_at` and make the "latest row" ambiguous
 *   for ordering reads. `_now` bumps to `prior + 1` on collision so
 *   the `(benefit_slug, occurred_at DESC)` and `(customer_id,
 *   occurred_at DESC)` indexes carry a strict per-process ordering.
 *
 *   Surface:
 *     - defineBenefit({ slug, tier, kind, value, conditions? })
 *     - updateBenefit(slug, patch)
 *     - archiveBenefit(slug)
 *     - listBenefits({ tier?, kind?, include_archived? })
 *     - benefitsForTier(tier, ctx?)
 *     - benefitsForCustomer(customer_id, ctx?)
 *     - recordUsage({ benefit_slug, customer_id, context?,
 *                     savings_minor?, occurred_at? })
 *     - usageForBenefit({ slug, from, to, customer_id?, limit? })
 *     - metricsForBenefit(slug, { from?, to? }?)
 *
 *   Storage:
 *     - tier_benefits, tier_benefit_usages (migration
 *       0141_tier_benefits.sql).
 *
 * @primitive tierBenefits
 * @related    b.uuid.v7, b.guardUuid, shop.loyalty,
 *             shop.loyaltyRedemption, shop.shipping
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// ---- constants ----------------------------------------------------------

var KINDS = Object.freeze([
  "free_shipping",
  "percent_off",
  "early_access",
  "priority_support",
  "exclusive_access",
  "birthday_bonus",
]);

var SLUG_RE      = /^[a-z0-9][a-z0-9_-]{0,79}$/;
var TIER_RE      = /^[a-z0-9][a-z0-9_-]{0,31}$/;
var PRINTABLE_RE = /^[^\x00-\x1f\x7f]*$/;

var MAX_CONTEXT_LEN          = 256;
var MAX_CURRENCY_LEN         = 16;
var MAX_REGION_LEN           = 16;
var MAX_CURRENCIES_PER_GATE  = 32;
var MAX_REGIONS_PER_GATE     = 64;
var MAX_COLLECTION_SLUG_LEN  = 80;

// ---- validators ---------------------------------------------------------

function _slug(s, label) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("tierBenefits: " + label + " must be a non-empty string");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "tierBenefits: " + label + " must match /^[a-z0-9][a-z0-9_-]{0,79}$/"
    );
  }
  return s;
}

function _tier(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("tierBenefits: tier must be a non-empty string");
  }
  var clean = s.toLowerCase();
  if (!TIER_RE.test(clean)) {
    throw new TypeError(
      "tierBenefits: tier must match /^[a-z0-9][a-z0-9_-]{0,31}$/"
    );
  }
  return clean;
}

function _kind(s) {
  if (typeof s !== "string" || KINDS.indexOf(s) === -1) {
    throw new TypeError("tierBenefits: kind must be one of " + KINDS.join(", "));
  }
  return s;
}

function _customerId(s) {
  try { return _b().guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) {
    throw new TypeError("tierBenefits: customer_id — " + (e && e.message || "invalid UUID"));
  }
}

function _context(s) {
  if (s == null) return null;
  if (typeof s !== "string") {
    throw new TypeError("tierBenefits: context must be a string");
  }
  if (!s.length) {
    throw new TypeError("tierBenefits: context must be a non-empty string when provided");
  }
  if (s.length > MAX_CONTEXT_LEN) {
    throw new TypeError("tierBenefits: context must be <= " + MAX_CONTEXT_LEN + " chars");
  }
  if (!PRINTABLE_RE.test(s)) {
    throw new TypeError("tierBenefits: context must not contain control bytes");
  }
  return s;
}

function _epochMs(ts, label) {
  if (typeof ts !== "number" || !Number.isInteger(ts) || ts < 0) {
    throw new TypeError("tierBenefits: " + label + " must be a non-negative integer epoch-ms");
  }
  return ts;
}

function _savingsMinor(n) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("tierBenefits: savings_minor must be a non-negative integer when provided");
  }
  return n;
}

function _positiveIntInRange(n, label, lo, hi) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < lo || n > hi) {
    throw new TypeError(
      "tierBenefits: " + label + " must be an integer in [" + lo + ", " + hi + "]"
    );
  }
  return n;
}

function _nonNegativeInt(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
    throw new TypeError("tierBenefits: " + label + " must be a non-negative integer");
  }
  return n;
}

// ---- value validators (per-kind) ---------------------------------------

function _validateValue(kind, value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("tierBenefits: value must be a plain object for kind " + kind);
  }
  var out = {};
  switch (kind) {
    case "free_shipping":
      if (value.min_order_minor != null) {
        out.min_order_minor = _nonNegativeInt(value.min_order_minor, "value.min_order_minor");
      }
      return out;
    case "percent_off":
      if (value.percent == null) {
        throw new TypeError("tierBenefits: value.percent required for kind percent_off");
      }
      out.percent = _positiveIntInRange(value.percent, "value.percent", 1, 100);
      return out;
    case "early_access":
      if (value.hours == null) {
        throw new TypeError("tierBenefits: value.hours required for kind early_access");
      }
      out.hours = _positiveIntInRange(value.hours, "value.hours", 1, 720);
      return out;
    case "priority_support":
      if (value.sla_minutes == null) {
        throw new TypeError("tierBenefits: value.sla_minutes required for kind priority_support");
      }
      out.sla_minutes = _positiveIntInRange(value.sla_minutes, "value.sla_minutes", 1, 10080);
      return out;
    case "exclusive_access":
      if (typeof value.collection_slug !== "string" || !value.collection_slug.length) {
        throw new TypeError(
          "tierBenefits: value.collection_slug required for kind exclusive_access"
        );
      }
      if (value.collection_slug.length > MAX_COLLECTION_SLUG_LEN) {
        throw new TypeError(
          "tierBenefits: value.collection_slug must be <= " + MAX_COLLECTION_SLUG_LEN + " chars"
        );
      }
      if (!SLUG_RE.test(value.collection_slug)) {
        throw new TypeError(
          "tierBenefits: value.collection_slug must match /^[a-z0-9][a-z0-9_-]{0,79}$/"
        );
      }
      out.collection_slug = value.collection_slug;
      return out;
    case "birthday_bonus": {
      var hasPoints = value.points != null;
      var hasPct    = value.percent_off != null;
      if (hasPoints === hasPct) {
        throw new TypeError(
          "tierBenefits: birthday_bonus value must carry exactly one of points / percent_off"
        );
      }
      if (hasPoints) {
        out.points = _positiveIntInRange(value.points, "value.points", 1, 1000000);
      } else {
        out.percent_off = _positiveIntInRange(value.percent_off, "value.percent_off", 1, 100);
      }
      return out;
    }
    default:
      // Unreachable — kind is validated upstream.
      throw new TypeError("tierBenefits: unknown kind " + kind);
  }
}

// ---- conditions validator ----------------------------------------------

function _validateConditions(conditions) {
  if (conditions == null) return null;
  if (typeof conditions !== "object" || Array.isArray(conditions)) {
    throw new TypeError("tierBenefits: conditions must be a plain object or null");
  }
  var out = {};
  var sawAny = false;
  if (conditions.min_order_minor != null) {
    out.min_order_minor = _nonNegativeInt(conditions.min_order_minor, "conditions.min_order_minor");
    sawAny = true;
  }
  if (conditions.currencies != null) {
    if (!Array.isArray(conditions.currencies) || !conditions.currencies.length) {
      throw new TypeError("tierBenefits: conditions.currencies must be a non-empty array");
    }
    if (conditions.currencies.length > MAX_CURRENCIES_PER_GATE) {
      throw new TypeError(
        "tierBenefits: conditions.currencies length must be <= " + MAX_CURRENCIES_PER_GATE
      );
    }
    var currencies = [];
    for (var i = 0; i < conditions.currencies.length; i += 1) {
      var c = conditions.currencies[i];
      if (typeof c !== "string" || !c.length || c.length > MAX_CURRENCY_LEN || !PRINTABLE_RE.test(c)) {
        throw new TypeError(
          "tierBenefits: conditions.currencies[" + i + "] must be a printable string <= "
          + MAX_CURRENCY_LEN + " chars"
        );
      }
      currencies.push(c);
    }
    out.currencies = currencies;
    sawAny = true;
  }
  if (conditions.regions != null) {
    if (!Array.isArray(conditions.regions) || !conditions.regions.length) {
      throw new TypeError("tierBenefits: conditions.regions must be a non-empty array");
    }
    if (conditions.regions.length > MAX_REGIONS_PER_GATE) {
      throw new TypeError(
        "tierBenefits: conditions.regions length must be <= " + MAX_REGIONS_PER_GATE
      );
    }
    var regions = [];
    for (var j = 0; j < conditions.regions.length; j += 1) {
      var r = conditions.regions[j];
      if (typeof r !== "string" || !r.length || r.length > MAX_REGION_LEN || !PRINTABLE_RE.test(r)) {
        throw new TypeError(
          "tierBenefits: conditions.regions[" + j + "] must be a printable string <= "
          + MAX_REGION_LEN + " chars"
        );
      }
      regions.push(r);
    }
    out.regions = regions;
    sawAny = true;
  }
  if (conditions.starts_at != null || conditions.ends_at != null) {
    if (conditions.starts_at == null || conditions.ends_at == null) {
      throw new TypeError(
        "tierBenefits: conditions.starts_at + conditions.ends_at must be paired"
      );
    }
    var start = _epochMs(conditions.starts_at, "conditions.starts_at");
    var end   = _epochMs(conditions.ends_at, "conditions.ends_at");
    if (end <= start) {
      throw new TypeError("tierBenefits: conditions.ends_at must be > conditions.starts_at");
    }
    out.starts_at = start;
    out.ends_at   = end;
    sawAny = true;
  }
  // Refuse unknown keys so a typo doesn't silently disable a gate.
  var allowed = { min_order_minor: 1, currencies: 1, regions: 1, starts_at: 1, ends_at: 1 };
  var keys = Object.keys(conditions);
  for (var k = 0; k < keys.length; k += 1) {
    if (!Object.prototype.hasOwnProperty.call(allowed, keys[k])) {
      throw new TypeError("tierBenefits: conditions has unknown key " + JSON.stringify(keys[k]));
    }
  }
  return sawAny ? out : null;
}

// ---- context-envelope matcher ------------------------------------------

function _matchConditions(conditions, ctx) {
  if (!conditions) return true;
  if (conditions.min_order_minor != null) {
    var subtotal = ctx && typeof ctx.subtotal_minor === "number" ? ctx.subtotal_minor : 0;
    if (subtotal < conditions.min_order_minor) return false;
  }
  if (conditions.currencies != null) {
    var cur = ctx && ctx.currency;
    if (typeof cur !== "string" || conditions.currencies.indexOf(cur) === -1) return false;
  }
  if (conditions.regions != null) {
    var reg = ctx && ctx.region;
    if (typeof reg !== "string" || conditions.regions.indexOf(reg) === -1) return false;
  }
  if (conditions.starts_at != null && conditions.ends_at != null) {
    var nowTs = ctx && typeof ctx.now === "number" ? ctx.now : Date.now();
    if (nowTs < conditions.starts_at || nowTs >= conditions.ends_at) return false;
  }
  return true;
}

// ---- monotonic clock ---------------------------------------------------
//
// Two writes against the same benefit/customer in the same millisecond
// would tie on `occurred_at` and make the "latest row" ambiguous for
// the `(benefit_slug, occurred_at DESC)` index that drives the usage
// feed. Tests that record + read back in tight loops depend on the
// strict-monotonic ordering — fast platforms collapse Date.now() to
// the same int across an entire batch.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) t = _lastTs + 1;
  _lastTs = t;
  return t;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return _b().externalDb.query(sql, params); };
  }
  var loyalty = opts.loyalty || null;

  async function _readBenefit(slug) {
    var r = await query(
      "SELECT slug, tier, kind, value_json, conditions_json, archived_at, created_at, updated_at "
      + "FROM tier_benefits WHERE slug = ?1 LIMIT 1",
      [slug],
    );
    return r.rows.length ? r.rows[0] : null;
  }

  function _hydrate(row) {
    return {
      slug:        row.slug,
      tier:        row.tier,
      kind:        row.kind,
      value:       JSON.parse(row.value_json),
      conditions:  row.conditions_json == null ? null : JSON.parse(row.conditions_json),
      archived_at: row.archived_at == null ? null : Number(row.archived_at),
      created_at:  Number(row.created_at),
      updated_at:  Number(row.updated_at),
    };
  }

  async function _resolveTier(customerId) {
    if (!loyalty) {
      throw new TypeError(
        "tierBenefits.benefitsForCustomer: loyalty handle not configured "
        + "— pass { loyalty } to create(...)"
      );
    }
    if (typeof loyalty.tierForCustomer === "function") {
      var t = await loyalty.tierForCustomer(customerId);
      if (typeof t !== "string" || !t.length) {
        throw new TypeError(
          "tierBenefits.benefitsForCustomer: loyalty.tierForCustomer returned "
          + JSON.stringify(t) + " — expected a non-empty tier string"
        );
      }
      return _tier(t);
    }
    if (typeof loyalty.balance === "function") {
      var bal = await loyalty.balance(customerId);
      if (!bal || typeof bal.tier !== "string" || !bal.tier.length) {
        throw new TypeError(
          "tierBenefits.benefitsForCustomer: loyalty.balance returned no .tier — "
          + "cannot resolve customer tier"
        );
      }
      return _tier(bal.tier);
    }
    throw new TypeError(
      "tierBenefits.benefitsForCustomer: loyalty handle must expose "
      + ".tierForCustomer(id) or .balance(id)"
    );
  }

  // ---- defineBenefit -----------------------------------------------------

  async function defineBenefit(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("tierBenefits.defineBenefit: input object required");
    }
    var slug       = _slug(input.slug, "slug");
    var tier       = _tier(input.tier);
    var kind       = _kind(input.kind);
    var value      = _validateValue(kind, input.value);
    var conditions = _validateConditions(input.conditions);

    var existing = await _readBenefit(slug);
    if (existing) {
      throw new TypeError(
        "tierBenefits.defineBenefit: slug " + JSON.stringify(slug)
        + " already exists — use updateBenefit"
      );
    }

    var ts = _now();
    await query(
      "INSERT INTO tier_benefits "
      + "(slug, tier, kind, value_json, conditions_json, archived_at, created_at, updated_at) "
      + "VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)",
      [slug, tier, kind, JSON.stringify(value),
        conditions == null ? null : JSON.stringify(conditions), ts],
    );
    var row = await _readBenefit(slug);
    return _hydrate(row);
  }

  // ---- updateBenefit -----------------------------------------------------

  async function updateBenefit(slug, patch) {
    var s = _slug(slug, "slug");
    if (!patch || typeof patch !== "object") {
      throw new TypeError("tierBenefits.updateBenefit: patch object required");
    }
    var row = await _readBenefit(s);
    if (!row) {
      throw new TypeError(
        "tierBenefits.updateBenefit: slug " + JSON.stringify(s) + " not found"
      );
    }
    if (row.archived_at != null) {
      throw new TypeError(
        "tierBenefits.updateBenefit: slug " + JSON.stringify(s)
        + " is archived — restore by writing a new slug"
      );
    }

    var newTier  = row.tier;
    var newKind  = row.kind;
    var newValue = JSON.parse(row.value_json);
    var newCond  = row.conditions_json == null ? null : JSON.parse(row.conditions_json);

    if (patch.tier !== undefined)       newTier  = _tier(patch.tier);
    if (patch.kind !== undefined)       newKind  = _kind(patch.kind);
    // Revalidate value against the (possibly new) kind. When kind changes
    // without a fresh value the operator is wrong about the new value
    // shape — refuse rather than silently re-coerce.
    if (patch.kind !== undefined && patch.value === undefined) {
      throw new TypeError(
        "tierBenefits.updateBenefit: kind change requires a fresh value"
      );
    }
    if (patch.value !== undefined) {
      newValue = _validateValue(newKind, patch.value);
    } else if (patch.kind !== undefined) {
      newValue = _validateValue(newKind, newValue);
    }
    if (patch.conditions !== undefined) {
      newCond = patch.conditions === null ? null : _validateConditions(patch.conditions);
    }

    // Refuse unknown patch keys — typo defense.
    var allowed = { tier: 1, kind: 1, value: 1, conditions: 1 };
    var keys = Object.keys(patch);
    for (var i = 0; i < keys.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(allowed, keys[i])) {
        throw new TypeError(
          "tierBenefits.updateBenefit: unknown patch key " + JSON.stringify(keys[i])
        );
      }
    }

    var ts = _now();
    await query(
      "UPDATE tier_benefits SET tier = ?1, kind = ?2, value_json = ?3, conditions_json = ?4, "
      + "updated_at = ?5 WHERE slug = ?6",
      [newTier, newKind, JSON.stringify(newValue),
        newCond == null ? null : JSON.stringify(newCond), ts, s],
    );
    var after = await _readBenefit(s);
    return _hydrate(after);
  }

  // ---- archiveBenefit ----------------------------------------------------

  async function archiveBenefit(slug) {
    var s = _slug(slug, "slug");
    var row = await _readBenefit(s);
    if (!row) {
      throw new TypeError(
        "tierBenefits.archiveBenefit: slug " + JSON.stringify(s) + " not found"
      );
    }
    if (row.archived_at != null) {
      // Idempotent — return the existing archived row rather than
      // double-stamping `updated_at` on a repeat call.
      return _hydrate(row);
    }
    var ts = _now();
    await query(
      "UPDATE tier_benefits SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
      [ts, s],
    );
    var after = await _readBenefit(s);
    return _hydrate(after);
  }

  // ---- listBenefits ------------------------------------------------------

  async function listBenefits(filters) {
    filters = filters || {};
    var clauses = [];
    var params  = [];
    var idx     = 1;
    if (filters.tier != null) {
      var t = _tier(filters.tier);
      clauses.push("tier = ?" + idx); params.push(t); idx += 1;
    }
    if (filters.kind != null) {
      var k = _kind(filters.kind);
      clauses.push("kind = ?" + idx); params.push(k); idx += 1;
    }
    if (!filters.include_archived) {
      clauses.push("archived_at IS NULL");
    }
    var sql = "SELECT slug, tier, kind, value_json, conditions_json, archived_at, "
            + "created_at, updated_at FROM tier_benefits";
    if (clauses.length) sql += " WHERE " + clauses.join(" AND ");
    sql += " ORDER BY tier ASC, slug ASC";
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrate(r.rows[i]));
    return out;
  }

  // ---- benefitsForTier ---------------------------------------------------

  async function benefitsForTier(tier, ctx) {
    var t = _tier(tier);
    var r = await query(
      "SELECT slug, tier, kind, value_json, conditions_json, archived_at, "
      + "created_at, updated_at FROM tier_benefits "
      + "WHERE tier = ?1 AND archived_at IS NULL ORDER BY slug ASC",
      [t],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = _hydrate(r.rows[i]);
      if (_matchConditions(row.conditions, ctx || null)) out.push(row);
    }
    return out;
  }

  // ---- benefitsForCustomer ----------------------------------------------

  async function benefitsForCustomer(customerId, ctx) {
    _customerId(customerId);
    var tier = await _resolveTier(customerId);
    return await benefitsForTier(tier, ctx);
  }

  // ---- recordUsage -------------------------------------------------------

  async function recordUsage(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("tierBenefits.recordUsage: input object required");
    }
    var slug       = _slug(input.benefit_slug, "benefit_slug");
    var customerId = _customerId(input.customer_id);
    var context    = _context(input.context == null ? null : input.context);
    var savings    = _savingsMinor(input.savings_minor);
    var occurredAt = input.occurred_at != null
      ? _epochMs(input.occurred_at, "occurred_at")
      : _now();

    var row = await _readBenefit(slug);
    if (!row) {
      throw new TypeError(
        "tierBenefits.recordUsage: benefit_slug " + JSON.stringify(slug) + " not found"
      );
    }
    if (row.archived_at != null) {
      throw new TypeError(
        "tierBenefits.recordUsage: benefit_slug " + JSON.stringify(slug)
        + " is archived — usage refused"
      );
    }

    var id = _b().uuid.v7();
    await query(
      "INSERT INTO tier_benefit_usages "
      + "(id, benefit_slug, customer_id, context, savings_minor, occurred_at) "
      + "VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
      [id, slug, customerId, context, savings, occurredAt],
    );
    return {
      id:              id,
      benefit_slug:    slug,
      customer_id:     customerId,
      context:         context,
      savings_minor:   savings,
      occurred_at:     occurredAt,
    };
  }

  // ---- usageForBenefit --------------------------------------------------

  async function usageForBenefit(filters) {
    if (!filters || typeof filters !== "object") {
      throw new TypeError("tierBenefits.usageForBenefit: filters object required");
    }
    var slug = _slug(filters.slug, "slug");
    var from = _epochMs(filters.from, "from");
    var to   = _epochMs(filters.to, "to");
    if (to < from) {
      throw new TypeError("tierBenefits.usageForBenefit: to must be >= from");
    }
    var limit = filters.limit != null ? filters.limit : 500;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 5000) {
      throw new TypeError("tierBenefits.usageForBenefit: limit must be an integer in [1, 5000]");
    }
    var sql = "SELECT id, benefit_slug, customer_id, context, savings_minor, occurred_at "
            + "FROM tier_benefit_usages "
            + "WHERE benefit_slug = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3";
    var params = [slug, from, to];
    if (filters.customer_id != null) {
      var cid = _customerId(filters.customer_id);
      sql += " AND customer_id = ?" + (params.length + 1);
      params.push(cid);
    }
    sql += " ORDER BY occurred_at DESC LIMIT ?" + (params.length + 1);
    params.push(limit);
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      var row = r.rows[i];
      out.push({
        id:             row.id,
        benefit_slug:   row.benefit_slug,
        customer_id:    row.customer_id,
        context:        row.context == null ? null : row.context,
        savings_minor:  row.savings_minor == null ? null : Number(row.savings_minor),
        occurred_at:    Number(row.occurred_at),
      });
    }
    return out;
  }

  // ---- metricsForBenefit ------------------------------------------------

  async function metricsForBenefit(slug, window) {
    var s = _slug(slug, "slug");
    window = window || {};
    var fromMs = window.from != null ? _epochMs(window.from, "from") : 0;
    var toMs   = window.to   != null ? _epochMs(window.to, "to")   : Number.MAX_SAFE_INTEGER;
    if (toMs < fromMs) {
      throw new TypeError("tierBenefits.metricsForBenefit: to must be >= from");
    }
    var r = await query(
      "SELECT COUNT(*) AS count_all, "
      + "COUNT(savings_minor) AS count_with_savings, "
      + "COALESCE(SUM(savings_minor), 0) AS sum_savings "
      + "FROM tier_benefit_usages "
      + "WHERE benefit_slug = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3",
      [s, fromMs, toMs],
    );
    var row = r.rows[0] || { count_all: 0, count_with_savings: 0, sum_savings: 0 };
    return {
      slug:               s,
      count:              Number(row.count_all),
      count_with_savings: Number(row.count_with_savings),
      sum_savings_minor:  Number(row.sum_savings),
      from:               fromMs,
      to:                 toMs === Number.MAX_SAFE_INTEGER ? null : toMs,
    };
  }

  return {
    KINDS:               KINDS.slice(),
    SLUG_RE:             SLUG_RE,

    defineBenefit:       defineBenefit,
    updateBenefit:       updateBenefit,
    archiveBenefit:      archiveBenefit,
    listBenefits:        listBenefits,
    benefitsForTier:     benefitsForTier,
    benefitsForCustomer: benefitsForCustomer,
    recordUsage:         recordUsage,
    usageForBenefit:     usageForBenefit,
    metricsForBenefit:   metricsForBenefit,
  };
}

module.exports = {
  create: create,
  KINDS:  KINDS,
};
