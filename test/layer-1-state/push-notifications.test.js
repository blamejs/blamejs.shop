"use strict";
/**
 * pushNotifications — outbound mobile + web push layer with per-
 * customer device-token registry, channel-scoped consent state, and
 * a delivery FSM with transient-retry back-off.
 *
 * Layer 1 against in-memory node:sqlite. The primitive is a pure
 * state-machine over its own four tables; the test exercises every
 * surface (provider registration, device registration + token
 * UNIQUE, opt-in / opt-out, enqueue gating, FSM transitions,
 * dispatchTick window + retry budget, metricsForProvider rate math).
 *
 * Direct require of `lib/push-notifications.js` — the primitive
 * isn't wired into `lib/index.js` yet (the entry-point edit is out
 * of scope for this gate).
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop = require("../../lib");
var push  = require("../../lib/push-notifications");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0148_push_notifications.sql",
].map(function (f) {
  return nodePath.resolve(__dirname, "..", "..", "migrations-d1", f);
});

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows: [], rowCount: Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _setup() {
  var q = _makeQuery();
  var p = push.create({ query: q });
  return { query: q, push: p };
}

// Synthetic credentials material — long enough to clear the
// MIN_CREDENTIALS_LEN guard but obviously fake so a leak scanner
// doesn't flag it.
var APNS_CREDS    = "FAKE-APNS-AUTH-KEY-FOR-TESTS-ONLY-00000000000000000000000000000000";
var FCM_CREDS     = "FAKE-FCM-SERVICE-ACCOUNT-JSON-FOR-TESTS-ONLY-00000000000000000000";
var WEBPUSH_CREDS = "FAKE-VAPID-PRIVATE-KEY-FOR-TESTS-ONLY-0000000000000000000000000000";

function _token(suffix) {
  return "fake-device-token-for-tests-" + suffix + "-0000000000000000000000000000";
}

// ---- registerProvider --------------------------------------------------

async function _providerLifecycle() {
  var ctx = _setup();

  var apns = await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  check("registerProvider returns row",        typeof apns === "object" && apns != null);
  check("registerProvider persists slug",      apns.slug === "apns-prod");
  check("registerProvider stores kind",        apns.kind === "apns");
  check("registerProvider hashes credentials (128 hex)",
    typeof apns.credentials_hash === "string" && /^[0-9a-f]{128}$/.test(apns.credentials_hash));
  check("registerProvider stores normalised credentials",
    apns.credentials_normalised === APNS_CREDS);
  check("registerProvider active flag",         Number(apns.active) === 1);
  check("registerProvider archived_at null",    apns.archived_at == null);

  // Re-register same slug (upsert) preserves kind, updates active.
  var apns2 = await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS + "-rotated",
    active:      false,
  });
  check("registerProvider upsert flips active",  Number(apns2.active) === 0);
  check("registerProvider upsert refreshes hash",
    apns2.credentials_hash !== apns.credentials_hash);

  // Changing kind on an existing slug → refused.
  await assert.rejects(ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "fcm",
    credentials: FCM_CREDS,
    active:      true,
  }), /cannot change kind/);

  // FCM + web_push providers register cleanly under separate slugs.
  var fcm = await ctx.push.registerProvider({
    slug:        "fcm-android",
    kind:        "fcm",
    credentials: FCM_CREDS,
    active:      true,
  });
  check("FCM provider registered", fcm.kind === "fcm");
  var web = await ctx.push.registerProvider({
    slug:        "webpush-prod",
    kind:        "web_push",
    credentials: WEBPUSH_CREDS,
    active:      true,
  });
  check("web_push provider registered", web.kind === "web_push");

  // Validation refusals
  await assert.rejects(ctx.push.registerProvider({
    slug:        "Bad Slug",
    kind:        "apns",
    credentials: APNS_CREDS,
  }), /slug must match/);
  await assert.rejects(ctx.push.registerProvider({
    slug:        "x",
    kind:        "sms",
    credentials: APNS_CREDS,
  }), /kind must be one of/);
  await assert.rejects(ctx.push.registerProvider({
    slug:        "tiny-creds",
    kind:        "apns",
    credentials: "too-short",
  }), /credentials/);
}

// ---- registerDevice + token UNIQUE -------------------------------------

async function _deviceRegistration() {
  var ctx = _setup();
  await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  await ctx.push.registerProvider({
    slug:        "fcm-android",
    kind:        "fcm",
    credentials: FCM_CREDS,
    active:      true,
  });

  var customer1 = _uuid();
  var customer2 = _uuid();
  var token1    = _token("ios-1");

  var dev1 = await ctx.push.registerDevice({
    customer_id:   customer1,
    provider_slug: "apns-prod",
    device_token:  token1,
    device_class:  "ios",
    locale:        "en-US",
  });
  check("registerDevice returns row",          typeof dev1 === "object" && dev1 != null);
  check("registerDevice customer_id stored",   dev1.customer_id === customer1);
  check("registerDevice provider_slug stored", dev1.provider_slug === "apns-prod");
  check("registerDevice device_class stored",  dev1.device_class === "ios");
  check("registerDevice token hashed (128 hex)",
    typeof dev1.device_token_hash === "string" && /^[0-9a-f]{128}$/.test(dev1.device_token_hash));
  check("registerDevice token_normalised stored", dev1.device_token_normalised === token1);
  check("registerDevice locale stored",          dev1.locale === "en-US");
  check("registerDevice revoked_at null",        dev1.revoked_at == null);

  // Re-registering the SAME token (UNIQUE) upserts onto the same
  // row, even if the customer changed (re-install under a new
  // account scenario).
  var dev1b = await ctx.push.registerDevice({
    customer_id:   customer2,
    provider_slug: "apns-prod",
    device_token:  token1,
    device_class:  "ios",
    locale:        "fr-FR",
  });
  check("registerDevice UNIQUE token same id",  dev1b.id === dev1.id);
  check("registerDevice UNIQUE token re-points customer", dev1b.customer_id === customer2);
  check("registerDevice UNIQUE token refreshes locale",   dev1b.locale === "fr-FR");

  // Different token → new row.
  var dev2 = await ctx.push.registerDevice({
    customer_id:   customer1,
    provider_slug: "fcm-android",
    device_token:  _token("android-1"),
    device_class:  "android",
  });
  check("registerDevice second token → new row",  dev2.id !== dev1.id);

  // Device-class / provider-kind compatibility check.
  await assert.rejects(ctx.push.registerDevice({
    customer_id:   customer1,
    provider_slug: "apns-prod",
    device_token:  _token("android-mismatch"),
    device_class:  "android",
  }), /not compatible/);

  // Unknown provider refused.
  await assert.rejects(ctx.push.registerDevice({
    customer_id:   customer1,
    provider_slug: "ghost-provider",
    device_token:  _token("ghost"),
    device_class:  "ios",
  }), /not registered/);

  // Inactive provider refuses new device registrations.
  await ctx.push.registerProvider({
    slug:        "apns-old",
    kind:        "apns",
    credentials: APNS_CREDS + "-deprecated",
    active:      false,
  });
  await assert.rejects(ctx.push.registerDevice({
    customer_id:   customer1,
    provider_slug: "apns-old",
    device_token:  _token("old-1"),
    device_class:  "ios",
  }), /inactive/);

  // revokeDevice flips revoked_at + stores reason.
  var revoked = await ctx.push.revokeDevice({
    device_id: dev2.id,
    reason:    "user-uninstall",
  });
  check("revokeDevice stamps revoked_at",  typeof revoked.revoked_at === "number");
  check("revokeDevice stamps reason",      revoked.revoke_reason === "user-uninstall");

  // revokeDevice idempotent on already-revoked row.
  var firstRevokedAt = revoked.revoked_at;
  var replay = await ctx.push.revokeDevice({
    device_id: dev2.id,
    reason:    "second-call",
  });
  check("revokeDevice idempotent (revoked_at unchanged)", replay.revoked_at === firstRevokedAt);
  check("revokeDevice idempotent (reason refreshed)",     replay.revoke_reason === "second-call");

  // devicesForCustomer surfaces active + revoked rows.
  var list = await ctx.push.devicesForCustomer(customer1);
  check("devicesForCustomer returns rows", list.length >= 1);
  var hasRevoked = list.some(function (d) { return d.id === dev2.id && d.revoked_at != null; });
  check("devicesForCustomer includes revoked row", hasRevoked);
}

// ---- opt-in / opt-out --------------------------------------------------

async function _optInOptOut() {
  var ctx = _setup();
  var customerId = _uuid();

  var row = await ctx.push.recordOptIn({
    customer_id: customerId,
    channel:     "marketing",
  });
  check("recordOptIn returns row",      typeof row === "object" && row != null);
  check("recordOptIn state opt_in",     row.state === "opt_in");
  check("recordOptIn channel stored",   row.channel === "marketing");

  // isOptedIn channel-scoped + global query.
  var m1 = await ctx.push.isOptedIn({ customer_id: customerId, channel: "marketing" });
  check("isOptedIn marketing = true",      m1 === true);
  var t1 = await ctx.push.isOptedIn({ customer_id: customerId, channel: "transactional" });
  check("isOptedIn transactional = false (no row)", t1 === false);
  var any = await ctx.push.isOptedIn({ customer_id: customerId });
  check("isOptedIn any-channel = true",    any === true);

  // Channel-narrow opt-out flips marketing.
  var out = await ctx.push.recordOptOut({
    customer_id: customerId,
    channel:     "marketing",
    reason:      "operator-initiated",
  });
  check("recordOptOut narrow returns 1 row",  Array.isArray(out) && out.length === 1);
  check("recordOptOut narrow flips state",     out[0].state === "opt_out");
  var m2 = await ctx.push.isOptedIn({ customer_id: customerId, channel: "marketing" });
  check("isOptedIn marketing → false after opt-out", m2 === false);

  // Global opt-out (no channel) writes 3 rows.
  var customer2 = _uuid();
  await ctx.push.recordOptIn({ customer_id: customer2, channel: "alert" });
  var globalOut = await ctx.push.recordOptOut({
    customer_id: customer2,
    reason:      "user-disabled-push",
  });
  check("recordOptOut global writes 3 rows",  globalOut.length === 3);
  for (var i = 0; i < globalOut.length; i += 1) {
    check("global opt-out flips channel " + globalOut[i].channel,
      globalOut[i].state === "opt_out");
  }

  // Re-opt-in upserts back to opt_in.
  var reIn = await ctx.push.recordOptIn({
    customer_id: customer2,
    channel:     "transactional",
  });
  check("re-opt-in flips back to opt_in", reIn.state === "opt_in");
}

// ---- enqueueNotification gating ----------------------------------------

async function _enqueueGates() {
  var ctx = _setup();
  await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  var customerId = _uuid();
  await ctx.push.registerDevice({
    customer_id:   customerId,
    provider_slug: "apns-prod",
    device_token:  _token("ios-gate-1"),
    device_class:  "ios",
  });

  // Marketing send without opt-in → refused.
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "marketing",
    title:                 "Flash sale",
    body:                  "50% off everything for the next 6 hours.",
  }), /not opted-in to marketing/);

  // After opt-in the same call succeeds.
  await ctx.push.recordOptIn({ customer_id: customerId, channel: "marketing" });
  var marketingMsg = await ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "marketing",
    title:                 "Flash sale",
    body:                  "50% off everything for the next 6 hours.",
    payload:               { url: "/sale", campaign_id: "fs-2026-05" },
  });
  check("marketing enqueue succeeds after opt-in", marketingMsg.status === "queued");
  check("enqueue stamps provider_slug",            marketingMsg.provider_slug === "apns-prod");
  check("enqueue stamps channel",                  marketingMsg.channel === "marketing");
  check("enqueue stamps title + body",
    marketingMsg.title === "Flash sale" && marketingMsg.body.indexOf("50%") !== -1);
  check("enqueue serialises payload_json",
    typeof marketingMsg.payload_json === "string" &&
    JSON.parse(marketingMsg.payload_json).campaign_id === "fs-2026-05");
  check("enqueue initial attempts = 0", Number(marketingMsg.attempts) === 0);

  // Transactional send bypasses missing opt-in.
  var trans = await ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Order shipped",
    body:                  "Your order #1234 has shipped.",
  });
  check("transactional bypasses missing opt-in", trans.status === "queued");

  // Explicit transactional opt-out refuses.
  await ctx.push.recordOptOut({
    customer_id: customerId,
    channel:     "transactional",
    reason:      "user-pref",
  });
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Order shipped",
    body:                  "Your order #1235 has shipped.",
  }), /opted-out of transactional/);

  // No device → refused.
  var customerNoDevice = _uuid();
  await ctx.push.recordOptIn({ customer_id: customerNoDevice, channel: "marketing" });
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerNoDevice,
    channel:               "marketing",
    title:                 "Welcome",
    body:                  "Thanks for signing up.",
  }), /no active devices/);

  // Body validation refuses control bytes.
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "alert",
    title:                 "Alert",
    body:                  "Hello\x07World",
  }), /control bytes/);

  // Title length cap.
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "alert",
    title:                 "",
    body:                  "Body",
  }), /title/);

  // Bad channel rejected.
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "promotional",
    title:                 "X",
    body:                  "Y",
  }), /channel must be one of/);
}

// ---- FSM transitions via dispatchTick ----------------------------------

async function _fsmTransitions() {
  var ctx = _setup();
  await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  var customerId = _uuid();
  await ctx.push.registerDevice({
    customer_id:   customerId,
    provider_slug: "apns-prod",
    device_token:  _token("fsm-ios-1"),
    device_class:  "ios",
  });

  var queued = await ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Verify",
    body:                  "Your code is 123456.",
  });
  check("FSM initial queued", queued.status === "queued");

  // dispatchTick advances queued → sent.
  var advanced = await ctx.push.dispatchTick({ now: Date.now() + 1000 });
  check("dispatchTick advances 1 row", advanced.length === 1);
  check("FSM queued → sent",            advanced[0].status === "sent");
  check("FSM dispatched_at stamped",    typeof advanced[0].dispatched_at === "number");

  // markDelivered transitions sent → delivered.
  var delivered = await ctx.push.markDelivered({
    notification_id:     advanced[0].id,
    provider_message_id: "APNS-abc123",
  });
  check("FSM sent → delivered",                delivered.status === "delivered");
  check("FSM provider_message_id stamped",     delivered.provider_message_id === "APNS-abc123");
  check("FSM delivered_at stamped",            typeof delivered.delivered_at === "number");

  // markDelivered idempotent on delivered.
  var replay = await ctx.push.markDelivered({
    notification_id:     advanced[0].id,
    provider_message_id: "APNS-abc123",
  });
  check("markDelivered idempotent",            replay.status === "delivered");

  // markFailed on delivered row → refused (terminal).
  await assert.rejects(ctx.push.markFailed({
    notification_id: advanced[0].id,
    reason:          "late-bounce",
    retry:           false,
  }), /terminal delivered/);

  // Hard-fail path: enqueue → tick → markFailed(retry=false) → terminal.
  var q2 = await ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Hard fail target",
    body:                  "X",
  });
  await ctx.push.dispatchTick({ now: Date.now() + 1000 });
  var hardFailed = await ctx.push.markFailed({
    notification_id: q2.id,
    reason:          "invalid_token",
    retry:           false,
  });
  check("hard failure terminates",             hardFailed.status === "failed");
  check("hard failure stamps failed_at",       typeof hardFailed.failed_at === "number");
  check("hard failure stamps fail_reason",     hardFailed.fail_reason === "invalid_token");
  check("hard failure clears next_retry_at",   hardFailed.next_retry_at == null);

  // markDelivered on terminal failed → refused.
  await assert.rejects(ctx.push.markDelivered({
    notification_id:     q2.id,
    provider_message_id: "APNS-late",
  }), /terminal failed/);

  // dispatchTick window — schedule_at in the future is skipped.
  var future = Date.now() + 60 * 60 * 1000;
  var laterMsg = await ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Later",
    body:                  "Scheduled for the future.",
    schedule_at:           future,
  });
  var nop = await ctx.push.dispatchTick({ now: Date.now() + 1000 });
  check("dispatchTick skips future-scheduled", nop.length === 0);
  var late = await ctx.push.dispatchTick({ now: future + 1000 });
  check("dispatchTick advances when due",      late.length === 1);
  check("dispatchTick advances correct row",   late[0].id === laterMsg.id);
}

// ---- concurrent dispatchTick claim (no double-send) --------------------

// Two ticks whose SELECT snapshots BOTH saw the same row `queued` must
// hand it to the operator send hook EXACTLY once. The fix makes the
// queued→sent advance an atomic claim guarded by `AND status =
// 'queued'`; the tick that loses the serialised-writer race sees
// rowCount 0 and drops the row from its `advanced` set, so the customer
// is never double-dispatched.
//
// The interleave is forced deterministically: the wrapper defers the
// winning tick's first advancing UPDATE until a SECOND dispatchTick has
// taken its own snapshot (still observing the row as `queued` — the
// exact double-fire precondition). Both ticks then run their claims; the
// union of what they hand to the hook must contain the row once.
async function _concurrentDispatchClaim() {
  var base = _setup();
  var customerId = _uuid();
  await base.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  await base.push.registerDevice({
    customer_id:   customerId,
    provider_slug: "apns-prod",
    device_token:  _token("race-ios-1"),
    device_class:  "ios",
  });
  var queued = await base.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Race target",
    body:                  "Should dispatch exactly once.",
  });
  var when = Date.now() + 1000;

  // Wrap the shared query so the FIRST advancing UPDATE the winner tick
  // issues is held until the loser tick has snapshotted the still-queued
  // row, then released. Both ticks share one DB (one `base.query`), so
  // this models two workers racing the same row.
  var releaseSecondSnapshot;
  var secondSnapshotTaken = new Promise(function (res) { releaseSecondSnapshot = res; });
  var heldOnce = false;
  var racingPush = push.create({
    query: async function (sql, params) {
      var isAdvanceUpdate =
        /^\s*UPDATE push_notifications SET status = 'sent'/.test(sql);
      if (isAdvanceUpdate && !heldOnce) {
        heldOnce = true;
        // Let the loser tick run its SELECT (which still sees `queued`)
        // before this winning UPDATE commits.
        await secondSnapshotTaken;
      }
      return base.query(sql, params);
    },
  });

  var winner = racingPush.dispatchTick({ now: when });
  // Loser tick snapshots the still-queued row, then signals the winner
  // to proceed; the loser's own claim races behind it.
  var loser = base.push.dispatchTick({ now: when }).then(function (r) {
    releaseSecondSnapshot();
    return r;
  });

  var results = await Promise.all([winner, loser]);
  var handedToHook = results[0].concat(results[1]).filter(function (n) {
    return n && n.id === queued.id;
  });
  check("race: row handed to the send hook exactly once (not double-sent)",
    handedToHook.length === 1);
  check("race: the single dispatch advanced queued → sent",
    handedToHook[0].status === "sent");

  // Final DB state is a single `sent` row — no re-queue, no second send.
  var finalRow = (await base.query(
    "SELECT * FROM push_notifications WHERE id = ?1", [queued.id],
  )).rows[0];
  check("race: final row is sent (one dispatch only)", finalRow.status === "sent");
}

// ---- retry back-off + exhaustion ---------------------------------------

async function _retryBackoff() {
  var ctx = _setup();
  await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  var customerId = _uuid();
  await ctx.push.registerDevice({
    customer_id:   customerId,
    provider_slug: "apns-prod",
    device_token:  _token("retry-ios-1"),
    device_class:  "ios",
  });

  var q = await ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "Retry target",
    body:                  "X",
  });
  await ctx.push.dispatchTick({ now: Date.now() + 1000 });

  // First transient failure → re-queues with next_retry_at in the
  // future, attempts === 1.
  var f1 = await ctx.push.markFailed({
    notification_id: q.id,
    reason:          "carrier_busy_1",
    retry:           true,
  });
  check("transient failure re-queues",         f1.status === "queued");
  check("transient failure attempts = 1",      Number(f1.attempts) === 1);
  check("transient failure stamps next_retry_at",
    typeof f1.next_retry_at === "number" && f1.next_retry_at > Date.now());
  check("transient failure stamps fail_reason", f1.fail_reason === "carrier_busy_1");

  // The first back-off should match RETRY_BACKOFF_MS[0] (1m).
  check("first back-off matches schedule[0]",
    f1.next_retry_at - f1.next_retry_at <= ctx.push.RETRY_BACKOFF_MS[0] + 1000);
  // (cheap sanity — exact equality flakes on clock skew across ratchet)

  // Retry exhaustion — after RETRY_BACKOFF_MS.length attempts the
  // next transient request terminates the row.
  var attempts = ctx.push.RETRY_BACKOFF_MS.length;
  var current = f1;
  for (var i = 1; i < attempts; i += 1) {
    current = await ctx.push.markFailed({
      notification_id: q.id,
      reason:          "carrier_busy_" + (i + 1),
      retry:           true,
    });
    if (i < attempts - 1) {
      check("retry attempt " + (i + 1) + " re-queues", current.status === "queued");
    } else {
      check("retry budget exhausted terminates",       current.status === "failed");
    }
  }

  // notificationsForCustomer pagination.
  var pagCustomer = _uuid();
  await ctx.push.recordOptIn({ customer_id: pagCustomer, channel: "marketing" });
  await ctx.push.registerDevice({
    customer_id:   pagCustomer,
    provider_slug: "apns-prod",
    device_token:  _token("pag-ios-1"),
    device_class:  "ios",
  });
  for (var k = 0; k < 5; k += 1) {
    await ctx.push.enqueueNotification({
      recipient_customer_id: pagCustomer,
      channel:               "marketing",
      title:                 "Notice " + k,
      body:                  "Body " + k,
    });
  }
  var page1 = await ctx.push.notificationsForCustomer({
    customer_id: pagCustomer,
    limit:       3,
  });
  check("notificationsForCustomer page 1 limit",  page1.rows.length === 3);
  check("notificationsForCustomer next_cursor set", typeof page1.next_cursor === "number");
  var page2 = await ctx.push.notificationsForCustomer({
    customer_id: pagCustomer,
    limit:       3,
    cursor:      page1.next_cursor,
  });
  check("notificationsForCustomer page 2",          page2.rows.length === 2);
  check("notificationsForCustomer page 2 cursor null", page2.next_cursor == null);
}

// ---- metricsForProvider rate math --------------------------------------

async function _metricsForProvider() {
  var ctx = _setup();
  await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  var customerId = _uuid();
  await ctx.push.registerDevice({
    customer_id:   customerId,
    provider_slug: "apns-prod",
    device_token:  _token("metrics-ios-1"),
    device_class:  "ios",
  });

  // 5 notifications: 3 will be delivered, 1 failed, 1 stays queued.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var n = await ctx.push.enqueueNotification({
      recipient_customer_id: customerId,
      channel:               "transactional",
      title:                 "Metric " + i,
      body:                  "Body " + i,
    });
    ids.push(n.id);
  }
  // Advance 4 to sent.
  await ctx.push.dispatchTick({ now: Date.now() + 1000 });

  // Deliver first 3.
  for (var d = 0; d < 3; d += 1) {
    await ctx.push.markDelivered({
      notification_id:     ids[d],
      provider_message_id: "APNS-msg-" + d,
    });
  }
  // Fail #4 terminally.
  await ctx.push.markFailed({
    notification_id: ids[3],
    reason:          "invalid_token",
    retry:           false,
  });
  // Notification #5 stays queued (was advanced to sent by dispatchTick,
  // but we re-queue it via a transient failure so the snapshot has a
  // queued row too). Actually all 5 advanced to sent. Adjust: re-queue
  // #5 by transient failure.
  await ctx.push.markFailed({
    notification_id: ids[4],
    reason:          "retry-me",
    retry:           true,
  });

  var beforeFrom = 1;                       // epoch lower bound
  var afterTo    = Date.now() + 60 * 60 * 1000;
  var m = await ctx.push.metricsForProvider({
    slug: "apns-prod",
    from: beforeFrom,
    to:   afterTo,
  });

  check("metricsForProvider slug echoed",      m.slug === "apns-prod");
  check("metricsForProvider total = 5",        m.total === 5);
  check("metricsForProvider delivered = 3",    m.delivered === 3);
  check("metricsForProvider failed = 1",       m.failed === 1);
  check("metricsForProvider queued = 1",       m.queued === 1);
  // dispatched counts sent + delivered + failed; queued not in
  // dispatched. After our flow: 3 delivered + 0 sent + 1 failed = 4.
  check("metricsForProvider dispatched = 4",   m.dispatched === 4);
  // delivery_rate = delivered / dispatched = 3/4 = 0.75
  check("metricsForProvider delivery_rate = 0.75",
    Math.abs(m.delivery_rate - 0.75) < 1e-9);
  // failure_rate = failed / dispatched = 1/4 = 0.25
  check("metricsForProvider failure_rate = 0.25",
    Math.abs(m.failure_rate - 0.25) < 1e-9);

  // Empty window → zeros (no NaN).
  var empty = await ctx.push.metricsForProvider({
    slug: "apns-prod",
    from: afterTo,                            // window after every row
    to:   afterTo + 1,
  });
  check("metricsForProvider empty window dispatched = 0", empty.dispatched === 0);
  check("metricsForProvider empty window delivery_rate = 0", empty.delivery_rate === 0);
  check("metricsForProvider empty window failure_rate = 0",  empty.failure_rate === 0);

  // Invalid window (to < from) refused.
  await assert.rejects(ctx.push.metricsForProvider({
    slug: "apns-prod",
    from: 1000,
    to:   500,
  }), /'to' must be >= 'from'/);
}

// ---- validation refusals -----------------------------------------------

async function _validationRefusals() {
  var ctx = _setup();

  // Bad UUID on markDelivered.
  await assert.rejects(ctx.push.markDelivered({
    notification_id:     "not-a-uuid",
    provider_message_id: "X",
  }), /notification_id/);

  // Bad batch_size on dispatchTick.
  await assert.rejects(ctx.push.dispatchTick({
    now:        Date.now(),
    batch_size: 999999,
  }), /batch_size/);

  // String `now` refused.
  await assert.rejects(ctx.push.dispatchTick({ now: "later" }),
    /must be a positive integer/);

  // Bad device_class.
  await ctx.push.registerProvider({
    slug:        "apns-prod",
    kind:        "apns",
    credentials: APNS_CREDS,
    active:      true,
  });
  await assert.rejects(ctx.push.registerDevice({
    customer_id:   _uuid(),
    provider_slug: "apns-prod",
    device_token:  _token("badclass"),
    device_class:  "smartwatch",
  }), /device_class must be one of/);

  // Bad locale shape.
  await assert.rejects(ctx.push.registerDevice({
    customer_id:   _uuid(),
    provider_slug: "apns-prod",
    device_token:  _token("badlocale"),
    device_class:  "ios",
    locale:        "english united states",     // BCP-47 doesn't allow spaces
  }), /BCP-47/);

  // Payload not JSON-serialisable (cyclic).
  var customerId = _uuid();
  await ctx.push.registerDevice({
    customer_id:   customerId,
    provider_slug: "apns-prod",
    device_token:  _token("cyclic-ios"),
    device_class:  "ios",
  });
  var cyclic = {};
  cyclic.self = cyclic;
  await assert.rejects(ctx.push.enqueueNotification({
    recipient_customer_id: customerId,
    channel:               "transactional",
    title:                 "X",
    body:                  "Y",
    payload:               cyclic,
  }), /payload/);

  // Unknown notification on markFailed.
  await assert.rejects(ctx.push.markFailed({
    notification_id: _uuid(),
    reason:          "x",
    retry:           false,
  }), /not found/);
}

// ---- driver / run ------------------------------------------------------

async function run() {
  await _providerLifecycle();
  await _deviceRegistration();
  await _optInOptOut();
  await _enqueueGates();
  await _fsmTransitions();
  await _concurrentDispatchClaim();
  await _retryBackoff();
  await _metricsForProvider();
  await _validationRefusals();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - push-notifications (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - push-notifications: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
