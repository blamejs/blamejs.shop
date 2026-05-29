"use strict";
/**
 * Local end-to-end storefront server — boots the REAL storefront with the
 * production middleware defaults (nothing disabled) on a node:sqlite
 * backend, so a real browser (Playwright) can exercise add-to-cart,
 * checkout, etc. against the same security stack a deploy runs. This is
 * the gap the layer-2 integration tests miss: they disable bot-guard /
 * rate-limit and mount a thin dep set; here everything is on.
 *
 *   node test/e2e/serve.js            # boots on PORT (default 8099)
 *
 * Prints "E2E_READY <port>" once listening; seeds one product/variant so
 * /products/e2e-widget is live. Ephemeral temp data dir.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop = require("../../lib");
var b = bShop.framework;

var PORT = parseInt(process.env.E2E_PORT || "8099", 10);

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

(async function main() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "e2e-order" });

  var p = await catalog.products.create({ slug: "e2e-widget", title: "E2E Widget", status: "active" });
  var v = await catalog.variants.create(p.id, { sku: "E2E-1", title: "Default" });
  await catalog.prices.set(v.id, { currency: "USD", amount_minor: 2500 });
  await catalog.inventory.create("E2E-1", { stock_on_hand: 100 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-e2e-"));
  // NOTE: production middleware defaults — bot-guard (createApp default),
  // the global per-client-IP rate limit, fetch-metadata cross-site
  // isolation + origin guard, the tight per-route limiters, and sealed
  // cookies are ALL on, wired through the same lib/security-middleware
  // composition server.js uses. This is the point: a real browser
  // exercises the same security stack a deploy runs.
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { rateLimit: bShop.securityMiddleware.globalRateLimitOpts() },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.securityMiddleware.mountRouteGuards(r);
      bShop.storefront.mount(r, { catalog: catalog, cart: cart, order: order });
    },
  });
  var bound = await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log("E2E_READY " + bound.port + " /products/e2e-widget");

  function _stop() { app.shutdown().then(function () { try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ } process.exit(0); }); }
  process.on("SIGINT", _stop);
  process.on("SIGTERM", _stop);
})().catch(function (e) {
  // Re-throw rather than logging the error — a boot failure's message /
  // stack can carry passphrase-adjacent config, and this is a dev harness.
  // Node's default handler prints it to stderr and exits non-zero.
  process.exitCode = 1;
  throw e;
});
