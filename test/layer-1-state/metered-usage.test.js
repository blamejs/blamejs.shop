"use strict";
/**
 * metered-usage — usage-based pricing companion to the recurring-
 * billing primitives.
 *
 * Layer 1 against an in-memory node:sqlite database loaded from
 * migration 0095 (meters + meter_events). The sibling subscriptions
 * + subscriptionBilling primitives are substituted with minimal
 * shape-only stubs so the metered-usage surface is exercised in
 * isolation.
 *
 * Coverage:
 *   - defineMeter: happy (flat + tiered), refuses redefine, refuses
 *     bad shapes (slug, title control bytes, currency, included,
 *     XOR pricing, bad tier_schedule).
 *   - recordUsage: idempotency_key dedup, archived-meter refusal,
 *     unknown-meter refusal, subscription-handle gating, bad input.
 *   - usageForPeriod: total_units / included_units / billable_units
 *     / charge_minor against the schema's included-floor + flat-rate
 *     math.
 *   - tier_schedule walks (first N free, next M at A, next K at B,
 *     tail at C) — covers per-tier consumption and the open-tail.
 *   - periodSummary: multiple meters, multi-currency totals,
 *     deterministic ordering.
 *   - recordPeriodInvoice: rolls up via the billingHandle stub, one
 *     invoice per currency, zero-charge currencies skipped.
 *   - updateMeter: title / unit / included / currency patches,
 *     pricing-shape XOR carried forward, archived refusal, unknown
 *     refusal, unsupported column refusal.
 *   - archiveMeter: archived row, idempotent re-archive, unknown
 *     refusal.
 *   - listMeters: default vs active_only, slug-asc ordering, limit
 *     validation.
 *   - factory: refuses bad subscriptions / subscriptionBilling
 *     handle shapes; refuses missing input objects across the
 *     surface.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop         = require("../../lib");
var meteredUsage  = require("../../lib/metered-usage");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG_METERED = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0095_metered_usage.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_METERED, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db: db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return {
          rows:      [],
          rowCount:  Number(info.changes),
          lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
        };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// Minimal subscriptions stub — meter-usage validates subscription_id
// exists when this handle is wired. The stub mints a known set of
// subscription IDs at construction and returns a tiny row shape that
// satisfies the `get(id)` contract; everything else is out of scope
// for the metered-usage surface.
function _fakeSubscriptions(ids) {
  var owned = {};
  for (var i = 0; i < ids.length; i += 1) owned[ids[i]] = true;
  return {
    add: function (id) { owned[id] = true; },
    get: async function (id) {
      return owned[id] ? { id: id } : null;
    },
  };
}

// Minimal subscriptionBilling stub — captures every recordInvoice
// call and returns a deterministic invoice row so recordPeriodInvoice
// can be exercised end-to-end. Operator wires their real billing
// primitive in production.
function _fakeBilling() {
  var counter = 0;
  var invoices = [];
  return {
    invoices: invoices,
    recordInvoice: async function (input) {
      // Mirror the real subscriptionBilling: dedupe on processor_invoice_id so
      // a replayed period close returns the existing invoice instead of
      // enqueuing a duplicate (the production UNIQUE constraint + dedupe path).
      if (input.processor_invoice_id != null) {
        for (var j = 0; j < invoices.length; j += 1) {
          if (invoices[j].processor_invoice_id === input.processor_invoice_id) return invoices[j];
        }
      }
      counter += 1;
      var invoice = {
        invoice_id:      "inv_" + counter,
        subscription_id: input.subscription_id,
        period_start:    input.period_start,
        period_end:      input.period_end,
        amount_minor:    input.amount_minor,
        currency:        input.currency,
        processor_invoice_id: input.processor_invoice_id == null ? null : input.processor_invoice_id,
      };
      invoices.push(invoice);
      return invoice;
    },
  };
}

function _factory(opts) {
  opts = opts || {};
  var h = _makeQuery();
  var subs = opts.withSubscriptions === false ? null : _fakeSubscriptions(opts.subscriptionIds || []);
  var bill = opts.withBilling === false ? null : _fakeBilling();
  var mu = meteredUsage.create({
    query:               h.query,
    subscriptions:       subs,
    subscriptionBilling: bill,
  });
  return { db: h.db, query: h.query, subscriptions: subs, billing: bill, mu: mu };
}

// ---- tests --------------------------------------------------------------

async function _defineMeterRefusals() {
  var f = _factory();

  // Happy define — flat-rate.
  var m1 = await f.mu.defineMeter({
    slug:                      "api_calls",
    title:                     "API calls",
    unit:                      "call",
    tier_price_minor:          1,
    included_units_per_period: 1000,
    currency:                  "USD",
  });
  check("defineMeter returns hydrated row",         m1.slug === "api_calls");
  check("defineMeter title",                        m1.title === "API calls");
  check("defineMeter unit",                         m1.unit === "call");
  check("defineMeter tier_price_minor",             m1.tier_price_minor === 1);
  check("defineMeter tier_schedule null on flat",   m1.tier_schedule === null);
  check("defineMeter included_units_per_period",    m1.included_units_per_period === 1000);
  check("defineMeter currency",                     m1.currency === "USD");
  check("defineMeter archived_at null",             m1.archived_at === null);
  check("defineMeter created_at present",           typeof m1.created_at === "number" && m1.created_at > 0);
  check("defineMeter updated_at present",           typeof m1.updated_at === "number" && m1.updated_at > 0);

  // Happy define — tiered.
  var m2 = await f.mu.defineMeter({
    slug:                      "egress_gb",
    title:                     "Egress GB",
    unit:                      "GB",
    tier_schedule:             [
      { up_to: 100, price_minor: 5 },
      { up_to: 1000, price_minor: 3 },
      { up_to: null, price_minor: 2 },
    ],
    included_units_per_period: 0,
    currency:                  "USD",
  });
  check("defineMeter tiered tier_price_minor null", m2.tier_price_minor === null);
  check("defineMeter tiered schedule round-trips",  Array.isArray(m2.tier_schedule) && m2.tier_schedule.length === 3);
  check("defineMeter tiered tail up_to null",       m2.tier_schedule[2].up_to === null);
  check("defineMeter tiered tier 0 up_to",          m2.tier_schedule[0].up_to === 100);
  check("defineMeter tiered tier 0 price",          m2.tier_schedule[0].price_minor === 5);

  // Default included_units_per_period when omitted.
  var m3 = await f.mu.defineMeter({
    slug: "seat_hours", title: "Seat-hours", unit: "seat-hour",
    tier_price_minor: 10, currency: "USD",
  });
  check("defineMeter default included = 0",         m3.included_units_per_period === 0);

  // Refuse redefinition.
  var dup;
  try {
    await f.mu.defineMeter({
      slug: "api_calls", title: "dup", unit: "call",
      tier_price_minor: 2, currency: "USD",
    });
  } catch (e) { dup = e; }
  check("defineMeter dup → METER_ALREADY_DEFINED",  dup && dup.code === "METER_ALREADY_DEFINED");

  // Refuse bad slug.
  await assert.rejects(
    f.mu.defineMeter({ slug: "BAD SLUG", title: "x", unit: "u", tier_price_minor: 1, currency: "USD" }),
    /slug must match/,
  );

  // Refuse bad title (control bytes).
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-1", title: "bad\x00title", unit: "u", tier_price_minor: 1, currency: "USD" }),
    /control \/ zero-width/,
  );

  // Refuse bad title (zero-width).
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-zw", title: "ti​tle", unit: "u", tier_price_minor: 1, currency: "USD" }),
    /control \/ zero-width/,
  );

  // Refuse bad currency.
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-2", title: "x", unit: "u", tier_price_minor: 1, currency: "usd" }),
    /currency must be 3-letter uppercase/,
  );

  // Refuse bad included_units_per_period.
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-3", title: "x", unit: "u", tier_price_minor: 1, included_units_per_period: -1, currency: "USD" }),
    /included_units_per_period/,
  );

  // Refuse both pricing shapes set.
  await assert.rejects(
    f.mu.defineMeter({
      slug: "ok-both", title: "x", unit: "u",
      tier_price_minor: 1,
      tier_schedule: [{ up_to: null, price_minor: 2 }],
      currency: "USD",
    }),
    /exactly one of tier_price_minor \/ tier_schedule/,
  );

  // Refuse neither pricing shape set.
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-neither", title: "x", unit: "u", currency: "USD" }),
    /exactly one of tier_price_minor \/ tier_schedule/,
  );

  // Refuse empty tier_schedule.
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-empty", title: "x", unit: "u", tier_schedule: [], currency: "USD" }),
    /tier_schedule must be 1\.\./,
  );

  // Refuse tier_schedule with non-open tail.
  await assert.rejects(
    f.mu.defineMeter({
      slug: "ok-tail", title: "x", unit: "u",
      tier_schedule: [{ up_to: 100, price_minor: 5 }, { up_to: 200, price_minor: 3 }],
      currency: "USD",
    }),
    /tail tier must use `up_to: null`/,
  );

  // Refuse tier_schedule out of order.
  await assert.rejects(
    f.mu.defineMeter({
      slug: "ok-order", title: "x", unit: "u",
      tier_schedule: [
        { up_to: 200, price_minor: 5 },
        { up_to: 100, price_minor: 3 },
        { up_to: null, price_minor: 2 },
      ],
      currency: "USD",
    }),
    /must be an integer > previous tier/,
  );

  // Refuse tier with bad price_minor.
  await assert.rejects(
    f.mu.defineMeter({
      slug: "ok-px", title: "x", unit: "u",
      tier_schedule: [{ up_to: 100, price_minor: -5 }, { up_to: null, price_minor: 2 }],
      currency: "USD",
    }),
    /price_minor must be a non-negative integer/,
  );

  // Refuse bad tier_price_minor.
  await assert.rejects(
    f.mu.defineMeter({ slug: "ok-tp", title: "x", unit: "u", tier_price_minor: -1, currency: "USD" }),
    /tier_price_minor must be a non-negative integer/,
  );

  // Refuse missing input.
  await assert.rejects(f.mu.defineMeter(), /input object required/);
}

async function _recordUsageIdempotency() {
  var subId = _uuid();
  var f = _factory({ subscriptionIds: [subId] });

  await f.mu.defineMeter({
    slug: "api_calls", title: "API calls", unit: "call",
    tier_price_minor: 1, included_units_per_period: 0, currency: "USD",
  });

  // First record — inserts.
  var e1 = await f.mu.recordUsage({
    subscription_id: subId,
    meter_slug:      "api_calls",
    quantity:        50,
    idempotency_key: "req_abc",
  });
  check("recordUsage returns id",               typeof e1.id === "string" && e1.id.length > 0);
  check("recordUsage quantity",                 e1.quantity === 50);
  check("recordUsage idempotency_key",          e1.idempotency_key === "req_abc");
  check("recordUsage occurred_at default = now",typeof e1.occurred_at === "number" && e1.occurred_at > 0);
  check("recordUsage period_start null default",e1.period_start === null);
  check("recordUsage period_end null default",  e1.period_end === null);

  // Replay — same key returns the same row, no second insert.
  var e2 = await f.mu.recordUsage({
    subscription_id: subId,
    meter_slug:      "api_calls",
    quantity:        50,
    idempotency_key: "req_abc",
  });
  check("recordUsage replay returns same id",   e2.id === e1.id);

  // Different key — separate row.
  var e3 = await f.mu.recordUsage({
    subscription_id: subId,
    meter_slug:      "api_calls",
    quantity:        25,
    idempotency_key: "req_def",
  });
  check("recordUsage distinct key new id",      e3.id !== e1.id);

  // NULL keys aren't deduped — two writes both land.
  var e4 = await f.mu.recordUsage({
    subscription_id: subId, meter_slug: "api_calls", quantity: 10,
  });
  var e5 = await f.mu.recordUsage({
    subscription_id: subId, meter_slug: "api_calls", quantity: 10,
  });
  check("recordUsage null-key both written",    e4.id !== e5.id);

  // Archived meter — refused.
  await f.mu.archiveMeter("api_calls");
  var archived;
  try {
    await f.mu.recordUsage({
      subscription_id: subId, meter_slug: "api_calls", quantity: 1,
    });
  } catch (e) { archived = e; }
  check("recordUsage archived → METER_ARCHIVED", archived && archived.code === "METER_ARCHIVED");

  // Unknown meter — refused.
  var unknown;
  try {
    await f.mu.recordUsage({
      subscription_id: subId, meter_slug: "no-such", quantity: 1,
    });
  } catch (e) { unknown = e; }
  check("recordUsage unknown → METER_NOT_FOUND", unknown && unknown.code === "METER_NOT_FOUND");

  // Subscription handle gates an unknown subscription_id.
  await f.mu.defineMeter({
    slug: "api_calls_v2", title: "API v2", unit: "call",
    tier_price_minor: 1, currency: "USD",
  });
  var bogusSub = _uuid();
  var subMissing;
  try {
    await f.mu.recordUsage({
      subscription_id: bogusSub, meter_slug: "api_calls_v2", quantity: 1,
    });
  } catch (e) { subMissing = e; }
  check("recordUsage bad sub → SUBSCRIPTION_NOT_FOUND",
    subMissing && subMissing.code === "SUBSCRIPTION_NOT_FOUND");

  // period_end before period_start — refused at the validator.
  await assert.rejects(
    f.mu.recordUsage({
      subscription_id: subId, meter_slug: "api_calls_v2", quantity: 1,
      period_start: 2000, period_end: 1000,
    }),
    /period_end must be >= period_start/,
  );

  // Bad input shape.
  await assert.rejects(f.mu.recordUsage(),                                   /input object required/);
  await assert.rejects(
    f.mu.recordUsage({ subscription_id: "not-uuid", meter_slug: "api_calls_v2", quantity: 1 }),
    /subscription_id/,
  );
  await assert.rejects(
    f.mu.recordUsage({ subscription_id: subId, meter_slug: "api_calls_v2", quantity: -1 }),
    /quantity must be a non-negative integer/,
  );
  await assert.rejects(
    f.mu.recordUsage({ subscription_id: subId, meter_slug: "api_calls_v2", quantity: 1, idempotency_key: "" }),
    /idempotency_key must be a non-empty string/,
  );
}

async function _usageForPeriodFlatRate() {
  var subId = _uuid();
  var f = _factory({ subscriptionIds: [subId] });

  await f.mu.defineMeter({
    slug: "api_calls", title: "API calls", unit: "call",
    tier_price_minor: 1, included_units_per_period: 1000, currency: "USD",
  });

  var t0 = 1000000;
  var t1 = 2000000;

  // 200 units inside the period — fully covered by the 1000-unit
  // included-floor, charge should be zero.
  await f.mu.recordUsage({
    subscription_id: subId, meter_slug: "api_calls", quantity: 200,
    occurred_at: 1500000, idempotency_key: "k1",
  });
  var below = await f.mu.usageForPeriod({
    subscription_id: subId, meter_slug: "api_calls",
    period_start: t0, period_end: t1,
  });
  check("usageForPeriod meter_slug",            below.meter_slug === "api_calls");
  check("usageForPeriod currency",              below.currency === "USD");
  check("usageForPeriod total_units = 200",     below.total_units === 200);
  check("usageForPeriod included = 200 (capped)", below.included_units === 200);
  check("usageForPeriod billable = 0",          below.billable_units === 0);
  check("usageForPeriod charge_minor = 0",      below.charge_minor === 0);

  // Add 1300 more units — total 1500 — billable should be 500 * 1 = 500.
  await f.mu.recordUsage({
    subscription_id: subId, meter_slug: "api_calls", quantity: 1300,
    occurred_at: 1600000, idempotency_key: "k2",
  });
  var above = await f.mu.usageForPeriod({
    subscription_id: subId, meter_slug: "api_calls",
    period_start: t0, period_end: t1,
  });
  check("usageForPeriod total_units = 1500",    above.total_units === 1500);
  check("usageForPeriod included reports full 1000",
    above.included_units === 1000);
  check("usageForPeriod billable = 500",        above.billable_units === 500);
  check("usageForPeriod charge_minor = 500",    above.charge_minor === 500);

  // Event outside the window is excluded.
  await f.mu.recordUsage({
    subscription_id: subId, meter_slug: "api_calls", quantity: 9999,
    occurred_at: 3000000, idempotency_key: "k3-outside",
  });
  var stillAbove = await f.mu.usageForPeriod({
    subscription_id: subId, meter_slug: "api_calls",
    period_start: t0, period_end: t1,
  });
  check("usageForPeriod outside-window excluded", stillAbove.total_units === 1500);

  // Unknown meter — refused.
  var notFound;
  try {
    await f.mu.usageForPeriod({
      subscription_id: subId, meter_slug: "no-such",
      period_start: t0, period_end: t1,
    });
  } catch (e) { notFound = e; }
  check("usageForPeriod unknown → METER_NOT_FOUND",
    notFound && notFound.code === "METER_NOT_FOUND");

  // period_end < period_start refused.
  await assert.rejects(
    f.mu.usageForPeriod({
      subscription_id: subId, meter_slug: "api_calls",
      period_start: 2000, period_end: 1000,
    }),
    /period_end must be >= period_start/,
  );

  // Bad input shape.
  await assert.rejects(f.mu.usageForPeriod(),                                /input object required/);
}

async function _tierScheduleMath() {
  var subId = _uuid();
  var f = _factory({ subscriptionIds: [subId] });

  // Tiered: first 100 at 5/unit, next 900 at 3/unit, tail at 2/unit.
  // Included-floor = 0 to make the tier math obvious.
  await f.mu.defineMeter({
    slug: "egress", title: "Egress", unit: "GB",
    tier_schedule: [
      { up_to: 100,  price_minor: 5 },
      { up_to: 1000, price_minor: 3 },
      { up_to: null, price_minor: 2 },
    ],
    included_units_per_period: 0,
    currency:                  "USD",
  });

  var t0 = 1000000;
  var t1 = 2000000;

  async function _expect(qty, expectedCharge, label) {
    // Drop the previous events by spinning a fresh factory — keeps
    // each tier-walk assertion independent.
    var fresh = _factory({ subscriptionIds: [subId] });
    await fresh.mu.defineMeter({
      slug: "egress", title: "Egress", unit: "GB",
      tier_schedule: [
        { up_to: 100,  price_minor: 5 },
        { up_to: 1000, price_minor: 3 },
        { up_to: null, price_minor: 2 },
      ],
      included_units_per_period: 0,
      currency:                  "USD",
    });
    await fresh.mu.recordUsage({
      subscription_id: subId, meter_slug: "egress", quantity: qty,
      occurred_at: 1500000, idempotency_key: "k-" + qty,
    });
    var u = await fresh.mu.usageForPeriod({
      subscription_id: subId, meter_slug: "egress",
      period_start: t0, period_end: t1,
    });
    check(label + " total_units = " + qty,    u.total_units === qty);
    check(label + " charge = " + expectedCharge, u.charge_minor === expectedCharge);
  }

  await _expect(50,   50 * 5,                                    "tier-walk 50 GB (all in tier 0)");
  await _expect(100,  100 * 5,                                   "tier-walk 100 GB (exact tier 0 boundary)");
  await _expect(150,  100 * 5 + 50 * 3,                          "tier-walk 150 GB (tier 0 + 50 in tier 1)");
  await _expect(1000, 100 * 5 + 900 * 3,                         "tier-walk 1000 GB (exact tier 1 boundary)");
  await _expect(1500, 100 * 5 + 900 * 3 + 500 * 2,               "tier-walk 1500 GB (tier 0 + 1 + 500 tail)");

  // Tier walk WITH an included-units floor — first 100 free, then
  // tiers apply to the (total - included) billable count.
  var floor = _factory({ subscriptionIds: [subId] });
  await floor.mu.defineMeter({
    slug: "egress-2", title: "Egress floor", unit: "GB",
    tier_schedule: [
      { up_to: 100,  price_minor: 5 },
      { up_to: null, price_minor: 2 },
    ],
    included_units_per_period: 100,
    currency:                  "USD",
  });
  await floor.mu.recordUsage({
    subscription_id: subId, meter_slug: "egress-2", quantity: 250,
    occurred_at: 1500000, idempotency_key: "kf-1",
  });
  var floorRes = await floor.mu.usageForPeriod({
    subscription_id: subId, meter_slug: "egress-2",
    period_start: t0, period_end: t1,
  });
  // 250 total, 100 included, 150 billable; tier walk on 150: first
  // 100 at 5 minor = 500, next 50 at 2 minor = 100 → 600.
  check("floor + tier billable_units = 150",  floorRes.billable_units === 150);
  check("floor + tier charge_minor = 600",    floorRes.charge_minor === 600);
}

async function _periodSummaryMultiMeter() {
  var subId = _uuid();
  var f = _factory({ subscriptionIds: [subId] });

  // Two USD meters + one EUR meter.
  await f.mu.defineMeter({
    slug: "api_calls", title: "API calls", unit: "call",
    tier_price_minor: 1, included_units_per_period: 0, currency: "USD",
  });
  await f.mu.defineMeter({
    slug: "egress", title: "Egress", unit: "GB",
    tier_price_minor: 10, included_units_per_period: 0, currency: "USD",
  });
  await f.mu.defineMeter({
    slug: "storage_eu", title: "Storage EU", unit: "GB",
    tier_price_minor: 2, included_units_per_period: 0, currency: "EUR",
  });

  var t0 = 1000000;
  var t1 = 2000000;

  await f.mu.recordUsage({ subscription_id: subId, meter_slug: "api_calls", quantity: 500, occurred_at: 1100000, idempotency_key: "p-1" });
  await f.mu.recordUsage({ subscription_id: subId, meter_slug: "egress",    quantity: 20,  occurred_at: 1200000, idempotency_key: "p-2" });
  await f.mu.recordUsage({ subscription_id: subId, meter_slug: "storage_eu", quantity: 50, occurred_at: 1300000, idempotency_key: "p-3" });

  var summary = await f.mu.periodSummary({
    subscription_id: subId, period_start: t0, period_end: t1,
  });
  check("periodSummary subscription_id",     summary.subscription_id === subId);
  check("periodSummary period_start",        summary.period_start === t0);
  check("periodSummary period_end",          summary.period_end === t1);
  check("periodSummary three lines",         summary.lines.length === 3);

  // Deterministic ordering — meter_slug ASC.
  check("periodSummary lines sorted by slug ASC #0", summary.lines[0].meter_slug === "api_calls");
  check("periodSummary lines sorted by slug ASC #1", summary.lines[1].meter_slug === "egress");
  check("periodSummary lines sorted by slug ASC #2", summary.lines[2].meter_slug === "storage_eu");

  // Per-line charge math.
  var byMeter = {};
  for (var i = 0; i < summary.lines.length; i += 1) byMeter[summary.lines[i].meter_slug] = summary.lines[i];
  check("periodSummary api_calls charge",   byMeter.api_calls.charge_minor === 500);
  check("periodSummary egress charge",      byMeter.egress.charge_minor === 200);
  check("periodSummary storage_eu charge",  byMeter.storage_eu.charge_minor === 100);

  // Multi-currency totals.
  check("periodSummary USD total",          summary.totals.USD === 700);
  check("periodSummary EUR total",          summary.totals.EUR === 100);

  // Empty window → no lines, no totals.
  var empty = await f.mu.periodSummary({
    subscription_id: subId, period_start: 9000000, period_end: 9100000,
  });
  check("periodSummary empty window lines",  empty.lines.length === 0);
  check("periodSummary empty window totals", Object.keys(empty.totals).length === 0);

  // recordPeriodInvoice rolls up — one invoice per currency with > 0.
  var rolled = await f.mu.recordPeriodInvoice({
    subscription_id: subId, period_start: t0, period_end: t1,
  });
  check("recordPeriodInvoice returns summary", rolled.summary.lines.length === 3);
  check("recordPeriodInvoice 2 invoices",      rolled.invoices.length === 2);

  // Invoices ordered by currency ASC (EUR before USD).
  check("recordPeriodInvoice invoice[0] EUR",  rolled.invoices[0].currency === "EUR");
  check("recordPeriodInvoice invoice[0] amount", rolled.invoices[0].amount_minor === 100);
  check("recordPeriodInvoice invoice[1] USD",  rolled.invoices[1].currency === "USD");
  check("recordPeriodInvoice invoice[1] amount", rolled.invoices[1].amount_minor === 700);
  check("recordPeriodInvoice handle saw 2 calls", f.billing.invoices.length === 2);

  // Re-running the SAME period close (a cron retry / at-least-once redelivery
  // / operator re-run) must NOT double-bill: recordPeriodInvoice stamps a
  // deterministic processor_invoice_id, so the billing layer dedupes the
  // replay instead of enqueuing a second invoice for the period.
  var rerun = await f.mu.recordPeriodInvoice({
    subscription_id: subId, period_start: t0, period_end: t1,
  });
  check("period invoice carries a stable idempotency key", !!rolled.invoices[0].processor_invoice_id);
  check("re-run did not enqueue more invoices",   f.billing.invoices.length === 2);
  check("re-run returned the existing invoices",
    rerun.invoices[0].invoice_id === rolled.invoices[0].invoice_id &&
    rerun.invoices[1].invoice_id === rolled.invoices[1].invoice_id);

  // Zero-charge currencies skipped — define a meter whose total is
  // fully consumed by the included-floor.
  await f.mu.defineMeter({
    slug: "zero_chf", title: "Zero CHF", unit: "x",
    tier_price_minor: 100, included_units_per_period: 1000, currency: "CHF",
  });
  await f.mu.recordUsage({
    subscription_id: subId, meter_slug: "zero_chf", quantity: 50,
    occurred_at: 1400000, idempotency_key: "p-zero",
  });
  var f2billing = _fakeBilling();
  // Rebind a fresh billing handle so the invoice list is clean for
  // this assertion.
  var mu2 = meteredUsage.create({
    query: f.query, subscriptions: f.subscriptions, subscriptionBilling: f2billing,
  });
  var rolled2 = await mu2.recordPeriodInvoice({
    subscription_id: subId, period_start: t0, period_end: t1,
  });
  // CHF line is in the summary but no CHF invoice was enqueued.
  var sawChf = rolled2.summary.lines.some(function (l) { return l.meter_slug === "zero_chf"; });
  check("zero-charge meter still in summary",     sawChf);
  var anyChfInvoice = rolled2.invoices.some(function (i) { return i.currency === "CHF"; });
  check("zero-charge currency skipped on invoice", !anyChfInvoice);

  // recordPeriodInvoice without a billing handle wired — refused.
  var noBill = _factory({ subscriptionIds: [subId], withBilling: false });
  await assert.rejects(
    noBill.mu.recordPeriodInvoice({
      subscription_id: subId, period_start: t0, period_end: t1,
    }),
    /subscriptionBilling handle required/,
  );

  // recordPeriodInvoice validator coverage.
  await assert.rejects(f.mu.recordPeriodInvoice(),                              /input object required/);
  await assert.rejects(
    f.mu.recordPeriodInvoice({ subscription_id: subId, period_start: 2000, period_end: 1000 }),
    /period_end must be >= period_start/,
  );

  // periodSummary validator coverage.
  await assert.rejects(f.mu.periodSummary(),                                    /input object required/);
  await assert.rejects(
    f.mu.periodSummary({ subscription_id: subId, period_start: 2000, period_end: 1000 }),
    /period_end must be >= period_start/,
  );
}

async function _updateAndArchive() {
  var f = _factory();

  await f.mu.defineMeter({
    slug: "api_calls", title: "API calls", unit: "call",
    tier_price_minor: 1, included_units_per_period: 100, currency: "USD",
  });

  // Patch title + unit + included + currency.
  var u1 = await f.mu.updateMeter("api_calls", {
    title:                     "API requests",
    unit:                      "request",
    included_units_per_period: 500,
    currency:                  "EUR",
  });
  check("updateMeter title",                u1.title === "API requests");
  check("updateMeter unit",                 u1.unit === "request");
  check("updateMeter included",             u1.included_units_per_period === 500);
  check("updateMeter currency",             u1.currency === "EUR");
  check("updateMeter pricing unchanged",    u1.tier_price_minor === 1 && u1.tier_schedule === null);

  // Swap pricing shape from flat to tiered: caller must set the
  // other to null in the same patch.
  var u2 = await f.mu.updateMeter("api_calls", {
    tier_price_minor: null,
    tier_schedule:    [
      { up_to: 1000, price_minor: 2 },
      { up_to: null, price_minor: 1 },
    ],
  });
  check("updateMeter pricing flat → tiered (flat null)",  u2.tier_price_minor === null);
  check("updateMeter pricing flat → tiered (sched len)",  u2.tier_schedule.length === 2);

  // Refuse leaving both pricing columns set.
  await assert.rejects(
    f.mu.updateMeter("api_calls", { tier_price_minor: 5 }),
    /cannot have both tier_price_minor and tier_schedule/,
  );

  // Refuse clearing both pricing columns.
  await assert.rejects(
    f.mu.updateMeter("api_calls", { tier_schedule: null }),
    /exactly one of tier_price_minor \/ tier_schedule must remain set/,
  );

  // Refuse unsupported column.
  await assert.rejects(
    f.mu.updateMeter("api_calls", { slug: "renamed" }),
    /patch key slug not allowed/,
  );

  // Refuse empty patch.
  await assert.rejects(
    f.mu.updateMeter("api_calls", {}),
    /patch must contain at least one key/,
  );

  // Refuse bad patch shape.
  await assert.rejects(f.mu.updateMeter("api_calls"),         /patch object required/);
  await assert.rejects(f.mu.updateMeter("api_calls", null),    /patch object required/);

  // Refuse unknown meter.
  var unknown;
  try { await f.mu.updateMeter("no-such", { title: "x" }); } catch (e) { unknown = e; }
  check("updateMeter unknown → METER_NOT_FOUND", unknown && unknown.code === "METER_NOT_FOUND");

  // archiveMeter sets archived_at.
  var archived = await f.mu.archiveMeter("api_calls");
  check("archiveMeter archived_at set",     typeof archived.archived_at === "number" && archived.archived_at > 0);

  // archived meter refuses subsequent updateMeter.
  var afterArchive;
  try {
    await f.mu.updateMeter("api_calls", { title: "after-archive" });
  } catch (e) { afterArchive = e; }
  check("updateMeter on archived → METER_ARCHIVED",
    afterArchive && afterArchive.code === "METER_ARCHIVED");

  // archiveMeter idempotent.
  var rearchived = await f.mu.archiveMeter("api_calls");
  check("archiveMeter idempotent same timestamp",
    rearchived.archived_at === archived.archived_at);

  // archiveMeter unknown → METER_NOT_FOUND.
  var archUnknown;
  try { await f.mu.archiveMeter("no-such"); } catch (e) { archUnknown = e; }
  check("archiveMeter unknown → METER_NOT_FOUND",
    archUnknown && archUnknown.code === "METER_NOT_FOUND");

  // archiveMeter bad slug shape.
  await assert.rejects(f.mu.archiveMeter("BAD SLUG"), /slug must match/);
}

async function _listAndFactoryRefusals() {
  var f = _factory();

  await f.mu.defineMeter({
    slug: "a_meter", title: "A", unit: "u", tier_price_minor: 1, currency: "USD",
  });
  await f.mu.defineMeter({
    slug: "b_meter", title: "B", unit: "u", tier_price_minor: 1, currency: "USD",
  });
  await f.mu.defineMeter({
    slug: "c_meter", title: "C", unit: "u", tier_price_minor: 1, currency: "USD",
  });
  await f.mu.archiveMeter("c_meter");

  var all = await f.mu.listMeters();
  check("listMeters default returns all",        all.length === 3);
  check("listMeters slug ASC #0",                all[0].slug === "a_meter");
  check("listMeters slug ASC #1",                all[1].slug === "b_meter");
  check("listMeters slug ASC #2",                all[2].slug === "c_meter");

  var active = await f.mu.listMeters({ active_only: true });
  check("listMeters active_only excludes archived", active.length === 2);
  check("listMeters active_only slug ASC #0",       active[0].slug === "a_meter");
  check("listMeters active_only slug ASC #1",       active[1].slug === "b_meter");

  // limit validation.
  await assert.rejects(f.mu.listMeters({ limit: 0 }),    /limit must be a positive integer/);
  await assert.rejects(f.mu.listMeters({ limit: -5 }),   /limit must be a positive integer/);
  await assert.rejects(f.mu.listMeters({ limit: 1000 }), /limit must be <=/);

  // Factory refuses bad subscriptions handle (missing get).
  assert.throws(
    function () { meteredUsage.create({ query: f.query, subscriptions: { unexpected: true } }); },
    /subscriptions handle must expose get/,
  );

  // Factory refuses bad subscriptionBilling handle (missing recordInvoice).
  assert.throws(
    function () { meteredUsage.create({ query: f.query, subscriptionBilling: { unexpected: true } }); },
    /subscriptionBilling handle must expose recordInvoice/,
  );

  // Surface-level missing-input refusals.
  await assert.rejects(f.mu.defineMeter(),         /input object required/);
  await assert.rejects(f.mu.recordUsage(),         /input object required/);
  await assert.rejects(f.mu.usageForPeriod(),      /input object required/);
  await assert.rejects(f.mu.periodSummary(),       /input object required/);
  await assert.rejects(f.mu.recordPeriodInvoice(), /input object required/);

  // Constants surfaced on the instance + module match.
  check("MAX_SLUG_LEN exposed on instance",  f.mu.MAX_SLUG_LEN === meteredUsage.MAX_SLUG_LEN);
  check("MAX_TIER_COUNT exposed",            f.mu.MAX_TIER_COUNT === meteredUsage.MAX_TIER_COUNT);
  check("DEFAULT_LIST_LIMIT exposed",        f.mu.DEFAULT_LIST_LIMIT === meteredUsage.DEFAULT_LIST_LIMIT);
}

async function run() {
  await _defineMeterRefusals();
  await _recordUsageIdempotency();
  await _usageForPeriodFlatRate();
  await _tierScheduleMath();
  await _periodSummaryMultiMeter();
  await _updateAndArchive();
  await _listAndFactoryRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - metered-usage (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
