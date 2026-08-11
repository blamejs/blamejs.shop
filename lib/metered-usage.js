"use strict";
/**
 * @module shop.meteredUsage
 * @title  Metered usage — usage-based pricing companion to
 *         `subscriptions` + `subscriptionBilling`.
 *
 * @intro
 *   Subscriptions where some portion of the bill scales with
 *   measured consumption (per-API-call, per-GB-transferred, per-
 *   seat-hour) need three things the flat-rate billing primitive
 *   doesn't model:
 *
 *     1. A catalog row defining the meter's unit, pricing schedule,
 *        and per-period free allowance.
 *     2. An append-only event ledger that absorbs raw usage signals
 *        idempotently (instrumentation libraries retry on network
 *        errors; webhook deliveries replay).
 *     3. A period-close roll-up that turns raw events into a
 *        billable line item the recurring-billing primitive can
 *        invoice against.
 *
 *   This primitive owns all three. Storage lives in the two tables
 *   shipped by migration 0095 (`meters` + `meter_events`). The
 *   roll-up math runs in-process — no aggregate table — so a meter
 *   schedule change between periods retroactively applies only
 *   when the caller re-queries; written history isn't mutated.
 *
 *   Composition:
 *     var meter = bShop.meteredUsage.create({
 *       query:               q,
 *       subscriptions:       subs.subscriptions,   // optional handle —
 *                                                  //   validates subscription_id
 *                                                  //   at recordUsage when wired.
 *       subscriptionBilling: bill,                 // optional — wired to
 *                                                  //   recordPeriodInvoice for
 *                                                  //   period-close.
 *     });
 *     await meter.defineMeter({
 *       slug: "api_calls", title: "API calls", unit: "call",
 *       tier_price_minor: 1, included_units_per_period: 1000,
 *       currency: "USD",
 *     });
 *     await meter.recordUsage({
 *       subscription_id, meter_slug: "api_calls", quantity: 50,
 *       idempotency_key: "req_abc",
 *     });
 *     var summary = await meter.usageForPeriod({
 *       subscription_id, meter_slug: "api_calls",
 *       period_start, period_end,
 *     });
 *
 *   Pricing shapes:
 *
 *     * Flat-rate: `tier_price_minor` set, `tier_schedule` omitted.
 *       Every billable unit costs `tier_price_minor` minor units.
 *
 *     * Tiered: `tier_schedule` is a JSON array of
 *       `[{ up_to, price_minor }, …]` rows ordered ascending.
 *       `up_to: null` is the open-ended tail tier. Quantities walk
 *       the tiers in order — first N units at tier 0's rate, next M
 *       at tier 1's, etc. The two shapes are mutually exclusive at
 *       define time; the schema enforces the XOR.
 *
 *   `included_units_per_period` is subtracted from total_units
 *   before the tier walk. A meter with 1000 included units and a
 *   200-unit period total bills zero billable units; a 1500-unit
 *   period total bills 500 billable units at the configured tier
 *   rate(s).
 *
 *   `idempotency_key` on `recordUsage` is the operator's dedup
 *   contract — instrumentation libraries retry under network
 *   error; webhook deliveries replay. When a key is reused the
 *   surface returns the existing row instead of inserting a
 *   duplicate. NULL keys are accepted (the SQLite partial-unique
 *   index leaves them un-collapsed) for callers that don't track
 *   keys.
 *
 *   `recordPeriodInvoice` requires the `subscriptionBilling` handle
 *   injected at factory time. It rolls up every meter for the
 *   subscription across [period_start, period_end] and enqueues
 *   one invoice line per currency the meters charge in (a single
 *   subscription with USD-priced api_calls + EUR-priced storage
 *   produces two invoice rows). The surface returns the list of
 *   `subscriptionBilling.recordInvoice` results so the caller can
 *   thread them through to a payment-attempt run on the same
 *   tick.
 *
 * @primitive meteredUsage
 * @related   shop.subscriptions, shop.subscriptionBilling
 */

var b = require("./vendor/blamejs");
var textGuard = require("./text-guard");

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN     = 80;
var MAX_TITLE_LEN    = 200;
var MAX_UNIT_LEN     = 64;
var MAX_IDEM_KEY_LEN = 200;
var MAX_TIER_COUNT   = 50;
var MAX_QUANTITY     = 9007199254740991;          // Number.MAX_SAFE_INTEGER
var MAX_INCLUDED     = 9007199254740991;
var MAX_PRICE_MINOR  = 100000000;                 // 1e8 — same ceiling as loyalty
var MAX_LIST_LIMIT   = 500;
var DEFAULT_LIST_LIMIT = 100;

// Slug shape matches the loyalty-redemption / catalog convention.
var SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

// Control-byte refusal posture inherited from the sibling billing
// primitives — operator-authored copy (title, unit) ends up on
// receipt emails + the operator dashboard, so the same "no direction-
// override / no invisible glyph" floor applies.

var ALLOWED_PATCH_COLUMNS = Object.freeze([
  "title",
  "unit",
  "tier_price_minor",
  "tier_schedule",
  "included_units_per_period",
  "currency",
]);

// ---- validators ---------------------------------------------------------

function _uuid(s, label) {
  try { return b.guardUuid.sanitize(s, { profile: "strict" }); }
  catch (e) { throw new TypeError("meteredUsage: " + label + " — " + (e && e.message || "invalid UUID")); }
}

function _slug(s) {
  if (typeof s !== "string" || !SLUG_RE.test(s)) {
    throw new TypeError("meteredUsage: slug must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ (<= " + MAX_SLUG_LEN + " chars)");
  }
  return s;
}

function _shortText(s, label, max) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("meteredUsage: " + label + " must be a non-empty string");
  }
  if (s.length > max) {
    throw new TypeError("meteredUsage: " + label + " must be <= " + max + " characters");
  }
  if (textGuard.hasCodepointThreat(s, { zeroWidth: "reject" })) {
    throw new TypeError("meteredUsage: " + label + " contains control / zero-width bytes");
  }
  return s;
}

function _currency(c) {
  if (typeof c !== "string" || !/^[A-Z]{3}$/.test(c)) {
    throw new TypeError("meteredUsage: currency must be 3-letter uppercase ISO 4217");
  }
  return c;
}

function _quantity(n) {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_QUANTITY) {
    throw new TypeError("meteredUsage: quantity must be a non-negative integer (<= Number.MAX_SAFE_INTEGER)");
  }
  return n;
}

function _includedUnits(n) {
  if (n == null) return 0;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_INCLUDED) {
    throw new TypeError("meteredUsage: included_units_per_period must be a non-negative integer");
  }
  return n;
}

function _epochMs(n, label) {
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("meteredUsage: " + label + " must be a positive integer (epoch ms)");
  }
  return n;
}

function _optEpochMs(n, label) {
  if (n == null) return null;
  return _epochMs(n, label);
}

function _tierPriceMinor(n) {
  if (n == null) return null;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_PRICE_MINOR) {
    throw new TypeError("meteredUsage: tier_price_minor must be a non-negative integer <= " + MAX_PRICE_MINOR);
  }
  return n;
}

// Validate the tier schedule shape — array of
// `{ up_to: integer | null, price_minor: integer }` rows, ascending
// by `up_to`, with exactly one open tail (`up_to: null`) at the end.
// Refuses an empty schedule, an out-of-order tier list, a duplicate
// `up_to` bound, or a schedule whose tail isn't open. A schedule with
// only one open tier is allowed (it degenerates to flat-rate pricing
// expressed as a single tier — same math, separate storage shape).
function _tierSchedule(arr) {
  if (arr == null) return null;
  if (!Array.isArray(arr)) {
    throw new TypeError("meteredUsage: tier_schedule must be an array of { up_to, price_minor } rows");
  }
  if (arr.length === 0 || arr.length > MAX_TIER_COUNT) {
    throw new TypeError("meteredUsage: tier_schedule must be 1.." + MAX_TIER_COUNT + " rows");
  }
  var prevUpTo = 0;
  for (var i = 0; i < arr.length; i += 1) {
    var row = arr[i];
    if (row == null || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError("meteredUsage: tier_schedule[" + i + "] must be a plain object");
    }
    var isTail = i === arr.length - 1;
    if (isTail) {
      if (row.up_to !== null && row.up_to !== undefined) {
        throw new TypeError("meteredUsage: tier_schedule tail tier must use `up_to: null` (open-ended)");
      }
    } else {
      if (typeof row.up_to !== "number" || !Number.isInteger(row.up_to) || row.up_to <= prevUpTo) {
        throw new TypeError(
          "meteredUsage: tier_schedule[" + i + "].up_to must be an integer > previous tier's up_to (" + prevUpTo + ")"
        );
      }
      prevUpTo = row.up_to;
    }
    if (typeof row.price_minor !== "number" || !Number.isInteger(row.price_minor) || row.price_minor < 0 || row.price_minor > MAX_PRICE_MINOR) {
      throw new TypeError("meteredUsage: tier_schedule[" + i + "].price_minor must be a non-negative integer <= " + MAX_PRICE_MINOR);
    }
  }
  // Normalize the tail row's `up_to` to explicit null so the stored
  // JSON is canonical regardless of whether the caller used null or
  // omitted the key entirely.
  var normalized = [];
  for (var j = 0; j < arr.length; j += 1) {
    normalized.push({
      up_to:       j === arr.length - 1 ? null : arr[j].up_to,
      price_minor: arr[j].price_minor,
    });
  }
  return normalized;
}

function _idempotencyKey(s) {
  if (s == null) return null;
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("meteredUsage: idempotency_key must be a non-empty string when provided");
  }
  if (s.length > MAX_IDEM_KEY_LEN) {
    throw new TypeError("meteredUsage: idempotency_key must be <= " + MAX_IDEM_KEY_LEN + " characters");
  }
  textGuard.freeText(s, "meteredUsage: idempotency_key");
  return s;
}

function _limit(n) {
  if (n == null) return DEFAULT_LIST_LIMIT;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("meteredUsage: limit must be a positive integer");
  }
  if (n > MAX_LIST_LIMIT) {
    throw new TypeError("meteredUsage: limit must be <= " + MAX_LIST_LIMIT);
  }
  return n;
}

function _now() { return Date.now(); }

// ---- row hydration ------------------------------------------------------

function _safeParseTierSchedule(s) {
  if (s == null) return null;
  try {
    var parsed = JSON.parse(s);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_e) {
    return null;
  }
}

function _hydrateMeter(r) {
  if (!r) return null;
  return {
    slug:                      r.slug,
    title:                     r.title,
    unit:                      r.unit,
    tier_price_minor:          r.tier_price_minor == null ? null : Number(r.tier_price_minor),
    tier_schedule:             _safeParseTierSchedule(r.tier_schedule_json),
    included_units_per_period: Number(r.included_units_per_period),
    currency:                  r.currency,
    archived_at:               r.archived_at == null ? null : Number(r.archived_at),
    created_at:                Number(r.created_at),
    updated_at:                Number(r.updated_at),
  };
}

function _hydrateEvent(r) {
  if (!r) return null;
  return {
    id:              r.id,
    subscription_id: r.subscription_id,
    meter_slug:      r.meter_slug,
    quantity:        Number(r.quantity),
    idempotency_key: r.idempotency_key == null ? null : r.idempotency_key,
    occurred_at:     Number(r.occurred_at),
    period_start:    r.period_start == null ? null : Number(r.period_start),
    period_end:      r.period_end == null ? null : Number(r.period_end),
    created_at:      Number(r.created_at),
  };
}

// ---- billing math -------------------------------------------------------

// Walk the meter's pricing schedule against `billableUnits` and
// return the charge in minor units. `billableUnits` is the already-
// included-floor-applied unit count (i.e. total_units - included,
// clamped at zero). Flat-rate meters short-circuit to
// `billableUnits * tier_price_minor`. Tiered meters walk the
// schedule from tier 0 upward, consuming up to `up_to` units per
// tier at that tier's rate, until `billableUnits` is exhausted (the
// tail tier — `up_to: null` — absorbs whatever remains).
function _chargeFor(meter, billableUnits) {
  if (billableUnits <= 0) return 0;
  if (meter.tier_price_minor != null) {
    return billableUnits * meter.tier_price_minor;
  }
  var schedule = meter.tier_schedule;
  var remaining = billableUnits;
  var consumedSoFar = 0;
  var charge = 0;
  for (var i = 0; i < schedule.length; i += 1) {
    var tier = schedule[i];
    if (remaining <= 0) break;
    var tierCapacity;
    if (tier.up_to == null) {
      tierCapacity = remaining;                              // open tail
    } else {
      tierCapacity = Math.max(0, tier.up_to - consumedSoFar);
    }
    var consumeHere = Math.min(remaining, tierCapacity);
    charge += consumeHere * tier.price_minor;
    remaining -= consumeHere;
    consumedSoFar += consumeHere;
  }
  return charge;
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  // Subscriptions handle is optional — when wired, recordUsage
  // validates the subscription_id exists before inserting. Without
  // it, the FK constraint on `meter_slug` still catches a bogus
  // meter; subscription_id stays free-form so the primitive can
  // operate in a tenant without the recurring-billing tables wired
  // (e.g. usage tracking for one-shot purchases).
  var subscriptionsHandle = opts.subscriptions || null;
  if (subscriptionsHandle != null && typeof subscriptionsHandle.get !== "function") {
    throw new TypeError("meteredUsage.create: opts.subscriptions handle must expose get(id)");
  }

  var billingHandle = opts.subscriptionBilling || null;
  if (billingHandle != null && typeof billingHandle.recordInvoice !== "function") {
    throw new TypeError("meteredUsage.create: opts.subscriptionBilling handle must expose recordInvoice(...)");
  }

  async function _getMeter(slug) {
    var r = await query("SELECT * FROM meters WHERE slug = ?1", [slug]);
    return _hydrateMeter(r.rows[0]);
  }

  async function _subscriptionExists(subscriptionId) {
    if (subscriptionsHandle == null) return true;
    var row = await subscriptionsHandle.get(subscriptionId);
    return row != null;
  }

  // ---- defineMeter --------------------------------------------------

  async function defineMeter(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("meteredUsage.defineMeter: input object required");
    }
    var slug     = _slug(input.slug);
    var title    = _shortText(input.title, "title", MAX_TITLE_LEN);
    var unit     = _shortText(input.unit, "unit", MAX_UNIT_LEN);
    var currency = _currency(input.currency);
    var included = _includedUnits(input.included_units_per_period);

    var hasFlat  = input.tier_price_minor != null;
    var hasTiers = input.tier_schedule != null;
    if (hasFlat === hasTiers) {
      throw new TypeError("meteredUsage.defineMeter: exactly one of tier_price_minor / tier_schedule must be provided");
    }
    var tierPrice    = hasFlat  ? _tierPriceMinor(input.tier_price_minor) : null;
    var tierSchedule = hasTiers ? _tierSchedule(input.tier_schedule)      : null;

    // Refuse redefine — operators `updateMeter` to mutate.
    var existing = await _getMeter(slug);
    if (existing) {
      var err = new Error("meteredUsage.defineMeter: slug " + slug + " already defined");
      err.code = "METER_ALREADY_DEFINED";
      throw err;
    }

    var ts = _now();
    await query(
      "INSERT INTO meters " +
      "(slug, title, unit, tier_price_minor, tier_schedule_json, " +
      " included_units_per_period, currency, archived_at, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?8)",
      [
        slug,
        title,
        unit,
        tierPrice,
        tierSchedule == null ? null : JSON.stringify(tierSchedule),
        included,
        currency,
        ts,
      ],
    );
    return await _getMeter(slug);
  }

  // ---- recordUsage --------------------------------------------------

  async function recordUsage(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("meteredUsage.recordUsage: input object required");
    }
    var subscriptionId = _uuid(input.subscription_id, "subscription_id");
    var meterSlug      = _slug(input.meter_slug);
    var quantity       = _quantity(input.quantity);
    var occurredAt     = input.occurred_at == null ? _now() : _epochMs(input.occurred_at, "occurred_at");
    var idemKey        = _idempotencyKey(input.idempotency_key);
    var periodStart    = _optEpochMs(input.period_start, "period_start");
    var periodEnd      = _optEpochMs(input.period_end,   "period_end");
    if (periodStart != null && periodEnd != null && periodEnd < periodStart) {
      throw new TypeError("meteredUsage.recordUsage: period_end must be >= period_start");
    }

    var meter = await _getMeter(meterSlug);
    if (!meter) {
      var notFound = new Error("meteredUsage.recordUsage: meter " + meterSlug + " not found");
      notFound.code = "METER_NOT_FOUND";
      throw notFound;
    }
    if (meter.archived_at != null) {
      var archived = new Error("meteredUsage.recordUsage: meter " + meterSlug + " is archived");
      archived.code = "METER_ARCHIVED";
      throw archived;
    }

    if (!(await _subscriptionExists(subscriptionId))) {
      var subMissing = new Error("meteredUsage.recordUsage: subscription " + subscriptionId + " not found");
      subMissing.code = "SUBSCRIPTION_NOT_FOUND";
      throw subMissing;
    }

    // Idempotency replay — the same key re-submitted collapses to
    // the existing row. The UNIQUE-WHERE-NOT-NULL index would refuse
    // a second INSERT anyway; this surface returns the existing row
    // so the caller's retry loop is a no-op.
    if (idemKey != null) {
      var existing = await query(
        "SELECT * FROM meter_events WHERE idempotency_key = ?1",
        [idemKey],
      );
      if (existing.rows.length) return _hydrateEvent(existing.rows[0]);
    }

    var id = b.uuid.v7();
    var ts = _now();
    await query(
      "INSERT INTO meter_events " +
      "(id, subscription_id, meter_slug, quantity, idempotency_key, " +
      " occurred_at, period_start, period_end, created_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
      [id, subscriptionId, meterSlug, quantity, idemKey, occurredAt, periodStart, periodEnd, ts],
    );
    var r = await query("SELECT * FROM meter_events WHERE id = ?1", [id]);
    return _hydrateEvent(r.rows[0]);
  }

  // ---- usageForPeriod -----------------------------------------------

  async function usageForPeriod(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("meteredUsage.usageForPeriod: input object required");
    }
    var subscriptionId = _uuid(input.subscription_id, "subscription_id");
    var meterSlug      = _slug(input.meter_slug);
    var periodStart    = _epochMs(input.period_start, "period_start");
    var periodEnd      = _epochMs(input.period_end,   "period_end");
    if (periodEnd < periodStart) {
      throw new TypeError("meteredUsage.usageForPeriod: period_end must be >= period_start");
    }

    var meter = await _getMeter(meterSlug);
    if (!meter) {
      var notFound = new Error("meteredUsage.usageForPeriod: meter " + meterSlug + " not found");
      notFound.code = "METER_NOT_FOUND";
      throw notFound;
    }

    var r = await query(
      "SELECT COALESCE(SUM(quantity), 0) AS total FROM meter_events " +
      "WHERE subscription_id = ?1 AND meter_slug = ?2 " +
      "AND occurred_at >= ?3 AND occurred_at <= ?4",
      [subscriptionId, meterSlug, periodStart, periodEnd],
    );
    var totalUnits = Number(r.rows[0] && r.rows[0].total != null ? r.rows[0].total : 0);
    var includedUnits = meter.included_units_per_period;
    // Cap reported included units at the actual total — a 200-unit
    // period with a 1000-unit allowance reports `included_units:
    // 200`, not 1000, so the operator dashboard renders an accurate
    // "free units consumed this period" number.
    var includedConsumed = Math.min(includedUnits, totalUnits);
    var billableUnits = Math.max(0, totalUnits - includedUnits);
    var chargeMinor = _chargeFor(meter, billableUnits);

    return {
      meter_slug:      meter.slug,
      currency:        meter.currency,
      total_units:     totalUnits,
      included_units:  includedConsumed,
      billable_units:  billableUnits,
      charge_minor:    chargeMinor,
    };
  }

  // ---- periodSummary ------------------------------------------------

  async function periodSummary(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("meteredUsage.periodSummary: input object required");
    }
    var subscriptionId = _uuid(input.subscription_id, "subscription_id");
    var periodStart    = _epochMs(input.period_start, "period_start");
    var periodEnd      = _epochMs(input.period_end,   "period_end");
    if (periodEnd < periodStart) {
      throw new TypeError("meteredUsage.periodSummary: period_end must be >= period_start");
    }

    // The distinct-meter scan is bounded by the catalog size, not
    // the event volume — meter counts are operator-authored (tens,
    // not millions) so the cross-product walk is cheap.
    var meterRows = (await query(
      "SELECT DISTINCT meter_slug FROM meter_events " +
      "WHERE subscription_id = ?1 AND occurred_at >= ?2 AND occurred_at <= ?3",
      [subscriptionId, periodStart, periodEnd],
    )).rows;

    var lines = [];
    var byCurrency = {};
    for (var i = 0; i < meterRows.length; i += 1) {
      var meterSlug = meterRows[i].meter_slug;
      var line = await usageForPeriod({
        subscription_id: subscriptionId,
        meter_slug:      meterSlug,
        period_start:    periodStart,
        period_end:      periodEnd,
      });
      lines.push(line);
      if (!byCurrency[line.currency]) byCurrency[line.currency] = 0;
      byCurrency[line.currency] += line.charge_minor;
    }

    // Deterministic ordering — meter_slug ASC — so the operator
    // dashboard renders the same row order on every reload.
    lines.sort(function (a, b) {
      return a.meter_slug < b.meter_slug ? -1 : a.meter_slug > b.meter_slug ? 1 : 0;
    });

    return {
      subscription_id: subscriptionId,
      period_start:    periodStart,
      period_end:      periodEnd,
      lines:           lines,
      totals:          byCurrency,
    };
  }

  // ---- recordPeriodInvoice ------------------------------------------

  async function recordPeriodInvoice(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("meteredUsage.recordPeriodInvoice: input object required");
    }
    if (billingHandle == null) {
      throw new TypeError("meteredUsage.recordPeriodInvoice: subscriptionBilling handle required at factory time");
    }
    var subscriptionId = _uuid(input.subscription_id, "subscription_id");
    var periodStart    = _epochMs(input.period_start, "period_start");
    var periodEnd      = _epochMs(input.period_end,   "period_end");
    if (periodEnd < periodStart) {
      throw new TypeError("meteredUsage.recordPeriodInvoice: period_end must be >= period_start");
    }

    var summary = await periodSummary({
      subscription_id: subscriptionId,
      period_start:    periodStart,
      period_end:      periodEnd,
    });

    var invoices = [];
    var currencies = Object.keys(summary.totals).sort();
    for (var i = 0; i < currencies.length; i += 1) {
      var currency = currencies[i];
      var amountMinor = summary.totals[currency];
      // Skip zero-charge currencies — a period that consumed only
      // included-floor units shouldn't enqueue a $0 invoice line.
      if (amountMinor <= 0) continue;
      // Idempotency key. A period close is cron-driven and at-least-once: a
      // tick that retries (transient error mid-run, redelivery, or an operator
      // re-running the close) MUST NOT enqueue a second invoice for the same
      // [period_start, period_end, currency] — that double-bills the customer.
      // recordInvoice dedupes on processor_invoice_id, so stamp a deterministic
      // id derived from the period identity; a re-run returns the existing row.
      var dedupeId = "metered:" + subscriptionId + ":" + periodStart + ":" + periodEnd + ":" + currency;
      var invoice = await billingHandle.recordInvoice({
        subscription_id:     subscriptionId,
        period_start:        periodStart,
        period_end:          periodEnd,
        amount_minor:        amountMinor,
        currency:            currency,
        processor_invoice_id: dedupeId,
      });
      invoices.push(invoice);
    }
    return { summary: summary, invoices: invoices };
  }

  // ---- listMeters ---------------------------------------------------

  async function listMeters(input) {
    input = input || {};
    var activeOnly = input.active_only === true;
    var limit = _limit(input.limit);
    var sql = "SELECT * FROM meters";
    var params = [];
    if (activeOnly) {
      sql += " WHERE archived_at IS NULL";
    }
    sql += " ORDER BY slug ASC LIMIT ?1";
    params.push(limit);
    var r = await query(sql, params);
    return r.rows.map(_hydrateMeter);
  }

  // ---- updateMeter --------------------------------------------------

  async function updateMeter(slug, patch) {
    slug = _slug(slug);
    if (!patch || typeof patch !== "object") {
      throw new TypeError("meteredUsage.updateMeter: patch object required");
    }
    var keys = Object.keys(patch);
    if (keys.length === 0) {
      throw new TypeError("meteredUsage.updateMeter: patch must contain at least one key");
    }
    for (var i = 0; i < keys.length; i += 1) {
      if (ALLOWED_PATCH_COLUMNS.indexOf(keys[i]) === -1) {
        throw new TypeError("meteredUsage.updateMeter: patch key " + keys[i] + " not allowed; allowed: " + ALLOWED_PATCH_COLUMNS.join(", "));
      }
    }

    var existing = await _getMeter(slug);
    if (!existing) {
      var notFound = new Error("meteredUsage.updateMeter: meter " + slug + " not found");
      notFound.code = "METER_NOT_FOUND";
      throw notFound;
    }
    if (existing.archived_at != null) {
      var archived = new Error("meteredUsage.updateMeter: meter " + slug + " is archived");
      archived.code = "METER_ARCHIVED";
      throw archived;
    }

    // The pricing-shape XOR carries forward — patching one pricing
    // column must clear the other (the SQL CHECK constraint refuses
    // both NULL or both NOT NULL). Apply the merged shape against
    // the validators before writing.
    var nextTierPrice    = "tier_price_minor"  in patch ? patch.tier_price_minor : existing.tier_price_minor;
    var nextTierSchedule = "tier_schedule"     in patch ? patch.tier_schedule    : existing.tier_schedule;
    var nextHasFlat  = nextTierPrice != null;
    var nextHasTiers = nextTierSchedule != null;
    if (nextHasFlat && nextHasTiers) {
      throw new TypeError("meteredUsage.updateMeter: cannot have both tier_price_minor and tier_schedule — set the other to null");
    }
    if (!nextHasFlat && !nextHasTiers) {
      throw new TypeError("meteredUsage.updateMeter: exactly one of tier_price_minor / tier_schedule must remain set");
    }
    var tierPrice    = nextHasFlat  ? _tierPriceMinor(nextTierPrice) : null;
    var tierSchedule = nextHasTiers ? _tierSchedule(nextTierSchedule) : null;

    var nextTitle    = "title"                     in patch ? _shortText(patch.title, "title", MAX_TITLE_LEN)   : existing.title;
    var nextUnit     = "unit"                      in patch ? _shortText(patch.unit, "unit", MAX_UNIT_LEN)     : existing.unit;
    var nextIncluded = "included_units_per_period" in patch ? _includedUnits(patch.included_units_per_period) : existing.included_units_per_period;
    var nextCurrency = "currency"                  in patch ? _currency(patch.currency)                       : existing.currency;

    var ts = _now();
    await query(
      "UPDATE meters SET " +
      "title = ?1, unit = ?2, tier_price_minor = ?3, tier_schedule_json = ?4, " +
      "included_units_per_period = ?5, currency = ?6, updated_at = ?7 " +
      "WHERE slug = ?8",
      [
        nextTitle,
        nextUnit,
        tierPrice,
        tierSchedule == null ? null : JSON.stringify(tierSchedule),
        nextIncluded,
        nextCurrency,
        ts,
        slug,
      ],
    );
    return await _getMeter(slug);
  }

  // ---- archiveMeter -------------------------------------------------

  async function archiveMeter(slug) {
    slug = _slug(slug);
    var existing = await _getMeter(slug);
    if (!existing) {
      var notFound = new Error("meteredUsage.archiveMeter: meter " + slug + " not found");
      notFound.code = "METER_NOT_FOUND";
      throw notFound;
    }
    if (existing.archived_at != null) return existing;       // no-op replay
    var ts = _now();
    await query(
      "UPDATE meters SET archived_at = ?1, updated_at = ?1 WHERE slug = ?2",
      [ts, slug],
    );
    return await _getMeter(slug);
  }

  return {
    MAX_SLUG_LEN:        MAX_SLUG_LEN,
    MAX_TITLE_LEN:       MAX_TITLE_LEN,
    MAX_UNIT_LEN:        MAX_UNIT_LEN,
    MAX_IDEM_KEY_LEN:    MAX_IDEM_KEY_LEN,
    MAX_TIER_COUNT:      MAX_TIER_COUNT,
    MAX_LIST_LIMIT:      MAX_LIST_LIMIT,
    DEFAULT_LIST_LIMIT:  DEFAULT_LIST_LIMIT,

    subscriptionBilling: billingHandle,
    subscriptions:       subscriptionsHandle,

    defineMeter:         defineMeter,
    recordUsage:         recordUsage,
    usageForPeriod:      usageForPeriod,
    periodSummary:       periodSummary,
    recordPeriodInvoice: recordPeriodInvoice,
    listMeters:          listMeters,
    updateMeter:         updateMeter,
    archiveMeter:        archiveMeter,
  };
}

module.exports = {
  create:             create,
  MAX_SLUG_LEN:       MAX_SLUG_LEN,
  MAX_TITLE_LEN:      MAX_TITLE_LEN,
  MAX_UNIT_LEN:       MAX_UNIT_LEN,
  MAX_IDEM_KEY_LEN:   MAX_IDEM_KEY_LEN,
  MAX_TIER_COUNT:     MAX_TIER_COUNT,
  MAX_LIST_LIMIT:     MAX_LIST_LIMIT,
  DEFAULT_LIST_LIMIT: DEFAULT_LIST_LIMIT,
};
