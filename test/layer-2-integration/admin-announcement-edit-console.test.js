"use strict";
/**
 * Announcement-bar edit console — the browser-side detail + edit screen.
 *
 * Boots b.createApp with admin.mount wired to the announcementBar
 * primitive, seeds a live announcement, then drives the detail screen
 * (GET /admin/announcements/:slug) and the edit path
 * (POST /admin/announcements/:slug/edit, browser + bearer JSON). The
 * edit changes the MESSAGE — a field the console previously had no way
 * to reach (the list offered only create + archive, so a typo fix meant
 * archive-and-recreate, discarding the slug + dismissal state). Asserts
 * the change persisted via announcementBar.getAnnouncement, the slug is
 * preserved, the response status is clean, no raw error text leaks, and
 * a bad-shape edit is a clean 400. Network: zero.
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

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql", "0180_announcement_bar.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "ann-edit" });
  var config  = bShop.config.create({ query: query });
  var announcementBar = bShop.announcementBar.create({ query: query });

  // Seed a live, dismissible announcement with a typo in the message.
  await announcementBar.defineAnnouncement({
    slug: "spring-sale", message: "Sprint sale — 20% off",
    theme: "promo", audience: "all", dismissible: true,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ann-edit-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, announcementBar: announcementBar, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // The list now offers an Edit affordance per row (write-but-no-edit
    // closed) — the link targets the detail screen.
    var list = await helpers.httpRequest({ port: port, path: "/admin/announcements", jar: jar });
    check("list then 200",                       list.status === 200);
    check("list shows an Edit affordance",       list.body.indexOf("/admin/announcements/spring-sale\">Edit") !== -1);

    // Detail screen renders the edit form, prefilled with the message.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/announcements/spring-sale", jar: jar });
    check("detail then 200",                     detail.status === 200);
    check("detail prefills the message",         detail.body.indexOf("Sprint sale — 20% off") !== -1);
    check("detail posts to the edit route",      detail.body.indexOf("/admin/announcements/spring-sale/edit") !== -1);

    // Edit the message (the field the console could not reach before) →
    // PRG to the detail screen with ?updated, change persists, slug kept.
    var edit = await helpers.httpRequest({
      port: port, path: "/admin/announcements/spring-sale/edit", method: "POST", jar: jar,
      form: {
        message: "Spring sale — 20% off", theme: "promo", audience: "all",
        dismissible_present: "1", dismissible: "on",
        link_present: "1", link_url: "", link_label: "",
        starts_present: "1", starts_at: "", expires_present: "1", expires_at: "",
      },
    });
    check("edit then 303",                       edit.status === 303);
    check("edit redirects with ?updated",        (edit.headers.location || "").indexOf("updated=1") !== -1);
    check("edit keeps the same slug in PRG",     (edit.headers.location || "").indexOf("/admin/announcements/spring-sale") !== -1);
    var after = await announcementBar.getAnnouncement("spring-sale");
    check("message persisted (typo fixed)",      after && after.message === "Spring sale — 20% off");
    check("slug preserved across the edit",      after && after.slug === "spring-sale");
    check("archived_at still null (not recreate)", after && after.archived_at == null);

    // The ?updated detail render shows the ok banner, no error leak.
    var afterPage = await helpers.httpRequest({ port: port, path: "/admin/announcements/spring-sale?updated=1", jar: jar });
    check("updated banner shown",                afterPage.body.indexOf("Announcement updated.") !== -1);
    check("no raw error text on the page",       afterPage.body.indexOf("announcementBar.updateAnnouncement") === -1);

    // Edit can also extend the expiry — a previously-unreachable field.
    var futureExp = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 16);
    var extend = await helpers.httpRequest({
      port: port, path: "/admin/announcements/spring-sale/edit", method: "POST", jar: jar,
      form: {
        message: "Spring sale — 20% off", theme: "promo", audience: "all",
        dismissible_present: "1", dismissible: "on",
        link_present: "1", link_url: "", link_label: "",
        starts_present: "1", starts_at: "", expires_present: "1", expires_at: futureExp,
      },
    });
    check("extend expiry then 303",              extend.status === 303);
    var afterExp = await announcementBar.getAnnouncement("spring-sale");
    check("expiry persisted",                    afterExp && afterExp.expires_at != null);

    // Bearer JSON edit path returns 200 JSON (the API contract).
    var apiEdit = await helpers.httpRequest({
      port: port, path: "/admin/announcements/spring-sale/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ message: "Spring sale — now 25% off" }),
    });
    check("bearer edit returns 200 JSON",        apiEdit.status === 200 && (apiEdit.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer edit persisted",               (await announcementBar.getAnnouncement("spring-sale")).message === "Spring sale — now 25% off");

    // Bad-shape edit (empty message via bearer JSON) is a clean 4xx with
    // no raw error leak in the bearer body, not a 500.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/announcements/spring-sale/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ message: "" }),
    });
    check("bad edit then 4xx",                    bad.status >= 400 && bad.status < 500);

    // Unknown slug via the browser → err notice redirect, never a 500.
    var miss = await helpers.httpRequest({
      port: port, path: "/admin/announcements/does-not-exist/edit", method: "POST", jar: jar,
      form: { message: "x", theme: "info", audience: "all", dismissible_present: "1" },
    });
    check("unknown-slug edit then 303",          miss.status === 303);
    check("unknown-slug flags err",              (miss.headers.location || "").indexOf("err=1") !== -1);

    // Detail JSON over bearer is unchanged for tooling.
    var apiGet = await helpers.httpRequest({ port: port, path: "/admin/announcements/spring-sale", headers: bearer });
    check("detail API JSON",                      (apiGet.headers["content-type"] || "").indexOf("application/json") === 0);

    // Anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/announcements/spring-sale" });
    check("anon detail → login form",            anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
