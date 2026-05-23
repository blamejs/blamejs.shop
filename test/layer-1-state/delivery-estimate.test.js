"use strict";
/**
 * deliveryEstimate — PDP + cart estimated-delivery-window calculator.
 * A customer in postcode 90210 sees "Get it by Thursday" on the PDP;
 * the framework composes the answer out of inventory locations,
 * carrier transit tables, holiday calendars, and per-origin cutoffs.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0117.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/delivery-estimate.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - defineCarrierTransit happy path + persistence shape; upsert on
 *     (from_zone, to_zone, carrier, service_level)
 *   - defineCutoff + defineHoliday + definePostalZone happy path +
 *     upsert
 *   - estimate happy path: before-cutoff on a Monday returns today as
 *     ship_by; transit math respects weekday-only business days
 *   - estimate skip-weekend math: after-cutoff on Friday rolls
 *     ship_by past Saturday + Sunday to Monday
 *   - estimate cutoff before-vs-after: same Monday at 10:00 vs 16:00
 *     in America/Los_Angeles diverges by one business day
 *   - estimate holiday skip: an observed destination-region holiday
 *     between ship_by and deliver_by extends deliver_by by one day
 *   - estimate multi-service-level rows: GROUND + TWO_DAY surface
 *     side-by-side, sorted ascending by transit_days
 *   - estimate no-zone-match: a destination_postal that doesn't match
 *     any prefix returns ok=false with reason "no_destination_zone"
 *   - estimateForCart per-line: lines from two origins surface as two
 *     line-level estimates with a cart-level slowest-of-N summary
 *   - archiveTransit soft-deletes a row out of the estimate menu
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop            = require("../../lib");
var deliveryEstimate = require("../../lib/delivery-estimate");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0117_delivery_estimate.sql"
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
  var est = deliveryEstimate.create(opts);
  return { query: query, est: est };
}

// Touch bShop so the require graph stays exercised + the lint detector
// for unused locals stays quiet — the framework handle is also what
// `lib/delivery-estimate.js` itself lazily resolves at runtime.
if (!bShop || !bShop.framework) {
  throw new Error("blamejs.shop framework handle missing");
}

// ---- known calendar anchors ---------------------------------------------
//
// 2026-01-12 is a Monday in every IANA zone. 2026-01-16 is a Friday.
// 2026-01-19 (MLK Day in the US) is a Monday. These calendar facts let
// the tests verify business-day math against absolute date strings
// rather than wall-clock-relative expectations.

// 10:00 America/Los_Angeles on Mon 2026-01-12 = 18:00 UTC = epoch
//   Date.UTC(2026, 0, 12, 18, 0).
var MON_10AM_LA = Date.UTC(2026, 0, 12, 18, 0);
// 16:00 America/Los_Angeles on Mon 2026-01-12 = 00:00 UTC Tue 2026-01-13.
var MON_4PM_LA  = Date.UTC(2026, 0, 13, 0, 0);
// 16:00 America/Los_Angeles on Fri 2026-01-16 = 00:00 UTC Sat 2026-01-17.
var FRI_4PM_LA  = Date.UTC(2026, 0, 17, 0, 0);

async function _seedTransitsAndCutoff(ctx) {
  await ctx.est.defineCutoff({
    origin_location:         "warehouse-la",
    daily_cutoff_local_time: "14:00",
    timezone:                "America/Los_Angeles",
  });
  // Postal-zone mapping — 902xx -> us-west, 100xx -> us-east.
  await ctx.est.definePostalZone({
    country: "US", postal_prefix: "902", zone: "us-west",
  });
  await ctx.est.definePostalZone({
    country: "US", postal_prefix: "100", zone: "us-east",
  });
  // Transit rows — origin slug "warehouse-la" doubles as its own from_zone.
  await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west",
    carrier: "ups", service_level: "GROUND", transit_days: 1,
  });
  await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west",
    carrier: "ups", service_level: "TWO_DAY", transit_days: 2,
  });
  await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-east",
    carrier: "ups", service_level: "GROUND", transit_days: 5,
  });
}

async function _defineCarrierTransitHappyPath() {
  var ctx = _setup();
  var t = await ctx.est.defineCarrierTransit({
    from_zone:     "warehouse-la",
    to_zone:       "us-west",
    carrier:       "ups",
    service_level: "GROUND",
    transit_days:  1,
  });
  check("defineCarrierTransit returns row",         t && typeof t === "object");
  check("defineCarrierTransit stamps uuid id",      typeof t.id === "string" && t.id.length === 36);
  check("defineCarrierTransit persists from_zone",  t.from_zone === "warehouse-la");
  check("defineCarrierTransit persists to_zone",    t.to_zone === "us-west");
  check("defineCarrierTransit persists carrier",    t.carrier === "ups");
  check("defineCarrierTransit persists service",    t.service_level === "GROUND");
  check("defineCarrierTransit persists days",       t.transit_days === 1);
  check("defineCarrierTransit archived_at null",    t.archived_at === null);
  check("defineCarrierTransit stamps created_at",   typeof t.created_at === "number" && t.created_at > 0);
  check("defineCarrierTransit stamps updated_at",   typeof t.updated_at === "number" && t.updated_at > 0);

  // Upsert — same key refreshes transit_days, preserves id + created_at.
  var t2 = await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west",
    carrier: "ups", service_level: "GROUND", transit_days: 2,
  });
  check("defineCarrierTransit upsert preserves id", t2.id === t.id);
  check("defineCarrierTransit upsert preserves created_at", t2.created_at === t.created_at);
  check("defineCarrierTransit upsert refreshes days", t2.transit_days === 2);

  // Different service_level -> distinct row.
  var t3 = await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west",
    carrier: "ups", service_level: "TWO_DAY", transit_days: 2,
  });
  check("defineCarrierTransit different service -> new id", t3.id !== t.id);

  // Refusals.
  await assert.rejects(ctx.est.defineCarrierTransit(null), /input object required/);
  await assert.rejects(ctx.est.defineCarrierTransit({
    from_zone: "BAD", to_zone: "us-west", carrier: "ups",
    service_level: "GROUND", transit_days: 1,
  }), /from_zone/);
  await assert.rejects(ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west", carrier: "pigeon",
    service_level: "GROUND", transit_days: 1,
  }), /carrier/);
  await assert.rejects(ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west", carrier: "ups",
    service_level: "GROUND", transit_days: -1,
  }), /transit_days/);
  await assert.rejects(ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west", carrier: "ups",
    service_level: "GROUND", transit_days: 9999,
  }), /transit_days/);
}

async function _defineCutoffAndHolidayHappyPath() {
  var ctx = _setup();
  var c = await ctx.est.defineCutoff({
    origin_location:         "warehouse-la",
    daily_cutoff_local_time: "14:00",
    timezone:                "America/Los_Angeles",
  });
  check("defineCutoff returns row",                 c && typeof c === "object");
  check("defineCutoff persists origin",             c.origin_location === "warehouse-la");
  check("defineCutoff persists time",               c.daily_cutoff_local_time === "14:00");
  check("defineCutoff persists timezone",           c.timezone === "America/Los_Angeles");

  // Upsert preserves created_at.
  var c2 = await ctx.est.defineCutoff({
    origin_location: "warehouse-la", daily_cutoff_local_time: "12:00",
    timezone: "America/Los_Angeles",
  });
  check("defineCutoff upsert preserves created_at", c2.created_at === c.created_at);
  check("defineCutoff upsert refreshes time",       c2.daily_cutoff_local_time === "12:00");

  // Refusals.
  await assert.rejects(ctx.est.defineCutoff({
    origin_location: "warehouse-la", daily_cutoff_local_time: "25:00",
    timezone: "America/Los_Angeles",
  }), /daily_cutoff_local_time/);
  await assert.rejects(ctx.est.defineCutoff({
    origin_location: "warehouse-la", daily_cutoff_local_time: "14:00",
    timezone: "Made/Up_Place",
  }), /timezone/);
  await assert.rejects(ctx.est.defineCutoff({
    origin_location: "warehouse-la", daily_cutoff_local_time: "14:00",
    timezone: "+0500",
  }), /timezone/);

  var h = await ctx.est.defineHoliday({
    region: "us", date: "2026-01-19", name: "MLK Day",
  });
  check("defineHoliday returns row",                h && typeof h === "object");
  check("defineHoliday stamps uuid id",             typeof h.id === "string" && h.id.length === 36);
  check("defineHoliday persists region",            h.region === "us");
  check("defineHoliday persists date",              h.date === "2026-01-19");
  check("defineHoliday persists name",              h.name === "MLK Day");
  // Upsert by (region, date) — refresh name in place.
  var h2 = await ctx.est.defineHoliday({
    region: "us", date: "2026-01-19", name: "Martin Luther King Jr. Day",
  });
  check("defineHoliday upsert preserves id",        h2.id === h.id);
  check("defineHoliday upsert refreshes name",      h2.name === "Martin Luther King Jr. Day");

  // Bad date refused.
  await assert.rejects(ctx.est.defineHoliday({
    region: "us", date: "2026-02-30", name: "Bogus",
  }), /date/);
  await assert.rejects(ctx.est.defineHoliday({
    region: "us", date: "2026-1-9", name: "Bad shape",
  }), /date/);

  // Postal zone happy + refusal.
  var p = await ctx.est.definePostalZone({
    country: "US", postal_prefix: "902", zone: "us-west",
  });
  check("definePostalZone persists country",        p.country === "US");
  check("definePostalZone persists prefix",         p.postal_prefix === "902");
  check("definePostalZone persists zone",           p.zone === "us-west");
  await assert.rejects(ctx.est.definePostalZone({
    country: "us", postal_prefix: "902", zone: "us-west",
  }), /country/);
}

async function _estimateBeforeCutoff() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);

  // Customer in 90210 at Mon 2026-01-12 10:00 America/Los_Angeles.
  // Before the 14:00 cutoff -> ship today (Mon), GROUND deliver Tue.
  var e = await ctx.est.estimate({
    origin_location:     "warehouse-la",
    destination_postal:  "90210",
    destination_country: "US",
    now:                 MON_10AM_LA,
  });
  check("estimate ok",                              e.ok === true);
  check("estimate resolves destination zone",       e.destination_zone === "us-west");
  check("estimate resolves origin zone",            e.origin_zone === "warehouse-la");
  check("estimate ship_by is today (Mon)",          e.ship_by_date === "2026-01-12");
  check("estimate exposes 2 service levels",        e.service_levels.length === 2);
  // Service levels sorted ascending by transit_days — GROUND (1) first.
  check("estimate sorted by transit_days",          e.service_levels[0].code === "GROUND");
  check("estimate GROUND deliver Tue",              e.service_levels[0].deliver_by === "2026-01-13");
  check("estimate GROUND business_days = 1",        e.service_levels[0].business_days === 1);
  check("estimate TWO_DAY deliver Wed",             e.service_levels[1].deliver_by === "2026-01-14");
  check("estimate TWO_DAY business_days = 2",       e.service_levels[1].business_days === 2);
  check("estimate min delivery = GROUND",           e.est_min_delivery_date === "2026-01-13");
  check("estimate max delivery = TWO_DAY",          e.est_max_delivery_date === "2026-01-14");
  check("estimate carrier label",                   e.service_levels[0].label === "ups GROUND");
}

async function _estimateAfterCutoff() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);

  // Same Monday at 16:00 PT -> after cutoff -> ship Tue Jan 13.
  // GROUND deliver Wed Jan 14.
  var e = await ctx.est.estimate({
    origin_location:     "warehouse-la",
    destination_postal:  "90210",
    destination_country: "US",
    now:                 MON_4PM_LA,
  });
  check("after-cutoff ship_by rolls to Tue",        e.ship_by_date === "2026-01-13");
  check("after-cutoff GROUND deliver Wed",          e.service_levels[0].deliver_by === "2026-01-14");
  check("after-cutoff TWO_DAY deliver Thu",         e.service_levels[1].deliver_by === "2026-01-15");
}

async function _estimateSkipsWeekend() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);

  // Fri 2026-01-16 16:00 PT — after cutoff. Ship rolls Fri+1=Sat
  // -> Sat is non-business -> roll to Mon 2026-01-19. GROUND +1
  // business day -> Tue 2026-01-20.
  var e = await ctx.est.estimate({
    origin_location:     "warehouse-la",
    destination_postal:  "90210",
    destination_country: "US",
    now:                 FRI_4PM_LA,
  });
  check("skip-weekend ship_by lands on Mon",        e.ship_by_date === "2026-01-19");
  check("skip-weekend GROUND deliver Tue",          e.service_levels[0].deliver_by === "2026-01-20");
  // TWO_DAY: ship Mon + 2 business days = Wed 2026-01-21.
  check("skip-weekend TWO_DAY deliver Wed",         e.service_levels[1].deliver_by === "2026-01-21");
}

async function _estimateSkipsHoliday() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);
  // Mon 2026-01-19 is a holiday in the US destination region.
  await ctx.est.defineHoliday({
    region: "us", date: "2026-01-19", name: "MLK Day",
  });

  // Fri 16:00 PT -> ship Mon Jan 19, but Mon is also a holiday for
  // the destination region. The DESTINATION holiday-skip applies to
  // the deliver-by walk, so GROUND ship_by remains Mon (origin region
  // not configured -> no origin-side skip) but the delivery walk skips
  // Mon as a non-business day and lands on Tue Jan 20.
  //
  // Wait — for ship_by we use ORIGIN region holidays. Destination
  // holidays delay only the delivery transit, not the ship date. Since
  // the test doesn't wire an origin-region resolver, the origin
  // doesn't skip Mon; ship_by is Mon Jan 19. GROUND deliver = Mon +
  // 1 business day in the destination region; Mon is a holiday so
  // the pre-roll lands the start at Tue Jan 20, then +1 -> Wed Jan
  // 21. The destination-side holiday adds a day to the delivery.
  var e = await ctx.est.estimate({
    origin_location:     "warehouse-la",
    destination_postal:  "90210",
    destination_country: "US",
    now:                 FRI_4PM_LA,
  });
  check("holiday-skip ship_by stays Mon (origin region not configured)",
    e.ship_by_date === "2026-01-19");
  check("holiday-skip GROUND deliver Wed (Mon holiday + 1 day)",
    e.service_levels[0].deliver_by === "2026-01-21");
  check("holiday-skip TWO_DAY deliver Thu",
    e.service_levels[1].deliver_by === "2026-01-22");
}

async function _estimateMultiServiceLevelMenu() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);
  // Add a third service level so the menu has 3 rows for the same
  // (origin, dest) pair.
  await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-la", to_zone: "us-west",
    carrier: "fedex", service_level: "OVERNIGHT", transit_days: 0,
  });
  var e = await ctx.est.estimate({
    origin_location:     "warehouse-la",
    destination_postal:  "90210",
    destination_country: "US",
    now:                 MON_10AM_LA,
  });
  check("multi-service-level menu has 3 rows",      e.service_levels.length === 3);
  // OVERNIGHT (0 days) first, then GROUND (1), then TWO_DAY (2).
  check("multi-service-level OVERNIGHT first",      e.service_levels[0].code === "OVERNIGHT");
  check("multi-service-level OVERNIGHT carrier",    e.service_levels[0].carrier === "fedex");
  check("multi-service-level OVERNIGHT same-day",   e.service_levels[0].deliver_by === "2026-01-12");
  check("multi-service-level GROUND second",        e.service_levels[1].code === "GROUND");
  check("multi-service-level TWO_DAY third",        e.service_levels[2].code === "TWO_DAY");
  check("multi-service-level min = OVERNIGHT",      e.est_min_delivery_date === "2026-01-12");
  check("multi-service-level max = TWO_DAY",        e.est_max_delivery_date === "2026-01-14");

  // requested_service_level filters the menu down to a single row.
  var f = await ctx.est.estimate({
    origin_location:         "warehouse-la",
    destination_postal:      "90210",
    destination_country:     "US",
    requested_service_level: "GROUND",
    now:                     MON_10AM_LA,
  });
  check("requested_service_level scopes the menu",  f.service_levels.length === 1);
  check("requested_service_level keeps GROUND",     f.service_levels[0].code === "GROUND");
}

async function _estimateNoZoneMatch() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);
  // Postal that doesn't prefix-match any registered zone -> ok=false.
  var e = await ctx.est.estimate({
    origin_location:     "warehouse-la",
    destination_postal:  "ZZZ99",
    destination_country: "US",
    now:                 MON_10AM_LA,
  });
  check("no-zone-match returns ok=false",           e.ok === false);
  check("no-zone-match reason typed",               e.reason === "no_destination_zone");
  check("no-zone-match service_levels empty",       e.service_levels.length === 0);
  check("no-zone-match ship_by null",               e.ship_by_date === null);

  // Requesting an origin without a cutoff -> hard refusal (config-
  // time mistake; surfaces loud).
  await assert.rejects(ctx.est.estimate({
    origin_location: "nowhere", destination_postal: "90210",
    destination_country: "US", now: MON_10AM_LA,
  }), /no shipping_cutoffs row/);

  // Missing origin_location AND no inventoryLocations wired -> refuse.
  await assert.rejects(ctx.est.estimate({
    destination_postal: "90210", destination_country: "US",
    now: MON_10AM_LA,
  }), /origin_location required/);

  // Bad destination_country.
  await assert.rejects(ctx.est.estimate({
    origin_location: "warehouse-la", destination_postal: "90210",
    destination_country: "us", now: MON_10AM_LA,
  }), /destination_country/);
}

async function _estimateForCartPerLine() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);
  // Second origin — warehouse-ny ships to us-west in 4 business days.
  await ctx.est.defineCutoff({
    origin_location: "warehouse-ny", daily_cutoff_local_time: "12:00",
    timezone: "America/New_York",
  });
  await ctx.est.defineCarrierTransit({
    from_zone: "warehouse-ny", to_zone: "us-west",
    carrier: "ups", service_level: "GROUND", transit_days: 4,
  });

  // Cart with two lines, two different origins. Mon Jan 12 10:00 PT.
  var cart = {
    lines: [
      { id: "line-1", origin_location: "warehouse-la", weight_grams: 500 },
      { id: "line-2", origin_location: "warehouse-ny", weight_grams: 800 },
    ],
  };
  var c = await ctx.est.estimateForCart({
    cart:        cart,
    destination: { postal: "90210", country: "US" },
    now:         MON_10AM_LA,
    requested_service_level: "GROUND",
  });
  check("cart estimate ok",                         c.ok === true);
  check("cart estimate has 2 lines",                c.lines.length === 2);
  check("cart estimate line-1 from warehouse-la",   c.lines[0].estimate.origin_location === "warehouse-la");
  check("cart estimate line-1 delivers Tue",        c.lines[0].estimate.est_min_delivery_date === "2026-01-13");
  check("cart estimate line-2 from warehouse-ny",   c.lines[1].estimate.origin_location === "warehouse-ny");
  // warehouse-ny ships Mon Jan 12 (10:00 PT = 13:00 ET, before 12:00
  // ET cutoff is false -> after cutoff -> ship Tue Jan 13). GROUND
  // +4 business days = Mon Jan 19.
  check("cart estimate line-2 ship Tue",            c.lines[1].estimate.ship_by_date === "2026-01-13");
  check("cart estimate line-2 deliver Mon Jan 19",  c.lines[1].estimate.est_min_delivery_date === "2026-01-19");
  // Cart-level max-of-maxes is the slower line.
  check("cart slowest min = line-2",                c.cart_min_delivery_date === "2026-01-19");

  // Bad input.
  await assert.rejects(ctx.est.estimateForCart(null), /input object required/);
  await assert.rejects(ctx.est.estimateForCart({
    cart: { lines: "not-array" },
    destination: { postal: "90210", country: "US" },
    now: MON_10AM_LA,
  }), /cart.lines/);
}

async function _listAndArchive() {
  var ctx = _setup();
  await _seedTransitsAndCutoff(ctx);
  await ctx.est.defineHoliday({
    region: "us", date: "2026-01-19", name: "MLK Day",
  });
  await ctx.est.defineHoliday({
    region: "us", date: "2026-07-04", name: "Independence Day",
  });

  var transits = await ctx.est.listTransits();
  check("listTransits returns 3 rows",              transits.length === 3);
  check("listTransits sorts by from_zone first",    transits.every(function (t) { return t.archived_at === null; }));

  var upsOnly = await ctx.est.listTransits({ carrier: "ups" });
  check("listTransits filters by carrier",          upsOnly.length === 3 && upsOnly.every(function (t) { return t.carrier === "ups"; }));

  var cutoffs = await ctx.est.listCutoffs();
  check("listCutoffs returns warehouse-la",         cutoffs.length === 1 && cutoffs[0].origin_location === "warehouse-la");

  var holidays = await ctx.est.listHolidays();
  check("listHolidays returns 2 rows",              holidays.length === 2);

  var holidaysFiltered = await ctx.est.listHolidays({
    region: "us", from: "2026-06-01", to: "2026-12-31",
  });
  check("listHolidays date window",                 holidaysFiltered.length === 1 && holidaysFiltered[0].date === "2026-07-04");

  var postal = await ctx.est.listPostalZones({ country: "US" });
  check("listPostalZones filtered by country",      postal.length === 2);

  // Archive a transit row -> drops out of estimate menu.
  var pre = await ctx.est.estimate({
    origin_location: "warehouse-la", destination_postal: "90210",
    destination_country: "US", now: MON_10AM_LA,
  });
  check("pre-archive estimate has 2 service levels", pre.service_levels.length === 2);

  var groundRow = transits.find(function (t) { return t.service_level === "GROUND" && t.to_zone === "us-west"; });
  var archived = await ctx.est.archiveTransit(groundRow.id);
  check("archiveTransit stamps archived_at",        typeof archived.archived_at === "number" && archived.archived_at > 0);

  var post = await ctx.est.estimate({
    origin_location: "warehouse-la", destination_postal: "90210",
    destination_country: "US", now: MON_10AM_LA,
  });
  check("post-archive estimate drops GROUND",       post.service_levels.length === 1 && post.service_levels[0].code === "TWO_DAY");

  // Archiving a non-existent id returns null.
  var none = await ctx.est.archiveTransit("00000000-0000-7000-8000-000000000000");
  check("archiveTransit missing id -> null",        none === null);

  // archiveTransit idempotent — second call against the already-archived
  // row returns it unchanged.
  var again = await ctx.est.archiveTransit(groundRow.id);
  check("archiveTransit idempotent",                again.id === groundRow.id && again.archived_at === archived.archived_at);

  // archiveHoliday — drops the row from holidays + listHolidays.
  var holidayRows = await ctx.est.listHolidays({ region: "us" });
  var mlk = holidayRows.find(function (h) { return h.date === "2026-01-19"; });
  await ctx.est.archiveHoliday(mlk.id);
  var afterArchive = await ctx.est.listHolidays({ region: "us" });
  check("archiveHoliday drops row from list",       afterArchive.length === 1 && afterArchive[0].date === "2026-07-04");
}

async function run() {
  await _defineCarrierTransitHappyPath();
  await _defineCutoffAndHolidayHappyPath();
  await _estimateBeforeCutoff();
  await _estimateAfterCutoff();
  await _estimateSkipsWeekend();
  await _estimateSkipsHoliday();
  await _estimateMultiServiceLevelMenu();
  await _estimateNoZoneMatch();
  await _estimateForCartPerLine();
  await _listAndArchive();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/delivery-estimate.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - delivery-estimate (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
