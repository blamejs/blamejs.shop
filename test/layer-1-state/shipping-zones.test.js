"use strict";
/**
 * shippingZones — operator-defined regional rate tables.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0106_shipping_zones.sql`.
 *
 * Coverage:
 *   - defineZone with country-only region match
 *   - defineZone with country + region match
 *   - rateFor weight bucketing across [min_weight, max_weight) rows
 *   - rateFor order_value bucketing across [min_order, max_order) rows
 *   - rateFor returns multiple matching rates sorted by rate ASC
 *   - zoneForDestination nearest match (country+region beats country)
 *   - updateZone / archiveZone / listZones
 *   - factory + input validation refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var shippingZones = require("../../lib/shipping-zones");
var helpers       = require("../helpers");
var check         = helpers.check;
var assert        = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0106_shipping_zones.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  return async function (sql, params) {
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
  };
}

// ---- defineZone: country-only region match ----------------------------

async function _defineZoneCountryOnly() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  var z = await sz.defineZone({
    slug:    "domestic-us",
    title:   "Domestic US flat rate",
    regions: [{ country: "US" }],
    rates:   [
      { rate_minor: 500, currency: "USD", service_label: "Standard" },
    ],
  });

  check("defineZone country-only slug",            z.slug === "domestic-us");
  check("defineZone country-only title",           z.title === "Domestic US flat rate");
  check("defineZone country-only active default",  z.active === true);
  check("defineZone country-only archived null",   z.archived_at === null);
  check("defineZone country-only created_at int",  Number.isInteger(z.created_at));
  check("defineZone country-only regions len",     z.regions.length === 1);
  check("defineZone country-only regions country", z.regions[0].country === "US");
  check("defineZone country-only regions region",  z.regions[0].region === null);
  check("defineZone country-only rates len",       z.rates.length === 1);

  // Lookup: country-only entry covers any US destination (no region given).
  var slugA = await sz.zoneForDestination({ country: "US" });
  check("zoneForDestination US -> domestic-us",    slugA === "domestic-us");

  // Lookup: country-only entry ALSO covers US+CA (region given but only
  // a country-level entry exists — score 1 still beats nothing).
  var slugB = await sz.zoneForDestination({ country: "US", region: "CA" });
  check("zoneForDestination US/CA -> domestic-us", slugB === "domestic-us");

  // Lookup against a country NOT covered: null.
  var slugC = await sz.zoneForDestination({ country: "CA" });
  check("zoneForDestination CA -> null",           slugC === null);

  // rateFor surfaces the single rate row for a US destination.
  var rates = await sz.rateFor({
    destination_country: "US",
    weight_grams:        1000,
    order_minor:         5000,
    currency:            "USD",
  });
  check("rateFor country-only returns 1 row",      rates.length === 1);
  check("rateFor row zone_slug",                   rates[0].zone_slug === "domestic-us");
  check("rateFor row rate_minor",                  rates[0].rate_minor === 500);
  check("rateFor row currency",                    rates[0].currency === "USD");
  check("rateFor row service_label",               rates[0].service_label === "Standard");
}

// ---- defineZone: country + region match -------------------------------

async function _defineZoneCountryRegion() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  // Two zones: a broad US country zone, plus a CA-specific zone.
  // Most-specific match wins -> CA destination resolves to us-ca.
  await sz.defineZone({
    slug:    "domestic-us",
    title:   "Domestic US",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 700, currency: "USD", service_label: "Standard" }],
  });
  await sz.defineZone({
    slug:    "us-ca",
    title:   "California same-day",
    regions: [{ country: "US", region: "CA" }],
    rates:   [{ rate_minor: 200, currency: "USD", service_label: "Same Day" }],
  });

  var slugCA = await sz.zoneForDestination({ country: "US", region: "CA" });
  check("country+region beats country-only",       slugCA === "us-ca");

  // NY destination has no region-specific zone, falls back to country.
  var slugNY = await sz.zoneForDestination({ country: "US", region: "NY" });
  check("region without specific zone -> country", slugNY === "domestic-us");

  // Hydrated read carries the region field through JSON round-trip.
  var loaded = await sz.getZone("us-ca");
  check("getZone hydrates region code",            loaded.regions[0].region === "CA");
  check("getZone hydrates country code",           loaded.regions[0].country === "US");
}

// ---- rateFor: weight bucketing ----------------------------------------

async function _rateForWeightBuckets() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  // Three half-open weight buckets: [0,1000), [1000,5000), [5000,+inf).
  await sz.defineZone({
    slug:    "us-weight",
    title:   "US weight tiers",
    regions: [{ country: "US" }],
    rates:   [
      { min_weight_grams: 0,    max_weight_grams: 1000, rate_minor: 300, currency: "USD", service_label: "Light"  },
      { min_weight_grams: 1000, max_weight_grams: 5000, rate_minor: 800, currency: "USD", service_label: "Medium" },
      { min_weight_grams: 5000,                         rate_minor: 1500, currency: "USD", service_label: "Heavy" },
    ],
  });

  var rLight = await sz.rateFor({
    destination_country: "US", weight_grams: 500, order_minor: 1000, currency: "USD",
  });
  check("weight 500 -> Light only",                rLight.length === 1);
  check("weight 500 service_label",                rLight[0].service_label === "Light");

  // Boundary: weight = 1000 falls in the [1000,5000) bucket, NOT [0,1000).
  var rBoundary = await sz.rateFor({
    destination_country: "US", weight_grams: 1000, order_minor: 1000, currency: "USD",
  });
  check("weight 1000 boundary -> Medium",          rBoundary.length === 1);
  check("weight 1000 service_label",               rBoundary[0].service_label === "Medium");

  var rMedium = await sz.rateFor({
    destination_country: "US", weight_grams: 4999, order_minor: 1000, currency: "USD",
  });
  check("weight 4999 -> Medium",                   rMedium.length === 1 && rMedium[0].service_label === "Medium");

  // Open upper bound -> Heavy matches any weight >= 5000.
  var rHeavy = await sz.rateFor({
    destination_country: "US", weight_grams: 12000, order_minor: 1000, currency: "USD",
  });
  check("weight 12000 -> Heavy",                   rHeavy.length === 1 && rHeavy[0].service_label === "Heavy");

  // Currency mismatch: same weight, EUR -> no matches (currency-strict).
  var rEur = await sz.rateFor({
    destination_country: "US", weight_grams: 500, order_minor: 1000, currency: "EUR",
  });
  check("weight bucket EUR no match",              rEur.length === 0);
}

// ---- rateFor: order_value bucketing -----------------------------------

async function _rateForOrderBuckets() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  // Free-over-N pattern: small orders pay 500, big orders ship free.
  await sz.defineZone({
    slug:    "us-order",
    title:   "US order-value tiers",
    regions: [{ country: "US" }],
    rates:   [
      { min_order_minor: 0,    max_order_minor: 5000, rate_minor: 500, currency: "USD", service_label: "Standard" },
      { min_order_minor: 5000,                        rate_minor: 0,   currency: "USD", service_label: "Free over 50" },
    ],
  });

  var rSmall = await sz.rateFor({
    destination_country: "US", weight_grams: 100, order_minor: 1000, currency: "USD",
  });
  check("order 1000 -> Standard only",             rSmall.length === 1);
  check("order 1000 rate 500",                     rSmall[0].rate_minor === 500);

  // Boundary: 5000 -> falls in [5000, +inf), Free tier.
  var rBoundary = await sz.rateFor({
    destination_country: "US", weight_grams: 100, order_minor: 5000, currency: "USD",
  });
  check("order 5000 boundary -> Free",             rBoundary.length === 1);
  check("order 5000 rate 0",                       rBoundary[0].rate_minor === 0);

  var rLarge = await sz.rateFor({
    destination_country: "US", weight_grams: 100, order_minor: 99999, currency: "USD",
  });
  check("order 99999 -> Free",                     rLarge.length === 1 && rLarge[0].rate_minor === 0);

  // Rate with BOTH weight + order bounds only matches if BOTH fall in.
  var q2  = _makeQuery();
  var sz2 = shippingZones.create({ query: q2 });
  await sz2.defineZone({
    slug:    "us-combo",
    title:   "Combo rates",
    regions: [{ country: "US" }],
    rates:   [
      { min_weight_grams: 0, max_weight_grams: 1000, min_order_minor: 0, max_order_minor: 5000,
        rate_minor: 250, currency: "USD", service_label: "Light + small" },
    ],
  });
  // weight matches, order does NOT -> no match.
  var rNo = await sz2.rateFor({
    destination_country: "US", weight_grams: 500, order_minor: 10000, currency: "USD",
  });
  check("combo bounds AND semantics: no match",    rNo.length === 0);
  // both match -> match.
  var rYes = await sz2.rateFor({
    destination_country: "US", weight_grams: 500, order_minor: 1000, currency: "USD",
  });
  check("combo bounds AND semantics: matches",     rYes.length === 1);
}

// ---- rateFor: multiple matches sorted by rate ASC ---------------------

async function _rateForMultipleSorted() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  // Two ACTIVE zones cover the same destination (country-level + region-
  // level) — rateFor walks both and returns the merged list sorted by
  // rate_minor ASC then service_label ASC then zone_slug ASC.
  await sz.defineZone({
    slug:    "domestic-us",
    title:   "Domestic",
    regions: [{ country: "US" }],
    rates:   [
      { rate_minor: 1500, currency: "USD", service_label: "Express"  },
      { rate_minor:  500, currency: "USD", service_label: "Standard" },
    ],
  });
  await sz.defineZone({
    slug:    "us-ca",
    title:   "California",
    regions: [{ country: "US", region: "CA" }],
    rates:   [
      { rate_minor: 200, currency: "USD", service_label: "Same Day" },
    ],
  });

  var rates = await sz.rateFor({
    destination_country: "US",
    destination_region:  "CA",
    weight_grams:        100,
    order_minor:         1000,
    currency:            "USD",
  });
  check("merged rate list length",                 rates.length === 3);
  check("sorted ASC: row 0 cheapest",              rates[0].rate_minor === 200);
  check("sorted ASC: row 0 from us-ca",            rates[0].zone_slug === "us-ca");
  check("sorted ASC: row 1 Standard",              rates[1].rate_minor === 500 && rates[1].service_label === "Standard");
  check("sorted ASC: row 2 Express",               rates[2].rate_minor === 1500 && rates[2].service_label === "Express");

  // Paused (active=0) zone drops out of the lookup pool entirely.
  await sz.updateZone("us-ca", { active: false });
  var paused = await sz.rateFor({
    destination_country: "US",
    destination_region:  "CA",
    weight_grams:        100,
    order_minor:         1000,
    currency:            "USD",
  });
  check("paused zone excluded from rateFor",       paused.length === 2);
  check("paused zone first row 500",               paused[0].rate_minor === 500);
}

// ---- zoneForDestination nearest match ---------------------------------

async function _zoneForDestinationNearest() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  // Three zones at varying specificity for the same country.
  await sz.defineZone({
    slug:    "z-country",
    title:   "Country level",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 100, currency: "USD", service_label: "S" }],
  });
  await sz.defineZone({
    slug:    "z-region-ca",
    title:   "Region CA",
    regions: [{ country: "US", region: "CA" }],
    rates:   [{ rate_minor: 100, currency: "USD", service_label: "S" }],
  });
  await sz.defineZone({
    slug:    "z-region-ny",
    title:   "Region NY",
    regions: [{ country: "US", region: "NY" }],
    rates:   [{ rate_minor: 100, currency: "USD", service_label: "S" }],
  });

  check("CA -> region",  (await sz.zoneForDestination({ country: "US", region: "CA" })) === "z-region-ca");
  check("NY -> region",  (await sz.zoneForDestination({ country: "US", region: "NY" })) === "z-region-ny");
  // No region -> country level.
  check("US no region",  (await sz.zoneForDestination({ country: "US" })) === "z-country");
  // Unknown region in covered country -> falls back to country level.
  check("US/TX -> country", (await sz.zoneForDestination({ country: "US", region: "TX" })) === "z-country");
  // Uncovered country -> null.
  check("DE -> null",    (await sz.zoneForDestination({ country: "DE" })) === null);

  // Archived zone drops out of routing.
  await sz.archiveZone("z-region-ca");
  check("CA after archive -> country",
    (await sz.zoneForDestination({ country: "US", region: "CA" })) === "z-country");

  // Tie-break: two equally-specific zones cover the same destination ->
  // slug ASC wins (deterministic).
  var q2  = _makeQuery();
  var sz2 = shippingZones.create({ query: q2 });
  await sz2.defineZone({
    slug:    "zone-b",
    title:   "B",
    regions: [{ country: "US", region: "CA" }],
    rates:   [{ rate_minor: 100, currency: "USD", service_label: "S" }],
  });
  await sz2.defineZone({
    slug:    "zone-a",
    title:   "A",
    regions: [{ country: "US", region: "CA" }],
    rates:   [{ rate_minor: 100, currency: "USD", service_label: "S" }],
  });
  check("tie-break slug ASC",
    (await sz2.zoneForDestination({ country: "US", region: "CA" })) === "zone-a");
}

// ---- updateZone / archiveZone / listZones -----------------------------

async function _updateArchiveList() {
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });

  await sz.defineZone({
    slug:    "u",
    title:   "Original",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 500, currency: "USD", service_label: "Standard" }],
  });
  await sz.defineZone({
    slug:    "paused-zone",
    title:   "Paused",
    regions: [{ country: "DE" }],
    rates:   [{ rate_minor: 700, currency: "EUR", service_label: "Standard" }],
    active:  false,
  });

  // List defaults: both live (non-archived) zones, active=true and paused.
  var all = await sz.listZones();
  check("listZones default returns 2",            all.length === 2);
  // Slug ASC ordering.
  check("listZones order paused-zone first",      all[0].slug === "paused-zone");
  check("listZones order u second",               all[1].slug === "u");

  // active_only filter excludes paused.
  var actives = await sz.listZones({ active_only: true });
  check("listZones active_only excludes paused",  actives.length === 1);
  check("listZones active_only slug",             actives[0].slug === "u");

  // updateZone: patch every column.
  var upd = await sz.updateZone("u", {
    title:   "Renamed",
    regions: [{ country: "US" }, { country: "CA" }],
    rates:   [
      { rate_minor: 250, currency: "USD", service_label: "Cheap" },
      { rate_minor: 999, currency: "USD", service_label: "Pricey" },
    ],
    active:  true,
  });
  check("update title applied",                   upd.title === "Renamed");
  check("update regions applied",                 upd.regions.length === 2);
  check("update second region country",           upd.regions[1].country === "CA");
  check("update rates applied",                   upd.rates.length === 2);
  check("update first rate",                      upd.rates[0].rate_minor === 250);
  check("update active still true",               upd.active === true);
  check("update updated_at advanced",             upd.updated_at >= upd.created_at);

  // updateZone non-existent slug -> null (not a throw).
  var missing = await sz.updateZone("nope", { title: "x" });
  check("update missing returns null",            missing === null);

  // updateZone rejects unknown columns and empty patch.
  await assert.rejects(sz.updateZone("u", {}),
                       /at least one column/);
  await assert.rejects(sz.updateZone("u", { slug: "renamed" }),
                       /not updatable/);
  await assert.rejects(sz.updateZone("u", { created_at: 0 }),
                       /not updatable/);

  // updateZone validates new values.
  await assert.rejects(sz.updateZone("u", { title: "" }),       /title/);
  await assert.rejects(sz.updateZone("u", { regions: [] }),     /regions/);
  await assert.rejects(sz.updateZone("u", { rates: [] }),       /rates/);
  await assert.rejects(sz.updateZone("u", { active: "yes" }),   /active/);

  // archiveZone: stamps archived_at and forces active=0.
  var arch = await sz.archiveZone("u");
  check("archive flips active false",             arch.active === false);
  check("archive sets archived_at",               arch.archived_at != null);
  check("archive preserves regions snapshot",     arch.regions.length === 2);

  // archiveZone is idempotent.
  var archAgain = await sz.archiveZone("u");
  check("archive idempotent archived_at",         archAgain.archived_at === arch.archived_at);
  check("archive idempotent active false",        archAgain.active === false);

  // archived zone refuses updates.
  await assert.rejects(sz.updateZone("u", { title: "no" }),
                       /archived/);

  // archived zone refuses defineZone reuse of the slug.
  await assert.rejects(sz.defineZone({
    slug:    "u",
    title:   "rebirth",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /already exists/);

  // archive missing slug -> null (not a throw).
  var archMissing = await sz.archiveZone("nothing");
  check("archive missing returns null",           archMissing === null);

  // listZones default still shows non-archived (paused-zone) but hides
  // archived rows.
  var afterArchive = await sz.listZones();
  check("listZones hides archived",               afterArchive.length === 1);
  check("listZones remaining slug",               afterArchive[0].slug === "paused-zone");

  // getZone returns the archived row (for audit history).
  var got = await sz.getZone("u");
  check("getZone returns archived row",           got != null);
  check("getZone archived archived_at",           got.archived_at != null);

  // getZone missing -> null.
  var none = await sz.getZone("never-existed");
  check("getZone missing returns null",           none === null);
}

// ---- factory + input validation refusals ------------------------------

async function _factoryAndInputRefusals() {
  // Factory accepts a custom query and returns the surface.
  var q  = _makeQuery();
  var sz = shippingZones.create({ query: q });
  check("factory returns surface",                typeof sz.defineZone === "function");
  check("factory exposes SLUG_RE",                sz.SLUG_RE instanceof RegExp);
  check("factory exposes COUNTRY_RE",             sz.COUNTRY_RE instanceof RegExp);
  check("factory exposes REGION_RE",              sz.REGION_RE instanceof RegExp);
  check("factory exposes MAX_REGIONS",            sz.MAX_REGIONS === shippingZones.MAX_REGIONS);
  check("factory exposes MAX_RATES",              sz.MAX_RATES === shippingZones.MAX_RATES);

  // Factory zero-args works too (when called without options it falls
  // back to the framework's externalDb at call time — we never call,
  // we just confirm construction).
  var sz0 = shippingZones.create();
  check("factory zero-args constructs",           typeof sz0.defineZone === "function");

  // defineZone refusals
  await assert.rejects(sz.defineZone(),
                       /input object required/);
  await assert.rejects(sz.defineZone({
    slug: "BAD SLUG", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /slug/);
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /title/);
  // Control char in title.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "bad title",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /title/);
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /regions/);
  // Bad country shape.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "us" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /country/);
  // Bad region shape.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US", region: "california" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /region/);
  // Duplicate region entries.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }, { country: "US" }],
    rates:   [{ rate_minor: 1, currency: "USD", service_label: "X" }],
  }), /duplicates/);
  // Empty rates.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [],
  }), /rates/);
  // Negative rate_minor.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: -1, currency: "USD", service_label: "X" }],
  }), /rate_minor/);
  // Bad currency.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 0, currency: "usd", service_label: "X" }],
  }), /currency/);
  // Empty service_label.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 0, currency: "USD", service_label: "" }],
  }), /service_label/);
  // min >= max weight.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ min_weight_grams: 500, max_weight_grams: 500, rate_minor: 0, currency: "USD", service_label: "X" }],
  }), /min_weight_grams/);
  // min >= max order.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ min_order_minor: 5000, max_order_minor: 1000, rate_minor: 0, currency: "USD", service_label: "X" }],
  }), /min_order_minor/);
  // active not a boolean.
  await assert.rejects(sz.defineZone({
    slug: "ok", title: "x",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 0, currency: "USD", service_label: "X" }],
    active:  "yes",
  }), /active/);

  // Duplicate slug refusal.
  await sz.defineZone({
    slug: "dup", title: "first",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 0, currency: "USD", service_label: "X" }],
  });
  await assert.rejects(sz.defineZone({
    slug: "dup", title: "second",
    regions: [{ country: "US" }],
    rates:   [{ rate_minor: 0, currency: "USD", service_label: "X" }],
  }), /already exists/);

  // getZone validates slug shape.
  await assert.rejects(sz.getZone("BAD"), /slug/);
  await assert.rejects(sz.getZone(""), /slug/);

  // zoneForDestination input refusals.
  await assert.rejects(sz.zoneForDestination(),
                       /input object required/);
  await assert.rejects(sz.zoneForDestination({ country: "us" }),
                       /country/);
  await assert.rejects(sz.zoneForDestination({ country: "US", region: "california" }),
                       /region/);

  // rateFor input refusals.
  await assert.rejects(sz.rateFor(),
                       /input object required/);
  await assert.rejects(sz.rateFor({
    destination_country: "us", weight_grams: 0, order_minor: 0, currency: "USD",
  }), /destination_country/);
  await assert.rejects(sz.rateFor({
    destination_country: "US", weight_grams: -1, order_minor: 0, currency: "USD",
  }), /weight_grams/);
  await assert.rejects(sz.rateFor({
    destination_country: "US", weight_grams: 1.5, order_minor: 0, currency: "USD",
  }), /weight_grams/);
  await assert.rejects(sz.rateFor({
    destination_country: "US", weight_grams: 0, order_minor: -1, currency: "USD",
  }), /order_minor/);
  await assert.rejects(sz.rateFor({
    destination_country: "US", weight_grams: 0, order_minor: 0, currency: "usd",
  }), /currency/);

  // updateZone refusals on bad slug.
  await assert.rejects(sz.updateZone("BAD", { title: "x" }), /slug/);
  await assert.rejects(sz.updateZone("ok"),                  /patch/);

  // archiveZone validates slug.
  await assert.rejects(sz.archiveZone("BAD"), /slug/);
}

async function run() {
  await _defineZoneCountryOnly();
  await _defineZoneCountryRegion();
  await _rateForWeightBuckets();
  await _rateForOrderBuckets();
  await _rateForMultipleSorted();
  await _zoneForDestinationNearest();
  await _updateArchiveList();
  await _factoryAndInputRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - shipping-zones (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - shipping-zones: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
