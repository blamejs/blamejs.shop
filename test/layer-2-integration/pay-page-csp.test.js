"use strict";
/**
 * Payment-page route-scoped CSP — proof the pay / checkout pages load the
 * Stripe / PayPal SDKs under a CSP that admits ONLY the processor host on
 * those routes, WITHOUT weakening the strict default CSP that governs every
 * other route, and WITHOUT shipping inline payment glue.
 *
 * The strict default the shop sends globally is `script-src 'self'`,
 * `require-trusted-types-for 'script'`, `object-src 'none'`,
 * `default-src 'self'`, `frame-ancestors 'none'` — no inline scripts, no
 * third-party hosts. The pay / checkout handlers set a ROUTE-scoped CSP
 * (securityMiddleware.scopedCsp) that appends the processor host to
 * script-src / connect-src / frame-src for that one response. The inline
 * Stripe / PayPal glue moved to external same-origin islands (pay.js /
 * paypal-checkout.js), so `script-src` never needs 'unsafe-inline' or a
 * nonce.
 *
 * Properties:
 *   a. scopedCsp(["stripe"]) ADMITS js.stripe.com on script-src AND keeps
 *      require-trusted-types-for / object-src 'none' / default-src 'self' /
 *      frame-ancestors 'none' — the builder must not weaken those.
 *   b. scopedCsp(["stripe","paypal"]) admits BOTH processor hosts.
 *   c. scopedCsp([]) and an UNKNOWN key return the strict default unchanged
 *      — a non-pay route is never silently relaxed.
 *   d. Over loopback HTTP: a /pay/:order_id route that sets the scoped CSP +
 *      renders renderPayPage emits the scoped CSP header (js.stripe.com in
 *      script-src), while a non-pay route on the SAME app keeps the strict
 *      default (no js.stripe.com, Trusted Types intact) — the proof the
 *      global CSP is NOT weakened.
 *   e. The rendered pay body carries the Stripe SDK <script src> + the
 *      pay.js island ref, and NO inline Stripe glue (no `Stripe(` /
 *      `stripe.elements(` literal) — the inline half moved to the island.
 *   f. An XSS-shaped order id / pk / client_secret renders ESCAPED in the
 *      data-* attributes, never as raw markup — the payload regression for
 *      this group's new sinks.
 *   g. The two new island assets exist + carry an SRI digest in the asset
 *      manifest (so _islandScript emits integrity). The third-party SDK tag
 *      is intentionally NOT SRI-pinned (rolling bundle).
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
var sf = bShop.storefront;

function _hdr(extra) {
  return Object.assign({
    "cf-connecting-ip": "203.0.113.30",
    "user-agent":       "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
    "accept":           "text/html,application/xhtml+xml",
    "accept-language":  "en-US,en;q=0.9",
    "sec-fetch-site":   "same-origin",
    "sec-fetch-mode":   "navigate",
  }, extra || {});
}

// The strict-default protections the scoped builder must NEVER drop.
var MUST_KEEP = [
  "require-trusted-types-for 'script'",
  "object-src 'none'",
  "default-src 'self'",
  "frame-ancestors 'none'",
];

function _assertProtectionsIntact(label, csp) {
  for (var i = 0; i < MUST_KEEP.length; i += 1) {
    check(label + " keeps " + MUST_KEEP[i], csp.indexOf(MUST_KEEP[i]) !== -1);
  }
  check(label + " never admits 'unsafe-inline' in script-src",
    !/script-src[^;]*'unsafe-inline'/.test(csp));
}

function _unit() {
  // (a) stripe scoped CSP admits the host + keeps every protection.
  var stripeCsp = sm.scopedCsp(["stripe"]);
  check("(a) scopedCsp(['stripe']) admits js.stripe.com on script-src",
    /script-src[^;]*https:\/\/js\.stripe\.com/.test(stripeCsp));
  check("(a) scopedCsp(['stripe']) admits api.stripe.com on connect-src",
    /connect-src[^;]*https:\/\/api\.stripe\.com/.test(stripeCsp));
  _assertProtectionsIntact("(a) stripe scoped CSP", stripeCsp);

  // (b) stripe+paypal admits both hosts.
  var bothCsp = sm.scopedCsp(["stripe", "paypal"]);
  check("(b) scopedCsp(['stripe','paypal']) admits js.stripe.com",
    /js\.stripe\.com/.test(bothCsp));
  check("(b) scopedCsp(['stripe','paypal']) admits www.paypal.com",
    /www\.paypal\.com/.test(bothCsp));
  _assertProtectionsIntact("(b) stripe+paypal scoped CSP", bothCsp);

  // (b2) the captcha provider host is admissible the same way.
  var turnstileCsp = sm.scopedCsp(["turnstile"]);
  check("(b2) scopedCsp(['turnstile']) admits challenges.cloudflare.com",
    /challenges\.cloudflare\.com/.test(turnstileCsp));
  _assertProtectionsIntact("(b2) turnstile scoped CSP", turnstileCsp);

  // (c) empty / unknown key => strict default unchanged (no host leaked).
  var emptyCsp = sm.scopedCsp([]);
  var unknownCsp = sm.scopedCsp(["totally-unknown-key"]);
  check("(c) scopedCsp([]) carries NO js.stripe.com (strict default)",
    !/js\.stripe\.com/.test(emptyCsp));
  check("(c) scopedCsp(['unknown']) carries NO third-party host (strict default)",
    unknownCsp.indexOf("https://") === -1);
  check("(c) scopedCsp([]) script-src is bare 'self'",
    /script-src 'self'(;|$)/.test(emptyCsp));
  _assertProtectionsIntact("(c) empty scoped CSP", emptyCsp);

  // (e) the rendered pay body: SDK src + island ref, no inline glue.
  var payHtml = sf.renderPayPage({
    order: { id: b.uuid.v7(), grand_total_minor: 2999, currency: "USD" },
    client_secret: "pi_test_secret_abc",
    publishable_key: "pk_test_abc",
    shop_name: "Shop",
  });
  check("(e) pay body has the Stripe SDK <script src>",
    /js\.stripe\.com\/v3\//.test(payHtml));
  check("(e) pay body references the pay.js island",
    /\/assets\/.*pay(\.[a-f0-9]+)?\.js/.test(payHtml));
  check("(e) pay body has NO inline Stripe constructor glue",
    payHtml.indexOf("Stripe({") === -1 && payHtml.indexOf("stripe.elements(") === -1);
  check("(e) pay body has NO inline <script> with executable body (only src tags)",
    !/<script>[^<]*\S[^<]*<\/script>/i.test(payHtml));

  // (f) XSS-shaped values render escaped in data-* attributes.
  var xssId = "\"><script>alert(1)</script>";
  var xssHtml = sf.renderPayPage({
    order: { id: xssId, grand_total_minor: 100, currency: "USD" },
    client_secret: "cs\"><img src=x>",
    publishable_key: "pk<b>",
    shop_name: "Shop",
  });
  check("(f) XSS order id renders ESCAPED in data-order",
    xssHtml.indexOf("data-order=\"&quot;&gt;&lt;script&gt;") !== -1);
  check("(f) XSS order id never appears raw in the markup",
    xssHtml.indexOf("<script>alert(1)") === -1);
  check("(f) XSS pk renders ESCAPED in data-pk",
    xssHtml.indexOf("data-pk=\"pk&lt;b&gt;\"") !== -1);

  // (g) island assets exist + carry SRI in the manifest.
  var manifest = require("../../lib/asset-manifest.json");
  var assets = manifest.assets || manifest;
  ["js/pay.js", "js/paypal-checkout.js", "js/captcha.js"].forEach(function (k) {
    var disk = nodePath.resolve(__dirname, "..", "..", "themes", "default", "assets", k);
    check("(g) island asset on disk: " + k, nodeFs.existsSync(disk));
    var entry = assets[k];
    check("(g) island asset in manifest with SRI: " + k,
      !!(entry && (entry.integrity || entry.sri)) &&
      String(entry.integrity || entry.sri).indexOf("sha384-") === 0);
  });
}

async function _http() {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-paycsp-"));
  var app = await b.createApp({
    dataDir: dataDir,
    vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // Mirror server.js: securityHeaders ON (strict default CSP), the shop's
    // scoped guards inside routes.
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
      // A stub pay route that does what the storefront handler does: sets the
      // route-scoped CSP, then sends the pay page.
      r.get("/pay/:order_id", function (req, res) {
        res.setHeader("content-security-policy", sm.scopedCsp(["stripe"]));
        res.status(200);
        res.setHeader("content-type", "text/html; charset=utf-8");
        var html = sf.renderPayPage({
          order: { id: req.params.order_id, grand_total_minor: 2999, currency: "USD" },
          client_secret: "pi_test_secret", publishable_key: "pk_test", shop_name: "Shop",
        });
        return res.end ? res.end(html) : res.send(html);
      });
      // A non-pay read page on the SAME app — must keep the strict default.
      r.get("/cart", function (_req, res) { res.json({ ok: true }); });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;

  try {
    // (d) the pay route emits the scoped CSP; /cart keeps the strict default.
    var payResp = await httpRequest({ port: port, path: "/pay/" + b.uuid.v7(), headers: _hdr() });
    var payCsp = payResp.headers["content-security-policy"] || "";
    check("(d) /pay response CSP admits js.stripe.com (route-scoped)",
      /js\.stripe\.com/.test(payCsp));
    _assertProtectionsIntact("(d) /pay route CSP", payCsp);

    var cartResp = await httpRequest({ port: port, path: "/cart", headers: _hdr() });
    var cartCsp = cartResp.headers["content-security-policy"] || "";
    check("(d) NON-pay /cart response carries the STRICT default (no js.stripe.com)",
      cartCsp.length > 0 && cartCsp.indexOf("https://js.stripe.com") === -1);
    check("(d) NON-pay /cart response keeps require-trusted-types-for 'script'",
      cartCsp.indexOf("require-trusted-types-for 'script'") !== -1);
    check("(d) NON-pay /cart script-src is bare 'self' (global CSP NOT weakened)",
      /script-src 'self'(;|$| )/.test(cartCsp) && cartCsp.indexOf("script-src 'self' https") === -1);
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
