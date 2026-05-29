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
 *   - removePasskey: customer-scoped, idempotent, refuses cross-customer
 *   - update: display_name mutation; email change refused (no verification)
 *   - updatePasskeyCounter: monotonic enforcement, regression refused
 */

var nodeFs     = require("node:fs");
var nodePath   = require("node:path");
var nodeCrypto = require("node:crypto");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_CUSTOMERS = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0006_customers.sql");
var MIG_OAUTH     = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0205_customer_oauth_identities.sql");

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
  _splitSchema(nodeFs.readFileSync(MIG_OAUTH, "utf8")).forEach(function (s) {
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
  var removed = await customers.removePasskey(c.id, pk.id);
  check("removePasskey true on hit",      removed === true);
  var idempotent = await customers.removePasskey(c.id, pk.id);
  check("removePasskey false on miss",    idempotent === false);
  var list = await customers.listPasskeys(c.id);
  check("listPasskeys empty after remove", list.length === 0);
}

// The credential id is part of the WHERE clause, not just the lookup: a
// customer cannot revoke another customer's passkey by passing its id.
async function _removePasskeyScoped() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var owner   = await customers.register({ email: "owner@example.com", display_name: "Owner" });
  var other   = await customers.register({ email: "other@example.com", display_name: "Other" });
  var pk = await customers.addPasskey(owner.id, { credential_id: "scoped-1", public_key: "k" });
  // The OTHER customer tries to remove the owner's passkey → no-op (false),
  // and the row survives.
  var crossAttempt = await customers.removePasskey(other.id, pk.id);
  check("removePasskey refuses cross-customer", crossAttempt === false);
  check("cross-customer passkey survives",       (await customers.listPasskeys(owner.id)).length === 1);
  // The real owner can remove it.
  check("owner removes own passkey",             (await customers.removePasskey(owner.id, pk.id)) === true);
}

async function _updateDisplayName() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "edit@example.com", display_name: "Old Name" });
  var beforeHash = c.email_hash;
  var updated = await customers.update(c.id, { display_name: "New Name" });
  check("update returns the row",            updated && updated.id === c.id);
  check("update changes display_name",       updated.display_name === "New Name");
  check("update leaves email_hash intact",   updated.email_hash === beforeHash);
  check("update bumps updated_at",           updated.updated_at >= c.updated_at);
  var refetched = await customers.get(c.id);
  check("update persists",                   refetched.display_name === "New Name");
}

async function _updateValidation() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var c = await customers.register({ email: "uv@example.com", display_name: "UV" });
  await assert.rejects(customers.update(c.id),                              /patch object required/);
  await assert.rejects(customers.update(c.id, {}),                          /nothing to update/);
  await assert.rejects(customers.update(c.id, { display_name: "" }),         /display_name/);
  await assert.rejects(customers.update(c.id, { display_name: "x\r\ny" }),   /control bytes/);
  // Email change is deliberately refused — it needs a verification ceremony.
  await assert.rejects(
    customers.update(c.id, { email: "new@example.com" }),
    /email cannot be changed|EMAIL_CHANGE_UNSUPPORTED/i,
  );
  // Unknown customer.
  await assert.rejects(
    customers.update(bShop.framework.uuid.v7(), { display_name: "Ghost" }),
    /not found/,
  );
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

async function _oidcNewAccount() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  var rv = await customers.signInWithOIDC({ provider: "google", subject: "g-sub-1", email: "New.User@Example.com", email_verified: true });
  check("oidc new account created",        rv.created === true && rv.linked_via === "new");
  check("oidc new account has a customer",  !!(rv.customer && rv.customer.id));
  // A second sign-in with the same subject resolves to the SAME customer.
  var rv2 = await customers.signInWithOIDC({ provider: "google", subject: "g-sub-1", email: "new.user@example.com", email_verified: true });
  check("oidc same subject → same customer", rv2.customer.id === rv.customer.id && rv2.created === false && rv2.linked_via === "oauth-subject");
  check("byOAuthIdentity resolves the link", (await customers.byOAuthIdentity("google", "g-sub-1")).id === rv.customer.id);
}

async function _oidcLinksVerifiedEmail() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  // A passwordless customer already exists for this email.
  var existing = await customers.register({ email: "buyer@example.com", display_name: "Buyer" });
  // Google sign-in with the SAME, VERIFIED email links to that account.
  var rv = await customers.signInWithOIDC({ provider: "google", subject: "g-sub-2", email: "buyer@example.com", email_verified: true });
  check("oidc verified email links existing", rv.customer.id === existing.id && rv.created === false && rv.linked_via === "verified-email");
}

async function _oidcRefusesUnverifiedEmailConflict() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  await customers.register({ email: "victim@example.com", display_name: "Victim" });
  // An attacker signs in with the victim's email but the IdP did NOT
  // verify it. We must NOT link (takeover) and cannot create a colliding
  // account → the sign-in is refused.
  await assert.rejects(
    customers.signInWithOIDC({ provider: "google", subject: "attacker-sub", email: "victim@example.com", email_verified: false }),
    /not verified it|OAUTH_EMAIL_UNVERIFIED_CONFLICT/i,
  );
  check("attacker subject left unlinked", (await customers.byOAuthIdentity("google", "attacker-sub")) === null);
}

async function _oidcUnverifiedNoCollisionCreates() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  // Unverified email with no existing account → a new account is created
  // (the email is informational; the subject is the trust anchor).
  var rv = await customers.signInWithOIDC({ provider: "google", subject: "fresh-sub", email: "fresh@example.com", email_verified: false });
  check("oidc unverified+no-collision creates", rv.created === true && rv.linked_via === "new");
}

async function _oidcValidation() {
  var customers = bShop.customers.create({ query: _makeQuery() });
  await assert.rejects(customers.signInWithOIDC({ provider: "myspace", subject: "x", email: "a@b.com", email_verified: true }), /unknown provider/);
  await assert.rejects(customers.signInWithOIDC({ provider: "google", subject: "", email: "a@b.com", email_verified: true }), /subject must be/);
  // No email + no existing subject link → can't create an account.
  await assert.rejects(customers.signInWithOIDC({ provider: "google", subject: "no-email-sub", email_verified: true }), /email is required/);
}

// Apple client-secret JWT minter — round-trips against a generated P-256
// key (no Apple account needed): the output must be a valid ES256 JWS with
// the claims Apple requires and a P1363 signature that verifies.
function _b64urlDecode(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function _appleClientSecret() {
  var kp  = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  var pem = kp.privateKey.export({ type: "pkcs8", format: "pem" });
  var jwt = bShop.customers.mintAppleClientSecret({
    team_id: "TEAM123456", key_id: "KEY1234567", client_id: "com.example.shop",
    private_key: pem, ttl_seconds: 3600,
  });
  var parts = jwt.split(".");
  check("apple secret is a 3-part JWS",      parts.length === 3);
  var header  = JSON.parse(_b64urlDecode(parts[0]).toString());
  var payload = JSON.parse(_b64urlDecode(parts[1]).toString());
  check("apple secret header is ES256",      header.alg === "ES256" && header.kid === "KEY1234567");
  check("apple secret iss is the team",      payload.iss === "TEAM123456");
  check("apple secret sub is the client",    payload.sub === "com.example.shop");
  check("apple secret aud is appleid",       payload.aud === "https://appleid.apple.com");
  check("apple secret exp honors ttl",       payload.exp - payload.iat === 3600);
  var sig = _b64urlDecode(parts[2]);
  check("apple secret sig is P1363 (64 B)",  sig.length === 64);
  var ok = nodeCrypto.verify("sha256", Buffer.from(parts[0] + "." + parts[1]),
    { key: kp.publicKey, dsaEncoding: "ieee-p1363" }, sig);
  check("apple secret signature verifies",   ok === true);
  // Default ttl (no ttl_seconds) is 150 days, expressed in seconds.
  var dflt = bShop.customers.mintAppleClientSecret({
    team_id: "T", key_id: "K", client_id: "C", private_key: pem,
  });
  var dp = JSON.parse(_b64urlDecode(dflt.split(".")[1]).toString());
  check("apple secret default ttl 150 days", dp.exp - dp.iat === 150 * 24 * 60 * 60);
  // Bad input throws (config-time validation).
  assert.throws(function () { bShop.customers.mintAppleClientSecret({ team_id: "x", key_id: "y", client_id: "z" }); }, /required/);
  assert.throws(function () { bShop.customers.mintAppleClientSecret({ team_id: "x", key_id: "y", client_id: "z", private_key: "nope" }); }, /valid PEM/);
  var rsa = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  assert.throws(function () {
    bShop.customers.mintAppleClientSecret({ team_id: "x", key_id: "y", client_id: "z",
      private_key: rsa.privateKey.export({ type: "pkcs8", format: "pem" }) });
  }, /EC P-256/);
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
  await _removePasskeyScoped();
  await _updateDisplayName();
  await _updateValidation();
  await _counterMonotonic();
  await _addPasskeyValidation();
  await _oidcNewAccount();
  await _oidcLinksVerifiedEmail();
  await _oidcRefusesUnverifiedEmailConflict();
  await _oidcUnverifiedNoCollisionCreates();
  await _oidcValidation();
  _appleClientSecret();
}

module.exports = { run: run };
