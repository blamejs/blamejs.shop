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
 * sends a confirmation email + records the confirm token + a token-bearing
 * unsubscribe link, confirm stamps the row, the sweep emails once on restock
 * + is idempotent, the secret gate, both stock-alert POSTs are edge-exempt
 * while the exemption stays scoped, XSS/email-injection is escaped + a bad
 * email 400s not 500s, and the token-gated unsubscribe round-trips while the
 * old (email, sku) tuple attack — and a wrong token — no longer cancel a row.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0048_stock_alerts.sql", "0207_stock_alert_unsubscribe_token.sql"]
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
                unsubscribe_url: "https://shop.example/stock-alert/unsubscribe?token=" + encodeURIComponent(row.unsubscribe_token),
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
    var confirmBody = confirmMsg.text || confirmMsg.html || "";
    var tokenMatch = confirmBody.match(/\/stock-alert\/confirm\/([A-Za-z0-9_-]{32})/);
    check("t2 confirmation carries a confirm link", !!tokenMatch);
    var token = tokenMatch && tokenMatch[1];
    // The confirmation email also carries a token-bearing unsubscribe link —
    // the per-row bearer is the authorization (no email/sku tuple in the URL).
    var confirmUnsubMatch = confirmBody.match(/\/stock-alert\/unsubscribe\?token=([A-Za-z0-9_-]{32})/);
    check("t2 confirmation carries a token unsub link", !!confirmUnsubMatch);
    check("t2 confirm unsub link has no email/sku tuple", confirmBody.indexOf("/stock-alert/unsubscribe?email=") === -1);

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

    // t7 — CSRF parity: both stock-alert POSTs are token-bearer surfaces, so
    // both are in EDGE_POST_PATHS (subscribe rides the cookie-less edge PDP
    // form; unsubscribe is the one-click mail-client POST whose per-row
    // bearer token IS the authorization). The exemption stays SCOPED, not
    // global — a container-CSRF action like a /products/ review POST is NOT
    // exempt. We prove the exemption logic at the source.
    check("t7 subscribe path is edge-exempt",     bShop.securityMiddleware.EDGE_POST_PATHS.indexOf("/stock-alert/subscribe") !== -1);
    check("t7 unsubscribe path is edge-exempt",   bShop.securityMiddleware.EDGE_POST_PATHS.indexOf("/stock-alert/unsubscribe") !== -1);
    check("t7 exemption stays scoped (no /products/)", bShop.securityMiddleware.EDGE_POST_PATHS.indexOf("/products/") === -1);
    // And a fresh no-cookie subscribe still works (no token needed). Capture
    // its confirmation email so t9 can drive the token-based unsubscribe.
    memory.sent.length = 0;
    var sub2 = await helpers.httpRequest({
      port: port, path: "/stock-alert/subscribe", method: "POST",
      form: { email: "another@example.com", sku: "BIS-TEE-1" },
    });
    check("t7 no-cookie subscribe 200",           sub2.status === 200);
    var sub2Confirm = null;
    await helpers.waitUntil(function () {
      sub2Confirm = memory.sent.find(function (m) { return /Confirm your back-in-stock alert/.test(m.subject || ""); });
      return !!sub2Confirm;
    }, { timeoutMs: 5000, label: "t7: another@ confirmation email recorded" });
    var sub2Body = sub2Confirm.text || sub2Confirm.html || "";
    var anotherUnsubMatch = sub2Body.match(/\/stock-alert\/unsubscribe\?token=([A-Za-z0-9_-]{32})/);
    check("t7 confirmation carries token unsub link", !!anotherUnsubMatch);
    var anotherUnsubToken = anotherUnsubMatch && anotherUnsubMatch[1];

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

    // t9 — token-based unsubscribe round-trip → the row is gone.
    var beforeUnsub = (await query("SELECT COUNT(*) AS c FROM stock_alerts WHERE email_hash = ?1", [stockAlerts.hashEmail("another@example.com")])).rows[0];
    check("t9 row present before unsubscribe",     Number(beforeUnsub.c) === 1);

    // The OLD attack: POST a guessed (email, sku) tuple — with no token — to
    // cancel a victim's alert. It must NOT remove the row anymore. The route
    // ignores email/sku entirely; the absent/empty token is a uniform no-op.
    var tupleAttack = await helpers.httpRequest({
      port: port, path: "/stock-alert/unsubscribe", method: "POST",
      form: { email: "another@example.com", sku: "BIS-TEE-1" },
    });
    check("t9 tuple-only POST 200 (uniform)",      tupleAttack.status === 200);
    var afterAttack = (await query("SELECT COUNT(*) AS c FROM stock_alerts WHERE email_hash = ?1", [stockAlerts.hashEmail("another@example.com")])).rows[0];
    check("t9 tuple attack did NOT remove row",    Number(afterAttack.c) === 1);

    // A wrong-but-well-shaped token is likewise a uniform no-op.
    var wrongToken = await helpers.httpRequest({
      port: port, path: "/stock-alert/unsubscribe", method: "POST",
      form: { token: "Z".repeat(32) },
    });
    check("t9 wrong token 200 (uniform)",          wrongToken.status === 200);
    var afterWrong = (await query("SELECT COUNT(*) AS c FROM stock_alerts WHERE email_hash = ?1", [stockAlerts.hashEmail("another@example.com")])).rows[0];
    check("t9 wrong token did NOT remove row",     Number(afterWrong.c) === 1);

    // Only the genuine bearer token from the email cancels the alert.
    var unsub = await helpers.httpRequest({
      port: port, path: "/stock-alert/unsubscribe", method: "POST",
      form: { token: anotherUnsubToken },
    });
    check("t9 unsubscribe 200",                    unsub.status === 200);
    check("t9 unsubscribe page reads done",        unsub.body.indexOf("You're unsubscribed") !== -1);
    var afterUnsub = (await query("SELECT COUNT(*) AS c FROM stock_alerts WHERE email_hash = ?1", [stockAlerts.hashEmail("another@example.com")])).rows[0];
    check("t9 row removed after unsubscribe",       Number(afterUnsub.c) === 0);

    // The GET confirm page renders the token in a hidden field (escaped) and
    // leaks no email/sku — it is the bearer-only handle.
    var confirmPage = await helpers.httpRequest({ port: port, path: "/stock-alert/unsubscribe?token=" + encodeURIComponent("A".repeat(32)) });
    check("t9 confirm page 200",                   confirmPage.status === 200);
    check("t9 confirm page carries token field",   confirmPage.body.indexOf("name=\"token\" value=\"" + "A".repeat(32) + "\"") !== -1);
    check("t9 confirm page shows no email/sku",    confirmPage.body.indexOf("another@example.com") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };
