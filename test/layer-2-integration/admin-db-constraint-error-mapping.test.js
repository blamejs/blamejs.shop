"use strict";
/**
 * Admin error mapping — storage-engine constraint violations must NOT
 * 500 with the raw SQLite message echoed to the client.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config)
 * against one in-memory node:sqlite DB with foreign keys ON, then drives
 * the bearer JSON admin routes into each DB-constraint class:
 *
 *   - duplicate product slug   → UNIQUE constraint failed: products.slug
 *   - duplicate variant sku    → UNIQUE constraint failed: variants.sku
 *   - duplicate inventory sku  → UNIQUE constraint failed: inventory.sku
 *   - media FK miss            → FOREIGN KEY constraint failed
 *
 * The fix maps the whole class at the _wrap chokepoint: UNIQUE/FK → 409
 * conflict, CHECK/NOT NULL → 400, with a GENERIC operator-facing detail
 * that names neither the table/column nor the SQL. Each case asserts the
 * corrected status AND that no raw internal string ("constraint failed",
 * the table/column name) leaks into the body.
 *
 * The _wrap chokepoint also nets any in-handler JSON.parse that throws a
 * SyntaxError, degrading it to a clean 400 with a generic "Invalid JSON"
 * detail (defense-in-depth; the per-field shipping-zone parse has its own
 * call-site message). A malformed TOP-LEVEL request body is intercepted by
 * the framework body parser before admin code runs, so that path is the
 * parser's concern, not this layer's.
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

var TOKEN = "admin-token-0123456789abcdef-dbmap";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql"]
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

// Assert a response body carries NONE of the storage-engine internals the
// pre-fix 500 leaked.
function _noLeak(label, body) {
  var lower = String(body).toLowerCase();
  check(label + ": no 'constraint failed'", lower.indexOf("constraint failed") === -1);
  check(label + ": no table/column name",   lower.indexOf("products.slug") === -1 &&
                                            lower.indexOf("variants.sku") === -1 &&
                                            lower.indexOf("inventory.sku") === -1);
  check(label + ": no 'json at position'",  lower.indexOf("json at position") === -1);
}

function _jsonPost(port, path, obj) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST",
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    body: typeof obj === "string" ? obj : JSON.stringify(obj),
  });
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "dbmap" });
  var config  = bShop.config.create({ query: query });

  // Seed an existing product + variant + inventory row so the duplicate
  // INSERTs below collide on the UNIQUE indexes.
  var prod = await catalog.products.create({ slug: "audit-widget", title: "Audit Widget", status: "active" });
  await catalog.variants.create(prod.id, { sku: "AUD-SKU-1", weight_grams: 100 });
  await catalog.inventory.create("INV-SKU-1", { stock_on_hand: 5 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-dbmap-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // ---- (1) duplicate product slug → 409 conflict, no leak ----
    var dupSlug = await _jsonPost(port, "/admin/products", { title: "DupTest", slug: "audit-widget" });
    check("dup slug → 409 conflict (not 500)", dupSlug.status === 409);
    check("dup slug detail is the generic in-use message",
      dupSlug.body.indexOf("already in use") !== -1);
    _noLeak("dup slug", dupSlug.body);

    // ---- (2) duplicate variant sku → 409 conflict, no leak ----
    var dupSku = await _jsonPost(port, "/admin/products/" + prod.id + "/variants/create",
      { sku: "AUD-SKU-1", weight_grams: 100 });
    check("dup variant sku → 409 conflict (not 500)", dupSku.status === 409);
    _noLeak("dup variant sku", dupSku.body);

    // ---- (3) duplicate inventory sku → 409 conflict, no leak ----
    var dupInv = await _jsonPost(port, "/admin/inventory", { sku: "INV-SKU-1", stock_on_hand: 7 });
    check("dup inventory sku → 409 conflict (not 500)", dupInv.status === 409);
    _noLeak("dup inventory sku", dupInv.body);

    // ---- (4) media FK miss (valid-but-nonexistent product uuid) → 409, no leak ----
    var ghostId = b.uuid.v7();   // well-formed UUID, no such product row
    var fkMiss = await _jsonPost(port, "/admin/media",
      { product_id: ghostId, r2_key: "products/ghost.svg", content_type: "image/svg+xml" });
    check("media FK miss → 409 conflict (not 500)", fkMiss.status === 409);
    check("media FK miss detail is the generic referenced-record message",
      fkMiss.body.indexOf("referenced record does not exist") !== -1);
    _noLeak("media FK miss", fkMiss.body);

    // ---- a clean create still succeeds (the mapping didn't break the happy path) ----
    var ok = await _jsonPost(port, "/admin/products", { title: "Fresh", slug: "fresh-widget" });
    check("clean create still 201", ok.status === 201);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
