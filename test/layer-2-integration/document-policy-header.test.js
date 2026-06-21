"use strict";
/**
 * Document-Policy header hygiene — proof that no shipped response asserts
 * a legacy Document-Policy feature token (document-write / unsized-media /
 * oversized-images) that current browsers don't recognize.
 *
 * The vendored blamejs securityHeaders default emits a Document-Policy
 * header naming exactly those three tokens. Current Chromium recognizes
 * none of them: it parses the header, rejects every token, logs
 * "Document-Policy HTTP header: Unrecognized document policy feature name
 * <x>", and applies nothing — an inert header that adds console noise with
 * zero protection. The shop suppresses that copy by passing
 * `documentPolicy: false` through createApp's `middleware.securityHeaders`
 * (lib/security-middleware.js securityHeadersOpts), matching the edge
 * Worker which never sent the header.
 *
 * Two properties:
 *   a. CONTAINER — a real `b.createApp` booted with the SAME middleware
 *      composition server.js uses (securityHeadersOpts() in the
 *      securityHeaders slot) emits NO Document-Policy header, and in any
 *      case none of the three legacy tokens, on a representative page.
 *      Other vendored security headers (CSP, X-Frame-Options) still ship —
 *      proving the suppression is scoped to Document-Policy, not a blanket
 *      disable of securityHeaders.
 *   b. EDGE PARITY — the Worker's `_SECURITY_HEADERS` set (worker/index.js)
 *      emits no Document-Policy and carries none of the three tokens in a
 *      header-value shape, so whatever the container sends (here: none)
 *      the edge matches. Guarded by existsSync: worker/ is excluded from
 *      the container build context, so the assertion is skipped in the
 *      in-image smoke and runs in the full-tree CI.
 */

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var b       = bShop.framework;
var helpers = require("../helpers");
var check   = helpers.check;
var httpRequest = helpers.httpRequest;

// The three legacy Document-Policy feature names current browsers reject.
var LEGACY_TOKENS = ["document-write", "unsized-media", "oversized-images"];

// Browser-shaped headers so bot-guard (a createApp default) passes.
function _hdr(extra) {
  return Object.assign({
    "cf-connecting-ip": "203.0.113.20",
    "user-agent":       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "accept":           "text/html,application/xhtml+xml",
    "accept-language":  "en-US,en;q=0.9",
    "sec-fetch-site":   "same-origin",
    "sec-fetch-mode":   "navigate",
  }, extra || {});
}

function _hasLegacyToken(value) {
  if (typeof value !== "string") return false;
  var lower = value.toLowerCase();
  for (var i = 0; i < LEGACY_TOKENS.length; i += 1) {
    if (lower.indexOf(LEGACY_TOKENS[i]) !== -1) return true;
  }
  return false;
}

async function _container() {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-docpol-"));

  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Mirror server.js exactly: securityHeaders stays ON but drops the
    // inert Document-Policy via securityHeadersOpts(); the other app-level
    // duplicates are disabled because the shop mounts its own scoped copies.
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
      // A representative read page — the same surface that emitted the
      // unrecognized Document-Policy header in production.
      r.get("/cart", function (_req, res) { res.json({ ok: true }); });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;

  try {
    var resp = await httpRequest({ port: port, path: "/cart", headers: _hdr() });
    check("(a) container page renders (2xx)", resp.status >= 200 && resp.status < 300);

    // node:http lowercases header names. The header must be ABSENT (the
    // shop suppresses the vendored default) — and, defensively, must carry
    // none of the three legacy tokens even if a future change re-adds a
    // (valid) Document-Policy.
    var docPolicy = resp.headers["document-policy"];
    check("(a) container sends NO Document-Policy header (vendored default suppressed)",
      docPolicy === undefined);
    check("(a) container Document-Policy carries no legacy/unrecognized token",
      !_hasLegacyToken(docPolicy));

    // Suppression is scoped to Document-Policy — the rest of the vendored
    // securityHeaders posture still ships. CSP + X-Frame-Options prove
    // securityHeaders wasn't disabled wholesale.
    check("(a) securityHeaders still ON — CSP present",
      typeof resp.headers["content-security-policy"] === "string" &&
      resp.headers["content-security-policy"].length > 0);
    check("(a) securityHeaders still ON — X-Frame-Options DENY present",
      resp.headers["x-frame-options"] === "DENY");

    // (a2) HSTS on container responses behind the proxy. The vendored
    // securityHeaders middleware emits Strict-Transport-Security only when
    // the request protocol resolves to https; behind the CF Worker the
    // container socket is plain http and the real scheme rides in
    // `x-forwarded-proto`. securityHeadersOpts() supplies a protocolResolver
    // that owns that header read and ships HSTS — without it the
    // container served NO HSTS on any response. A forwarded-https request
    // carries the 2-year preload value; a plain-http request (dev / direct,
    // no forwarded-proto) correctly omits it (RFC 6797 §7.2).
    var httpsResp = await httpRequest({
      port: port, path: "/cart",
      headers: _hdr({ "x-forwarded-proto": "https", "cf-connecting-ip": "203.0.113.21" }),
    });
    check("(a2) container emits HSTS on a forwarded-https request",
      httpsResp.headers["strict-transport-security"] === "max-age=63072000; includeSubDomains; preload");

    var httpResp = await httpRequest({
      port: port, path: "/cart",
      headers: _hdr({ "x-forwarded-proto": "http", "cf-connecting-ip": "203.0.113.22" }),
    });
    check("(a2) container omits HSTS on a plain-http request (RFC 6797 §7.2)",
      httpResp.headers["strict-transport-security"] === undefined);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

function _edgeParity() {
  // worker/ is excluded from the container build context (.dockerignore),
  // so guard the source read: when worker/index.js isn't present (in-image
  // smoke) this parity assertion is skipped rather than crashing the gate
  // (an unguarded worker import bricks every container deploy). The full-
  // tree CI run has worker/ present and exercises this.
  var workerIndexPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  if (!nodeFs.existsSync(workerIndexPath)) return;

  var src = nodeFs.readFileSync(workerIndexPath, "utf8");

  // The edge header set must declare no `document-policy` key — it sends no
  // Document-Policy, matching the container (which now suppresses it). A
  // `"document-policy":` key in the _SECURITY_HEADERS object literal would
  // mean the edge ships one; assert it's absent.
  check("(b) edge _SECURITY_HEADERS declares no document-policy key",
    !/["']document-policy["']\s*:/i.test(src));

  // And no legacy token appears in a structured-field value shape anywhere
  // in the edge header source (the detector's value shape), so the two
  // substrates are header-consistent on Document-Policy.
  check("(b) edge source carries no legacy Document-Policy token value",
    !/\b(?:document-write|unsized-media|oversized-images)=\?[01]\b/i.test(src));
}

// SEC-3 — the edge HSTS is a full two-year max-age (matching the container's
// vendored default) so the two substrates are HSTS-consistent AND the edge
// response clears the 1-year HSTS-preload-list minimum. Source-read parity,
// guarded by existsSync (worker/ is absent in the in-image smoke; an
// unguarded read bricks the deploy).
function _edgeHsts() {
  var workerIndexPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  if (!nodeFs.existsSync(workerIndexPath)) return;
  var src = nodeFs.readFileSync(workerIndexPath, "utf8");

  // The edge HSTS header value is the full 2-year (63072000s) max-age with
  // includeSubDomains + preload.
  check("(c) edge HSTS is max-age=63072000 (2y), includeSubDomains, preload",
    /"strict-transport-security"\s*:\s*"max-age=63072000;\s*includeSubDomains;\s*preload"/.test(src));
  // The old 180-day value must be GONE — a regression back to it would drop
  // the edge below the preload minimum.
  check("(c) edge HSTS no longer carries the old 180-day max-age (15552000)",
    src.indexOf("max-age=15552000") === -1);

  // Container parity: the shop leaves the vendored securityHeaders `hsts` at
  // its default (server.js passes only documentPolicy), and that default IS
  // 2-year (max-age=63072000) — so an https container response carries the
  // same value the edge now sends. Assert against the vendored source so the
  // parity is two-sided and independent of the protocol-detection plumbing.
  var vendoredSrc = nodeFs.readFileSync(
    nodePath.resolve(__dirname, "..", "..", "lib", "vendor", "blamejs",
      "lib", "middleware", "security-headers.js"), "utf8");
  check("(c) container vendored HSTS default is 2-year (parity with edge)",
    /opts\.hsts === undefined\s*\?\s*"max-age=63072000;\s*includeSubDomains;\s*preload"/.test(vendoredSrc));
}

// SEC-4 — the edge Permissions-Policy denies the SAME directive set as the
// container's vendored DEFAULT_PERMISSIONS. The two substrates serve one
// origin; a shorter edge list silently weakens whatever pages the edge
// happens to serve, and a vendor refresh that grows the denylist must fail
// here instead of drifting. Source-read parity, guarded by existsSync
// (worker/ is absent in the in-image smoke; an unguarded read bricks the
// deploy).
function _edgePermissionsPolicyParity() {
  var workerIndexPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  if (!nodeFs.existsSync(workerIndexPath)) return;
  var src = nodeFs.readFileSync(workerIndexPath, "utf8");

  // Vendored list: ["accelerometer=()", ...] → directive names.
  var vendored = require("../../lib/vendor/blamejs/lib/middleware/security-headers")
    .DEFAULT_PERMISSIONS.map(function (d) { return d.replace(/=.*$/, ""); }).sort();

  // Edge list: pull the "permissions-policy" value out of the
  // _SECURITY_HEADERS literal (a multi-line concatenated string), then
  // split it into directive names.
  var m = src.match(/"permissions-policy"\s*:\s*((?:"[^"]*"\s*\+\s*)*"[^"]*")/);
  check("(d) edge declares a permissions-policy key", !!m);
  if (!m) return;
  var edgeValue = m[1].match(/"([^"]*)"/g).map(function (q) { return q.slice(1, -1); }).join("");
  var edge = edgeValue.split(",").map(function (d) { return d.trim().replace(/=.*$/, ""); })
    .filter(Boolean).sort();

  var missingOnEdge = vendored.filter(function (d) { return edge.indexOf(d) === -1; });
  var extraOnEdge   = edge.filter(function (d) { return vendored.indexOf(d) === -1; });
  check("(d) edge Permissions-Policy denies every vendored directive" +
    (missingOnEdge.length ? " — missing: " + missingOnEdge.join(", ") : ""),
    missingOnEdge.length === 0);
  check("(d) edge Permissions-Policy carries no directive the vendored list lacks" +
    (extraOnEdge.length ? " — extra: " + extraOnEdge.join(", ") : ""),
    extraOnEdge.length === 0);
  // Edge-only posture: every edge directive is deny-all `=()` — the edge
  // never hosts a passkey or payment ceremony, so nothing relaxes there.
  check("(d) every edge Permissions-Policy directive is deny-all",
    edgeValue.split(",").every(function (d) { return /=\(\)\s*$/.test(d.trim()); }));
}

async function _run() {
  await _container();
  _edgeParity();
  _edgeHsts();
  _edgePermissionsPolicyParity();
}

module.exports = { run: _run };
