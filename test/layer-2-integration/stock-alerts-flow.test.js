"use strict";
/**
 * Back-in-stock "Notify me" — full HTTP integration of the double-opt-in
 * subscribe → confirm → scan-and-notify → unsubscribe flow.
 *
 * Boots a real b.createApp storefront wired with { catalog, cart, stockAlerts,
 * email } against an in-memory node:sqlite DB loaded from the live migrations.
 * The email handle uses b.mail.transports.memory() so every send lands in an
 * in-memory array the test asserts on (no SMTP). The cron sweep is driven via
 * the same /_/stock-alert-sweep handler server.js mounts — except this storefront
 * test mounts a thin equivalent handler over the wired stockAlerts + memory
 * mailer so the sweep + email fan-out exercise the production code path.
 *
 * Asserts: OOS PDP renders the notify form (in-stock PDP doesn't), subscribe
 * sends a confirmation email + records the token, confirm stamps the row,
 * the sweep emails once on restock + is idempotent, the secret gate, the
 * EDGE_POST_PATHS CSRF exemption is scoped (not global), XSS/email-injection
 * is escaped + a bad email 400s not 500s, and unsubscribe round-trips.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var SWEEP_SECRET = "sweep-secret-0123456789abcdef-test";

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0048_stock_alerts.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

async function _run() {
  var mq      = helpers.memD1Query(MIGS);
  var query   = mq.query;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var stockAlerts = bShop.stockAlerts.create({ query: query, catalog: catalog });

  // In-memory mailer so the test asserts on the recorded message array.
  var memory = b.mail.transports.memory();
  var mailer = b.mail.create({ transport: memory, defaults: { from: "shop@example.com" } });
  var email  = bShop.email.create({ mailer: mailer });

  // Seed a product with a single OUT-OF-STOCK variant (stock_on_hand = 0).
  var prod = await catalog.products.create({ slug: "back-in-stock-tee", title: "Back-in-Stock Tee", status: "active" });
  await catalog.variants.create(prod.id, { sku: "BIS-TEE-1", title: "Default", position: 0 });
  await catalog.inventory.create("BIS-TEE-1", { stock_on_hand: 0 });

  // A second product that IS in stock (the notify form must NOT show).
  var prod2 = await catalog.products.create({ slug: "in-stock-mug", title: "In-Stock Mug", status: "active" });
  await catalog.variants.create(prod2.id, { sku: "INS-MUG-1", title: "Default", position: 0 });
  await catalog.inventory.create("INS-MUG-1", { stock_on_hand: 25 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-stock-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, stockAlerts: stockAlerts, email: email,
        shop_origin: "https://shop.example",
      });
      // A thin sweep handler mirroring server.js#/_/stock-alert-sweep — same
      // timing-safe secret gate, same email fan-out via the memory mailer,
      // same never-5xx shape. Exercises the production sweep + email path.
      r.post("/_/stock-alert-sweep", async function (req, res) {
        var got  = req.headers && req.headers["x-d1-bridge-secret"];
        var want = SWEEP_SECRET;
        if (!want || typeof got !== "string" || got.length !== want.length || !b.crypto.timingSafeEqual(got, want)) {
          res.status(401); res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify({ ok: false, error: "UNAUTHORIZED" })) : res.send("");
        }
        var now = Date.now();
        var summary = { scanned: 0, notified: 0, emailed: 0 };
        try {
          var swept = await stockAlerts.scanAndNotify({ now: now });
          summary.scanned = swept.scanned; summary.notified = swept.notified;
          for (var i = 0; i < swept.rows.length; i += 1) {
            var row = swept.rows[i];
            try {
              await email.sendBackInStock({
                to: row.email_normalised, product_title: row.sku, sku: row.sku,
                product_url: "https://shop.example/search?q=" + encodeURIComponent(row.sku),
                unsubscribe_url: "https://shop.example/stock-alert/unsubscribe?email=" + encodeURIComponent(row.email_normalised) + "&sku=" + encodeURIComponent(row.sku),
              });
              summary.emailed += 1;
            } catch (_e) { /* drop-silent per row */ }
          }
          res.status(200); res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify(Object.assign({ ok: true }, summary))) : res.send("");
        } catch (e) {
          res.status(200); res.setHeader && res.setHeader("content-type", "application/json");
          return res.end ? res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) })) : res.send("");
        }
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    // t1 — OOS PDP renders the notify form; in-stock PDP does not.
    var oosPdp = await helpers.httpRequest({ port: port, path: "/products/back-in-stock-tee" });
    check("t1 OOS PDP 200",                       oosPdp.status === 200);
    check("t1 OOS PDP shows the notify action",   oosPdp.body.indexOf("action=\"/stock-alert/subscribe\"") !== -1);
    check("t1 OOS PDP shows the email input",     oosPdp.body.indexOf("name=\"email\"") !== -1 && oosPdp.body.indexOf("Email me when this is back") !== -1);
    check("t1 OOS PDP carries the sku hidden",    oosPdp.body.indexOf("name=\"sku\" value=\"BIS-TEE-1\"") !== -1);

    var insPdp = await helpers.httpRequest({ port: port, path: "/products/in-stock-mug" });
    check("t1 in-stock PDP 200",                  insPdp.status === 200);
    check("t1 in-stock PDP has NO notify form",   insPdp.body.indexOf("action=\"/stock-alert/subscribe\"") === -1);

    // t2 — subscribe → 200 thank-you + a confirmation email recorded.
    memory.sent.length = 0;
    var sub = await helpers.httpRequest({
      port: port, path: "/stock-alert/subscribe", method: "POST",
      form: { email: "shopper@example.com", sku: "BIS-TEE-1" },
    });
    check("t2 subscribe 200",                     sub.status === 200);
    check("t2 thank-you page rendered",           sub.body.indexOf("Check your email") !== -1);
    var confirmMsg = null;
    await helpers.waitUntil(function () {
      confirmMsg = memory.sent.find(function (m) { return /Confirm your back-in-stock alert/.test(m.subject || ""); });
      return !!confirmMsg;
    }, { timeoutMs: 5000, label: "t2: confirmation email recorded" });
    check("t2 confirmation email to the shopper", confirmMsg.to === "shopper@example.com");
    var tokenMatch = (confirmMsg.text || confirmMsg.html || "").match(/\/stock-alert\/confirm\/([A-Za-z0-9_-]{32})/);
    check("t2 confirmation carries a confirm link", !!tokenMatch);
    var token = tokenMatch && tokenMatch[1];

    // t3 — confirm → 200 confirmed page; DB row has confirmed_at stamped.
    var confirm = await helpers.httpRequest({ port: port, path: "/stock-alert/confirm/" + token });
    check("t3 confirm 200",                       confirm.status === 200);
    check("t3 confirm page reads confirmed",      confirm.body.indexOf("You're all set") !== -1);
    var rowAfterConfirm = (await query("SELECT confirmed_at FROM stock_alerts WHERE sku = ?1", ["BIS-TEE-1"])).rows[0];
    check("t3 confirmed_at stamped",              rowAfterConfirm && rowAfterConfirm.confirmed_at != null);

    // t4 — restock + sweep → notified:1 + a "Back in stock" email.
    await query("UPDATE inventory SET stock_on_hand = 10 WHERE sku = ?1", ["BIS-TEE-1"]);
    memory.sent.length = 0;
    var sweep = await helpers.httpRequest({
      port: port, path: "/_/stock-alert-sweep", method: "POST",
      headers: { "x-d1-bridge-secret": SWEEP_SECRET, "content-type": "application/json" }, body: "{}",
    });
    var sweepJson = JSON.parse(sweep.body);
    check("t4 sweep ok",                          sweepJson.ok === true);
    check("t4 sweep notified 1",                  sweepJson.notified === 1);
    var bisMsg = null;
    await helpers.waitUntil(function () {
      bisMsg = memory.sent.find(function (m) { return /Back in stock/.test(m.subject || ""); });
      return !!bisMsg;
    }, { timeoutMs: 5000, label: "t4: back-in-stock email recorded" });
    check("t4 back-in-stock email to the shopper", bisMsg.to === "shopper@example.com");

    // t5 — re-running the sweep does NOT re-email (notified_at stamped).
    memory.sent.length = 0;
    var sweep2 = await helpers.httpRequest({
      port: port, path: "/_/stock-alert-sweep", method: "POST",
      headers: { "x-d1-bridge-secret": SWEEP_SECRET, "content-type": "application/json" }, body: "{}",
    });
    var sweep2Json = JSON.parse(sweep2.body);
    check("t5 re-sweep notified 0",               sweep2Json.notified === 0);
    check("t5 re-sweep emailed 0",                (memory.sent.filter(function (m) { return /Back in stock/.test(m.subject || ""); })).length === 0);

    // t6 — sweep with a WRONG/absent secret → 401.
    var badSweep = await helpers.httpRequest({
      port: port, path: "/_/stock-alert-sweep", method: "POST",
      headers: { "x-d1-bridge-secret": "wrong-secret-but-same-length-padpad", "content-type": "application/json" }, body: "{}",
    });
    check("t6 wrong secret 401",                  badSweep.status === 401);
    var noSweep = await helpers.httpRequest({ port: port, path: "/_/stock-alert-sweep", method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    check("t6 absent secret 401",                 noSweep.status === 401);

    // t7 — CSRF parity: subscribe with NO csrf cookie/token succeeds (the
    // EDGE_POST_PATHS exemption); a container-CSRF route still 403s without a
    // token (the exemption is scoped, not global). The cookie consent POST
    // /consent is itself edge-exempt, so use a NON-exempt container POST:
    // /stock-alert/unsubscribe is NOT in EDGE_POST_PATHS, so a no-token POST
    // to it would 403 if the storefront-level csrf guard were active. This
    // test app boots WITHOUT the security middleware, so instead we prove the
    // exemption logic at the source: the subscribe path is exempt, the
    // unsubscribe path is not.
    check("t7 subscribe path is edge-exempt",     bShop.securityMiddleware.EDGE_POST_PATHS.indexOf("/stock-alert/subscribe") !== -1);
    check("t7 unsubscribe path NOT edge-exempt",  bShop.securityMiddleware.EDGE_POST_PATHS.indexOf("/stock-alert/unsubscribe") === -1);
    // And a fresh no-cookie subscribe still works (no token needed).
    var sub2 = await helpers.httpRequest({
      port: port, path: "/stock-alert/subscribe", method: "POST",
      form: { email: "another@example.com", sku: "BIS-TEE-1" },
    });
    check("t7 no-cookie subscribe 200",           sub2.status === 200);

    // t8 — XSS / email-injection: a hostile sku/email is escaped, a bad email
    // shape is 400 not 500.
    var xss = await helpers.httpRequest({
      port: port, path: "/stock-alert/subscribe", method: "POST",
      form: { email: "not-an-email<script>", sku: "<script>alert(1)</script>" },
    });
    check("t8 bad email 400 not 500",             xss.status === 400);
    check("t8 error page escapes the payload",    xss.body.indexOf("<script>alert(1)</script>") === -1);
    // The confirm page on a bad-shape token escapes / never 500s.
    var badConfirm = await helpers.httpRequest({ port: port, path: "/stock-alert/confirm/" + encodeURIComponent("<script>x</script>") });
    check("t8 bad token confirm 200 (invalid)",   badConfirm.status === 200);
    check("t8 bad token confirm escapes payload", badConfirm.body.indexOf("<script>x</script>") === -1);

    // t9 — unsubscribe round-trip → the row is gone.
    var beforeUnsub = (await query("SELECT COUNT(*) AS c FROM stock_alerts WHERE email_hash = ?1", [stockAlerts.hashEmail("another@example.com")])).rows[0];
    check("t9 row present before unsubscribe",     Number(beforeUnsub.c) === 1);
    var unsub = await helpers.httpRequest({
      port: port, path: "/stock-alert/unsubscribe", method: "POST",
      form: { email: "another@example.com", sku: "BIS-TEE-1" },
    });
    check("t9 unsubscribe 200",                    unsub.status === 200);
    check("t9 unsubscribe page reads done",        unsub.body.indexOf("You're unsubscribed") !== -1);
    var afterUnsub = (await query("SELECT COUNT(*) AS c FROM stock_alerts WHERE email_hash = ?1", [stockAlerts.hashEmail("another@example.com")])).rows[0];
    check("t9 row removed after unsubscribe",       Number(afterUnsub.c) === 0);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };
