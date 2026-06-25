"use strict";
/**
 * webhookReceiver — inbound HMAC-SHA-256 signed-event acceptor.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * 0110_webhook_receiver.sql. Exercises every shipped surface:
 *
 *   - defineSource happy path + secret returned exactly once
 *   - defineSource collision on duplicate slug
 *   - verifyAndPersist with a good signature persists, returns event_id
 *   - verifyAndPersist with a bad signature returns signature_invalid
 *   - verifyAndPersist with an expired timestamp returns
 *     timestamp_out_of_window
 *   - verifyAndPersist with a known idempotency_key returns replay
 *   - rotateSecret + 24h grace — old secret still verifies inside the
 *     window, refuses outside; new secret verifies immediately
 *   - markProcessed FSM (received -> processed; refuses non-received)
 *   - markFailed FSM with retry true / false (received -> failed;
 *     refuses non-received; fail_reason encodes retry hint)
 *   - body-size enforcement (oversize body throws WEBHOOK_BODY_TOO_LARGE)
 *   - unprocessedEvents queue feed + eventsForSource keyset pagination
 *   - purgeOlderThan sweeps terminal rows, preserves `received` rows
 *   - archiveSource refuses subsequent deliveries
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/webhook-receiver.js` directly so the gate exists ahead of the
 * entry-point edit.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var nodeCrypto = require("node:crypto");
var { DatabaseSync } = require("node:sqlite");

var bShop          = require("../../lib");
var webhookReceiver = require("../../lib/webhook-receiver");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0110_webhook_receiver.sql"
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

function _setup(nowHolder) {
  var h = _makeQuery();
  var opts = { query: h.query };
  if (nowHolder != null) {
    opts.now = function () { return nowHolder.value; };
  }
  var wr = webhookReceiver.create(opts);
  return { db: h.db, query: h.query, wr: wr };
}

// Sign a body the way a third-party would: HMAC-SHA-256 over
// `<ts>.<body>` keyed by the plaintext secret. We use node:crypto
// directly here because this is the test's adversary — the surface
// under test composes only blamejs primitives.
function _signThirdParty(secret, timestampSeconds, body) {
  var bodyStr = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
  return nodeCrypto.createHmac("sha256", secret)
    .update(timestampSeconds + "." + bodyStr, "utf8")
    .digest("hex");
}

async function _defineSourceHappyPath() {
  var s = _setup();

  var out = await s.wr.defineSource({
    slug:                   "stripe-prod",
    replay_window_seconds:  300,
    max_body_bytes:         65536,
    signature_header_name:  "Stripe-Signature",
    timestamp_header_name:  "Stripe-Timestamp",
    active:                 true,
  });
  check("defineSource returns slug",                  out.slug === "stripe-prod");
  check("defineSource returns 43-char plaintext",     out.secret_plaintext.length === 43);
  check("defineSource plaintext is base64url",        /^[A-Za-z0-9_\-]{43}$/.test(out.secret_plaintext));
  check("defineSource round-trips replay window",      out.replay_window_seconds === 300);
  check("defineSource round-trips max body bytes",     out.max_body_bytes === 65536);
  check("defineSource round-trips signature header",   out.signature_header_name === "Stripe-Signature");
  check("defineSource round-trips timestamp header",   out.timestamp_header_name === "Stripe-Timestamp");
  check("defineSource round-trips active",             out.active === true);

  var row = s.db.prepare("SELECT * FROM webhook_sources WHERE slug = ?").get("stripe-prod");
  check("source row inserted",                         !!row);
  check("plaintext NOT stored on row",                 row.signing_secret_hash !== out.secret_plaintext);
  check("signing_secret_hash is sha3-512 hex",         /^[0-9a-f]{128}$/.test(row.signing_secret_hash));
  check("previous hash is NULL on fresh source",       row.signing_secret_previous_hash === null);
  check("rotated_at is NULL on fresh source",          row.signing_secret_rotated_at === null);

  var fetched = await s.wr.getSource("stripe-prod");
  check("getSource projects the row",                  fetched.slug === "stripe-prod");
  check("getSource omits plaintext",                   fetched.secret_plaintext === undefined);
  check("getSource exposes hash",                      typeof fetched.signing_secret_hash === "string");

  // Defaults — caller omits everything optional.
  var defOut = await s.wr.defineSource({ slug: "default-source", active: true });
  check("default replay window applied",               defOut.replay_window_seconds === webhookReceiver.DEFAULT_REPLAY_WINDOW_SECONDS);
  check("default max body bytes applied",              defOut.max_body_bytes === webhookReceiver.DEFAULT_MAX_BODY_BYTES);
  check("default signature header applied",            defOut.signature_header_name === webhookReceiver.DEFAULT_SIGNATURE_HEADER_NAME);
  check("default timestamp header applied",            defOut.timestamp_header_name === webhookReceiver.DEFAULT_TIMESTAMP_HEADER_NAME);

  // Collision on duplicate slug.
  await assert.rejects(
    s.wr.defineSource({ slug: "stripe-prod", active: true }),
    function (e) { return e && e.code === "WEBHOOK_SOURCE_EXISTS"; }
  );

  // Validation refusals.
  await assert.rejects(s.wr.defineSource({ slug: "Bad-Slug", active: true }), /slug must match/);
  await assert.rejects(s.wr.defineSource({ slug: "ok", active: "yes" }),       /active must be a boolean/);
  await assert.rejects(s.wr.defineSource({ slug: "ok", active: true, replay_window_seconds: 10 }), /replay_window_seconds/);
  await assert.rejects(s.wr.defineSource({ slug: "ok", active: true, max_body_bytes: 1 }),         /max_body_bytes/);
  await assert.rejects(s.wr.defineSource({ slug: "ok", active: true, secret_plaintext: "too-short" }), /secret must be 43/);
}

async function _verifyAndPersistGoodSignature() {
  var s = _setup();
  var src = await s.wr.defineSource({ slug: "good-sig", active: true });
  var secret = src.secret_plaintext;

  var body = JSON.stringify({ event: "order.created", id: "evt_001" });
  var ts   = Math.floor(Date.now() / 1000);
  var sig  = _signThirdParty(secret, ts, body);

  var out = await s.wr.verifyAndPersist({
    source_slug:       "good-sig",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  sig,
    timestamp_header:  String(ts),
    idempotency_key:   "evt_001",
  });
  check("good sig ok",                                  out.ok === true);
  check("good sig returns event_id",                    typeof out.event_id === "string" && out.event_id.length >= 26);
  check("good sig not a replay",                        out.replay === false);
  check("good sig not signature_invalid",               out.signature_invalid === false);
  check("good sig not timestamp_out_of_window",         out.timestamp_out_of_window === false);

  var row = s.db.prepare("SELECT * FROM webhook_received_events WHERE id = ?").get(out.event_id);
  check("event persisted",                              !!row);
  check("event source_slug stored",                     row.source_slug === "good-sig");
  check("event idempotency_key stored",                 row.idempotency_key === "evt_001");
  check("event body_sha3_512 is hex",                    /^[0-9a-f]{128}$/.test(row.body_sha3_512));
  check("event body_size stored",                       Number(row.body_size) === Buffer.byteLength(body, "utf8"));
  check("event status is received",                     row.status === "received");
  check("event outcome is NULL initially",              row.outcome === null);
  check("event processed_at is NULL initially",          row.processed_at === null);
  check("event failed_at is NULL initially",             row.failed_at === null);

  // Body coercion paths — Buffer and Uint8Array work alongside strings.
  var bufBody = Buffer.from('{"event":"buf"}', "utf8");
  var ts2 = Math.floor(Date.now() / 1000);
  var sig2 = _signThirdParty(secret, ts2, bufBody);
  var out2 = await s.wr.verifyAndPersist({
    source_slug:       "good-sig",
    secret_plaintext:  secret,
    body:              bufBody,
    signature_header:  sig2,
    timestamp_header:  String(ts2),
    idempotency_key:   "evt_002",
  });
  check("buffer body verifies",                          out2.ok === true);

  var u8Body = new Uint8Array(Buffer.from('{"event":"u8"}', "utf8"));
  var ts3 = Math.floor(Date.now() / 1000);
  var sig3 = _signThirdParty(secret, ts3, Buffer.from(u8Body));
  var out3 = await s.wr.verifyAndPersist({
    source_slug:       "good-sig",
    secret_plaintext:  secret,
    body:              u8Body,
    signature_header:  sig3,
    timestamp_header:  String(ts3),
    idempotency_key:   "evt_003",
  });
  check("uint8array body verifies",                      out3.ok === true);
}

async function _verifyAndPersistBadSignature() {
  var s = _setup();
  var src = await s.wr.defineSource({ slug: "bad-sig", active: true });
  var secret = src.secret_plaintext;

  var body = '{"event":"x"}';
  var ts   = Math.floor(Date.now() / 1000);
  var realSig = _signThirdParty(secret, ts, body);
  // Flip one hex character — a tampered signature.
  var tamperedSig = (realSig[0] === "a" ? "b" : "a") + realSig.slice(1);

  var out = await s.wr.verifyAndPersist({
    source_slug:       "bad-sig",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  tamperedSig,
    timestamp_header:  String(ts),
  });
  check("tampered sig is signature_invalid",            out.signature_invalid === true);
  check("tampered sig ok=false",                        out.ok === false);
  check("tampered sig event_id is null",                out.event_id === null);

  // Wrong secret supplied (attacker doesn't have the plaintext).
  var wrongSecret = "X".repeat(43);
  var outWrong = await s.wr.verifyAndPersist({
    source_slug:       "bad-sig",
    secret_plaintext:  wrongSecret,
    body:              body,
    signature_header:  realSig,
    timestamp_header:  String(ts),
  });
  check("wrong secret is signature_invalid",            outWrong.signature_invalid === true);
  check("wrong secret ok=false",                        outWrong.ok === false);

  // Malformed hex signature (e.g. third-party emitted base64).
  var outBadHex = await s.wr.verifyAndPersist({
    source_slug:       "bad-sig",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  "not-a-hex-string",
    timestamp_header:  String(ts),
  });
  check("malformed sig is signature_invalid",           outBadHex.signature_invalid === true);

  // No row persisted under any refusal.
  var n = s.db.prepare("SELECT COUNT(*) AS n FROM webhook_received_events").get().n;
  check("refused deliveries persist 0 rows",            Number(n) === 0);
}

async function _verifyAndPersistExpiredTimestamp() {
  var nowHolder = { value: 1700000000000 };           // a fixed wall-clock
  var s = _setup(nowHolder);

  var src = await s.wr.defineSource({
    slug:                  "expired-ts",
    replay_window_seconds: 300,                       // 5 min tolerance
    active:                true,
  });
  var secret = src.secret_plaintext;

  // Stamp the third-party signature 10 minutes BEFORE the receiver's
  // wall-clock — outside the 5-minute tolerance window.
  var thirdPartyTs = Math.floor((nowHolder.value - 10 * 60 * 1000) / 1000);
  var body = '{"event":"old"}';
  var sig  = _signThirdParty(secret, thirdPartyTs, body);

  var out = await s.wr.verifyAndPersist({
    source_slug:       "expired-ts",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  sig,
    timestamp_header:  String(thirdPartyTs),
  });
  check("expired ts is timestamp_out_of_window",        out.timestamp_out_of_window === true);
  check("expired ts ok=false",                          out.ok === false);
  check("expired ts not signature_invalid",             out.signature_invalid === false);
  check("expired ts event_id is null",                  out.event_id === null);

  // Future-stamped (forward clock skew beyond the window) — same refusal.
  var futureTs = Math.floor((nowHolder.value + 10 * 60 * 1000) / 1000);
  var sigFuture = _signThirdParty(secret, futureTs, body);
  var outFuture = await s.wr.verifyAndPersist({
    source_slug:       "expired-ts",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  sigFuture,
    timestamp_header:  String(futureTs),
  });
  check("future-skewed ts is timestamp_out_of_window",  outFuture.timestamp_out_of_window === true);

  // Garbage timestamp header — refused (signature_invalid; we don't
  // distinguish from "wrong sig" to avoid leaking parser internals).
  var outGarbage = await s.wr.verifyAndPersist({
    source_slug:       "expired-ts",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  sig,
    timestamp_header:  "not-a-number",
  });
  check("non-numeric ts is signature_invalid",          outGarbage.signature_invalid === true);

  var n = s.db.prepare("SELECT COUNT(*) AS n FROM webhook_received_events").get().n;
  check("expired/future ts persist 0 rows",             Number(n) === 0);
}

async function _verifyAndPersistReplay() {
  var s = _setup();
  var src = await s.wr.defineSource({ slug: "replay-src", active: true });
  var secret = src.secret_plaintext;

  var body = '{"event":"order.shipped","id":"evt_777"}';
  var ts   = Math.floor(Date.now() / 1000);
  var sig  = _signThirdParty(secret, ts, body);

  var first = await s.wr.verifyAndPersist({
    source_slug:       "replay-src",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  sig,
    timestamp_header:  String(ts),
    idempotency_key:   "evt_777",
  });
  check("first delivery ok",                            first.ok === true && first.replay === false);

  // Second delivery with the same idempotency_key — should be a replay.
  var second = await s.wr.verifyAndPersist({
    source_slug:       "replay-src",
    secret_plaintext:  secret,
    body:              body,
    signature_header:  sig,
    timestamp_header:  String(ts),
    idempotency_key:   "evt_777",
  });
  check("replay ok=true",                               second.ok === true);
  check("replay flag is true",                          second.replay === true);
  check("replay event_id points at the original row",   second.event_id === first.event_id);

  // Only one row landed.
  var n = s.db.prepare("SELECT COUNT(*) AS n FROM webhook_received_events WHERE source_slug = ?")
    .get("replay-src").n;
  check("only one row persisted across the replay",     Number(n) === 1);

  // Without idempotency_key, two deliveries land as two rows (no
  // dedupe key to compare on).
  var bodyA = '{"event":"a"}';
  var tsA = Math.floor(Date.now() / 1000);
  var sigA = _signThirdParty(secret, tsA, bodyA);
  await s.wr.verifyAndPersist({
    source_slug: "replay-src", secret_plaintext: secret,
    body: bodyA, signature_header: sigA, timestamp_header: String(tsA),
  });
  await s.wr.verifyAndPersist({
    source_slug: "replay-src", secret_plaintext: secret,
    body: bodyA, signature_header: sigA, timestamp_header: String(tsA),
  });
  var nNoKey = s.db.prepare(
    "SELECT COUNT(*) AS n FROM webhook_received_events WHERE source_slug = ? AND idempotency_key IS NULL"
  ).get("replay-src").n;
  check("no-idempotency rows do not dedupe",            Number(nNoKey) === 2);
}

// Prod-redaction regression for the state-agnostic replay detection. The
// production D1 service-binding rewrites the SQLite "UNIQUE constraint failed"
// text to a bare "HTTP 500", so the old `e.message.indexOf("UNIQUE")` gate was
// blind in prod — a duplicate delivery would re-throw the 500 instead of
// collapsing to a replay. Wrap the query so EVERY error surfaces as a bare
// "HTTP 500" (exactly what the bridge does) and prove the unconditional
// re-read still returns the replay.
async function _verifyAndPersistReplayUnderRedactedError() {
  var h = _makeQuery();
  var redacting = async function (sql, params) {
    try { return await h.query(sql, params); }
    catch (_e) { throw new Error("HTTP 500"); }   // no "UNIQUE" text, like prod
  };
  var wr = webhookReceiver.create({ query: redacting });
  var src = await wr.defineSource({ slug: "redact-src", active: true });
  var secret = src.secret_plaintext;
  var body = '{"event":"order.shipped","id":"evt_redact"}';
  var ts   = Math.floor(Date.now() / 1000);
  var sig  = _signThirdParty(secret, ts, body);
  var input = {
    source_slug:      "redact-src", secret_plaintext: secret, body: body,
    signature_header: sig, timestamp_header: String(ts), idempotency_key: "evt_redact",
  };
  var first = await wr.verifyAndPersist(input);
  check("redacted-error: first delivery persists (not a replay)",
    first.ok === true && first.replay === false);
  // The duplicate INSERT throws a bare "HTTP 500"; the re-read still finds the
  // row and returns a replay (the old indexOf path would have re-thrown).
  var second = await wr.verifyAndPersist(input);
  check("redacted-error: duplicate collapses to a replay despite the bare HTTP 500",
    second.ok === true && second.replay === true && second.event_id === first.event_id);
  var n = h.db.prepare("SELECT COUNT(*) AS n FROM webhook_received_events WHERE source_slug = ?")
    .get("redact-src").n;
  check("redacted-error: only one row persisted", Number(n) === 1);
}

async function _rotateSecretGraceWindow() {
  var nowHolder = { value: 1700000000000 };
  var s = _setup(nowHolder);

  var src = await s.wr.defineSource({ slug: "rot", active: true });
  var oldSecret = src.secret_plaintext;

  var rot = await s.wr.rotateSecret("rot");
  check("rotateSecret returns slug",                    rot.slug === "rot");
  check("rotateSecret returns new plaintext",           typeof rot.secret_plaintext === "string" && rot.secret_plaintext.length === 43);
  check("rotateSecret plaintext differs from old",      rot.secret_plaintext !== oldSecret);
  check("rotateSecret carries 24h grace",               rot.rotation_grace_ms === 24 * 60 * 60 * 1000);
  var newSecret = rot.secret_plaintext;

  var row = s.db.prepare("SELECT * FROM webhook_sources WHERE slug = ?").get("rot");
  check("previous hash now populated",                  typeof row.signing_secret_previous_hash === "string" && row.signing_secret_previous_hash.length === 128);
  check("rotated_at populated",                          Number(row.signing_secret_rotated_at) === nowHolder.value);

  // Sign with the OLD secret — inside the grace window, this verifies.
  var bodyOld = '{"event":"old-signer"}';
  var tsOld   = Math.floor(nowHolder.value / 1000);
  var sigOld  = _signThirdParty(oldSecret, tsOld, bodyOld);
  var outOld = await s.wr.verifyAndPersist({
    source_slug:       "rot",
    secret_plaintext:  oldSecret,
    body:              bodyOld,
    signature_header:  sigOld,
    timestamp_header:  String(tsOld),
  });
  check("old secret verifies inside grace window",      outOld.ok === true);

  // Sign with the NEW secret — verifies immediately.
  var bodyNew = '{"event":"new-signer"}';
  var tsNew   = Math.floor(nowHolder.value / 1000);
  var sigNew  = _signThirdParty(newSecret, tsNew, bodyNew);
  var outNew = await s.wr.verifyAndPersist({
    source_slug:       "rot",
    secret_plaintext:  newSecret,
    body:              bodyNew,
    signature_header:  sigNew,
    timestamp_header:  String(tsNew),
  });
  check("new secret verifies immediately",              outNew.ok === true);

  // Advance the wall-clock past the grace window — the old secret
  // is refused even with a fresh timestamp signed under it.
  nowHolder.value = nowHolder.value + (25 * 60 * 60 * 1000);     // +25h
  var tsLate  = Math.floor(nowHolder.value / 1000);
  var sigLate = _signThirdParty(oldSecret, tsLate, bodyOld);
  var outLate = await s.wr.verifyAndPersist({
    source_slug:       "rot",
    secret_plaintext:  oldSecret,
    body:              bodyOld,
    signature_header:  sigLate,
    timestamp_header:  String(tsLate),
  });
  check("old secret refused outside grace window",      outLate.signature_invalid === true);
  check("old secret outside grace ok=false",            outLate.ok === false);

  // New secret still verifies past the grace window.
  var sigNew2 = _signThirdParty(newSecret, tsLate, bodyNew);
  var outNew2 = await s.wr.verifyAndPersist({
    source_slug:       "rot",
    secret_plaintext:  newSecret,
    body:              bodyNew,
    signature_header:  sigNew2,
    timestamp_header:  String(tsLate),
  });
  check("new secret still verifies past grace window",  outNew2.ok === true);
}

async function _markProcessedFsm() {
  var s = _setup();
  var src = await s.wr.defineSource({ slug: "fsm", active: true });
  var secret = src.secret_plaintext;

  var body = '{"event":"x"}';
  var ts = Math.floor(Date.now() / 1000);
  var sig = _signThirdParty(secret, ts, body);
  var rec = await s.wr.verifyAndPersist({
    source_slug: "fsm", secret_plaintext: secret,
    body: body, signature_header: sig, timestamp_header: String(ts),
    idempotency_key: "fsm-1",
  });

  var processed = await s.wr.markProcessed({ event_id: rec.event_id, outcome: "order-created" });
  check("markProcessed flips status",                   processed.status === "processed");
  check("markProcessed sets outcome",                   processed.outcome === "order-created");
  check("markProcessed stamps processed_at",            Number.isInteger(processed.processed_at) && processed.processed_at > 0);
  check("markProcessed leaves failed_at NULL",          processed.failed_at === null);
  check("markProcessed leaves fail_reason NULL",        processed.fail_reason === null);

  // Re-marking is refused (FSM is one-way received -> terminal).
  await assert.rejects(
    s.wr.markProcessed({ event_id: rec.event_id, outcome: "duplicate" }),
    function (e) { return e && e.code === "WEBHOOK_EVENT_NOT_RECEIVED"; }
  );

  // markFailed on a processed row is also refused.
  await assert.rejects(
    s.wr.markFailed({ event_id: rec.event_id, reason: "after-processed", retry: false }),
    function (e) { return e && e.code === "WEBHOOK_EVENT_NOT_RECEIVED"; }
  );

  // Validation refusals.
  await assert.rejects(s.wr.markProcessed({ event_id: rec.event_id, outcome: "" }),     /outcome must be non-empty/);
  await assert.rejects(s.wr.markProcessed({ event_id: "not-a-uuid", outcome: "ok" }),    /event_id/);

  // markFailed path on a fresh row — retry=true encodes the hint in
  // fail_reason; retry=false marks the dead-letter terminal state.
  var bodyR = '{"event":"retry"}';
  var tsR = Math.floor(Date.now() / 1000);
  var sigR = _signThirdParty(secret, tsR, bodyR);
  var recR = await s.wr.verifyAndPersist({
    source_slug: "fsm", secret_plaintext: secret,
    body: bodyR, signature_header: sigR, timestamp_header: String(tsR),
    idempotency_key: "fsm-2",
  });
  var failedRetry = await s.wr.markFailed({ event_id: recR.event_id, reason: "downstream-503", retry: true });
  check("markFailed flips status",                      failedRetry.status === "failed");
  check("markFailed stamps failed_at",                  Number.isInteger(failedRetry.failed_at) && failedRetry.failed_at > 0);
  check("markFailed encodes retry hint in fail_reason", failedRetry.fail_reason.indexOf("[retry] downstream-503") === 0);

  var bodyD = '{"event":"dead-letter"}';
  var tsD = Math.floor(Date.now() / 1000);
  var sigD = _signThirdParty(secret, tsD, bodyD);
  var recD = await s.wr.verifyAndPersist({
    source_slug: "fsm", secret_plaintext: secret,
    body: bodyD, signature_header: sigD, timestamp_header: String(tsD),
    idempotency_key: "fsm-3",
  });
  var failedDead = await s.wr.markFailed({ event_id: recD.event_id, reason: "permanent-fail", retry: false });
  check("dead-letter encoded in fail_reason",           failedDead.fail_reason.indexOf("[dead-letter] permanent-fail") === 0);

  // missing event
  await assert.rejects(
    s.wr.markProcessed({ event_id: bShop.framework.uuid.v7(), outcome: "ok" }),
    function (e) { return e && e.code === "WEBHOOK_EVENT_NOT_FOUND"; }
  );
  await assert.rejects(
    s.wr.markFailed({ event_id: bShop.framework.uuid.v7(), reason: "x", retry: false }),
    function (e) { return e && e.code === "WEBHOOK_EVENT_NOT_FOUND"; }
  );
}

async function _bodySizeEnforcement() {
  var s = _setup();
  var src = await s.wr.defineSource({
    slug:           "tiny",
    max_body_bytes: 256,
    active:         true,
  });
  var secret = src.secret_plaintext;

  // Within the limit — accepted.
  var smallBody = "x".repeat(200);
  var tsA = Math.floor(Date.now() / 1000);
  var sigA = _signThirdParty(secret, tsA, smallBody);
  var outOk = await s.wr.verifyAndPersist({
    source_slug:       "tiny",
    secret_plaintext:  secret,
    body:              smallBody,
    signature_header:  sigA,
    timestamp_header:  String(tsA),
  });
  check("body within limit accepted",                   outOk.ok === true);

  // Over the limit — throws WEBHOOK_BODY_TOO_LARGE.
  var bigBody = "y".repeat(300);
  var tsB = Math.floor(Date.now() / 1000);
  var sigB = _signThirdParty(secret, tsB, bigBody);
  await assert.rejects(
    s.wr.verifyAndPersist({
      source_slug:       "tiny",
      secret_plaintext:  secret,
      body:              bigBody,
      signature_header:  sigB,
      timestamp_header:  String(tsB),
    }),
    function (e) { return e && e.code === "WEBHOOK_BODY_TOO_LARGE"; }
  );

  // No row persisted for the refused oversize delivery.
  var n = s.db.prepare(
    "SELECT COUNT(*) AS n FROM webhook_received_events WHERE source_slug = ?"
  ).get("tiny").n;
  check("oversize body persists no row",                Number(n) === 1);
}

async function _queueAndPagination() {
  var nowHolder = { value: 1700000000000 };
  var s = _setup(nowHolder);
  var src = await s.wr.defineSource({ slug: "queue", active: true });
  var secret = src.secret_plaintext;

  // Persist 5 events with ascending received_at.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    nowHolder.value += 1000;
    var body = '{"i":' + i + '}';
    var ts = Math.floor(nowHolder.value / 1000);
    var sig = _signThirdParty(secret, ts, body);
    var out = await s.wr.verifyAndPersist({
      source_slug: "queue", secret_plaintext: secret,
      body: body, signature_header: sig, timestamp_header: String(ts),
      idempotency_key: "q-" + i,
    });
    ids.push(out.event_id);
  }

  var q = await s.wr.unprocessedEvents({ limit: 10 });
  check("unprocessedEvents returns all 5 received rows", q.length === 5);
  check("unprocessedEvents is oldest-first",             q[0].id === ids[0] && q[4].id === ids[4]);

  // Mark one processed — drops out of the unprocessed queue.
  await s.wr.markProcessed({ event_id: ids[0], outcome: "ok" });
  var q2 = await s.wr.unprocessedEvents({ limit: 10, source_slug: "queue" });
  check("processed row drops out of queue",              q2.length === 4 && q2.every(function (r) { return r.id !== ids[0]; }));

  // eventsForSource — DESC by time + keyset pagination.
  var page1 = await s.wr.eventsForSource({ source_slug: "queue", limit: 2 });
  check("eventsForSource page 1 newest-first",            page1.rows.length === 2 && page1.rows[0].id === ids[4]);
  check("eventsForSource page 1 has cursor",              typeof page1.next_cursor === "string");

  var page2 = await s.wr.eventsForSource({ source_slug: "queue", limit: 2, cursor: page1.next_cursor });
  check("eventsForSource page 2 continues",              page2.rows.length === 2 && page2.rows[0].id === ids[2]);

  var page3 = await s.wr.eventsForSource({ source_slug: "queue", limit: 2, cursor: page2.next_cursor });
  check("eventsForSource final page",                    page3.rows.length === 1 && page3.next_cursor === null);

  // getEvent — hit + miss.
  var got = await s.wr.getEvent(ids[2]);
  check("getEvent hit returns the row",                  got && got.id === ids[2]);
  var miss = await s.wr.getEvent(bShop.framework.uuid.v7());
  check("getEvent miss returns null",                    miss === null);

  // purgeOlderThan — advance the wall-clock 8 days, sweep terminal
  // rows older than 7 days. `received` rows must NOT be swept (an
  // unprocessed row past retention points at a broken worker — we
  // surface that by leaving the row in place).
  nowHolder.value += 8 * 24 * 60 * 60 * 1000;
  var purged = await s.wr.purgeOlderThan(7);
  check("purgeOlderThan reports swept count",            purged.purged >= 1);
  var receivedAfterPurge = s.db.prepare(
    "SELECT COUNT(*) AS n FROM webhook_received_events WHERE status = 'received'"
  ).get().n;
  check("received rows NOT swept by purge",              Number(receivedAfterPurge) === 4);
}

async function _archiveSource() {
  var s = _setup();
  var src = await s.wr.defineSource({ slug: "to-archive", active: true });
  var secret = src.secret_plaintext;

  var archived = await s.wr.archiveSource("to-archive");
  check("archiveSource sets archived_at",                Number.isInteger(archived.archived_at) && archived.archived_at > 0);
  check("archiveSource flips active to false",           archived.active === false);

  // Subsequent verifyAndPersist refuses with WEBHOOK_SOURCE_INACTIVE.
  var body = '{"event":"after-archive"}';
  var ts = Math.floor(Date.now() / 1000);
  var sig = _signThirdParty(secret, ts, body);
  await assert.rejects(
    s.wr.verifyAndPersist({
      source_slug: "to-archive", secret_plaintext: secret,
      body: body, signature_header: sig, timestamp_header: String(ts),
    }),
    function (e) { return e && e.code === "WEBHOOK_SOURCE_INACTIVE"; }
  );

  // Idempotent re-archive — returns the same shape.
  var again = await s.wr.archiveSource("to-archive");
  check("re-archive is idempotent",                      again.archived_at === archived.archived_at);

  // rotateSecret on an archived source is refused.
  await assert.rejects(
    s.wr.rotateSecret("to-archive"),
    function (e) { return e && e.code === "WEBHOOK_SOURCE_ARCHIVED"; }
  );

  // Unknown slug paths.
  await assert.rejects(
    s.wr.archiveSource("never-defined"),
    function (e) { return e && e.code === "WEBHOOK_SOURCE_NOT_FOUND"; }
  );
  await assert.rejects(
    s.wr.rotateSecret("never-defined"),
    function (e) { return e && e.code === "WEBHOOK_SOURCE_NOT_FOUND"; }
  );
}

// ---- idempotency-key validation ---------------------------------------
//
// The idempotency_key is a third-party-supplied opaque string used as the
// dedupe identity in `UNIQUE(source_slug, idempotency_key)`. It must
// refuse path-traversal shapes — `/`, `\`, `..` — which a loose
// printable-ASCII alphabet admitted. Strict validation permits a literal
// space (security-neutral) and leaves the bytes un-normalized.

async function _idempotencyKeyValidation() {
  var s = _setup();
  var src = await s.wr.defineSource({ slug: "idem-src", active: true });
  var secret = src.secret_plaintext;

  function _deliver(key) {
    var body = '{"event":"' + Date.now() + Math.random() + '"}';
    var ts = Math.floor(Date.now() / 1000);
    var sig = _signThirdParty(secret, ts, body);
    return s.wr.verifyAndPersist({
      source_slug:      "idem-src",
      secret_plaintext: secret,
      body:             body,
      signature_header: sig,
      timestamp_header: String(ts),
      idempotency_key:  key,
    });
  }

  // Path-traversal shapes are refused.
  await assert.rejects(_deliver("evt/../../etc/passwd"), /idempotency_key/);
  await assert.rejects(_deliver("a/b"),                  /idempotency_key/);
  await assert.rejects(_deliver("a\\b"),                 /idempotency_key/);
  await assert.rejects(_deliver(".."),                   /idempotency_key/);

  // Control bytes are refused.
  await assert.rejects(_deliver("evt\x00null"),          /idempotency_key/);

  // Over-length (>256 bytes) is refused.
  await assert.rejects(_deliver("x".repeat(257)),        /idempotency_key/);

  // A literal space is permitted (security-neutral for a stored key).
  var withSpace = await _deliver("evt with space");
  check("idempotency_key with a literal space is accepted", withSpace.ok === true);

  // A plain printable key still works.
  var plain = await _deliver("evt_clean_001");
  check("clean idempotency_key accepted", plain.ok === true);

  // null is still a valid passthrough (no dedupe key supplied).
  var none = await _deliver(null);
  check("null idempotency_key passes through", none.ok === true);
}

async function run() {
  await _defineSourceHappyPath();
  await _idempotencyKeyValidation();
  await _verifyAndPersistGoodSignature();
  await _verifyAndPersistBadSignature();
  await _verifyAndPersistExpiredTimestamp();
  await _verifyAndPersistReplay();
  await _verifyAndPersistReplayUnderRedactedError();
  await _rotateSecretGraceWindow();
  await _markProcessedFsm();
  await _bodySizeEnforcement();
  await _queueAndPagination();
  await _archiveSource();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("webhook-receiver.test.js: ok (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("webhook-receiver.test.js: FAIL\n" + (e && e.stack ? e.stack : e) + "\n");
    process.exit(1);
  });
}
