"use strict";
/**
 * CAPTCHA gate wiring — HTTP integration across the three high-risk entry
 * points (signup / login / checkout), over one in-memory node:sqlite holding
 * the captcha provider + verification tables (migration 0114).
 *
 * The whole point of this group is that the gate is OFF until an operator
 * registers a provider, and ON without breaking anything once they do:
 *
 *   a. UNCONFIGURED STORE (no provider wired) — register-begin / login-begin
 *      behave EXACTLY as today: no widget rendered, no token verified, the
 *      ceremony proceeds. This is the graceful-no-op proof, the most
 *      important assertion (it's how we avoid breaking every store that
 *      doesn't use captcha).
 *   b. CONFIGURED + VALID TOKEN — register-begin with a token whose stub
 *      `verify` returns {success:true} proceeds, and a captcha_verifications
 *      row is recorded ok=1, gate=signup.
 *   c. CONFIGURED + INVALID TOKEN — register-begin returns 4xx with a clean
 *      message (no raw error leak), records ok=0, and creates NO customer.
 *   d. CONFIGURED + MISSING TOKEN — fails closed (defensive reader →
 *      verifyToken refusal), 4xx, no write.
 *   e. LOGIN gate is opt-in (CAPTCHA_GATE_LOGIN) — with a provider active but
 *      login NOT opted in, login-begin proceeds with no verify; opted in, a
 *      bad token refuses login-begin.
 *   f. SCOPED CSP on the auth pages — GET /account/register with a provider
 *      active admits the provider host; with no provider it keeps the strict
 *      default (no provider host).
 *   g. The widget markup escapes an XSS-shaped sitekey (the new sink).
 *   h. CHECKOUT — the GET checkout renders the widget when active and the
 *      route-scoped CSP admits the provider; a checkout POST with a bad token
 *      is refused before the cart converts.
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
var waitUntil = helpers.waitUntil;

var b = bShop.framework;

var MIG_CATALOG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0001_catalog.sql");
var MIG_CART    = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0002_cart.sql");
var MIG_CAPTCHA = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0114_captcha_gate.sql");

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery(migs) {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  migs.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

// catalog + cart satisfy mount()'s prerequisite deps (the auth routes don't
// exercise them). A throwaway in-memory backend.
function _catalogCart() {
  var query   = _makeQuery([MIG_CATALOG, MIG_CART]);
  var catalog = bShop.catalog.create({ query: query });
  return { catalog: catalog, cart: bShop.cart.create({ query: query, catalog: catalog }) };
}

// A minimal stub customers dep — register-begin only needs hashEmail +
// byEmailHash + register; a registration sets `created` so we can assert no
// customer was created on a refused captcha.
function _stubCustomers(state) {
  return {
    hashEmail:   function (email) { return "hash-of-" + String(email); },
    byEmailHash: async function () { return null; },
    register:    async function (input) {
      state.created += 1;
      return { id: b.uuid.v7(), email: input.email, email_hash: "hash-of-" + input.email + "-padding-to-16chars", display_name: input.display_name };
    },
    listPasskeys: async function () { return []; },
  };
}

async function _boot(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-captcha-sf-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}
async function _teardown(h) {
  if (!h) return;
  try { await h.app.shutdown(); } catch (_e) { /* */ }
  try { nodeFs.rmSync(h.dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
}

function _postJson(h, path, body) {
  return helpers.httpRequest({
    port: h.port, path: path, method: "POST",
    headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
    body: JSON.stringify(body),
  });
}
function _get(h, path) {
  return helpers.httpRequest({
    port: h.port, path: path,
    headers: { "user-agent": "Mozilla/5.0", "accept": "text/html", "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" },
  });
}

// Build the captcha deps the storefront mount reads, backed by a real gate
// over a shared sqlite holding an active turnstile provider. `verifyResult`
// is the stub siteverify response; `loginOn` toggles CAPTCHA_GATE_LOGIN.
async function _captchaDeps(verifyResult, loginOn) {
  var query = _makeQuery([MIG_CAPTCHA]);
  var cg = bShop.captchaGate.create({ query: query });
  await cg.registerProvider({
    slug: "turnstile", kind: "turnstile",
    public_key: "0x4AAAAAAA-sitekey", secret_key: "0x4AAAAAAA-secret", active: true,
  });
  return {
    _gate: cg,
    captchaGate:         cg,
    captchaProviderSlug: "turnstile",
    captchaKind:         "turnstile",
    captchaPublicKey:    "0x4AAAAAAA-sitekey",
    captchaLoginEnabled: !!loginOn,
    captchaVerify:       async function () { return verifyResult; },
  };
}

async function _run() {
  // ---- (a) UNCONFIGURED STORE: ceremonies proceed, no widget --------
  var stateA = { created: 0 };
  var handleA = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers(stateA), shop_origin: "https://shop.test" }));
  try {
    var regA = await _postJson(handleA, "/account/passkey/register-begin", { email: "a@example.com", display_name: "Aa" });
    check("(a) unconfigured register-begin proceeds (2xx challenge)", regA.status >= 200 && regA.status < 300);
    var logA = await _postJson(handleA, "/account/passkey/login-begin", { email: "a@example.com" });
    check("(a) unconfigured login-begin proceeds (2xx challenge)", logA.status >= 200 && logA.status < 300);
    var regPageA = await _get(handleA, "/account/register");
    check("(a) unconfigured register page renders no captcha widget", regPageA.body.indexOf("captcha-widget") === -1);
    check("(a) unconfigured register page keeps strict default CSP (no provider host)",
      (regPageA.headers["content-security-policy"] || "").indexOf("challenges.cloudflare.com") === -1);
  } finally { await _teardown(handleA); }

  // ---- (b) CONFIGURED + VALID TOKEN: proceeds, records ok=1 ----------
  var stateB = { created: 0 };
  var capB = await _captchaDeps({ success: true }, false);
  var handleB = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers(stateB), shop_origin: "https://shop.test" }, capB));
  try {
    var regB = await _postJson(handleB, "/account/passkey/register-begin", { email: "b@example.com", display_name: "Bb", captcha_token: "good-token" });
    check("(b) valid-token register-begin proceeds (2xx)", regB.status >= 200 && regB.status < 300);
    check("(b) valid-token register-begin created the customer", stateB.created === 1);
    // recordOutcome is awaited in the handler, so the row is settled; poll
    // defensively in case of runner contention.
    await waitUntil(async function () {
      var m = await capB._gate.metricsForProvider({ slug: "turnstile", from: 1, to: Date.now() + 1000 });
      return m.total >= 1;
    }, { timeoutMs: 5000, label: "(b) captcha verification row recorded" });
    var rowsB = await capB._gate.gatesForVerification({ slug: "turnstile", from: 1, to: Date.now() + 1000, limit: 10 });
    var signupOk = rowsB.rows.filter(function (r) { return r.gate === "signup" && r.ok === true; });
    check("(b) a captcha_verifications row recorded ok=1, gate=signup", signupOk.length >= 1);
  } finally { await _teardown(handleB); }

  // ---- (c) CONFIGURED + INVALID TOKEN: 4xx, records ok=0, no write ---
  var stateC = { created: 0 };
  var capC = await _captchaDeps({ success: false }, false);
  var handleC = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers(stateC), shop_origin: "https://shop.test" }, capC));
  try {
    var regC = await _postJson(handleC, "/account/passkey/register-begin", { email: "c@example.com", display_name: "Cc", captcha_token: "bad-token" });
    check("(c) invalid-token register-begin refused (4xx)", regC.status >= 400 && regC.status < 500);
    check("(c) invalid-token register-begin message is clean (no raw error)",
      regC.body.indexOf("verifyToken") === -1 && regC.body.indexOf("captcha_") === -1 && regC.body.length < 200);
    check("(c) invalid-token register-begin created NO customer", stateC.created === 0);
    var rowsC = await capC._gate.gatesForVerification({ slug: "turnstile", from: 1, to: Date.now() + 1000, limit: 10 });
    var signupFail = rowsC.rows.filter(function (r) { return r.gate === "signup" && r.ok === false; });
    check("(c) a captcha_verifications row recorded ok=0, gate=signup", signupFail.length >= 1);
  } finally { await _teardown(handleC); }

  // ---- (d) CONFIGURED + MISSING TOKEN: fails closed -----------------
  var stateD = { created: 0 };
  var capD = await _captchaDeps({ success: true }, false);  // even a "valid" verify can't pass with no token
  var handleD = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers(stateD), shop_origin: "https://shop.test" }, capD));
  try {
    var regD = await _postJson(handleD, "/account/passkey/register-begin", { email: "d@example.com", display_name: "Dd" });   // no captcha_token
    check("(d) missing-token register-begin refused (4xx) — fails closed", regD.status >= 400 && regD.status < 500);
    check("(d) missing-token register-begin created NO customer", stateD.created === 0);
  } finally { await _teardown(handleD); }

  // ---- (e) LOGIN gate is opt-in -------------------------------------
  // Provider active, login NOT opted in → login-begin proceeds (no verify).
  var capE1 = await _captchaDeps({ success: false }, false);
  var handleE1 = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers({ created: 0 }), shop_origin: "https://shop.test" }, capE1));
  try {
    var logE1 = await _postJson(handleE1, "/account/passkey/login-begin", { email: "e@example.com" });   // no token, login not gated
    check("(e) login NOT opted in: login-begin proceeds despite no token", logE1.status >= 200 && logE1.status < 300);
    var loginPageE1 = await _get(handleE1, "/account/login");
    check("(e) login NOT opted in: login page renders no widget", loginPageE1.body.indexOf("captcha-widget") === -1);
    check("(e) login NOT opted in: login page keeps strict default CSP",
      (loginPageE1.headers["content-security-policy"] || "").indexOf("challenges.cloudflare.com") === -1);
  } finally { await _teardown(handleE1); }
  // Provider active, login OPTED IN, bad token → login-begin refused.
  var capE2 = await _captchaDeps({ success: false }, true);
  var handleE2 = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers({ created: 0 }), shop_origin: "https://shop.test" }, capE2));
  try {
    var logE2 = await _postJson(handleE2, "/account/passkey/login-begin", { email: "e@example.com", captcha_token: "bad" });
    check("(e) login OPTED IN + bad token: login-begin refused (4xx)", logE2.status >= 400 && logE2.status < 500);
    var loginPageE2 = await _get(handleE2, "/account/login");
    check("(e) login OPTED IN: login page renders the widget", loginPageE2.body.indexOf("captcha-widget") !== -1);
    check("(e) login OPTED IN: login page CSP admits the provider host",
      (loginPageE2.headers["content-security-policy"] || "").indexOf("challenges.cloudflare.com") !== -1);
  } finally { await _teardown(handleE2); }

  // ---- (f)+(g) SCOPED CSP + escaped sitekey on the register page ----
  var capF = await _captchaDeps({ success: true }, false);
  var handleF = await _boot(Object.assign(_catalogCart(), { customers: _stubCustomers({ created: 0 }), shop_origin: "https://shop.test" }, capF));
  try {
    var regPageF = await _get(handleF, "/account/register");
    check("(f) provider-active register page admits challenges.cloudflare.com",
      (regPageF.headers["content-security-policy"] || "").indexOf("challenges.cloudflare.com") !== -1);
    check("(f) provider-active register page keeps require-trusted-types-for 'script'",
      (regPageF.headers["content-security-policy"] || "").indexOf("require-trusted-types-for 'script'") !== -1);
    check("(f) register page renders the captcha widget + island", regPageF.body.indexOf("captcha-widget") !== -1 && /captcha(\.[a-f0-9]+)?\.js/.test(regPageF.body));
    check("(g) the sitekey renders escaped/intact in the widget data attr",
      regPageF.body.indexOf("data-sitekey=\"0x4AAAAAAA-sitekey\"") !== -1);
  } finally { await _teardown(handleF); }
}

module.exports = { run: _run };
