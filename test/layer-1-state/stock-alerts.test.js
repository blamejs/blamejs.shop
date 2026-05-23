"use strict";
/**
 * stockAlerts — back-in-stock notification subscriptions.
 *
 * Layer 1 against in-memory node:sqlite loaded from the catalog
 * migration plus migration 0048. Coverage:
 *
 *   - subscribe mints a token + hashes the email + writes a row
 *   - subscribe dedupes re-subscriptions to the same (email, sku, variant)
 *   - confirm transitions a pending row to confirmed
 *   - scanAndNotify fires when inventory > 0 + dedupes per row
 *   - scanAndNotify enqueues into the notifications dep when wired
 *   - unsubscribe removes the row
 *   - cleanupExpired drops past-expires_at rows
 *   - listForSku / listForCustomer / isSubscribed
 *   - refusals: bad email / bad sku / bad token shape / missing
 *     catalog dep
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop       = require("../../lib");
var stockAlerts = require("../../lib/stock-alerts");
var helpers     = require("../helpers");
var check       = helpers.check;
var assert      = helpers.assert;

var MIGS = [
  "0001_catalog.sql",
  "0008_inventory_thresholds.sql",
  "0048_stock_alerts.sql",
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
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE" || verb === "ALTER") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

function _collectorNotifications() {
  var calls = [];
  return {
    calls: calls,
    enqueue: function (input) {
      calls.push(input);
      return Promise.resolve({ ok: true, id: "fake-" + calls.length, scheduled_at: input.scheduled_at });
    },
  };
}

function _optedOutNotifications() {
  var calls = [];
  return {
    calls: calls,
    enqueue: function (input) {
      calls.push(input);
      return Promise.resolve({ ok: false, error: "opted-out" });
    },
  };
}

// Build the trio every test needs: shared query + catalog + alerts.
function _wire(extra) {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var alerts  = stockAlerts.create(Object.assign({
    query:   query,
    catalog: catalog,
  }, extra || {}));
  return { query: query, catalog: catalog, alerts: alerts };
}

// ---- tests --------------------------------------------------------------

async function _subscribeMintsToken() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-A", { stock_on_hand: 0 });

  var rv = await w.alerts.subscribe({ email: "Alice@Example.com", sku: "SKU-A" });
  check("subscribe status",                rv.status === "subscribed");
  check("subscribe returns id (UUID)",     typeof rv.id === "string" && rv.id.length > 0);
  check("subscribe returns email_hash",    /^[0-9a-f]{128}$/.test(rv.email_hash));
  check("subscribe returns token len 32",  typeof rv.confirmation_token === "string" && rv.confirmation_token.length === 32);
  check("subscribe token is base64url",    /^[A-Za-z0-9_-]{32}$/.test(rv.confirmation_token));
  check("subscribe returns expires_at",    Number.isInteger(rv.expires_at) && rv.expires_at > Date.now());

  // hashEmail returns the same digest as subscribe.
  var h = w.alerts.hashEmail("alice@example.com");
  check("hashEmail matches subscribe hash", h === rv.email_hash);
  check("hashEmail lowercases at hash time", w.alerts.hashEmail("ALICE@EXAMPLE.COM") === rv.email_hash);
}

async function _subscribeDedupesAndDoesNotRevealToken() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-B", { stock_on_hand: 0 });

  var first = await w.alerts.subscribe({ email: "bob@example.com", sku: "SKU-B" });
  check("first subscribe gets token",          typeof first.confirmation_token === "string");

  var dup = await w.alerts.subscribe({ email: "BOB@example.com", sku: "SKU-B" });
  check("dup re-subscribe → already-pending",  dup.status === "already-pending");
  check("dup id matches first",                dup.id === first.id);
  check("dup does NOT reveal a token",         dup.confirmation_token === undefined);
  check("dup email_hash matches first",        dup.email_hash === first.email_hash);

  // After confirm, re-subscribing surfaces 'already-confirmed'.
  await w.alerts.confirm({ token: first.confirmation_token });
  var dup2 = await w.alerts.subscribe({ email: "bob@example.com", sku: "SKU-B" });
  check("post-confirm dup → already-confirmed", dup2.status === "already-confirmed");
  check("post-confirm dup id stable",            dup2.id === first.id);

  // Variant axis is part of the unique key — different variant_id is a
  // distinct row.
  var variantId = bShop.framework.uuid.v4();
  var withVariant = await w.alerts.subscribe({ email: "bob@example.com", sku: "SKU-B", variant_id: variantId });
  check("variant axis distinct row",            withVariant.status === "subscribed");
  check("variant axis distinct id",             withVariant.id !== first.id);
  check("variant axis mints fresh token",       typeof withVariant.confirmation_token === "string");
}

async function _confirmTransitionsPendingToConfirmed() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-C", { stock_on_hand: 0 });
  var sub = await w.alerts.subscribe({ email: "carol@example.com", sku: "SKU-C" });

  var pre = await w.alerts.isSubscribed({ email: "carol@example.com", sku: "SKU-C" });
  check("pre-confirm status pending",     pre.subscribed === true && pre.status === "pending");

  var row = await w.alerts.confirm({ token: sub.confirmation_token });
  check("confirm returns row",            row && row.id === sub.id);
  check("confirm stamps confirmed_at",    Number.isInteger(Number(row.confirmed_at)) && Number(row.confirmed_at) > 0);

  var post = await w.alerts.isSubscribed({ email: "carol@example.com", sku: "SKU-C" });
  check("post-confirm status confirmed",  post.subscribed === true && post.status === "confirmed");

  // Bad token → null
  var missing = await w.alerts.confirm({ token: "A".repeat(32) });
  check("unknown token → null",           missing === null);

  // Bad token shape refused at the entry point.
  await assert.rejects(w.alerts.confirm({ token: "too-short" }), /32 base64url characters/);
  await assert.rejects(w.alerts.confirm({ token: "!".repeat(32) }), /32 base64url characters/);
}

async function _scanAndNotifyFiresWhenInventoryAvailable() {
  var notif = _collectorNotifications();
  var w = _wire({ notifications: notif });

  await w.catalog.inventory.create("SKU-D", { stock_on_hand: 0 });
  var sub1 = await w.alerts.subscribe({ email: "alice@example.com", sku: "SKU-D" });
  await w.alerts.confirm({ token: sub1.confirmation_token });
  var sub2 = await w.alerts.subscribe({ email: "bob@example.com", sku: "SKU-D" });
  await w.alerts.confirm({ token: sub2.confirmation_token });
  // un-confirmed subscriber — must NOT fire.
  await w.alerts.subscribe({ email: "carol@example.com", sku: "SKU-D" });

  // Inventory still 0 — sweep is a no-op on the notify side.
  var pre = await w.alerts.scanAndNotify({});
  check("no-stock sweep notified 0",       pre.notified === 0);
  check("no-stock sweep enqueued 0",       notif.calls.length === 0);

  // Operator restocks. Now stock_on_hand = 7.
  await w.catalog.inventory.restock("SKU-D", 7);
  var sweep = await w.alerts.scanAndNotify({});
  check("sweep notified 2",                sweep.notified === 2);
  check("sweep enqueued 2",                sweep.enqueued === 2);
  check("notif called twice",              notif.calls.length === 2);
  check("notif event_type stock back",     notif.calls[0].event_type === "stock.back-in-stock");
  check("notif channel in-app",            notif.calls[0].channel === "in-app");
  check("notif recipient_id is email_hash", /^[0-9a-f]{128}$/.test(notif.calls[0].recipient_id));
  check("notif payload carries sku",       notif.calls[0].payload.sku === "SKU-D");
  check("notif payload carries available", notif.calls[0].payload.available === 7);

  // Second sweep is idempotent — every notified row carries
  // notified_at, so they are filtered out of the candidate set.
  var sweep2 = await w.alerts.scanAndNotify({});
  check("idempotent: second sweep scans 0", sweep2.scanned === 0);
  check("idempotent: second sweep notif 0", sweep2.notified === 0);
  check("idempotent: notif still 2 total",  notif.calls.length === 2);
}

async function _scanAndNotifyHandlesOptedOutWithoutRetrying() {
  // notifications.enqueue returns { ok:false, error:"opted-out" } — the
  // row must still stamp notified_at so the sweeper doesn't retry.
  var notif = _optedOutNotifications();
  var w = _wire({ notifications: notif });

  await w.catalog.inventory.create("SKU-OPT", { stock_on_hand: 5 });
  var sub = await w.alerts.subscribe({ email: "opted@example.com", sku: "SKU-OPT" });
  await w.alerts.confirm({ token: sub.confirmation_token });

  var sweep = await w.alerts.scanAndNotify({});
  check("opted-out sweep notified the row",  sweep.notified === 1);
  check("opted-out sweep enqueued 0",        sweep.enqueued === 0);
  check("opted-out invocation still happened", notif.calls.length === 1);

  // Second sweep skips it.
  var sweep2 = await w.alerts.scanAndNotify({});
  check("opted-out second sweep no-op",       sweep2.notified === 0);
}

async function _scanAndNotifyWithoutNotificationsDepStillStamps() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-NN", { stock_on_hand: 3 });
  var sub = await w.alerts.subscribe({ email: "noop@example.com", sku: "SKU-NN" });
  await w.alerts.confirm({ token: sub.confirmation_token });

  var sweep = await w.alerts.scanAndNotify({});
  check("no-notif sweep notified the row",  sweep.notified === 1);
  check("no-notif sweep enqueued 0",        sweep.enqueued === 0);

  var live = await w.alerts.isSubscribed({ email: "noop@example.com", sku: "SKU-NN" });
  check("post-sweep status notified",        live.subscribed === true && live.status === "notified");
}

async function _scanAndNotifyScopedToSku() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-X", { stock_on_hand: 2 });
  await w.catalog.inventory.create("SKU-Y", { stock_on_hand: 2 });
  var subX = await w.alerts.subscribe({ email: "x@example.com", sku: "SKU-X" });
  await w.alerts.confirm({ token: subX.confirmation_token });
  var subY = await w.alerts.subscribe({ email: "y@example.com", sku: "SKU-Y" });
  await w.alerts.confirm({ token: subY.confirmation_token });

  var sweep = await w.alerts.scanAndNotify({ sku: "SKU-X" });
  check("scoped sweep scanned 1",  sweep.scanned === 1);
  check("scoped sweep notified 1", sweep.notified === 1);
  check("scoped sweep row sku",    sweep.rows[0].sku === "SKU-X");

  // SKU-Y row still pending after the scoped sweep.
  var yLive = await w.alerts.isSubscribed({ email: "y@example.com", sku: "SKU-Y" });
  check("scoped sweep left SKU-Y untouched", yLive.status === "confirmed");
}

async function _unsubscribeRemovesRow() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-U", { stock_on_hand: 0 });
  await w.alerts.subscribe({ email: "u@example.com", sku: "SKU-U" });

  var rv = await w.alerts.unsubscribe({ email: "u@example.com", sku: "SKU-U" });
  check("unsubscribe removed",        rv.removed === true);

  var sub2 = await w.alerts.isSubscribed({ email: "u@example.com", sku: "SKU-U" });
  check("post-unsub: not subscribed", sub2.subscribed === false);

  // Idempotent — second unsubscribe is no-op.
  var rv2 = await w.alerts.unsubscribe({ email: "u@example.com", sku: "SKU-U" });
  check("unsubscribe idempotent",     rv2.removed === false);

  // Case-insensitive email match.
  await w.alerts.subscribe({ email: "Dave@Example.com", sku: "SKU-U" });
  var rv3 = await w.alerts.unsubscribe({ email: "dave@example.com", sku: "SKU-U" });
  check("unsubscribe matches normalised email", rv3.removed === true);
}

async function _cleanupExpiredAndListSurfaces() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-L", { stock_on_hand: 0 });

  var now = Date.now();
  var customerId = bShop.framework.uuid.v4();
  // Two live (one with customer link).
  var live1 = await w.alerts.subscribe({ email: "live1@example.com", sku: "SKU-L", customer_id: customerId, now: now });
  await w.alerts.confirm({ token: live1.confirmation_token, now: now });
  var live2 = await w.alerts.subscribe({ email: "live2@example.com", sku: "SKU-L", now: now });
  await w.alerts.confirm({ token: live2.confirmation_token, now: now });

  // One expired — subscribed in the distant past, ttl already elapsed.
  var expiredNow = now - (1000 * 60 * 60 * 24 * 100);                    // 100 days ago, default TTL is 90 days
  await w.alerts.subscribe({ email: "expired@example.com", sku: "SKU-L", now: expiredNow });

  // listForSku surfaces the live rows only by default.
  var skuRows = await w.alerts.listForSku("SKU-L");
  check("listForSku returns 3 (un-notified)", skuRows.length === 3);

  var st = await w.alerts.stats({ now: now });
  check("stats.total = 3",       st.total === 3);
  check("stats.confirmed = 2",   st.confirmed === 2);
  check("stats.pending = 0",     st.pending === 0);
  check("stats.expired = 1",     st.expired === 1);
  check("stats.notified = 0",    st.notified === 0);

  // listForCustomer narrows to the linked customer.
  var custRows = await w.alerts.listForCustomer(customerId);
  check("listForCustomer returns 1",         custRows.length === 1);
  check("listForCustomer carries email norm", custRows[0].email_normalised === "live1@example.com");

  // cleanupExpired drops the expired row only.
  var clean = await w.alerts.cleanupExpired({ now: now });
  check("cleanupExpired removed 1",          clean.removed === 1);

  var skuRows2 = await w.alerts.listForSku("SKU-L");
  check("post-cleanup listForSku returns 2", skuRows2.length === 2);
}

async function _refusalsAndFactoryShape() {
  var w = _wire();
  await w.catalog.inventory.create("SKU-R", { stock_on_hand: 0 });

  // Bad emails.
  await assert.rejects(w.alerts.subscribe({ email: "not-an-email", sku: "SKU-R" }), /email/);
  await assert.rejects(w.alerts.subscribe({ email: "", sku: "SKU-R" }), /email/);
  // Bad SKUs.
  await assert.rejects(w.alerts.subscribe({ email: "ok@example.com", sku: "bad sku" }), /sku must match/);
  await assert.rejects(w.alerts.subscribe({ email: "ok@example.com", sku: "" }), /sku must match/);
  // Bad confirm token shape.
  await assert.rejects(w.alerts.confirm({ token: 123 }), /32 base64url characters/);
  await assert.rejects(w.alerts.confirm({}), /32 base64url characters/);
  // Bad limit.
  await assert.rejects(w.alerts.listForSku("SKU-R", { limit: 0 }), /limit must be/);
  await assert.rejects(w.alerts.listForSku("SKU-R", { limit: 9999 }), /limit must be/);
  // listForCustomer requires id.
  await assert.rejects(w.alerts.listForCustomer(null), /customer_id required/);
  await assert.rejects(w.alerts.listForCustomer("not-a-uuid"), /customer_id/);

  // Factory rejects missing / mis-shaped catalog.
  assert.throws(function () { stockAlerts.create({ query: w.query }); }, /catalog/);
  assert.throws(function () { stockAlerts.create({ query: w.query, catalog: {} }); }, /catalog/);
  // Factory rejects mis-shaped notifications dep.
  assert.throws(
    function () { stockAlerts.create({ query: w.query, catalog: w.catalog, notifications: { not: "shaped" } }); },
    /notifications must expose/,
  );
  // Bad ttl_ms at factory.
  assert.throws(function () { stockAlerts.create({ query: w.query, catalog: w.catalog, ttl_ms: -1 }); }, /ttl_ms/);

  // Stats with bad now.
  await assert.rejects(w.alerts.stats({ now: -1 }), /now must be/);
}

async function _resubscribeAfterNotificationMintsFreshToken() {
  // Once a notification has fired, the row is terminal. A fresh
  // subscribe must mint a new row with a fresh token.
  var w = _wire();
  await w.catalog.inventory.create("SKU-RS", { stock_on_hand: 4 });
  var first = await w.alerts.subscribe({ email: "rs@example.com", sku: "SKU-RS" });
  await w.alerts.confirm({ token: first.confirmation_token });

  var sweep = await w.alerts.scanAndNotify({});
  check("notification fired",                sweep.notified === 1);

  // Drain inventory back to zero so we don't immediately re-fire.
  await w.query("UPDATE inventory SET stock_on_hand = 0 WHERE sku = ?1", ["SKU-RS"]);

  var second = await w.alerts.subscribe({ email: "rs@example.com", sku: "SKU-RS" });
  check("re-subscribe after notified → fresh row", second.status === "subscribed");
  check("re-subscribe mints fresh id",             second.id !== first.id);
  check("re-subscribe mints fresh token",          typeof second.confirmation_token === "string" && second.confirmation_token !== first.confirmation_token);
}

async function run() {
  await _subscribeMintsToken();
  await _subscribeDedupesAndDoesNotRevealToken();
  await _confirmTransitionsPendingToConfirmed();
  await _scanAndNotifyFiresWhenInventoryAvailable();
  await _scanAndNotifyHandlesOptedOutWithoutRetrying();
  await _scanAndNotifyWithoutNotificationsDepStillStamps();
  await _scanAndNotifyScopedToSku();
  await _unsubscribeRemovesRow();
  await _cleanupExpiredAndListSurfaces();
  await _refusalsAndFactoryShape();
  await _resubscribeAfterNotificationMintsFreshToken();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("stock-alerts.test: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("stock-alerts.test: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
