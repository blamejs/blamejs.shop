"use strict";
/**
 * loyalty-earn-rules — per-action point-earning configuration.
 * Distinct from `loyalty` (ledger / balance) and `tierBenefits`
 * (perks). Defines HOW points are earned: per-dollar spent,
 * per-purchase, per-review, per-referral redemption, birthday,
 * signup, first-purchase, abandoned-cart-recovered.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0163.
 *
 * Coverage:
 *   - defineRule per trigger: stores rules across the full trigger
 *     enum; idempotent on same-slug re-define
 *   - evaluateForEvent math: per_dollar_spent multiplies, flat
 *     triggers award points_per_unit
 *   - awardForEvent composes loyalty.earn stub
 *   - max_per_event cap applied at evaluate + award
 *   - customer_status_in filter skips ineligible customers
 *   - metricsForRule aggregates over a window
 *   - dedup on (rule_slug, customer_id, trigger_event_ref)
 *   - validation surface refuses bad inputs
 *   - applyBatch runs many events
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop      = require("../../lib");
var earnRules  = require("../../lib/loyalty-earn-rules");
var helpers    = require("../helpers");
var check      = helpers.check;
var assert     = helpers.assert;

var MIG_RULES = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0163_loyalty_earn_rules.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_RULES, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
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

// Minimal loyalty stub — records earn() calls so the test can assert
// on composition without spinning up the real loyalty primitive's
// schema. The real loyalty handle exposes a richer surface; only
// `earn` is required by awardForEvent.
function _makeLoyaltyStub() {
  var calls = [];
  var failNext = null;
  return {
    calls:    calls,
    failNext: function (err) { failNext = err; },
    earn:     async function (input) {
      if (failNext) {
        var e = failNext;
        failNext = null;
        throw e;
      }
      calls.push(input);
      return { balance: 0, lifetime: 0, tier: "bronze", tier_changed: false };
    },
  };
}

function _factory(loyaltyHandle) {
  var h = _makeQuery();
  return {
    db:      h.db,
    query:   h.query,
    loyalty: loyaltyHandle,
    rules:   earnRules.create({ query: h.query, loyalty: loyaltyHandle || null }),
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- defineRule per trigger --------------------------------------------

async function _defineRulePerTrigger() {
  var f = _factory();

  // Define one rule per trigger from the closed enum.
  var triggers = [
    { slug: "spend-per-dollar",   trigger: "per_dollar_spent",         points_per_unit: 1, max_per_event: 5000 },
    { slug: "flat-per-purchase",  trigger: "per_purchase",             points_per_unit: 50 },
    { slug: "review-bonus",       trigger: "per_review",               points_per_unit: 25 },
    { slug: "referral-redeemed",  trigger: "per_referral_redeemed",    points_per_unit: 500 },
    { slug: "birthday-bonus",     trigger: "birthday",                 points_per_unit: 200 },
    { slug: "signup-bonus",       trigger: "signup_bonus",             points_per_unit: 100 },
    { slug: "first-purchase",     trigger: "first_purchase",           points_per_unit: 300 },
    { slug: "cart-recovered",     trigger: "abandoned_cart_recovered", points_per_unit: 75 },
  ];
  for (var i = 0; i < triggers.length; i += 1) {
    var t = triggers[i];
    var rule = await f.rules.defineRule(t);
    check("defineRule " + t.trigger + " slug",      rule.slug === t.slug);
    check("defineRule " + t.trigger + " trigger",   rule.trigger === t.trigger);
    check("defineRule " + t.trigger + " points",    rule.points_per_unit === t.points_per_unit);
    check("defineRule " + t.trigger + " active",    rule.active === true);
    check("defineRule " + t.trigger + " archived",  rule.archived_at === null);
  }

  // listRules surfaces every active rule.
  var listed = await f.rules.listRules({ active_only: true });
  check("listRules active_only count", listed.length === triggers.length);
  for (var L = 0; L < listed.length - 1; L += 1) {
    check("listRules slug ordering", listed[L].slug <= listed[L + 1].slug);
  }

  // Re-defining the same slug updates atomically.
  var updated = await f.rules.defineRule({
    slug:             "spend-per-dollar",
    trigger:          "per_dollar_spent",
    points_per_unit:  2,
    max_per_event:    10000,
  });
  check("defineRule re-define points",  updated.points_per_unit === 2);
  check("defineRule re-define max",     updated.max_per_event === 10000);

  // getRule round-trips.
  var fetched = await f.rules.getRule("birthday-bonus");
  check("getRule round-trip", fetched && fetched.slug === "birthday-bonus" && fetched.trigger === "birthday");

  // Unknown slug returns null.
  var miss = await f.rules.getRule("not-a-rule");
  check("getRule unknown null", miss === null);
}

// ---- evaluateForEvent math ---------------------------------------------

async function _evaluateForEventMath() {
  var f = _factory();

  await f.rules.defineRule({
    slug:             "dollar-rule",
    trigger:          "per_dollar_spent",
    points_per_unit:  3,
  });
  await f.rules.defineRule({
    slug:             "flat-purchase",
    trigger:          "per_purchase",
    points_per_unit:  150,
  });

  // per_dollar_spent: 3 * 42 = 126.
  var dollarEval = await f.rules.evaluateForEvent({
    trigger:        "per_dollar_spent",
    customer_id:    _uuid(),
    dollars_spent:  42,
  });
  check("evaluate per_dollar_spent total", dollarEval.total_points === 126);
  check("evaluate per_dollar_spent verdicts len", dollarEval.verdicts.length === 1);
  check("evaluate per_dollar_spent eligible",     dollarEval.verdicts[0].eligible === true);
  check("evaluate per_dollar_spent points",       dollarEval.verdicts[0].points === 126);

  // per_purchase: flat 150 regardless of dollars.
  var flatEval = await f.rules.evaluateForEvent({
    trigger:        "per_purchase",
    customer_id:    _uuid(),
    dollars_spent:  9999,
  });
  check("evaluate per_purchase flat total", flatEval.total_points === 150);

  // Floor on fractional dollars: 12.99 -> 12 units.
  var fracEval = await f.rules.evaluateForEvent({
    trigger:        "per_dollar_spent",
    customer_id:    _uuid(),
    dollars_spent:  12.99,
  });
  check("evaluate fractional dollars floored", fracEval.total_points === 36);

  // Zero dollars -> zero points but rule is "ineligible" not failure.
  var zeroEval = await f.rules.evaluateForEvent({
    trigger:        "per_dollar_spent",
    customer_id:    _uuid(),
    dollars_spent:  0,
  });
  check("evaluate zero dollars total zero",    zeroEval.total_points === 0);
  check("evaluate zero dollars not eligible",  zeroEval.verdicts[0].eligible === false);

  // No matching rule -> empty verdicts.
  var noMatch = await f.rules.evaluateForEvent({
    trigger:        "per_review",
    customer_id:    _uuid(),
  });
  check("evaluate no matching rule",  noMatch.total_points === 0 && noMatch.verdicts.length === 0);
}

// ---- awardForEvent composes loyalty stub --------------------------------

async function _awardForEventComposesLoyalty() {
  var loyaltyStub = _makeLoyaltyStub();
  var f = _factory(loyaltyStub);

  await f.rules.defineRule({
    slug:             "purchase-bonus",
    trigger:          "per_purchase",
    points_per_unit:  100,
  });

  var customerId = _uuid();
  var orderId    = _uuid();
  var result = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       customerId,
    trigger_event_ref: "order:" + orderId,
  });

  check("award total_points 100",          result.total_points === 100);
  check("award awarded length 1",          result.awarded.length === 1);
  check("award skipped empty",             result.skipped.length === 0);
  check("award entry slug",                result.awarded[0].slug === "purchase-bonus");
  check("award entry points",              result.awarded[0].points === 100);
  check("award entry log_id shape",        typeof result.awarded[0].log_id === "string"
                                            && result.awarded[0].log_id.length === 36);

  // Loyalty stub was called.
  check("loyalty.earn called once",        loyaltyStub.calls.length === 1);
  check("loyalty.earn customer",           loyaltyStub.calls[0].customer_id === customerId);
  check("loyalty.earn points",             loyaltyStub.calls[0].points === 100);
  check("loyalty.earn source",             loyaltyStub.calls[0].source === "earn-rule.purchase-bonus");

  // Audit log row landed.
  var logRow = f.db.prepare("SELECT * FROM loyalty_earn_log WHERE customer_id = ?").all(customerId)[0];
  check("audit log row landed",            logRow && logRow.rule_slug === "purchase-bonus");
  check("audit log points",                Number(logRow.points_awarded) === 100);
  check("audit log event ref",             logRow.trigger_event_ref === "order:" + orderId);

  // Replay with same trigger_event_ref: dedup-skipped, loyalty NOT called twice.
  var replay = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       customerId,
    trigger_event_ref: "order:" + orderId,
  });
  check("replay awarded empty",            replay.awarded.length === 0);
  check("replay skipped 1 entry",          replay.skipped.length === 1);
  check("replay skip reason dedup",        /duplicate trigger_event_ref/.test(replay.skipped[0].reason));
  check("loyalty.earn still called once",  loyaltyStub.calls.length === 1);

  // Loyalty failure rolls back the audit row so a retry isn't dedup-blocked.
  var loyaltyStub2 = _makeLoyaltyStub();
  var f2 = _factory(loyaltyStub2);
  await f2.rules.defineRule({
    slug:             "review-bonus",
    trigger:          "per_review",
    points_per_unit:  25,
  });
  var c2 = _uuid();
  loyaltyStub2.failNext(new Error("ledger temporarily unavailable"));
  await assert.rejects(
    f2.rules.awardForEvent({
      trigger:           "per_review",
      customer_id:       c2,
      trigger_event_ref: "review:" + _uuid(),
    }),
    /ledger temporarily unavailable/,
  );
  var rolledBack = f2.db.prepare("SELECT COUNT(*) AS c FROM loyalty_earn_log WHERE customer_id = ?")
                        .all(c2)[0];
  check("audit log rolled back on loyalty failure", Number(rolledBack.c) === 0);
}

// ---- max_per_event cap --------------------------------------------------

async function _maxPerEventCap() {
  var loyaltyStub = _makeLoyaltyStub();
  var f = _factory(loyaltyStub);

  await f.rules.defineRule({
    slug:             "spend-capped",
    trigger:          "per_dollar_spent",
    points_per_unit:  10,
    max_per_event:    500,
  });

  // 100 dollars * 10 = 1000 uncapped; capped at 500.
  var customerId = _uuid();
  var evalRes = await f.rules.evaluateForEvent({
    trigger:        "per_dollar_spent",
    customer_id:    customerId,
    dollars_spent:  100,
  });
  check("evaluate capped points",          evalRes.total_points === 500);
  check("evaluate capped flag",            evalRes.verdicts[0].capped === true);
  check("evaluate cap reason mentions max", /capped at max_per_event=500/.test(evalRes.verdicts[0].reason));

  // Award honors the cap.
  var awardRes = await f.rules.awardForEvent({
    trigger:           "per_dollar_spent",
    customer_id:       customerId,
    trigger_event_ref: "order:" + _uuid(),
    dollars_spent:     100,
  });
  check("award capped points",             awardRes.total_points === 500);
  check("award capped entry flag",         awardRes.awarded[0].capped === true);
  check("loyalty.earn received capped",    loyaltyStub.calls[0].points === 500);

  // Under-cap: uncapped path returns false on capped flag.
  var underRes = await f.rules.awardForEvent({
    trigger:           "per_dollar_spent",
    customer_id:       _uuid(),
    trigger_event_ref: "order:" + _uuid(),
    dollars_spent:     10,
  });
  check("under-cap points",                underRes.total_points === 100);
  check("under-cap not flagged",           underRes.awarded[0].capped === false);
}

// ---- customer_status filter --------------------------------------------

async function _customerStatusFilter() {
  var loyaltyStub = _makeLoyaltyStub();
  var f = _factory(loyaltyStub);

  await f.rules.defineRule({
    slug:                "vip-only",
    trigger:             "per_purchase",
    points_per_unit:     200,
    customer_status_in:  ["vip", "platinum"],
  });

  // VIP customer gets the points.
  var vipResult = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       _uuid(),
    trigger_event_ref: "order:" + _uuid(),
    customer_status:   "vip",
  });
  check("vip status awarded",              vipResult.total_points === 200);
  check("vip status awarded length 1",     vipResult.awarded.length === 1);

  // Active (non-VIP) customer is filtered.
  var activeResult = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       _uuid(),
    trigger_event_ref: "order:" + _uuid(),
    customer_status:   "active",
  });
  check("active status filtered",          activeResult.total_points === 0);
  check("active status skipped 1",         activeResult.skipped.length === 1);
  check("active status reason status",     /customer_status="active" not in/.test(activeResult.skipped[0].reason));

  // Missing customer_status when rule restricts is filtered.
  var missingResult = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       _uuid(),
    trigger_event_ref: "order:" + _uuid(),
  });
  check("missing status filtered",         missingResult.total_points === 0);
  check("missing status skipped",          missingResult.skipped.length === 1);

  // Loyalty stub only saw the VIP award.
  check("loyalty.earn vip only",           loyaltyStub.calls.length === 1
                                            && loyaltyStub.calls[0].points === 200);

  // Define an unrestricted rule alongside — both rules evaluate on
  // the same trigger, but the customer_status_in gate prunes the
  // VIP-only rule for non-VIP customers.
  await f.rules.defineRule({
    slug:             "everyone-purchase",
    trigger:          "per_purchase",
    points_per_unit:  10,
  });
  var multiResult = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       _uuid(),
    trigger_event_ref: "order:" + _uuid(),
    customer_status:   "active",
  });
  // Only the everyone rule fires (10 points), vip-only is filtered.
  check("multi-rule everyone fires",       multiResult.total_points === 10);
  check("multi-rule everyone awarded",     multiResult.awarded.length === 1);
  check("multi-rule vip skipped",          multiResult.skipped.length === 1);
}

// ---- metricsForRule -----------------------------------------------------

async function _metricsForRuleWindow() {
  var loyaltyStub = _makeLoyaltyStub();
  var f = _factory(loyaltyStub);
  await f.rules.defineRule({
    slug:             "metric-rule",
    trigger:          "per_purchase",
    points_per_unit:  50,
  });

  // Award across 5 customers + 1 duplicate retry.
  var customers = [];
  for (var i = 0; i < 5; i += 1) {
    var cid = _uuid();
    customers.push(cid);
    await f.rules.awardForEvent({
      trigger:           "per_purchase",
      customer_id:       cid,
      trigger_event_ref: "order:" + _uuid(),
    });
  }
  // Replay against an existing customer with the SAME event ref — dedup skip.
  await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       customers[0],
    trigger_event_ref: "order:dup",
  });
  // Fresh event ref for the same customer — counts as another award.
  await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       customers[0],
    trigger_event_ref: "order:fresh",
  });

  // Hand-stamp the earliest row for customers[0] backward so the window
  // slicing is exercised. SQLite without SQLITE_ENABLE_UPDATE_DELETE_LIMIT
  // rejects UPDATE ... LIMIT, so we target by row id instead.
  var earliestRow = f.db.prepare(
    "SELECT id FROM loyalty_earn_log WHERE customer_id = ? ORDER BY occurred_at ASC",
  ).all(customers[0])[0];
  f.db.prepare("UPDATE loyalty_earn_log SET occurred_at = ? WHERE id = ?")
       .run(1, earliestRow.id);

  var metrics = await f.rules.metricsForRule({ slug: "metric-rule" });
  check("metrics award_count 7",           metrics.award_count === 7);
  check("metrics unique_customers 5",      metrics.unique_customers === 5);
  check("metrics total_points 350",        metrics.total_points === 350);
  check("metrics first_award 1",           metrics.first_award === 1);
  check("metrics trigger",                 metrics.trigger === "per_purchase");

  // Window filter: from=2 excludes the stamped-back row.
  var windowed = await f.rules.metricsForRule({ slug: "metric-rule", from: 2 });
  check("metrics windowed count 6",        windowed.award_count === 6);
  check("metrics windowed points 300",     windowed.total_points === 300);

  // Unknown slug -> null.
  var missMetrics = await f.rules.metricsForRule({ slug: "nope" });
  check("metrics unknown null",            missMetrics === null);

  // Invalid window: from > to refused.
  await assert.rejects(
    f.rules.metricsForRule({ slug: "metric-rule", from: 100, to: 50 }),
    /from must be <= to/,
  );
}

// ---- archive / update / applyBatch / validation -------------------------

async function _archiveAndUpdateAndBatch() {
  var loyaltyStub = _makeLoyaltyStub();
  var f = _factory(loyaltyStub);

  await f.rules.defineRule({
    slug:             "patch-rule",
    trigger:          "per_purchase",
    points_per_unit:  10,
  });

  // updateRule allows changes to points / cap / status / active.
  var updated = await f.rules.updateRule("patch-rule", {
    points_per_unit:     20,
    max_per_event:       100,
    customer_status_in:  ["active"],
  });
  check("update points_per_unit",          updated.points_per_unit === 20);
  check("update max_per_event",            updated.max_per_event === 100);
  check("update customer_status_in",       updated.customer_status_in.length === 1
                                            && updated.customer_status_in[0] === "active");

  // updateRule refuses changing trigger.
  await assert.rejects(
    f.rules.updateRule("patch-rule", { trigger: "birthday" }),
    /trigger is immutable/,
  );

  // archiveRule flips active off + sets archived_at + future awards skip.
  var archived = await f.rules.archiveRule("patch-rule");
  check("archived archived_at set",        typeof archived.archived_at === "number");
  check("archived active false",           archived.active === false);

  var afterArchive = await f.rules.awardForEvent({
    trigger:           "per_purchase",
    customer_id:       _uuid(),
    trigger_event_ref: "order:" + _uuid(),
    customer_status:   "active",
  });
  check("archived rule awards zero",       afterArchive.total_points === 0);
  check("archived rule awarded empty",     afterArchive.awarded.length === 0);

  // defineRule on archived slug refused.
  await assert.rejects(
    f.rules.defineRule({
      slug:             "patch-rule",
      trigger:          "per_purchase",
      points_per_unit:  1,
    }),
    /is archived/,
  );

  // updateRule on archived refused.
  await assert.rejects(
    f.rules.updateRule("patch-rule", { points_per_unit: 5 }),
    /is archived/,
  );

  // archiveRule on unknown slug returns null.
  var missArch = await f.rules.archiveRule("nope-rule");
  check("archive unknown null",            missArch === null);

  // applyBatch — fresh fixture so the archived rule doesn't interfere.
  var f2 = _factory(_makeLoyaltyStub());
  await f2.rules.defineRule({
    slug:             "batch-rule",
    trigger:          "per_purchase",
    points_per_unit:  10,
  });

  var batchEvents = [
    { trigger: "per_purchase", customer_id: _uuid(), trigger_event_ref: "ord:1" },
    { trigger: "per_purchase", customer_id: _uuid(), trigger_event_ref: "ord:2" },
    { trigger: "per_purchase", customer_id: _uuid(), trigger_event_ref: "ord:3" },
    "not-an-object",
    { trigger: "per_purchase" },   // missing customer_id -> failed
  ];
  var batchResult = await f2.rules.applyBatch({ events: batchEvents });
  check("batch total_events",              batchResult.total_events === 5);
  check("batch awarded length 3",          batchResult.awarded.length === 3);
  check("batch total_points 30",           batchResult.total_points === 30);
  check("batch failed length 2",           batchResult.failed.length === 2);
  check("batch failed[0] index 3",         batchResult.failed[0].index === 3);
  check("batch failed[0] reason",          /event must be an object/.test(batchResult.failed[0].reason));
  check("batch failed[1] index 4",         batchResult.failed[1].index === 4);
}

// ---- validation surface -------------------------------------------------

async function _validationSurface() {
  var f = _factory();

  // defineRule
  await assert.rejects(f.rules.defineRule(),                                          /input object required/);
  await assert.rejects(f.rules.defineRule({}),                                        /slug/);
  await assert.rejects(f.rules.defineRule({ slug: "Bad Slug" }),                      /slug/);
  await assert.rejects(f.rules.defineRule({ slug: "ok" }),                            /trigger/);
  await assert.rejects(f.rules.defineRule({ slug: "ok", trigger: "bogus" }),          /trigger/);
  await assert.rejects(
    f.rules.defineRule({ slug: "ok", trigger: "per_purchase", points_per_unit: 0 }),
    /points_per_unit/,
  );
  await assert.rejects(
    f.rules.defineRule({ slug: "ok", trigger: "per_purchase", points_per_unit: -1 }),
    /points_per_unit/,
  );
  await assert.rejects(
    f.rules.defineRule({ slug: "ok", trigger: "per_purchase", points_per_unit: 1.5 }),
    /points_per_unit/,
  );
  await assert.rejects(
    f.rules.defineRule({
      slug: "ok", trigger: "per_purchase", points_per_unit: 10, max_per_event: 0,
    }),
    /max_per_event/,
  );
  await assert.rejects(
    f.rules.defineRule({
      slug: "ok", trigger: "per_purchase", points_per_unit: 10, customer_status_in: [],
    }),
    /non-empty/,
  );
  await assert.rejects(
    f.rules.defineRule({
      slug: "ok", trigger: "per_purchase", points_per_unit: 10, customer_status_in: ["Bad Status"],
    }),
    /customer_status_in/,
  );
  await assert.rejects(
    f.rules.defineRule({
      slug: "ok", trigger: "per_purchase", points_per_unit: 10,
      customer_status_in: ["active", "active"],
    }),
    /duplicates a previous entry/,
  );

  // Seed a real rule for the entry-point tests.
  await f.rules.defineRule({
    slug:             "live",
    trigger:          "per_purchase",
    points_per_unit:  10,
  });

  // evaluateForEvent
  await assert.rejects(f.rules.evaluateForEvent(),                                                /input object required/);
  await assert.rejects(f.rules.evaluateForEvent({ trigger: "bogus" }),                            /trigger/);
  await assert.rejects(
    f.rules.evaluateForEvent({ trigger: "per_purchase", customer_id: "not-a-uuid" }),
    /customer_id/,
  );

  // awardForEvent
  await assert.rejects(f.rules.awardForEvent(),                                                   /input object required/);
  await assert.rejects(
    f.rules.awardForEvent({ trigger: "per_purchase", customer_id: _uuid() }),
    /trigger_event_ref/,
  );
  await assert.rejects(
    f.rules.awardForEvent({
      trigger: "per_purchase", customer_id: _uuid(), trigger_event_ref: "  has spaces  ",
    }),
    /trigger_event_ref/,
  );

  // updateRule
  await assert.rejects(f.rules.updateRule("Bad Slug", {}),                                         /slug/);
  await assert.rejects(f.rules.updateRule("live"),                                                 /patch object required/);
  await assert.rejects(
    f.rules.updateRule("live", { points_per_unit: -1 }),
    /points_per_unit/,
  );
  var missUpdate = await f.rules.updateRule("unknown-slug", { points_per_unit: 10 });
  check("updateRule unknown null", missUpdate === null);

  // archiveRule
  await assert.rejects(f.rules.archiveRule("Bad Slug"),                                            /slug/);

  // metricsForRule
  await assert.rejects(f.rules.metricsForRule(),                                                   /input object required/);
  await assert.rejects(f.rules.metricsForRule({ slug: "Bad" }),                                    /slug/);

  // applyBatch
  await assert.rejects(f.rules.applyBatch(),                                                       /input object required/);
  await assert.rejects(f.rules.applyBatch({ events: [] }),                                         /non-empty array/);
  await assert.rejects(f.rules.applyBatch({ events: "x" }),                                        /non-empty array/);
  await assert.rejects(
    f.rules.applyBatch({ events: [{ trigger: "per_purchase" }], rules: "not-array" }),
    /rules must be an array/,
  );

  // listRules
  await assert.rejects(f.rules.listRules({ limit: 0 }),                                            /limit/);
  await assert.rejects(f.rules.listRules({ trigger: "bogus" }),                                    /trigger/);
}

// ---- exported constants -------------------------------------------------

async function _exportedConstants() {
  check("TRIGGERS exported",                Array.isArray(earnRules.TRIGGERS)
                                              && earnRules.TRIGGERS.indexOf("per_dollar_spent") !== -1
                                              && earnRules.TRIGGERS.indexOf("birthday") !== -1
                                              && earnRules.TRIGGERS.indexOf("abandoned_cart_recovered") !== -1);
  check("UNIT_TRIGGERS exported",           typeof earnRules.UNIT_TRIGGERS === "object"
                                              && earnRules.UNIT_TRIGGERS.per_dollar_spent === "dollars_spent");
  check("MAX_POINTS_PER_UNIT exported",     typeof earnRules.MAX_POINTS_PER_UNIT === "number"
                                              && earnRules.MAX_POINTS_PER_UNIT > 0);
  check("MAX_MAX_PER_EVENT exported",       typeof earnRules.MAX_MAX_PER_EVENT === "number"
                                              && earnRules.MAX_MAX_PER_EVENT > 0);

  var inst = earnRules.create({ query: _makeQuery().query });
  check("instance exposes TRIGGERS",         inst.TRIGGERS.length === earnRules.TRIGGERS.length);
  check("instance exposes UNIT_TRIGGERS",    inst.UNIT_TRIGGERS.per_dollar_spent === "dollars_spent");
}

async function run() {
  await _defineRulePerTrigger();
  await _evaluateForEventMath();
  await _awardForEventComposesLoyalty();
  await _maxPerEventCap();
  await _customerStatusFilter();
  await _metricsForRuleWindow();
  await _archiveAndUpdateAndBatch();
  await _validationSurface();
  await _exportedConstants();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(
    function () {
      console.log("ok - loyalty-earn-rules (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
