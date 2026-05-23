"use strict";
/**
 * tier-benefits — per-loyalty-tier perks: free shipping, percent off,
 * early access, priority support, exclusive products, birthday bonus.
 *
 * Layer 1 against in-memory node:sqlite loaded from the live D1
 * migration `0141_tier_benefits.sql`. Loyalty composition is stubbed
 * via a fake `loyalty.tierForCustomer(id)` handle so the test stays
 * inside this primitive's scope.
 *
 * Coverage:
 *   - defineBenefit persists + hydrates the typed value envelope
 *     for every kind in the enum
 *   - duplicate slug refuses; per-kind value validation refuses bad
 *     shapes; unknown condition keys refused
 *   - benefitsForTier returns the active set ordered by slug
 *   - archive removes a benefit from benefitsForTier; updateBenefit
 *     mutates the value/conditions in place
 *   - benefitsForCustomer resolves the tier via the stub loyalty
 *     handle and returns the tier's active set (and the .balance(id)
 *     fallback shape works too)
 *   - conditions filter (currencies / regions / min_order_minor /
 *     time window) applied against a context envelope
 *   - recordUsage round-trips through usageForBenefit;
 *     metricsForBenefit aggregates count + sum(savings_minor)
 *   - listBenefits filters by tier / kind / include_archived
 *   - input refusals on every public surface
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop        = require("../../lib");
var tierBenefits = require("../../lib/tier-benefits");
var helpers      = require("../helpers");
var check        = helpers.check;
var assert       = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0141_tier_benefits.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) {
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

function _uuid() { return bShop.framework.uuid.v7(); }

function _stubLoyalty(initialMap) {
  var map = Object.assign({}, initialMap || {});
  return {
    set: function (id, tier) { map[id] = tier; },
    tierForCustomer: async function (id) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) {
        throw new Error("stubLoyalty: no tier for " + id);
      }
      return map[id];
    },
  };
}

function _stubLoyaltyViaBalance(initialMap) {
  var map = Object.assign({}, initialMap || {});
  return {
    set: function (id, tier) { map[id] = tier; },
    balance: async function (id) {
      if (!Object.prototype.hasOwnProperty.call(map, id)) {
        return { balance: 0, lifetime: 0, tier: "bronze", tier_expires_at: null };
      }
      return { balance: 0, lifetime: 0, tier: map[id], tier_expires_at: null };
    },
  };
}

// ---- defineBenefit + per-kind value validation -------------------------

async function _defineEveryKind() {
  var tb = tierBenefits.create({ query: _makeQuery() });

  var freeShip = await tb.defineBenefit({
    slug:  "platinum-free-ship",
    tier:  "platinum",
    kind:  "free_shipping",
    value: { min_order_minor: 5000 },
  });
  check("free_shipping slug",                freeShip.slug === "platinum-free-ship");
  check("free_shipping tier",                freeShip.tier === "platinum");
  check("free_shipping kind",                freeShip.kind === "free_shipping");
  check("free_shipping value",               freeShip.value.min_order_minor === 5000);
  check("free_shipping archived_at null",    freeShip.archived_at === null);
  check("free_shipping created_at int",      Number.isInteger(freeShip.created_at));
  check("free_shipping conditions null",     freeShip.conditions === null);

  var pctOff = await tb.defineBenefit({
    slug:  "gold-15-off",
    tier:  "gold",
    kind:  "percent_off",
    value: { percent: 15 },
  });
  check("percent_off value",                 pctOff.value.percent === 15);

  var early = await tb.defineBenefit({
    slug:  "silver-early-access",
    tier:  "silver",
    kind:  "early_access",
    value: { hours: 24 },
  });
  check("early_access hours",                early.value.hours === 24);

  var support = await tb.defineBenefit({
    slug:  "platinum-priority-support",
    tier:  "platinum",
    kind:  "priority_support",
    value: { sla_minutes: 60 },
  });
  check("priority_support sla",              support.value.sla_minutes === 60);

  var excl = await tb.defineBenefit({
    slug:  "platinum-exclusive",
    tier:  "platinum",
    kind:  "exclusive_access",
    value: { collection_slug: "vip-only" },
  });
  check("exclusive_access collection",       excl.value.collection_slug === "vip-only");

  var birthday = await tb.defineBenefit({
    slug:  "gold-birthday",
    tier:  "gold",
    kind:  "birthday_bonus",
    value: { points: 500 },
  });
  check("birthday_bonus points",             birthday.value.points === 500);

  var birthdayPct = await tb.defineBenefit({
    slug:  "platinum-birthday",
    tier:  "platinum",
    kind:  "birthday_bonus",
    value: { percent_off: 20 },
  });
  check("birthday_bonus percent_off",        birthdayPct.value.percent_off === 20);

  // Duplicate slug refused.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "platinum-free-ship",
      tier:  "platinum",
      kind:  "free_shipping",
      value: {},
    }),
    /already exists/,
  );

  // birthday_bonus refuses both points + percent_off (must be exactly one).
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-birthday-both",
      tier:  "gold",
      kind:  "birthday_bonus",
      value: { points: 100, percent_off: 10 },
    }),
    /exactly one/,
  );
  // birthday_bonus refuses neither.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-birthday-neither",
      tier:  "gold",
      kind:  "birthday_bonus",
      value: {},
    }),
    /exactly one/,
  );

  // percent_off out of range.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-percent",
      tier:  "gold",
      kind:  "percent_off",
      value: { percent: 0 },
    }),
    /percent/,
  );
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-percent-2",
      tier:  "gold",
      kind:  "percent_off",
      value: { percent: 101 },
    }),
    /percent/,
  );

  // early_access requires hours.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-early",
      tier:  "silver",
      kind:  "early_access",
      value: {},
    }),
    /hours required/,
  );

  // exclusive_access collection_slug shape.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-excl",
      tier:  "platinum",
      kind:  "exclusive_access",
      value: { collection_slug: "BAD CASE" },
    }),
    /collection_slug/,
  );

  // Unknown kind.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "bad-kind",
      tier:  "gold",
      kind:  "free_money",
      value: {},
    }),
    /kind must be/,
  );

  // Unknown condition key refused.
  await assert.rejects(
    tb.defineBenefit({
      slug:       "bad-cond-key",
      tier:       "gold",
      kind:       "percent_off",
      value:      { percent: 10 },
      conditions: { typo: 1 },
    }),
    /unknown key/,
  );

  // Bad slug shape.
  await assert.rejects(
    tb.defineBenefit({
      slug:  "BAD SLUG",
      tier:  "gold",
      kind:  "percent_off",
      value: { percent: 10 },
    }),
    /slug must match/,
  );
}

// ---- benefitsForTier returns active set --------------------------------

async function _benefitsForTier() {
  var q  = _makeQuery();
  var tb = tierBenefits.create({ query: q });

  await tb.defineBenefit({
    slug: "platinum-a", tier: "platinum", kind: "percent_off",
    value: { percent: 20 },
  });
  await tb.defineBenefit({
    slug: "platinum-b", tier: "platinum", kind: "free_shipping",
    value: {},
  });
  await tb.defineBenefit({
    slug: "gold-a", tier: "gold", kind: "percent_off",
    value: { percent: 10 },
  });

  var plat = await tb.benefitsForTier("platinum");
  check("benefitsForTier platinum count",    plat.length === 2);
  check("benefitsForTier platinum sorted",   plat[0].slug === "platinum-a");
  check("benefitsForTier platinum second",   plat[1].slug === "platinum-b");

  var gold = await tb.benefitsForTier("gold");
  check("benefitsForTier gold count",        gold.length === 1);
  check("benefitsForTier gold slug",         gold[0].slug === "gold-a");

  // Empty tier returns [].
  var none = await tb.benefitsForTier("silver");
  check("benefitsForTier silver empty",      none.length === 0);

  // Tier names are case-normalized.
  var platUpper = await tb.benefitsForTier("PLATINUM");
  check("benefitsForTier case-normalized",   platUpper.length === 2);

  // Archive one — drops out of benefitsForTier.
  await tb.archiveBenefit("platinum-a");
  var platAfter = await tb.benefitsForTier("platinum");
  check("benefitsForTier after archive",     platAfter.length === 1);
  check("benefitsForTier active remains",    platAfter[0].slug === "platinum-b");

  // listBenefits with include_archived returns the archived row.
  var listAll = await tb.listBenefits({ tier: "platinum", include_archived: true });
  check("listBenefits include_archived",     listAll.length === 2);
  var archived = listAll.find(function (r) { return r.slug === "platinum-a"; });
  check("listBenefits archived_at set",      typeof archived.archived_at === "number");

  // listBenefits without include_archived skips it.
  var listLive = await tb.listBenefits({ tier: "platinum" });
  check("listBenefits live only",            listLive.length === 1);

  // listBenefits by kind.
  var listPct = await tb.listBenefits({ kind: "percent_off" });
  check("listBenefits kind percent_off",     listPct.length === 1);
  check("listBenefits kind only gold",       listPct[0].slug === "gold-a");
}

// ---- benefitsForCustomer via stub loyalty ------------------------------

async function _benefitsForCustomer() {
  var q   = _makeQuery();
  var loy = _stubLoyalty();
  var tb  = tierBenefits.create({ query: q, loyalty: loy });

  await tb.defineBenefit({
    slug: "gold-ship", tier: "gold", kind: "free_shipping",
    value: {},
  });
  await tb.defineBenefit({
    slug: "gold-pct", tier: "gold", kind: "percent_off",
    value: { percent: 10 },
  });
  await tb.defineBenefit({
    slug: "platinum-pct", tier: "platinum", kind: "percent_off",
    value: { percent: 25 },
  });

  var goldCust = _uuid();
  loy.set(goldCust, "gold");
  var platCust = _uuid();
  loy.set(platCust, "platinum");

  var goldPerks = await tb.benefitsForCustomer(goldCust);
  check("benefitsForCustomer gold count",      goldPerks.length === 2);
  check("benefitsForCustomer gold has ship",
    goldPerks.some(function (p) { return p.slug === "gold-ship"; }));
  check("benefitsForCustomer gold has pct",
    goldPerks.some(function (p) { return p.slug === "gold-pct"; }));

  var platPerks = await tb.benefitsForCustomer(platCust);
  check("benefitsForCustomer plat count",      platPerks.length === 1);
  check("benefitsForCustomer plat slug",       platPerks[0].slug === "platinum-pct");

  // loyalty stub via .balance(id) fallback shape works too.
  var tbBal = tierBenefits.create({ query: q, loyalty: _stubLoyaltyViaBalance({ }) });
  // Default tier from the balance stub is "bronze" — no benefits.
  var bronzeCust = _uuid();
  var bronzePerks = await tbBal.benefitsForCustomer(bronzeCust);
  check("benefitsForCustomer bronze via balance empty", bronzePerks.length === 0);

  // No loyalty handle — refuses.
  var tbNoLoy = tierBenefits.create({ query: q });
  await assert.rejects(
    tbNoLoy.benefitsForCustomer(_uuid()),
    /loyalty handle not configured/,
  );
}

// ---- conditions filter --------------------------------------------------

async function _conditionsFilter() {
  var q   = _makeQuery();
  var loy = _stubLoyalty();
  var tb  = tierBenefits.create({ query: q, loyalty: loy });

  await tb.defineBenefit({
    slug:       "gold-free-ship",
    tier:       "gold",
    kind:       "free_shipping",
    value:      { min_order_minor: 0 },
    conditions: { min_order_minor: 5000 },
  });
  await tb.defineBenefit({
    slug:       "gold-us-only",
    tier:       "gold",
    kind:       "percent_off",
    value:      { percent: 15 },
    conditions: { regions: ["US", "CA"] },
  });
  await tb.defineBenefit({
    slug:       "gold-usd-only",
    tier:       "gold",
    kind:       "percent_off",
    value:      { percent: 5 },
    conditions: { currencies: ["USD"] },
  });
  await tb.defineBenefit({
    slug:       "gold-window",
    tier:       "gold",
    kind:       "percent_off",
    value:      { percent: 30 },
    conditions: { starts_at: 1000, ends_at: 2000 },
  });

  var cust = _uuid();
  loy.set(cust, "gold");

  // Subtotal too low — free-ship excluded.
  var smallCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 100, currency: "USD", region: "US", now: 1500 });
  check("conditions: small cart excludes free-ship",
    !smallCart.some(function (p) { return p.slug === "gold-free-ship"; }));
  // But still has the unconditional gates that pass under this envelope.
  check("conditions: small cart keeps us-only",
    smallCart.some(function (p) { return p.slug === "gold-us-only"; }));
  check("conditions: small cart keeps usd-only",
    smallCart.some(function (p) { return p.slug === "gold-usd-only"; }));
  check("conditions: small cart keeps window",
    smallCart.some(function (p) { return p.slug === "gold-window"; }));

  // Subtotal high enough — free-ship included.
  var bigCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 9999, currency: "USD", region: "US", now: 1500 });
  check("conditions: big cart includes free-ship",
    bigCart.some(function (p) { return p.slug === "gold-free-ship"; }));

  // Wrong region — us-only excluded.
  var ukCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 9999, currency: "USD", region: "UK", now: 1500 });
  check("conditions: UK excludes us-only",
    !ukCart.some(function (p) { return p.slug === "gold-us-only"; }));

  // Wrong currency — usd-only excluded.
  var eurCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 9999, currency: "EUR", region: "US", now: 1500 });
  check("conditions: EUR excludes usd-only",
    !eurCart.some(function (p) { return p.slug === "gold-usd-only"; }));

  // Outside time window — window excluded.
  var earlyCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 9999, currency: "USD", region: "US", now: 500 });
  check("conditions: pre-window excludes window benefit",
    !earlyCart.some(function (p) { return p.slug === "gold-window"; }));
  var lateCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 9999, currency: "USD", region: "US", now: 2500 });
  check("conditions: post-window excludes window benefit",
    !lateCart.some(function (p) { return p.slug === "gold-window"; }));
  // Inside window — included.
  var inCart = await tb.benefitsForCustomer(cust, { subtotal_minor: 9999, currency: "USD", region: "US", now: 1500 });
  check("conditions: in-window includes window benefit",
    inCart.some(function (p) { return p.slug === "gold-window"; }));

  // Empty ctx — every condition that requires ctx fails closed.
  var noCtx = await tb.benefitsForCustomer(cust);
  check("conditions: empty ctx excludes free-ship",
    !noCtx.some(function (p) { return p.slug === "gold-free-ship"; }));
  check("conditions: empty ctx excludes us-only",
    !noCtx.some(function (p) { return p.slug === "gold-us-only"; }));
  check("conditions: empty ctx excludes usd-only",
    !noCtx.some(function (p) { return p.slug === "gold-usd-only"; }));

  // Conditions with starts_at without ends_at refused.
  await assert.rejects(
    tb.defineBenefit({
      slug:       "bad-cond",
      tier:       "gold",
      kind:       "percent_off",
      value:      { percent: 5 },
      conditions: { starts_at: 1000 },
    }),
    /must be paired/,
  );
  // Conditions starts_at >= ends_at refused.
  await assert.rejects(
    tb.defineBenefit({
      slug:       "bad-cond-2",
      tier:       "gold",
      kind:       "percent_off",
      value:      { percent: 5 },
      conditions: { starts_at: 2000, ends_at: 2000 },
    }),
    /ends_at/,
  );
}

// ---- recordUsage + metricsForBenefit -----------------------------------

async function _recordUsageAndMetrics() {
  var q   = _makeQuery();
  var tb  = tierBenefits.create({ query: q });

  await tb.defineBenefit({
    slug:  "free-ship",
    tier:  "platinum",
    kind:  "free_shipping",
    value: {},
  });

  var cust1 = _uuid();
  var cust2 = _uuid();

  var u1 = await tb.recordUsage({
    benefit_slug:  "free-ship",
    customer_id:   cust1,
    context:       "order:abc",
    savings_minor: 995,
    occurred_at:   1000,
  });
  check("recordUsage id present",            typeof u1.id === "string" && u1.id.length > 0);
  check("recordUsage echoes slug",           u1.benefit_slug === "free-ship");
  check("recordUsage echoes customer",       u1.customer_id === cust1);
  check("recordUsage echoes context",        u1.context === "order:abc");
  check("recordUsage echoes savings",        u1.savings_minor === 995);
  check("recordUsage echoes occurred_at",    u1.occurred_at === 1000);

  await tb.recordUsage({
    benefit_slug:  "free-ship",
    customer_id:   cust2,
    context:       "order:def",
    savings_minor: 1200,
    occurred_at:   2000,
  });
  // Usage row with NULL savings — count++ but sum unaffected.
  await tb.recordUsage({
    benefit_slug:  "free-ship",
    customer_id:   cust1,
    context:       "drop:zzz",
    occurred_at:   3000,
  });

  var feed = await tb.usageForBenefit({ slug: "free-ship", from: 0, to: 10000 });
  check("usageForBenefit length",            feed.length === 3);
  check("usageForBenefit DESC order",        feed[0].occurred_at === 3000);
  check("usageForBenefit second row",        feed[1].occurred_at === 2000);
  check("usageForBenefit null savings",      feed[0].savings_minor === null);

  // Filter by customer.
  var cust1Feed = await tb.usageForBenefit({
    slug: "free-ship", from: 0, to: 10000, customer_id: cust1,
  });
  check("usageForBenefit customer filter",   cust1Feed.length === 2);

  // Time window filter.
  var win = await tb.usageForBenefit({ slug: "free-ship", from: 1500, to: 2500 });
  check("usageForBenefit window",            win.length === 1);
  check("usageForBenefit window row",        win[0].occurred_at === 2000);

  // Metrics — count includes NULL-savings rows, sum excludes them.
  var m = await tb.metricsForBenefit("free-ship");
  check("metricsForBenefit count",           m.count === 3);
  check("metricsForBenefit count_savings",   m.count_with_savings === 2);
  check("metricsForBenefit sum",             m.sum_savings_minor === 995 + 1200);

  // Metrics windowed.
  var mWin = await tb.metricsForBenefit("free-ship", { from: 1500, to: 2500 });
  check("metricsForBenefit windowed count",      mWin.count === 1);
  check("metricsForBenefit windowed sum",        mWin.sum_savings_minor === 1200);

  // Empty window.
  var mNone = await tb.metricsForBenefit("free-ship", { from: 9000, to: 9999 });
  check("metricsForBenefit empty window count",  mNone.count === 0);
  check("metricsForBenefit empty window sum",    mNone.sum_savings_minor === 0);

  // recordUsage against unknown slug refused.
  await assert.rejects(
    tb.recordUsage({ benefit_slug: "no-such", customer_id: _uuid() }),
    /not found/,
  );

  // recordUsage against archived slug refused.
  await tb.defineBenefit({ slug: "doomed", tier: "gold", kind: "free_shipping", value: {} });
  await tb.archiveBenefit("doomed");
  await assert.rejects(
    tb.recordUsage({ benefit_slug: "doomed", customer_id: _uuid() }),
    /archived/,
  );
}

// ---- updateBenefit -----------------------------------------------------

async function _updateBenefit() {
  var q  = _makeQuery();
  var tb = tierBenefits.create({ query: q });

  await tb.defineBenefit({
    slug:  "to-update",
    tier:  "gold",
    kind:  "percent_off",
    value: { percent: 10 },
  });

  // Update value only.
  var v1 = await tb.updateBenefit("to-update", { value: { percent: 25 } });
  check("updateBenefit value",               v1.value.percent === 25);
  check("updateBenefit kind preserved",      v1.kind === "percent_off");
  check("updateBenefit tier preserved",      v1.tier === "gold");

  // Update tier.
  var v2 = await tb.updateBenefit("to-update", { tier: "platinum" });
  check("updateBenefit tier change",         v2.tier === "platinum");

  // Update conditions.
  var v3 = await tb.updateBenefit("to-update", {
    conditions: { min_order_minor: 1000 },
  });
  check("updateBenefit conditions",          v3.conditions.min_order_minor === 1000);

  // Clear conditions by passing null.
  var v4 = await tb.updateBenefit("to-update", { conditions: null });
  check("updateBenefit conditions cleared",  v4.conditions === null);

  // Kind change requires a fresh value.
  await assert.rejects(
    tb.updateBenefit("to-update", { kind: "free_shipping" }),
    /kind change requires a fresh value/,
  );

  // Kind change with new value succeeds.
  var v5 = await tb.updateBenefit("to-update", {
    kind:  "free_shipping",
    value: { min_order_minor: 0 },
  });
  check("updateBenefit kind change",         v5.kind === "free_shipping");
  check("updateBenefit kind change value",   v5.value.min_order_minor === 0);

  // Update with unknown key refused.
  await assert.rejects(
    tb.updateBenefit("to-update", { bogus: 1 }),
    /unknown patch key/,
  );

  // Update on archived slug refused.
  await tb.archiveBenefit("to-update");
  await assert.rejects(
    tb.updateBenefit("to-update", { tier: "gold" }),
    /archived/,
  );

  // Update on unknown slug refused.
  await assert.rejects(
    tb.updateBenefit("no-such-slug", { tier: "gold" }),
    /not found/,
  );

  // archiveBenefit on unknown slug refused.
  await assert.rejects(
    tb.archiveBenefit("no-such-slug"),
    /not found/,
  );

  // archiveBenefit is idempotent.
  var arch1 = await tb.archiveBenefit("to-update");
  check("archive idempotent",                typeof arch1.archived_at === "number");
}

// ---- input refusals ----------------------------------------------------

async function _refusals() {
  var tb = tierBenefits.create({ query: _makeQuery() });

  await assert.rejects(tb.defineBenefit(),           /input object required/);
  await assert.rejects(tb.defineBenefit({}),          /slug/);
  await assert.rejects(
    tb.defineBenefit({ slug: "x", tier: "gold", kind: "percent_off", value: null }),
    /value must be a plain object/,
  );
  await assert.rejects(
    tb.defineBenefit({ slug: "x", tier: "BAD TIER", kind: "percent_off", value: { percent: 5 } }),
    /tier must match/,
  );

  // benefitsForTier
  await assert.rejects(tb.benefitsForTier(),         /tier must be a non-empty string/);
  await assert.rejects(tb.benefitsForTier(""),       /tier must be a non-empty string/);

  // benefitsForCustomer — bad uuid
  await assert.rejects(
    tb.benefitsForCustomer("not-a-uuid"),
    /customer_id/,
  );

  // recordUsage
  await assert.rejects(tb.recordUsage(),             /input object required/);
  await assert.rejects(
    tb.recordUsage({ benefit_slug: "ok", customer_id: "not-a-uuid" }),
    /customer_id/,
  );
  await assert.rejects(
    tb.recordUsage({ benefit_slug: "ok", customer_id: _uuid(), savings_minor: -1 }),
    /savings_minor/,
  );
  await assert.rejects(
    tb.recordUsage({ benefit_slug: "BAD", customer_id: _uuid() }),
    /slug must match/,
  );

  // usageForBenefit
  await assert.rejects(tb.usageForBenefit(),         /filters object required/);
  await assert.rejects(
    tb.usageForBenefit({ slug: "x", from: 100, to: 50 }),
    /to must be >= from/,
  );
  await assert.rejects(
    tb.usageForBenefit({ slug: "x", from: 0, to: 100, limit: 0 }),
    /limit must be an integer/,
  );

  // metricsForBenefit
  await assert.rejects(
    tb.metricsForBenefit("x", { from: 100, to: 50 }),
    /to must be >= from/,
  );

  // updateBenefit + archiveBenefit
  await assert.rejects(tb.updateBenefit("x"),        /patch object required/);
  await assert.rejects(tb.updateBenefit("BAD"),      /slug must match/);
  await assert.rejects(tb.archiveBenefit("BAD"),     /slug must match/);
}

async function run() {
  await _defineEveryKind();
  await _benefitsForTier();
  await _benefitsForCustomer();
  await _conditionsFilter();
  await _recordUsageAndMetrics();
  await _updateBenefit();
  await _refusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - tier-benefits (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - tier-benefits: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
