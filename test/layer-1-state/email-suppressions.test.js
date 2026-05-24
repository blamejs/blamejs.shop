"use strict";
/**
 * emailSuppressions — opt-out / bounce / complaint gate for outbound mail.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0028.
 * Coverage:
 *
 *   - add (new): inserts a row, returns email_hash + status 'new'
 *   - add (duplicate): re-occurrence collapses, bumps occurrences
 *   - isSuppressed (scope hierarchy): every requested-scope vs.
 *     stored-scope combination resolves to the documented answer
 *   - remove: operator manual override drops the row + requires reason
 *   - cleanupExpired: soft-bounce purge respects expires_at, leaves
 *     permanent rows untouched
 *   - list: paginated, cursor round-trips, narrows by type / scope
 *   - stats: aggregate counts grouped by suppression_type
 *   - refusals: bad email shape / bad suppression_type / bad scope /
 *     missing reason on remove / cursor tamper
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0028_email_suppressions.sql"
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

function _factory(query) {
  return bShop.emailSuppressions.create({ query: query });
}

async function _addNew() {
  var query = _makeQuery();
  var sup   = _factory(query);

  var rv = await sup.add({
    email:            "Alice@Example.com",
    suppression_type: "hard-bounce",
    reason:           "550 5.1.1 mailbox does not exist",
    source:           "sendgrid",
  });
  check("add(new) returns status 'new'",          rv.status === "new");
  check("add(new) hashes the normalised email",   typeof rv.email_hash === "string" && /^[0-9a-f]{128}$/.test(rv.email_hash));
  check("add(new) lowercases + trims email",      rv.email_normalized === "alice@example.com");
  check("add(new) records the type",              rv.suppression_type === "hard-bounce");
  check("add(new) defaults scope for hard-bounce", rv.scope === "transactional");
  check("add(new) occurrences = 1",               rv.occurrences === 1);

  // Round-trip via byHash — the stored row carries the fields we set.
  var row = await sup.byHash(rv.email_hash);
  check("byHash returns a row",                   row && typeof row === "object");
  check("byHash row reason matches",              row.reason === "550 5.1.1 mailbox does not exist");
  check("byHash row source matches",              row.source === "sendgrid");
  check("byHash row first_seen_at populated",     Number.isInteger(row.first_seen_at) && row.first_seen_at > 0);
  check("byHash row last_seen_at == first_seen_at on new", row.last_seen_at === row.first_seen_at);
  check("byHash row occurrences = 1",             row.occurrences === 1);
  check("byHash row expires_at NULL by default",  row.expires_at == null);

  // unsubscribe defaults to marketing scope.
  var unsub = await sup.add({
    email:            "bob@example.com",
    suppression_type: "unsubscribe",
  });
  check("add unsubscribe defaults scope=marketing", unsub.scope === "marketing");

  // operator-manual defaults to all.
  var man = await sup.add({
    email:            "carol@example.com",
    suppression_type: "operator-manual",
    reason:           "abuse triage",
  });
  check("add operator-manual defaults scope=all", man.scope === "all");

  // Explicit scope override sticks.
  var override = await sup.add({
    email:            "dave@example.com",
    suppression_type: "unsubscribe",
    scope:            "all",
  });
  check("explicit scope override sticks",          override.scope === "all");
}

async function _addDuplicateIncrement() {
  var query = _makeQuery();
  var sup   = _factory(query);

  var first = await sup.add({
    email:            "alice@example.com",
    suppression_type: "soft-bounce",
    reason:           "mailbox full",
    source:           "ses",
    expires_at:       Date.now() + 86400000,
  });
  check("first add → status 'new'",               first.status === "new");
  check("first add → occurrences 1",              first.occurrences === 1);

  // Yield a microtask so last_seen_at differs from first_seen_at on
  // platforms with sub-ms Date.now() resolution. The primitive doesn't
  // promise strict monotonicity; it does promise that updated rows
  // refresh last_seen_at to a fresh now.
  await new Promise(function (r) { setImmediate(r); });

  var second = await sup.add({
    email:            "Alice@example.com",   // mixed case → same hash
    suppression_type: "hard-bounce",          // type can change on re-occurrence
    reason:           "550 5.1.1 mailbox does not exist",
    source:           "sendgrid",
  });
  check("dup add → status 'updated'",             second.status === "updated");
  check("dup add → same email_hash",              second.email_hash === first.email_hash);
  check("dup add → occurrences 2",                second.occurrences === 2);
  check("dup add → type updated",                 second.suppression_type === "hard-bounce");

  var row = await sup.byHash(second.email_hash);
  check("dup row → reason refreshed",             row.reason === "550 5.1.1 mailbox does not exist");
  check("dup row → source refreshed",             row.source === "sendgrid");
  check("dup row → expires_at cleared on update", row.expires_at == null);
  // first_seen_at is sticky; last_seen_at moves forward.
  check("dup row → last_seen_at >= first_seen_at", row.last_seen_at >= row.first_seen_at);
  check("dup row → occurrences stored 2",          row.occurrences === 2);

  var third = await sup.add({
    email:            "alice@example.com",
    suppression_type: "complaint",
  });
  check("third add → occurrences 3",              third.occurrences === 3);
}

async function _isSuppressedScopeMatrix() {
  var query = _makeQuery();
  var sup   = _factory(query);

  // Three rows — one per scope — under three distinct addresses.
  await sup.add({ email: "all@example.com",     suppression_type: "operator-manual", scope: "all"           });
  await sup.add({ email: "mkt@example.com",     suppression_type: "unsubscribe",     scope: "marketing"     });
  await sup.add({ email: "txn@example.com",     suppression_type: "hard-bounce",     scope: "transactional" });

  // scope='all' row → suppresses every requested scope.
  var allTxn = await sup.isSuppressed({ email: "all@example.com", scope: "transactional" });
  var allMkt = await sup.isSuppressed({ email: "all@example.com", scope: "marketing" });
  var allAll = await sup.isSuppressed({ email: "all@example.com", scope: "all" });
  check("scope=all blocks transactional",       allTxn.suppressed === true);
  check("scope=all blocks marketing",           allMkt.suppressed === true);
  check("scope=all blocks all",                  allAll.suppressed === true);
  check("scope=all surfaces type",               allTxn.suppression_type === "operator-manual");
  check("scope=all surfaces scope",              allTxn.scope === "all");

  // scope='marketing' row → blocks marketing only.
  var mktTxn = await sup.isSuppressed({ email: "mkt@example.com", scope: "transactional" });
  var mktMkt = await sup.isSuppressed({ email: "mkt@example.com", scope: "marketing" });
  var mktAll = await sup.isSuppressed({ email: "mkt@example.com", scope: "all" });
  check("scope=marketing allows transactional", mktTxn.suppressed === false);
  check("scope=marketing blocks marketing",     mktMkt.suppressed === true);
  check("scope=marketing surfaces on all-view", mktAll.suppressed === true);
  check("scope=marketing type surfaces",        mktMkt.suppression_type === "unsubscribe");

  // scope='transactional' row → blocks transactional only.
  var txnTxn = await sup.isSuppressed({ email: "txn@example.com", scope: "transactional" });
  var txnMkt = await sup.isSuppressed({ email: "txn@example.com", scope: "marketing" });
  var txnAll = await sup.isSuppressed({ email: "txn@example.com", scope: "all" });
  check("scope=transactional blocks transactional", txnTxn.suppressed === true);
  check("scope=transactional allows marketing",     txnMkt.suppressed === false);
  check("scope=transactional surfaces on all-view", txnAll.suppressed === true);

  // Unknown address → not suppressed.
  var miss = await sup.isSuppressed({ email: "unknown@example.com", scope: "all" });
  check("unknown address → suppressed false",    miss.suppressed === false);
  check("unknown address → no type field",       miss.suppression_type === undefined);

  // Default scope is 'all' — most restrictive view.
  var defaulted = await sup.isSuppressed({ email: "mkt@example.com" });
  check("default scope='all' surfaces marketing row", defaulted.suppressed === true);

  // Expired soft-bounce → does not suppress.
  await sup.add({
    email:            "expired@example.com",
    suppression_type: "soft-bounce",
    scope:            "all",
    expires_at:       1,           // long past
  });
  var exp = await sup.isSuppressed({ email: "expired@example.com", scope: "all" });
  check("expired row → suppressed false",        exp.suppressed === false);

  // Future-dated soft-bounce → does suppress.
  await sup.add({
    email:            "future@example.com",
    suppression_type: "soft-bounce",
    scope:            "all",
    expires_at:       Date.now() + 86400000,
  });
  var fut = await sup.isSuppressed({ email: "future@example.com", scope: "all" });
  check("future-dated row → suppressed true",     fut.suppressed === true);
}

async function _removeOperatorOverride() {
  var query = _makeQuery();
  var sup   = _factory(query);

  var rv = await sup.add({
    email:            "mistake@example.com",
    suppression_type: "complaint",
    reason:           "FBL false positive",
  });
  var pre = await sup.isSuppressed({ email: "mistake@example.com", scope: "all" });
  check("pre-remove: suppressed",                 pre.suppressed === true);

  var del = await sup.remove(rv.email_hash, { reason: "support ticket #4421 — complaint retracted" });
  check("remove returns removed: true",           del.removed === true);
  check("remove echoes email_hash",               del.email_hash === rv.email_hash);

  var post = await sup.isSuppressed({ email: "mistake@example.com", scope: "all" });
  check("post-remove: not suppressed",            post.suppressed === false);

  // byHash returns null after remove.
  var byHash = await sup.byHash(rv.email_hash);
  check("post-remove byHash → null",              byHash === null);

  // Removing a non-existent row → removed: false (still resolves).
  var notFound = await sup.remove(
    "0".repeat(128),
    { reason: "speculative cleanup" }
  );
  check("remove non-existent → removed false",    notFound.removed === false);
}

async function _cleanupExpired() {
  var query = _makeQuery();
  var sup   = _factory(query);

  var now = Date.now();
  // Three rows: one already-expired, one future-expiry, one
  // permanent.
  await sup.add({
    email:            "expired@example.com",
    suppression_type: "soft-bounce",
    expires_at:       now - 1000,
  });
  await sup.add({
    email:            "future@example.com",
    suppression_type: "soft-bounce",
    expires_at:       now + 86400000,
  });
  await sup.add({
    email:            "permanent@example.com",
    suppression_type: "operator-manual",
    reason:           "abuse triage",
  });

  // Pre-cleanup: list() returns all three.
  var pre = await sup.list();
  check("pre-cleanup: 3 rows",                    pre.rows.length === 3);

  var rv = await sup.cleanupExpired();
  check("cleanupExpired removed 1 row",           rv.removed === 1);

  // Post-cleanup: only future + permanent remain.
  var post = await sup.list();
  check("post-cleanup: 2 rows",                   post.rows.length === 2);
  var emails = post.rows.map(function (r) { return r.email_normalized; }).sort();
  check("post-cleanup: expired row purged",       emails.indexOf("expired@example.com") === -1);
  check("post-cleanup: future row remains",       emails.indexOf("future@example.com") !== -1);
  check("post-cleanup: permanent row remains",    emails.indexOf("permanent@example.com") !== -1);

  // Explicit cutoff cleanup.
  var rv2 = await sup.cleanupExpired(now + 86400001);
  check("explicit-cutoff cleanup removed 1 (future)", rv2.removed === 1);
  var final = await sup.list();
  check("final: only permanent remains",          final.rows.length === 1);
  check("final row is the permanent one",         final.rows[0].email_normalized === "permanent@example.com");
}

async function _listPagination() {
  var query = _makeQuery();
  var sup   = _factory(query);

  // Seed 5 rows with monotonically increasing last_seen_at — serialise
  // the inserts so timestamps differ on platforms with sub-ms
  // Date.now() resolution.
  var seeded = [];
  for (var i = 0; i < 5; i += 1) {
    seeded.push(await sup.add({
      email:            "user" + i + "@example.com",
      suppression_type: i % 2 === 0 ? "hard-bounce" : "unsubscribe",
    }));
    await new Promise(function (r) { setImmediate(r); });
  }

  // Default list — all 5 in DESC order by last_seen_at.
  var all = await sup.list();
  check("list returns 5 rows",                    all.rows.length === 5);
  check("list next_cursor null on full page",     all.next_cursor === null);
  for (var j = 1; j < all.rows.length; j += 1) {
    check("list sorted last_seen_at DESC",        all.rows[j - 1].last_seen_at >= all.rows[j].last_seen_at);
  }

  // limit=2 + cursor → 3 pages.
  var p1 = await sup.list({ limit: 2 });
  check("page-1 has 2 rows",                      p1.rows.length === 2);
  check("page-1 cursor is a string",              typeof p1.next_cursor === "string");

  var p2 = await sup.list({ limit: 2, cursor: p1.next_cursor });
  check("page-2 has 2 rows",                      p2.rows.length === 2);
  check("page-2 cursor is a string",              typeof p2.next_cursor === "string");
  check("page-2 distinct from page-1",            p2.rows[0].email_hash !== p1.rows[0].email_hash);

  var p3 = await sup.list({ limit: 2, cursor: p2.next_cursor });
  check("page-3 has 1 row (residual)",            p3.rows.length === 1);
  check("page-3 cursor is null",                  p3.next_cursor === null);

  // suppression_type narrows.
  var bounces = await sup.list({ suppression_type: "hard-bounce" });
  check("type=hard-bounce narrows",               bounces.rows.length === 3);
  check("type-narrowed rows all hard-bounce",     bounces.rows.every(function (r) { return r.suppression_type === "hard-bounce"; }));

  // scope narrows (hard-bounce default scope is transactional;
  // unsubscribe default is marketing).
  var txnScope = await sup.list({ scope: "transactional" });
  check("scope=transactional narrows",            txnScope.rows.length === 3);
  var mktScope = await sup.list({ scope: "marketing" });
  check("scope=marketing narrows",                mktScope.rows.length === 2);

  // Cursor tamper — supply a cursor signed by a different secret.
  var alt = bShop.emailSuppressions.create({
    query:        query,
    cursorSecret: "alternate-secret-entirely",
  });
  await alt.list({ limit: 2 });
  var tampered = (p1.next_cursor.charAt(0) === "A" ? "B" : "A") + p1.next_cursor.slice(1);
  await assert.rejects(
    sup.list({ limit: 2, cursor: tampered }),
    /cursor/i
  );
}

async function _statsAggregation() {
  var query = _makeQuery();
  var sup   = _factory(query);

  await sup.add({ email: "a@example.com", suppression_type: "hard-bounce" });
  await sup.add({ email: "b@example.com", suppression_type: "hard-bounce" });
  await sup.add({ email: "c@example.com", suppression_type: "unsubscribe" });
  await sup.add({ email: "d@example.com", suppression_type: "complaint" });
  await sup.add({ email: "e@example.com", suppression_type: "operator-manual", reason: "abuse" });

  var counts = await sup.stats();
  check("stats hard-bounce = 2",                  counts["hard-bounce"] === 2);
  check("stats unsubscribe = 1",                  counts["unsubscribe"] === 1);
  check("stats complaint = 1",                    counts["complaint"] === 1);
  check("stats operator-manual = 1",              counts["operator-manual"] === 1);
  check("stats soft-bounce = 0 (still present)",  counts["soft-bounce"] === 0);
  check("stats rate-limit-block = 0",             counts["rate-limit-block"] === 0);

  // Bounded range — only rows with last_seen_at >= now+1 will match
  // (every row was just inserted with last_seen_at ~= now).
  var future = await sup.stats({ from: Date.now() + 86400000 });
  check("future-only range yields all zeros",     future["hard-bounce"] === 0 && future["unsubscribe"] === 0);

  // Range encompassing all rows.
  var past = await sup.stats({ from: 1 });
  check("past-encompassing range = full counts",  past["hard-bounce"] === 2);
}

async function _refusals() {
  var query = _makeQuery();
  var sup   = _factory(query);

  // Bad email shape.
  await assert.rejects(
    sup.add({ email: "not-an-email", suppression_type: "hard-bounce" }),
    /email/i
  );
  await assert.rejects(
    sup.add({ email: "", suppression_type: "hard-bounce" }),
    /email/i
  );
  await assert.rejects(
    sup.add({ email: 42, suppression_type: "hard-bounce" }),
    /email/i
  );
  // Header injection in the address itself → guardEmail refuses.
  await assert.rejects(
    sup.add({ email: "alice@example.com\r\nBcc: leak@evil", suppression_type: "hard-bounce" }),
    /email/i
  );

  // Bad suppression_type.
  await assert.rejects(
    sup.add({ email: "alice@example.com", suppression_type: "made-up" }),
    /suppression_type/
  );
  await assert.rejects(
    sup.add({ email: "alice@example.com" }),
    /suppression_type/
  );

  // Bad scope.
  await assert.rejects(
    sup.add({ email: "alice@example.com", suppression_type: "hard-bounce", scope: "purple" }),
    /scope/
  );

  // Bad reason — CR / LF embedded.
  await assert.rejects(
    sup.add({
      email:            "alice@example.com",
      suppression_type: "hard-bounce",
      reason:           "first line\r\nBcc: leak@evil",
    }),
    /reason/
  );

  // Bad source.
  await assert.rejects(
    sup.add({
      email:            "alice@example.com",
      suppression_type: "hard-bounce",
      source:           "Has Spaces",
    }),
    /source/
  );

  // Bad expires_at.
  await assert.rejects(
    sup.add({
      email:            "alice@example.com",
      suppression_type: "soft-bounce",
      expires_at:       -1,
    }),
    /expires_at/
  );
  await assert.rejects(
    sup.add({
      email:            "alice@example.com",
      suppression_type: "soft-bounce",
      expires_at:       "tomorrow",
    }),
    /expires_at/
  );

  // isSuppressed: bad email, bad scope.
  await assert.rejects(
    sup.isSuppressed({ email: "not-an-email" }),
    /email/i
  );
  await assert.rejects(
    sup.isSuppressed({ email: "alice@example.com", scope: "purple" }),
    /scope/
  );
  await assert.rejects(
    sup.isSuppressed(null),
    /input/
  );

  // remove: bad hash shape, missing reason.
  await assert.rejects(
    sup.remove("short", { reason: "test" }),
    /email_hash/
  );
  await assert.rejects(
    sup.remove("ZZ" + "0".repeat(126), { reason: "test" }),
    /email_hash/
  );
  var validHash = "a".repeat(128);
  await assert.rejects(
    sup.remove(validHash),
    /reason/
  );
  await assert.rejects(
    sup.remove(validHash, { reason: "" }),
    /reason/
  );

  // byHash: bad hash shape.
  await assert.rejects(
    sup.byHash("short"),
    /email_hash/
  );

  // list: bad limit, bad type, bad scope, bad cursor.
  await assert.rejects(
    sup.list({ limit: 0 }),
    /limit/
  );
  await assert.rejects(
    sup.list({ limit: 1001 }),
    /limit/
  );
  await assert.rejects(
    sup.list({ suppression_type: "made-up" }),
    /suppression_type/
  );
  await assert.rejects(
    sup.list({ scope: "purple" }),
    /scope/
  );
  await assert.rejects(
    sup.list({ cursor: 12345 }),
    /cursor/i
  );

  // stats: bad range.
  await assert.rejects(
    sup.stats({ from: "yesterday" }),
    /from/
  );
  await assert.rejects(
    sup.stats({ from: 100, to: 50 }),
    /from/
  );

  // cleanupExpired: bad ts.
  await assert.rejects(
    sup.cleanupExpired(-1),
    /ts/
  );

  // Factory in production requires cursorSecret.
  var prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      function () { bShop.emailSuppressions.create({ query: query }); },
      /cursorSecret/
    );
  } finally {
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
}

async function run() {
  await _addNew();
  await _addDuplicateIncrement();
  await _isSuppressedScopeMatrix();
  await _removeOperatorOverride();
  await _cleanupExpired();
  await _listPagination();
  await _statsAggregation();
  await _refusals();
}

module.exports = { run: run };
