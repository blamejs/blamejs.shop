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
 * That read goes through `b.requestHelpers.trustedClientIp`, which honours
 * the forwarded header only when the socket peer sits inside the trusted
 * range (see TRUSTED_PROXY_CIDRS) — a header alone never speaks for a client.
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

// Server-to-server webhooks: cross-site by nature, unthrottleable by a
// per-IP human budget, and each authenticated by its own gate the handler
// verifies first thing — an HMAC signature (Stripe / PayPal) or a per-
// endpoint signing secret (the ESP bounce / complaint intake). They are
// exempt from the rate limiters, fetch-metadata, and the double-submit CSRF
// token (a third-party POST carries no session cookie or token). The
// `/api/` prefix also lands them in the vendored bot-guard's onlyForHtml
// skip, so the secret / signature gate is the deciding check.
var WEBHOOK_PATHS = [
  "/api/webhooks/stripe",
  "/api/webhooks/paypal",
  "/api/webhooks/mail-bounce",
];

// Liveness / readiness probe — the container's Docker HEALTHCHECK hits
// this on a fixed cadence; never rate-limit it or a slow cold start
// could wedge the health signal.
var HEALTH_PATH = "/_/health";

// Per-client-IP budget on POST /api/webhooks/paypal (see the limiter in
// mountRouteGuards). Generous against PayPal's real delivery cadence —
// redelivery is ~25 attempts per event spread over days, so even a
// post-downtime backlog flush of distinct events sits far under this —
// while bounding how many verify-webhook-signature dials a spammer can
// force per minute.
var PAYPAL_WEBHOOK_BUDGET_PER_MINUTE = 120;

// Worker→container internal endpoints — machine-to-machine POSTs over
// the Cloudflare service binding (cron ticks + the InventoryLock DO's
// low-stock event), each authenticated FIRST thing in its handler by a
// constant-time check of the shared D1_BRIDGE_SECRET header. The
// worker's fetch() carries no browser fingerprint (no User-Agent, no
// Accept-Language), so bot-guard's missing-Accept-Language heuristic
// 403s every one of these calls before the handler's own — strictly
// stronger — secret gate ever runs, and it does so silently: the
// worker fires them under ctx.waitUntil / fire-and-forget and reads
// nothing back. Skipping bot-guard here does not weaken the surface
// (an unauthenticated caller still gets the handler's 401); it makes
// the shared-secret gate the deciding check, which is the design.
// HEALTH_PATH is deliberately NOT in this list — the Docker
// HEALTHCHECK probe is browser-shaped by contract and bot-guard stays
// on for it.
var INTERNAL_BRIDGE_PATHS = [
  "/_/cart-recovery-tick",
  "/_/stock-alert-sweep",
  "/_/low-stock-alert",
  "/_/wishlist-alerts-sweep",
  "/_/wishlist-digest-sweep",
  "/_/campaign-send-tick",
  "/_/winback-send-tick",
  "/_/customer-portal-expire",
  "/_/stale-order-reap",
  "/_/quote-expiry-tick",
  "/_/webhook-retry-tick",
];

// Public well-known paths fetched by third-party verification crawlers
// rather than browsers. Apple's Apple Pay domain-verification crawl GETs
// the merchantid association file and is not guaranteed to send
// Accept-Language, which the bot-guard's missing-Accept-Language heuristic
// would 403 — silently hiding the Apple Pay button (the same
// machine-caller-blocked-before-its-real-gate failure the worker→container
// paths above hit). The file is a static, unauthenticated, state-free
// public resource (the route 404s when unconfigured and only ever serves
// the operator-supplied association bytes), so skipping the browser
// fingerprint check on it weakens nothing. In production the crawl lands on
// the edge Worker, which serves the file before any container hop; this
// skip keeps a direct-to-container fetch (or an edge-serving-off deploy)
// from refusing the verification crawl.
var PUBLIC_WELL_KNOWN_PATHS = [
  "/.well-known/apple-developer-merchantid-domain-association",
];

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
//   /stock-alert/             -> subscribe + unsubscribe. Subscribe is anonymous,
//                                CSRF-exempt (EDGE_POST_PATHS), and emails the
//                                request-supplied address — without the tight
//                                budget it is a victim-addressed mail cannon on
//                                the loose global bucket alone.
//   /cart/coupon              -> apply + remove a typed discount code. POST /cart/coupon
//                                validates the code against the discount engine; on a
//                                miss it returns a UNIFORM error (no existence oracle),
//                                which makes the loose global bucket alone a code-guessing
//                                engine — a sprayer can grind the coupon namespace for a
//                                live code. The tight per-(IP+path) budget caps the
//                                guess rate (same guessable-secret rationale as the
//                                /gift-cards/balance lookup). Container-only.
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
  "/stock-alert/",
  "/cart/coupon",
  // Public suggestion box — anonymous submit + vote POSTs. The submit writes
  // a free-text row and the vote bumps a counter; on the loose global bucket
  // alone an anonymous sprayer could flood the backlog or grind a vote. The
  // tight per-(IP+path) budget caps the rate. Container-only (CSRF-tokened),
  // so it is NOT in EDGE_POST_PATHS — the page carries a per-session token.
  "/suggestions",
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
  // Back-in-stock "Notify me" — the subscribe form lives on the edge-cached,
  // cookie-less PDP buy box (dual-rendered byte-identical with the worker
  // twin), so it cannot carry a per-session `_csrf` token. A DISTINCT
  // top-level action keeps `/products/` (which DOES require the token on its
  // review + question POSTs) un-exempted. Keeps SameSite + fetch-metadata
  // defense; the confirm/unsubscribe GETs need no CSRF. Kept in lockstep with
  // the `edge-form-csrf-exempt` detector lookahead in
  // test/layer-0-primitives/codebase-patterns.test.js.
  "/stock-alert/subscribe",
  // Back-in-stock one-click unsubscribe — same bearer-token model as
  // /unsubscribe above. The opaque, per-row token in the `?token=` link IS
  // the authorization; the POST a mail client fires carries no cookies and no
  // session CSRF token, so the path is exempt from the double-submit check
  // (it keeps SameSite + fetch-metadata defense and is enumeration-safe +
  // timing-safe at the token layer).
  "/stock-alert/unsubscribe",
];

// Authenticated, container-only POST routes that fall UNDER an EDGE_POST_PATHS
// prefix but must NOT inherit the edge exemption. `/cart/lines` is exempt for
// the edge-cached add / qty-update / remove forms (worker/render/*), which are
// cookie-less and token-less. But `POST /cart/lines/:line_id/save` is a
// login-required mutation rendered ONLY by the container (the "Save for later"
// control on the session-bound cart page), where a session exists and the page
// carries the per-request `_csrf` token. A bare `/cart/lines` prefix match
// would exempt it by accident, dropping double-submit CSRF on an authenticated
// state change. These carve-backs re-arm the token check on exactly those
// paths while leaving every legitimate edge form exempt. Matched as exact
// regexes (anchored, `:line_id` as a free segment) so a sibling edge path is
// never re-captured.
var EDGE_EXEMPT_CARVEBACKS = [
  /^\/cart\/lines\/[^/]+\/save$/,
];

/**
 * Is `pathname` covered by the edge-form CSRF exemption? True when it matches
 * an EDGE_POST_PATHS prefix AND is not one of the authenticated container-only
 * carve-backs above. The single source both the container csrfGuard and the
 * storefront's `_csrf` form-injection consult, so the exemption set the guard
 * skips and the set the renderer leaves token-less can never drift apart.
 * Request-shape reader — returns a boolean for any input, never throws.
 */
function isEdgeExemptPath(pathname) {
  var p = typeof pathname === "string" ? pathname : "";
  if (!_hasPrefix(p, EDGE_POST_PATHS)) return false;
  for (var i = 0; i < EDGE_EXEMPT_CARVEBACKS.length; i += 1) {
    if (EDGE_EXEMPT_CARVEBACKS[i].test(p)) return false;
  }
  return true;
}

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

// Which socket peers may speak for a client other than themselves.
//
// Same topology as resolveProtocol below: the container has no public ingress
// and is reachable only through the Cloudflare Worker over the service
// binding, so every peer that can open a socket here IS the edge — which is
// what the all-addresses default states. It is written as a CIDR list rather
// than an unconditional "believe the header" so that a deployment which does
// expose the container directly has one value to narrow, and so the gate is
// the framework's rather than a second trust model living here.
//
// Narrowing it is the right move the moment the container is reachable any
// other way: an unlisted peer's forwarded headers are ignored and keying falls
// back to that peer's own address.
var TRUSTED_PROXY_CIDRS = (process.env.SHOP_TRUSTED_PROXIES || "0.0.0.0/0,::/0")
  .split(",").map(function (s) { return s.trim(); }).filter(Boolean);

// The edge publishes the client address as `cf-connecting-ip` and overwrites
// any value a client sent under that name. `x-real-ip` is the usual nginx
// spelling and `x-forwarded-for` the multi-hop standard, kept for a
// self-hosted deployment behind either. First header PRESENT wins, so an empty
// leading header means "this request carries no forwarded address" rather than
// deferring to one further down the list that a client may have set.
var _trustedClientIp = b.requestHelpers.trustedClientIp({
  trustedProxies:   TRUSTED_PROXY_CIDRS,
  forwardedHeaders: ["cf-connecting-ip", "x-real-ip", "x-forwarded-for"],
});

/**
 * Resolve the real client IP for rate-limit keying. Always returns a
 * non-empty string so two un-identifiable clients never collapse into
 * the same bucket as a real IP — request-shape reader, returns a
 * default, never throws.
 *
 * The resolved address is collapsed to its rate-limit-significant key via
 * `b.requestHelpers.ipKey`: an IPv4 host is kept verbatim, but an IPv6
 * client is masked to its /64 prefix. A single end-site is allocated a
 * whole IPv6 /64 (RFC 6177 / RFC 4291) and freely rotates the low 64 bits,
 * so keying on the full 128-bit address would let one site present a fresh
 * source on every request and mint unlimited buckets — walking every
 * per-IP limiter (and the captcha-IP budget) that keys off this value.
 * Keying on the /64 closes that while still distinguishing real end-sites.
 *
 * Resolution itself is `b.requestHelpers.trustedClientIp`, which reads the
 * header family named below, folds an IPv4-mapped IPv6 peer, walks a multi-hop
 * value right-to-left, and falls back to the socket address — one implementation
 * shared with every other gate rather than a second, looser one here.
 */
function clientKey(req) {
  var ip = _trustedClientIp.resolve(req);
  return ip ? _ipBucket(ip) : "unknown";
}

// Collapse one resolved client IP to its per-IP bucket key. ipKey returns
// "" for a value that isn't a parseable IP (a malformed header, "unknown"),
// so we fall back to the original non-empty string — keeping two
// un-identifiable clients in distinct buckets rather than collapsing every
// garbage value into one shared bucket.
function _ipBucket(ip) {
  return b.requestHelpers.ipKey(ip, { ipv6Bits: 64 }) || ip;
}

/**
 * Own the HTTPS decision for every proxy-trust consumer in one place — the
 * single trust model the security middleware (HSTS via securityHeaders, the
 * Secure-cookie + Origin pre-check via csrfProtect) and the storefront/admin
 * session-cookie Secure flag all resolve protocol through.
 *
 * Topology: the Node container has NO public ingress. It is reachable only
 * through the Cloudflare Worker over the service binding, and the edge always
 * terminates TLS, so the real client scheme rides in the Worker-set
 * `x-forwarded-proto` (always `https` for a real visitor). Because no internet
 * caller can reach the container socket, that header cannot be forged from
 * outside — so honoring it is correct here. blamejs 0.15.14 stopped trusting a
 * bare `trustProxy` (a forgeable X-Forwarded-Proto from a *directly reachable*
 * socket); it hands the decision to an operator-supplied `protocolResolver`
 * when the operator can attest the header's provenance, which this deployment
 * can. A direct dev / e2e connection carries no forwarded header and a plain
 * socket, so it resolves to `http` (and the bare-named, non-Secure cookie a
 * browser will actually store over loopback is emitted).
 *
 * Request-shape reader — returns "http"|"https" for any input, never throws.
 */
function resolveProtocol(req) {
  var headers = (req && req.headers) || {};
  var xfp = headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.length > 0) {
    // Leftmost hop is the original client scheme (the Worker sets a single
    // `https` token). Normalize and accept only the two valid schemes.
    var first = xfp.split(",")[0].trim().toLowerCase();
    if (first === "https" || first === "http") return first;
  }
  // No forwarded header → direct connection. Delegate the socket-scheme
  // derivation to the vendored primitive (trustProxy:false = socket-only) so
  // that fallback stays single-sourced in the framework.
  return b.requestHelpers.requestProtocol(req, { trustProxy: false });
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
 *
 * `referrerPolicy: "same-origin"` overrides the vendored `no-referrer`
 * default. Under `no-referrer`, browsers serialize the Origin header as
 * the opaque string "null" on same-origin NAVIGATIONAL form POSTs (Fetch
 * spec: a no-referrer referrer policy opaques the Origin on non-GET
 * navigations). The CSRF gate's origin pre-check refuses "null" before
 * the double-submit token is read, so every checkout / sign-in / account
 * / admin form submit 403s in a real browser — while loopback tests,
 * which send no Origin header at all, pass. `same-origin` keeps the
 * external privacy posture identical (no referrer ever leaves the site)
 * while restoring a real Origin on same-origin POSTs, which the gate
 * verifies against PUBLIC_ORIGINS. Cross-site and sandboxed-iframe
 * submits still arrive with a foreign or "null" Origin and are still
 * refused — the defense is unchanged; only the false positive is gone.
 * The Worker emits the same policy (worker/index.js _SECURITY_HEADERS)
 * so both substrates stay header-consistent.
 */
function securityHeadersOpts() {
  // `protocolResolver` is what lets the vendored HSTS header actually
  // ship from the container. The vendored securityHeaders middleware
  // emits Strict-Transport-Security ONLY when the request protocol
  // resolves to https (RFC 6797 §7.2: HSTS over plain HTTP is ignored by
  // UAs, so the middleware suppresses it on non-TLS requests). Behind the
  // Cloudflare Worker the container socket is plain http and the real
  // scheme rides in the Worker-set `x-forwarded-proto: https` — left to
  // its default (socket only) the middleware reads `http`, decides the
  // request isn't TLS, and drops HSTS on EVERY container-served response.
  // The edge Worker sets its own HSTS on edge-rendered pages, but a
  // direct-to-container request (edge render off, or an internal hop that
  // returns HTML) then carries no HSTS at all. blamejs 0.15.14 refuses a
  // bare `trustProxy` for this decision (an attacker who can reach the
  // socket could forge X-Forwarded-Proto to suppress HSTS), so we own the
  // decision via `resolveProtocol` — sound here because the container has
  // no public ingress (see resolveProtocol). The csrf gate and the
  // storefront/admin session-cookie path resolve protocol the same way
  // (one trust model). HSTS stays OWNED by the vendored middleware (we set
  // no header ourselves), so there is no double-set: on an edge-rendered
  // page only the Worker's header is present; on a container-served page
  // only this one is.
  return { documentPolicy: false, referrerPolicy: "same-origin", protocolResolver: resolveProtocol };
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
    // Stripe.js v3 starts sub-frames on per-origin `*.js.stripe.com` hosts
    // for performance (Stripe security guide), and its dynamic loader
    // injects those sub-resource <script>s at runtime — so BOTH the apex
    // and the wildcard must be admitted on script-src, or the
    // TrustedScriptURL/dynamic-load path is refused (the 3DS challenge
    // loader rides this).
    script:  ["https://js.stripe.com", "https://*.js.stripe.com"],
    connect: ["https://api.stripe.com"],
    // frame-src: the apex + `*.js.stripe.com` carry the Payment Element /
    // 3DS challenge frames; hooks.stripe.com carries redirect-style
    // confirmations. `b.stripecdn.com` serves the Express Checkout wallet
    // button assets (e.g. the Amazon Pay button iframe at
    // b.stripecdn.com/stripethirdparty-srv/...) — without it the express
    // wallet button iframe is blocked (net::ERR_ABORTED) while Link /
    // Google Pay, which render from *.js.stripe.com, load fine.
    frame:   [
      "https://js.stripe.com",
      "https://*.js.stripe.com",
      "https://hooks.stripe.com",
      "https://b.stripecdn.com",
    ],
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

// ---- route-scoped Permissions-Policy (payment + passkey surfaces) --------
//
// The app-level Permissions-Policy is the vendored strict denylist
// (DEFAULT_PERMISSIONS) — every powerful API disabled in every document,
// including `payment=()`, `publickey-credentials-get=()`, and
// `publickey-credentials-create=()`. That is correct everywhere EXCEPT the
// handful of pages whose whole job needs one of those features:
//
//   - GET /pay/:order_id mounts Stripe's Express Checkout Element, whose
//     Google Pay / Apple Pay buttons drive the Payment Request API. Under
//     `payment=()` the browser refuses the API inside the cross-origin
//     pay.google.com / Stripe wallet frames, degrading the wallet express
//     buttons (the card form is unaffected, which is why card captures
//     complete while wallets don't).
//
//   - The passkey (WebAuthn) ceremonies. `navigator.credentials.get()`
//     (assertion / sign-in) is gated by `publickey-credentials-get`;
//     `navigator.credentials.create()` (registration / enrollment) by
//     `publickey-credentials-create`. Under the deny-all default the browser
//     refuses the API in the TOP-LEVEL document with "The
//     'publickey-credentials-get' feature is not enabled in this document"
//     (resp. -create), so sign-in / enrollment fail outright. These run on
//     container-served routes:
//       publickey-credentials-get    — GET /account/login (passkey-login.js)
//       publickey-credentials-create — GET /account/register (passkey-register.js)
//                                       GET /account/passkeys (passkey-add.js)
//
// `scopedPermissionsPolicy(opts)` returns a Permissions-Policy string for
// `res.setHeader("permissions-policy", ...)` on the route's response:
// byte-identical to the vendored default EXCEPT the named feature(s), each
// re-enabled for ONLY the allowlist that feature needs, ONLY on that one
// response. setHeader OVERWRITES, so the app-level strict header still
// governs every OTHER route. Every other feature in the denylist stays `()`.
// Derived from the vendored DEFAULT_PERMISSIONS array (the single source the
// app-level header is also built from in `securityHeadersOpts` → the vendored
// default), never a hand-forked copy of the list.

// The allowlist that replaces `payment=()` on the pay surface: same origin
// (the pay page's own form), the Stripe SDK frame, and the Google Pay frame
// the Stripe Express Checkout Element spawns. Apple Pay rides the same
// `payment` feature and needs no extra origin (Safari grants it to the
// top-level same-origin document). Quote-wrapped per RFC 9651 structured
// fields. Single source — every page that enables the payment feature names
// it here.
var _PAYMENT_ALLOWLIST = 'payment=(self "https://js.stripe.com" "https://pay.google.com")';

// WebAuthn assertion / attestation run in the page's OWN top-level document
// (the islands call navigator.credentials.get / .create directly, never from
// a cross-origin child frame), so `self` is the entire allowlist — no third-
// party origin is delegated. Keeping the grant to `self` is the tightest
// value that unblocks the ceremony: a cross-origin iframe on the same page
// still cannot drive WebAuthn. Single source — every passkey page names the
// feature → allowlist mapping here.
var _PASSKEY_FEATURE_ALLOWLIST = {
  "publickey-credentials-get":    "publickey-credentials-get=(self)",
  "publickey-credentials-create": "publickey-credentials-create=(self)",
};

// Feature name → its scoped allowlist token. The pay surface relaxes
// `payment`; the passkey surfaces relax the two WebAuthn features. A caller
// names which feature(s) to relax; every feature NOT named stays at the
// vendored `()` deny. This is the single registry of "which feature may be
// re-enabled, and to exactly what" — nothing outside it can be loosened.
var _SCOPED_FEATURE_OVERRIDES = Object.assign(
  { payment: _PAYMENT_ALLOWLIST },
  _PASSKEY_FEATURE_ALLOWLIST
);

/**
 * Build a route-scoped Permissions-Policy string from the vendored strict
 * denylist with one or more features re-enabled to their scoped allowlist.
 * `opts.features` is an array of feature names to relax (each must appear in
 * `_SCOPED_FEATURE_OVERRIDES`); every other feature is carried through
 * verbatim as `feature=()`. With no argument it defaults to relaxing
 * `payment` — the established pay-surface behavior — so existing callers are
 * unchanged. Returns the string for the route's
 * `res.setHeader("permissions-policy", ...)`; the app-level strict header is
 * unchanged on every other route (setHeader overwrites this one response).
 *
 * Called per-response on a render path, so it never throws — it maps over the
 * vendored default array and swaps only the named entries, failing safe (an
 * unknown feature name simply leaves that feature at the strict deny, and a
 * feature the default does not list is never invented).
 */
function scopedPermissionsPolicy(opts) {
  var features = (opts && Array.isArray(opts.features) && opts.features.length)
    ? opts.features
    : ["payment"];
  // Map requested feature names → their override token, ignoring any name not
  // in the registry (fail-safe: an unknown key relaxes nothing).
  var overrides = {};
  features.forEach(function (name) {
    if (Object.prototype.hasOwnProperty.call(_SCOPED_FEATURE_OVERRIDES, name)) {
      overrides[name] = _SCOPED_FEATURE_OVERRIDES[name];
    }
  });
  return _vendoredSecurityHeaders.DEFAULT_PERMISSIONS.map(function (entry) {
    var feature = entry.split("=")[0];
    return Object.prototype.hasOwnProperty.call(overrides, feature)
      ? overrides[feature]
      : entry;
  }).join(", ");
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

/**
 * createApp `middleware.botGuard` opts — the vendored defaults (block
 * mode, the automation-UA deny list, the missing-Accept-Language
 * heuristic) plus the internal-bridge skip list. Bot-guard is a
 * heuristic for human-facing surfaces; the worker→container endpoints
 * are machine-to-machine and authenticate with the shared
 * D1_BRIDGE_SECRET, so on those paths the secret gate — not a browser
 * fingerprint — is the deciding check (see INTERNAL_BRIDGE_PATHS).
 *
 * `/admin` is skipped HERE but re-guarded in tag mode inside
 * `mountRouteGuards`: every admin route is gated on the timing-safe
 * bearer-key check, and the documented way to drive the admin JSON
 * surface is curl — whose User-Agent is on the vendored deny list, and
 * the UA check fires before auth is ever consulted. In block mode the
 * README / onboarding curl examples answer 403 "Forbidden" instead of
 * reaching the 401/200 bearer gate; in tag mode automation is audited
 * (`system.botguard.tag` + `req.suspectedBot`) while the bearer key
 * stays the deciding check. The regex matches `/admin` and
 * `/admin/...` only — not other `/admin…`-prefixed names.
 */
function botGuardOpts() {
  return {
    skipPaths: INTERNAL_BRIDGE_PATHS.slice()
      // EXACT-match the well-known paths. A bare-string skip is matched as a
      // PREFIX by the bot guard, which would also exempt any sibling under the
      // directory (e.g. /.well-known/apple-...-association/anything), re-opening
      // the guard on routes that aren't the single static association file.
      .concat(PUBLIC_WELL_KNOWN_PATHS.map(function (p) {
        return new RegExp("^" + p.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "$");
      }))
      .concat([/^\/admin(\/|$)/]),
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
  // --- bot-guard, tag mode, /admin only -------------------------------
  //
  // The app-level bot-guard (block mode) skips /admin — see
  // botGuardOpts: curl is the documented admin client and the UA
  // deny-list check fires before the bearer gate, so block mode turns
  // every documented example into a 403. The surface still wants the
  // signal, though: this tag-mode instance audits automation
  // (system.botguard.tag + req.suspectedBot) without refusing it, and
  // the timing-safe bearer key stays the deciding check.
  var adminBotTag = b.middleware.botGuard({ mode: "tag" });
  r.use(function adminBotTagGuard(req, res, next) {
    var pathname = req.pathname || req.url || "/";
    if (!/^\/admin(\/|$)/.test(pathname)) return next();
    return adminBotTag(req, res, next);
  });

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
    // while the visitor is on https; `protocolResolver` owns the Worker-set
    // `x-forwarded-proto` read so the origin pre-check derives the real
    // public origin (and the token cookie carries the `__Host-csrf` prefix),
    // matching the session-cookie stance (storefront `_secureForReq`).
    // blamejs 0.15.14 refuses a bare `trustProxy` here (forgeable from a
    // directly-reachable socket); the resolver is sound because the
    // container has no public ingress (see resolveProtocol). allowedOrigins
    // is the explicit public-host allowlist so a legitimate same-origin POST
    // is never refused as cross-origin on a proxy scheme/host mismatch — the
    // regression that breaks sign-in + every authenticated form behind the CDN.
    protocolResolver: resolveProtocol,
    allowedOrigins:   PUBLIC_ORIGINS,
  });
  r.use(function csrfGuard(req, res, next) {
    var pathname = req.pathname || req.url || "/";
    if (_hasPrefix(pathname, WEBHOOK_PATHS) || pathname === HEALTH_PATH) return next();
    if (isEdgeExemptPath(pathname)) return next();
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
  // --- PayPal webhook per-IP budget -----------------------------------
  //
  // The webhook paths are exempt from the global + tight limiters above
  // (a processor's server-to-server POST is unthrottleable by a human
  // budget), but /api/webhooks/paypal is uniquely expensive to probe:
  // verification is a server-to-server dial to PayPal's
  // verify-webhook-signature API, so every header-complete spam POST costs
  // an outbound request. The adapter's verify dial rides its own circuit
  // (never the payment circuit — lib/payment.js), so spam can't fast-fail
  // checkouts; this budget bounds the outbound dial volume itself. Sized
  // for PayPal's real delivery shape: legitimate redelivery after downtime
  // is ~25 attempts per event spread over days, so even a backlog flush of
  // many distinct events sits far under this per-minute ceiling — and a
  // clipped delivery is never lost: the limiter answers 429, PayPal treats
  // any non-2xx as retry-later and redelivers. Stripe's webhook keeps no
  // budget — its verification is a local HMAC (no dial to amplify).
  var PAYPAL_WEBHOOK_PATH = "/api/webhooks/paypal";
  var paypalWebhookLimiter = b.middleware.rateLimit({
    backend:   "memory",
    algorithm: "fixed-window",
    max:       PAYPAL_WEBHOOK_BUDGET_PER_MINUTE,
    windowMs:  C.TIME.minutes(1),
    keyFn:     clientKey,
  });
  r.use(function paypalWebhookRateGuard(req, res, next) {
    var pathname = req.pathname || req.url || "/";
    if (pathname !== PAYPAL_WEBHOOK_PATH) return next();
    return paypalWebhookLimiter(req, res, next);
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

// ---- download-route response streaming ------------------------------------
//
// Every download route in the shop streams an async iterable to the socket
// header-first so memory stays bounded regardless of row count. Doing that
// correctly needs three things the obvious `for await (…) res.write(chunk)`
// loop does not do, and all three are failure modes we have hit:
//
//   Backpressure. `res.write()` returns false once the socket buffer is full.
//   Ignoring it does not slow the producer down — Node keeps queueing chunks in
//   memory, so a slow client turns a bounded-memory export back into an
//   unbounded one. The fix is to wait for 'drain' before producing more.
//
//   Client disconnect. A closed socket never drains, so a naive await would
//   hang the request forever; a naive loop would keep pulling rows out of the
//   database to write them nowhere. Both are stopped here.
//
//   A mid-stream failure must not look like success. Once the status line and
//   headers are flushed, the error handler can no longer replace them: its
//   `writeHead(500)` throws ERR_HTTP_HEADERS_SENT, and its fallback appends the
//   text "Internal Server Error" to the partial body and closes it as a clean
//   200. A CSV or NDJSON consumer then ingests a truncated export as a complete
//   one whose last row happens to be garbage. After the first byte the only
//   honest signal left is an incomplete transfer, so the socket is destroyed
//   and the chunked stream ends unterminated — which every HTTP client reports
//   as a failed download.
//
// There is no framework primitive for this yet. b.archive has exactly the
// drain-aware writer needed but keeps it private, and b.static / b.router pipe
// a Readable straight to `res`, which does not fit an async iterable. Asked
// upstream in blamejs/blamejs#564; compose it here until it lands.
//
// A response object without an incremental `write()` — the plain-object stub
// several tests pass — falls back to buffering, which is what those callers
// already relied on.
function _resIsGone(res) {
  return res.destroyed === true || res.writableEnded === true ||
         (res.socket && res.socket.destroyed === true);
}

function _awaitDrain(res) {
  return new Promise(function (resolve, reject) {
    function cleanup() {
      if (typeof res.removeListener !== "function") return;
      res.removeListener("drain", onDrain);
      res.removeListener("error", onError);
      res.removeListener("close", onClose);
    }
    function onDrain() { cleanup(); resolve(false); }
    function onClose() { cleanup(); resolve(true); }        // client gave up — not an error
    function onError(e) { cleanup(); reject(e); }
    res.once("drain", onDrain);
    res.once("error", onError);
    res.once("close", onClose);
  });
}

/**
 * Stream an async iterable of string/Buffer chunks to `res`, honoring
 * backpressure. Headers and status must already be set — the first chunk
 * commits them.
 *
 * Resolves when the body is fully written and `res.end()` has been called, or
 * early (without ending) when the client disconnected mid-stream. Rethrows a
 * producer error after destroying a committed response, so the caller's error
 * handler still logs it but can no longer turn a truncated download into a 200.
 */
async function streamToResponse(res, iterable) {
  if (typeof res.write !== "function" || typeof res.end !== "function") {
    var buffered = "";
    for await (var c of iterable) { if (c) buffered += c; }
    if (typeof res.end === "function") res.end(buffered); else res.send(buffered);
    return { streamed: false, aborted: false };
  }

  var committed = false;
  try {
    for await (var chunk of iterable) {
      if (!chunk) continue;
      if (_resIsGone(res)) return { streamed: true, aborted: true };
      committed = true;
      // `once` is missing on the lighter response doubles; those never signal
      // backpressure either (their write() always reports accepted), so the
      // wait is simply skipped rather than guessed at.
      if (res.write(chunk) === false && typeof res.once === "function") {
        var clientLeft = await _awaitDrain(res);
        if (clientLeft) return { streamed: true, aborted: true };
      }
    }
  } catch (e) {
    if (committed) {
      if (typeof res.destroy === "function") res.destroy();
    } else if (typeof res.removeHeader === "function") {
      // Nothing was written yet, so the error handler can still produce a
      // proper 500 — but the download headers set before the stream began
      // survive `writeHead`, and the browser would save that error page as
      // `orders-….csv`. Drop them so the failure renders as a failure.
      res.removeHeader("content-disposition");
      res.removeHeader("content-type");
    }
    throw e;
  }
  res.end();
  return { streamed: true, aborted: false };
}

module.exports = {
  clientKey:            clientKey,
  streamToResponse:     streamToResponse,
  resolveProtocol:      resolveProtocol,
  securityHeadersOpts:  securityHeadersOpts,
  globalRateLimitOpts:  globalRateLimitOpts,
  botGuardOpts:         botGuardOpts,
  mountRouteGuards:     mountRouteGuards,
  scopedCsp:            scopedCsp,
  scopedPermissionsPolicy: scopedPermissionsPolicy,
  CSP_HOSTS:            CSP_HOSTS,
  WEBHOOK_PATHS:        WEBHOOK_PATHS,
  HEALTH_PATH:          HEALTH_PATH,
  PAYPAL_WEBHOOK_BUDGET_PER_MINUTE: PAYPAL_WEBHOOK_BUDGET_PER_MINUTE,
  TIGHT_PREFIXES:       TIGHT_PREFIXES,
  EDGE_POST_PATHS:      EDGE_POST_PATHS,
  EDGE_EXEMPT_CARVEBACKS: EDGE_EXEMPT_CARVEBACKS,
  isEdgeExemptPath:     isEdgeExemptPath,
  PUBLIC_WELL_KNOWN_PATHS: PUBLIC_WELL_KNOWN_PATHS,
};
