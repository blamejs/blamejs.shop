"use strict";
/**
 * Business hours — HTTP integration of the public /hours page + the
 * primitive's deterministic open/closed math.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * businessHours dep, against one in-memory `node:sqlite` DB. An operator
 * defines a Mon–Fri 09:00–17:00 (UTC) schedule; /hours renders the week
 * grid + a live status. The open/closed determination is verified directly
 * against the primitive with pinned timestamps (the page's own status is
 * wall-clock dependent, so the page test asserts structure, not the live
 * state).
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0127_business_hours.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-hrs-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var hours   = bShop.businessHours.create({ query: query });

  // Open weekdays (Mon=1 .. Fri=5) 09:00–17:00 UTC; closed weekends.
  var weekly = [];
  for (var dy = 1; dy <= 5; dy += 1) weekly.push({ day: dy, open: "09:00", close: "17:00" });
  await hours.defineSchedule({ slug: "support", timezone: "Etc/UTC", weekly_hours: weekly });

  // Deterministic open/closed math (pinned timestamps, no wall clock).
  var monNoon = Date.UTC(2024, 0, 1, 12, 0); // 2024-01-01 is a Monday
  var monEarly = Date.UTC(2024, 0, 1, 7, 0);
  var sunNoon = Date.UTC(2024, 0, 7, 12, 0); // 2024-01-07 is a Sunday
  check("open Mon 12:00 UTC",                  (await hours.isOpenAt({ slug: "support", when: monNoon })) === true);
  check("closed Mon 07:00 (before open)",      (await hours.isOpenAt({ slug: "support", when: monEarly })) === false);
  check("closed Sun (no weekend hours)",       (await hours.isOpenAt({ slug: "support", when: sunNoon })) === false);
  var nextOpen = await hours.nextOpenAt({ slug: "support", when: monEarly });
  check("nextOpenAt Mon-early → 09:00",        nextOpen && nextOpen.open === "09:00");

  var handle = await _bootApp({ catalog: catalog, cart: cart, businessHours: hours });
  try {
    var page = await helpers.httpRequest({ port: handle.port, path: "/hours" });
    check("/hours → 200",                        page.status === 200);
    check("/hours shows the schedule",           page.body.indexOf("support") !== -1);
    check("/hours shows the weekday hours",       page.body.indexOf("09:00–17:00") !== -1);
    check("/hours shows the timezone",           page.body.indexOf("UTC") !== -1);
    check("/hours shows weekend as closed",       page.body.indexOf("Closed") !== -1);
    check("/hours shows a live status pill",      page.body.indexOf("hours-status") !== -1);
    check("/hours lists day names",              page.body.indexOf("Monday") !== -1 && page.body.indexOf("Sunday") !== -1);

    // Archive → drops off the active list the page reads.
    await hours.archiveSchedule("support");
    var after = await helpers.httpRequest({ port: handle.port, path: "/hours" });
    check("archived schedule → not published notice", after.body.indexOf("haven't been published") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
