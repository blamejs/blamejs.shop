"use strict";
/**
 * Collections — full HTTP integration of the public browse pages.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * collections dep, against one in-memory `node:sqlite` DB loaded from the
 * live migrations. Public pages (no auth). Seeds a manual collection with
 * one member product and exercises /collections, /collections/:slug, and
 * the unknown / malformed-slug failure modes (404, never 500).
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0043_collections.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-col-"));
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
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "col-flow-cursor" });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "Pro widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });

  // Seed a manual collection with the product as a member.
  var now = Date.now();
  await query(
    "INSERT INTO collections (slug, type, title, description, sort_strategy, created_at, updated_at) " +
    "VALUES ('summer', 'manual', 'Summer Picks', 'Sun-ready gear.', 'manual', ?1, ?1)",
    [now],
  );
  await query(
    "INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) VALUES (?1, 'summer', ?2, 0, ?3)",
    [b.uuid.v7(), product.id, now],
  );

  var handle = await _bootApp({ catalog: catalog, cart: cart, collections: collections });

  try {
    // Index lists the collection.
    var index = await helpers.httpRequest({ port: handle.port, path: "/collections" });
    check("collections index then 200",        index.status === 200);
    check("index shows the collection title",   index.body.indexOf("Summer Picks") !== -1);
    check("index links to the collection",      index.body.indexOf("/collections/summer") !== -1);

    // Collection page shows its member product as a card with price.
    var page = await helpers.httpRequest({ port: handle.port, path: "/collections/summer" });
    check("collection page then 200",           page.status === 200);
    check("collection page shows title",        page.body.indexOf("Summer Picks") !== -1);
    check("collection page shows the product",   page.body.indexOf("Widget Pro") !== -1);
    check("collection page links to the PDP",    page.body.indexOf("/products/widget-pro") !== -1);
    check("collection page shows the price",     page.body.indexOf("$29.99") !== -1);

    // Unknown collection then 404.
    var unknown = await helpers.httpRequest({ port: handle.port, path: "/collections/does-not-exist" });
    check("unknown collection then 404",        unknown.status === 404);

    // A malformed slug must be a 404, not a 500 (productsIn would throw,
    // but the bad slug is caught at get() → null → 404 first).
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/collections/" + encodeURIComponent("bad slug!!") });
    check("malformed slug then 404",            malformed.status === 404);

    // Footer surfaces the collections link (reachability).
    check("footer links to /collections",       index.body.indexOf("/collections\">Collections") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
