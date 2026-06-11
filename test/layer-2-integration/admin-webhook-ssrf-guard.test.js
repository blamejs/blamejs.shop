"use strict";
/**
 * Webhook SSRF guard — an outbound webhook endpoint URL that targets an
 * internal / loopback / link-local / cloud-metadata destination must be
 * refused at subscription time, not registered ACTIVE.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * webhooks) and POSTs /admin/webhooks with each SSRF-shaped URL the live
 * harness confirmed used to return 201 ACTIVE:
 *
 *   https://169.254.169.254/latest/meta-data/   (AWS/GCP/Azure metadata IP)
 *   https://127.0.0.1/x                          (IPv4 loopback)
 *   https://localhost/x                          (loopback by name)
 *   https://metadata.google.internal/x           (GCP metadata by name)
 *   https://10.0.0.5/x                           (RFC 1918 private)
 *   https://[::1]/x                              (IPv6 loopback)
 *   https://foo.internal/x                       (cloud-private *.internal)
 *
 * Each must yield a clean 400 (bearer) and persist NO endpoint. A normal
 * public https URL still registers, proving the guard only blocks the
 * internal class. The guard composes b.ssrfGuard.classify for literal-IP
 * hosts (loopback / private / link-local / reserved / cloud-metadata) plus
 * a known-name denylist; DNS-rebinding is out of scope by design.
 *
 * Network: zero — the SSRF URLs are rejected before any outbound dial, and
 * the offline transport stub never touches the network.
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

var TOKEN = "admin-token-0123456789abcdef-ssrf";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0005_webhooks.sql", "0017_webhook_dlq.sql"]
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

var BLOCKED_URLS = [
  "https://169.254.169.254/latest/meta-data/",
  "https://127.0.0.1/x",
  "https://localhost/x",
  "https://metadata.google.internal/x",
  "https://10.0.0.5/x",
  "https://[::1]/x",
  "https://foo.internal/x",
  // Trailing-dot FQDN forms — semantically the same host, but evade a naive
  // denylist/classifier unless the trailing dot is stripped first.
  "https://localhost./x",
  "https://metadata.google.internal./x",
  "https://169.254.169.254./latest/meta-data/",
];

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "ssrf" });
  var config  = bShop.config.create({ query: query });
  var webhooks = bShop.webhooks.create({ query: query, transport: async function () { return { status: 200 }; } });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-ssrf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, webhooks: webhooks, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN, "content-type": "application/json" };

  try {
    for (var i = 0; i < BLOCKED_URLS.length; i += 1) {
      var url = BLOCKED_URLS[i];
      var res = await helpers.httpRequest({
        port: port, path: "/admin/webhooks", method: "POST",
        headers: bearer, body: JSON.stringify({ url: url, events: "order.refund" }),
      });
      check("SSRF url refused with 400 (not 201): " + url, res.status === 400);
      check("SSRF 400 detail names the not-allowed host: " + url,
        res.body.indexOf("not allowed") !== -1);
    }

    // No SSRF endpoint persisted.
    var afterBlocked = await webhooks.endpoints.list();
    check("no SSRF endpoint registered", afterBlocked.length === 0);

    // A normal public https URL still registers ACTIVE — the guard only
    // blocks the internal class.
    var ok = await helpers.httpRequest({
      port: port, path: "/admin/webhooks", method: "POST",
      headers: bearer, body: JSON.stringify({ url: "https://hooks.example.com/in", events: "order.refund" }),
    });
    check("public https url → 201", ok.status === 201);
    var rows = await webhooks.endpoints.list();
    check("public endpoint registered", rows.length === 1 && rows[0].url === "https://hooks.example.com/in");
    check("public endpoint is active", rows[0].active === 1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
