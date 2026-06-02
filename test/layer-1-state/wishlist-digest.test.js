"use strict";
/**
 * wishlist-digest — weekly / monthly wishlist email summaries.
 *
 * Layer 1 against in-memory node:sqlite with migration 0198 loaded.
 * The wishlist + catalog + email + emailSuppressions deps are all
 * stubbed locally so this test exercises the primitive in isolation
 * (compositional wiring with the real wishlist / catalog primitives is
 * covered by the smoke suite).
 *
 * Coverage:
 *   - defineSchedule weekly + monthly happy paths + refusals
 *     (bad frequency, missing day_of_week / day_of_month, bad
 *     time_local, bad timezone, archived schedule)
 *   - enrollCustomer + next_dispatch_at math via Intl.DateTimeFormat
 *     (weekly Mon @ 09:00 Europe/London anchored mid-week + same-day-
 *     past + same-day-future; monthly day_of_month variations)
 *   - dispatchTick fan-out: pulls due rows, invokes composeDigest,
 *     dispatches via stubbed email, ledgers a sent row, advances
 *     next_dispatch_at by one period
 *   - composeDigest shape: returns HTML + text + lines + item_count
 *   - pauseEnrollment + resumeEnrollment FSM
 *   - emailSuppressions short-circuit ledgers item_count = 0
 *   - factory refusals: bad wishlist / catalog / email shapes
 *   - metricsForSchedule rollup window
 *   - enrollmentsForCustomer newest-first read
 *   - recordDigestSent async callback path
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var wishlistDigest = require("../../lib/wishlist-digest");
var bShop          = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0198_wishlist_digest.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

// Minimal wishlist stub — returns the configured rows for one customer.
function _wishlistStub(byCustomer) {
  byCustomer = byCustomer || {};
  return {
    listForCustomer: async function (customerId /* , listOpts */) {
      var rows = byCustomer[customerId] || [];
      return { rows: rows, nextCursor: null };
    },
  };
}

// Minimal catalog stub — products keyed by id, prices keyed by
// variant_id + currency.
function _catalogStub(opts) {
  opts = opts || {};
  var products  = opts.products  || {};
  var prices    = opts.prices    || {};
  var inventory = opts.inventory || null;
  var cat = {
    products: {
      get: async function (id) { return products[id] || null; },
    },
    prices: {
      current: async function (variantId, currency) {
        var key = variantId + ":" + currency;
        return prices[key] || null;
      },
    },
  };
  if (inventory) {
    cat.inventory = {
      get: async function (skuOrVariant) { return inventory[skuOrVariant] || null; },
    };
  }
  return cat;
}

// Email stub — captures every sendWishlistDigest call.
function _emailStub(opts) {
  opts = opts || {};
  var calls = [];
  return {
    sendWishlistDigest: async function (input) {
      if (opts.fail) throw new Error("mailer-down");
      calls.push(input);
      return { ok: true, id: "mail-" + calls.length };
    },
    calls: calls,
  };
}

// Suppressions stub — every address in `suppressed[]` answers true.
function _suppressionsStub(suppressedList) {
  var set = {};
  (suppressedList || []).forEach(function (e) { set[e.toLowerCase()] = true; });
  return {
    isSuppressed: async function (input) {
      return { suppressed: !!set[(input.email || "").toLowerCase()] };
    },
  };
}

function _customerId() { return bShop.framework.uuid.v7(); }

async function _wire(opts) {
  opts = opts || {};
  var q = _makeQuery();
  var svc = wishlistDigest.create({
    query:             q,
    wishlist:          opts.wishlist          || _wishlistStub(),
    catalog:           opts.catalog           || _catalogStub(),
    email:             opts.email             || _emailStub(),
    emailSuppressions: opts.emailSuppressions || null,
    emailForCustomer:  opts.emailForCustomer  || null,
    currencyForCustomer: opts.currencyForCustomer || null,
    defaultCurrency:   opts.defaultCurrency   || "USD",
  });
  return { q: q, svc: svc };
}

// ---- 1. defineSchedule weekly / monthly + refusals ---------------------

async function _defineSchedule() {
  var w = await _wire();

  // Weekly Mon @ 09:00 Europe/London
  var weekly = await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "Europe/London",
  });
  check("defineSchedule weekly returns row",      weekly && weekly.slug === "weekly-monday-9am");
  check("defineSchedule weekly frequency",        weekly.frequency === "weekly");
  check("defineSchedule weekly day_of_week=1",    weekly.day_of_week === 1);
  check("defineSchedule weekly day_of_month null",weekly.day_of_month == null);
  check("defineSchedule weekly time_local",       weekly.time_local === "09:00");
  check("defineSchedule weekly tz",               weekly.timezone === "Europe/London");
  check("defineSchedule weekly archived_at null", weekly.archived_at == null);

  // Update in place — change time
  var updated = await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "10:00",
    timezone:    "Europe/London",
  });
  check("defineSchedule update time_local",       updated.time_local === "10:00");

  // Monthly first-of-the-month @ 08:30 UTC
  var monthly = await w.svc.defineSchedule({
    slug:         "monthly-first-utc",
    frequency:    "monthly",
    day_of_month: 1,
    time_local:   "08:30",
    timezone:     "UTC",
  });
  check("defineSchedule monthly day_of_month=1",  monthly.day_of_month === 1);
  check("defineSchedule monthly day_of_week null",monthly.day_of_week == null);
  check("defineSchedule monthly time_local",      monthly.time_local === "08:30");

  // Refusals
  await assert.rejects(w.svc.defineSchedule(),                                              /input object required/);
  await assert.rejects(w.svc.defineSchedule({}),                                            /slug/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "daily",
    day_of_week: 1, time_local: "09:00", timezone: "UTC" }),                                /frequency/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "weekly",
    time_local: "09:00", timezone: "UTC" }),                                                /day_of_week required/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "weekly",
    day_of_week: 1, day_of_month: 5, time_local: "09:00", timezone: "UTC" }),               /day_of_month must be null/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "weekly",
    day_of_week: 9, time_local: "09:00", timezone: "UTC" }),                                /day_of_week must be an integer/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "monthly",
    time_local: "09:00", timezone: "UTC" }),                                                /day_of_month required/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "monthly",
    day_of_month: 31, time_local: "09:00", timezone: "UTC" }),                              /day_of_month must be an integer/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "weekly",
    day_of_week: 1, time_local: "25:00", timezone: "UTC" }),                                /time_local/);
  await assert.rejects(w.svc.defineSchedule({ slug: "bad", frequency: "weekly",
    day_of_week: 1, time_local: "09:00", timezone: "Not/A/Zone" }),                         /timezone/);
}

// ---- 2. enrollCustomer + next_dispatch_at math --------------------------

async function _enrollCustomerNextDispatchAtMath() {
  var w = await _wire();
  await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "Europe/London",
  });

  // Wed 2025-06-04 12:00 UTC == Wed 13:00 BST in London. The next
  // weekly Mon-09:00 Europe/London after this anchor is 2025-06-09
  // 09:00 BST == 2025-06-09 08:00 UTC.
  var anchorMidWeek = Date.UTC(2025, 5, 4, 12, 0);   // 2025-06-04 12:00 UTC
  var cid1 = _customerId();
  var en1 = await w.svc.enrollCustomer({
    customer_id:   cid1,
    schedule_slug: "weekly-monday-9am",
    now:           anchorMidWeek,
  });
  check("enrollCustomer status=active",          en1.status === "active");
  check("enrollCustomer schedule_slug",          en1.schedule_slug === "weekly-monday-9am");
  // Expected next_dispatch_at: 2025-06-09 08:00 UTC (Mon 09:00 BST)
  var expectedNext = Date.UTC(2025, 5, 9, 8, 0);
  check("enrollCustomer next_dispatch_at = Mon 09:00 London after mid-week anchor",
    en1.next_dispatch_at === expectedNext);

  // Same-day-past: anchor Mon 2025-06-09 10:00 UTC (11:00 BST, past
  // the 09:00 BST send) — next must be 2025-06-16 08:00 UTC.
  var anchorMonPast = Date.UTC(2025, 5, 9, 10, 0);
  var cid2 = _customerId();
  var en2 = await w.svc.enrollCustomer({
    customer_id:   cid2,
    schedule_slug: "weekly-monday-9am",
    now:           anchorMonPast,
  });
  var expectedNext2 = Date.UTC(2025, 5, 16, 8, 0);
  check("enrollCustomer same-day-past rolls a week", en2.next_dispatch_at === expectedNext2);

  // Same-day-future: anchor Mon 2025-06-09 06:00 UTC (07:00 BST,
  // before the 09:00 BST send) — next must be 2025-06-09 08:00 UTC.
  var anchorMonFuture = Date.UTC(2025, 5, 9, 6, 0);
  var cid3 = _customerId();
  var en3 = await w.svc.enrollCustomer({
    customer_id:   cid3,
    schedule_slug: "weekly-monday-9am",
    now:           anchorMonFuture,
  });
  var expectedNext3 = Date.UTC(2025, 5, 9, 8, 0);
  check("enrollCustomer same-day-future fires today", en3.next_dispatch_at === expectedNext3);

  // Monthly: day_of_month = 15 @ 12:00 UTC, anchor 2025-06-10 09:00 UTC.
  // Next = 2025-06-15 12:00 UTC.
  await w.svc.defineSchedule({
    slug:         "monthly-mid-utc",
    frequency:    "monthly",
    day_of_month: 15,
    time_local:   "12:00",
    timezone:     "UTC",
  });
  var anchorMonthly1 = Date.UTC(2025, 5, 10, 9, 0);
  var cid4 = _customerId();
  var en4 = await w.svc.enrollCustomer({
    customer_id:   cid4,
    schedule_slug: "monthly-mid-utc",
    now:           anchorMonthly1,
  });
  var expectedMonth1 = Date.UTC(2025, 5, 15, 12, 0);
  check("enrollCustomer monthly day-of-month future-in-month", en4.next_dispatch_at === expectedMonth1);

  // Monthly anchor past day_of_month — rolls to next month.
  // Anchor 2025-06-20 09:00 UTC; next = 2025-07-15 12:00 UTC.
  var anchorMonthly2 = Date.UTC(2025, 5, 20, 9, 0);
  var cid5 = _customerId();
  var en5 = await w.svc.enrollCustomer({
    customer_id:   cid5,
    schedule_slug: "monthly-mid-utc",
    now:           anchorMonthly2,
  });
  var expectedMonth2 = Date.UTC(2025, 6, 15, 12, 0);
  check("enrollCustomer monthly past-dom rolls forward",       en5.next_dispatch_at === expectedMonth2);

  // Refusals
  await assert.rejects(w.svc.enrollCustomer({ customer_id: "not-a-uuid",
    schedule_slug: "weekly-monday-9am" }),                                                  /customer_id/);
  await assert.rejects(w.svc.enrollCustomer({ customer_id: _customerId(),
    schedule_slug: "no-such-slug" }),                                                       /not found/);
}

// ---- 3. dispatchTick fan-out --------------------------------------------

async function _dispatchTickFanOut() {
  var customerA = _customerId();
  var customerB = _customerId();

  // Wishlist: customerA has two items, customerB has one item.
  var productA1 = bShop.framework.uuid.v7();
  var productA2 = bShop.framework.uuid.v7();
  var productB1 = bShop.framework.uuid.v7();
  var variantA1 = bShop.framework.uuid.v7();
  var variantA2 = bShop.framework.uuid.v7();
  var variantB1 = bShop.framework.uuid.v7();
  var wlMap = {};
  wlMap[customerA] = [
    { id: "wl-a1", customer_id: customerA, product_id: productA1, variant_id: variantA1, created_at: 1 },
    { id: "wl-a2", customer_id: customerA, product_id: productA2, variant_id: variantA2, created_at: 2 },
  ];
  wlMap[customerB] = [
    { id: "wl-b1", customer_id: customerB, product_id: productB1, variant_id: variantB1, created_at: 3 },
  ];
  var wishlistStub = _wishlistStub(wlMap);

  var productsMap = {};
  productsMap[productA1] = { id: productA1, title: "Coffee Beans 1kg" };
  productsMap[productA2] = { id: productA2, title: "Espresso Machine" };
  productsMap[productB1] = { id: productB1, title: "Grinder" };
  var pricesMap = {};
  pricesMap[variantA1 + ":USD"] = { amount_minor: 2500, currency: "USD" };
  pricesMap[variantA2 + ":USD"] = { amount_minor: 50000, currency: "USD" };
  pricesMap[variantB1 + ":USD"] = { amount_minor: 15000, currency: "USD" };
  var catalogStub = _catalogStub({ products: productsMap, prices: pricesMap });

  var emailStub = _emailStub();
  var emailMap = {};
  emailMap[customerA] = "alice@example.com";
  emailMap[customerB] = "bob@example.com";

  var w = await _wire({
    wishlist:         wishlistStub,
    catalog:          catalogStub,
    email:            emailStub,
    emailForCustomer: function (cid) { return emailMap[cid] || null; },
  });

  await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "UTC",
  });

  // Anchor at 2025-06-04 (Wed) — next Mon 2025-06-09 09:00 UTC.
  var anchor = Date.UTC(2025, 5, 4, 12, 0);
  await w.svc.enrollCustomer({ customer_id: customerA, schedule_slug: "weekly-monday-9am", now: anchor });
  await w.svc.enrollCustomer({ customer_id: customerB, schedule_slug: "weekly-monday-9am", now: anchor });

  // Tick BEFORE the first dispatch is due — nothing fires.
  var beforeDue = Date.UTC(2025, 5, 8, 9, 0);
  var emptyTick = await w.svc.dispatchTick({ now: beforeDue });
  check("dispatchTick before due fires nothing", emptyTick.sent === 0);
  check("dispatchTick before due emailStub idle", emailStub.calls.length === 0);

  // Tick AT the first dispatch — both fire.
  var atDue = Date.UTC(2025, 5, 9, 9, 0);
  var tick = await w.svc.dispatchTick({ now: atDue });
  check("dispatchTick at-due sent=2",            tick.sent === 2);
  check("dispatchTick emailStub got two calls",  emailStub.calls.length === 2);
  check("dispatchTick emailStub recipients",
    emailStub.calls.map(function (c) { return c.customer_email; }).sort().join(",")
    === "alice@example.com,bob@example.com");
  check("dispatchTick emailStub passes item_count",
    emailStub.calls.every(function (c) { return typeof c.item_count === "number" && c.item_count >= 1; }));
  check("dispatchTick emailStub passes html",    emailStub.calls.every(function (c) { return typeof c.html === "string"; }));

  // Ledger row written + next_dispatch_at advanced.
  var ledger = await w.q("SELECT * FROM wishlist_digest_sent", []);
  check("dispatchTick ledger row count",         ledger.rows.length === 2);
  var enrollments = await w.q("SELECT * FROM wishlist_digest_enrollments WHERE status = 'active'", []);
  var expectedAdvanced = Date.UTC(2025, 5, 16, 9, 0);
  check("dispatchTick advanced both next_dispatch_at by one week",
    enrollments.rows.every(function (r) { return Number(r.next_dispatch_at) === expectedAdvanced; }));

  // Second tick at same instant — neither row is due now (advanced).
  var tick2 = await w.svc.dispatchTick({ now: atDue });
  check("dispatchTick same-instant rerun fires nothing", tick2.sent === 0);

  // metricsForSchedule rollup — sent_at is stamped via the per-factory
  // monotonic clock (wall-clock-anchored), so we query against a wide
  // window rather than the `now` we passed to dispatchTick.
  var metrics = await w.svc.metricsForSchedule({
    slug: "weekly-monday-9am",
    from: 0,
    to:   Date.now() + 1000,
  });
  check("metricsForSchedule sent_count",         metrics.sent_count === 2);
  check("metricsForSchedule total_items=3",      metrics.total_items === 3);   // 2 + 1
}

// ---- 4. composeDigest shape --------------------------------------------

async function _composeDigestShape() {
  var customerA = _customerId();
  var productA  = bShop.framework.uuid.v7();
  var variantA  = bShop.framework.uuid.v7();

  var wlMap = {};
  wlMap[customerA] = [
    { id: "wl-c1", customer_id: customerA, product_id: productA, variant_id: variantA, created_at: 10 },
  ];
  var productsMap = {};
  productsMap[productA] = { id: productA, title: "Wishlisted Widget" };
  var pricesMap = {};
  pricesMap[variantA + ":USD"] = { amount_minor: 1999, currency: "USD" };
  var inventoryMap = {};
  inventoryMap[variantA] = { stock_on_hand: 5, stock_held: 0 };

  var w = await _wire({
    wishlist: _wishlistStub(wlMap),
    catalog:  _catalogStub({ products: productsMap, prices: pricesMap, inventory: inventoryMap }),
  });

  var digest = await w.svc.composeDigest({ customer_id: customerA });
  check("composeDigest customer_id",             digest.customer_id === customerA);
  check("composeDigest currency",                digest.currency === "USD");
  check("composeDigest item_count=1",            digest.item_count === 1);
  check("composeDigest lines length",            digest.lines.length === 1);
  check("composeDigest line title",              digest.lines[0].title === "Wishlisted Widget");
  check("composeDigest line price",              digest.lines[0].price === "$19.99");
  check("composeDigest line in_stock=true",      digest.lines[0].in_stock === true);
  check("composeDigest html non-empty",          digest.html.length > 0 && digest.html.indexOf("Wishlisted Widget") >= 0);
  check("composeDigest text non-empty",          digest.text.length > 0 && digest.text.indexOf("Wishlisted Widget") >= 0);

  // Empty-wishlist case
  var emptyCid = _customerId();
  var emptyDigest = await w.svc.composeDigest({ customer_id: emptyCid });
  check("composeDigest empty item_count=0",      emptyDigest.item_count === 0);
  check("composeDigest empty html mentions no items",
    emptyDigest.html.indexOf("No items") >= 0);

  // Currency-correct rendering via pricing.format (was a hand-rolled
  // amount_minor/100 + toFixed(2) before): a zero-decimal currency must
  // not render a spurious fraction, and a whole-unit amount must keep
  // its trailing zeros.
  var jpyCid  = _customerId();
  var jpyProd = bShop.framework.uuid.v7();
  var jpyVar  = bShop.framework.uuid.v7();
  var jpyWl = {}; jpyWl[jpyCid] = [
    { id: "wl-jpy", customer_id: jpyCid, product_id: jpyProd, variant_id: jpyVar, created_at: 10 },
  ];
  var jpyProducts = {}; jpyProducts[jpyProd] = { id: jpyProd, title: "Yen Widget" };
  var jpyPrices   = {}; jpyPrices[jpyVar + ":JPY"] = { amount_minor: 1050, currency: "JPY" };
  var wJpy = await _wire({
    wishlist:            _wishlistStub(jpyWl),
    catalog:             _catalogStub({ products: jpyProducts, prices: jpyPrices }),
    currencyForCustomer: function () { return "JPY"; },
  });
  var jpyDigest = await wJpy.svc.composeDigest({ customer_id: jpyCid });
  check("composeDigest JPY price has no fraction", jpyDigest.lines[0].price === "¥1,050");

  var zeroCid  = _customerId();
  var zeroProd = bShop.framework.uuid.v7();
  var zeroVar  = bShop.framework.uuid.v7();
  var zeroWl = {}; zeroWl[zeroCid] = [
    { id: "wl-zero", customer_id: zeroCid, product_id: zeroProd, variant_id: zeroVar, created_at: 10 },
  ];
  var zeroProducts = {}; zeroProducts[zeroProd] = { id: zeroProd, title: "Round Widget" };
  var zeroPrices   = {}; zeroPrices[zeroVar + ":USD"] = { amount_minor: 1000, currency: "USD" };
  var wZero = await _wire({
    wishlist: _wishlistStub(zeroWl),
    catalog:  _catalogStub({ products: zeroProducts, prices: zeroPrices }),
  });
  var zeroDigest = await wZero.svc.composeDigest({ customer_id: zeroCid });
  check("composeDigest USD keeps trailing zeros", zeroDigest.lines[0].price === "$10.00");

  // Hot-path guard: garbage catalog price data (non-integer / negative
  // amount_minor) must NOT throw — pricing.format throws on bad input,
  // so composeDigest degrades that line's price to "—" rather than
  // poisoning the dispatcher tick.
  var badCid  = _customerId();
  var badProd = bShop.framework.uuid.v7();
  var badVar  = bShop.framework.uuid.v7();
  var badWl = {}; badWl[badCid] = [
    { id: "wl-bad", customer_id: badCid, product_id: badProd, variant_id: badVar, created_at: 10 },
  ];
  var badProducts = {}; badProducts[badProd] = { id: badProd, title: "Broken Widget" };
  var badPrices = {};
  badPrices[badVar + ":USD"] = { amount_minor: 19.99, currency: "USD" };   // non-integer — would throw in pricing.format
  var wBad = await _wire({
    wishlist: _wishlistStub(badWl),
    catalog:  _catalogStub({ products: badProducts, prices: badPrices }),
  });
  var badDigest = await wBad.svc.composeDigest({ customer_id: badCid });
  check("composeDigest non-integer amount degrades to dash", badDigest.lines[0].price === "—");
  check("composeDigest non-integer amount still renders line", badDigest.lines.length === 1);
}

// listSchedules — new read verb. Returns non-archived schedules by
// default; active_only:false includes archived rows.
async function _listSchedulesReturnsLiveOnly() {
  var w = await _wire();
  await w.svc.defineSchedule({
    slug: "weekly-a", frequency: "weekly", day_of_week: 1, time_local: "09:00", timezone: "UTC",
  });
  await w.svc.defineSchedule({
    slug: "monthly-b", frequency: "monthly", day_of_month: 1, time_local: "08:00", timezone: "UTC",
  });
  var live = await w.svc.listSchedules();
  check("listSchedules returns both live",        live.length === 2);

  // Archive one via a direct UPDATE (no archive verb exists) — listSchedules
  // active_only (default) hides it; active_only:false shows it.
  await w.q("UPDATE wishlist_digest_schedules SET archived_at = ?1 WHERE slug = ?2", [Date.now(), "weekly-a"]);
  var liveAfter = await w.svc.listSchedules();
  check("listSchedules hides archived by default", liveAfter.length === 1 && liveAfter[0].slug === "monthly-b");
  var all = await w.svc.listSchedules({ active_only: false });
  check("listSchedules active_only:false shows archived", all.length === 2);
}

// ---- 5. pauseEnrollment + resumeEnrollment FSM -------------------------

async function _pauseResumeFsm() {
  var w = await _wire();
  await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "UTC",
  });
  var cid = _customerId();
  var anchor = Date.UTC(2025, 5, 4, 12, 0);
  var en = await w.svc.enrollCustomer({
    customer_id: cid, schedule_slug: "weekly-monday-9am", now: anchor,
  });

  // Pause
  var paused = await w.svc.pauseEnrollment({
    enrollment_id: en.id,
    reason:        "customer requested a break",
  });
  check("pauseEnrollment status=paused",          paused.status === "paused");
  check("pauseEnrollment paused_reason captured", paused.paused_reason === "customer requested a break");
  check("pauseEnrollment paused_at non-null",     paused.paused_at != null);

  // Re-pause is no-op (returns existing paused row)
  var pausedAgain = await w.svc.pauseEnrollment({
    enrollment_id: en.id, reason: "second-call",
  });
  check("pauseEnrollment idempotent",             pausedAgain.status === "paused");
  check("pauseEnrollment idempotent reason preserved",
    pausedAgain.paused_reason === "customer requested a break");

  // Resume — recomputes next_dispatch_at from the resume anchor.
  var resumeAnchor = Date.UTC(2025, 5, 4, 12, 0);
  var resumed = await w.svc.resumeEnrollment({
    enrollment_id: en.id, now: resumeAnchor,
  });
  check("resumeEnrollment status=active",         resumed.status === "active");
  check("resumeEnrollment paused_at cleared",     resumed.paused_at == null);
  check("resumeEnrollment paused_reason cleared", resumed.paused_reason == null);
  check("resumeEnrollment recomputed next_dispatch_at",
    resumed.next_dispatch_at === Date.UTC(2025, 5, 9, 9, 0));

  // Resume on already-active is a no-op.
  var resumedAgain = await w.svc.resumeEnrollment({ enrollment_id: en.id });
  check("resumeEnrollment idempotent on active",  resumedAgain.status === "active");

  // pauseEnrollment refusals
  await assert.rejects(w.svc.pauseEnrollment({ enrollment_id: "missing-id",
    reason: "x" }),                                                                         /not found/);
  await assert.rejects(w.svc.pauseEnrollment({ enrollment_id: en.id, reason: "" }),         /reason/);
}

// ---- 6. emailSuppressions short-circuit --------------------------------

async function _emailSuppressionsShortCircuit() {
  var customerA = _customerId();
  var productA  = bShop.framework.uuid.v7();
  var variantA  = bShop.framework.uuid.v7();

  var wlMap = {};
  wlMap[customerA] = [
    { id: "wl-s1", customer_id: customerA, product_id: productA, variant_id: variantA, created_at: 1 },
  ];
  var productsMap = {}; productsMap[productA] = { id: productA, title: "Suppressed Widget" };
  var pricesMap   = {}; pricesMap[variantA + ":USD"] = { amount_minor: 999, currency: "USD" };

  var emailStub = _emailStub();
  var suppStub  = _suppressionsStub(["alice@example.com"]);

  var w = await _wire({
    wishlist:          _wishlistStub(wlMap),
    catalog:           _catalogStub({ products: productsMap, prices: pricesMap }),
    email:             emailStub,
    emailSuppressions: suppStub,
    emailForCustomer:  function (cid) { return cid === customerA ? "alice@example.com" : null; },
  });
  await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "UTC",
  });
  var anchor = Date.UTC(2025, 5, 4, 12, 0);
  await w.svc.enrollCustomer({
    customer_id: customerA, schedule_slug: "weekly-monday-9am", now: anchor,
  });

  var atDue = Date.UTC(2025, 5, 9, 9, 0);
  var tick = await w.svc.dispatchTick({ now: atDue });
  check("suppressed tick sent=0",                tick.sent === 0);
  check("suppressed tick skipped=1",             tick.skipped === 1);
  check("suppressed tick skipped_by.suppressed", tick.skipped_by.suppressed === 1);
  check("suppressed tick emailStub never called",emailStub.calls.length === 0);

  // Ledger row written with item_count = 0 — the cadence stays on rails.
  var ledger = await w.q("SELECT * FROM wishlist_digest_sent", []);
  check("suppressed ledger row count = 1",       ledger.rows.length === 1);
  check("suppressed ledger item_count = 0",      Number(ledger.rows[0].item_count) === 0);
}

// ---- 7. enrollmentsForCustomer + recordDigestSent + factory refusals ---

async function _enrollmentsAndRecordSentAndRefusals() {
  var w = await _wire();
  await w.svc.defineSchedule({
    slug:        "weekly-monday-9am",
    frequency:   "weekly",
    day_of_week: 1,
    time_local:  "09:00",
    timezone:    "UTC",
  });
  await w.svc.defineSchedule({
    slug:         "monthly-first-utc",
    frequency:    "monthly",
    day_of_month: 1,
    time_local:   "08:30",
    timezone:     "UTC",
  });
  var cid = _customerId();
  var anchor = Date.UTC(2025, 5, 4, 12, 0);
  var enW = await w.svc.enrollCustomer({
    customer_id: cid, schedule_slug: "weekly-monday-9am", now: anchor,
  });
  var enM = await w.svc.enrollCustomer({
    customer_id: cid, schedule_slug: "monthly-first-utc", now: anchor,
  });

  var list = await w.svc.enrollmentsForCustomer(cid);
  check("enrollmentsForCustomer returns both",   list.length === 2);
  check("enrollmentsForCustomer newest-first",   list[0].id === enM.id);
  check("enrollmentsForCustomer second is weekly", list[1].id === enW.id);

  // Empty customer returns []
  var emptyList = await w.svc.enrollmentsForCustomer(_customerId());
  check("enrollmentsForCustomer empty",          emptyList.length === 0);

  // recordDigestSent — async callback path
  var sentAt = Date.UTC(2025, 5, 9, 9, 0);
  var rec = await w.svc.recordDigestSent({
    enrollment_id: enW.id,
    item_count:    3,
    sent_at:       sentAt,
  });
  check("recordDigestSent enrollment_id",        rec.enrollment_id === enW.id);
  check("recordDigestSent item_count",           rec.item_count === 3);
  check("recordDigestSent sent_at >= input",     rec.sent_at >= sentAt);

  // Ledger holds the row + enrollment next_dispatch_at advanced.
  var ledger = await w.q("SELECT * FROM wishlist_digest_sent WHERE enrollment_id = ?1", [enW.id]);
  check("recordDigestSent ledger row count",     ledger.rows.length === 1);
  var enFresh = await w.q("SELECT * FROM wishlist_digest_enrollments WHERE id = ?1", [enW.id]);
  check("recordDigestSent advanced next_dispatch_at",
    Number(enFresh.rows[0].next_dispatch_at) > enW.next_dispatch_at);

  // recordDigestSent refusals
  await assert.rejects(w.svc.recordDigestSent({ enrollment_id: "missing",
    item_count: 1, sent_at: sentAt }),                                                      /not found/);
  await assert.rejects(w.svc.recordDigestSent({ enrollment_id: enW.id,
    item_count: -1, sent_at: sentAt }),                                                     /item_count/);

  // Factory refusals
  assert.throws(function () {
    wishlistDigest.create({ query: function () {} });
  }, /wishlist/);
  assert.throws(function () {
    wishlistDigest.create({ query: function () {}, wishlist: _wishlistStub() });
  }, /catalog/);
  assert.throws(function () {
    wishlistDigest.create({
      query:    function () {},
      wishlist: _wishlistStub(),
      catalog:  _catalogStub(),
    });
  }, /email/);
  assert.throws(function () {
    wishlistDigest.create({
      query:             function () {},
      wishlist:          _wishlistStub(),
      catalog:           _catalogStub(),
      email:             _emailStub(),
      emailSuppressions: {},
    });
  }, /isSuppressed/);
}

async function run() {
  await _defineSchedule();
  await _enrollCustomerNextDispatchAtMath();
  await _dispatchTickFanOut();
  await _composeDigestShape();
  await _listSchedulesReturnsLiveOnly();
  await _pauseResumeFsm();
  await _emailSuppressionsShortCircuit();
  await _enrollmentsAndRecordSentAndRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("wishlist-digest: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
