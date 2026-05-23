"use strict";
/**
 * operatorAuditLog — append-only operator-action audit log with
 * SHA3-512 chain linkage.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0074_operator_audit_log.sql alone — the primitive has no FKs into
 * the rest of the schema, so the test runs against a minimal
 * in-memory database with just the operator_audit_events table.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/operator-audit-log.js` directly so the gate exists ahead of
 * the entry-point edit.
 *
 * Coverage:
 *   - record happy path persists every field + stamps id / occurred_at
 *   - record refuses bad input (actor_type, ua_class, oversized JSON,
 *     control bytes in ip_hash, bad ident shapes)
 *   - chain linkage: first row prev_hash is ZERO, subsequent rows'
 *     prev_hash equals previous row_hash; chainHead tracks the tip
 *   - verifyChain returns ok on a clean walk
 *   - verifyChain detects row-hash tampering (mutated after-state)
 *   - verifyChain detects prev-hash tampering (deleted middle row)
 *   - listByActor pagination + range filter
 *   - listByResource pagination
 *   - searchAction action + range filter
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var operatorAuditLog = require("../../lib/operator-audit-log");
var helpers          = require("../helpers");
var check            = helpers.check;
var assert           = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0074_operator_audit_log.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var q = async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
  q._db = db;
  return q;
}

function _setup() {
  var query = _makeQuery();
  return { query: query, log: operatorAuditLog.create({ query: query }) };
}

var SHA3_512_HEX = /^[0-9a-f]{128}$/;

// ---- record happy path -------------------------------------------------

async function _recordHappy() {
  var ctx = _setup();

  var row = await ctx.log.record({
    actor_type:    "operator",
    actor_id:      "op-alice",
    action:        "product.update",
    resource_kind: "product",
    resource_id:   "prod-42",
    before:        { title: "Old", price_cents: 1999 },
    after:         { title: "New", price_cents: 2499 },
    ip_hash:       "abc123-hashed-ip",
    ua_class:      "browser",
  });
  check("record returns id",            typeof row.id === "string" && row.id.length > 0);
  check("record returns occurred_at",   typeof row.occurred_at === "number" && row.occurred_at > 0);
  check("record persists actor_type",   row.actor_type === "operator");
  check("record persists actor_id",     row.actor_id === "op-alice");
  check("record persists action",       row.action === "product.update");
  check("record persists resource_kind", row.resource_kind === "product");
  check("record persists resource_id",  row.resource_id === "prod-42");
  check("record persists before",       row.before && row.before.title === "Old");
  check("record persists after",        row.after && row.after.title === "New");
  check("record persists ip_hash",      row.ip_hash === "abc123-hashed-ip");
  check("record persists ua_class",     row.ua_class === "browser");
  check("record prev_hash is ZERO on first row",
    row.prev_hash === operatorAuditLog.ZERO_HASH);
  check("record row_hash is SHA3-512 hex", SHA3_512_HEX.test(row.row_hash));

  // Round-trip: row landed in the table, hydration reproduces it.
  var stored = (await ctx.query(
    "SELECT * FROM operator_audit_events WHERE id = ?1", [row.id],
  )).rows[0];
  check("row stored in table", stored && stored.id === row.id);
  check("row before_json stored", stored.before_json && stored.before_json.indexOf("Old") !== -1);
  check("row after_json stored",  stored.after_json  && stored.after_json.indexOf("New") !== -1);

  // before / after optional — null when omitted (create / delete).
  var creation = await ctx.log.record({
    actor_type:    "operator",
    actor_id:      "op-alice",
    action:        "product.create",
    resource_kind: "product",
    resource_id:   "prod-43",
    after:         { title: "Brand new" },
  });
  check("record before optional",   creation.before === null);
  check("record after recorded",    creation.after  && creation.after.title === "Brand new");

  var deletion = await ctx.log.record({
    actor_type:    "operator",
    actor_id:      "op-alice",
    action:        "product.delete",
    resource_kind: "product",
    resource_id:   "prod-42",
    before:        { title: "New", price_cents: 2499 },
  });
  check("record after optional",    deletion.after === null);

  // ip_hash + ua_class optional (system actor with no request context).
  var sysRow = await ctx.log.record({
    actor_type:    "system",
    actor_id:      "subscription-billing-runner",
    action:        "subscription.renew",
    resource_kind: "subscription",
    resource_id:   "sub-99",
  });
  check("record ip_hash optional",  sysRow.ip_hash === null);
  check("record ua_class optional", sysRow.ua_class === null);
  check("record actor_type=system",  sysRow.actor_type === "system");

  // app actor.
  var appRow = await ctx.log.record({
    actor_type:    "app",
    actor_id:      "apikey-pubid-xyz",
    action:        "order.refund",
    resource_kind: "order",
    resource_id:   "ord-77",
    after:         { refunded_cents: 1000 },
    ua_class:      "api_client",
  });
  check("record actor_type=app", appRow.actor_type === "app");
  check("record ua_class=api_client", appRow.ua_class === "api_client");
}

// ---- record refusals ---------------------------------------------------

async function _recordRefusals() {
  var ctx = _setup();

  await assert.rejects(ctx.log.record(), /input object required/);

  // Bad actor_type.
  await assert.rejects(ctx.log.record({
    actor_type: "ghost", actor_id: "x", action: "a", resource_kind: "r", resource_id: "rid",
  }), /actor_type must be one of/);

  // Bad ua_class.
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "x", action: "a", resource_kind: "r", resource_id: "rid",
    ua_class: "telephone",
  }), /ua_class must be null or one of/);

  // Bad actor_id shape.
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "", action: "a", resource_kind: "r", resource_id: "rid",
  }), /actor_id must match/);

  // Bad action shape.
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "x", action: "bad action with space",
    resource_kind: "r", resource_id: "rid",
  }), /action must match/);

  // Bad resource_kind shape.
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "x", action: "a",
    resource_kind: "kind/with/slashes", resource_id: "rid",
  }), /resource_kind must match/);

  // Oversized after-JSON.
  var huge = { blob: "x".repeat(70 * 1024) };
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "x", action: "a",
    resource_kind: "r", resource_id: "rid", after: huge,
  }), /after JSON exceeds/);

  // Control byte in ip_hash.
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "x", action: "a",
    resource_kind: "r", resource_id: "rid", ip_hash: "bad\x00byte",
  }), /ip_hash contains control/);

  // Non-JSON-serializable before (BigInt).
  await assert.rejects(ctx.log.record({
    actor_type: "operator", actor_id: "x", action: "a",
    resource_kind: "r", resource_id: "rid", before: { n: 1n },
  }), /not JSON-serializable/);
}

// ---- chain linkage + chainHead ----------------------------------------

async function _chainLinkage() {
  var ctx = _setup();
  // First record — head was ZERO; tip is its row_hash.
  var emptyHead = await ctx.log.chainHead();
  check("chainHead is ZERO when empty", emptyHead === operatorAuditLog.ZERO_HASH);

  var r1 = await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x1",
  });
  check("first row prev_hash is ZERO", r1.prev_hash === operatorAuditLog.ZERO_HASH);
  var head1 = await ctx.log.chainHead();
  check("chainHead after 1 row equals row1.row_hash", head1 === r1.row_hash);

  var r2 = await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x2",
  });
  check("second row prev_hash equals first row_hash",
    r2.prev_hash === r1.row_hash);
  check("second row_hash differs from first", r2.row_hash !== r1.row_hash);
  check("second row occurred_at > first occurred_at",
    r2.occurred_at > r1.occurred_at);

  var r3 = await ctx.log.record({
    actor_type: "system", actor_id: "cron-1", action: "y.run",
    resource_kind: "y", resource_id: "y1",
  });
  check("third row prev_hash equals second row_hash",
    r3.prev_hash === r2.row_hash);

  var head3 = await ctx.log.chainHead();
  check("chainHead after 3 rows equals row3.row_hash", head3 === r3.row_hash);
}

// ---- verifyChain happy path -------------------------------------------

async function _verifyHappy() {
  var ctx = _setup();
  for (var i = 0; i < 20; i += 1) {
    await ctx.log.record({
      actor_type:    i % 2 === 0 ? "operator" : "system",
      actor_id:      "actor-" + i,
      action:        "thing.touch",
      resource_kind: "thing",
      resource_id:   "thing-" + (i % 5),
      before:        { v: i - 1 },
      after:         { v: i },
      ip_hash:       i % 3 === 0 ? null : ("hash-" + i),
      ua_class:      i % 3 === 0 ? null : "browser",
    });
  }
  var v = await ctx.log.verifyChain();
  check("verifyChain ok on clean walk", v.ok === true);
  check("verifyChain rows_verified = 20", v.rows_verified === 20);
  check("verifyChain last_hash is SHA3-512 hex",
    SHA3_512_HEX.test(v.last_hash));
  check("verifyChain last_hash equals chainHead",
    v.last_hash === (await ctx.log.chainHead()));

  // Empty table.
  var ctx2 = _setup();
  var v2 = await ctx2.log.verifyChain();
  check("verifyChain ok on empty table", v2.ok === true);
  check("verifyChain rows_verified=0 on empty table", v2.rows_verified === 0);
  check("verifyChain last_hash=ZERO on empty table",
    v2.last_hash === operatorAuditLog.ZERO_HASH);
}

// ---- verifyChain detects row_hash tampering ---------------------------

async function _verifyDetectsRowTamper() {
  var ctx = _setup();
  await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x1",
    after: { value: "original" },
  });
  await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x2",
    after: { value: "two" },
  });
  await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x3",
    after: { value: "three" },
  });

  // Tamper: rewrite the after_json on the middle row. The stored
  // row_hash no longer matches the recomputed hash for the mutated
  // row-fields.
  var rows = (await ctx.query(
    "SELECT id, occurred_at FROM operator_audit_events ORDER BY occurred_at ASC, id ASC",
    [],
  )).rows;
  check("setup wrote 3 rows", rows.length === 3);
  var middleId = rows[1].id;
  await ctx.query(
    "UPDATE operator_audit_events SET after_json = ?1 WHERE id = ?2",
    [JSON.stringify({ value: "TAMPERED" }), middleId],
  );

  var v = await ctx.log.verifyChain();
  check("verifyChain detects row_hash tamper", v.ok === false);
  check("verifyChain reports row_hash mismatch", v.reason === "row_hash mismatch");
  check("verifyChain reports break_at = 1",     v.break_at === 1);
  check("verifyChain reports break_row_id",     v.break_row_id === middleId);
  check("verifyChain rows_verified counts clean prefix", v.rows_verified === 1);
}

// ---- verifyChain detects prev_hash break (deleted row) ----------------

async function _verifyDetectsPrevTamper() {
  var ctx = _setup();
  var r1 = await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x1",
  });
  await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x2",
  });
  var r3 = await ctx.log.record({
    actor_type: "operator", actor_id: "op-1", action: "x.do",
    resource_kind: "x", resource_id: "x3",
  });

  // Delete the middle row. r3's prev_hash now points at r2.row_hash
  // but verifyChain walks (r1, r3) — r3.prev_hash !== r1.row_hash.
  await ctx.query(
    "DELETE FROM operator_audit_events WHERE resource_id = ?1", ["x2"],
  );

  var v = await ctx.log.verifyChain();
  check("verifyChain detects deleted-row break", v.ok === false);
  check("verifyChain reports prev_hash mismatch", v.reason === "prev_hash mismatch");
  check("verifyChain break_at = 1 (after r1)", v.break_at === 1);
  check("verifyChain expected = r1.row_hash",  v.expected === r1.row_hash);
  check("verifyChain actual = r3.prev_hash",   v.actual   === r3.prev_hash);
}

// ---- listByActor pagination + range ----------------------------------

async function _listByActor() {
  var ctx = _setup();
  // 5 rows by op-alice, 3 rows by op-bob.
  for (var i = 0; i < 5; i += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-alice", action: "a.x",
      resource_kind: "x", resource_id: "rid-" + i,
    });
  }
  for (var j = 0; j < 3; j += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-bob", action: "a.x",
      resource_kind: "x", resource_id: "rid-bob-" + j,
    });
  }

  var aliceAll = await ctx.log.listByActor({ actor_id: "op-alice" });
  check("listByActor returns alice rows only",
    aliceAll.rows.length === 5 &&
    aliceAll.rows.every(function (r) { return r.actor_id === "op-alice"; }));
  check("listByActor newest-first",
    aliceAll.rows[0].occurred_at >= aliceAll.rows[aliceAll.rows.length - 1].occurred_at);

  // Pagination: limit 2.
  var page1 = await ctx.log.listByActor({ actor_id: "op-alice", limit: 2 });
  check("listByActor page1 size = 2", page1.rows.length === 2);
  check("listByActor page1 next_cursor present", typeof page1.next_cursor === "string");

  var page2 = await ctx.log.listByActor({
    actor_id: "op-alice", limit: 2, cursor: page1.next_cursor,
  });
  check("listByActor page2 size = 2", page2.rows.length === 2);
  check("listByActor page2 != page1",
    page2.rows[0].id !== page1.rows[0].id);

  var page3 = await ctx.log.listByActor({
    actor_id: "op-alice", limit: 2, cursor: page2.next_cursor,
  });
  check("listByActor page3 size = 1 (residue)", page3.rows.length === 1);
  check("listByActor page3 next_cursor=null (under limit)",
    page3.next_cursor === null);

  // No duplicate ids across pages.
  var seen = {};
  [page1, page2, page3].forEach(function (p) {
    p.rows.forEach(function (r) {
      check("no duplicate id across pages: " + r.id, !seen[r.id]);
      seen[r.id] = true;
    });
  });

  // Range filter.
  var allRows = (await ctx.query(
    "SELECT occurred_at FROM operator_audit_events WHERE actor_id = ?1 ORDER BY occurred_at ASC",
    ["op-alice"],
  )).rows;
  var midTs = Number(allRows[2].occurred_at);
  var ranged = await ctx.log.listByActor({
    actor_id: "op-alice", from: midTs, to: midTs + 1000000,
  });
  check("listByActor range filter narrows",
    ranged.rows.every(function (r) { return r.occurred_at >= midTs; }));

  // Bad cursor.
  await assert.rejects(
    ctx.log.listByActor({ actor_id: "op-alice", cursor: "not-base64url-json" }),
    /cursor malformed/
  );
}

// ---- listByResource pagination ---------------------------------------

async function _listByResource() {
  var ctx = _setup();
  // 4 rows on (product, prod-42); 2 rows on (product, prod-43);
  // 3 rows on (order, ord-1).
  for (var i = 0; i < 4; i += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-1", action: "product.update",
      resource_kind: "product", resource_id: "prod-42",
      after: { v: i },
    });
  }
  for (var j = 0; j < 2; j += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-1", action: "product.update",
      resource_kind: "product", resource_id: "prod-43",
    });
  }
  for (var k = 0; k < 3; k += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-1", action: "order.note.add",
      resource_kind: "order", resource_id: "ord-1",
    });
  }

  var p42 = await ctx.log.listByResource({
    resource_kind: "product", resource_id: "prod-42",
  });
  check("listByResource returns prod-42 rows only",
    p42.rows.length === 4 &&
    p42.rows.every(function (r) {
      return r.resource_kind === "product" && r.resource_id === "prod-42";
    }));
  check("listByResource newest-first",
    p42.rows[0].occurred_at >= p42.rows[p42.rows.length - 1].occurred_at);

  // Pagination.
  var page1 = await ctx.log.listByResource({
    resource_kind: "product", resource_id: "prod-42", limit: 2,
  });
  check("listByResource page1 size = 2", page1.rows.length === 2);
  check("listByResource page1 next_cursor present",
    typeof page1.next_cursor === "string");

  var page2 = await ctx.log.listByResource({
    resource_kind: "product", resource_id: "prod-42", limit: 2,
    cursor: page1.next_cursor,
  });
  check("listByResource page2 size = 2", page2.rows.length === 2);
  // page2 hit exactly the limit so the cursor pattern emits a final
  // next_cursor — fetching that page returns an empty result. This is
  // the standard "exact-fill" pagination quirk; the caller stops when
  // the row list comes back empty or short.
  var page3 = await ctx.log.listByResource({
    resource_kind: "product", resource_id: "prod-42", limit: 2,
    cursor: page2.next_cursor,
  });
  check("listByResource page3 size = 0 (drained)", page3.rows.length === 0);
  check("listByResource page3 next_cursor=null",   page3.next_cursor === null);

  // Unknown resource — empty.
  var none = await ctx.log.listByResource({
    resource_kind: "product", resource_id: "ghost",
  });
  check("listByResource empty for unknown resource", none.rows.length === 0);
  check("listByResource empty next_cursor=null",    none.next_cursor === null);
}

// ---- searchAction + range filter --------------------------------------

async function _searchAction() {
  var ctx = _setup();
  // 6 rows of action "order.refund.manual", 2 rows of
  // "product.price.override", 3 rows of "support.ticket.assign".
  for (var i = 0; i < 6; i += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-" + i, action: "order.refund.manual",
      resource_kind: "order", resource_id: "ord-" + i,
      after: { refunded_cents: 500 },
    });
  }
  for (var j = 0; j < 2; j += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-x", action: "product.price.override",
      resource_kind: "product", resource_id: "p-" + j,
    });
  }
  for (var k = 0; k < 3; k += 1) {
    await ctx.log.record({
      actor_type: "operator", actor_id: "op-y", action: "support.ticket.assign",
      resource_kind: "ticket", resource_id: "tk-" + k,
    });
  }

  var refunds = await ctx.log.searchAction({ action: "order.refund.manual" });
  check("searchAction returns matching action only",
    refunds.rows.length === 6 &&
    refunds.rows.every(function (r) { return r.action === "order.refund.manual"; }));

  // Pagination.
  var page1 = await ctx.log.searchAction({
    action: "order.refund.manual", limit: 4,
  });
  check("searchAction page1 size = 4", page1.rows.length === 4);
  check("searchAction page1 next_cursor present",
    typeof page1.next_cursor === "string");

  var page2 = await ctx.log.searchAction({
    action: "order.refund.manual", limit: 4, cursor: page1.next_cursor,
  });
  check("searchAction page2 size = 2 (residue)", page2.rows.length === 2);
  check("searchAction page2 next_cursor=null",   page2.next_cursor === null);

  // Range filter — pick the middle refund's occurred_at as the window.
  var allRefunds = (await ctx.query(
    "SELECT occurred_at FROM operator_audit_events WHERE action = ?1 ORDER BY occurred_at ASC",
    ["order.refund.manual"],
  )).rows;
  var thirdTs = Number(allRefunds[2].occurred_at);
  var ranged = await ctx.log.searchAction({
    action: "order.refund.manual", from: thirdTs,
  });
  check("searchAction range filter narrows",
    ranged.rows.every(function (r) { return r.occurred_at >= thirdTs; }));

  // Unknown action — empty.
  var none = await ctx.log.searchAction({ action: "never.happened" });
  check("searchAction empty for unknown action", none.rows.length === 0);

  // Bad range — to < from.
  await assert.rejects(
    ctx.log.searchAction({ action: "order.refund.manual", from: 1000, to: 500 }),
    /to must be ≥ from/
  );

  // Bad input.
  await assert.rejects(ctx.log.searchAction(), /input object required/);
}

async function run() {
  await _recordHappy();
  await _recordRefusals();
  await _chainLinkage();
  await _verifyHappy();
  await _verifyDetectsRowTamper();
  await _verifyDetectsPrevTamper();
  await _listByActor();
  await _listByResource();
  await _searchAction();
}

module.exports = { run: run };

// Standalone invocation: `node test/layer-1-state/operator-audit-log.test.js`.
// The smoke orchestrator calls run() directly via require; the
// require.main guard keeps direct invocation usable without
// duplicating the harness.
if (require.main === module) {
  run().then(function () {
    console.log("operator-audit-log: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
