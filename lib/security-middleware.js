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
];

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
    // `/products/` and `/gift-cards` carry GET reads (PDP, balance page
    // render) that a shopper hits freely — only gate the state-changing
    // / lookup POSTs there. Login / register / passkey / checkout /
    // newsletter / survey are gated on every method (their GETs are the
    // form render, which a spray would hammer just the same to harvest a
    // fresh token, so the budget covers both).
    var method = (req.method || "GET").toUpperCase();
    var gateAllMethods = pathname.indexOf("/products/") !== 0 &&
                         pathname.indexOf("/gift-cards") !== 0;
    if (!gateAllMethods && method !== "POST") return next();
    return tightLimiter(req, res, next);
  });

  return { fetchMetadata: fmGate, tightLimiter: tightLimiter };
}

module.exports = {
  clientKey:            clientKey,
  globalRateLimitOpts:  globalRateLimitOpts,
  mountRouteGuards:     mountRouteGuards,
  WEBHOOK_PATHS:        WEBHOOK_PATHS,
  HEALTH_PATH:          HEALTH_PATH,
  TIGHT_PREFIXES:       TIGHT_PREFIXES,
};
