"use strict";
/**
 * carrierRates — at-checkout shipping rate shopping. Operator
 * registers N carrier-rate sources; the primitive caches their quotes
 * and serves a sorted-by-cost list for a (cart + ship-to) tuple.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0080.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/carrier-rates.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - registerCarrier happy path + persistence shape; upsert on slug
 *   - registerCarrier refuses bad inputs (bad slug, bad carrier, bad
 *     service_levels, non-https rate_endpoint)
 *   - recordRateQuote happy path + dedup on
 *     (carrier_slug, service_code, origin_postal, dest_postal,
 *     weight_grams) — refresh keeps id stable
 *   - recordRateQuote refuses an unregistered carrier + an off-menu
 *     service code
 *   - ratesForShipment returns live cached rates sorted ascending by
 *     rate_minor, filters expired rows + paused carriers
 *   - ratesForShipment falls back to a synthetic flat-rate row when
 *     no live carrier quotes exist
 *   - cleanupExpiredQuotes prunes rows past valid_until
 *   - recentQuotes pagination — limit + opaque cursor walks through
 *     the result without skipping or duplicating
 *   - metricsForCarrier aggregates count + min/max/avg per
 *     (service_code, currency)
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var carrierRates = require("../../lib/carrier-rates");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0080_carrier_rates.sql"
);

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PATH, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _setup(extra) {
  var query = _makeQuery();
  var opts = Object.assign({ query: query }, extra || {});
  var rates = carrierRates.create(opts);
  return { query: query, rates: rates };
}

// Touch bShop so the require graph stays exercised + the lint detector
// for unused locals stays quiet — the framework handle is also what
// `lib/carrier-rates.js` itself lazily resolves at runtime.
if (!bShop || !bShop.framework) {
  throw new Error("blamejs.shop framework handle missing");
}

var UPS_LEVELS = [
  { code: "GROUND",       label: "UPS Ground",         sla_days: 5 },
  { code: "TWO_DAY",      label: "UPS 2nd Day Air",    sla_days: 2 },
  { code: "NEXT_DAY",     label: "UPS Next Day Air",   sla_days: 1 },
];

var FEDEX_LEVELS = [
  { code: "GROUND",       label: "FedEx Ground",       sla_days: 5 },
  { code: "EXPRESS_SAVER", label: "FedEx Express Saver", sla_days: 3 },
];

var FLAT_LEVELS = [
  { code: "DOMESTIC",     label: "Flat Rate (US)",     sla_days: 7 },
];

var FAR_FUTURE  = Date.UTC(2030, 0, 1);
var FAR_PAST    = Date.UTC(2000, 0, 1);

async function _registerCarrierHappyPath() {
  var ctx = _setup();
  var r = await ctx.rates.registerCarrier({
    slug:           "ups",
    carrier:        "ups",
    service_levels: UPS_LEVELS,
    rate_endpoint:  "https://rate-worker.example.com/ups",
    active:         true,
  });
  check("registerCarrier returns row",             r && typeof r === "object");
  check("registerCarrier persists slug",           r.slug === "ups");
  check("registerCarrier persists carrier",        r.carrier === "ups");
  check("registerCarrier persists service_levels", Array.isArray(r.service_levels) && r.service_levels.length === 3);
  check("registerCarrier persists service_level code",  r.service_levels[0].code === "GROUND");
  check("registerCarrier persists service_level label", r.service_levels[0].label === "UPS Ground");
  check("registerCarrier persists service_level sla",   r.service_levels[0].sla_days === 5);
  check("registerCarrier persists rate_endpoint",  r.rate_endpoint === "https://rate-worker.example.com/ups");
  check("registerCarrier persists active",         r.active === true);
  check("registerCarrier stamps created_at",       typeof r.created_at === "number" && r.created_at > 0);
  check("registerCarrier stamps updated_at",       typeof r.updated_at === "number" && r.updated_at > 0);

  // Upsert — second registerCarrier with the same slug rotates the
  // service levels in place; created_at is preserved.
  var updated = await ctx.rates.registerCarrier({
    slug:           "ups",
    carrier:        "ups",
    service_levels: [{ code: "GROUND", label: "UPS Ground (renamed)", sla_days: 6 }],
    active:         false,
  });
  check("registerCarrier upsert preserves created_at", updated.created_at === r.created_at);
  check("registerCarrier upsert rotates service_levels", updated.service_levels.length === 1);
  check("registerCarrier upsert rotates label",     updated.service_levels[0].label === "UPS Ground (renamed)");
  check("registerCarrier upsert flips active",      updated.active === false);
  check("registerCarrier upsert clears rate_endpoint", updated.rate_endpoint === null);

  // Carrier without an endpoint — operators wiring a worker that
  // already knows the URL out of band can omit rate_endpoint.
  var noEndpoint = await ctx.rates.registerCarrier({
    slug:           "flat-domestic",
    carrier:        "flat_rate",
    service_levels: FLAT_LEVELS,
    active:         true,
  });
  check("registerCarrier accepts missing rate_endpoint", noEndpoint.rate_endpoint === null);
}

async function _registerCarrierInputRefusals() {
  var ctx = _setup();
  // Bad slug shape.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "UPS", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  }), /slug/);
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "-leading-dash", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  }), /slug/);

  // Bad carrier value.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "rocket-post", service_levels: UPS_LEVELS, active: true,
  }), /carrier/);

  // service_levels must be a non-empty array.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups", service_levels: [], active: true,
  }), /service_levels/);

  // service_levels[i] missing label.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups",
    service_levels: [{ code: "GROUND", sla_days: 5 }],
    active: true,
  }), /label/);

  // service_levels[i] negative sla_days.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups",
    service_levels: [{ code: "GROUND", label: "Ground", sla_days: -1 }],
    active: true,
  }), /sla_days/);

  // service_levels[i] duplicate code.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups",
    service_levels: [
      { code: "GROUND", label: "A", sla_days: 5 },
      { code: "GROUND", label: "B", sla_days: 5 },
    ],
    active: true,
  }), /duplicate/);

  // Non-https rate_endpoint refused — safeUrl gate is https-only.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups",
    service_levels: UPS_LEVELS,
    rate_endpoint: "http://insecure.example.com/ups",
    active: true,
  }), /rate_endpoint/);

  // Bogus scheme.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups",
    service_levels: UPS_LEVELS,
    rate_endpoint: "javascript:alert(1)",
    active: true,
  }), /rate_endpoint/);

  // active must be boolean.
  await assert.rejects(ctx.rates.registerCarrier({
    slug: "x", carrier: "ups", service_levels: UPS_LEVELS, active: 1,
  }), /active/);

  // Missing input.
  await assert.rejects(ctx.rates.registerCarrier(null), /input object required/);
}

async function _recordRateQuoteDedup() {
  var ctx = _setup();
  await ctx.rates.registerCarrier({
    slug: "ups", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  });

  var q1 = await ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "GROUND",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    1299,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  });
  check("recordRateQuote returns hydrated row",    q1 && typeof q1 === "object");
  check("recordRateQuote stamps 36-char uuid id",  typeof q1.id === "string" && q1.id.length === 36);
  check("recordRateQuote persists carrier_slug",   q1.carrier_slug === "ups");
  check("recordRateQuote persists service_code",   q1.service_code === "GROUND");
  check("recordRateQuote persists origin_postal",  q1.origin_postal === "94110");
  check("recordRateQuote persists dest_postal",    q1.dest_postal === "10001");
  check("recordRateQuote persists weight_grams",   q1.weight_grams === 1500);
  check("recordRateQuote persists dimensions",     q1.dimensions.length_mm === 300);
  check("recordRateQuote persists rate_minor",     q1.rate_minor === 1299);
  check("recordRateQuote persists currency",       q1.currency === "USD");
  check("recordRateQuote persists valid_until",    q1.valid_until === FAR_FUTURE);
  check("recordRateQuote stamps queried_at",       typeof q1.queried_at === "number" && q1.queried_at > 0);

  // Same key, fresher rate + later expiry — refreshes in place,
  // preserves the row id (no stack of duplicates).
  var q2 = await ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "GROUND",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    1199,
    currency:      "USD",
    valid_until:   FAR_FUTURE + 60_000,
  });
  check("recordRateQuote dedup preserves id",      q2.id === q1.id);
  check("recordRateQuote dedup refreshes rate",    q2.rate_minor === 1199);
  check("recordRateQuote dedup refreshes valid_until", q2.valid_until === FAR_FUTURE + 60_000);

  // Different service_code on the same key → new row.
  var q3 = await ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "NEXT_DAY",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    4599,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  });
  check("recordRateQuote different service_code -> new id", q3.id !== q1.id);

  // Unregistered carrier refused.
  await assert.rejects(ctx.rates.recordRateQuote({
    carrier_slug:  "rogue",
    service_code:  "GROUND",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    1000,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  }), /not registered/);

  // Off-menu service_code refused.
  await assert.rejects(ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "PIGEON",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    1000,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  }), /service_levels menu/);

  // Negative rate refused.
  await assert.rejects(ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "GROUND",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    -1,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  }), /rate_minor/);

  // Bad currency.
  await assert.rejects(ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "GROUND",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    1000,
    currency:      "usd",
    valid_until:   FAR_FUTURE,
  }), /currency/);

  // Bad dimensions (zero width).
  await assert.rejects(ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "GROUND",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 0, height_mm: 100 },
    rate_minor:    1000,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  }), /width_mm/);
}

async function _ratesForShipmentSortAndFallback() {
  var ctx = _setup();
  await ctx.rates.registerCarrier({
    slug: "ups", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  });
  await ctx.rates.registerCarrier({
    slug: "fedex", carrier: "fedex", service_levels: FEDEX_LEVELS, active: true,
  });
  await ctx.rates.registerCarrier({
    slug: "flat-us", carrier: "flat_rate", service_levels: FLAT_LEVELS, active: true,
  });

  // Three live quotes against the same shipment, different rates.
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups", service_code: "GROUND",
    origin_postal: "94110", dest_postal: "10001", weight_grams: 1500,
    dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor: 1299, currency: "USD", valid_until: FAR_FUTURE,
  });
  await ctx.rates.recordRateQuote({
    carrier_slug:  "fedex", service_code: "GROUND",
    origin_postal: "94110", dest_postal: "10001", weight_grams: 1500,
    dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor: 1099, currency: "USD", valid_until: FAR_FUTURE,
  });
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups", service_code: "NEXT_DAY",
    origin_postal: "94110", dest_postal: "10001", weight_grams: 1500,
    dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor: 4599, currency: "USD", valid_until: FAR_FUTURE,
  });

  // Expired quote (valid_until in the past) — must NOT appear.
  await ctx.rates.recordRateQuote({
    carrier_slug:  "fedex", service_code: "EXPRESS_SAVER",
    origin_postal: "94110", dest_postal: "10001", weight_grams: 1500,
    dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor: 100, currency: "USD", valid_until: FAR_PAST,
  });

  var rows = await ctx.rates.ratesForShipment({
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
  });
  check("ratesForShipment returns 3 live rates",   rows.length === 3);
  check("ratesForShipment sorts ascending by rate", rows[0].rate_minor === 1099 && rows[1].rate_minor === 1299 && rows[2].rate_minor === 4599);
  check("ratesForShipment skips expired quote",    !rows.some(function (r) { return r.rate_minor === 100; }));
  check("ratesForShipment decorates with service_label", rows[0].service_label === "FedEx Ground");
  check("ratesForShipment decorates with sla_days", rows[0].sla_days === 5);
  check("ratesForShipment marks non-synthetic",    rows.every(function (r) { return r.synthetic === false; }));

  // Paused carrier excludes its cached quotes from rates.
  await ctx.rates.registerCarrier({
    slug: "ups", carrier: "ups", service_levels: UPS_LEVELS, active: false,
  });
  var pausedRows = await ctx.rates.ratesForShipment({
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
  });
  check("ratesForShipment skips paused carrier rates", pausedRows.length === 1 && pausedRows[0].carrier_slug === "fedex");

  // Different shipment shape with no live quotes -> synthetic flat-rate fallback.
  var fallback = await ctx.rates.ratesForShipment({
    origin_postal: "94110",
    dest_postal:   "60601",
    weight_grams:  500,
    dimensions:    { length_mm: 200, width_mm: 100, height_mm: 50 },
  });
  check("ratesForShipment falls back to flat-rate", fallback.length === 1);
  check("ratesForShipment fallback is synthetic",   fallback[0].synthetic === true);
  check("ratesForShipment fallback carrier slug",   fallback[0].carrier_slug === "flat-us");
  check("ratesForShipment fallback service code",   fallback[0].service_code === "DOMESTIC");
  check("ratesForShipment fallback label decorated", fallback[0].service_label === "Flat Rate (US)");
  check("ratesForShipment fallback sla_days",       fallback[0].sla_days === 7);
  check("ratesForShipment fallback rate is 0",      fallback[0].rate_minor === 0);

  // Bad input rejected.
  await assert.rejects(ctx.rates.ratesForShipment({
    origin_postal: "",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
  }), /origin_postal/);

  await assert.rejects(ctx.rates.ratesForShipment({
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  0,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
  }), /weight_grams/);
}

async function _cleanupExpiredQuotes() {
  var ctx = _setup();
  await ctx.rates.registerCarrier({
    slug: "ups", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  });
  // Live row.
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups", service_code: "GROUND",
    origin_postal: "94110", dest_postal: "10001", weight_grams: 1500,
    dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor: 1299, currency: "USD", valid_until: FAR_FUTURE,
  });
  // Expired row #1.
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups", service_code: "TWO_DAY",
    origin_postal: "94110", dest_postal: "10001", weight_grams: 1500,
    dimensions: { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor: 2499, currency: "USD", valid_until: FAR_PAST,
  });
  // Expired row #2 (different shipment, still expired).
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups", service_code: "NEXT_DAY",
    origin_postal: "94110", dest_postal: "60601", weight_grams: 2000,
    dimensions: { length_mm: 400, width_mm: 200, height_mm: 100 },
    rate_minor: 5999, currency: "USD", valid_until: FAR_PAST + 1000,
  });

  var pruned = await ctx.rates.cleanupExpiredQuotes();
  check("cleanupExpiredQuotes prunes 2 rows",      pruned.pruned === 2);

  var remaining = await ctx.query("SELECT id, service_code FROM carrier_rate_quotes", []);
  check("cleanupExpiredQuotes leaves live row",    remaining.rows.length === 1 && remaining.rows[0].service_code === "GROUND");

  // Second call prunes nothing.
  var pruned2 = await ctx.rates.cleanupExpiredQuotes();
  check("cleanupExpiredQuotes idempotent",         pruned2.pruned === 0);
}

async function _recentQuotesPagination() {
  var ctx = _setup({ cursorSecret: "test-secret-page-key" });
  await ctx.rates.registerCarrier({
    slug: "ups", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  });
  await ctx.rates.registerCarrier({
    slug: "fedex", carrier: "fedex", service_levels: FEDEX_LEVELS, active: true,
  });

  // Insert 5 quotes; queried_at is stamped by the primitive at write
  // time so successive calls naturally sort newest-first on read.
  var inserted = [];
  for (var i = 0; i < 5; i += 1) {
    var slug = i % 2 === 0 ? "ups" : "fedex";
    var svc  = "GROUND";
    var q = await ctx.rates.recordRateQuote({
      carrier_slug:  slug,
      service_code:  svc,
      origin_postal: "94110",
      dest_postal:   "ZIP" + i,
      weight_grams:  1000 + i * 100,
      dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
      rate_minor:    1000 + i,
      currency:      "USD",
      valid_until:   FAR_FUTURE,
    });
    inserted.push(q);
    // Step time so queried_at is monotonically increasing — sqlite's
    // grouping otherwise lands every row inside the same ms tick.
    await new Promise(function (r) { setTimeout(r, 2); });   // allow:test-promise-settimeout-sleep — deterministic monotonic-clock step, not a wait-for-event sleep
  }

  // Page 1: newest 2.
  var p1 = await ctx.rates.recentQuotes({ from: 1, to: FAR_FUTURE, limit: 2 });
  check("recentQuotes page 1 returns 2 rows",      p1.rows.length === 2);
  check("recentQuotes page 1 sorted newest first", p1.rows[0].queried_at >= p1.rows[1].queried_at);
  check("recentQuotes page 1 exposes next_cursor", typeof p1.next_cursor === "string" && p1.next_cursor.length > 0);

  // Page 2: next 2 — must not duplicate page 1 ids.
  var p2 = await ctx.rates.recentQuotes({ from: 1, to: FAR_FUTURE, limit: 2, cursor: p1.next_cursor });
  check("recentQuotes page 2 returns 2 rows",      p2.rows.length === 2);
  var p1Ids = p1.rows.map(function (r) { return r.id; });
  var p2Ids = p2.rows.map(function (r) { return r.id; });
  check("recentQuotes page 2 doesn't duplicate page 1", p2Ids.every(function (id) { return p1Ids.indexOf(id) === -1; }));
  check("recentQuotes page 2 exposes next_cursor", typeof p2.next_cursor === "string");

  // Page 3: last 1 — cursor exhausts.
  var p3 = await ctx.rates.recentQuotes({ from: 1, to: FAR_FUTURE, limit: 2, cursor: p2.next_cursor });
  check("recentQuotes page 3 returns last row",    p3.rows.length === 1);
  check("recentQuotes page 3 no next_cursor",      p3.next_cursor === null);

  // Together pages 1 + 2 + 3 cover every inserted row exactly once.
  var allIds = p1Ids.concat(p2Ids).concat(p3.rows.map(function (r) { return r.id; }));
  check("recentQuotes pages cover every inserted row",
    inserted.every(function (q) { return allIds.indexOf(q.id) !== -1; }) && allIds.length === inserted.length);

  // carrier_slug filter scopes the listing.
  var upsOnly = await ctx.rates.recentQuotes({ from: 1, to: FAR_FUTURE, limit: 50, carrier_slug: "ups" });
  check("recentQuotes carrier_slug filter applied", upsOnly.rows.length === 3 && upsOnly.rows.every(function (r) { return r.carrier_slug === "ups"; }));

  // window-narrow returns []
  var none = await ctx.rates.recentQuotes({ from: 1, to: 100, limit: 50 });
  check("recentQuotes narrow window -> []",        none.rows.length === 0);

  // Bad input refused.
  await assert.rejects(ctx.rates.recentQuotes(null), /opts object required/);
  await assert.rejects(ctx.rates.recentQuotes({ from: FAR_FUTURE, to: 1 }), /to must be >= from/);
  await assert.rejects(ctx.rates.recentQuotes({ from: 1, to: FAR_FUTURE, limit: 0 }), /limit/);
  await assert.rejects(ctx.rates.recentQuotes({ from: 1, to: FAR_FUTURE, limit: 5, cursor: "garbage" }), /cursor/);
}

async function _metricsForCarrier() {
  var ctx = _setup();
  await ctx.rates.registerCarrier({
    slug: "ups", carrier: "ups", service_levels: UPS_LEVELS, active: true,
  });
  // Three quotes against UPS / GROUND / USD.
  for (var i = 0; i < 3; i += 1) {
    await ctx.rates.recordRateQuote({
      carrier_slug:  "ups",
      service_code:  "GROUND",
      origin_postal: "94110",
      dest_postal:   "DEST" + i,
      weight_grams:  1000 + i * 100,
      dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
      rate_minor:    1000 + i * 100,
      currency:      "USD",
      valid_until:   FAR_FUTURE,
    });
  }
  // One quote against UPS / NEXT_DAY / USD.
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "NEXT_DAY",
    origin_postal: "94110",
    dest_postal:   "10001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    4500,
    currency:      "USD",
    valid_until:   FAR_FUTURE,
  });
  // One quote against UPS / GROUND / EUR — distinct currency group.
  await ctx.rates.recordRateQuote({
    carrier_slug:  "ups",
    service_code:  "GROUND",
    origin_postal: "10115",
    dest_postal:   "75001",
    weight_grams:  1500,
    dimensions:    { length_mm: 300, width_mm: 200, height_mm: 100 },
    rate_minor:    900,
    currency:      "EUR",
    valid_until:   FAR_FUTURE,
  });

  var metrics = await ctx.rates.metricsForCarrier({ slug: "ups", from: 1, to: FAR_FUTURE });
  check("metricsForCarrier returns 3 groups",      metrics.length === 3);

  // Locate the (GROUND, USD) row — 3 quotes, min 1000, max 1200, avg 1100.
  var groundUsd = metrics.find(function (m) { return m.service_code === "GROUND" && m.currency === "USD"; });
  check("metricsForCarrier GROUND/USD count",      groundUsd && groundUsd.quote_count === 3);
  check("metricsForCarrier GROUND/USD min",        groundUsd.min_minor === 1000);
  check("metricsForCarrier GROUND/USD max",        groundUsd.max_minor === 1200);
  check("metricsForCarrier GROUND/USD avg",        groundUsd.avg_minor === 1100);

  // (NEXT_DAY, USD) — single row, min == max == avg.
  var nextDayUsd = metrics.find(function (m) { return m.service_code === "NEXT_DAY" && m.currency === "USD"; });
  check("metricsForCarrier NEXT_DAY/USD count",    nextDayUsd && nextDayUsd.quote_count === 1);
  check("metricsForCarrier NEXT_DAY/USD min",      nextDayUsd.min_minor === 4500);

  // (GROUND, EUR) — single row.
  var groundEur = metrics.find(function (m) { return m.service_code === "GROUND" && m.currency === "EUR"; });
  check("metricsForCarrier GROUND/EUR isolated",   groundEur && groundEur.quote_count === 1 && groundEur.min_minor === 900);

  // Bad input refused.
  await assert.rejects(ctx.rates.metricsForCarrier(null), /input object required/);
  await assert.rejects(ctx.rates.metricsForCarrier({ slug: "ups", from: FAR_FUTURE, to: 1 }), /to must be >= from/);
  await assert.rejects(ctx.rates.metricsForCarrier({ slug: "BAD-SLUG", from: 1, to: FAR_FUTURE }), /slug/);

  // Unknown carrier -> empty result (not an error; reporting against a
  // never-quoted carrier is a legitimate dashboard shape).
  var empty = await ctx.rates.metricsForCarrier({ slug: "never-registered", from: 1, to: FAR_FUTURE });
  check("metricsForCarrier unknown carrier -> []", empty.length === 0);
}

async function run() {
  await _registerCarrierHappyPath();
  await _registerCarrierInputRefusals();
  await _recordRateQuoteDedup();
  await _ratesForShipmentSortAndFallback();
  await _cleanupExpiredQuotes();
  await _recentQuotesPagination();
  await _metricsForCarrier();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/carrier-rates.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - carrier-rates (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
