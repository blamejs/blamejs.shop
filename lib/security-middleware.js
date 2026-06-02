"use strict";
/**
 * Request-lifecycle security wiring — composes the vendored blamejs
 * middleware that defends the storefront + admin request paths into a
 * single place both the production entry point (server.js) and the
 * end-to-end harness (test/e2e/serve.js) wire identically.
 *
 * Three layers, all per-client-IP:
 *
 *   1. A generous GLOBAL rate limit (token bucket) — the backstop
 *      against credential / passkey spraying, gift-card balance
 *      brute-force, checkout hammering, and unauthenticated row-flood
 *      writes. Sized so a normal browsing + checkout session (page
 *      navigations + form POSTs + the cart-count island fetch) never
 *      trips it; only a flood does.
 *
 *   2. TIGHT per-route budgets on the abusable POST / auth endpoints
 *      (login, passkey register, checkout, gift-card balance lookup,
 *      account register, newsletter, review / question submit, survey
 *      response). A human does well under five of these a minute, so a
 *      ~10/min budget is invisible to real use and shuts spray down.
 *
 *   3. fetch-metadata (Sec-Fetch-Site / -Mode / -Dest) — refuses
 *      cross-site state-changing requests WITHOUT needing a per-form
 *      token, restoring CSRF defense-in-depth on top of the storefront's
 *      SameSite session cookies. The payment webhook routes are exempt
 *      (a payment processor's server-to-server POST is cross-site by
 *      nature and carries its own HMAC signature check).
 *
 * THE CLIENT-IP CONSTRAINT. In production the Node container sits BEHIND
 * the Cloudflare Worker: every container request arrives via the
 * Worker's forward, so the socket peer is the CF fabric, not the user.
 * Cloudflare injects the real client address as `cf-connecting-ip`
 * (with `x-real-ip` as a mirror); the Worker forwards both verbatim.
 * Every limiter here therefore keys on that header, falling back to the
 * socket address only for direct (non-proxied) connections such as the
 * e2e harness and local dev. Keying on the socket would put every
 * visitor in ONE bucket behind the fabric and let a single global limit
 * throttle the whole store.
 *
 * The container runs as a single instance (max_instances=1), so the
 * default in-memory rate-limit backend is correct — there is no second
 * replica to coordinate a shared counter with, and the in-memory token
 * bucket / fixed window need no SQL hop.
 */

var b = require("./vendor/blamejs");

// The vendored strict default CSP, as a string constant, so a route can
// derive a SCOPED copy that admits a specific payment-processor / CAPTCHA-
// provider host on script-src/connect-src/frame-src WITHOUT relaxing the
// app-level default everywhere else (see scopedCsp). Required from the
// vendored module path because the constant is exported on the module, not
// hung off the `b.middleware.securityHeaders` factory function. This is a
// top-of-domain composition read of a read-only constant, not a vendored-
// tree edit.
var _vendoredSecurityHeaders = require("./vendor/blamejs/lib/middleware/security-headers");

var C = b.constants;

// Payment webhooks are server-to-server POSTs from Stripe / PayPal:
// cross-site by nature, unthrottleable by a per-IP human budget, and
// already authenticated by an HMAC signature the edge + container both
// verify. They are exempt from BOTH the rate limiters and fetch-metadata.
var WEBHOOK_PATHS = ["/api/webhooks/stripe", "/api/webhooks/paypal"];

// Liveness / readiness probe — the container's Docker HEALTHCHECK hits
// this on a fixed cadence; never rate-limit it or a slow cold start
// could wedge the health signal.
var HEALTH_PATH = "/_/health";

// The abusable endpoints — POST / auth surfaces where a human does
// well under five requests a minute. Each gets its own per-client-IP
// budget so a spray against one can't borrow another's headroom, and a
// legitimate burst on one (a shopper re-submitting a slow checkout)
// never eats the login budget. Entries are matched as path PREFIXES so
// the dynamic `:slug` / `:token` segments and the begin/finish passkey
// sub-paths are all covered by a single stem.
//
// Prefix coverage notes:
//   /account/login            -> /account/login, /account/login/google, ...
//   /account/register         -> /account/register AND /account/register-begin
//   /account/passkey/         -> register-begin / register-finish / add-* begin+finish
//   /products/                -> the review + question submit sub-paths (gated to POST below)
//   /survey/                  -> /survey/:token (GET form + POST submit)
//   /orders/                  -> /orders/:id/cancel|rate|reorder (gated to POST below;
//                                the /orders/:id confirmation GET a shopper hits freely is NOT throttled)
var TIGHT_PREFIXES = [
  "/account/login",
  "/account/register",
  "/account/passkey/",
  "/checkout",
  "/gift-cards/balance",
  "/gift-cards",
  "/newsletter",
  "/products/",
  "/survey/",
  "/orders/",
];

// Edge-served state-changing POST endpoints. These forms are rendered at
// the Cloudflare edge (worker/render/*) into cached, cookie-less HTML that
// is byte-identical for every visitor, and their container twins must stay
// byte-identical (the render-parity gate). A per-session double-submit CSRF
// token therefore cannot be baked into the shared markup without either
// breaking parity or breaking no-JS form submission. They are exempt from
// the token check and keep their established defense: the SameSite=Lax
// session cookie + the fetch-metadata cross-site gate. Token CSRF applies to
// the container-only authenticated surface (account / subscriptions /
// checkout / admin), where a session exists and the server renders the
// token directly. Matched as path PREFIXES (covers the `:slug` / `:id`
// segments on dismiss + cart-line update/remove).
var EDGE_POST_PATHS = [
  "/cart/lines",
  "/cart/bundle",
  "/wishlist/toggle",
  "/compare/toggle",
  "/consent",
  "/currency",
  "/newsletter",
  // One-click unsubscribe (RFC 8058). The unsubscribe token in the URL IS
  // the bearer; the POST a mail client fires from List-Unsubscribe-Post
  // carries no cookies and no session CSRF token, so the path must be
  // exempt from the double-submit check (it keeps its SameSite +
  // fetch-metadata defense and is single-use + timing-safe at the token
  // layer). Container-only — there's no edge copy to keep parity with.
  "/unsubscribe",
  "/announcements/",
];

// The TLS-terminated public origin(s) the storefront is served on. Behind
// the Cloudflare Worker the container socket is plain http, so the CSRF
// origin pre-check would otherwise build `http://<host>` and refuse every
// same-origin browser POST (which carries `Origin: https://<host>`) on a
// bare scheme mismatch — breaking sign-in and every authenticated form.
// The csrf gate below trusts the Worker-forwarded `x-forwarded-proto` (so
// it derives the real https origin) AND carries this explicit allowlist as
// belt-and-suspenders for the public host. Override with the comma-
// separated SHOP_PUBLIC_ORIGINS for an alternate deploy; the default is
// the canonical origin the Worker + storefront already use as their
// fallback.
var PUBLIC_ORIGINS = (process.env.SHOP_PUBLIC_ORIGINS || "https://blamejs.shop")
  .split(",").map(function (s) { return s.trim(); }).filter(Boolean);

/**
 * Resolve the real client IP for rate-limit keying. Reads the
 * Cloudflare-injected `cf-connecting-ip` first (the canonical single
 * client address behind the fabric), then `x-real-ip` (its mirror),
 * then falls back to the socket address via `b.requestHelpers.clientIp`
 * for direct connections (e2e harness, local dev). Always returns a
 * non-empty string so two un-identifiable clients never collapse into
 * the same bucket as a real IP — request-shape reader, returns a
 * default, never throws.
 */
function clientKey(req) {
  var headers = (req && req.headers) || {};
  var cf = headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.length > 0) return cf.trim();
  var real = headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real.trim();
  var sock = b.requestHelpers.clientIp(req);
  return sock || "unknown";
}

/**
 * Build the security-headers options for createApp's
 * `middleware.securityHeaders`. The vendored blamejs default emits a
 * `Document-Policy` header asserting `document-write=?0`,
 * `unsized-media=?0`, and `oversized-images=?0`. Current Chromium
 * recognizes none of those three feature names — it parses the header,
 * rejects every token, logs "Unrecognized document policy feature name
 * <x>" to the console, and applies nothing. The header is therefore
 * inert: it adds console noise on every container response while
 * enforcing no policy. (The recognized Document-Policy feature set today
 * is `force-load-at-top` / `js-profiling` /
 * `include-js-call-stacks-in-crash-reports` / `expect-no-linked-resources`
 * / `network-efficiency-guardrails` — none of which is a control this
 * storefront needs to assert.) We have no valid, useful Document-Policy
 * to send, so disable the header rather than ship one the browser
 * rejects. This also matches the edge: the Worker's `_SECURITY_HEADERS`
 * set (worker/index.js) emits no Document-Policy, so suppressing it on
 * the container makes the two substrates header-consistent. Every other
 * vendored default (HSTS, CSP, Permissions-Policy, COOP/CORP, X-Frame-
 * Options, etc.) stays ON. Pass-through to the framework primitive — we
 * compose its `documentPolicy: false` override, never patch the vendored
 * tree.
 */
function securityHeadersOpts() {
  return { documentPolicy: false };
}

// ---- route-scoped CSP (payment processors + CAPTCHA providers) ----------
//
// The app-level CSP is the vendored strict default: `script-src 'self'`,
// `require-trusted-types-for 'script'`, `object-src 'none'`,
// `default-src 'self'`, `frame-ancestors 'none'` — no inline scripts, no
// third-party hosts. A few WRITE-side pages legitimately load a third-
// party SDK from a fixed host: the Stripe / PayPal payment pages, and the
// auth + checkout pages when an operator has enabled a CAPTCHA provider.
// Those SDK hosts can't be `'self'`, so the page needs a route-SCOPED CSP
// that admits ONLY the specific provider origin on the directives that
// provider needs (script-src / connect-src / frame-src). Every other
// protection — Trusted Types, object-src, default-src, frame-ancestors —
// stays exactly as the strict default. The inline glue that drives those
// SDKs lives in external same-origin islands (themes/default/assets/js/*),
// so `script-src` never needs `'unsafe-inline'` or a nonce.
//
// `scopedCsp(keys)` returns a CSP string for `res.setHeader(
// "content-security-policy", ...)` on the route's response. Node's
// setHeader OVERWRITES, so the route's header replaces the app-level
// default for that one response only; no other route is affected.

// The fixed, public host set per provider. Single source of truth —
// every page that admits a provider names it here, never inline. Only the
// directives the provider actually loads from are listed (Stripe needs all
// three; PayPal needs script + frame + connect; a CAPTCHA widget needs all
// three). Hosts are scheme-qualified https origins, never wildcards beyond
// what the provider's own CDN requires.
var CSP_HOSTS = {
  stripe: {
    script:  ["https://js.stripe.com"],
    connect: ["https://api.stripe.com"],
    frame:   ["https://js.stripe.com", "https://hooks.stripe.com"],
  },
  paypal: {
    script:  ["https://www.paypal.com", "https://www.paypalobjects.com"],
    frame:   ["https://www.paypal.com"],
    connect: ["https://www.paypal.com"],
  },
  // CAPTCHA providers (only the active provider's host is added per request).
  turnstile: {
    script:  ["https://challenges.cloudflare.com"],
    frame:   ["https://challenges.cloudflare.com"],
    connect: ["https://challenges.cloudflare.com"],
  },
  hcaptcha: {
    script:  ["https://js.hcaptcha.com", "https://hcaptcha.com"],
    frame:   ["https://hcaptcha.com", "https://*.hcaptcha.com"],
    connect: ["https://hcaptcha.com", "https://*.hcaptcha.com"],
  },
  recaptcha: {
    script:  ["https://www.google.com", "https://www.gstatic.com"],
    frame:   ["https://www.google.com"],
    connect: ["https://www.google.com"],
  },
};

// Directive name → the CSP_HOSTS sub-key that feeds it.
var _SCOPED_DIRECTIVES = {
  "script-src":  "script",
  "connect-src": "connect",
  "frame-src":   "frame",
};

// Directives the scoped builder MUST NOT touch — relaxing any of these
// would weaken the page's defense, which is the whole point this group
// guards against. Listed for the in-file invariant; the builder only ever
// appends to the three _SCOPED_DIRECTIVES entries.
//   default-src 'self', object-src 'none',
//   require-trusted-types-for 'script', frame-ancestors 'none', base-uri 'self'

// Parse the vendored default CSP into an ordered directive map ONCE at
// module load. The default is a `name a b; name c;` string; split on `;`,
// the first token of each clause is the directive name, the rest its
// source list.
function _parseCsp(cspString) {
  var order = [];
  var map = {};
  String(cspString).split(";").forEach(function (clause) {
    var trimmed = clause.trim();
    if (!trimmed) return;
    var parts = trimmed.split(/\s+/);
    var name = parts[0];
    order.push(name);
    map[name] = parts.slice(1);
  });
  return { order: order, map: map };
}

var _DEFAULT_CSP_PARSED = _parseCsp(_vendoredSecurityHeaders.DEFAULT_CSP);

/**
 * Build a route-scoped CSP string from the vendored strict default plus the
 * named providers' hosts. `keys` is an array of CSP_HOSTS keys
 * ("stripe" / "paypal" / "turnstile" / "hcaptcha" / "recaptcha"); each
 * adds its hosts to script-src / connect-src / frame-src (creating the
 * directive from `'self'` if the default omits it, e.g. frame-src). Every
 * other directive — including require-trusted-types-for, object-src,
 * default-src, frame-ancestors — is carried through verbatim. Unknown keys
 * are ignored (a defensive request-shape reader: a caller passing a
 * mistyped key gets the strict default for that key, never a throw on the
 * hot path of rendering a pay page). Returns the strict default unchanged
 * when `keys` is empty / not an array.
 *
 * Config-time-ish but called per-response on a render path, so it returns
 * defaults rather than throwing — a bad key degrades to the strict default,
 * which fails safe (the SDK is refused, not admitted too broadly).
 */
function scopedCsp(keys) {
  // Clone the parsed default so the per-call mutation never leaks into the
  // module-level snapshot.
  var order = _DEFAULT_CSP_PARSED.order.slice();
  var map = {};
  _DEFAULT_CSP_PARSED.order.forEach(function (name) {
    map[name] = _DEFAULT_CSP_PARSED.map[name].slice();
  });

  if (Array.isArray(keys)) {
    keys.forEach(function (key) {
      var hostSet = CSP_HOSTS[key];
      if (!hostSet) return;
      Object.keys(_SCOPED_DIRECTIVES).forEach(function (directive) {
        var subKey = _SCOPED_DIRECTIVES[directive];
        var hosts = hostSet[subKey];
        if (!hosts || !hosts.length) return;
        if (!map[directive]) {
          // The default omits frame-src (it relies on the default-src /
          // fenced-frame-src pair); create it from 'self' so admitting a
          // provider frame doesn't accidentally open it to everything.
          map[directive] = ["'self'"];
          order.push(directive);
        }
        hosts.forEach(function (h) {
          if (map[directive].indexOf(h) === -1) map[directive].push(h);
        });
      });
    });
  }

  return order.map(function (name) {
    var srcs = map[name];
    return srcs.length ? (name + " " + srcs.join(" ")) : name;
  }).join("; ") + ";";
}

/**
 * Build the GLOBAL rate-limit options for createApp's
 * `middleware.rateLimit`. Token-bucket so a bursty-but-bounded browsing
 * session is smoothed rather than clipped at a window edge.
 *
 *   burst           — the standing buffer a client may spend at once.
 *   refillPerSecond — the sustained per-second throughput.
 *
 * 300 burst + 5/s refill = a 300-request standing buffer that refills
 * to full over a minute, i.e. a 300/min sustained ceiling per client
 * IP. A very active human session (rapid navigation, the cart-count
 * island firing once per page view, form POSTs) lands far under this;
 * an unauthenticated spray flood blows straight through it. The webhook
 * + health paths skip the limiter entirely.
 */
function globalRateLimitOpts() {
  return {
    backend:         "memory",
    algorithm:       "token-bucket",
    burst:           300,
    refillPerSecond: 5,
    keyFn:           clientKey,
    skipPaths:       WEBHOOK_PATHS.concat([HEALTH_PATH]),
  };
}

function _hasPrefix(pathname, prefixes) {
  for (var i = 0; i < prefixes.length; i += 1) {
    if (pathname.indexOf(prefixes[i]) === 0) return true;
  }
  return false;
}

/**
 * Mount the per-route tight rate limiters + the fetch-metadata gate on
 * the router inside the operator's `routes(r)` chain. Call AFTER the
 * webhook raw-body capture + bodyParser are mounted (so the gate reads
 * a fully-shaped request) and BEFORE the storefront / admin routes.
 *
 * @param r  the blamejs Router passed to createApp's routes(r) callback.
 */
function mountRouteGuards(r) {
  // --- CSRF: double-submit token on authenticated state-changing POSTs ---
  //
  // The vendored createApp enforces CSRF by default; the entry points pass
  // `middleware: { csrf: false }` to disable that APP-level auto-mount and
  // we mount it here, INSIDE the route chain, so the EDGE_POST_PATHS are
  // exempt. Those are the edge-cached, cookie-less, dual-rendered forms
  // (cart-add, consent, newsletter, currency, dismiss, wishlist/compare)
  // that cannot carry a per-session token without breaking render-parity or
  // no-JS submission — they keep their SameSite + fetch-metadata defense.
  // Every other state-changing request is token-validated; the token is
  // issued on GET (exposed as `req.csrfToken`) and the storefront/admin
  // shells render it into a hidden `_csrf` field. `skipStateless` passes
  // cookie-less and bearer-token (Authorization-header) requests through —
  // they cannot be CSRF-ed (no ambient cookie credential to abuse).
  var csrfGate = b.middleware.csrfProtect({
    cookie:        true,
    skipStateless: true,
    // Behind the Cloudflare Worker the container connection is plain http
    // while the visitor is on https; trustProxy opts in the Worker-set
    // `x-forwarded-proto` so the origin pre-check derives the real public
    // origin (and the token cookie carries the `__Host-csrf` prefix),
    // matching the session-cookie stance (storefront `_secureForReq`).
    // allowedOrigins is the explicit public-host allowlist so a legitimate
    // same-origin POST is never refused as cross-origin on a proxy
    // scheme/host mismatch — the regression that breaks sign-in + every
    // authenticated form behind the CDN.
    trustProxy:     true,
    allowedOrigins: PUBLIC_ORIGINS,
  });
  r.use(function csrfGuard(req, res, next) {
    var pathname = req.pathname || req.url || "/";
    if (_hasPrefix(pathname, WEBHOOK_PATHS) || pathname === HEALTH_PATH) return next();
    if (_hasPrefix(pathname, EDGE_POST_PATHS)) return next();
    return csrfGate(req, res, next);
  });

  // --- fetch-metadata: cross-site state-change isolation -------------
  //
  // Refuses cross-site POST / PUT / DELETE / PATCH (the CSRF vector)
  // using the browser-supplied Sec-Fetch-* headers — same-origin and
  // same-site requests, plus direct navigations (typed URL / bookmark),
  // pass through. Legacy / non-browser clients that omit Sec-Fetch-*
  // are deferred to (allowMissing default) so server-to-server callers
  // and old browsers aren't broken; the storefront's SameSite session
  // cookie is the gate for those. The webhook paths are exempt because
  // a payment processor's callback is legitimately cross-site.
  var fmGate = b.middleware.fetchMetadata({
    allowSameSite:   true,
    allowCrossSite:  false,
    allowMissing:    true,
    allowedNavigate: true,
  });
  r.use(function fetchMetadataGuard(req, res, next) {
    var pathname = req.pathname || req.url || "/";
    if (_hasPrefix(pathname, WEBHOOK_PATHS)) return next();
    return fmGate(req, res, next);
  });

  // --- tight per-route rate limiters ---------------------------------
  //
  // One fixed-window limiter keyed on (client IP + path) so each
  // abusable endpoint carries its own per-client budget. Fixed-window
  // (rather than token-bucket) gives a flat, predictable "N per minute"
  // ceiling that's easy to reason about for an auth surface. ~10/min is
  // an order of magnitude above human use of any of these endpoints and
  // shuts a spray down hard.
  var tightLimiter = b.middleware.rateLimit({
    backend:   "memory",
    algorithm: "fixed-window",
    max:       10,
    windowMs:  C.TIME.minutes(1),
    keyFn:     function (req) {
      return clientKey(req) + "|" + (req.pathname || req.url || "/");
    },
  });
  r.use(function tightRateGuard(req, res, next) {
    var pathname = req.pathname || req.url || "/";
    // Never throttle the webhook or health paths.
    if (_hasPrefix(pathname, WEBHOOK_PATHS) || pathname === HEALTH_PATH) return next();
    if (!_hasPrefix(pathname, TIGHT_PREFIXES)) return next();
    // `/products/`, `/gift-cards`, and `/orders/` carry GET reads (PDP,
    // balance page render, order confirmation page) that a shopper hits
    // freely — only gate the state-changing / lookup POSTs there. For
    // `/orders/` that's the cancel/rate/reorder mutations; the
    // `GET /orders/:id` confirmation page (a customer reloads it
    // repeatedly) is never throttled. Login / register / passkey /
    // checkout / newsletter / survey are gated on every method (their
    // GETs are the form render, which a spray would hammer just the same
    // to harvest a fresh token, so the budget covers both).
    var method = (req.method || "GET").toUpperCase();
    var gateAllMethods = pathname.indexOf("/products/") !== 0 &&
                         pathname.indexOf("/gift-cards") !== 0 &&
                         pathname.indexOf("/orders/") !== 0;
    if (!gateAllMethods && method !== "POST") return next();
    return tightLimiter(req, res, next);
  });

  return { fetchMetadata: fmGate, tightLimiter: tightLimiter };
}

module.exports = {
  clientKey:            clientKey,
  securityHeadersOpts:  securityHeadersOpts,
  globalRateLimitOpts:  globalRateLimitOpts,
  mountRouteGuards:     mountRouteGuards,
  scopedCsp:            scopedCsp,
  CSP_HOSTS:            CSP_HOSTS,
  WEBHOOK_PATHS:        WEBHOOK_PATHS,
  HEALTH_PATH:          HEALTH_PATH,
  TIGHT_PREFIXES:       TIGHT_PREFIXES,
  EDGE_POST_PATHS:      EDGE_POST_PATHS,
};
