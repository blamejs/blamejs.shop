"use strict";
/**
 * customer-merge — operator-driven consolidation of duplicate
 * customer accounts. proposeMerge / executeMerge / rollbackMerge
 * orchestrate the multi-table reparent through injected child
 * primitives; redirect marker resolves a stale source id to its
 * canonical target.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0194_customer_merge.sql`. Every child primitive (customers,
 * order, subscriptions, loyalty, reviews, addresses,
 * paymentMethods) is stubbed locally so the test exercises the
 * orchestration in isolation.
 *
 * Coverage:
 *   - findDuplicateCandidates pairs above the similarity floor;
 *     already-redirected sources excluded; ordered by similarity
 *     DESC
 *   - proposeMerge captures a frozen plan from countForCustomer
 *     across every wired child; refuses self-merge / chained
 *     redirect / duplicate proposal / unknown ids
 *   - executeMerge pre-flights the count, commits every reparent
 *     atomically, archives the source customer, and writes the
 *     redirect marker; refuses non-proposed merges + plan drift
 *   - rollbackMerge reverses every reparent within the 7-day
 *     window; restores the source customer; clears the redirect
 *     marker; refuses past the window
 *   - cancelMerge drops a proposed plan; idempotent on cancelled;
 *     refuses on executed / rolled_back
 *   - historyForCustomer surfaces merges as source OR target
 *   - listMerges filters on status + date range
 *   - redirectFor resolves a stale id to canonical; null on miss
 *   - factory refuses missing customers handle / malformed child
 *     handles
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var customerMerge = require("../../lib/customer-merge");
var bShop         = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0194_customer_merge.sql"
);

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
        changes:   Number(info.changes),
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- stubs -------------------------------------------------------------
//
// Every child primitive is stubbed with a Map of customer_id ->
// row-count + a `transfers` log so the test can assert which
// reparents fired in what order.

function _customersStub(opts) {
  opts = opts || {};
  var rows = Object.create(null);
  var archives = [];
  var restores = [];
  var seed = opts.seed || [];
  for (var i = 0; i < seed.length; i += 1) {
    rows[seed[i].id] = { id: seed[i].id, display_name: seed[i].display_name, archived: false };
  }
  return {
    rows: rows,
    archives: archives,
    restores: restores,
    add: function (id, displayName) {
      rows[id] = { id: id, display_name: displayName, archived: false };
    },
    getCustomerById: async function (id) {
      var row = rows[id];
      return row ? { id: row.id, display_name: row.display_name, archived: row.archived } : null;
    },
    archiveCustomer: async function (id) {
      if (!rows[id]) throw new Error("stub: customer not found " + id);
      rows[id].archived = true;
      archives.push(id);
    },
    restoreCustomer: async function (id) {
      if (!rows[id]) throw new Error("stub: customer not found " + id);
      rows[id].archived = false;
      restores.push(id);
    },
    listForCandidates: async function (listOpts) {
      var out = [];
      var keys = Object.keys(rows);
      var limit = (listOpts && listOpts.limit) || keys.length;
      for (var k = 0; k < keys.length && out.length < limit; k += 1) {
        var r = rows[keys[k]];
        if (r.archived) continue;
        out.push({ id: r.id, display_name: r.display_name });
      }
      return { rows: out };
    },
  };
}

function _childStub() {
  var byCustomer = Object.create(null);
  var transfers = [];
  return {
    byCustomer: byCustomer,
    transfers: transfers,
    set: function (id, n) { byCustomer[id] = n; },
    countForCustomer: async function (id) {
      return byCustomer[id] || 0;
    },
    reparentForCustomer: async function (fromId, toId) {
      var n = byCustomer[fromId] || 0;
      delete byCustomer[fromId];
      byCustomer[toId] = (byCustomer[toId] || 0) + n;
      transfers.push({ from: fromId, to: toId, rowCount: n });
      return { rowCount: n };
    },
  };
}

function _setup(opts) {
  opts = opts || {};
  var query    = _makeQuery();
  var customers = _customersStub({ seed: opts.seed });
  var order          = _childStub();
  var subscriptions  = _childStub();
  var loyalty        = _childStub();
  var reviews        = _childStub();
  var addresses      = _childStub();
  var paymentMethods = _childStub();

  var cm = customerMerge.create({
    query:          query,
    customers:      customers,
    order:          order,
    subscriptions:  subscriptions,
    loyalty:        loyalty,
    reviews:        reviews,
    addresses:      addresses,
    paymentMethods: paymentMethods,
  });
  return {
    query: query,
    cm: cm,
    customers: customers,
    order: order,
    subscriptions: subscriptions,
    loyalty: loyalty,
    reviews: reviews,
    addresses: addresses,
    paymentMethods: paymentMethods,
  };
}

// ---- tests -------------------------------------------------------------

async function _findDuplicateCandidates() {
  var sourceId = _uuid();
  var targetId = _uuid();
  var unrelated = _uuid();
  var alreadyMergedSource = _uuid();
  var alreadyMergedTarget = _uuid();

  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Jane Smith" },
      { id: targetId, display_name: "Jane Smyth" },
      { id: unrelated, display_name: "Bob Jones" },
      { id: alreadyMergedSource, display_name: "Pat Lee" },
      { id: alreadyMergedTarget, display_name: "Pat Lee" },
    ],
  });

  // No candidates yet — pair must be above default 0.85 floor.
  var hits = await ctx.cm.findDuplicateCandidates({ limit: 10 });
  check("findDuplicateCandidates returns Jane pair",
    hits.length >= 1 &&
    hits.some(function (h) {
      return (h.a_id === sourceId && h.b_id === targetId) ||
             (h.a_id === targetId && h.b_id === sourceId);
    }));
  check("findDuplicateCandidates Jane similarity above floor",
    hits[0].similarity >= 0.85);
  check("findDuplicateCandidates excludes Bob Jones (unrelated)",
    hits.every(function (h) { return h.a_id !== unrelated && h.b_id !== unrelated; }));

  // Wire a merge that lands as executed, so alreadyMergedSource
  // gets a redirect — it must drop out of candidate scans.
  var p = await ctx.cm.proposeMerge({
    source_customer_id: alreadyMergedSource,
    target_customer_id: alreadyMergedTarget,
    requested_by:       "operator-a",
  });
  await ctx.cm.executeMerge({ merge_id: p.id, executed_by: "operator-b" });

  var afterMerge = await ctx.cm.findDuplicateCandidates({ limit: 10 });
  check("findDuplicateCandidates excludes already-merged source",
    afterMerge.every(function (h) {
      return h.a_id !== alreadyMergedSource && h.b_id !== alreadyMergedSource;
    }));

  // Lower the similarity floor — picks up looser pairs.
  var loose = await ctx.cm.findDuplicateCandidates({
    limit: 50, similarity_min: 0.5,
  });
  check("lower similarity floor finds more pairs", loose.length >= hits.length);

  // Refusals.
  await assert.rejects(ctx.cm.findDuplicateCandidates({ limit: 0 }),     /limit/);
  await assert.rejects(ctx.cm.findDuplicateCandidates({ limit: 9999 }),  /limit/);
  await assert.rejects(ctx.cm.findDuplicateCandidates({ similarity_min: 2 }),   /similarity_min/);
  await assert.rejects(ctx.cm.findDuplicateCandidates({ similarity_min: -1 }),  /similarity_min/);
  await assert.rejects(ctx.cm.findDuplicateCandidates({ similarity_min: "x" }), /similarity_min/);
}

async function _proposeMergePlan() {
  var sourceId = _uuid();
  var targetId = _uuid();
  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Jane Smith" },
      { id: targetId, display_name: "Jane Smyth" },
    ],
  });

  // Wire child counts for the source.
  ctx.order.set(sourceId, 3);
  ctx.subscriptions.set(sourceId, 1);
  ctx.loyalty.set(sourceId, 7);
  ctx.reviews.set(sourceId, 2);
  ctx.addresses.set(sourceId, 2);
  ctx.paymentMethods.set(sourceId, 1);

  var proposal = await ctx.cm.proposeMerge({
    source_customer_id: sourceId,
    target_customer_id: targetId,
    requested_by:       "operator-a",
  });
  check("proposeMerge returns id",            typeof proposal.id === "string" && proposal.id.length > 0);
  check("proposeMerge status proposed",       proposal.status === "proposed");
  check("proposeMerge captures plan.orders",  proposal.plan.orders === 3);
  check("proposeMerge captures plan.subscriptions", proposal.plan.subscriptions === 1);
  check("proposeMerge captures plan.loyalty_entries", proposal.plan.loyalty_entries === 7);
  check("proposeMerge captures plan.reviews", proposal.plan.reviews === 2);
  check("proposeMerge captures plan.addresses", proposal.plan.addresses === 2);
  check("proposeMerge captures plan.payment_methods", proposal.plan.payment_methods === 1);
  check("proposeMerge captures plan.total_rows", proposal.plan.total_rows === 16);
  check("proposeMerge requested_by recorded", proposal.requested_by === "operator-a");
  check("proposeMerge executed_at null",      proposal.executed_at === null);
  check("proposeMerge created_at numeric",    typeof proposal.created_at === "number");

  // No reparents fired during proposal.
  check("no reparents during proposal",        ctx.order.transfers.length === 0);

  // Self-merge refused.
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: sourceId,
    requested_by: "operator-a",
  }), /source_customer_id and target_customer_id must differ/);

  // Unknown source refused.
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: _uuid(), target_customer_id: targetId,
    requested_by: "operator-a",
  }), /source_customer_id .* not found/);

  // Unknown target refused.
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: _uuid(),
    requested_by: "operator-a",
  }), /target_customer_id .* not found/);

  // Duplicate proposal refused.
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "operator-a",
  }), /proposed plan already exists/);

  // Refusals on shape.
  await assert.rejects(ctx.cm.proposeMerge(), /input object required/);
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: "not-a-uuid", target_customer_id: targetId,
    requested_by: "op",
  }), /source_customer_id/);
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "",
  }), /requested_by/);
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "op\x00bad",
  }), /requested_by/);
}

async function _executeMergeReparents() {
  var sourceId = _uuid();
  var targetId = _uuid();
  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Jane Smith" },
      { id: targetId, display_name: "Jane Smyth" },
    ],
  });
  ctx.order.set(sourceId, 2);
  ctx.order.set(targetId, 1);
  ctx.subscriptions.set(sourceId, 1);
  ctx.loyalty.set(sourceId, 5);

  var p = await ctx.cm.proposeMerge({
    source_customer_id: sourceId,
    target_customer_id: targetId,
    requested_by:       "operator-a",
  });
  var executed = await ctx.cm.executeMerge({
    merge_id:    p.id,
    executed_by: "operator-b",
  });

  check("executeMerge status executed",         executed.status === "executed");
  check("executeMerge stamps executed_at",      typeof executed.executed_at === "number");
  check("executeMerge stamps executed_by",      executed.executed_by === "operator-b");
  check("executeMerge preserves plan",          executed.plan.orders === 2);
  check("executeMerge records actual counts",   executed.plan.actual && executed.plan.actual.orders === 2);
  check("executeMerge actual total matches plan",
    executed.plan.actual.total_rows === executed.plan.total_rows);

  // Every wired child saw a reparent call.
  check("order reparent fired",          ctx.order.transfers.length === 1);
  check("order reparent direction",      ctx.order.transfers[0].from === sourceId && ctx.order.transfers[0].to === targetId);
  check("subscriptions reparent fired",  ctx.subscriptions.transfers.length === 1);
  check("loyalty reparent fired",        ctx.loyalty.transfers.length === 1);
  check("reviews reparent fired (0 count)", ctx.reviews.transfers.length === 1);

  // Source customer archived.
  check("source customer archived",      ctx.customers.archives.length === 1 && ctx.customers.archives[0] === sourceId);
  var srcRow = await ctx.customers.getCustomerById(sourceId);
  check("source customer flag archived", srcRow.archived === true);

  // Order rows landed on the target.
  check("orders reparented onto target", ctx.order.byCustomer[targetId] === 3);
  check("orders cleared from source",    ctx.order.byCustomer[sourceId] == null);

  // Redirect marker exists.
  var redirect = await ctx.cm.redirectFor(sourceId);
  check("redirectFor resolves source -> target", redirect != null && redirect.target_customer_id === targetId);
  check("redirectFor merge_id matches",          redirect.merge_id === p.id);
  check("redirectFor executed_at numeric",       typeof redirect.executed_at === "number");
  check("redirectFor unknown returns null",      (await ctx.cm.redirectFor(_uuid())) === null);

  // Cannot re-execute.
  await assert.rejects(ctx.cm.executeMerge({
    merge_id: p.id, executed_by: "operator-b",
  }), /only proposed merges can be executed/);

  // Unknown merge_id refused.
  await assert.rejects(ctx.cm.executeMerge({
    merge_id: _uuid(), executed_by: "operator-b",
  }), /not found/);

  // Refusals on shape.
  await assert.rejects(ctx.cm.executeMerge(), /input object required/);
  await assert.rejects(ctx.cm.executeMerge({ merge_id: "not-a-uuid", executed_by: "op" }), /merge_id/);
  await assert.rejects(ctx.cm.executeMerge({ merge_id: p.id, executed_by: "" }), /executed_by/);
}

async function _executeMergeConcurrentClaimsOnce() {
  // Two operators double-click execute on the SAME proposed merge.
  // The proposed->executed transition is an atomic conditional
  // UPDATE, so exactly one caller runs the reparent / archive /
  // redirect-insert side effects; the loser returns the executed row
  // without re-firing them.
  var sourceId = _uuid();
  var targetId = _uuid();
  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Race A" },
      { id: targetId, display_name: "Race B" },
    ],
  });
  ctx.order.set(sourceId, 4);

  var p = await ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "operator-a",
  });

  var results = await Promise.allSettled([
    ctx.cm.executeMerge({ merge_id: p.id, executed_by: "operator-b" }),
    ctx.cm.executeMerge({ merge_id: p.id, executed_by: "operator-c" }),
  ]);
  var fulfilled = results.filter(function (r) { return r.status === "fulfilled"; });
  check("concurrent execute: both calls resolve to executed",
    fulfilled.length === 2 &&
    fulfilled.every(function (r) { return r.value.status === "executed"; }));

  // The exactly-once side effect fired exactly once despite two callers.
  check("concurrent execute: reparent fired exactly once",
    ctx.order.transfers.length === 1);
  check("concurrent execute: orders reparented once (no double-count)",
    ctx.order.byCustomer[targetId] === 4 && ctx.order.byCustomer[sourceId] == null);
  check("concurrent execute: source archived exactly once",
    ctx.customers.archives.length === 1);

  // Exactly one redirect marker exists.
  var redirects = (await ctx.query(
    "SELECT * FROM customer_merge_redirects WHERE source_customer_id = ?1", [sourceId],
  )).rows;
  check("concurrent execute: single redirect marker", redirects.length === 1);
}

async function _executeMergeChainedRefused() {
  // A target that is already the source of an existing redirect
  // cannot be merged INTO; the operator must merge onto the final
  // canonical id.
  var idA = _uuid();
  var idB = _uuid();
  var idC = _uuid();
  var ctx = _setup({
    seed: [
      { id: idA, display_name: "Alex One" },
      { id: idB, display_name: "Alex 1" },
      { id: idC, display_name: "Alex Une" },
    ],
  });

  // Merge A -> B; B is now canonical, A is a redirect source.
  var p1 = await ctx.cm.proposeMerge({
    source_customer_id: idA, target_customer_id: idB,
    requested_by: "operator-a",
  });
  await ctx.cm.executeMerge({ merge_id: p1.id, executed_by: "operator-b" });

  // A is already a redirect source — merging A again is refused.
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: idA, target_customer_id: idC,
    requested_by: "operator-a",
  }), /already merged into/);

  // Merging C -> A is refused (A is itself a redirect; chained
  // redirects refused, operator must target B directly).
  await assert.rejects(ctx.cm.proposeMerge({
    source_customer_id: idC, target_customer_id: idA,
    requested_by: "operator-a",
  }), /chained redirects refused/);
}

async function _rollbackMergeWindow() {
  var sourceId = _uuid();
  var targetId = _uuid();
  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Robin A" },
      { id: targetId, display_name: "Robin B" },
    ],
  });
  // Use sources with no pre-existing target rows so the stub's
  // bulk-tally model reverses cleanly. (A real per-row primitive
  // tracks which rows were reparented and reverses only those;
  // the stub uses a single counter and reparents the whole pool.)
  ctx.order.set(sourceId, 2);
  ctx.loyalty.set(sourceId, 4);

  var p = await ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "operator-a",
  });
  await ctx.cm.executeMerge({ merge_id: p.id, executed_by: "operator-b" });

  check("post-execute loyalty on target",   ctx.loyalty.byCustomer[targetId] === 4);
  check("post-execute orders on target",    ctx.order.byCustomer[targetId] === 2);

  // Rollback within window — reverses every reparent.
  var rb = await ctx.cm.rollbackMerge({
    merge_id: p.id,
    reason:   "operator clicked the wrong button",
  });
  check("rollback status rolled_back",      rb.status === "rolled_back");
  check("rollback stamps rolled_back_at",   typeof rb.rolled_back_at === "number");
  check("rollback records reason",          rb.rollback_reason === "operator clicked the wrong button");

  // Every reparent reversed via the same per-primitive verbs.
  check("orders restored to source",        ctx.order.byCustomer[sourceId] === 2);
  check("orders cleared from target",       ctx.order.byCustomer[targetId] == null);
  check("loyalty restored to source",       ctx.loyalty.byCustomer[sourceId] === 4);
  check("loyalty cleared from target",      ctx.loyalty.byCustomer[targetId] == null);

  // Source customer restored.
  check("source customer restored",         ctx.customers.restores.length === 1 && ctx.customers.restores[0] === sourceId);
  var srcRow = await ctx.customers.getCustomerById(sourceId);
  check("source customer un-archived",      srcRow.archived === false);

  // Redirect marker cleared.
  check("redirect cleared after rollback",  (await ctx.cm.redirectFor(sourceId)) === null);

  // Cannot re-rollback.
  await assert.rejects(ctx.cm.rollbackMerge({
    merge_id: p.id, reason: "again",
  }), /only executed merges can be rolled back/);

  // Past-window refusal — wire a stale executed_at directly and
  // call rollback again. Set up a fresh merge first.
  var s2 = _uuid();
  var t2 = _uuid();
  ctx.customers.add(s2, "Stale One");
  ctx.customers.add(t2, "Stale Two");
  ctx.order.set(s2, 1);

  var p2 = await ctx.cm.proposeMerge({
    source_customer_id: s2, target_customer_id: t2,
    requested_by: "operator-a",
  });
  await ctx.cm.executeMerge({ merge_id: p2.id, executed_by: "operator-b" });
  // Backdate executed_at to 8 days ago — past the 7-day window.
  var stale = Date.now() - 8 * 24 * 60 * 60 * 1000;
  await ctx.query(
    "UPDATE customer_merges SET executed_at = ?1 WHERE id = ?2",
    [stale, p2.id],
  );
  await assert.rejects(ctx.cm.rollbackMerge({
    merge_id: p2.id, reason: "too late",
  }), /rollback window/);

  // Refusals on shape.
  await assert.rejects(ctx.cm.rollbackMerge(), /input object required/);
  await assert.rejects(ctx.cm.rollbackMerge({ merge_id: _uuid(), reason: "x" }), /not found/);
  await assert.rejects(ctx.cm.rollbackMerge({ merge_id: p.id, reason: "" }), /reason/);
  await assert.rejects(ctx.cm.rollbackMerge({ merge_id: p.id, reason: "x".repeat(281) }), /reason/);
}

async function _cancelMerge() {
  var sourceId = _uuid();
  var targetId = _uuid();
  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Sam One" },
      { id: targetId, display_name: "Sam 1" },
    ],
  });
  ctx.order.set(sourceId, 1);

  var p = await ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "operator-a",
  });
  var cancelled = await ctx.cm.cancelMerge({
    merge_id: p.id, reason: "operator changed mind",
  });
  check("cancelMerge status cancelled",   cancelled.status === "cancelled");
  check("cancelMerge stamps cancelled_at", typeof cancelled.cancelled_at === "number");
  check("cancelMerge records reason",     cancelled.cancel_reason === "operator changed mind");

  // No reparents fired.
  check("cancel did not reparent",        ctx.order.transfers.length === 0);
  check("source not archived",            ctx.customers.archives.length === 0);

  // Idempotent on terminal cancelled state.
  var again = await ctx.cm.cancelMerge({
    merge_id: p.id, reason: "second time",
  });
  check("re-cancel returns cancelled row", again.status === "cancelled");

  // Cannot cancel an executed merge.
  var s2 = _uuid();
  var t2 = _uuid();
  ctx.customers.add(s2, "Pat A");
  ctx.customers.add(t2, "Pat B");
  var p2 = await ctx.cm.proposeMerge({
    source_customer_id: s2, target_customer_id: t2,
    requested_by: "operator-a",
  });
  await ctx.cm.executeMerge({ merge_id: p2.id, executed_by: "operator-b" });
  await assert.rejects(ctx.cm.cancelMerge({
    merge_id: p2.id, reason: "too late",
  }), /only proposed merges can be cancelled/);
}

async function _historyAndList() {
  var s1 = _uuid();
  var t1 = _uuid();
  var s2 = _uuid();
  var ctx = _setup({
    seed: [
      { id: s1, display_name: "X One" },
      { id: t1, display_name: "X Two" },
      { id: s2, display_name: "Y One" },
    ],
  });

  // Merge 1: s1 -> t1 executed.
  var p1 = await ctx.cm.proposeMerge({
    source_customer_id: s1, target_customer_id: t1,
    requested_by: "operator-a",
  });
  await ctx.cm.executeMerge({ merge_id: p1.id, executed_by: "operator-b" });

  // Merge 2: s2 -> t1 proposed (not executed).
  var p2 = await ctx.cm.proposeMerge({
    source_customer_id: s2, target_customer_id: t1,
    requested_by: "operator-a",
  });

  // historyForCustomer(t1) — both merges (t1 is target in both).
  var t1History = await ctx.cm.historyForCustomer(t1);
  check("historyForCustomer(t1) returns both", t1History.length === 2);
  check("historyForCustomer ordered created_at DESC",
    t1History[0].created_at >= t1History[1].created_at);

  // historyForCustomer(s1) — only merge 1 (s1 was source).
  var s1History = await ctx.cm.historyForCustomer(s1);
  check("historyForCustomer(s1) returns merge 1", s1History.length === 1 && s1History[0].id === p1.id);

  // historyForCustomer unknown id returns [].
  var unknownHistory = await ctx.cm.historyForCustomer(_uuid());
  check("historyForCustomer unknown id returns []", unknownHistory.length === 0);

  // listMerges all.
  var all = await ctx.cm.listMerges({});
  check("listMerges returns 2",            all.length === 2);

  // listMerges filter by status.
  var executedOnly = await ctx.cm.listMerges({ status: "executed" });
  check("listMerges status=executed filter", executedOnly.length === 1 && executedOnly[0].id === p1.id);

  var proposedOnly = await ctx.cm.listMerges({ status: "proposed" });
  check("listMerges status=proposed filter", proposedOnly.length === 1 && proposedOnly[0].id === p2.id);

  // listMerges date range.
  var rangeMatch = await ctx.cm.listMerges({ from: 0, to: Date.now() + 1000 });
  check("listMerges date range matches",   rangeMatch.length === 2);

  var rangeEmpty = await ctx.cm.listMerges({ from: 1, to: 2 });
  check("listMerges narrow range empty",   rangeEmpty.length === 0);

  // listMerges limit.
  var limited = await ctx.cm.listMerges({ limit: 1 });
  check("listMerges honors limit",         limited.length === 1);

  // getMerge.
  var fetched = await ctx.cm.getMerge(p1.id);
  check("getMerge returns row",            fetched != null && fetched.id === p1.id);
  check("getMerge unknown returns null",   (await ctx.cm.getMerge(_uuid())) === null);

  // Refusals.
  await assert.rejects(ctx.cm.historyForCustomer("not-a-uuid"),                 /customer_id/);
  await assert.rejects(ctx.cm.listMerges({ status: "bogus" }),                  /status/);
  await assert.rejects(ctx.cm.listMerges({ from: 100, to: 50 }),                /from must be <= to/);
  await assert.rejects(ctx.cm.listMerges({ from: -1 }),                         /from/);
  await assert.rejects(ctx.cm.listMerges({ limit: 0 }),                         /limit/);
  await assert.rejects(ctx.cm.listMerges({ limit: 99999 }),                     /limit/);
  await assert.rejects(ctx.cm.redirectFor("not-a-uuid"),                        /customer_id/);
  await assert.rejects(ctx.cm.getMerge("not-a-uuid"),                           /merge_id/);
}

async function _factoryRefusals() {
  // customers is required.
  assert.throws(function () {
    customerMerge.create({ query: function () {} });
  }, /opts\.customers is required/);

  // customers handle missing verbs.
  assert.throws(function () {
    customerMerge.create({
      query:     function () {},
      customers: { getCustomerById: function () {} },
    });
  }, /opts\.customers must expose an archiveCustomer/);

  assert.throws(function () {
    customerMerge.create({
      query:     function () {},
      customers: {
        getCustomerById: function () {},
        archiveCustomer: function () {},
      },
    });
  }, /opts\.customers must expose a restoreCustomer/);

  // Bad child shape — order missing reparentForCustomer.
  assert.throws(function () {
    customerMerge.create({
      query:     function () {},
      customers: {
        getCustomerById:    function () {},
        archiveCustomer:    function () {},
        restoreCustomer:    function () {},
        listForCandidates:  function () {},
      },
      order: { countForCustomer: function () {} },
    });
  }, /opts\.order must expose a reparentForCustomer/);

  // Bad child shape — subscriptions missing countForCustomer.
  assert.throws(function () {
    customerMerge.create({
      query:     function () {},
      customers: {
        getCustomerById:    function () {},
        archiveCustomer:    function () {},
        restoreCustomer:    function () {},
        listForCandidates:  function () {},
      },
      subscriptions: { reparentForCustomer: function () {} },
    });
  }, /opts\.subscriptions must expose a countForCustomer/);

  // No children wired beyond customers: the primitive still
  // creates; the plan reports 0 for every primitive.
  var query = _makeQuery();
  var customers = _customersStub({ seed: [] });
  var cm = customerMerge.create({
    query:     query,
    customers: customers,
  });
  check("create succeeds with no child primitives", typeof cm.proposeMerge === "function");
  check("MERGE_STATUSES exposed",                    Array.isArray(cm.MERGE_STATUSES) && cm.MERGE_STATUSES.length === 4);
  check("ROLLBACK_WINDOW_MS exposed",                cm.ROLLBACK_WINDOW_MS === 7 * 24 * 60 * 60 * 1000);

  // Verify the zero-children plan still works end-to-end.
  var idA = _uuid();
  var idB = _uuid();
  customers.add(idA, "Some One");
  customers.add(idB, "Some Two");
  var proposal = await cm.proposeMerge({
    source_customer_id: idA, target_customer_id: idB,
    requested_by: "operator-a",
  });
  check("zero-children proposal total_rows = 0", proposal.plan.total_rows === 0);
  check("zero-children proposal.orders = 0",     proposal.plan.orders === 0);
  var executed = await cm.executeMerge({ merge_id: proposal.id, executed_by: "operator-b" });
  check("zero-children execute succeeds",         executed.status === "executed");
  check("zero-children redirect exists",          (await cm.redirectFor(idA)) != null);
}

async function _planDriftRefused() {
  var sourceId = _uuid();
  var targetId = _uuid();
  var ctx = _setup({
    seed: [
      { id: sourceId, display_name: "Drift A" },
      { id: targetId, display_name: "Drift B" },
    ],
  });
  ctx.order.set(sourceId, 2);

  var p = await ctx.cm.proposeMerge({
    source_customer_id: sourceId, target_customer_id: targetId,
    requested_by: "operator-a",
  });
  check("proposal captures 2 orders", p.plan.orders === 2);

  // Between proposal and execute, the customer placed another
  // order — actual count is now 3, captured plan said 2. The
  // merge engine refuses to execute on drift.
  ctx.order.set(sourceId, 3);

  await assert.rejects(ctx.cm.executeMerge({
    merge_id: p.id, executed_by: "operator-b",
  }), /plan drifted/);

  // The proposal is still proposed (refused, not consumed).
  var refetched = await ctx.cm.getMerge(p.id);
  check("after drift refusal, status still proposed", refetched.status === "proposed");

  // Bring the counts back into agreement; execute succeeds.
  ctx.order.set(sourceId, 2);
  var executed = await ctx.cm.executeMerge({
    merge_id: p.id, executed_by: "operator-b",
  });
  check("re-execute after drift correction succeeds", executed.status === "executed");
}

async function run() {
  await _findDuplicateCandidates();
  await _proposeMergePlan();
  await _executeMergeReparents();
  await _executeMergeChainedRefused();
  await _rollbackMergeWindow();
  await _cancelMerge();
  await _historyAndList();
  await _factoryRefusals();
  await _planDriftRefused();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/customer-merge.test.js`.
if (require.main === module) {
  run().then(function () {
    console.log("OK - customer-merge (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - customer-merge: " + (err && err.message || err));
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
}
