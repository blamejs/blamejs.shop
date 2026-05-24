"use strict";
/**
 * paymentMethods — per-customer saved processor tokens.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0036_payment_methods.sql. The primitive never sees the raw PAN
 * or CVV — every `add()` input is screened for PAN-shaped digit
 * runs (13-19 consecutive digits, with or without separators) and
 * CVV-shaped field names, and refused before it touches the row.
 *
 * Coverage:
 *   - add: happy path persists row + writes 'added' audit entry
 *   - add: refuses PAN-shaped digit run in any string field
 *   - add: refuses hyphen-separated PAN ("4242-4242-4242-4242")
 *   - add: refuses CVV-shaped field name (cvv / cvc / cv2 / cid)
 *   - add: refuses invalid processor / last4 / exp_month / exp_year
 *   - setDefault: clears sibling default + writes both audit rows
 *   - setDefault: refuses if the method is archived
 *   - archive: drops default flag + writes 'archived' audit row
 *   - markExpired: archives only rows whose (year, month) is in the past
 *   - listForCustomer: filters archived by default; include_archived shows them
 *   - byProcessorToken / defaultForCustomer / get: round-trip
 *   - audit: returns the full ordered trail for a row
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var paymentMethodsModule = require("../../lib/payment-methods");
var bFramework           = require("../../lib/vendor/blamejs");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PM = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0036_payment_methods.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_PM, "utf8")).forEach(function (s) {
    db.prepare(s).run();
  });
  return {
    db:    db,
    query: async function (sql, params) {
      var stmt = db.prepare(sql);
      var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
      if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
        var info = stmt.run.apply(stmt, params || []);
        return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
      }
      var rows = stmt.all.apply(stmt, params || []);
      return { rows: rows, rowCount: rows.length };
    },
  };
}

function _pmFactory() {
  var h = _makeQuery();
  return { db: h.db, pm: paymentMethodsModule.create({ query: h.query }) };
}

function _newCustomerId() { return bFramework.uuid.v7(); }

// Token generator that's guaranteed not to contain 13+ consecutive
// ASCII digits — interleaves letters so the PAN screen never trips
// on the test fixture itself. Each call returns a unique token via
// a process-local counter; tests that want to assert a specific
// token pass it via `_validAdd({ processor_token: "…" })`.
var _tokenCounter = 0;
function _safeToken() {
  _tokenCounter += 1;
  return "pm_test_xyz_" + _tokenCounter + "_abc";
}

function _validAdd(over) {
  var base = {
    customer_id:     _newCustomerId(),
    processor:       "stripe",
    processor_token: _safeToken(),
    brand:           "visa",
    last4:           "4242",
    exp_month:       4,
    exp_year:        new Date().getUTCFullYear() + 2,
  };
  if (over) {
    var keys = Object.keys(over);
    for (var i = 0; i < keys.length; i += 1) base[keys[i]] = over[keys[i]];
  }
  return base;
}

async function _addHappyPath() {
  var f = _pmFactory();
  var custId = _newCustomerId();
  var saved = await f.pm.add(_validAdd({ customer_id: custId, label: "Work card" }));

  check("add returns uuid id",            typeof saved.id === "string" && saved.id.length === 36);
  check("add echoes customer_id",         saved.customer_id === custId);
  check("add echoes processor",           saved.processor === "stripe");
  check("add echoes brand",               saved.brand === "visa");
  check("add echoes last4",               saved.last4 === "4242");
  check("add echoes exp_month",           saved.exp_month === 4);
  check("add returns is_default false",   saved.is_default === false);
  check("add returns archived_at null",   saved.archived_at === null);

  var rows = f.db.prepare("SELECT * FROM payment_methods WHERE id = ?").all(saved.id);
  check("add persists exactly one row",   rows.length === 1);
  check("stored is_default = 0",          rows[0].is_default === 0);
  check("stored archived_at NULL",        rows[0].archived_at === null);
  check("stored label round-trips",       rows[0].label === "Work card");

  // 'added' audit entry written.
  var auditRows = f.db.prepare("SELECT * FROM payment_method_audit WHERE payment_method_id = ?").all(saved.id);
  check("add writes one audit entry",     auditRows.length === 1);
  check("audit event = 'added'",          auditRows[0].event === "added");
}

async function _refusePAN() {
  var f = _pmFactory();

  // Raw PAN smuggled into processor_token — refused.
  await assert.rejects(
    f.pm.add(_validAdd({ processor_token: "4242424242424242" })),
    /PAN-shaped/,
  );

  // Raw PAN in label — refused.
  await assert.rejects(
    f.pm.add(_validAdd({ label: "My card 4242424242424242" })),
    /PAN-shaped/,
  );

  // Hyphen-separated PAN — separators collapsed, still refused.
  await assert.rejects(
    f.pm.add(_validAdd({ processor_token: "4242-4242-4242-4242" })),
    /PAN-shaped/,
  );

  // Space-separated PAN — refused.
  await assert.rejects(
    f.pm.add(_validAdd({ label: "4242 4242 4242 4242" })),
    /PAN-shaped/,
  );

  // 13-digit PAN (short AmEx-style — still inside the 13..19 window).
  await assert.rejects(
    f.pm.add(_validAdd({ processor_token: "1234567890123" })),
    /PAN-shaped/,
  );

  // 12 digits — below the screen window; the processor_token gate
  // accepts it (but the rest of the row still has to be valid).
  var ok = await f.pm.add(_validAdd({ processor_token: "pm_" + "123456789012" }));
  check("12-digit token allowed",         typeof ok.id === "string");
}

async function _refuseCVVField() {
  var f = _pmFactory();

  await assert.rejects(
    f.pm.add(Object.assign(_validAdd(), { cvv: "123" })),
    /CVV-shaped/,
  );
  await assert.rejects(
    f.pm.add(Object.assign(_validAdd(), { cvc: "123" })),
    /CVV-shaped/,
  );
  await assert.rejects(
    f.pm.add(Object.assign(_validAdd(), { cv2: "" })),
    /CVV-shaped/,
  );
  await assert.rejects(
    f.pm.add(Object.assign(_validAdd(), { cid: "1234" })),
    /CVV-shaped/,
  );
  await assert.rejects(
    f.pm.add(Object.assign(_validAdd(), { security_code: "999" })),
    /CVV-shaped/,
  );
}

async function _refuseInvalidShape() {
  var f = _pmFactory();
  var nowYear = new Date().getUTCFullYear();

  // Bad processor.
  await assert.rejects(f.pm.add(_validAdd({ processor: "bitcoin" })),         /processor/);
  await assert.rejects(f.pm.add(_validAdd({ processor: "" })),                /processor/);

  // Bad last4.
  await assert.rejects(f.pm.add(_validAdd({ last4: "424" })),                 /last4/);
  await assert.rejects(f.pm.add(_validAdd({ last4: "42424" })),               /last4/);
  await assert.rejects(f.pm.add(_validAdd({ last4: "abcd" })),                /last4/);

  // Bad exp_month.
  await assert.rejects(f.pm.add(_validAdd({ exp_month: 0 })),                 /exp_month/);
  await assert.rejects(f.pm.add(_validAdd({ exp_month: 13 })),                /exp_month/);
  await assert.rejects(f.pm.add(_validAdd({ exp_month: 1.5 })),               /exp_month/);

  // Bad exp_year — past year refused.
  await assert.rejects(f.pm.add(_validAdd({ exp_year: nowYear - 1 })),        /exp_year/);
  await assert.rejects(f.pm.add(_validAdd({ exp_year: "2027" })),             /exp_year/);

  // Bad customer_id.
  await assert.rejects(f.pm.add(_validAdd({ customer_id: "not-a-uuid" })),    /customer_id/);

  // Missing brand.
  await assert.rejects(f.pm.add(_validAdd({ brand: "" })),                    /brand/);

  // No input at all.
  await assert.rejects(f.pm.add(),                                            /input object required/);
}

async function _setDefaultUniqueness() {
  var f = _pmFactory();
  var custId = _newCustomerId();

  var a = await f.pm.add(_validAdd({ customer_id: custId, processor_token: "pm_a" }));
  var b = await f.pm.add(_validAdd({ customer_id: custId, processor_token: "pm_b" }));
  var c = await f.pm.add(_validAdd({ customer_id: custId, processor_token: "pm_c" }));

  // Mark A as default.
  var setA = await f.pm.setDefault(a.id);
  check("setDefault A returns changed",   setA.changed === true && setA.is_default === true);

  var defA = await f.pm.defaultForCustomer(custId);
  check("default-for-customer is A",      defA && defA.id === a.id);

  // Move default to B — A must clear.
  var setB = await f.pm.setDefault(b.id);
  check("setDefault B returns changed",   setB.changed === true);

  var aRow = f.db.prepare("SELECT * FROM payment_methods WHERE id = ?").all(a.id)[0];
  var bRow = f.db.prepare("SELECT * FROM payment_methods WHERE id = ?").all(b.id)[0];
  check("A no longer default",            aRow.is_default === 0);
  check("B is default",                   bRow.is_default === 1);

  // Only one default per customer in the table.
  var defaults = f.db.prepare(
    "SELECT id FROM payment_methods WHERE customer_id = ? AND is_default = 1 AND archived_at IS NULL"
  ).all(custId);
  check("exactly one live default",       defaults.length === 1 && defaults[0].id === b.id);

  // Re-set B (idempotent — no-op).
  var setBAgain = await f.pm.setDefault(b.id);
  check("re-set default is no-op",        setBAgain.changed === false);

  // Audit trail: A has added + default_set + default_cleared; B has
  // added + default_set. Within-millisecond ordering is not
  // guaranteed (UUIDv7 carries a random tail), so check on presence
  // not position.
  var aAudit = await f.pm.audit(a.id);
  var aEvents = aAudit.map(function (r) { return r.event; });
  check("A audit has 3 entries",           aEvents.length === 3);
  check("A audit contains 'added'",        aEvents.indexOf("added") !== -1);
  check("A audit contains 'default_set'",  aEvents.indexOf("default_set") !== -1);
  check("A audit contains 'default_cleared'", aEvents.indexOf("default_cleared") !== -1);

  var bAudit = await f.pm.audit(b.id);
  var bEvents = bAudit.map(function (r) { return r.event; });
  check("B audit has 2 entries",           bEvents.length === 2);
  check("B audit contains 'added'",        bEvents.indexOf("added") !== -1);
  check("B audit contains 'default_set'",  bEvents.indexOf("default_set") !== -1);

  // C never set — only 'added'.
  var cAudit = await f.pm.audit(c.id);
  check("C audit only 'added'",           cAudit.length === 1 && cAudit[0].event === "added");
}

async function _setDefaultRefusesArchived() {
  var f = _pmFactory();
  var custId = _newCustomerId();
  var saved = await f.pm.add(_validAdd({ customer_id: custId }));
  await f.pm.archive({ payment_method_id: saved.id, reason: "customer_request" });

  await assert.rejects(f.pm.setDefault(saved.id), /archived/);

  // Unknown id — refused with not-found.
  await assert.rejects(f.pm.setDefault(bFramework.uuid.v7()), /not found/);

  // Bad uuid shape — refused.
  await assert.rejects(f.pm.setDefault("not-a-uuid"), /payment_method_id/);
}

async function _markExpiredWalk() {
  var f = _pmFactory();
  var custId = _newCustomerId();
  var nowYear  = new Date().getUTCFullYear();
  var nowMonth = new Date().getUTCMonth() + 1;

  // markExpired's validator refuses past exp_year on add() — so to
  // build "already-expired" rows we INSERT directly to bypass the
  // validator and exercise the sweep itself.
  function _rawInsert(id, expYear, expMonth, archived) {
    var ts = Date.now();
    f.db.prepare(
      "INSERT INTO payment_methods (id, customer_id, processor, processor_token, brand, last4, " +
      "exp_month, exp_year, billing_address_id, label, is_default, archived_at, archive_reason, created_at, updated_at) " +
      "VALUES (?, ?, 'stripe', ?, 'visa', '4242', ?, ?, NULL, NULL, 0, ?, ?, ?, ?)"
    ).run(id, custId, "pm_" + id, expMonth, expYear, archived ? ts : null, archived ? "operator" : null, ts, ts);
  }

  var lastYearId   = bFramework.uuid.v7();
  var thisMonthId  = bFramework.uuid.v7();
  var lastMonthId  = bFramework.uuid.v7();
  var futureId     = bFramework.uuid.v7();
  var alreadyArchivedId = bFramework.uuid.v7();

  _rawInsert(lastYearId,   nowYear - 1, 1,                                false);
  _rawInsert(lastMonthId,  nowYear,     ((nowMonth - 2 + 12) % 12) + 1,   false); // last month of prior year if Jan
  // If `lastMonth` rolled into prior year, force lastMonthId to (nowYear-1) for the row.
  if (nowMonth === 1) {
    f.db.prepare("UPDATE payment_methods SET exp_year = ? WHERE id = ?").run(nowYear - 1, lastMonthId);
  }
  _rawInsert(thisMonthId,  nowYear,     nowMonth,                          false);
  _rawInsert(futureId,     nowYear + 5, 1,                                 false);
  _rawInsert(alreadyArchivedId, nowYear - 3, 1,                            true);

  var result = await f.pm.markExpired();
  check("markExpired returns count",       typeof result.archived_count === "number");
  check("markExpired archives last year",   result.archived_ids.indexOf(lastYearId) !== -1);
  check("markExpired archives last month",  result.archived_ids.indexOf(lastMonthId) !== -1);
  check("markExpired skips this month",     result.archived_ids.indexOf(thisMonthId) === -1);
  check("markExpired skips future",         result.archived_ids.indexOf(futureId) === -1);
  check("markExpired skips already-arch",   result.archived_ids.indexOf(alreadyArchivedId) === -1);

  // Each newly-archived row carries an 'archived' audit entry with reason 'expired'.
  var auditLastYear = await f.pm.audit(lastYearId);
  var archEvt = auditLastYear.filter(function (r) { return r.event === "archived"; });
  check("expired audit entry written",      archEvt.length === 1 && archEvt[0].reason === "expired");

  // Already-archived row gets no new audit entries from this sweep.
  var auditExisting = await f.pm.audit(alreadyArchivedId);
  check("already-archived row untouched",   auditExisting.length === 0);

  // Re-running markExpired is a no-op.
  var second = await f.pm.markExpired();
  check("markExpired idempotent",           second.archived_count === 0);
}

async function _archiveDropsDefault() {
  var f = _pmFactory();
  var custId = _newCustomerId();
  var a = await f.pm.add(_validAdd({ customer_id: custId, processor_token: "pm_arch_a" }));
  await f.pm.setDefault(a.id);

  var archived = await f.pm.archive({ payment_method_id: a.id, reason: "customer_request", actor: "robert@example.com" });
  check("archive returns row",              archived && archived.id === a.id);
  check("archive sets archived_at",         archived.archived_at != null);
  check("archive sets reason",              archived.archive_reason === "customer_request");
  check("archive clears default",           archived.is_default === 0);

  // Audit trail records the archive with actor + reason.
  var trail = await f.pm.audit(a.id);
  var archRow = trail.filter(function (r) { return r.event === "archived"; })[0];
  check("archived audit row written",       archRow && archRow.reason === "customer_request" && archRow.actor === "robert@example.com");

  // Re-archive is idempotent — no new audit row.
  var beforeLen = (await f.pm.audit(a.id)).length;
  var again = await f.pm.archive({ payment_method_id: a.id, reason: "customer_request" });
  check("archive idempotent",               again && again.id === a.id);
  var afterLen = (await f.pm.audit(a.id)).length;
  check("re-archive writes no audit row",   afterLen === beforeLen);

  // Bad reason refused.
  var b = await f.pm.add(_validAdd({ customer_id: custId, processor_token: "pm_arch_b" }));
  await assert.rejects(
    f.pm.archive({ payment_method_id: b.id, reason: "because" }),
    /reason/,
  );
  await assert.rejects(
    f.pm.archive({ payment_method_id: b.id }),
    /reason/,
  );
  await assert.rejects(
    f.pm.archive(),
    /input object required/,
  );

  // After dropping default via archive, a sibling can become default.
  var c = await f.pm.add(_validAdd({ customer_id: custId, processor_token: "pm_arch_c" }));
  var setC = await f.pm.setDefault(c.id);
  check("sibling can become default after archive", setC.is_default === true);
}

async function _listForCustomerFilters() {
  var f = _pmFactory();
  var custA = _newCustomerId();
  var custB = _newCustomerId();
  var a1 = await f.pm.add(_validAdd({ customer_id: custA, processor_token: "pm_list_a1" }));
  var a2 = await f.pm.add(_validAdd({ customer_id: custA, processor_token: "pm_list_a2" }));
  var a3 = await f.pm.add(_validAdd({ customer_id: custA, processor_token: "pm_list_a3" }));
  await f.pm.add(_validAdd({ customer_id: custB, processor_token: "pm_list_b1" }));

  await f.pm.archive({ payment_method_id: a3.id, reason: "replaced" });

  // Default (archived excluded by default).
  var live = await f.pm.listForCustomer(custA);
  check("list excludes archived by default",     live.length === 2);
  var liveIds = live.map(function (r) { return r.id; });
  check("list returns the right ids",            liveIds.indexOf(a1.id) !== -1 && liveIds.indexOf(a2.id) !== -1 && liveIds.indexOf(a3.id) === -1);

  // include_archived = true → all three.
  var all = await f.pm.listForCustomer(custA, { include_archived: true });
  check("list with include_archived returns 3",  all.length === 3);

  // Default-first ordering: set a2 as default and verify it lands first.
  await f.pm.setDefault(a2.id);
  var ordered = await f.pm.listForCustomer(custA);
  check("default-first ordering",                ordered[0].id === a2.id);

  // Cross-customer isolation: listForCustomer(B) sees only B's rows.
  var bRows = await f.pm.listForCustomer(custB);
  check("cross-customer isolation",              bRows.length === 1 && bRows[0].customer_id === custB);

  // Bad uuid refused.
  await assert.rejects(f.pm.listForCustomer("not-a-uuid"), /customer_id/);
}

async function _byProcessorTokenAndGet() {
  var f = _pmFactory();
  var custId = _newCustomerId();
  // Use the shared safe-token helper. A dash-stripped uuid.v7() can
  // occasionally form a 13+ consecutive-digit run (its timestamp prefix
  // is digit-heavy), which the PAN-shape guard rightly refuses — a flake.
  var token = _safeToken();
  var saved = await f.pm.add(_validAdd({ customer_id: custId, processor_token: token }));

  var got = await f.pm.get(saved.id);
  check("get returns the row",             got && got.id === saved.id);
  check("get missing returns null",        (await f.pm.get(bFramework.uuid.v7())) === null);

  var byTok = await f.pm.byProcessorToken({ processor: "stripe", processor_token: token });
  check("byProcessorToken returns the row", byTok && byTok.id === saved.id);

  var miss = await f.pm.byProcessorToken({ processor: "paypal", processor_token: token });
  check("byProcessorToken cross-processor miss", miss === null);

  // Duplicate (processor, token) refused at the UNIQUE index level.
  await assert.rejects(
    f.pm.add(_validAdd({ customer_id: _newCustomerId(), processor_token: token })),
    /already saved/,
  );

  // byProcessorToken refuses bad input.
  await assert.rejects(
    f.pm.byProcessorToken({ processor: "stripe", processor_token: "" }),
    /processor_token/,
  );
  await assert.rejects(
    f.pm.byProcessorToken({ processor: "bogus", processor_token: token }),
    /processor/,
  );
  await assert.rejects(f.pm.byProcessorToken(), /input object required/);
}

async function _addAcceptsAllProcessors() {
  var f = _pmFactory();
  var custId = _newCustomerId();
  var procs = paymentMethodsModule.PROCESSORS;
  for (var i = 0; i < procs.length; i += 1) {
    var p = procs[i];
    var saved = await f.pm.add(_validAdd({
      customer_id:     custId,
      processor:       p,
      processor_token: "tok_" + p + "_" + i,
    }));
    check("add accepts processor " + p, saved.processor === p);
  }
}

async function run() {
  await _addHappyPath();
  await _refusePAN();
  await _refuseCVVField();
  await _refuseInvalidShape();
  await _setDefaultUniqueness();
  await _setDefaultRefusesArchived();
  await _markExpiredWalk();
  await _archiveDropsDefault();
  await _listForCustomerFilters();
  await _byProcessorTokenAndGet();
  await _addAcceptsAllProcessors();
}

module.exports = { run: run };
