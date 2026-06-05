"use strict";
/**
 * Passkey route-scoped Permissions-Policy — proof the WebAuthn ceremony
 * pages re-enable ONLY the feature their island needs, scoped to `self`, on
 * exactly those routes, WITHOUT weakening the strict deny-all Permissions-
 * Policy that governs every other route.
 *
 * The app-level Permissions-Policy is the vendored strict denylist: every
 * powerful API disabled in every document, including
 * `publickey-credentials-get=()` and `publickey-credentials-create=()`. Under
 * the deny-all the browser refuses navigator.credentials.get / .create in the
 * TOP-LEVEL document ("The 'publickey-credentials-get' feature is not enabled
 * in this document"), so passkey sign-in / enrollment fail outright.
 *
 * The fix re-enables the one feature each ceremony needs for `self` only, on
 * that route's response, via securityMiddleware.scopedPermissionsPolicy({
 * features: [...] }):
 *   GET /account/login    — publickey-credentials-get   (passkey-login.js)
 *   GET /account/register — publickey-credentials-create (passkey-register.js)
 *   GET /account/passkeys — publickey-credentials-create (passkey-add.js)
 *
 * Properties:
 *   (u1) scopedPermissionsPolicy({ features:["publickey-credentials-get"] })
 *        admits `self` for that feature, keeps -create denied, keeps every
 *        other feature denied, and never opens the feature to `*`.
 *   (u2) the -create variant is symmetric.
 *   (u3) both-at-once relaxes EXACTLY those two; the vendored list is the
 *        single source (every default feature present, no feature invented).
 *   (u4) no-arg / empty / unknown-feature => the strict payment-only default
 *        (no WebAuthn feature relaxed) — a non-passkey route is never silently
 *        relaxed by a mistyped key.
 *   (h1) over loopback HTTP: /account/login emits a Permissions-Policy whose
 *        publickey-credentials-get is `(self)`, -create stays `()`.
 *   (h2) /account/register + /account/passkeys emit -create `(self)`, -get
 *        stays `()`.
 *   (h3) an unrelated page (home) on the SAME app keeps BOTH WebAuthn
 *        features at `()` — the global Permissions-Policy is NOT weakened.
 *
 * Header tokens are asserted by exact-directive equality (extract the
 * `feature=(...)` token and compare it whole), never a loose substring, so a
 * lookalike elsewhere in the header can't satisfy or fool the assertion.
 */

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var b       = bShop.framework;
var helpers = require("../helpers");
var check   = helpers.check;
var httpRequest = helpers.httpRequest;

var sm = bShop.securityMiddleware;

var GET    = "publickey-credentials-get";
var CREATE = "publickey-credentials-create";

function _hdr(extra) {
  return Object.assign({
    "cf-connecting-ip": "203.0.113.40",
    "user-agent":       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "accept":           "text/html,application/xhtml+xml",
    "accept-language":  "en-US,en;q=0.9",
    "sec-fetch-site":   "same-origin",
    "sec-fetch-mode":   "navigate",
  }, extra || {});
}

// Extract the whole `feature=(...)` directive token from a Permissions-Policy
// string. Returns "" if the feature is absent. Token equality (not substring)
// is the assertion currency throughout.
function _directive(policy, feature) {
  var re = new RegExp("(?:^|,\\s*)(" + feature.replace(/[-]/g, "\\-") + "=\\([^)]*\\))");
  return (String(policy).match(re) || [])[1] || "";
}

function _unit() {
  var vendored = require("../../lib/vendor/blamejs/lib/middleware/security-headers");

  // (u1) get-only: feature is (self); create stays (); all others ().
  var getPolicy = sm.scopedPermissionsPolicy({ features: [GET] });
  check("(u1) get variant: publickey-credentials-get is EXACTLY (self)",
    _directive(getPolicy, GET) === GET + "=(self)");
  check("(u1) get variant: publickey-credentials-create stays EXACTLY ()",
    _directive(getPolicy, CREATE) === CREATE + "=()");
  check("(u1) get variant: never opens the feature to '*'",
    getPolicy.indexOf(GET + "=*") === -1);
  check("(u1) get variant: keeps camera/geolocation/microphone DENIED",
    /(^|,\s*)camera=\(\)/.test(getPolicy) &&
    /(^|,\s*)geolocation=\(\)/.test(getPolicy) &&
    /(^|,\s*)microphone=\(\)/.test(getPolicy));
  check("(u1) get variant: keeps payment DENIED (not the pay surface)",
    _directive(getPolicy, "payment") === "payment=()");

  // (u2) create-only: symmetric.
  var createPolicy = sm.scopedPermissionsPolicy({ features: [CREATE] });
  check("(u2) create variant: publickey-credentials-create is EXACTLY (self)",
    _directive(createPolicy, CREATE) === CREATE + "=(self)");
  check("(u2) create variant: publickey-credentials-get stays EXACTLY ()",
    _directive(createPolicy, GET) === GET + "=()");
  check("(u2) create variant: never opens the feature to '*'",
    createPolicy.indexOf(CREATE + "=*") === -1);
  check("(u2) create variant: keeps payment DENIED",
    _directive(createPolicy, "payment") === "payment=()");

  // (u3) both relaxed at once => exactly those two; vendored list is source.
  var bothPolicy = sm.scopedPermissionsPolicy({ features: [GET, CREATE] });
  check("(u3) both variant: get is (self) AND create is (self)",
    _directive(bothPolicy, GET) === GET + "=(self)" &&
    _directive(bothPolicy, CREATE) === CREATE + "=(self)");
  check("(u3) scoped policy carries EVERY vendored feature name",
    vendored.DEFAULT_PERMISSIONS.every(function (entry) {
      var feature = entry.split("=")[0];
      return new RegExp("(^|,\\s*)" + feature + "=").test(bothPolicy);
    }));
  check("(u3) scoped policy relaxes EXACTLY the two WebAuthn features — all others ()",
    vendored.DEFAULT_PERMISSIONS.filter(function (entry) {
      var feature = entry.split("=")[0];
      return feature !== GET && feature !== CREATE &&
        !new RegExp("(^|,\\s*)" + feature + "=\\(\\)").test(bothPolicy);
    }).length === 0);

  // (u4) no-arg / empty => the payment-only default (the established pay-
  //      surface behavior); neither WebAuthn feature is relaxed.
  var defaultPolicy = sm.scopedPermissionsPolicy();
  var emptyPolicy   = sm.scopedPermissionsPolicy({ features: [] });
  [["no-arg", defaultPolicy], ["empty", emptyPolicy]].forEach(function (pair) {
    check("(u4) " + pair[0] + ": publickey-credentials-get stays ()",
      _directive(pair[1], GET) === GET + "=()");
    check("(u4) " + pair[0] + ": publickey-credentials-create stays ()",
      _directive(pair[1], CREATE) === CREATE + "=()");
  });
  // The no-arg default IS the pay surface (payment relaxed) — unchanged from
  // the established behavior the /pay route depends on.
  check("(u4) no-arg default still relaxes payment (pay-surface back-compat)",
    /payment=\([^)]*\bself\b/.test(defaultPolicy) &&
    _directive(defaultPolicy, "payment") === 'payment=(self "https://js.stripe.com" "https://pay.google.com")');

  // (u4b) an explicit but UNKNOWN feature relaxes NOTHING — fail-safe: a
  //       mistyped key leaves every feature at the strict deny, including
  //       payment and both WebAuthn features. The mistake degrades to the
  //       full strict denylist, never to an over-broad grant.
  var unknownPolicy = sm.scopedPermissionsPolicy({ features: ["totally-unknown-feature"] });
  check("(u4b) unknown feature: payment stays () (fail-safe, nothing relaxed)",
    _directive(unknownPolicy, "payment") === "payment=()");
  check("(u4b) unknown feature: both WebAuthn features stay ()",
    _directive(unknownPolicy, GET) === GET + "=()" &&
    _directive(unknownPolicy, CREATE) === CREATE + "=()");
  check("(u4b) unknown feature: NO feature opened to (self) or '*'",
    unknownPolicy.indexOf("=(self)") === -1 && unknownPolicy.indexOf("=*") === -1);
}

async function _http() {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-pk-pp-"));
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Mirror server.js: securityHeaders ON (strict default Permissions-Policy
    // built from the vendored denylist), the shop's scoped guards in routes.
    middleware: {
      securityHeaders: bShop.securityMiddleware.securityHeadersOpts(),
      rateLimit:       bShop.securityMiddleware.globalRateLimitOpts(),
      csrf:            false,
      bodyParser:      false,
      fetchMetadata:   false,
      cspNonce:        false,
    },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.securityMiddleware.mountRouteGuards(r);
      // Stub passkey-ceremony routes that do what the storefront handlers do:
      // set the route-scoped Permissions-Policy, then send HTML.
      function _html(res, policy) {
        res.setHeader("permissions-policy", policy);
        res.status(200);
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end ? res.end("<!doctype html><title>ok</title>") : res.send("ok");
      }
      r.get("/account/login", function (_req, res) {
        return _html(res, sm.scopedPermissionsPolicy({ features: [GET] }));
      });
      r.get("/account/register", function (_req, res) {
        return _html(res, sm.scopedPermissionsPolicy({ features: [CREATE] }));
      });
      r.get("/account/passkeys", function (_req, res) {
        return _html(res, sm.scopedPermissionsPolicy({ features: [CREATE] }));
      });
      // An unrelated read page on the SAME app — must keep the strict default
      // (both WebAuthn features denied).
      r.get("/", function (_req, res) { res.json({ ok: true }); });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;

  try {
    // (h1) /account/login: get is (self); create stays ().
    var loginResp = await httpRequest({ port: port, path: "/account/login", headers: _hdr() });
    var loginPp = loginResp.headers["permissions-policy"] || "";
    check("(h1) /account/login response carries a Permissions-Policy",
      loginPp.length > 0);
    check("(h1) /account/login: publickey-credentials-get is EXACTLY (self)",
      _directive(loginPp, GET) === GET + "=(self)");
    check("(h1) /account/login: publickey-credentials-create stays EXACTLY ()",
      _directive(loginPp, CREATE) === CREATE + "=()");

    // (h2) /account/register + /account/passkeys: create is (self); get ().
    var regResp = await httpRequest({ port: port, path: "/account/register", headers: _hdr() });
    var regPp = regResp.headers["permissions-policy"] || "";
    check("(h2) /account/register: publickey-credentials-create is EXACTLY (self)",
      _directive(regPp, CREATE) === CREATE + "=(self)");
    check("(h2) /account/register: publickey-credentials-get stays EXACTLY ()",
      _directive(regPp, GET) === GET + "=()");

    var pkResp = await httpRequest({ port: port, path: "/account/passkeys", headers: _hdr() });
    var pkPp = pkResp.headers["permissions-policy"] || "";
    check("(h2) /account/passkeys: publickey-credentials-create is EXACTLY (self)",
      _directive(pkPp, CREATE) === CREATE + "=(self)");
    check("(h2) /account/passkeys: publickey-credentials-get stays EXACTLY ()",
      _directive(pkPp, GET) === GET + "=()");

    // (h3) the home page keeps the strict default — BOTH WebAuthn features
    //      denied (scoping intact; global Permissions-Policy NOT weakened).
    var homeResp = await httpRequest({ port: port, path: "/", headers: _hdr() });
    var homePp = homeResp.headers["permissions-policy"] || "";
    check("(h3) home response carries the strict default Permissions-Policy",
      homePp.length > 0);
    check("(h3) home: publickey-credentials-get stays EXACTLY () (NOT weakened)",
      _directive(homePp, GET) === GET + "=()");
    check("(h3) home: publickey-credentials-create stays EXACTLY () (NOT weakened)",
      _directive(homePp, CREATE) === CREATE + "=()");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

async function _run() {
  _unit();
  await _http();
}

module.exports = { run: _run };
