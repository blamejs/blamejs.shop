"use strict";
/**
 * Announcement bar — full HTTP integration of the sitewide promo/notice
 * strip.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * announcementBar dep, against one in-memory `node:sqlite` DB loaded from
 * the live migrations. The active announcement is resolved per request from
 * a short-TTL in-memory cache refreshed off the request path, so the first
 * page view primes the cache and a poll (`helpers.waitUntil`) waits for the
 * bar to appear — no fixed sleep.
 *
 * Verifies the bar renders for its audience, carries the dismiss affordance
 * + the island, that the server render is dismissal-AGNOSTIC (the island
 * hides dismissed bars client-side, so a cached page stays correct), that
 * the dismiss POST sets the hint cookie + 303s back, and that archiving a
 * row drops it from the active set.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0180_announcement_bar.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-ann-"));
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
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var announcementBar = bShop.announcementBar.create({ query: query });

  // A live, dismissible, audience-all promo announcement.
  await announcementBar.defineAnnouncement({
    slug:        "launch-sale",
    message:     "Launch week — free post-quantum stickers with every order.",
    link_url:    "/collections/launch",
    link_label:  "Shop the launch",
    theme:       "promo",
    audience:    "all",
    dismissible: true,
  });

  var handle = await _bootApp({ catalog: catalog, cart: cart, announcementBar: announcementBar });

  try {
    // The active row is served from a cache primed off the request path, so
    // the first view kicks the refresh and the bar appears shortly after.
    var homeBody = "";
    await helpers.waitUntil(async function () {
      var r = await helpers.httpRequest({ port: handle.port, path: "/" });
      homeBody = r.body;
      return homeBody.indexOf("data-announcement-slug=\"launch-sale\"") !== -1;
    }, { timeoutMs: 5000, label: "announcement-bar: bar appears on the home page" });

    check("bar renders the message",            homeBody.indexOf("Launch week — free post-quantum stickers with every order.") !== -1);
    check("bar uses the promo theme class",     homeBody.indexOf("announcement-bar--promo") !== -1);
    check("bar renders the link",               /class="announcement-bar__link" href="\/collections\/launch"/.test(homeBody));
    check("bar carries the dismiss form",       homeBody.indexOf("action=\"/announcements/launch-sale/dismiss\"") !== -1);
    check("dismiss island is loaded",           homeBody.indexOf("id=\"announcement-island\"") !== -1);

    // A javascript: link would be refused at the sink — assert the only
    // emitted href scheme here is the safe one (no inline-JS href anywhere).
    check("no javascript: scheme in output",    homeBody.toLowerCase().indexOf("href=\"javascript:") === -1);

    // Dismiss (no-JS path): records + sets the hint cookie + 303s back.
    var dismissed = await helpers.httpRequest({
      port: handle.port, path: "/announcements/launch-sale/dismiss",
      method: "POST", form: { return_to: "/" },
    });
    check("dismiss → 303",                      dismissed.status === 303);
    check("dismiss → back to /",                (dismissed.headers["location"] || "") === "/");
    var setCookie = String(dismissed.headers["set-cookie"] || "");
    check("dismiss sets the hint cookie",       /shop_ann_dismissed=[^;]*launch-sale/.test(setCookie));

    // Design invariant: the SERVER render is dismissal-agnostic — the bar
    // is still in the markup after a dismiss (the island hides it per the
    // cookie), so a shared edge cache keyed on URL stays correct.
    var afterDismiss = await helpers.httpRequest({ port: handle.port, path: "/" });
    check("server render stays dismissal-agnostic", afterDismiss.body.indexOf("data-announcement-slug=\"launch-sale\"") !== -1);

    // Archiving drops it from the active set the renderer reads.
    await announcementBar.archiveAnnouncement("launch-sale");
    var active = await announcementBar.listAnnouncements({ active_only: true });
    check("archived row leaves the active set", active.every(function (a) { return a.slug !== "launch-sale"; }));
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
