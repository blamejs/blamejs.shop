"use strict";
/**
 * pixelEvents — server-side conversion-tracking pixel/event API
 * integration.
 *
 * Layer 1 against in-memory node:sqlite loaded from
 * 0123_pixel_events.sql alone — the primitive has no FKs into the
 * rest of the schema, so the test runs against a minimal in-memory
 * database with just the two pixel tables.
 *
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/pixel-events.js` directly so the gate exists ahead of the
 * entry-point edit.
 *
 * Coverage:
 *   - registerProvider happy path + duplicate-slug update + provider
 *     swap refusal + bad-shape refusals.
 *   - recordEvent hashes customer_email + customer_phone via SHA-256
 *     of the normalised value; idempotent on (provider_slug, event_id)
 *     replay.
 *   - recordEvent refusals: bad event_name / event_id / occurred_at /
 *     missing provider / mismatched value+currency.
 *   - dispatchTick batches queued rows in occurred_at order; filters
 *     out events whose provider is inactive; respects batch_size.
 *   - markDispatched / markFailed FSM transitions + retry back-off +
 *     terminal refusals.
 *   - eventsForOrder returns the matching events in occurred_at order.
 *   - metricsForProvider rolls up by event_name + status across the
 *     requested period.
 *   - dispatchedInPeriod range scan + failedEvents listing.
 *   - PII hashing helpers normalise email (lowercase + trim) and
 *     phone (strip non-digits) before the SHA-256 digest.
 */

var nodeFs     = require("node:fs");
var nodePath   = require("node:path");
var nodeCrypto = require("node:crypto");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var pixelEvents = require("../../lib/pixel-events");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0123_pixel_events.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _setup() {
  var query = _makeQuery();
  var pe    = pixelEvents.create({ query: query });
  return { query: query, pe: pe };
}

function _sha256(s) {
  return nodeCrypto.createHash("sha256").update(s, "utf8").digest("hex");
}

function _uuidv7() {
  return bShop.framework.uuid.v7();
}

function _validProvider(over) {
  over = over || {};
  var base = {
    slug:           "meta",
    provider:       "meta_capi",
    pixel_id:       "1234567890",
    access_token:   "EAAB-abcdef-redacted-XYZ",
    conversion_url: "https://graph.facebook.com/v18.0/1234567890/events",
    active:         true,
  };
  var k;
  for (k in over) {
    if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
  }
  return base;
}

function _validEvent(over) {
  over = over || {};
  var base = {
    provider_slug:    "meta",
    event_name:       "purchase",
    event_id:         "order_8819_purchase",
    occurred_at:      Date.UTC(2026, 4, 22, 12, 0, 0),
    customer_email:   "Alice@Example.COM",
    customer_phone:   "+1 (555) 555-0123",
    customer_id:      null,
    order_id:         null,
    value_minor:      2999,
    currency:         "USD",
    event_source_url: "https://shop.example/orders/8819/thanks",
  };
  var k;
  for (k in over) {
    if (Object.prototype.hasOwnProperty.call(over, k)) base[k] = over[k];
  }
  return base;
}

// ---- registerProvider --------------------------------------------------

async function _registerProviderHappy() {
  var ctx = _setup();
  var rv  = await ctx.pe.registerProvider(_validProvider());
  check("register returns slug",                  rv.slug === "meta");
  check("register returns provider",              rv.provider === "meta_capi");
  check("register returns pixel_id",              rv.pixel_id === "1234567890");
  check("register returns conversion_url",        rv.conversion_url === "https://graph.facebook.com/v18.0/1234567890/events");
  check("register active true",                   rv.active === true);
  check("register archived_at null",              rv.archived_at === null);
  check("register access_token_hash sha256",      /^[0-9a-f]{64}$/.test(rv.access_token_hash));
  check("register token hash matches",            rv.access_token_hash === _sha256("EAAB-abcdef-redacted-XYZ"));
  check("register access_token_normalized",       rv.access_token_normalized === "EAAB-abcdef-redacted-XYZ");
  check("register created_at populated",          Number.isInteger(rv.created_at) && rv.created_at > 0);
  check("register updated_at == created_at",      rv.updated_at === rv.created_at);

  // getProvider reflects.
  var got = await ctx.pe.getProvider("meta");
  check("getProvider hits",                       got && got.slug === "meta");
  check("getProvider miss returns null",          (await ctx.pe.getProvider("never")) === null);

  // Re-register the same slug updates fields (token rotation).
  var update = await ctx.pe.registerProvider(_validProvider({
    access_token: "EAAB-NEW-TOKEN",
    pixel_id:     "9999999999",
    active:       false,
  }));
  check("re-register updates pixel_id",           update.pixel_id === "9999999999");
  check("re-register updates token hash",         update.access_token_hash === _sha256("EAAB-NEW-TOKEN"));
  check("re-register updates active flag",        update.active === false);
  check("re-register keeps created_at",           update.created_at === rv.created_at);
  check("re-register bumps updated_at",           update.updated_at >= rv.updated_at);

  // Provider platform swap is refused.
  await assert.rejects(
    ctx.pe.registerProvider(_validProvider({ provider: "google_ec" })),
    /cannot change provider platform/
  );

  // All five providers accept their enum value.
  for (var i = 0; i < pixelEvents.PROVIDERS.length; i += 1) {
    var ctxP = _setup();
    var p = pixelEvents.PROVIDERS[i];
    var rvP = await ctxP.pe.registerProvider(_validProvider({
      slug:           "p-" + i,
      provider:       p,
      conversion_url: "https://example.com/" + p + "/events",
    }));
    check("provider enum accepts " + p,           rvP.provider === p);
  }

  // listProviders.
  var listed = await ctx.pe.listProviders();
  check("listProviders returns 1",                listed.length === 1);
  var activeOnly = await ctx.pe.listProviders({ active_only: true });
  check("listProviders active_only excludes",     activeOnly.length === 0);     // re-register flipped active=false
}

async function _registerProviderRefusals() {
  var ctx = _setup();
  // Bad slug.
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ slug: "Has Caps" })),       /slug/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ slug: "" })),                /slug/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ slug: 42 })),                /slug/);
  // Bad provider enum.
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ provider: "amazon_capi" })), /provider/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ provider: "" })),            /provider/);
  // Bad pixel_id.
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ pixel_id: "" })),             /pixel_id/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ pixel_id: 12345 })),          /pixel_id/);
  // Bad access_token.
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ access_token: "" })),          /access_token/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ access_token: null })),        /access_token/);
  // Bad conversion_url.
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ conversion_url: "" })),                          /conversion_url/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ conversion_url: "http://insecure.example" })),    /https/);
  await assert.rejects(ctx.pe.registerProvider(_validProvider({ conversion_url: "ftp://example" })),              /https/);
  // Null input.
  await assert.rejects(ctx.pe.registerProvider(null),                                                              /input/);
  await assert.rejects(ctx.pe.registerProvider(undefined),                                                         /input/);
}

// ---- recordEvent hashing -----------------------------------------------

async function _recordEventHashes() {
  var ctx = _setup();
  await ctx.pe.registerProvider(_validProvider());

  var rv = await ctx.pe.recordEvent(_validEvent());
  check("recordEvent returns id (uuid v7)",       typeof rv.id === "string" && rv.id.length >= 32);
  check("recordEvent provider_slug",              rv.provider_slug === "meta");
  check("recordEvent event_name",                 rv.event_name === "purchase");
  check("recordEvent event_id",                   rv.event_id === "order_8819_purchase");
  check("recordEvent occurred_at",                rv.occurred_at === Date.UTC(2026, 4, 22, 12, 0, 0));
  check("recordEvent value_minor",                rv.value_minor === 2999);
  check("recordEvent currency",                   rv.currency === "USD");
  check("recordEvent status queued",              rv.status === "queued");
  check("recordEvent attempts 0",                 rv.attempts === 0);
  check("recordEvent dispatched_at null",         rv.dispatched_at === null);
  check("recordEvent response_status null",       rv.response_status === null);
  check("recordEvent last_failure null",          rv.last_failure === null);
  check("recordEvent event_source_url",           rv.event_source_url === "https://shop.example/orders/8819/thanks");

  // Email hashed via SHA-256 of normalised (trim + lowercase) form.
  check("recordEvent email is hashed",            rv.customer_email_sha256 === _sha256("alice@example.com"));
  check("email hash is 64 hex",                   /^[0-9a-f]{64}$/.test(rv.customer_email_sha256));
  // Phone hashed via SHA-256 of digits-only form.
  check("recordEvent phone is hashed",            rv.customer_phone_sha256 === _sha256("15555550123"));
  check("phone hash is 64 hex",                   /^[0-9a-f]{64}$/.test(rv.customer_phone_sha256));

  // Plaintext email never persisted — the hash differs from any
  // SHA-256 over the un-normalised inputs the operator passed.
  check("plaintext email not persisted",          rv.customer_email_sha256 !== _sha256("Alice@Example.COM"));

  // Idempotent replay on (provider_slug, event_id).
  var replay = await ctx.pe.recordEvent(_validEvent());
  check("recordEvent dedup returns same row",     replay.id === rv.id);

  // A different event_id creates a new row.
  var second = await ctx.pe.recordEvent(_validEvent({
    event_id:        "order_8819_addtocart",
    event_name:      "add_to_cart",
    customer_email:  "  BOB@example.com  ",
    customer_phone:  null,
    value_minor:     null,
    currency:        null,
  }));
  check("recordEvent second row id differs",      second.id !== rv.id);
  check("recordEvent second event_name",          second.event_name === "add_to_cart");
  check("trim before lowercase before hash",      second.customer_email_sha256 === _sha256("bob@example.com"));
  check("null phone is null hash",                second.customer_phone_sha256 === null);
  check("null value/currency permitted",          second.value_minor === null && second.currency === null);

  // Helpers surface the same hashing the primitive uses internally.
  check("hashEmail helper matches",               ctx.pe.hashEmail("ALICE@example.COM") === _sha256("alice@example.com"));
  check("hashPhone helper matches",               ctx.pe.hashPhone("+1 (555) 555-0123") === _sha256("15555550123"));
  check("hashEmail null in null out",             ctx.pe.hashEmail(null) === null);
  check("hashPhone empty digits returns null",    ctx.pe.hashPhone("+") === null);
}

async function _recordEventRefusals() {
  var ctx = _setup();
  await ctx.pe.registerProvider(_validProvider());

  // Unknown provider.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ provider_slug: "tiktok" })), /not found/);
  // Bad event_name.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_name: "checkout" })),  /event_name/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_name: "" })),          /event_name/);
  // Bad event_id.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_id: "" })),                 /event_id/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_id: "has space" })),        /event_id/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_id: "has\nnewline" })),     /event_id/);
  // Bad occurred_at.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ occurred_at: 0 })),         /occurred_at/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ occurred_at: -1 })),        /occurred_at/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ occurred_at: 1.5 })),       /occurred_at/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ occurred_at: "ts" })),       /occurred_at/);
  // Bad email shape.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ customer_email: "no-at-sign" })),    /customer_email/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ customer_email: 42 })),               /customer_email/);
  // Bad phone shape.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ customer_phone: "abc" })),            /customer_phone/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ customer_phone: "123" })),            /customer_phone/);    // too short
  // Bad currency.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ currency: "usd" })),                  /currency/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ currency: "USDX" })),                 /currency/);
  // Bad value_minor.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ value_minor: -1 })),                  /value_minor/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ value_minor: 1.5 })),                 /value_minor/);
  // Mismatched value + currency.
  await assert.rejects(
    ctx.pe.recordEvent(_validEvent({ value_minor: 100, currency: null })),
    /supplied together/
  );
  await assert.rejects(
    ctx.pe.recordEvent(_validEvent({ value_minor: null, currency: "USD" })),
    /supplied together/
  );
  // Bad event_source_url.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_source_url: "" })),                /event_source_url/);
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ event_source_url: "no-scheme.example" })), /event_source_url/);
  // Bad ip_hash.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ ip_hash: "NOT-HEX" })),   /ip_hash/);
  // Bad ua_class.
  await assert.rejects(ctx.pe.recordEvent(_validEvent({ ua_class: "Has Space" })), /ua_class/);
  // Null input.
  await assert.rejects(ctx.pe.recordEvent(null),                                   /input/);
}

// ---- dispatchTick + FSM ------------------------------------------------

async function _dispatchTickAndFsm() {
  var ctx = _setup();
  await ctx.pe.registerProvider(_validProvider());
  await ctx.pe.registerProvider(_validProvider({
    slug:           "google",
    provider:       "google_ec",
    conversion_url: "https://google.example/conversions",
  }));

  var t0 = Date.UTC(2026, 4, 22, 0, 0, 0);
  // Queue six events spread across two providers + the time axis.
  for (var i = 0; i < 4; i += 1) {
    await ctx.pe.recordEvent(_validEvent({
      event_id:    "meta_e" + i,
      occurred_at: t0 + i * 1000,
    }));
  }
  await ctx.pe.recordEvent(_validEvent({
    provider_slug: "google",
    event_id:      "g_e0",
    occurred_at:   t0 + 500,
  }));
  // One in the future — won't be due at t0 + 5s.
  await ctx.pe.recordEvent(_validEvent({
    provider_slug: "google",
    event_id:      "g_future",
    occurred_at:   t0 + 60 * 60 * 1000,
  }));

  // Tick at t0+5s with batch_size=3 — returns 3 oldest queued rows in
  // occurred_at order.
  var batch = await ctx.pe.dispatchTick({ now: t0 + 5000, batch_size: 3 });
  check("dispatchTick batch length",              batch.length === 3);
  check("dispatchTick batch[0] earliest",         batch[0].event_id === "meta_e0");
  check("dispatchTick batch[1] second",           batch[1].event_id === "g_e0");
  check("dispatchTick batch[2] third",            batch[2].event_id === "meta_e1");
  for (var k = 0; k < batch.length; k += 1) {
    check("dispatchTick batch[" + k + "] status queued", batch[k].status === "queued");
  }

  // Mark the first as dispatched, second as transient failure (retry),
  // third as terminal failure (no retry).
  var ok = await ctx.pe.markDispatched({
    event_id:        batch[0].id,
    response_status: 200,
    response_body:   '{"events_received":1}',
  });
  check("markDispatched status",                  ok.status === "dispatched");
  check("markDispatched attempts++",              ok.attempts === 1);
  check("markDispatched response_status",         ok.response_status === 200);
  check("markDispatched response_body persisted", ok.response_body === '{"events_received":1}');
  check("markDispatched dispatched_at stamped",   Number.isInteger(ok.dispatched_at) && ok.dispatched_at > 0);
  check("markDispatched last_failure null",       ok.last_failure === null);

  // Idempotent — replaying markDispatched on a dispatched row returns
  // the existing row.
  var okReplay = await ctx.pe.markDispatched({
    event_id:        batch[0].id,
    response_status: 200,
  });
  check("markDispatched idempotent",              okReplay.id === ok.id && okReplay.status === "dispatched");
  check("markDispatched idempotent no attempt++", okReplay.attempts === ok.attempts);

  // Transient failure → re-queue.
  var transient = await ctx.pe.markFailed({
    event_id: batch[1].id,
    reason:   "transient_5xx",
    retry:    true,
  });
  check("markFailed retry → queued",              transient.status === "queued");
  check("markFailed retry attempts++",             transient.attempts === 1);
  check("markFailed retry last_failure",          transient.last_failure === "transient_5xx");
  check("markFailed retry advances occurred_at",  transient.occurred_at > batch[1].occurred_at);

  // Terminal failure.
  var terminal = await ctx.pe.markFailed({
    event_id: batch[2].id,
    reason:   "bad_credentials",
    retry:    false,
  });
  check("markFailed terminal status",             terminal.status === "failed");
  check("markFailed terminal last_failure",       terminal.last_failure === "bad_credentials");

  // FSM refusals.
  await assert.rejects(
    ctx.pe.markFailed({ event_id: batch[0].id, reason: "post-dispatch", retry: false }),
    /terminal dispatched/
  );
  await assert.rejects(
    ctx.pe.markDispatched({ event_id: batch[2].id, response_status: 200 }),
    /terminal failed/
  );

  // dispatchTick at the same instant skips the dispatched + failed
  // rows and re-includes the transient-failure row only after its
  // back-off window expires. With a 1-minute back-off the row stays
  // pending until t0 + 65s. Test both sides of that boundary.
  var preBackoff = await ctx.pe.dispatchTick({ now: t0 + 6000, batch_size: 10 });
  var preIds     = preBackoff.map(function (e) { return e.event_id; });
  check("preBackoff excludes dispatched",         preIds.indexOf("meta_e0") === -1);
  check("preBackoff excludes terminal",            preIds.indexOf("meta_e1") === -1);
  check("preBackoff excludes re-queued",           preIds.indexOf("g_e0")    === -1);     // its occurred_at is now t0+60s+; not yet due at t0+6s
  check("preBackoff includes meta_e2",             preIds.indexOf("meta_e2") !== -1);
  check("preBackoff includes meta_e3",             preIds.indexOf("meta_e3") !== -1);

  // The re-queue stamp on the transient-failure row uses the
  // primitive's internal wall-clock _now() — the new occurred_at lands
  // at (wall_now + back-off). To assert "after the back-off window
  // the dispatcher will pick the row again" we tick with a `now`
  // value at the row's re-stamped occurred_at + 1ms.
  var postBackoff = await ctx.pe.dispatchTick({ now: transient.occurred_at + 1, batch_size: 10 });
  var postIds     = postBackoff.map(function (e) { return e.event_id; });
  check("postBackoff includes re-queued g_e0",     postIds.indexOf("g_e0") !== -1);

  // Inactive provider — its events drop out of the tick.
  await ctx.pe.registerProvider(_validProvider({ active: false }));
  var inactiveTick = await ctx.pe.dispatchTick({ now: transient.occurred_at + 1, batch_size: 50 });
  for (var x = 0; x < inactiveTick.length; x += 1) {
    check("inactive provider skipped",             inactiveTick[x].provider_slug !== "meta");
  }

  // markFailed / markDispatched on missing event.
  var badId = _uuidv7();
  await assert.rejects(ctx.pe.markFailed({ event_id: badId, reason: "x", retry: false }),  /not found/);
  await assert.rejects(ctx.pe.markDispatched({ event_id: badId, response_status: 200 }),   /not found/);

  // Bad inputs.
  await assert.rejects(ctx.pe.markDispatched(null),                                                   /input/);
  await assert.rejects(ctx.pe.markFailed(null),                                                       /input/);
  await assert.rejects(ctx.pe.markDispatched({ event_id: batch[0].id, response_status: 700 }),         /response_status/);
  await assert.rejects(ctx.pe.markDispatched({ event_id: batch[0].id, response_status: 50 }),          /response_status/);
  await assert.rejects(ctx.pe.markFailed({ event_id: batch[2].id, reason: "", retry: true }),          /reason/);
  await assert.rejects(ctx.pe.dispatchTick({ now: -1 }),                                                /now/);
  await assert.rejects(ctx.pe.dispatchTick({ batch_size: 0 }),                                          /batch_size/);
}

// ---- eventsForOrder ----------------------------------------------------

async function _eventsForOrder() {
  var ctx = _setup();
  await ctx.pe.registerProvider(_validProvider());

  var orderA = _uuidv7();
  var orderB = _uuidv7();

  // Three events for order A across two event names + one for order B.
  var t0 = Date.UTC(2026, 4, 22, 0, 0, 0);
  await ctx.pe.recordEvent(_validEvent({ event_id: "a_view",     event_name: "view_content", order_id: orderA, occurred_at: t0 + 1000 }));
  await ctx.pe.recordEvent(_validEvent({ event_id: "a_add",      event_name: "add_to_cart",  order_id: orderA, occurred_at: t0 + 2000 }));
  await ctx.pe.recordEvent(_validEvent({ event_id: "a_purchase", event_name: "purchase",     order_id: orderA, occurred_at: t0 + 3000 }));
  await ctx.pe.recordEvent(_validEvent({ event_id: "b_purchase", event_name: "purchase",     order_id: orderB, occurred_at: t0 + 4000 }));

  var aEvents = await ctx.pe.eventsForOrder(orderA);
  check("eventsForOrder A length",                aEvents.length === 3);
  check("eventsForOrder A[0] earliest",           aEvents[0].event_id === "a_view");
  check("eventsForOrder A[1]",                    aEvents[1].event_id === "a_add");
  check("eventsForOrder A[2]",                    aEvents[2].event_id === "a_purchase");

  var bEvents = await ctx.pe.eventsForOrder(orderB);
  check("eventsForOrder B length",                bEvents.length === 1);
  check("eventsForOrder B[0]",                    bEvents[0].event_id === "b_purchase");

  // Unknown order returns empty.
  var nope = await ctx.pe.eventsForOrder(_uuidv7());
  check("eventsForOrder unknown empty",           nope.length === 0);

  // Bad input.
  await assert.rejects(ctx.pe.eventsForOrder("not-a-uuid"), /order_id/);
  await assert.rejects(ctx.pe.eventsForOrder(null),         /order_id/);
}

// ---- dispatchedInPeriod + failedEvents --------------------------------

async function _dispatchedInPeriod() {
  var ctx = _setup();
  await ctx.pe.registerProvider(_validProvider());
  await ctx.pe.registerProvider(_validProvider({
    slug:           "tiktok",
    provider:       "tiktok_events",
    conversion_url: "https://business-api.tiktok.com/open_api/v1.3/event/track/",
  }));

  var t0 = Date.UTC(2026, 4, 22, 0, 0, 0);
  // Five events, dispatch all in order.
  var ids = [];
  for (var i = 0; i < 5; i += 1) {
    var ev = await ctx.pe.recordEvent(_validEvent({
      provider_slug: i % 2 === 0 ? "meta" : "tiktok",
      event_id:      "ev_" + i,
      occurred_at:   t0 + i * 1000,
    }));
    ids.push(ev.id);
  }
  for (var j = 0; j < ids.length; j += 1) {
    await ctx.pe.markDispatched({ event_id: ids[j], response_status: 200 });
  }

  // The dispatched_at column is stamped at markDispatched call-time
  // via the primitive's internal _now() — the period window we narrow
  // on therefore brackets wall-clock-now, not the test's t0 reference.
  var nowMs = Date.now();
  var allDispatched = await ctx.pe.dispatchedInPeriod({
    from: nowMs - 60 * 60 * 1000,
    to:   nowMs + 60 * 60 * 1000,
  });
  check("dispatchedInPeriod all",                 allDispatched.length === 5);

  var metaOnly = await ctx.pe.dispatchedInPeriod({
    provider_slug: "meta",
    from:          nowMs - 60 * 60 * 1000,
    to:            nowMs + 60 * 60 * 1000,
  });
  check("dispatchedInPeriod meta only",           metaOnly.length === 3);
  for (var m = 0; m < metaOnly.length; m += 1) {
    check("dispatchedInPeriod meta filter",       metaOnly[m].provider_slug === "meta");
  }

  // Narrow window that pre-dates every dispatched_at returns empty.
  var narrowEmpty = await ctx.pe.dispatchedInPeriod({
    from: 1,
    to:   1000,
  });
  check("dispatchedInPeriod narrow excludes",     narrowEmpty.length === 0);

  // Bad input.
  await assert.rejects(ctx.pe.dispatchedInPeriod({ from: 100, to: 50 }), /from must be/);
  await assert.rejects(ctx.pe.dispatchedInPeriod(null),                   /input/);

  // failedEvents — fail one new event and assert it surfaces.
  var willFail = await ctx.pe.recordEvent(_validEvent({
    provider_slug: "meta", event_id: "to_fail", occurred_at: t0 + 100000,
  }));
  await ctx.pe.markFailed({ event_id: willFail.id, reason: "perm_failure", retry: false });
  var failed = await ctx.pe.failedEvents({ limit: 10 });
  check("failedEvents includes failed row",       failed.length === 1);
  check("failedEvents reason captured",           failed[0].last_failure === "perm_failure");
}

// ---- metricsForProvider ------------------------------------------------

async function _metricsForProvider() {
  var ctx = _setup();
  await ctx.pe.registerProvider(_validProvider());

  var t0 = Date.UTC(2026, 4, 22, 0, 0, 0);
  // 2 purchases, 1 dispatched + 1 queued.
  var p1 = await ctx.pe.recordEvent(_validEvent({ event_id: "p1", event_name: "purchase",     occurred_at: t0 + 1000 }));
  await ctx.pe.recordEvent(_validEvent({          event_id: "p2", event_name: "purchase",     occurred_at: t0 + 2000 }));
  // 1 add_to_cart, dispatched.
  await ctx.pe.recordEvent(_validEvent({          event_id: "a1", event_name: "add_to_cart",  occurred_at: t0 + 3000 }));
  // 1 view_content, failed.
  var v1 = await ctx.pe.recordEvent(_validEvent({ event_id: "v1", event_name: "view_content", occurred_at: t0 + 4000 }));

  // Dispatch p1.
  await ctx.pe.markDispatched({ event_id: p1.id, response_status: 200 });
  // Dispatch a1.
  var dueEvents = await ctx.pe.dispatchTick({ now: t0 + 5000, batch_size: 50 });
  var a1Row;
  for (var k = 0; k < dueEvents.length; k += 1) {
    if (dueEvents[k].event_id === "a1") { a1Row = dueEvents[k]; break; }
  }
  await ctx.pe.markDispatched({ event_id: a1Row.id, response_status: 200 });
  // Fail v1.
  await ctx.pe.markFailed({ event_id: v1.id, reason: "perm_failure", retry: false });

  var m = await ctx.pe.metricsForProvider({
    slug: "meta",
    from: t0 - 1000,
    to:   t0 + 10000,
  });
  check("metrics slug echo",                      m.slug === "meta");
  check("metrics provider echo",                  m.provider === "meta_capi");
  check("metrics pixel_id echo",                  m.pixel_id === "1234567890");
  check("metrics total = 4",                      m.total === 4);
  check("metrics dispatched = 2",                 m.dispatched === 2);
  check("metrics queued = 1",                     m.queued === 1);
  check("metrics failed = 1",                     m.failed === 1);
  check("metrics by_event purchase total = 2",    m.by_event.purchase.total === 2);
  check("metrics purchase dispatched = 1",        m.by_event.purchase.dispatched === 1);
  check("metrics purchase queued = 1",            m.by_event.purchase.queued === 1);
  check("metrics add_to_cart dispatched = 1",     m.by_event.add_to_cart.dispatched === 1);
  check("metrics view_content failed = 1",        m.by_event.view_content.failed === 1);
  // Event names not seen still show zeroes.
  check("metrics lead total = 0",                 m.by_event.lead.total === 0);
  check("metrics search total = 0",               m.by_event.search.total === 0);

  // Window narrowed past the events.
  var none = await ctx.pe.metricsForProvider({
    slug: "meta",
    from: t0 + 1000 * 1000,
    to:   t0 + 2000 * 1000,
  });
  check("metrics narrow window total = 0",        none.total === 0);

  // Bad input.
  await assert.rejects(ctx.pe.metricsForProvider({ slug: "never", from: 1, to: 2 }), /not found/);
  await assert.rejects(ctx.pe.metricsForProvider({ slug: "meta", from: 100, to: 50 }), /from must be/);
  await assert.rejects(ctx.pe.metricsForProvider(null),                                 /input/);
}

// ---- run --------------------------------------------------------------

async function run() {
  await _registerProviderHappy();
  await _registerProviderRefusals();
  await _recordEventHashes();
  await _recordEventRefusals();
  await _dispatchTickAndFsm();
  await _eventsForOrder();
  await _dispatchedInPeriod();
  await _metricsForProvider();
}

module.exports = { run: run };

if (require.main === module) {
  // Reference bShop so the lazy framework resolve (uuid.v7, guardUuid)
  // is wired before the first test runs.
  void bShop;
  run().then(function () {
    process.stdout.write("pixel-events.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("pixel-events.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
