"use strict";
/**
 * Apple Pay domain-association file — proof the
 * /.well-known/apple-developer-merchantid-domain-association route serves the
 * Stripe-provided association bytes so Apple can verify the domain and render
 * the Apple Pay button in the pay-page Express Checkout Element.
 *
 * Properties:
 *   a. Configured: the container route returns 200 text/plain with the
 *      operator-supplied bytes VERBATIM — no HTML wrapper, no escape, no
 *      appended/trimmed byte (Apple's crawl rejects any transform).
 *   b. Unconfigured: the route returns 404 (the fail-open posture — the
 *      Apple Pay button simply does not render; every other method works).
 *   c. Bot-guard skip: a verification crawl that omits Accept-Language (Apple's
 *      crawler is not guaranteed to send it) is SERVED, not 403'd, when the
 *      production bot-guard composition is active — the file is a static,
 *      unauthenticated, state-free public resource and is on the bot-guard
 *      skip list.
 *   d. Edge parity: the Worker ships the same route (reads
 *      env.APPLE_PAY_DOMAIN_ASSOCIATION, serves text/plain, 404s when unset)
 *      and forwards the value into the container env — pinned against the
 *      worker source behind an fs.existsSync guard.
 *   e. The path is registered in PUBLIC_WELL_KNOWN_PATHS and the bot-guard
 *      skip list derived from it.
 *
 * Boots a real `b.createApp` server for the container halves over loopback
 * with the shared `helpers.httpRequest` client so the assertions exercise the
 * production code path. Network: zero (no live Stripe / Apple calls).
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var WELL_KNOWN_PATH = "/.well-known/apple-developer-merchantid-domain-association";

// A representative association value with bytes that WOULD be mangled if the
// route ever HTML-escaped or otherwise transformed the body: angle brackets,
// ampersand, quotes, and a trailing newline. Stripe's real file is a hex
// blob, but the route must be transform-agnostic, so this proves verbatim
// passthrough on the harsher input.
var ASSOC_VALUE = "7B227073\"<&>'newline-follows\n2D636861\n";

async function _bootApp(deps, opts) {
  opts = opts || {};
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-applepay-"));
  var middleware = opts.botGuard
    ? {
        // Mirror server.js's bot-guard composition (the deny-list + the
        // missing-Accept-Language heuristic + the well-known skip list).
        botGuard: bShop.securityMiddleware.botGuardOpts(),
        rateLimit: false,
      }
    : { botGuard: false, rateLimit: false };
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: middleware,
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
  var query   = function () { return Promise.resolve({ rows: [], rowCount: 0 }); };
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });

  // ---- (a) configured: verbatim text/plain ----------------------------
  var handle = await _bootApp({
    catalog: catalog, cart: cart,
    apple_pay_domain_association: ASSOC_VALUE,
  });
  try {
    var resp = await helpers.httpRequest({ port: handle.port, path: WELL_KNOWN_PATH });
    check("(a) configured route 200", resp.status === 200);
    check("(a) content-type is text/plain",
      /^text\/plain/.test(String(resp.headers["content-type"] || "")));
    check("(a) body is the association bytes VERBATIM (no transform)",
      resp.body === ASSOC_VALUE);
    // The raw `<`/`&`/`"` survived — never HTML-escaped into entities.
    check("(a) angle brackets NOT HTML-escaped", resp.body.indexOf("&lt;") === -1 && resp.body.indexOf("<") !== -1);
    check("(a) ampersand NOT HTML-escaped",      resp.body.indexOf("&amp;") === -1 && resp.body.indexOf("&") !== -1);
    // Cache-Control is short so a freshly-pasted association propagates.
    check("(a) cache-control allows a short public cache",
      /max-age=300/.test(String(resp.headers["cache-control"] || "")));
  } finally {
    await _teardown(handle);
  }

  // ---- (b) unconfigured: 404 ------------------------------------------
  var handle2 = await _bootApp({ catalog: catalog, cart: cart, apple_pay_domain_association: "" });
  try {
    var resp2 = await helpers.httpRequest({ port: handle2.port, path: WELL_KNOWN_PATH });
    check("(b) unconfigured route 404", resp2.status === 404);
    check("(b) 404 body never leaks an association value", resp2.body.indexOf(ASSOC_VALUE) === -1);
  } finally {
    await _teardown(handle2);
  }

  // Also prove an ABSENT dep (not just empty string) 404s — the route never
  // throws when the operator hasn't wired the value at all.
  var handle2b = await _bootApp({ catalog: catalog, cart: cart });
  try {
    var resp2b = await helpers.httpRequest({ port: handle2b.port, path: WELL_KNOWN_PATH });
    check("(b) absent dep route 404", resp2b.status === 404);
  } finally {
    await _teardown(handle2b);
  }

  // ---- (c) bot-guard skip: crawl without Accept-Language is served -----
  var handle3 = await _bootApp(
    { catalog: catalog, cart: cart, apple_pay_domain_association: ASSOC_VALUE },
    { botGuard: true }
  );
  try {
    // Apple's verification crawl: a non-browser GET that omits Accept-Language.
    // An empty Accept-Language is falsy to the bot-guard's missing-header
    // heuristic, so without the well-known skip this would 403.
    var crawl = await helpers.httpRequest({
      port:    handle3.port,
      path:    WELL_KNOWN_PATH,
      headers: { "user-agent": "Apple Pay Web Verification", "accept-language": "", "sec-fetch-mode": "" },
    });
    check("(c) crawl without Accept-Language is SERVED (not 403)", crawl.status === 200);
    check("(c) crawl gets the verbatim association bytes", crawl.body === ASSOC_VALUE);

    // Control: a DIFFERENT no-Accept-Language path on the same bot-guarded app
    // is refused — proves the bot-guard is genuinely active and the skip is
    // scoped to the well-known path, not the whole app.
    var blocked = await helpers.httpRequest({
      port:    handle3.port,
      path:    "/cart",
      headers: { "user-agent": "Some Random Scraper", "accept-language": "", "sec-fetch-mode": "" },
    });
    check("(c) control: a non-skip path without Accept-Language IS bot-blocked (403)",
      blocked.status === 403);
  } finally {
    await _teardown(handle3);
  }

  // ---- (e) the path is on the public well-known skip list -------------
  var sm = bShop.securityMiddleware;
  check("(e) PUBLIC_WELL_KNOWN_PATHS includes the apple-pay path",
    Array.isArray(sm.PUBLIC_WELL_KNOWN_PATHS) &&
    sm.PUBLIC_WELL_KNOWN_PATHS.indexOf(WELL_KNOWN_PATH) !== -1);
  // The skip is matched the way the bot guard matches it: a string entry is a
  // prefix, a RegExp entry is .test()'d. The well-known skip is an EXACT regex,
  // so it must exempt the association path itself but NOT a sibling under it.
  function _skipMatches(skipPaths, p) {
    return (skipPaths || []).some(function (sp) {
      return (sp instanceof RegExp) ? sp.test(p) : (typeof sp === "string" && p.indexOf(sp) === 0);
    });
  }
  var skips = sm.botGuardOpts().skipPaths;
  check("(e) botGuardOpts() exempts the exact apple-pay path",
    _skipMatches(skips, WELL_KNOWN_PATH));
  check("(e) botGuardOpts() does NOT exempt a sibling under the well-known path",
    !_skipMatches(skips, WELL_KNOWN_PATH + "/evil"));

  // ---- (d) edge worker parity (guarded source-shape) ------------------
  var workerPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  if (!nodeFs.existsSync(workerPath)) return;
  var workerSrc = nodeFs.readFileSync(workerPath, "utf8");
  check("(d) worker serves the apple-pay well-known path",
    workerSrc.indexOf(WELL_KNOWN_PATH) !== -1);
  check("(d) worker reads env.APPLE_PAY_DOMAIN_ASSOCIATION",
    /env\.APPLE_PAY_DOMAIN_ASSOCIATION/.test(workerSrc));
  check("(d) worker serves the association as text/plain",
    /apple-developer-merchantid-domain-association[\s\S]{0,800}text\/plain/.test(workerSrc));
  check("(d) worker 404s the well-known path when unconfigured",
    /apple-developer-merchantid-domain-association[\s\S]{0,1200}status:\s*404/.test(workerSrc));
  // The value is forwarded into the container env passthrough so the
  // container twin sees the same bytes in production.
  check("(d) worker forwards APPLE_PAY_DOMAIN_ASSOCIATION into the container env",
    /APPLE_PAY_DOMAIN_ASSOCIATION:\s*env\.APPLE_PAY_DOMAIN_ASSOCIATION/.test(workerSrc));
}

module.exports = { run: _run };
