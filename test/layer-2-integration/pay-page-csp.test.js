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
 *   p/d2. The pay route ALSO sets a route-scoped Permissions-Policy that
 *      re-enables the `payment` feature for the same origin + the Stripe /
 *      Google Pay wallet frames (so the Express Checkout Element's Google Pay
 *      / Apple Pay buttons can use the Payment Request API), while every other
 *      feature stays denied and a non-pay route keeps the app-level
 *      `payment=()` — the proof the global Permissions-Policy is NOT weakened.
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
  // Stripe.js v3 starts perf sub-frames + the 3DS challenge loader on
  // per-origin *.js.stripe.com hosts (Stripe security guide), so the
  // wildcard MUST be admitted on script-src or the dynamic load is refused.
  check("(a) scopedCsp(['stripe']) admits *.js.stripe.com on script-src",
    /script-src[^;]*https:\/\/\*\.js\.stripe\.com/.test(stripeCsp));
  check("(a) scopedCsp(['stripe']) admits api.stripe.com on connect-src",
    /connect-src[^;]*https:\/\/api\.stripe\.com/.test(stripeCsp));
  // frame-src must carry the apex + wildcard (Payment Element / 3DS frames),
  // hooks.stripe.com (redirect confirmations), and b.stripecdn.com (the
  // Express Checkout wallet button iframes, e.g. the Amazon Pay button) —
  // exactly the host set the probe needs to unblock the express wallets,
  // no wildcards beyond *.js.stripe.com.
  // Anchor to a directive boundary — a bare /frame-src/ also matches inside
  // `fenced-frame-src`, which carries a different (deny) value.
  var stripeFrame = (stripeCsp.match(/(?:^|;\s*)frame-src ([^;]*)/) || [])[1] || "";
  check("(a) scopedCsp(['stripe']) frame-src admits js.stripe.com",
    /https:\/\/js\.stripe\.com\b/.test(stripeFrame));
  check("(a) scopedCsp(['stripe']) frame-src admits *.js.stripe.com",
    /https:\/\/\*\.js\.stripe\.com\b/.test(stripeFrame));
  check("(a) scopedCsp(['stripe']) frame-src admits hooks.stripe.com",
    /https:\/\/hooks\.stripe\.com\b/.test(stripeFrame));
  check("(a) scopedCsp(['stripe']) frame-src admits b.stripecdn.com (Amazon Pay button iframe)",
    /https:\/\/b\.stripecdn\.com\b/.test(stripeFrame));
  // No over-broad host: EVERY wildcard host token in the whole policy must be
  // exactly `https://*.js.stripe.com` (the one Stripe documents) — no
  // `https://*.stripe.com`, `https://*.stripecdn.com`, or bare `https:`.
  var wildcardHosts = stripeCsp.match(/https:\/\/\*[^\s;]*/g) || [];
  check("(a) scopedCsp(['stripe']) every wildcard host is exactly *.js.stripe.com",
    wildcardHosts.length > 0 && wildcardHosts.every(function (h) {
      return h === "https://*.js.stripe.com";
    }));
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

  // (p) scopedPermissionsPolicy() re-enables `payment` for the pay surface
  //     ONLY — same origin + Stripe + Google Pay frames — while every other
  //     feature stays denied, and the entry derives from the vendored default.
  var pp = sm.scopedPermissionsPolicy();
  check("(p) scopedPermissionsPolicy admits self for payment",
    /payment=\([^)]*\bself\b/.test(pp));
  check("(p) scopedPermissionsPolicy admits js.stripe.com for payment",
    /payment=\([^)]*"https:\/\/js\.stripe\.com"/.test(pp));
  check("(p) scopedPermissionsPolicy admits pay.google.com for payment",
    /payment=\([^)]*"https:\/\/pay\.google\.com"/.test(pp));
  check("(p) scopedPermissionsPolicy NEVER opens payment to '*'",
    !/payment=\*/.test(pp));
  check("(p) scopedPermissionsPolicy keeps camera DENIED",
    /(^|,\s*)camera=\(\)/.test(pp));
  check("(p) scopedPermissionsPolicy keeps geolocation DENIED",
    /(^|,\s*)geolocation=\(\)/.test(pp));
  check("(p) scopedPermissionsPolicy keeps microphone DENIED",
    /(^|,\s*)microphone=\(\)/.test(pp));
  // The vendored denylist is the single source: every default feature is
  // present in the scoped string, exactly one (payment) is relaxed.
  var vendored = require("../../lib/vendor/blamejs/lib/middleware/security-headers");
  check("(p) scoped policy carries EVERY vendored feature name",
    vendored.DEFAULT_PERMISSIONS.every(function (entry) {
      var feature = entry.split("=")[0];
      return new RegExp("(^|,\\s*)" + feature + "=").test(pp);
    }));
  check("(p) scoped policy relaxes EXACTLY one feature (payment) — all others ()",
    vendored.DEFAULT_PERMISSIONS.filter(function (entry) {
      var feature = entry.split("=")[0];
      return feature !== "payment" &&
        !new RegExp("(^|,\\s*)" + feature + "=\\(\\)").test(pp);
    }).length === 0);

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

  // (e2) the Trusted Types `default` policy island is emitted BEFORE the
  //      Stripe SDK <script> tag (so the createScriptURL gate is registered
  //      before Stripe.js fires its first dynamic load), and it is NOT
  //      deferred (must run synchronously at parse time, ahead of the
  //      parser-inserted SDK tag). pay.js stays deferred and is emitted AFTER.
  var ttIdx     = payHtml.indexOf("pay-trusted-types");
  var sdkIdx    = payHtml.indexOf("js.stripe.com/v3/");
  var payJsIdx  = payHtml.search(/\/assets\/.*pay(\.[a-f0-9]+)?\.js/);
  check("(e2) pay body emits the pay-trusted-types island", ttIdx !== -1);
  check("(e2) TT policy island is emitted BEFORE the Stripe SDK tag",
    ttIdx !== -1 && sdkIdx !== -1 && ttIdx < sdkIdx);
  check("(e2) pay.js island is emitted AFTER the Stripe SDK tag",
    payJsIdx !== -1 && sdkIdx !== -1 && payJsIdx > sdkIdx);
  // The TT-policy <script> must NOT be deferred (it has to register the
  // policy before the SDK runs). Isolate its own tag and assert no `defer`.
  var ttTag = (payHtml.match(/<script[^>]*pay-trusted-types[^>]*><\/script>/) || [])[0] || "";
  check("(e2) TT policy <script> carries an integrity (SRI) attr",
    /integrity="sha384-/.test(ttTag));
  check("(e2) TT policy <script> is NOT deferred (runs sync before the SDK)",
    ttTag.length > 0 && ttTag.indexOf(" defer") === -1 && ttTag.indexOf(" async") === -1);

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
  ["js/pay.js", "js/pay-trusted-types.js", "js/paypal-checkout.js", "js/captcha.js"].forEach(function (k) {
    var disk = nodePath.resolve(__dirname, "..", "..", "themes", "default", "assets", k);
    check("(g) island asset on disk: " + k, nodeFs.existsSync(disk));
    var entry = assets[k];
    check("(g) island asset in manifest with SRI: " + k,
      !!(entry && (entry.integrity || entry.sri)) &&
      String(entry.integrity || entry.sri).indexOf("sha384-") === 0);
  });

  // (h) Trusted Types `default` policy source — the createScriptURL gate is
  //     a REAL allowlist (returns Stripe origins, throws everything else),
  //     not a relaxation. Source-shape assertions on the shipped asset plus a
  //     functional test of the validator extracted from the source.
  var ttSrc = nodeFs.readFileSync(
    nodePath.resolve(__dirname, "..", "..", "themes", "default", "assets", "js", "pay-trusted-types.js"),
    "utf8");
  check("(h) TT island registers a policy named 'default'",
    /createPolicy\(\s*["']default["']/.test(ttSrc));
  check("(h) TT island defines createScriptURL", /createScriptURL\s*:/.test(ttSrc));
  check("(h) TT island guards behind window.trustedTypes (no-op on Firefox/Safari)",
    /window\.trustedTypes/.test(ttSrc) && /createPolicy[^a-z]/.test(ttSrc));
  check("(h) TT island THROWS for non-Stripe origins (real gate, not passthrough)",
    /throw\s+new\s+TypeError/.test(ttSrc));

  // Functionally exercise the validator. The IIFE references `window` /
  // `URL`; extract the Stripe-origin regex it ships and re-derive the gate so
  // the test asserts behavior, not just text. (The regex is the load-bearing
  // allowlist — if it drifts, this fails.)
  // Capture the regex BODY between the literal's slashes (no flags shipped)
  // and rebuild it with `new RegExp` — avoids eval, and reconstructs the
  // exact allowlist the asset ships so a drift in the pattern fails here.
  var reMatch = ttSrc.match(/STRIPE_ORIGIN\s*=\s*\/(.+?)\/\s*;/);
  check("(h) TT island ships a STRIPE_ORIGIN allowlist regex", !!reMatch);
  if (reMatch) {
    var stripeOriginRe = new RegExp(reMatch[1]);
    function vet(u) {
      var origin = new URL(u, "https://blamejs.shop/").origin;
      if (stripeOriginRe.test(origin)) return u;
      throw new TypeError("blocked: " + origin);
    }
    check("(h) validator ADMITS https://js.stripe.com/v3/",
      vet("https://js.stripe.com/v3/") === "https://js.stripe.com/v3/");
    check("(h) validator ADMITS a *.js.stripe.com sub-origin",
      vet("https://m.js.stripe.com/inner.js") === "https://m.js.stripe.com/inner.js");
    var rejected = function (u) {
      try { vet(u); return false; } catch (e) { return e instanceof TypeError; }
    };
    check("(h) validator REJECTS an attacker host (evil.example.com)",
      rejected("https://evil.example.com/x.js"));
    check("(h) validator REJECTS a stripe.com lookalike (notjs.stripe.com.evil.com)",
      rejected("https://js.stripe.com.evil.com/x.js"));
    check("(h) validator REJECTS b.stripecdn.com for SCRIPT urls (frames only, never script)",
      rejected("https://b.stripecdn.com/x.js"));
    check("(h) validator REJECTS http (non-https) js.stripe.com",
      rejected("http://js.stripe.com/v3/"));
  }
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
        res.setHeader("permissions-policy", sm.scopedPermissionsPolicy());
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
    // The live response carries the FULL express-wallet frame-src host set,
    // so the Amazon Pay button iframe (b.stripecdn.com) is no longer blocked.
    var payFrame = (payCsp.match(/(?:^|;\s*)frame-src ([^;]*)/) || [])[1] || "";
    check("(d) /pay response frame-src admits *.js.stripe.com",
      /https:\/\/\*\.js\.stripe\.com\b/.test(payFrame));
    check("(d) /pay response frame-src admits b.stripecdn.com (Amazon Pay button)",
      /https:\/\/b\.stripecdn\.com\b/.test(payFrame));
    check("(d) /pay response script-src admits *.js.stripe.com (dynamic TT load path)",
      /script-src[^;]*https:\/\/\*\.js\.stripe\.com\b/.test(payCsp));
    _assertProtectionsIntact("(d) /pay route CSP", payCsp);

    // (d2) the pay route's Permissions-Policy re-enables `payment` for the
    //      Stripe / Google Pay wallet frames; the app-level strict default
    //      keeps `payment=()` on a non-pay route.
    var payPp = payResp.headers["permissions-policy"] || "";
    check("(d2) /pay response Permissions-Policy admits payment for self + Stripe + Google Pay",
      /payment=\([^)]*\bself\b/.test(payPp) &&
      /payment=\([^)]*"https:\/\/js\.stripe\.com"/.test(payPp) &&
      /payment=\([^)]*"https:\/\/pay\.google\.com"/.test(payPp));
    check("(d2) /pay response Permissions-Policy keeps camera/microphone DENIED",
      /(^|,\s*)camera=\(\)/.test(payPp) && /(^|,\s*)microphone=\(\)/.test(payPp));

    var cartResp = await httpRequest({ port: port, path: "/cart", headers: _hdr() });
    var cartCsp = cartResp.headers["content-security-policy"] || "";
    check("(d) NON-pay /cart response carries the STRICT default (no js.stripe.com)",
      cartCsp.length > 0 && !/js\.stripe\.com/.test(cartCsp));
    check("(d) NON-pay /cart response keeps require-trusted-types-for 'script'",
      cartCsp.indexOf("require-trusted-types-for 'script'") !== -1);
    check("(d) NON-pay /cart script-src is bare 'self' (global CSP NOT weakened)",
      /script-src 'self'(;|$| )/.test(cartCsp) && cartCsp.indexOf("script-src 'self' https") === -1);
    // (d2) the global Permissions-Policy denies payment everywhere else.
    var cartPp = cartResp.headers["permissions-policy"] || "";
    // Extract the payment directive token and assert it is EXACTLY the
    // empty allowlist — token equality rather than substring probing, so
    // the assertion can't be satisfied (or fooled) by lookalike hosts
    // elsewhere in the header.
    var cartPayDirective = (cartPp.match(/(?:^|,\s*)(payment=\([^)]*\))/) || [])[1] || "";
    check("(d2) NON-pay /cart response keeps payment=() (global Permissions-Policy NOT weakened)",
      cartPp.length > 0 && cartPayDirective === "payment=()");
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
