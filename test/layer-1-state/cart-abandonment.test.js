"use strict";
/**
 * cart-abandonment — scheduled scanner over the carts table.
 *
 * Layer 1 against in-memory node:sqlite loaded from migrations
 * 0001 (catalog), 0002 (cart), 0031 (cart-abandonment). The scanner
 * is invoked directly; the cart primitive seeds idle / fresh /
 * lines-only carts so each gate exercises a real shipped surface.
 *
 * Coverage:
 *   - scan: happy path — 3 candidates detected, 1 already-detected
 *     dedup, 1 fresh cart skipped, 1 empty cart skipped, 1
 *     too-old-to-bother cart skipped
 *   - markReminderSent / markReminderSkipped / markReminderFailed
 *     transitions are terminal and idempotent
 *   - recentDetections: pagination + status filter + HMAC cursor
 *   - statsForRun: returns counts + status for a specific run
 *   - cleanupOld: deletes detection rows older than ts
 *   - refusals: negative thresholds, missing required deps, bad
 *     reason, bad detection_id, bad cursor
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0031_cart_abandonment_runs.sql"].map(function (f) {
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
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  function query(sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return Promise.resolve({
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      });
    }
    var rows = stmt.all.apply(stmt, params || []);
    return Promise.resolve({ rows: rows, rowCount: rows.length });
  }
  query.raw = db;
  return query;
}

async function _setupCatalog(catalog) {
  var p = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", status: "active" });
  var v1 = await catalog.variants.create(p.id, { sku: "WDG-PRO-A" });
  var v2 = await catalog.variants.create(p.id, { sku: "WDG-PRO-B" });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  await catalog.prices.set(v2.id, { currency: "USD", amount_minor: 1500 });
  return { v1: v1, v2: v2 };
}

function _newSessionId() {
  return "sess_" + Math.random().toString(36).slice(2, 14).padEnd(12, "x");
}

// Backdate a cart's `updated_at` (and every line's `updated_at` /
// `added_at`) so the scanner's idle-window predicate fires. The
// cart primitive stamps "now" on every mutation; tests need to pin
// the rows to specific epochs to exercise the threshold logic.
async function _backdateCart(query, cartId, updatedAt) {
  await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [updatedAt, cartId]);
  await query("UPDATE cart_lines SET added_at = ?1, updated_at = ?1 WHERE cart_id = ?2", [updatedAt, cartId]);
}

async function _seedIdleCartWithLines(cart, catalog, variant, hoursIdle) {
  var sid = _newSessionId();
  var c = await cart.create(sid, { currency: "USD" });
  await cart.addLine(c.id, { variant_id: variant.id, qty: 2 });
  var idleSince = Date.now() - hoursIdle * 60 * 60 * 1000;
  // Cart primitive doesn't expose a backdate hook by design — call
  // the raw query that ships in the same shape the primitive uses.
  var query = catalog._testQuery;
  await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [idleSince, c.id]);
  await query("UPDATE cart_lines SET added_at = ?1, updated_at = ?1 WHERE cart_id = ?2", [idleSince, c.id]);
  return { id: c.id, session_id: sid, idle_since: idleSince };
}

// Attach the raw query function to catalog so the helper above can
// reach it; the catalog primitive doesn't normally expose it, but
// the test owns both sides of the wire here.
function _wireTestQuery(catalog, query) {
  catalog._testQuery = query;
}

// ---- scenarios ----------------------------------------------------------

async function _scanHappyPathWithDedup() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  _wireTestQuery(catalog, query);
  var fix = await _setupCatalog(catalog);

  // Three idle carts (>= 24h) that should detect.
  var idle1 = await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);
  var idle2 = await _seedIdleCartWithLines(cart, catalog, fix.v1, 48);
  var idle3 = await _seedIdleCartWithLines(cart, catalog, fix.v2, 30);

  // One fresh cart (< 24h) that should NOT detect.
  var freshSid = _newSessionId();
  var fresh = await cart.create(freshSid, { currency: "USD" });
  await cart.addLine(fresh.id, { variant_id: fix.v1.id, qty: 1 });
  // updated_at stays at "now" → outside the idle window.

  // One empty idle cart (no lines) that should NOT detect.
  var emptySid = _newSessionId();
  var empty = await cart.create(emptySid, { currency: "USD" });
  await query("UPDATE carts SET updated_at = ?1 WHERE id = ?2", [Date.now() - 26 * 60 * 60 * 1000, empty.id]);

  // One ancient cart (> 30 day max_age) that should NOT detect.
  var ancientSid = _newSessionId();
  var ancient = await cart.create(ancientSid, { currency: "USD" });
  await cart.addLine(ancient.id, { variant_id: fix.v2.id, qty: 1 });
  await _backdateCart(query, ancient.id, Date.now() - 40 * 24 * 60 * 60 * 1000);

  var abandon = bShop.cartAbandonment.create({ query: query, cart: cart });

  var first = await abandon.scan({});
  check("scan returns run_id (uuid)",      typeof first.run_id === "string" && first.run_id.length > 0);
  // 3 idle carts with lines + 1 idle empty cart = 4 scanned (the
  // empty cart is walked but skipped because it has no lines; the
  // fresh cart is filtered by the idle predicate, the ancient cart
  // by the max_age predicate, so neither reaches the scan loop).
  check("scan reports 4 carts scanned",    first.carts_scanned === 4);
  check("scan reports 3 carts detected",   first.carts_detected === 3);
  check("scan returns 3 candidates",       first.candidates.length === 3);

  var ids = first.candidates.map(function (c) { return c.cart_id; });
  check("idle1 detected", ids.indexOf(idle1.id) !== -1);
  check("idle2 detected", ids.indexOf(idle2.id) !== -1);
  check("idle3 detected", ids.indexOf(idle3.id) !== -1);
  check("fresh NOT detected", ids.indexOf(fresh.id) === -1);
  check("empty NOT detected", ids.indexOf(empty.id) === -1);
  check("ancient NOT detected", ids.indexOf(ancient.id) === -1);

  // Candidate payload shape: detection_id + subtotal_minor +
  // line_count + currency. For idle1 (qty 2 of v1 @ 2999) the
  // subtotal is 5998.
  var c1 = first.candidates.filter(function (c) { return c.cart_id === idle1.id; })[0];
  check("candidate has detection_id",   typeof c1.detection_id === "string" && c1.detection_id.length > 0);
  check("candidate line_count is 1",    c1.line_count === 1);
  check("candidate subtotal is qty * unit",  c1.subtotal_minor === 5998);
  check("candidate currency echoed",    c1.subtotal_currency === "USD");

  // Re-running the scan within the same idle window must NOT
  // re-detect any of the three carts — they're still inside the
  // 24h dedup window since their last detection.
  var second = await abandon.scan({});
  check("second scan: 4 carts re-walked",                 second.carts_scanned === 4);
  check("second scan: 0 NEW detections (dedup)",          second.carts_detected === 0);
  check("second scan: empty candidate list",              second.candidates.length === 0);

  // The detection rows from the first run are still in place — no
  // double-write happened.
  var allDet = (await query("SELECT id FROM cart_abandonment_detections")).rows;
  check("detection table still has 3 rows after re-scan",  allDet.length === 3);

  // Session id never lands raw — confirm via direct table read.
  var raw = (await query("SELECT session_id_hash FROM cart_abandonment_detections WHERE cart_id = ?1", [idle1.id])).rows[0];
  check("session_id is hashed, not raw",  raw.session_id_hash !== idle1.session_id);
  check("session_id_hash is non-empty",   typeof raw.session_id_hash === "string" && raw.session_id_hash.length >= 16);
}

async function _reminderTransitions() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  _wireTestQuery(catalog, query);
  var fix = await _setupCatalog(catalog);

  var i1 = await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);
  var i2 = await _seedIdleCartWithLines(cart, catalog, fix.v2, 25);
  var i3 = await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);

  var abandon = bShop.cartAbandonment.create({ query: query, cart: cart });
  var first = await abandon.scan({});
  check("transitions: 3 candidates",  first.candidates.length === 3);

  var byCart = {};
  first.candidates.forEach(function (c) { byCart[c.cart_id] = c; });

  // markReminderSent — pending → sent
  var sent = await abandon.markReminderSent(byCart[i1.id].detection_id, { sent_at: 1700000000000 });
  check("markReminderSent: changed=true",      sent.changed === true);
  var sentRow = await abandon._getDetection(byCart[i1.id].detection_id);
  check("markReminderSent: status=sent",        sentRow.reminder_status === "sent");
  check("markReminderSent: sent_at stamped",    sentRow.reminder_sent_at === 1700000000000);

  // Idempotent re-call: row is no longer pending → changed=false
  var sentAgain = await abandon.markReminderSent(byCart[i1.id].detection_id);
  check("markReminderSent idempotent",          sentAgain.changed === false);

  // markReminderSkipped — pending → skipped-no-email
  var skipNoEmail = await abandon.markReminderSkipped(byCart[i2.id].detection_id, { reason: "no-email" });
  check("markReminderSkipped no-email: changed", skipNoEmail.changed === true);
  check("markReminderSkipped no-email: status",  skipNoEmail.status === "skipped-no-email");
  var skipNoEmailRow = await abandon._getDetection(byCart[i2.id].detection_id);
  check("skipped row carries reason",            skipNoEmailRow.reminder_skipped_reason === "no-email");

  // markReminderFailed — pending → failed
  var failed = await abandon.markReminderFailed(byCart[i3.id].detection_id, { error: "smtp connect refused" });
  check("markReminderFailed: changed=true",     failed.changed === true);
  var failedRow = await abandon._getDetection(byCart[i3.id].detection_id);
  check("markReminderFailed: status=failed",     failedRow.reminder_status === "failed");
  check("markReminderFailed: error stored",      failedRow.reminder_skipped_reason === "smtp connect refused");

  // Suppressed reason routes to skipped-suppressed status (distinct
  // from skipped-no-email for dashboard splits).
  var i4 = await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);
  var second = await abandon.scan({});
  var c4 = second.candidates.filter(function (c) { return c.cart_id === i4.id; })[0];
  var skipSupp = await abandon.markReminderSkipped(c4.detection_id, { reason: "suppressed" });
  check("markReminderSkipped suppressed: status", skipSupp.status === "skipped-suppressed");
}

async function _recentDetectionsPagination() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  _wireTestQuery(catalog, query);
  var fix = await _setupCatalog(catalog);

  // Seed 7 idle carts so a limit:3 paginate-through covers 3 pages
  // (3 + 3 + 1).
  for (var i = 0; i < 7; i += 1) {
    await _seedIdleCartWithLines(cart, catalog, fix.v1, 25 + i);
    // Yield so the scan's detected_at differs across rows (the
    // cursor tie-breaker on id handles same-ms rows but ordering
    // is easier to assert when detected_at is strictly distinct).
    await new Promise(function (r) { setImmediate(r); });
  }

  var abandon = bShop.cartAbandonment.create({ query: query, cart: cart });
  await abandon.scan({});

  // Page 1
  var page1 = await abandon.recentDetections({ limit: 3 });
  check("recentDetections page 1: 3 rows",       page1.rows.length === 3);
  check("recentDetections page 1: nextCursor set", typeof page1.nextCursor === "string" && page1.nextCursor.length > 0);

  // Page 2
  var page2 = await abandon.recentDetections({ limit: 3, cursor: page1.nextCursor });
  check("recentDetections page 2: 3 rows",       page2.rows.length === 3);
  check("page2 distinct from page1",              page2.rows[0].id !== page1.rows[0].id);

  // Page 3 — final 1 row, nextCursor null
  var page3 = await abandon.recentDetections({ limit: 3, cursor: page2.nextCursor });
  check("recentDetections page 3: 1 row",        page3.rows.length === 1);
  check("recentDetections page 3: nextCursor null", page3.nextCursor === null);

  // Newest-first ordering across the full set
  var all = page1.rows.concat(page2.rows).concat(page3.rows);
  for (var k = 1; k < all.length; k += 1) {
    check("recentDetections sorted detected_at DESC",
      all[k - 1].detected_at >= all[k].detected_at);
  }

  // Status filter narrows the result set.
  await abandon.markReminderSent(page1.rows[0].id);
  await abandon.markReminderSent(page1.rows[1].id);
  var sentOnly = await abandon.recentDetections({ status: "sent" });
  check("recentDetections status=sent: 2 rows",  sentOnly.rows.length === 2);
  check("status filter restricts to sent rows", sentOnly.rows.every(function (r) {
    return r.reminder_status === "sent";
  }));
  var pendingOnly = await abandon.recentDetections({ status: "pending" });
  check("recentDetections status=pending: 5 rows", pendingOnly.rows.length === 5);
}

async function _statsForRun() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  _wireTestQuery(catalog, query);
  var fix = await _setupCatalog(catalog);

  await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);
  await _seedIdleCartWithLines(cart, catalog, fix.v2, 25);

  var abandon = bShop.cartAbandonment.create({ query: query, cart: cart });
  var r = await abandon.scan({});

  var stats = await abandon.statsForRun(r.run_id);
  check("statsForRun: id round-trips",          stats.id === r.run_id);
  check("statsForRun: status=completed",         stats.status === "completed");
  check("statsForRun: carts_scanned counter",    stats.carts_scanned === 2);
  check("statsForRun: carts_detected counter",   stats.carts_detected === 2);
  check("statsForRun: reminders_sent starts 0",  stats.reminders_sent === 0);
  check("statsForRun: started_at integer",       Number.isInteger(stats.started_at));
  check("statsForRun: finished_at integer",      Number.isInteger(stats.finished_at));
  check("statsForRun: detections_in_window 2",   stats.detections_in_window === 2);

  // Mark a reminder sent → reminders_sent bumps on the owning run.
  await abandon.markReminderSent(r.candidates[0].detection_id);
  var statsAfter = await abandon.statsForRun(r.run_id);
  check("statsForRun: reminders_sent bumped",    statsAfter.reminders_sent === 1);

  // Unknown run → null
  var none = await abandon.statsForRun(bShop.framework.uuid.v7());
  check("statsForRun unknown returns null",     none === null);
}

async function _cleanupOld() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  _wireTestQuery(catalog, query);
  var fix = await _setupCatalog(catalog);

  await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);
  await _seedIdleCartWithLines(cart, catalog, fix.v2, 25);
  await _seedIdleCartWithLines(cart, catalog, fix.v1, 25);

  var abandon = bShop.cartAbandonment.create({ query: query, cart: cart });
  await abandon.scan({});

  // Backdate two detections so cleanupOld(before_ts = now-1d)
  // deletes them.
  var allBefore = (await query("SELECT id FROM cart_abandonment_detections")).rows;
  check("cleanup setup: 3 detections",  allBefore.length === 3);

  var oldTs = Date.now() - 5 * 24 * 60 * 60 * 1000;
  await query(
    "UPDATE cart_abandonment_detections SET detected_at = ?1 WHERE id IN (?2, ?3)",
    [oldTs, allBefore[0].id, allBefore[1].id],
  );

  var deleted = await abandon.cleanupOld({ before_ts: Date.now() - 24 * 60 * 60 * 1000 });
  check("cleanupOld returns deleted=2",  deleted.deleted === 2);

  var allAfter = (await query("SELECT id FROM cart_abandonment_detections")).rows;
  check("cleanupOld actually removes",   allAfter.length === 1);
}

async function _refusals() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  _wireTestQuery(catalog, query);

  // Factory: missing required cart dep
  assert.throws(function () { bShop.cartAbandonment.create({ query: query }); },
    /opts\.cart \(cart primitive\) is required/);

  // Factory: mis-shaped customers dep — must be an object
  assert.throws(function () { bShop.cartAbandonment.create({ query: query, cart: cart, customers: "not-an-object" }); },
    /customers must be an object/);

  // Factory: mis-shaped suppression dep — must expose isSuppressed
  assert.throws(function () { bShop.cartAbandonment.create({ query: query, cart: cart, emailSuppressions: { nope: true } }); },
    /isSuppressed/);

  var abandon = bShop.cartAbandonment.create({ query: query, cart: cart });

  // scan: negative / zero thresholds refused
  await assert.rejects(abandon.scan({ idle_threshold_ms: -1 }),  /idle_threshold_ms must be a positive integer/);
  await assert.rejects(abandon.scan({ idle_threshold_ms: 0 }),   /idle_threshold_ms must be a positive integer/);
  await assert.rejects(abandon.scan({ max_age_ms: -10 }),         /max_age_ms must be a positive integer/);
  await assert.rejects(abandon.scan({ max_age_ms: 1.5 }),         /max_age_ms must be a positive integer/);
  await assert.rejects(abandon.scan({ max_carts: 0 }),            /max_carts must be an integer/);
  await assert.rejects(abandon.scan({ max_carts: 99999 }),        /max_carts must be an integer/);

  // scan: idle must be < max_age
  await assert.rejects(
    abandon.scan({ idle_threshold_ms: 10 * 60 * 60 * 1000, max_age_ms: 5 * 60 * 60 * 1000 }),
    /idle_threshold_ms must be strictly less than max_age_ms/,
  );

  // mark*: bad detection_id shapes
  await assert.rejects(abandon.markReminderSent("not-a-uuid"),               /detection_id/);
  await assert.rejects(abandon.markReminderSkipped("not-a-uuid", { reason: "no-email" }), /detection_id/);
  await assert.rejects(abandon.markReminderFailed("not-a-uuid", { error: "x" }),          /detection_id/);

  // mark*: bad sent_at
  await assert.rejects(abandon.markReminderSent(bShop.framework.uuid.v7(), { sent_at: -1 }),  /sent_at/);
  await assert.rejects(abandon.markReminderSent(bShop.framework.uuid.v7(), { sent_at: 1.5 }), /sent_at/);

  // mark*: bad / missing skip reason
  await assert.rejects(abandon.markReminderSkipped(bShop.framework.uuid.v7(), {}),               /reason/);
  await assert.rejects(abandon.markReminderSkipped(bShop.framework.uuid.v7(), { reason: "ohno" }), /reason must be one of/);

  // markReminderFailed: missing / bad error
  await assert.rejects(abandon.markReminderFailed(bShop.framework.uuid.v7(), {}),                 /error/);
  await assert.rejects(abandon.markReminderFailed(bShop.framework.uuid.v7(), { error: "" }),       /error/);
  await assert.rejects(abandon.markReminderFailed(bShop.framework.uuid.v7(), { error: "bad\x00" }), /control bytes/);

  // recentDetections: bad status / limit / cursor
  await assert.rejects(abandon.recentDetections({ status: "garbage" }),  /status must be one of/);
  await assert.rejects(abandon.recentDetections({ limit: 0 }),            /limit must be/);
  await assert.rejects(abandon.recentDetections({ limit: 9999 }),         /limit must be/);
  await assert.rejects(abandon.recentDetections({ cursor: "tampered" }),  /cursor/);

  // cleanupOld: missing before_ts
  await assert.rejects(abandon.cleanupOld({}),                            /before_ts/);
  await assert.rejects(abandon.cleanupOld({ before_ts: -1 }),             /before_ts/);
}

async function run() {
  await _scanHappyPathWithDedup();
  await _reminderTransitions();
  await _recentDetectionsPagination();
  await _statsForRun();
  await _cleanupOld();
  await _refusals();
}

module.exports = { run: run };
