"use strict";
/**
 * marketingBudget — per-channel marketing spend tracking and ROAS
 * reporting.
 *
 * Layer 1 against in-memory node:sqlite with migration 0172 loaded.
 * The primitive has no FK into the rest of the schema (it composes
 * sideways with orders via a UNIQUE order_id column on the
 * attribution row), so the test runs against a minimal in-memory
 * database with just the four marketing tables.
 *
 * Coverage:
 *   - defineChannel happy path + update-in-place + kind/currency lock
 *   - recordSpend writes through with denormalised currency + refuses
 *     unknown channel + bad amounts
 *   - attributeOrderToChannel happy path + currency-mismatch refusal
 *     + UNIQUE order_id replace-in-place
 *   - spendForPeriod chronological + bounded total
 *   - revenueForChannel total + order_count
 *   - roas math + spend-zero + zero-zero edge
 *   - topChannels leaderboard order + tie-break + revenue-without-
 *     spend + spend-without-revenue
 *   - unattributedRevenue floors at zero + currency filter
 *   - monthlyBudget upsert + currency lock
 *   - budgetVsActual joins budget + spend by month + flags
 *     over-budget + no-budget-but-spend
 *   - bad-shape refusals across the surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var marketingBudget = require("../../lib/marketing-budget");
var bShop           = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0172_marketing_budget.sql");

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

function _orderId() { return bShop.framework.uuid.v7(); }

function _wire() {
  var q = _makeQuery();
  var svc = marketingBudget.create({ query: q });
  return { q: q, svc: svc };
}

async function _defineChannel() {
  var w = _wire();
  var ch = await w.svc.defineChannel({
    slug: "google-ads-uk", name: "Google Ads UK",
    kind: "google_ads", currency: "GBP",
  });
  check("defineChannel returns row",       ch && ch.slug === "google-ads-uk");
  check("defineChannel kind stored",       ch.kind === "google_ads");
  check("defineChannel currency stored",   ch.currency === "GBP");
  check("defineChannel active=1 default",  Number(ch.active) === 1);

  // Update name in place
  var renamed = await w.svc.defineChannel({
    slug: "google-ads-uk", name: "Google Ads — UK Search",
    kind: "google_ads", currency: "GBP",
  });
  check("defineChannel rename in place",   renamed.name === "Google Ads — UK Search");

  // Kind / currency are pinned on first insert
  await assert.rejects(w.svc.defineChannel({
    slug: "google-ads-uk", name: "x", kind: "meta_ads", currency: "GBP",
  }), /cannot change kind/);
  await assert.rejects(w.svc.defineChannel({
    slug: "google-ads-uk", name: "x", kind: "google_ads", currency: "USD",
  }), /cannot change currency/);

  // Inactive flag honoured
  var off = await w.svc.defineChannel({
    slug: "tiktok-us", name: "TikTok US", kind: "tiktok_ads",
    currency: "USD", active: false,
  });
  check("defineChannel active=false",      Number(off.active) === 0);

  // listChannels active filter
  var active = await w.svc.listChannels();
  check("listChannels excludes inactive",  active.length === 1 && active[0].slug === "google-ads-uk");
  var all = await w.svc.listChannels({ active_only: false });
  check("listChannels all returns both",   all.length === 2);

  // Refusals
  await assert.rejects(w.svc.defineChannel(),                                                /input object required/);
  await assert.rejects(w.svc.defineChannel({}),                                              /slug/);
  await assert.rejects(w.svc.defineChannel({ slug: "x", name: "n", kind: "bogus",
    currency: "GBP" }),                                                                       /kind/);
  await assert.rejects(w.svc.defineChannel({ slug: "x", name: "n", kind: "google_ads",
    currency: "gbp" }),                                                                       /currency/);
  await assert.rejects(w.svc.defineChannel({ slug: "BAD_SLUG", name: "n", kind: "google_ads",
    currency: "GBP" }),                                                                       /slug/);
}

async function _recordSpendAndAttribute() {
  var w = _wire();
  await w.svc.defineChannel({ slug: "meta-uk", name: "Meta UK",
    kind: "meta_ads", currency: "GBP" });
  var now = Date.now();
  var s1 = await w.svc.recordSpend({
    channel_slug: "meta-uk", spent_at: now, amount_minor: 5000, memo: "First push",
  });
  check("recordSpend returns row",         s1 && Number(s1.amount_minor) === 5000);
  check("recordSpend currency denormed",   s1.currency === "GBP");
  check("recordSpend memo stored",         s1.memo === "First push");

  // Unknown channel refused
  await assert.rejects(w.svc.recordSpend({
    channel_slug: "no-such", spent_at: now, amount_minor: 100,
  }), /not found/);
  // Bad amount refused
  await assert.rejects(w.svc.recordSpend({
    channel_slug: "meta-uk", spent_at: now, amount_minor: -1,
  }), /amount_minor/);
  await assert.rejects(w.svc.recordSpend({
    channel_slug: "meta-uk", spent_at: 0, amount_minor: 1,
  }), /spent_at/);

  // attributeOrderToChannel
  var orderA = _orderId();
  var att = await w.svc.attributeOrderToChannel({
    order_id: orderA, channel_slug: "meta-uk",
    attributed_revenue_minor: 12000, currency: "GBP", attributed_at: now,
  });
  check("attribute returns row",            att && Number(att.attributed_revenue_minor) === 12000);
  check("attribute order_id stored",        att.order_id === orderA);

  // Currency mismatch refused
  await assert.rejects(w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "meta-uk",
    attributed_revenue_minor: 100, currency: "USD", attributed_at: now,
  }), /does not match channel currency/);

  // Re-attribute same order_id — UPDATE in place
  var reAtt = await w.svc.attributeOrderToChannel({
    order_id: orderA, channel_slug: "meta-uk",
    attributed_revenue_minor: 18000, currency: "GBP", attributed_at: now + 100,
  });
  check("re-attribute updates revenue",     Number(reAtt.attributed_revenue_minor) === 18000);
  check("re-attribute same id",             reAtt.id === att.id);

  // Bad order_id refused
  await assert.rejects(w.svc.attributeOrderToChannel({
    order_id: "not-a-uuid", channel_slug: "meta-uk",
    attributed_revenue_minor: 100, currency: "GBP", attributed_at: now,
  }), /order_id/);
}

async function _roasMath() {
  var w = _wire();
  await w.svc.defineChannel({ slug: "ga-us", name: "Google Ads US",
    kind: "google_ads", currency: "USD" });
  var base = Date.now();
  // Spend = 10000, Revenue = 30000 -> ROAS = 3.0 (30000 bps)
  await w.svc.recordSpend({ channel_slug: "ga-us", spent_at: base + 1, amount_minor: 4000 });
  await w.svc.recordSpend({ channel_slug: "ga-us", spent_at: base + 2, amount_minor: 6000 });
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "ga-us",
    attributed_revenue_minor: 30000, currency: "USD", attributed_at: base + 3,
  });

  var window = { channel_slug: "ga-us", from: base, to: base + 1000 };
  var roas = await w.svc.roas(window);
  check("roas spend total",                Number(roas.spend_minor)   === 10000);
  check("roas revenue total",              Number(roas.revenue_minor) === 30000);
  check("roas bps = 30000",                roas.roas_bps === 30000);

  // spend zero + revenue non-zero — null ratio
  await w.svc.defineChannel({ slug: "organic", name: "Organic", kind: "organic_search",
    currency: "USD" });
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "organic",
    attributed_revenue_minor: 5000, currency: "USD", attributed_at: base + 4,
  });
  var nullRoas = await w.svc.roas({ channel_slug: "organic", from: base, to: base + 1000 });
  check("roas null when no spend",         nullRoas.roas_bps === null);
  check("roas null revenue surfaced",      Number(nullRoas.revenue_minor) === 5000);

  // both zero -> 0
  await w.svc.defineChannel({ slug: "quiet", name: "Quiet", kind: "other", currency: "USD" });
  var zero = await w.svc.roas({ channel_slug: "quiet", from: base, to: base + 1000 });
  check("roas zero/zero = 0",              zero.roas_bps === 0);

  // unknown channel refused
  await assert.rejects(w.svc.roas({ channel_slug: "no-such", from: base, to: base + 1 }),
                                                                                          /not found/);

  // spendForPeriod totals + ordering
  var sp = await w.svc.spendForPeriod({ channel_slug: "ga-us", from: base, to: base + 1000 });
  check("spendForPeriod total",            sp.total_minor === 10000);
  check("spendForPeriod ordered",          sp.rows.length === 2 &&
                                           sp.rows[0].spent_at <= sp.rows[1].spent_at);
  check("spendForPeriod currency",         sp.currency === "USD");

  // revenueForChannel total + order_count
  var rv = await w.svc.revenueForChannel({ channel_slug: "ga-us", from: base, to: base + 1000 });
  check("revenueForChannel total",         rv.total_minor === 30000);
  check("revenueForChannel order_count",   rv.order_count === 1);

  // Window-bounded refusals
  await assert.rejects(w.svc.spendForPeriod({ channel_slug: "ga-us",
    from: 0, to: 1 }),                                                                     /from/);
  await assert.rejects(w.svc.spendForPeriod({ channel_slug: "ga-us",
    from: 100, to: 50 }),                                                                  /strictly less than/);
}

async function _topChannelsLeaderboard() {
  var w = _wire();
  await w.svc.defineChannel({ slug: "a", name: "A", kind: "google_ads",   currency: "USD" });
  await w.svc.defineChannel({ slug: "b", name: "B", kind: "meta_ads",     currency: "USD" });
  await w.svc.defineChannel({ slug: "c", name: "C", kind: "organic_search", currency: "USD" });
  await w.svc.defineChannel({ slug: "d", name: "D", kind: "tiktok_ads",   currency: "USD" });
  var base = Date.now();

  // a: spend 1000, revenue 5000  (ROAS 50000 bps)
  await w.svc.recordSpend({ channel_slug: "a", spent_at: base + 1, amount_minor: 1000 });
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "a",
    attributed_revenue_minor: 5000, currency: "USD", attributed_at: base + 2,
  });

  // b: spend 2000, revenue 10000 (ROAS 50000 bps) — top by revenue
  await w.svc.recordSpend({ channel_slug: "b", spent_at: base + 3, amount_minor: 2000 });
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "b",
    attributed_revenue_minor: 10000, currency: "USD", attributed_at: base + 4,
  });

  // c: organic — revenue 4000, no spend
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "c",
    attributed_revenue_minor: 4000, currency: "USD", attributed_at: base + 5,
  });

  // d: spend 500, no attributed revenue (a flop)
  await w.svc.recordSpend({ channel_slug: "d", spent_at: base + 6, amount_minor: 500 });

  var top = await w.svc.topChannels({ from: base, to: base + 1000, limit: 5 });
  check("topChannels four rows",            top.length === 4);
  check("topChannels first b (rev 10000)",  top[0].channel_slug === "b" && top[0].revenue_minor === 10000);
  check("topChannels second a (rev 5000)",  top[1].channel_slug === "a" && top[1].revenue_minor === 5000);
  check("topChannels third c (rev 4000)",   top[2].channel_slug === "c" && top[2].revenue_minor === 4000);
  check("topChannels fourth d (rev 0)",     top[3].channel_slug === "d" && top[3].revenue_minor === 0);
  check("topChannels c null roas",          top[2].roas_bps === null);
  check("topChannels d zero roas (no rev)", top[3].roas_bps === 0);
  check("topChannels d spend captured",     top[3].spend_minor === 500);

  // limit cap honoured
  var topTwo = await w.svc.topChannels({ from: base, to: base + 1000, limit: 2 });
  check("topChannels limit 2",              topTwo.length === 2 && topTwo[0].channel_slug === "b");

  // limit refusal
  await assert.rejects(w.svc.topChannels({ from: base, to: base + 1, limit: 9999 }),     /limit/);
}

async function _unattributedRevenue() {
  var w = _wire();
  await w.svc.defineChannel({ slug: "meta", name: "Meta", kind: "meta_ads", currency: "USD" });
  var base = Date.now();
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "meta",
    attributed_revenue_minor: 4000, currency: "USD", attributed_at: base + 1,
  });
  await w.svc.attributeOrderToChannel({
    order_id: _orderId(), channel_slug: "meta",
    attributed_revenue_minor: 3000, currency: "USD", attributed_at: base + 2,
  });

  // total order revenue = 12000, attributed = 7000 -> unattributed = 5000
  var u = await w.svc.unattributedRevenue({
    from: base, to: base + 1000,
    order_revenue_total_minor: 12000, currency: "USD",
  });
  check("unattributedRevenue attributed",     u.attributed_minor === 7000);
  check("unattributedRevenue unattributed",   u.unattributed_minor === 5000);
  check("unattributedRevenue currency",       u.currency === "USD");

  // floors at zero when attributed > total
  var floor = await w.svc.unattributedRevenue({
    from: base, to: base + 1000,
    order_revenue_total_minor: 1000, currency: "USD",
  });
  check("unattributedRevenue floors at 0",    floor.unattributed_minor === 0);

  // no currency filter — sums across all currencies
  var noCur = await w.svc.unattributedRevenue({
    from: base, to: base + 1000,
    order_revenue_total_minor: 10000,
  });
  check("unattributedRevenue no currency",    noCur.attributed_minor === 7000);
  check("unattributedRevenue currency null",  noCur.currency === null);
}

async function _monthlyBudgetVsActual() {
  var w = _wire();
  await w.svc.defineChannel({ slug: "ga", name: "Google Ads",
    kind: "google_ads", currency: "USD" });
  await w.svc.defineChannel({ slug: "meta", name: "Meta",
    kind: "meta_ads", currency: "USD" });
  await w.svc.defineChannel({ slug: "tik", name: "TikTok",
    kind: "tiktok_ads", currency: "USD" });

  // Declare monthly budgets — May 2026
  var b1 = await w.svc.monthlyBudget({
    channel_slug: "ga", month: "2026-05", amount_minor: 100000, currency: "USD",
  });
  check("monthlyBudget returns row",        b1 && b1.channel_slug === "ga");
  check("monthlyBudget amount stored",      Number(b1.amount_minor) === 100000);
  check("monthlyBudget month stored",       b1.month === "2026-05");

  // Update in place
  var b1b = await w.svc.monthlyBudget({
    channel_slug: "ga", month: "2026-05", amount_minor: 150000, currency: "USD",
  });
  check("monthlyBudget update in place",    Number(b1b.amount_minor) === 150000);

  await w.svc.monthlyBudget({
    channel_slug: "meta", month: "2026-05", amount_minor: 50000, currency: "USD",
  });

  // Currency mismatch refused
  await assert.rejects(w.svc.monthlyBudget({
    channel_slug: "ga", month: "2026-05", amount_minor: 100, currency: "GBP",
  }), /does not match channel currency/);
  // Unknown channel refused
  await assert.rejects(w.svc.monthlyBudget({
    channel_slug: "no-such", month: "2026-05", amount_minor: 100, currency: "USD",
  }), /not found/);
  // Bad month refused
  await assert.rejects(w.svc.monthlyBudget({
    channel_slug: "ga", month: "2026/05", amount_minor: 100, currency: "USD",
  }), /month/);

  // Record spend inside May 2026 (use UTC mid-month timestamps so the
  // range read is robust against local-time slippage).
  var maySpend = Date.UTC(2026, 4, 15, 12, 0, 0);   // 2026-05-15 12:00 UTC
  await w.svc.recordSpend({ channel_slug: "ga",   spent_at: maySpend, amount_minor: 80000 });
  await w.svc.recordSpend({ channel_slug: "ga",   spent_at: maySpend + 1, amount_minor: 40000 });
  await w.svc.recordSpend({ channel_slug: "meta", spent_at: maySpend + 2, amount_minor: 70000 });
  // tik has spend but no budget
  await w.svc.recordSpend({ channel_slug: "tik",  spent_at: maySpend + 3, amount_minor: 25000 });
  // spend outside the month — must not count
  var aprSpend = Date.UTC(2026, 3, 15, 12, 0, 0);   // 2026-04-15
  await w.svc.recordSpend({ channel_slug: "ga", spent_at: aprSpend, amount_minor: 999999 });
  var junSpend = Date.UTC(2026, 5, 1, 0, 0, 0);     // 2026-06-01 (exactly on the upper bound)
  await w.svc.recordSpend({ channel_slug: "ga", spent_at: junSpend, amount_minor: 999999 });

  var rep = await w.svc.budgetVsActual({ month: "2026-05" });
  check("budgetVsActual three channels",    rep.length === 3);

  // Find each row by slug — sort order is by actual_minor DESC so:
  // ga (120k) > meta (70k) > tik (25k)
  check("budgetVsActual ordered by actual", rep[0].channel_slug === "ga"   &&
                                            rep[1].channel_slug === "meta" &&
                                            rep[2].channel_slug === "tik");
  check("budgetVsActual ga actual",         rep[0].actual_minor === 120000);
  check("budgetVsActual ga budget",         rep[0].budget_minor === 150000);
  check("budgetVsActual ga variance",       rep[0].variance_minor === 30000);
  check("budgetVsActual ga not over",       rep[0].over_budget === false);
  check("budgetVsActual ga pct_used_bps",   rep[0].pct_used_bps === 8000);   // 120000/150000 = 0.8 = 8000 bps

  check("budgetVsActual meta over",         rep[1].actual_minor === 70000 &&
                                            rep[1].budget_minor === 50000 &&
                                            rep[1].over_budget === true);
  check("budgetVsActual meta variance neg", rep[1].variance_minor === -20000);

  check("budgetVsActual tik no budget",     rep[2].budget_minor === 0 &&
                                            rep[2].pct_used_bps === null &&
                                            rep[2].over_budget === true);

  // Single-channel filter
  var gaOnly = await w.svc.budgetVsActual({ month: "2026-05", channel_slug: "ga" });
  check("budgetVsActual filter ga only",    gaOnly.length === 1 && gaOnly[0].channel_slug === "ga");
}

async function run() {
  await _defineChannel();
  await _recordSpendAndAttribute();
  await _roasMath();
  await _topChannelsLeaderboard();
  await _unattributedRevenue();
  await _monthlyBudgetVsActual();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("marketing-budget: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
