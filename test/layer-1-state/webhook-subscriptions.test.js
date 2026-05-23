"use strict";
/**
 * webhookSubscriptions — owner-scoped fan-out registration with
 * signing-secret rotation grace.
 *
 * Layer 1 against in-memory node:sqlite loaded from migration 0060.
 * The primitive isn't wired through `bShop` yet — the test requires
 * `lib/webhook-subscriptions.js` directly so the gate exists ahead of
 * the entry-point edit.
 *
 * Coverage:
 *   - subscribe happy path (id / hash shape / plaintext returned once /
 *     defaults / endpoint_url https-only validation / event-types shape)
 *   - subscribe refusals (missing input, bad owner_type, missing
 *     endpoint_url, http:// refused, bad event_types, oversized name,
 *     control bytes, duplicate event types)
 *   - subscriptionsForEvent fan-out: wildcard match, literal match,
 *     paused subscriptions excluded
 *   - pause / resume lifecycle
 *   - update event_types (and other patchable columns)
 *   - rotateSecret with 24h grace window (previous hash preserved
 *     inside window, dropped after)
 *   - unsubscribe + listForOwner + get
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop                 = require("../../lib");
var webhookSubscriptions  = require("../../lib/webhook-subscriptions");
var helpers               = require("../helpers");
var check                 = helpers.check;
var assert                = helpers.assert;

var MIG_PATH = nodePath.resolve(
  __dirname, "..", "..", "migrations-d1", "0060_webhook_subscriptions.sql"
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

function _validUUID() { return bShop.framework.uuid.v7(); }

function _setupClock() {
  // Mutable clock — tests advance through the 24h rotation grace by
  // poking `clock.now`. The factory captures the closure so every
  // subsequent call to nowFn() returns the current value.
  var clock = { now: Date.now() };
  var query = _makeQuery();
  var subs = webhookSubscriptions.create({
    query: query,
    now:   function () { return clock.now; },
  });
  return { query: query, subs: subs, clock: clock };
}

function _setup() {
  var query = _makeQuery();
  var subs = webhookSubscriptions.create({ query: query });
  return { query: query, subs: subs };
}

function _validSubscribe(overrides) {
  return Object.assign({
    owner_type:   "operator",
    owner_id:     "op-1",
    endpoint_url: "https://example.com/hooks/in",
    event_types:  ["order.mark_paid", "order.mark_shipped"],
    name:         "Default receiver",
  }, overrides || {});
}

async function _subscribeHappyPath() {
  var ctx = _setup();
  var res = await ctx.subs.subscribe(_validSubscribe());
  check("subscribe returns subscription object",       res && typeof res.subscription === "object");
  check("subscribe returns signing_secret plaintext",  typeof res.signing_secret === "string" && res.signing_secret.length >= 32);
  var row = res.subscription;
  check("subscribe id is 36-char uuid",                typeof row.id === "string" && row.id.length === 36);
  check("subscribe persists owner_type",               row.owner_type === "operator");
  check("subscribe persists owner_id",                 row.owner_id === "op-1");
  check("subscribe persists endpoint_url",             row.endpoint_url === "https://example.com/hooks/in");
  check("subscribe stamps active=1",                   Number(row.active) === 1);
  check("subscribe stamps paused_at=null",             row.paused_at == null);
  check("subscribe persists name",                     row.name === "Default receiver");
  check("subscribe stamps created_at",                 typeof row.created_at === "number");
  check("subscribe stamps updated_at = created_at",    Number(row.created_at) === Number(row.updated_at));
  check("subscribe hashes secret (hex sha3-512)",      typeof row.signing_secret_hash === "string" && /^[0-9a-f]{128}$/.test(row.signing_secret_hash));
  check("subscribe does NOT store plaintext",          row.signing_secret_hash !== res.signing_secret);
  check("subscribe stores event_types as JSON",        row.event_types_json === JSON.stringify(["order.mark_paid", "order.mark_shipped"]));
  check("subscribe leaves previous_hash null",         row.signing_secret_previous_hash == null);
  check("subscribe leaves rotated_at null",            row.signing_secret_rotated_at == null);

  // Two subscribes yield two distinct plaintexts.
  var r2 = await ctx.subs.subscribe(_validSubscribe({ owner_id: "op-2" }));
  check("two subscribes -> two plaintexts",            r2.signing_secret !== res.signing_secret);
  check("two subscribes -> two hashes",                r2.subscription.signing_secret_hash !== row.signing_secret_hash);

  // Operator-supplied secret accepted.
  var r3 = await ctx.subs.subscribe(_validSubscribe({
    owner_id:       "op-3",
    signing_secret: "x".repeat(48),
  }));
  check("subscribe accepts operator secret",           r3.signing_secret === "x".repeat(48));

  // get + listForOwner.
  var got = await ctx.subs.get(row.id);
  check("get resolves by id",                          got && got.id === row.id);
  var list = await ctx.subs.listForOwner({ owner_type: "operator", owner_id: "op-1" });
  check("listForOwner returns the operator's row",     list.length === 1 && list[0].id === row.id);
  var listOther = await ctx.subs.listForOwner({ owner_type: "app", owner_id: "op-1" });
  check("listForOwner scoped by owner_type",           listOther.length === 0);
}

async function _subscribeRefusals() {
  var ctx = _setup();
  await assert.rejects(ctx.subs.subscribe(),                                              /input object required/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ owner_type: "" })),           /owner_type/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ owner_type: "vendor" })),     /owner_type/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ owner_id: "" })),             /owner_id/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ owner_id: "bad\x01id" })),    /owner_id/);

  // http:// refused — safeUrl defaults to https-only.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ endpoint_url: "http://example.com/hook" })),  /endpoint_url/);
  // Bare host without scheme refused.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ endpoint_url: "example.com/hook" })),         /endpoint_url/);
  // Missing endpoint_url refused.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ endpoint_url: "" })),                         /endpoint_url/);

  // event_types must be a non-empty array of valid event-type strings.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ event_types: [] })),                          /event_types/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ event_types: "order.mark_paid" })),           /event_types/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ event_types: ["BAD CASE"] })),                /event_types/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ event_types: ["order.x", "order.x"] })),     /duplicate/);

  // Oversized name + control bytes.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ name: "x".repeat(201) })),                    /name/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ name: "bad\x01name" })),                       /name/);
  // Zero-width in name.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({
    name: "bad" + String.fromCharCode(0x200B) + "name",
  })),                                                                                                    /name/);

  // operator-supplied secret too short.
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ signing_secret: "tooshort" })),               /signing_secret/);
  await assert.rejects(ctx.subs.subscribe(_validSubscribe({ signing_secret: 42 })),                       /signing_secret/);
}

async function _subscriptionsForEventFanout() {
  var ctx = _setup();
  // Wildcard subscriber.
  var rWild = await ctx.subs.subscribe(_validSubscribe({
    owner_id: "wild", event_types: ["*"], name: "wild",
  }));
  // Literal subscriber matching one type only.
  var rOnePaid = await ctx.subs.subscribe(_validSubscribe({
    owner_id: "paid-only", event_types: ["order.mark_paid"], name: "paid",
  }));
  // Literal subscriber matching a different type.
  var rOneShipped = await ctx.subs.subscribe(_validSubscribe({
    owner_id: "shipped-only", event_types: ["order.mark_shipped"], name: "shipped",
  }));
  // Active subscriber matching both types via two-entry array.
  var rBoth = await ctx.subs.subscribe(_validSubscribe({
    owner_id: "both", event_types: ["order.mark_paid", "order.mark_shipped"], name: "both",
  }));

  var paid = await ctx.subs.subscriptionsForEvent("order.mark_paid");
  var paidIds = paid.map(function (r) { return r.id; }).sort();
  var expectedPaid = [rWild.subscription.id, rOnePaid.subscription.id, rBoth.subscription.id].sort();
  check("subscriptionsForEvent(paid) returns wild+literal+both",
        JSON.stringify(paidIds) === JSON.stringify(expectedPaid));

  var shipped = await ctx.subs.subscriptionsForEvent("order.mark_shipped");
  var shippedIds = shipped.map(function (r) { return r.id; }).sort();
  var expectedShipped = [rWild.subscription.id, rOneShipped.subscription.id, rBoth.subscription.id].sort();
  check("subscriptionsForEvent(shipped) routes correctly",
        JSON.stringify(shippedIds) === JSON.stringify(expectedShipped));

  // Unknown event still routes through wildcard only — the framework
  // permits custom event types at emit time so the wildcard
  // subscriber receives them.
  var custom = await ctx.subs.subscriptionsForEvent("custom.event.fired");
  check("subscriptionsForEvent(custom) -> wildcard only",
        custom.length === 1 && custom[0].id === rWild.subscription.id);

  // Paused subscriptions are excluded from the fan-out.
  await ctx.subs.pauseSubscription(rBoth.subscription.id);
  var paidAfterPause = await ctx.subs.subscriptionsForEvent("order.mark_paid");
  var stillThere = paidAfterPause.map(function (r) { return r.id; });
  check("paused subscription dropped from fan-out",
        stillThere.indexOf(rBoth.subscription.id) === -1);
  check("paused-subscription fan-out still includes others",
        stillThere.indexOf(rWild.subscription.id) !== -1 && stillThere.indexOf(rOnePaid.subscription.id) !== -1);

  await assert.rejects(ctx.subs.subscriptionsForEvent(""),  /eventType/);
  await assert.rejects(ctx.subs.subscriptionsForEvent(123), /eventType/);
}

async function _pauseResumeLifecycle() {
  var ctx = _setup();
  var res = await ctx.subs.subscribe(_validSubscribe({ owner_id: "lifecycle" }));
  var paused = await ctx.subs.pauseSubscription(res.subscription.id);
  check("pause flips active=0",                Number(paused.active) === 0);
  check("pause stamps paused_at",              typeof paused.paused_at === "number");
  check("pause preserves owner_type",          paused.owner_type === "operator");

  var resumed = await ctx.subs.resumeSubscription(res.subscription.id);
  check("resume flips active=1",               Number(resumed.active) === 1);
  check("resume clears paused_at",             resumed.paused_at == null);

  // Pause / resume on unknown id -> null.
  var nullPause = await ctx.subs.pauseSubscription(_validUUID());
  check("pause unknown -> null",               nullPause === null);
  var nullResume = await ctx.subs.resumeSubscription(_validUUID());
  check("resume unknown -> null",              nullResume === null);
}

async function _updateEventTypes() {
  var ctx = _setup();
  var res = await ctx.subs.subscribe(_validSubscribe({
    owner_id: "patch", event_types: ["order.mark_paid"], name: "Old name",
  }));

  var patched = await ctx.subs.update(res.subscription.id, {
    event_types: ["order.mark_paid", "order.mark_shipped", "order.cancel"],
    name:        "New name",
  });
  check("update patches event_types_json",
        patched.event_types_json === JSON.stringify(["order.mark_paid", "order.mark_shipped", "order.cancel"]));
  check("update patches name",                  patched.name === "New name");
  check("update preserves owner_id",            patched.owner_id === "patch");
  check("update bumps updated_at",              Number(patched.updated_at) >= Number(res.subscription.updated_at));

  // endpoint_url patchable + still https-only.
  var withUrl = await ctx.subs.update(res.subscription.id, {
    endpoint_url: "https://example.com/hooks/v2",
  });
  check("update patches endpoint_url",          withUrl.endpoint_url === "https://example.com/hooks/v2");
  await assert.rejects(ctx.subs.update(res.subscription.id, {
    endpoint_url: "http://example.com/hook",
  }), /endpoint_url/);

  // Unknown columns refused.
  await assert.rejects(ctx.subs.update(res.subscription.id, { owner_type: "app" }),  /not updatable/);
  await assert.rejects(ctx.subs.update(res.subscription.id, { active: 0 }),          /not updatable/);
  // Empty patch refused.
  await assert.rejects(ctx.subs.update(res.subscription.id, {}),                     /at least one column/);

  // Bad event_types still refused on update.
  await assert.rejects(ctx.subs.update(res.subscription.id, { event_types: [] }),    /event_types/);

  // Unknown id -> null.
  var noop = await ctx.subs.update(_validUUID(), { name: "x" });
  check("update unknown -> null",               noop === null);
}

async function _rotateSecret24hGrace() {
  var ctx = _setupClock();
  var t0  = ctx.clock.now;
  var sub = await ctx.subs.subscribe(_validSubscribe({ owner_id: "rot" }));
  var originalHash = sub.subscription.signing_secret_hash;

  var rotated = await ctx.subs.rotateSecret(sub.subscription.id);
  check("rotateSecret returns new plaintext",          typeof rotated.signing_secret === "string" && rotated.signing_secret.length >= 32);
  check("rotateSecret plaintext differs from first",   rotated.signing_secret !== sub.signing_secret);
  check("rotateSecret swaps signing_secret_hash",      rotated.subscription.signing_secret_hash !== originalHash);
  check("rotateSecret preserves previous_hash",        rotated.subscription.signing_secret_previous_hash === originalHash);
  check("rotateSecret stamps rotated_at",              Number(rotated.subscription.signing_secret_rotated_at) === t0);

  // Inside the grace window — previous hash still visible.
  ctx.clock.now = t0 + (12 * 60 * 60 * 1000);                              // 12h later
  var midGrace = await ctx.subs.get(sub.subscription.id);
  check("inside grace: previous_hash retained",        midGrace.signing_secret_previous_hash === originalHash);
  check("inside grace: hash unchanged",                midGrace.signing_secret_hash === rotated.subscription.signing_secret_hash);

  // Outside the grace window — previous hash hidden on read.
  ctx.clock.now = t0 + (24 * 60 * 60 * 1000) + 1;                          // 24h+1ms later
  var postGrace = await ctx.subs.get(sub.subscription.id);
  check("after grace: previous_hash hidden",           postGrace.signing_secret_previous_hash == null);
  check("after grace: current hash unchanged",         postGrace.signing_secret_hash === rotated.subscription.signing_secret_hash);

  // The sweep clears the previous hash from the persistent row.
  await ctx.subs.expireRotationGrace();
  var fresh = await ctx.subs.get(sub.subscription.id);
  check("expireRotationGrace clears previous_hash",    fresh.signing_secret_previous_hash == null);
  check("expireRotationGrace clears rotated_at",       fresh.signing_secret_rotated_at == null);

  // Rotate on unknown id -> null.
  var nullRotate = await ctx.subs.rotateSecret(_validUUID());
  check("rotateSecret unknown -> null",                nullRotate === null);
}

async function _unsubscribeAndListing() {
  var ctx = _setup();
  var a = await ctx.subs.subscribe(_validSubscribe({ owner_id: "x", name: "first" }));
  var b = await ctx.subs.subscribe(_validSubscribe({ owner_id: "x", name: "second" }));

  var listed = await ctx.subs.listForOwner({ owner_type: "operator", owner_id: "x" });
  check("listForOwner returns both rows",            listed.length === 2);

  var removed = await ctx.subs.unsubscribe(a.subscription.id);
  check("unsubscribe returns true on hit",            removed === true);
  var gone = await ctx.subs.get(a.subscription.id);
  check("unsubscribe removes the row",                gone === null);

  var listedAfter = await ctx.subs.listForOwner({ owner_type: "operator", owner_id: "x" });
  check("listForOwner reflects deletion",             listedAfter.length === 1 && listedAfter[0].id === b.subscription.id);

  // Unsubscribe on unknown -> false.
  var missed = await ctx.subs.unsubscribe(_validUUID());
  check("unsubscribe miss returns false",             missed === false);

  // listForOwner refusals.
  await assert.rejects(ctx.subs.listForOwner(),                                 /input object required/);
  await assert.rejects(ctx.subs.listForOwner({ owner_type: "x", owner_id: "y" }), /owner_type/);
}

async function run() {
  await _subscribeHappyPath();
  await _subscribeRefusals();
  await _subscriptionsForEventFanout();
  await _pauseResumeLifecycle();
  await _updateEventTypes();
  await _rotateSecret24hGrace();
  await _unsubscribeAndListing();
}

module.exports = { run: run };

// Allow direct invocation: `node test/layer-1-state/webhook-subscriptions.test.js`.
if (require.main === module) {
  run().then(
    function () {
      console.log("ok - webhook-subscriptions (" + helpers.getChecks() + " checks)");
    },
    function (e) {
      console.error(e && e.stack || e);
      process.exit(1);
    }
  );
}
