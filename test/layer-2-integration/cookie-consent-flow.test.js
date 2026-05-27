"use strict";
/**
 * Cookie-consent banner — full HTTP integration of the GDPR / ePrivacy
 * opt-in flow.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * cookieConsent dep, against one in-memory `node:sqlite` DB loaded from
 * the live migrations. Covers: the banner showing when no choice exists,
 * the accept-all / reject / granular round-trips (sealed choice cookie +
 * non-sealed flag cookie + ledger row), the persisted choice gating the
 * server-side consent hook, the manage page reflecting the stored
 * decision, the malformed-POST 400 re-render, the safe-redirect guard on
 * return_to, the tampered choice cookie reading as "no choice", and the
 * DNT / GPC implicit-deny on analytics + marketing.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0103_cookie_consent.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery(db) {
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-cc-"));
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

// Count rows in the consent ledger so the test can assert the audit
// trail grew on each decision.
function _ledgerCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM cookie_consent_records").get().n);
}

async function _run() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  var query = _makeQuery(db);

  var catalog       = bShop.catalog.create({ query: query });
  var cart          = bShop.cart.create({ query: query, catalog: catalog });
  var cookieConsent = bShop.cookieConsent.create({ query: query });

  await catalog.products.create({ slug: "widget", title: "Widget", description: "x", status: "active" });

  var handle = await _bootApp({ catalog: catalog, cart: cart, cookieConsent: cookieConsent });

  try {
    // ---- banner shows when no choice exists ----------------------------
    var first = await helpers.httpRequest({ port: handle.port, path: "/" });
    check("home renders 200",                  first.status === 200);
    check("banner present with no choice",     first.body.indexOf("id=\"consent-banner\"") !== -1);
    check("banner has accept-all control",     first.body.indexOf("value=\"accept_all\"") !== -1);
    check("banner has reject control",         first.body.indexOf("value=\"reject\"") !== -1);
    check("consent island script wired",       first.body.indexOf("js/consent.") !== -1);
    check("footer manage-cookies link",        first.body.indexOf("href=\"/cookies\">Manage cookies") !== -1);

    // ---- manage page reachable, all-off by default ---------------------
    var manage0 = await helpers.httpRequest({ port: handle.port, path: "/cookies" });
    check("manage page 200",                   manage0.status === 200);
    check("manage page shows analytics toggle", manage0.body.indexOf("name=\"cat_analytics\"") !== -1);
    check("manage analytics unchecked default", manage0.body.indexOf("name=\"cat_analytics\" value=\"1\" checked") === -1);

    // ---- accept-all round-trip -----------------------------------------
    var jar = helpers.cookieJar();
    var ledgerBefore = _ledgerCount(db);
    var accept = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: jar,
      form: { choice: "accept_all", return_to: "/cart" },
    });
    check("accept-all 303",                    accept.status === 303);
    check("accept-all returns to return_to",   (accept.headers["location"] || "") === "/cart");
    check("sealed choice cookie set",          jar.get("shop_consent") !== null);
    // The flag cookie carries the policy version the decision was captured
    // under (not a bare "1"), so the island can compare it to the active
    // version stamped on its <script> tag and re-prompt after a bump.
    check("flag cookie carries policy version", jar.get("shop_consent_set") === "v1");
    check("island script stamps active policy", first.body.indexOf("id=\"consent-island\"") !== -1 && first.body.indexOf("data-consent-policy=\"v1\"") !== -1);
    check("ledger row written on accept",      _ledgerCount(db) === ledgerBefore + 1);

    // The flag cookie drives the consent island's client-side hide; the
    // banner markup still ships in the document (it must, since edge-
    // cached pages are shared) — so the server keeps rendering it and
    // the island hides it. Assert the marker that the island reads.
    var afterAccept = await helpers.httpRequest({ port: handle.port, path: "/", jar: jar });
    check("flag cookie replays on next req",   afterAccept.status === 200);

    // ---- manage page reflects the stored accept-all decision -----------
    var manageAfter = await helpers.httpRequest({ port: handle.port, path: "/cookies", jar: jar });
    check("manage reflects analytics on",      manageAfter.body.indexOf("name=\"cat_analytics\" value=\"1\" checked") !== -1);
    check("manage reflects marketing on",      manageAfter.body.indexOf("name=\"cat_marketing\" value=\"1\" checked") !== -1);

    // ---- policy bump invalidates the stored decision -------------------
    // Bumping the active policy version makes consent captured under the
    // old version no longer authoritative: the manage page reads all-off
    // (so the gate denies analytics/marketing again) and the island re-
    // prompts because the flag cookie ("v1") no longer matches the active
    // version now stamped on the script ("v2").
    cookieConsent.policyVersion = "v2";
    var manageStale = await helpers.httpRequest({ port: handle.port, path: "/cookies", jar: jar });
    check("policy bump resets stored toggles", manageStale.body.indexOf("value=\"1\" checked") === -1);
    check("policy bump restamps active policy", manageStale.body.indexOf("data-consent-policy=\"v2\"") !== -1);
    // A fresh decision under the new version is honored again.
    var reaccept = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: jar,
      form: { choice: "accept_all", return_to: "/" },
    });
    check("re-consent under new policy 303",   reaccept.status === 303);
    check("flag cookie now carries v2",        jar.get("shop_consent_set") === "v2");
    var manageReaccept = await helpers.httpRequest({ port: handle.port, path: "/cookies", jar: jar });
    check("v2 decision honored again",         manageReaccept.body.indexOf("name=\"cat_analytics\" value=\"1\" checked") !== -1);
    cookieConsent.policyVersion = "v1";

    // ---- granular round-trip: analytics on, marketing off --------------
    var jar2 = helpers.cookieJar();
    var granular = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: jar2,
      form: { choice: "granular", return_to: "/cookies", cat_analytics: "1" },
    });
    check("granular 303 to /cookies?saved=1",  granular.status === 303 && (granular.headers["location"] || "") === "/cookies?saved=1");
    var manageGran = await helpers.httpRequest({ port: handle.port, path: "/cookies?saved=1", jar: jar2 });
    check("granular saved notice shown",       manageGran.body.indexOf("preferences were saved") !== -1);
    check("granular analytics checked",        manageGran.body.indexOf("name=\"cat_analytics\" value=\"1\" checked") !== -1);
    check("granular marketing unchecked",      manageGran.body.indexOf("name=\"cat_marketing\" value=\"1\" checked") === -1);
    check("granular functional unchecked",     manageGran.body.indexOf("name=\"cat_functional\" value=\"1\" checked") === -1);

    // ---- reject round-trip ---------------------------------------------
    var jar3 = helpers.cookieJar();
    var reject = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: jar3,
      form: { choice: "reject", return_to: "/" },
    });
    check("reject 303",                        reject.status === 303);
    check("reject sets choice cookie",         jar3.get("shop_consent") !== null);
    var manageRej = await helpers.httpRequest({ port: handle.port, path: "/cookies", jar: jar3 });
    check("reject leaves all categories off",  manageRej.body.indexOf("value=\"1\" checked") === -1);

    // ---- malformed POST then 400 + re-render ---------------------------
    var bad = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST",
      form: { choice: "not-a-real-choice" },
    });
    check("malformed choice then 400",         bad.status === 400);
    check("malformed re-renders manage page",  bad.body.indexOf("wasn't understood") !== -1);

    var missing = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", form: { return_to: "/" },
    });
    check("missing choice then 400",           missing.status === 400);

    // ---- safe-redirect guard on return_to ------------------------------
    var jarRedir = helpers.cookieJar();
    var openRedir = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: jarRedir,
      form: { choice: "accept_all", return_to: "//evil.example/phish" },
    });
    check("protocol-relative return_to refused", openRedir.status === 303 && (openRedir.headers["location"] || "") === "/");
    var absRedir = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: helpers.cookieJar(),
      form: { choice: "reject", return_to: "https://evil.example/phish" },
    });
    check("absolute-url return_to refused",    absRedir.status === 303 && (absRedir.headers["location"] || "") === "/");

    // ---- tampered choice cookie reads as "no choice" -------------------
    var tamperJar = helpers.cookieJar();
    // A garbage value in the slot the sealed reader expects. The reader
    // fails the unseal and treats it as no decision — the manage page
    // renders all-off rather than 500ing.
    var tampered = await helpers.httpRequest({
      port: handle.port, path: "/cookies",
      headers: { cookie: "shop_consent=not-a-valid-sealed-value-" + "x".repeat(40) },
    });
    check("tampered cookie then 200 not 500",  tampered.status === 200);
    check("tampered cookie reads all-off",     tampered.body.indexOf("value=\"1\" checked") === -1);
    void tamperJar;

    // ---- gating hook: DNT collapses analytics + marketing --------------
    // Opt analytics + marketing IN, then re-read the manage page with a
    // DNT header set. The stored decision still shows the toggles ON
    // (the banner records what the buyer SAID), but the server-side
    // consent gate (_consentAllows) must deny analytics + marketing under
    // DNT. We assert the gate through the recorded ledger semantics:
    // categoryAllowed honors DNT/GPC as implicit deny.
    var dntSid = b.uuid.v7();
    await cookieConsent.recordConsent({
      session_id: dntSid,
      categories: { functional: true, analytics: true, marketing: true, preferences: true },
      ua_class:   "desktop",
      dnt:        true,
      gpc:        false,
    });
    var analyticsUnderDnt = await cookieConsent.categoryAllowed({ session_id: dntSid, category: "analytics" });
    var marketingUnderDnt = await cookieConsent.categoryAllowed({ session_id: dntSid, category: "marketing" });
    var functionalUnderDnt = await cookieConsent.categoryAllowed({ session_id: dntSid, category: "functional" });
    var necessaryAlways = await cookieConsent.categoryAllowed({ session_id: dntSid, category: "strictly_necessary" });
    check("DNT denies analytics",              analyticsUnderDnt === false);
    check("DNT denies marketing",              marketingUnderDnt === false);
    check("DNT leaves functional opt-in",      functionalUnderDnt === true);
    check("strictly-necessary always allowed", necessaryAlways === true);

    // ---- edge/container render parity (guarded import) -----------------
    // The banner markup must be byte-identical across the container
    // (lib/storefront.js) and the edge worker (worker/render/_lib.js).
    // worker/ is excluded from the container build context (.dockerignore),
    // so the import is guarded: when the module isn't present (in-image
    // smoke), this parity assertion is skipped rather than crashing the
    // gate (an unguarded worker import bricks every container deploy).
    var workerLibPath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "_lib.js");
    if (nodeFs.existsSync(workerLibPath)) {
      var containerSrc = nodeFs.readFileSync(nodePath.resolve(__dirname, "..", "..", "lib", "storefront.js"), "utf8");
      var workerSrc    = nodeFs.readFileSync(workerLibPath, "utf8");
      var cBanner = _extractBanner(containerSrc);
      var wBanner = _extractBanner(workerSrc);
      check("banner markup parity edge<->container", cBanner.length > 0 && cBanner === wBanner);
    }
  } finally {
    await _teardown(handle);
  }
}

// Reconstruct the CONSENT_BANNER string literal from a source file so the
// parity check compares the actual rendered markup, not the source bytes
// (which differ in CommonJS vs ESM keyword + line endings).
function _extractBanner(src) {
  var lines = src.replace(/\r/g, "").split("\n");
  var start = -1;
  for (var i = 0; i < lines.length; i += 1) {
    if (/(?:var|export var) CONSENT_BANNER\s*=\s*$/.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return "";
  var parts = [];
  for (var j = start; j < lines.length; j += 1) {
    var m = lines[j].match(/^\s*"((?:[^"\\]|\\.)*)"\s*(\+|;)\s*$/);
    if (!m) return "";
    parts.push(JSON.parse('"' + m[1] + '"'));
    if (m[2] === ";") break;
  }
  return parts.join("");
}

module.exports = { run: _run };
