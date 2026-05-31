"use strict";
/**
 * @module shop.admin
 * @title  Admin API — bearer-token-gated CRUD over the shop primitives
 *
 * @intro
 *   v1 ships a single-bearer-token admin surface — operators set
 *   `ADMIN_API_KEY` as a Worker secret and use it as the bearer for
 *   every `/admin/*` route. This is the v1-defensible minimum: it
 *   doesn't require a registration ceremony, doesn't need browser
 *   JavaScript, and the operator already has a CLI-friendly trust
 *   root (the secret is in the same vault as every other deploy
 *   credential).
 *
 *   The full passkey-enrolled multi-admin surface (composed on
 *   `b.auth.passkey` + `b.auth.stepUp` + `b.permissions` + b.apiKey's
 *   sealed-storage / scope / rate-limit model) lands in v1.x once the
 *   admin UI also lands. The two are paired because passkey enrolment
 *   requires WebAuthn ceremonies that only make sense from a browser.
 *
 *   Bearer comparison uses `b.crypto.timingSafeEqual` so a side-channel
 *   timing attack can't recover the token byte-by-byte. The token is
 *   never logged — when a request fails auth the response is `401`
 *   with no detail.
 *
 *   Every mutating route writes an audit row via the shop's audit
 *   sink (currently `b.audit.emit` with `action: \"shop.admin.<verb>\"`,
 *   namespace `shop.admin`). Once `b.audit.registerNamespace` is wired
 *   into the boot flow, the namespace is registered there; until then
 *   we register it lazily inside the admin module.
 */

var pricing = require("./pricing");
var collectionsModule = require("./collections");
var quantityDiscountsModule = require("./quantity-discounts");
var loyaltyEarnRulesModule = require("./loyalty-earn-rules");
var loyaltyRedemptionModule = require("./loyalty-redemption");
var textGuard = require("./text-guard");
var { AsyncLocalStorage } = require("node:async_hooks");   // allow:non-shop-require — Node-core per-request context (no npm dep); the framework itself composes it in db-role-context / log. No b.* request-context primitive exists to wrap it.

var b = require("./vendor/blamejs");

var AUDIT_NAMESPACE = "shop_admin";

// Per-request store for the double-submit CSRF token. The admin console is
// container-only and has no locale ALS (unlike the storefront), so it gets
// its own: a sync middleware in `mount()` seeds the request's `req.csrfToken`
// here, and `_renderAdminShell` (the single funnel every authenticated admin
// page flows through) reads it back to token every `<form method="post">`.
// `enterWith` scopes the value to the request's async execution context, so
// concurrent admin requests never see each other's token. A render reached
// outside a request finds no store and injects no field.
var _csrfAls = new AsyncLocalStorage();

// Inject a hidden `_csrf` field into every POST form in `html`, value matched
// to the request's double-submit `__Host-csrf` / `csrf` cookie so a real
// browser (and the e2e harness) submits a token `csrfGuard`
// (lib/security-middleware) accepts. Admin is container-only — none of its
// actions are EDGE_POST_PATHS — so every POST form is tokened (no edge-parity
// carve-out, unlike the storefront). GET forms are left untouched. The field
// is spliced immediately after each form's open tag; existing markup is
// preserved byte-for-byte. Absent a token (render outside a request) the html
// is returned unchanged.
function _injectAdminCsrfFields(html) {
  var store = _csrfAls.getStore();
  var token = store && store.csrf_token;
  if (!token || typeof html !== "string" || html.indexOf("<form") === -1) return html;
  var field = "<input type=\"hidden\" name=\"_csrf\" value=\"" + _htmlEscape(token) + "\">";
  return html.replace(/<form\b[^>]*>/gi, function (openTag) {
    var method = openTag.match(/\bmethod\s*=\s*["']?([a-z]+)/i);
    if (!method || method[1].toLowerCase() !== "post") return openTag;
    return openTag + field;
  });
}

// The console stylesheet ships as an external /assets file — an inline
// <style> block (or inline style="" attributes) is refused by the strict
// `style-src 'self'` CSP that governs container-served routes, which is
// why the console renders unstyled when those are inlined. `'self'`
// allows this file; the deploy's R2 asset sync uploads it. The asset is
// referenced by its content-fingerprinted name (`admin.<hash>.css`), so
// the hash is the cache-buster — no `?v=` query — and the URL maps
// one-to-one onto a byte-content. The sha384 Subresource Integrity digest
// (b.crypto.sri, W3C SRI 1.0) makes the browser reject a tampered or
// mismatched object. Same-origin, so no `crossorigin` is needed. The
// digest + fingerprinted path come from the build-time manifest
// (lib/asset-manifest.json) rather than hashing the file at render time,
// so they're present in the container image too — which doesn't ship the
// theme asset files. A key absent from the manifest yields the plain path
// and no integrity attribute.
var _assetManifest = require("./asset-manifest.json");
function _assetSri(relUnderThemeAssets) {
  var entry = _assetManifest.assets[relUnderThemeAssets];
  return (entry && entry.integrity) || null;
}
function _assetUrl(relUnderThemeAssets) {
  var entry = _assetManifest.assets[relUnderThemeAssets];
  var fp    = (entry && entry.fingerprinted) || relUnderThemeAssets;
  return "/assets/themes/default/" + fp;
}
function _adminStylesheetLink() {
  var sri = _assetSri("css/admin.css");
  return "<link rel=\"stylesheet\" href=\"" + _assetUrl("css/admin.css") + "\"" +
    (sri ? " integrity=\"" + sri + "\"" : "") + ">";
}

// Conservative content-type → file-extension map for the upload route.
// Unknown types fall back to no extension; the R2 object metadata still
// carries the full content-type so the asset serves correctly either
// way. Operator can override by passing a key with extension via the
// raw `catalog.media.attach` route.
var _CT_TO_EXT = {
  "image/png":     "png",
  "image/jpeg":    "jpg",
  "image/jpg":     "jpg",
  "image/webp":    "webp",
  "image/gif":     "gif",
  "image/avif":    "avif",
  "image/svg+xml": "svg",
  "video/mp4":     "mp4",
  "video/webm":    "webm",
  "application/pdf": "pdf",
};
function _extFromContentType(ct) {
  if (typeof ct !== "string") return "";
  return _CT_TO_EXT[ct.toLowerCase()] || "";
}

// Image content-types the direct-file upload path accepts — a strict
// subset of _CT_TO_EXT. The file picker is for product imagery, so
// video / pdf are not offered here (the attach-by-key + upload-from-URL
// routes still reach the wider _CT_TO_EXT set for those). svg stays on
// the list to match the upload-from-URL flow, but it can't be
// magic-byte sniffed (it's text), so the mismatch cross-check skips it.
var _UPLOAD_IMAGE_CT = {
  "image/png":     "png",
  "image/jpeg":    "jpg",
  "image/jpg":     "jpg",
  "image/webp":    "webp",
  "image/gif":     "gif",
  "image/avif":    "avif",
  "image/svg+xml": "svg",
};
// Per-file cap on a direct upload, sized for product photography. The
// body-parser multipart sub-parser enforces its own global fileSize cap
// upstream; this is the route-level cap so the limit is explicit at the
// media surface and the rejection names the media budget rather than a
// generic 413.
var _UPLOAD_MAX_BYTES = b.constants.BYTES.mib(10);

// Cap on the standalone shipping-labels list / pending-queue reads. Matches
// the labels primitive's own MAX_PENDING_LIMIT so a console drain can never
// ask for more than the primitive will return.
var MAX_LABEL_LIST_LIMIT = 200;

// ---- shared helpers -----------------------------------------------------

function _parseEpochMs(str, label) {
  if (str == null) return null;
  var n = parseInt(str, 10);
  if (!Number.isFinite(n) || n < 0 || String(n) !== String(str)) {
    throw new TypeError("admin: " + label + " must be an epoch-millisecond integer");
  }
  return n;
}

function _parseLimit(str, label, max, fallback) {
  if (str == null) return fallback;
  var n = parseInt(str, 10);
  if (!Number.isFinite(n) || n < 1 || n > max || String(n) !== String(str)) {
    throw new TypeError("admin: " + label + " must be an integer in [1, " + max + "]");
  }
  return n;
}

// ---- HTML escape + dashboard layout ------------------------------------

function _htmlEscape(s) {
  if (s == null) return "";
  return b.template.escapeHtml(String(s));
}

// Strict integer coercion for money / count form fields. Refuses
// "50abc" / "" / floats, unlike parseInt's loose prefix match (which
// silently turns "50abc" into 50). Accepts an already-numeric value
// (must itself be a safe integer). Throws a TypeError whose message
// carries the caller's prefix so the browser form path surfaces it as
// a 400 notice. Same shape as the collections-rule _strictInt nested
// helper, hoisted to module scope so the gift-card + subscription-plan
// create paths share it.
function _strictMinorInt(value, prefix, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError(prefix + ": " + label + " out of range");
    return value;
  }
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    throw new TypeError(prefix + ": " + label + " must be an integer");
  }
  var n = Number(value.trim());
  if (!Number.isSafeInteger(n)) throw new TypeError(prefix + ": " + label + " out of range");
  return n;
}

// Strict non-negative integer for a form field (money minor units,
// dimensions). Refuses "", floats, and parseInt's loose-prefix "12abc"
// → 12 — the /^\d+$/ test is anchored so the whole string must be
// digits. Throws a TypeError (surfaced as a 400 notice on the browser
// path). A pre-coerced number is accepted only when it's a safe
// non-negative integer.
function _strictNonNegIntField(value, label) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("admin: " + label + " must be a non-negative integer");
    return value;
  }
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) {
    throw new TypeError("admin: " + label + " must be a non-negative integer");
  }
  var n = Number(value.trim());
  if (!Number.isSafeInteger(n)) throw new TypeError("admin: " + label + " out of range");
  return n;
}

// Strict positive integer for a form field (parcel weight / dimensions
// that must be > 0). Same anchored /^\d+$/ discipline as the
// non-negative variant, then rejects zero.
function _strictPosIntField(value, label) {
  var n = _strictNonNegIntField(value, label);
  if (n === 0) throw new TypeError("admin: " + label + " must be a positive integer");
  return n;
}

// Parse a "k=v, k=v" form string into a variant options attribute map.
// An empty / whitespace string yields `{}` (no options). A pair missing
// its `=` is skipped rather than throwing — the catalog primitive does
// the authoritative validation on the resulting object. Keys + values
// are trimmed; a duplicate key keeps the last value.
function _parseOptionsString(s) {
  if (s == null) return {};
  if (typeof s !== "string") return {};
  var out = {};
  s.split(",").forEach(function (pair) {
    var eq = pair.indexOf("=");
    if (eq === -1) return;
    var k = pair.slice(0, eq).trim();
    var v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  });
  return out;
}

// ---- bearer auth --------------------------------------------------------

function _readBearer(req) {
  if (!req || !req.headers) return null;
  var h = req.headers.authorization || req.headers.Authorization;
  if (!h || typeof h !== "string") return null;
  if (h.slice(0, 7).toLowerCase() !== "bearer ") return null;
  return h.slice(7).trim();
}

function _authOk(token, expected) {
  if (typeof token !== "string" || typeof expected !== "string") return false;
  if (token.length !== expected.length) return false;
  return b.crypto.timingSafeEqual(token, expected);
}

// ---- admin browser session (sealed cookie) ------------------------------
//
// The JSON API (R/W wrappers) is bearer-token only — that's the contract
// for machine clients. The server-rendered admin pages (landing, setup
// wizard, dashboard) additionally accept a sealed `shop_admin` cookie so
// an operator can sign in from a browser by pasting the same token once.
// The cookie composes the framework cookie primitive (vault-sealed
// read/write) — scoped to /admin, SameSite=Strict, HttpOnly + Secure.
var ADMIN_COOKIE_NAME = "shop_admin";

// Cookie-prefix-hardened name. The admin session cookie is Path=/admin, so
// it CANNOT carry `__Host-` (which mandates Path=/); the correct prefix is
// `__Secure-`, which requires only the Secure attribute (RFC 6265bis
// §4.1.3.1). As with the storefront session cookies, the prefix moves in
// lockstep with Secure: a `__Secure-` cookie without Secure is invalid
// (silently dropped), and Secure cookies don't store over plain http. So
// https admin sessions carry `__Secure-shop_admin`; http dev/e2e sessions
// carry the bare `shop_admin`. The validity check resolves the prefixed
// name first and the bare name second.
var ADMIN_COOKIE_NAME_SECURE = "__Secure-" + ADMIN_COOKIE_NAME;

var _adminJarMemo = null;
function _adminJar() {
  if (!_adminJarMemo) {
    _adminJarMemo = b.cookies.create({
      vault:    b.vault,
      defaults: { httpOnly: true, secure: true, sameSite: "Strict", path: "/admin" },
    });
  }
  return _adminJarMemo;
}

// Whether THIS request's PUBLIC connection is https — drives both the
// Secure attribute and the prefix choice for the admin session cookie.
// Same rule as the storefront: trust the Worker-set `x-forwarded-proto`
// (the container socket may be plain http behind the TLS-terminating
// Worker), and treat a direct dev/e2e connection (no forwarded header,
// non-encrypted socket) as http so the bare-named, non-Secure cookie is
// emitted and a real browser stores it.
function _secureForReq(req) {
  return b.requestHelpers.requestProtocol(req, { trustProxy: true }) === "https";
}
function _adminCookieName(secure) { return secure ? ADMIN_COOKIE_NAME_SECURE : ADMIN_COOKIE_NAME; }

function _setAdminCookie(req, res) {
  var secure = _secureForReq(req);
  _adminJar().writeSealed(res, _adminCookieName(secure), JSON.stringify({
    admin: true,
    exp:   Date.now() + b.constants.TIME.hours(12),
  }), { expires: new Date(Date.now() + b.constants.TIME.hours(12)), secure: secure });
}
function _clearAdminCookie(req, res) {
  // Expire-now must match the live request's protocol so the cleared
  // cookie's attributes satisfy the `__Secure-` invariant: over https
  // clear the prefixed name with Secure; over http clear the bare name. A
  // request never carries both at once (the write side emits one per
  // protocol), so clearing the protocol-matched name signs the operator out.
  var secure = _secureForReq(req);
  _adminJar().clear(res, _adminCookieName(secure), { secure: secure });
}

// One-time gift-card code reveal. The issue POST stashes the freshly-issued
// plaintext code in a sealed, HttpOnly, /admin-scoped cookie and 303-redirects
// (Post/Redirect/Get — so a refresh of the detail page can't re-issue a card),
// WITHOUT placing the code in the URL / Location header / browser history /
// access log. The detail GET reads it exactly once and clears it, so a reload
// after the reveal shows the normal card with no code.
var GC_REVEAL_COOKIE = "gc_reveal";
function _stashGiftCardReveal(res, id, code) {
  _adminJar().writeSealed(res, GC_REVEAL_COOKIE, JSON.stringify({ id: id, code: code }),
    { expires: new Date(Date.now() + b.constants.TIME.hours(1)) });
}
function _takeGiftCardReveal(req, res, id) {
  var raw = _adminJar().readSealed(req, GC_REVEAL_COOKIE);
  if (raw === null) return null;
  _adminJar().clear(res, GC_REVEAL_COOKIE);
  var env;
  try { env = JSON.parse(raw); } catch (_e) { return null; }
  return (env && env.id === id && typeof env.code === "string") ? env.code : null;
}
function _adminCookieValid(req) {
  // Resolve the prefixed name first and the bare name second so an admin
  // session set in either environment (or mid-rollout) is recognised.
  var raw = _adminJar().readSealed(req, ADMIN_COOKIE_NAME_SECURE);
  if (raw === null) raw = _adminJar().readSealed(req, ADMIN_COOKIE_NAME);
  if (raw === null) return false;
  var env;
  try { env = JSON.parse(raw); } catch (_e) { return false; }
  return !!(env && env.admin === true && env.exp && env.exp > Date.now());
}

// HTML-page auth: a valid admin cookie OR the bearer token (so existing
// tooling that sends the header still reaches the dashboard). Never
// throws — a missing vault surfaces as "not authed" so the caller can
// render the login form rather than 500.
function _htmlAuthed(req, expectedToken) {
  if (_authOk(_readBearer(req), expectedToken)) return true;
  try { return _adminCookieValid(req); } catch (_e) { return false; }
}

function _problem(res, status, code, detail) {
  return b.problemDetails.send(res, {
    type:   "/problems/" + code,
    title:  code.replace(/-/g, " "),
    status: status,
    detail: detail || code,
  });
}

function _sendHtml(res, status, html) {
  res.status(status);
  if (res.setHeader) {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.setHeader("x-robots-tag", "noindex, nofollow");
  }
  if (res.end) res.end(html); else res.send(html);
}

function _redirect(res, location) {
  res.status(303);
  if (res.setHeader) res.setHeader("location", location);
  if (res.end) res.end(); else res.send("");
}

// Single classifier for a thrown admin error → an operator-safe outcome,
// shared by BOTH the bearer JSON path (_wrap) and every cookie/HTML form
// path so the two can never diverge on what a given error class is allowed
// to reveal. Returns `{ status, code, message }`:
//
//   - TypeError          → 400 bad-request, `e.message` verbatim. These are
//                          our own validation throws (`currency "ZZZ" is not
//                          a known ISO 4217 code`, `regions_json must be valid
//                          JSON`) — intended, operator-safe text the form must
//                          surface so the operator can correct the input.
//   - SyntaxError        → 400 bad-request, generic "Invalid input." A parser
//                          SyntaxError that reached here echoes the parse
//                          position ("...JSON at position 1"); never surface it.
//   - UNIQUE / FOREIGN KEY constraint → 409 conflict, generic in-use /
//                          referenced-record text — never the table/column/SQL.
//   - CHECK / NOT NULL constraint     → 400 bad-request, generic
//                          missing-or-invalid text.
//   - anything else      → 500 internal-error, generic "Something went wrong
//                          — please try again." The raw message is recorded
//                          server-side via the framework audit (drop-silent,
//                          outcome:"failure") so an operator can correlate;
//                          it never reaches the client.
//
// `auditAction` (optional) names the audit action for the unknown-error
// record; defaults to "request" so a bare call still files under a sensible
// namespace.
function _safeNotice(e, auditAction) {
  if (e instanceof TypeError) {
    return { status: 400, code: "bad-request", message: (e && e.message) || "Invalid input." };
  }
  if (e instanceof SyntaxError) {
    return { status: 400, code: "bad-request", message: "Invalid input." };
  }
  var msg = (e && e.message) || "";
  if (/UNIQUE constraint failed/i.test(msg) || /FOREIGN KEY constraint failed/i.test(msg)) {
    return /FOREIGN KEY/i.test(msg)
      ? { status: 409, code: "conflict", message: "A referenced record does not exist." }
      : { status: 409, code: "conflict", message: "That value is already in use." };
  }
  if (/(?:CHECK|NOT NULL) constraint failed/i.test(msg)) {
    return { status: 400, code: "bad-request", message: "A required value is missing or invalid." };
  }
  // Genuine unknown error — record it server-side via the framework audit
  // (drop-silent) so operators can correlate, then hand back a generic
  // message + a 500. The raw message never reaches the client.
  b.audit.safeEmit({
    action:   AUDIT_NAMESPACE + "." + (auditAction || "request") + ".error",
    outcome:  "failure",
    metadata: { message: msg || String(e) },
  });
  return { status: 500, code: "internal-error", message: "Something went wrong — please try again." };
}

function _wrap(handler, opts) {
  // Every admin handler routes through this wrapper: bearer-token
  // gate, error-to-problem-details translation, audit write on the
  // mutating ops. `opts.audit` is the audit action name; omit for
  // read-only routes.
  return async function (req, res) {
    var token = _readBearer(req);
    if (!_authOk(token, opts.expectedToken)) return _problem(res, 401, "unauthorized");
    try {
      var result = await handler(req, res);
      if (opts.audit && result && result !== false) {
        // `safeEmit` is the framework's drop-silent variant — handles
        // sink failure / invalid namespace / shape errors internally
        // without throwing, so the audit attempt can never crash the
        // write path it observes. Equivalent to `try { audit.emit(...)
        // } catch (_e) {}` but composed via the framework primitive
        // instead of a local wrapper.
        b.audit.safeEmit({
          action:   AUDIT_NAMESPACE + "." + opts.audit,
          outcome:  "success",
          metadata: { id: result.id || null },
        });
      }
      return result;
    } catch (e) {
      // Single classification, shared with the cookie/HTML paths via
      // _safeNotice. A 5xx carries NO error-derived detail (the unknown
      // case is recorded server-side inside _safeNotice); 4xx surface the
      // generic / validation message.
      var n = _safeNotice(e, opts.audit);
      if (n.status >= 500) return _problem(res, n.status, n.code);
      return _problem(res, n.status, n.code, n.message);
    }
  };
}

// ---- factory ------------------------------------------------------------

function mount(router, deps) {
  if (!router || typeof router.post !== "function") throw new TypeError("admin.mount: router with .post() required");
  if (!deps || !deps.catalog || !deps.order)        throw new TypeError("admin.mount: deps.catalog + deps.order required");
  var expectedToken = deps.token;
  if (typeof expectedToken !== "string" || expectedToken.length < 16) {
    throw new TypeError("admin.mount: deps.token must be a string ≥ 16 chars (use a 32-byte random secret)");
  }
  var catalog       = deps.catalog;
  var order         = deps.order;
  var payment       = deps.payment       || null;   // refund endpoints disabled when absent
  var _checkout     = deps.checkout      || null;   // reserved — future webhook handler wiring
  var r2            = deps.r2_bridge     || null;   // media-upload endpoint disabled when absent
  var assetPrefix   = typeof deps.asset_prefix === "string" ? deps.asset_prefix : "/assets/";
  var catalogImport = deps.catalogImport || null;   // bulk-import route disabled when absent
  var reviews       = deps.reviews       || null;   // moderation endpoints disabled when absent
  var productQa     = deps.productQa     || null;   // Q&A moderation endpoints disabled when absent
  var returns       = deps.returns       || null;   // RMA moderation endpoints disabled when absent
  var customers     = deps.customers     || null;   // read-only customers console disabled when absent
  var storeCredit      = deps.storeCredit      || null;  // per-customer store-credit panel + grant/deduct disabled when absent
  var customerNotes    = deps.customerNotes    || null;  // per-customer CRM notes panel disabled when absent
  var customerSegments = deps.customerSegments || null;  // per-customer segment-membership panel disabled when absent
  var orderTracking = deps.orderTracking || null;   // shipment/tracking panel disabled when absent
  var salesReports  = deps.salesReports  || null;   // /admin/reports degrades to an unconfigured notice when absent
  var printReceipts = deps.printReceipts || null;   // order receipt document disabled when absent
  var packingSlips  = deps.packingSlips  || null;   // order packing-slip document disabled when absent
  var pickLists      = deps.pickLists      || null;  // warehouse pick-list console disabled when absent
  var shippingLabels = deps.shippingLabels || null;  // per-shipment carrier-label record disabled when absent
  var splitShipments = deps.splitShipments || null;  // order split-shipment planner disabled when absent
  var salesTaxFilings = deps.salesTaxFilings || null; // sales-tax-filing remittance console disabled when absent

  // Which optional console sections are wired — gates their nav links so a
  // signed-in admin is never sent to a route that wasn't mounted. Passed
  // into every authed render call as `nav_available`.
  // `reports` is always present in the nav (read-only sales summary needs no
  // extra dep); its route mounts unconditionally and renders an unconfigured
  // notice when the salesReports primitive isn't wired.
  var navAvailable = { returns: !!returns, reviews: !!reviews, productQa: !!productQa, subscriptions: !!deps.subscriptions, webhooks: !!deps.webhooks, collections: !!deps.collections, customers: !!deps.customers, giftcards: !!deps.giftcards, announcementBar: !!deps.announcementBar, blog: !!deps.blog, customerSurveys: !!deps.customerSurveys, storefrontPages: !!deps.storefrontPages, businessHours: !!deps.businessHours, taxRates: !!deps.taxRates, shippingZones: !!deps.shippingZones, autoDiscount: !!deps.autoDiscount, discountAllocation: !!deps.discountAllocation, quantityDiscounts: !!deps.quantityDiscounts, loyalty: !!deps.loyalty, pickLists: !!pickLists, salesTaxFilings: !!salesTaxFilings, shippingLabels: !!shippingLabels };

  try { b.audit.registerNamespace(AUDIT_NAMESPACE); } catch (_e) { /* idempotent */ }

  // Seed the per-request double-submit CSRF token onto the ALS so
  // `_renderAdminShell` can token every admin POST form. SYNCHRONOUS, like
  // the storefront's locale middleware: `enterWith` only propagates to the
  // request's downstream handlers when it runs in the same synchronous tick
  // the router awaits. The guard (lib/security-middleware) issues the token on
  // GET and exposes it as `req.csrfToken`; absent one it rides as "" and no
  // field is injected. Mounted ahead of every admin route. Drop-silent — a
  // failure here must never 500 the console; the form just renders token-less
  // (and a stateless GET wasn't being CSRF-checked anyway).
  if (typeof router.use === "function") {
    router.use(function adminCsrfTokenMiddleware(req, _res, next) {
      try {
        _csrfAls.enterWith({ csrf_token: req.csrfToken || "" });
      } catch (_e) { /* drop-silent — form renders token-less */ }
      next();
    });
  }

  var W = function (auditAction, h) {
    return _wrap(h, { expectedToken: expectedToken, audit: auditAction });
  };
  var R = function (h) {
    return _wrap(h, { expectedToken: expectedToken });
  };

  // Content-negotiate one endpoint between the JSON API and the HTML
  // console: a bearer token routes to `apiHandler` (the JSON contract,
  // unchanged for tooling); a browser admin-cookie session routes to
  // `htmlHandler` (the rendered console page). Unauthenticated GETs show
  // the sign-in form; other methods bounce to /admin.
  function _pageOrApi(isGet, apiHandler, htmlHandler) {
    return async function (req, res) {
      if (_authOk(_readBearer(req), expectedToken)) return apiHandler(req, res);
      // Mirror _htmlAuthed: a missing vault makes the cookie check throw;
      // treat that as "not authed" rather than 500-ing the route.
      var cookieOk = false;
      try { cookieOk = _adminCookieValid(req); } catch (_e) { cookieOk = false; }
      if (cookieOk) return htmlHandler(req, res);
      if (isGet) return _sendHtml(res, 200, renderAdminLogin({ shop_name: deps.shop_name }));
      return _redirect(res, "/admin");
    };
  }

  function _json(res, status, obj) {
    res.status(status);
    if (res.setHeader) res.setHeader("content-type", "application/json; charset=utf-8");
    var body = JSON.stringify(obj);
    if (res.end) res.end(body); else res.send(body);
  }

  // ---- products -------------------------------------------------------

  router.post("/admin/products", _pageOrApi(false,
    W("product.create", async function (req, res) {
      var p = await catalog.products.create(req.body || {});
      _json(res, 201, p);
      return p;
    }),
    async function (req, res) {
      // Browser form submit — create, then redirect (PRG) straight to the
      // new product's detail screen so the operator continues setup (variant,
      // price, stock) there instead of hunting for it in the list. Bad input
      // re-renders the products page with a notice, never a 500.
      var made;
      try {
        made = await catalog.products.create(req.body || {});
      } catch (e) {
        var n = _safeNotice(e, "product.create");
        var page = await catalog.products.list({ limit: 100 });
        return _sendHtml(res, n.status, renderAdminProducts({
          shop_name: deps.shop_name, nav_available: navAvailable, products: page.rows || [],
          notice: n.message,
        }));
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".product.create", outcome: "success", metadata: { id: made.id } });
      _redirect(res, "/admin/products/" + encodeURIComponent(made.id) + "?created=1");
    },
  ));

  router.get("/admin/products/search", R(async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var qRaw = url && url.searchParams.get("q");
    var q = typeof qRaw === "string" ? qRaw : "";
    if (q.length > 200) q = q.slice(0, 200);
    var cursor = url && url.searchParams.get("cursor");
    var limitS = url && url.searchParams.get("limit");
    var limit  = limitS == null ? 50 : parseInt(limitS, 10);
    // No status filter at the admin surface — operators view draft +
    // archived products alongside active ones so a typo'd slug is
    // findable before publication.
    var page = await catalog.products.search({
      q:      q,
      limit:  limit,
      cursor: cursor || undefined,
    });
    _json(res, 200, page);
  }));

  router.get("/admin/products", _pageOrApi(true,
    R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var status = url && url.searchParams.get("status");
      var cursor = url && url.searchParams.get("cursor");
      var limitS = url && url.searchParams.get("limit");
      var limit  = limitS == null ? 50 : parseInt(limitS, 10);
      var page = await catalog.products.list({ status: status || undefined, cursor: cursor || undefined, limit: limit });
      _json(res, 200, page);
    }),
    async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var created = !!(url && url.searchParams.get("created"));
      var page = await catalog.products.list({ limit: 100 });
      _sendHtml(res, 200, renderAdminProducts({ shop_name: deps.shop_name, nav_available: navAvailable, products: page.rows || [], created: created }));
    },
  ));

  // Default currency for the price-set form — read from shop config when
  // wired, falling back to USD. A config read failure (unconfigured store)
  // is non-fatal: the form just defaults to USD.
  async function _defaultCurrency() {
    if (!deps.config) return "USD";
    try {
      var c = await deps.config.get("shop.currency", "USD");
      return (typeof c === "string" && /^[A-Z]{3}$/.test(c)) ? c : "USD";
    } catch (_e) { return "USD"; }
  }

  // Hydrate the full detail model: the product, its variants, each
  // variant's price-per-currency (current + history), and the product's
  // media. Throws TypeError on a malformed id (defensive id reader) — the
  // caller maps that to a 404, never a 500.
  async function _productDetailModel(id) {
    var p = await catalog.products.get(id);
    if (!p) return null;
    var variants = await catalog.variants.listForProduct(id);
    var pricesByVariant = {};
    for (var i = 0; i < variants.length; i += 1) {
      var v = variants[i];
      var currencies = await catalog.prices.currencies(v.id);
      var perCurrency = [];
      for (var j = 0; j < currencies.length; j += 1) {
        var cur = currencies[j];
        perCurrency.push({
          currency: cur,
          current:  await catalog.prices.current(v.id, cur),
          history:  await catalog.prices.history(v.id, cur),
        });
      }
      pricesByVariant[v.id] = { currencies: perCurrency };
    }
    var media = await catalog.media.listForProduct(id);
    return { product: p, variants: variants, prices_by_variant: pricesByVariant, media: media };
  }

  // Detail content-negotiates: bearer → JSON (product + variants + prices
  // + media); browser → the full management screen. A bad / unknown id is
  // a 404 page, never a 500.
  router.get("/admin/products/:id", _pageOrApi(true,
    R(async function (req, res) {
      var model;
      try { model = await _productDetailModel(req.params.id); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 404, "product-not-found", e.message); throw e; }
      if (!model) return _problem(res, 404, "product-not-found");
      _json(res, 200, model);
    }),
    async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var model;
      try { model = await _productDetailModel(req.params.id); }
      catch (e) { if (!(e instanceof TypeError)) throw e; model = null; }
      if (!model) {
        var page = await catalog.products.list({ limit: 100 });
        return _sendHtml(res, 404, renderAdminProducts({
          shop_name: deps.shop_name, nav_available: navAvailable, products: page.rows || [], notice: "Product not found.",
        }));
      }
      _sendHtml(res, 200, renderAdminProduct({
        shop_name: deps.shop_name, nav_available: navAvailable,
        product: model.product, variants: model.variants,
        prices_by_variant: model.prices_by_variant, media: model.media,
        asset_prefix: assetPrefix, upload_available: !!r2,
        default_currency: await _defaultCurrency(),
        saved:   url && url.searchParams.get("saved"),
        created: url && url.searchParams.get("created"),
        notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
      }));
    },
  ));

  router.patch("/admin/products/:id", W("product.update", async function (req, res) {
    var p = await catalog.products.update(req.params.id, req.body || {});
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
    return p;
  }));

  // Browser POST alias for the product fields edit (HTML forms can't
  // PATCH). Bearer clients keep using PATCH /admin/products/:id. Bad input
  // re-renders the detail with a notice (?err=1), never a 500.
  router.post("/admin/products/:id/edit", _pageOrApi(false,
    W("product.update", async function (req, res) {
      var p;
      try { p = await catalog.products.update(req.params.id, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!p) return _problem(res, 404, "product-not-found");
      _json(res, 200, p);
      return p;
    }),
    async function (req, res) {
      var id  = req.params.id;
      var enc = encodeURIComponent(id);
      var body = req.body || {};
      var patch = {};
      if (typeof body.slug === "string")        patch.slug = body.slug.trim();
      if (typeof body.title === "string")       patch.title = body.title;
      if (typeof body.description === "string") patch.description = body.description;
      if (typeof body.status === "string" && body.status) patch.status = body.status;
      try {
        if (Object.keys(patch).length === 0) return _redirect(res, "/admin/products/" + enc + "?err=1");
        var p = await catalog.products.update(id, patch);
        if (!p) return _redirect(res, "/admin/products/" + enc + "?err=1");
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        return _redirect(res, "/admin/products/" + enc + "?err=1");
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".product.update", outcome: "success", metadata: { id: id } });
      _redirect(res, "/admin/products/" + enc + "?saved=1");
    },
  ));

  function _productStateAction(verb, op, audit) {
    return _pageOrApi(false,
      W(audit, async function (req, res) {
        var p = await op(req.params.id);
        if (!p) return _problem(res, 404, "product-not-found");
        _json(res, 200, p);
        return p;
      }),
      async function (req, res) {
        // A bad/missing id is a no-op (fall through to the list); a real
        // failure must NOT be reported as success — let it surface.
        try { await op(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + "." + audit, outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, "/admin/products");
      },
    );
  }
  router.post("/admin/products/:id/archive", _productStateAction("archive", function (id) { return catalog.products.archive(id); }, "product.archive"));
  router.post("/admin/products/:id/restore", _productStateAction("restore", function (id) { return catalog.products.restore(id); }, "product.restore"));

  // ---- variants -------------------------------------------------------

  router.post("/admin/products/:id/variants", W("variant.create", async function (req, res) {
    var v = await catalog.variants.create(req.params.id, req.body || {});
    _json(res, 201, v);
    return v;
  }));

  // Browser POST alias for variant create from the product detail screen.
  // The options string ("k=v, k=v") and the weight / requires_shipping
  // selects come in as form strings — coerce them to the shapes the
  // primitive expects before handing off. Bad input → ?err=1 notice.
  router.post("/admin/products/:id/variants/create", _pageOrApi(false,
    W("variant.create", async function (req, res) {
      var v = await catalog.variants.create(req.params.id, req.body || {});
      _json(res, 201, v);
      return v;
    }),
    async function (req, res) {
      var id  = req.params.id;
      var enc = encodeURIComponent(id);
      var body = req.body || {};
      try {
        await catalog.variants.create(id, {
          sku:               typeof body.sku === "string" ? body.sku.trim() : body.sku,
          title:             typeof body.title === "string" ? body.title : undefined,
          options:           _parseOptionsString(body.options),
          weight_grams:      body.weight_grams === undefined || body.weight_grams === "" ? undefined : _strictMinorInt(body.weight_grams, "admin.variant", "weight_grams"),
          requires_shipping: body.requires_shipping === undefined ? undefined : (String(body.requires_shipping) === "1"),
        });
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        return _redirect(res, "/admin/products/" + enc + "?err=1");
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".variant.create", outcome: "success", metadata: { id: id } });
      _redirect(res, "/admin/products/" + enc + "?saved=1");
    },
  ));

  router.patch("/admin/variants/:id", W("variant.update", async function (req, res) {
    var v = await catalog.variants.update(req.params.id, req.body || {});
    if (!v) return _problem(res, 404, "variant-not-found");
    _json(res, 200, v);
    return v;
  }));

  // Resolve the owning product id for a variant so a variant-scoped
  // browser route can redirect back to the product detail page. Returns
  // null for a missing / malformed id.
  async function _variantProductId(variantId) {
    var v = null;
    try { v = await catalog.variants.get(variantId); }
    catch (e) { if (!(e instanceof TypeError)) throw e; }
    return v ? v.product_id : null;
  }

  // Browser POST alias for variant edit (HTML forms can't PATCH).
  router.post("/admin/variants/:id/edit", _pageOrApi(false,
    W("variant.update", async function (req, res) {
      var v;
      try { v = await catalog.variants.update(req.params.id, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!v) return _problem(res, 404, "variant-not-found");
      _json(res, 200, v);
      return v;
    }),
    async function (req, res) {
      var vid  = req.params.id;
      var body = req.body || {};
      var productId = await _variantProductId(vid);
      var back = productId ? "/admin/products/" + encodeURIComponent(productId) : "/admin/products";
      if (!productId) return _redirect(res, back + "?err=1");
      try {
        var patch = {};
        if (typeof body.sku === "string")   patch.sku = body.sku.trim();
        if (typeof body.title === "string") patch.title = body.title;
        if (typeof body.options === "string") patch.options = _parseOptionsString(body.options);
        if (body.weight_grams !== undefined && body.weight_grams !== "") patch.weight_grams = _strictMinorInt(body.weight_grams, "admin.variant", "weight_grams");
        if (body.requires_shipping !== undefined) patch.requires_shipping = String(body.requires_shipping) === "1";
        if (Object.keys(patch).length === 0) return _redirect(res, back + "?err=1");
        var v = await catalog.variants.update(vid, patch);
        if (!v) return _redirect(res, back + "?err=1");
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        return _redirect(res, back + "?err=1");
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".variant.update", outcome: "success", metadata: { id: vid } });
      _redirect(res, back + "?saved=1");
    },
  ));

  router.delete("/admin/variants/:id", W("variant.delete", async function (req, res) {
    var ok = await catalog.variants.delete(req.params.id);
    if (!ok) return _problem(res, 404, "variant-not-found");
    _json(res, 200, { ok: true });
    return { id: req.params.id };
  }));

  // Browser confirm interstitial for variant delete — deleting a variant
  // removes its prices + media via the FK cascade, so the console confirms
  // first (the CSP forbids a client confirm() dialog). Reached by a GET
  // link from the detail screen; bearer clients DELETE directly.
  router.get("/admin/variants/:id/delete/confirm-page", _pageOrApi(true,
    R(async function (_req, res) {
      return _problem(res, 405, "use-canonical-endpoint", "DELETE /admin/variants/:id (or POST .../delete) directly for the JSON API");
    }),
    async function (req, res) {
      var vid = req.params.id;
      var v = null;
      try { v = await catalog.variants.get(vid); }
      catch (e) { if (!(e instanceof TypeError)) throw e; }
      var productId = v ? v.product_id : null;
      var back = productId ? "/admin/products/" + encodeURIComponent(productId) : "/admin/products";
      if (!v) return _redirect(res, back + "?err=1");
      _sendHtml(res, 200, renderAdminConfirm({
        shop_name: deps.shop_name, nav_available: navAvailable, active: "products",
        heading: "Delete this variant?",
        consequence: "Deleting the variant is permanent — its prices and any media attached to it are removed too.",
        detail: "Variant: " + (v.title || v.sku) + " (" + v.sku + ").",
        action: "/admin/variants/" + _htmlEscape(vid) + "/delete",
        confirm_label: "Delete variant",
        cancel_href: back,
      }));
    },
  ));

  // Browser POST for variant delete (HTML forms can't DELETE). Bearer
  // clients keep using DELETE /admin/variants/:id.
  router.post("/admin/variants/:id/delete", _pageOrApi(false,
    W("variant.delete", async function (req, res) {
      var ok = await catalog.variants.delete(req.params.id);
      if (!ok) return _problem(res, 404, "variant-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.id };
    }),
    async function (req, res) {
      var vid = req.params.id;
      var productId = await _variantProductId(vid);
      var back = productId ? "/admin/products/" + encodeURIComponent(productId) : "/admin/products";
      var ok = false;
      try { ok = await catalog.variants.delete(vid); }
      catch (e) { if (!(e instanceof TypeError)) throw e; }
      if (!ok) return _redirect(res, back + "?err=1");
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".variant.delete", outcome: "success", metadata: { id: vid } });
      _redirect(res, back + "?saved=1");
    },
  ));

  // ---- prices ---------------------------------------------------------

  router.post("/admin/variants/:id/prices", W("price.set", async function (req, res) {
    var p = await catalog.prices.set(req.params.id, req.body || {});
    _json(res, 201, p);
    return p;
  }));

  // Browser POST alias for setting a price from the product detail screen.
  // The amount comes in as a form string — coerce it with the strict
  // integer reader (refuses "29.99" / "" / "50abc") before handing to the
  // primitive. Bad input → ?err=1 notice on the product detail.
  router.post("/admin/variants/:id/prices/set", _pageOrApi(false,
    W("price.set", async function (req, res) {
      var p = await catalog.prices.set(req.params.id, req.body || {});
      _json(res, 201, p);
      return p;
    }),
    async function (req, res) {
      var vid  = req.params.id;
      var body = req.body || {};
      var productId = await _variantProductId(vid);
      var back = productId ? "/admin/products/" + encodeURIComponent(productId) : "/admin/products";
      if (!productId) return _redirect(res, back + "?err=1");
      try {
        var amount = _strictMinorInt(body.amount_minor, "admin.price", "amount_minor");
        await catalog.prices.set(vid, {
          currency:     typeof body.currency === "string" ? body.currency.trim().toUpperCase() : body.currency,
          amount_minor: amount,
        });
      } catch (e) {
        if (!(e instanceof TypeError)) throw e;
        return _redirect(res, back + "?err=1");
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".price.set", outcome: "success", metadata: { id: vid } });
      _redirect(res, back + "?saved=1");
    },
  ));

  router.get("/admin/variants/:id/prices", R(async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var currency = url && url.searchParams.get("currency");
    if (!currency) return _problem(res, 400, "missing-currency", "?currency=USD required");
    var hist = await catalog.prices.history(req.params.id, currency);
    _json(res, 200, { history: hist });
  }));

  // ---- inventory ------------------------------------------------------

  // Inventory list — JSON for the bearer token, HTML console for a signed-in
  // browser. `?low=1` filters to SKUs at/below their low-stock threshold.
  router.get("/admin/inventory", _pageOrApi(true,
    R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var page = await catalog.inventory.list({ low_only: !!(url && url.searchParams.get("low")), limit: 500 });
      _json(res, 200, page);
    }),
    async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var low = !!(url && url.searchParams.get("low"));
      var page = await catalog.inventory.list({ low_only: low, limit: 500 });
      _sendHtml(res, 200, renderAdminInventory({
        shop_name: deps.shop_name, nav_available: navAvailable,
        inventory: page.rows || [], low: low,
        notice: url && url.searchParams.get("err") ? "That SKU wasn't found — nothing was changed." : null,
        updated: !!(url && url.searchParams.get("updated")),
        created: !!(url && url.searchParams.get("created")),
      }));
    },
  ));

  router.post("/admin/inventory", _pageOrApi(false,
    W("inventory.create", async function (req, res) {
      var body = req.body || {};
      if (!body.sku) throw new TypeError("admin.inventory.create: body.sku required");
      var inv = await catalog.inventory.create(body.sku, body);
      _json(res, 201, inv);
      return Object.assign({ id: body.sku }, inv);
    }),
    async function (req, res) {
      var body = req.body || {};
      try {
        if (!body.sku) throw new TypeError("sku required");
        await catalog.inventory.create(body.sku, { stock_on_hand: parseInt(body.stock_on_hand, 10) || 0 });
      } catch (e) {
        var n = _safeNotice(e, "inventory.create");
        var page = await catalog.inventory.list({ limit: 500 });
        return _sendHtml(res, n.status, renderAdminInventory({
          shop_name: deps.shop_name, nav_available: navAvailable, inventory: page.rows || [],
          notice: n.message,
        }));
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".inventory.create", outcome: "success", metadata: { sku: body.sku } });
      _redirect(res, "/admin/inventory?created=1");
    },
  ));

  router.post("/admin/inventory/:sku/restock", _pageOrApi(false,
    W("inventory.restock", async function (req, res) {
      var qty = parseInt((req.body || {}).qty, 10);
      if (!Number.isFinite(qty)) throw new TypeError("admin.inventory.restock: body.qty required (integer)");
      var inv = await catalog.inventory.restock(req.params.sku, qty);
      if (!inv) return _problem(res, 404, "inventory-not-found");
      _json(res, 200, inv);
      return Object.assign({ id: req.params.sku }, inv);
    }),
    async function (req, res) {
      // Browser row form: restock by qty (when > 0) and/or set the low-stock
      // threshold (when the field is non-empty; blank clears it). A bad sku is
      // a no-op notice, never a 500.
      var body = req.body || {};
      var sku = req.params.sku;
      var changed = false;
      try {
        var qty = parseInt(body.qty, 10);
        if (Number.isFinite(qty) && qty > 0) { if (await catalog.inventory.restock(sku, qty)) changed = true; }
        if (Object.prototype.hasOwnProperty.call(body, "threshold")) {
          var raw = String(body.threshold).trim();
          var threshold = raw === "" ? null : parseInt(raw, 10);
          if (threshold === null || (Number.isInteger(threshold) && threshold >= 0)) {
            if (await catalog.inventory.setThreshold(sku, threshold)) changed = true;
          }
        }
      } catch (e) { if (!(e instanceof TypeError)) throw e; }
      // restock / setThreshold return null for an unknown SKU — don't report
      // success on a stale/tampered form to a non-existent SKU.
      if (!changed) return _redirect(res, "/admin/inventory?err=1");
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".inventory.restock", outcome: "success", metadata: { sku: sku } });
      _redirect(res, "/admin/inventory?updated=1");
    },
  ));

  // Per-SKU low-stock threshold. Body `{ threshold }` — null clears.
  router.patch("/admin/inventory/:sku/threshold", W("inventory.set_threshold", async function (req, res) {
    var body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, "threshold")) {
      throw new TypeError("admin.inventory.set_threshold: body.threshold required (integer ≥ 0 or null)");
    }
    var threshold = body.threshold;
    if (threshold !== null && !Number.isInteger(threshold)) {
      throw new TypeError("admin.inventory.set_threshold: threshold must be a non-negative integer or null");
    }
    var inv = await catalog.inventory.setThreshold(req.params.sku, threshold);
    if (!inv) return _problem(res, 404, "inventory-not-found");
    _json(res, 200, inv);
    return Object.assign({ id: req.params.sku }, inv);
  }));

  // Recent low-stock alerts. Defaults to 100 newest by fired_at DESC.
  // Optional `?sku=` narrows to a single SKU's history; `?limit=` +
  // `?offset=` page through older alerts.
  var inventoryAlerts = deps.inventoryAlerts || null;
  if (inventoryAlerts) {
    router.get("/admin/inventory/alerts", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var sku    = url && url.searchParams.get("sku");
      var limitS = url && url.searchParams.get("limit");
      var offsetS = url && url.searchParams.get("offset");
      var limit  = limitS == null ? 100 : parseInt(limitS, 10);
      var offset = offsetS == null ? 0   : parseInt(offsetS, 10);
      if (!Number.isFinite(limit))  throw new TypeError("admin.inventory.alerts: limit must be an integer");
      if (!Number.isFinite(offset)) throw new TypeError("admin.inventory.alerts: offset must be a non-negative integer");
      var rows = await inventoryAlerts.list({
        sku:    sku || undefined,
        limit:  limit,
        offset: offset,
      });
      _json(res, 200, { rows: rows });
    }));
  }

  // ---- media ----------------------------------------------------------

  // True when media `mid` exists AND its product_id equals `productId` — the
  // self-consistency check the per-product media routes assert before acting,
  // so a `/admin/products/:id/media/:mid/...` request can't name product A in
  // the path while operating on product B's media. A malformed `mid` makes
  // catalog.media.get throw TypeError (the caller maps it to a clean 400);
  // an unknown id, a foreign-product id, or a variant-only row (no
  // product_id) returns false so the caller renders the same not-found.
  async function _mediaBelongsToProduct(mid, productId) {
    var row = await catalog.media.get(mid);
    return !!(row && row.product_id && row.product_id === productId);
  }

  router.post("/admin/media", W("media.attach", async function (req, res) {
    var m = await catalog.media.attach(req.body || {});
    _json(res, 201, m);
    return m;
  }));

  // Browser POST alias: attach an existing R2 object to a product from the
  // product detail screen. The product id comes from the path; the
  // primitive validates the r2_key + content_type. Bad input → ?err=1.
  router.post("/admin/products/:id/media/attach", _pageOrApi(false,
    W("media.attach", async function (req, res) {
      var body = Object.assign({}, req.body || {}, { product_id: req.params.id });
      var m = await catalog.media.attach(body);
      _json(res, 201, m);
      return m;
    }),
    async function (req, res) {
      var id  = req.params.id;
      var enc = encodeURIComponent(id);
      var body = req.body || {};
      try {
        await catalog.media.attach({
          product_id:   id,
          r2_key:       typeof body.r2_key === "string" ? body.r2_key.trim() : body.r2_key,
          content_type: typeof body.content_type === "string" ? body.content_type.trim() : body.content_type,
          alt_text:     typeof body.alt_text === "string" ? body.alt_text : undefined,
        });
      } catch (e) {
        // Bad input (TypeError), a missing product (FOREIGN KEY constraint),
        // or any other failure → a notice via PRG. _safeNotice records an
        // unknown error server-side; the redirect itself carries no raw
        // message, so the storage-engine string can't ride the query into
        // the detail banner.
        _safeNotice(e, "media.attach");
        return _redirect(res, "/admin/products/" + enc + "?err=1");
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".media.attach", outcome: "success", metadata: { id: id } });
      _redirect(res, "/admin/products/" + enc + "?saved=1");
    },
  ));

  // --- media upload (r2 bridge) ---------------------------------------
  // POST /admin/media/upload — fetches `source_url` via b.httpClient
  // (SSRF gate + size cap), uploads to R2 through the bridge, then
  // records the media row. Endpoint is omitted entirely when no
  // r2_bridge is wired (operator hasn't set D1_BRIDGE_URL +
  // D1_BRIDGE_SECRET).
  if (r2) {
    // Fetch → store → attach, shared by the JSON upload route and the
    // browser POST alias. Throws TypeError on bad input (mapped to 400);
    // returns `{ status, code, detail }` for an operational failure the
    // caller renders as a problem (JSON) or ?err=1 (browser), or `{ rec }`
    // on success.
    async function _performMediaUpload(body) {
      body = body || {};
      if (typeof body.source_url !== "string" || !body.source_url.length) {
        throw new TypeError("admin.media.upload: body.source_url required");
      }
      if (!body.product_id && !body.variant_id) {
        throw new TypeError("admin.media.upload: one of product_id / variant_id required");
      }
      if (typeof body.content_type !== "string" || !body.content_type.length) {
        throw new TypeError("admin.media.upload: body.content_type required");
      }
      if (!/^[\w.+\-]+\/[\w.+\-]+/.test(body.content_type)) {
        throw new TypeError("admin.media.upload: body.content_type must match `type/subtype`");
      }
      // Fetch the source bytes. The framework's httpClient runs every
      // outbound through the SSRF gate, so a `source_url` pointing at
      // a cloud-metadata IP (169.254.169.254) / RFC 1918 host can't
      // smuggle internal data into the bucket. `maxResponseBytes` caps the
      // buffered body at the same media budget the direct-file path enforces
      // (`_UPLOAD_MAX_BYTES`): without it the client buffers up to its
      // ~1 GiB GET default, so a `source_url` pointing at a multi-gigabyte
      // resource would balloon memory before the magic-byte sniff ever runs.
      // The client rejects with `RESPONSE_TOO_LARGE` the moment the body
      // crosses the cap; that surfaces below as a clean 413, never an OOM or
      // a 500.
      var fetched;
      try {
        fetched = await b.httpClient.request({
          method:           "GET",
          url:              body.source_url,
          timeoutMs:        20000,
          maxResponseBytes: _UPLOAD_MAX_BYTES,
          headers:          { "accept": body.content_type + ",*/*;q=0.5" },
        });
      } catch (e) {
        if (e && e.code === "RESPONSE_TOO_LARGE") {
          return { status: 413, code: "source-too-large",
            detail: "source_url body exceeds the " + _UPLOAD_MAX_BYTES + "-byte media upload cap" };
        }
        return { status: 502, code: "source-fetch-failed", detail: (e && e.message) || String(e) };
      }
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        return { status: 502, code: "source-fetch-status", detail: "source_url returned HTTP " + fetched.statusCode };
      }
      var fetchedCT = String(fetched.headers && (fetched.headers["content-type"] || fetched.headers["Content-Type"]) || "");
      // Loose match — the declared content_type must be a prefix of
      // (or equal to) the server's content-type up to parameters. So
      // `image/png` accepts `image/png; charset=binary` but refuses
      // `application/zip` smuggled past the operator's intent.
      var declared = body.content_type.split(";")[0].trim().toLowerCase();
      var served   = fetchedCT.split(";")[0].trim().toLowerCase();
      if (served && declared !== served) {
        return { status: 422, code: "content-type-mismatch",
          detail: "source_url served `" + served + "` but operator declared `" + declared + "`" };
      }
      var buf = fetched.body && Buffer.isBuffer(fetched.body) ? fetched.body
              : Buffer.from(fetched.body || "");
      if (buf.length === 0) {
        return { status: 422, code: "source-empty", detail: "source_url returned an empty body" };
      }
      return await _storeAndAttach(buf, body.content_type, body);
    }

    // Store bytes to R2 and attach the media row — the tail shared by the
    // upload-from-URL flow and the direct-file upload flow. Generates the
    // R2 key (extension inferred from the declared content-type so the
    // operator can preview without a content-disposition round-trip),
    // pushes through the same r2_bridge put path, then records the catalog
    // row. Returns `{ status, code, detail }` on an operational failure or
    // `{ rec }` on success. Never throws on an R2 / attach failure — the
    // caller renders the problem.
    async function _storeAndAttach(buf, contentType, body) {
      var declared = String(contentType).split(";")[0].trim().toLowerCase();
      // SVG is text — magic-byte sniffing can't classify it, so the type
      // gate trusts the declared `image/svg+xml`. An SVG served same-origin
      // from the media bucket is a stored-XSS vector on direct navigation
      // (embedded <script>, on* handlers, javascript: URLs, foreignObject
      // namespace escapes). Run the bytes through the framework's SVG guard
      // before they reach the bucket: `refuse` (an unrepairable threat —
      // <script>, DOCTYPE/XXE, SVGZ) is an operational failure the caller
      // renders as a clean 4xx with no row written; `sanitize` stores the
      // repaired bytes; `serve` stores the (clean) original. Composes the
      // vendored b.guardSvg — never a hand-rolled SVG allowlist.
      if (declared === "image/svg+xml") {
        var verdict;
        try {
          verdict = await b.guardSvg.gate({ profile: "strict" }).check({ bytes: buf });
        } catch (_e) {
          return { status: 422, code: "svg-unsafe",
            detail: "the uploaded SVG could not be validated as safe to serve" };
        }
        if (!verdict || verdict.action === "refuse") {
          return { status: 422, code: "svg-unsafe",
            detail: "the uploaded SVG carries active content that can't be served safely (scripts, external entities, or a compressed payload)" };
        }
        if (verdict.action === "sanitize") {
          // The guard hands back the repaired bytes as a Buffer (the gate
          // contract) — or, defensively, a string. Anything else is a guard
          // malfunction; fail closed rather than store unvalidated bytes.
          var clean = verdict.sanitized;
          if (Buffer.isBuffer(clean)) {
            buf = clean;
          } else if (typeof clean === "string") {
            buf = Buffer.from(clean, "utf8");
          } else {
            return { status: 422, code: "svg-unsafe",
              detail: "the uploaded SVG could not be sanitized into safe-to-serve bytes" };
          }
        }
      }
      var ext = _extFromContentType(declared);
      var id  = b.uuid.v7();
      var key = "media/" + id + (ext ? "." + ext : "");
      try {
        await r2.put(key, buf, contentType);
      } catch (e) {
        return { status: 502, code: "r2-upload-failed", detail: (e && e.message) || String(e) };
      }
      var m;
      try {
        m = await catalog.media.attach({
          product_id:   body.product_id || undefined,
          variant_id:   body.variant_id || undefined,
          r2_key:       key,
          content_type: contentType,
          width:        body.width    || 0,
          height:       body.height   || 0,
          position:     body.position || 0,
          alt_text:     body.alt_text || "",
        });
      } catch (e) {
        // The R2 write succeeded but the DB row didn't land — surface
        // the orphan key so the operator can reconcile or re-attach.
        var problem = e instanceof TypeError ? 400 : 500;
        return { status: problem, code: "media-attach-failed",
          detail: (e && e.message || String(e)) + " (orphan r2_key=" + key + ")" };
      }
      // Expose the public asset URL alongside the media row so the
      // admin UI can preview without an extra round-trip.
      return { rec: Object.assign({}, m, { asset_url: assetPrefix + key }) };
    }

    // Direct-file upload: validate + store an image picked from the
    // operator's device. The framework's multipart body-parser has already
    // streamed the part to a tmp file (req.files[N] = { field, filename,
    // mimeType, path, size, hash }); this reads it back, checks the
    // declared MIME against the image allowlist, enforces the media-budget
    // size cap, cross-checks the magic bytes against the declared type
    // (defense against an image/png label on a non-image body), then hands
    // off to _storeAndAttach. Request-shape reader: returns `{ status,
    // code, detail }` for any bad/oversized/disallowed file rather than
    // throwing — the upload must never crash the request that carries it.
    async function _performFileUpload(file, body) {
      body = body || {};
      if (!body.product_id && !body.variant_id) {
        return { status: 400, code: "missing-target", detail: "one of product_id / variant_id required" };
      }
      if (!file || typeof file.path !== "string" || !file.path.length) {
        return { status: 400, code: "no-file", detail: "no file part received (expected a multipart `file` field)" };
      }
      var declaredCT = String(file.mimeType || "").split(";")[0].trim().toLowerCase();
      if (!_UPLOAD_IMAGE_CT[declaredCT]) {
        return { status: 415, code: "unsupported-type",
          detail: "`" + (declaredCT || "(none)") + "` is not an accepted image type " +
                  "(png, jpeg, webp, gif, avif, svg)" };
      }
      // The multipart parser caps file size globally, but the media route
      // pins its own budget so the limit is explicit here and the message
      // names the media cap. file.size is the streamed byte count.
      if (typeof file.size === "number" && file.size > _UPLOAD_MAX_BYTES) {
        return { status: 413, code: "file-too-large",
          detail: "file is " + file.size + " bytes, exceeds the " + _UPLOAD_MAX_BYTES + "-byte media upload cap" };
      }
      // Read the streamed tmp file back through the framework's atomic
      // reader with the media cap as maxBytes — this re-checks the on-disk
      // byte count against the budget (the parser's own cap is global) and
      // catches a size header that under-reported the streamed bytes,
      // throwing `atomic-file/too-large` rather than buffering past the cap.
      var buf;
      try {
        buf = b.atomicFile.readSync(file.path, { maxBytes: _UPLOAD_MAX_BYTES });
      } catch (e) {
        if (e && e.code === "atomic-file/too-large") {
          return { status: 413, code: "file-too-large",
            detail: "file exceeds the " + _UPLOAD_MAX_BYTES + "-byte media upload cap" };
        }
        return { status: 500, code: "tmp-read-failed", detail: (e && e.message) || String(e) };
      }
      if (buf.length === 0) {
        return { status: 422, code: "file-empty", detail: "uploaded file is empty (0 bytes)" };
      }
      // Magic-byte cross-check: refuse a body whose sniffed type doesn't
      // match the declared image type. svg is text (no magic bytes) so
      // b.fileType.detect returns null — skip the cross-check for it and
      // trust the declared type, same as the upload-from-URL flow.
      if (declaredCT !== "image/svg+xml") {
        var sniffed = b.fileType.detect(buf);
        var sniffedMime = sniffed && sniffed.mime;
        // jpg/jpeg are synonyms; normalize both sides to one token.
        var declNorm  = declaredCT === "image/jpg" ? "image/jpeg" : declaredCT;
        var sniffNorm = sniffedMime === "image/jpg" ? "image/jpeg" : sniffedMime;
        if (!sniffNorm) {
          return { status: 422, code: "unrecognized-bytes",
            detail: "could not classify the file's bytes as a known image format" };
        }
        if (sniffNorm !== declNorm) {
          return { status: 422, code: "content-type-mismatch",
            detail: "file bytes sniff as `" + sniffNorm + "` but the part declared `" + declaredCT + "`" };
        }
      }
      return await _storeAndAttach(buf, declaredCT, body);
    }

    // Pull the first uploaded file out of req.files. The multipart parser
    // exposes every accepted file part as req.files[] = { field, filename,
    // mimeType, path, size, hash }; the media form names its part `file`,
    // but accept any single file part so an API caller using a different
    // field name still works.
    function _firstUploadFile(req) {
      var files = (req && Array.isArray(req.files)) ? req.files : [];
      if (!files.length) return null;
      for (var i = 0; i < files.length; i++) {
        if (files[i] && files[i].field === "file") return files[i];
      }
      return files[0];
    }

    router.post("/admin/media/upload", W("media.upload", async function (req, res) {
      var out = await _performMediaUpload(req.body || {});
      if (out.rec) { _json(res, 201, out.rec); return out.rec; }
      return _problem(res, out.status, out.code, out.detail);
    }));

    // Browser POST alias: upload-from-URL scoped to a product (id from the
    // path). On success PRGs back to the detail; an operational failure or
    // bad input lands a ?err=1 notice rather than a problem-details JSON.
    router.post("/admin/products/:id/media/upload", _pageOrApi(false,
      W("media.upload", async function (req, res) {
        var body = Object.assign({}, req.body || {}, { product_id: req.params.id });
        var out = await _performMediaUpload(body);
        if (out.rec) { _json(res, 201, out.rec); return out.rec; }
        return _problem(res, out.status, out.code, out.detail);
      }),
      async function (req, res) {
        var id  = req.params.id;
        var enc = encodeURIComponent(id);
        var body = Object.assign({}, req.body || {}, { product_id: id });
        var out;
        try { out = await _performMediaUpload(body); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/products/" + enc + "?err=1"); }
        if (!out.rec) return _redirect(res, "/admin/products/" + enc + "?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".media.upload", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/products/" + enc + "?saved=1");
      },
    ));

    // Direct-file upload (multipart/form-data). The JSON API route takes
    // product_id / variant_id from the form fields; the browser alias
    // scopes it to the product in the path and PRGs back to the detail.
    router.post("/admin/media/upload-file", W("media.upload", async function (req, res) {
      var out = await _performFileUpload(_firstUploadFile(req), req.body || {});
      if (out.rec) { _json(res, 201, out.rec); return out.rec; }
      return _problem(res, out.status, out.code, out.detail);
    }));

    router.post("/admin/products/:id/media/upload-file", _pageOrApi(false,
      W("media.upload", async function (req, res) {
        var body = Object.assign({}, req.body || {}, { product_id: req.params.id });
        var out = await _performFileUpload(_firstUploadFile(req), body);
        if (out.rec) { _json(res, 201, out.rec); return out.rec; }
        return _problem(res, out.status, out.code, out.detail);
      }),
      async function (req, res) {
        var id  = req.params.id;
        var enc = encodeURIComponent(id);
        var body = Object.assign({}, req.body || {}, { product_id: id });
        var out = await _performFileUpload(_firstUploadFile(req), body);
        if (!out.rec) return _redirect(res, "/admin/products/" + enc + "?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".media.upload", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/products/" + enc + "?saved=1");
      },
    ));
  }

  router.delete("/admin/media/:id", W("media.delete", async function (req, res) {
    var ok = await catalog.media.delete(req.params.id);
    if (!ok) return _problem(res, 404, "media-not-found");
    _json(res, 200, { ok: true });
    return { id: req.params.id };
  }));

  // Browser confirm interstitial for media delete — removing a media row
  // detaches the asset from the product (the R2 object itself is left in
  // the bucket for the operator to reclaim), so the console confirms.
  router.get("/admin/media/:id/delete/confirm-page", _pageOrApi(true,
    R(async function (_req, res) {
      return _problem(res, 405, "use-canonical-endpoint", "DELETE /admin/media/:id (or POST .../delete) directly for the JSON API");
    }),
    async function (req, res) {
      var mid = req.params.id;
      var m = null;
      try { m = await catalog.media.get(mid); }
      catch (e) { if (!(e instanceof TypeError)) throw e; }
      var productId = m ? m.product_id : null;
      var back = productId ? "/admin/products/" + encodeURIComponent(productId) : "/admin/products";
      if (!m) return _redirect(res, back + "?err=1");
      _sendHtml(res, 200, renderAdminConfirm({
        shop_name: deps.shop_name, nav_available: navAvailable, active: "products",
        heading: "Delete this media?",
        consequence: "This detaches the asset from the product. The stored object remains in your bucket — reclaim it there if no longer needed.",
        detail: m.r2_key ? "Key: " + m.r2_key : "This media row will be removed.",
        action: "/admin/media/" + _htmlEscape(mid) + "/delete",
        confirm_label: "Delete media",
        cancel_href: back,
      }));
    },
  ));

  // Browser POST for media delete (HTML forms can't DELETE).
  router.post("/admin/media/:id/delete", _pageOrApi(false,
    W("media.delete", async function (req, res) {
      var ok = await catalog.media.delete(req.params.id);
      if (!ok) return _problem(res, 404, "media-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.id };
    }),
    async function (req, res) {
      var mid = req.params.id;
      var m = null;
      try { m = await catalog.media.get(mid); }
      catch (e) { if (!(e instanceof TypeError)) throw e; }
      var productId = m ? m.product_id : null;
      var back = productId ? "/admin/products/" + encodeURIComponent(productId) : "/admin/products";
      var ok = false;
      try { ok = await catalog.media.delete(mid); }
      catch (e) { if (!(e instanceof TypeError)) throw e; }
      if (!ok) return _redirect(res, back + "?err=1");
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".media.delete", outcome: "success", metadata: { id: mid } });
      _redirect(res, back + "?saved=1");
    },
  ));

  // Reorder a product's media. The PDP gallery renders the media in list
  // order with the first row as the hero, so this is "rearrange the gallery
  // + choose which image leads." Browser form posts the full ordered id set
  // as a comma-joined `ordered_media_ids` string (same convention as the
  // collections-members reorder); the JSON API accepts an array. The
  // primitive rewrites `position` to 0..N-1 and refuses a partial / foreign
  // set (TypeError → clean 400 / ?err=1). DB-only — no R2 bridge needed.
  router.post("/admin/products/:id/media/reorder", _pageOrApi(false,
    W("media.reorder", async function (req, res) {
      var body = req.body || {};
      var ids = Array.isArray(body.ordered_media_ids) ? body.ordered_media_ids : null;
      if (!ids || ids.length === 0) return _problem(res, 400, "bad-request", "ordered_media_ids array required");
      try { await catalog.media.reorder(req.params.id, ids); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      _json(res, 200, { ok: true });
      return { id: req.params.id };
    }),
    async function (req, res) {
      var id  = req.params.id;
      var enc = encodeURIComponent(id);
      var body = req.body || {};
      // The reorder form posts a single comma-joined id field; also accept
      // repeated ordered_media_id rows for parity with the collections form.
      var ids;
      if (body.ordered_media_ids != null && typeof body.ordered_media_ids === "string") {
        ids = body.ordered_media_ids.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      } else {
        var raw = body.ordered_media_id;
        var rows = raw == null ? [] : (Array.isArray(raw) ? raw : [raw]);
        ids = rows.map(function (s) { return String(s).trim(); }).filter(Boolean);
      }
      if (!ids.length) return _redirect(res, "/admin/products/" + enc + "?err=1");
      try { await catalog.media.reorder(id, ids); }
      catch (e) {
        _safeNotice(e, "media.reorder");
        return _redirect(res, "/admin/products/" + enc + "?err=1");
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".media.reorder", outcome: "success", metadata: { id: id } });
      _redirect(res, "/admin/products/" + enc + "?saved=1");
    },
  ));

  // Promote one media row to the hero slot (position 0). No body — the media
  // id is in the path, the product id only used to PRG back to the detail.
  // A malformed id throws TypeError (→ 400 / ?err=1); an unknown or
  // variant-only row returns false (→ 404 / ?err=1). DB-only.
  //
  // The :id (product) path segment is asserted against the media row's own
  // product_id before the promote: the primitive scopes its reorder by the
  // row's product, so naming product A in the path while pointing :mid at
  // product B's media would silently act on B. Refuse that mismatch (and a
  // variant-only row, which has no product to lead) with the same clean
  // not-found status, so the path is self-consistent and the contract
  // doesn't lie about which product it touched.
  router.post("/admin/products/:id/media/:mid/primary", _pageOrApi(false,
    W("media.set_primary", async function (req, res) {
      var ok;
      try {
        if (!(await _mediaBelongsToProduct(req.params.mid, req.params.id))) {
          return _problem(res, 404, "media-not-found");
        }
        ok = await catalog.media.setPrimary(req.params.mid);
      }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!ok) return _problem(res, 404, "media-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.mid };
    }),
    async function (req, res) {
      var id  = req.params.id;
      var enc = encodeURIComponent(id);
      var ok = false;
      try {
        if (!(await _mediaBelongsToProduct(req.params.mid, id))) {
          return _redirect(res, "/admin/products/" + enc + "?err=1");
        }
        ok = await catalog.media.setPrimary(req.params.mid);
      }
      catch (e) {
        _safeNotice(e, "media.set_primary");
        return _redirect(res, "/admin/products/" + enc + "?err=1");
      }
      if (!ok) return _redirect(res, "/admin/products/" + enc + "?err=1");
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".media.set_primary", outcome: "success", metadata: { id: req.params.mid } });
      _redirect(res, "/admin/products/" + enc + "?saved=1");
    },
  ));

  // ---- bulk catalog import --------------------------------------------

  // POST /admin/catalog/import — Content-Type: text/csv body. The CSV
  // header row is exact-order: product_slug, product_title,
  // product_status, product_description, variant_sku, variant_title,
  // variant_weight_grams, price_currency, price_amount_minor,
  // inventory_qty. Rows sharing a product_slug collapse to a single
  // parent product (first row wins for title/status/description); each
  // row produces a variant + price + inventory entry. Per-row errors
  // are collected and returned alongside the success counts — the
  // operator decides whether to re-upload with fixes. `?dry_run=true`
  // validates without writing.
  if (catalogImport) {
    router.post("/admin/catalog/import", W("catalog.import", async function (req, res) {
      var csv = req.body;
      if (typeof csv !== "string" || !csv.length) {
        throw new TypeError("admin.catalog.import: send the CSV as a text/csv body");
      }
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var dryRunQ = url && url.searchParams.get("dry_run");
      var dryRun = dryRunQ === "true" || dryRunQ === "1";
      var result = await catalogImport.importCsv({ csv: csv, dry_run: dryRun });
      _json(res, 200, result);
      return {
        id:       "catalog.import:" + Date.now(),
        dry_run:  dryRun,
        rows:     result.rows,
        errors:   result.errors.length,
        created:  result.created,
      };
    }));
  }

  // ---- orders ---------------------------------------------------------

  // Recent orders across all customers. Bearer → no list endpoint existed
  // before, so this adds one (JSON); a signed-in browser gets the console.
  router.get("/admin/orders", _pageOrApi(true,
    R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var status = url && url.searchParams.get("status");
      var limitS = url && url.searchParams.get("limit");
      var limit  = limitS == null ? 50 : parseInt(limitS, 10);
      var list = await order.listRecent({ status: status || undefined, limit: limit });
      _json(res, 200, list);
    }),
    async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var statusRaw = url && url.searchParams.get("status");
      // A bad ?status= filter falls back to "all" rather than erroring the
      // page — the operator just sees everything, which is a safe default.
      var status = null, notice = null;
      if (statusRaw) {
        try { await order.listRecent({ status: statusRaw, limit: 1 }); status = statusRaw; }
        catch (_e) { notice = "Unknown status filter — showing all orders."; }
      }
      var list = await order.listRecent({ status: status || undefined, limit: 100 });
      _sendHtml(res, 200, renderAdminOrders({
        shop_name: deps.shop_name, nav_available: navAvailable, orders: list.rows || [],
        status: status, notice: notice,
      }));
    },
  ));

  router.get("/admin/orders/:id", _pageOrApi(true,
    R(async function (req, res) {
      var o = await order.get(req.params.id);
      if (!o) return _problem(res, 404, "order-not-found");
      _json(res, 200, o);
    }),
    async function (req, res) {
      var o;
      // A malformed id throws (defensive id reader) — render 404, not 500.
      try { o = await order.get(req.params.id); }
      catch (e) { if (!(e instanceof TypeError)) throw e; o = null; }
      if (!o) return _sendHtml(res, 404, renderAdminOrders({
        shop_name: deps.shop_name, nav_available: navAvailable, orders: [], notice: "Order not found.",
      }));
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      // Shipment + carrier-event ledger for the tracking panel. Best-effort:
      // the shipments table may be unmigrated on a given deploy, so a read
      // failure degrades to "no shipments yet" rather than 500-ing the
      // detail. Each shipment is hydrated via getShipment so the panel can
      // list its carrier events.
      var shipments = [];
      if (orderTracking) {
        try {
          var shipRows = await orderTracking.listForOrder(o.id);
          for (var si = 0; si < shipRows.length; si += 1) {
            var full = await orderTracking.getShipment(shipRows[si].id);
            var ship = full || shipRows[si];
            // Carrier-label records for the shipment. Best-effort: the
            // shipping_labels table may be unmigrated, and the labels
            // primitive may not be wired — a read failure leaves the
            // panel label-free rather than 500-ing the order detail.
            if (shippingLabels) {
              try { ship.labels = await shippingLabels.labelsForShipment(ship.id); }
              catch (_le) { ship.labels = []; }
            }
            shipments.push(ship);
          }
        } catch (_e) { shipments = []; }
      }
      // Split-shipment plans for the order. Best-effort, same rationale
      // as the shipment read above — a missing table / unwired primitive
      // degrades to "no plans" rather than erroring the page.
      var splitPlans = [];
      if (splitShipments) {
        try { splitPlans = await splitShipments.splitsForOrder(o.id); }
        catch (_se) { splitPlans = []; }
      }
      _sendHtml(res, 200, renderAdminOrder({
        shop_name:   deps.shop_name,
        nav_available: navAvailable,
        order:       o,
        transitions: order.transitionsFrom(o.status),
        // Refund moves money, so the console only offers it when a payment
        // provider is wired AND the order has a captured intent to refund.
        can_refund:  !!(payment && o.payment_intent_id),
        // Shipment/tracking panel only renders when the tracking primitive
        // is wired; the carrier + status enums drive its form selects.
        can_track:   !!orderTracking,
        // Printable-document links — shown only when the render primitive is
        // wired (its route is mounted only then).
        can_receipt:      !!printReceipts,
        can_packing_slip: !!packingSlips,
        // Per-shipment carrier-label record form + split-shipment planner —
        // each renders only when its primitive is wired (routes mount only
        // then). Label carrier/package/broker enums drive the form selects.
        can_label:        !!shippingLabels,
        label_carriers:   shippingLabels ? shippingLabels.CARRIERS : null,
        label_package_types: shippingLabels ? shippingLabels.PACKAGE_TYPES : null,
        label_purchased_via: shippingLabels ? shippingLabels.PURCHASED_VIA : null,
        can_split:        !!splitShipments,
        split_plans:      splitPlans,
        shipments:   shipments,
        carriers:    orderTracking ? orderTracking.CARRIERS : null,
        statuses:    orderTracking ? orderTracking.STATUSES : null,
        moved:       url && url.searchParams.get("moved"),
        ship_done:   url && url.searchParams.get("ship"),
        label_done:  url && url.searchParams.get("label"),
        split_done:  url && url.searchParams.get("split"),
        notice:      url && url.searchParams.get("err") ? "That action couldn't be completed for this order." : null,
      }));
    },
  ));

  // ---- shipment tracking (operator-managed) ---------------------------
  //
  // Attach a shipment to an order (carrier + optional tracking number) and
  // record carrier events against it. Composes order-tracking; mounted
  // only when that primitive is wired. Both the JSON API and the browser
  // console funnel through `W()` so writes carry the CSRF + audit
  // discipline of the rest of the console. The browser side redirects back
  // to the order detail (PRG); a bad shape (TypeError) surfaces as a
  // notice, never a 500.
  if (orderTracking) {
    router.post("/admin/orders/:id/shipments", _pageOrApi(false,
      W("order.shipment.create", async function (req, res) {
        var body = req.body || {};
        var ship;
        try {
          ship = await orderTracking.createShipment({
            order_id:           req.params.id,
            carrier:            body.carrier,
            carrier_other_name: body.carrier_other_name || undefined,
            tracking_number:    body.tracking_number || undefined,
          });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 201, ship);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var body = req.body || {};
        try {
          await orderTracking.createShipment({
            order_id:           id,
            carrier:            body.carrier,
            carrier_other_name: (body.carrier_other_name && body.carrier_other_name.length) ? body.carrier_other_name : undefined,
            tracking_number:    (body.tracking_number && body.tracking_number.length) ? body.tracking_number : undefined,
          });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.shipment.create", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/orders/" + enc + "?ship=1");
      },
    ));

    router.post("/admin/orders/:id/shipments/:shipmentId/events", _pageOrApi(false,
      W("order.shipment.event", async function (req, res) {
        var body = req.body || {};
        var ev;
        try {
          ev = await orderTracking.recordEvent({
            shipment_id: req.params.shipmentId,
            status:      body.status,
            location:    body.location || undefined,
            detail:      body.detail || undefined,
          });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 200, ev);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var body = req.body || {};
        try {
          await orderTracking.recordEvent({
            shipment_id: req.params.shipmentId,
            status:      body.status,
            location:    (body.location && body.location.length) ? body.location : undefined,
            detail:      (body.detail && body.detail.length) ? body.detail : undefined,
          });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.shipment.event", outcome: "success", metadata: { id: id, shipment_id: req.params.shipmentId } });
        _redirect(res, "/admin/orders/" + enc + "?ship=1");
      },
    ));
  }

  // ---- shipping labels (per-shipment carrier-label record) ------------
  //
  // Records a carrier-minted label against an existing shipment. The
  // framework never calls the broker (EasyPost/Shippo/etc.) — the operator
  // (or their worker) holds the broker credentials, mints the label, and
  // records the result here. The console flow composes the labels
  // primitive's two-step lifecycle in one POST: requestLabel writes the
  // pending row (parcel dims + carrier + service), then markPurchased
  // stamps the broker-minted tracking number + label URL + cost. Mounted
  // only when both the labels primitive AND order-tracking are wired (a
  // label has no shipment to hang off without tracking).
  if (shippingLabels && orderTracking) {
    router.post("/admin/orders/:id/shipments/:shipmentId/labels", _pageOrApi(false,
      W("order.shipment.label", async function (req, res) {
        var body = req.body || {};
        var out;
        try {
          out = await _recordShippingLabel(req.params.shipmentId, body);
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          if (e && e.code && /SHIPPING_LABELS/.test(e.code)) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 201, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var body = req.body || {};
        try {
          await _recordShippingLabel(req.params.shipmentId, body);
        } catch (e) {
          if (!(e instanceof TypeError) && !(e && e.code && /SHIPPING_LABELS/.test(e.code))) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.shipment.label", outcome: "success", metadata: { id: id, shipment_id: req.params.shipmentId } });
        _redirect(res, "/admin/orders/" + enc + "?label=1");
      },
    ));

    // Mark a recorded label as used (parcel handed to the carrier).
    // purchased → used. Separate from the record step so the warehouse can
    // close out the label at pickup time.
    router.post("/admin/orders/:id/labels/:labelId/used", _pageOrApi(false,
      W("order.shipment.label.used", async function (req, res) {
        var out;
        try {
          out = await shippingLabels.markUsed({ label_id: req.params.labelId });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          if (e && e.code && /SHIPPING_LABELS/.test(e.code)) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        try {
          await shippingLabels.markUsed({ label_id: req.params.labelId });
        } catch (e) {
          if (!(e instanceof TypeError) && !(e && e.code && /SHIPPING_LABELS/.test(e.code))) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.shipment.label.used", outcome: "success", metadata: { id: id, label_id: req.params.labelId } });
        _redirect(res, "/admin/orders/" + enc + "?label=1");
      },
    ));

    // Void a recorded label (broker void, within the 30-day window).
    // purchased → voided. Mirrors the /used route: the primitive enforces
    // the transition + window, a TypeError (bad id / missing reason) or a
    // SHIPPING_LABELS_* coded error (wrong status / expired window) surfaces
    // as a 400 on the JSON path and an `?err` notice on the browser path.
    router.post("/admin/orders/:id/labels/:labelId/void", _pageOrApi(false,
      W("order.shipment.label.void", async function (req, res) {
        var body = req.body || {};
        var out;
        try {
          out = await shippingLabels.voidLabel({ label_id: req.params.labelId, reason: body.reason });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          if (e && e.code && /SHIPPING_LABELS/.test(e.code)) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var body = req.body || {};
        try {
          await shippingLabels.voidLabel({
            label_id: req.params.labelId,
            // A blank reason field reaches the primitive as undefined so the
            // operator-facing "reason required" message surfaces, rather than
            // the empty string slipping past the non-empty check.
            reason: (body.reason && body.reason.length) ? body.reason : undefined,
          });
        } catch (e) {
          if (!(e instanceof TypeError) && !(e && e.code && /SHIPPING_LABELS/.test(e.code))) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.shipment.label.void", outcome: "success", metadata: { id: id, label_id: req.params.labelId } });
        _redirect(res, "/admin/orders/" + enc + "?label=1");
      },
    ));
  }

  // Compose requestLabel + markPurchased into one recorded label. The
  // console only records labels the operator already minted with their
  // broker, so the two-step primitive lifecycle collapses to a single
  // operator action. Throws TypeError on bad shape (surfaced as 400) and
  // the labels primitive's SHIPPING_LABELS_* coded errors on a bad
  // transition. Defensive request-shape reader — every field is validated
  // by the primitive; the strict-int helpers here only convert the form
  // strings before they reach it.
  async function _recordShippingLabel(shipmentId, body) {
    // Coerce every numeric form field BEFORE the first DB write so a bad
    // cost / dimension throws up-front rather than leaving an orphaned
    // pending-label row from requestLabel. Parcel dimensions + weight are
    // positive integers (mm / grams); money (cost_minor) is non-negative
    // integer minor units — strict /^\d+$/, never parseInt (which would
    // silently truncate "500abc" → 500 onto a cost field).
    var weightGrams = _strictPosIntField(body.weight_grams, "weight_grams");
    var lengthMm    = _strictPosIntField(body.length_mm, "length_mm");
    var widthMm     = _strictPosIntField(body.width_mm, "width_mm");
    var heightMm    = _strictPosIntField(body.height_mm, "height_mm");
    var costMinor   = _strictNonNegIntField(body.cost_minor, "cost_minor");
    var pending = await shippingLabels.requestLabel({
      shipment_id:   shipmentId,
      carrier:       body.carrier,
      service_level: body.service_level,
      weight_grams:  weightGrams,
      length_mm:     lengthMm,
      width_mm:      widthMm,
      height_mm:     heightMm,
      package_type:  body.package_type,
    });
    return await shippingLabels.markPurchased({
      label_id:        pending.id,
      tracking_number: body.tracking_number,
      label_url:       body.label_url,
      cost_minor:      costMinor,
      currency:        typeof body.currency === "string" ? body.currency.trim().toUpperCase() : body.currency,
      purchased_via:   body.purchased_via,
    });
  }

  // ---- shipping labels (standalone back-office console) ---------------
  //
  // A cross-order view of the carrier-label store, separate from the
  // per-shipment panel on the order detail. Three screens, each composing
  // a labels-primitive read:
  //   - /admin/shipping-labels         — a status-filtered list. The
  //       primitive exposes a list read per backable status: `pending`
  //       (pendingLabels) and `voided` (voidedInWindow over a date range).
  //       There is no cross-order list for purchased/used labels — those
  //       are reached from their order detail — so the filter offers the
  //       two engine-backed views, defaulting to pending.
  //   - /admin/shipping-labels/costs   — broker-spend report grouped by
  //       broker + currency over a date range (costsByPeriod).
  //   - /admin/shipping-labels/pending — the mint queue (pendingLabels,
  //       capped at 200) the operator's broker worker drains.
  // Mounted only when the labels primitive is wired. Every HTML handler
  // parses its from/to/carrier query params defensively: a malformed value
  // re-renders the page with a correction notice (never a 500). The bearer
  // JSON contract returns the same composed payload.
  if (shippingLabels) {
    // Resolve a {from, to} epoch-ms window from the query string, accepting
    // either raw epoch-ms (from/to — machine clients) or calendar dates
    // (from-date/to-date — the browser date inputs). `to-date` is the
    // inclusive end day, advanced to the next UTC midnight. Throws TypeError
    // on a malformed value; defaults to the trailing 30 days. Mirrors the
    // reports window resolver so both report surfaces parse identically.
    function _labelWindow(url) {
      var from = _parseEpochMs(url && url.searchParams.get("from"), "from");
      var to   = _parseEpochMs(url && url.searchParams.get("to"),   "to");
      if (from == null) from = _parseDateParam(url && url.searchParams.get("from-date"), "from");
      if (to == null) {
        var toDate = _parseDateParam(url && url.searchParams.get("to-date"), "to");
        if (toDate != null) to = toDate + b.constants.TIME.days(1);
      }
      var now = Date.now();
      return {
        to:   to   == null ? now : to,
        from: from == null ? (now - b.constants.TIME.days(30)) : from,
      };
    }

    // The status filter on the standalone list — only the values the
    // primitive exposes a cross-order list read for.
    function _labelStatusParam(url) {
      var raw = url && url.searchParams.get("status");
      if (raw == null || raw === "") return "pending";
      if (raw !== "pending" && raw !== "voided") {
        throw new TypeError("admin: status must be one of pending, voided");
      }
      return raw;
    }

    // Optional carrier filter for the costs report. Validated against the
    // primitive's frozen enum so a bad value is a notice, not a 500.
    function _labelCarrierParam(url) {
      var raw = url && url.searchParams.get("carrier");
      if (raw == null || raw === "") return null;
      if (shippingLabels.CARRIERS.indexOf(raw) === -1) {
        throw new TypeError("admin: carrier must be one of " + shippingLabels.CARRIERS.join(", "));
      }
      return raw;
    }

    // Compose the list payload for the chosen status. `pending` drains the
    // queue (limit 200, ignoring the window — a pending label has no
    // purchased/voided timestamp to range on); `voided` ranges voided_at
    // over the window.
    async function _labelListPayload(status, win) {
      if (status === "voided") {
        var voided = await shippingLabels.voidedInWindow({ from: win.from, to: win.to });
        return { status: "voided", from: win.from, to: win.to, labels: voided };
      }
      var pending = await shippingLabels.pendingLabels({ limit: MAX_LABEL_LIST_LIMIT });
      return { status: "pending", from: win.from, to: win.to, labels: pending };
    }

    router.get("/admin/shipping-labels", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status, win;
        try { status = _labelStatusParam(url); win = _labelWindow(url); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        var payload;
        try { payload = await _labelListPayload(status, win); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, payload);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = "pending", notice = null;
        var win = { to: Date.now(), from: Date.now() - b.constants.TIME.days(30) };
        try { status = _labelStatusParam(url); win = _labelWindow(url); }
        catch (e) {
          notice = _safeNotice(e, "shipping_label.list").message.replace(/^admin:\s*/, "");
        }
        var payload;
        try { payload = await _labelListPayload(status, win); }
        catch (e2) {
          // A bad range that slipped past the param parse (primitive
          // re-validates from < to) → fall back to the default window.
          win = { to: Date.now(), from: Date.now() - b.constants.TIME.days(30) };
          notice = _safeNotice(e2, "shipping_label.list").message.replace(/^shipping-labels:\s*/, "");
          payload = await _labelListPayload(status, win);
        }
        _sendHtml(res, 200, renderAdminShippingLabels({
          shop_name: deps.shop_name, nav_available: navAvailable,
          payload: payload, notice: notice,
        }));
      },
    ));

    router.get("/admin/shipping-labels/pending", _pageOrApi(true,
      R(async function (req, res) {
        var rows;
        try { rows = await shippingLabels.pendingLabels({ limit: MAX_LABEL_LIST_LIMIT }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, { limit: MAX_LABEL_LIST_LIMIT, labels: rows });
      }),
      async function (req, res) {
        var rows = [], notice = null;
        try { rows = await shippingLabels.pendingLabels({ limit: MAX_LABEL_LIST_LIMIT }); }
        catch (e) {
          notice = _safeNotice(e, "shipping_label.pending").message.replace(/^shipping-labels:\s*/, "");
        }
        _sendHtml(res, 200, renderAdminShippingLabelsPending({
          shop_name: deps.shop_name, nav_available: navAvailable,
          labels: rows, notice: notice,
        }));
      },
    ));

    router.get("/admin/shipping-labels/costs", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var win, carrier;
        try { win = _labelWindow(url); carrier = _labelCarrierParam(url); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        var report;
        try { report = await _labelCostsReport(win, carrier); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, report);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var notice = null, carrier = null;
        var win = { to: Date.now(), from: Date.now() - b.constants.TIME.days(30) };
        try { win = _labelWindow(url); carrier = _labelCarrierParam(url); }
        catch (e) {
          notice = _safeNotice(e, "shipping_label.costs").message.replace(/^admin:\s*/, "");
        }
        var report;
        try { report = await _labelCostsReport(win, carrier); }
        catch (e2) {
          win = { to: Date.now(), from: Date.now() - b.constants.TIME.days(30) };
          carrier = null;
          notice = _safeNotice(e2, "shipping_label.costs").message.replace(/^shipping-labels:\s*/, "");
          report = await _labelCostsReport(win, carrier);
        }
        _sendHtml(res, 200, renderAdminShippingLabelCosts({
          shop_name: deps.shop_name, nav_available: navAvailable,
          report: report, carriers: shippingLabels.CARRIERS, notice: notice,
        }));
      },
    ));
  }

  // Compose the broker-spend report: the per-(broker, currency) aggregate
  // from costsByPeriod plus a per-currency rollup of the gross spend +
  // label count across the window. `_strictMinorInt`-safe — the primitive
  // already returns integer minor units; the rollup only sums them.
  async function _labelCostsReport(win, carrier) {
    var opts2 = { from: win.from, to: win.to };
    if (carrier) opts2.carrier = carrier;
    var rows = await shippingLabels.costsByPeriod(opts2);
    var byCurrency = {};
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var cur = r.currency || "USD";
      if (!byCurrency[cur]) byCurrency[cur] = { currency: cur, total_minor: 0, label_count: 0 };
      // costsByPeriod coerces these to plain numbers already; treat them as
      // integer minor units (admin never renders raw broker prose here).
      byCurrency[cur].total_minor += _strictMinorInt(r.total_minor, "shippingLabels", "total_minor");
      byCurrency[cur].label_count += _strictMinorInt(r.label_count, "shippingLabels", "label_count");
    }
    var totals = Object.keys(byCurrency).map(function (k) { return byCurrency[k]; });
    totals.sort(function (a, c) { return a.currency < c.currency ? -1 : a.currency > c.currency ? 1 : 0; });
    return {
      from:     win.from,
      to:       win.to,
      carrier:  carrier || null,
      by_broker: rows,
      totals:    totals,
    };
  }

  // ---- split shipments (order-detail planner) -------------------------
  //
  // Splits one order into N parcels: ship some lines now, the rest later.
  // The console uses the `manual` strategy — the operator picks which
  // line + qty goes in each parcel via the order-detail form. planSplit
  // writes a `proposed` plan row (validated: every line_id belongs to the
  // order, the per-line qty sums to the order_line qty). executeSplit
  // walks the plan and writes one shipment per parcel via order-tracking,
  // flipping the plan to `executed`. The order FSM stays honest: shipments
  // accrue on the order while it sits in `fulfilling`; the operator marks
  // the order `shipped` via the existing transition only once every parcel
  // is out — partial fulfilment is the order staying `fulfilling` with
  // some-but-not-all shipments executed. Mounted only when both the split
  // primitive AND order-tracking are wired.
  if (splitShipments && orderTracking) {
    router.post("/admin/orders/:id/split/plan", _pageOrApi(false,
      W("order.split.plan", async function (req, res) {
        var body = req.body || {};
        var plan;
        try {
          plan = await splitShipments.planSplit({
            order_id:   req.params.id,
            strategy:   "manual",
            manualPlan: _parseManualSplitPlan(body),
          });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 201, plan);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        try {
          await splitShipments.planSplit({
            order_id:   id,
            strategy:   "manual",
            manualPlan: _parseManualSplitPlan(req.body || {}),
          });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.split.plan", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/orders/" + enc + "?split=1");
      },
    ));

    router.post("/admin/orders/:id/split/:planId/execute", _pageOrApi(false,
      W("order.split.execute", async function (req, res) {
        var out;
        try {
          out = await splitShipments.executeSplit({
            order_id: req.params.id,
            plan:     { id: req.params.planId },
          });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        try {
          await splitShipments.executeSplit({
            order_id: id,
            plan:     { id: req.params.planId },
          });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.split.execute", outcome: "success", metadata: { id: id, plan_id: req.params.planId } });
        _redirect(res, "/admin/orders/" + enc + "?split=1");
      },
    ));

    router.post("/admin/orders/:id/split/:planId/cancel", _pageOrApi(false,
      W("order.split.cancel", async function (req, res) {
        var out;
        try {
          out = await splitShipments.cancelPlan(req.params.planId);
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        try {
          await splitShipments.cancelPlan(req.params.planId);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/orders/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.split.cancel", outcome: "success", metadata: { id: id, plan_id: req.params.planId } });
        _redirect(res, "/admin/orders/" + enc + "?split=1");
      },
    ));
  }

  // Read the manual-split form into the `[{ lines: [{ line_id, qty }] }]`
  // shape the split primitive validates. The browser form posts parcel
  // assignment as `parcel_<line_id>` (which parcel index this line goes
  // to) + `qty_<line_id>` (how much). Lines with a blank/zero parcel are
  // left for the implicit remainder parcel; the primitive's conservation
  // check refuses a plan that doesn't consume every order_line qty, so a
  // forgotten line surfaces loudly rather than silently dropping product.
  // Defensive request-shape reader — returns the array for the primitive
  // to validate; an empty selection yields an empty array (the primitive
  // throws "manualPlan must be a non-empty array" → 400).
  function _parseManualSplitPlan(body) {
    // JSON API path: a structured `manualPlan` array passes straight
    // through (the primitive validates every field).
    if (Array.isArray(body.manualPlan)) return body.manualPlan;
    // Browser form path: group `parcel_<lineId>` + `qty_<lineId>` pairs.
    var byParcel = Object.create(null);
    var order_index = [];
    var keys = Object.keys(body);
    for (var i = 0; i < keys.length; i += 1) {
      var k = keys[i];
      if (k.indexOf("parcel_") !== 0) continue;
      var lineId = k.slice("parcel_".length);
      var parcelRaw = body[k];
      if (parcelRaw == null || String(parcelRaw).trim() === "") continue;
      var parcelKey = String(parcelRaw).trim();
      var qtyRaw = body["qty_" + lineId];
      // Strict integer for the per-line qty — /^\d+$/, never parseInt.
      if (typeof qtyRaw !== "string" && typeof qtyRaw !== "number") continue;
      var qtyStr = String(qtyRaw).trim();
      if (!/^\d+$/.test(qtyStr)) {
        throw new TypeError("admin.order.split: qty for line " + lineId + " must be a non-negative integer");
      }
      var qty = Number(qtyStr);
      if (qty === 0) continue;  // zero qty = not in this parcel
      if (!byParcel[parcelKey]) { byParcel[parcelKey] = []; order_index.push(parcelKey); }
      byParcel[parcelKey].push({ line_id: lineId, qty: qty });
    }
    return order_index.map(function (key) { return { lines: byParcel[key] }; });
  }

  // ---- pick lists (warehouse fulfillment worksheet) -------------------
  //
  // Consolidates N open orders into one aisle-sequenced picker route. The
  // console: list worksheets (filtered by location / status), generate a
  // new one (auto-select every paid/fulfilling order at a location, or a
  // pasted set of order ids), drill into a worksheet to confirm each line
  // as picked, mark the whole list complete (fans out one shipment per
  // parent order via order-tracking), cancel an in-flight list, and a
  // print-optimized worksheet (@media print) the picker carries to the
  // floor. Composes the pick-lists primitive; mounted only when wired.
  if (pickLists) {
    router.get("/admin/pick-lists", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var listOpts = _pickListFilter(url);
        _json(res, 200, { rows: await pickLists.listLists(listOpts) });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var listOpts, rows, notice = null;
        try {
          listOpts = _pickListFilter(url);
          rows = await pickLists.listLists(listOpts);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          notice = "Unknown filter — showing all pick lists.";
          rows = await pickLists.listLists({});
        }
        _sendHtml(res, 200, renderAdminPickLists({
          shop_name: deps.shop_name, nav_available: navAvailable,
          lists: rows,
          location: url && url.searchParams.get("location"),
          status: url && url.searchParams.get("status"),
          statuses: pickLists.LIST_STATUSES,
          sort_options: pickLists.SORT_BY_ENUM,
          created: url && url.searchParams.get("created"),
          notice: notice || ((url && url.searchParams.get("err")) ? "That pick list couldn't be created — check the location and any order ids." : null),
        }));
      },
    ));

    router.post("/admin/pick-lists", _pageOrApi(false,
      W("pick_list.generate", async function (req, res) {
        var list;
        try { list = await pickLists.generateList(_pickListGenerateInput(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 201, list);
        return { id: list.id };
      }),
      async function (req, res) {
        var list;
        try { list = await pickLists.generateList(_pickListGenerateInput(req.body || {})); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/pick-lists?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".pick_list.generate", outcome: "success", metadata: { id: list.id } });
        _redirect(res, "/admin/pick-lists/" + encodeURIComponent(list.id) + "?created=1");
      },
    ));

    router.get("/admin/pick-lists/:id", _pageOrApi(true,
      R(async function (req, res) {
        var list;
        try { list = await pickLists.getList(req.params.id); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!list) return _problem(res, 404, "pick-list-not-found");
        _json(res, 200, list);
      }),
      async function (req, res) {
        var list = null;
        try { list = await pickLists.getList(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; list = null; }
        if (!list) return _sendHtml(res, 404, renderAdminPickLists({
          shop_name: deps.shop_name, nav_available: navAvailable, lists: [],
          statuses: pickLists.LIST_STATUSES, sort_options: pickLists.SORT_BY_ENUM,
          notice: "Pick list not found.",
        }));
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var discrepancies = await pickLists.discrepanciesFor(list.id);
        _sendHtml(res, 200, renderAdminPickList({
          shop_name: deps.shop_name, nav_available: navAvailable,
          list: list, discrepancies: discrepancies,
          created: url && url.searchParams.get("created"),
          picked: url && url.searchParams.get("picked"),
          completed: url && url.searchParams.get("completed"),
          cancelled: url && url.searchParams.get("cancelled"),
          notice: (url && url.searchParams.get("err")) ? "That action couldn't be completed for this pick list." : null,
        }));
      },
    ));

    // Print-optimized worksheet — the picker carries this to the floor.
    // GET-only HTML; no JSON variant (it's a document). A bad / missing id
    // 404s rather than 500-ing.
    router.get("/admin/pick-lists/:id/print", R(async function (req, res) {
      var list = null;
      try { list = await pickLists.getList(req.params.id); }
      catch (e) { if (!(e instanceof TypeError)) throw e; list = null; }
      if (!list) return _sendHtml(res, 404, "<!doctype html><meta charset=\"utf-8\"><title>Not found</title><p>Pick list not found.</p>");
      _sendHtml(res, 200, renderPickListPrint({ shop_name: deps.shop_name, list: list }));
    }));

    router.post("/admin/pick-lists/:id/lines/:lineId/pick", _pageOrApi(false,
      W("pick_list.confirm_line", async function (req, res) {
        var body = req.body || {};
        var out;
        try {
          out = await pickLists.confirmLine({
            list_id:         req.params.id,
            line_id:         req.params.lineId,
            picker_id:       body.picker_id,
            actual_quantity: _optStrictNonNegInt(body.actual_quantity, "actual_quantity"),
          });
        } catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var body = req.body || {};
        try {
          await pickLists.confirmLine({
            list_id:         id,
            line_id:         req.params.lineId,
            picker_id:       (body.picker_id && body.picker_id.length) ? body.picker_id : "console",
            actual_quantity: _optStrictNonNegInt(body.actual_quantity, "actual_quantity"),
          });
        } catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/pick-lists/" + enc + "?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".pick_list.confirm_line", outcome: "success", metadata: { id: id, line_id: req.params.lineId } });
        _redirect(res, "/admin/pick-lists/" + enc + "?picked=1");
      },
    ));

    router.post("/admin/pick-lists/:id/complete", _pageOrApi(false,
      W("pick_list.complete", async function (req, res) {
        var out;
        try { out = await pickLists.markListComplete({ list_id: req.params.id }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        try { await pickLists.markListComplete({ list_id: id }); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/pick-lists/" + enc + "?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".pick_list.complete", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/pick-lists/" + enc + "?completed=1");
      },
    ));

    router.post("/admin/pick-lists/:id/cancel", _pageOrApi(false,
      W("pick_list.cancel", async function (req, res) {
        var body = req.body || {};
        var out;
        try { out = await pickLists.cancelList({ list_id: req.params.id, reason: body.reason }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, out);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var body = req.body || {};
        try {
          await pickLists.cancelList({ list_id: id, reason: (body.reason && body.reason.length) ? body.reason : "Cancelled from console" });
        } catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/pick-lists/" + enc + "?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".pick_list.cancel", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/pick-lists/" + enc + "?cancelled=1");
      },
    ));
  }

  // Map the pick-list list filter query (?location= / ?status=) to the
  // primitive's listLists opts. A blank value is omitted (no filter); a
  // present-but-invalid value reaches the primitive, which throws a
  // TypeError the route turns into "showing all". Defensive reader.
  function _pickListFilter(url) {
    var out = {};
    var loc = url && url.searchParams.get("location");
    var st  = url && url.searchParams.get("status");
    if (loc && loc.length) out.location_code = loc;
    if (st && st.length)   out.status = st;
    return out;
  }

  // Build the generateList input from the create form. `location_code`
  // is required (the primitive throws if it's malformed). `order_ids` is
  // an optional newline/comma-separated paste — when blank, the primitive
  // auto-selects every eligible order at the location. `sort_by` +
  // `max_lines` are optional. Strict integer for max_lines (never
  // parseInt). Defensive request-shape reader.
  function _pickListGenerateInput(body) {
    var input = { location_code: typeof body.location_code === "string" ? body.location_code.trim() : body.location_code };
    if (body.sort_by != null && String(body.sort_by).length) input.sort_by = body.sort_by;
    if (body.max_lines != null && String(body.max_lines).trim().length) {
      input.max_lines = _strictPosIntField(body.max_lines, "max_lines");
    }
    if (Array.isArray(body.order_ids)) {
      input.order_ids = body.order_ids;
    } else if (typeof body.order_ids === "string" && body.order_ids.trim().length) {
      var ids = body.order_ids.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (ids.length) input.order_ids = ids;
    }
    return input;
  }

  // Optional strict non-negative integer from a form field — returns
  // undefined when the field is blank/absent (the primitive then defaults
  // it), throws TypeError on garbage. Used for the optional
  // actual_quantity on a pick confirm.
  function _optStrictNonNegInt(value, label) {
    if (value == null || (typeof value === "string" && value.trim() === "")) return undefined;
    return _strictNonNegIntField(value, label);
  }

  router.post("/admin/orders/:id/transition", _pageOrApi(false,
    W("order.transition", async function (req, res) {
      var body = req.body || {};
      if (!body.event) throw new TypeError("admin.order.transition: body.event required");
      var o = await order.transition(req.params.id, body.event, { reason: body.reason, metadata: body.metadata });
      _json(res, 200, o);
      return o;
    }),
    async function (req, res) {
      // Browser form → run the transition, then redirect back to the
      // detail (PRG). A bad id (TypeError) or an FSM refusal (the move
      // isn't legal from this status) surfaces as a notice, not a 500;
      // any other failure propagates.
      var id = req.params.id;
      var event = (req.body || {}).event;
      if (!event) return _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?err=1");
      try {
        await order.transition(id, event, { reason: "admin:console" });
      } catch (e) {
        if (e instanceof TypeError || (e && e.code && /FSM|TRANSITION|GUARD/i.test(e.code))) {
          return _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?err=1");
        }
        throw e;
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.transition", outcome: "success", metadata: { id: id, event: event } });
      _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?moved=1");
    },
  ));

  // ---- customers (read-only) ------------------------------------------

  // Operator-facing customer roster, newest first. READ-ONLY — no create /
  // edit / delete (the storefront owns account mutation via passkey / OIDC
  // ceremonies). The raw email is never stored, so the table shows the
  // display name, a short id, the join date, the sign-in method (passkey
  // count + linked OAuth providers), and the order count. Order counts +
  // sign-in methods are resolved with bounded aggregate queries over the
  // page's ids — no per-row N+1. Endpoint omitted when no customers
  // primitive is wired.
  if (customers) {
    router.get("/admin/customers", _pageOrApi(true,
      R(async function (req, res) {
        var url    = req.url ? new URL(req.url, "http://localhost") : null;
        var cursor = url && url.searchParams.get("cursor");
        var limitS = url && url.searchParams.get("limit");
        var limit  = limitS == null ? 50 : parseInt(limitS, 10);
        var page = await customers.list({ cursor: cursor || undefined, limit: limit });
        _json(res, 200, page);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var cursor = url && url.searchParams.get("cursor");
        var page = await customers.list({ cursor: cursor || undefined, limit: 100 });
        var rows = page.rows || [];
        var ids = rows.map(function (c) { return c.id; });
        // One grouped query for order counts, one IN-bounded pair for
        // sign-in methods — never a trip per row.
        var counts  = await order.countsByCustomer(ids);
        var methods = await customers.signInMethodsByCustomer(ids);
        _sendHtml(res, 200, renderAdminCustomers({
          shop_name: deps.shop_name, nav_available: navAvailable,
          customers: rows,
          order_counts:  counts,
          passkey_counts: methods.passkeys,
          oauth_providers: methods.oauth,
          next_cursor: page.next_cursor || null,
        }));
      },
    ));

    // ---- customer detail ----------------------------------------------
    // The per-customer operator screen. The roster (above) is read-only by
    // design — the storefront owns account mutation via the passkey / OIDC
    // ceremonies — so this screen READS the customer's identity fields +
    // recent orders, and WRITES only the operator-managed satellites:
    // store-credit (an audited wallet), CRM notes, and (read-only) segment
    // membership. It does NOT edit the customer profile: the only mutable
    // identity field is display_name, and the roster's stated design intent
    // is read-only identity, so the operator-managed satellites are the
    // write surface here. Each satellite panel renders only when its
    // primitive is wired; an unwired one degrades to a "not wired" notice
    // rather than vanishing.

    // Free-text reason gate for a store-credit adjustment. A store-credit
    // grant / deduct is a money-adjacent action, so the reason is MANDATORY
    // — it rides into the ledger row's source_ref (grant) / reason (deduct)
    // column so every balance change is attributed. Throws a TypeError
    // (→ 400) on a missing / blank / over-long / control-byte reason so the
    // form surfaces a clean notice and writes nothing. 128 chars matches the
    // primitive's source_ref cap (storeCredit MAX_SOURCE_REF_LEN); the
    // primitive re-validates, so this gate fails fast with operator-facing
    // text rather than relying on the deeper throw.
    var STORE_CREDIT_REASON_MAX = 128;
    function _storeCreditReason(raw) {
      if (raw == null) throw new TypeError("admin: a reason is required for a store-credit adjustment");
      var s = String(raw).trim();
      if (!s.length) throw new TypeError("admin: a reason is required for a store-credit adjustment");
      if (s.length > STORE_CREDIT_REASON_MAX) throw new TypeError("admin: reason must be <= " + STORE_CREDIT_REASON_MAX + " chars");
      if (/[\x00-\x1f\x7f]/.test(s)) throw new TypeError("admin: reason must not contain control bytes");
      return s;
    }
    // Coerce the grant/deduct form into a positive minor-unit amount + a
    // direction. `direction` is "grant" or "deduct"; `amount_minor` is a
    // positive integer (the strict reader refuses "", floats, "12abc").
    function _storeCreditDirection(body) {
      var dir = typeof body.direction === "string" ? body.direction.trim() : "";
      if (dir !== "grant" && dir !== "deduct") {
        throw new TypeError("admin: direction must be 'grant' or 'deduct'");
      }
      return dir;
    }

    // Best-effort hydrate of a customer's satellites for the detail render.
    // A satellite whose primitive isn't wired (or whose table isn't migrated
    // on a given deploy) degrades that panel to a notice rather than 500-ing
    // the page — same discipline as the order-detail tracking panel.
    async function _customerDetailModel(customer, flags) {
      flags = flags || {};
      var currency = await _defaultCurrency();

      var recentOrders = [];
      try {
        var ordersPage = await order.listForCustomer(customer.id, { limit: 10 });
        recentOrders = ordersPage.rows || [];
      } catch (_e) { recentOrders = []; }

      var creditBalanceMinor = null;
      var creditHistory = [];
      if (storeCredit) {
        try { creditBalanceMinor = (await storeCredit.balance(customer.id)).balance_minor; }
        catch (_e) { creditBalanceMinor = null; }
        try { creditHistory = (await storeCredit.history({ customer_id: customer.id, limit: 10 })).rows || []; }
        catch (_e) { creditHistory = []; }
      }

      var loyaltyInfo = null;
      if (deps.loyalty) {
        try { loyaltyInfo = await deps.loyalty.balance(customer.id); }
        catch (_e) { loyaltyInfo = null; }
      }

      var notes = [];
      if (customerNotes) {
        try { notes = (await customerNotes.notesForCustomer({ customer_id: customer.id, limit: 20 })).rows || []; }
        catch (_e) { notes = []; }
      }

      var segments = null;
      if (customerSegments) {
        try { segments = await customerSegments.segmentsForCustomer(customer.id); }
        catch (_e) { segments = []; }
      }

      return Object.assign({
        shop_name:      deps.shop_name,
        nav_available:  navAvailable,
        customer:       customer,
        currency:       currency,
        recent_orders:  recentOrders,
        can_store_credit:    !!storeCredit,
        store_credit_minor:  creditBalanceMinor,
        store_credit_history: creditHistory,
        loyalty:        loyaltyInfo,
        loyalty_link:   !!deps.loyalty,
        can_notes:      !!customerNotes,
        notes:          notes,
        can_segments:   !!customerSegments,
        segments:       segments,
      }, flags);
    }

    // Resolve the :id to a customer record. A malformed id throws inside the
    // defensive id reader (customers.get) — caught and treated as "no such
    // customer" so the route renders a clean 404, never a 500. An unknown
    // (well-formed) id returns null → the same 404.
    async function _resolveCustomer(id) {
      try { return await customers.get(id); }
      catch (e) { if (e instanceof TypeError) return null; throw e; }
    }

    router.get("/admin/customers/:id", _pageOrApi(true,
      R(async function (req, res) {
        var c = await _resolveCustomer(req.params.id);
        if (!c) return _problem(res, 404, "customer-not-found");
        // Bearer JSON: the customer record + its satellites (no HTML).
        var model = await _customerDetailModel(c, {});
        _json(res, 200, {
          customer:             c,
          recent_orders:        model.recent_orders,
          store_credit_minor:   model.store_credit_minor,
          store_credit_history: model.store_credit_history,
          loyalty:              model.loyalty,
          notes:                model.notes,
          segments:             model.segments,
        });
      }),
      async function (req, res) {
        var c = await _resolveCustomer(req.params.id);
        if (!c) return _sendHtml(res, 404, renderAdminCustomers({
          shop_name: deps.shop_name, nav_available: navAvailable, customers: [], notice: "Customer not found.",
        }));
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var flags = {
          saved:        url && url.searchParams.get("saved"),
          credit_notice: url && url.searchParams.get("credit_err") ? url.searchParams.get("credit_err") : null,
          note_notice:   url && url.searchParams.get("note_err") ? url.searchParams.get("note_err") : null,
        };
        _sendHtml(res, 200, renderAdminCustomerDetail(await _customerDetailModel(c, flags)));
      },
    ));

    // ---- store-credit adjustment (grant / deduct) ----------------------
    // Scoped to the :id customer — the customer the adjustment targets is the
    // path id, never a form field, so an operator can't grant credit to a
    // different customer than the screen they're on. A grant composes
    // storeCredit.credit (source goodwill / source_ref reason); a deduct
    // composes storeCredit.expire (the operator-initiated burn that carries a
    // required reason). Over-deduction is refused at the route as a clean 409
    // BEFORE any write — the expire primitive caps silently at the balance,
    // so the route enforces the no-overdraft contract by reading the balance
    // first (nothing is written when the deduction exceeds the balance).
    if (storeCredit) {
      router.post("/admin/customers/:id/store-credit", _pageOrApi(false,
        W("customer.store_credit.adjust", async function (req, res) {
          var c = await _resolveCustomer(req.params.id);
          if (!c) return _problem(res, 404, "customer-not-found");
          var body = req.body || {};
          var dir, amount, reason;
          try {
            dir    = _storeCreditDirection(body);
            amount = _strictMinorInt(body.amount_minor, "admin", "amount_minor");
            if (amount <= 0) throw new TypeError("admin: amount_minor must be a positive integer (minor units)");
            reason = _storeCreditReason(body.reason);
          } catch (e) {
            if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
            throw e;
          }
          var result;
          if (dir === "grant") {
            result = await storeCredit.credit({
              customer_id: c.id, amount_minor: amount, source: "goodwill", source_ref: reason,
            });
          } else {
            var bal = (await storeCredit.balance(c.id)).balance_minor;
            if (amount > bal) {
              return _problem(res, 409, "insufficient-balance", "Deduction exceeds the available store-credit balance.");
            }
            result = await storeCredit.expire({ customer_id: c.id, amount_minor: amount, reason: reason });
          }
          _json(res, 200, result);
          return { id: c.id };
        }),
        async function (req, res) {
          var c = await _resolveCustomer(req.params.id);
          if (!c) return _sendHtml(res, 404, renderAdminCustomers({
            shop_name: deps.shop_name, nav_available: navAvailable, customers: [], notice: "Customer not found.",
          }));
          var body = req.body || {};
          var dir, amount, reason;
          try {
            dir    = _storeCreditDirection(body);
            amount = _strictMinorInt(body.amount_minor, "admin", "amount_minor");
            if (amount <= 0) throw new TypeError("admin: amount_minor must be a positive integer (minor units)");
            reason = _storeCreditReason(body.reason);
          } catch (e) {
            var n = _safeNotice(e, "customer.store_credit.adjust");
            return _redirect(res, "/admin/customers/" + encodeURIComponent(c.id) +
              "?credit_err=" + encodeURIComponent(n.message.replace(/^admin[.:]\s*/, "")));
          }
          if (dir === "deduct") {
            var bal = (await storeCredit.balance(c.id)).balance_minor;
            if (amount > bal) {
              return _redirect(res, "/admin/customers/" + encodeURIComponent(c.id) +
                "?credit_err=" + encodeURIComponent("That deduction exceeds the available balance."));
            }
          }
          try {
            if (dir === "grant") {
              await storeCredit.credit({ customer_id: c.id, amount_minor: amount, source: "goodwill", source_ref: reason });
            } else {
              await storeCredit.expire({ customer_id: c.id, amount_minor: amount, reason: reason });
            }
          } catch (e) {
            var n2 = _safeNotice(e, "customer.store_credit.adjust");
            return _redirect(res, "/admin/customers/" + encodeURIComponent(c.id) +
              "?credit_err=" + encodeURIComponent(n2.message.replace(/^(?:admin|storeCredit)[.:]\s*/, "")));
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".customer.store_credit.adjust", outcome: "success", metadata: { id: c.id, direction: dir } });
          _redirect(res, "/admin/customers/" + encodeURIComponent(c.id) + "?saved=1");
        },
      ));
    }

    // ---- customer notes (add) ------------------------------------------
    // Scoped to the :id customer — the note attaches to the path customer.
    // Composes customerNotes.addNote (the body is required + length-capped by
    // the primitive). The author is stamped "operator" — the console never
    // adds a system note. Bad input (empty / over-long body, bad kind) is a
    // clean 4xx with nothing written.
    if (customerNotes) {
      router.post("/admin/customers/:id/notes", _pageOrApi(false,
        W("customer.note.add", async function (req, res) {
          var c = await _resolveCustomer(req.params.id);
          if (!c) return _problem(res, 404, "customer-not-found");
          var body = req.body || {};
          var note;
          try {
            note = await customerNotes.addNote({
              customer_id: c.id, author: "operator",
              body: body.body, kind: (body.kind != null && body.kind !== "") ? body.kind : undefined,
            });
          } catch (e) {
            if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
            throw e;
          }
          _json(res, 201, note);
          return { id: c.id };
        }),
        async function (req, res) {
          var c = await _resolveCustomer(req.params.id);
          if (!c) return _sendHtml(res, 404, renderAdminCustomers({
            shop_name: deps.shop_name, nav_available: navAvailable, customers: [], notice: "Customer not found.",
          }));
          var body = req.body || {};
          try {
            await customerNotes.addNote({
              customer_id: c.id, author: "operator",
              body: body.body, kind: (body.kind != null && body.kind !== "") ? body.kind : undefined,
            });
          } catch (e) {
            var n = _safeNotice(e, "customer.note.add");
            return _redirect(res, "/admin/customers/" + encodeURIComponent(c.id) +
              "?note_err=" + encodeURIComponent(n.message.replace(/^(?:admin|customerNotes)[.:]\s*/, "")));
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".customer.note.add", outcome: "success", metadata: { id: c.id } });
          _redirect(res, "/admin/customers/" + encodeURIComponent(c.id) + "?saved=1");
        },
      ));
    }
  }

  // ---- refunds --------------------------------------------------------

  if (payment) {
    // Issue the actual payment-provider refund, then advance the order
    // FSM. Shared by the JSON API and the browser console so a console
    // "Refund" moves the money first (never a bare state change — that
    // would mark an order refunded with the customer never paid back).
    async function _refundOrder(o, body) {
      var refundIdempotencyKey = "refund:" + o.id + ":" + (body.idempotency_suffix || b.uuid.v7());
      var refund = await payment.refund({
        payment_intent: o.payment_intent_id,
        amount_minor:   body.amount_minor || undefined,
        reason:         body.reason || undefined,
        metadata:       { order_id: o.id },
      }, refundIdempotencyKey);
      try {
        await order.transition(o.id, "refund", {
          reason:   "admin:refund:" + (body.reason || "requested_by_customer"),
          metadata: { stripe_refund_id: refund.id, amount_minor: refund.amount },
        });
      } catch (_e) { /* refund succeeded at the provider; transition refusal logged, surfaced via re-fetch */ }
      return { refund: refund, order: await order.get(o.id) };
    }

    // Browser confirmation interstitial for the full refund — it moves
    // money via the provider and advances the FSM, so the console makes
    // the operator confirm (the CSP forbids a client confirm() dialog).
    // Bearer clients never reach here; they keep POSTing /refund directly.
    router.post("/admin/orders/:id/refund/confirm", _pageOrApi(false,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/orders/:id/refund directly for the JSON API");
      }),
      async function (req, res) {
        var id = req.params.id;
        var o;
        try { o = await order.get(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; o = null; }
        if (!o || !o.payment_intent_id) {
          return _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?err=1");
        }
        var amount = pricing.format(o.grand_total_minor, o.currency);
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "orders",
          heading: "Refund order " + o.id.slice(0, 8) + "?",
          consequence: "This issues a full refund of " + amount + " through the payment provider and cannot be undone.",
          detail: "The provider refund runs first; only if it succeeds does the order move to a refunded state.",
          action: "/admin/orders/" + _htmlEscape(o.id) + "/refund",
          confirm_label: "Refund " + amount,
          cancel_href: "/admin/orders/" + encodeURIComponent(id),
        }));
      },
    ));

    router.post("/admin/orders/:id/refund", _pageOrApi(false,
      W("order.refund", async function (req, res) {
        var o = await order.get(req.params.id);
        if (!o) return _problem(res, 404, "order-not-found");
        if (!o.payment_intent_id) return _problem(res, 422, "no-payment-intent", "Order has no linked payment intent");
        var result;
        try {
          result = await _refundOrder(o, req.body || {});
        } catch (e) {
          // allow:admin-5xx-echoes-raw-error-message — 502 surfaces the PAYMENT PROVIDER's refund-failure reason (e.g. "charge already refunded"), an operator-actionable upstream message, not a server/storage internal.
          return _problem(res, 502, "stripe-refund-failed", (e && e.message) || String(e));
        }
        _json(res, 200, result);
        return { id: o.id };
      }),
      async function (req, res) {
        // Browser console: full refund (partial refunds stay on the JSON
        // API via amount_minor), then PRG back to the detail. A bad id or
        // missing payment intent surfaces as a notice, never a 500.
        var id = req.params.id;
        var o;
        try { o = await order.get(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; o = null; }
        if (!o || !o.payment_intent_id) {
          return _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?err=1");
        }
        try {
          await _refundOrder(o, { reason: "requested_by_customer" });
        } catch (_e) {
          // Provider refund failed — the order is untouched (the FSM
          // transition only runs after a successful refund).
          return _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.refund", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/orders/" + encodeURIComponent(id) + "?moved=1");
      },
    ));
  }

  // ---- reviews (moderation) -------------------------------------------

  // Operator-side review moderation. The queue lists reviews across all
  // products in one status (defaults to `pending`); publish / reject
  // drive the same transitions the storefront submit path leaves in
  // `pending`. Endpoints are omitted entirely when no reviews primitive
  // is wired.
  if (reviews) {
    router.get("/admin/reviews", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || "pending";
        var cursor = url && url.searchParams.get("cursor");
        var limitS = url && url.searchParams.get("limit");
        var limit  = limitS == null ? undefined : parseInt(limitS, 10);
        var page = await reviews.listByStatus(status, { cursor: cursor || undefined, limit: limit });
        _json(res, 200, page);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || "pending";
        var notice = null, rows = [];
        // A bad ?status= raises a TypeError — fall back to pending.
        try {
          rows = (await reviews.listByStatus(status, { limit: 100 })).rows || [];
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          status = "pending"; notice = "Unknown status filter — showing pending reviews.";
          rows = (await reviews.listByStatus("pending", { limit: 100 })).rows || [];
        }
        // A failed publish/reject redirects back with ?err=1 — surface it
        // so a no-op (e.g. unknown id / missing reason) isn't mistaken for
        // success, the way orders/returns do.
        if (!notice && url && url.searchParams.get("err")) {
          notice = "That action couldn't be completed for the review.";
        }
        _sendHtml(res, 200, renderAdminReviews({
          shop_name: deps.shop_name, nav_available: navAvailable,
          reviews: rows, status: status, notice: notice,
          moved: url && url.searchParams.get("moved"),
        }));
      },
    ));

    router.get("/admin/reviews/:id", R(async function (req, res) {
      var rev = await reviews.get(req.params.id);
      if (!rev) return _problem(res, 404, "review-not-found");
      _json(res, 200, rev);
    }));

    // Publish / reject content-negotiate: bearer → JSON (unchanged);
    // browser form → moderate, then PRG back to the queue (a not-found id
    // is a no-op notice, never a 500).
    function _reviewModerate(jsonHandler, auditEvent, opFn) {
      return _pageOrApi(false, jsonHandler, async function (req, res) {
        var id = req.params.id;
        try { await opFn(id, req.body || {}); }
        catch (e) {
          if (e instanceof TypeError || (e && e.code === "REVIEW_NOT_FOUND")) {
            return _redirect(res, "/admin/reviews?err=1");
          }
          throw e;
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + "." + auditEvent, outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/reviews?moved=1");
      });
    }

    router.post("/admin/reviews/:id/publish", _reviewModerate(
      W("review.publish", async function (req, res) {
        var rev;
        try {
          rev = await reviews.publish(req.params.id);
        } catch (e) {
          if (e && e.code === "REVIEW_NOT_FOUND") return _problem(res, 404, "review-not-found");
          throw e;
        }
        _json(res, 200, rev);
        return rev;
      }),
      "review.publish",
      function (id) { return reviews.publish(id); },
    ));

    router.post("/admin/reviews/:id/reject", _reviewModerate(
      W("review.reject", async function (req, res) {
        var body = req.body || {};
        var rev;
        try {
          rev = await reviews.reject(req.params.id, body.reason);
        } catch (e) {
          if (e && e.code === "REVIEW_NOT_FOUND") return _problem(res, 404, "review-not-found");
          throw e;
        }
        _json(res, 200, rev);
        return rev;
      }),
      "review.reject",
      function (id, body) { return reviews.reject(id, body.reason || undefined); },
    ));
  }

  // ---- product Q&A (moderation) ---------------------------------------

  // Operator-side Q&A moderation. The queue lists questions across all
  // products in one status (defaults to `pending`); the per-question
  // detail page shows the thread and lets the operator approve / reject
  // the question, post the authoritative answer, approve / reject /
  // pin individual answers. The storefront leaves new questions in
  // `pending`; operator-posted answers land `pending` and are approved
  // from the same page. Endpoints are omitted entirely when no productQa
  // primitive is wired.
  if (productQa) {
    // A guardUuid / shape rejection is a TypeError; a not-found row and
    // a refused FSM transition carry a code. Map all to client errors so
    // a bad id / stale action is a notice, never a 500.
    function _qaClientError(e) {
      if (!e) return null;
      if (e instanceof TypeError) return { status: 400, slug: "bad-request" };
      if (e.code === "PRODUCT_QA_QUESTION_NOT_FOUND") return { status: 404, slug: "question-not-found" };
      if (e.code === "PRODUCT_QA_ANSWER_NOT_FOUND")   return { status: 404, slug: "answer-not-found" };
      if (e.code === "PRODUCT_QA_TRANSITION_REFUSED") return { status: 409, slug: "transition-refused" };
      if (e.code === "PRODUCT_QA_PIN_REFUSED")        return { status: 409, slug: "pin-refused" };
      return null;
    }

    router.get("/admin/questions", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || "pending";
        var limitS = url && url.searchParams.get("limit");
        var limit  = limitS == null ? undefined : parseInt(limitS, 10);
        var rows = await productQa.listQuestionsByStatus(status, { limit: limit });
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || "pending";
        var notice = null, rows = [];
        // A bad ?status= raises a TypeError — fall back to pending.
        try {
          rows = await productQa.listQuestionsByStatus(status, { limit: 100 });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          status = "pending"; notice = "Unknown status filter — showing pending questions.";
          rows = await productQa.listQuestionsByStatus("pending", { limit: 100 });
        }
        _sendHtml(res, 200, renderAdminQuestions({
          shop_name: deps.shop_name, nav_available: navAvailable,
          questions: rows, status: status, notice: notice,
          moved: url && url.searchParams.get("moved"),
        }));
      },
    ));

    router.get("/admin/questions/:id", _pageOrApi(true,
      R(async function (req, res) {
        var q;
        try { q = await productQa.getQuestion(req.params.id); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "question-not-found"); throw e; }
        if (!q) return _problem(res, 404, "question-not-found");
        q.answers = await productQa.listAnswersForQuestion(q.id, { limit: 200 });
        _json(res, 200, q);
      }),
      async function (req, res) {
        var q;
        try { q = await productQa.getQuestion(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; q = null; }
        if (!q) return _sendHtml(res, 404, renderAdminQuestions({
          shop_name: deps.shop_name, nav_available: navAvailable,
          questions: [], status: "pending", notice: "Question not found.",
        }));
        // Show every answer regardless of status so the operator can
        // moderate pending/rejected answers, not just approved ones.
        var answers = await productQa.listAnswersForQuestion(q.id, { limit: 200 });
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _sendHtml(res, 200, renderAdminQuestion({
          shop_name:   deps.shop_name, nav_available: navAvailable,
          question:    q, answers: answers,
          moved:       url && url.searchParams.get("moved"),
          notice:      url && url.searchParams.get("err") ? "That action couldn't be completed." : null,
        }));
      },
    ));

    // A Q&A action: run `opFn(id, body)`, then PRG. A bad id / shape /
    // FSM refusal becomes a notice on the queue (question-level) or the
    // detail (answer-level), never a 500; anything else propagates.
    function _qaQuestionAction(jsonHandler, auditEvent, opFn) {
      return _pageOrApi(false, jsonHandler, async function (req, res) {
        var id = req.params.id;
        try { await opFn(id, req.body || {}); }
        catch (e) {
          if (_qaClientError(e)) return _redirect(res, "/admin/questions?err=1");
          throw e;
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + "." + auditEvent, outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/questions?moved=1");
      });
    }
    function _qaAnswerAction(jsonHandler, auditEvent, opFn, backFor) {
      return _pageOrApi(false, jsonHandler, async function (req, res) {
        var id = req.params.id;
        var back = backFor(req);
        try { await opFn(id, req.body || {}); }
        catch (e) {
          if (_qaClientError(e)) return _redirect(res, "/admin/questions/" + encodeURIComponent(back) + "?err=1");
          throw e;
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + "." + auditEvent, outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/questions/" + encodeURIComponent(back) + "?moved=1");
      });
    }

    router.post("/admin/questions/:id/approve", _qaQuestionAction(
      W("question.approve", async function (req, res) {
        var q;
        try { q = await productQa.approveQuestion(req.params.id); }
        catch (e) { var ce = _qaClientError(e); if (ce) return _problem(res, ce.status, ce.slug, e.message); throw e; }
        _json(res, 200, q); return q;
      }),
      "question.approve",
      function (id) { return productQa.approveQuestion(id); },
    ));

    router.post("/admin/questions/:id/reject", _qaQuestionAction(
      W("question.reject", async function (req, res) {
        var body = req.body || {};
        var q;
        try { q = await productQa.rejectQuestion(req.params.id, body.reason); }
        catch (e) { var ce = _qaClientError(e); if (ce) return _problem(res, ce.status, ce.slug, e.message); throw e; }
        _json(res, 200, q); return q;
      }),
      "question.reject",
      function (id, body) { return productQa.rejectQuestion(id, body.reason || undefined); },
    ));

    // Post the operator's authoritative answer to a question. The answer
    // lands `pending`; the operator approves it from the same detail page
    // (so the post + publish stay explicit, mirroring the question FSM).
    router.post("/admin/questions/:id/answer", _qaAnswerAction(
      W("question.answer", async function (req, res) {
        var body = req.body || {};
        var a;
        try {
          a = await productQa.submitAnswer({ question_id: req.params.id, author: "operator", body: body.body });
        } catch (e) { var ce = _qaClientError(e); if (ce) return _problem(res, ce.status, ce.slug, e.message); throw e; }
        _json(res, 201, a); return a;
      }),
      "question.answer",
      function (id, body) { return productQa.submitAnswer({ question_id: id, author: "operator", body: body.body }); },
      function (req) { return req.params.id; },
    ));

    router.post("/admin/answers/:id/approve", _qaAnswerAction(
      W("answer.approve", async function (req, res) {
        var a;
        try { a = await productQa.approveAnswer(req.params.id); }
        catch (e) { var ce = _qaClientError(e); if (ce) return _problem(res, ce.status, ce.slug, e.message); throw e; }
        _json(res, 200, a); return a;
      }),
      "answer.approve",
      function (id) { return productQa.approveAnswer(id); },
      function (req) { return (req.body || {}).question_id || ""; },
    ));

    router.post("/admin/answers/:id/reject", _qaAnswerAction(
      W("answer.reject", async function (req, res) {
        var body = req.body || {};
        var a;
        try { a = await productQa.rejectAnswer(req.params.id, body.reason); }
        catch (e) { var ce = _qaClientError(e); if (ce) return _problem(res, ce.status, ce.slug, e.message); throw e; }
        _json(res, 200, a); return a;
      }),
      "answer.reject",
      function (id, body) { return productQa.rejectAnswer(id, body.reason || undefined); },
      function (req) { return (req.body || {}).question_id || ""; },
    ));

    router.post("/admin/answers/:id/pin", _qaAnswerAction(
      W("answer.pin", async function (req, res) {
        var a;
        try { a = await productQa.pinAnswer(req.params.id); }
        catch (e) { var ce = _qaClientError(e); if (ce) return _problem(res, ce.status, ce.slug, e.message); throw e; }
        _json(res, 200, a); return a;
      }),
      "answer.pin",
      function (id) { return productQa.pinAnswer(id); },
      function (req) { return (req.body || {}).question_id || ""; },
    ));
  }

  // ---- returns (moderation) -------------------------------------------

  // Operator-side RMA moderation. The queue lists return
  // authorizations across all orders in one status (defaults to
  // `pending`); approve / received / refund / reject walk the same FSM
  // the customer-facing request path leaves in `pending`. A bad state
  // transition (e.g. refund-from-pending) and a malformed :id both
  // surface as client errors (4xx), never a 500. Endpoints are omitted
  // entirely when no returns primitive is wired.
  if (returns) {
    function _returnsClientError(e) {
      // A transition refused by the FSM or a not-found row is the
      // caller's problem, not the server's. `_currentStatus` raises a
      // not-found TypeError; `_assertTransition` raises an Error tagged
      // RMA_TRANSITION_REFUSED. Map both to 4xx. (Bad-shape input is a
      // plain TypeError, which the wrapper already maps to 400.)
      if (!e) return null;
      if (e.code === "RMA_NOT_FOUND") return { status: 404, slug: "return-not-found" };
      if (e.code === "RMA_TRANSITION_REFUSED") return { status: 409, slug: "return-transition-refused" };
      return null;
    }

    router.get("/admin/returns", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || "pending";
        var cursor = url && url.searchParams.get("cursor");
        var limitS = url && url.searchParams.get("limit");
        var limit  = limitS == null ? undefined : parseInt(limitS, 10);
        var page = await returns.listByStatus(status, { cursor: cursor || undefined, limit: limit });
        _json(res, 200, page);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || "pending";
        var notice = null, rows = [];
        // A bad ?status= (not one of the RMA states) raises a TypeError
        // from listByStatus — fall back to pending with a notice rather
        // than erroring the page.
        try {
          var page = await returns.listByStatus(status, { limit: 100 });
          rows = page.rows || [];
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          status = "pending"; notice = "Unknown status filter — showing pending returns.";
          rows = (await returns.listByStatus("pending", { limit: 100 })).rows || [];
        }
        _sendHtml(res, 200, renderAdminReturns({
          shop_name: deps.shop_name, nav_available: navAvailable, returns: rows, status: status, notice: notice,
        }));
      },
    ));

    router.get("/admin/returns/:id", _pageOrApi(true,
      R(async function (req, res) {
        var rma;
        try {
          rma = await returns.get(req.params.id);
        } catch (e) {
          // A non-UUID :id raises a guardUuid TypeError — surface it as a
          // 404 (the route is a defensive request-shape reader, never a
          // 500). Re-raise anything that isn't the bad-id shape so the
          // wrapper's generic handling applies.
          if (e instanceof TypeError) return _problem(res, 404, "return-not-found");
          throw e;
        }
        if (!rma) return _problem(res, 404, "return-not-found");
        _json(res, 200, rma);
      }),
      async function (req, res) {
        var rma;
        try { rma = await returns.get(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; rma = null; }
        if (!rma) return _sendHtml(res, 404, renderAdminReturns({
          shop_name: deps.shop_name, nav_available: navAvailable, returns: [], status: "pending", notice: "Return not found.",
        }));
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var rmaCtx = await _rmaProviderContext(rma);
        _sendHtml(res, 200, renderAdminReturn({
          shop_name:   deps.shop_name,
          nav_available: navAvailable,
          rma:         rma,
          transitions: returns.transitionsFrom(rma.status),
          // When a payment provider is wired AND the linked order has a
          // captured intent, the Refund action moves money through the
          // provider via a confirm interstitial. Absent either, it stays
          // record-only with a pointer to the order page for the money side.
          can_provider_refund: rmaCtx.canProviderRefund,
          moved:       url && url.searchParams.get("moved"),
          notice:      url && url.searchParams.get("err") ? "That action couldn't be completed for this return." : null,
        }));
      },
    ));

    // Resolve whether an RMA can be refunded through the payment provider:
    // the provider must be wired AND the linked order must carry a captured
    // payment intent. Returns the linked order too so the caller can issue
    // the refund without a second fetch. Best-effort — a bad/legacy order id
    // degrades to "record-only" rather than throwing.
    async function _rmaProviderContext(rma) {
      var ctx = { order: null, canProviderRefund: false };
      if (!payment || !rma || !rma.order_id) return ctx;
      try { ctx.order = await order.get(rma.order_id); }
      catch (_e) { ctx.order = null; }
      ctx.canProviderRefund = !!(ctx.order && ctx.order.payment_intent_id);
      return ctx;
    }

    // The browser side of an RMA action: run `opFn(id, body)`, then PRG
    // back to the detail. A bad id / shape (TypeError) or an FSM refusal /
    // not-found (mapped by _returnsClientError) becomes a notice on the
    // detail, never a 500; anything else propagates.
    function _returnAction(jsonHandler, auditEvent, opFn) {
      return _pageOrApi(false, jsonHandler, async function (req, res) {
        var id = req.params.id;
        try { await opFn(id, req.body || {}); }
        catch (e) {
          if (e instanceof TypeError || _returnsClientError(e)) {
            return _redirect(res, "/admin/returns/" + encodeURIComponent(id) + "?err=1");
          }
          throw e;
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + "." + auditEvent, outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/returns/" + encodeURIComponent(id) + "?moved=1");
      });
    }

    router.post("/admin/returns/:id/approve", _returnAction(
      W("return.approve", async function (req, res) {
        var body = req.body || {};
        var rma;
        try {
          rma = await returns.approve(req.params.id, {
            refund_amount_minor: body.refund_amount_minor,
            refund_currency:     body.refund_currency,
            operator_notes:      body.operator_notes,
          });
        } catch (e) {
          var ce = _returnsClientError(e);
          if (ce) return _problem(res, ce.status, ce.slug, e.message);
          throw e;
        }
        _json(res, 200, rma);
        return rma;
      }),
      "return.approve",
      function (id, body) {
        // Browser form fields arrive as strings. Convert ONLY a clean
        // non-negative integer to a number; anything else (e.g. "4999usd",
        // "1e3", "") passes through unchanged so returns.approve's
        // _nonNegInt rejects it (→ notice via _returnAction) instead of
        // parseInt silently truncating garbage onto a money field.
        var raw = body.refund_amount_minor;
        var amount = (typeof raw === "string" && /^\d+$/.test(raw.trim())) ? Number(raw.trim()) : raw;
        return returns.approve(id, {
          refund_amount_minor: amount,
          refund_currency:     body.refund_currency || undefined,
          operator_notes:      body.operator_notes || undefined,
        });
      },
    ));

    router.post("/admin/returns/:id/received", _returnAction(
      W("return.received", async function (req, res) {
        var body = req.body || {};
        var rma;
        try {
          rma = await returns.markReceived(req.params.id, { operator_notes: body.operator_notes });
        } catch (e) {
          var ce = _returnsClientError(e);
          if (ce) return _problem(res, ce.status, ce.slug, e.message);
          throw e;
        }
        _json(res, 200, rma);
        return rma;
      }),
      "return.received",
      function (id, body) { return returns.markReceived(id, { operator_notes: body.operator_notes || undefined }); },
    ));

    // Issue the provider refund for an RMA (when a captured intent exists),
    // then record the RMA refund. The provider call runs FIRST — only if it
    // succeeds does the RMA move to refunded — so the queue never marks a
    // return refunded with the customer never paid back. The refund amount
    // is the RMA's approved refund_amount_minor (set at approve time);
    // absent one, the provider issues a full refund of the intent.
    async function _rmaProviderRefund(rma, order2, body) {
      var idem = "rma-refund:" + rma.id + ":" + (body.idempotency_suffix || b.uuid.v7());
      var refund = await payment.refund({
        payment_intent: order2.payment_intent_id,
        amount_minor:   (rma.refund_amount_minor != null && rma.refund_amount_minor > 0) ? rma.refund_amount_minor : undefined,
        reason:         "requested_by_customer",
        metadata:       { order_id: order2.id, rma_id: rma.id, rma_code: rma.rma_code || "" },
      }, idem);
      var updated = await returns.refund(rma.id, {
        operator_notes: (body.operator_notes && body.operator_notes.length)
          ? body.operator_notes
          : ("provider refund " + refund.id),
      });
      return { refund: refund, rma: updated };
    }

    // Browser confirmation interstitial for a provider-backed RMA refund —
    // it moves money + advances the RMA, so the console makes the operator
    // confirm (the CSP forbids a client confirm() dialog). Only meaningful
    // when a captured intent exists; otherwise it bounces to the detail.
    router.post("/admin/returns/:id/refund/confirm", _pageOrApi(false,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/returns/:id/refund directly for the JSON API");
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var rma;
        try { rma = await returns.get(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; rma = null; }
        if (!rma) return _redirect(res, "/admin/returns/" + enc + "?err=1");
        var rmaCtx = await _rmaProviderContext(rma);
        if (!rmaCtx.canProviderRefund) {
          // No captured intent — there's nothing to confirm; the detail's
          // record-only form handles it.
          return _redirect(res, "/admin/returns/" + enc + "?err=1");
        }
        var amount = (rma.refund_amount_minor != null && rma.refund_amount_minor > 0)
          ? pricing.format(rma.refund_amount_minor, rma.refund_currency || "USD")
          : pricing.format(rmaCtx.order.grand_total_minor, rmaCtx.order.currency);
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "returns",
          heading: "Refund return " + _htmlEscape(rma.rma_code || rma.id.slice(0, 8)) + "?",
          consequence: "This issues a refund of " + amount + " through the payment provider and cannot be undone.",
          detail: "The provider refund runs first; only if it succeeds does the return move to a refunded state.",
          action: "/admin/returns/" + _htmlEscape(rma.id) + "/refund",
          confirm_label: "Refund " + amount,
          cancel_href: "/admin/returns/" + enc,
        }));
      },
    ));

    router.post("/admin/returns/:id/refund", _pageOrApi(false,
      W("return.refund", async function (req, res) {
        var body = req.body || {};
        // A malformed rma id is a bad request, not a missing record — let
        // the guardUuid TypeError surface as a clean 400 via _wrap, matching
        // the approve/received/reject siblings. Only a well-formed id that
        // resolves to no row (rma === null) is a genuine 404.
        var rma = await returns.get(req.params.id);
        if (!rma) return _problem(res, 404, "return-not-found");
        var rmaCtx = await _rmaProviderContext(rma);
        // Provider-backed path: move money first, then record the RMA.
        if (rmaCtx.canProviderRefund) {
          var result;
          try { result = await _rmaProviderRefund(rma, rmaCtx.order, body); }
          catch (e) {
            var ce = _returnsClientError(e);
            if (ce) return _problem(res, ce.status, ce.slug, e.message);
            // allow:admin-5xx-echoes-raw-error-message — 502 surfaces the PAYMENT PROVIDER's refund-failure reason, an operator-actionable upstream message, not a server/storage internal.
            return _problem(res, 502, "provider-refund-failed", (e && e.message) || String(e));
          }
          _json(res, 200, result.rma);
          return result.rma;
        }
        // Record-only path (no captured intent / no provider wired).
        var recorded;
        try {
          recorded = await returns.refund(req.params.id, { operator_notes: body.operator_notes });
        } catch (e) {
          var ce2 = _returnsClientError(e);
          if (ce2) return _problem(res, ce2.status, ce2.slug, e.message);
          throw e;
        }
        _json(res, 200, recorded);
        return recorded;
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var rma;
        try { rma = await returns.get(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; rma = null; }
        if (!rma) return _redirect(res, "/admin/returns/" + enc + "?err=1");
        var rmaCtx = await _rmaProviderContext(rma);
        try {
          if (rmaCtx.canProviderRefund) {
            await _rmaProviderRefund(rma, rmaCtx.order, req.body || {});
          } else {
            await returns.refund(id, { operator_notes: (req.body || {}).operator_notes || undefined });
          }
        } catch (e) {
          if (e instanceof TypeError || _returnsClientError(e)) {
            return _redirect(res, "/admin/returns/" + enc + "?err=1");
          }
          // A provider-refund failure leaves the RMA untouched (the record
          // step only runs after a successful refund) — surface as a notice.
          return _redirect(res, "/admin/returns/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".return.refund", outcome: "success", metadata: { id: id, provider: rmaCtx.canProviderRefund } });
        _redirect(res, "/admin/returns/" + enc + "?moved=1");
      },
    ));

    router.post("/admin/returns/:id/reject", _returnAction(
      W("return.reject", async function (req, res) {
        var body = req.body || {};
        var rma;
        try {
          rma = await returns.reject(req.params.id, {
            rejected_reason: body.rejected_reason,
            operator_notes:  body.operator_notes,
          });
        } catch (e) {
          var ce = _returnsClientError(e);
          if (ce) return _problem(res, ce.status, ce.slug, e.message);
          throw e;
        }
        _json(res, 200, rma);
        return rma;
      }),
      "return.reject",
      function (id, body) { return returns.reject(id, { rejected_reason: body.rejected_reason, operator_notes: body.operator_notes || undefined }); },
    ));
  }

  // ---- config ---------------------------------------------------------

  var config = deps.config || null;
  if (config) {
    router.get("/admin/config", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var prefix = url && url.searchParams.get("prefix");
      var rows = await config.list(prefix || null);
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/config/:key", R(async function (req, res) {
      var v = await config.getFresh(req.params.key);
      if (v === null) return _problem(res, 404, "config-not-found");
      _json(res, 200, { key: req.params.key, value: v });
    }));

    router.put("/admin/config/:key", W("config.put", async function (req, res) {
      var body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, "value")) {
        throw new TypeError("admin.config.put: body.value required");
      }
      var r = await config.put(req.params.key, body.value);
      _json(res, 200, r);
      return { id: req.params.key };
    }));

    router.delete("/admin/config/:key", W("config.delete", async function (req, res) {
      var ok = await config.delete(req.params.key);
      if (!ok) return _problem(res, 404, "config-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.key };
    }));
  }

  // ---- payment-method domains (Apple Pay / Google Pay enablement) -----
  //
  // Registering the shop's web domain with Stripe enables the wallet
  // methods for the Express Checkout Element on the pay page. Stripe
  // performs Apple merchant validation + hosts the association file, so
  // there's no Apple Developer account to wire — this is the operator's
  // one-shot action. Disabled when the payment dep is absent.
  if (payment) {
    router.post("/admin/payment-method-domains", W("payment_domain.register", async function (req, res) {
      var body = req.body || {};
      var domainName = body.domain_name;
      var result = await payment.registerPaymentMethodDomain(domainName);
      _json(res, 201, result);
      return { id: (result && result.id) || domainName };
    }));

    router.get("/admin/payment-method-domains", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var domainName = url && url.searchParams.get("domain_name");
      var filter = domainName ? { domain_name: domainName } : {};
      var result = await payment.listPaymentMethodDomains(filter);
      _json(res, 200, result);
    }));
  }

  // ---- webhooks -------------------------------------------------------

  var webhooks = deps.webhooks || null;
  if (webhooks) {
    var KNOWN_WH_EVENTS = webhooks.KNOWN_EVENTS || [];

    // Create content-negotiates: bearer → JSON (unchanged for tooling);
    // signed-in browser form → create, then a one-time secret reveal page.
    // The HMAC signing secret is shown once here and never rendered in the
    // list (endpoints.list returns it, so the list render omits it), the
    // way Stripe / GitHub surface webhook secrets.
    router.post("/admin/webhooks", _pageOrApi(false,
      W("webhook.create", async function (req, res) {
        var body = req.body || {};
        var ep = await webhooks.endpoints.create({ url: body.url, events: body.events });
        _json(res, 201, ep);
        return ep;
      }),
      async function (req, res) {
        var body = req.body || {};
        var events;
        if (body.events_all === "on" || body.events_all === "1") {
          events = "*";
        } else {
          events = KNOWN_WH_EVENTS.filter(function (ev) {
            var v = body["evt_" + ev];
            return v === "on" || v === "1";
          }).join(",");
        }
        var ep;
        try {
          ep = await webhooks.endpoints.create({ url: (typeof body.url === "string" ? body.url.trim() : body.url), events: events });
        } catch (e) {
          var n = _safeNotice(e, "webhook.create");
          var rows = await webhooks.endpoints.list();
          return _sendHtml(res, n.status, renderAdminWebhooks({
            shop_name: deps.shop_name, nav_available: navAvailable, endpoints: rows,
            known_events: KNOWN_WH_EVENTS, notice: n.message.replace(/^webhooks:\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".webhook.create", outcome: "success", metadata: { id: ep.id } });
        // Direct 200, not a redirect — the one-time secret must never land
        // in a URL / server log / browser history.
        _sendHtml(res, 200, renderAdminWebhookSecret({
          shop_name: deps.shop_name, nav_available: navAvailable, endpoint: ep,
        }));
      },
    ));

    router.get("/admin/webhooks", _pageOrApi(true,
      R(async function (_req, res) {
        var rows = await webhooks.endpoints.list();
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var rows = await webhooks.endpoints.list();
        _sendHtml(res, 200, renderAdminWebhooks({
          shop_name: deps.shop_name, nav_available: navAvailable, endpoints: rows,
          known_events: KNOWN_WH_EVENTS,
          created: url && url.searchParams.get("created"),
          toggled: url && url.searchParams.get("toggled"),
          deleted: url && url.searchParams.get("deleted"),
          notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed for the endpoint." : null,
        }));
      },
    ));

    router.patch("/admin/webhooks/:id", W("webhook.update", async function (req, res) {
      var ep = await webhooks.endpoints.update(req.params.id, req.body || {});
      if (!ep) return _problem(res, 404, "webhook-not-found");
      _json(res, 200, ep);
      return ep;
    }));

    router.delete("/admin/webhooks/:id", W("webhook.delete", async function (req, res) {
      var ok = await webhooks.endpoints.delete(req.params.id);
      if (!ok) return _problem(res, 404, "webhook-not-found");
      _json(res, 200, { ok: true });
      return { id: req.params.id };
    }));

    // Browser-form equivalents of PATCH active / DELETE (HTML forms can
    // only GET/POST). Bearer clients keep using PATCH / DELETE above.
    router.post("/admin/webhooks/:id/toggle", _pageOrApi(false,
      W("webhook.update", async function (req, res) {
        var cur = await webhooks.endpoints.get(req.params.id);
        if (!cur) return _problem(res, 404, "webhook-not-found");
        var ep = await webhooks.endpoints.update(req.params.id, { active: cur.active ? false : true });
        _json(res, 200, ep);
        return ep;
      }),
      async function (req, res) {
        var ep = null;
        try {
          var cur = await webhooks.endpoints.get(req.params.id);
          if (cur) ep = await webhooks.endpoints.update(req.params.id, { active: cur.active ? false : true });
        } catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!ep) return _redirect(res, "/admin/webhooks?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".webhook.update", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, "/admin/webhooks?toggled=1");
      },
    ));

    // Browser confirmation interstitial for delete — removing an
    // endpoint is irreversible (its signing secret is gone for good and
    // deliveries stop), so the console confirms before the real DELETE.
    router.post("/admin/webhooks/:id/delete/confirm", _pageOrApi(false,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "DELETE /admin/webhooks/:id (or POST .../delete) directly for the JSON API");
      }),
      async function (req, res) {
        var id = req.params.id;
        var ep = null;
        try { ep = await webhooks.endpoints.get(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!ep) return _redirect(res, "/admin/webhooks?err=1");
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "webhooks",
          heading: "Delete this endpoint?",
          consequence: "Deleting the endpoint is permanent — its signing secret is destroyed and no further deliveries are sent.",
          detail: ep.url ? "Endpoint: " + ep.url : "This endpoint will be removed.",
          action: "/admin/webhooks/" + _htmlEscape(id) + "/delete",
          confirm_label: "Delete endpoint",
          cancel_href: "/admin/webhooks",
        }));
      },
    ));

    router.post("/admin/webhooks/:id/delete", _pageOrApi(false,
      W("webhook.delete", async function (req, res) {
        var ok = await webhooks.endpoints.delete(req.params.id);
        if (!ok) return _problem(res, 404, "webhook-not-found");
        _json(res, 200, { ok: true });
        return { id: req.params.id };
      }),
      async function (req, res) {
        var ok = false;
        try { ok = await webhooks.endpoints.delete(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!ok) return _redirect(res, "/admin/webhooks?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".webhook.delete", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, "/admin/webhooks?deleted=1");
      },
    ));

    router.get("/admin/webhooks/:id/deliveries", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var limitS = url && url.searchParams.get("limit");
        var limit  = limitS == null ? 50 : parseInt(limitS, 10);
        var rows = await webhooks.deliveries.list(req.params.id, { limit: limit });
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var ep, rows;
        try {
          ep = await webhooks.endpoints.get(req.params.id);
          rows = ep ? await webhooks.deliveries.list(req.params.id, { limit: 100 }) : [];
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          ep = null; rows = [];
        }
        if (!ep) return _sendHtml(res, 404, renderAdminWebhookDeliveries({
          shop_name: deps.shop_name, nav_available: navAvailable, endpoint: null, deliveries: [],
        }));
        _sendHtml(res, 200, renderAdminWebhookDeliveries({
          shop_name: deps.shop_name, nav_available: navAvailable, endpoint: ep, deliveries: rows,
          retried: url && url.searchParams.get("retried"),
          notice:  (url && url.searchParams.get("err")) ? "That delivery couldn't be retried." : null,
        }));
      },
    ));

    // Retry composes the network transport (re-POSTs to the endpoint), so
    // a bearer client gets the JSON contract; a browser form retries then
    // PRGs back to the endpoint's delivery feed.
    router.post("/admin/webhooks/deliveries/:id/retry", _pageOrApi(false,
      W("webhook.retry", async function (req, res) {
        var d = await webhooks.deliveries.retry(req.params.id);
        if (!d) return _problem(res, 404, "delivery-not-found");
        _json(res, 200, d);
        return { id: req.params.id };
      }),
      async function (req, res) {
        var d = null;
        try { d = await webhooks.deliveries.retry(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!d) return _redirect(res, "/admin/webhooks?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".webhook.retry", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, "/admin/webhooks/" + encodeURIComponent(d.endpoint_id) + "/deliveries?retried=1");
      },
    ));
  }

  // ---- collections ----------------------------------------------------

  // Operator-side console for manual + smart product collections (the
  // customer-facing /collections pages already ship). Manual collections
  // get a member manager (add by product id, remove, reorder); smart
  // collections get a rule editor (field/op/value rows) plus a live
  // preview of the products the rules currently match. Endpoints are
  // omitted entirely when no collections primitive is wired.
  var collections = deps.collections || null;
  if (collections) {
    // Form rule rows arrive as parallel arrays (rule_field[], rule_op[],
    // rule_value[]) — or scalars when the operator submits a single row.
    // Normalise to arrays, zip into a { all: [...] } rule set, and coerce
    // numeric / array op values so the primitive's validator sees the
    // shape it expects. Bad shapes throw TypeError, surfaced as a 400
    // re-render the same way every other create form does.
    function _asArray(v) {
      if (v == null) return [];
      return Array.isArray(v) ? v : [v];
    }
    function _rulesFromForm(body) {
      var fields = _asArray(body.rule_field);
      var ops    = _asArray(body.rule_op);
      var values = _asArray(body.rule_value);
      var all = [];
      for (var i = 0; i < fields.length; i += 1) {
        var field = fields[i];
        var op    = ops[i];
        var raw   = values[i];
        // Skip wholly blank rows (the editor renders a spare empty row).
        if ((field == null || field === "") && (raw == null || raw === "")) continue;
        var value = _coerceRuleValue(field, op, raw);
        all.push({ field: field, op: op, value: value });
      }
      if (all.length === 0) {
        throw new TypeError("rules: add at least one rule (field, op, value)");
      }
      return { all: all };
    }
    function _coerceRuleValue(field, op, raw) {
      var s = raw == null ? "" : String(raw);
      // `in` / `not_in` take a comma-separated list; numeric fields parse
      // each entry as an integer, others stay strings.
      if (op === "in" || op === "not_in") {
        return s.split(",").map(function (part) {
          var t = part.trim();
          return _isNumericField(field) ? _strictInt(t, "rule value") : t;
        });
      }
      // `between` takes "lo,hi" — both strict integers.
      if (op === "between") {
        var parts = s.split(",");
        if (parts.length !== 2) throw new TypeError("rules: 'between' value must be \"lo,hi\"");
        return [_strictInt(parts[0].trim(), "rule lo"), _strictInt(parts[1].trim(), "rule hi")];
      }
      // Numeric comparison ops + numeric-field eq/neq parse as integers.
      var numericOp = op === "gt" || op === "gte" || op === "lt" || op === "lte";
      if (numericOp || (_isNumericField(field) && (op === "eq" || op === "neq"))) {
        return _strictInt(s, "rule value");
      }
      return s;
    }
    function _isNumericField(field) {
      return field === "price_minor" || field === "inventory_count" || field === "created_at";
    }
    // Strict integer parse — refuses "12abc" / "" / floats, unlike
    // parseInt's loose prefix match. Money / count fields must be exact.
    function _strictInt(s, label) {
      if (typeof s !== "string" || !/^-?\d+$/.test(s.trim())) {
        throw new TypeError("collections: " + label + " must be an integer");
      }
      var n = Number(s.trim());
      if (!Number.isSafeInteger(n)) throw new TypeError("collections: " + label + " out of range");
      return n;
    }

    // Map the ?active= query to a collections.list filter: 1/true →
    // active-only, 0/false → archived-only, absent → all.
    function _collectionsFilter(activeS) {
      if (activeS === "1" || activeS === "true")  return { active_only: true };
      if (activeS === "0" || activeS === "false") return { archived_only: true };
      return {};
    }

    async function _listForBrowser(filter) {
      var rows = await collections.list(filter || {});
      // Annotate each row with its current size: manual → member count,
      // smart → matched-preview count. Both compose productsIn; the loop
      // is bounded by the collection count (operators have tens, not
      // thousands), so this is not an N+1 over an unbounded set.
      for (var i = 0; i < rows.length; i += 1) {
        var count = null;
        try {
          var p = await collections.productsIn({ slug: rows[i].slug, limit: 200 });
          count = (p.rows || []).length;
        } catch (_e) { count = null; }
        rows[i]._count = count;
      }
      return rows;
    }

    // List content-negotiates: bearer → JSON (the raw list, unchanged for
    // tooling); signed-in browser → the console table with an
    // all/active/archived filter.
    router.get("/admin/collections", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        var rows = await collections.list(_collectionsFilter(activeS));
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        var rows = await _listForBrowser(_collectionsFilter(activeS));
        _sendHtml(res, 200, renderAdminCollections({
          shop_name: deps.shop_name, nav_available: navAvailable, collections: rows,
          active_filter: activeS,
          created:  url && url.searchParams.get("created"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the collection." : null,
        }));
      },
    ));

    // Create content-negotiates: bearer → JSON 201 (manual or smart per
    // body.type); browser form → create, then PRG. A bad shape (TypeError)
    // re-renders the list with the validator's message rather than 500.
    router.post("/admin/collections", _pageOrApi(false,
      W("collection.create", async function (req, res) {
        var body = req.body || {};
        var col;
        if (body.type === "smart") col = await collections.defineSmart(body);
        else                       col = await collections.defineManual(body);
        _json(res, 201, col);
        return { id: col.slug };
      }),
      async function (req, res) {
        var body = req.body || {};
        var type = body.type === "smart" ? "smart" : "manual";
        try {
          if (type === "smart") {
            await collections.defineSmart({
              slug:          typeof body.slug === "string" ? body.slug.trim() : body.slug,
              title:         body.title,
              description:   body.description,
              rules:         _rulesFromForm(body),
              sort_strategy: body.sort_strategy || "newest",
            });
          } else {
            await collections.defineManual({
              slug:          typeof body.slug === "string" ? body.slug.trim() : body.slug,
              title:         body.title,
              description:   body.description,
              sort_strategy: body.sort_strategy || "manual",
            });
          }
        } catch (e) {
          var n = _safeNotice(e, "collection.create");
          var rows = await _listForBrowser({});
          return _sendHtml(res, n.status, renderAdminCollections({
            shop_name: deps.shop_name, nav_available: navAvailable, collections: rows,
            notice: n.message.replace(/^collections[.:]\s*/, ""), form_type: type,
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".collection.create", outcome: "success" });
        _redirect(res, "/admin/collections?created=1");
      },
    ));

    async function _detailModel(slug) {
      var col = await collections.get(slug);
      if (!col) return null;
      var preview = null, members = null;
      if (col.type === "manual") {
        var pm = await collections.productsIn({ slug: slug, limit: 200 });
        members = pm.rows || [];
      } else {
        var ps = await collections.productsIn({ slug: slug, limit: 50 });
        preview = ps.rows || [];
      }
      return { collection: col, members: members, preview: preview };
    }

    // Detail content-negotiates: bearer → JSON (collection + members /
    // preview); browser → the member manager (manual) or rule editor +
    // preview (smart). A bad / unknown slug is a 404 page, never a 500.
    router.get("/admin/collections/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var model;
        try { model = await _detailModel(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "collection-not-found", e.message); throw e; }
        if (!model) return _problem(res, 404, "collection-not-found");
        _json(res, 200, model);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var model;
        try { model = await _detailModel(req.params.slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; model = null; }
        if (!model) return _sendHtml(res, 404, renderAdminCollections({
          shop_name: deps.shop_name, nav_available: navAvailable, collections: [], notice: "Collection not found.",
        }));
        _sendHtml(res, 200, renderAdminCollection({
          shop_name: deps.shop_name, nav_available: navAvailable,
          collection: model.collection, members: model.members, preview: model.preview,
          rule_fields: collectionsModule.RULE_FIELDS, rule_ops: collectionsModule.RULE_OPS,
          sort_strategies: collectionsModule.SORT_STRATEGIES,
          saved:   url && url.searchParams.get("saved"),
          updated: url && url.searchParams.get("updated"),
          notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
        }));
      },
    ));

    // Edit content-negotiates: bearer PATCH (the JSON contract) + browser
    // POST /edit (HTML forms can't PATCH). Both update title / description
    // / sort_strategy, and rules for smart. A bad shape is a 400 / notice.
    router.patch("/admin/collections/:slug", W("collection.update", async function (req, res) {
      var col;
      try { col = await collections.update(req.params.slug, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!col) return _problem(res, 404, "collection-not-found");
      _json(res, 200, col);
      return { id: col.slug };
    }));

    router.post("/admin/collections/:slug/edit", _pageOrApi(false,
      W("collection.update", async function (req, res) {
        var col;
        try { col = await collections.update(req.params.slug, req.body || {}); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!col) return _problem(res, 404, "collection-not-found");
        _json(res, 200, col);
        return { id: col.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var body = req.body || {};
        var enc = encodeURIComponent(slug);
        try {
          var existing = await collections.get(slug);
          if (!existing) return _redirect(res, "/admin/collections/" + enc + "?err=1");
          var patch = {};
          if (body.title !== undefined)       patch.title = body.title;
          if (body.description !== undefined) patch.description = body.description;
          if (body.sort_strategy)             patch.sort_strategy = body.sort_strategy;
          if (existing.type === "smart" && (body.rule_field !== undefined || body.rule_op !== undefined)) {
            patch.rules = _rulesFromForm(body);
          }
          if (Object.keys(patch).length === 0) return _redirect(res, "/admin/collections/" + enc + "?err=1");
          await collections.update(slug, patch);
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/collections/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".collection.update", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/collections/" + enc + "?updated=1");
      },
    ));

    // Archive content-negotiates: bearer DELETE (soft archive) + browser
    // POST /archive. An unknown / already-archived slug is a no-op notice
    // (?err=1), never a false success.
    router.delete("/admin/collections/:slug", W("collection.archive", async function (req, res) {
      var col;
      try { col = await collections.archive(req.params.slug); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!col) return _problem(res, 404, "collection-not-found");
      _json(res, 200, col);
      return { id: col.slug };
    }));

    router.post("/admin/collections/:slug/archive", _pageOrApi(false,
      W("collection.archive", async function (req, res) {
        var col;
        try { col = await collections.archive(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!col) return _problem(res, 404, "collection-not-found");
        _json(res, 200, col);
        return { id: col.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var col = null;
        try { col = await collections.archive(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        // archive() returns the row whether or not it flipped (already-
        // archived re-returns the row); treat a missing row as the only
        // err. An already-archived re-archive is idempotent, not an error.
        if (!col) return _redirect(res, "/admin/collections?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".collection.archive", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/collections?archived=1");
      },
    ));

    // Manual member ops — browser POST routes (the JSON API composes
    // addProduct / removeProduct / reorderProducts directly). Each PRGs
    // back to the detail; a bad shape / unknown product is a ?err=1 notice.
    function _memberRedirect(res, slug, ok) {
      var enc = encodeURIComponent(slug);
      return _redirect(res, "/admin/collections/" + enc + (ok ? "?updated=1" : "?err=1"));
    }

    router.post("/admin/collections/:slug/members/add", _pageOrApi(false,
      W("collection.member_add", async function (req, res) {
        var body = req.body || {};
        var m;
        try { m = await collections.addProduct({ collection_slug: req.params.slug, product_id: body.product_id }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 201, m);
        return { id: req.params.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var body = req.body || {};
        try {
          await collections.addProduct({ collection_slug: slug, product_id: (body.product_id || "").trim() });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _memberRedirect(res, slug, false);
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".collection.member_add", outcome: "success", metadata: { slug: slug } });
        _memberRedirect(res, slug, true);
      },
    ));

    router.post("/admin/collections/:slug/members/remove", _pageOrApi(false,
      W("collection.member_remove", async function (req, res) {
        var body = req.body || {};
        var ok;
        try { ok = await collections.removeProduct({ collection_slug: req.params.slug, product_id: body.product_id }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!ok) return _problem(res, 404, "collection-member-not-found");
        _json(res, 200, { ok: true });
        return { id: req.params.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var body = req.body || {};
        var ok = false;
        try {
          ok = await collections.removeProduct({ collection_slug: slug, product_id: (body.product_id || "").trim() });
        } catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!ok) return _memberRedirect(res, slug, false);
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".collection.member_remove", outcome: "success", metadata: { slug: slug } });
        _memberRedirect(res, slug, true);
      },
    ));

    router.post("/admin/collections/:slug/members/reorder", _pageOrApi(false,
      W("collection.reorder", async function (req, res) {
        var body = req.body || {};
        var ids = Array.isArray(body.ordered_product_ids) ? body.ordered_product_ids : null;
        if (!ids) return _problem(res, 400, "bad-request", "ordered_product_ids array required");
        try { await collections.reorderProducts({ collection_slug: req.params.slug, ordered_product_ids: ids }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, { ok: true });
        return { id: req.params.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var body = req.body || {};
        // The reorder form posts the full ordered id list — a single hidden
        // field of comma-joined ids, or repeated ordered_product_id rows.
        var ids;
        if (body.ordered_product_ids != null && typeof body.ordered_product_ids === "string") {
          ids = body.ordered_product_ids.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
        } else {
          ids = _asArray(body.ordered_product_id).map(function (s) { return String(s).trim(); }).filter(Boolean);
        }
        try {
          await collections.reorderProducts({ collection_slug: slug, ordered_product_ids: ids });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _memberRedirect(res, slug, false);
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".collection.reorder", outcome: "success", metadata: { slug: slug } });
        _memberRedirect(res, slug, true);
      },
    ));
  }

  // ---- discount allocations -------------------------------------------

  // Read-only console for the per-line discount-allocation audit trail.
  // When a placed order carried a cart-level discount, checkout records
  // (post-commit) how that discount split across the order's lines, so a
  // later partial refund knows each line's discounted share. Allocations
  // are SYSTEM-WRITTEN — there's no create/edit here; the operator looks
  // up an order id and reads back the recorded breakdown. Endpoints are
  // omitted entirely when no discountAllocation primitive is wired.
  var discountAllocation = deps.discountAllocation || null;
  if (discountAllocation) {
    // Look an order's recorded allocations up by id. Content-negotiates:
    // bearer → JSON (the raw rows, unchanged for tooling); signed-in
    // browser → the lookup form plus the rendered breakdown tables.
    //
    // The order id is a defensive request-shape reader — an empty / over-
    // long / control-byte id makes allocationsForOrder throw a TypeError,
    // which surfaces as an empty result + a notice, never a 500.
    async function _lookupAllocations(orderId) {
      if (typeof orderId !== "string" || orderId === "") return [];
      try {
        return await discountAllocation.allocationsForOrder(orderId);
      } catch (e) {
        if (e instanceof TypeError) return [];   // malformed id — treat as "nothing recorded"
        throw e;
      }
    }

    router.get("/admin/discount-allocation", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var orderId = (url && url.searchParams.get("order_id")) || "";
        var rows = await _lookupAllocations(orderId);
        _json(res, 200, { order_id: orderId, rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var orderId = (url && url.searchParams.get("order_id")) || "";
        var rows = orderId ? await _lookupAllocations(orderId) : [];
        var notice = (orderId && rows.length === 0)
          ? "No discount allocations recorded for that order."
          : null;
        _sendHtml(res, 200, renderAdminDiscountAllocation({
          shop_name:     deps.shop_name,
          nav_available: navAvailable,
          order_id:      orderId,
          allocations:   rows,
          notice:        notice,
        }));
      },
    ));
  }

  // ---- announcements --------------------------------------------------
  // Sitewide promo/notice strip. Content-negotiated like the other console
  // screens: bearer → the JSON contract; signed-in browser → the HTML
  // table + create form. The console exposes the all / guest / logged_in
  // audiences; the primitive's segment audience needs an isMember handle
  // that isn't wired (see server.js), so it isn't offered here.
  if (deps.announcementBar) {
    var announcements = deps.announcementBar;

    router.get("/admin/announcements", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        var rows = await announcements.listAnnouncements(activeS === "1" ? { active_only: true } : {});
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        var rows = await announcements.listAnnouncements(activeS === "1" ? { active_only: true } : {});
        _sendHtml(res, 200, renderAdminAnnouncements({
          shop_name: deps.shop_name, nav_available: navAvailable, announcements: rows,
          active_filter: activeS,
          created:  url && url.searchParams.get("created"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the announcement." : null,
        }));
      },
    ));

    router.post("/admin/announcements", _pageOrApi(false,
      W("announcement.define", async function (req, res) {
        var row = await announcements.defineAnnouncement(req.body || {});
        _json(res, 201, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        try {
          await announcements.defineAnnouncement(_announcementFromForm(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "announcement.define");
          var rows = await announcements.listAnnouncements({});
          return _sendHtml(res, n.status, renderAdminAnnouncements({
            shop_name: deps.shop_name, nav_available: navAvailable, announcements: rows,
            notice: n.message.replace(/^announcementBar[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".announcement.define", outcome: "success" });
        _redirect(res, "/admin/announcements?created=1");
      },
    ));

    // Detail screen: the single announcement + its edit form. Content-
    // negotiates like the list — bearer → the JSON row; browser cookie →
    // the rendered edit page. A bad / unknown slug is a 404 page (browser)
    // or 404 problem (bearer), never a 500.
    router.get("/admin/announcements/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var row = await announcements.getAnnouncement(req.params.slug);
        if (!row) return _problem(res, 404, "announcement-not-found");
        _json(res, 200, row);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var row = await announcements.getAnnouncement(req.params.slug);
        if (!row) return _sendHtml(res, 404, renderAdminAnnouncements({
          shop_name: deps.shop_name, nav_available: navAvailable, announcements: [], notice: "Announcement not found.",
        }));
        _sendHtml(res, 200, renderAdminAnnouncement({
          shop_name: deps.shop_name, nav_available: navAvailable, announcement: row,
          updated: url && url.searchParams.get("updated"),
          notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed for the announcement." : null,
        }));
      },
    ));

    // Edit content-negotiates: bearer POST /edit (JSON) + browser POST
    // /edit (HTML forms can't PATCH). Both forward the full editable
    // column set — message, link, audience, schedule, dismissible — into
    // updateAnnouncement, preserving the slug + accumulated dismissal
    // state (archive-and-recreate would discard both). PRG to ?updated=1;
    // a bad shape is a clean 400 (bearer) / err notice (browser).
    router.post("/admin/announcements/:slug/edit", _pageOrApi(false,
      W("announcement.update", async function (req, res) {
        var row;
        try { row = await announcements.updateAnnouncement(req.params.slug, _announcementPatchFromForm(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!row) return _problem(res, 404, "announcement-not-found");
        _json(res, 200, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc = encodeURIComponent(slug);
        try { await announcements.updateAnnouncement(slug, _announcementPatchFromForm(req.body || {})); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/announcements/" + enc + "?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".announcement.update", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/announcements/" + enc + "?updated=1");
      },
    ));

    router.post("/admin/announcements/:slug/archive", _pageOrApi(false,
      W("announcement.archive", async function (req, res) {
        var row;
        try { row = await announcements.archiveAnnouncement(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!row) return _problem(res, 404, "announcement-not-found");
        _json(res, 200, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var row = null;
        try { row = await announcements.archiveAnnouncement(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!row) return _redirect(res, "/admin/announcements?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".announcement.archive", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/announcements?archived=1");
      },
    ));
  }

  // ---- blog -----------------------------------------------------------
  // Author the operator's editorial blog. The edge Worker serves the
  // customer-facing /blog index + /blog/:slug posts + the RSS feed,
  // reading ONLY published rows; this console writes them. A post is
  // created as a draft and stays invisible to the storefront until it's
  // published — publish / unpublish / archive / restore move it through
  // the lifecycle (draft → published → archived, with restore back to
  // draft). Content-negotiated like the other screens: bearer → the JSON
  // contract; signed-in browser → the HTML list + author forms.
  if (deps.blog) {
    var blog = deps.blog;

    // The list pulls each lifecycle state separately (the primitive has
    // listDrafts / listArchived + listPublished) and merges them for the
    // console table. The published set is the first page of the cursor-
    // paginated feed — an editorial corpus that the console doesn't page
    // (operators have tens of posts); the storefront's /blog is the
    // paginated reader.
    async function _blogRows(filter) {
      var drafts    = await blog.listDrafts();
      var archived  = await blog.listArchived();
      var published = (await blog.listPublished({ limit: blog.MAX_LIST_LIMIT })).rows;
      if (filter === "draft")     return drafts;
      if (filter === "published") return published;
      if (filter === "archived")  return archived;
      // All: published first (newest-live), then drafts, then archived.
      return published.concat(drafts).concat(archived);
    }

    router.get("/admin/blog", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || null;
        _json(res, 200, { rows: await _blogRows(status) });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || null;
        var rows = await _blogRows(status);
        _sendHtml(res, 200, renderAdminBlog({
          shop_name: deps.shop_name, nav_available: navAvailable, articles: rows,
          status_filter: status,
          created:   url && url.searchParams.get("created"),
          updated:   url && url.searchParams.get("updated"),
          published: url && url.searchParams.get("published"),
          archived:  url && url.searchParams.get("archived"),
          notice:    (url && url.searchParams.get("err")) ? "That action couldn't be completed for the post." : null,
        }));
      },
    ));

    // The new-post form. A standalone GET so the "New post" button on the
    // list has a target; the create POST lives at /admin/blog.
    router.get("/admin/blog/new", _pageOrApi(true,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/blog with a JSON body to create a post");
      }),
      async function (_req, res) {
        _sendHtml(res, 200, renderAdminBlogDetail({
          shop_name: deps.shop_name, nav_available: navAvailable, article: null,
        }));
      },
    ));

    // Create content-negotiates: bearer → JSON 201 (a draft row); browser
    // form → createDraft, then PRG to the post's detail screen to keep
    // authoring. Every post is born a DRAFT — never published on create —
    // so it can't reach the storefront before the operator publishes it.
    router.post("/admin/blog", _pageOrApi(false,
      W("blog.create", async function (req, res) {
        var row = await blog.createDraft(req.body || {});
        _json(res, 201, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var made;
        try {
          made = await blog.createDraft(_blogFromForm(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "blog.create");
          return _sendHtml(res, n.status, renderAdminBlogDetail({
            shop_name: deps.shop_name, nav_available: navAvailable, article: null,
            form_values: req.body || {},
            notice: n.message.replace(/^blogArticles[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".blog.create", outcome: "success", metadata: { slug: made.slug } });
        _redirect(res, "/admin/blog/" + encodeURIComponent(made.slug) + "?created=1");
      },
    ));

    // Detail content-negotiates: bearer → JSON (the row, any status);
    // browser → the edit form + the lifecycle action buttons. A bad /
    // unknown slug is a 404 page, never a 500.
    router.get("/admin/blog/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var row;
        try { row = await blog.get(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "blog-post-not-found", e.message); throw e; }
        if (!row) return _problem(res, 404, "blog-post-not-found");
        _json(res, 200, row);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var row;
        try { row = await blog.get(req.params.slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; row = null; }
        if (!row) return _sendHtml(res, 404, renderAdminBlog({
          shop_name: deps.shop_name, nav_available: navAvailable, articles: [], notice: "Post not found.",
        }));
        _sendHtml(res, 200, renderAdminBlogDetail({
          shop_name: deps.shop_name, nav_available: navAvailable, article: row,
          updated:   url && url.searchParams.get("updated"),
          published: url && url.searchParams.get("published"),
          notice:    (url && url.searchParams.get("err")) ? "That action couldn't be completed for the post." : null,
        }));
      },
    ));

    // Edit content-negotiates: bearer PATCH (the JSON contract) + browser
    // POST /edit (HTML forms can't PATCH). Both patch the editable columns
    // (title / body / author / tags / meta / hero image). Status is NOT
    // editable here — it moves via the lifecycle routes below.
    router.patch("/admin/blog/:slug", W("blog.update", async function (req, res) {
      var row;
      try { row = await blog.update(req.params.slug, req.body || {}); }
      catch (e) {
        if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
        if (e && e.code === "BLOG_ARTICLE_NOT_FOUND") return _problem(res, 404, "blog-post-not-found");
        throw e;
      }
      _json(res, 200, row);
      return { id: row.slug };
    }));

    router.post("/admin/blog/:slug/edit", _pageOrApi(false,
      W("blog.update", async function (req, res) {
        var row;
        try { row = await blog.update(req.params.slug, req.body || {}); }
        catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          if (e && e.code === "BLOG_ARTICLE_NOT_FOUND") return _problem(res, 404, "blog-post-not-found");
          throw e;
        }
        _json(res, 200, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc  = encodeURIComponent(slug);
        try {
          await blog.update(slug, _blogPatchFromForm(req.body || {}));
        } catch (e) {
          if (e && e.code === "BLOG_ARTICLE_NOT_FOUND") return _redirect(res, "/admin/blog?err=1");
          var n = _safeNotice(e, "blog.update");
          var current = null;
          try { current = await blog.get(slug); } catch (_e) { current = null; }
          if (!current) return _redirect(res, "/admin/blog?err=1");
          return _sendHtml(res, n.status, renderAdminBlogDetail({
            shop_name: deps.shop_name, nav_available: navAvailable, article: current,
            notice: n.message.replace(/^blogArticles[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".blog.update", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/blog/" + enc + "?updated=1");
      },
    ));

    // Lifecycle transitions — each PRGs back to the detail. publish takes
    // a draft live (now visible on the storefront); unpublish pulls it
    // back to draft (gone from the storefront); restore returns an
    // archived post to draft. An illegal transition (wrong from-state) or
    // a missing slug is a ?err=1 notice, never a 500.
    function _blogTransition(action, fn) {
      router.post("/admin/blog/:slug/" + action, _pageOrApi(false,
        W("blog." + action, async function (req, res) {
          var row;
          try { row = await fn(req.params.slug); }
          catch (e) {
            if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
            if (e && e.code === "BLOG_ARTICLE_NOT_FOUND") return _problem(res, 404, "blog-post-not-found");
            if (e && e.code === "BLOG_ARTICLE_BAD_STATE") return _problem(res, 409, "conflict", e.message);
            throw e;
          }
          _json(res, 200, row);
          return { id: row.slug };
        }),
        async function (req, res) {
          var slug = req.params.slug;
          var enc  = encodeURIComponent(slug);
          try {
            await fn(slug);
          } catch (e) {
            if (e instanceof TypeError || (e && (e.code === "BLOG_ARTICLE_NOT_FOUND" || e.code === "BLOG_ARTICLE_BAD_STATE"))) {
              return _redirect(res, "/admin/blog/" + enc + "?err=1");
            }
            throw e;
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".blog." + action, outcome: "success", metadata: { slug: slug } });
          // archive lands back on the list (the post left the editable
          // set); the others stay on the detail with a status banner.
          if (action === "archive") return _redirect(res, "/admin/blog?archived=1");
          _redirect(res, "/admin/blog/" + enc + (action === "publish" ? "?published=1" : "?updated=1"));
        },
      ));
    }
    _blogTransition("publish",   function (s) { return blog.publish(s); });
    _blogTransition("unpublish", function (s) { return blog.unpublish(s); });
    _blogTransition("restore",   function (s) { return blog.restore(s); });

    // Archive is destructive-ish (the post leaves the live storefront and
    // the editable set), so the browser path confirms first — the CSP
    // forbids a client confirm() dialog. Reached by a GET link from the
    // detail screen; bearer clients POST /archive directly.
    router.get("/admin/blog/:slug/archive/confirm-page", _pageOrApi(true,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/blog/:slug/archive directly for the JSON API");
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc  = encodeURIComponent(slug);
        var row = null;
        try { row = await blog.get(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!row) return _redirect(res, "/admin/blog?err=1");
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "blog",
          heading: "Archive this post?",
          consequence: "Archiving removes the post from the live storefront blog. You can restore it to a draft later.",
          detail: "Post: " + (row.title || slug) + ".",
          action: "/admin/blog/" + _htmlEscape(enc) + "/archive",
          confirm_label: "Archive post",
          cancel_href: "/admin/blog/" + enc,
        }));
      },
    ));
    _blogTransition("archive", function (s) { return blog.archive(s); });
  }

  // ---- storefront pages -----------------------------------------------
  // Author the operator's CMS content pages (About, Shipping, Returns,
  // Privacy, Terms, and the long tail every shop needs). The edge Worker
  // serves the customer-facing page at /pages/:slug, reading ONLY
  // published rows; this console writes them. A page is created as a draft
  // and stays invisible to the storefront until it's published — publish /
  // unpublish / archive / restore move it through the lifecycle (draft →
  // published → archived, with restore back to draft). Content-negotiated
  // like the other screens: bearer → the JSON contract; signed-in browser
  // → the HTML list + author forms.
  if (deps.storefrontPages) {
    var pages = deps.storefrontPages;

    // The list pulls each lifecycle state separately (the primitive has
    // listDrafts / listArchived + listPublished, each returning an array)
    // and merges them for the console table. The console doesn't page the
    // page corpus — operators have a handful of content pages.
    async function _pageRows(filter) {
      var drafts    = await pages.listDrafts();
      var archived  = await pages.listArchived();
      var published = await pages.listPublished();
      if (filter === "draft")     return drafts;
      if (filter === "published") return published;
      if (filter === "archived")  return archived;
      // All: published first (newest-live), then drafts, then archived.
      return published.concat(drafts).concat(archived);
    }

    router.get("/admin/pages", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || null;
        _json(res, 200, { rows: await _pageRows(status) });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = (url && url.searchParams.get("status")) || null;
        var rows = await _pageRows(status);
        _sendHtml(res, 200, renderAdminPages({
          shop_name: deps.shop_name, nav_available: navAvailable, pages: rows,
          status_filter: status,
          created:   url && url.searchParams.get("created"),
          updated:   url && url.searchParams.get("updated"),
          published: url && url.searchParams.get("published"),
          archived:  url && url.searchParams.get("archived"),
          notice:    (url && url.searchParams.get("err")) ? "That action couldn't be completed for the page." : null,
        }));
      },
    ));

    // The new-page form. A standalone GET so the "New page" button on the
    // list has a target; the create POST lives at /admin/pages.
    router.get("/admin/pages/new", _pageOrApi(true,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/pages with a JSON body to create a page");
      }),
      async function (_req, res) {
        _sendHtml(res, 200, renderAdminPageDetail({
          shop_name: deps.shop_name, nav_available: navAvailable, page: null,
        }));
      },
    ));

    // Create content-negotiates: bearer → JSON 201 (a draft row); browser
    // form → defineDraft, then PRG to the page's detail screen to keep
    // authoring. Every page is born a DRAFT — never published on create —
    // so it can't reach the storefront before the operator publishes it.
    router.post("/admin/pages", _pageOrApi(false,
      W("page.create", async function (req, res) {
        var row = await pages.defineDraft(req.body || {});
        _json(res, 201, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var made;
        try {
          made = await pages.defineDraft(_pageFromForm(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "page.create");
          return _sendHtml(res, n.status, renderAdminPageDetail({
            shop_name: deps.shop_name, nav_available: navAvailable, page: null,
            form_values: req.body || {},
            notice: n.message.replace(/^storefrontPages[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".page.create", outcome: "success", metadata: { slug: made.slug } });
        _redirect(res, "/admin/pages/" + encodeURIComponent(made.slug) + "?created=1");
      },
    ));

    // Detail content-negotiates: bearer → JSON (the row, any status);
    // browser → the edit form + the lifecycle action buttons. A bad /
    // unknown slug is a 404 page, never a 500.
    router.get("/admin/pages/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var row;
        try { row = await pages.get(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "page-not-found", e.message); throw e; }
        if (!row) return _problem(res, 404, "page-not-found");
        _json(res, 200, row);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var row;
        try { row = await pages.get(req.params.slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; row = null; }
        if (!row) return _sendHtml(res, 404, renderAdminPages({
          shop_name: deps.shop_name, nav_available: navAvailable, pages: [], notice: "Page not found.",
        }));
        _sendHtml(res, 200, renderAdminPageDetail({
          shop_name: deps.shop_name, nav_available: navAvailable, page: row,
          updated:   url && url.searchParams.get("updated"),
          published: url && url.searchParams.get("published"),
          notice:    (url && url.searchParams.get("err")) ? "That action couldn't be completed for the page." : null,
        }));
      },
    ));

    // Edit content-negotiates: bearer PATCH (the JSON contract) + browser
    // POST /edit (HTML forms can't PATCH). Both patch the editable columns
    // (title / body / meta / layout). Status is NOT editable here — it
    // moves via the lifecycle routes below.
    router.patch("/admin/pages/:slug", W("page.update", async function (req, res) {
      var row;
      try { row = await pages.update(req.params.slug, req.body || {}); }
      catch (e) {
        if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
        throw e;
      }
      _json(res, 200, row);
      return { id: row.slug };
    }));

    router.post("/admin/pages/:slug/edit", _pageOrApi(false,
      W("page.update", async function (req, res) {
        var row;
        try { row = await pages.update(req.params.slug, req.body || {}); }
        catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        _json(res, 200, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc  = encodeURIComponent(slug);
        try {
          await pages.update(slug, _pagePatchFromForm(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "page.update");
          var current = null;
          try { current = await pages.get(slug); } catch (_e) { current = null; }
          if (!current) return _redirect(res, "/admin/pages?err=1");
          return _sendHtml(res, n.status, renderAdminPageDetail({
            shop_name: deps.shop_name, nav_available: navAvailable, page: current,
            notice: n.message.replace(/^storefrontPages[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".page.update", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/pages/" + enc + "?updated=1");
      },
    ));

    // Lifecycle transitions — each PRGs back to the detail. publish takes
    // a draft live (now visible on the storefront); unpublish pulls it
    // back to draft (gone from the storefront); restore returns an
    // archived page to draft. An illegal transition (wrong from-state) or
    // a missing slug throws a TypeError from the primitive — a ?err=1
    // notice, never a 500.
    function _pageTransition(action, fn) {
      router.post("/admin/pages/:slug/" + action, _pageOrApi(false,
        W("page." + action, async function (req, res) {
          var row;
          try { row = await fn(req.params.slug); }
          catch (e) {
            if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
            throw e;
          }
          _json(res, 200, row);
          return { id: row.slug };
        }),
        async function (req, res) {
          var slug = req.params.slug;
          var enc  = encodeURIComponent(slug);
          try {
            await fn(slug);
          } catch (e) {
            if (e instanceof TypeError) return _redirect(res, "/admin/pages/" + enc + "?err=1");
            throw e;
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".page." + action, outcome: "success", metadata: { slug: slug } });
          // archive lands back on the list (the page left the editable
          // set); the others stay on the detail with a status banner.
          if (action === "archive") return _redirect(res, "/admin/pages?archived=1");
          _redirect(res, "/admin/pages/" + enc + (action === "publish" ? "?published=1" : "?updated=1"));
        },
      ));
    }
    _pageTransition("publish",   function (s) { return pages.publish(s); });
    _pageTransition("unpublish", function (s) { return pages.unpublish(s); });
    _pageTransition("restore",   function (s) { return pages.restore(s); });

    // Archive removes the page from the live storefront and the editable
    // set, so the browser path confirms first — the CSP forbids a client
    // confirm() dialog. Reached by a GET link from the detail screen;
    // bearer clients POST /archive directly.
    router.get("/admin/pages/:slug/archive/confirm-page", _pageOrApi(true,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/pages/:slug/archive directly for the JSON API");
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc  = encodeURIComponent(slug);
        var row = null;
        try { row = await pages.get(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!row) return _redirect(res, "/admin/pages?err=1");
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "pages",
          heading: "Archive this page?",
          consequence: "Archiving removes the page from the live storefront. You can restore it to a draft later.",
          detail: "Page: " + (row.title || slug) + ".",
          action: "/admin/pages/" + _htmlEscape(enc) + "/archive",
          confirm_label: "Archive page",
          cancel_href: "/admin/pages/" + enc,
        }));
      },
    ));
    _pageTransition("archive", function (s) { return pages.archive(s); });
  }

  // ---- customer surveys -----------------------------------------------
  // Define NPS/CSAT/CES/custom surveys, issue token invitations (the
  // plaintext link is shown once on issue), and read the rollup. The
  // console creates surveys with a standard question set for the chosen
  // kind; fully custom question lists go through the JSON API. Content-
  // negotiated like the other screens.
  if (deps.customerSurveys) {
    var surveys = deps.customerSurveys;

    router.get("/admin/surveys", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        _json(res, 200, { rows: await surveys.listSurveys(activeS === "1" ? { active_only: true } : {}) });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        var rows = await surveys.listSurveys(activeS === "1" ? { active_only: true } : {});
        _sendHtml(res, 200, renderAdminSurveys({
          shop_name: deps.shop_name, nav_available: navAvailable, surveys: rows,
          active_filter: activeS,
          created:  url && url.searchParams.get("created"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the survey." : null,
        }));
      },
    ));

    router.post("/admin/surveys", _pageOrApi(false,
      W("survey.define", async function (req, res) {
        var row = await surveys.defineSurvey(req.body || {});
        _json(res, 201, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var body = req.body || {};
        try {
          await surveys.defineSurvey({
            slug:     typeof body.slug === "string" ? body.slug.trim() : body.slug,
            title:    body.title,
            kind:     body.kind,
            trigger:  body.trigger || "manual",
            questions: _standardSurveyQuestions(body.kind),
          });
        } catch (e) {
          var n = _safeNotice(e, "survey.define");
          var rows = await surveys.listSurveys({});
          return _sendHtml(res, n.status, renderAdminSurveys({
            shop_name: deps.shop_name, nav_available: navAvailable, surveys: rows,
            notice: n.message.replace(/^customerSurveys[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".survey.define", outcome: "success" });
        _redirect(res, "/admin/surveys?created=1");
      },
    ));

    router.post("/admin/surveys/:slug/archive", _pageOrApi(false,
      W("survey.archive", async function (req, res) {
        var row;
        try { row = await surveys.archiveSurvey(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!row) return _problem(res, 404, "survey-not-found");
        _json(res, 200, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var row = null;
        try { row = await surveys.archiveSurvey(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!row) return _redirect(res, "/admin/surveys?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".survey.archive", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/surveys?archived=1");
      },
    ));

    // Detail: rollup + the issue-invitation form. The freshly-issued token
    // link is rendered once via the ?token= flash (never stored plaintext).
    router.get("/admin/surveys/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var roll = await surveys.rollup({ slug: req.params.slug });
        if (!roll) return _problem(res, 404, "survey-not-found");
        _json(res, 200, roll);
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var survey = await surveys.getSurvey(slug);
        if (!survey) return _sendHtml(res, 404, renderAdminSurveyDetail({ shop_name: deps.shop_name, nav_available: navAvailable, survey: null }));
        var roll = await surveys.rollup({ slug: slug });
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _sendHtml(res, 200, renderAdminSurveyDetail({
          shop_name: deps.shop_name, nav_available: navAvailable,
          survey: survey, rollup: roll,
          issued_link: url && url.searchParams.get("link"),
          notice: (url && url.searchParams.get("err")) ? "Couldn't issue that invitation — check the customer id." : null,
        }));
      },
    ));

    router.post("/admin/surveys/:slug/issue", _pageOrApi(false,
      W("survey.issue", async function (req, res) {
        var out = await surveys.issueInvitation(Object.assign({}, req.body || {}, { survey_slug: req.params.slug }));
        _json(res, 201, out);
        return { id: out.invitation_id };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc = encodeURIComponent(slug);
        var out;
        try {
          out = await surveys.issueInvitation({ survey_slug: slug, customer_id: (req.body && req.body.customer_id) });
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/surveys/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".survey.issue", outcome: "success", metadata: { slug: slug } });
        // The plaintext token is shown exactly once — pass it back via the
        // detail redirect so the operator can copy the survey link.
        _redirect(res, "/admin/surveys/" + enc + "?link=" + encodeURIComponent(out.plaintext_token));
      },
    ));
  }

  // ---- business hours -------------------------------------------------
  // Define open/close schedules surfaced on the public /hours page. The
  // console create form takes a per-weekday open/close pair (blank = closed
  // that day); holidays + one-off exceptions are managed via the JSON API.
  // Content-negotiated like the other screens.
  if (deps.businessHours) {
    var hours = deps.businessHours;

    router.get("/admin/hours", _pageOrApi(true,
      R(async function (req, res) {
        _json(res, 200, { rows: await hours.listSchedules() });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var rows = await hours.listSchedules();
        _sendHtml(res, 200, renderAdminHours({
          shop_name: deps.shop_name, nav_available: navAvailable, schedules: rows,
          created:  url && url.searchParams.get("created"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the schedule." : null,
        }));
      },
    ));

    router.post("/admin/hours", _pageOrApi(false,
      W("hours.define", async function (req, res) {
        var row = await hours.defineSchedule(req.body || {});
        _json(res, 201, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        try {
          await hours.defineSchedule(_scheduleFromForm(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "hours.define");
          var rows = await hours.listSchedules();
          return _sendHtml(res, n.status, renderAdminHours({
            shop_name: deps.shop_name, nav_available: navAvailable, schedules: rows,
            notice: n.message.replace(/^businessHours[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".hours.define", outcome: "success" });
        _redirect(res, "/admin/hours?created=1");
      },
    ));

    router.post("/admin/hours/:slug/archive", _pageOrApi(false,
      W("hours.archive", async function (req, res) {
        var row;
        try { row = await hours.archiveSchedule(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!row) return _problem(res, 404, "schedule-not-found");
        _json(res, 200, row);
        return { id: row.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var row = null;
        try { row = await hours.archiveSchedule(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!row) return _redirect(res, "/admin/hours?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".hours.archive", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/hours?archived=1");
      },
    ));
  }

  // ---- reporting ------------------------------------------------------
  //
  // A sales/revenue report over a selectable date range: order count,
  // gross/net revenue, refunds, AOV, top products, broken down by day and
  // by status. Aggregated from the salesReports primitive (pure read-only
  // SQL over orders/order_lines). The route mounts unconditionally so the
  // always-present "Reports" nav link never points at a missing route; when
  // the salesReports primitive isn't wired it renders an unconfigured
  // notice. CSV export of the by-day series is exposed via `?format=csv`.
  //
  // Date range: `from`/`to` are epoch-ms query params (defaults to the last
  // 30 days). A malformed range re-renders the page with a 400 + the
  // validator's message rather than crashing — the report is config/entry
  // tier, so a bad operator-typed range surfaces as a correction, not a 500.

  // Parse a "YYYY-MM-DD" calendar-date param to the epoch-ms at UTC
  // midnight. Returns null when the param is absent; throws TypeError on a
  // malformed value so the config/entry-tier 400 path catches it. The
  // browser date <input> submits this shape; the JSON API can use either
  // this or the raw epoch-ms `from`/`to`.
  function _parseDateParam(str, label) {
    if (str == null || str === "") return null;
    if (typeof str !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(str)) {
      throw new TypeError("admin: " + label + " must be a YYYY-MM-DD date");
    }
    var ms = Date.parse(str + "T00:00:00Z");
    if (!isFinite(ms)) throw new TypeError("admin: " + label + " is not a valid date");
    return ms;
  }

  // Resolve the report window from the query string. Returns
  // `{ from, to }` (epoch-ms) or throws TypeError on a malformed value.
  // Accepts either the raw epoch-ms `from`/`to` pair (machine clients) or
  // the calendar-date `from-date`/`to-date` pair (the browser date inputs);
  // the epoch-ms form wins when both are present. Defaults: to = now,
  // from = now - 30d. The salesReports primitive re-validates (from < to,
  // span ≤ 1y), so this only coerces the shape.
  function _reportWindow(url) {
    var from = _parseEpochMs(url && url.searchParams.get("from"), "from");
    var to   = _parseEpochMs(url && url.searchParams.get("to"),   "to");
    if (from == null) from = _parseDateParam(url && url.searchParams.get("from-date"), "from");
    // `to-date` is the inclusive end day — advance to the next UTC midnight
    // so the window covers the whole selected day (salesReports treats `to`
    // as exclusive: `updated_at < to`).
    if (to == null) {
      var toDate = _parseDateParam(url && url.searchParams.get("to-date"), "to");
      if (toDate != null) to = toDate + b.constants.TIME.days(1);
    }
    var now  = Date.now();
    return {
      to:   to   == null ? now : to,
      from: from == null ? (now - b.constants.TIME.days(30)) : from,
    };
  }

  // Aggregate the report payload from the salesReports primitive. Composes
  // the by-day revenue series, AOV, refund rate, the status funnel, and the
  // top products into one object the HTML + CSV + JSON surfaces all read.
  async function _buildReport(win) {
    var byDay  = await salesReports.revenueByDay({ from: win.from, to: win.to });
    var aov    = await salesReports.aov({ from: win.from, to: win.to });
    var refund = await salesReports.refundRate({ from: win.from, to: win.to });
    var funnel = await salesReports.funnel({ from: win.from, to: win.to });
    var top    = await salesReports.topProducts({ from: win.from, to: win.to, limit: 10 });

    // Headline totals from the by-day series — gross/net/refunds summed
    // across every currency bucket in the window. The per-currency split
    // stays on the by-day rows for the operator who needs it; the headline
    // is the single-number summary a dashboard leads with.
    var orderCount = 0, gross = 0, net = 0, refunds = 0;
    var currency = (aov && aov.currency) || "USD";
    for (var i = 0; i < byDay.length; i += 1) {
      var row = byDay[i];
      orderCount += row.order_count;
      gross      += row.gross_revenue_minor;
      net        += row.net_revenue_minor;
      refunds    += row.refund_total_minor;
    }
    return {
      from:                win.from,
      to:                  win.to,
      currency:            currency,
      order_count:         orderCount,
      gross_revenue_minor: gross,
      net_revenue_minor:   net,
      refund_total_minor:  refunds,
      aov_minor:           (aov && aov.aov_minor) || 0,
      refund_rate_bps:     (refund && refund.refund_rate_bps) || 0,
      by_day:              byDay,
      by_status:           funnel,
      top_products:        (top && top.rows) || [],
    };
  }

  // CSV body for the by-day revenue series. Composes `b.csv.stringify`
  // (RFC 4180) — the cell values are integer aggregates + ISO date buckets
  // + 3-letter currency codes, all framework-internal (never raw
  // operator/customer prose), so the RFC-4180 quoting is sufficient here;
  // there is no untrusted free-text column that would require b.guardCsv's
  // formula-injection defenses.
  function _reportCsv(report) {
    var rows = report.by_day.map(function (r) {
      return {
        date:                r.bucket_start,
        currency:            r.currency,
        order_count:         r.order_count,
        gross_revenue_minor: r.gross_revenue_minor,
        net_revenue_minor:   r.net_revenue_minor,
        refund_total_minor:  r.refund_total_minor,
      };
    });
    return b.csv.stringify(rows, {
      columns: ["date", "currency", "order_count", "gross_revenue_minor", "net_revenue_minor", "refund_total_minor"],
      header:  true,
      eol:     "\n",
    });
  }

  router.get("/admin/reports", _pageOrApi(true,
    R(async function (req, res) {
      if (!salesReports) return _problem(res, 503, "reporting-unconfigured", "the salesReports primitive is not wired");
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      // A malformed from/to surfaces as a 400 problem (config/entry tier).
      var win;
      try { win = _reportWindow(url); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      var report;
      try { report = await _buildReport(win); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (url && url.searchParams.get("format") === "csv") {
        res.status(200);
        if (res.setHeader) {
          res.setHeader("content-type", "text/csv; charset=utf-8");
          res.setHeader("content-disposition", "attachment; filename=\"sales-report.csv\"");
        }
        var csv = _reportCsv(report);
        if (res.end) res.end(csv); else res.send(csv);
        return;
      }
      _json(res, 200, report);
    }),
    async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      if (!salesReports) {
        return _sendHtml(res, 200, renderAdminReports({
          shop_name: deps.shop_name, nav_available: navAvailable, report: null,
          notice: "Reporting isn't configured on this deployment.",
        }));
      }
      var win, notice = null;
      try { win = _reportWindow(url); }
      catch (e) {
        // Bad range → re-render with the default window + a correction
        // notice (config/entry tier: the operator fixes the typo).
        win = { to: Date.now(), from: Date.now() - b.constants.TIME.days(30) };
        notice = _safeNotice(e, "report.view").message.replace(/^admin:\s*/, "");
      }
      // CSV download from the browser surface too (a link, not a fetch).
      if (url && url.searchParams.get("format") === "csv") {
        var report0;
        try { report0 = await _buildReport(win); }
        catch (e2) { if (!(e2 instanceof TypeError)) throw e2; report0 = null; }
        if (report0) {
          res.status(200);
          if (res.setHeader) {
            res.setHeader("content-type", "text/csv; charset=utf-8");
            res.setHeader("content-disposition", "attachment; filename=\"sales-report.csv\"");
          }
          var csv0 = _reportCsv(report0);
          if (res.end) res.end(csv0); else res.send(csv0);
          return;
        }
      }
      var report;
      try { report = await _buildReport(win); }
      catch (e3) {
        win = { to: Date.now(), from: Date.now() - b.constants.TIME.days(30) };
        notice = _safeNotice(e3, "report.view").message.replace(/^salesReports:\s*/, "");
        report = await _buildReport(win);
      }
      _sendHtml(res, 200, renderAdminReports({
        shop_name: deps.shop_name, nav_available: navAvailable, report: report, notice: notice,
      }));
    },
  ));

  // ---- printable order documents --------------------------------------
  //
  // Operator-facing receipt + packing slip for an order. These are the
  // warehouse/fulfilment paper trail (the customer's own order page is a
  // separate storefront surface — untouched here). Each renders clean,
  // self-contained, print-optimized HTML the operator prints or pipes to a
  // PDF. Mounted only when the corresponding render primitive is wired.
  //
  // Failure modes: a malformed order id (TypeError from the primitive's id
  // reader) → 404; a missing order → 404. Only TypeError is swallowed to a
  // 404 — any other error propagates to the 500 path.

  // The receipt + packing-slip render primitives emit a self-contained
  // document driven purely by the order; the shop's own name + contact live
  // in shop_config, so we read them here and inject a small masthead at the
  // top of the document `<body>`. Both renderers emit a literal "<body>\n"
  // marker; the header slots in right after it. When config is unwired or
  // the keys are unset, the document renders without a masthead (the order
  // data alone is still a complete, valid document).
  async function _shopMastheadHtml() {
    if (!deps.config) return "";
    var name = null, contact = null;
    try {
      name = await deps.config.get("shop.name", deps.shop_name || null);
      // The setup wizard persists the operator's contact under
      // "shop.contact_email"; fall back to the conventional
      // "shop.support_email" key the config module documents.
      contact = await deps.config.get("shop.contact_email", null);
      if (contact == null) contact = await deps.config.get("shop.support_email", null);
    } catch (_e) {
      // Config read failure must not break the print document — degrade to
      // no masthead rather than 500-ing the operator's print job.
      return "";
    }
    if (!name && !contact) return "";
    var parts = "";
    if (name)    parts += "<strong>" + _htmlEscape(String(name)) + "</strong>";
    if (contact) parts += (name ? "<br>" : "") + _htmlEscape(String(contact));
    // Inline style is acceptable here: this document is served standalone
    // (not under the admin console's strict style-src CSP) and is built for
    // printing, where an external stylesheet round-trip is undesirable.
    return "<div style=\"margin-bottom:8mm;font-size:11pt;\">" + parts + "</div>\n";
  }

  function _injectMasthead(html, masthead) {
    if (!masthead) return html;
    var marker = "<body>\n";
    var at = html.indexOf(marker);
    if (at === -1) return html;                                  // renderer changed shape — emit the doc unaltered
    return html.slice(0, at + marker.length) + masthead + html.slice(at + marker.length);
  }

  if (printReceipts) {
    router.get("/admin/orders/:id/receipt", async function (req, res) {
      if (!_htmlAuthed(req, expectedToken)) {
        if (req.method === "GET" || !req.method) return _sendHtml(res, 200, renderAdminLogin({ shop_name: deps.shop_name }));
        return _problem(res, 401, "unauthorized");
      }
      var html;
      try {
        html = await printReceipts.htmlPdf({ order_id: req.params.id });
      } catch (e) {
        if (e instanceof TypeError) {
          return _sendHtml(res, 404, renderAdminOrders({
            shop_name: deps.shop_name, nav_available: navAvailable, orders: [], notice: "Order not found.",
          }));
        }
        // Record the real error server-side; return a generic 500 with no
        // detail so a renderer fault never echoes its internals to the client.
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.receipt.error", outcome: "failure", metadata: { message: (e && e.message) || String(e) } });
        return _problem(res, 500, "internal-error");
      }
      _sendHtml(res, 200, _injectMasthead(html, await _shopMastheadHtml()));
    });
  }

  if (packingSlips) {
    router.get("/admin/orders/:id/packing-slip", async function (req, res) {
      if (!_htmlAuthed(req, expectedToken)) {
        if (req.method === "GET" || !req.method) return _sendHtml(res, 200, renderAdminLogin({ shop_name: deps.shop_name }));
        return _problem(res, 401, "unauthorized");
      }
      var html;
      try {
        html = await packingSlips.renderHtml({ order_id: req.params.id });
      } catch (e) {
        if (e instanceof TypeError) {
          return _sendHtml(res, 404, renderAdminOrders({
            shop_name: deps.shop_name, nav_available: navAvailable, orders: [], notice: "Order not found.",
          }));
        }
        // Record the real error server-side; return a generic 500 with no
        // detail so a renderer fault never echoes its internals to the client.
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.packing_slip.error", outcome: "failure", metadata: { message: (e && e.message) || String(e) } });
        return _problem(res, 500, "internal-error");
      }
      _sendHtml(res, 200, _injectMasthead(html, await _shopMastheadHtml()));
    });
  }

  // ---- analytics ------------------------------------------------------

  var analytics = deps.analytics || null;
  if (analytics) {
    function _parseWindow(url) {
      var since = _parseEpochMs(url && url.searchParams.get("since"), "since");
      var until = _parseEpochMs(url && url.searchParams.get("until"), "until");
      var w = {};
      if (since != null) w.since = since;
      if (until != null) w.until = until;
      return w;
    }

    router.get("/admin/analytics/summary", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var summary = await analytics.summary(_parseWindow(url));
      _json(res, 200, summary);
    }));

    router.get("/admin/analytics/revenue-by-day", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var rows = await analytics.revenueByDay(_parseWindow(url));
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/analytics/top-skus", R(async function (req, res) {
      var url   = req.url ? new URL(req.url, "http://localhost") : null;
      var w     = _parseWindow(url);
      w.limit   = _parseLimit(url && url.searchParams.get("limit"), "limit", 100, 10);
      var rows  = await analytics.topSKUs(w);
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/analytics/recent-orders", R(async function (req, res) {
      var url  = req.url ? new URL(req.url, "http://localhost") : null;
      var lim  = _parseLimit(url && url.searchParams.get("limit"), "limit", 100, 20);
      var rows = await analytics.recentOrders({ limit: lim });
      _json(res, 200, { rows: rows });
    }));

    // HTML page — accepts the admin browser cookie OR the bearer token,
    // so it's reachable both from a signed-in browser and from tooling.
    router.get("/admin/dashboard", async function (req, res) {
      if (!_htmlAuthed(req, expectedToken)) {
        return _sendHtml(res, 200, renderAdminLogin({ shop_name: deps.shop_name }));
      }
      var url     = req.url ? new URL(req.url, "http://localhost") : null;
      var w       = _parseWindow(url);
      var summary = await analytics.summary(w);
      var byDay   = await analytics.revenueByDay(w);
      var top     = await analytics.topSKUs(Object.assign({}, w, { limit: 10 }));
      var recent  = await analytics.recentOrders({ limit: 20 });
      _sendHtml(res, 200, renderDashboard({
        summary:    summary,
        by_day:     byDay,
        top_skus:   top,
        recent:     recent,
        shop_name:  (deps.shop_name || "blamejs.shop"),
        nav_available: navAvailable,
      }));
    });
  }

  // ---- subscriptions --------------------------------------------------

  var subscriptions = deps.subscriptions || null;
  if (subscriptions) {
    // Coerce the edit form into a plans.update patch. Only the mutable
    // columns are forwarded; an absent / blank field is omitted so a
    // partial edit leaves the rest untouched. amount_minor /
    // interval_count / trial_days go through the strict integer reader so
    // "", a float, or "12abc" is refused as a clean 400 rather than
    // coerced. active rides a hidden presence marker so a value-only edit
    // doesn't flip it. variant_id="" links the plan to no variant
    // (standalone); the immutable Stripe-bound columns are never on the
    // form.
    function _subscriptionPlanPatchFromForm(body) {
      body = body || {};
      var patch = {};
      if (body.amount_minor   != null && body.amount_minor   !== "") patch.amount_minor   = _strictMinorInt(body.amount_minor, "subscriptions", "amount_minor (minor units)");
      if (body.interval_count != null && body.interval_count !== "") patch.interval_count = _strictMinorInt(body.interval_count, "subscriptions", "interval_count");
      if (body.trial_days     != null && body.trial_days     !== "") patch.trial_days     = _strictMinorInt(body.trial_days, "subscriptions", "trial_days");
      if (body.active_present === "1") patch.active = (body.active === "on" || body.active === "1");
      if (Object.prototype.hasOwnProperty.call(body, "variant_id")) {
        var vid = typeof body.variant_id === "string" ? body.variant_id.trim() : body.variant_id;
        patch.variant_id = vid ? vid : null;
      }
      return patch;
    }

    // Create content-negotiates: bearer → JSON (unchanged for tooling);
    // signed-in browser form → create, then PRG back to the catalog (a
    // bad-shape submit re-renders the form with the validator's message
    // rather than 500-ing).
    router.post("/admin/subscription-plans", _pageOrApi(false,
      W("subscription_plan.create", async function (req, res) {
        var p = await subscriptions.plans.create(req.body || {});
        _json(res, 201, p);
        return p;
      }),
      async function (req, res) {
        var body = req.body || {};
        var input = {
          stripe_price_id: typeof body.stripe_price_id === "string" ? body.stripe_price_id.trim() : body.stripe_price_id,
          interval:        body.interval,
          currency:        typeof body.currency === "string" ? body.currency.trim().toLowerCase() : body.currency,
        };
        if (body.amount_minor   != null && body.amount_minor   !== "") input.amount_minor   = _strictMinorInt(body.amount_minor, "subscriptions", "amount_minor (minor units)");
        if (body.interval_count != null && body.interval_count !== "") input.interval_count = _strictMinorInt(body.interval_count, "subscriptions", "interval_count");
        if (body.trial_days     != null && body.trial_days     !== "") input.trial_days     = _strictMinorInt(body.trial_days, "subscriptions", "trial_days");
        if (body.variant_id) input.variant_id = String(body.variant_id).trim();
        try {
          await subscriptions.plans.create(input);
        } catch (e) {
          var n = _safeNotice(e, "subscription_plan.create");
          var rows = await subscriptions.plans.list({});
          return _sendHtml(res, n.status, renderAdminSubscriptionPlans({
            shop_name: deps.shop_name, nav_available: navAvailable, plans: rows,
            notice: n.message.replace(/^subscriptions[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".subscription_plan.create", outcome: "success" });
        _redirect(res, "/admin/subscription-plans?created=1");
      },
    ));

    router.get("/admin/subscription-plans", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var variantId = url && url.searchParams.get("variant_id");
        var activeS   = url && url.searchParams.get("active");
        var filter = {};
        if (variantId) filter.variant_id = variantId;
        if (activeS != null) filter.active = activeS === "1" || activeS === "true";
        var rows = await subscriptions.plans.list(filter);
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeS = url && url.searchParams.get("active");
        var filter = {};
        if (activeS === "1" || activeS === "true")  filter.active = true;
        else if (activeS === "0" || activeS === "false") filter.active = false;
        var rows = await subscriptions.plans.list(filter);
        _sendHtml(res, 200, renderAdminSubscriptionPlans({
          shop_name: deps.shop_name, nav_available: navAvailable, plans: rows,
          active_filter: activeS,
          created:  url && url.searchParams.get("created"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the plan." : null,
        }));
      },
    ));

    // Detail screen content-negotiates: bearer → the JSON plan (the
    // tooling contract, unchanged); browser cookie → the rendered detail
    // + edit page. A malformed / unknown id is a 404 either way, never a
    // 500. (Previously this route was bearer-JSON-only, so the console
    // had no way to change a plan's price / interval-count / trial after
    // create — only archive-and-recreate against a fresh Stripe price.)
    router.get("/admin/subscription-plans/:id", _pageOrApi(true,
      R(async function (req, res) {
        var p;
        try { p = await subscriptions.plans.get(req.params.id); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "subscription-plan-not-found", e.message); throw e; }
        if (!p) return _problem(res, 404, "subscription-plan-not-found");
        _json(res, 200, p);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var p = null;
        try { p = await subscriptions.plans.get(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; p = null; }
        if (!p) return _sendHtml(res, 404, renderAdminSubscriptionPlans({
          shop_name: deps.shop_name, nav_available: navAvailable, plans: [], notice: "Subscription plan not found.",
        }));
        _sendHtml(res, 200, renderAdminSubscriptionPlan({
          shop_name: deps.shop_name, nav_available: navAvailable, plan: p,
          updated: url && url.searchParams.get("updated"),
          notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed for the plan." : null,
        }));
      },
    ));

    router.patch("/admin/subscription-plans/:id", W("subscription_plan.update", async function (req, res) {
      var p;
      try { p = await subscriptions.plans.update(req.params.id, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!p) return _problem(res, 404, "subscription-plan-not-found");
      _json(res, 200, p);
      return p;
    }));

    // Browser edit alias for the PATCH (HTML forms can't PATCH). Forwards
    // the mutable columns — amount / interval_count / trial_days / active
    // / variant_id — through plans.update; the immutable Stripe-bound
    // columns (stripe_price_id / interval / currency) are not on the form
    // (changing those is archive-and-recreate). A bad value is a clean
    // 400 (bearer) / err notice (browser), never a 500 or partial write.
    router.post("/admin/subscription-plans/:id/edit", _pageOrApi(false,
      W("subscription_plan.update", async function (req, res) {
        var p;
        try { p = await subscriptions.plans.update(req.params.id, _subscriptionPlanPatchFromForm(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!p) return _problem(res, 404, "subscription-plan-not-found");
        _json(res, 200, p);
        return p;
      }),
      async function (req, res) {
        var id = req.params.id;
        var enc = encodeURIComponent(id);
        var updated = null;
        try { updated = await subscriptions.plans.update(id, _subscriptionPlanPatchFromForm(req.body || {})); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/subscription-plans/" + enc + "?err=1"); }
        // A well-formed-but-unknown id (stale / tampered form) updates no
        // row — plans.update returns null. Flag err, never a false success.
        if (!updated) return _redirect(res, "/admin/subscription-plans/" + enc + "?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".subscription_plan.update", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/subscription-plans/" + enc + "?updated=1");
      },
    ));

    // Browser confirmation interstitial for archive — terminal from the
    // console (a retired plan is replaced by creating a new one against a
    // fresh Stripe price id, never reactivated in place), so confirm it.
    router.post("/admin/subscription-plans/:id/archive/confirm", _pageOrApi(false,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/subscription-plans/:id/archive directly for the JSON API");
      }),
      async function (req, res) {
        var id = req.params.id;
        var p = null;
        try { p = await subscriptions.plans.get(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!p) return _redirect(res, "/admin/subscription-plans?err=1");
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "subscriptions",
          heading: "Archive this plan?",
          consequence: "Archiving is terminal — this plan cannot be reactivated. To offer it again you create a new plan against a fresh Stripe price id.",
          detail: "Existing subscriptions on this plan are unaffected; new sign-ups can no longer select it.",
          action: "/admin/subscription-plans/" + _htmlEscape(id) + "/archive",
          confirm_label: "Archive plan",
          cancel_href: "/admin/subscription-plans",
        }));
      },
    ));

    // Archive content-negotiates: bearer → JSON; browser form → archive,
    // then PRG. An unknown / malformed id is a no-op notice (?err=1),
    // never a 500.
    router.post("/admin/subscription-plans/:id/archive", _pageOrApi(false,
      W("subscription_plan.archive", async function (req, res) {
        var p = await subscriptions.plans.archive(req.params.id);
        if (!p) return _problem(res, 404, "subscription-plan-not-found");
        _json(res, 200, p);
        return p;
      }),
      async function (req, res) {
        var p = null;
        try { p = await subscriptions.plans.archive(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!p) return _redirect(res, "/admin/subscription-plans?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".subscription_plan.archive", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, "/admin/subscription-plans?archived=1");
      },
    ));

    router.get("/admin/subscriptions", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var customerId = url && url.searchParams.get("customer_id");
      var status     = url && url.searchParams.get("status");
      var filter = {};
      if (customerId) filter.customer_id = customerId;
      if (status)     filter.status = status;
      var rows = await subscriptions.subscriptions.list(filter);
      _json(res, 200, { rows: rows });
    }));

    router.get("/admin/subscriptions/:id", R(async function (req, res) {
      var s = await subscriptions.subscriptions.get(req.params.id);
      if (!s) return _problem(res, 404, "subscription-not-found");
      _json(res, 200, s);
    }));

    // Cancelling composes the Stripe API (payment.subscriptions.cancel),
    // so the route only mounts when a payment handle is wired — exactly
    // like the refund routes. Without Stripe it stays unmounted (404
    // "feature unavailable") rather than 400-ing with internal error
    // text when the handler dereferences a null payment. Plan CRUD and
    // the read-only instance views above need no Stripe and always mount.
    if (payment) {
      router.post("/admin/subscriptions/:id/cancel", W("subscription.cancel", async function (req, res) {
        var body = req.body || {};
        var s = await subscriptions.subscriptions.cancel(req.params.id, { at_period_end: !!body.at_period_end });
        if (!s) return _problem(res, 404, "subscription-not-found");
        _json(res, 200, s);
        return s;
      }));
    }
  }

  // ---- gift cards -----------------------------------------------------
  //
  // The ledger console: list issued cards (masked by code_hint + the
  // original/remaining balance + status), drill into one card's ledger
  // transactions (issue / redeem / adjust), and — when the ledger is
  // wired — issue a new card from the console. The bearer JSON contract
  // is unchanged; the signed-in browser session gets the rendered page.
  // `giftcards` owns the card rows; `giftCardLedger` (optional) owns the
  // append-only transaction history shown on the detail view.
  var giftcards     = deps.giftcards || null;
  var giftCardLedger = deps.giftCardLedger || null;
  if (giftcards) {
    // Issue a card. Bearer → JSON (the issued plaintext code is
    // returned ONCE for the operator to deliver); browser form →
    // issue, then render the detail page DIRECTLY from this POST 200
    // with the plaintext code passed in-body. We deliberately do NOT
    // redirect with the code on the query string — the one-time bearer
    // code must never land in a URL / Location header / browser
    // history / access log (mirrors renderAdminWebhookSecret).
    router.post("/admin/gift-cards", _pageOrApi(false,
      W("gift_card.issue", async function (req, res) {
        var issued = await _issueGiftCard(req.body || {});
        _json(res, 201, issued);
        return { id: issued.id };
      }),
      async function (req, res) {
        var issued;
        try {
          issued = await _issueGiftCard(req.body || {});
        } catch (e) {
          var n = _safeNotice(e, "gift_card.issue");
          var rows = await giftcards.list({});
          return _sendHtml(res, n.status, renderAdminGiftCards({
            shop_name: deps.shop_name, nav_available: navAvailable, cards: rows,
            notice: n.message.replace(/^giftcards?[.:]\s*/i, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".gift_card.issue", outcome: "success", metadata: { id: issued.id } });
        // Stash the one-time code in a sealed cookie and 303-redirect to the
        // card's detail page (PRG: a refresh can't re-issue). The detail GET
        // reveals + clears the code; it never travels in the URL.
        _stashGiftCardReveal(res, issued.id, issued.code);
        _redirect(res, "/admin/gift-cards/" + encodeURIComponent(issued.id));
      },
    ));

    router.get("/admin/gift-cards", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = url && url.searchParams.get("status");
        var rows = await giftcards.list(status ? { status: status } : {});
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var status = url && url.searchParams.get("status");
        var rows = await giftcards.list(status ? { status: status } : {});
        _sendHtml(res, 200, renderAdminGiftCards({
          shop_name: deps.shop_name, nav_available: navAvailable, cards: rows,
          status_filter: status,
          ledger_enabled: !!giftCardLedger,
        }));
      },
    ));

    router.get("/admin/gift-cards/:id", _pageOrApi(true,
      R(async function (req, res) {
        var card = await giftcards.getById(req.params.id);
        if (!card) return _problem(res, 404, "gift-card-not-found");
        var history = [];
        if (giftCardLedger) {
          try { history = (await giftCardLedger.history(req.params.id, { limit: 500 })).rows; }
          catch (e) { if (!(e instanceof TypeError)) throw e; }
        }
        _json(res, 200, { card: card, ledger: history });
      }),
      async function (req, res) {
        var card = await giftcards.getById(req.params.id);
        if (!card) {
          return _sendHtml(res, 404, renderAdminGiftCard({
            shop_name: deps.shop_name, nav_available: navAvailable, card: null,
          }));
        }
        // One-time reveal: if this GET follows a fresh issue (sealed
        // `gc_reveal` cookie present for this id), show the plaintext code
        // once and clear the cookie. A subsequent reload reveals nothing —
        // the code never lands in the URL / history / access log.
        var issuedCode = _takeGiftCardReveal(req, res, req.params.id);
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var history = [];
        if (giftCardLedger) {
          try { history = (await giftCardLedger.history(req.params.id, { limit: 500 })).rows; }
          catch (e) { if (!(e instanceof TypeError)) throw e; }
        }
        _sendHtml(res, 200, renderAdminGiftCard({
          shop_name: deps.shop_name, nav_available: navAvailable, card: card,
          ledger: history, issued_code: issuedCode || undefined,
          voided: !!(url && url.searchParams.get("voided")),
          notice: (url && url.searchParams.get("err")) ? "That action couldn't be completed for this card." : null,
        }));
      },
    ));

    // Browser confirmation interstitial for void — voiding revokes a
    // money instrument (the remaining balance can no longer be redeemed),
    // so the console confirms before the real POST. Bearer clients skip
    // this and POST .../void directly (mirrors the webhook delete pattern).
    router.post("/admin/gift-cards/:id/void/confirm", _pageOrApi(false,
      R(async function (_req, res) {
        return _problem(res, 405, "use-canonical-endpoint", "POST /admin/gift-cards/:id/void directly for the JSON API");
      }),
      async function (req, res) {
        var card = await giftcards.getById(req.params.id);
        if (!card) return _redirect(res, "/admin/gift-cards?err=1");
        if (card.status !== "active") return _redirect(res, "/admin/gift-cards/" + encodeURIComponent(req.params.id) + "?err=1");
        var cur = String(card.currency || "").toUpperCase();
        _sendHtml(res, 200, renderAdminConfirm({
          shop_name: deps.shop_name, nav_available: navAvailable, active: "giftcards",
          heading: "Void this gift card?",
          consequence: "Voiding is permanent — the remaining balance can no longer be redeemed at checkout.",
          detail: "Card ••••" + card.code_hint + " with " + pricing.format(card.balance_minor, cur) + " remaining will be voided.",
          action: "/admin/gift-cards/" + _htmlEscape(req.params.id) + "/void",
          confirm_label: "Void card",
          cancel_href: "/admin/gift-cards/" + encodeURIComponent(req.params.id),
        }));
      },
    ));

    // Void a card. Bearer → JSON (the voided row); browser form → void,
    // then PRG back to the card's detail page. `void` is idempotent on an
    // already-voided card and refuses a fully-redeemed one; both surfaces
    // translate that to a 4xx / err flag rather than a 500.
    router.post("/admin/gift-cards/:id/void", _pageOrApi(false,
      W("gift_card.void", async function (req, res) {
        var card;
        try { card = await giftcards.void(req.params.id, { reason: (req.body && req.body.reason) || undefined }); }
        catch (e) {
          if (e && e.code === "GIFTCARD_ALREADY_REDEEMED") return _problem(res, 409, "gift-card-redeemed", e.message);
          throw e;
        }
        if (!card) return _problem(res, 404, "gift-card-not-found");
        _json(res, 200, card);
        return { id: card.id };
      }),
      async function (req, res) {
        var card = null;
        try { card = await giftcards.void(req.params.id, { reason: (req.body && req.body.reason) || undefined }); }
        catch (e) {
          if (e && e.code === "GIFTCARD_ALREADY_REDEEMED") return _redirect(res, "/admin/gift-cards/" + encodeURIComponent(req.params.id) + "?err=1");
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/gift-cards?err=1");
        }
        if (!card) return _redirect(res, "/admin/gift-cards?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".gift_card.void", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, "/admin/gift-cards/" + encodeURIComponent(req.params.id) + "?voided=1");
      },
    ));
  }

  // Issue a card from operator input, recording the opening balance as
  // a `manual` credit in the ledger (when wired) so the transaction
  // history starts from the issuance event. Strict integer parsing of
  // the amount; the giftcards primitive enforces the rest.
  async function _issueGiftCard(body) {
    var input = { currency: typeof body.currency === "string" ? body.currency.trim().toUpperCase() : body.currency };
    // The giftcards primitive only shape-checks the currency (/^[A-Z]{3}$/),
    // so a well-formed-but-nonexistent code like "ZZZ" would issue a card in
    // a currency the rest of the shop can't price. Validate against the
    // framework's ISO 4217 catalog (the same b.money.CURRENCIES surface the
    // currency-rounding + display primitives compose) and refuse unknown
    // codes with a clean 400.
    textGuard.currencyCode(input.currency, "giftcards: currency");
    if (body.amount_minor != null && body.amount_minor !== "") {
      input.amount_minor = _strictMinorInt(body.amount_minor, "giftcards", "amount_minor (minor units)");
    }
    if (body.issued_to_email) input.issued_to_email = String(body.issued_to_email).trim();
    if (body.expires_at != null && body.expires_at !== "") {
      input.expires_at = _strictMinorInt(body.expires_at, "giftcards", "expires_at (epoch-ms)");
    }
    var issued = await giftcards.issue(input);
    if (giftCardLedger) {
      // Opening credit so the ledger history starts from issuance.
      // Best-effort: a ledger write failure must not lose the issued
      // card (the card row + plaintext code already exist) — the
      // operator can reconcile, and the card balance is authoritative
      // on the card row. Swallow only the ledger fault.
      try {
        await giftCardLedger.credit({
          gift_card_id: issued.id,
          amount_minor: input.amount_minor,
          source:       "manual",
          source_ref:   "admin-issue",
        });
      } catch (_e) { /* drop-silent — card issued; ledger seed is advisory */ }
    }
    return issued;
  }

  // ---- tax rates ------------------------------------------------------
  //
  // Operator-managed per-jurisdiction rate table. `defineRate` keys on a
  // (jurisdiction, category, effective window) tuple; the console lists
  // by jurisdiction, creates a rate, edits the mutable columns (rate_bps
  // / effective_until / source), and archives. `bulkImport` is an
  // API-only path (operators hydrate a paid-feed snapshot from a script);
  // it has no console form because authoring dozens of rows by hand isn't
  // a console gesture — the single-rate create covers operator-by-hand
  // entry and the feed importer uses the bearer JSON surface.
  var taxRates = deps.taxRates || null;
  if (taxRates) {
    router.post("/admin/tax-rates", _pageOrApi(false,
      W("tax_rate.create", async function (req, res) {
        var rate = await taxRates.defineRate(_taxRateInput(req.body || {}));
        _json(res, 201, rate);
        return { id: rate.id };
      }),
      async function (req, res) {
        var body = req.body || {};
        var jurisdiction = typeof body.jurisdiction === "string" ? body.jurisdiction.trim().toUpperCase() : body.jurisdiction;
        try {
          await taxRates.defineRate(_taxRateInput(body));
        } catch (e) {
          // The primitive's overlap code carries an operator-safe message;
          // everything else routes through the shared classifier so a raw
          // constraint / parser / unknown error can't reach the banner.
          var overlap = e && e.code === "TAX_RATE_OVERLAP";
          var n = overlap ? { status: 400, message: (e.message || "").replace(/^taxRates[.:]\s*/, "") }
                          : _safeNotice(e, "tax_rate.create");
          var noticeMsg = overlap ? n.message : n.message.replace(/^taxRates[.:]\s*/, "");
          var rows = await _taxRatesForBrowser(jurisdiction);
          return _sendHtml(res, n.status, renderAdminTaxRates({
            shop_name: deps.shop_name, nav_available: navAvailable, rates: rows,
            jurisdiction: jurisdiction, sources: taxRates.SOURCES,
            notice: noticeMsg,
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".tax_rate.create", outcome: "success" });
        _redirect(res, "/admin/tax-rates?jurisdiction=" + encodeURIComponent(jurisdiction) + "&created=1");
      },
    ));

    router.get("/admin/tax-rates", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var j = url && url.searchParams.get("jurisdiction");
        if (!j) return _json(res, 200, { rows: [] });
        var includeExpired = url && url.searchParams.get("include_expired") === "1";
        var rows = await taxRates.listForJurisdiction({ jurisdiction: j, include_expired: includeExpired });
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var j = url && url.searchParams.get("jurisdiction");
        var jurisdiction = j ? String(j).trim().toUpperCase() : null;
        var rows = await _taxRatesForBrowser(jurisdiction);
        _sendHtml(res, 200, renderAdminTaxRates({
          shop_name: deps.shop_name, nav_available: navAvailable, rates: rows,
          jurisdiction: jurisdiction, sources: taxRates.SOURCES,
          created:  url && url.searchParams.get("created"),
          updated:  url && url.searchParams.get("updated"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the rate." : null,
        }));
      },
    ));

    // Patch the mutable columns (rate_bps / effective_until / source).
    router.patch("/admin/tax-rates/:id", W("tax_rate.update", async function (req, res) {
      var rate;
      try { rate = await taxRates.updateRate(req.params.id, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!rate) return _problem(res, 404, "tax-rate-not-found");
      _json(res, 200, rate);
      return { id: rate.id };
    }));

    // Browser POST alias for the edit (HTML can't PATCH). Re-aims at the
    // rate's jurisdiction list on success / failure.
    router.post("/admin/tax-rates/:id/edit", _pageOrApi(false,
      W("tax_rate.update", async function (req, res) {
        var rate;
        try { rate = await taxRates.updateRate(req.params.id, _taxRatePatch(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!rate) return _problem(res, 404, "tax-rate-not-found");
        _json(res, 200, rate);
        return { id: rate.id };
      }),
      async function (req, res) {
        var body = req.body || {};
        var enc = "/admin/tax-rates" + (body.jurisdiction ? "?jurisdiction=" + encodeURIComponent(String(body.jurisdiction).trim().toUpperCase()) : "");
        var rate = null;
        try { rate = await taxRates.updateRate(req.params.id, _taxRatePatch(body)); }
        catch (e) { if (!(e instanceof TypeError) && e.code !== "TAX_RATE_OVERLAP" && e.code !== "TAX_RATE_ARCHIVED") throw e; }
        if (!rate) return _redirect(res, enc + (enc.indexOf("?") === -1 ? "?" : "&") + "err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".tax_rate.update", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, enc + (enc.indexOf("?") === -1 ? "?" : "&") + "updated=1");
      },
    ));

    router.delete("/admin/tax-rates/:id", W("tax_rate.archive", async function (req, res) {
      var rate;
      try { rate = await taxRates.archiveRate(req.params.id, {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!rate) return _problem(res, 404, "tax-rate-not-found");
      _json(res, 200, rate);
      return { id: rate.id };
    }));

    router.post("/admin/tax-rates/:id/archive", _pageOrApi(false,
      W("tax_rate.archive", async function (req, res) {
        var rate;
        try { rate = await taxRates.archiveRate(req.params.id, {}); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!rate) return _problem(res, 404, "tax-rate-not-found");
        _json(res, 200, rate);
        return { id: rate.id };
      }),
      async function (req, res) {
        var body = req.body || {};
        var enc = "/admin/tax-rates" + (body.jurisdiction ? "?jurisdiction=" + encodeURIComponent(String(body.jurisdiction).trim().toUpperCase()) : "");
        var rate = null;
        try { rate = await taxRates.archiveRate(req.params.id, {}); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!rate) return _redirect(res, enc + (enc.indexOf("?") === -1 ? "?" : "&") + "err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".tax_rate.archive", outcome: "success", metadata: { id: req.params.id } });
        _redirect(res, enc + (enc.indexOf("?") === -1 ? "?" : "&") + "archived=1");
      },
    ));
  }

  // ---- sales tax filings ----------------------------------------------
  //
  // Post-checkout remittance bookkeeping. Each row aggregates completed
  // orders that fell inside a filing window for one jurisdiction, then
  // walks the lifecycle the authority expects: draft → computed (the
  // aggregation snapshot) → submitted (filed) → paid (remittance cleared),
  // with an amend path for a correction. The console never touches cart /
  // checkout / order pricing — it reads orders the storefront already
  // wrote. A missing sales_tax_filings table only surfaces when a route
  // reads it (degrades to a notice), never at boot.
  if (salesTaxFilings) {
    // Translate a create form / JSON body into a defineFilingPeriod input.
    // The four window fields are epoch-ms; strict integer parsing so a
    // typo is a 400, never a silent zero.
    function _filingPeriodInput(body) {
      return {
        jurisdiction: typeof body.jurisdiction === "string" ? body.jurisdiction.trim().toUpperCase() : body.jurisdiction,
        kind:         typeof body.kind === "string" ? body.kind.trim() : body.kind,
        period_start: _strictMinorInt(body.period_start, "salesTaxFilings", "period_start (epoch-ms)"),
        period_end:   _strictMinorInt(body.period_end,   "salesTaxFilings", "period_end (epoch-ms)"),
        due_date:     _strictMinorInt(body.due_date,     "salesTaxFilings", "due_date (epoch-ms)"),
      };
    }

    // Build the list-screen model: the filtered filings, the upcoming-due
    // strip, and the filter values echoed back into the form. A malformed
    // filter (bad jurisdiction / status) throws TypeError in the primitive
    // — map it to an empty list so the page renders the notice, never 500.
    async function _filingsForBrowser(filter) {
      try { return await salesTaxFilings.listFilings(filter); }
      catch (e) { if (e instanceof TypeError) return []; throw e; }
    }
    async function _upcomingForBrowser() {
      try { return await salesTaxFilings.upcomingDue({ days_ahead: 30 }); }
      catch (e) { if (e instanceof TypeError) return []; throw e; }
    }

    router.get("/admin/tax-filings", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var filter = {};
        var j = url && url.searchParams.get("jurisdiction");
        var s = url && url.searchParams.get("status");
        if (j) filter.jurisdiction = String(j).trim().toUpperCase();
        if (s) filter.status = String(s).trim();
        var rows;
        try { rows = await salesTaxFilings.listFilings(filter); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var j = url && url.searchParams.get("jurisdiction");
        var s = url && url.searchParams.get("status");
        var jurisdiction = j ? String(j).trim().toUpperCase() : null;
        var status       = s ? String(s).trim() : null;
        var filter = {};
        if (jurisdiction) filter.jurisdiction = jurisdiction;
        if (status)       filter.status = status;
        var rows     = await _filingsForBrowser(filter);
        var upcoming = await _upcomingForBrowser();
        _sendHtml(res, 200, renderAdminTaxFilings({
          shop_name: deps.shop_name, nav_available: navAvailable,
          filings: rows, upcoming: upcoming,
          jurisdiction: jurisdiction, status_filter: status,
          kinds: salesTaxFilings.KINDS, statuses: salesTaxFilings.STATUSES,
          created:  url && url.searchParams.get("created"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the filing." : null,
        }));
      },
    ));

    // Open a filing period → draft row. A duplicate (jurisdiction, kind,
    // period_start) is refused by the primitive's UNIQUE index; surface it
    // as a 400 notice rather than a 500.
    router.post("/admin/tax-filings", _pageOrApi(false,
      W("tax_filing.create", async function (req, res) {
        var filing;
        try { filing = await salesTaxFilings.defineFilingPeriod(_filingPeriodInput(req.body || {})); }
        catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          if (e.code === "SALES_TAX_FILING_DUPLICATE") return _problem(res, 409, "filing-duplicate", e.message);
          throw e;
        }
        _json(res, 201, filing);
        return { id: filing.id };
      }),
      async function (req, res) {
        var filing;
        try { filing = await salesTaxFilings.defineFilingPeriod(_filingPeriodInput(req.body || {})); }
        catch (e) {
          // The primitive's own duplicate-period code carries an operator-safe
          // message (a named UNIQUE index, no raw SQL); everything else routes
          // through the shared classifier so a raw constraint / parser / unknown
          // error can't reach the banner.
          var dup = e && e.code === "SALES_TAX_FILING_DUPLICATE";
          var n   = dup ? { status: 400, message: (e.message || "").replace(/^salesTaxFilings[.:]\s*/, "") }
                        : _safeNotice(e, "tax_filing.create");
          var noticeMsg = dup ? n.message : n.message.replace(/^salesTaxFilings[.:]\s*/, "");
          var rows     = await _filingsForBrowser({});
          var upcoming = await _upcomingForBrowser();
          return _sendHtml(res, n.status, renderAdminTaxFilings({
            shop_name: deps.shop_name, nav_available: navAvailable,
            filings: rows, upcoming: upcoming,
            kinds: salesTaxFilings.KINDS, statuses: salesTaxFilings.STATUSES,
            notice: noticeMsg,
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".tax_filing.create", outcome: "success", metadata: { id: filing.id } });
        _redirect(res, "/admin/tax-filings/" + encodeURIComponent(filing.id) + "?created=1");
      },
    ));

    // Per-jurisdiction remittance report over a [from, to] window. GET so
    // the window lives in the URL (bookmarkable). A bad / missing range is
    // a notice on the list page, not a 500.
    router.get("/admin/tax-filings/report", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var j = url && url.searchParams.get("jurisdiction");
        if (!j) return _problem(res, 400, "bad-request", "jurisdiction required");
        var from = _parseEpochMs(url && url.searchParams.get("from"), "from");
        var to   = _parseEpochMs(url && url.searchParams.get("to"),   "to");
        if (from == null || to == null) return _problem(res, 400, "bad-request", "from and to (epoch-ms) required");
        var report;
        try { report = await salesTaxFilings.auditReportForJurisdiction({ jurisdiction: String(j).trim().toUpperCase(), from: from, to: to }); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, report);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var j = url && url.searchParams.get("jurisdiction");
        var jurisdiction = j ? String(j).trim().toUpperCase() : null;
        // Parse the window defensively — a present-but-malformed epoch throws
        // TypeError; treat it as unset so the window notice guides the operator
        // (a bad range is a notice on this page, never a 500).
        var from = null, to = null;
        try {
          from = _parseEpochMs(url && url.searchParams.get("from"), "from");
          to   = _parseEpochMs(url && url.searchParams.get("to"),   "to");
        } catch (e) { if (!(e instanceof TypeError)) throw e; }
        var report = null, notice = null;
        if (!jurisdiction) {
          notice = "Enter a jurisdiction and a window to run a remittance report.";
        } else if (from == null || to == null) {
          notice = "Enter both a from and a to date (epoch-ms) for the report window.";
        } else {
          try { report = await salesTaxFilings.auditReportForJurisdiction({ jurisdiction: jurisdiction, from: from, to: to }); }
          catch (e) { notice = _safeNotice(e, "tax_filing.report").message.replace(/^salesTaxFilings[.:]\s*/, ""); }
        }
        _sendHtml(res, 200, renderAdminTaxFilingReport({
          shop_name: deps.shop_name, nav_available: navAvailable,
          report: report, jurisdiction: jurisdiction, notice: notice,
        }));
      },
    ));

    async function _filingDetailModel(id) {
      return await salesTaxFilings.getFiling(id);
    }

    router.get("/admin/tax-filings/:id", _pageOrApi(true,
      R(async function (req, res) {
        var filing;
        try { filing = await _filingDetailModel(req.params.id); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "filing-not-found", e.message); throw e; }
        if (!filing) return _problem(res, 404, "filing-not-found");
        _json(res, 200, filing);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var filing;
        try { filing = await _filingDetailModel(req.params.id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; filing = null; }
        if (!filing) return _sendHtml(res, 404, renderAdminTaxFilings({
          shop_name: deps.shop_name, nav_available: navAvailable,
          filings: [], upcoming: [], kinds: salesTaxFilings.KINDS, statuses: salesTaxFilings.STATUSES,
          notice: "Filing not found.",
        }));
        _sendHtml(res, 200, renderAdminTaxFiling({
          shop_name: deps.shop_name, nav_available: navAvailable, filing: filing,
          computed: url && url.searchParams.get("computed"),
          created:  url && url.searchParams.get("created"),
          submitted: url && url.searchParams.get("submitted"),
          paid:     url && url.searchParams.get("paid"),
          amended:  url && url.searchParams.get("amended"),
          notice:   (url && url.searchParams.get("err"))
            ? String(url.searchParams.get("err_msg") || "That action couldn't be completed for the filing.")
            : null,
        }));
      },
    ));

    // Lifecycle transitions — each is a browser POST that PRGs back to the
    // detail. A bad transition (wrong status) or bad input is a ?err notice
    // on the detail page, never a 500. The bearer JSON contract returns the
    // updated filing (or a problem document).
    function _filingActionRoute(suffix, audit, okParam, run) {
      router.post("/admin/tax-filings/:id/" + suffix, _pageOrApi(false,
        W("tax_filing." + audit, async function (req, res) {
          var filing;
          try { filing = await run(req.params.id, req.body || {}); }
          catch (e) {
            if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
            if (e.code === "SALES_TAX_FILING_NOT_FOUND") return _problem(res, 404, "filing-not-found", e.message);
            if (e.code === "SALES_TAX_FILING_BAD_TRANSITION") return _problem(res, 409, "filing-bad-transition", e.message);
            throw e;
          }
          _json(res, 200, filing);
          return { id: filing.id };
        }),
        async function (req, res) {
          var enc = encodeURIComponent(req.params.id);
          try {
            await run(req.params.id, req.body || {});
          } catch (e) {
            // The primitive's not-found / bad-transition codes carry
            // operator-safe messages; everything else routes through the
            // shared classifier so a raw constraint / parser / unknown error
            // can't ride the err_msg query param into the detail banner.
            var safe = e && (e.code === "SALES_TAX_FILING_NOT_FOUND" || e.code === "SALES_TAX_FILING_BAD_TRANSITION");
            var msg  = (safe ? (e.message || "") : _safeNotice(e, "tax_filing." + audit).message)
              .replace(/^salesTaxFilings[.:]\s*/, "");
            return _redirect(res, "/admin/tax-filings/" + enc + "?err=1&err_msg=" + encodeURIComponent(msg));
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".tax_filing." + audit, outcome: "success", metadata: { id: req.params.id } });
          _redirect(res, "/admin/tax-filings/" + enc + "?" + okParam + "=1");
        },
      ));
    }

    _filingActionRoute("compute", "compute", "computed", function (id) {
      return salesTaxFilings.computeFiling({ filing_id: id });
    });
    _filingActionRoute("submit", "submit", "submitted", function (id, body) {
      return salesTaxFilings.recordSubmission({
        filing_id:      id,
        submission_ref: typeof body.submission_ref === "string" ? body.submission_ref.trim() : body.submission_ref,
        submitted_by:   typeof body.submitted_by === "string" ? body.submitted_by.trim() : body.submitted_by,
      });
    });
    _filingActionRoute("pay", "pay", "paid", function (id, body) {
      return salesTaxFilings.recordPayment({
        filing_id:     id,
        payment_minor: _strictMinorInt(body.payment_minor, "salesTaxFilings", "payment_minor"),
        payment_ref:   typeof body.payment_ref === "string" ? body.payment_ref.trim() : body.payment_ref,
      });
    });
    _filingActionRoute("amend", "amend", "amended", function (id, body) {
      return salesTaxFilings.markAmended({
        filing_id: id,
        reason:    typeof body.reason === "string" ? body.reason.trim() : body.reason,
      });
    });
  }

  // Read a jurisdiction's rate history for the browser list. A null /
  // unset jurisdiction yields an empty list (the page shows the picker
  // form). A malformed jurisdiction throws TypeError in the primitive —
  // map that to an empty list so the page renders the notice, never 500.
  async function _taxRatesForBrowser(jurisdiction) {
    if (!jurisdiction) return [];
    try { return await taxRates.listForJurisdiction({ jurisdiction: jurisdiction, include_expired: true }); }
    catch (e) { if (e instanceof TypeError) return []; throw e; }
  }

  // Translate the create form / JSON body into a defineRate input.
  // Strict integer parsing for rate_bps + the two epoch-ms windows.
  function _taxRateInput(body) {
    var input = {
      jurisdiction: typeof body.jurisdiction === "string" ? body.jurisdiction.trim().toUpperCase() : body.jurisdiction,
      rate_bps:     _strictMinorInt(body.rate_bps, "taxRates", "rate_bps"),
      source:       typeof body.source === "string" && body.source ? body.source : "manual",
    };
    if (body.category != null && body.category !== "") input.category = String(body.category).trim();
    input.effective_from = (body.effective_from == null || body.effective_from === "")
      ? Date.now()
      : _strictMinorInt(body.effective_from, "taxRates", "effective_from (epoch-ms)");
    if (body.effective_until != null && body.effective_until !== "") {
      input.effective_until = _strictMinorInt(body.effective_until, "taxRates", "effective_until (epoch-ms)");
    }
    return input;
  }

  // Translate the edit form / JSON body into an updateRate patch. Only
  // the mutable columns are forwarded; absent fields are left untouched.
  function _taxRatePatch(body) {
    var patch = {};
    if (body.rate_bps != null && body.rate_bps !== "") patch.rate_bps = _strictMinorInt(body.rate_bps, "taxRates", "rate_bps");
    if (Object.prototype.hasOwnProperty.call(body, "effective_until")) {
      patch.effective_until = (body.effective_until == null || body.effective_until === "")
        ? null
        : _strictMinorInt(body.effective_until, "taxRates", "effective_until (epoch-ms)");
    }
    if (body.source != null && body.source !== "") patch.source = String(body.source);
    return patch;
  }

  // ---- shipping zones -------------------------------------------------
  //
  // Operator-defined flat-rate / table-rate zones. The console create is
  // the common single-country, single-flat-service shape — country +
  // service label + flat amount + currency, optionally a region. The
  // primitive's full regions[] / rates[] vocabulary (weight + order-value
  // buckets, multi-region) is reachable via the bearer JSON contract; the
  // edit screen lets an operator paste the full regions / rates JSON to
  // mutate beyond the simple shape.
  var shippingZones = deps.shippingZones || null;
  if (shippingZones) {
    router.post("/admin/shipping", _pageOrApi(false,
      W("shipping_zone.create", async function (req, res) {
        var zone = await shippingZones.defineZone(_shippingZoneInput(req.body || {}));
        _json(res, 201, zone);
        return { id: zone.slug };
      }),
      async function (req, res) {
        try {
          await shippingZones.defineZone(_shippingZoneInput(req.body || {}));
        } catch (e) {
          // The primitive's already-exists code carries an operator-safe
          // message; everything else routes through the shared classifier so
          // a raw constraint / parser / unknown error can't reach the banner.
          var dup = e && e.code === "SHIPPING_ZONE_EXISTS";
          var n   = dup ? { status: 400, message: (e.message || "").replace(/^shippingZones[.:]\s*/, "") }
                        : _safeNotice(e, "shipping_zone.create");
          var noticeMsg = dup ? n.message : n.message.replace(/^shippingZones[.:]\s*/, "");
          var rows = await shippingZones.listZones({});
          return _sendHtml(res, n.status, renderAdminShipping({
            shop_name: deps.shop_name, nav_available: navAvailable, zones: rows,
            notice: noticeMsg,
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".shipping_zone.create", outcome: "success" });
        _redirect(res, "/admin/shipping?created=1");
      },
    ));

    router.get("/admin/shipping", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeOnly = url && url.searchParams.get("active") === "1";
        var rows = await shippingZones.listZones(activeOnly ? { active_only: true } : {});
        _json(res, 200, { rows: rows });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var rows = await shippingZones.listZones({});
        _sendHtml(res, 200, renderAdminShipping({
          shop_name: deps.shop_name, nav_available: navAvailable, zones: rows,
          created:  url && url.searchParams.get("created"),
          updated:  url && url.searchParams.get("updated"),
          archived: url && url.searchParams.get("archived"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the zone." : null,
        }));
      },
    ));

    router.get("/admin/shipping/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var zone;
        try { zone = await shippingZones.getZone(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 404, "shipping-zone-not-found", e.message); throw e; }
        if (!zone) return _problem(res, 404, "shipping-zone-not-found");
        _json(res, 200, zone);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var zone;
        try { zone = await shippingZones.getZone(req.params.slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; zone = null; }
        if (!zone) return _sendHtml(res, 404, renderAdminShipping({
          shop_name: deps.shop_name, nav_available: navAvailable, zones: [], notice: "Zone not found.",
        }));
        _sendHtml(res, 200, renderAdminShippingZone({
          shop_name: deps.shop_name, nav_available: navAvailable, zone: zone,
          updated: url && url.searchParams.get("updated"),
          notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
        }));
      },
    ));

    router.patch("/admin/shipping/:slug", W("shipping_zone.update", async function (req, res) {
      var zone;
      try { zone = await shippingZones.updateZone(req.params.slug, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!zone) return _problem(res, 404, "shipping-zone-not-found");
      _json(res, 200, zone);
      return { id: zone.slug };
    }));

    // Browser edit alias. Mutates title + active (checkbox) and, when the
    // operator pastes JSON, regions / rates. Empty paste fields are left
    // untouched so a title-only edit doesn't wipe the rate table.
    router.post("/admin/shipping/:slug/edit", _pageOrApi(false,
      W("shipping_zone.update", async function (req, res) {
        var zone;
        try { zone = await shippingZones.updateZone(req.params.slug, _shippingZonePatch(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!zone) return _problem(res, 404, "shipping-zone-not-found");
        _json(res, 200, zone);
        return { id: zone.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var enc = encodeURIComponent(slug);
        var zone = null;
        try { zone = await shippingZones.updateZone(slug, _shippingZonePatch(req.body || {})); }
        catch (e) { if (!(e instanceof TypeError) && e.code !== "SHIPPING_ZONE_ARCHIVED") throw e; }
        if (!zone) return _redirect(res, "/admin/shipping/" + enc + "?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".shipping_zone.update", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/shipping/" + enc + "?updated=1");
      },
    ));

    router.delete("/admin/shipping/:slug", W("shipping_zone.archive", async function (req, res) {
      var zone;
      try { zone = await shippingZones.archiveZone(req.params.slug); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      if (!zone) return _problem(res, 404, "shipping-zone-not-found");
      _json(res, 200, zone);
      return { id: zone.slug };
    }));

    router.post("/admin/shipping/:slug/archive", _pageOrApi(false,
      W("shipping_zone.archive", async function (req, res) {
        var zone;
        try { zone = await shippingZones.archiveZone(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!zone) return _problem(res, 404, "shipping-zone-not-found");
        _json(res, 200, zone);
        return { id: zone.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        var zone = null;
        try { zone = await shippingZones.archiveZone(slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!zone) return _redirect(res, "/admin/shipping?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".shipping_zone.archive", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/shipping?archived=1");
      },
    ));
  }

  // Translate the create form / JSON body into a defineZone input. The
  // console form is the single-country, single-flat-rate shape; the
  // bearer JSON path can pass the full regions[]/rates[] arrays directly,
  // so those pass through untouched when present.
  function _shippingZoneInput(body) {
    if (Array.isArray(body.regions) || Array.isArray(body.rates)) {
      // Full JSON shape from a bearer client — forward as-is.
      return body;
    }
    var country = typeof body.country === "string" ? body.country.trim().toUpperCase() : body.country;
    var region  = (body.region != null && body.region !== "") ? String(body.region).trim().toUpperCase() : null;
    var regionEntry = { country: country };
    if (region) regionEntry.region = region;
    return {
      slug:   typeof body.slug === "string" ? body.slug.trim() : body.slug,
      title:  body.title,
      active: body.active === "0" || body.active === "off" ? false : true,
      regions: [regionEntry],
      rates: [{
        rate_minor:    _strictMinorInt(body.rate_minor, "shippingZones", "rate_minor"),
        currency:      typeof body.currency === "string" ? body.currency.trim().toUpperCase() : body.currency,
        service_label: body.service_label,
      }],
    };
  }

  // Translate the edit form / JSON body into an updateZone patch. Title
  // + active always forward; regions / rates only when the operator
  // pasted non-empty JSON (an empty paste leaves the existing table).
  function _shippingZonePatch(body) {
    var patch = {};
    if (Object.prototype.hasOwnProperty.call(body, "title") && body.title !== "") patch.title = body.title;
    // The active checkbox is present (="on"/"1") when checked, absent when
    // unchecked — but only treat it as a field when the form declared it
    // via the hidden marker so a partial JSON edit doesn't flip active.
    if (body.active_present === "1") patch.active = (body.active === "on" || body.active === "1");
    if (typeof body.regions_json === "string" && body.regions_json.trim() !== "") {
      // A pasted JSON blob that doesn't parse is operator input, not a
      // server fault — throw a TypeError so both surfaces (bearer via
      // _wrap, cookie via the htmlHandler's TypeError catch) degrade to a
      // clean 400 instead of a 500 that echoes the parser's position.
      try { patch.regions = JSON.parse(body.regions_json); }
      catch (_e) { throw new TypeError("shippingZones: regions_json must be valid JSON"); }
    } else if (Array.isArray(body.regions)) {
      patch.regions = body.regions;
    }
    if (typeof body.rates_json === "string" && body.rates_json.trim() !== "") {
      try { patch.rates = JSON.parse(body.rates_json); }
      catch (_e) { throw new TypeError("shippingZones: rates_json must be valid JSON"); }
    } else if (Array.isArray(body.rates)) {
      patch.rates = body.rates;
    }
    return patch;
  }

  // ---- automatic discounts + stacking policies ------------------------
  //
  // Two related concerns on one console screen. `autoDiscount` rules are
  // cart-level automatics (no code typed); `couponStacking` policies gate
  // which codes may combine. The screen lists + creates + archives both;
  // rule edit covers title / priority / active (the trigger + value JSON
  // vocabularies are re-set via the create-shape edit fields). Segment-
  // gated rules / per-customer caps / exclusions stay on the bearer JSON
  // surface — the console covers the operator-by-hand common case (a
  // trigger, a value, a priority); the richer JSON shapes pass through
  // the bearer create unchanged.
  var autoDiscount   = deps.autoDiscount   || null;
  var couponStacking = deps.couponStacking || null;
  if (autoDiscount) {
    router.post("/admin/discounts", _pageOrApi(false,
      W("auto_discount.create", async function (req, res) {
        var rule = await autoDiscount.defineRule(_discountInput(req.body || {}));
        _json(res, 201, rule);
        return { id: rule.slug };
      }),
      async function (req, res) {
        try {
          await autoDiscount.defineRule(_discountInput(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "auto_discount.create");
          return _sendHtml(res, n.status, await _renderDiscounts({
            notice: n.message.replace(/^autoDiscount[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".auto_discount.create", outcome: "success" });
        _redirect(res, "/admin/discounts?created=1");
      },
    ));

    router.get("/admin/discounts", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var activeOnly = url && url.searchParams.get("active") === "1";
        var rules = await autoDiscount.listRules(activeOnly ? { active_only: true, limit: 500 } : { limit: 500 });
        var policies = couponStacking ? await couponStacking.listPolicies({ limit: 200 }) : [];
        _json(res, 200, { rules: rules, policies: policies });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _sendHtml(res, 200, await _renderDiscounts({
          created:        url && url.searchParams.get("created"),
          updated:        url && url.searchParams.get("updated"),
          archived:       url && url.searchParams.get("archived"),
          policy_created: url && url.searchParams.get("policy_created"),
          policy_archived: url && url.searchParams.get("policy_archived"),
          notice:         (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
        }));
      },
    ));

    router.patch("/admin/discounts/:slug", W("auto_discount.update", async function (req, res) {
      var rule;
      try { rule = await autoDiscount.updateRule(req.params.slug, req.body || {}); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      _json(res, 200, rule);
      return { id: rule.slug };
    }));

    // Detail screen: the single rule + a full edit form covering the
    // trigger + value terms (not just priority/active). Content-
    // negotiates like the list — bearer → the JSON rule; browser cookie
    // → the rendered edit page.
    router.get("/admin/discounts/:slug", _pageOrApi(true,
      R(async function (req, res) {
        var rule = await autoDiscount.getRule(req.params.slug);
        if (!rule) return _problem(res, 404, "auto-discount-not-found");
        _json(res, 200, rule);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var rule = await autoDiscount.getRule(req.params.slug);
        if (!rule) return _sendHtml(res, 404, await _renderDiscounts({
          notice: "Discount rule not found.",
        }));
        _sendHtml(res, 200, renderAdminDiscount({
          shop_name: deps.shop_name, nav_available: navAvailable, rule: rule,
          updated: url && url.searchParams.get("updated"),
          notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed for the rule." : null,
        }));
      },
    ));

    router.post("/admin/discounts/:slug/edit", _pageOrApi(false,
      W("auto_discount.update", async function (req, res) {
        var rule;
        try { rule = await autoDiscount.updateRule(req.params.slug, _discountPatch(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, rule);
        return { id: rule.slug };
      }),
      async function (req, res) {
        var slug = req.params.slug;
        // A terms edit (trigger/value) comes from the detail screen and
        // returns there on error so the operator sees their input in
        // context; the inline row edit (priority/active only) stays on
        // the list. Success PRGs to the list's ?updated banner either way.
        var fromDetail = (req.body && (req.body.trigger_kind || req.body.value_kind));
        var errHref = fromDetail
          ? "/admin/discounts/" + encodeURIComponent(slug) + "?err=1"
          : "/admin/discounts?err=1";
        try { await autoDiscount.updateRule(slug, _discountPatch(req.body || {})); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, errHref); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".auto_discount.update", outcome: "success", metadata: { slug: slug } });
        _redirect(res, "/admin/discounts?updated=1");
      },
    ));

    router.delete("/admin/discounts/:slug", W("auto_discount.archive", async function (req, res) {
      var rule;
      try { rule = await autoDiscount.archiveRule(req.params.slug); }
      catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
      _json(res, 200, rule);
      return { id: rule.slug };
    }));

    router.post("/admin/discounts/:slug/archive", _pageOrApi(false,
      W("auto_discount.archive", async function (req, res) {
        var rule;
        try { rule = await autoDiscount.archiveRule(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, rule);
        return { id: rule.slug };
      }),
      async function (req, res) {
        try { await autoDiscount.archiveRule(req.params.slug); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/discounts?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".auto_discount.archive", outcome: "success", metadata: { slug: req.params.slug } });
        _redirect(res, "/admin/discounts?archived=1");
      },
    ));

    // Stacking-policy lifecycle — only mounted when the couponStacking
    // dep is wired alongside autoDiscount (the screen renders the policy
    // section conditionally too).
    if (couponStacking) {
      router.post("/admin/discounts/policies", _pageOrApi(false,
        W("coupon_policy.create", async function (req, res) {
          var policy = await couponStacking.definePolicy(_policyInput(req.body || {}));
          _json(res, 201, policy);
          return { id: policy.slug };
        }),
        async function (req, res) {
          try {
            await couponStacking.definePolicy(_policyInput(req.body || {}));
          } catch (e) {
            var n = _safeNotice(e, "coupon_policy.create");
            return _sendHtml(res, n.status, await _renderDiscounts({
              notice: n.message.replace(/^couponStacking[.:]\s*/, ""),
            }));
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".coupon_policy.create", outcome: "success" });
          _redirect(res, "/admin/discounts?policy_created=1");
        },
      ));

      router.delete("/admin/discounts/policies/:slug", W("coupon_policy.archive", async function (req, res) {
        var policy;
        try { policy = await couponStacking.archivePolicy(req.params.slug); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, policy);
        return { id: policy.slug };
      }));

      router.post("/admin/discounts/policies/:slug/archive", _pageOrApi(false,
        W("coupon_policy.archive", async function (req, res) {
          var policy;
          try { policy = await couponStacking.archivePolicy(req.params.slug); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          _json(res, 200, policy);
          return { id: policy.slug };
        }),
        async function (req, res) {
          try { await couponStacking.archivePolicy(req.params.slug); }
          catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/discounts?err=1"); }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".coupon_policy.archive", outcome: "success", metadata: { slug: req.params.slug } });
          _redirect(res, "/admin/discounts?policy_archived=1");
        },
      ));
    }
  }

  // ---- quantity discounts ---------------------------------------------
  // Tier-set CRUD for automatic per-line quantity breaks ("buy 5, save
  // 10%"). The pricing engine already applies these at PDP / cart /
  // checkout; this console manages the schedules. Content-negotiated like
  // the other screens: bearer → the JSON contract; signed-in browser →
  // the HTML table + create form. The detail screen renders the schedule,
  // a rewrite form, archive/unarchive, and a sample tierBreakdown preview.
  if (deps.quantityDiscounts) {
    var quantityDiscounts = deps.quantityDiscounts;

    // The engine has no get(id) — fetch a single set by walking the
    // both-states list (operators have tens of sets, not thousands).
    async function _qdSetById(id) {
      var rows = await quantityDiscounts.list({ archived: null, limit: 200 });
      for (var i = 0; i < rows.length; i += 1) {
        if (rows[i].id === id) return rows[i];
      }
      return null;
    }

    // Map the ?archived= query to a list filter: 1/true → archived-only,
    // 0/false → active-only, absent → both. The list view defaults to
    // showing everything so a freshly-archived set stays visible.
    function _qdFilter(archivedS) {
      if (archivedS === "1" || archivedS === "true")  return { archived: true };
      if (archivedS === "0" || archivedS === "false") return { archived: false };
      return { archived: null };
    }

    // Parse the create / edit form's flat tier fields into the engine's
    // tiers array. The form posts parallel arrays tier_min[] /
    // tier_kind[] / tier_value[]; a row with every field blank is
    // dropped (the spare append row), a row with any field set is kept
    // and validated by the engine. min_quantity + value go through the
    // strict integer reader so "", floats, and "12abc" are refused as a
    // 4xx rather than coerced.
    function _qdAsArray(v) {
      if (v == null) return [];
      return Array.isArray(v) ? v : [v];
    }
    function _qdTiersFromForm(body) {
      var mins   = _qdAsArray(body.tier_min);
      var kinds  = _qdAsArray(body.tier_kind);
      var values = _qdAsArray(body.tier_value);
      var n = Math.max(mins.length, kinds.length, values.length);
      var tiers = [];
      for (var i = 0; i < n; i += 1) {
        var minRaw   = mins[i]   == null ? "" : String(mins[i]).trim();
        var kindRaw  = kinds[i]  == null ? "" : String(kinds[i]).trim();
        var valueRaw = values[i] == null ? "" : String(values[i]).trim();
        if (minRaw === "" && kindRaw === "" && valueRaw === "") continue;   // spare blank row
        tiers.push({
          min_quantity:  _strictMinorInt(minRaw, "quantityDiscounts", "min_quantity"),
          discount_kind: kindRaw,
          value:         _strictMinorInt(valueRaw, "quantityDiscounts", "value"),
        });
      }
      return tiers;
    }

    // Translate the create form / JSON body into a defineTier input. A
    // body already carrying a tiers array (bearer JSON client) passes
    // through untouched; the browser form is flattened first.
    function _qdDefineInput(body) {
      if (Array.isArray(body.tiers)) return body;
      var scope = typeof body.scope === "string" ? body.scope.trim() : body.scope;
      var input = {
        scope:     scope,
        exclusive: (body.exclusive === "on" || body.exclusive === "1" || body.exclusive === true),
        tiers:     _qdTiersFromForm(body),
      };
      // scope_id is null exactly for global; the engine enforces the
      // pairing. Trim + omit for global so a stray blank field doesn't
      // trip the "must be null when global" check.
      if (scope !== "global") {
        input.scope_id = typeof body.scope_id === "string" ? body.scope_id.trim() : body.scope_id;
      }
      return input;
    }

    async function _renderQdList(flags) {
      flags = flags || {};
      var rows = await quantityDiscounts.list(_qdFilter(flags.archived_filter));
      return renderAdminQuantityDiscounts(Object.assign({
        shop_name: deps.shop_name, nav_available: navAvailable,
        scopes: quantityDiscountsModule.VALID_SCOPES, kinds: quantityDiscountsModule.VALID_KINDS,
        tier_sets: rows,
      }, flags));
    }

    router.get("/admin/quantity-discounts", _pageOrApi(true,
      R(async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var archivedS = url && url.searchParams.get("archived");
        _json(res, 200, { rows: await quantityDiscounts.list(_qdFilter(archivedS)) });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var archivedS = url && url.searchParams.get("archived");
        _sendHtml(res, 200, await _renderQdList({
          archived_filter: archivedS,
          created:  url && url.searchParams.get("created"),
          saved:    url && url.searchParams.get("saved"),
          archived: url && url.searchParams.get("archived_ok"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed for the tier set." : null,
        }));
      },
    ));

    router.post("/admin/quantity-discounts", _pageOrApi(false,
      W("quantity_discount.create", async function (req, res) {
        var set = await quantityDiscounts.defineTier(_qdDefineInput(req.body || {}));
        _json(res, 201, set);
        return { id: set.id };
      }),
      async function (req, res) {
        try {
          await quantityDiscounts.defineTier(_qdDefineInput(req.body || {}));
        } catch (e) {
          var n = _safeNotice(e, "quantity_discount.create");
          return _sendHtml(res, n.status, await _renderQdList({
            notice: n.message.replace(/^quantityDiscounts[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".quantity_discount.create", outcome: "success" });
        _redirect(res, "/admin/quantity-discounts?created=1");
      },
    ));

    // Detail: the tier set + its schedule, a rewrite form, archive /
    // unarchive, and a sample-price tierBreakdown preview. A bad / unknown
    // id is a 404 page, never a 500.
    async function _qdDetailModel(id, sampleMinor) {
      var set = await _qdSetById(id);
      if (!set) return null;
      var breakdown = null;
      try {
        breakdown = await quantityDiscounts.tierBreakdown({
          scope:    set.scope,
          scope_id: set.scope_id,
          sample_unit_price_minor: (sampleMinor == null ? 1000 : sampleMinor),
        });
      } catch (_e) { breakdown = null; }
      return { set: set, breakdown: breakdown, sample_minor: (sampleMinor == null ? 1000 : sampleMinor) };
    }

    router.get("/admin/quantity-discounts/:id", _pageOrApi(true,
      R(async function (req, res) {
        var set = await _qdSetById(req.params.id);
        if (!set) return _problem(res, 404, "quantity-discount-not-found");
        _json(res, 200, set);
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var sampleS = url && url.searchParams.get("sample");
        var sampleMinor = null;
        if (sampleS != null && /^\d+$/.test(sampleS)) sampleMinor = Number(sampleS);
        var model = await _qdDetailModel(req.params.id, sampleMinor);
        if (!model) return _sendHtml(res, 404, renderAdminQuantityDiscount({
          shop_name: deps.shop_name, nav_available: navAvailable, tier_set: null,
        }));
        _sendHtml(res, 200, renderAdminQuantityDiscount({
          shop_name: deps.shop_name, nav_available: navAvailable,
          kinds: quantityDiscountsModule.VALID_KINDS,
          tier_set: model.set, breakdown: model.breakdown, sample_minor: model.sample_minor,
          saved:  url && url.searchParams.get("saved"),
          notice: (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
        }));
      },
    ));

    router.post("/admin/quantity-discounts/:id/edit", _pageOrApi(false,
      W("quantity_discount.update", async function (req, res) {
        var set;
        try { set = await quantityDiscounts.update(req.params.id, req.body || {}); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!set) return _problem(res, 404, "quantity-discount-not-found");
        _json(res, 200, set);
        return { id: set.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var body = req.body || {};
        var enc = encodeURIComponent(id);
        try {
          var patch = {};
          // exclusive_present marks the checkbox was rendered, so an
          // unchecked box reads as false rather than "leave unchanged".
          if (body.exclusive_present === "1") {
            patch.exclusive = (body.exclusive === "on" || body.exclusive === "1");
          }
          var tiers = _qdTiersFromForm(body);
          if (tiers.length > 0) patch.tiers = tiers;
          if (Object.keys(patch).length === 0) return _redirect(res, "/admin/quantity-discounts/" + enc + "?err=1");
          var set = await quantityDiscounts.update(id, patch);
          if (!set) return _redirect(res, "/admin/quantity-discounts/" + enc + "?err=1");
        } catch (e) {
          if (!(e instanceof TypeError)) throw e;
          return _redirect(res, "/admin/quantity-discounts/" + enc + "?err=1");
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".quantity_discount.update", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/quantity-discounts/" + enc + "?saved=1");
      },
    ));

    router.post("/admin/quantity-discounts/:id/archive", _pageOrApi(false,
      W("quantity_discount.archive", async function (req, res) {
        var ok;
        try { ok = await quantityDiscounts.archive(req.params.id); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!ok) return _problem(res, 404, "quantity-discount-not-found");
        _json(res, 200, { ok: true });
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var ok = false;
        try { ok = await quantityDiscounts.archive(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!ok) return _redirect(res, "/admin/quantity-discounts?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".quantity_discount.archive", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/quantity-discounts?archived_ok=1");
      },
    ));

    router.post("/admin/quantity-discounts/:id/unarchive", _pageOrApi(false,
      W("quantity_discount.unarchive", async function (req, res) {
        var ok;
        try { ok = await quantityDiscounts.unarchive(req.params.id); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        if (!ok) return _problem(res, 404, "quantity-discount-not-found");
        _json(res, 200, { ok: true });
        return { id: req.params.id };
      }),
      async function (req, res) {
        var id = req.params.id;
        var ok = false;
        try { ok = await quantityDiscounts.unarchive(id); }
        catch (e) { if (!(e instanceof TypeError)) throw e; }
        if (!ok) return _redirect(res, "/admin/quantity-discounts?err=1");
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".quantity_discount.unarchive", outcome: "success", metadata: { id: id } });
        _redirect(res, "/admin/quantity-discounts?saved=1");
      },
    ));
  }

  // ---- loyalty --------------------------------------------------------
  // Manage the loyalty program from the console: the earn rules that mint
  // points, the rewards catalog customers redeem against, and a direct
  // per-customer points adjustment (grant / deduct with a required reason,
  // recorded in the loyalty ledger). The customer-facing /account/loyalty
  // page shows ONLY active earn rules + active rewards, so the console
  // flags inactive rows and an archive removes them from the storefront.
  //
  // `loyalty` (the points ledger) is the core dep — the overview + the
  // adjustment action mount on it. Earn rules + the rewards catalog mount
  // additionally on their own primitives, so a deployment that wired only
  // the ledger still gets the adjustment surface (and the nav link).
  if (deps.loyalty) {
    var loyalty = deps.loyalty;
    var loyaltyEarnRules  = deps.loyaltyEarnRules  || null;
    var loyaltyRedemption = deps.loyaltyRedemption || null;

    // Validate the operator's free-text adjustment reason at the route.
    // A points adjustment is a money-adjacent action, so the reason is
    // MANDATORY — it rides into the ledger row's `notes` column. Throws a
    // TypeError (→ 400) on a missing / blank / over-long / control-byte
    // reason so the browser form surfaces a clean notice and writes
    // nothing. The amount goes through the strict signed-integer reader
    // (refuses "", floats, "12abc") and must be non-zero.
    var LOYALTY_REASON_MAX = 256;
    function _loyaltyReason(raw) {
      if (raw == null) throw new TypeError("admin: a reason is required for a points adjustment");
      var s = String(raw).trim();
      if (!s.length) throw new TypeError("admin: a reason is required for a points adjustment");
      if (s.length > LOYALTY_REASON_MAX) throw new TypeError("admin: reason must be <= " + LOYALTY_REASON_MAX + " chars");
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s)) throw new TypeError("admin: reason must not contain control bytes");
      return s;
    }
    // Coerce the grant/deduct form into a signed delta. `direction` is
    // "grant" (positive) or "deduct" (negative); `amount` is a positive
    // integer count of points. The two compose into the non-zero signed
    // delta loyalty.adjust expects, so the operator never types a sign.
    function _loyaltyDelta(body) {
      var amount = _strictMinorInt(body.amount, "admin", "amount");
      if (amount <= 0) throw new TypeError("admin: amount must be a positive integer");
      var dir = typeof body.direction === "string" ? body.direction.trim() : "";
      if (dir !== "grant" && dir !== "deduct") {
        throw new TypeError("admin: direction must be 'grant' or 'deduct'");
      }
      return dir === "deduct" ? -amount : amount;
    }

    // Build the overview model: thresholds + ratios from the ledger, plus
    // (best-effort) the earn-rule + reward lists. A not-wired or
    // not-migrated sub-primitive degrades that panel rather than the page.
    async function _loyaltyOverview(flags) {
      flags = flags || {};
      var earnRules = null;
      if (loyaltyEarnRules) {
        try { earnRules = await loyaltyEarnRules.listRules({ limit: 200 }); }
        catch (_e) { earnRules = []; }
      }
      var rewards = null;
      if (loyaltyRedemption) {
        try { rewards = await loyaltyRedemption.listRewards({ limit: 200 }); }
        catch (_e) { rewards = []; }
      }
      return Object.assign({
        shop_name:        deps.shop_name,
        nav_available:    navAvailable,
        tiers:            loyalty.TIERS,
        tier_thresholds:  loyalty.TIER_THRESHOLDS,
        points_per_usd:   loyalty.POINTS_PER_USD,
        redemption_points_per_usd: loyalty.REDEMPTION_POINTS_PER_USD,
        earn_triggers:    loyaltyEarnRulesModule.TRIGGERS,
        reward_kinds:     loyaltyRedemptionModule.KINDS,
        earn_rules:       earnRules,
        rewards:          rewards,
        can_manage_rules:   !!loyaltyEarnRules,
        can_manage_rewards: !!loyaltyRedemption,
      }, flags);
    }

    router.get("/admin/loyalty", _pageOrApi(true,
      R(async function (_req, res) {
        // Bearer JSON: the program's configuration snapshot.
        _json(res, 200, {
          tiers:            loyalty.TIERS,
          tier_thresholds:  loyalty.TIER_THRESHOLDS,
          points_per_usd:   loyalty.POINTS_PER_USD,
          redemption_points_per_usd: loyalty.REDEMPTION_POINTS_PER_USD,
          earn_rules:       loyaltyEarnRules  ? await loyaltyEarnRules.listRules({ limit: 200 }) : null,
          rewards:          loyaltyRedemption ? await loyaltyRedemption.listRewards({ limit: 200 }) : null,
        });
      }),
      async function (req, res) {
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        var flags = {
          adjusted: url && url.searchParams.get("adjusted"),
          notice:   (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
        };
        // A failed adjustment round-trips its message through a one-shot
        // query flag set on the redirect (kept short + already escaped on
        // render) so the operator sees WHY without a 5xx.
        if (url && url.searchParams.get("adjust_err")) {
          flags.adjust_notice = url.searchParams.get("adjust_err");
        }
        _sendHtml(res, 200, renderAdminLoyalty(await _loyaltyOverview(flags)));
      },
    ));

    // Points adjustment — grant or deduct a specific customer's balance
    // with a required reason. Composes loyalty.adjust, which writes the
    // signed delta to loyalty_transactions (the audited ledger) and
    // recomputes the tier. A bad customer id / amount / missing reason is
    // a clean 4xx with nothing written; an underflowing deduction surfaces
    // the primitive's LOYALTY_INSUFFICIENT_BALANCE as a notice.
    router.post("/admin/loyalty/adjust", _pageOrApi(false,
      W("loyalty.adjust", async function (req, res) {
        var body = req.body || {};
        var customerId = body.customer_id;
        var delta;
        var reason;
        try {
          delta  = _loyaltyDelta(body);
          reason = _loyaltyReason(body.reason);
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          throw e;
        }
        var result;
        try {
          result = await loyalty.adjust({
            customer_id: customerId,
            points:      delta,
            source:      "admin-adjustment",
            notes:       reason,
          });
        } catch (e) {
          if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
          if (e && e.code === "LOYALTY_INSUFFICIENT_BALANCE") {
            return _problem(res, 409, "insufficient-balance", "Adjustment would drop the balance below zero.");
          }
          throw e;
        }
        _json(res, 200, result);
        return { id: customerId };
      }),
      async function (req, res) {
        var body = req.body || {};
        var customerId = body.customer_id;
        var cidPrefill = typeof customerId === "string" ? customerId : "";
        // Re-render the overview with the adjustment form's error notice.
        // The message is classified by the shared _safeNotice funnel (so
        // the cookie/HTML path can never reveal more than the bearer JSON
        // path); the `admin:`/`loyalty:` namespace prefix is stripped for
        // the operator. An insufficient-balance refusal is the one
        // primitive code _safeNotice would otherwise genericize to a 500,
        // so it's mapped to a clean 4xx notice ahead of the funnel.
        async function _adjustFail(e) {
          if (e && e.code === "LOYALTY_INSUFFICIENT_BALANCE") {
            return _sendHtml(res, 409, renderAdminLoyalty(await _loyaltyOverview({
              adjust_notice: "That deduction would drop the balance below zero.",
              adjust_customer_id: cidPrefill,
            })));
          }
          var n = _safeNotice(e, "loyalty.adjust");
          return _sendHtml(res, n.status, renderAdminLoyalty(await _loyaltyOverview({
            adjust_notice: n.message.replace(/^(?:admin|loyalty)[.:]\s*/, ""),
            adjust_customer_id: cidPrefill,
          })));
        }
        var delta;
        var reason;
        try {
          delta  = _loyaltyDelta(body);
          reason = _loyaltyReason(body.reason);
        } catch (e) {
          return _adjustFail(e);
        }
        try {
          await loyalty.adjust({
            customer_id: customerId,
            points:      delta,
            source:      "admin-adjustment",
            notes:       reason,
          });
        } catch (e) {
          return _adjustFail(e);
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.adjust", outcome: "success" });
        _redirect(res, "/admin/loyalty?adjusted=1");
      },
    ));

    // ---- earn rules ---------------------------------------------------
    if (loyaltyEarnRules) {
      // Translate the create / edit form into a defineRule / updateRule
      // input. The status list is a comma-separated free-text field
      // (e.g. "active, vip"); a blank field means no restriction (null).
      function _loyaltyStatusList(raw) {
        if (raw == null) return null;
        var s = String(raw).trim();
        if (!s.length) return null;
        return s.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      }
      function _earnDefineInput(body) {
        var input = {
          slug:            typeof body.slug === "string" ? body.slug.trim() : body.slug,
          trigger:         typeof body.trigger === "string" ? body.trigger.trim() : body.trigger,
          points_per_unit: _strictMinorInt(body.points_per_unit, "admin", "points_per_unit"),
          active:          (body.active === "on" || body.active === "1" || body.active === true),
        };
        var maxRaw = body.max_per_event == null ? "" : String(body.max_per_event).trim();
        if (maxRaw !== "") input.max_per_event = _strictMinorInt(maxRaw, "admin", "max_per_event");
        var statusList = _loyaltyStatusList(body.customer_status_in);
        if (statusList) input.customer_status_in = statusList;
        return input;
      }

      router.get("/admin/loyalty/earn-rules", _pageOrApi(true,
        R(async function (_req, res) {
          _json(res, 200, { rows: await loyaltyEarnRules.listRules({ limit: 200 }) });
        }),
        async function (req, res) {
          var url = req.url ? new URL(req.url, "http://localhost") : null;
          _sendHtml(res, 200, renderAdminLoyaltyEarnRules({
            shop_name: deps.shop_name, nav_available: navAvailable,
            triggers: loyaltyEarnRulesModule.TRIGGERS,
            rules: await loyaltyEarnRules.listRules({ limit: 200 }),
            created: url && url.searchParams.get("created"),
            saved:   url && url.searchParams.get("saved"),
            archived: url && url.searchParams.get("archived_ok"),
            notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed for the rule." : null,
          }));
        },
      ));

      router.post("/admin/loyalty/earn-rules", _pageOrApi(false,
        W("loyalty.earn_rule.create", async function (req, res) {
          var rule;
          try { rule = await loyaltyEarnRules.defineRule(_earnDefineInput(req.body || {})); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          _json(res, 201, rule);
          return { id: rule.slug };
        }),
        async function (req, res) {
          try {
            await loyaltyEarnRules.defineRule(_earnDefineInput(req.body || {}));
          } catch (e) {
            var n = _safeNotice(e, "loyalty.earn_rule.create");
            return _sendHtml(res, n.status, renderAdminLoyaltyEarnRules({
              shop_name: deps.shop_name, nav_available: navAvailable,
              triggers: loyaltyEarnRulesModule.TRIGGERS,
              rules: await loyaltyEarnRules.listRules({ limit: 200 }),
              notice: n.message.replace(/^loyaltyEarnRules[.:]\s*/, ""),
            }));
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.earn_rule.create", outcome: "success" });
          _redirect(res, "/admin/loyalty/earn-rules?created=1");
        },
      ));

      router.get("/admin/loyalty/earn-rules/:slug", _pageOrApi(true,
        R(async function (req, res) {
          var rule;
          try { rule = await loyaltyEarnRules.getRule(req.params.slug); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          if (!rule) return _problem(res, 404, "loyalty-earn-rule-not-found");
          _json(res, 200, rule);
        }),
        async function (req, res) {
          var url = req.url ? new URL(req.url, "http://localhost") : null;
          var rule;
          try { rule = await loyaltyEarnRules.getRule(req.params.slug); }
          catch (e) { if (!(e instanceof TypeError)) throw e; rule = null; }
          if (!rule) return _sendHtml(res, 404, renderAdminLoyaltyEarnRule({
            shop_name: deps.shop_name, nav_available: navAvailable, rule: null,
          }));
          _sendHtml(res, 200, renderAdminLoyaltyEarnRule({
            shop_name: deps.shop_name, nav_available: navAvailable,
            triggers: loyaltyEarnRulesModule.TRIGGERS, rule: rule,
            saved:  url && url.searchParams.get("saved"),
            notice: (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
          }));
        },
      ));

      router.post("/admin/loyalty/earn-rules/:slug/edit", _pageOrApi(false,
        W("loyalty.earn_rule.update", async function (req, res) {
          var patch = _earnPatchFromForm(req.body || {});
          var rule;
          try { rule = await loyaltyEarnRules.updateRule(req.params.slug, patch); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          if (!rule) return _problem(res, 404, "loyalty-earn-rule-not-found");
          _json(res, 200, rule);
          return { id: rule.slug };
        }),
        async function (req, res) {
          var slug = req.params.slug;
          var enc = encodeURIComponent(slug);
          try {
            var rule = await loyaltyEarnRules.updateRule(slug, _earnPatchFromForm(req.body || {}));
            if (!rule) return _redirect(res, "/admin/loyalty/earn-rules?err=1");
          } catch (e) {
            if (!(e instanceof TypeError)) throw e;
            return _redirect(res, "/admin/loyalty/earn-rules/" + enc + "?err=1");
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.earn_rule.update", outcome: "success", metadata: { slug: slug } });
          _redirect(res, "/admin/loyalty/earn-rules/" + enc + "?saved=1");
        },
      ));

      router.post("/admin/loyalty/earn-rules/:slug/archive", _pageOrApi(false,
        W("loyalty.earn_rule.archive", async function (req, res) {
          var rule;
          try { rule = await loyaltyEarnRules.archiveRule(req.params.slug); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          if (!rule) return _problem(res, 404, "loyalty-earn-rule-not-found");
          _json(res, 200, rule);
          return { id: req.params.slug };
        }),
        async function (req, res) {
          var slug = req.params.slug;
          try { await loyaltyEarnRules.archiveRule(slug); }
          catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/loyalty/earn-rules?err=1"); }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.earn_rule.archive", outcome: "success", metadata: { slug: slug } });
          _redirect(res, "/admin/loyalty/earn-rules?archived_ok=1");
        },
      ));
    }

    // ---- rewards catalog ----------------------------------------------
    if (loyaltyRedemption) {
      // The reward's value_json shape depends on its kind. The console
      // collects one numeric field (percent / amount_minor / product_id)
      // and the create path assembles the per-kind payload the primitive
      // validates. free_shipping carries an empty object.
      function _rewardValueJson(kind, body) {
        if (kind === "discount_percent") {
          return { percent: _strictMinorInt(body.value_number, "admin", "percent") };
        }
        if (kind === "discount_amount") {
          return { amount_minor: _strictMinorInt(body.value_number, "admin", "amount_minor") };
        }
        if (kind === "free_product") {
          var pid = typeof body.value_text === "string" ? body.value_text.trim() : "";
          return { product_id: pid };
        }
        // free_shipping (or an unknown kind the primitive will reject).
        return {};
      }
      function _rewardDefineInput(body) {
        var kind = typeof body.kind === "string" ? body.kind.trim() : body.kind;
        var input = {
          slug:       typeof body.slug === "string" ? body.slug.trim() : body.slug,
          kind:       kind,
          title:      typeof body.title === "string" ? body.title : body.title,
          point_cost: _strictMinorInt(body.point_cost, "admin", "point_cost"),
          value_json: _rewardValueJson(kind, body),
          active:     (body.active === "on" || body.active === "1" || body.active === true),
        };
        var maxRaw = body.max_per_customer == null ? "" : String(body.max_per_customer).trim();
        if (maxRaw !== "") input.max_per_customer = _strictMinorInt(maxRaw, "admin", "max_per_customer");
        var expRaw = body.expires_days_after_redemption == null ? "" : String(body.expires_days_after_redemption).trim();
        if (expRaw !== "") input.expires_days_after_redemption = _strictMinorInt(expRaw, "admin", "expires_days_after_redemption");
        return input;
      }

      router.get("/admin/loyalty/rewards", _pageOrApi(true,
        R(async function (_req, res) {
          _json(res, 200, { rows: await loyaltyRedemption.listRewards({ limit: 200 }) });
        }),
        async function (req, res) {
          var url = req.url ? new URL(req.url, "http://localhost") : null;
          _sendHtml(res, 200, renderAdminLoyaltyRewards({
            shop_name: deps.shop_name, nav_available: navAvailable,
            kinds: loyaltyRedemptionModule.KINDS,
            rewards: await loyaltyRedemption.listRewards({ limit: 200 }),
            created: url && url.searchParams.get("created"),
            saved:   url && url.searchParams.get("saved"),
            archived: url && url.searchParams.get("archived_ok"),
            notice:  (url && url.searchParams.get("err")) ? "That action couldn't be completed for the reward." : null,
          }));
        },
      ));

      router.post("/admin/loyalty/rewards", _pageOrApi(false,
        W("loyalty.reward.create", async function (req, res) {
          var reward;
          try { reward = await loyaltyRedemption.defineReward(_rewardDefineInput(req.body || {})); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          _json(res, 201, reward);
          return { id: reward.slug };
        }),
        async function (req, res) {
          try {
            await loyaltyRedemption.defineReward(_rewardDefineInput(req.body || {}));
          } catch (e) {
            var n = _safeNotice(e, "loyalty.reward.create");
            return _sendHtml(res, n.status, renderAdminLoyaltyRewards({
              shop_name: deps.shop_name, nav_available: navAvailable,
              kinds: loyaltyRedemptionModule.KINDS,
              rewards: await loyaltyRedemption.listRewards({ limit: 200 }),
              notice: n.message.replace(/^loyaltyRedemption[.:]\s*/, ""),
            }));
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.reward.create", outcome: "success" });
          _redirect(res, "/admin/loyalty/rewards?created=1");
        },
      ));

      router.get("/admin/loyalty/rewards/:slug", _pageOrApi(true,
        R(async function (req, res) {
          var reward;
          try { reward = await loyaltyRedemption.getReward(req.params.slug); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          if (!reward) return _problem(res, 404, "loyalty-reward-not-found");
          _json(res, 200, reward);
        }),
        async function (req, res) {
          var url = req.url ? new URL(req.url, "http://localhost") : null;
          var reward;
          try { reward = await loyaltyRedemption.getReward(req.params.slug); }
          catch (e) { if (!(e instanceof TypeError)) throw e; reward = null; }
          if (!reward) return _sendHtml(res, 404, renderAdminLoyaltyReward({
            shop_name: deps.shop_name, nav_available: navAvailable, reward: null,
          }));
          _sendHtml(res, 200, renderAdminLoyaltyReward({
            shop_name: deps.shop_name, nav_available: navAvailable, reward: reward,
            saved:  url && url.searchParams.get("saved"),
            notice: (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
          }));
        },
      ));

      router.post("/admin/loyalty/rewards/:slug/edit", _pageOrApi(false,
        W("loyalty.reward.update", async function (req, res) {
          var reward;
          try { reward = await loyaltyRedemption.updateReward(req.params.slug, await _rewardPatchFromForm(req.params.slug, req.body || {})); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          _json(res, 200, reward);
          return { id: reward.slug };
        }),
        async function (req, res) {
          var slug = req.params.slug;
          var enc = encodeURIComponent(slug);
          try {
            await loyaltyRedemption.updateReward(slug, await _rewardPatchFromForm(slug, req.body || {}));
          } catch (e) {
            if (!(e instanceof TypeError)) throw e;
            return _redirect(res, "/admin/loyalty/rewards/" + enc + "?err=1");
          }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.reward.update", outcome: "success", metadata: { slug: slug } });
          _redirect(res, "/admin/loyalty/rewards/" + enc + "?saved=1");
        },
      ));

      router.post("/admin/loyalty/rewards/:slug/archive", _pageOrApi(false,
        W("loyalty.reward.archive", async function (req, res) {
          var reward;
          try { reward = await loyaltyRedemption.archiveReward(req.params.slug); }
          catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
          _json(res, 200, reward);
          return { id: req.params.slug };
        }),
        async function (req, res) {
          var slug = req.params.slug;
          try { await loyaltyRedemption.archiveReward(slug); }
          catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/loyalty/rewards?err=1"); }
          b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".loyalty.reward.archive", outcome: "success", metadata: { slug: slug } });
          _redirect(res, "/admin/loyalty/rewards?archived_ok=1");
        },
      ));

      // Build the updateReward patch from the edit form. Only the columns
      // the operator changed are forwarded; value_json is re-validated
      // against the reward's STORED kind (kind is immutable on update), so
      // the helper reads the current reward to resolve it.
      async function _rewardPatchFromForm(slug, body) {
        var patch = {};
        if (typeof body.title === "string" && body.title.length) patch.title = body.title;
        if (body.point_cost != null && String(body.point_cost).trim() !== "") {
          patch.point_cost = _strictMinorInt(body.point_cost, "admin", "point_cost");
        }
        if (body.active_present === "1") {
          patch.active = (body.active === "on" || body.active === "1");
        }
        var maxRaw = body.max_per_customer == null ? "" : String(body.max_per_customer).trim();
        if (maxRaw !== "") patch.max_per_customer = _strictMinorInt(maxRaw, "admin", "max_per_customer");
        var expRaw = body.expires_days_after_redemption == null ? "" : String(body.expires_days_after_redemption).trim();
        if (expRaw !== "") patch.expires_days_after_redemption = _strictMinorInt(expRaw, "admin", "expires_days_after_redemption");
        // A supplied value field rewrites value_json against the stored
        // kind. Absent it, value_json is left untouched.
        if ((body.value_number != null && String(body.value_number).trim() !== "") ||
            (typeof body.value_text === "string" && body.value_text.trim() !== "")) {
          var current = await loyaltyRedemption.getReward(slug);
          if (current) patch.value_json = _rewardValueJson(current.kind, body);
        }
        return patch;
      }
    }
  }

  // Patch builder for the loyalty earn-rule edit form. trigger is
  // immutable on update (the primitive refuses a change), so the form
  // never sends it; only points_per_unit / max_per_event /
  // customer_status_in / active are editable. Hoisted above the rewards
  // block's IIFE-free scope so both the bearer + browser edit paths share
  // it. Defined as a closure inside mount() so it can stay near its
  // callers without polluting the module surface.
  function _earnPatchFromForm(body) {
    var patch = {};
    if (body.points_per_unit != null && String(body.points_per_unit).trim() !== "") {
      patch.points_per_unit = _strictMinorInt(body.points_per_unit, "admin", "points_per_unit");
    }
    if (body.max_per_event != null) {
      var maxRaw = String(body.max_per_event).trim();
      // An explicit "0" / "" clears the cap (null); a positive value sets it.
      if (maxRaw === "" || maxRaw === "0") patch.max_per_event = null;
      else patch.max_per_event = _strictMinorInt(maxRaw, "admin", "max_per_event");
    }
    if (body.customer_status_in != null) {
      var s = String(body.customer_status_in).trim();
      patch.customer_status_in = s.length
        ? s.split(",").map(function (x) { return x.trim(); }).filter(Boolean)
        : null;
    }
    if (body.active_present === "1") {
      patch.active = (body.active === "on" || body.active === "1");
    }
    return patch;
  }

  // Render the discounts screen — gathers rules + (optional) stacking
  // policies, then hands them to the renderer with whatever banner flags
  // the caller passed.
  async function _renderDiscounts(flags) {
    flags = flags || {};
    var rules = await autoDiscount.listRules({ limit: 500 });
    var policies = couponStacking ? await couponStacking.listPolicies({ limit: 200 }) : [];
    return renderAdminDiscounts(Object.assign({
      shop_name: deps.shop_name, nav_available: navAvailable,
      rules: rules, policies: policies, stacking_enabled: !!couponStacking,
    }, flags));
  }

  // Translate the create form / JSON body into a defineRule input. The
  // console covers a single trigger + a single value + priority; the
  // bearer JSON path can pass the full vocabulary (applies_to, segments,
  // exclusions, caps) directly, so a body already carrying object-shaped
  // trigger / value passes through untouched.
  function _discountInput(body) {
    if (body.trigger && typeof body.trigger === "object" && body.value && typeof body.value === "object") {
      return body; // full JSON shape from a bearer client
    }
    var input = {
      slug:  typeof body.slug === "string" ? body.slug.trim() : body.slug,
      title: body.title,
      trigger: _discountTrigger(body),
      value:   _discountValue(body),
    };
    if (body.priority != null && body.priority !== "") {
      input.priority = _strictMinorInt(body.priority, "autoDiscount", "priority");
    }
    return input;
  }

  function _discountTrigger(body) {
    var kind = body.trigger_kind;
    if (kind === "item_count_min") {
      return { kind: "item_count_min", min_count: _strictMinorInt(body.trigger_min_count, "autoDiscount", "trigger min_count") };
    }
    if (kind === "sku_purchase") {
      var skus = String(body.trigger_skus || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      var t = { kind: "sku_purchase", skus: skus };
      if (body.trigger_min_quantity != null && body.trigger_min_quantity !== "") {
        t.min_quantity = _strictMinorInt(body.trigger_min_quantity, "autoDiscount", "trigger min_quantity");
      }
      return t;
    }
    // default: cart_total_min
    return { kind: "cart_total_min", min_minor: _strictMinorInt(body.trigger_min_minor, "autoDiscount", "trigger min_minor") };
  }

  function _discountValue(body) {
    var kind = body.value_kind;
    if (kind === "percent_off") {
      return { kind: "percent_off", basis_points: _strictMinorInt(body.value_basis_points, "autoDiscount", "value basis_points") };
    }
    if (kind === "amount_off_total" || kind === "amount_off_each") {
      return { kind: kind, minor: _strictMinorInt(body.value_minor, "autoDiscount", "value minor") };
    }
    if (kind === "bogo") {
      return {
        kind: "bogo",
        buy_qty: _strictMinorInt(body.value_buy_qty, "autoDiscount", "value buy_qty"),
        get_qty: _strictMinorInt(body.value_get_qty, "autoDiscount", "value get_qty"),
      };
    }
    return { kind: "free_shipping" };
  }

  // Translate the rule edit form into an updateRule patch. The inline
  // row form covers the common "rename / re-prioritise / pause" gesture
  // (title / priority / active); the detail screen additionally posts a
  // trigger_kind + value_kind so an operator can change the actual
  // discount terms (amount / percentage / threshold / BOGO) from the
  // console, not just reprioritise. The trigger / value kind fields are
  // reused from the create form's vocabulary via _discountTrigger /
  // _discountValue, which throw a TypeError on a bad / missing required
  // field — so a bad terms edit degrades to a clean 400, never a 500,
  // and never a silent partial write. The richer applies_to / segment /
  // exclusion vocabulary stays on the bearer JSON PATCH.
  function _discountPatch(body) {
    var patch = {};
    if (Object.prototype.hasOwnProperty.call(body, "title") && body.title !== "") patch.title = body.title;
    if (body.priority != null && body.priority !== "") patch.priority = _strictMinorInt(body.priority, "autoDiscount", "priority");
    if (body.active_present === "1") patch.active = (body.active === "on" || body.active === "1");
    if (body.trigger_kind != null && body.trigger_kind !== "") patch.trigger = _discountTrigger(body);
    if (body.value_kind   != null && body.value_kind   !== "") patch.value   = _discountValue(body);
    return patch;
  }

  // Translate the policy create form / JSON body into a definePolicy
  // input. The console exposes the common shape (max codes + the two
  // combine toggles + an order-min floor); exclusive_codes / segment
  // gating stay on the bearer JSON path.
  function _policyInput(body) {
    if (body.allow_combine && typeof body.allow_combine === "object") {
      return body; // full JSON shape from a bearer client
    }
    var input = {
      slug:  typeof body.slug === "string" ? body.slug.trim() : body.slug,
      title: body.title,
      max_codes_per_order: _strictMinorInt(body.max_codes_per_order, "couponStacking", "max_codes_per_order"),
      allow_combine: {
        with_quantity_discounts: (body.with_quantity_discounts === "on" || body.with_quantity_discounts === "1"),
        with_other_codes:        (body.with_other_codes === "on" || body.with_other_codes === "1"),
      },
    };
    if (body.order_min_minor != null && body.order_min_minor !== "") {
      input.order_min_minor = _strictMinorInt(body.order_min_minor, "couponStacking", "order_min_minor");
    }
    return input;
  }

  // ---- admin web pages (browser session + setup wizard) ---------------
  //
  // The operator signs in by pasting the ADMIN_API_KEY once; that sets a
  // sealed, SameSite=Strict, /admin-scoped cookie so the rendered pages
  // (landing, dashboard, setup) are reachable from a browser. The JSON
  // API stays bearer-only. POST routes follow the storefront's
  // form-POST pattern (SameSite cookie + the app-level origin /
  // fetch-metadata guards), no separate CSRF token field.

  async function _setupComplete() {
    if (!config) return false;
    try { return (await config.get("setup.completed", false)) === true; }
    catch (_e) { return false; }
  }

  router.get("/admin", async function (req, res) {
    if (!_htmlAuthed(req, expectedToken)) {
      return _sendHtml(res, 200, renderAdminLogin({ shop_name: deps.shop_name }));
    }
    _sendHtml(res, 200, renderAdminLanding({
      shop_name:      deps.shop_name,
      setup_complete: await _setupComplete(),
      // Live payment status from the entry-point integration map. The
      // landing flags "payments aren't live" until Stripe is "enabled",
      // INDEPENDENT of the identity-only setup step — finishing the setup
      // wizard doesn't make checkout work if the Stripe secrets are unset.
      payments_live:  ((deps.integrations || {}).stripe === "enabled"),
      nav_available:  navAvailable,
    }));
  });

  router.post("/admin/login", async function (req, res) {
    var body  = req.body || {};
    var token = typeof body.token === "string" ? body.token : "";
    if (!_authOk(token, expectedToken)) {
      return _sendHtml(res, 401, renderAdminLogin({ shop_name: deps.shop_name, error: true }));
    }
    try { _setAdminCookie(req, res); }
    catch (e) {
      // Sealed cookies need an initialized vault — surface 503 rather
      // than 500 so the operator knows to configure VAULT_PASSPHRASE.
      if (e && e.code === "vault/not-initialized") {
        return _sendHtml(res, 503, renderAdminLogin({ shop_name: deps.shop_name }));
      }
      throw e;
    }
    _redirect(res, (await _setupComplete()) ? "/admin" : "/admin/setup");
  });

  router.post("/admin/logout", async function (req, res) {
    _clearAdminCookie(req, res);
    _redirect(res, "/admin");
  });

  // Integrations status — what's live + what to set to enable the rest.
  // `deps.integrations` is the live on/off map computed at the entry
  // point from the environment (admin.js never reads process.env).
  router.get("/admin/integrations", async function (req, res) {
    if (!_htmlAuthed(req, expectedToken)) {
      return _sendHtml(res, 200, renderAdminLogin({ shop_name: deps.shop_name }));
    }
    _sendHtml(res, 200, renderAdminIntegrations({
      shop_name: deps.shop_name,
      status:    deps.integrations || {},
      nav_available: navAvailable,
    }));
  });

  if (config) {
    router.get("/admin/setup", async function (req, res) {
      if (!_htmlAuthed(req, expectedToken)) return _redirect(res, "/admin");
      var url   = req.url ? new URL(req.url, "http://localhost") : null;
      var saved = !!(url && url.searchParams.get("saved"));
      var values = {};
      try {
        values.shop_name     = await config.get("shop.name", deps.shop_name || "");
        values.contact_email = await config.get("shop.contact_email", "");
        values.currency      = await config.get("shop.currency", "");
        values.support_url   = await config.get("shop.support_url", "");
      } catch (_e) { /* unconfigured — render an empty form */ }
      _sendHtml(res, 200, renderAdminSetup({ shop_name: deps.shop_name, values: values, saved: saved, nav_available: navAvailable }));
    });

    router.post("/admin/setup", async function (req, res) {
      if (!_htmlAuthed(req, expectedToken)) return _redirect(res, "/admin");
      var body = req.body || {};
      var values = {
        shop_name:     (typeof body.shop_name === "string"     ? body.shop_name     : "").trim(),
        contact_email: (typeof body.contact_email === "string" ? body.contact_email : "").trim(),
        currency:      (typeof body.currency === "string"      ? body.currency      : "").trim().toUpperCase(),
        support_url:   (typeof body.support_url === "string"   ? body.support_url   : "").trim(),
      };
      // Defensive request-shape reader: bad input re-renders the form
      // with a notice (400), never a 500.
      var notice = null;
      if (!values.shop_name) notice = "Shop name is required.";
      else if (values.shop_name.length > 80) notice = "Shop name is too long (max 80 characters).";
      else if (values.currency && !/^[A-Z]{3}$/.test(values.currency)) notice = "Currency must be a 3-letter ISO 4217 code (e.g. USD).";
      else if (values.contact_email) {
        var emailReport = b.guardEmail.validate(values.contact_email, { profile: "strict" });
        if (!emailReport || emailReport.ok === false) notice = "That contact email doesn't look valid.";
      }
      if (!notice && values.support_url) {
        var u = b.safeUrl.parse(values.support_url);
        if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) notice = "Support URL must be a valid http(s) URL.";
      }
      if (notice) {
        return _sendHtml(res, 400, renderAdminSetup({ shop_name: deps.shop_name, values: values, notice: notice, nav_available: navAvailable }));
      }
      try {
        await config.put("shop.name", values.shop_name);
        if (values.contact_email) await config.put("shop.contact_email", values.contact_email);
        if (values.currency)      await config.put("shop.currency", values.currency);
        if (values.support_url)   await config.put("shop.support_url", values.support_url);
        await config.put("setup.completed", true);
      } catch (e) {
        var n = _safeNotice(e, "setup.save");
        return _sendHtml(res, n.status, renderAdminSetup({
          shop_name: deps.shop_name, values: values, nav_available: navAvailable,
          notice: n.message,
        }));
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".setup.save", outcome: "success", metadata: {} });
      _redirect(res, "/admin/setup?saved=1");
    });
  }

  // ---- ping (auth check) ----------------------------------------------

  router.get("/admin/ping", R(async function (_req, res) {
    _json(res, 200, { ok: true, ts: Date.now() });
  }));
}

// ---- dashboard renderer -------------------------------------------------
//
// Server-rendered HTML dashboard for `GET /admin/dashboard`. Reads
// the four analytics aggregates and lays them out in a single page
// matching the storefront's dark violet brand (near-black canvas,
// #AD38DB accent, Hanken Grotesk + Space Mono). No client-side JS —
// the SVG sparkline is rendered server-side from the revenue-by-day rows.

var DASHBOARD_LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <meta name=\"robots\" content=\"noindex,nofollow\">\n" +
  "  <title>{{page_title}} — {{shop_name}}</title>\n" +
  "  RAW_ADMIN_CSS\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#admin-main\">Skip to content</a>\n" +
  "  <header class=\"admin-header\">\n" +
  "    <div class=\"admin-header__inner\">\n" +
  "      <h1>{{shop_name}} <span class=\"brand-accent\">/ admin</span></h1>\n" +
  "      <span class=\"window-label\">{{window_label}}</span>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  {{nav}}\n" +
  "  <main id=\"admin-main\">{{body}}</main>\n" +
  "</body>\n" +
  "</html>\n";

function _renderTemplate(template, vars) {
  // Strict substitution — every {{key}} must be present in vars.
  // Mirrors the email/storefront renderers but local so admin doesn't
  // reach across module boundaries for an HTML escape function.
  var seen = {};
  var out = template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, function (_m, k) {
    if (!Object.prototype.hasOwnProperty.call(vars, k)) {
      throw new Error("admin: dashboard template references unknown variable {{" + k + "}}");
    }
    seen[k] = true;
    return _htmlEscape(vars[k]);
  });
  Object.keys(vars).forEach(function (k) {
    if (!seen[k]) throw new Error("admin: dashboard template did not reference variable " + JSON.stringify(k));
  });
  return out;
}

// Splice a fully-rendered HTML fragment into `html` at the first
// occurrence of a literal `RAW_*` token, inserting the fragment LITERALLY.
//
// `String.prototype.replace(token, replacementString)` gives the
// replacement string special meaning to `$` sequences — `$$`, `$&`,
// `` $` `` (the text before the match), `$'` (the text after the match),
// `$N`. An admin page body that contains a dollar followed by a backtick
// would otherwise splice the page chrome into the body, and any other
// dollar sequence corrupts the output. Passing a REPLACER FUNCTION makes
// `String.replace` insert the return value verbatim, with no dollar
// interpretation. Mirrors the storefront's `_spliceRaw`.
function _spliceRaw(html, token, fragment) {
  return html.replace(token, function () { return fragment == null ? "" : String(fragment); });
}

function _sparkSvg(byDay, currency) {
  // SVG sparkline rendered server-side from revenue-by-day rows of
  // the dashboard's primary currency. Returns an empty placeholder
  // when no data is in-window.
  var pts = byDay.filter(function (r) { return r.currency === currency; });
  if (pts.length === 0) {
    return "<div class=\"empty\">No revenue in this window.</div>";
  }
  var max = 1;
  for (var i = 0; i < pts.length; i += 1) if (pts[i].revenue_minor > max) max = pts[i].revenue_minor;
  var W = 800, H = 120, P = 6;
  var path = pts.map(function (p, i) {
    var x = pts.length === 1 ? (W / 2) : P + (i * ((W - 2 * P) / (pts.length - 1)));
    var y = H - P - ((p.revenue_minor / max) * (H - 2 * P));
    return (i === 0 ? "M" : "L") + x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return "<div class=\"spark\"><svg viewBox=\"0 0 " + W + " " + H + "\" preserveAspectRatio=\"none\" aria-label=\"Revenue by day sparkline\">" +
         "<path d=\"" + path + "\" fill=\"none\" stroke=\"#AD38DB\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>" +
         "</svg></div>";
}

function renderDashboard(opts) {
  if (!opts) throw new TypeError("admin.renderDashboard: opts required");
  var summary  = opts.summary  || { currency: "USD", total_orders: 0, total_revenue_minor: 0, by_status: {} };
  // Operators with multi-currency catalogs receive an array of
  // per-currency rows from analytics.summary. Pick the first (most-
  // touched alphabetically) as the headline, surface the rest below.
  var primary, others;
  if (Array.isArray(summary)) {
    primary = summary[0];
    others  = summary.slice(1);
  } else {
    primary = summary;
    others  = [];
  }
  var byStatus = primary.by_status || {};

  // ---- stat cards
  var stats = "" +
    _statCard("Orders",         String(primary.total_orders),                                       false) +
    _statCard("Revenue (net)",  pricing.format(primary.total_revenue_minor, primary.currency),     true) +
    _statCard("Paid",           String(byStatus.paid || 0),                                        false) +
    _statCard("Fulfilling",     String(byStatus.fulfilling || 0),                                  false) +
    _statCard("Shipped",        String(byStatus.shipped || 0),                                     false) +
    _statCard("Delivered",      String(byStatus.delivered || 0),                                   false) +
    _statCard("Refunded",       String(byStatus.refunded || 0),                                    false) +
    _statCard("Cancelled",      String(byStatus.cancelled || 0),                                   false);

  var statsBlock =
    "<section><h2>Window summary ({{currency_label}})</h2><div class=\"stat-grid\">RAW_STATS</div></section>"
    .replace("{{currency_label}}", _htmlEscape(primary.currency))
    .replace("RAW_STATS", stats);

  // Multi-currency callout for operators with multiple currencies in
  // the same window.
  var otherCurrencies = "";
  if (others.length) {
    var rows = others.map(function (r) {
      return "<tr><td>" + _htmlEscape(r.currency) + "</td><td class=\"num\">" + _htmlEscape(String(r.total_orders)) + "</td><td class=\"num\">" + _htmlEscape(pricing.format(r.total_revenue_minor, r.currency)) + "</td></tr>";
    }).join("");
    otherCurrencies =
      "<section><h2>Other currencies in window</h2><div class=\"panel\">" +
      "<table><thead><tr><th scope=\"col\">Currency</th><th scope=\"col\" class=\"num\">Orders</th><th scope=\"col\" class=\"num\">Revenue</th></tr></thead><tbody>" + rows + "</tbody></table>" +
      "</div></section>";
  }

  // ---- revenue sparkline
  var spark =
    "<section><h2>Revenue by day</h2><div class=\"panel\">" +
    _sparkSvg(opts.by_day || [], primary.currency) +
    "</div></section>";

  // ---- top SKUs + recent orders in a two-column layout
  var topSkus = opts.top_skus || [];
  var topRows = topSkus.length
    ? topSkus.map(function (r) {
        return "<tr><td>" + _htmlEscape(r.sku) + "</td><td class=\"num\">" + _htmlEscape(String(r.units_sold)) + "</td><td class=\"num\">" + _htmlEscape(pricing.format(r.revenue_minor, r.currency)) + "</td></tr>";
      }).join("")
    : "<tr><td colspan=\"3\" class=\"empty\">No sales in this window.</td></tr>";

  var recent = opts.recent || [];
  var recentRows = recent.length
    ? recent.map(function (o) {
        var statusClass = _htmlEscape(o.status);
        return "<tr>" +
          "<td><a class=\"order-id\" href=\"/admin/orders/" + _htmlEscape(o.id) + "\">" + _htmlEscape(o.id.slice(0, 8)) + "</a></td>" +
          "<td><span class=\"status-pill " + statusClass + "\">" + _htmlEscape(o.status) + "</span></td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(o.grand_total_minor, o.currency)) + "</td>" +
          "</tr>";
      }).join("")
    : "<tr><td colspan=\"3\" class=\"empty\">No orders yet.</td></tr>";

  var twoCol =
    "<section><h2>Catalog + activity</h2><div class=\"two-col\">" +
    "  <div class=\"panel\">" +
    "    <h3 class=\"subhead\">Top SKUs by units sold</h3>" +
    "    <table><thead><tr><th scope=\"col\">SKU</th><th scope=\"col\" class=\"num\">Units</th><th scope=\"col\" class=\"num\">Revenue</th></tr></thead><tbody>" + topRows + "</tbody></table>" +
    "  </div>" +
    "  <div class=\"panel\">" +
    "    <h3 class=\"subhead\">Recent orders</h3>" +
    "    <table><thead><tr><th scope=\"col\">Order</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Total</th></tr></thead><tbody>" + recentRows + "</tbody></table>" +
    "  </div>" +
    "</div></section>";

  var body = statsBlock + otherCurrencies + spark + twoCol;

  return _renderAdminShell(
    opts.shop_name,
    "Window: last 30 days (operator-tunable via ?since=&until=)",
    body,
    "dashboard",
    opts.nav_available,
  );
}

function _statCard(label, value, accent) {
  return "<div class=\"stat-card\"><div class=\"label\">" + _htmlEscape(label) + "</div>" +
         "<div class=\"value" + (accent ? " accent" : "") + "\">" + _htmlEscape(value) + "</div></div>";
}

// ---- admin web pages (login / landing / setup wizard) -------------------

// Console nav — one entry per HTML console screen. `active` highlights
// the current page; `null`/`false` (unauthenticated pages like the
// sign-in form) renders no nav at all.
// Items carrying `requires` map to an optional `deps.<key>` primitive —
// their routes only mount when that dep is wired, so the nav link is shown
// only when `available[key]` is truthy (otherwise it would point at an
// unregistered route). Items without `requires` are always present.
var ADMIN_NAV_ITEMS = [
  { key: "home",         href: "/admin",              label: "Home" },
  { key: "dashboard",    href: "/admin/dashboard",    label: "Dashboard" },
  { key: "products",     href: "/admin/products",     label: "Products" },
  { key: "inventory",    href: "/admin/inventory",    label: "Inventory" },
  { key: "orders",       href: "/admin/orders",       label: "Orders" },
  { key: "reports",      href: "/admin/reports",      label: "Reports" },
  { key: "customers",    href: "/admin/customers",    label: "Customers",    requires: "customers" },
  { key: "returns",      href: "/admin/returns",      label: "Returns",      requires: "returns" },
  { key: "reviews",      href: "/admin/reviews",      label: "Reviews",      requires: "reviews" },
  { key: "questions",    href: "/admin/questions",    label: "Q&A",          requires: "productQa" },
  { key: "subscriptions", href: "/admin/subscription-plans", label: "Subscriptions", requires: "subscriptions" },
  { key: "collections",  href: "/admin/collections",  label: "Collections",  requires: "collections" },
  { key: "discounts",    href: "/admin/discounts",    label: "Discounts",    requires: "autoDiscount" },
  { key: "discount-allocation", href: "/admin/discount-allocation", label: "Discount splits", requires: "discountAllocation" },
  { key: "quantity-discounts", href: "/admin/quantity-discounts", label: "Quantity breaks", requires: "quantityDiscounts" },
  { key: "loyalty",      href: "/admin/loyalty",      label: "Loyalty",      requires: "loyalty" },
  { key: "tax",          href: "/admin/tax-rates",    label: "Tax",          requires: "taxRates" },
  { key: "tax-filings",  href: "/admin/tax-filings",  label: "Tax filings",  requires: "salesTaxFilings" },
  { key: "shipping",     href: "/admin/shipping",     label: "Shipping",     requires: "shippingZones" },
  { key: "shipping-labels", href: "/admin/shipping-labels", label: "Shipping labels", requires: "shippingLabels" },
  { key: "pick-lists",   href: "/admin/pick-lists",   label: "Pick lists",   requires: "pickLists" },
  { key: "announcements", href: "/admin/announcements", label: "Announcements", requires: "announcementBar" },
  { key: "blog",         href: "/admin/blog",         label: "Blog",         requires: "blog" },
  { key: "pages",        href: "/admin/pages",        label: "Pages",        requires: "storefrontPages" },
  { key: "surveys",      href: "/admin/surveys",      label: "Surveys",      requires: "customerSurveys" },
  { key: "hours",        href: "/admin/hours",        label: "Hours",        requires: "businessHours" },
  { key: "giftcards",    href: "/admin/gift-cards",    label: "Gift cards",   requires: "giftcards" },
  { key: "webhooks",     href: "/admin/webhooks",     label: "Webhooks",     requires: "webhooks" },
  { key: "integrations", href: "/admin/integrations", label: "Integrations" },
  { key: "setup",        href: "/admin/setup",        label: "Setup" },
];
// `available` is a map of optional-section key → truthy when wired. When
// omitted (a render fn called without it), optional items are shown — the
// route handlers always pass it, so a real deployment gates correctly.
function _adminNav(active, available) {
  if (active === null || active === undefined || active === false) return "";
  var links = ADMIN_NAV_ITEMS.filter(function (it) {
    return !it.requires || !available || available[it.requires];
  }).map(function (it) {
    return "<a href=\"" + it.href + "\"" + (it.key === active ? " class=\"active\" aria-current=\"page\"" : "") + ">" +
      _htmlEscape(it.label) + "</a>";
  }).join("");
  return "<nav class=\"admin-nav\"><div class=\"admin-nav__inner\">" + links + "</div></nav>";
}

function _renderAdminShell(shopName, subtitle, bodyHtml, active, available) {
  var html = _renderTemplate(DASHBOARD_LAYOUT, {
    shop_name:    shopName || "blamejs.shop",
    page_title:   subtitle || "Admin",
    window_label: subtitle || "",
    nav:          "RAW_NAV",
    body:         "RAW_BODY",
  }).replace("RAW_ADMIN_CSS", _adminStylesheetLink())
    .replace("RAW_NAV", _adminNav(active, available));
  // Splice the admin body literally so a `$`-bearing fragment can't trip
  // `String.replace`'s dollar substitution. See `_spliceRaw`.
  html = _spliceRaw(html, "RAW_BODY", bodyHtml);
  // Token every admin POST form with the per-request double-submit CSRF value
  // (seeded on the ALS by mount()'s sync middleware). Single funnel — every
  // authenticated admin page assembles here — so this is the one place the
  // field needs injecting.
  return _injectAdminCsrfFields(html);
}

// Server-rendered confirmation interstitial for irreversible /
// money-moving actions. The CSP forbids inline script, so a client
// `confirm()` dialog is impossible — instead the action button POSTs
// here, this page states the consequence, and its Confirm button POSTs
// to the real endpoint (Cancel is a plain link back). `opts.fields` is
// an optional map of hidden form inputs forwarded to the real endpoint.
function renderAdminConfirm(opts) {
  opts = opts || {};
  var fields = opts.fields || {};
  var hidden = Object.keys(fields).map(function (k) {
    return "<input type=\"hidden\" name=\"" + _htmlEscape(k) + "\" value=\"" + _htmlEscape(fields[k]) + "\">";
  }).join("");
  var body =
    "<section class=\"mw-42\">" +
      "<h2>" + _htmlEscape(opts.heading || "Confirm action") + "</h2>" +
      "<div class=\"banner banner--warn\">" + _htmlEscape(opts.consequence || "This action cannot be undone.") + "</div>" +
      "<div class=\"panel\">" +
        "<p>" + _htmlEscape(opts.detail || "Are you sure you want to continue?") + "</p>" +
        "<div class=\"actions-row\">" +
          "<form method=\"post\" action=\"" + _htmlEscape(opts.action) + "\" class=\"form-inline\">" + hidden +
            "<button class=\"btn btn--danger\" type=\"submit\">" + _htmlEscape(opts.confirm_label || "Confirm") + "</button>" +
          "</form>" +
          "<a class=\"btn btn--ghost\" href=\"" + _htmlEscape(opts.cancel_href) + "\">Cancel</a>" +
        "</div>" +
      "</div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, opts.heading || "Confirm", body, opts.active, opts.nav_available);
}

function renderAdminLogin(opts) {
  opts = opts || {};
  var err = opts.error
    ? "<div class=\"banner banner--err\">That key didn't match. Check the ADMIN_API_KEY this deployment was started with.</div>"
    : "";
  var shopName = opts.shop_name || "blamejs.shop";
  var body =
    "<div class=\"signin-wrap\">" +
      "<div class=\"signin-card\">" +
        "<div class=\"signin-mark\"><span class=\"dot\"></span>" + _htmlEscape(shopName) + " admin</div>" +
        "<h2>Sign in</h2>" +
        "<p class=\"signin-lede\">This console manages your shop's catalog, orders, and settings.</p>" +
        err +
        "<form method=\"post\" action=\"/admin/login\">" +
          "<label class=\"form-field\"><span>Admin API key</span>" +
            "<input type=\"password\" name=\"token\" autocomplete=\"off\" autofocus required>" +
            "<small>The ADMIN_API_KEY this deployment was started with.</small>" +
          "</label>" +
          "<button type=\"submit\" class=\"btn\">Sign in</button>" +
        "</form>" +
      "</div>" +
    "</div>";
  return _renderAdminShell(shopName, "Sign in", body, null);
}

function renderAdminLanding(opts) {
  opts = opts || {};
  var setupBanner = opts.setup_complete
    ? ""
    : "<div class=\"banner banner--warn\">Your shop isn't set up yet. <a href=\"/admin/setup\">Finish setup &rarr;</a></div>";
  // Payments are gated on Stripe env secrets, not the identity-only setup
  // step — so this banner shows independently of `setup_complete`. Until
  // Stripe is live, checkout 404/503s even for a "finished" shop.
  var paymentsBanner = opts.payments_live
    ? ""
    : "<div class=\"banner banner--warn\">Payments aren't live yet — customers can't check out. <a href=\"/admin/integrations\">See Integrations &rarr;</a></div>";
  var body =
    "<section>" + setupBanner + paymentsBanner +
      "<h2>Admin</h2>" +
      "<div class=\"nav-cards\">" +
        "<a class=\"nav-card\" href=\"/admin/setup\"><h3>Setup wizard</h3><p>Shop identity, currency, and contact details.</p></a>" +
        "<a class=\"nav-card\" href=\"/admin/integrations\"><h3>Integrations</h3><p>Payments, wallets, and sign-in — what's live and what to set.</p></a>" +
        "<a class=\"nav-card\" href=\"/admin/dashboard\"><h3>Dashboard</h3><p>Sales, revenue, and recent orders at a glance.</p></a>" +
      "</div>" +
      "<div class=\"actions-row\"><form method=\"post\" action=\"/admin/logout\"><button type=\"submit\" class=\"btn btn--ghost\">Sign out</button></form></div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "", body, "home", opts.nav_available);
}

function _setupField(label, name, value, type, hint, extra) {
  return "<label class=\"form-field\"><span>" + _htmlEscape(label) + "</span>" +
    "<input type=\"" + (type || "text") + "\" name=\"" + _htmlEscape(name) + "\" value=\"" + _htmlEscape(value || "") + "\"" + (extra || "") + ">" +
    (hint ? "<small>" + _htmlEscape(hint) + "</small>" : "") +
    "</label>";
}

function renderAdminSetup(opts) {
  opts = opts || {};
  var v = opts.values || {};
  var saved  = opts.saved  ? "<div class=\"banner banner--ok\">Saved. Your shop details are live.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var body =
    "<section class=\"mw-34\">" +
      "<h2>Shop setup</h2>" +
      "<p class=\"meta\">Set the basics customers see across the storefront. You can change these any time.</p>" +
      saved + notice +
      "<form method=\"post\" action=\"/admin/setup\">" +
        _setupField("Shop name", "shop_name", v.shop_name, "text", "Shown in the header, page titles, and emails.", " maxlength=\"80\" required") +
        _setupField("Contact email", "contact_email", v.contact_email, "email", "Where customer replies and operational mail land.", " maxlength=\"160\"") +
        _setupField("Default currency", "currency", v.currency, "text", "3-letter ISO 4217 code (e.g. USD, EUR, GBP).", " maxlength=\"3\" class=\"input-code\"") +
        _setupField("Support URL", "support_url", v.support_url, "url", "Linked from the storefront footer (help centre, contact page).", " maxlength=\"300\"") +
        "<div class=\"actions-row\"><button type=\"submit\" class=\"btn\">Save shop details</button>" +
          "<a class=\"btn btn--ghost\" href=\"/admin\">Back</a></div>" +
      "</form>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Setup", body, "setup", opts.nav_available);
}

// Each integration is off until the operator supplies its credentials.
// `opts.status` carries the live booleans (computed at the entry point
// from the environment); this page shows what's on and exactly what to
// set to turn the rest on. Read-only — secrets are never rendered.
var INTEGRATIONS_CATALOG = [
  { key: "stripe",           name: "Card checkout (Stripe)",  enables: "Checkout, the Payment Element, refunds, and subscription billing.",
    set: "STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY (point the Stripe webhook at /api/webhooks/stripe)." },
  { key: "express_checkout", name: "Apple Pay & Google Pay",  enables: "One-tap wallet buttons on the pay page.",
    set: "Configure Stripe (above), then register each domain: POST /admin/payment-method-domains {\"domain_name\":\"shop.example.com\"}. No Apple Developer account needed." },
  { key: "google_signin",    name: "Sign in with Google",     enables: "A “Continue with Google” button on the account login page.",
    set: "GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, SHOP_ORIGIN. Add <SHOP_ORIGIN>/account/auth/google/callback as a Google OAuth redirect URI." },
  { key: "apple_signin",     name: "Sign in with Apple",      enables: "A “Continue with Apple” button on the account login page.",
    set: "APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_CLIENT_ID (your Services ID), APPLE_PRIVATE_KEY (the .p8 key contents), SHOP_ORIGIN. Add <SHOP_ORIGIN>/account/auth/apple/callback as a Return URL on the Services ID. Requires an Apple Developer Program membership." },
  { key: "paypal",           name: "PayPal checkout",         enables: "A native PayPal button on the checkout page (create / capture via PayPal Orders v2) — distinct from PayPal-through-Stripe.",
    set: "PAYPAL_CLIENT_ID, PAYPAL_SECRET (a PayPal REST app), PAYPAL_WEBHOOK_ID, PAYPAL_ENV (sandbox|live). Card checkout (Stripe) must be live too. Point a PayPal webhook at /api/webhooks/paypal." },
];

function renderAdminIntegrations(opts) {
  opts = opts || {};
  var status = opts.status || {};
  var rows = INTEGRATIONS_CATALOG.map(function (it) {
    // Three states: "enabled" (live), "action" (credentials present but a
    // one-time operator action — e.g. registering a domain with Stripe —
    // is still required before it's actually live), "off" (not configured).
    var st = status[it.key] || "off";
    var pill, detail;
    if (st === "enabled") {
      pill = "<span class=\"status-pill paid\">Enabled</span>";
      detail = "<span class=\"meta\">Live.</span>";
    } else if (st === "action") {
      pill = "<span class=\"status-pill pending\">Action needed</span>";
      detail = "<span class=\"meta\">" + _htmlEscape(it.set) + "</span>";
    } else {
      pill = "<span class=\"status-pill cancelled\">Not configured</span>";
      detail = "<span class=\"meta\">" + _htmlEscape(it.set) + "</span>";
    }
    return "<tr>" +
        "<td><strong>" + _htmlEscape(it.name) + "</strong><br><span class=\"meta\">" + _htmlEscape(it.enables) + "</span></td>" +
        "<td>" + pill + "</td>" +
        "<td>" + detail + "</td>" +
      "</tr>";
  }).join("");
  var body =
    "<section>" +
      "<h2>Integrations</h2>" +
      "<p class=\"meta\">Every integration is off until you supply its credentials — set them as deployment secrets, then redeploy. Nothing is enabled without your keys.</p>" +
      "<div class=\"panel\"><table>" +
        "<thead><tr><th scope=\"col\">Integration</th><th scope=\"col\">Status</th><th scope=\"col\">To enable</th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table></div>" +
      "<p class=\"meta mt-125\">Sign in with Apple and PayPal are planned. “Sign in with Shop” / Shop Pay isn't available to a self-hosted store. See the README “Optional integrations” section for full setup steps.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin\">Back</a></div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Integrations", body, "integrations", opts.nav_available);
}

function renderAdminProducts(opts) {
  opts = opts || {};
  var products = opts.products || [];
  var created = opts.created ? "<div class=\"banner banner--ok\">Product created.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var rows = products.map(function (p) {
    var cls = p.status === "active" ? "paid" : (p.status === "archived" ? "refunded" : "pending");
    var action = p.status === "archived"
      ? "<form method=\"post\" action=\"/admin/products/" + _htmlEscape(p.id) + "/restore\"><button class=\"btn btn--ghost\" type=\"submit\">Restore</button></form>"
      : "<form method=\"post\" action=\"/admin/products/" + _htmlEscape(p.id) + "/archive\"><button class=\"btn btn--ghost\" type=\"submit\">Archive</button></form>";
    return "<tr><td><a href=\"/admin/products/" + _htmlEscape(p.id) + "\"><strong>" + _htmlEscape(p.title) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(p.slug) + "</code></td>" +
      "<td><span class=\"status-pill " + cls + "\">" + _htmlEscape(p.status) + "</span></td>" +
      "<td><div class=\"actions-row mt-0\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/products/" + _htmlEscape(p.id) + "\">Manage</a>" +
        action +
      "</div></td></tr>";
  }).join("");
  var table = products.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Status</th><th scope=\"col\">Action</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No products yet — create your first one below.</p>";
  var body =
    "<section><h2>Products</h2>" + created + notice + table +
      "<div class=\"panel mt mw-34\">" +
        "<h3 class=\"subhead\">New product</h3>" +
        "<form method=\"post\" action=\"/admin/products\">" +
          _setupField("Title", "title", "", "text", "", " maxlength=\"200\" required") +
          _setupField("Slug", "slug", "", "text", "Lowercase, hyphenated — the storefront URL.", " maxlength=\"200\" required") +
          "<label class=\"form-field\"><span>Status</span><select name=\"status\"><option value=\"draft\">Draft</option><option value=\"active\">Active</option></select></label>" +
          _setupField("Description", "description", "", "text", "", " maxlength=\"2000\"") +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create product</button></div>" +
        "</form>" +
      "</div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Products", body, "products", opts.nav_available);
}

// created_at / updated_at are epoch-ms numbers (order._now()); render a
// short, locale-neutral date. Guards against a string or a bad value so a
// malformed row never throws inside the template.
function _fmtDate(v) {
  var n = typeof v === "number" ? v : Date.parse(v);
  if (!isFinite(n)) return "—";
  return new Date(n).toISOString().slice(0, 10);
}

// The status values an operator can filter the orders list by — drives the
// filter chips. Kept in render-layer order (lifecycle, then terminal).
var ORDER_STATUS_FILTERS = ["pending", "paid", "fulfilling", "shipped", "delivered", "refunded", "cancelled"];

function renderAdminOrders(opts) {
  opts = opts || {};
  var orders = opts.orders || [];
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var active = opts.status || null;

  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (active ? "" : " chip--on") + "\" href=\"/admin/orders\">All</a>" +
    ORDER_STATUS_FILTERS.map(function (s) {
      return "<a class=\"chip" + (active === s ? " chip--on" : "") + "\" href=\"/admin/orders?status=" + encodeURIComponent(s) + "\">" + _htmlEscape(s) + "</a>";
    }).join("") +
    "</div>";

  var rows = orders.map(function (o) {
    var items = (o.lines || []).reduce(function (n, l) { return n + (l.qty || 0); }, 0);
    return "<tr>" +
      "<td><a class=\"order-id\" href=\"/admin/orders/" + _htmlEscape(o.id) + "\">" + _htmlEscape(o.id.slice(0, 8)) + "</a></td>" +
      "<td><span class=\"status-pill " + _htmlEscape(o.status) + "\">" + _htmlEscape(o.status) + "</span></td>" +
      "<td class=\"num\">" + _htmlEscape(String(items)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(pricing.format(o.grand_total_minor, o.currency)) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(o.created_at)) + "</td>" +
      "</tr>";
  }).join("");

  var table = orders.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Order</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Items</th><th scope=\"col\" class=\"num\">Total</th><th scope=\"col\">Placed</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No orders" + (active ? " with status “" + _htmlEscape(active) + "”" : " yet") + ".</p>";

  var body = "<section><h2>Orders</h2>" + notice + chips + table + "</section>";
  return _renderAdminShell(opts.shop_name, "Orders", body, "orders", opts.nav_available);
}

// epoch-ms → "YYYY-MM-DD" for a date <input>'s value. Mirrors `_fmtDate`'s
// guard so a bad value never throws inside the template.
function _dateInputValue(v) {
  var n = typeof v === "number" ? v : Date.parse(v);
  if (!isFinite(n)) return "";
  return new Date(n).toISOString().slice(0, 10);
}

// Sales/revenue report screen. Renders the headline totals (orders,
// gross/net revenue, refunds, AOV, refund rate), the order-status funnel,
// a by-day revenue table, and the top products — all for the selected
// date range. A date-range form lets the operator retune the window; a CSV
// link exports the by-day series. `opts.report` is null when reporting
// isn't configured (renders the notice only).
function renderAdminReports(opts) {
  opts = opts || {};
  var report = opts.report;
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  if (!report) {
    var emptyBody = "<section><h2>Reports</h2>" + notice +
      "<p class=\"empty\">No sales report available.</p></section>";
    return _renderAdminShell(opts.shop_name, "Reports", emptyBody, "reports", opts.nav_available);
  }

  var fromVal = _dateInputValue(report.from);
  // The window's `to` is exclusive (next UTC midnight after the operator's
  // chosen end day); render the inclusive end day back into the date input
  // by stepping one day back.
  var toVal   = _dateInputValue(report.to - b.constants.TIME.days(1));

  // Date-range form (GET so the window lives in the URL — bookmarkable +
  // shareable). The browser submits calendar-date params; the CSV link
  // carries the same window as raw epoch-ms.
  var csvHref = "/admin/reports?format=csv" +
    "&from=" + encodeURIComponent(String(report.from)) +
    "&to="   + encodeURIComponent(String(report.to));
  var rangeForm =
    "<form method=\"get\" action=\"/admin/reports\" class=\"order-filters\">" +
      "<label class=\"form-field\"><span>From</span><input type=\"date\" name=\"from-date\" value=\"" + _htmlEscape(fromVal) + "\"></label>" +
      "<label class=\"form-field\"><span>To</span><input type=\"date\" name=\"to-date\" value=\"" + _htmlEscape(toVal) + "\"></label>" +
      "<button class=\"btn\" type=\"submit\">Apply</button>" +
      "<a class=\"btn btn--ghost\" href=\"" + _htmlEscape(csvHref) + "\">Export CSV</a>" +
    "</form>";

  // Headline stat cards. Money formats through the same pricing helper the
  // dashboard + order pages use, in the report's headline currency.
  var cur = report.currency;
  var statsBlock =
    "<section><h2>Summary</h2><div class=\"stat-grid\">" +
      _statCard("Orders", String(report.order_count)) +
      _statCard("Gross revenue", pricing.format(report.gross_revenue_minor, cur)) +
      _statCard("Net revenue", pricing.format(report.net_revenue_minor, cur)) +
      _statCard("Refunds", pricing.format(report.refund_total_minor, cur)) +
      _statCard("Avg order value", pricing.format(report.aov_minor, cur)) +
      _statCard("Refund rate", (report.refund_rate_bps / 100).toFixed(2) + "%") +
    "</div></section>";

  // Order-status funnel — each milestone counts orders that reached at
  // least that stage within the window.
  var f = report.by_status || {};
  var funnelRows = [
    ["Checkout started", f.checkout_started],
    ["Payment intent created", f.payment_intent_created],
    ["Paid", f.paid],
    ["Fulfilled", f.fulfilled],
    ["Refunded", f.refunded],
  ].map(function (pair) {
    return "<tr><td>" + _htmlEscape(pair[0]) + "</td><td class=\"num\">" + _htmlEscape(String(pair[1] == null ? 0 : pair[1])) + "</td></tr>";
  }).join("");
  var funnelBlock =
    "<section><h2>Order status</h2><div class=\"panel\">" +
      "<table><thead><tr><th scope=\"col\">Stage</th><th scope=\"col\" class=\"num\">Orders</th></tr></thead><tbody>" + funnelRows + "</tbody></table>" +
    "</div></section>";

  // Top products by gross revenue across the window.
  var top = report.top_products || [];
  var topRows = top.length
    ? top.map(function (r) {
        return "<tr><td>" + _htmlEscape(r.sku) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(String(r.units_sold)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(r.gross_revenue_minor, r.currency)) + "</td></tr>";
      }).join("")
    : "<tr><td colspan=\"3\" class=\"empty\">No sales in this window.</td></tr>";
  var topBlock =
    "<section><h2>Top products</h2><div class=\"panel\">" +
      "<table><thead><tr><th scope=\"col\">SKU</th><th scope=\"col\" class=\"num\">Units</th><th scope=\"col\" class=\"num\">Revenue</th></tr></thead><tbody>" + topRows + "</tbody></table>" +
    "</div></section>";

  // By-day revenue series — one row per (day, currency) bucket.
  var byDay = report.by_day || [];
  var dayRows = byDay.length
    ? byDay.map(function (r) {
        return "<tr>" +
          "<td>" + _htmlEscape(r.bucket_start) + "</td>" +
          "<td>" + _htmlEscape(r.currency) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(String(r.order_count)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(r.gross_revenue_minor, r.currency)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(r.net_revenue_minor, r.currency)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(r.refund_total_minor, r.currency)) + "</td>" +
          "</tr>";
      }).join("")
    : "<tr><td colspan=\"6\" class=\"empty\">No sales in this window.</td></tr>";
  var dayBlock =
    "<section><h2>By day</h2><div class=\"panel\">" +
      "<table><thead><tr><th scope=\"col\">Date</th><th scope=\"col\">Currency</th><th scope=\"col\" class=\"num\">Orders</th><th scope=\"col\" class=\"num\">Gross</th><th scope=\"col\" class=\"num\">Net</th><th scope=\"col\" class=\"num\">Refunds</th></tr></thead><tbody>" + dayRows + "</tbody></table>" +
    "</div></section>";

  var body =
    "<section><h2>Reports</h2>" + notice +
      "<p class=\"meta\">Window: " + _htmlEscape(_fmtDate(report.from)) + " → " + _htmlEscape(_fmtDate(report.to)) + "</p>" +
      rangeForm +
    "</section>" +
    statsBlock + funnelBlock + topBlock + dayBlock;
  return _renderAdminShell(opts.shop_name, "Reports", body, "reports", opts.nav_available);
}

// A single shipping-label row for the standalone cross-order tables. Shows
// carrier + service, tracking number, cost (via pricing.format from the
// label's own minor units + currency), the broker it came from, its status
// pill, and a link to the broker's label URL. Read-only — lifecycle actions
// (mark used / void) live on the order detail where the shipment context is.
function _shippingLabelRow(l) {
  var costCell = (l.cost_minor != null && l.currency)
    ? _htmlEscape(pricing.format(l.cost_minor, l.currency))
    : "<span class=\"meta\">—</span>";
  var trackCell = l.tracking_number
    ? "<code class=\"order-id\">" + _htmlEscape(String(l.tracking_number)) + "</code>"
    : "<span class=\"meta\">—</span>";
  var urlCell = l.label_url
    ? "<a class=\"order-id\" href=\"" + _htmlEscape(String(l.label_url)) + "\" rel=\"noopener nofollow\" target=\"_blank\">Open ↗</a>"
    : "<span class=\"meta\">—</span>";
  var viaCell = l.purchased_via
    ? _htmlEscape(String(l.purchased_via))
    : "<span class=\"meta\">—</span>";
  return "<tr>" +
    "<td>" + _htmlEscape(String(l.carrier)) + " <span class=\"meta\">" + _htmlEscape(String(l.service_level || "")) + "</span></td>" +
    "<td>" + trackCell + "</td>" +
    "<td class=\"num\">" + costCell + "</td>" +
    "<td>" + viaCell + "</td>" +
    "<td><span class=\"status-pill " + _htmlEscape(String(l.status)) + "\">" + _htmlEscape(String(l.status)) + "</span></td>" +
    "<td>" + urlCell + "</td>" +
    "<td>" + _htmlEscape(_fmtDate(l.created_at)) + "</td>" +
  "</tr>";
}

// Sub-nav shared by the three standalone shipping-label screens — the
// list, the broker-spend report, and the mint queue.
function _shippingLabelSubnav(active) {
  var tabs = [
    ["list",    "/admin/shipping-labels",         "All labels"],
    ["pending", "/admin/shipping-labels/pending", "Mint queue"],
    ["costs",   "/admin/shipping-labels/costs",   "Broker spend"],
  ];
  return "<div class=\"order-filters\">" + tabs.map(function (t) {
    return "<a class=\"chip" + (active === t[0] ? " chip--on" : "") + "\" href=\"" + t[1] + "\">" + _htmlEscape(t[2]) + "</a>";
  }).join("") + "</div>";
}

// Standalone cross-order label list. The primitive exposes a list read for
// two statuses — pending (the mint queue) and voided (over a date range) —
// so the status filter offers those two. Purchased + used labels are
// reached from their order's detail panel, not browsed cross-order. A date
// range narrows the voided view (ignored for pending, which has no
// purchased/voided timestamp to range on).
function renderAdminShippingLabels(opts) {
  opts = opts || {};
  var payload = opts.payload || { status: "pending", labels: [], from: Date.now(), to: Date.now() };
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var labels = payload.labels || [];
  var status = payload.status || "pending";

  var statuses = [["pending", "Pending"], ["voided", "Voided"]];
  var chips = "<div class=\"order-filters\">" + statuses.map(function (s) {
    return "<a class=\"chip" + (status === s[0] ? " chip--on" : "") + "\" href=\"/admin/shipping-labels?status=" + encodeURIComponent(s[0]) + "\">" + _htmlEscape(s[1]) + "</a>";
  }).join("") + "</div>";

  // Date-range form only narrows the voided view (GET so the window lives in
  // the URL). For pending it's still shown for consistency but the window is
  // not applied.
  var fromVal = _dateInputValue(payload.from);
  var toVal   = _dateInputValue((payload.to || Date.now()) - b.constants.TIME.days(1));
  var rangeForm =
    "<form method=\"get\" action=\"/admin/shipping-labels\" class=\"order-filters\">" +
      "<input type=\"hidden\" name=\"status\" value=\"" + _htmlEscape(status) + "\">" +
      "<label class=\"form-field\"><span>From</span><input type=\"date\" name=\"from-date\" value=\"" + _htmlEscape(fromVal) + "\"></label>" +
      "<label class=\"form-field\"><span>To</span><input type=\"date\" name=\"to-date\" value=\"" + _htmlEscape(toVal) + "\"></label>" +
      "<button class=\"btn\" type=\"submit\">Apply</button>" +
    "</form>";

  var rows = labels.map(_shippingLabelRow).join("");
  var table = labels.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Carrier</th><th scope=\"col\">Tracking</th><th scope=\"col\" class=\"num\">Cost</th><th scope=\"col\">Broker</th><th scope=\"col\">Status</th><th scope=\"col\">Label</th><th scope=\"col\">Created</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No " + _htmlEscape(status) + " labels" + (status === "voided" ? " in this window" : "") + ".</p>";

  var body =
    "<section><h2>Shipping labels</h2>" + notice +
      _shippingLabelSubnav("list") +
      chips +
      (status === "voided" ? rangeForm : "") +
      table +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Shipping labels", body, "shipping-labels", opts.nav_available);
}

// The mint queue: pending labels awaiting a broker mint, oldest first. The
// operator's broker worker drains this (requestLabel wrote each row;
// markPurchased clears it). Read-only console view of the same queue.
function renderAdminShippingLabelsPending(opts) {
  opts = opts || {};
  var labels = opts.labels || [];
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var rows = labels.map(_shippingLabelRow).join("");
  var table = labels.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Carrier</th><th scope=\"col\">Tracking</th><th scope=\"col\" class=\"num\">Cost</th><th scope=\"col\">Broker</th><th scope=\"col\">Status</th><th scope=\"col\">Label</th><th scope=\"col\">Created</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No labels awaiting a broker mint.</p>";
  var body =
    "<section><h2>Shipping labels</h2>" + notice +
      _shippingLabelSubnav("pending") +
      "<p class=\"meta\">Pending labels awaiting a broker mint, oldest first (up to " + String(MAX_LABEL_LIST_LIMIT) + ").</p>" +
      table +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Shipping labels", body, "shipping-labels", opts.nav_available);
}

// Broker-spend report: gross label spend + label count grouped by broker +
// currency over a date range, with an optional carrier filter and a
// per-currency headline rollup. Money formats through the same pricing
// helper the order + reports pages use.
function renderAdminShippingLabelCosts(opts) {
  opts = opts || {};
  var report = opts.report || { from: Date.now(), to: Date.now(), by_broker: [], totals: [], carrier: null };
  var carriers = opts.carriers || [];
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var fromVal = _dateInputValue(report.from);
  var toVal   = _dateInputValue(report.to - b.constants.TIME.days(1));
  var carrierOpts = "<option value=\"\">All carriers</option>" + carriers.map(function (c) {
    return "<option value=\"" + _htmlEscape(c) + "\"" + (report.carrier === c ? " selected" : "") + ">" + _htmlEscape(c) + "</option>";
  }).join("");
  var rangeForm =
    "<form method=\"get\" action=\"/admin/shipping-labels/costs\" class=\"order-filters\">" +
      "<label class=\"form-field\"><span>From</span><input type=\"date\" name=\"from-date\" value=\"" + _htmlEscape(fromVal) + "\"></label>" +
      "<label class=\"form-field\"><span>To</span><input type=\"date\" name=\"to-date\" value=\"" + _htmlEscape(toVal) + "\"></label>" +
      "<label class=\"form-field\"><span>Carrier</span><select name=\"carrier\">" + carrierOpts + "</select></label>" +
      "<button class=\"btn\" type=\"submit\">Apply</button>" +
    "</form>";

  // Per-currency headline cards — total gross spend + label count.
  var totals = report.totals || [];
  var statsBlock = totals.length
    ? "<section><h2>Total spend</h2><div class=\"stat-grid\">" + totals.map(function (t) {
        return _statCard("Spend (" + t.currency + ")", pricing.format(t.total_minor, t.currency)) +
          _statCard("Labels (" + t.currency + ")", String(t.label_count));
      }).join("") + "</div></section>"
    : "<section><h2>Total spend</h2><p class=\"empty\">No labels purchased in this window.</p></section>";

  var byBroker = report.by_broker || [];
  var brokerRows = byBroker.length
    ? byBroker.map(function (r) {
        return "<tr>" +
          "<td>" + _htmlEscape(String(r.purchased_via)) + "</td>" +
          "<td>" + _htmlEscape(String(r.currency)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(String(r.label_count)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(r.total_minor, r.currency)) + "</td>" +
        "</tr>";
      }).join("")
    : "<tr><td colspan=\"4\" class=\"empty\">No labels purchased in this window.</td></tr>";
  var brokerBlock =
    "<section><h2>By broker</h2><div class=\"panel\">" +
      "<table><thead><tr><th scope=\"col\">Broker</th><th scope=\"col\">Currency</th><th scope=\"col\" class=\"num\">Labels</th><th scope=\"col\" class=\"num\">Spend</th></tr></thead><tbody>" + brokerRows + "</tbody></table>" +
    "</div></section>";

  var body =
    "<section><h2>Shipping labels</h2>" + notice +
      _shippingLabelSubnav("costs") +
      "<p class=\"meta\">Window: " + _htmlEscape(_fmtDate(report.from)) + " → " + _htmlEscape(_fmtDate(report.to)) +
        (report.carrier ? " · carrier " + _htmlEscape(String(report.carrier)) : "") + "</p>" +
      rangeForm +
    "</section>" +
    statsBlock + brokerBlock;
  return _renderAdminShell(opts.shop_name, "Shipping labels", body, "shipping-labels", opts.nav_available);
}

function renderAdminOrder(opts) {
  opts = opts || {};
  var o = opts.order;
  var transitions = opts.transitions || [];
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Order updated.</div>" : "";
  var shipOk = opts.ship_done ? "<div class=\"banner banner--ok\">Shipment updated.</div>" : "";
  var labelOk = opts.label_done ? "<div class=\"banner banner--ok\">Shipping label updated.</div>" : "";
  var splitOk = opts.split_done ? "<div class=\"banner banner--ok\">Split shipment updated.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var lineRows = (o.lines || []).map(function (l) {
    return "<tr>" +
      "<td>" + _htmlEscape(l.sku) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(l.qty)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(pricing.format(l.unit_amount_minor, l.unit_currency)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(pricing.format(l.line_total_minor, l.unit_currency)) + "</td>" +
      "</tr>";
  }).join("");
  var linesTable = (o.lines && o.lines.length)
    ? "<table><thead><tr><th scope=\"col\">SKU</th><th scope=\"col\" class=\"num\">Qty</th><th scope=\"col\" class=\"num\">Unit</th><th scope=\"col\" class=\"num\">Line</th></tr></thead><tbody>" + lineRows + "</tbody></table>"
    : "<p class=\"empty\">No line items recorded.</p>";

  function _total(label, minor, strong) {
    return "<tr><td>" + _htmlEscape(label) + "</td><td class=\"num\">" +
      (strong ? "<strong>" : "") + _htmlEscape(pricing.format(minor, o.currency)) + (strong ? "</strong>" : "") +
      "</td></tr>";
  }
  var totals = "<table class=\"order-totals\"><tbody>" +
    _total("Subtotal", o.subtotal_minor, false) +
    (o.discount_minor ? _total("Discount", -o.discount_minor, false) : "") +
    _total("Tax", o.tax_minor, false) +
    _total("Shipping", o.shipping_minor, false) +
    _total("Total", o.grand_total_minor, true) +
    "</tbody></table>";

  var ship = o.ship_to || {};
  var shipLines = [ship.name, ship.line1, ship.line2,
    [ship.city, ship.region, ship.postal_code].filter(Boolean).join(", "), ship.country]
    .filter(Boolean).map(function (s) { return _htmlEscape(String(s)); }).join("<br>");

  // One form per legal next transition. `refund` is special: it moves
  // money, so it posts to the payment-refund endpoint (which issues the
  // provider refund THEN advances the FSM) rather than the bare
  // state-transition endpoint — and only when there's a captured payment
  // to refund. Every other move posts to /transition. A terminal status
  // (empty list) shows a note instead of buttons.
  var actionForms = transitions.map(function (t) {
    if (t.on === "refund") {
      if (!opts.can_refund) return "";  // no payment intent — nothing to refund here
      // POSTs to the confirm interstitial (states the amount + warns
      // it's irreversible), whose Confirm button POSTs the real refund.
      return "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/refund/confirm\" class=\"form-inline\">" +
        "<button class=\"btn btn--danger\" type=\"submit\">" + _htmlEscape(t.label) + "</button>" +
        "</form>";
    }
    var danger = (t.on === "cancel");
    return "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/transition\" class=\"form-inline\">" +
      "<input type=\"hidden\" name=\"event\" value=\"" + _htmlEscape(t.on) + "\">" +
      "<button class=\"btn" + (danger ? " btn--danger" : "") + "\" type=\"submit\">" + _htmlEscape(t.label) + "</button>" +
      "</form>";
  }).filter(Boolean).join(" ");
  var actions = actionForms || "<span class=\"meta\">This order is in a final state — no further changes.</span>";

  // Printable operator documents — a receipt + a packing slip, each opening
  // the print-optimized HTML in a new tab. Rendered only when the matching
  // render primitive is wired (the routes mount only then).
  var docLinks = [];
  if (opts.can_receipt) {
    docLinks.push("<a class=\"btn btn--ghost\" href=\"/admin/orders/" + _htmlEscape(o.id) + "/receipt\" target=\"_blank\" rel=\"noopener\">Print receipt</a>");
  }
  if (opts.can_packing_slip) {
    docLinks.push("<a class=\"btn btn--ghost\" href=\"/admin/orders/" + _htmlEscape(o.id) + "/packing-slip\" target=\"_blank\" rel=\"noopener\">Print packing slip</a>");
  }
  var documentsPanel = docLinks.length
    ? "<div class=\"panel mt\"><h3 class=\"subhead\">Documents</h3>" +
        "<div class=\"order-actions\">" + docLinks.join(" ") + "</div>" +
      "</div>"
    : "";

  // Shipment + tracking panel. Renders only when the tracking primitive is
  // wired (`can_track`). For each existing shipment: the carrier, status,
  // tracking number (linked to the carrier's public URL when known), and
  // its carrier-event log, plus a single-select form to record the next
  // event. A bottom form attaches a NEW shipment (carrier + optional
  // tracking number). Carrier + status option lists come from the
  // primitive's frozen enums (deps.carriers / deps.statuses).
  var trackingPanel = "";
  if (opts.can_track) {
    var carriers = opts.carriers || [];
    var statuses = opts.statuses || [];
    var carrierOpts = carriers.map(function (c) {
      return "<option value=\"" + _htmlEscape(c) + "\">" + _htmlEscape(c) + "</option>";
    }).join("");
    var shipments = opts.shipments || [];
    var shipBlocks = shipments.map(function (s) {
      var carrierLabel = s.carrier === "other" ? (s.carrier_other_name || "other") : s.carrier;
      var trackingCell = s.tracking_number
        ? (s.tracking_url
            ? "<a class=\"order-id\" href=\"" + _htmlEscape(String(s.tracking_url)) + "\" rel=\"noopener nofollow\" target=\"_blank\">" + _htmlEscape(String(s.tracking_number)) + " ↗</a>"
            : "<code class=\"order-id\">" + _htmlEscape(String(s.tracking_number)) + "</code>")
        : "<span class=\"meta\">—</span>";
      var eventRows = (s.events || []).map(function (e) {
        return "<tr><td>" + _htmlEscape(String(e.status)) + "</td>" +
          "<td>" + (e.location ? _htmlEscape(String(e.location)) : "<span class=\"meta\">—</span>") + "</td>" +
          "<td>" + _htmlEscape(_fmtDate(e.occurred_at)) + "</td></tr>";
      }).join("");
      var eventsTable = (s.events && s.events.length)
        ? "<table><thead><tr><th scope=\"col\">Status</th><th scope=\"col\">Location</th><th scope=\"col\">When</th></tr></thead><tbody>" + eventRows + "</tbody></table>"
        : "<p class=\"empty\">No carrier events yet.</p>";
      var statusOpts = statuses.map(function (st) {
        return "<option value=\"" + _htmlEscape(st) + "\">" + _htmlEscape(st) + "</option>";
      }).join("");
      var eventForm =
        "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/shipments/" + _htmlEscape(s.id) + "/events\" class=\"return-action\">" +
          "<h4>Record event</h4>" +
          "<label class=\"form-field\"><span>Status</span><select name=\"status\" required>" + statusOpts + "</select></label>" +
          _setupField("Location", "location", "", "text", "Carrier-reported, optional.", " maxlength=\"128\"") +
          _setupField("Detail", "detail", "", "text", "Optional note.", " maxlength=\"512\"") +
          "<button class=\"btn\" type=\"submit\">Record event</button>" +
        "</form>";
      // Carrier-label sub-panel — only when the labels primitive is wired
      // (its routes mount only then). Lists every recorded label for the
      // shipment (purchased / used / voided) with its tracking number,
      // cost, and a "Mark used" action on purchased labels, plus a form to
      // record a freshly-minted broker label.
      var labelPanel = "";
      if (opts.can_label) {
        labelPanel = _orderLabelPanel(o.id, s, opts.label_carriers || [], opts.label_package_types || [], opts.label_purchased_via || []);
      }
      return "<div class=\"panel mt\">" +
        "<div class=\"order-shipment-head\">" +
          "<strong>" + _htmlEscape(String(carrierLabel)) + "</strong> " +
          "<span class=\"status-pill " + _htmlEscape(s.status) + "\">" + _htmlEscape(s.status) + "</span>" +
        "</div>" +
        "<p class=\"meta\">Tracking: " + trackingCell + "</p>" +
        eventsTable +
        labelPanel +
        eventForm +
      "</div>";
    }).join("");
    var addShipmentForm =
      "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/shipments\" class=\"return-action\">" +
        "<h4>Add a shipment</h4>" +
        "<label class=\"form-field\"><span>Carrier</span><select name=\"carrier\" required>" + carrierOpts + "</select></label>" +
        _setupField("Carrier name (if “other”)", "carrier_other_name", "", "text", "Required only when carrier is “other”.", " maxlength=\"64\"") +
        _setupField("Tracking number", "tracking_number", "", "text", "Optional — links to the carrier's tracking page.", " maxlength=\"64\"") +
        "<button class=\"btn\" type=\"submit\">Add shipment</button>" +
      "</form>";
    trackingPanel =
      "<div class=\"panel mt\"><h3 class=\"subhead\">Shipments &amp; tracking</h3>" +
        (shipments.length ? shipBlocks : "<p class=\"empty\">No shipments yet.</p>") +
        addShipmentForm +
      "</div>";
  }

  // Split-shipment planner panel — only when the split primitive is wired.
  // Lists every plan for the order (proposed / executed / cancelled) with
  // its parcels, an Execute / Cancel action on proposed plans, and a form
  // to plan a new manual split: per-line, which parcel (1, 2, …) the line
  // goes in + how much. A proposed plan that doesn't consume every line
  // qty is refused by the primitive (surfaced as a notice).
  var splitPanel = "";
  if (opts.can_split) {
    splitPanel = _orderSplitPanel(o, opts.split_plans || []);
  }

  var body =
    "<section class=\"mw-48\">" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/orders\">&larr; Orders</a></div>" +
      "<h2>Order <code class=\"order-id\">" + _htmlEscape(o.id.slice(0, 8)) + "</code> " +
        "<span class=\"status-pill " + _htmlEscape(o.status) + "\">" + _htmlEscape(o.status) + "</span></h2>" +
      "<p class=\"meta\">Placed " + _htmlEscape(_fmtDate(o.created_at)) + " · last updated " + _htmlEscape(_fmtDate(o.updated_at)) +
        (o.payment_intent_id ? " · payment <code class=\"order-id\">" + _htmlEscape(o.payment_intent_id) + "</code>" : "") + "</p>" +
      moved + shipOk + labelOk + splitOk + notice +
      "<div class=\"two-col\">" +
        "<div class=\"panel\"><h3 class=\"subhead\">Items</h3>" + linesTable + "</div>" +
        "<div class=\"panel\"><h3 class=\"subhead\">Ship to</h3>" +
          (shipLines || "<span class=\"meta\">No shipping address.</span>") +
          "<h3 class=\"subhead subhead--sp\">Totals</h3>" + totals +
        "</div>" +
      "</div>" +
      "<div class=\"panel mt\"><h3 class=\"subhead\">Actions</h3>" +
        "<div class=\"order-actions\">" + actions + "</div>" +
      "</div>" +
      documentsPanel +
      splitPanel +
      trackingPanel +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Order " + o.id.slice(0, 8), body, "orders", opts.nav_available);
}

// Per-shipment carrier-label sub-panel for the order detail. Lists the
// recorded labels (tracking number, broker, cost, status pill) with a
// "Mark used" action on purchased ones, then a form to record a freshly-
// minted broker label (carrier + service + parcel dims + tracking + URL +
// cost). The framework never mints the label — the operator records what
// their broker returned. Cost is shown via pricing.format from the label's
// own minor-units + currency.
function _orderLabelPanel(orderId, shipment, carriers, packageTypes, purchasedVia) {
  var labels = shipment.labels || [];
  var labelRows = labels.map(function (l) {
    var costCell = (l.cost_minor != null && l.currency)
      ? _htmlEscape(pricing.format(l.cost_minor, l.currency))
      : "<span class=\"meta\">—</span>";
    var trackCell = l.tracking_number
      ? "<code class=\"order-id\">" + _htmlEscape(String(l.tracking_number)) + "</code>"
      : "<span class=\"meta\">—</span>";
    var urlCell = l.label_url
      ? "<a class=\"order-id\" href=\"" + _htmlEscape(String(l.label_url)) + "\" rel=\"noopener nofollow\" target=\"_blank\">Open ↗</a>"
      : "<span class=\"meta\">—</span>";
    // A purchased label can be marked used (handed to the carrier) OR voided
    // (broker void, within the 30-day window). The void form carries a
    // required reason input so the operator records WHY before the POST; the
    // primitive refuses a blank/expired void with a 400 → notice.
    var actionCell = "<span class=\"meta\">—</span>";
    if (l.status === "purchased") {
      actionCell =
        "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(orderId) + "/labels/" + _htmlEscape(l.id) + "/used\" class=\"form-inline\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Mark used</button></form> " +
        "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(orderId) + "/labels/" + _htmlEscape(l.id) + "/void\" class=\"form-inline\">" +
          "<input type=\"text\" name=\"reason\" placeholder=\"Void reason\" maxlength=\"512\" aria-label=\"Void reason\" required>" +
          "<button class=\"btn btn--danger\" type=\"submit\">Void</button></form>";
    }
    return "<tr>" +
      "<td>" + _htmlEscape(String(l.carrier)) + " <span class=\"meta\">" + _htmlEscape(String(l.service_level || "")) + "</span></td>" +
      "<td>" + trackCell + "</td>" +
      "<td class=\"num\">" + costCell + "</td>" +
      "<td><span class=\"status-pill " + _htmlEscape(l.status) + "\">" + _htmlEscape(l.status) + "</span></td>" +
      "<td>" + urlCell + "</td>" +
      "<td>" + actionCell + "</td>" +
    "</tr>";
  }).join("");
  var labelsTable = labels.length
    ? "<table><thead><tr><th scope=\"col\">Carrier</th><th scope=\"col\">Tracking</th><th scope=\"col\" class=\"num\">Cost</th><th scope=\"col\">Status</th><th scope=\"col\">Label</th><th scope=\"col\"></th></tr></thead><tbody>" + labelRows + "</tbody></table>"
    : "<p class=\"empty\">No labels recorded for this shipment.</p>";
  var carrierOpts = carriers.map(function (c) {
    return "<option value=\"" + _htmlEscape(c) + "\">" + _htmlEscape(c) + "</option>";
  }).join("");
  var pkgOpts = packageTypes.map(function (p) {
    return "<option value=\"" + _htmlEscape(p) + "\">" + _htmlEscape(p) + "</option>";
  }).join("");
  var viaOpts = purchasedVia.map(function (v) {
    return "<option value=\"" + _htmlEscape(v) + "\"" + (v === "manual" ? " selected" : "") + ">" + _htmlEscape(v) + "</option>";
  }).join("");
  var recordForm =
    "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(orderId) + "/shipments/" + _htmlEscape(shipment.id) + "/labels\" class=\"return-action\">" +
      "<h4>Record a shipping label</h4>" +
      "<label class=\"form-field\"><span>Carrier</span><select name=\"carrier\" required>" + carrierOpts + "</select></label>" +
      _setupField("Service level", "service_level", "", "text", "e.g. Ground, Priority.", " maxlength=\"64\" required") +
      "<label class=\"form-field\"><span>Package type</span><select name=\"package_type\" required>" + pkgOpts + "</select></label>" +
      _setupField("Weight (grams)", "weight_grams", "", "text", "Whole grams, > 0.", " inputmode=\"numeric\" required") +
      _setupField("Length (mm)", "length_mm", "", "text", "Whole millimetres, > 0.", " inputmode=\"numeric\" required") +
      _setupField("Width (mm)", "width_mm", "", "text", "Whole millimetres, > 0.", " inputmode=\"numeric\" required") +
      _setupField("Height (mm)", "height_mm", "", "text", "Whole millimetres, > 0.", " inputmode=\"numeric\" required") +
      _setupField("Tracking number", "tracking_number", "", "text", "The carrier-minted tracking number.", " maxlength=\"64\" required") +
      _setupField("Label URL", "label_url", "", "url", "https:// link to the broker's PDF/ZPL label.", " maxlength=\"2048\" required") +
      _setupField("Cost (minor units)", "cost_minor", "", "text", "Integer minor units (e.g. 650 = $6.50).", " inputmode=\"numeric\" required") +
      _setupField("Currency", "currency", "", "text", "3-letter ISO 4217 (e.g. USD).", " maxlength=\"3\" class=\"input-code\" required") +
      "<label class=\"form-field\"><span>Recorded via</span><select name=\"purchased_via\" required>" + viaOpts + "</select></label>" +
      "<button class=\"btn\" type=\"submit\">Record label</button>" +
    "</form>";
  return "<div class=\"order-label-block\"><h4>Labels</h4>" + labelsTable + recordForm + "</div>";
}

// Split-shipment planner panel for the order detail. Lists existing plans
// (parcels + status + an Execute/Cancel action on proposed ones), then a
// manual-split form: one row per order_line with a "parcel" number (which
// parcel this line ships in) + a qty. The primitive's conservation check
// enforces that every unit lands in exactly one parcel.
function _orderSplitPanel(o, plans) {
  var planBlocks = plans.map(function (plan) {
    var parcels = (plan.shipments || []).map(function (parcel, i) {
      var lines = (parcel.lines || []).map(function (pl) {
        return "<li><code class=\"order-id\">" + _htmlEscape(String(pl.line_id).slice(0, 8)) + "</code> &times; " + _htmlEscape(String(pl.qty)) + "</li>";
      }).join("");
      return "<div class=\"split-parcel\"><strong>Parcel " + _htmlEscape(String(i + 1)) + "</strong> " +
        "<span class=\"meta\">" + _htmlEscape(String(parcel.rationale || "manual")) + "</span>" +
        "<ul>" + lines + "</ul></div>";
    }).join("");
    var planActions = "";
    if (plan.status === "proposed") {
      planActions =
        "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/split/" + _htmlEscape(plan.id) + "/execute\" class=\"form-inline\">" +
          "<button class=\"btn\" type=\"submit\">Execute (create shipments)</button></form> " +
        "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/split/" + _htmlEscape(plan.id) + "/cancel\" class=\"form-inline\">" +
          "<button class=\"btn btn--danger\" type=\"submit\">Cancel plan</button></form>";
    } else if (plan.status === "executed") {
      planActions = "<span class=\"meta\">" + _htmlEscape(String((plan.shipment_ids || []).length)) + " shipment(s) created.</span>";
    }
    return "<div class=\"panel mt\">" +
      "<div class=\"order-shipment-head\"><strong>Plan <code class=\"order-id\">" + _htmlEscape(plan.id.slice(0, 8)) + "</code></strong> " +
        "<span class=\"status-pill " + _htmlEscape(plan.status) + "\">" + _htmlEscape(plan.status) + "</span></div>" +
      parcels +
      "<div class=\"order-actions\">" + planActions + "</div>" +
    "</div>";
  }).join("");
  // Manual-split form: one row per order_line. The operator types a parcel
  // number (1, 2, …) + a qty per line; lines sharing a parcel number ship
  // together. Defaults each line's qty to its full order qty in parcel 1
  // (the no-op single-parcel plan) so the form is pre-filled and the
  // operator only edits what splits.
  var lineRows = (o.lines || []).map(function (l) {
    return "<tr>" +
      "<td>" + _htmlEscape(l.sku) + " <span class=\"meta\">(" + _htmlEscape(String(l.qty)) + ")</span></td>" +
      "<td><input type=\"text\" name=\"parcel_" + _htmlEscape(l.id) + "\" value=\"1\" inputmode=\"numeric\" class=\"input-code\"></td>" +
      "<td><input type=\"text\" name=\"qty_" + _htmlEscape(l.id) + "\" value=\"" + _htmlEscape(String(l.qty)) + "\" inputmode=\"numeric\" class=\"input-code\"></td>" +
    "</tr>";
  }).join("");
  var planForm = (o.lines && o.lines.length)
    ? "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/split/plan\" class=\"return-action\">" +
        "<h4>Plan a manual split</h4>" +
        "<p class=\"meta\">Assign each line to a parcel number (lines sharing a number ship together). Every unit must land in a parcel.</p>" +
        "<table><thead><tr><th scope=\"col\">Line (order qty)</th><th scope=\"col\">Parcel</th><th scope=\"col\">Qty</th></tr></thead><tbody>" + lineRows + "</tbody></table>" +
        "<button class=\"btn\" type=\"submit\">Propose split</button>" +
      "</form>"
    : "<p class=\"empty\">No order lines to split.</p>";
  return "<div class=\"panel mt\"><h3 class=\"subhead\">Split shipments</h3>" +
    (plans.length ? planBlocks : "<p class=\"empty\">No split plans yet.</p>") +
    planForm +
  "</div>";
}

// Pick-lists index: the worksheet roster + a filter + a generate form.
// Each row links to the worksheet detail. The generate form takes a
// location (required), an optional pasted set of order ids (blank =
// auto-select every eligible order at the location), a sort order, and an
// optional max-lines cap.
function renderAdminPickLists(opts) {
  opts = opts || {};
  var lists = opts.lists || [];
  var statuses = opts.statuses || [];
  var sortOptions = opts.sort_options || [];
  var created = opts.created ? "<div class=\"banner banner--ok\">Pick list created.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var rows = lists.map(function (l) {
    return "<tr>" +
      "<td><a href=\"/admin/pick-lists/" + _htmlEscape(l.id) + "\"><code class=\"order-id\">" + _htmlEscape(l.id.slice(0, 8)) + "</code></a></td>" +
      "<td>" + _htmlEscape(String(l.location_code)) + "</td>" +
      "<td><span class=\"status-pill " + _htmlEscape(l.status) + "\">" + _htmlEscape(l.status) + "</span></td>" +
      "<td>" + _htmlEscape(String(l.sort_by)) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(l.generated_at)) + "</td>" +
    "</tr>";
  }).join("");
  var table = lists.length
    ? "<table><thead><tr><th scope=\"col\">List</th><th scope=\"col\">Location</th><th scope=\"col\">Status</th><th scope=\"col\">Sort</th><th scope=\"col\">Generated</th></tr></thead><tbody>" + rows + "</tbody></table>"
    : "<p class=\"empty\">No pick lists yet. Generate one from the open orders at a location.</p>";

  var statusFilter = "<form method=\"get\" action=\"/admin/pick-lists\" class=\"form-inline\">" +
    "<label class=\"form-field\"><span>Location</span><input type=\"text\" name=\"location\" value=\"" + _htmlEscape(opts.location || "") + "\" maxlength=\"64\"></label>" +
    "<label class=\"form-field\"><span>Status</span><select name=\"status\">" +
      "<option value=\"\">All</option>" +
      statuses.map(function (s) {
        return "<option value=\"" + _htmlEscape(s) + "\"" + (opts.status === s ? " selected" : "") + ">" + _htmlEscape(s) + "</option>";
      }).join("") +
    "</select></label>" +
    "<button class=\"btn btn--ghost\" type=\"submit\">Filter</button>" +
  "</form>";

  var sortOpts = sortOptions.map(function (s) {
    return "<option value=\"" + _htmlEscape(s) + "\">" + _htmlEscape(s) + "</option>";
  }).join("");
  var generateForm =
    "<form method=\"post\" action=\"/admin/pick-lists\" class=\"return-action\">" +
      "<h4>Generate a pick list</h4>" +
      _setupField("Location code", "location_code", "", "text", "Warehouse the picker works (e.g. WH-EAST).", " maxlength=\"64\" required") +
      "<label class=\"form-field\"><span>Order ids (optional)</span>" +
        "<textarea name=\"order_ids\" rows=\"3\" placeholder=\"Leave blank to batch every open order at this location\"></textarea>" +
        "<small>Comma- or newline-separated order ids. Blank = auto-select every paid/fulfilling order.</small>" +
      "</label>" +
      "<label class=\"form-field\"><span>Sort by</span><select name=\"sort_by\">" + sortOpts + "</select></label>" +
      _setupField("Max lines (optional)", "max_lines", "", "text", "Cap the worksheet size. Blank = default.", " inputmode=\"numeric\"") +
      "<button class=\"btn\" type=\"submit\">Generate</button>" +
    "</form>";

  var body =
    "<section class=\"mw-48\">" +
      "<h2>Pick lists</h2>" +
      "<p class=\"meta\">Consolidate open orders into an aisle-sequenced picker route.</p>" +
      created + notice +
      statusFilter +
      "<div class=\"panel mt\">" + table + "</div>" +
      "<div class=\"panel mt\">" + generateForm + "</div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Pick lists", body, "pick-lists", opts.nav_available);
}

// Pick-list detail: the worksheet header + per-line confirm forms + the
// complete / cancel actions + a link to the print view. Each line shows
// the SKU, expected qty, aisle/bin position, and (once confirmed) the
// actual qty + picker + when. Lines are grouped by aisle_position so the
// picker sees the route in walk order.
function renderAdminPickList(opts) {
  opts = opts || {};
  var l = opts.list;
  var created = opts.created ? "<div class=\"banner banner--ok\">Pick list created.</div>" : "";
  var picked = opts.picked ? "<div class=\"banner banner--ok\">Line updated.</div>" : "";
  var completed = opts.completed ? "<div class=\"banner banner--ok\">Pick list completed — shipments created.</div>" : "";
  var cancelled = opts.cancelled ? "<div class=\"banner banner--ok\">Pick list cancelled.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  if (!l) {
    var nf =
      "<section class=\"mw-48\">" +
        "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/pick-lists\">&larr; Pick lists</a></div>" +
        notice +
      "</section>";
    return _renderAdminShell(opts.shop_name, "Pick list", nf, "pick-lists", opts.nav_available);
  }

  var active = (l.status === "generated" || l.status === "in_progress");
  var lineRows = (l.lines || []).map(function (ln) {
    var confirmed = ln.actual_quantity != null;
    var pickedCell = confirmed
      ? _htmlEscape(String(ln.actual_quantity)) + "<span class=\"meta\"> by " + _htmlEscape(String(ln.picked_by || "—")) + " · " + _htmlEscape(_fmtDate(ln.picked_at)) + "</span>"
      : "<span class=\"meta\">Not picked</span>";
    var action = active
      ? "<form method=\"post\" action=\"/admin/pick-lists/" + _htmlEscape(l.id) + "/lines/" + _htmlEscape(ln.id) + "/pick\" class=\"form-inline\">" +
          "<input type=\"text\" name=\"actual_quantity\" value=\"" + _htmlEscape(confirmed ? String(ln.actual_quantity) : String(ln.expected_quantity)) + "\" inputmode=\"numeric\" class=\"input-code\" aria-label=\"Picked quantity\">" +
          "<input type=\"hidden\" name=\"picker_id\" value=\"console\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">" + (confirmed ? "Recount" : "Confirm") + "</button>" +
        "</form>"
      : "<span class=\"meta\">—</span>";
    return "<tr>" +
      "<td>" + _htmlEscape(String(ln.aisle_position)) + "</td>" +
      "<td>" + _htmlEscape(String(ln.sku)) + "</td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(String(ln.order_id).slice(0, 8)) + "</code></td>" +
      "<td class=\"num\">" + _htmlEscape(String(ln.expected_quantity)) + "</td>" +
      "<td>" + pickedCell + "</td>" +
      "<td>" + action + "</td>" +
    "</tr>";
  }).join("");
  var linesTable = (l.lines && l.lines.length)
    ? "<table><thead><tr><th scope=\"col\">Aisle/bin</th><th scope=\"col\">SKU</th><th scope=\"col\">Order</th><th scope=\"col\" class=\"num\">Expected</th><th scope=\"col\">Picked</th><th scope=\"col\"></th></tr></thead><tbody>" + lineRows + "</tbody></table>"
    : "<p class=\"empty\">This worksheet has no lines.</p>";

  // Variance summary — short / over picks only (the discrepancies feed
  // returns every line; surface the non-zero ones here).
  var discRows = (opts.discrepancies || []).filter(function (d) {
    return d.discrepancy != null && d.discrepancy !== 0;
  }).map(function (d) {
    return "<tr><td>" + _htmlEscape(String(d.sku)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(d.expected_quantity)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(d.actual_quantity)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(d.discrepancy)) + "</td></tr>";
  }).join("");
  var variancePanel = discRows
    ? "<div class=\"panel mt\"><h3 class=\"subhead\">Variances</h3>" +
        "<table><thead><tr><th scope=\"col\">SKU</th><th scope=\"col\" class=\"num\">Expected</th><th scope=\"col\" class=\"num\">Picked</th><th scope=\"col\" class=\"num\">Diff</th></tr></thead><tbody>" + discRows + "</tbody></table></div>"
    : "";

  // Complete / cancel actions — only on a non-terminal worksheet.
  var listActions = "";
  if (active) {
    listActions =
      "<form method=\"post\" action=\"/admin/pick-lists/" + _htmlEscape(l.id) + "/complete\" class=\"form-inline\">" +
        "<button class=\"btn\" type=\"submit\">Complete &amp; create shipments</button></form> " +
      "<form method=\"post\" action=\"/admin/pick-lists/" + _htmlEscape(l.id) + "/cancel\" class=\"return-action\">" +
        _setupField("Cancel reason", "reason", "", "text", "Why this worksheet is being abandoned.", " maxlength=\"280\"") +
        "<button class=\"btn btn--danger\" type=\"submit\">Cancel list</button></form>";
  } else {
    listActions = "<span class=\"meta\">This worksheet is " + _htmlEscape(l.status) + " — no further changes.</span>";
  }

  var shipNote = (l.shipments && l.shipments.length)
    ? "<p class=\"meta\">" + _htmlEscape(String(l.shipments.length)) + " shipment(s) created on completion.</p>"
    : "";

  var body =
    "<section class=\"mw-48\">" +
      "<div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/pick-lists\">&larr; Pick lists</a> " +
        "<a class=\"btn btn--ghost\" href=\"/admin/pick-lists/" + _htmlEscape(l.id) + "/print\" target=\"_blank\" rel=\"noopener\">Print worksheet</a>" +
      "</div>" +
      "<h2>Pick list <code class=\"order-id\">" + _htmlEscape(l.id.slice(0, 8)) + "</code> " +
        "<span class=\"status-pill " + _htmlEscape(l.status) + "\">" + _htmlEscape(l.status) + "</span></h2>" +
      "<p class=\"meta\">Location " + _htmlEscape(String(l.location_code)) + " · sorted by " + _htmlEscape(String(l.sort_by)) +
        " · generated " + _htmlEscape(_fmtDate(l.generated_at)) + "</p>" +
      created + picked + completed + cancelled + notice +
      shipNote +
      "<div class=\"panel mt\"><h3 class=\"subhead\">Lines</h3>" + linesTable + "</div>" +
      variancePanel +
      "<div class=\"panel mt\"><h3 class=\"subhead\">Actions</h3><div class=\"order-actions\">" + listActions + "</div></div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Pick list " + l.id.slice(0, 8), body, "pick-lists", opts.nav_available);
}

// Print-optimized pick-list worksheet. A self-contained document (own
// <style> with @media print) the picker carries to the floor — no nav,
// no actions, just the SKU / aisle / qty route. The CSP forbids inline
// script but allows the page's own stylesheet via the admin nonce chain;
// this document is served from the same admin origin so the print view
// inherits it. Kept deliberately minimal so it prints on one or two pages.
function renderPickListPrint(opts) {
  opts = opts || {};
  var l = opts.list;
  var shopName = opts.shop_name || "blamejs.shop";
  var lineRows = (l.lines || []).map(function (ln) {
    return "<tr>" +
      "<td>" + _htmlEscape(String(ln.aisle_position)) + "</td>" +
      "<td>" + _htmlEscape(String(ln.sku)) + "</td>" +
      "<td>" + _htmlEscape(String(ln.order_id).slice(0, 8)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(ln.expected_quantity)) + "</td>" +
      "<td class=\"pick-box\"></td>" +
    "</tr>";
  }).join("");
  var style =
    "<style>" +
    "body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#111}" +
    "h1{font-size:18px;margin:0 0 4px}.meta{color:#555;font-size:12px;margin:0 0 16px}" +
    "table{width:100%;border-collapse:collapse}" +
    "th,td{border:1px solid #999;padding:6px 8px;text-align:left}" +
    "th{background:#eee}.num{text-align:right}.pick-box{width:48px}" +
    "@media print{body{margin:0}@page{margin:12mm}.no-print{display:none}}" +
    "</style>";
  var html =
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">" +
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" +
    "<meta name=\"robots\" content=\"noindex, nofollow\">" +
    "<title>Pick list " + _htmlEscape(l.id.slice(0, 8)) + "</title>" + style + "</head><body>" +
    "<h1>" + _htmlEscape(shopName) + " — pick list</h1>" +
    "<p class=\"meta\">List " + _htmlEscape(l.id.slice(0, 8)) + " · location " + _htmlEscape(String(l.location_code)) +
      " · sorted by " + _htmlEscape(String(l.sort_by)) + " · generated " + _htmlEscape(_fmtDate(l.generated_at)) + "</p>" +
    "<table><thead><tr><th>Aisle/bin</th><th>SKU</th><th>Order</th><th class=\"num\">Qty</th><th>Picked</th></tr></thead>" +
    "<tbody>" + (lineRows || "<tr><td colspan=\"5\">No lines.</td></tr>") + "</tbody></table>" +
    "</body></html>";
  return html;
}

// Read-only customer roster. The raw email is never stored (lookups are
// keyed on a SHA3-512 namespace hash), so the table surfaces the display
// name, a short id, the join date, the sign-in method (passkey count +
// linked OAuth providers), and the order count. Order counts + sign-in
// methods arrive as { customer_id: … } maps resolved by the route's
// bounded aggregate queries — the renderer just looks them up, no work
// per row beyond the lookup. No row actions: the storefront owns account
// mutation via the passkey / OIDC ceremonies.
function renderAdminCustomers(opts) {
  opts = opts || {};
  var customers = opts.customers || [];
  var orderCounts    = opts.order_counts    || {};
  var passkeyCounts  = opts.passkey_counts  || {};
  var oauthProviders = opts.oauth_providers || {};

  var rows = customers.map(function (c) {
    var passkeys = passkeyCounts[c.id] || 0;
    var providers = oauthProviders[c.id] || [];
    // Sign-in method chips: one per passkey-count + one per linked OAuth
    // provider. A customer mid-registration (no credential yet) shows none.
    var methodCells = [];
    if (passkeys > 0) {
      methodCells.push("<span class=\"chip\">" + _htmlEscape(passkeys === 1 ? "1 passkey" : passkeys + " passkeys") + "</span>");
    }
    for (var i = 0; i < providers.length; i += 1) {
      methodCells.push("<span class=\"chip\">" + _htmlEscape(providers[i]) + "</span>");
    }
    var method = methodCells.length ? methodCells.join(" ") : "<span class=\"meta\">—</span>";
    var orders = orderCounts[c.id] || 0;
    var enc = encodeURIComponent(c.id);
    return "<tr>" +
      "<td><a href=\"/admin/customers/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(c.display_name) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(String(c.id).slice(0, 8)) + "</code></td>" +
      "<td>" + _htmlEscape(_fmtDate(c.created_at)) + "</td>" +
      "<td>" + method + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(orders)) + "</td>" +
      "<td><a class=\"btn btn--ghost btn--sm\" href=\"/admin/customers/" + _htmlEscape(enc) + "\">Manage</a></td>" +
      "</tr>";
  }).join("");

  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var table = customers.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Name</th><th scope=\"col\">ID</th><th scope=\"col\">Joined</th><th scope=\"col\">Sign-in method</th><th scope=\"col\" class=\"num\">Orders</th><th scope=\"col\"><span class=\"sr-only\">Manage</span></th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No customers yet.</p>";

  // Cursor pager — a Next link when the page filled and more rows remain.
  // The opaque cursor is HMAC-tagged by customers.list; encode it for the URL.
  var pager = opts.next_cursor
    ? "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/customers?cursor=" + _htmlEscape(encodeURIComponent(opts.next_cursor)) + "\">Next page <span aria-hidden=\"true\">→</span></a></div>"
    : "";

  var body = "<section><h2>Customers</h2>" + notice +
    "<p class=\"meta\">Accounts are passwordless — customers enrol a passkey or sign in with a federated provider. Email addresses aren't stored in the clear, so they're not shown here. Open a customer to manage their store credit, loyalty, notes, and segment membership.</p>" +
    table + pager + "</section>";
  return _renderAdminShell(opts.shop_name, "Customers", body, "customers", opts.nav_available);
}

// Per-customer operator detail screen. READS the customer's identity fields
// + recent orders; WRITES only the operator-managed satellites (store-credit
// + CRM notes). Segment membership is read-only — it is rule-derived (RFM
// predicates recomputed by the scheduler), so there is no per-customer
// manual assign / remove in the segments primitive; the panel shows the
// segments the customer currently sits in and says so. Every panel renders
// only when its primitive is wired.
function renderAdminCustomerDetail(opts) {
  opts = opts || {};
  var c = opts.customer || {};
  var currency = opts.currency || "USD";
  var enc = encodeURIComponent(c.id);

  var saved = opts.saved ? "<div class=\"banner banner--ok\">Saved.</div>" : "";

  // ---- identity (read-only) -----------------------------------------
  var identity = "<div class=\"panel\"><h3 class=\"subhead\">Customer</h3>" +
    "<dl class=\"kv-list\">" +
      "<div><dt>Name</dt><dd>" + _htmlEscape(c.display_name) + "</dd></div>" +
      "<div><dt>Customer id</dt><dd><code class=\"order-id\">" + _htmlEscape(String(c.id)) + "</code></dd></div>" +
      "<div><dt>Joined</dt><dd>" + _htmlEscape(_fmtDate(c.created_at)) + "</dd></div>" +
    "</dl>" +
    "<p class=\"meta\">Identity is read-only here — customers manage their own profile through the storefront (passkey / federated sign-in). Email addresses aren't stored in the clear.</p>" +
  "</div>";

  // ---- recent orders -------------------------------------------------
  var orderRows = (opts.recent_orders || []).map(function (o) {
    return "<tr>" +
      "<td><a class=\"order-id\" href=\"/admin/orders/" + _htmlEscape(encodeURIComponent(o.id)) + "\">" + _htmlEscape(String(o.id).slice(0, 8)) + "</a></td>" +
      "<td><span class=\"status-pill " + _htmlEscape(o.status) + "\">" + _htmlEscape(o.status) + "</span></td>" +
      "<td class=\"num\">" + _htmlEscape(pricing.format(o.grand_total_minor, o.currency)) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(o.created_at)) + "</td>" +
    "</tr>";
  }).join("");
  var ordersPanel = "<div class=\"panel\"><h3 class=\"subhead\">Recent orders</h3>" +
    ((opts.recent_orders || []).length
      ? "<table><thead><tr><th scope=\"col\">Order</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Total</th><th scope=\"col\">Placed</th></tr></thead><tbody>" + orderRows + "</tbody></table>"
      : "<p class=\"empty\">No orders yet.</p>") +
  "</div>";

  // ---- store credit --------------------------------------------------
  var creditPanel;
  if (!opts.can_store_credit) {
    creditPanel = "<div class=\"panel\"><h3 class=\"subhead\">Store credit</h3>" +
      "<p class=\"empty\">Store credit isn't wired in this deployment.</p></div>";
  } else {
    var bal = opts.store_credit_minor != null ? opts.store_credit_minor : 0;
    var creditNotice = opts.credit_notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.credit_notice) + "</div>" : "";
    var histRows = (opts.store_credit_history || []).map(function (h) {
      var sign = h.kind === "credit" ? "+" : "−";
      var note = h.source_ref != null ? h.source_ref : (h.source != null ? h.source : "");
      return "<tr>" +
        "<td>" + _htmlEscape(h.kind) + "</td>" +
        "<td class=\"num\">" + _htmlEscape(sign + pricing.format(h.amount_minor, currency)) + "</td>" +
        "<td class=\"num\">" + _htmlEscape(pricing.format(h.balance_after_minor, currency)) + "</td>" +
        "<td>" + _htmlEscape(note) + "</td>" +
        "<td>" + _htmlEscape(_fmtDate(h.occurred_at)) + "</td>" +
      "</tr>";
    }).join("");
    var histTable = (opts.store_credit_history || []).length
      ? "<table><thead><tr><th scope=\"col\">Kind</th><th scope=\"col\" class=\"num\">Amount</th><th scope=\"col\" class=\"num\">Balance after</th><th scope=\"col\">Reason</th><th scope=\"col\">When</th></tr></thead><tbody>" + histRows + "</tbody></table>"
      : "<p class=\"empty\">No store-credit activity yet.</p>";
    creditPanel = "<div class=\"panel\"><h3 class=\"subhead\">Store credit</h3>" +
      creditNotice +
      "<p class=\"stat-figure\">" + _htmlEscape(pricing.format(bal, currency)) + "</p>" +
      "<p class=\"meta\">Account-bound balance — applied at checkout. Every grant or deduct is recorded with your reason in the ledger below.</p>" +
      "<form method=\"post\" action=\"/admin/customers/" + _htmlEscape(enc) + "/store-credit\">" +
        "<fieldset class=\"box\"><legend class=\"legend-sm\">Direction</legend>" +
          "<label class=\"kv\"><input type=\"radio\" name=\"direction\" value=\"grant\" checked> Grant (add credit)</label>" +
          "<label class=\"kv\"><input type=\"radio\" name=\"direction\" value=\"deduct\"> Deduct (remove credit)</label>" +
        "</fieldset>" +
        "<label class=\"form-field\"><span>Amount (" + _htmlEscape(currency) + " minor units)</span>" +
          "<input type=\"number\" name=\"amount_minor\" min=\"1\" step=\"1\" required class=\"input-code\" placeholder=\"e.g. 500 = " + _htmlEscape(pricing.format(500, currency)) + "\"></label>" +
        "<label class=\"form-field\"><span>Reason</span>" +
          "<input type=\"text\" name=\"reason\" required maxlength=\"128\" placeholder=\"e.g. goodwill for the late delivery\">" +
          "<small>Required. Recorded with the adjustment in the ledger.</small></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Apply adjustment</button></div>" +
      "</form>" +
      histTable +
    "</div>";
  }

  // ---- loyalty -------------------------------------------------------
  var loyaltyPanel = "";
  if (opts.loyalty_link) {
    var loy = opts.loyalty || { balance: 0, lifetime: 0, tier: "bronze" };
    loyaltyPanel = "<div class=\"panel\"><div class=\"actions-row\"><h3 class=\"subhead\">Loyalty</h3>" +
      "<a class=\"btn btn--ghost\" href=\"/admin/loyalty\">Adjust points</a></div>" +
      "<dl class=\"kv-list\">" +
        "<div><dt>Balance</dt><dd>" + _htmlEscape(String(loy.balance)) + " pts</dd></div>" +
        "<div><dt>Lifetime</dt><dd>" + _htmlEscape(String(loy.lifetime)) + " pts</dd></div>" +
        "<div><dt>Tier</dt><dd>" + _htmlEscape(String(loy.tier)) + "</dd></div>" +
      "</dl>" +
      "<p class=\"meta\">Grant or deduct points from the Loyalty screen — paste this customer's id (above) into the adjustment form.</p>" +
    "</div>";
  }

  // ---- notes ---------------------------------------------------------
  var notesPanel;
  if (!opts.can_notes) {
    notesPanel = "<div class=\"panel\"><h3 class=\"subhead\">Notes</h3>" +
      "<p class=\"empty\">Customer notes aren't wired in this deployment.</p></div>";
  } else {
    var noteNotice = opts.note_notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.note_notice) + "</div>" : "";
    var noteRows = (opts.notes || []).map(function (n) {
      return "<li><div class=\"note-meta\">" + _htmlEscape(n.kind) + " · " + _htmlEscape(_fmtDate(n.created_at)) + "</div>" +
        "<div class=\"note-body\">" + _htmlEscape(n.body) + "</div></li>";
    }).join("");
    notesPanel = "<div class=\"panel\"><h3 class=\"subhead\">Notes</h3>" +
      noteNotice +
      "<p class=\"meta\">Operator-only annotations on this customer. Never shown to the customer.</p>" +
      ((opts.notes || []).length
        ? "<ul class=\"note-list\">" + noteRows + "</ul>"
        : "<p class=\"empty\">No notes yet.</p>") +
      "<form method=\"post\" action=\"/admin/customers/" + _htmlEscape(enc) + "/notes\">" +
        "<label class=\"form-field\"><span>Kind</span>" +
          "<select name=\"kind\">" +
            "<option value=\"general\">general</option>" +
            "<option value=\"preference\">preference</option>" +
            "<option value=\"escalation\">escalation</option>" +
            "<option value=\"warning\">warning</option>" +
            "<option value=\"billing\">billing</option>" +
          "</select></label>" +
        "<label class=\"form-field\"><span>Note</span>" +
          "<textarea name=\"body\" required maxlength=\"8000\" rows=\"3\" placeholder=\"e.g. VIP — comp shipping where possible\"></textarea></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add note</button></div>" +
      "</form>" +
    "</div>";
  }

  // ---- segments (read-only) ------------------------------------------
  var segmentsPanel = "";
  if (opts.can_segments) {
    var segChips = (opts.segments || []).map(function (s) {
      return "<span class=\"chip\">" + _htmlEscape(s.title || s.slug) + "</span>";
    }).join(" ");
    segmentsPanel = "<div class=\"panel\"><h3 class=\"subhead\">Segments</h3>" +
      ((opts.segments || []).length
        ? "<div class=\"chip-row\">" + segChips + "</div>"
        : "<p class=\"empty\">Not in any segment.</p>") +
      "<p class=\"meta\">Segment membership is rule-derived — the scheduler recomputes it from each segment's RFM predicates, so there is no manual assign / remove per customer. Define or edit segments under their own console.</p>" +
    "</div>";
  }

  var body = "<section>" +
    "<div class=\"actions-row\"><h2>" + _htmlEscape(c.display_name) + "</h2>" +
      "<a class=\"btn btn--ghost\" href=\"/admin/customers\"><span aria-hidden=\"true\">←</span> All customers</a></div>" +
    saved +
    identity + ordersPanel + creditPanel + loyaltyPanel + notesPanel + segmentsPanel +
  "</section>";
  return _renderAdminShell(opts.shop_name, c.display_name || "Customer", body, "customers", opts.nav_available);
}

// The RMA states an operator can filter the returns queue by — drives the
// filter chips, lifecycle order then terminal.
var RETURN_STATUS_FILTERS = ["pending", "approved", "received", "refunded", "rejected"];

// status → status-pill CSS class. The pill stylesheet has paid/fulfilling/
// shipped/delivered (green), refunded, cancelled, pending — map the RMA
// states onto the closest existing colour without new CSS.
function _returnPillClass(status) {
  if (status === "approved" || status === "received") return "shipped";  // in-progress green
  if (status === "refunded") return "refunded";
  if (status === "rejected") return "cancelled";
  return "pending";
}

function renderAdminReturns(opts) {
  opts = opts || {};
  var rmas = opts.returns || [];
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var active = opts.status || "pending";

  var chips = "<div class=\"order-filters\">" +
    RETURN_STATUS_FILTERS.map(function (s) {
      return "<a class=\"chip" + (active === s ? " chip--on" : "") + "\" href=\"/admin/returns?status=" + encodeURIComponent(s) + "\">" + _htmlEscape(s) + "</a>";
    }).join("") +
    "</div>";

  var rows = rmas.map(function (r) {
    var items = (r.lines || []).reduce(function (n, l) { return n + (l.qty || 0); }, 0);
    var amount = r.refund_amount_minor != null ? pricing.format(r.refund_amount_minor, r.refund_currency || "USD") : "—";
    return "<tr>" +
      "<td><a class=\"order-id\" href=\"/admin/returns/" + _htmlEscape(r.id) + "\">" + _htmlEscape(r.rma_code || r.id.slice(0, 8)) + "</a></td>" +
      "<td><span class=\"order-id\">" + _htmlEscape(String(r.order_id).slice(0, 8)) + "</span></td>" +
      "<td>" + _htmlEscape(r.reason) + "</td>" +
      "<td><span class=\"status-pill " + _returnPillClass(r.status) + "\">" + _htmlEscape(r.status) + "</span></td>" +
      "<td class=\"num\">" + _htmlEscape(String(items)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(amount) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(r.created_at)) + "</td>" +
      "</tr>";
  }).join("");

  var table = rmas.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">RMA</th><th scope=\"col\">Order</th><th scope=\"col\">Reason</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Items</th><th scope=\"col\" class=\"num\">Refund</th><th scope=\"col\">Requested</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No “" + _htmlEscape(active) + "” returns.</p>";

  var body = "<section><h2>Returns</h2>" + notice + chips + table + "</section>";
  return _renderAdminShell(opts.shop_name, "Returns", body, "returns", opts.nav_available);
}

function renderAdminReturn(opts) {
  opts = opts || {};
  var r = opts.rma;
  var transitions = opts.transitions || [];
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Return updated.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var has = function (on) { return transitions.some(function (t) { return t.on === on; }); };

  var lineRows = (r.lines || []).map(function (l) {
    return "<tr><td>" + _htmlEscape(l.sku) + "</td><td class=\"num\">" + _htmlEscape(String(l.qty)) + "</td>" +
      "<td>" + _htmlEscape(l.reason || "—") + "</td></tr>";
  }).join("");
  var linesTable = (r.lines && r.lines.length)
    ? "<table><thead><tr><th scope=\"col\">SKU</th><th scope=\"col\" class=\"num\">Qty</th><th scope=\"col\">Reason</th></tr></thead><tbody>" + lineRows + "</tbody></table>"
    : "<p class=\"empty\">No line items recorded.</p>";

  function _field(label, value) {
    return "<p><span class=\"meta\">" + _htmlEscape(label) + "</span><br>" + (value ? _htmlEscape(String(value)) : "<span class=\"meta\">—</span>") + "</p>";
  }
  var refundShown = r.refund_amount_minor != null ? pricing.format(r.refund_amount_minor, r.refund_currency || "USD") : null;

  // Action forms keyed to the legal transitions. Approve + reject need
  // input (refund amount / rejection reason); mark-received + refund are
  // single-click. Each posts to its own endpoint and redirects (PRG).
  var actionBlocks = [];
  if (has("approve")) {
    actionBlocks.push(
      "<form method=\"post\" action=\"/admin/returns/" + _htmlEscape(r.id) + "/approve\" class=\"return-action\">" +
        "<h4>Approve</h4>" +
        _setupField("Refund amount (minor units)", "refund_amount_minor", "", "number", "e.g. 4999 for $49.99.", " min=\"0\" required") +
        _setupField("Refund currency", "refund_currency", r.refund_currency || "USD", "text", "3-letter ISO 4217.", " maxlength=\"3\" class=\"input-code\"") +
        _setupField("Operator notes", "operator_notes", "", "text", "", " maxlength=\"500\"") +
        "<button class=\"btn\" type=\"submit\">Approve return</button>" +
      "</form>");
  }
  if (has("markReceived")) {
    actionBlocks.push(
      "<form method=\"post\" action=\"/admin/returns/" + _htmlEscape(r.id) + "/received\" class=\"return-action\">" +
        "<h4>Mark received</h4><p class=\"meta\">Confirm the returned goods arrived.</p>" +
        _setupField("Operator notes", "operator_notes", "", "text", "", " maxlength=\"500\"") +
        "<button class=\"btn\" type=\"submit\">Mark received</button>" +
      "</form>");
  }
  if (has("refund")) {
    if (opts.can_provider_refund) {
      // A captured payment intent is linked — the Refund button moves money
      // through the provider. It POSTs to the confirm interstitial (states
      // the amount + warns it's irreversible), whose Confirm button issues
      // the provider refund THEN records the RMA refund.
      actionBlocks.push(
        "<form method=\"post\" action=\"/admin/returns/" + _htmlEscape(r.id) + "/refund/confirm\" class=\"return-action\">" +
          "<h4>Refund</h4><p class=\"meta\">Issues the refund" + (refundShown ? " of " + _htmlEscape(refundShown) : "") + " through the payment provider, then marks this return refunded.</p>" +
          "<button class=\"btn btn--danger\" type=\"submit\">Refund through provider</button>" +
        "</form>");
    } else {
      // No captured intent / no provider wired — the action records the RMA
      // refund only. The money side is issued separately (manual provider
      // refund, or the order page when the order carries an intent), made
      // explicit so the operator never assumes this moved money.
      actionBlocks.push(
        "<form method=\"post\" action=\"/admin/returns/" + _htmlEscape(r.id) + "/refund\" class=\"return-action\">" +
          "<h4>Refund</h4><p class=\"meta\">Record-only: marks the refund" + (refundShown ? " of " + _htmlEscape(refundShown) : "") + " as issued. No money moves from here — issue the refund manually or from the " +
          "<a href=\"/admin/orders/" + _htmlEscape(String(r.order_id)) + "\">linked order</a>.</p>" +
          _setupField("Operator notes", "operator_notes", "", "text", "", " maxlength=\"500\"") +
          "<button class=\"btn\" type=\"submit\">Mark refunded (record only)</button>" +
        "</form>");
    }
  }
  if (has("reject")) {
    actionBlocks.push(
      "<form method=\"post\" action=\"/admin/returns/" + _htmlEscape(r.id) + "/reject\" class=\"return-action\">" +
        "<h4>Reject</h4>" +
        _setupField("Reason for rejection", "rejected_reason", "", "text", "Shown to the customer.", " maxlength=\"500\" required") +
        _setupField("Operator notes", "operator_notes", "", "text", "", " maxlength=\"500\"") +
        "<button class=\"btn btn--danger\" type=\"submit\">Reject return</button>" +
      "</form>");
  }
  var actions = actionBlocks.length
    ? "<div class=\"return-actions\">" + actionBlocks.join("") + "</div>"
    : "<span class=\"meta\">This return is in a final state — no further changes.</span>";

  var body =
    "<section class=\"mw-48\">" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/returns\">&larr; Returns</a></div>" +
      "<h2>Return <code class=\"order-id\">" + _htmlEscape(r.rma_code || r.id.slice(0, 8)) + "</code> " +
        "<span class=\"status-pill " + _returnPillClass(r.status) + "\">" + _htmlEscape(r.status) + "</span></h2>" +
      "<p class=\"meta\">Requested " + _htmlEscape(_fmtDate(r.created_at)) +
        " · order <a class=\"order-id\" href=\"/admin/orders/" + _htmlEscape(r.order_id) + "\">" + _htmlEscape(String(r.order_id).slice(0, 8)) + "</a></p>" +
      moved + notice +
      "<div class=\"two-col\">" +
        "<div class=\"panel\"><h3 class=\"subhead\">Items</h3>" + linesTable + "</div>" +
        "<div class=\"panel\"><h3 class=\"subhead\">Details</h3>" +
          _field("Reason", r.reason) +
          _field("Customer detail", r.reason_detail) +
          _field("Customer notes", r.customer_notes) +
          (refundShown ? _field("Refund", refundShown) : "") +
          (r.operator_notes ? _field("Operator notes", r.operator_notes) : "") +
          (r.rejected_reason ? _field("Rejection reason", r.rejected_reason) : "") +
        "</div>" +
      "</div>" +
      "<div class=\"panel mt\"><h3 class=\"subhead\">Actions</h3>" +
        actions +
      "</div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Return " + (r.rma_code || r.id.slice(0, 8)), body, "returns", opts.nav_available);
}

// The review states an operator can filter the moderation queue by.
var REVIEW_STATUS_FILTERS = ["pending", "published", "rejected"];

function _stars(n) {
  var r = Math.max(0, Math.min(5, parseInt(n, 10) || 0));
  return "★★★★★".slice(0, r) + "☆☆☆☆☆".slice(0, 5 - r);
}

function renderAdminReviews(opts) {
  opts = opts || {};
  var list = opts.reviews || [];
  var active = opts.status || "pending";
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Review updated.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var chips = "<div class=\"order-filters\">" +
    REVIEW_STATUS_FILTERS.map(function (s) {
      return "<a class=\"chip" + (active === s ? " chip--on" : "") + "\" href=\"/admin/reviews?status=" + encodeURIComponent(s) + "\">" + _htmlEscape(s) + "</a>";
    }).join("") +
    "</div>";

  // Reviews are short, so the queue moderates inline — each card shows the
  // rating, title, body, verified-purchase flag, and the actions that make
  // sense from its current status (a rejected review can be published, a
  // published one taken down, a pending one either way).
  var cards = list.map(function (rv) {
    var pub = "<form method=\"post\" action=\"/admin/reviews/" + _htmlEscape(rv.id) + "/publish\" class=\"form-inline\">" +
      "<button class=\"btn\" type=\"submit\">Publish</button></form>";
    var rej = "<form method=\"post\" action=\"/admin/reviews/" + _htmlEscape(rv.id) + "/reject\" class=\"review-reject\">" +
      "<input type=\"text\" name=\"reason\" placeholder=\"Reason (shown in the log)\" maxlength=\"300\" required>" +
      "<button class=\"btn btn--danger\" type=\"submit\">Reject</button></form>";
    var actions = rv.status === "published" ? rej
      : rv.status === "rejected" ? pub
      : pub + " " + rej;  // pending → either
    return "<div class=\"panel review-card\">" +
      "<div class=\"review-card__head\">" +
        "<span class=\"review-stars\" title=\"" + _htmlEscape(String(rv.rating)) + " of 5\">" + _stars(rv.rating) + "</span> " +
        "<strong>" + _htmlEscape(rv.title || "(no title)") + "</strong> " +
        (rv.verified_purchase ? "<span class=\"status-pill paid\">Verified</span> " : "") +
        "<span class=\"status-pill " + (rv.status === "published" ? "paid" : rv.status === "rejected" ? "cancelled" : "pending") + "\">" + _htmlEscape(rv.status) + "</span>" +
      "</div>" +
      "<p class=\"review-card__body\">" + _htmlEscape(rv.body || "") + "</p>" +
      "<p class=\"meta\">Product <code class=\"order-id\">" + _htmlEscape(String(rv.product_id).slice(0, 8)) + "</code> · " + _htmlEscape(_fmtDate(rv.created_at)) +
        (rv.rejected_reason ? " · rejected: " + _htmlEscape(rv.rejected_reason) : "") + "</p>" +
      "<div class=\"order-actions\">" + actions + "</div>" +
    "</div>";
  }).join("");

  var queue = list.length ? cards : "<p class=\"empty\">No “" + _htmlEscape(active) + "” reviews.</p>";
  var body = "<section><h2>Reviews</h2>" + moved + notice + chips + queue + "</section>";
  return _renderAdminShell(opts.shop_name, "Reviews", body, "reviews", opts.nav_available);
}

// The Q&A moderation states an operator can filter the question queue by.
var QA_STATUS_FILTERS = ["pending", "approved", "rejected"];

function _qaStatusPill(status) {
  var cls = status === "approved" ? "paid" : status === "rejected" ? "cancelled" : "pending";
  return "<span class=\"status-pill " + cls + "\">" + _htmlEscape(status) + "</span>";
}

// Cross-product question queue. Each card links to the per-question
// detail where the operator posts + publishes the answer. Inline
// approve / reject act on the question itself.
function renderAdminQuestions(opts) {
  opts = opts || {};
  var list = opts.questions || [];
  var active = opts.status || "pending";
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Question updated.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var chips = "<div class=\"order-filters\">" +
    QA_STATUS_FILTERS.map(function (s) {
      return "<a class=\"chip" + (active === s ? " chip--on" : "") + "\" href=\"/admin/questions?status=" + encodeURIComponent(s) + "\">" + _htmlEscape(s) + "</a>";
    }).join("") +
    "</div>";

  var cards = list.map(function (q) {
    var detail = "/admin/questions/" + _htmlEscape(q.id);
    var pub = "<form method=\"post\" action=\"/admin/questions/" + _htmlEscape(q.id) + "/approve\" class=\"form-inline\">" +
      "<button class=\"btn\" type=\"submit\">Approve</button></form>";
    var rej = "<form method=\"post\" action=\"/admin/questions/" + _htmlEscape(q.id) + "/reject\" class=\"review-reject\">" +
      "<input type=\"text\" name=\"reason\" placeholder=\"Reason (shown in the log)\" maxlength=\"300\" required>" +
      "<button class=\"btn btn--danger\" type=\"submit\">Reject</button></form>";
    // Rejected questions are terminal for the approve path (the lib
    // refuses approve-from-rejected), so only show reject from approved
    // and both from pending.
    var actions = q.status === "approved" ? rej
      : q.status === "rejected" ? ""
      : pub + " " + rej;
    return "<div class=\"panel review-card\">" +
      "<div class=\"review-card__head\">" +
        _qaStatusPill(q.status) + " " +
        "<a href=\"" + detail + "\"><strong>Open thread</strong></a>" +
      "</div>" +
      "<p class=\"review-card__body\">" + _htmlEscape(q.body || "") + "</p>" +
      "<p class=\"meta\">Product <code class=\"order-id\">" + _htmlEscape(String(q.product_id).slice(0, 8)) + "</code> · " + _htmlEscape(_fmtDate(q.occurred_at)) + "</p>" +
      (actions ? "<div class=\"order-actions\">" + actions + "</div>" : "") +
    "</div>";
  }).join("");

  var queue = list.length ? cards : "<p class=\"empty\">No “" + _htmlEscape(active) + "” questions.</p>";
  var body = "<section><h2>Q&amp;A</h2>" + moved + notice + chips + queue + "</section>";
  return _renderAdminShell(opts.shop_name, "Q&A", body, "questions", opts.nav_available);
}

// Per-question detail: the question, its answer thread (every status),
// the operator answer form, and per-answer approve / reject / pin.
function renderAdminQuestion(opts) {
  opts = opts || {};
  var q = opts.question || {};
  var answers = opts.answers || [];
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Updated.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var qApprove = q.status === "pending"
    ? "<form method=\"post\" action=\"/admin/questions/" + _htmlEscape(q.id) + "/approve\" class=\"form-inline\"><button class=\"btn\" type=\"submit\">Approve question</button></form>"
    : "";
  var qReject = q.status !== "rejected"
    ? "<form method=\"post\" action=\"/admin/questions/" + _htmlEscape(q.id) + "/reject\" class=\"review-reject\">" +
        "<input type=\"text\" name=\"reason\" placeholder=\"Reason (shown in the log)\" maxlength=\"300\" required>" +
        "<button class=\"btn btn--danger\" type=\"submit\">Reject question</button></form>"
    : "";

  var qPanel = "<div class=\"panel review-card\">" +
    "<div class=\"review-card__head\">" + _qaStatusPill(q.status) + "</div>" +
    "<p class=\"review-card__body\">" + _htmlEscape(q.body || "") + "</p>" +
    "<p class=\"meta\">Product <code class=\"order-id\">" + _htmlEscape(String(q.product_id).slice(0, 8)) + "</code> · " + _htmlEscape(_fmtDate(q.occurred_at)) + "</p>" +
    ((qApprove || qReject) ? "<div class=\"order-actions\">" + qApprove + " " + qReject + "</div>" : "") +
  "</div>";

  var answerCards = answers.map(function (a) {
    var hid = "<input type=\"hidden\" name=\"question_id\" value=\"" + _htmlEscape(q.id) + "\">";
    var approve = a.status === "pending"
      ? "<form method=\"post\" action=\"/admin/answers/" + _htmlEscape(a.id) + "/approve\" class=\"form-inline\">" + hid + "<button class=\"btn\" type=\"submit\">Approve</button></form>"
      : "";
    var reject = a.status !== "rejected"
      ? "<form method=\"post\" action=\"/admin/answers/" + _htmlEscape(a.id) + "/reject\" class=\"review-reject\">" + hid +
          "<input type=\"text\" name=\"reason\" placeholder=\"Reason\" maxlength=\"300\" required>" +
          "<button class=\"btn btn--danger\" type=\"submit\">Reject</button></form>"
      : "";
    // Pin is only valid for an approved operator answer; the lib refuses
    // otherwise, so only surface the control when it'll succeed.
    var pin = (Number(a.is_operator) === 1 && a.status === "approved" && Number(a.pinned) !== 1)
      ? "<form method=\"post\" action=\"/admin/answers/" + _htmlEscape(a.id) + "/pin\" class=\"form-inline\">" + hid + "<button class=\"btn\" type=\"submit\">Pin as top</button></form>"
      : "";
    var who = Number(a.is_operator) === 1 ? "Seller" : (a.author === "system" ? "System" : "Customer");
    return "<div class=\"panel review-card\">" +
      "<div class=\"review-card__head\">" +
        _qaStatusPill(a.status) + " <strong>" + _htmlEscape(who) + "</strong> " +
        (Number(a.pinned) === 1 ? "<span class=\"status-pill paid\">Pinned</span>" : "") +
      "</div>" +
      "<p class=\"review-card__body\">" + _htmlEscape(a.body || "") + "</p>" +
      "<div class=\"order-actions\">" + approve + " " + reject + " " + pin + "</div>" +
    "</div>";
  }).join("");
  var thread = answers.length ? answerCards : "<p class=\"empty\">No answers yet.</p>";

  var answerForm = "<div class=\"panel\"><h3>Post the seller answer</h3>" +
    "<form method=\"post\" action=\"/admin/questions/" + _htmlEscape(q.id) + "/answer\">" +
      "<label class=\"form-field\"><span>Your answer</span>" +
        "<textarea name=\"body\" maxlength=\"4000\" rows=\"4\" required></textarea>" +
      "</label>" +
      "<div class=\"order-actions\"><button class=\"btn\" type=\"submit\">Submit answer</button></div>" +
    "</form>" +
    "<p class=\"meta\">The answer lands pending — approve it above to publish it on the product page.</p>" +
  "</div>";

  var body = "<section><h2>Question</h2>" +
    "<p class=\"meta\"><a href=\"/admin/questions\">← Back to queue</a></p>" +
    moved + notice + qPanel +
    "<h3 class=\"mt\">Answers</h3>" + thread + answerForm +
  "</section>";
  return _renderAdminShell(opts.shop_name, "Question", body, "questions", opts.nav_available);
}


function renderAdminInventory(opts) {
  opts = opts || {};
  var rows = opts.inventory || [];
  var created = opts.created ? "<div class=\"banner banner--ok\">SKU created.</div>" : "";
  var updated = opts.updated ? "<div class=\"banner banner--ok\">Inventory updated.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (opts.low ? "" : " chip--on") + "\" href=\"/admin/inventory\">All</a>" +
    "<a class=\"chip" + (opts.low ? " chip--on" : "") + "\" href=\"/admin/inventory?low=1\">Low stock</a>" +
    "</div>";

  var body = rows.map(function (r) {
    var available = (r.stock_on_hand || 0) - (r.stock_held || 0);
    var th = r.low_stock_threshold;
    var isLow = th != null && available <= th;
    var thVal = th == null ? "" : String(th);
    return "<tr" + (isLow ? " class=\"row--low\"" : "") + ">" +
      "<th scope=\"row\"><code class=\"order-id\">" + _htmlEscape(r.sku) + "</code>" + (isLow ? " <span class=\"status-pill pending\">low</span>" : "") + "</th>" +
      "<td class=\"num\">" + _htmlEscape(String(r.stock_on_hand)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(r.stock_held)) + "</td>" +
      "<td class=\"num\"><strong>" + _htmlEscape(String(available)) + "</strong></td>" +
      "<td>" +
        "<form method=\"post\" action=\"/admin/inventory/" + _htmlEscape(r.sku) + "/restock\" class=\"inv-row-form\">" +
          "<input type=\"number\" name=\"qty\" min=\"1\" placeholder=\"+ qty\" class=\"input-narrow\">" +
          "<input type=\"number\" name=\"threshold\" min=\"0\" value=\"" + _htmlEscape(thVal) + "\" placeholder=\"alert ≤\" title=\"low-stock threshold (blank clears)\" class=\"input-narrow\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Save</button>" +
        "</form>" +
      "</td></tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">SKU</th><th scope=\"col\" class=\"num\">On hand</th><th scope=\"col\" class=\"num\">Held</th><th scope=\"col\" class=\"num\">Available</th><th scope=\"col\">Restock / threshold</th></tr></thead><tbody>" + body + "</tbody></table></div>"
    : "<p class=\"empty\">No inventory rows" + (opts.low ? " below threshold" : " yet") + ".</p>";

  var createForm =
    "<div class=\"panel mt mw-34\">" +
      "<h3 class=\"subhead\">Track a new SKU</h3>" +
      "<form method=\"post\" action=\"/admin/inventory\">" +
        _setupField("SKU", "sku", "", "text", "Must match a variant SKU.", " maxlength=\"128\" required") +
        _setupField("Starting stock on hand", "stock_on_hand", "0", "number", "", " min=\"0\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Track SKU</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Inventory</h2>" + created + updated + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Inventory", bodyHtml, "inventory", opts.nav_available);
}

// Single subscription-plan detail + edit form. The Stripe-bound columns
// (price id / interval / currency) are immutable post-create — shown
// read-only — because they mirror a recurring Stripe Price; to change
// those an operator archives the plan and creates a new one against a
// fresh price id. The mutable columns (amount / interval count / trial /
// active / variant link) are editable here.
function renderAdminSubscriptionPlan(opts) {
  opts = opts || {};
  var p = opts.plan;
  if (!p) {
    var nf = "<section><h2>Subscription plan</h2><p class=\"empty\">Subscription plan not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/subscription-plans\">Back to plans</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Subscription plan", nf, "subscriptions", opts.nav_available);
  }
  var updated = opts.updated ? "<div class=\"banner banner--ok\">Plan updated.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var isActive = p.active === 1 || p.active === true;
  var cur = String(p.currency || "").toUpperCase();
  var every = p.interval_count > 1 ? p.interval_count + " " + p.interval + "s" : p.interval;

  var summary =
    "<div class=\"panel\"><dl class=\"detail-grid\">" +
      "<div><dt>Price</dt><dd><strong>" + _htmlEscape(pricing.format(p.amount_minor, cur) + " / " + every) + "</strong></dd></div>" +
      "<div><dt>Stripe price</dt><dd><code class=\"order-id\">" + _htmlEscape(p.stripe_price_id) + "</code></dd></div>" +
      "<div><dt>Variant</dt><dd>" + (p.variant_id ? "<code class=\"order-id\">" + _htmlEscape(String(p.variant_id)) + "</code>" : "<span class=\"meta\">standalone</span>") + "</dd></div>" +
      "<div><dt>Trial</dt><dd>" + (p.trial_days ? _htmlEscape(String(p.trial_days)) + " days" : "<span class=\"meta\">none</span>") + "</dd></div>" +
      "<div><dt>Status</dt><dd><span class=\"status-pill " + (isActive ? "paid" : "cancelled") + "\">" + (isActive ? "active" : "archived") + "</span></dd></div>" +
    "</dl></div>";

  var editForm = !isActive
    ? "<p class=\"empty\">This plan is archived and can no longer be edited. Create a new plan against a fresh Stripe price id to offer it again.</p>"
    : "<div class=\"panel mw-34\">" +
        "<h3 class=\"subhead\">Edit plan</h3>" +
        "<p class=\"meta\">The Stripe price id, billing interval, and currency are fixed — they mirror the Stripe Price. To change those, archive this plan and create a new one.</p>" +
        "<form method=\"post\" action=\"/admin/subscription-plans/" + _htmlEscape(p.id) + "/edit\">" +
          "<input type=\"hidden\" name=\"active_present\" value=\"1\">" +
          _setupField("Amount (minor units)", "amount_minor", String(p.amount_minor), "number", "In the currency's smallest unit — e.g. 1999 = $19.99.", " min=\"1\"") +
          _setupField("Interval count", "interval_count", String(p.interval_count), "number", "Bill every N " + _htmlEscape(p.interval) + "s (1–12).", " min=\"1\" max=\"12\"") +
          _setupField("Trial days", "trial_days", String(p.trial_days), "number", "Free trial length before the first charge (0–730).", " min=\"0\" max=\"730\"") +
          _setupField("Variant id (optional)", "variant_id", p.variant_id ? String(p.variant_id) : "", "text", "Link to a storefront variant, or clear for a standalone tier.", " maxlength=\"64\"") +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"active\" checked> Active</label>" +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save changes</button></div>" +
        "</form>" +
      "</div>";

  var bodyHtml = "<section><h2>Subscription plan</h2>" + updated + notice + summary + editForm +
    "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/subscription-plans\">Back to plans</a></div></section>";
  return _renderAdminShell(opts.shop_name, "Subscription plan", bodyHtml, "subscriptions", opts.nav_available);
}

function renderAdminSubscriptionPlans(opts) {
  opts = opts || {};
  var rows = opts.plans || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Plan created.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Plan archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var af = opts.active_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (af == null ? " chip--on" : "") + "\" href=\"/admin/subscription-plans\">All</a>" +
    "<a class=\"chip" + (af === "1" ? " chip--on" : "") + "\" href=\"/admin/subscription-plans?active=1\">Active</a>" +
    "<a class=\"chip" + (af === "0" ? " chip--on" : "") + "\" href=\"/admin/subscription-plans?active=0\">Archived</a>" +
    "</div>";

  // Each plan mirrors a recurring Stripe Price (Stripe stays the pricing
  // source of truth). Archiving is terminal from the console — because the
  // mirrored Stripe price id may go stale, a retired plan is re-offered by
  // creating a new one against a fresh price id, never reactivated in place.
  var bodyRows = rows.map(function (p) {
    var every = p.interval_count > 1 ? p.interval_count + " " + p.interval + "s" : p.interval;
    // Plans store currency lowercase (the subscriptions validator's form);
    // pricing.format wants the uppercase ISO 4217 code.
    var price = pricing.format(p.amount_minor, String(p.currency || "").toUpperCase()) + " / " + every;
    var isActive = p.active === 1 || p.active === true;
    var archiveCell = isActive
      ? "<a class=\"btn btn--ghost\" href=\"/admin/subscription-plans/" + _htmlEscape(p.id) + "\">Edit</a> " +
        "<form method=\"post\" action=\"/admin/subscription-plans/" + _htmlEscape(p.id) + "/archive/confirm\" class=\"form-inline\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Archive</button></form>"
      : "<a class=\"btn btn--ghost\" href=\"/admin/subscription-plans/" + _htmlEscape(p.id) + "\">View</a>";
    return "<tr>" +
      "<td><strong>" + _htmlEscape(price) + "</strong>" +
        (p.trial_days ? " <span class=\"status-pill pending\">" + _htmlEscape(String(p.trial_days)) + "d trial</span>" : "") + "</td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(p.stripe_price_id) + "</code></td>" +
      "<td>" + (p.variant_id ? "<code class=\"order-id\">" + _htmlEscape(String(p.variant_id).slice(0, 8)) + "</code>" : "<span class=\"meta\">standalone</span>") + "</td>" +
      "<td><span class=\"status-pill " + (isActive ? "paid" : "cancelled") + "\">" + (isActive ? "active" : "archived") + "</span></td>" +
      "<td>" + archiveCell + "</td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Price / interval</th><th scope=\"col\">Stripe price</th><th scope=\"col\">Variant</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No subscription plans" + (af === "0" ? " archived" : af === "1" ? " active" : " yet") + ".</p>";

  var intervalOpts = ["month", "year", "week", "day"].map(function (iv) {
    return "<option value=\"" + iv + "\">" + iv + "</option>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-34\">" +
      "<h3 class=\"subhead\">Create a plan</h3>" +
      "<p class=\"meta\">Pre-create the recurring Price in Stripe, then mirror it here so the storefront can render the plan without a network hop.</p>" +
      "<form method=\"post\" action=\"/admin/subscription-plans\">" +
        _setupField("Stripe price id", "stripe_price_id", "", "text", "The recurring Price id from your Stripe dashboard (e.g. price_…).", " maxlength=\"255\" required") +
        "<label class=\"form-field\"><span>Billing interval</span><select name=\"interval\">" + intervalOpts + "</select></label>" +
        _setupField("Interval count", "interval_count", "1", "number", "Bill every N intervals (1–12).", " min=\"1\" max=\"12\"") +
        _setupField("Currency", "currency", "", "text", "3-letter ISO 4217 (e.g. USD).", " maxlength=\"3\" required") +
        _setupField("Amount (minor units)", "amount_minor", "", "number", "In the currency's smallest unit — e.g. 1999 = $19.99.", " min=\"1\" required") +
        _setupField("Trial days", "trial_days", "0", "number", "Free trial length before the first charge (0–730).", " min=\"0\" max=\"730\"") +
        _setupField("Variant id (optional)", "variant_id", "", "text", "Link to a storefront variant, or leave blank for a standalone tier.", " maxlength=\"64\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create plan</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Subscription plans</h2>" + created + archived + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Subscription plans", bodyHtml, "subscriptions", opts.nav_available);
}

// Gift-card ledger console — list issued cards. The code is masked to
// its `code_hint` (last 4 plaintext chars) prefixed with the standard
// •••• fill; the plaintext bearer code is never stored and so never
// rendered here. Original (issued) + remaining balance + lifecycle
// status + issued date per row, newest first.
// A <select> form field matching the _setupField shape. `options` is an
// array of { value, label }; `selected` highlights the current value.
function _selectField(label, name, options, selected, hint, extra) {
  var opts = (options || []).map(function (o) {
    return "<option value=\"" + _htmlEscape(o.value) + "\"" +
      (o.value === selected ? " selected" : "") + ">" + _htmlEscape(o.label) + "</option>";
  }).join("");
  return "<label class=\"form-field\"><span>" + _htmlEscape(label) + "</span>" +
    "<select name=\"" + _htmlEscape(name) + "\"" + (extra || "") + ">" + opts + "</select>" +
    (hint ? "<small>" + _htmlEscape(hint) + "</small>" : "") +
    "</label>";
}

// bps → human "X.XX%". 1 bp = 0.01%.
function _fmtBps(bps) {
  var n = Number(bps);
  if (!isFinite(n)) return "—";
  return (n / 100).toFixed(2) + "%";
}

function renderAdminTaxRates(opts) {
  opts = opts || {};
  var rows = opts.rates || [];
  var jurisdiction = opts.jurisdiction || "";
  var sources = opts.sources || ["manual"];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Rate created.</div>" : "";
  var updated  = opts.updated  ? "<div class=\"banner banner--ok\">Rate updated.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Rate archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // Jurisdiction picker — the list is scoped to one jurisdiction at a
  // time (the lib's listForJurisdiction is the only list surface).
  var picker =
    "<div class=\"panel mw-34\">" +
      "<form method=\"get\" action=\"/admin/tax-rates\" class=\"form-inline\">" +
        "<label class=\"form-field\"><span>Jurisdiction</span>" +
          "<input type=\"text\" name=\"jurisdiction\" value=\"" + _htmlEscape(jurisdiction) + "\" placeholder=\"US or US-CA\" maxlength=\"6\" class=\"input-code\" required>" +
          "<small>ISO 3166-1 country, optionally -subdivision (e.g. US, US-CA, DE-BY).</small>" +
        "</label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">View rates</button></div>" +
      "</form>" +
    "</div>";

  var table = "";
  if (jurisdiction) {
    var bodyRows = rows.map(function (r) {
      var isArchived = r.archived_at != null;
      var until = r.effective_until == null ? "<span class=\"meta\">open</span>" : _htmlEscape(_fmtDate(Number(r.effective_until)));
      var editForm = isArchived ? "" :
        "<form method=\"post\" action=\"/admin/tax-rates/" + _htmlEscape(r.id) + "/edit\" class=\"form-inline\">" +
          "<input type=\"hidden\" name=\"jurisdiction\" value=\"" + _htmlEscape(jurisdiction) + "\">" +
          "<input type=\"number\" name=\"rate_bps\" value=\"" + _htmlEscape(String(r.rate_bps)) + "\" min=\"0\" max=\"10000\" class=\"input-sm\" aria-label=\"rate basis points\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Save</button>" +
        "</form> " +
        "<form method=\"post\" action=\"/admin/tax-rates/" + _htmlEscape(r.id) + "/archive\" class=\"form-inline\">" +
          "<input type=\"hidden\" name=\"jurisdiction\" value=\"" + _htmlEscape(jurisdiction) + "\">" +
          "<button class=\"btn btn--danger\" type=\"submit\">Archive</button>" +
        "</form>";
      return "<tr>" +
        "<td>" + (r.category ? "<code>" + _htmlEscape(r.category) + "</code>" : "<span class=\"meta\">default</span>") + "</td>" +
        "<td class=\"num\"><strong>" + _htmlEscape(_fmtBps(r.rate_bps)) + "</strong> <span class=\"meta\">(" + _htmlEscape(String(r.rate_bps)) + " bps)</span></td>" +
        "<td>" + _htmlEscape(_fmtDate(Number(r.effective_from))) + "</td>" +
        "<td>" + until + "</td>" +
        "<td>" + _htmlEscape(r.source) + "</td>" +
        "<td><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "live") + "</span></td>" +
        "<td>" + editForm + "</td>" +
      "</tr>";
    }).join("");
    table = rows.length
      ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Category</th><th scope=\"col\" class=\"num\">Rate</th><th scope=\"col\">From</th><th scope=\"col\">Until</th><th scope=\"col\">Source</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
      : "<p class=\"empty\">No rates for " + _htmlEscape(jurisdiction) + " yet.</p>";
  }

  var sourceOpts = sources.map(function (s) { return { value: s, label: s }; });
  var createForm = jurisdiction
    ? "<div class=\"panel mt mw-34\">" +
        "<h3 class=\"subhead\">Add a rate for " + _htmlEscape(jurisdiction) + "</h3>" +
        "<form method=\"post\" action=\"/admin/tax-rates\">" +
          "<input type=\"hidden\" name=\"jurisdiction\" value=\"" + _htmlEscape(jurisdiction) + "\">" +
          _setupField("Category (optional)", "category", "", "text", "Leave blank for the jurisdiction's default rate. Lowercase, e.g. food, books.", " maxlength=\"64\"") +
          _setupField("Rate (basis points)", "rate_bps", "", "number", "1 bp = 0.01%. 2000 = 20.00%.", " min=\"0\" max=\"10000\" required") +
          _setupField("Effective from (epoch-ms, optional)", "effective_from", "", "number", "When the rate starts. Blank = now.", " min=\"0\"") +
          _setupField("Effective until (epoch-ms, optional)", "effective_until", "", "number", "When the rate ends. Blank = open-ended.", " min=\"0\"") +
          _selectField("Source", "source", sourceOpts, "manual", "Who declared this rate.", "") +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add rate</button></div>" +
        "</form>" +
      "</div>"
    : "";

  var body = "<section><h2>Tax rates</h2>" + created + updated + archived + notice + picker + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Tax rates", body, "tax", opts.nav_available);
}

// Money for the filings screens. A filing aggregates orders that may span
// currencies, so the row stores raw minor-unit totals with no single
// currency column. Display them through the same pricing formatter the rest
// of the console uses, in the operator's display currency (defaults to USD)
// — the number is the reconciliation figure regardless of the symbol.
var TAX_FILING_DISPLAY_CURRENCY = "USD";
function _filingMoney(minor) {
  return pricing.format(Number(minor) || 0, TAX_FILING_DISPLAY_CURRENCY);
}

// Sales-tax-filings list screen — open filings (filterable by jurisdiction
// + status), an upcoming-due strip, and the open-a-period form. Read-heavy:
// the lifecycle actions live on each filing's detail page.
function renderAdminTaxFilings(opts) {
  opts = opts || {};
  var filings  = opts.filings  || [];
  var upcoming = opts.upcoming || [];
  var kinds    = opts.kinds    || ["monthly", "quarterly", "annual"];
  var statuses = opts.statuses || ["draft", "computed", "submitted", "paid", "amended"];
  var jurisdiction = opts.jurisdiction || "";
  var statusFilter = opts.status_filter || "";
  var created = opts.created ? "<div class=\"banner banner--ok\">Filing period opened.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // Status pill class reuse: map filing status onto the order pill palette so
  // the visual language matches the rest of the console.
  function _statusPill(s) {
    var cls = s === "paid" ? "paid"
            : s === "submitted" ? "shipped"
            : s === "computed" ? "fulfilling"
            : s === "amended" ? "cancelled"
            : "pending";
    return "<span class=\"status-pill " + cls + "\">" + _htmlEscape(s) + "</span>";
  }

  // Filter form — jurisdiction text + status select. GET so the filter
  // lives in the URL.
  var statusOpts = [{ value: "", label: "All statuses" }].concat(statuses.map(function (s) { return { value: s, label: s }; }));
  var filterForm =
    "<form method=\"get\" action=\"/admin/tax-filings\" class=\"order-filters\">" +
      "<label class=\"form-field\"><span>Jurisdiction</span>" +
        "<input type=\"text\" name=\"jurisdiction\" value=\"" + _htmlEscape(jurisdiction) + "\" placeholder=\"US or US-CA\" maxlength=\"6\" class=\"input-code\"></label>" +
      _selectField("Status", "status", statusOpts, statusFilter, "", "") +
      "<button class=\"btn\" type=\"submit\">Filter</button>" +
      "<a class=\"btn btn--ghost\" href=\"/admin/tax-filings\">Clear</a>" +
    "</form>";

  // Due/overdue strip — open filings due within the next 30 days OR already
  // past their due date (upcomingDue filters due_date <= now+30d, no lower bound).
  var dueRows = upcoming.map(function (f) {
    return "<tr>" +
      "<td><a class=\"order-id\" href=\"/admin/tax-filings/" + _htmlEscape(f.id) + "\">" + _htmlEscape(f.jurisdiction) + "</a></td>" +
      "<td>" + _htmlEscape(f.kind) + "</td>" +
      "<td>" + _statusPill(f.status) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(f.due_date)) + "</td>" +
      "</tr>";
  }).join("");
  var dueBlock = upcoming.length
    ? "<section><h2>Due soon or overdue</h2><div class=\"panel\">" +
        "<table><thead><tr><th scope=\"col\">Jurisdiction</th><th scope=\"col\">Period</th><th scope=\"col\">Status</th><th scope=\"col\">Due</th></tr></thead><tbody>" + dueRows + "</tbody></table>" +
      "</div></section>"
    : "";

  // Filings table.
  var rows = filings.map(function (f) {
    return "<tr>" +
      "<td><a class=\"order-id\" href=\"/admin/tax-filings/" + _htmlEscape(f.id) + "\">" + _htmlEscape(f.jurisdiction) + "</a></td>" +
      "<td>" + _htmlEscape(f.kind) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(f.period_start)) + " → " + _htmlEscape(_fmtDate(f.period_end)) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(f.due_date)) + "</td>" +
      "<td>" + _statusPill(f.status) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(_filingMoney(f.tax_collected_minor)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(_filingMoney(f.tax_owed_minor)) + "</td>" +
      "</tr>";
  }).join("");
  var table = filings.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Jurisdiction</th><th scope=\"col\">Kind</th><th scope=\"col\">Period</th><th scope=\"col\">Due</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Collected</th><th scope=\"col\" class=\"num\">Owed</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No filings" + (jurisdiction ? " for " + _htmlEscape(jurisdiction) : "") + " yet. Open a period below.</p>";

  // Open-a-period form.
  var kindOpts = kinds.map(function (k) { return { value: k, label: k }; });
  var createForm =
    "<div class=\"panel mt mw-34\">" +
      "<h3 class=\"subhead\">Open a filing period</h3>" +
      "<form method=\"post\" action=\"/admin/tax-filings\">" +
        _setupField("Jurisdiction", "jurisdiction", "", "text", "ISO 3166-1 country, optionally -subdivision (e.g. US, US-CA, DE-BY).", " maxlength=\"6\" class=\"input-code\" required") +
        _selectField("Kind", "kind", kindOpts, "quarterly", "Filing cadence the authority expects.", " required") +
        _setupField("Period start (epoch-ms)", "period_start", "", "number", "First instant of the filing window.", " min=\"0\" required") +
        _setupField("Period end (epoch-ms)", "period_end", "", "number", "Exclusive end of the window (must be after start).", " min=\"0\" required") +
        _setupField("Due date (epoch-ms)", "due_date", "", "number", "When the filing is due (must be on or after the period end).", " min=\"0\" required") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Open period</button></div>" +
      "</form>" +
    "</div>";

  // Report shortcut.
  var reportForm =
    "<div class=\"panel mt mw-34\">" +
      "<h3 class=\"subhead\">Remittance report</h3>" +
      "<form method=\"get\" action=\"/admin/tax-filings/report\">" +
        _setupField("Jurisdiction", "jurisdiction", jurisdiction, "text", "Roll up every filing whose period intersects the window.", " maxlength=\"6\" class=\"input-code\" required") +
        _setupField("From (epoch-ms)", "from", "", "number", "Window start.", " min=\"0\" required") +
        _setupField("To (epoch-ms)", "to", "", "number", "Window end.", " min=\"0\" required") +
        "<div class=\"actions-row\"><button class=\"btn btn--ghost\" type=\"submit\">Run report</button></div>" +
      "</form>" +
    "</div>";

  var body =
    "<section><h2>Sales tax filings</h2>" + created + notice + filterForm + table + "</section>" +
    dueBlock +
    "<section><div class=\"two-col\">" + createForm + reportForm + "</div></section>";
  return _renderAdminShell(opts.shop_name, "Tax filings", body, "tax-filings", opts.nav_available);
}

// Sales-tax-filing detail — the snapshot totals, the per-rate breakdown, the
// audit trail, and the lifecycle action forms gated on the filing's status.
function renderAdminTaxFiling(opts) {
  opts = opts || {};
  var f = opts.filing;
  var banners =
    (opts.created   ? "<div class=\"banner banner--ok\">Filing period opened.</div>" : "") +
    (opts.computed  ? "<div class=\"banner banner--ok\">Snapshot computed.</div>" : "") +
    (opts.submitted ? "<div class=\"banner banner--ok\">Submission recorded.</div>" : "") +
    (opts.paid      ? "<div class=\"banner banner--ok\">Payment recorded.</div>" : "") +
    (opts.amended   ? "<div class=\"banner banner--ok\">Filing amended.</div>" : "") +
    (opts.notice    ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "");
  if (!f) {
    return _renderAdminShell(opts.shop_name, "Filing", "<section><h2>Filing</h2>" + banners + "<p class=\"empty\">Filing not found.</p></section>", "tax-filings", opts.nav_available);
  }
  var enc = encodeURIComponent(f.id);

  var meta =
    "<section><h2>" + _htmlEscape(f.jurisdiction) + " · " + _htmlEscape(f.kind) + "</h2>" + banners +
      "<p class=\"meta\">Window: " + _htmlEscape(_fmtDate(f.period_start)) + " → " + _htmlEscape(_fmtDate(f.period_end)) +
        " · Due " + _htmlEscape(_fmtDate(f.due_date)) +
        " · Status <span class=\"status-pill " + _htmlEscape(f.status) + "\">" + _htmlEscape(f.status) + "</span></p>" +
    "</section>";

  var stats =
    "<section><h2>Snapshot</h2><div class=\"stat-grid\">" +
      _statCard("Gross revenue", _filingMoney(f.gross_revenue_minor)) +
      _statCard("Taxable revenue", _filingMoney(f.taxable_revenue_minor)) +
      _statCard("Exempt revenue", _filingMoney(f.exempt_revenue_minor)) +
      _statCard("Tax collected", _filingMoney(f.tax_collected_minor)) +
      _statCard("Tax owed", _filingMoney(f.tax_owed_minor), true) +
    "</div>" +
    (f.computed_at == null ? "<p class=\"meta\">Not computed yet — run the snapshot to aggregate orders in the window.</p>"
                           : "<p class=\"meta\">Computed " + _htmlEscape(_fmtDate(f.computed_at)) + ".</p>") +
    "</section>";

  // Per-rate breakdown table — one row per rate bucket the snapshot produced.
  var breakdown = f.by_rate_breakdown || {};
  var bkeys = Object.keys(breakdown);
  var breakdownRows = bkeys.map(function (k) {
    var bkt = breakdown[k] || {};
    var label = k === "__none__" ? "no rate matched"
              : k === "__exempt__" ? "exempt"
              : k === "__unknown__" ? "unknown rate"
              : _fmtBps(k);
    return "<tr>" +
      "<td>" + _htmlEscape(label) + (k === "__none__" || k === "__exempt__" || k === "__unknown__" ? "" : " <span class=\"meta\">(" + _htmlEscape(String(k)) + " bps)</span>") + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(bkt.order_count == null ? 0 : bkt.order_count)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(_filingMoney(bkt.taxable_minor)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(_filingMoney(bkt.tax_minor)) + "</td>" +
      "</tr>";
  }).join("");
  var breakdownBlock = bkeys.length
    ? "<section><h2>By rate</h2><div class=\"panel\"><table><thead><tr><th scope=\"col\">Rate</th><th scope=\"col\" class=\"num\">Orders</th><th scope=\"col\" class=\"num\">Taxable</th><th scope=\"col\" class=\"num\">Tax</th></tr></thead><tbody>" + breakdownRows + "</tbody></table></div></section>"
    : "";

  // Audit trail — submission + payment + amendment columns once recorded.
  var trail = "";
  if (f.submission_ref || f.payment_ref || f.amended_reason) {
    var trailRows = "";
    if (f.submission_ref) {
      trailRows += "<tr><td>Submitted</td><td>" + _htmlEscape(f.submission_ref) +
        (f.submitted_by ? " <span class=\"meta\">by " + _htmlEscape(f.submitted_by) + "</span>" : "") +
        (f.submitted_at != null ? " <span class=\"meta\">" + _htmlEscape(_fmtDate(f.submitted_at)) + "</span>" : "") + "</td></tr>";
    }
    if (f.payment_ref || f.payment_minor != null) {
      trailRows += "<tr><td>Paid</td><td>" + _htmlEscape(_filingMoney(f.payment_minor)) +
        (f.payment_ref ? " <span class=\"meta\">ref " + _htmlEscape(f.payment_ref) + "</span>" : "") +
        (f.paid_at != null ? " <span class=\"meta\">" + _htmlEscape(_fmtDate(f.paid_at)) + "</span>" : "") + "</td></tr>";
    }
    if (f.amended_reason) {
      trailRows += "<tr><td>Amended</td><td>" + _htmlEscape(f.amended_reason) +
        (f.amended_at != null ? " <span class=\"meta\">" + _htmlEscape(_fmtDate(f.amended_at)) + "</span>" : "") + "</td></tr>";
    }
    trail = "<section><h2>Audit trail</h2><div class=\"panel\"><table><tbody>" + trailRows + "</tbody></table></div></section>";
  }

  // Lifecycle actions — gated on the FSM. draft → compute; computed →
  // submit or amend; submitted → pay or amend; paid → amend.
  var actions = "";
  if (f.status === "draft" || f.status === "computed") {
    actions +=
      "<form method=\"post\" action=\"/admin/tax-filings/" + enc + "/compute\" class=\"form-inline\">" +
        "<button class=\"btn\" type=\"submit\">" + (f.status === "computed" ? "Recompute snapshot" : "Compute snapshot") + "</button>" +
      "</form>";
  }
  if (f.status === "computed") {
    actions +=
      "<form method=\"post\" action=\"/admin/tax-filings/" + enc + "/submit\" class=\"stack\">" +
        _setupField("Submission reference", "submission_ref", "", "text", "The authority's confirmation number (e.g. DR-123-456).", " maxlength=\"200\" required") +
        _setupField("Submitted by", "submitted_by", "", "text", "Who filed it.", " maxlength=\"200\" required") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Record submission</button></div>" +
      "</form>";
  }
  if (f.status === "submitted") {
    actions +=
      "<form method=\"post\" action=\"/admin/tax-filings/" + enc + "/pay\" class=\"stack\">" +
        _setupField("Payment (minor units)", "payment_minor", "", "number", "Remitted amount in minor units — may be a partial / installment payment.", " min=\"0\" required") +
        _setupField("Payment reference", "payment_ref", "", "text", "The authority's payment confirmation.", " maxlength=\"200\" required") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Record payment</button></div>" +
      "</form>";
  }
  if (f.status === "computed" || f.status === "submitted" || f.status === "paid") {
    actions +=
      "<form method=\"post\" action=\"/admin/tax-filings/" + enc + "/amend\" class=\"stack\">" +
        _setupField("Amendment reason", "reason", "", "text", "Why this filing is being corrected. The snapshot stays for the audit trail.", " maxlength=\"1000\" required") +
        "<div class=\"actions-row\"><button class=\"btn btn--danger\" type=\"submit\">Mark amended</button></div>" +
      "</form>";
  }
  var actionsBlock = actions
    ? "<section><h2>Actions</h2><div class=\"panel\">" + actions + "</div></section>"
    : "<section><h2>Actions</h2><p class=\"meta\">This filing is in a terminal state; re-open the period after amending to file again.</p></section>";

  var back = "<p class=\"mt\"><a class=\"btn btn--ghost\" href=\"/admin/tax-filings\">Back to filings</a></p>";
  return _renderAdminShell(opts.shop_name, "Filing", meta + stats + breakdownBlock + trail + actionsBlock + back, "tax-filings", opts.nav_available);
}

// Per-jurisdiction remittance report — the totals across every filing whose
// period intersects the window. Read-only.
function renderAdminTaxFilingReport(opts) {
  opts = opts || {};
  var report = opts.report;
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";
  if (!report) {
    return _renderAdminShell(opts.shop_name, "Remittance report",
      "<section><h2>Remittance report</h2>" + notice +
      "<p class=\"mt\"><a class=\"btn btn--ghost\" href=\"/admin/tax-filings\">Back to filings</a></p></section>",
      "tax-filings", opts.nav_available);
  }
  var stats =
    "<div class=\"stat-grid\">" +
      _statCard("Filings", String(report.filing_count)) +
      _statCard("Gross revenue", _filingMoney(report.total_gross_revenue_minor)) +
      _statCard("Taxable revenue", _filingMoney(report.total_taxable_revenue_minor)) +
      _statCard("Exempt revenue", _filingMoney(report.total_exempt_revenue_minor)) +
      _statCard("Tax collected", _filingMoney(report.total_tax_collected_minor)) +
      _statCard("Tax owed", _filingMoney(report.total_tax_owed_minor), true) +
      _statCard("Tax paid", _filingMoney(report.total_tax_paid_minor)) +
    "</div>";
  var rows = (report.filings || []).map(function (f) {
    return "<tr>" +
      "<td><a class=\"order-id\" href=\"/admin/tax-filings/" + _htmlEscape(f.id) + "\">" + _htmlEscape(f.kind) + "</a></td>" +
      "<td>" + _htmlEscape(_fmtDate(f.period_start)) + " → " + _htmlEscape(_fmtDate(f.period_end)) + "</td>" +
      "<td><span class=\"status-pill " + _htmlEscape(f.status) + "\">" + _htmlEscape(f.status) + "</span></td>" +
      "<td class=\"num\">" + _htmlEscape(_filingMoney(f.tax_collected_minor)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(_filingMoney(f.tax_owed_minor)) + "</td>" +
      "</tr>";
  }).join("");
  var table = (report.filings || []).length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Period</th><th scope=\"col\">Window</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Collected</th><th scope=\"col\" class=\"num\">Owed</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No filings intersect this window.</p>";

  var body =
    "<section><h2>Remittance report · " + _htmlEscape(report.jurisdiction) + "</h2>" + notice +
      "<p class=\"meta\">Window: " + _htmlEscape(_fmtDate(report.from)) + " → " + _htmlEscape(_fmtDate(report.to)) + "</p>" +
      stats + table +
      "<p class=\"mt\"><a class=\"btn btn--ghost\" href=\"/admin/tax-filings\">Back to filings</a></p>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Remittance report", body, "tax-filings", opts.nav_available);
}

function renderAdminShipping(opts) {
  opts = opts || {};
  var rows = opts.zones || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Zone created.</div>" : "";
  var updated  = opts.updated  ? "<div class=\"banner banner--ok\">Zone updated.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Zone archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var bodyRows = rows.map(function (z) {
    var isArchived = z.archived_at != null;
    var regionStr = (z.regions || []).map(function (r) {
      return r.region ? r.country + "-" + r.region : r.country;
    }).join(", ");
    var rateCount = (z.rates || []).length;
    var statusCls = isArchived ? "cancelled" : (z.active ? "paid" : "pending");
    var statusTxt = isArchived ? "archived" : (z.active ? "active" : "paused");
    return "<tr>" +
      "<td><a href=\"/admin/shipping/" + _htmlEscape(encodeURIComponent(z.slug)) + "\"><strong>" + _htmlEscape(z.title) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(z.slug) + "</code></td>" +
      "<td>" + _htmlEscape(regionStr) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(rateCount)) + "</td>" +
      "<td><span class=\"status-pill " + statusCls + "\">" + _htmlEscape(statusTxt) + "</span></td>" +
      "<td><div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/shipping/" + _htmlEscape(encodeURIComponent(z.slug)) + "\">Manage</a>" +
        (isArchived ? "" :
          "<form method=\"post\" action=\"/admin/shipping/" + _htmlEscape(encodeURIComponent(z.slug)) + "/archive\" class=\"form-inline\">" +
            "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Regions</th><th scope=\"col\" class=\"num\">Rates</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No shipping zones yet.</p>";

  var createForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Add a zone</h3>" +
      "<p class=\"meta\">A flat-rate service for one destination. Add more rate rows / regions from the zone's manage screen.</p>" +
      "<form method=\"post\" action=\"/admin/shipping\">" +
        _setupField("Slug", "slug", "", "text", "Stable identifier, e.g. domestic-us.", " maxlength=\"64\" required") +
        _setupField("Title", "title", "", "text", "Operator-facing name, e.g. Domestic (US).", " maxlength=\"200\" required") +
        _setupField("Country", "country", "", "text", "ISO 3166-1 alpha-2, e.g. US.", " maxlength=\"2\" class=\"input-code\" required") +
        _setupField("Region (optional)", "region", "", "text", "ISO 3166-2 subdivision without country prefix, e.g. CA. Blank = whole country.", " maxlength=\"3\" class=\"input-code\"") +
        _setupField("Service label", "service_label", "", "text", "Shown at checkout, e.g. Standard.", " maxlength=\"128\" required") +
        _setupField("Rate (minor units)", "rate_minor", "", "number", "In the currency's smallest unit — 500 = $5.00.", " min=\"0\" required") +
        _setupField("Currency", "currency", "", "text", "3-letter ISO 4217, e.g. USD.", " maxlength=\"3\" class=\"input-code\" required") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add zone</button></div>" +
      "</form>" +
    "</div>";

  var body = "<section><h2>Shipping zones</h2>" + created + updated + archived + notice + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Shipping zones", body, "shipping", opts.nav_available);
}

function renderAdminShippingZone(opts) {
  opts = opts || {};
  var z = opts.zone;
  if (!z) {
    var nf = "<section><h2>Shipping zone</h2><p class=\"empty\">Zone not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/shipping\">Back to shipping</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Shipping zone", nf, "shipping", opts.nav_available);
  }
  var updated = opts.updated ? "<div class=\"banner banner--ok\">Zone updated.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var enc = encodeURIComponent(z.slug);

  var rateRows = (z.rates || []).map(function (r) {
    var bucket = [];
    if (r.min_weight_grams != null || r.max_weight_grams != null) {
      bucket.push((r.min_weight_grams || 0) + "–" + (r.max_weight_grams == null ? "∞" : r.max_weight_grams) + " g");
    }
    if (r.min_order_minor != null || r.max_order_minor != null) {
      bucket.push((r.min_order_minor || 0) + "–" + (r.max_order_minor == null ? "∞" : r.max_order_minor) + " minor");
    }
    return "<tr>" +
      "<td>" + _htmlEscape(r.service_label) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(pricing.format(r.rate_minor, String(r.currency || "").toUpperCase())) + "</td>" +
      "<td>" + (bucket.length ? _htmlEscape(bucket.join(" · ")) : "<span class=\"meta\">any</span>") + "</td>" +
    "</tr>";
  }).join("");
  var rateTable = (z.rates || []).length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Service</th><th scope=\"col\" class=\"num\">Rate</th><th scope=\"col\">Bucket</th></tr></thead><tbody>" + rateRows + "</tbody></table></div>"
    : "<p class=\"empty\">No rate rows.</p>";

  var head = "<p class=\"meta\"><a href=\"/admin/shipping\">&larr; Shipping</a> · <code class=\"order-id\">" + _htmlEscape(z.slug) + "</code> · " +
    "<span class=\"status-pill " + (z.archived_at != null ? "cancelled" : (z.active ? "paid" : "pending")) + "\">" +
    (z.archived_at != null ? "archived" : (z.active ? "active" : "paused")) + "</span></p>";

  // Edit form: title + active toggle always; regions / rates via JSON
  // paste for the full vocabulary (weight + order buckets, multi-region).
  var editForm =
    "<div class=\"panel mt mw-42\">" +
      "<h3 class=\"subhead\">Edit zone</h3>" +
      "<form method=\"post\" action=\"/admin/shipping/" + _htmlEscape(enc) + "/edit\">" +
        _setupField("Title", "title", z.title, "text", "", " maxlength=\"200\"") +
        "<input type=\"hidden\" name=\"active_present\" value=\"1\">" +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"active\"" + (z.active ? " checked" : "") + "> Active (serve this zone at checkout)</label>" +
        "<label class=\"form-field\"><span>Regions JSON (optional)</span>" +
          "<textarea name=\"regions_json\" rows=\"3\" placeholder='[{\"country\":\"US\",\"region\":\"CA\"}]'></textarea>" +
          "<small>Paste to replace the regions array. Blank leaves it unchanged.</small></label>" +
        "<label class=\"form-field\"><span>Rates JSON (optional)</span>" +
          "<textarea name=\"rates_json\" rows=\"4\" placeholder='[{\"rate_minor\":500,\"currency\":\"USD\",\"service_label\":\"Standard\"}]'></textarea>" +
          "<small>Paste to replace the rate table. Blank leaves it unchanged.</small></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save zone</button>" +
          "<a class=\"btn btn--ghost\" href=\"/admin/shipping\">Back</a></div>" +
      "</form>" +
    "</div>";

  var body = "<section><h2>" + _htmlEscape(z.title) + "</h2>" + updated + notice + head +
    "<h3 class=\"subhead subhead--sp-lg\">Rates</h3>" + rateTable + editForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Zone " + z.slug, body, "shipping", opts.nav_available);
}

// Human one-liner for a rule's trigger / value JSON.
function _fmtTrigger(t) {
  if (!t || !t.kind) return "—";
  if (t.kind === "cart_total_min") return "cart ≥ " + (t.min_minor || 0) + " minor";
  if (t.kind === "item_count_min") return "≥ " + (t.min_count || 0) + " items";
  if (t.kind === "sku_purchase")   return "buys " + (t.skus || []).join("/") + (t.min_quantity > 1 ? " ×" + t.min_quantity : "");
  return t.kind;
}
function _fmtValue(v) {
  if (!v || !v.kind) return "—";
  if (v.kind === "percent_off")      return (Number(v.basis_points) / 100).toFixed(2) + "% off";
  if (v.kind === "amount_off_total") return v.minor + " minor off total";
  if (v.kind === "amount_off_each")  return v.minor + " minor off each";
  if (v.kind === "free_shipping")    return "free shipping";
  if (v.kind === "bogo")             return "buy " + v.buy_qty + " get " + v.get_qty;
  return v.kind;
}

// Single auto-discount rule detail + a full edit form. Unlike the
// inline row form (priority/active only), this form re-collects the
// trigger + value terms so an operator can change the amount / percent
// / threshold / BOGO quantities from the console. The trigger / value
// field set mirrors the create form exactly; each kind's fields are
// prefilled from the rule's current terms, and the operator fills the
// ones the chosen kind needs (the backend validates the required
// fields for the kind). The hidden active_present marker keeps a
// terms-only edit from flipping active.
function renderAdminDiscount(opts) {
  opts = opts || {};
  var r = opts.rule;
  if (!r) {
    var nf = "<section><h2>Discount rule</h2><p class=\"empty\">Discount rule not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/discounts\">Back to discounts</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Discount rule", nf, "discounts", opts.nav_available);
  }
  var updated = opts.updated ? "<div class=\"banner banner--ok\">Rule updated.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var isArchived = r.archived_at != null;
  var t = r.trigger || {};
  var v = r.value || {};

  var TRIGGERS = [
    { value: "cart_total_min", label: "Cart total ≥ (minor)" },
    { value: "item_count_min", label: "Item count ≥" },
    { value: "sku_purchase",   label: "SKU purchased" },
  ];
  var VALUES = [
    { value: "percent_off",      label: "Percent off" },
    { value: "amount_off_total", label: "Amount off total" },
    { value: "amount_off_each",  label: "Amount off each" },
    { value: "free_shipping",    label: "Free shipping" },
    { value: "bogo",             label: "Buy X get Y" },
  ];
  // For amount_off_total / amount_off_each the lib stores one `minor`
  // field; prefill it for whichever amount kind is active.
  var amountMinor = (v.kind === "amount_off_total" || v.kind === "amount_off_each") && v.minor != null ? String(v.minor) : "";

  var editForm = isArchived
    ? "<p class=\"empty\">This rule is archived and can no longer be edited.</p>"
    : "<div class=\"panel mw-42\">" +
        "<h3 class=\"subhead\">Edit rule</h3>" +
        "<p class=\"meta\">Change the trigger, the value, or the priority. Fill the fields for the trigger / value kind you pick — the others are ignored.</p>" +
        "<form method=\"post\" action=\"/admin/discounts/" + _htmlEscape(encodeURIComponent(r.slug)) + "/edit\">" +
          "<input type=\"hidden\" name=\"active_present\" value=\"1\">" +
          _setupField("Title", "title", r.title, "text", "Operator-facing name.", " maxlength=\"200\"") +
          _selectField("Trigger kind", "trigger_kind", TRIGGERS, t.kind || "cart_total_min", "What fires the rule.", "") +
          _setupField("· Cart total min (minor)", "trigger_min_minor", t.kind === "cart_total_min" && t.min_minor != null ? String(t.min_minor) : "", "number", "For \"Cart total ≥\".", " min=\"0\"") +
          _setupField("· Item count min", "trigger_min_count", t.kind === "item_count_min" && t.min_count != null ? String(t.min_count) : "", "number", "For \"Item count ≥\".", " min=\"1\"") +
          _setupField("· SKUs (comma-separated)", "trigger_skus", t.kind === "sku_purchase" && Array.isArray(t.skus) ? t.skus.join(",") : "", "text", "For \"SKU purchased\".", " maxlength=\"2000\"") +
          _setupField("· SKU min quantity", "trigger_min_quantity", t.kind === "sku_purchase" && t.min_quantity != null ? String(t.min_quantity) : "", "number", "For \"SKU purchased\" (default 1).", " min=\"1\"") +
          _selectField("Value kind", "value_kind", VALUES, v.kind || "percent_off", "What the rule gives.", "") +
          _setupField("· Percent (basis points)", "value_basis_points", v.kind === "percent_off" && v.basis_points != null ? String(v.basis_points) : "", "number", "For \"Percent off\". 1000 = 10.00%.", " min=\"1\" max=\"10000\"") +
          _setupField("· Amount (minor)", "value_minor", amountMinor, "number", "For \"Amount off total / each\".", " min=\"1\"") +
          _setupField("· BOGO buy qty", "value_buy_qty", v.kind === "bogo" && v.buy_qty != null ? String(v.buy_qty) : "", "number", "For \"Buy X get Y\".", " min=\"1\"") +
          _setupField("· BOGO get qty", "value_get_qty", v.kind === "bogo" && v.get_qty != null ? String(v.get_qty) : "", "number", "For \"Buy X get Y\".", " min=\"1\"") +
          _setupField("Priority", "priority", String(r.priority), "number", "Higher wins ties.", " min=\"0\"") +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"active\"" + (r.active ? " checked" : "") + "> Active</label>" +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save changes</button></div>" +
        "</form>" +
      "</div>";

  var bodyHtml = "<section><h2>Discount rule</h2>" + updated + notice +
    "<div class=\"panel\"><dl class=\"detail-grid\">" +
      "<div><dt>Rule</dt><dd><strong>" + _htmlEscape(r.title) + "</strong><br><code class=\"order-id\">" + _htmlEscape(r.slug) + "</code></dd></div>" +
      "<div><dt>Trigger</dt><dd>" + _htmlEscape(_fmtTrigger(r.trigger)) + "</dd></div>" +
      "<div><dt>Value</dt><dd>" + _htmlEscape(_fmtValue(r.value)) + "</dd></div>" +
      "<div><dt>Priority</dt><dd>" + _htmlEscape(String(r.priority)) + "</dd></div>" +
      "<div><dt>Status</dt><dd><span class=\"status-pill " + (isArchived ? "cancelled" : (r.active ? "paid" : "pending")) + "\">" + (isArchived ? "archived" : (r.active ? "active" : "paused")) + "</span></dd></div>" +
    "</dl></div>" +
    editForm +
    "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/discounts\">Back to discounts</a></div>" +
  "</section>";
  return _renderAdminShell(opts.shop_name, "Discount rule", bodyHtml, "discounts", opts.nav_available);
}

function renderAdminDiscounts(opts) {
  opts = opts || {};
  var rules = opts.rules || [];
  var policies = opts.policies || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Discount rule created.</div>" : "";
  var updated  = opts.updated  ? "<div class=\"banner banner--ok\">Rule updated.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Rule archived.</div>" : "";
  var pCreated = opts.policy_created  ? "<div class=\"banner banner--ok\">Stacking policy created.</div>" : "";
  var pArchived = opts.policy_archived ? "<div class=\"banner banner--ok\">Stacking policy archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var ruleRows = rules.map(function (r) {
    var isArchived = r.archived_at != null;
    var statusCls = isArchived ? "cancelled" : (r.active ? "paid" : "pending");
    var statusTxt = isArchived ? "archived" : (r.active ? "active" : "paused");
    var actions = isArchived ? "" :
      "<form method=\"post\" action=\"/admin/discounts/" + _htmlEscape(encodeURIComponent(r.slug)) + "/edit\" class=\"form-inline\">" +
        "<input type=\"hidden\" name=\"active_present\" value=\"1\">" +
        "<input type=\"number\" name=\"priority\" value=\"" + _htmlEscape(String(r.priority)) + "\" min=\"0\" class=\"input-sm\" aria-label=\"priority\">" +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"active\"" + (r.active ? " checked" : "") + "> on</label>" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Save</button>" +
      "</form> " +
      "<a class=\"btn btn--ghost\" href=\"/admin/discounts/" + _htmlEscape(encodeURIComponent(r.slug)) + "\">Edit terms</a> " +
      "<form method=\"post\" action=\"/admin/discounts/" + _htmlEscape(encodeURIComponent(r.slug)) + "/archive\" class=\"form-inline\">" +
        "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>";
    return "<tr>" +
      "<td><strong>" + _htmlEscape(r.title) + "</strong><br><code class=\"order-id\">" + _htmlEscape(r.slug) + "</code></td>" +
      "<td>" + _htmlEscape(_fmtTrigger(r.trigger)) + "</td>" +
      "<td>" + _htmlEscape(_fmtValue(r.value)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(r.priority)) + "</td>" +
      "<td><span class=\"status-pill " + statusCls + "\">" + _htmlEscape(statusTxt) + "</span></td>" +
      "<td>" + actions + "</td>" +
    "</tr>";
  }).join("");
  var ruleTable = rules.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Rule</th><th scope=\"col\">Trigger</th><th scope=\"col\">Value</th><th scope=\"col\" class=\"num\">Priority</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + ruleRows + "</tbody></table></div>"
    : "<p class=\"empty\">No automatic discount rules yet.</p>";

  var TRIGGERS = [
    { value: "cart_total_min", label: "Cart total ≥ (minor)" },
    { value: "item_count_min", label: "Item count ≥" },
    { value: "sku_purchase",   label: "SKU purchased" },
  ];
  var VALUES = [
    { value: "percent_off",      label: "Percent off" },
    { value: "amount_off_total", label: "Amount off total" },
    { value: "amount_off_each",  label: "Amount off each" },
    { value: "free_shipping",    label: "Free shipping" },
    { value: "bogo",             label: "Buy X get Y" },
  ];
  // The create form is server-rendered with every trigger / value field
  // present; the operator fills the ones that apply to the kind they
  // pick (the lib validates the chosen kind's required fields). No client
  // JS toggling — the strict CSP forbids inline script, and the backend
  // is the validator.
  var createForm =
    "<div class=\"panel mt mw-42\">" +
      "<h3 class=\"subhead\">Add a rule</h3>" +
      "<form method=\"post\" action=\"/admin/discounts\">" +
        _setupField("Slug", "slug", "", "text", "Stable handle, e.g. free-ship-50.", " maxlength=\"80\" required") +
        _setupField("Title", "title", "", "text", "Operator-facing name.", " maxlength=\"200\" required") +
        _selectField("Trigger kind", "trigger_kind", TRIGGERS, "cart_total_min", "What fires the rule.", "") +
        _setupField("· Cart total min (minor)", "trigger_min_minor", "", "number", "For \"Cart total ≥\".", " min=\"0\"") +
        _setupField("· Item count min", "trigger_min_count", "", "number", "For \"Item count ≥\".", " min=\"1\"") +
        _setupField("· SKUs (comma-separated)", "trigger_skus", "", "text", "For \"SKU purchased\".", " maxlength=\"2000\"") +
        _setupField("· SKU min quantity", "trigger_min_quantity", "", "number", "For \"SKU purchased\" (default 1).", " min=\"1\"") +
        _selectField("Value kind", "value_kind", VALUES, "percent_off", "What the rule gives.", "") +
        _setupField("· Percent (basis points)", "value_basis_points", "", "number", "For \"Percent off\". 1000 = 10.00%.", " min=\"1\" max=\"10000\"") +
        _setupField("· Amount (minor)", "value_minor", "", "number", "For \"Amount off total / each\".", " min=\"1\"") +
        _setupField("· BOGO buy qty", "value_buy_qty", "", "number", "For \"Buy X get Y\".", " min=\"1\"") +
        _setupField("· BOGO get qty", "value_get_qty", "", "number", "For \"Buy X get Y\".", " min=\"1\"") +
        _setupField("Priority", "priority", "", "number", "Higher wins ties. Default 0.", " min=\"0\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add rule</button></div>" +
      "</form>" +
    "</div>";

  var policySection = "";
  if (opts.stacking_enabled) {
    var polRows = policies.map(function (p) {
      var isArchived = p.archived_at != null;
      var combine = [];
      if (p.allow_combine && p.allow_combine.with_other_codes) combine.push("codes");
      if (p.allow_combine && p.allow_combine.with_quantity_discounts) combine.push("qty discounts");
      var statusCls = isArchived ? "cancelled" : (p.active ? "paid" : "pending");
      var statusTxt = isArchived ? "archived" : (p.active ? "active" : "paused");
      var actions = isArchived ? "" :
        "<form method=\"post\" action=\"/admin/discounts/policies/" + _htmlEscape(encodeURIComponent(p.slug)) + "/archive\" class=\"form-inline\">" +
          "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>";
      return "<tr>" +
        "<td><strong>" + _htmlEscape(p.title) + "</strong><br><code class=\"order-id\">" + _htmlEscape(p.slug) + "</code></td>" +
        "<td class=\"num\">" + _htmlEscape(String(p.max_codes_per_order)) + "</td>" +
        "<td>" + (combine.length ? _htmlEscape(combine.join(", ")) : "<span class=\"meta\">none</span>") + "</td>" +
        "<td class=\"num\">" + _htmlEscape(String(p.order_min_minor)) + "</td>" +
        "<td><span class=\"status-pill " + statusCls + "\">" + _htmlEscape(statusTxt) + "</span></td>" +
        "<td>" + actions + "</td>" +
      "</tr>";
    }).join("");
    var polTable = policies.length
      ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Policy</th><th scope=\"col\" class=\"num\">Max codes</th><th scope=\"col\">Combines with</th><th scope=\"col\" class=\"num\">Order min</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + polRows + "</tbody></table></div>"
      : "<p class=\"empty\">No stacking policies yet — without one, only one code applies per order.</p>";
    var polForm =
      "<div class=\"panel mt mw-40\">" +
        "<h3 class=\"subhead\">Add a stacking policy</h3>" +
        "<form method=\"post\" action=\"/admin/discounts/policies\">" +
          _setupField("Slug", "slug", "", "text", "Stable handle, e.g. default-stack.", " maxlength=\"80\" required") +
          _setupField("Title", "title", "", "text", "Operator-facing name.", " maxlength=\"200\" required") +
          _setupField("Max codes per order", "max_codes_per_order", "", "number", "1–32.", " min=\"1\" max=\"32\" required") +
          _setupField("Order minimum (minor)", "order_min_minor", "", "number", "Subtotal floor; default 0.", " min=\"0\"") +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"with_other_codes\"> Allow combining multiple codes</label>" +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"with_quantity_discounts\"> Allow combining with quantity discounts</label>" +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add policy</button></div>" +
        "</form>" +
      "</div>";
    policySection = "<h3 class=\"subhead subhead--sp-lg\">Coupon stacking policies</h3>" +
      "<p class=\"meta\">Gate which codes (and quantity discounts) may combine on one order.</p>" +
      pCreated + pArchived + polTable + polForm;
  }

  var body = "<section><h2>Discounts</h2>" + created + updated + archived + notice +
    "<p class=\"meta\">Automatic cart-level discounts — applied without a coupon code.</p>" +
    ruleTable + createForm + policySection + "</section>";
  return _renderAdminShell(opts.shop_name, "Discounts", body, "discounts", opts.nav_available);
}

function renderAdminGiftCards(opts) {
  opts = opts || {};
  var rows = opts.cards || [];
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var sf = opts.status_filter;
  var STATUS = ["active", "redeemed", "expired", "voided"];
  var chipHtml = "<a class=\"chip" + (sf == null ? " chip--on" : "") + "\" href=\"/admin/gift-cards\">All</a>";
  for (var s = 0; s < STATUS.length; s += 1) {
    chipHtml += "<a class=\"chip" + (sf === STATUS[s] ? " chip--on" : "") +
      "\" href=\"/admin/gift-cards?status=" + STATUS[s] + "\">" + STATUS[s] + "</a>";
  }
  var chips = "<div class=\"order-filters\">" + chipHtml + "</div>";

  // Card lifecycle → status-pill class (reuse the order pills): active
  // = paid (green), redeemed = neutral, expired/voided = cancelled.
  function _pill(status) {
    var cls = status === "active" ? "paid" : (status === "redeemed" ? "pending" : "cancelled");
    return "<span class=\"status-pill " + cls + "\">" + _htmlEscape(status) + "</span>";
  }

  var bodyRows = rows.map(function (gc) {
    var cur = String(gc.currency || "").toUpperCase();
    var issued    = pricing.format(gc.issued_minor, cur);
    var remaining = pricing.format(gc.balance_minor, cur);
    return "<tr>" +
      "<th scope=\"row\"><code class=\"order-id\">••••" + _htmlEscape(gc.code_hint) + "</code></th>" +
      "<td class=\"num\">" + _htmlEscape(issued) + "</td>" +
      "<td class=\"num\"><strong>" + _htmlEscape(remaining) + "</strong></td>" +
      "<td>" + _pill(gc.status) + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(gc.created_at)) + "</td>" +
      "<td><a class=\"btn btn--ghost\" href=\"/admin/gift-cards/" + _htmlEscape(gc.id) + "\">Ledger</a></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Code</th><th scope=\"col\" class=\"num\">Issued</th><th scope=\"col\" class=\"num\">Remaining</th><th scope=\"col\">Status</th><th scope=\"col\">Issued on</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No gift cards" + (sf ? " " + _htmlEscape(sf) : " yet") + ".</p>";

  // The issue form composes the giftcards primitive's issue() — the
  // plaintext code is shown once on the card's detail page after a
  // successful issue, never again.
  var issueForm =
    "<div class=\"panel mt mw-34\">" +
      "<h3 class=\"subhead\">Issue a card</h3>" +
      "<p class=\"meta\">Generates a bearer code. You'll see the code once, on the next screen — deliver it to the recipient; it can't be shown again.</p>" +
      "<form method=\"post\" action=\"/admin/gift-cards\">" +
        _setupField("Amount (minor units)", "amount_minor", "", "number", "In the currency's smallest unit — e.g. 5000 = $50.00.", " min=\"1\" required") +
        _setupField("Currency", "currency", "", "text", "3-letter ISO 4217 (e.g. USD).", " maxlength=\"3\" required") +
        _setupField("Recipient email (optional)", "issued_to_email", "", "email", "Stored as a one-way hash so the recipient can claim it after sign-in.", " maxlength=\"160\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Issue card</button></div>" +
      "</form>" +
    "</div>";

  var body = "<section><h2>Gift cards</h2>" + notice + chips + table + issueForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Gift cards", body, "giftcards", opts.nav_available);
}

// Single-card detail: the masked code, the balances + status, the
// (optionally shown-once) freshly-issued plaintext code, and the
// append-only ledger of transactions against the card.
function renderAdminGiftCard(opts) {
  opts = opts || {};
  var gc = opts.card;
  if (!gc) {
    var nf = "<section><h2>Gift card</h2><p class=\"empty\">Gift card not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/gift-cards\">Back to gift cards</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Gift card", nf, "giftcards", opts.nav_available);
  }
  var cur = String(gc.currency || "").toUpperCase();
  var issuedBanner = opts.issued_code
    ? "<div class=\"banner banner--ok\">Copy the code now — it is shown once and cannot be retrieved again: " +
        "<code class=\"order-id\">" + _htmlEscape(opts.issued_code) + "</code></div>"
    : "";
  var voidedBanner = opts.voided ? "<div class=\"banner banner--ok\">Gift card voided. Its remaining balance can no longer be redeemed.</div>" : "";
  var noticeBanner = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var statusCls = gc.status === "active" ? "paid" : (gc.status === "redeemed" ? "pending" : "cancelled");
  var summary =
    "<div class=\"panel\"><dl class=\"detail-grid\">" +
      "<div><dt>Code</dt><dd><code class=\"order-id\">••••" + _htmlEscape(gc.code_hint) + "</code></dd></div>" +
      "<div><dt>Issued</dt><dd>" + _htmlEscape(pricing.format(gc.issued_minor, cur)) + "</dd></div>" +
      "<div><dt>Remaining</dt><dd><strong>" + _htmlEscape(pricing.format(gc.balance_minor, cur)) + "</strong></dd></div>" +
      "<div><dt>Status</dt><dd><span class=\"status-pill " + statusCls + "\">" + _htmlEscape(gc.status) + "</span></dd></div>" +
      "<div><dt>Issued on</dt><dd>" + _htmlEscape(_fmtDate(gc.created_at)) + "</dd></div>" +
      "<div><dt>Expires</dt><dd>" + (gc.expires_at ? _htmlEscape(_fmtDate(gc.expires_at)) : "<span class=\"meta\">never</span>") + "</dd></div>" +
    "</dl></div>";

  var ledger = opts.ledger || [];
  var ledgerRows = ledger.map(function (row) {
    var detail = row.order_id
      ? "<code class=\"order-id\">" + _htmlEscape(String(row.order_id).slice(0, 8)) + "</code>"
      : (row.source ? _htmlEscape(row.source) + (row.source_ref ? " · " + _htmlEscape(row.source_ref) : "") : "<span class=\"meta\">—</span>");
    var sign = row.kind === "credit" ? "+" : "−";
    return "<tr>" +
      "<td>" + _htmlEscape(row.kind) + "</td>" +
      "<td class=\"num\">" + sign + _htmlEscape(pricing.format(row.amount_minor, cur)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(pricing.format(row.balance_after_minor, cur)) + "</td>" +
      "<td>" + detail + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(row.occurred_at)) + "</td>" +
    "</tr>";
  }).join("");
  var ledgerTable = ledger.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Type</th><th scope=\"col\" class=\"num\">Amount</th><th scope=\"col\" class=\"num\">Balance after</th><th scope=\"col\">Detail</th><th scope=\"col\">When</th></tr></thead><tbody>" + ledgerRows + "</tbody></table></div>"
    : "<p class=\"empty\">No ledger transactions recorded for this card yet.</p>";

  // Void is offered only while the card is active — a redeemed card has
  // no balance to revoke, a voided card is already revoked. The confirm
  // interstitial guards the destructive POST.
  var voidAction = gc.status === "active"
    ? "<form method=\"post\" action=\"/admin/gift-cards/" + _htmlEscape(gc.id) + "/void/confirm\" class=\"form-inline\"><button class=\"btn btn--danger\" type=\"submit\">Void card</button></form>"
    : "";

  var body = "<section><h2>Gift card</h2>" + issuedBanner + voidedBanner + noticeBanner + summary +
    "<h3 class=\"subhead subhead--sp-lg\">Ledger</h3>" + ledgerTable +
    "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/gift-cards\">Back to gift cards</a>" + voidAction + "</div></section>";
  return _renderAdminShell(opts.shop_name, "Gift card", body, "giftcards", opts.nav_available);
}

function renderAdminWebhooks(opts) {
  opts = opts || {};
  var rows  = opts.endpoints    || [];
  var known = opts.known_events || [];
  var toggled = opts.toggled ? "<div class=\"banner banner--ok\">Endpoint updated.</div>" : "";
  var deleted = opts.deleted ? "<div class=\"banner banner--ok\">Endpoint deleted.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // The signing secret is intentionally absent from this table — it is
  // shown once on create (renderAdminWebhookSecret) and never again.
  var bodyRows = rows.map(function (e) {
    var isActive = e.active === 1 || e.active === true;
    var events = e.events === "*" ? "all events" : String(e.events || "").split(",").join(", ");
    return "<tr>" +
      "<td><code class=\"order-id\">" + _htmlEscape(e.url) + "</code></td>" +
      "<td>" + _htmlEscape(events) + "</td>" +
      "<td><span class=\"status-pill " + (isActive ? "paid" : "cancelled") + "\">" + (isActive ? "active" : "disabled") + "</span></td>" +
      "<td class=\"num\">" + _htmlEscape(String(e.rate_limit_per_minute)) + "/min</td>" +
      "<td>" +
        "<a class=\"btn btn--ghost\" href=\"/admin/webhooks/" + _htmlEscape(e.id) + "/deliveries\">Deliveries</a> " +
        "<form method=\"post\" action=\"/admin/webhooks/" + _htmlEscape(e.id) + "/toggle\" class=\"form-inline\"><button class=\"btn btn--ghost\" type=\"submit\">" + (isActive ? "Disable" : "Enable") + "</button></form> " +
        "<form method=\"post\" action=\"/admin/webhooks/" + _htmlEscape(e.id) + "/delete/confirm\" class=\"form-inline\"><button class=\"btn btn--danger\" type=\"submit\">Delete</button></form>" +
      "</td></tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">URL</th><th scope=\"col\">Events</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Rate</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No webhook endpoints yet.</p>";

  var eventChecks = known.map(function (ev) {
    return "<label class=\"kv\"><input type=\"checkbox\" name=\"evt_" + _htmlEscape(ev) + "\"> <code>" + _htmlEscape(ev) + "</code></label>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Add an endpoint</h3>" +
      "<p class=\"meta\">Deliveries are signed (HMAC-SHA3-512); the signing secret is shown once, right after you create the endpoint. Only https:// URLs are accepted.</p>" +
      "<form method=\"post\" action=\"/admin/webhooks\">" +
        _setupField("Endpoint URL", "url", "", "url", "Where deliveries are POSTed (https:// only).", " maxlength=\"2048\" required") +
        "<fieldset class=\"box\">" +
          "<legend class=\"legend-sm\">Events</legend>" +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"events_all\"> <strong>All events (*)</strong></label>" +
          eventChecks +
          "<small class=\"u-mute\">Pick specific events, or check “All events” to subscribe to everything.</small>" +
        "</fieldset>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create endpoint</button></div>" +
      "</form>" +
    "</div>";

  var body = "<section><h2>Webhooks</h2>" + toggled + deleted + notice + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Webhooks", body, "webhooks", opts.nav_available);
}

function renderAdminWebhookSecret(opts) {
  opts = opts || {};
  var e = opts.endpoint || {};
  var body =
    "<section class=\"mw-42\">" +
      "<h2>Endpoint created</h2>" +
      "<div class=\"banner banner--ok\">Copy the signing secret now — it is shown once and cannot be retrieved again.</div>" +
      "<div class=\"panel\">" +
        "<p class=\"meta\">Endpoint</p><p><code class=\"order-id\">" + _htmlEscape(e.url || "") + "</code></p>" +
        "<p class=\"meta\">Signing secret (HMAC-SHA3-512, key id <code>v1</code>)</p>" +
        "<pre class=\"code-block\"><code>" + _htmlEscape(e.secret || "") + "</code></pre>" +
        "<p class=\"meta\">Verify each delivery's signature with this secret using your framework's webhook verifier.</p>" +
      "</div>" +
      "<div class=\"actions-row\"><a class=\"btn\" href=\"/admin/webhooks\">Done</a></div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Endpoint created", body, "webhooks", opts.nav_available);
}

function renderAdminWebhookDeliveries(opts) {
  opts = opts || {};
  var e = opts.endpoint;
  if (!e) {
    var nf = "<section><h2>Deliveries</h2><p class=\"empty\">Endpoint not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/webhooks\">Back to webhooks</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Deliveries", nf, "webhooks", opts.nav_available);
  }
  var rows = opts.deliveries || [];
  var retried = opts.retried ? "<div class=\"banner banner--ok\">Delivery retried.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var bodyRows = rows.map(function (d) {
    var ok = d.delivered_at != null;
    var statusCell = ok
      ? "<span class=\"status-pill paid\">delivered</span>"
      : "<span class=\"status-pill " + (d.last_error ? "refunded" : "pending") + "\">" + (d.last_error ? "failed" : "pending") + "</span>";
    var code = d.last_status != null ? _htmlEscape(String(d.last_status)) : "—";
    var retry = ok ? "<span class=\"meta\">—</span>"
      : "<form method=\"post\" action=\"/admin/webhooks/deliveries/" + _htmlEscape(d.id) + "/retry\" class=\"form-inline\"><button class=\"btn btn--ghost\" type=\"submit\">Retry</button></form>";
    return "<tr>" +
      "<td>" + _htmlEscape(d.event_type) + "</td>" +
      "<td>" + statusCell + "</td>" +
      "<td class=\"num\">" + code + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(d.attempts)) + "</td>" +
      "<td>" + (d.last_error ? "<span class=\"meta\">" + _htmlEscape(d.last_error) + "</span>" : "") + "</td>" +
      "<td>" + _htmlEscape(_fmtDate(d.created_at)) + "</td>" +
      "<td>" + retry + "</td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Event</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Code</th><th scope=\"col\" class=\"num\">Attempts</th><th scope=\"col\">Last error</th><th scope=\"col\">Created</th><th scope=\"col\"></th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No deliveries recorded for this endpoint yet.</p>";

  var head = "<p class=\"meta\">Endpoint <code class=\"order-id\">" + _htmlEscape(e.url) + "</code></p>";
  var body = "<section><h2>Deliveries</h2>" + retried + notice + head + table +
    "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/webhooks\">Back to webhooks</a></div></section>";
  return _renderAdminShell(opts.shop_name, "Deliveries", body, "webhooks", opts.nav_available);
}

function renderAdminCollections(opts) {
  opts = opts || {};
  var rows = opts.collections || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Collection created.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Collection archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var af = opts.active_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (af == null ? " chip--on" : "") + "\" href=\"/admin/collections\">All</a>" +
    "<a class=\"chip" + (af === "1" ? " chip--on" : "") + "\" href=\"/admin/collections?active=1\">Active</a>" +
    "<a class=\"chip" + (af === "0" ? " chip--on" : "") + "\" href=\"/admin/collections?active=0\">Archived</a>" +
    "</div>";

  var bodyRows = rows.map(function (c) {
    var isArchived = c.archived_at != null;
    var typeLabel = c.type === "smart" ? "smart" : "manual";
    var countLabel = c._count == null ? "—" : String(c._count);
    var countTitle = c.type === "smart" ? "matched products" : "members";
    return "<tr>" +
      "<td><a href=\"/admin/collections/" + _htmlEscape(encodeURIComponent(c.slug)) + "\"><strong>" + _htmlEscape(c.title) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(c.slug) + "</code></td>" +
      "<td><span class=\"status-pill " + (c.type === "smart" ? "pending" : "paid") + "\">" + _htmlEscape(typeLabel) + "</span></td>" +
      "<td><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "active") + "</span></td>" +
      "<td class=\"num\" title=\"" + _htmlEscape(countTitle) + "\">" + _htmlEscape(countLabel) + "</td>" +
      "<td><div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/collections/" + _htmlEscape(encodeURIComponent(c.slug)) + "\">Manage</a>" +
        (isArchived ? "" :
          "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(encodeURIComponent(c.slug)) + "/archive\" class=\"form-inline\">" +
            "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Type</th><th scope=\"col\">Status</th><th scope=\"col\" class=\"num\">Products</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No collections" + (af === "0" ? " archived" : af === "1" ? " active" : " yet") + ".</p>";

  // The create form toggles between a manual and a smart shape. Manual
  // needs only title + slug; smart adds one starter rule row (the detail
  // page's rule editor adds more after the collection exists).
  var startType = opts.form_type === "smart" ? "smart" : "manual";
  var fieldOpts = collectionsModule.RULE_FIELDS.map(function (f) {
    return "<option value=\"" + _htmlEscape(f) + "\">" + _htmlEscape(f) + "</option>";
  }).join("");
  var opOpts = collectionsModule.RULE_OPS.map(function (o) {
    return "<option value=\"" + _htmlEscape(o) + "\">" + _htmlEscape(o) + "</option>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Create a collection</h3>" +
      "<p class=\"meta\">Manual collections are handpicked; smart collections match products by a rule set. Slug is the storefront URL (/collections/&lt;slug&gt;).</p>" +
      "<form method=\"post\" action=\"/admin/collections\">" +
        "<label class=\"form-field\"><span>Type</span><select name=\"type\">" +
          "<option value=\"manual\"" + (startType === "manual" ? " selected" : "") + ">manual</option>" +
          "<option value=\"smart\""  + (startType === "smart"  ? " selected" : "") + ">smart</option>" +
        "</select></label>" +
        _setupField("Title", "title", "", "text", "", " maxlength=\"500\" required") +
        _setupField("Slug", "slug", "", "text", "Lowercase, hyphenated.", " maxlength=\"200\" required") +
        _setupField("Description (optional)", "description", "", "text", "", " maxlength=\"2000\"") +
        "<fieldset class=\"box\">" +
          "<legend class=\"legend-sm\">Smart rule (used only for smart collections)</legend>" +
          "<div class=\"actions-row\">" +
            "<select name=\"rule_field\"><option value=\"\">field…</option>" + fieldOpts + "</select>" +
            "<select name=\"rule_op\"><option value=\"\">op…</option>" + opOpts + "</select>" +
            "<input type=\"text\" name=\"rule_value\" placeholder=\"value (lists + between: comma-separated)\" maxlength=\"500\">" +
          "</div>" +
          "<small class=\"u-mute\">Numeric fields (price_minor, inventory_count, created_at) compare as integers. Add more rules after creating.</small>" +
        "</fieldset>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create collection</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Collections</h2>" + created + archived + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Collections", bodyHtml, "collections", opts.nav_available);
}

// Read-only view of the per-line discount-allocation audit trail for one
// order. The operator looks an order up by id; each recorded allocation
// renders as a header (source, kind, total, recorded-at) plus a table of
// the per-line breakdown. Allocations are system-written by checkout —
// there's no create/edit affordance here. Amounts are exact minor-unit
// integers (the audit row carries no currency; the figures are the same
// integers the refund math reads back), so the operator sees the precise
// recorded split rather than a rounded display value.
function renderAdminDiscountAllocation(opts) {
  opts = opts || {};
  var orderId = typeof opts.order_id === "string" ? opts.order_id : "";
  var allocations = opts.allocations || [];
  var notice = opts.notice ? "<div class=\"banner banner--warn\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var lookupForm =
    "<div class=\"panel mw-40\">" +
      "<h3 class=\"subhead\">Look up an order</h3>" +
      "<p class=\"meta\">When an order carried a cart-level discount, the split across its lines is recorded here for refund precision. Enter an order id to see its recorded allocations.</p>" +
      "<form method=\"get\" action=\"/admin/discount-allocation\">" +
        _setupField("Order id", "order_id", orderId, "text", "The order's id (shown on the order detail page).", " maxlength=\"200\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Look up</button></div>" +
      "</form>" +
    "</div>";

  var results = "";
  if (allocations.length) {
    results = allocations.map(function (a) {
      var breakdown = Array.isArray(a.breakdown) ? a.breakdown : [];
      var lineRows = breakdown.map(function (l) {
        return "<tr>" +
          "<td><code class=\"order-id\">" + _htmlEscape(String(l.line_id)) + "</code></td>" +
          "<td class=\"num\">" + _htmlEscape(String(l.allocated_minor)) + "</td>" +
          "<td class=\"num\">" + _htmlEscape(String(l.remaining_minor)) + "</td>" +
        "</tr>";
      }).join("");
      var lineTable = breakdown.length
        ? "<table><thead><tr><th scope=\"col\">Line</th><th scope=\"col\" class=\"num\">Allocated (minor)</th><th scope=\"col\" class=\"num\">Remaining (minor)</th></tr></thead><tbody>" + lineRows + "</tbody></table>"
        : "<p class=\"empty\">This allocation has no recorded lines.</p>";
      return "<div class=\"panel mt\">" +
        "<h3 class=\"subhead\">" + _htmlEscape(a.source || "—") + "</h3>" +
        "<p class=\"meta\">" +
          "Split: <strong>" + _htmlEscape(a.kind || "—") + "</strong>" +
          " &middot; Total: <strong>" + _htmlEscape(String(a.total_minor)) + "</strong> minor units" +
          " &middot; Recorded: " + _htmlEscape(_fmtDate(a.applied_at)) +
        "</p>" +
        lineTable +
      "</div>";
    }).join("");
  }

  var bodyHtml = "<section><h2>Discount splits</h2>" + notice + lookupForm + results + "</section>";
  return _renderAdminShell(opts.shop_name, "Discount splits", bodyHtml, "discount-allocation", opts.nav_available);
}

// A <datetime-local> form value → epoch ms (integer) for the lib's
// starts_at/expires_at, or null when blank/unparseable (open-ended). The
// announcement primitive validates the result; a blank schedule field just
// omits the bound.
function _epochFromForm(v) {
  if (typeof v !== "string" || !v.trim()) return null;
  var t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : null;
}

// Coerce the create form into the shape announcementBar.defineAnnouncement
// expects: trimmed slug, strict boolean `dismissible`, integer epoch
// schedule bounds, and link_url/link_label as a both-or-neither pair.
function _announcementFromForm(body) {
  body = body || {};
  var out = {
    slug:        typeof body.slug === "string" ? body.slug.trim() : body.slug,
    message:     body.message,
    theme:       body.theme,
    audience:    body.audience,
    dismissible: body.dismissible === "on" || body.dismissible === "1" || body.dismissible === true,
  };
  var lu = typeof body.link_url === "string" ? body.link_url.trim() : "";
  var ll = typeof body.link_label === "string" ? body.link_label.trim() : "";
  if (lu || ll) { out.link_url = lu; out.link_label = ll; }
  var sa = _epochFromForm(body.starts_at);  if (sa != null) out.starts_at = sa;
  var ea = _epochFromForm(body.expires_at); if (ea != null) out.expires_at = ea;
  return out;
}

// Coerce the edit form into an updateAnnouncement patch. Every editable
// column the primitive's whitelist accepts is forwarded so a console
// edit reaches the same surface as the bearer PATCH: message, theme,
// audience, dismissible, the link pair, and the two schedule bounds.
// The schedule + link fields use the form's hidden presence markers so
// a partial edit doesn't unintentionally clear an unrelated column: a
// link_present marker maps a blank pair to null (clear the link); a
// starts_present / expires_present marker maps a blank bound to null
// (open the schedule). Absent markers leave the column untouched. The
// primitive validates the result (audience<->segment, link both-or-
// neither, expires>starts) and throws a TypeError on a bad shape, which
// both surfaces degrade to a clean 400 / err notice.
function _announcementPatchFromForm(body) {
  body = body || {};
  var patch = {};
  if (Object.prototype.hasOwnProperty.call(body, "message") && body.message !== "") patch.message = body.message;
  if (body.theme    != null && body.theme    !== "") patch.theme = body.theme;
  if (body.audience != null && body.audience !== "") patch.audience = body.audience;
  // The dismissible checkbox is present (on/1) when checked, absent when
  // unchecked — only treat it as a field when the form declared the
  // hidden marker so a partial JSON edit doesn't flip it.
  if (body.dismissible_present === "1") patch.dismissible = (body.dismissible === "on" || body.dismissible === "1");
  if (body.link_present === "1") {
    var lu = typeof body.link_url === "string" ? body.link_url.trim() : "";
    var ll = typeof body.link_label === "string" ? body.link_label.trim() : "";
    if (lu || ll) { patch.link_url = lu; patch.link_label = ll; }
    else { patch.link_url = null; patch.link_label = null; }
  }
  if (body.starts_present === "1")  patch.starts_at  = _epochFromForm(body.starts_at);
  if (body.expires_present === "1") patch.expires_at = _epochFromForm(body.expires_at);
  return patch;
}

// epoch ms → the <datetime-local> value an <input> renders back. Returns
// "" for a null/absent bound so the field stays empty (open-ended).
function _datetimeLocalValue(epochMs) {
  if (epochMs == null) return "";
  var d = new Date(Number(epochMs));
  if (isNaN(d.getTime())) return "";
  function _pad(n) { return n < 10 ? "0" + n : String(n); }
  return d.getUTCFullYear() + "-" + _pad(d.getUTCMonth() + 1) + "-" + _pad(d.getUTCDate()) +
    "T" + _pad(d.getUTCHours()) + ":" + _pad(d.getUTCMinutes());
}

// Single-announcement detail + edit screen. The form prefills every
// editable column and posts to /edit; the hidden presence markers tell
// the patch coercion which columns the form is authoritative for, so a
// blank schedule / link clears rather than being ignored.
function renderAdminAnnouncement(opts) {
  opts = opts || {};
  var a = opts.announcement;
  if (!a) {
    var nf = "<section><h2>Announcement</h2><p class=\"empty\">Announcement not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/announcements\">Back to announcements</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Announcement", nf, "announcements", opts.nav_available);
  }
  var updated = opts.updated ? "<div class=\"banner banner--ok\">Announcement updated.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var isArchived = a.archived_at != null;

  var themeOpts = ["urgency", "promo", "info", "success"].map(function (t) {
    return "<option value=\"" + t + "\"" + (t === a.theme ? " selected" : "") + ">" + t + "</option>";
  }).join("");
  // segment audience needs an isMember handle that isn't wired in the
  // console (see the create screen's note), so the picker offers the
  // three reachable audiences; an existing segment row keeps its value
  // as a disabled-looking selected option so an edit doesn't silently
  // re-target it.
  var audValues = ["all", "guest", "logged_in"];
  if (a.audience === "segment") audValues = ["segment"].concat(audValues);
  var audienceOpts = audValues.map(function (au) {
    return "<option value=\"" + au + "\"" + (au === a.audience ? " selected" : "") + ">" + au + "</option>";
  }).join("");

  var editForm = isArchived
    ? "<p class=\"empty\">This announcement is archived and can no longer be edited.</p>"
    : "<div class=\"panel mw-40\">" +
        "<h3 class=\"subhead\">Edit announcement</h3>" +
        "<form method=\"post\" action=\"/admin/announcements/" + _htmlEscape(encodeURIComponent(a.slug)) + "/edit\">" +
          "<input type=\"hidden\" name=\"dismissible_present\" value=\"1\">" +
          "<input type=\"hidden\" name=\"link_present\" value=\"1\">" +
          "<input type=\"hidden\" name=\"starts_present\" value=\"1\">" +
          "<input type=\"hidden\" name=\"expires_present\" value=\"1\">" +
          "<label class=\"form-field\"><span>Message</span><textarea name=\"message\" maxlength=\"500\" required>" + _htmlEscape(a.message) + "</textarea></label>" +
          _setupField("Link URL (optional)", "link_url", a.link_url || "", "text", "https:// or a /-rooted path. Clear both to remove the link.", " maxlength=\"2048\"") +
          _setupField("Link label (optional)", "link_label", a.link_label || "", "text", "", " maxlength=\"120\"") +
          "<label class=\"form-field\"><span>Theme</span><select name=\"theme\">" + themeOpts + "</select></label>" +
          "<label class=\"form-field\"><span>Audience</span><select name=\"audience\">" + audienceOpts + "</select></label>" +
          "<label class=\"form-field\"><span>Starts at (optional)</span><input type=\"datetime-local\" name=\"starts_at\" value=\"" + _htmlEscape(_datetimeLocalValue(a.starts_at)) + "\"></label>" +
          "<label class=\"form-field\"><span>Expires at (optional)</span><input type=\"datetime-local\" name=\"expires_at\" value=\"" + _htmlEscape(_datetimeLocalValue(a.expires_at)) + "\"></label>" +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"dismissible\" value=\"on\"" + (a.dismissible ? " checked" : "") + "> Visitors can dismiss this</label>" +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save changes</button></div>" +
        "</form>" +
      "</div>";

  var bodyHtml = "<section><h2>Announcement</h2>" + updated + notice +
    "<div class=\"panel\"><dl class=\"detail-grid\">" +
      "<div><dt>Slug</dt><dd><code class=\"order-id\">" + _htmlEscape(a.slug) + "</code></dd></div>" +
      "<div><dt>Status</dt><dd><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "active") + "</span></dd></div>" +
    "</dl></div>" +
    editForm +
    "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/announcements\">Back to announcements</a></div>" +
  "</section>";
  return _renderAdminShell(opts.shop_name, "Announcement", bodyHtml, "announcements", opts.nav_available);
}

function renderAdminAnnouncements(opts) {
  opts = opts || {};
  var rows = opts.announcements || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Announcement saved.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Announcement archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var af = opts.active_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (af == null ? " chip--on" : "") + "\" href=\"/admin/announcements\">All</a>" +
    "<a class=\"chip" + (af === "1" ? " chip--on" : "") + "\" href=\"/admin/announcements?active=1\">Active now</a>" +
    "</div>";

  var bodyRows = rows.map(function (a) {
    var isArchived = a.archived_at != null;
    return "<tr>" +
      "<td><code class=\"order-id\">" + _htmlEscape(a.slug) + "</code></td>" +
      "<td>" + _htmlEscape(a.message) + "</td>" +
      "<td><span class=\"status-pill\">" + _htmlEscape(a.theme) + "</span></td>" +
      "<td>" + _htmlEscape(a.audience) + "</td>" +
      "<td><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "active") + "</span></td>" +
      "<td><div class=\"actions-row\">" +
        (isArchived ? "" :
          "<a class=\"btn btn--ghost\" href=\"/admin/announcements/" + _htmlEscape(encodeURIComponent(a.slug)) + "\">Edit</a> " +
          "<form method=\"post\" action=\"/admin/announcements/" + _htmlEscape(encodeURIComponent(a.slug)) + "/archive\" class=\"form-inline\">" +
            "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Slug</th><th scope=\"col\">Message</th><th scope=\"col\">Theme</th><th scope=\"col\">Audience</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No announcements" + (af === "1" ? " active right now" : " yet") + ".</p>";

  var themeOpts = ["urgency", "promo", "info", "success"].map(function (t) {
    return "<option value=\"" + t + "\"" + (t === "info" ? " selected" : "") + ">" + t + "</option>";
  }).join("");
  var audienceOpts = ["all", "guest", "logged_in"].map(function (au) {
    return "<option value=\"" + au + "\">" + au + "</option>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Create an announcement</h3>" +
      "<p class=\"meta\">The highest-priority active announcement shows at the top of every page (urgency &gt; promo &gt; info &gt; success). Leave the schedule blank for an open-ended notice.</p>" +
      "<form method=\"post\" action=\"/admin/announcements\">" +
        _setupField("Slug", "slug", "", "text", "Lowercase, hyphenated — a stable id.", " maxlength=\"64\" required") +
        "<label class=\"form-field\"><span>Message</span><textarea name=\"message\" maxlength=\"500\" required></textarea></label>" +
        _setupField("Link URL (optional)", "link_url", "", "text", "https:// or a /-rooted path.", " maxlength=\"2048\"") +
        _setupField("Link label (optional)", "link_label", "", "text", "", " maxlength=\"120\"") +
        "<label class=\"form-field\"><span>Theme</span><select name=\"theme\">" + themeOpts + "</select></label>" +
        "<label class=\"form-field\"><span>Audience</span><select name=\"audience\">" + audienceOpts + "</select></label>" +
        "<label class=\"form-field\"><span>Starts at (optional)</span><input type=\"datetime-local\" name=\"starts_at\"></label>" +
        "<label class=\"form-field\"><span>Expires at (optional)</span><input type=\"datetime-local\" name=\"expires_at\"></label>" +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"dismissible\" value=\"on\" checked> Visitors can dismiss this</label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create announcement</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Announcements</h2>" + created + archived + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Announcements", bodyHtml, "announcements", opts.nav_available);
}

// ---- blog form coercion + render --------------------------------------

// A comma- or newline-separated tag field → the normalized string array
// the blog primitive validates. Empty entries are dropped; the primitive
// enforces the per-tag shape + the dedupe + the count cap, so this only
// splits and trims.
function _csvTags(v) {
  if (typeof v !== "string" || !v.trim()) return [];
  return v.split(/[,\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
}

// Coerce the create form into blogArticles.createDraft's shape: trimmed
// slug, the required title/body/author, the optional tags array, and the
// optional hero-image + meta fields (a blank optional field is omitted so
// the primitive's null default applies). The primitive validates every
// field — this only shapes the form strings.
function _blogFromForm(body) {
  body = body || {};
  var out = {
    slug:      typeof body.slug === "string" ? body.slug.trim() : body.slug,
    title:     body.title,
    body:      body.body,
    author_id: typeof body.author_id === "string" ? body.author_id.trim() : body.author_id,
  };
  var tags = _csvTags(body.tags);
  if (tags.length) out.tags = tags;
  var hero = typeof body.hero_image_url === "string" ? body.hero_image_url.trim() : "";
  if (hero) out.hero_image_url = hero;
  var md = typeof body.meta_description === "string" ? body.meta_description.trim() : "";
  if (md) out.meta_description = md;
  var mk = typeof body.meta_keywords === "string" ? body.meta_keywords.trim() : "";
  if (mk) out.meta_keywords = mk;
  return out;
}

// Coerce the edit form into a blogArticles.update patch. Only the columns
// the form actually carries are included; an empty optional field is sent
// as "" so the operator can clear a previously-set meta line / hero image
// (the primitive accepts an empty string for the nullable meta columns).
// Tags always ride (an empty list clears them). Status is NOT here — it
// moves via the lifecycle routes.
function _blogPatchFromForm(body) {
  body = body || {};
  var patch = { tags: _csvTags(body.tags) };
  if (typeof body.title === "string")           patch.title = body.title;
  if (typeof body.body === "string")            patch.body = body.body;
  if (typeof body.author_id === "string")       patch.author_id = body.author_id.trim();
  if (typeof body.hero_image_url === "string")  patch.hero_image_url = body.hero_image_url.trim() || null;
  if (typeof body.meta_description === "string") patch.meta_description = body.meta_description.trim();
  if (typeof body.meta_keywords === "string")   patch.meta_keywords = body.meta_keywords.trim();
  return patch;
}

// One status pill class per lifecycle state, reusing the order-status pill
// palette: published = paid (green), draft = pending (amber), archived =
// cancelled (grey).
function _blogStatusPill(status) {
  var cls = status === "published" ? "paid" : status === "archived" ? "cancelled" : "pending";
  return "<span class=\"status-pill " + cls + "\">" + _htmlEscape(status) + "</span>";
}

function renderAdminBlog(opts) {
  opts = opts || {};
  var rows = opts.articles || [];
  var created   = opts.created   ? "<div class=\"banner banner--ok\">Post created as a draft.</div>" : "";
  var updated   = opts.updated   ? "<div class=\"banner banner--ok\">Post saved.</div>" : "";
  var published = opts.published ? "<div class=\"banner banner--ok\">Post published — it's live on the storefront blog.</div>" : "";
  var archived  = opts.archived  ? "<div class=\"banner banner--ok\">Post archived.</div>" : "";
  var notice    = opts.notice    ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var sf = opts.status_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (sf == null ? " chip--on" : "") + "\" href=\"/admin/blog\">All</a>" +
    "<a class=\"chip" + (sf === "published" ? " chip--on" : "") + "\" href=\"/admin/blog?status=published\">Published</a>" +
    "<a class=\"chip" + (sf === "draft" ? " chip--on" : "") + "\" href=\"/admin/blog?status=draft\">Drafts</a>" +
    "<a class=\"chip" + (sf === "archived" ? " chip--on" : "") + "\" href=\"/admin/blog?status=archived\">Archived</a>" +
    "</div>";

  var bodyRows = rows.map(function (a) {
    var enc = encodeURIComponent(a.slug);
    var date = a.published_at != null ? _fmtDate(a.published_at) : "—";
    // Per-row lifecycle actions match the post's current state: a draft
    // can publish; a published post can unpublish or archive; an archived
    // post can restore. Edit + the storefront link are always offered.
    var actions = "<a class=\"btn btn--ghost\" href=\"/admin/blog/" + _htmlEscape(enc) + "\">Edit</a>";
    if (a.status === "draft") {
      actions += "<form method=\"post\" action=\"/admin/blog/" + _htmlEscape(enc) + "/publish\" class=\"form-inline\">" +
        "<button class=\"btn\" type=\"submit\">Publish</button></form>";
    } else if (a.status === "published") {
      actions += "<form method=\"post\" action=\"/admin/blog/" + _htmlEscape(enc) + "/unpublish\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Unpublish</button></form>" +
        "<a class=\"btn btn--danger\" href=\"/admin/blog/" + _htmlEscape(enc) + "/archive/confirm-page\">Archive</a>";
    } else if (a.status === "archived") {
      actions += "<form method=\"post\" action=\"/admin/blog/" + _htmlEscape(enc) + "/restore\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Restore</button></form>";
    }
    return "<tr>" +
      "<td><a href=\"/admin/blog/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(a.title) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(a.slug) + "</code></td>" +
      "<td>" + _blogStatusPill(a.status) + "</td>" +
      "<td>" + _htmlEscape(date) + "</td>" +
      "<td><div class=\"actions-row\">" + actions + "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Status</th><th scope=\"col\">Published</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No posts" + (sf ? " " + _htmlEscape(sf) : " yet") + ". Write your first one.</p>";

  var newBtn = "<div class=\"actions-row\"><a class=\"btn\" href=\"/admin/blog/new\">New post</a></div>";

  var bodyHtml = "<section><h2>Blog</h2>" +
    created + updated + published + archived + notice +
    "<p class=\"meta\">Editorial posts shown on the storefront blog (/blog). A post is created as a draft and stays hidden until you publish it.</p>" +
    newBtn + chips + table + "</section>";
  return _renderAdminShell(opts.shop_name, "Blog", bodyHtml, "blog", opts.nav_available);
}

// New-post form (article: null) or edit form (article set) for a single
// blog post, plus the lifecycle action row when editing an existing post.
// `form_values` re-fills a failed create so the operator doesn't retype.
function renderAdminBlogDetail(opts) {
  opts = opts || {};
  var a = opts.article || null;
  var isNew = !a;
  var fv = opts.form_values || {};
  var updated   = opts.updated   ? "<div class=\"banner banner--ok\">Post saved.</div>" : "";
  var published = opts.published ? "<div class=\"banner banner--ok\">Post published — it's live on the storefront blog.</div>" : "";
  var notice    = opts.notice    ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // Field values: the existing row when editing, else the failed-create
  // form values, else blank.
  function _val(col) {
    if (a && a[col] != null) return a[col];
    if (fv[col] != null) return fv[col];
    return "";
  }
  var tagsVal = a && Array.isArray(a.tags) ? a.tags.join(", ")
              : (typeof fv.tags === "string" ? fv.tags : "");

  var action = isNew ? "/admin/blog" : "/admin/blog/" + encodeURIComponent(a.slug) + "/edit";
  // Slug is the PK — editable only on create (the primitive keys update on
  // it). On edit it shows read-only so the operator sees the storefront URL.
  var slugField = isNew
    ? _setupField("Slug", "slug", _val("slug"), "text", "Lowercase letters, digits, and hyphens — appears in /blog/<slug>.", " maxlength=\"120\" required")
    : "<label class=\"form-field\"><span>Slug</span><input type=\"text\" value=\"" + _htmlEscape(a.slug) + "\" readonly>" +
        "<small>The storefront URL: <code>/blog/" + _htmlEscape(a.slug) + "</code></small></label>";

  var form =
    "<div class=\"panel mw-40\">" +
      "<h3 class=\"subhead\">" + (isNew ? "New post" : "Post details") + "</h3>" +
      "<form method=\"post\" action=\"" + _htmlEscape(action) + "\">" +
        slugField +
        _setupField("Title", "title", _val("title"), "text", "", " maxlength=\"200\" required") +
        _setupField("Author", "author_id", _val("author_id"), "text", "An author id (your editorial team's handle).", " maxlength=\"80\" required") +
        "<label class=\"form-field\"><span>Body (Markdown)</span>" +
          "<textarea name=\"body\" rows=\"16\" maxlength=\"200000\" required>" + _htmlEscape(_val("body")) + "</textarea>" +
          "<small>Headings, lists, links, bold/italic. Raw HTML is escaped — links are https-only.</small></label>" +
        _setupField("Tags (optional)", "tags", tagsVal, "text", "Comma-separated, e.g. guides, buying-tips.", " maxlength=\"1000\"") +
        _setupField("Hero image URL (optional)", "hero_image_url", _val("hero_image_url"), "text", "https:// or a /-rooted path.", " maxlength=\"2048\"") +
        _setupField("Meta description (optional)", "meta_description", _val("meta_description"), "text", "Shown in search results + the post's <head>.", " maxlength=\"320\"") +
        _setupField("Meta keywords (optional)", "meta_keywords", _val("meta_keywords"), "text", "", " maxlength=\"320\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">" + (isNew ? "Create draft" : "Save") + "</button>" +
          "<a class=\"btn btn--ghost\" href=\"/admin/blog\">Back</a></div>" +
      "</form>" +
    "</div>";

  var lifecycle = "";
  if (!isNew) {
    var enc = encodeURIComponent(a.slug);
    var btns = "";
    if (a.status === "draft") {
      btns = "<form method=\"post\" action=\"/admin/blog/" + _htmlEscape(enc) + "/publish\" class=\"form-inline\">" +
        "<button class=\"btn\" type=\"submit\">Publish</button></form>" +
        "<span class=\"meta\">Publishing makes the post live on the storefront blog.</span>";
    } else if (a.status === "published") {
      btns = "<form method=\"post\" action=\"/admin/blog/" + _htmlEscape(enc) + "/unpublish\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Unpublish</button></form>" +
        "<a class=\"btn btn--danger\" href=\"/admin/blog/" + _htmlEscape(enc) + "/archive/confirm-page\">Archive</a>" +
        "<span class=\"meta\">Unpublish pulls it back to a draft; archive removes it from the storefront.</span>";
    } else if (a.status === "archived") {
      btns = "<form method=\"post\" action=\"/admin/blog/" + _htmlEscape(enc) + "/restore\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Restore to draft</button></form>";
    }
    lifecycle = "<div class=\"panel mt-1 mw-40\"><h3 class=\"subhead\">Status</h3>" +
      "<p class=\"meta\">Current state: " + _blogStatusPill(a.status) + "</p>" +
      "<div class=\"actions-row\">" + btns + "</div></div>";
  }

  var head = isNew
    ? "<p class=\"meta\"><a href=\"/admin/blog\">&larr; Blog</a></p>"
    : "<p class=\"meta\"><a href=\"/admin/blog\">&larr; Blog</a> · " +
        _blogStatusPill(a.status) +
        (a.status === "published"
          ? " · <a href=\"/blog/" + _htmlEscape(encodeURIComponent(a.slug)) + "\" target=\"_blank\" rel=\"noreferrer\">View on storefront &rarr;</a>"
          : "") +
      "</p>";

  var title = isNew ? "New post" : (a.title || a.slug);
  var body = "<section><h2>" + _htmlEscape(title) + "</h2>" + updated + published + notice + head + form + "</section>" + lifecycle;
  return _renderAdminShell(opts.shop_name, isNew ? "New post" : "Post " + a.slug, body, "blog", opts.nav_available);
}

// Coerce the create form into storefrontPages.defineDraft's shape: trimmed
// slug, the required title/body, and the optional meta + layout fields (a
// blank optional field is omitted so the primitive's default applies). The
// primitive validates every field — this only shapes the form strings.
function _pageFromForm(body) {
  body = body || {};
  var out = {
    slug:  typeof body.slug === "string" ? body.slug.trim() : body.slug,
    title: body.title,
    body:  body.body,
  };
  var md = typeof body.meta_description === "string" ? body.meta_description.trim() : "";
  if (md) out.meta_description = md;
  var mk = typeof body.meta_keywords === "string" ? body.meta_keywords.trim() : "";
  if (mk) out.meta_keywords = mk;
  var layout = typeof body.layout === "string" ? body.layout.trim() : "";
  if (layout) out.layout = layout;
  return out;
}

// Coerce the edit form into a storefrontPages.update patch. Only the
// columns the form carries are included; an empty optional meta field is
// sent as "" so the operator can clear a previously-set meta line (the
// primitive accepts an empty string for the nullable meta columns). Status
// / slug are NOT here — status moves via the lifecycle routes; the slug is
// the PK and immutable after create.
function _pagePatchFromForm(body) {
  body = body || {};
  var patch = {};
  if (typeof body.title === "string")            patch.title = body.title;
  if (typeof body.body === "string")             patch.body = body.body;
  if (typeof body.meta_description === "string") patch.meta_description = body.meta_description.trim();
  if (typeof body.meta_keywords === "string")    patch.meta_keywords = body.meta_keywords.trim();
  if (typeof body.layout === "string" && body.layout.trim()) patch.layout = body.layout.trim();
  return patch;
}

// One status pill class per lifecycle state, reusing the order-status pill
// palette: published = paid (green), draft = pending (amber), archived =
// cancelled (grey). Mirrors the blog pill so the two content surfaces read
// the same.
function _pageStatusPill(status) {
  var cls = status === "published" ? "paid" : status === "archived" ? "cancelled" : "pending";
  return "<span class=\"status-pill " + cls + "\">" + _htmlEscape(status) + "</span>";
}

// Layout <select> — the closed enum the migration + primitive enforce.
// `current` pre-selects the page's layout (default when absent).
var _PAGE_LAYOUTS = ["default", "wide", "landing", "legal"];
function _pageLayoutSelect(current) {
  var sel = (typeof current === "string" && _PAGE_LAYOUTS.indexOf(current) !== -1) ? current : "default";
  var opts = _PAGE_LAYOUTS.map(function (l) {
    return "<option value=\"" + l + "\"" + (l === sel ? " selected" : "") + ">" + l + "</option>";
  }).join("");
  return "<label class=\"form-field\"><span>Layout</span>" +
    "<select name=\"layout\">" + opts + "</select>" +
    "<small>Picks the storefront wrapper: default, wide, landing, or legal.</small></label>";
}

function renderAdminPages(opts) {
  opts = opts || {};
  var rows = opts.pages || [];
  var created   = opts.created   ? "<div class=\"banner banner--ok\">Page created as a draft.</div>" : "";
  var updated   = opts.updated   ? "<div class=\"banner banner--ok\">Page saved.</div>" : "";
  var published = opts.published ? "<div class=\"banner banner--ok\">Page published — it's live on the storefront.</div>" : "";
  var archived  = opts.archived  ? "<div class=\"banner banner--ok\">Page archived.</div>" : "";
  var notice    = opts.notice    ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var sf = opts.status_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (sf == null ? " chip--on" : "") + "\" href=\"/admin/pages\">All</a>" +
    "<a class=\"chip" + (sf === "published" ? " chip--on" : "") + "\" href=\"/admin/pages?status=published\">Published</a>" +
    "<a class=\"chip" + (sf === "draft" ? " chip--on" : "") + "\" href=\"/admin/pages?status=draft\">Drafts</a>" +
    "<a class=\"chip" + (sf === "archived" ? " chip--on" : "") + "\" href=\"/admin/pages?status=archived\">Archived</a>" +
    "</div>";

  var bodyRows = rows.map(function (p) {
    var enc = encodeURIComponent(p.slug);
    var date = p.published_at != null ? _fmtDate(p.published_at) : "—";
    // Per-row lifecycle actions match the page's current state: a draft
    // can publish; a published page can unpublish or archive; an archived
    // page can restore. Edit is always offered.
    var actions = "<a class=\"btn btn--ghost\" href=\"/admin/pages/" + _htmlEscape(enc) + "\">Edit</a>";
    if (p.status === "draft") {
      actions += "<form method=\"post\" action=\"/admin/pages/" + _htmlEscape(enc) + "/publish\" class=\"form-inline\">" +
        "<button class=\"btn\" type=\"submit\">Publish</button></form>";
    } else if (p.status === "published") {
      actions += "<form method=\"post\" action=\"/admin/pages/" + _htmlEscape(enc) + "/unpublish\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Unpublish</button></form>" +
        "<a class=\"btn btn--danger\" href=\"/admin/pages/" + _htmlEscape(enc) + "/archive/confirm-page\">Archive</a>";
    } else if (p.status === "archived") {
      actions += "<form method=\"post\" action=\"/admin/pages/" + _htmlEscape(enc) + "/restore\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Restore</button></form>";
    }
    return "<tr>" +
      "<td><a href=\"/admin/pages/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(p.title) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(p.slug) + "</code></td>" +
      "<td>" + _pageStatusPill(p.status) + "</td>" +
      "<td>" + _htmlEscape(date) + "</td>" +
      "<td><div class=\"actions-row\">" + actions + "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Status</th><th scope=\"col\">Published</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No pages" + (sf ? " " + _htmlEscape(sf) : " yet") + ". Write your first one.</p>";

  var newBtn = "<div class=\"actions-row\"><a class=\"btn\" href=\"/admin/pages/new\">New page</a></div>";

  var bodyHtml = "<section><h2>Pages</h2>" +
    created + updated + published + archived + notice +
    "<p class=\"meta\">Content pages shown on the storefront at /pages/&lt;slug&gt; (About, Shipping, Returns, and the like). A page is created as a draft and stays hidden until you publish it.</p>" +
    newBtn + chips + table + "</section>";
  return _renderAdminShell(opts.shop_name, "Pages", bodyHtml, "pages", opts.nav_available);
}

// New-page form (page: null) or edit form (page set) for a single content
// page, plus the lifecycle action row when editing an existing page.
// `form_values` re-fills a failed create so the operator doesn't retype.
function renderAdminPageDetail(opts) {
  opts = opts || {};
  var p = opts.page || null;
  var isNew = !p;
  var fv = opts.form_values || {};
  var updated   = opts.updated   ? "<div class=\"banner banner--ok\">Page saved.</div>" : "";
  var published = opts.published ? "<div class=\"banner banner--ok\">Page published — it's live on the storefront.</div>" : "";
  var notice    = opts.notice    ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // Field values: the existing row when editing, else the failed-create
  // form values, else blank.
  function _val(col) {
    if (p && p[col] != null) return p[col];
    if (fv[col] != null) return fv[col];
    return "";
  }

  var action = isNew ? "/admin/pages" : "/admin/pages/" + encodeURIComponent(p.slug) + "/edit";
  // Slug is the PK — editable only on create (the primitive keys update on
  // it). On edit it shows read-only so the operator sees the storefront URL.
  var slugField = isNew
    ? _setupField("Slug", "slug", _val("slug"), "text", "Letters, digits, dots, hyphens, underscores — appears in /pages/<slug>.", " maxlength=\"80\" required")
    : "<label class=\"form-field\"><span>Slug</span><input type=\"text\" value=\"" + _htmlEscape(p.slug) + "\" readonly>" +
        "<small>The storefront URL: <code>/pages/" + _htmlEscape(p.slug) + "</code></small></label>";

  var form =
    "<div class=\"panel mw-40\">" +
      "<h3 class=\"subhead\">" + (isNew ? "New page" : "Page details") + "</h3>" +
      "<form method=\"post\" action=\"" + _htmlEscape(action) + "\">" +
        slugField +
        _setupField("Title", "title", _val("title"), "text", "Shown as the page heading and the <title> tag.", " maxlength=\"200\" required") +
        "<label class=\"form-field\"><span>Body (Markdown)</span>" +
          "<textarea name=\"body\" rows=\"18\" maxlength=\"200000\" required>" + _htmlEscape(_val("body")) + "</textarea>" +
          "<small>Headings, lists, links, bold/italic. Raw HTML is escaped — links are https-only or /-rooted.</small></label>" +
        _pageLayoutSelect(p ? p.layout : (typeof fv.layout === "string" ? fv.layout : "default")) +
        _setupField("Meta description (optional)", "meta_description", _val("meta_description"), "text", "Shown in search results + the page's <head>.", " maxlength=\"320\"") +
        _setupField("Meta keywords (optional)", "meta_keywords", _val("meta_keywords"), "text", "", " maxlength=\"320\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">" + (isNew ? "Create draft" : "Save") + "</button>" +
          "<a class=\"btn btn--ghost\" href=\"/admin/pages\">Back</a></div>" +
      "</form>" +
    "</div>";

  var lifecycle = "";
  if (!isNew) {
    var enc = encodeURIComponent(p.slug);
    var btns = "";
    if (p.status === "draft") {
      btns = "<form method=\"post\" action=\"/admin/pages/" + _htmlEscape(enc) + "/publish\" class=\"form-inline\">" +
        "<button class=\"btn\" type=\"submit\">Publish</button></form>" +
        "<span class=\"meta\">Publishing makes the page live on the storefront.</span>";
    } else if (p.status === "published") {
      btns = "<form method=\"post\" action=\"/admin/pages/" + _htmlEscape(enc) + "/unpublish\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Unpublish</button></form>" +
        "<a class=\"btn btn--danger\" href=\"/admin/pages/" + _htmlEscape(enc) + "/archive/confirm-page\">Archive</a>" +
        "<span class=\"meta\">Unpublish pulls it back to a draft; archive removes it from the storefront.</span>";
    } else if (p.status === "archived") {
      btns = "<form method=\"post\" action=\"/admin/pages/" + _htmlEscape(enc) + "/restore\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Restore to draft</button></form>";
    }
    lifecycle = "<div class=\"panel mt-1 mw-40\"><h3 class=\"subhead\">Status</h3>" +
      "<p class=\"meta\">Current state: " + _pageStatusPill(p.status) + "</p>" +
      "<div class=\"actions-row\">" + btns + "</div></div>";
  }

  var head = isNew
    ? "<p class=\"meta\"><a href=\"/admin/pages\">&larr; Pages</a></p>"
    : "<p class=\"meta\"><a href=\"/admin/pages\">&larr; Pages</a> · " +
        _pageStatusPill(p.status) +
        (p.status === "published"
          ? " · <a href=\"/pages/" + _htmlEscape(encodeURIComponent(p.slug)) + "\" target=\"_blank\" rel=\"noreferrer\">View on storefront &rarr;</a>"
          : "") +
      "</p>";

  var title = isNew ? "New page" : (p.title || p.slug);
  var body = "<section><h2>" + _htmlEscape(title) + "</h2>" + updated + published + notice + head + form + "</section>" + lifecycle;
  return _renderAdminShell(opts.shop_name, isNew ? "New page" : "Page " + p.slug, body, "pages", opts.nav_available);
}

// Standard question set per survey kind, so the console can create the
// common surveys without a dynamic question builder (fully custom question
// lists go through the JSON defineSurvey API). Each question carries a
// stable id so historical responses survive a later edit.
function _standardSurveyQuestions(kind) {
  if (kind === "nps") {
    return [
      { id: "score", kind: "rating", label: "How likely are you to recommend us to a friend?", max: 10, required: true },
      { id: "reason", kind: "free_text", label: "What's the main reason for your score?", required: false },
    ];
  }
  if (kind === "ces") {
    return [
      { id: "effort", kind: "rating", label: "How easy was it to get what you needed?", max: 7, required: true },
      { id: "reason", kind: "free_text", label: "Anything that made it harder than it should have been?", required: false },
    ];
  }
  if (kind === "csat") {
    return [
      { id: "score", kind: "rating", label: "How satisfied were you with your experience?", max: 5, required: true },
      { id: "comment", kind: "free_text", label: "Anything you'd like to add?", required: false },
    ];
  }
  // custom — a single open-ended prompt the operator can refine via the API.
  return [
    { id: "feedback", kind: "free_text", label: "Your feedback", required: true },
  ];
}

function renderAdminSurveys(opts) {
  opts = opts || {};
  var rows = opts.surveys || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Survey created.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Survey archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var af = opts.active_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (af == null ? " chip--on" : "") + "\" href=\"/admin/surveys\">All</a>" +
    "<a class=\"chip" + (af === "1" ? " chip--on" : "") + "\" href=\"/admin/surveys?active=1\">Active</a>" +
    "</div>";

  var bodyRows = rows.map(function (s) {
    var isArchived = s.archived_at != null;
    var enc = _htmlEscape(encodeURIComponent(s.slug));
    return "<tr>" +
      "<td><a href=\"/admin/surveys/" + enc + "\"><strong>" + _htmlEscape(s.title) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(s.slug) + "</code></td>" +
      "<td><span class=\"status-pill\">" + _htmlEscape(s.kind) + "</span></td>" +
      "<td>" + _htmlEscape(s.trigger_event || s.trigger || "manual") + "</td>" +
      "<td><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "active") + "</span></td>" +
      "<td><div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/surveys/" + enc + "\">Open</a>" +
        (isArchived ? "" :
          "<form method=\"post\" action=\"/admin/surveys/" + enc + "/archive\" class=\"form-inline\">" +
            "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Kind</th><th scope=\"col\">Trigger</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No surveys" + (af === "1" ? " active" : " yet") + ".</p>";

  var kindOpts = [["nps", "NPS — recommend score"], ["csat", "CSAT — satisfaction"], ["ces", "CES — ease of effort"], ["custom", "Custom — open feedback"]]
    .map(function (k) { return "<option value=\"" + k[0] + "\">" + _htmlEscape(k[1]) + "</option>"; }).join("");
  var trigOpts = [["manual", "Manual (issue invitations yourself)"], ["after_delivery", "After delivery"], ["after_support_close", "After support close"], ["after_refund", "After refund"]]
    .map(function (t) { return "<option value=\"" + t[0] + "\">" + _htmlEscape(t[1]) + "</option>"; }).join("");

  var createForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Create a survey</h3>" +
      "<p class=\"meta\">The console seeds a standard question set for the chosen kind. After creating, open the survey to issue invitation links + read the rollup.</p>" +
      "<form method=\"post\" action=\"/admin/surveys\">" +
        _setupField("Title", "title", "", "text", "", " maxlength=\"200\" required") +
        _setupField("Slug", "slug", "", "text", "Lowercase, hyphenated — a stable id.", " maxlength=\"64\" required") +
        "<label class=\"form-field\"><span>Kind</span><select name=\"kind\">" + kindOpts + "</select></label>" +
        "<label class=\"form-field\"><span>Trigger</span><select name=\"trigger\">" + trigOpts + "</select></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create survey</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Surveys</h2>" + created + archived + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Surveys", bodyHtml, "surveys", opts.nav_available);
}

function renderAdminSurveyDetail(opts) {
  opts = opts || {};
  var survey = opts.survey;
  if (!survey) {
    var nf = "<section><h2>Survey</h2><p class=\"empty\">Survey not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/surveys\">Back to surveys</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Survey", nf, "surveys", opts.nav_available);
  }
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // Freshly-issued invitation link — shown exactly once (the plaintext
  // token is never persisted). The operator copies it into their own
  // email/SMS to the customer.
  var linkReveal = "";
  if (opts.issued_link) {
    var path = "/survey/" + _htmlEscape(opts.issued_link);
    linkReveal =
      "<div class=\"banner banner--ok\">Invitation issued. Copy this single-use link and send it to the customer — it won't be shown again:" +
        "<br><code class=\"code-block\">" + path + "</code></div>";
  }

  var roll = opts.rollup || { response_count: 0, per_question: [] };
  var headline = "";
  if (roll.nps)       headline = "NPS score: <strong>" + _htmlEscape(String(roll.nps.score)) + "</strong> (" + _htmlEscape(String(roll.nps.promoter_pct)) + "% promoters, " + _htmlEscape(String(roll.nps.detractor_pct)) + "% detractors)";
  else if (roll.csat) headline = "CSAT: <strong>" + _htmlEscape(String(roll.csat.positive_pct)) + "%</strong> positive";
  else if (roll.ces)  headline = "CES mean: <strong>" + _htmlEscape(String(roll.ces.mean)) + "</strong>";

  var qRows = (roll.per_question || []).map(function (pq) {
    var detail;
    if (pq.kind === "rating") detail = "mean " + _htmlEscape(String(pq.mean)) + " over " + _htmlEscape(String(pq.count)) + " answers";
    else if (pq.kind === "select") {
      detail = Object.keys(pq.buckets || {}).map(function (o) { return _htmlEscape(o) + ": " + _htmlEscape(String(pq.buckets[o])); }).join(", ");
    } else detail = _htmlEscape(String(pq.count)) + " written responses";
    return "<tr><td><code class=\"order-id\">" + _htmlEscape(pq.id) + "</code></td><td>" + _htmlEscape(pq.kind) + "</td><td>" + detail + "</td></tr>";
  }).join("");
  var rollupPanel =
    "<div class=\"panel\">" +
      "<p class=\"meta\">" + _htmlEscape(String(roll.response_count)) + " response(s)." + (headline ? " " + headline : "") + "</p>" +
      (qRows ? "<table><thead><tr><th scope=\"col\">Question</th><th scope=\"col\">Kind</th><th scope=\"col\">Result</th></tr></thead><tbody>" + qRows + "</tbody></table>" : "") +
    "</div>";

  var enc = _htmlEscape(encodeURIComponent(survey.slug));
  var issueForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Issue an invitation</h3>" +
      "<p class=\"meta\">Generates a single-use survey link for one customer. You send the link; the customer answers without signing in.</p>" +
      "<form method=\"post\" action=\"/admin/surveys/" + enc + "/issue\">" +
        _setupField("Customer id", "customer_id", "", "text", "The customer's UUID.", " maxlength=\"64\" required") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Issue invitation</button>" +
          "<a class=\"btn btn--ghost\" href=\"/admin/surveys\">Back to surveys</a></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>" + _htmlEscape(survey.title) + "</h2>" + notice + linkReveal + rollupPanel + issueForm + "</section>";
  return _renderAdminShell(opts.shop_name, survey.title, bodyHtml, "surveys", opts.nav_available);
}

// Build a defineSchedule input from the per-weekday open/close form fields
// (d0_open/d0_close .. d6_open/d6_close). A day with both a start and end
// time becomes a weekly_hours entry; a blank day is closed. Sun=0.
function _scheduleFromForm(body) {
  body = body || {};
  var weekly = [];
  for (var d = 0; d < 7; d += 1) {
    var open  = body["d" + d + "_open"];
    var close = body["d" + d + "_close"];
    if (typeof open === "string" && open.trim() && typeof close === "string" && close.trim()) {
      weekly.push({ day: d, open: open.trim(), close: close.trim() });
    }
  }
  return {
    slug:         typeof body.slug === "string" ? body.slug.trim() : body.slug,
    timezone:     body.timezone,
    weekly_hours: weekly,
  };
}

function renderAdminHours(opts) {
  opts = opts || {};
  var rows = opts.schedules || [];
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Schedule saved.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Schedule archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  var bodyRows = rows.map(function (s) {
    var isArchived = s.archived_at != null;
    var enc = _htmlEscape(encodeURIComponent(s.slug));
    var openDays = ((s.weekly_hours || []).reduce(function (set, w) { set[w.day] = 1; return set; }, {}));
    var dayCount = Object.keys(openDays).length;
    return "<tr>" +
      "<td><code class=\"order-id\">" + _htmlEscape(s.slug) + "</code></td>" +
      "<td>" + _htmlEscape(s.timezone) + "</td>" +
      "<td class=\"num\">" + dayCount + " open day(s)</td>" +
      "<td><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "active") + "</span></td>" +
      "<td><div class=\"actions-row\">" +
        (isArchived ? "" :
          "<form method=\"post\" action=\"/admin/hours/" + enc + "/archive\" class=\"form-inline\">" +
            "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Schedule</th><th scope=\"col\">Timezone</th><th scope=\"col\" class=\"num\">Days</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No schedules yet.</p>";

  var dayFields = DOW.map(function (label, d) {
    return "<div class=\"actions-row\">" +
      "<span class=\"u-mute\">" + label + "</span>" +
      "<input type=\"time\" name=\"d" + d + "_open\" aria-label=\"" + label + " open\">" +
      "<input type=\"time\" name=\"d" + d + "_close\" aria-label=\"" + label + " close\">" +
    "</div>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-42\">" +
      "<h3 class=\"subhead\">Create a schedule</h3>" +
      "<p class=\"meta\">Set an open + close time per weekday (leave a day blank to mark it closed). Times are in the schedule's timezone. Holidays + one-off exceptions are managed via the API.</p>" +
      "<form method=\"post\" action=\"/admin/hours\">" +
        _setupField("Slug", "slug", "", "text", "Lowercase, hyphenated — e.g. support or store.", " maxlength=\"64\" required") +
        _setupField("Timezone", "timezone", "", "text", "IANA name, e.g. America/New_York.", " maxlength=\"64\" required") +
        "<fieldset class=\"box\"><legend class=\"legend-sm\">Weekly hours (open / close)</legend>" + dayFields + "</fieldset>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create schedule</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Business hours</h2>" + created + archived + notice + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Hours", bodyHtml, "hours", opts.nav_available);
}

function renderAdminCollection(opts) {
  opts = opts || {};
  var col = opts.collection;
  if (!col) {
    var nf = "<section><h2>Collection</h2><p class=\"empty\">Collection not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/collections\">Back to collections</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Collection", nf, "collections", opts.nav_available);
  }
  var updated = (opts.updated || opts.saved) ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var notice  = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var enc = encodeURIComponent(col.slug);

  var sortStrategies = opts.sort_strategies || collectionsModule.SORT_STRATEGIES;
  var sortOpts = sortStrategies.filter(function (s) {
    // `manual` sort only applies to manual collections (the primitive
    // refuses it on smart) — drop it from the smart editor's options.
    return !(col.type === "smart" && s === "manual");
  }).map(function (s) {
    return "<option value=\"" + _htmlEscape(s) + "\"" + (s === col.sort_strategy ? " selected" : "") + ">" + _htmlEscape(s) + "</option>";
  }).join("");

  var editForm =
    "<div class=\"panel mw-40\">" +
      "<h3 class=\"subhead\">Details</h3>" +
      "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/edit\">" +
        _setupField("Title", "title", col.title, "text", "", " maxlength=\"500\" required") +
        _setupField("Description", "description", col.description || "", "text", "", " maxlength=\"2000\"") +
        "<label class=\"form-field\"><span>Sort strategy</span><select name=\"sort_strategy\">" + sortOpts + "</select></label>";

  if (col.type === "smart") {
    var fields = opts.rule_fields || collectionsModule.RULE_FIELDS;
    var ops    = opts.rule_ops    || collectionsModule.RULE_OPS;
    var existing = (col.rules && Array.isArray(col.rules.all)) ? col.rules.all : [];
    // Render the existing rules plus one spare empty row so the operator
    // can append without a separate "add row" round-trip.
    var ruleRows = existing.concat([{ field: "", op: "", value: "" }]).map(function (rule) {
      var rv = rule.value;
      if (Array.isArray(rv)) rv = rv.join(",");
      else if (rv == null)   rv = "";
      var fieldOpts = "<option value=\"\">field…</option>" + fields.map(function (f) {
        return "<option value=\"" + _htmlEscape(f) + "\"" + (f === rule.field ? " selected" : "") + ">" + _htmlEscape(f) + "</option>";
      }).join("");
      var opOpts = "<option value=\"\">op…</option>" + ops.map(function (o) {
        return "<option value=\"" + _htmlEscape(o) + "\"" + (o === rule.op ? " selected" : "") + ">" + _htmlEscape(o) + "</option>";
      }).join("");
      return "<div class=\"actions-row m-04\">" +
        "<select name=\"rule_field\">" + fieldOpts + "</select>" +
        "<select name=\"rule_op\">" + opOpts + "</select>" +
        "<input type=\"text\" name=\"rule_value\" value=\"" + _htmlEscape(String(rv)) + "\" placeholder=\"value\" maxlength=\"500\">" +
      "</div>";
    }).join("");
    editForm +=
      "<fieldset class=\"box\">" +
        "<legend class=\"legend-sm\">Rules (all must match)</legend>" +
        ruleRows +
        "<small class=\"u-mute\">Leave a row blank to drop it. Lists (in / not_in) + between use comma-separated values.</small>" +
      "</fieldset>";
  }
  editForm += "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save</button></div></form></div>";

  var detailBody;
  if (col.type === "manual") {
    var members = opts.members || [];
    var memberRows = members.map(function (m) {
      return "<tr>" +
        "<td class=\"num\">" + _htmlEscape(String(m.position)) + "</td>" +
        "<td><code class=\"order-id\">" + _htmlEscape(m.product_id) + "</code></td>" +
        "<td><form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/members/remove\" class=\"form-inline\">" +
          "<input type=\"hidden\" name=\"product_id\" value=\"" + _htmlEscape(m.product_id) + "\">" +
          "<button class=\"btn btn--danger\" type=\"submit\">Remove</button></form></td>" +
      "</tr>";
    }).join("");
    var memberTable = members.length
      ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\" class=\"num\">#</th><th scope=\"col\">Product id</th><th scope=\"col\"></th></tr></thead><tbody>" + memberRows + "</tbody></table></div>"
      : "<p class=\"empty\">No members yet — add a product below.</p>";

    // Reorder: a single field of the current ids, comma-joined, that the
    // operator can rewrite into the new order. v1-defensible without
    // client JS — the primitive normalises positions to 0..N-1.
    var currentIds = members.map(function (m) { return m.product_id; }).join(",");
    var reorderForm = members.length > 1
      ? "<div class=\"panel mt-1 mw-40\">" +
          "<h3 class=\"subhead\">Reorder members</h3>" +
          "<p class=\"meta\">Rewrite the comma-separated id list into the order you want. Must list every current member.</p>" +
          "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/members/reorder\">" +
            "<label class=\"form-field\"><span>Ordered product ids</span>" +
              "<input type=\"text\" name=\"ordered_product_ids\" value=\"" + _htmlEscape(currentIds) + "\"></label>" +
            "<div class=\"actions-row\"><button class=\"btn btn--ghost\" type=\"submit\">Apply order</button></div>" +
          "</form>" +
        "</div>"
      : "";

    var addForm =
      "<div class=\"panel mt-1 mw-40\">" +
        "<h3 class=\"subhead\">Add a member</h3>" +
        "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/members/add\">" +
          _setupField("Product id", "product_id", "", "text", "The catalog product's UUID.", " maxlength=\"64\" required") +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add product</button></div>" +
        "</form>" +
      "</div>";

    detailBody = "<section class=\"mt\"><h3 class=\"fs-105\">Members</h3>" +
      memberTable + reorderForm + addForm + "</section>";
  } else {
    var preview = opts.preview || [];
    var previewCards = preview.map(function (p) {
      return "<tr>" +
        "<td><strong>" + _htmlEscape(p.title || "(untitled)") + "</strong></td>" +
        "<td><code class=\"order-id\">" + _htmlEscape(p.slug || p.id || "") + "</code></td>" +
        "<td>" + _htmlEscape(p.status || "") + "</td>" +
      "</tr>";
    }).join("");
    var previewTable = preview.length
      ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Title</th><th scope=\"col\">Slug</th><th scope=\"col\">Status</th></tr></thead><tbody>" + previewCards + "</tbody></table></div>"
      : "<p class=\"empty\">No products match these rules yet.</p>";
    detailBody = "<section class=\"mt\"><h3 class=\"fs-105\">Matched products (live preview)</h3>" +
      "<p class=\"meta\">The first " + _htmlEscape(String(preview.length)) + " products the rules match right now.</p>" +
      previewTable + "</section>";
  }

  var head =
    "<p class=\"meta\"><a href=\"/admin/collections\">&larr; Collections</a> · " +
      "<code class=\"order-id\">" + _htmlEscape(col.slug) + "</code> · " +
      "<span class=\"status-pill " + (col.type === "smart" ? "pending" : "paid") + "\">" + _htmlEscape(col.type) + "</span>" +
      (col.archived_at != null ? " · <span class=\"status-pill cancelled\">archived</span>" : "") +
      " · <a href=\"/collections/" + _htmlEscape(enc) + "\" target=\"_blank\" rel=\"noreferrer\">View on storefront &rarr;</a></p>";

  var body = "<section><h2>" + _htmlEscape(col.title) + "</h2>" + updated + notice + head + editForm + "</section>" + detailBody;
  return _renderAdminShell(opts.shop_name, "Collection " + col.slug, body, "collections", opts.nav_available);
}

// One labelled <option> list for the discount_kind dropdown, with the
// kind whose value is a fixed money amount annotated so the operator
// knows whether `value` is basis points or minor units.
function _qdKindLabel(kind) {
  if (kind === "percent_off")      return "percent_off (value = basis points; 1000 = 10%)";
  if (kind === "amount_off_each")  return "amount_off_each (value = minor units off each unit)";
  if (kind === "amount_off_total") return "amount_off_total (value = minor units off the line)";
  if (kind === "fixed_each_price") return "fixed_each_price (value = new unit price in minor units)";
  return kind;
}

function _qdKindOptions(kinds, selected) {
  return (kinds || []).map(function (k) {
    return "<option value=\"" + _htmlEscape(k) + "\"" + (k === selected ? " selected" : "") + ">" +
      _htmlEscape(_qdKindLabel(k)) + "</option>";
  }).join("");
}

// A single editable tier row — min_quantity + discount_kind + value.
// `tier` may be a stored row (edit) or {} for a spare append row.
function _qdTierRow(kinds, tier) {
  tier = tier || {};
  var minVal = tier.min_quantity == null ? "" : String(tier.min_quantity);
  var valVal = tier.value == null ? "" : String(tier.value);
  return "<div class=\"actions-row m-04\">" +
    "<input type=\"number\" name=\"tier_min\" value=\"" + _htmlEscape(minVal) + "\" placeholder=\"min qty\" min=\"1\" step=\"1\" class=\"input-code\">" +
    "<select name=\"tier_kind\"><option value=\"\">kind…</option>" + _qdKindOptions(kinds, tier.discount_kind) + "</select>" +
    "<input type=\"number\" name=\"tier_value\" value=\"" + _htmlEscape(valVal) + "\" placeholder=\"value\" min=\"0\" step=\"1\" class=\"input-code\">" +
  "</div>";
}

// Quantity-discount tier-set list — a table of tier sets (scope,
// scope_id, #tiers, exclusive, status) plus a create form. The create
// form's scope dropdown + each tier row's kind dropdown use the engine's
// exact enums so a console-built set always validates. Mirrors
// renderAdminCollections.
function renderAdminQuantityDiscounts(opts) {
  opts = opts || {};
  var rows   = opts.tier_sets || [];
  var scopes = opts.scopes || quantityDiscountsModule.VALID_SCOPES;
  var kinds  = opts.kinds  || quantityDiscountsModule.VALID_KINDS;
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Tier set created.</div>" : "";
  var saved    = opts.saved    ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Tier set archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var af = opts.archived_filter;
  var chips = "<div class=\"order-filters\">" +
    "<a class=\"chip" + (af == null ? " chip--on" : "") + "\" href=\"/admin/quantity-discounts\">All</a>" +
    "<a class=\"chip" + (af === "0" ? " chip--on" : "") + "\" href=\"/admin/quantity-discounts?archived=0\">Active</a>" +
    "<a class=\"chip" + (af === "1" ? " chip--on" : "") + "\" href=\"/admin/quantity-discounts?archived=1\">Archived</a>" +
    "</div>";

  var bodyRows = rows.map(function (s) {
    var isArchived = s.archived_at != null;
    var enc = encodeURIComponent(s.id);
    return "<tr>" +
      "<td><a href=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(s.scope) + "</strong></a></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(s.scope_id == null ? "—" : s.scope_id) + "</code></td>" +
      "<td class=\"num\">" + _htmlEscape(String((s.tiers || []).length)) + "</td>" +
      "<td><span class=\"status-pill " + (s.exclusive ? "pending" : "paid") + "\">" + (s.exclusive ? "exclusive" : "stacks") + "</span></td>" +
      "<td><span class=\"status-pill " + (isArchived ? "cancelled" : "paid") + "\">" + (isArchived ? "archived" : "active") + "</span></td>" +
      "<td><div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "\">Manage</a>" +
        (isArchived
          ? "<form method=\"post\" action=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "/unarchive\" class=\"form-inline\">" +
              "<button class=\"btn btn--ghost\" type=\"submit\">Restore</button></form>"
          : "<form method=\"post\" action=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "/archive\" class=\"form-inline\">" +
              "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Scope</th><th scope=\"col\">Scope id</th><th scope=\"col\" class=\"num\">Tiers</th><th scope=\"col\">Stacking</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No quantity breaks" + (af === "1" ? " archived" : af === "0" ? " active" : " yet") + ".</p>";

  var scopeOpts = scopes.map(function (sc) {
    return "<option value=\"" + _htmlEscape(sc) + "\"" + (sc === "sku" ? " selected" : "") + ">" + _htmlEscape(sc) + "</option>";
  }).join("");

  // Three starter tier rows on create — enough for a typical "5 / 10 /
  // 20" schedule without a separate add-row round-trip. Blank rows are
  // dropped server-side; the operator fills as many as they need.
  var starterRows = _qdTierRow(kinds, {}) + _qdTierRow(kinds, {}) + _qdTierRow(kinds, {});

  var createForm =
    "<div class=\"panel mt mw-40\">" +
      "<h3 class=\"subhead\">Create a tier set</h3>" +
      "<p class=\"meta\">A quantity break attaches to a scope (one SKU, product, collection, vendor, category, or everything) and a schedule of (min quantity, kind, value) rules. The pricing engine applies the best matching rule per cart line automatically.</p>" +
      "<form method=\"post\" action=\"/admin/quantity-discounts\">" +
        "<label class=\"form-field\"><span>Scope</span><select name=\"scope\">" + scopeOpts + "</select></label>" +
        _setupField("Scope id", "scope_id", "", "text", "The SKU / product id / collection slug / vendor / category. Leave blank only when scope = global.", " maxlength=\"256\"") +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"exclusive\" value=\"on\"> Exclusive — when this set's best rule applies, no other tier set may stack on the same line.</label>" +
        "<fieldset class=\"box\">" +
          "<legend class=\"legend-sm\">Tiers (min quantity → discount)</legend>" +
          starterRows +
          "<small class=\"u-mute\">Leave a row blank to drop it. min quantity is a positive integer; value's meaning depends on the kind (percent_off = basis points, the amount/fixed kinds = minor units). Duplicate min quantities in one set are refused.</small>" +
        "</fieldset>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create tier set</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Quantity breaks</h2>" + created + saved + archived + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Quantity breaks", bodyHtml, "quantity-discounts", opts.nav_available);
}

// Quantity-discount tier-set detail — the set's scope + schedule, a
// rewrite form (rewrite the tier rows / toggle exclusive), archive or
// unarchive, and a sample-price tierBreakdown preview. Mirrors
// renderAdminCollection.
function renderAdminQuantityDiscount(opts) {
  opts = opts || {};
  var s = opts.tier_set;
  if (!s) {
    var nf = "<section><h2>Quantity break</h2><p class=\"empty\">Tier set not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/quantity-discounts\">Back to quantity breaks</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Quantity break", nf, "quantity-discounts", opts.nav_available);
  }
  var kinds = opts.kinds || quantityDiscountsModule.VALID_KINDS;
  var saved  = opts.saved  ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var enc = encodeURIComponent(s.id);
  var isArchived = s.archived_at != null;

  // Render the stored tiers plus one spare empty row so the operator can
  // append without a separate round-trip. The edit POST rewrites the
  // whole schedule (the engine's update replaces tiers wholesale).
  var tierRows = (s.tiers || []).map(function (t) { return _qdTierRow(kinds, t); }).join("") + _qdTierRow(kinds, {});

  var editForm =
    "<div class=\"panel mw-40\">" +
      "<h3 class=\"subhead\">Schedule</h3>" +
      "<form method=\"post\" action=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "/edit\">" +
        "<input type=\"hidden\" name=\"exclusive_present\" value=\"1\">" +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"exclusive\" value=\"on\"" + (s.exclusive ? " checked" : "") + "> Exclusive — no other tier set may stack on the same line.</label>" +
        "<fieldset class=\"box\">" +
          "<legend class=\"legend-sm\">Tiers (rewrites the whole schedule)</legend>" +
          tierRows +
          "<small class=\"u-mute\">Leave a row blank to drop it. Rewriting replaces every rule in this set. Duplicate min quantities are refused.</small>" +
        "</fieldset>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save schedule</button></div>" +
      "</form>" +
    "</div>";

  // tierBreakdown preview — the active schedule at a sample unit price so
  // the operator can sanity-check the discounted unit / line at each
  // threshold. The sample defaults to 1000 minor (e.g. $10.00); the
  // operator can re-sample via the query string.
  var sampleMinor = opts.sample_minor == null ? 1000 : opts.sample_minor;
  var breakdown = opts.breakdown;
  var previewRows = (breakdown && Array.isArray(breakdown.rows) ? breakdown.rows : []).map(function (r) {
    var du = r.sample_discounted_unit_minor;
    var ld = r.sample_line_discount_minor;
    var ls = r.sample_line_subtotal_minor;
    return "<tr>" +
      "<td class=\"num\">" + _htmlEscape(String(r.min_quantity)) + "</td>" +
      "<td>" + _htmlEscape(r.discount_kind) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(r.value)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(du == null ? "—" : String(du)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(ld == null ? "—" : String(ld)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(ls == null ? "—" : String(ls)) + "</td>" +
    "</tr>";
  }).join("");
  var previewTable = previewRows
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\" class=\"num\">Min qty</th><th scope=\"col\">Kind</th><th scope=\"col\" class=\"num\">Value</th><th scope=\"col\" class=\"num\">Unit @ min</th><th scope=\"col\" class=\"num\">Line saved</th><th scope=\"col\" class=\"num\">Line total</th></tr></thead><tbody>" + previewRows + "</tbody></table></div>"
    : "<p class=\"empty\">No active rules to preview for this scope.</p>";
  var previewForm =
    "<form method=\"get\" action=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "\" class=\"actions-row m-04\">" +
      "<label class=\"form-field\"><span>Sample unit price (minor units)</span>" +
        "<input type=\"number\" name=\"sample\" value=\"" + _htmlEscape(String(sampleMinor)) + "\" min=\"0\" step=\"1\" class=\"input-code\"></label>" +
      "<button class=\"btn btn--ghost\" type=\"submit\">Preview</button>" +
    "</form>";
  // An archived set is not active, so tierBreakdown (which filters to
  // active rules at this scope) would preview OTHER sets' rules — or
  // nothing. Show a clear restore prompt instead of a foreign/empty table.
  var previewSection = isArchived
    ? "<section class=\"mt\"><h3 class=\"fs-105\">Schedule preview</h3>" +
        "<p class=\"empty\">This tier set is archived, so its schedule isn't active. Restore the set to preview it.</p>" +
      "</section>"
    : "<section class=\"mt\"><h3 class=\"fs-105\">Schedule preview</h3>" +
        "<p class=\"meta\">The active rules for this scope at a sample unit price (all values in minor units). Helps sanity-check a schedule before it goes live.</p>" +
        previewForm + previewTable +
      "</section>";

  var archiveBlock = isArchived
    ? "<form method=\"post\" action=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "/unarchive\" class=\"form-inline\">" +
        "<button class=\"btn btn--ghost\" type=\"submit\">Restore tier set</button></form>"
    : "<form method=\"post\" action=\"/admin/quantity-discounts/" + _htmlEscape(enc) + "/archive\" class=\"form-inline\">" +
        "<button class=\"btn btn--danger\" type=\"submit\">Archive tier set</button></form>";

  var head =
    "<p class=\"meta\"><a href=\"/admin/quantity-discounts\">&larr; Quantity breaks</a> · " +
      "<span class=\"status-pill " + (s.exclusive ? "pending" : "paid") + "\">" + (s.exclusive ? "exclusive" : "stacks") + "</span>" +
      (isArchived ? " · <span class=\"status-pill cancelled\">archived</span>" : "") +
      " · <code class=\"order-id\">" + _htmlEscape(s.scope_id == null ? "global" : s.scope_id) + "</code></p>";

  var body = "<section><h2>" + _htmlEscape(s.scope) +
    (s.scope_id == null ? "" : " · " + _htmlEscape(s.scope_id)) + "</h2>" +
    saved + notice + head + editForm +
    "<div class=\"actions-row mt-1\">" + archiveBlock + "</div></section>" + previewSection;
  return _renderAdminShell(opts.shop_name, "Quantity break", body, "quantity-discounts", opts.nav_available);
}

// ---- loyalty render functions ------------------------------------------

// Status pill for an active / inactive / archived loyalty row — shared by
// the earn-rule + reward lists.
function _loyaltyStatusPill(active, archivedAt) {
  if (archivedAt != null) return "<span class=\"status-pill cancelled\">archived</span>";
  return active
    ? "<span class=\"status-pill paid\">active</span>"
    : "<span class=\"status-pill pending\">inactive</span>";
}

// Render a reward's value_json as a short human label per kind.
function _loyaltyRewardValueLabel(reward) {
  var v = reward.value_json || {};
  if (reward.kind === "discount_percent") return _htmlEscape(String(v.percent)) + "% off";
  if (reward.kind === "discount_amount")  return _htmlEscape(String(v.amount_minor)) + " minor off";
  if (reward.kind === "free_product")     return "free product " + _htmlEscape(String(v.product_id || ""));
  if (reward.kind === "free_shipping")    return "free shipping";
  return _htmlEscape(reward.kind);
}

// Loyalty overview / settings — the program's tiers + conversion ratios,
// a summary of earn rules + rewards (with links to manage each), and the
// per-customer points-adjustment form (grant / deduct with a required
// reason, recorded in the loyalty ledger). The customer's /account/loyalty
// page shows only ACTIVE earn rules + ACTIVE rewards, so the summary flags
// inactive rows.
function renderAdminLoyalty(opts) {
  opts = opts || {};
  var adjusted = opts.adjusted ? "<div class=\"banner banner--ok\">Points adjusted. The ledger recorded the change.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var adjustNotice = opts.adjust_notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.adjust_notice) + "</div>" : "";

  var thresholds = opts.tier_thresholds || {};
  var tiers = opts.tiers || [];
  var tierRows = tiers.map(function (t) {
    return "<tr><td><strong>" + _htmlEscape(t) + "</strong></td>" +
      "<td class=\"num\">" + _htmlEscape(String(thresholds[t] == null ? "—" : thresholds[t])) + "</td></tr>";
  }).join("");
  var tierTable =
    "<div class=\"panel\"><h3 class=\"subhead\">Tiers</h3>" +
      "<p class=\"meta\">Lifetime points (never decremented) place a customer in a tier. " +
        "Earning $1 grants " + _htmlEscape(String(opts.points_per_usd)) + " points; " +
        _htmlEscape(String(opts.redemption_points_per_usd)) + " points redeem for $1 of value.</p>" +
      "<table><thead><tr><th scope=\"col\">Tier</th><th scope=\"col\" class=\"num\">Lifetime points to reach</th></tr></thead>" +
      "<tbody>" + tierRows + "</tbody></table></div>";

  // Earn-rule summary.
  var earnSummary;
  if (!opts.can_manage_rules) {
    earnSummary = "<div class=\"panel\"><h3 class=\"subhead\">Earn rules</h3>" +
      "<p class=\"empty\">Earn-rule management isn't wired in this deployment.</p></div>";
  } else {
    var earnRules = opts.earn_rules || [];
    var earnRows = earnRules.map(function (r) {
      var enc = encodeURIComponent(r.slug);
      return "<tr>" +
        "<td><a href=\"/admin/loyalty/earn-rules/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(r.slug) + "</strong></a></td>" +
        "<td>" + _htmlEscape(r.trigger) + "</td>" +
        "<td class=\"num\">" + _htmlEscape(String(r.points_per_unit)) + "</td>" +
        "<td>" + _loyaltyStatusPill(r.active, r.archived_at) + "</td>" +
      "</tr>";
    }).join("");
    earnSummary = "<div class=\"panel\"><div class=\"actions-row\"><h3 class=\"subhead\">Earn rules</h3>" +
      "<a class=\"btn btn--ghost\" href=\"/admin/loyalty/earn-rules\">Manage earn rules</a></div>" +
      (earnRules.length
        ? "<table><thead><tr><th scope=\"col\">Slug</th><th scope=\"col\">Trigger</th><th scope=\"col\" class=\"num\">Points/unit</th><th scope=\"col\">Status</th></tr></thead><tbody>" + earnRows + "</tbody></table>"
        : "<p class=\"empty\">No earn rules yet. Customers only earn points from active rules.</p>") +
      "</div>";
  }

  // Reward summary.
  var rewardSummary;
  if (!opts.can_manage_rewards) {
    rewardSummary = "<div class=\"panel\"><h3 class=\"subhead\">Rewards catalog</h3>" +
      "<p class=\"empty\">Rewards-catalog management isn't wired in this deployment.</p></div>";
  } else {
    var rewards = opts.rewards || [];
    var rewardRows = rewards.map(function (rw) {
      var enc = encodeURIComponent(rw.slug);
      return "<tr>" +
        "<td><a href=\"/admin/loyalty/rewards/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(rw.slug) + "</strong></a></td>" +
        "<td>" + _htmlEscape(rw.title) + "</td>" +
        "<td class=\"num\">" + _htmlEscape(String(rw.point_cost)) + "</td>" +
        "<td>" + _loyaltyStatusPill(rw.active, rw.archived_at) + "</td>" +
      "</tr>";
    }).join("");
    rewardSummary = "<div class=\"panel\"><div class=\"actions-row\"><h3 class=\"subhead\">Rewards catalog</h3>" +
      "<a class=\"btn btn--ghost\" href=\"/admin/loyalty/rewards\">Manage rewards</a></div>" +
      (rewards.length
        ? "<table><thead><tr><th scope=\"col\">Slug</th><th scope=\"col\">Title</th><th scope=\"col\" class=\"num\">Point cost</th><th scope=\"col\">Status</th></tr></thead><tbody>" + rewardRows + "</tbody></table>"
        : "<p class=\"empty\">No rewards yet. Customers only see active rewards in their catalog.</p>") +
      "</div>";
  }

  // Points-adjustment form. The customer id is pasted (the customers
  // roster shows each customer's id); the amount is a positive integer; a
  // grant / deduct radio sets the sign; the reason is required and lands
  // in the ledger row.
  var prefillCid = opts.adjust_customer_id ? _htmlEscape(opts.adjust_customer_id) : "";
  var adjustForm =
    "<div class=\"panel mw-40\"><h3 class=\"subhead\">Adjust a customer's points</h3>" +
      "<p class=\"meta\">Grant or deduct points for one customer. Every adjustment is recorded in the loyalty ledger with the reason you give. A grant also counts toward the customer's lifetime tier.</p>" +
      adjustNotice +
      "<form method=\"post\" action=\"/admin/loyalty/adjust\">" +
        "<label class=\"form-field\"><span>Customer id</span>" +
          "<input type=\"text\" name=\"customer_id\" value=\"" + prefillCid + "\" required maxlength=\"64\" class=\"input-code\" placeholder=\"customer UUID\">" +
          "<small>From the Customers roster — each row's id column.</small></label>" +
        "<fieldset class=\"box\"><legend class=\"legend-sm\">Direction</legend>" +
          "<label class=\"kv\"><input type=\"radio\" name=\"direction\" value=\"grant\" checked> Grant (add points)</label>" +
          "<label class=\"kv\"><input type=\"radio\" name=\"direction\" value=\"deduct\"> Deduct (remove points)</label>" +
        "</fieldset>" +
        "<label class=\"form-field\"><span>Amount (points)</span>" +
          "<input type=\"number\" name=\"amount\" min=\"1\" step=\"1\" required class=\"input-code\"></label>" +
        "<label class=\"form-field\"><span>Reason</span>" +
          "<input type=\"text\" name=\"reason\" required maxlength=\"256\" placeholder=\"e.g. service recovery for order #1234\">" +
          "<small>Required. Recorded with the adjustment in the ledger.</small></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Apply adjustment</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Loyalty</h2>" + adjusted + notice +
    tierTable + earnSummary + rewardSummary + adjustForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Loyalty", bodyHtml, "loyalty", opts.nav_available);
}

// Earn-rules list + create form. Customers earn points only from ACTIVE
// rules, so the create form defaults `active` on and the list flags
// inactive / archived rows.
function renderAdminLoyaltyEarnRules(opts) {
  opts = opts || {};
  var rules = opts.rules || [];
  var triggers = opts.triggers || loyaltyEarnRulesModule.TRIGGERS;
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Earn rule saved.</div>" : "";
  var saved    = opts.saved    ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Earn rule archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var bodyRows = rules.map(function (r) {
    var enc = encodeURIComponent(r.slug);
    var statusList = (r.customer_status_in && r.customer_status_in.length) ? r.customer_status_in.join(", ") : "all";
    return "<tr>" +
      "<td><a href=\"/admin/loyalty/earn-rules/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(r.slug) + "</strong></a></td>" +
      "<td>" + _htmlEscape(r.trigger) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(r.points_per_unit)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(r.max_per_event == null ? "—" : String(r.max_per_event)) + "</td>" +
      "<td>" + _htmlEscape(statusList) + "</td>" +
      "<td>" + _loyaltyStatusPill(r.active, r.archived_at) + "</td>" +
      "<td><div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/loyalty/earn-rules/" + _htmlEscape(enc) + "\">Manage</a>" +
        (r.archived_at == null
          ? "<form method=\"post\" action=\"/admin/loyalty/earn-rules/" + _htmlEscape(enc) + "/archive\" class=\"form-inline\">" +
              "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>"
          : "") +
      "</div></td>" +
    "</tr>";
  }).join("");
  var table = rules.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Slug</th><th scope=\"col\">Trigger</th><th scope=\"col\" class=\"num\">Points/unit</th><th scope=\"col\" class=\"num\">Max/event</th><th scope=\"col\">Statuses</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No earn rules yet.</p>";

  var triggerOpts = triggers.map(function (t) {
    return "<option value=\"" + _htmlEscape(t) + "\">" + _htmlEscape(t) + "</option>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-40\"><h3 class=\"subhead\">Create an earn rule</h3>" +
      "<p class=\"meta\">An earn rule grants points when a trigger fires. points/unit is the multiplier for per_dollar_spent / per_purchase and the flat amount for the bonus triggers. Customers earn only from active rules.</p>" +
      "<form method=\"post\" action=\"/admin/loyalty/earn-rules\">" +
        _setupField("Slug", "slug", "", "text", "Lowercase letters, digits, dashes (e.g. spend-1pt-per-dollar).", " maxlength=\"100\" required") +
        "<label class=\"form-field\"><span>Trigger</span><select name=\"trigger\">" + triggerOpts + "</select></label>" +
        _setupField("Points per unit", "points_per_unit", "", "number", "Positive integer.", " min=\"1\" step=\"1\" required class=\"input-code\"") +
        _setupField("Max per event", "max_per_event", "", "number", "Optional cap so a huge order doesn't mint a giant balance. Leave blank for uncapped.", " min=\"1\" step=\"1\" class=\"input-code\"") +
        _setupField("Customer statuses", "customer_status_in", "", "text", "Optional comma-separated list (e.g. active, vip). Blank means every customer is eligible.", " maxlength=\"256\"") +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"active\" value=\"on\" checked> Active — show this rule to customers and award on its trigger.</label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create earn rule</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Earn rules</h2>" +
    "<p class=\"meta\"><a href=\"/admin/loyalty\">&larr; Loyalty</a></p>" +
    created + saved + archived + notice + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Earn rules", bodyHtml, "loyalty", opts.nav_available);
}

// Earn-rule detail — the rule's stored fields and an edit form. trigger
// is immutable on update (the primitive refuses a change), so the form
// shows it read-only.
function renderAdminLoyaltyEarnRule(opts) {
  opts = opts || {};
  var r = opts.rule;
  if (!r) {
    var nf = "<section><h2>Earn rule</h2><p class=\"empty\">Earn rule not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/loyalty/earn-rules\">Back to earn rules</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Earn rule", nf, "loyalty", opts.nav_available);
  }
  var saved  = opts.saved  ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var enc = encodeURIComponent(r.slug);
  var statusList = (r.customer_status_in && r.customer_status_in.length) ? r.customer_status_in.join(", ") : "";
  var isArchived = r.archived_at != null;

  var editForm = isArchived
    ? "<div class=\"panel mw-40\"><p class=\"empty\">This rule is archived and can no longer be edited. Archived rules don't award points or show to customers.</p></div>"
    : "<div class=\"panel mw-40\"><h3 class=\"subhead\">Edit</h3>" +
        "<form method=\"post\" action=\"/admin/loyalty/earn-rules/" + _htmlEscape(enc) + "/edit\">" +
          _setupField("Points per unit", "points_per_unit", String(r.points_per_unit), "number", "Positive integer.", " min=\"1\" step=\"1\" class=\"input-code\"") +
          _setupField("Max per event", "max_per_event", r.max_per_event == null ? "" : String(r.max_per_event), "number", "Blank or 0 clears the cap.", " min=\"0\" step=\"1\" class=\"input-code\"") +
          _setupField("Customer statuses", "customer_status_in", statusList, "text", "Comma-separated; blank means all customers.", " maxlength=\"256\"") +
          "<input type=\"hidden\" name=\"active_present\" value=\"1\">" +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"active\" value=\"on\"" + (r.active ? " checked" : "") + "> Active</label>" +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save rule</button></div>" +
        "</form>" +
      "</div>";

  var archiveBlock = isArchived ? "" :
    "<div class=\"actions-row mt-1\">" +
      "<form method=\"post\" action=\"/admin/loyalty/earn-rules/" + _htmlEscape(enc) + "/archive\" class=\"form-inline\">" +
        "<button class=\"btn btn--danger\" type=\"submit\">Archive rule</button></form>" +
    "</div>";

  var head =
    "<p class=\"meta\"><a href=\"/admin/loyalty/earn-rules\">&larr; Earn rules</a> · " +
      "<span class=\"status-pill paid\">" + _htmlEscape(r.trigger) + "</span> · " +
      _loyaltyStatusPill(r.active, r.archived_at) + "</p>";

  var body = "<section><h2>" + _htmlEscape(r.slug) + "</h2>" + saved + notice + head + editForm + archiveBlock + "</section>";
  return _renderAdminShell(opts.shop_name, "Earn rule", body, "loyalty", opts.nav_available);
}

// Rewards-catalog list + create form. A reward must be active (and not
// archived) to appear in the customer's redemption catalog, so the create
// form defaults active on and the list flags inactive / archived rows.
function renderAdminLoyaltyRewards(opts) {
  opts = opts || {};
  var rewards = opts.rewards || [];
  var kinds = opts.kinds || loyaltyRedemptionModule.KINDS;
  var created  = opts.created  ? "<div class=\"banner banner--ok\">Reward saved.</div>" : "";
  var saved    = opts.saved    ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var archived = opts.archived ? "<div class=\"banner banner--ok\">Reward archived.</div>" : "";
  var notice   = opts.notice   ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  var bodyRows = rewards.map(function (rw) {
    var enc = encodeURIComponent(rw.slug);
    return "<tr>" +
      "<td><a href=\"/admin/loyalty/rewards/" + _htmlEscape(enc) + "\"><strong>" + _htmlEscape(rw.slug) + "</strong></a></td>" +
      "<td>" + _htmlEscape(rw.title) + "</td>" +
      "<td>" + _htmlEscape(rw.kind) + "</td>" +
      "<td>" + _loyaltyRewardValueLabel(rw) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(rw.point_cost)) + "</td>" +
      "<td>" + _loyaltyStatusPill(rw.active, rw.archived_at) + "</td>" +
      "<td><div class=\"actions-row\">" +
        "<a class=\"btn btn--ghost\" href=\"/admin/loyalty/rewards/" + _htmlEscape(enc) + "\">Manage</a>" +
        (rw.archived_at == null
          ? "<form method=\"post\" action=\"/admin/loyalty/rewards/" + _htmlEscape(enc) + "/archive\" class=\"form-inline\">" +
              "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>"
          : "") +
      "</div></td>" +
    "</tr>";
  }).join("");
  var table = rewards.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Slug</th><th scope=\"col\">Title</th><th scope=\"col\">Kind</th><th scope=\"col\">Value</th><th scope=\"col\" class=\"num\">Point cost</th><th scope=\"col\">Status</th><th scope=\"col\">Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No rewards yet.</p>";

  var kindOpts = kinds.map(function (k) {
    return "<option value=\"" + _htmlEscape(k) + "\">" + _htmlEscape(k) + "</option>";
  }).join("");

  var createForm =
    "<div class=\"panel mt mw-40\"><h3 class=\"subhead\">Create a reward</h3>" +
      "<p class=\"meta\">A reward debits points at redemption. The value field's meaning depends on the kind: discount_percent → a whole-number percent (1–100); discount_amount → minor units off; free_product → a product id; free_shipping → leave it blank. A reward must be active to appear to customers.</p>" +
      "<form method=\"post\" action=\"/admin/loyalty/rewards\">" +
        _setupField("Slug", "slug", "", "text", "Letters, digits, dashes, dots, underscores.", " maxlength=\"80\" required") +
        "<label class=\"form-field\"><span>Kind</span><select name=\"kind\">" + kindOpts + "</select></label>" +
        _setupField("Title", "title", "", "text", "Shown to customers in the catalog.", " maxlength=\"200\" required") +
        _setupField("Point cost", "point_cost", "", "number", "Positive integer — points spent to redeem.", " min=\"1\" step=\"1\" required class=\"input-code\"") +
        _setupField("Value (number)", "value_number", "", "number", "percent (1–100) or amount in minor units. Leave blank for free_product / free_shipping.", " min=\"1\" step=\"1\" class=\"input-code\"") +
        _setupField("Value (product id)", "value_text", "", "text", "Only for free_product — the product id the reward grants.", " maxlength=\"128\"") +
        _setupField("Max per customer", "max_per_customer", "", "number", "Optional lifetime cap per customer. Blank for unlimited.", " min=\"1\" step=\"1\" class=\"input-code\"") +
        _setupField("Expires (days)", "expires_days_after_redemption", "", "number", "Optional — an unconsumed redemption expires after N days. Blank never expires.", " min=\"1\" step=\"1\" class=\"input-code\"") +
        "<label class=\"kv\"><input type=\"checkbox\" name=\"active\" value=\"on\" checked> Active — show this reward in the customer catalog.</label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create reward</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Rewards catalog</h2>" +
    "<p class=\"meta\"><a href=\"/admin/loyalty\">&larr; Loyalty</a></p>" +
    created + saved + archived + notice + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Rewards catalog", bodyHtml, "loyalty", opts.nav_available);
}

// Reward detail — the reward's stored fields and an edit form. kind is
// immutable on update (the primitive validates value_json against the
// stored kind), so the form shows it read-only and re-validates value on
// change.
function renderAdminLoyaltyReward(opts) {
  opts = opts || {};
  var rw = opts.reward;
  if (!rw) {
    var nf = "<section><h2>Reward</h2><p class=\"empty\">Reward not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/loyalty/rewards\">Back to rewards</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Reward", nf, "loyalty", opts.nav_available);
  }
  var saved  = opts.saved  ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var notice = opts.notice ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";
  var enc = encodeURIComponent(rw.slug);
  var isArchived = rw.archived_at != null;
  var v = rw.value_json || {};
  var valueNumber = rw.kind === "discount_percent" ? (v.percent == null ? "" : String(v.percent))
                  : rw.kind === "discount_amount"  ? (v.amount_minor == null ? "" : String(v.amount_minor))
                  : "";
  var valueText = rw.kind === "free_product" ? String(v.product_id || "") : "";

  var editForm = isArchived
    ? "<div class=\"panel mw-40\"><p class=\"empty\">This reward is archived. Archived rewards stay readable for past redemptions but never show to customers.</p></div>"
    : "<div class=\"panel mw-40\"><h3 class=\"subhead\">Edit</h3>" +
        "<form method=\"post\" action=\"/admin/loyalty/rewards/" + _htmlEscape(enc) + "/edit\">" +
          _setupField("Title", "title", rw.title, "text", "", " maxlength=\"200\"") +
          _setupField("Point cost", "point_cost", String(rw.point_cost), "number", "", " min=\"1\" step=\"1\" class=\"input-code\"") +
          (rw.kind === "free_product"
            ? _setupField("Value (product id)", "value_text", valueText, "text", "Leave unchanged to keep the current product.", " maxlength=\"128\"")
            : rw.kind === "free_shipping"
              ? "<p class=\"meta\">free_shipping carries no value field.</p>"
              : _setupField("Value (number)", "value_number", valueNumber, "number", "percent (1–100) or amount in minor units.", " min=\"1\" step=\"1\" class=\"input-code\"")) +
          _setupField("Max per customer", "max_per_customer", rw.max_per_customer == null ? "" : String(rw.max_per_customer), "number", "", " min=\"1\" step=\"1\" class=\"input-code\"") +
          _setupField("Expires (days)", "expires_days_after_redemption", rw.expires_days_after_redemption == null ? "" : String(rw.expires_days_after_redemption), "number", "", " min=\"1\" step=\"1\" class=\"input-code\"") +
          "<input type=\"hidden\" name=\"active_present\" value=\"1\">" +
          "<label class=\"kv\"><input type=\"checkbox\" name=\"active\" value=\"on\"" + (rw.active ? " checked" : "") + "> Active — show in the customer catalog.</label>" +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save reward</button></div>" +
        "</form>" +
      "</div>";

  var archiveBlock = isArchived ? "" :
    "<div class=\"actions-row mt-1\">" +
      "<form method=\"post\" action=\"/admin/loyalty/rewards/" + _htmlEscape(enc) + "/archive\" class=\"form-inline\">" +
        "<button class=\"btn btn--danger\" type=\"submit\">Archive reward</button></form>" +
    "</div>";

  var head =
    "<p class=\"meta\"><a href=\"/admin/loyalty/rewards\">&larr; Rewards catalog</a> · " +
      "<span class=\"status-pill paid\">" + _htmlEscape(rw.kind) + "</span> · " +
      _loyaltyStatusPill(rw.active, rw.archived_at) + " · " +
      "<code class=\"order-id\">" + _htmlEscape(String(rw.point_cost)) + " pts</code></p>";

  var body = "<section><h2>" + _htmlEscape(rw.title) + "</h2>" + saved + notice + head + editForm + archiveBlock + "</section>";
  return _renderAdminShell(opts.shop_name, "Reward", body, "loyalty", opts.nav_available);
}

// Product detail / management screen — the console's full editor for a
// single catalog product: its fields (slug / title / description /
// status), its variants (create / edit / delete), each variant's price
// (set, with the current price + an append-only price history) and the
// product's media (list / attach-by-key / upload-by-URL when the R2
// bridge is wired / delete). Mirrors `renderAdminCollection`: an edit
// form posting to a /edit POST alias (HTML forms can't PATCH), inline
// sub-entity tables with per-row forms, and destructive actions routed
// through a server-rendered confirm interstitial (the CSP forbids a
// client confirm() dialog).
function renderAdminProduct(opts) {
  opts = opts || {};
  var p = opts.product;
  if (!p) {
    var nf = "<section><h2>Product</h2><p class=\"empty\">Product not found.</p>" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/products\">Back to products</a></div></section>";
    return _renderAdminShell(opts.shop_name, "Product", nf, "products", opts.nav_available);
  }
  var variants     = opts.variants || [];
  var mediaRows    = opts.media || [];
  var pricesByVar  = opts.prices_by_variant || {};   // { variantId: { currencies: [{ currency, current, history }] } }
  var assetPrefix  = typeof opts.asset_prefix === "string" ? opts.asset_prefix : "/assets/";
  var uploadWired  = !!opts.upload_available;
  var defaultCurrency = (typeof opts.default_currency === "string" && /^[A-Z]{3}$/.test(opts.default_currency)) ? opts.default_currency : "USD";
  var pid = _htmlEscape(p.id);

  var saved   = opts.saved   ? "<div class=\"banner banner--ok\">Saved.</div>" : "";
  var created = opts.created ? "<div class=\"banner banner--ok\">Product created. Add a variant with a SKU, set its price, and add stock to make it sellable.</div>" : "";
  var notice  = opts.notice  ? "<div class=\"banner banner--err\">" + _htmlEscape(opts.notice) + "</div>" : "";

  // ---- product fields edit ---------------------------------------------
  var statusOpts = ["draft", "active", "archived"].map(function (s) {
    return "<option value=\"" + s + "\"" + (s === p.status ? " selected" : "") + ">" + s + "</option>";
  }).join("");
  var editForm =
    "<div class=\"panel mw-40\">" +
      "<h3 class=\"subhead\">Details</h3>" +
      "<form method=\"post\" action=\"/admin/products/" + pid + "/edit\">" +
        _setupField("Slug", "slug", p.slug, "text", "Lowercase, hyphenated — the storefront URL.", " maxlength=\"200\" required") +
        _setupField("Title", "title", p.title, "text", "", " maxlength=\"500\" required") +
        "<label class=\"form-field\"><span>Description</span>" +
          "<textarea name=\"description\" maxlength=\"100000\" rows=\"4\">" + _htmlEscape(p.description || "") + "</textarea></label>" +
        "<label class=\"form-field\"><span>Status</span><select name=\"status\">" + statusOpts + "</select></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Save</button></div>" +
      "</form>" +
    "</div>";

  // ---- variants table + per-variant price manager ----------------------
  var variantBlocks = variants.map(function (v) {
    var vid = _htmlEscape(v.id);
    var optionPairs = Object.keys(v.options || {}).map(function (k) {
      return _htmlEscape(k) + "=" + _htmlEscape(String(v.options[k]));
    }).join(", ");
    var optionsText = Object.keys(v.options || {}).map(function (k) {
      return k + "=" + String(v.options[k]);
    }).join(", ");

    // Price rows — current + history per currency the variant is priced in.
    var priceModel = pricesByVar[v.id] || { currencies: [] };
    var priceCurrencyBlocks = (priceModel.currencies || []).map(function (pc) {
      var current = pc.current
        ? "<strong>" + _htmlEscape(pricing.format(pc.current.amount_minor, pc.currency)) + "</strong>"
        : "<span class=\"u-mute\">no active price</span>";
      var histRows = (pc.history || []).map(function (h) {
        return "<tr>" +
          "<td class=\"num\">" + _htmlEscape(pricing.format(h.amount_minor, pc.currency)) + "</td>" +
          "<td>" + _htmlEscape(_fmtDate(h.effective_from)) + "</td>" +
          "<td>" + (h.effective_until == null ? "<span class=\"status-pill paid\">current</span>" : _htmlEscape(_fmtDate(h.effective_until))) + "</td>" +
        "</tr>";
      }).join("");
      var histTable = (pc.history && pc.history.length)
        ? "<table><thead><tr><th scope=\"col\" class=\"num\">Amount</th><th scope=\"col\">From</th><th scope=\"col\">Until</th></tr></thead><tbody>" + histRows + "</tbody></table>"
        : "";
      return "<div class=\"m-04\">" +
        "<span class=\"u-mute\">" + _htmlEscape(pc.currency) + "</span> · " + current +
        histTable +
      "</div>";
    }).join("");
    var priceSection =
      "<div class=\"panel-sub\">" +
        "<h4 class=\"subhead subhead--sp\">Price</h4>" +
        (priceCurrencyBlocks || "<p class=\"empty\">No price set yet.</p>") +
        "<form method=\"post\" action=\"/admin/variants/" + vid + "/prices/set\" class=\"price-set-form\">" +
          "<div class=\"actions-row\">" +
            "<input type=\"text\" name=\"currency\" value=\"" + _htmlEscape(defaultCurrency) + "\" class=\"input-code\" aria-label=\"Currency\" maxlength=\"3\" required>" +
            "<input type=\"number\" name=\"amount_minor\" min=\"0\" step=\"1\" placeholder=\"amount (minor units)\" aria-label=\"Amount in minor units\" required>" +
            "<button class=\"btn btn--ghost\" type=\"submit\">Set price</button>" +
          "</div>" +
          "<small class=\"u-mute\">Amount in the currency's minor units — e.g. 2999 = $29.99. Setting a price is append-only; the prior price is retained in history.</small>" +
        "</form>" +
      "</div>";

    var editVariant =
      "<form method=\"post\" action=\"/admin/variants/" + vid + "/edit\">" +
        "<div class=\"actions-row\">" +
          "<label class=\"form-field mb-0\"><span>SKU</span><input type=\"text\" name=\"sku\" value=\"" + _htmlEscape(v.sku) + "\" maxlength=\"128\" required></label>" +
          "<label class=\"form-field mb-0\"><span>Title</span><input type=\"text\" name=\"title\" value=\"" + _htmlEscape(v.title || "") + "\" maxlength=\"500\"></label>" +
        "</div>" +
        "<div class=\"actions-row\">" +
          "<label class=\"form-field mb-0\"><span>Options (k=v, comma-sep)</span><input type=\"text\" name=\"options\" value=\"" + _htmlEscape(optionsText) + "\" maxlength=\"2000\"></label>" +
          "<label class=\"form-field mb-0\"><span>Weight (g)</span><input type=\"number\" name=\"weight_grams\" value=\"" + _htmlEscape(String(v.weight_grams || 0)) + "\" min=\"0\" step=\"1\"></label>" +
        "</div>" +
        "<label class=\"form-field\"><span>Requires shipping</span><select name=\"requires_shipping\">" +
          "<option value=\"1\"" + (v.requires_shipping ? " selected" : "") + ">Yes (physical)</option>" +
          "<option value=\"0\"" + (v.requires_shipping ? "" : " selected") + ">No (digital)</option>" +
        "</select></label>" +
        "<div class=\"actions-row\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Save variant</button>" +
          "<a class=\"btn btn--danger\" href=\"/admin/variants/" + vid + "/delete/confirm-page?product_id=" + pid + "\">Delete</a>" +
        "</div>" +
      "</form>";

    return "<div class=\"panel mt-1\">" +
      "<div class=\"actions-row mt-0\">" +
        "<strong>" + _htmlEscape(v.title || v.sku) + "</strong>" +
        "<code class=\"order-id\">" + _htmlEscape(v.sku) + "</code>" +
        (optionPairs ? "<span class=\"u-mute\">" + optionPairs + "</span>" : "") +
      "</div>" +
      editVariant +
      priceSection +
    "</div>";
  }).join("");
  var variantsBody = variants.length ? variantBlocks : "<p class=\"empty\">No variants yet — add the first one below.</p>";

  var addVariant =
    "<div class=\"panel mt-1 mw-40\">" +
      "<h3 class=\"subhead\">Add a variant</h3>" +
      "<form method=\"post\" action=\"/admin/products/" + pid + "/variants/create\">" +
        _setupField("SKU", "sku", "", "text", "Unique stock-keeping unit — letters, digits, . _ -", " maxlength=\"128\" required") +
        _setupField("Title", "title", "", "text", "Optional — e.g. “Large / Blue”.", " maxlength=\"500\"") +
        _setupField("Options", "options", "", "text", "Attribute map as k=v pairs, comma-separated — e.g. size=L, color=blue.", " maxlength=\"2000\"") +
        _setupField("Weight (grams)", "weight_grams", "0", "number", "Used for shipping rate calculation.", " min=\"0\" step=\"1\"") +
        "<label class=\"form-field\"><span>Requires shipping</span><select name=\"requires_shipping\">" +
          "<option value=\"1\">Yes (physical)</option><option value=\"0\">No (digital)</option>" +
        "</select></label>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add variant</button></div>" +
      "</form>" +
    "</div>";

  var variantsSection = "<section class=\"mt\"><h3 class=\"fs-105\">Variants</h3>" + variantsBody + addVariant + "</section>";

  // ---- media -----------------------------------------------------------
  var mediaCards = mediaRows.map(function (m, idx) {
    var mid = _htmlEscape(m.id);
    var url = assetPrefix + m.r2_key;
    var isImage = /^image\//.test(m.content_type || "");
    var thumb = isImage
      ? "<img class=\"media-thumb\" src=\"" + _htmlEscape(url) + "\" alt=\"" + _htmlEscape(m.alt_text || "") + "\" loading=\"lazy\">"
      : "<span class=\"media-thumb media-thumb--file\">" + _htmlEscape((m.content_type || "file").split("/")[0]) + "</span>";
    // The first row is the hero shown on the product page — mark it with a
    // pill; every other row offers a "Make primary" form that promotes it to
    // position 0 (the CSRF field is injected into the form by the shell).
    var makePrimary = (idx === 0)
      ? "<span class=\"status-pill paid\">Primary</span>"
      : "<form method=\"post\" action=\"/admin/products/" + pid + "/media/" + mid + "/primary\" class=\"form-inline\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Make primary</button></form>";
    return "<div class=\"media-card\">" +
      thumb +
      "<code class=\"order-id\">" + _htmlEscape(m.r2_key) + "</code>" +
      "<span class=\"u-mute\">" + _htmlEscape(m.content_type || "") + (m.alt_text ? " · " + _htmlEscape(m.alt_text) : "") + "</span>" +
      "<div class=\"actions-row mt-0\">" + makePrimary +
        "<a class=\"btn btn--danger\" href=\"/admin/media/" + mid + "/delete/confirm-page?product_id=" + pid + "\">Delete</a>" +
      "</div>" +
    "</div>";
  }).join("");
  var mediaGrid = mediaRows.length
    ? "<div class=\"media-grid\">" + mediaCards + "</div>"
    : "<p class=\"empty\">No media attached yet.</p>";

  // Reorder: a single field of the current media ids, comma-joined, that the
  // operator rewrites into the new order. No-JS-required and v1-defensible
  // — the primitive normalises positions to 0..N-1 and the first row is the
  // hero. Only shown when there's more than one image to order.
  var currentMediaIds = mediaRows.map(function (m) { return m.id; }).join(",");
  var mediaReorderForm = mediaRows.length > 1
    ? "<div class=\"panel mt-1 mw-40\">" +
        "<h3 class=\"subhead\">Reorder images</h3>" +
        "<p class=\"meta\">The first image is the hero shown on the product page. Rewrite the comma-separated id list into the order you want — list every current image.</p>" +
        "<form method=\"post\" action=\"/admin/products/" + pid + "/media/reorder\">" +
          "<label class=\"form-field\"><span>Ordered media ids</span>" +
            "<input type=\"text\" name=\"ordered_media_ids\" value=\"" + _htmlEscape(currentMediaIds) + "\"></label>" +
          "<div class=\"actions-row\"><button class=\"btn btn--ghost\" type=\"submit\">Apply order</button></div>" +
        "</form>" +
      "</div>"
    : "";

  var attachForm =
    "<div class=\"panel mt-1 mw-40\">" +
      "<h3 class=\"subhead\">Attach media by R2 key</h3>" +
      "<p class=\"meta\">Reference an object already in your media bucket. The key is its path under the bucket (no leading slash, no “..”).</p>" +
      "<form method=\"post\" action=\"/admin/products/" + pid + "/media/attach\">" +
        _setupField("R2 key", "r2_key", "", "text", "e.g. media/01j…png", " maxlength=\"1024\" required") +
        _setupField("Content type", "content_type", "", "text", "MIME type — e.g. image/png.", " maxlength=\"255\" required") +
        _setupField("Alt text", "alt_text", "", "text", "Describes the image for screen readers + SEO.", " maxlength=\"500\"") +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Attach media</button></div>" +
      "</form>" +
    "</div>";

  var fileUploadForm = uploadWired
    ? "<div class=\"panel mt-1 mw-40\">" +
        "<h3 class=\"subhead\">Upload an image from your device</h3>" +
        "<p class=\"meta\">Pick a file (PNG, JPEG, WebP, GIF, AVIF, or SVG). It's stored in your bucket and attached to this product in one step.</p>" +
        "<form method=\"post\" enctype=\"multipart/form-data\" action=\"/admin/products/" + pid + "/media/upload-file\">" +
          "<label class=\"form-field\"><span>Image file</span>" +
            "<input type=\"file\" name=\"file\" accept=\"image/png,image/jpeg,image/webp,image/gif,image/avif,image/svg+xml\" required>" +
            "<small>Up to 10 MB. The file's bytes are checked against its type.</small>" +
          "</label>" +
          _setupField("Alt text", "alt_text", "", "text", "Describes the image for screen readers + SEO.", " maxlength=\"500\"") +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Upload + attach</button></div>" +
        "</form>" +
      "</div>"
    : "";

  var uploadForm = uploadWired
    ? "<div class=\"panel mt-1 mw-40\">" +
        "<h3 class=\"subhead\">Upload media from a URL</h3>" +
        "<p class=\"meta\">Fetches the source (SSRF-gated), stores it in your bucket, and attaches it to this product in one step.</p>" +
        "<form method=\"post\" action=\"/admin/products/" + pid + "/media/upload\">" +
          _setupField("Source URL", "source_url", "", "url", "A public https URL to the asset bytes.", " maxlength=\"2000\" required") +
          _setupField("Content type", "content_type", "", "text", "MIME type the source serves — e.g. image/png.", " maxlength=\"255\" required") +
          _setupField("Alt text", "alt_text", "", "text", "Describes the image for screen readers + SEO.", " maxlength=\"500\"") +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Upload + attach</button></div>" +
        "</form>" +
      "</div>"
    : "";

  var mediaSection = "<section class=\"mt\"><h3 class=\"fs-105\">Media</h3>" + mediaGrid + mediaReorderForm + fileUploadForm + attachForm + uploadForm + "</section>";

  // ---- head + assembly -------------------------------------------------
  var statusCls = p.status === "active" ? "paid" : (p.status === "archived" ? "refunded" : "pending");
  var archiveAction = p.status === "archived"
    ? "<form method=\"post\" action=\"/admin/products/" + pid + "/restore\" class=\"form-inline\"><button class=\"btn btn--ghost\" type=\"submit\">Restore</button></form>"
    : "<form method=\"post\" action=\"/admin/products/" + pid + "/archive\" class=\"form-inline\"><button class=\"btn btn--ghost\" type=\"submit\">Archive</button></form>";
  var head =
    "<p class=\"meta\"><a href=\"/admin/products\">&larr; Products</a> · " +
      "<code class=\"order-id\">" + _htmlEscape(p.slug) + "</code> · " +
      "<span class=\"status-pill " + statusCls + "\">" + _htmlEscape(p.status) + "</span>" +
      " · <a href=\"/products/" + _htmlEscape(encodeURIComponent(p.slug)) + "\" target=\"_blank\" rel=\"noreferrer\">View on storefront &rarr;</a></p>";

  var body = "<section><h2>" + _htmlEscape(p.title) + "</h2>" + created + saved + notice + head +
    "<div class=\"actions-row mt-0\">" + archiveAction + "</div>" +
    editForm + "</section>" + variantsSection + mediaSection;
  return _renderAdminShell(opts.shop_name, "Product " + p.slug, body, "products", opts.nav_available);
}

module.exports = {
  mount:           mount,
  AUDIT_NAMESPACE: AUDIT_NAMESPACE,
  renderDashboard: renderDashboard,
  renderAdminLogin:        renderAdminLogin,
  renderAdminLanding:      renderAdminLanding,
  renderAdminSetup:        renderAdminSetup,
  renderAdminIntegrations: renderAdminIntegrations,
  renderAdminProducts:     renderAdminProducts,
  renderAdminProduct:      renderAdminProduct,
  renderAdminInventory:    renderAdminInventory,
  renderAdminOrders:       renderAdminOrders,
  renderAdminOrder:        renderAdminOrder,
  renderAdminCustomers:    renderAdminCustomers,
  renderAdminCustomerDetail: renderAdminCustomerDetail,
  renderAdminReturns:      renderAdminReturns,
  renderAdminReturn:       renderAdminReturn,
  renderAdminReviews:      renderAdminReviews,
  renderAdminQuestions:    renderAdminQuestions,
  renderAdminQuestion:     renderAdminQuestion,
  renderAdminCollections:  renderAdminCollections,
  renderAdminCollection:   renderAdminCollection,
  renderAdminBlog:         renderAdminBlog,
  renderAdminBlogDetail:   renderAdminBlogDetail,
  renderAdminPages:        renderAdminPages,
  renderAdminPageDetail:   renderAdminPageDetail,
  renderAdminGiftCards:    renderAdminGiftCards,
  renderAdminGiftCard:     renderAdminGiftCard,
  renderAdminTaxRates:     renderAdminTaxRates,
  renderAdminShipping:     renderAdminShipping,
  renderAdminShippingZone: renderAdminShippingZone,
  renderAdminDiscounts:    renderAdminDiscounts,
  renderAdminDiscountAllocation: renderAdminDiscountAllocation,
  renderAdminQuantityDiscounts: renderAdminQuantityDiscounts,
  renderAdminQuantityDiscount:  renderAdminQuantityDiscount,
  renderAdminLoyalty:           renderAdminLoyalty,
  renderAdminLoyaltyEarnRules:  renderAdminLoyaltyEarnRules,
  renderAdminLoyaltyEarnRule:   renderAdminLoyaltyEarnRule,
  renderAdminLoyaltyRewards:    renderAdminLoyaltyRewards,
  renderAdminLoyaltyReward:     renderAdminLoyaltyReward,
  renderAdminConfirm:      renderAdminConfirm,
};
