"use strict";
/**
 * smsDispatcher — outbound SMS layer with per-country provider
 * routing, consent state, and a delivery FSM with transient-retry
 * back-off.
 *
 * Layer 1 against in-memory node:sqlite. The primitive is a pure
 * state-machine over its own three tables; the test exercises every
 * surface (provider registration + routing, opt-in / opt-out /
 * STOP-keyword auto opt-out, enqueue refusal for non-transactional
 * sends to opted-out recipients, FSM transitions, dispatchTick
 * window, transient-failure retry with back-off, validation
 * refusals).
 *
 * Direct require of `lib/sms-dispatcher.js` — the primitive isn't
 * wired into `lib/index.js` yet (the entry-point edit is out of
 * scope for this gate; the test exists ahead of the wire, same
 * posture as dunning.test.js).
 *
 * Coverage:
 *   - registerProvider + providerForRegion: per-country routing
 *   - recordOptIn + isOptedIn (channel-scoped + any-channel)
 *   - recordOptOut narrows / broadens by channel
 *   - STOP / UNSUBSCRIBE / CANCEL keyword: opt-out across every
 *     channel + single confirmation queued
 *   - enqueue refuses marketing sends without an opt-in row
 *   - enqueue refuses any kind on explicit opt-out for that kind
 *   - enqueue refuses when no provider covers the country
 *   - enqueue refuses emoji-only / control-byte bodies
 *   - FSM transitions: queued → sent (dispatchTick), sent →
 *     delivered (markDelivered), sent → failed (markFailed),
 *     failed → queued (markFailed with retry: true), terminal
 *     refusals (delivered → failed, failed → delivered)
 *   - dispatchTick window: schedule_at <= now is due, > now is
 *     skipped
 *   - messagesForCustomer pagination
 *   - validation refusals: bad slug, bad country, bad kind,
 *     non-E.164 phone, mismatched phone_hash
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop = require("../../lib");
var sms   = require("../../lib/sms-dispatcher");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = [
  "0088_sms_dispatcher.sql",
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
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _uuid() { return bShop.framework.uuid.v7(); }

function _setup() {
  var q = _makeQuery();
  var dispatcher = sms.create({ query: q });
  return { query: q, sms: dispatcher };
}

// ---- provider routing --------------------------------------------------

async function _providerRouting() {
  var ctx = _setup();

  var twilio = await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US", "CA"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/test/Messages",
    active:       true,
  });
  check("registerProvider returns row",          typeof twilio === "object" && twilio != null);
  check("registerProvider persists slug",        twilio.slug === "twilio");
  check("registerProvider stores regions JSON",
    typeof twilio.regions_json === "string" &&
    JSON.parse(twilio.regions_json).indexOf("US") !== -1);
  check("registerProvider active flag",          Number(twilio.active) === 1);

  await ctx.sms.registerProvider({
    slug:         "messagebird",
    name:         "MessageBird",
    regions:      ["NL", "DE", "FR", "GB"],
    endpoint_url: "https://rest.messagebird.com/messages",
    active:       true,
  });

  // Inactive provider — should NOT be selected by providerForRegion.
  await ctx.sms.registerProvider({
    slug:         "plivo",
    name:         "Plivo",
    regions:      ["US", "AU"],
    endpoint_url: "https://api.plivo.com/v1/Account/test/Message/",
    active:       false,
  });

  var us = await ctx.sms.providerForRegion("US");
  check("providerForRegion US → twilio (oldest active)", us && us.slug === "twilio");
  var de = await ctx.sms.providerForRegion("DE");
  check("providerForRegion DE → messagebird",            de && de.slug === "messagebird");
  var au = await ctx.sms.providerForRegion("AU");
  check("providerForRegion AU → null (only inactive)",   au == null);
  var xx = await ctx.sms.providerForRegion("XX");
  check("providerForRegion unknown country → null",      xx == null);

  // Case-insensitive country input — operator might pass lowercase.
  var usLower = await ctx.sms.providerForRegion("us");
  check("providerForRegion case-insensitive",            usLower && usLower.slug === "twilio");

  // Re-register (upsert) updates the row.
  var reregistered = await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio (updated)",
    regions:      ["US", "CA", "GB"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/v2/Messages",
    active:       true,
  });
  check("registerProvider upserts name",
    reregistered.name === "Twilio (updated)");
  // After upsert: GB has TWO active providers (twilio + messagebird).
  // twilio is older (registered first); the upsert preserves
  // created_at so the tie-breaker (created_at ASC, then slug ASC)
  // resolves to twilio.
  var gb = await ctx.sms.providerForRegion("GB");
  check("providerForRegion GB tie-breaker → twilio (older registration)",
    gb && gb.slug === "twilio");
}

// ---- opt-in / opt-out --------------------------------------------------

async function _optInOptOut() {
  var ctx = _setup();
  var phone = "+15555550100";
  var phoneHash = ctx.sms.hashPhone(phone);
  var customerId = _uuid();

  var row = await ctx.sms.recordOptIn({
    customer_id:      customerId,
    phone_hash:       phoneHash,
    phone_normalized: phone,
    channel:          "marketing",
    opt_in_text:      "YES",
  });
  check("recordOptIn persists row",       typeof row === "object" && row != null);
  check("recordOptIn state is opt_in",    row.state === "opt_in");
  check("recordOptIn channel is marketing", row.channel === "marketing");
  check("recordOptIn customer_id stored", row.customer_id === customerId);
  check("recordOptIn opt_in_text stored", row.opt_in_text === "YES");

  // isOptedIn channel-scoped query
  var marketing = await ctx.sms.isOptedIn({ phone_hash: phoneHash, channel: "marketing" });
  check("isOptedIn marketing = true",  marketing === true);
  var trans = await ctx.sms.isOptedIn({ phone_hash: phoneHash, channel: "transactional" });
  check("isOptedIn transactional = false (no row)", trans === false);

  // No-channel query — any opt-in row qualifies.
  var anyChan = await ctx.sms.isOptedIn({ phone_hash: phoneHash });
  check("isOptedIn no-channel = true (any row)", anyChan === true);

  // Subsequent opt-in to the same channel upserts.
  var second = await ctx.sms.recordOptIn({
    customer_id:      customerId,
    phone_hash:       phoneHash,
    phone_normalized: phone,
    channel:          "marketing",
    opt_in_text:      "AGREE",
  });
  check("recordOptIn upsert preserves channel",  second.channel === "marketing");
  check("recordOptIn upsert updates opt_in_text", second.opt_in_text === "AGREE");

  // Channel-narrow opt-out.
  var out = await ctx.sms.recordOptOut({
    customer_id: customerId,
    phone_hash:  phoneHash,
    channel:     "marketing",
    reason:      "operator-initiated",
  });
  check("recordOptOut returns rows", Array.isArray(out) && out.length === 1);
  check("recordOptOut narrow flips marketing state", out[0].state === "opt_out");
  var marketing2 = await ctx.sms.isOptedIn({ phone_hash: phoneHash, channel: "marketing" });
  check("isOptedIn after opt-out → false", marketing2 === false);

  // No-channel opt-out applies to every channel.
  var phone2 = "+15555550200";
  var hash2 = ctx.sms.hashPhone(phone2);
  await ctx.sms.recordOptIn({
    phone_hash:       hash2,
    phone_normalized: phone2,
    channel:          "verification",
  });
  var broad = await ctx.sms.recordOptOut({
    phone_hash: hash2,
    reason:     "global-opt-out",
  });
  check("recordOptOut no-channel writes 3 rows", broad.length === 3);
  var verif = await ctx.sms.isOptedIn({ phone_hash: hash2, channel: "verification" });
  check("recordOptOut no-channel flips verification", verif === false);

  // Mismatched phone_hash → refuse.
  await assert.rejects(ctx.sms.recordOptIn({
    phone_hash:       ctx.sms.hashPhone("+15555550300"),
    phone_normalized: "+15555550400",
    channel:          "marketing",
  }), /does not match/);
}

// ---- STOP keyword auto opt-out ----------------------------------------

async function _stopKeywordAutoOptOut() {
  var ctx = _setup();
  await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/test/Messages",
    active:       true,
  });

  var phone = "+15555551000";
  var phoneHash = ctx.sms.hashPhone(phone);

  // Pre-existing opt-in across all channels.
  for (var i = 0; i < ctx.sms.CHANNELS.length; i += 1) {
    await ctx.sms.recordOptIn({
      phone_hash:       phoneHash,
      phone_normalized: phone,
      channel:          ctx.sms.CHANNELS[i],
    });
  }

  // Operator's inbound-webhook receives the user replying "STOP".
  var result = await ctx.sms.handleInboundKeyword({
    phone_hash:       phoneHash,
    phone_normalized: phone,
    body:             "STOP",
    country_code:     "US",
  });
  check("handleInboundKeyword matched",   result.matched === true);
  check("handleInboundKeyword wrote 3 channels", result.opt_state.length === 3);
  for (var j = 0; j < result.opt_state.length; j += 1) {
    check(
      "handleInboundKeyword flips channel " + result.opt_state[j].channel + " to opt_out",
      result.opt_state[j].state === "opt_out"
    );
  }

  // Confirmation message queued.
  check("handleInboundKeyword queues confirmation",
    typeof result.confirmation === "object" && result.confirmation != null);
  check("confirmation status is queued",   result.confirmation.status === "queued");
  check("confirmation kind is transactional", result.confirmation.kind === "transactional");
  check("confirmation provider stamped",   result.confirmation.provider_slug === "twilio");

  // Lowercase / whitespace variations also match.
  var phone2 = "+15555552000";
  var hash2 = ctx.sms.hashPhone(phone2);
  var r2 = await ctx.sms.handleInboundKeyword({
    phone_hash:       hash2,
    phone_normalized: phone2,
    body:             "  unsubscribe  ",
    country_code:     "US",
  });
  check("handleInboundKeyword matches lowercase + whitespace", r2.matched === true);

  // CANCEL also matches.
  var phone3 = "+15555553000";
  var hash3 = ctx.sms.hashPhone(phone3);
  var r3 = await ctx.sms.handleInboundKeyword({
    phone_hash:       hash3,
    phone_normalized: phone3,
    body:             "CANCEL",
    country_code:     "US",
  });
  check("handleInboundKeyword matches CANCEL", r3.matched === true);

  // Non-keyword body — no match.
  var phone4 = "+15555554000";
  var hash4 = ctx.sms.hashPhone(phone4);
  var r4 = await ctx.sms.handleInboundKeyword({
    phone_hash:       hash4,
    phone_normalized: phone4,
    body:             "What's the weather today?",
    country_code:     "US",
  });
  check("handleInboundKeyword non-keyword no match", r4.matched === false);
}

// ---- enqueue refusals + acceptance -------------------------------------

async function _enqueueGates() {
  var ctx = _setup();
  await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/test/Messages",
    active:       true,
  });

  var phone = "+15555550100";
  var phoneHash = ctx.sms.hashPhone(phone);
  var customerId = _uuid();

  // Marketing send without an opt-in row → refuse.
  await assert.rejects(ctx.sms.enqueue({
    recipient_customer_id: customerId,
    recipient_phone:       phone,
    country_code:          "US",
    body:                  "Sale: 50% off everything this weekend.",
    kind:                  "marketing",
  }), /not opted-in to marketing/);

  // After opt-in, the same enqueue succeeds.
  await ctx.sms.recordOptIn({
    customer_id:      customerId,
    phone_hash:       phoneHash,
    phone_normalized: phone,
    channel:          "marketing",
  });
  var marketingMsg = await ctx.sms.enqueue({
    recipient_customer_id: customerId,
    recipient_phone:       phone,
    country_code:          "US",
    body:                  "Sale: 50% off everything this weekend.",
    kind:                  "marketing",
  });
  check("enqueue marketing after opt-in",   marketingMsg.status === "queued");
  check("enqueue stamps provider_slug",     marketingMsg.provider_slug === "twilio");
  check("enqueue stamps phone_hash (not raw)", marketingMsg.recipient_phone_hash === phoneHash);
  check("enqueue stamps country_code",      marketingMsg.country_code === "US");
  check("enqueue stamps kind",              marketingMsg.kind === "marketing");

  // Transactional send without any opt-state — succeeds (opt-out
  // semantics: only explicit opt-out blocks transactional).
  var trans = await ctx.sms.enqueue({
    recipient_customer_id: customerId,
    recipient_phone:       phone,
    country_code:          "US",
    body:                  "Your order #1234 has shipped.",
    kind:                  "transactional",
  });
  check("enqueue transactional bypasses missing opt-in", trans.status === "queued");

  // After explicit transactional opt-out — refused.
  await ctx.sms.recordOptOut({
    phone_hash: phoneHash,
    channel:    "transactional",
    reason:     "operator-decision",
  });
  await assert.rejects(ctx.sms.enqueue({
    recipient_customer_id: customerId,
    recipient_phone:       phone,
    country_code:          "US",
    body:                  "Your order #1235 has shipped.",
    kind:                  "transactional",
  }), /opted-out of transactional/);

  // No provider for the country — refused.
  await assert.rejects(ctx.sms.enqueue({
    recipient_phone:  "+819012345678",
    country_code:     "JP",
    body:             "Order shipped.",
    kind:             "transactional",
  }), /no active provider covers JP/);

  // Body validation — emoji-only.
  await assert.rejects(ctx.sms.enqueue({
    recipient_phone:  phone,
    country_code:     "US",
    body:             "😀👍",
    kind:             "verification",
  }), /emoji-only/);

  // Body validation — control bytes.
  await assert.rejects(ctx.sms.enqueue({
    recipient_phone:  phone,
    country_code:     "US",
    body:             "Hello\x07World",
    kind:             "verification",
  }), /control bytes/);

  // Non-E.164 phone refused.
  await assert.rejects(ctx.sms.enqueue({
    recipient_phone:  "5555550100",
    country_code:     "US",
    body:             "Hello world.",
    kind:             "verification",
  }), /E\.164/);
}

// ---- FSM transitions ---------------------------------------------------

async function _fsmTransitions() {
  var ctx = _setup();
  await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/test/Messages",
    active:       true,
  });

  var phone = "+15555556000";
  var queued = await ctx.sms.enqueue({
    recipient_phone:  phone,
    country_code:     "US",
    body:             "Your verification code is 123456.",
    kind:             "verification",
  });
  check("FSM initial queued", queued.status === "queued");
  check("FSM attempts = 0",   Number(queued.attempts) === 0);

  // dispatchTick advances queued → sent.
  var advanced = await ctx.sms.dispatchTick({ now: Date.now() + 1000 });
  check("dispatchTick advances 1 row", advanced.length === 1);
  check("FSM queued → sent",            advanced[0].status === "sent");
  check("FSM sent_at stamped",          typeof advanced[0].sent_at === "number");
  check("FSM provider_slug retained",   advanced[0].provider_slug === "twilio");

  // markDelivered transitions sent → delivered.
  var delivered = await ctx.sms.markDelivered({
    message_id:   advanced[0].id,
    provider_ref: "SM_test_abc123",
  });
  check("FSM sent → delivered",          delivered.status === "delivered");
  check("FSM provider_ref stamped",      delivered.provider_ref === "SM_test_abc123");
  check("FSM delivered_at stamped",      typeof delivered.delivered_at === "number");

  // markDelivered idempotent on a delivered row.
  var replay = await ctx.sms.markDelivered({
    message_id:   advanced[0].id,
    provider_ref: "SM_test_abc123",
  });
  check("FSM markDelivered idempotent",  replay.status === "delivered");

  // markFailed on a delivered row → refuse (terminal).
  await assert.rejects(ctx.sms.markFailed({
    message_id: advanced[0].id,
    reason:     "carrier_reject",
    retry:      false,
  }), /terminal delivered/);

  // Transient failure path: enqueue → tick → markFailed(retry=true)
  // → row goes back to queued with next_retry_at in the future.
  var q2 = await ctx.sms.enqueue({
    recipient_phone:  "+15555556100",
    country_code:     "US",
    body:             "Order confirmation #5678.",
    kind:             "transactional",
  });
  await ctx.sms.dispatchTick({ now: Date.now() + 1000 });
  var failedTransient = await ctx.sms.markFailed({
    message_id: q2.id,
    reason:     "carrier_busy",
    retry:      true,
  });
  check("transient failure re-queues",        failedTransient.status === "queued");
  check("transient failure increments attempts", Number(failedTransient.attempts) === 1);
  check("transient failure stamps next_retry_at",
    typeof failedTransient.next_retry_at === "number" &&
    failedTransient.next_retry_at > Date.now());
  check("transient failure stamps reason",    failedTransient.failure_reason === "carrier_busy");

  // markDelivered after retry transition → refuse (sent_at is null
  // because we never re-sent yet; the operator's hook should drive
  // the actual provider call). Actually the FSM allows delivered
  // from queued for synchronous providers, so it should succeed —
  // but that's exercised separately below.

  // Hard-fail path: markFailed(retry=false) terminates.
  var q3 = await ctx.sms.enqueue({
    recipient_phone:  "+15555556200",
    country_code:     "US",
    body:             "Reset link: https://example.com/r/abc",
    kind:             "transactional",
  });
  await ctx.sms.dispatchTick({ now: Date.now() + 1000 });
  var hardFailed = await ctx.sms.markFailed({
    message_id: q3.id,
    reason:     "invalid_number",
    retry:      false,
  });
  check("hard failure terminates",            hardFailed.status === "failed");
  check("hard failure stamps failed_at",      typeof hardFailed.failed_at === "number");
  check("hard failure clears next_retry_at",  hardFailed.next_retry_at == null);

  // markDelivered on a terminal failed row → refuse.
  await assert.rejects(ctx.sms.markDelivered({
    message_id:   q3.id,
    provider_ref: "SM_late_delivery",
  }), /terminal failed/);

  // Synchronous-provider path: enqueue → markDelivered directly
  // (queued → delivered allowed without an intermediate sent).
  var q4 = await ctx.sms.enqueue({
    recipient_phone:  "+15555556300",
    country_code:     "US",
    body:             "Welcome aboard.",
    kind:             "transactional",
  });
  var syncDelivered = await ctx.sms.markDelivered({
    message_id:   q4.id,
    provider_ref: "SM_sync_xyz",
  });
  check("FSM queued → delivered (synchronous)", syncDelivered.status === "delivered");
  check("FSM sync sent_at backfilled",          typeof syncDelivered.sent_at === "number");
}

// ---- dispatchTick window + retry exhaustion ----------------------------

async function _dispatchTickWindow() {
  var ctx = _setup();
  await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/test/Messages",
    active:       true,
  });

  var phone = "+15555557000";
  var now = Date.now();

  // Two messages: one due, one scheduled in the future.
  var dueMsg = await ctx.sms.enqueue({
    recipient_phone:  phone,
    country_code:     "US",
    body:             "Due now.",
    kind:             "transactional",
    schedule_at:      now,
  });
  var laterMsg = await ctx.sms.enqueue({
    recipient_phone:  "+15555557100",
    country_code:     "US",
    body:             "Due later.",
    kind:             "transactional",
    schedule_at:      now + 60 * 60 * 1000,   // +1h
  });

  var firstTick = await ctx.sms.dispatchTick({ now: now + 1000 });
  check("dispatchTick picks only due rows", firstTick.length === 1);
  check("dispatchTick due row is the right one", firstTick[0].id === dueMsg.id);

  // Second tick BEFORE the future schedule → nothing advances.
  var nop = await ctx.sms.dispatchTick({ now: now + 60 * 1000 });
  check("dispatchTick skips future-scheduled rows", nop.length === 0);

  // Third tick AT the future schedule → it advances.
  var later = await ctx.sms.dispatchTick({ now: now + 60 * 60 * 1000 + 1000 });
  check("dispatchTick advances when due", later.length === 1);
  check("dispatchTick advances correct row",  later[0].id === laterMsg.id);

  // Retry exhaustion — repeatedly mark transient-failed past the
  // back-off schedule length. After RETRY_BACKOFF_MS.length attempts
  // the next transient request terminates the row.
  var q = await ctx.sms.enqueue({
    recipient_phone:  "+15555557200",
    country_code:     "US",
    body:             "Retry me.",
    kind:             "transactional",
  });
  await ctx.sms.dispatchTick({ now: now + 1000 });
  var attempts = ctx.sms.RETRY_BACKOFF_MS.length;
  var current = q;
  for (var i = 0; i < attempts; i += 1) {
    current = await ctx.sms.markFailed({
      message_id: q.id,
      reason:     "carrier_busy_" + i,
      retry:      true,
    });
    // Up through the back-off length, every retry re-queues; after
    // the budget is exhausted the row terminates as failed.
    if (i < attempts - 1) {
      check("retry attempt " + (i + 1) + " re-queues", current.status === "queued");
    } else {
      check("retry budget exhausted terminates", current.status === "failed");
    }
  }

  // messagesForCustomer pagination
  var customerId = _uuid();
  var phoneForList = "+15555558000";
  await ctx.sms.recordOptIn({
    customer_id:      customerId,
    phone_hash:       ctx.sms.hashPhone(phoneForList),
    phone_normalized: phoneForList,
    channel:          "marketing",
  });
  for (var k = 0; k < 5; k += 1) {
    await ctx.sms.enqueue({
      recipient_customer_id: customerId,
      recipient_phone:       phoneForList,
      country_code:          "US",
      body:                  "Notice " + k,
      kind:                  "marketing",
    });
  }
  var page1 = await ctx.sms.messagesForCustomer({
    customer_id: customerId,
    limit:       3,
  });
  check("messagesForCustomer page 1 limit", page1.rows.length === 3);
  check("messagesForCustomer next_cursor set", typeof page1.next_cursor === "number");
  var page2 = await ctx.sms.messagesForCustomer({
    customer_id: customerId,
    limit:       3,
    cursor:      page1.next_cursor,
  });
  check("messagesForCustomer page 2", page2.rows.length === 2);
  check("messagesForCustomer page 2 no more cursor", page2.next_cursor == null);
}

// ---- messageByProviderRef lookup --------------------------------------

async function _providerRefLookup() {
  var ctx = _setup();
  await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US"],
    endpoint_url: "https://api.twilio.com/2010-04-01/Accounts/test/Messages",
    active:       true,
  });
  var q = await ctx.sms.enqueue({
    recipient_phone:  "+15555559000",
    country_code:     "US",
    body:             "Lookup me.",
    kind:             "transactional",
  });
  await ctx.sms.dispatchTick({ now: Date.now() + 1000 });
  await ctx.sms.markDelivered({ message_id: q.id, provider_ref: "SM_lookup_target" });

  var found = await ctx.sms.messageByProviderRef({
    provider_slug: "twilio",
    provider_ref:  "SM_lookup_target",
  });
  check("messageByProviderRef finds row",    found && found.id === q.id);

  var missing = await ctx.sms.messageByProviderRef({
    provider_slug: "twilio",
    provider_ref:  "SM_not_here",
  });
  check("messageByProviderRef missing → null", missing == null);
}

// ---- validation refusals -----------------------------------------------

async function _validationRefusals() {
  var ctx = _setup();

  // Bad provider slug shape.
  await assert.rejects(ctx.sms.registerProvider({
    slug:         "Bad Slug",
    name:         "X",
    regions:      ["US"],
    endpoint_url: "https://example.com/sms",
    active:       true,
  }), /slug must match/);

  // Empty regions.
  await assert.rejects(ctx.sms.registerProvider({
    slug:         "empty",
    name:         "X",
    regions:      [],
    endpoint_url: "https://example.com/sms",
    active:       true,
  }), /regions must be a non-empty array/);

  // Non-https endpoint.
  await assert.rejects(ctx.sms.registerProvider({
    slug:         "insecure",
    name:         "X",
    regions:      ["US"],
    endpoint_url: "http://example.com/sms",
    active:       true,
  }), /https/);

  // Bad country code.
  await assert.rejects(ctx.sms.providerForRegion("United States"), /alpha-2/);

  // Bad kind.
  await ctx.sms.registerProvider({
    slug:         "twilio",
    name:         "Twilio",
    regions:      ["US"],
    endpoint_url: "https://example.com/sms",
    active:       true,
  });
  await assert.rejects(ctx.sms.enqueue({
    recipient_phone:  "+15555550100",
    country_code:     "US",
    body:             "Hello.",
    kind:             "promotional",
  }), /kind must be one of/);

  // Bad phone_hash length.
  await assert.rejects(ctx.sms.isOptedIn({
    phone_hash: "not-a-hash",
    channel:    "marketing",
  }), /phone_hash/);

  // Bad UUID on markDelivered.
  await assert.rejects(ctx.sms.markDelivered({
    message_id:   "not-a-uuid",
    provider_ref: "SM_x",
  }), /message_id/);

  // Bad batch_size on dispatchTick.
  await assert.rejects(ctx.sms.dispatchTick({
    now:        Date.now(),
    batch_size: 999999,
  }), /batch_size/);

  // No `now` on dispatchTick is allowed (defaults to Date.now()),
  // but a string `now` is refused.
  await assert.rejects(ctx.sms.dispatchTick({ now: "later" }),
    /must be a positive integer/);
}

// ---- driver ------------------------------------------------------------

(async function () {
  await _providerRouting();
  await _optInOptOut();
  await _stopKeywordAutoOptOut();
  await _enqueueGates();
  await _fsmTransitions();
  await _dispatchTickWindow();
  await _providerRefLookup();
  await _validationRefusals();

  console.log("sms-dispatcher: " + helpers.getChecks() + " checks passed");
})().catch(function (e) {
  console.error(e && e.stack || e);
  process.exit(1);
});
