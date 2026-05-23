"use strict";
/**
 * carrier-accounts — per-operator carrier API credential store, with
 * at-rest hashing, 24h rotation grace, constant-time verify, and
 * per-account usage metrics.
 *
 * Layer 1 against in-memory node:sqlite with migration 0191 loaded.
 *
 * Coverage:
 *   - defineAccount across every carrier in the enum, with secrets
 *     hashed at rest and plaintext returned exactly once
 *   - defineAccount upsert on (carrier, label) replaces secrets +
 *     clears rotation state
 *   - rotateCredentials returns a fresh plaintext pair, slides the old
 *     api_key_hash to api_key_previous_hash, flips status to
 *     `rotating`, and verifyCredentials accepts both hashes within the
 *     24h grace and rejects the previous after the grace lapses
 *   - verifyCredentials uses a constant-time hex compare and refuses
 *     disabled rows immediately
 *   - disableAccount + enableAccount round-trip + idempotency
 *   - recordUsage + metricsForAccount success-rate + percentile latency
 *   - accountByCarrier + listAccounts filtering
 *   - factory + entry-point input validation refusals
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var carrierAccounts = require("../../lib/carrier-accounts");
var bShop           = require("../../lib/index");

var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0191_carrier_accounts.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  var queryFn = async function (sql, params) {
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
  queryFn.__db = db;
  return queryFn;
}

function _validAddress() {
  return { line1: "100 Warehouse Way", city: "Bristol", country: "GB" };
}

async function _wire() {
  var q = _makeQuery();
  var svc = carrierAccounts.create({ query: q });
  return { q: q, svc: svc };
}

// ---- 1. defineAccount across every carrier ----------------------------

async function _defineAccountAcrossCarriers() {
  var w = await _wire();

  var samples = [
    { carrier: "ups",            account_number: "AB1234",     api_key: "ups-key-abcdef1234" },
    { carrier: "fedex",          account_number: "510000123",  api_key: "fedex-key-abcdef1234", meter_number: "M12345" },
    { carrier: "usps",           account_number: "9001234567", api_key: "usps-key-abcdef1234" },
    { carrier: "dhl",            account_number: "950000123",  api_key: "dhl-key-abcdef1234",   api_secret: "dhl-secret-1234abcd" },
    { carrier: "canada_post",    account_number: "0012345",    api_key: "cp-key-abcdef1234" },
    { carrier: "royal_mail",     account_number: "RM-9999",    api_key: "rm-key-abcdef1234" },
    { carrier: "australia_post", account_number: "AP-001234",  api_key: "ap-key-abcdef1234" },
  ];

  for (var i = 0; i < samples.length; i += 1) {
    var s = samples[i];
    var defined = await w.svc.defineAccount({
      carrier:           s.carrier,
      account_number:    s.account_number,
      api_key:           s.api_key,
      api_secret:        s.api_secret || null,
      meter_number:      s.meter_number || null,
      account_label:     "production",
      ship_from_address: _validAddress(),
    });
    check("defineAccount carrier=" + s.carrier + " row id is a UUID",
      typeof defined.id === "string" && defined.id.length > 0);
    check("defineAccount carrier=" + s.carrier + " hashed account_number is hex",
      typeof defined.account_number_hash === "string" &&
      /^[0-9a-f]+$/.test(defined.account_number_hash) &&
      defined.account_number_hash !== s.account_number);
    check("defineAccount carrier=" + s.carrier + " hashed api_key is hex + not plaintext",
      typeof defined.api_key_hash === "string" &&
      /^[0-9a-f]+$/.test(defined.api_key_hash) &&
      defined.api_key_hash !== s.api_key);
    check("defineAccount carrier=" + s.carrier + " plaintext returned once",
      defined.plaintext.api_key === s.api_key &&
      defined.plaintext.account_number === s.account_number);
    check("defineAccount carrier=" + s.carrier + " status = active",
      defined.status === "active" && defined.active === true);
    check("defineAccount carrier=" + s.carrier + " ship_from_address round-trips",
      defined.ship_from_address.city === "Bristol");
    check("defineAccount carrier=" + s.carrier + " normalised <= 12 chars",
      defined.account_number_normalised.length <= 12);

    // Hash is deterministic against namespaceHash
    var expectAN = bShop.framework.crypto.namespaceHash(
      carrierAccounts.NS_ACCOUNT_NUMBER, s.account_number,
    );
    var expectAK = bShop.framework.crypto.namespaceHash(
      carrierAccounts.NS_API_KEY, s.api_key,
    );
    check("defineAccount carrier=" + s.carrier + " account_number_hash matches namespaceHash",
      defined.account_number_hash === expectAN);
    check("defineAccount carrier=" + s.carrier + " api_key_hash matches namespaceHash",
      defined.api_key_hash === expectAK);

    // getAccount returns the projected row without the plaintext bundle
    var fetched = await w.svc.getAccount(defined.id);
    check("getAccount returns no plaintext",     fetched.plaintext === undefined);
    check("getAccount preserves hash",           fetched.api_key_hash === defined.api_key_hash);
  }

  // Refusals
  await assert.rejects(w.svc.defineAccount(),                                              /input object required/);
  await assert.rejects(w.svc.defineAccount({ carrier: "bogus",
    account_number: "X", api_key: "key-key-key-key", ship_from_address: _validAddress() }), /carrier/);
  await assert.rejects(w.svc.defineAccount({ carrier: "ups",
    account_number: "!!!bad!!!", api_key: "key-key-key-key",
    ship_from_address: _validAddress() }),                                                 /account_number/);
  await assert.rejects(w.svc.defineAccount({ carrier: "ups",
    account_number: "AB1234", api_key: "short",
    ship_from_address: _validAddress() }),                                                 /api_key/);
  await assert.rejects(w.svc.defineAccount({ carrier: "ups",
    account_number: "AB1234", api_key: "key-key-key-key",
    ship_from_address: { line1: "", city: "x", country: "GB" } }),                          /line1/);
  await assert.rejects(w.svc.defineAccount({ carrier: "ups",
    account_number: "AB1234", api_key: "key-key-key-key",
    ship_from_address: { line1: "x", city: "y", country: "GBR" } }),                        /country/);
}

// ---- 2. upsert replaces secrets + clears rotation state ----------------

async function _defineAccountUpsertReplacesSecrets() {
  var w = await _wire();
  var first = await w.svc.defineAccount({
    carrier:        "ups",
    account_number: "AB1234",
    api_key:        "first-ups-key-001",
    account_label:  "production",
    ship_from_address: _validAddress(),
  });
  // Rotate so api_key_previous_hash is non-null
  await w.svc.rotateCredentials({ account_id: first.id });
  var rotated = await w.svc.getAccount(first.id);
  check("rotate sets previous hash before upsert", typeof rotated.api_key_previous_hash === "string");
  check("rotate flips status",                     rotated.status === "rotating");

  // Re-define same (carrier, label) — secrets replaced, previous cleared
  var second = await w.svc.defineAccount({
    carrier:        "ups",
    account_number: "AB1234",
    api_key:        "second-ups-key-002",
    account_label:  "production",
    ship_from_address: _validAddress(),
  });
  check("upsert keeps id",                       second.id === first.id);
  check("upsert clears previous hash",           second.api_key_previous_hash == null);
  check("upsert flips status back to active",    second.status === "active");
  check("upsert new api_key_hash != old",        second.api_key_hash !== rotated.api_key_hash);
}

// ---- 3. rotateCredentials + 24h grace ----------------------------------

async function _rotateCredentialsGrace() {
  var w = await _wire();
  var defined = await w.svc.defineAccount({
    carrier:        "fedex",
    account_number: "510000123",
    api_key:        "original-fedex-key-1234",
    account_label:  "production",
    ship_from_address: _validAddress(),
  });
  var originalKey = defined.plaintext.api_key;

  // Pre-rotate, original key verifies
  var ok = await w.svc.verifyCredentials({ account_id: defined.id, plaintext_key: originalKey });
  check("verify original (pre-rotate)", ok.ok === true && ok.matched === "live");

  // Rotate — fresh plaintext returned, status flips, previous hash slid in
  var rotated = await w.svc.rotateCredentials({ account_id: defined.id });
  check("rotate plaintext returned",      typeof rotated.plaintext.api_key === "string" &&
                                          rotated.plaintext.api_key !== originalKey);
  check("rotate status = rotating",       rotated.status === "rotating");
  check("rotate sets rotated_at",         typeof rotated.rotated_at === "number" && rotated.rotated_at > 0);
  check("rotate exposes grace ms",        rotated.rotation_grace_ms === carrierAccounts.ROTATION_GRACE_MS);
  check("rotate api_key_hash changed",    rotated.api_key_hash !== defined.api_key_hash);
  check("rotate previous hash = old",     rotated.api_key_previous_hash === defined.api_key_hash);

  var newKey = rotated.plaintext.api_key;

  // Both keys verify within the grace window — `now` left to default
  var liveCheck = await w.svc.verifyCredentials({ account_id: defined.id, plaintext_key: newKey });
  check("verify new key matches live",    liveCheck.ok === true && liveCheck.matched === "live");
  var prevCheck = await w.svc.verifyCredentials({ account_id: defined.id, plaintext_key: originalKey });
  check("verify previous within grace",   prevCheck.ok === true && prevCheck.matched === "previous" &&
                                          typeof prevCheck.grace_expires_at === "number");

  // After the grace window — previous refused, new still accepted
  var afterGrace = rotated.rotated_at + carrierAccounts.ROTATION_GRACE_MS + 1;
  var stale = await w.svc.verifyCredentials({
    account_id:    defined.id,
    plaintext_key: originalKey,
    now:           afterGrace,
  });
  check("verify previous after grace refused", stale.ok === false && stale.reason === "mismatch");
  var liveAfter = await w.svc.verifyCredentials({
    account_id:    defined.id,
    plaintext_key: newKey,
    now:           afterGrace,
  });
  check("verify new after grace accepted",     liveAfter.ok === true && liveAfter.matched === "live");

  // Random plaintext refused both windows
  var randomMiss = await w.svc.verifyCredentials({
    account_id:    defined.id,
    plaintext_key: "totally-bogus-key-zzzzzz",
  });
  check("verify random key refused", randomMiss.ok === false && randomMiss.reason === "mismatch");

  // Rotate refusals
  await assert.rejects(w.svc.rotateCredentials(),                                  /input object required/);
  await assert.rejects(w.svc.rotateCredentials({ account_id: bShop.framework.uuid.v7() }),
                                                                                   /not found/);
}

// ---- 4. verifyCredentials constant-time + disabled refusal -------------

async function _verifyCredentialsConstantTimeAndDisabled() {
  var w = await _wire();
  var defined = await w.svc.defineAccount({
    carrier:        "dhl",
    account_number: "950000123",
    api_key:        "dhl-original-key-1234",
    api_secret:     "dhl-original-secret-1234",
    account_label:  "production",
    ship_from_address: _validAddress(),
  });

  // Deterministic hash → verify returns ok
  var ok = await w.svc.verifyCredentials({
    account_id:    defined.id,
    plaintext_key: defined.plaintext.api_key,
  });
  check("verify plaintext-hash deterministic", ok.ok === true);

  // Constant-time compare — different lengths still refused without
  // throwing. (The plaintext alphabet refuses short strings; we test
  // with a properly-sized but wrong key.)
  var wrong = await w.svc.verifyCredentials({
    account_id:    defined.id,
    plaintext_key: "dhl-DIFFERENT-key-9999",
  });
  check("verify wrong key returns mismatch",   wrong.ok === false && wrong.reason === "mismatch");

  // Disable + verify refuses immediately (even with the correct key)
  await w.svc.disableAccount({ account_id: defined.id, reason: "operator compromised key suspected" });
  var afterDisable = await w.svc.verifyCredentials({
    account_id:    defined.id,
    plaintext_key: defined.plaintext.api_key,
  });
  check("verify disabled refuses",             afterDisable.ok === false && afterDisable.reason === "disabled");

  // Refusals
  await assert.rejects(w.svc.verifyCredentials(),                                 /input object required/);
  await assert.rejects(w.svc.verifyCredentials({ account_id: defined.id,
    plaintext_key: "x" }),                                                         /plaintext_key/);
}

// ---- 5. disableAccount + enableAccount ---------------------------------

async function _disableEnableLifecycle() {
  var w = await _wire();
  var defined = await w.svc.defineAccount({
    carrier:        "usps",
    account_number: "9001234567",
    api_key:        "usps-key-abcdef1234",
    account_label:  "production",
    ship_from_address: _validAddress(),
  });

  var disabled = await w.svc.disableAccount({
    account_id: defined.id, reason: "rotating off USPS for now",
  });
  check("disable status",                 disabled.status === "disabled");
  check("disable reason persisted",       disabled.disabled_reason === "rotating off USPS for now");
  check("disable disabled_at stamped",    typeof disabled.disabled_at === "number" && disabled.disabled_at > 0);

  // Idempotent re-disable
  var redis = await w.svc.disableAccount({
    account_id: defined.id, reason: "still off",
  });
  check("disable idempotent",             redis.status === "disabled" &&
                                          redis.disabled_at === disabled.disabled_at);

  // Rotate refuses on disabled rows
  await assert.rejects(w.svc.rotateCredentials({ account_id: defined.id }),       /disabled/);

  // Re-enable
  var enabled = await w.svc.enableAccount({ account_id: defined.id });
  check("enable status",                  enabled.status === "active");
  check("enable clears reason",           enabled.disabled_reason == null);
  check("enable clears disabled_at",      enabled.disabled_at == null);

  // Idempotent re-enable
  var reenabled = await w.svc.enableAccount({ account_id: defined.id });
  check("enable idempotent",              reenabled.status === "active");

  // Refusals
  await assert.rejects(w.svc.disableAccount({ account_id: defined.id, reason: "" }), /reason/);
  await assert.rejects(w.svc.disableAccount({ account_id: bShop.framework.uuid.v7(),
    reason: "missing" }),                                                            /not found/);
  await assert.rejects(w.svc.enableAccount({ account_id: bShop.framework.uuid.v7() }),
                                                                                     /not found/);
}

// ---- 6. recordUsage + metricsForAccount --------------------------------

async function _metricsForAccountSuccessRateAndLatency() {
  var w = await _wire();
  var defined = await w.svc.defineAccount({
    carrier:        "ups",
    account_number: "AB1234",
    api_key:        "metrics-test-key-1234",
    account_label:  "metrics",
    ship_from_address: _validAddress(),
  });
  var id = defined.id;

  var beforeWindow = Date.now() - 60 * 1000;

  // 6 successful @ varying latencies, 4 failed @ varying latencies
  var sampleSuccess = [100, 200, 300, 400, 500, 1000];
  var sampleFailure = [50, 800, 1200, 1500];
  var i;
  for (i = 0; i < sampleSuccess.length; i += 1) {
    await w.svc.recordUsage({
      account_id: id, operation: "rate_quote",
      success:    true, ms_elapsed: sampleSuccess[i],
    });
  }
  for (i = 0; i < sampleFailure.length; i += 1) {
    await w.svc.recordUsage({
      account_id: id, operation: "label_create",
      success:    false, ms_elapsed: sampleFailure[i],
    });
  }

  var afterWindow = Date.now() + 60 * 1000;

  var metrics = await w.svc.metricsForAccount({
    account_id: id, from: beforeWindow, to: afterWindow,
  });
  check("metrics requests count",         metrics.requests === 10);
  check("metrics successes count",        metrics.successes === 6);
  check("metrics failures count",         metrics.failures === 4);
  // success_rate = 6/10 = 0.6
  check("metrics success_rate",           Math.abs(metrics.success_rate - 0.6) < 1e-9);
  // sumMs = 100+200+300+400+500+1000 + 50+800+1200+1500 = 6050; /10 = 605
  check("metrics avg_ms",                 Math.abs(metrics.avg_ms - 605) < 1e-9);
  // Sorted latencies: 50, 100, 200, 300, 400, 500, 800, 1000, 1200, 1500
  // p50 nearest-rank = ceil(0.5*10)-1 = idx 4 -> 400
  // p95 nearest-rank = ceil(0.95*10)-1 = idx 9 -> 1500
  check("metrics p50_ms",                 metrics.p50_ms === 400);
  check("metrics p95_ms",                 metrics.p95_ms === 1500);

  // Empty window — zero shape, no NaN
  var empty = await w.svc.metricsForAccount({
    account_id: id, from: 1, to: 2,
  });
  check("metrics empty requests",         empty.requests === 0);
  check("metrics empty success_rate",     empty.success_rate === 0);
  check("metrics empty avg_ms",           empty.avg_ms === 0);
  check("metrics empty p50/p95",          empty.p50_ms === 0 && empty.p95_ms === 0);

  // Refusals
  await assert.rejects(w.svc.recordUsage(),                                       /input object required/);
  await assert.rejects(w.svc.recordUsage({ account_id: id, operation: "BAD-OP",
    success: true, ms_elapsed: 1 }),                                              /operation/);
  await assert.rejects(w.svc.recordUsage({ account_id: id, operation: "ok",
    success: "yes", ms_elapsed: 1 }),                                             /success/);
  await assert.rejects(w.svc.recordUsage({ account_id: id, operation: "ok",
    success: true, ms_elapsed: -1 }),                                             /ms_elapsed/);
  await assert.rejects(w.svc.recordUsage({ account_id: bShop.framework.uuid.v7(),
    operation: "ok", success: true, ms_elapsed: 1 }),                             /not found/);
  await assert.rejects(w.svc.metricsForAccount(),                                 /input object required/);
  await assert.rejects(w.svc.metricsForAccount({ account_id: id, from: 10, to: 5 }), /from must be <= to/);
}

// ---- 7. accountByCarrier + listAccounts filtering ----------------------

async function _accountByCarrierAndListFilters() {
  var w = await _wire();
  await w.svc.defineAccount({
    carrier: "ups", account_number: "AB1234", api_key: "k-ups-primary-001",
    account_label: "production", ship_from_address: _validAddress(),
  });
  await w.svc.defineAccount({
    carrier: "ups", account_number: "CD5678", api_key: "k-ups-secondary-001",
    account_label: "sandbox", ship_from_address: _validAddress(),
  });
  await w.svc.defineAccount({
    carrier: "fedex", account_number: "510000123", api_key: "k-fedex-primary-001",
    ship_from_address: _validAddress(),  // unlabelled
  });

  // accountByCarrier with label
  var ups = await w.svc.accountByCarrier({ carrier: "ups", label: "production" });
  check("accountByCarrier label match",    ups != null && ups.account_label === "production");
  var ups2 = await w.svc.accountByCarrier({ carrier: "ups", label: "sandbox" });
  check("accountByCarrier label sandbox",  ups2 != null && ups2.account_label === "sandbox");

  // accountByCarrier without label — picks the unlabelled row
  var fed = await w.svc.accountByCarrier({ carrier: "fedex" });
  check("accountByCarrier unlabelled",     fed != null && fed.account_label == null);

  // accountByCarrier miss returns null
  var miss = await w.svc.accountByCarrier({ carrier: "dhl" });
  check("accountByCarrier miss = null",    miss === null);

  // listAccounts all
  var all = await w.svc.listAccounts();
  check("listAccounts total = 3",          all.length === 3);

  // listAccounts filtered by carrier
  var upsAll = await w.svc.listAccounts({ carrier: "ups" });
  check("listAccounts carrier=ups",        upsAll.length === 2 &&
                                           upsAll.every(function (r) { return r.carrier === "ups"; }));

  // Disable one and request active_only
  await w.svc.disableAccount({ account_id: ups.id, reason: "test disable" });
  var activeOnly = await w.svc.listAccounts({ active_only: true });
  check("listAccounts active_only",        activeOnly.length === 2 &&
                                           activeOnly.every(function (r) { return r.status === "active"; }));

  // active_only=false still includes the disabled row
  var withDisabled = await w.svc.listAccounts({ active_only: false });
  check("listAccounts active_only=false",  withDisabled.length === 3);

  // Refusals
  await assert.rejects(w.svc.accountByCarrier(),                                  /input object required/);
  await assert.rejects(w.svc.accountByCarrier({ carrier: "bogus" }),               /carrier/);
  await assert.rejects(w.svc.listAccounts({ carrier: "bogus" }),                   /carrier/);
  await assert.rejects(w.svc.listAccounts({ active_only: "yes" }),                 /active_only/);
}

async function run() {
  await _defineAccountAcrossCarriers();
  await _defineAccountUpsertReplacesSecrets();
  await _rotateCredentialsGrace();
  await _verifyCredentialsConstantTimeAndDisabled();
  await _disableEnableLifecycle();
  await _metricsForAccountSuccessRateAndLatency();
  await _accountByCarrierAndListFilters();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("carrier-accounts: " + helpers.getChecks() + " checks passed");
  }).catch(function (err) {
    console.error(err && err.stack || err);
    process.exit(1);
  });
}
