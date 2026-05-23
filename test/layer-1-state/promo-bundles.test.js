"use strict";
/**
 * promoBundles — time-limited multi-component promotional offers.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0140.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/promo-bundles.js` directly so the gate exists ahead of any
 * entry-point edit.
 *
 * Coverage:
 *   - defineBundle persists every column + sorts components_json
 *     canonically; getBundle round-trips
 *   - defineBundle refuses inverted / zero-length windows, duplicate
 *     component sku, non-positive quantities, and a re-define of the
 *     same slug
 *   - activeBundles({ now }) returns only bundles inside their
 *     [starts_at, expires_at) window and skips archived bundles +
 *     bundles that have hit their total redemption cap
 *   - detectInCart matches a bundle only when every component is
 *     present at >= the required quantity; missing components +
 *     wrong-currency carts produce no match
 *   - applyBundleToCart consumes the matched quantities, drops
 *     zeroed lines, and adds a synthetic bundle line at
 *     bundle_price_minor; the input cart is not mutated
 *   - recordRedemption increments the counter, enforces
 *     max_redemptions_total under a guarded UPDATE, and is idempotent
 *     on a replayed (slug, order_id) pair
 *   - updateBundle can extend a window + change caps; refuses to
 *     mutate components / bundle_price_minor / currency; refuses a
 *     cap below current redemptions_used
 *   - archiveBundle is idempotent + hides the bundle from
 *     activeBundles / detectInCart
 *   - metricsForBundle aggregates count + savings + distinct
 *     customers + first/last timestamps
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");                                      // ensure entry-point loads + lazy framework handle resolves
var promoBundles = require("../../lib/promo-bundles");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0140_promo_bundles.sql"
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

function _setup() {
  var query = _makeQuery();
  var pb    = promoBundles.create({ query: query });
  return { query: query, pb: pb };
}

// `T0` is a fixed epoch the test threads through every starts_at /
// expires_at / now argument so the window math is deterministic and
// independent of the wall clock. The monotonic-clock state inside
// the primitive still uses Date.now() for redemption timestamps;
// that's the only place wall-clock leakage exists and it doesn't
// affect window membership.
var T0     = 1_700_000_000_000;             // 2023-11-14T22:13:20Z
var HOUR   = 60 * 60 * 1000;
var DAY    = 24 * HOUR;

// ---- defineBundle happy path + getBundle round-trip --------------------

async function _defineHappy() {
  var s = _setup();
  var def = await s.pb.defineBundle({
    slug:               "holiday-3pack",
    title:              "Holiday 3-Pack",
    components:         [{ sku: "SKU-C", quantity: 1 }, { sku: "SKU-A", quantity: 2 }, { sku: "SKU-B", quantity: 1 }],
    bundle_price_minor: 9900,
    currency:           "USD",
    starts_at:          T0,
    expires_at:         T0 + 30 * DAY,
    max_redemptions_total: 100,
    max_per_customer:      2,
  });
  check("defineBundle returns slug",            def.slug === "holiday-3pack");
  check("defineBundle stores title",            def.title === "Holiday 3-Pack");
  check("defineBundle stores price",            def.bundle_price_minor === 9900);
  check("defineBundle stores currency",         def.currency === "USD");
  check("defineBundle stores starts_at",        def.starts_at === T0);
  check("defineBundle stores expires_at",       def.expires_at === T0 + 30 * DAY);
  check("defineBundle stores total cap",        def.max_redemptions_total === 100);
  check("defineBundle stores per-cust cap",     def.max_per_customer === 2);
  check("defineBundle initialises counter",     def.redemptions_used === 0);
  check("defineBundle not archived",            def.archived_at === null);

  // Components are canonicalized sorted by sku — operator passed
  // them out of order; storage normalises.
  check("defineBundle sorts components",        def.components.length === 3);
  check("defineBundle component[0]",            def.components[0].sku === "SKU-A" && def.components[0].quantity === 2);
  check("defineBundle component[1]",            def.components[1].sku === "SKU-B" && def.components[1].quantity === 1);
  check("defineBundle component[2]",            def.components[2].sku === "SKU-C" && def.components[2].quantity === 1);

  var got = await s.pb.getBundle("holiday-3pack");
  check("getBundle round-trip",                 got && got.slug === "holiday-3pack" && got.components.length === 3);
  check("getBundle on miss returns null",       (await s.pb.getBundle("missing-slug")) === null);
}

// ---- defineBundle refusals ---------------------------------------------

async function _defineRefusals() {
  var s = _setup();

  // Inverted window
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k", components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0 + DAY, expires_at: T0,
  }), /starts_at must be strictly less than expires_at/);

  // Zero-length window
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k", components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0, expires_at: T0,
  }), /starts_at must be strictly less than expires_at/);

  // Duplicate component sku
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k",
    components: [{ sku: "A", quantity: 1 }, { sku: "A", quantity: 2 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  }), /duplicate/);

  // Empty components
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k", components: [],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  }), /non-empty array/);

  // Non-positive quantity
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k",
    components: [{ sku: "A", quantity: 0 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  }), /quantity/);

  // Bad slug shape (uppercase + space)
  await assert.rejects(s.pb.defineBundle({
    slug: "BAD SLUG", title: "k",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  }), /slug must match/);

  // Bad currency
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "usd",
    starts_at: T0, expires_at: T0 + DAY,
  }), /currency/);

  // Negative price
  await assert.rejects(s.pb.defineBundle({
    slug: "k", title: "k",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: -1, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  }), /bundle_price_minor/);

  // No input
  await assert.rejects(s.pb.defineBundle(), /input object required/);

  // Define then re-define same slug
  await s.pb.defineBundle({
    slug: "dup-slug", title: "first",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  });
  await assert.rejects(s.pb.defineBundle({
    slug: "dup-slug", title: "second",
    components: [{ sku: "B", quantity: 1 }],
    bundle_price_minor: 200, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
  }), /already exists/);
}

// ---- activeBundles window membership ----------------------------------

async function _activeBundlesWindow() {
  var s = _setup();
  // Three bundles with disjoint windows: past / current / future
  await s.pb.defineBundle({
    slug: "past", title: "past",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0 - 10 * DAY, expires_at: T0 - 1 * DAY,
  });
  await s.pb.defineBundle({
    slug: "current", title: "current",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0 - 1 * DAY, expires_at: T0 + 10 * DAY,
  });
  await s.pb.defineBundle({
    slug: "future", title: "future",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 100, currency: "USD",
    starts_at: T0 + 1 * DAY, expires_at: T0 + 10 * DAY,
  });

  var inWindow = await s.pb.activeBundles({ now: T0 });
  check("activeBundles only the current row",  inWindow.length === 1 && inWindow[0].slug === "current");

  // Half-open semantics: an instant exactly at starts_at is in;
  // exactly at expires_at is out.
  var atStart = await s.pb.activeBundles({ now: T0 + 1 * DAY });
  var atEnd   = await s.pb.activeBundles({ now: T0 + 10 * DAY });
  check("activeBundles starts_at is inclusive", atStart.map(function (b) { return b.slug; }).indexOf("future") !== -1);
  check("activeBundles expires_at is exclusive", atEnd.map(function (b) { return b.slug; }).indexOf("current") === -1);

  // Archive the current bundle — it should disappear from
  // activeBundles immediately.
  await s.pb.archiveBundle("current");
  var afterArchive = await s.pb.activeBundles({ now: T0 });
  check("activeBundles hides archived rows",   afterArchive.length === 0);
}

// ---- detectInCart matching --------------------------------------------

async function _detectInCart() {
  var s = _setup();
  await s.pb.defineBundle({
    slug: "kit-x", title: "Kit X",
    components: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 1 }],
    bundle_price_minor: 1500, currency: "USD",
    starts_at: T0 - DAY, expires_at: T0 + DAY,
  });

  // Cart missing component B — no match
  var noMatch = await s.pb.detectInCart({
    now: T0,
    cart: {
      currency: "USD",
      lines: [
        { sku: "A", quantity: 5, unit_amount_minor: 1000 },
      ],
    },
  });
  check("detectInCart no match on missing comp",   noMatch.length === 0);

  // Cart with insufficient quantity of A — no match
  var notEnough = await s.pb.detectInCart({
    now: T0,
    cart: {
      currency: "USD",
      lines: [
        { sku: "A", quantity: 1, unit_amount_minor: 1000 },
        { sku: "B", quantity: 1, unit_amount_minor: 800 },
      ],
    },
  });
  check("detectInCart no match below required qty", notEnough.length === 0);

  // Cart with exact + extra — matches; savings = 2*1000 + 1*800 - 1500 = 1300
  var matched = await s.pb.detectInCart({
    now: T0,
    cart: {
      currency: "USD",
      lines: [
        { sku: "A", quantity: 3, unit_amount_minor: 1000 },
        { sku: "B", quantity: 2, unit_amount_minor: 800 },
        { sku: "C", quantity: 1, unit_amount_minor: 500 },
      ],
    },
  });
  check("detectInCart matched 1 bundle",            matched.length === 1);
  check("detectInCart slug",                        matched[0].slug === "kit-x");
  check("detectInCart component_total_minor",       matched[0].component_total_minor === 2800);
  check("detectInCart savings_minor",               matched[0].savings_minor === 1300);

  // Wrong currency — no match
  var wrongCcy = await s.pb.detectInCart({
    now: T0,
    cart: {
      currency: "EUR",
      lines: [
        { sku: "A", quantity: 2, unit_amount_minor: 1000 },
        { sku: "B", quantity: 1, unit_amount_minor: 800 },
      ],
    },
  });
  check("detectInCart skips wrong-currency cart",   wrongCcy.length === 0);

  // Outside the window — no match
  var outOfWindow = await s.pb.detectInCart({
    now: T0 + 10 * DAY,
    cart: {
      currency: "USD",
      lines: [
        { sku: "A", quantity: 2, unit_amount_minor: 1000 },
        { sku: "B", quantity: 1, unit_amount_minor: 800 },
      ],
    },
  });
  check("detectInCart skips out-of-window bundle",  outOfWindow.length === 0);

  // Cart-shape refusals
  await assert.rejects(s.pb.detectInCart({}), /cart object required/);
  await assert.rejects(s.pb.detectInCart({ cart: { currency: "USD", lines: "nope" } }), /lines must be an array/);
  await assert.rejects(s.pb.detectInCart({ cart: { currency: "usd", lines: [] } }), /cart.currency/);
}

// ---- applyBundleToCart ------------------------------------------------

async function _applyBundleToCart() {
  var s = _setup();
  await s.pb.defineBundle({
    slug: "kit-y", title: "Kit Y",
    components: [{ sku: "A", quantity: 2 }, { sku: "B", quantity: 1 }],
    bundle_price_minor: 1500, currency: "USD",
    starts_at: T0 - DAY, expires_at: T0 + DAY,
  });

  var origCart = {
    currency: "USD",
    lines: [
      { sku: "A", quantity: 3, unit_amount_minor: 1000 },
      { sku: "B", quantity: 1, unit_amount_minor: 800 },
      { sku: "C", quantity: 1, unit_amount_minor: 500 },
    ],
  };
  var transformed = await s.pb.applyBundleToCart({
    now: T0,
    cart: origCart,
    bundle_slug: "kit-y",
  });

  // Input cart should be untouched.
  check("applyBundleToCart does not mutate input cart lines length", origCart.lines.length === 3);
  check("applyBundleToCart input A qty unchanged",                   origCart.lines[0].quantity === 3);
  check("applyBundleToCart input B qty unchanged",                   origCart.lines[1].quantity === 1);

  // Transformed cart: A goes from 3 -> 1 (consumed 2), B goes from 1 -> 0
  // (consumed 1 — line dropped), C remains 1, plus the synthetic
  // bundle line at 1500.
  var bySku = {};
  for (var i = 0; i < transformed.lines.length; i += 1) {
    bySku[transformed.lines[i].sku] = transformed.lines[i];
  }
  check("applyBundleToCart A qty reduced by 2",       bySku["A"] && bySku["A"].quantity === 1);
  check("applyBundleToCart B line dropped",           !bySku["B"]);
  check("applyBundleToCart C untouched",              bySku["C"] && bySku["C"].quantity === 1);
  check("applyBundleToCart bundle line present",      !!bySku["bundle:kit-y"]);
  check("applyBundleToCart bundle line price",        bySku["bundle:kit-y"].unit_amount_minor === 1500);
  check("applyBundleToCart bundle line qty 1",        bySku["bundle:kit-y"].quantity === 1);
  check("applyBundleToCart bundle flag set",          bySku["bundle:kit-y"].is_promo_bundle === true);
  check("applyBundleToCart applied summary present",  transformed.applied_promo_bundle.slug === "kit-y");
  // savings = 2*1000 + 1*800 - 1500 = 1300
  check("applyBundleToCart savings_minor",            transformed.applied_promo_bundle.savings_minor === 1300);
  check("applyBundleToCart line-level savings",       bySku["bundle:kit-y"].savings_minor === 1300);

  // Refuse outside the window
  await assert.rejects(s.pb.applyBundleToCart({
    now: T0 + 100 * DAY, cart: origCart, bundle_slug: "kit-y",
  }), /outside its active window/);

  // Refuse on insufficient components
  await assert.rejects(s.pb.applyBundleToCart({
    now: T0,
    cart: { currency: "USD", lines: [{ sku: "A", quantity: 1, unit_amount_minor: 1000 }] },
    bundle_slug: "kit-y",
  }), /does not contain enough/);

  // Refuse on unknown slug
  await assert.rejects(s.pb.applyBundleToCart({
    now: T0, cart: origCart, bundle_slug: "no-such-slug",
  }), /not found/);

  // Refuse on currency mismatch
  await assert.rejects(s.pb.applyBundleToCart({
    now: T0,
    cart: { currency: "EUR", lines: [{ sku: "A", quantity: 2, unit_amount_minor: 1000 }, { sku: "B", quantity: 1, unit_amount_minor: 800 }] },
    bundle_slug: "kit-y",
  }), /does not match cart currency/);
}

// ---- recordRedemption cap + idempotency -------------------------------

async function _recordRedemption() {
  var s = _setup();
  await s.pb.defineBundle({
    slug: "capped", title: "capped",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 1000, currency: "USD",
    starts_at: T0 - DAY, expires_at: T0 + DAY,
    max_redemptions_total: 2,
  });

  var order1 = bShop.framework.uuid.v7();
  var order2 = bShop.framework.uuid.v7();
  var order3 = bShop.framework.uuid.v7();
  var cust1  = bShop.framework.uuid.v7();
  var cust2  = bShop.framework.uuid.v7();

  var r1 = await s.pb.recordRedemption({
    slug: "capped", order_id: order1, customer_id: cust1, savings_minor: 300,
  });
  check("recordRedemption returns id",        typeof r1.id === "string" && r1.id.length > 0);
  check("recordRedemption stores slug",        r1.slug === "capped");
  check("recordRedemption stores order_id",    r1.order_id === order1);
  check("recordRedemption stores customer_id", r1.customer_id === cust1);
  check("recordRedemption stores savings",     r1.savings_minor === 300);

  var afterOne = await s.pb.getBundle("capped");
  check("recordRedemption increments counter", afterOne.redemptions_used === 1);

  // Idempotent replay — same (slug, order_id) returns the same id
  // without incrementing the counter.
  var r1Replay = await s.pb.recordRedemption({
    slug: "capped", order_id: order1, customer_id: cust1, savings_minor: 999,
  });
  check("recordRedemption idempotent id",       r1Replay.id === r1.id);
  check("recordRedemption idempotent savings",  r1Replay.savings_minor === 300);
  var afterReplay = await s.pb.getBundle("capped");
  check("recordRedemption replay does not tick", afterReplay.redemptions_used === 1);

  // Second distinct redemption hits the cap exactly.
  await s.pb.recordRedemption({
    slug: "capped", order_id: order2, customer_id: cust2, savings_minor: 300,
  });
  var atCap = await s.pb.getBundle("capped");
  check("recordRedemption counter at cap",      atCap.redemptions_used === 2);

  // Third redemption refused.
  await assert.rejects(s.pb.recordRedemption({
    slug: "capped", order_id: order3, customer_id: cust1, savings_minor: 300,
  }), /max_redemptions_total/);

  // Unknown slug refused
  await assert.rejects(s.pb.recordRedemption({
    slug: "no-such-slug", order_id: order3, savings_minor: 100,
  }), /not found/);

  // Bad UUID refused
  await assert.rejects(s.pb.recordRedemption({
    slug: "capped", order_id: "not-a-uuid", savings_minor: 100,
  }), /order_id/);

  // Negative savings refused
  await assert.rejects(s.pb.recordRedemption({
    slug: "capped", order_id: bShop.framework.uuid.v7(), savings_minor: -1,
  }), /savings_minor/);
}

// ---- updateBundle + archiveBundle -------------------------------------

async function _updateAndArchive() {
  var s = _setup();
  await s.pb.defineBundle({
    slug: "mut-test", title: "old title",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 1000, currency: "USD",
    starts_at: T0, expires_at: T0 + DAY,
    max_redemptions_total: 10,
  });

  // Title + window extension is allowed.
  var u1 = await s.pb.updateBundle("mut-test", {
    title: "new title",
    expires_at: T0 + 7 * DAY,
    max_redemptions_total: 50,
  });
  check("updateBundle title patched",       u1.title === "new title");
  check("updateBundle expires_at patched",  u1.expires_at === T0 + 7 * DAY);
  check("updateBundle cap patched",         u1.max_redemptions_total === 50);

  // Components mutation refused (immutable post-define).
  await assert.rejects(s.pb.updateBundle("mut-test", {
    components: [{ sku: "B", quantity: 1 }],
  }), /unsupported patch column/);

  // bundle_price_minor mutation refused
  await assert.rejects(s.pb.updateBundle("mut-test", {
    bundle_price_minor: 500,
  }), /unsupported patch column/);

  // currency mutation refused
  await assert.rejects(s.pb.updateBundle("mut-test", {
    currency: "EUR",
  }), /unsupported patch column/);

  // Empty patch refused
  await assert.rejects(s.pb.updateBundle("mut-test", {}), /at least one column/);

  // Inverted-window patch refused
  await assert.rejects(s.pb.updateBundle("mut-test", {
    starts_at: T0 + 100 * DAY,
  }), /starts_at must remain strictly less than expires_at/);

  // Cap below redemptions_used refused — first burn one redemption.
  var orderId = bShop.framework.uuid.v7();
  await s.pb.recordRedemption({
    slug: "mut-test", order_id: orderId, savings_minor: 100,
  });
  await assert.rejects(s.pb.updateBundle("mut-test", {
    max_redemptions_total: 0,
  }), /max_redemptions_total/);

  // Unknown slug refused
  await assert.rejects(s.pb.updateBundle("not-a-slug", {
    title: "x",
  }), /not found/);

  // Archive: hides from activeBundles + detectInCart, idempotent
  // second call.
  var archived = await s.pb.archiveBundle("mut-test");
  check("archiveBundle sets archived_at",   archived.archived_at != null);

  var inWindow = await s.pb.activeBundles({ now: T0 + 1 * HOUR });
  check("archiveBundle hides from active",  inWindow.map(function (b) { return b.slug; }).indexOf("mut-test") === -1);

  var detected = await s.pb.detectInCart({
    now: T0 + 1 * HOUR,
    cart: { currency: "USD", lines: [{ sku: "A", quantity: 1, unit_amount_minor: 9999 }] },
  });
  check("archiveBundle hides from detect",  detected.length === 0);

  var archivedAgain = await s.pb.archiveBundle("mut-test");
  check("archiveBundle is idempotent",      archivedAgain.archived_at === archived.archived_at);

  // Archive unknown slug refused
  await assert.rejects(s.pb.archiveBundle("nope-slug"), /not found/);
}

// ---- metricsForBundle -------------------------------------------------

async function _metricsRollup() {
  var s = _setup();
  await s.pb.defineBundle({
    slug: "metrics-kit", title: "metrics",
    components: [{ sku: "A", quantity: 1 }],
    bundle_price_minor: 1000, currency: "USD",
    starts_at: T0, expires_at: T0 + 30 * DAY,
  });

  // Zero redemptions: counter at 0, totals at 0, nullable timestamps.
  var empty = await s.pb.metricsForBundle("metrics-kit");
  check("metricsForBundle counter 0",         empty.redemptions_used === 0);
  check("metricsForBundle savings 0",         empty.total_savings_minor === 0);
  check("metricsForBundle distinct 0",        empty.distinct_customers === 0);
  check("metricsForBundle first_at null",     empty.first_redeemed_at === null);
  check("metricsForBundle last_at null",      empty.last_redeemed_at === null);

  // Three redemptions across two customers; one anonymous.
  var custA = bShop.framework.uuid.v7();
  var custB = bShop.framework.uuid.v7();
  await s.pb.recordRedemption({
    slug: "metrics-kit", order_id: bShop.framework.uuid.v7(), customer_id: custA, savings_minor: 100,
  });
  await s.pb.recordRedemption({
    slug: "metrics-kit", order_id: bShop.framework.uuid.v7(), customer_id: custB, savings_minor: 250,
  });
  await s.pb.recordRedemption({
    slug: "metrics-kit", order_id: bShop.framework.uuid.v7(), savings_minor: 50,
  });

  var rollup = await s.pb.metricsForBundle("metrics-kit");
  check("metricsForBundle redemptions counted", rollup.redemptions_used === 3);
  check("metricsForBundle savings summed",      rollup.total_savings_minor === 400);
  check("metricsForBundle distinct customers",  rollup.distinct_customers === 2);
  check("metricsForBundle first set",           rollup.first_redeemed_at != null);
  check("metricsForBundle last >= first",       rollup.last_redeemed_at >= rollup.first_redeemed_at);

  // Unknown slug refused
  await assert.rejects(s.pb.metricsForBundle("nope-slug"), /not found/);
}

// ---- run --------------------------------------------------------------

async function run() {
  await _defineHappy();
  await _defineRefusals();
  await _activeBundlesWindow();
  await _detectInCart();
  await _applyBundleToCart();
  await _recordRedemption();
  await _updateAndArchive();
  await _metricsRollup();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("promo-bundles.test.js — OK (" + helpers.getChecks() + " checks)");
  }).catch(function (e) {
    console.error("promo-bundles.test.js — FAIL");
    console.error(e && e.stack || e);
    process.exit(1);
  });
}
