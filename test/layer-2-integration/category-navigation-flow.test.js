"use strict";
/**
 * Category navigation — full HTTP integration of the public browse pages.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * categoryNavigation dep, against one in-memory `node:sqlite` DB loaded
 * from the live migrations. Public pages (no auth). Seeds a small
 * category tree (outdoors > tents > family-tents, plus a sibling
 * "empty" category with no children) through the primitive's write path
 * and exercises /categories, /categories/:slug, breadcrumbs, an empty
 * category, and the unknown / malformed-slug failure modes (404, never
 * 500).
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0201_category_navigation.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-cat-"));
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
  var categoryNavigation = bShop.categoryNavigation.create({ query: query, catalog: catalog });

  // Seed a small tree through the real write path:
  //   outdoors                  (top-level)
  //     └─ tents
  //          └─ family-tents
  //   apparel                   (top-level, no children — empty state)
  //   archived-line             (top-level, then archived — hidden)
  await categoryNavigation.defineCategory({ slug: "outdoors", title: "Outdoors", description: "Gear for the wild." });
  await categoryNavigation.defineCategory({ slug: "tents", parent_slug: "outdoors", title: "Tents" });
  await categoryNavigation.defineCategory({ slug: "family-tents", parent_slug: "tents", title: "Family Tents", description: "Room for everyone." });
  await categoryNavigation.defineCategory({ slug: "apparel", title: "Apparel" });
  await categoryNavigation.defineCategory({ slug: "archived-line", title: "Discontinued" });
  await categoryNavigation.archive({ slug: "archived-line" });

  var handle = await _bootApp({ catalog: catalog, cart: cart, categoryNavigation: categoryNavigation });

  try {
    // Index lists the active top-level categories, hides the archived one.
    var index = await helpers.httpRequest({ port: handle.port, path: "/categories" });
    check("categories index then 200",          index.status === 200);
    check("index shows a top-level category",    index.body.indexOf("Outdoors") !== -1);
    check("index shows the empty top-level",     index.body.indexOf("Apparel") !== -1);
    check("index links to a category",           index.body.indexOf("/categories/outdoors") !== -1);
    check("index hides the archived category",   index.body.indexOf("Discontinued") === -1);

    // A category page shows its direct child sub-categories.
    var outdoors = await helpers.httpRequest({ port: handle.port, path: "/categories/outdoors" });
    check("category page then 200",              outdoors.status === 200);
    check("category page shows its title",       outdoors.body.indexOf("Outdoors") !== -1);
    check("category page lists a child",         outdoors.body.indexOf("Tents") !== -1);
    check("category page links to the child",    outdoors.body.indexOf("/categories/tents") !== -1);

    // A deep category renders the full breadcrumb chain root -> current.
    var family = await helpers.httpRequest({ port: handle.port, path: "/categories/family-tents" });
    check("deep category then 200",              family.status === 200);
    check("breadcrumb links to the root",        family.body.indexOf("/categories/outdoors") !== -1);
    check("breadcrumb links to the parent",      family.body.indexOf("/categories/tents") !== -1);
    check("breadcrumb marks current page",       family.body.indexOf("aria-current=\"page\">Family Tents") !== -1);

    // An empty category (no children) renders a graceful empty state.
    var apparel = await helpers.httpRequest({ port: handle.port, path: "/categories/apparel" });
    check("empty category then 200",             apparel.status === 200);
    check("empty category shows empty state",    apparel.body.indexOf("No sub-categories here yet.") !== -1);

    // An archived category is hidden — 404, not a 500.
    var archived = await helpers.httpRequest({ port: handle.port, path: "/categories/archived-line" });
    check("archived category then 404",          archived.status === 404);

    // Unknown category then 404.
    var unknown = await helpers.httpRequest({ port: handle.port, path: "/categories/does-not-exist" });
    check("unknown category then 404",           unknown.status === 404);

    // A malformed slug must be a 404, not a 500 (getCategory throws a
    // TypeError on the bad shape; the route catches it).
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/categories/" + encodeURIComponent("bad slug!!") });
    check("malformed slug then 404",             malformed.status === 404);

    // Footer surfaces the categories link (reachability).
    check("footer links to /categories",         index.body.indexOf("/categories\">Categories") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
