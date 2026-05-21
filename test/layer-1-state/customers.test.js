"use strict";
/**
 * customers — passkey-enrolled accounts.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0006 (customers). Email hashing comes from b.crypto.namespaceHash;
 * the test confirms collisions on canonical-equivalent addresses and
 * non-collisions on distinct addresses.
 *
 * Coverage:
 *   - register: persists customer, derives email_hash via b.crypto.namespaceHash
 *   - register: duplicate addresses refused (same hash)
 *   - register: canonical normalization (domain case-fold) collides
 *   - register / validation: bad email shapes refused at strict profile
 *   - byEmailHash: lookup round-trips
 *   - addPasskey: persists credential row, refuses duplicate credential_id
 *   - listPasskeys: ordered by created_at
 *   - removePasskey: idempotent, FK cascade safe
 *   - updatePasskeyCounter: monotonic enforcement, regression refused
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_CUSTOMERS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0006_customers.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG_CUSTOMERS, "utf8")).forEach(function (s) {
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

async function _register() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({
    email:        "alice@example.com",
    display_name: "Alice Example",
  });
  check("register returns uuid",            typeof c.id === "string" && c.id.length === 36);
  check("register stores hash, not raw",     c.email_hash && c.email_hash.indexOf("alice") === -1);
  check("register persists display_name",    c.display_name === "Alice Example");
  check("register hash is hex SHA3-512",     /^[0-9a-f]{128}$/.test(c.email_hash));

  var fetched = await customers.get(c.id);
  check("get round-trips",                   fetched && fetched.id === c.id && fetched.email_hash === c.email_hash);
}

async function _byEmailHash() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "bob@example.com", display_name: "Bob" });
  var hash = customers.hashEmail("bob@example.com");
  check("hashEmail matches register hash",   hash === c.email_hash);
  var found = await customers.byEmailHash(hash);
  check("byEmailHash recovers customer",     found && found.id === c.id);
  var miss = await customers.byEmailHash(customers.hashEmail("nobody@example.com"));
  check("byEmailHash misses on absent",      miss === null);
}

async function _duplicateRefused() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  await customers.register({ email: "dup@example.com", display_name: "First" });
  await assert.rejects(
    customers.register({ email: "dup@example.com", display_name: "Second" }),
    /already registered/i,
  );
}

async function _canonicalNormalization() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  await customers.register({ email: "case@example.com", display_name: "Lower" });
  // Same address with capital-letter domain — should collide on
  // hash since the primitive lowercases the domain before hashing.
  await assert.rejects(
    customers.register({ email: "case@EXAMPLE.COM", display_name: "Mixed" }),
    /already registered/i,
  );
}

async function _validation() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  await assert.rejects(customers.register(),                                            /input object required/);
  await assert.rejects(customers.register({}),                                           /email/);
  await assert.rejects(customers.register({ email: "" }),                                /email/);
  await assert.rejects(customers.register({ email: "not-an-email", display_name: "x" }),  /email/);
  await assert.rejects(customers.register({ email: "two@@example.com", display_name: "x" }), /email/);
  await assert.rejects(customers.register({ email: "a@example.com", display_name: "" }),    /display_name/);
  // Header-injection class — strict profile MUST refuse.
  await assert.rejects(customers.register({ email: "a@example.com\r\nBcc: evil@x", display_name: "x" }), /email/);
  await assert.rejects(customers.byEmailHash(""),                                        /non-empty string/);
}

async function _addAndListPasskeys() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "pk@example.com", display_name: "PK" });
  var pk1 = await customers.addPasskey(c.id, {
    credential_id: "cred-A",
    public_key:    "pk-A",
    counter:       0,
    transports:    "internal,hybrid",
  });
  check("addPasskey returns row",        pk1.id && pk1.credential_id === "cred-A");
  check("addPasskey stores transports",  pk1.transports === "internal,hybrid");

  // Second passkey (e.g., user enrolls a second device).
  var pk2 = await customers.addPasskey(c.id, {
    credential_id: "cred-B",
    public_key:    "pk-B",
    counter:       5,
    transports:    "usb",
  });
  var list = await customers.listPasskeys(c.id);
  check("listPasskeys returns both",     list.length === 2);
  check("listPasskeys ordered by ts",     list[0].id === pk1.id && list[1].id === pk2.id);

  var byCred = await customers.getPasskeyByCredentialId("cred-A");
  check("getPasskeyByCredentialId hits",  byCred && byCred.id === pk1.id);
  check("getPasskeyByCredentialId miss",  (await customers.getPasskeyByCredentialId("nope")) === null);
}

async function _duplicateCredentialRefused() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c1 = await customers.register({ email: "c1@example.com", display_name: "C1" });
  var c2 = await customers.register({ email: "c2@example.com", display_name: "C2" });
  await customers.addPasskey(c1.id, { credential_id: "shared", public_key: "k1" });
  // Same credential_id — should refuse even for a different customer
  await assert.rejects(
    customers.addPasskey(c2.id, { credential_id: "shared", public_key: "k2" }),
    /already registered/i,
  );
}

async function _removePasskey() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "rm@example.com", display_name: "RM" });
  var pk = await customers.addPasskey(c.id, { credential_id: "rm-1", public_key: "k" });
  var removed = await customers.removePasskey(pk.id);
  check("removePasskey true on hit",      removed === true);
  var idempotent = await customers.removePasskey(pk.id);
  check("removePasskey false on miss",    idempotent === false);
  var list = await customers.listPasskeys(c.id);
  check("listPasskeys empty after remove", list.length === 0);
}

async function _counterMonotonic() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "ctr@example.com", display_name: "Ctr" });
  var pk = await customers.addPasskey(c.id, { credential_id: "ctr-1", public_key: "k", counter: 5 });

  var bumped = await customers.updatePasskeyCounter(pk.id, 7);
  check("updatePasskeyCounter persists bump", bumped.counter === 7);

  // Counter regression — refuse
  await assert.rejects(customers.updatePasskeyCounter(pk.id, 6), /regression/i);

  // Counter == 0 ("authenticator doesn't track") — accept without bump
  var zeroAccept = await customers.updatePasskeyCounter(pk.id, 0);
  check("counter=0 accepted as no-counter-authenticator", zeroAccept.counter === 7);

  // Unknown passkey
  var nullPk = await customers.updatePasskeyCounter(bShop.framework.uuid.v7(), 1);
  check("updatePasskeyCounter null on miss", nullPk === null);
}

async function _addPasskeyValidation() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "vpk@example.com", display_name: "V" });
  await assert.rejects(customers.addPasskey(c.id),                                        /input object required/);
  await assert.rejects(customers.addPasskey(c.id, { credential_id: "" }),                  /credential_id/);
  await assert.rejects(customers.addPasskey(c.id, { credential_id: "x", public_key: "" }), /public_key/);
  await assert.rejects(customers.addPasskey(c.id, {
    credential_id: "x", public_key: "y", transports: "UPPER",
  }), /transports/);
  await assert.rejects(customers.addPasskey(c.id, {
    credential_id: "x", public_key: "y", counter: -1,
  }), /counter/);
  // Unknown customer
  await assert.rejects(customers.addPasskey(bShop.framework.uuid.v7(), {
    credential_id: "orphan", public_key: "k",
  }), /not found/);
}

async function run() {
  await _register();
  await _byEmailHash();
  await _duplicateRefused();
  await _canonicalNormalization();
  await _validation();
  await _addAndListPasskeys();
  await _duplicateCredentialRefused();
  await _removePasskey();
  await _counterMonotonic();
  await _addPasskeyValidation();
}

module.exports = { run: run };
