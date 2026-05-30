"use strict";
/**
 * Request-lifecycle security wiring — proof the rate limiters + the
 * fetch-metadata gate defend the abusable endpoints WITHOUT throttling
 * or blocking a real visitor.
 *
 * Boots a real `b.createApp` with the SAME `lib/security-middleware`
 * composition server.js + test/e2e/serve.js use (global per-client-IP
 * rate limit + tight per-route limiters + fetch-metadata), mounts a
 * handful of representative routes, and drives it over loopback HTTP
 * with the shared `helpers.httpRequest` client so the assertions
 * exercise the production code path.
 *
 * Four properties, the four ways this wiring could go wrong:
 *   a. A normal session (page loads + a checkout POST + a login) from
 *      ONE client IP is NOT throttled — the global budget is generous.
 *   b. Rapid repeated POSTs to a tight endpoint from one IP ARE
 *      throttled (429), while a DIFFERENT IP on the same endpoint is
 *      not — proves per-client-IP keying, not a shared global bucket.
 *   c. A cross-site POST (Sec-Fetch-Site: cross-site) to a
 *      state-changing route is blocked (403) by fetch-metadata, while a
 *      same-origin / navigation POST passes.
 *   d. The Stripe webhook path is exempt from BOTH fetch-metadata
 *      (cross-site allowed) and the rate limiter (a flood of signed
 *      deliveries is never throttled away).
 *
 * The real client IP is read from `cf-connecting-ip` (the Cloudflare
 * header the Worker forwards), so every request sets it explicitly to
 * stand in for a distinct visitor — proving the keyer reads the header,
 * not the shared loopback socket address.
 */

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var b       = bShop.framework;
var helpers = require("../helpers");
var check   = helpers.check;
var httpRequest = helpers.httpRequest;

// Browser-shaped header set so bot-guard (a createApp default) passes;
// the per-test overrides layer the cf-connecting-ip + Sec-Fetch-* on top.
function _hdr(ip, extra) {
  return Object.assign({
    "cf-connecting-ip": ip,
    "user-agent":       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "accept":           "text/html,application/xhtml+xml",
    "accept-language":  "en-US,en;q=0.9",
  }, extra || {});
}

async function _run() {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-secmw-"));

  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Mirror server.js exactly: createApp (v0.13.46+) wires cookies, CSP
    // nonce, fetch-metadata, body parser, and CSRF ON by default. The shop
    // mounts its OWN scoped copies inside routes() — the webhook-exempt body
    // parser + webhookRawBodyCapture + mountRouteGuards (fetch-metadata +
    // CSRF with the webhook exemptions). Disable createApp's app-level
    // duplicates so the shop's scoped copies are the single source of truth;
    // otherwise the app-level fetch-metadata (no webhook exemption) would 403
    // a cross-site signed webhook delivery before the exempt copy runs.
    middleware: {
      rateLimit:     bShop.securityMiddleware.globalRateLimitOpts(),
      csrf:          false,
      bodyParser:    false,
      fetchMetadata: false,
      cspNonce:      false,
    },
    routes: function (r) {
      // Capture the raw webhook body before the JSON parser, the way
      // server.js does — the signature is verified over the exact bytes.
      r.use(bShop.storefront.webhookRawBodyCapture(["/api/webhooks/stripe"]));
      r.use(b.middleware.bodyParser());
      bShop.securityMiddleware.mountRouteGuards(r);

      // A plain read page (no tight budget, no state change).
      r.get("/", function (_req, res) { res.json({ ok: true }); });
      // The per-session cart-count island the edge calls on every page.
      r.get("/cart/count", function (_req, res) { res.json({ count: 0 }); });
      // A benign same-origin checkout POST (tight-budget path).
      r.post("/checkout", function (_req, res) { res.json({ ok: true }); });
      // A tight-budget auth POST.
      r.post("/account/login", function (_req, res) { res.json({ ok: true }); });
      // The exempt payment webhook.
      r.post("/api/webhooks/stripe", function (_req, res) { res.json({ ok: true }); });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;

  try {
    // ---- (a) A normal session from ONE IP is not throttled ----------
    //
    // 40 page loads + 40 cart-count island fetches + a checkout + a
    // login, all from one visitor, in a tight loop — far busier than a
    // real minute of browsing, and well under the 300-burst global
    // budget. Every request must be a 2xx (the navigation Sec-Fetch-Site
    // lets the state-changing POSTs through fetch-metadata).
    var sessionIp = "203.0.113.10";
    var nav = { "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate" };
    var throttledInSession = 0;
    for (var i = 0; i < 40; i += 1) {
      var pg = await httpRequest({ port: port, path: "/",           headers: _hdr(sessionIp, nav) });
      var cc = await httpRequest({ port: port, path: "/cart/count", headers: _hdr(sessionIp, nav) });
      if (pg.status === 429 || cc.status === 429) throttledInSession += 1;
    }
    var co = await httpRequest({ port: port, method: "POST", path: "/checkout",      headers: _hdr(sessionIp, nav), form: { x: "1" } });
    var lo = await httpRequest({ port: port, method: "POST", path: "/account/login", headers: _hdr(sessionIp, nav), form: { u: "a" } });
    check("(a) normal session: no page/island request throttled", throttledInSession === 0);
    check("(a) normal session: checkout POST passes (2xx)", co.status >= 200 && co.status < 300);
    check("(a) normal session: login POST passes (2xx)",    lo.status >= 200 && lo.status < 300);

    // ---- (b) Tight endpoint sprays one IP, spares another -----------
    //
    // The tight budget is 10/min per (IP + path). A fresh IP fires 15
    // rapid logins: the first ~10 pass, the rest 429. A SECOND IP on
    // the same endpoint is untouched — proving per-client-IP keying
    // rather than a shared bucket. (Each request carries the same-origin
    // Sec-Fetch-Site so fetch-metadata never interferes.)
    var sprayIp = "198.51.100.7";
    var spray2xx = 0, spray429 = 0;
    for (var s = 0; s < 15; s += 1) {
      var r1 = await httpRequest({ port: port, method: "POST", path: "/account/login", headers: _hdr(sprayIp, nav), form: { u: "a" } });
      if (r1.status === 429) spray429 += 1;
      else if (r1.status >= 200 && r1.status < 300) spray2xx += 1;
    }
    check("(b) spray IP: ~10 logins pass before the cap", spray2xx >= 1 && spray2xx <= 10);
    check("(b) spray IP: excess logins are 429", spray429 >= 4);

    var freshIp = "198.51.100.99";
    var fresh = await httpRequest({ port: port, method: "POST", path: "/account/login", headers: _hdr(freshIp, nav), form: { u: "a" } });
    check("(b) a different IP on the same endpoint is NOT throttled (per-IP keying)", fresh.status >= 200 && fresh.status < 300);

    // The global budget is separate + generous: the same sprayer can
    // still load a non-tight read page (the tight 429 is per-path).
    var readAfterSpray = await httpRequest({ port: port, path: "/", headers: _hdr(sprayIp, nav) });
    check("(b) tight 429 is per-path: the sprayer can still read pages", readAfterSpray.status >= 200 && readAfterSpray.status < 300);

    // ---- (c) Cross-site POST blocked; same-origin passes ------------
    //
    // A cross-site state-changing POST (the CSRF vector) is refused 403
    // by fetch-metadata. The same route from a same-origin / navigation
    // context passes. Use a fresh IP so the tight budget isn't in play.
    var csrfIp = "203.0.113.55";
    var crossSite = await httpRequest({
      port: port, method: "POST", path: "/checkout",
      headers: _hdr(csrfIp, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors" }),
      form: { x: "1" },
    });
    check("(c) cross-site POST to /checkout is refused (403)", crossSite.status === 403);

    var sameOrigin = await httpRequest({
      port: port, method: "POST", path: "/checkout",
      headers: _hdr("203.0.113.56", { "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" }),
      form: { x: "1" },
    });
    check("(c) same-origin POST to /checkout passes (2xx)", sameOrigin.status >= 200 && sameOrigin.status < 300);

    // A legacy / non-browser client that omits Sec-Fetch-* is deferred
    // to (allowMissing) — the SameSite cookie is the gate there. Use a
    // fresh IP so the tight budget doesn't mask the result.
    var noFetchMeta = await httpRequest({
      port: port, method: "POST", path: "/checkout",
      headers: _hdr("203.0.113.57", {}),
      form: { x: "1" },
    });
    check("(c) Sec-Fetch-* absent: deferred to other layers, not 403", noFetchMeta.status !== 403);

    // ---- (d) Stripe webhook exempt from BOTH gates ------------------
    //
    // A cross-site signed delivery to the webhook path must NOT be 403'd
    // by fetch-metadata, and a flood of them must NOT be rate-limited
    // away. Fire 25 cross-site POSTs from ONE IP (past both the tight 10
    // budget AND any cross-site refusal) — every one must reach the
    // handler (2xx).
    var hookIp = "198.51.100.200";
    var hookBlocked = 0;
    for (var h = 0; h < 25; h += 1) {
      var hk = await httpRequest({
        port: port, method: "POST", path: "/api/webhooks/stripe",
        headers: _hdr(hookIp, { "sec-fetch-site": "cross-site", "sec-fetch-mode": "cors", "content-type": "application/json" }),
        body: JSON.stringify({ id: "evt_" + h }),
      });
      if (hk.status === 403 || hk.status === 429) hookBlocked += 1;
    }
    check("(d) webhook path: never 403 (fetch-metadata exempt) and never 429 (rate-limit exempt)", hookBlocked === 0);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
