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

var b = require("./vendor/blamejs");

var AUDIT_NAMESPACE = "shop_admin";

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
      if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message);
      return _problem(res, 500, "internal-error", (e && e.message) || String(e));
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
  var orderTracking = deps.orderTracking || null;   // shipment/tracking panel disabled when absent

  // Which optional console sections are wired — gates their nav links so a
  // signed-in admin is never sent to a route that wasn't mounted. Passed
  // into every authed render call as `nav_available`.
  var navAvailable = { returns: !!returns, reviews: !!reviews, productQa: !!productQa, subscriptions: !!deps.subscriptions, webhooks: !!deps.webhooks, collections: !!deps.collections, customers: !!deps.customers, giftcards: !!deps.giftcards, announcementBar: !!deps.announcementBar, customerSurveys: !!deps.customerSurveys, businessHours: !!deps.businessHours, taxRates: !!deps.taxRates, shippingZones: !!deps.shippingZones, autoDiscount: !!deps.autoDiscount };

  try { b.audit.registerNamespace(AUDIT_NAMESPACE); } catch (_e) { /* idempotent */ }

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
      // Browser form submit — create, then redirect (PRG). Bad input
      // re-renders the products page with a notice, never a 500.
      try {
        await catalog.products.create(req.body || {});
      } catch (e) {
        if (e instanceof TypeError || e.code === "CATALOG_DUPLICATE" || /slug|exists|duplicate/i.test(e.message || "")) {
          var page = await catalog.products.list({ limit: 100 });
          return _sendHtml(res, 400, renderAdminProducts({
            shop_name: deps.shop_name, nav_available: navAvailable, products: page.rows || [],
            notice: (e && e.message) || "Couldn't create that product.",
          }));
        }
        throw e;
      }
      b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".product.create", outcome: "success", metadata: {} });
      _redirect(res, "/admin/products?created=1");
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
        saved:  url && url.searchParams.get("saved"),
        notice: (url && url.searchParams.get("err")) ? "That action couldn't be completed." : null,
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
        if (e instanceof TypeError || /exists|duplicate|UNIQUE/i.test(e.message || "")) {
          var page = await catalog.inventory.list({ limit: 500 });
          return _sendHtml(res, 400, renderAdminInventory({
            shop_name: deps.shop_name, nav_available: navAvailable, inventory: page.rows || [],
            notice: (e && e.message) || "Couldn't create that SKU.",
          }));
        }
        throw e;
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
        if (!(e instanceof TypeError)) throw e;
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
      // smuggle internal data into the bucket.
      var fetched;
      try {
        fetched = await b.httpClient.request({
          method:    "GET",
          url:       body.source_url,
          timeoutMs: 20000,
          headers:   { "accept": body.content_type + ",*/*;q=0.5" },
        });
      } catch (e) {
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
            shipments.push(full || shipRows[si]);
          }
        } catch (_e) { shipments = []; }
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
        shipments:   shipments,
        carriers:    orderTracking ? orderTracking.CARRIERS : null,
        statuses:    orderTracking ? orderTracking.STATUSES : null,
        moved:       url && url.searchParams.get("moved"),
        ship_done:   url && url.searchParams.get("ship"),
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
        var rma;
        try { rma = await returns.get(req.params.id); }
        catch (e) {
          if (e instanceof TypeError) return _problem(res, 404, "return-not-found", e.message);
          throw e;
        }
        if (!rma) return _problem(res, 404, "return-not-found");
        var rmaCtx = await _rmaProviderContext(rma);
        // Provider-backed path: move money first, then record the RMA.
        if (rmaCtx.canProviderRefund) {
          var result;
          try { result = await _rmaProviderRefund(rma, rmaCtx.order, body); }
          catch (e) {
            var ce = _returnsClientError(e);
            if (ce) return _problem(res, ce.status, ce.slug, e.message);
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
          if (!(e instanceof TypeError)) throw e;
          var rows = await webhooks.endpoints.list();
          return _sendHtml(res, 400, renderAdminWebhooks({
            shop_name: deps.shop_name, nav_available: navAvailable, endpoints: rows,
            known_events: KNOWN_WH_EVENTS, notice: e.message.replace(/^webhooks:\s*/, ""),
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

    function _cleanCreateMessage(e) {
      return (e && e.message || "Couldn't create that collection.").replace(/^collections[.:]\s*/, "");
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
          if (!(e instanceof TypeError)) throw e;
          var rows = await _listForBrowser({});
          return _sendHtml(res, 400, renderAdminCollections({
            shop_name: deps.shop_name, nav_available: navAvailable, collections: rows,
            notice: _cleanCreateMessage(e), form_type: type,
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
          if (!(e instanceof TypeError)) throw e;
          var rows = await announcements.listAnnouncements({});
          return _sendHtml(res, 400, renderAdminAnnouncements({
            shop_name: deps.shop_name, nav_available: navAvailable, announcements: rows,
            notice: (e && e.message || "Couldn't save that announcement.").replace(/^announcementBar[.:]\s*/, ""),
          }));
        }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".announcement.define", outcome: "success" });
        _redirect(res, "/admin/announcements?created=1");
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
          if (!(e instanceof TypeError)) throw e;
          var rows = await surveys.listSurveys({});
          return _sendHtml(res, 400, renderAdminSurveys({
            shop_name: deps.shop_name, nav_available: navAvailable, surveys: rows,
            notice: (e.message || "Couldn't create that survey.").replace(/^customerSurveys[.:]\s*/, ""),
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
          if (!(e instanceof TypeError)) throw e;
          var rows = await hours.listSchedules();
          return _sendHtml(res, 400, renderAdminHours({
            shop_name: deps.shop_name, nav_available: navAvailable, schedules: rows,
            notice: (e.message || "Couldn't save that schedule.").replace(/^businessHours[.:]\s*/, ""),
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
          if (!(e instanceof TypeError)) throw e;
          var rows = await subscriptions.plans.list({});
          return _sendHtml(res, 400, renderAdminSubscriptionPlans({
            shop_name: deps.shop_name, nav_available: navAvailable, plans: rows,
            notice: e.message.replace(/^subscriptions[.:]\s*/, ""),
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

    router.get("/admin/subscription-plans/:id", R(async function (req, res) {
      var p = await subscriptions.plans.get(req.params.id);
      if (!p) return _problem(res, 404, "subscription-plan-not-found");
      _json(res, 200, p);
    }));

    router.patch("/admin/subscription-plans/:id", W("subscription_plan.update", async function (req, res) {
      var p = await subscriptions.plans.update(req.params.id, req.body || {});
      if (!p) return _problem(res, 404, "subscription-plan-not-found");
      _json(res, 200, p);
      return p;
    }));

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
          if (!(e instanceof TypeError)) throw e;
          var rows = await giftcards.list({});
          return _sendHtml(res, 400, renderAdminGiftCards({
            shop_name: deps.shop_name, nav_available: navAvailable, cards: rows,
            notice: e.message.replace(/^giftcards?[.:]\s*/i, ""),
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
          if (!(e instanceof TypeError) && e.code !== "TAX_RATE_OVERLAP") throw e;
          var rows = await _taxRatesForBrowser(jurisdiction);
          return _sendHtml(res, 400, renderAdminTaxRates({
            shop_name: deps.shop_name, nav_available: navAvailable, rates: rows,
            jurisdiction: jurisdiction, sources: taxRates.SOURCES,
            notice: (e && e.message || "").replace(/^taxRates[.:]\s*/, ""),
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
          if (!(e instanceof TypeError) && e.code !== "SHIPPING_ZONE_EXISTS") throw e;
          var rows = await shippingZones.listZones({});
          return _sendHtml(res, 400, renderAdminShipping({
            shop_name: deps.shop_name, nav_available: navAvailable, zones: rows,
            notice: (e && e.message || "").replace(/^shippingZones[.:]\s*/, ""),
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
      patch.regions = JSON.parse(body.regions_json);
    } else if (Array.isArray(body.regions)) {
      patch.regions = body.regions;
    }
    if (typeof body.rates_json === "string" && body.rates_json.trim() !== "") {
      patch.rates = JSON.parse(body.rates_json);
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
          if (!(e instanceof TypeError)) throw e;
          return _sendHtml(res, 400, await _renderDiscounts({
            notice: (e && e.message || "").replace(/^autoDiscount[.:]\s*/, ""),
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

    router.post("/admin/discounts/:slug/edit", _pageOrApi(false,
      W("auto_discount.update", async function (req, res) {
        var rule;
        try { rule = await autoDiscount.updateRule(req.params.slug, _discountPatch(req.body || {})); }
        catch (e) { if (e instanceof TypeError) return _problem(res, 400, "bad-request", e.message); throw e; }
        _json(res, 200, rule);
        return { id: rule.slug };
      }),
      async function (req, res) {
        try { await autoDiscount.updateRule(req.params.slug, _discountPatch(req.body || {})); }
        catch (e) { if (!(e instanceof TypeError)) throw e; return _redirect(res, "/admin/discounts?err=1"); }
        b.audit.safeEmit({ action: AUDIT_NAMESPACE + ".auto_discount.update", outcome: "success", metadata: { slug: req.params.slug } });
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
            if (!(e instanceof TypeError)) throw e;
            return _sendHtml(res, 400, await _renderDiscounts({
              notice: (e && e.message || "").replace(/^couponStacking[.:]\s*/, ""),
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

  // Translate the rule edit form into an updateRule patch — title /
  // priority / active. The trigger + value re-set go through the bearer
  // JSON PATCH for the full vocabulary; the console edit is the common
  // "rename / re-prioritise / pause" gesture.
  function _discountPatch(body) {
    var patch = {};
    if (Object.prototype.hasOwnProperty.call(body, "title") && body.title !== "") patch.title = body.title;
    if (body.priority != null && body.priority !== "") patch.priority = _strictMinorInt(body.priority, "autoDiscount", "priority");
    if (body.active_present === "1") patch.active = (body.active === "on" || body.active === "1");
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
        return _sendHtml(res, 500, renderAdminSetup({
          shop_name: deps.shop_name, values: values, nav_available: navAvailable,
          notice: "Couldn't save — " + ((e && e.message) || "please try again."),
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
  { key: "customers",    href: "/admin/customers",    label: "Customers",    requires: "customers" },
  { key: "returns",      href: "/admin/returns",      label: "Returns",      requires: "returns" },
  { key: "reviews",      href: "/admin/reviews",      label: "Reviews",      requires: "reviews" },
  { key: "questions",    href: "/admin/questions",    label: "Q&A",          requires: "productQa" },
  { key: "subscriptions", href: "/admin/subscription-plans", label: "Subscriptions", requires: "subscriptions" },
  { key: "collections",  href: "/admin/collections",  label: "Collections",  requires: "collections" },
  { key: "discounts",    href: "/admin/discounts",    label: "Discounts",    requires: "autoDiscount" },
  { key: "tax",          href: "/admin/tax-rates",    label: "Tax",          requires: "taxRates" },
  { key: "shipping",     href: "/admin/shipping",     label: "Shipping",     requires: "shippingZones" },
  { key: "announcements", href: "/admin/announcements", label: "Announcements", requires: "announcementBar" },
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
  return _renderTemplate(DASHBOARD_LAYOUT, {
    shop_name:    shopName || "blamejs.shop",
    page_title:   subtitle || "Admin",
    window_label: subtitle || "",
    nav:          "RAW_NAV",
    body:         "RAW_BODY",
  }).replace("RAW_ADMIN_CSS", _adminStylesheetLink())
    .replace("RAW_NAV", _adminNav(active, available))
    .replace("RAW_BODY", bodyHtml);
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

function renderAdminOrder(opts) {
  opts = opts || {};
  var o = opts.order;
  var transitions = opts.transitions || [];
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Order updated.</div>" : "";
  var shipOk = opts.ship_done ? "<div class=\"banner banner--ok\">Shipment updated.</div>" : "";
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
      return "<div class=\"panel mt\">" +
        "<div class=\"order-shipment-head\">" +
          "<strong>" + _htmlEscape(String(carrierLabel)) + "</strong> " +
          "<span class=\"status-pill " + _htmlEscape(s.status) + "\">" + _htmlEscape(s.status) + "</span>" +
        "</div>" +
        "<p class=\"meta\">Tracking: " + trackingCell + "</p>" +
        eventsTable +
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

  var body =
    "<section class=\"mw-48\">" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/orders\">&larr; Orders</a></div>" +
      "<h2>Order <code class=\"order-id\">" + _htmlEscape(o.id.slice(0, 8)) + "</code> " +
        "<span class=\"status-pill " + _htmlEscape(o.status) + "\">" + _htmlEscape(o.status) + "</span></h2>" +
      "<p class=\"meta\">Placed " + _htmlEscape(_fmtDate(o.created_at)) + " · last updated " + _htmlEscape(_fmtDate(o.updated_at)) +
        (o.payment_intent_id ? " · payment <code class=\"order-id\">" + _htmlEscape(o.payment_intent_id) + "</code>" : "") + "</p>" +
      moved + shipOk + notice +
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
      trackingPanel +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Order " + o.id.slice(0, 8), body, "orders", opts.nav_available);
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
    return "<tr>" +
      "<td><strong>" + _htmlEscape(c.display_name) + "</strong></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(String(c.id).slice(0, 8)) + "</code></td>" +
      "<td>" + _htmlEscape(_fmtDate(c.created_at)) + "</td>" +
      "<td>" + method + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(orders)) + "</td>" +
      "</tr>";
  }).join("");

  var table = customers.length
    ? "<div class=\"panel\"><table><thead><tr><th scope=\"col\">Name</th><th scope=\"col\">ID</th><th scope=\"col\">Joined</th><th scope=\"col\">Sign-in method</th><th scope=\"col\" class=\"num\">Orders</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No customers yet.</p>";

  // Cursor pager — a Next link when the page filled and more rows remain.
  // The opaque cursor is HMAC-tagged by customers.list; encode it for the URL.
  var pager = opts.next_cursor
    ? "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/customers?cursor=" + _htmlEscape(encodeURIComponent(opts.next_cursor)) + "\">Next page <span aria-hidden=\"true\">→</span></a></div>"
    : "";

  var body = "<section><h2>Customers</h2>" +
    "<p class=\"meta\">Accounts are passwordless — customers enrol a passkey or sign in with a federated provider. Email addresses aren't stored in the clear, so they're not shown here.</p>" +
    table + pager + "</section>";
  return _renderAdminShell(opts.shop_name, "Customers", body, "customers", opts.nav_available);
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
      ? "<form method=\"post\" action=\"/admin/subscription-plans/" + _htmlEscape(p.id) + "/archive/confirm\" class=\"form-inline\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Archive</button></form>"
      : "<span class=\"meta\">—</span>";
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
  var mediaCards = mediaRows.map(function (m) {
    var mid = _htmlEscape(m.id);
    var url = assetPrefix + m.r2_key;
    var isImage = /^image\//.test(m.content_type || "");
    var thumb = isImage
      ? "<img class=\"media-thumb\" src=\"" + _htmlEscape(url) + "\" alt=\"" + _htmlEscape(m.alt_text || "") + "\" loading=\"lazy\">"
      : "<span class=\"media-thumb media-thumb--file\">" + _htmlEscape((m.content_type || "file").split("/")[0]) + "</span>";
    return "<div class=\"media-card\">" +
      thumb +
      "<code class=\"order-id\">" + _htmlEscape(m.r2_key) + "</code>" +
      "<span class=\"u-mute\">" + _htmlEscape(m.content_type || "") + (m.alt_text ? " · " + _htmlEscape(m.alt_text) : "") + "</span>" +
      "<a class=\"btn btn--danger\" href=\"/admin/media/" + mid + "/delete/confirm-page?product_id=" + pid + "\">Delete</a>" +
    "</div>";
  }).join("");
  var mediaGrid = mediaRows.length
    ? "<div class=\"media-grid\">" + mediaCards + "</div>"
    : "<p class=\"empty\">No media attached yet.</p>";

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

  var mediaSection = "<section class=\"mt\"><h3 class=\"fs-105\">Media</h3>" + mediaGrid + fileUploadForm + attachForm + uploadForm + "</section>";

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

  var body = "<section><h2>" + _htmlEscape(p.title) + "</h2>" + saved + notice + head +
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
  renderAdminReturns:      renderAdminReturns,
  renderAdminReturn:       renderAdminReturn,
  renderAdminReviews:      renderAdminReviews,
  renderAdminQuestions:    renderAdminQuestions,
  renderAdminQuestion:     renderAdminQuestion,
  renderAdminCollections:  renderAdminCollections,
  renderAdminCollection:   renderAdminCollection,
  renderAdminGiftCards:    renderAdminGiftCards,
  renderAdminGiftCard:     renderAdminGiftCard,
  renderAdminTaxRates:     renderAdminTaxRates,
  renderAdminShipping:     renderAdminShipping,
  renderAdminShippingZone: renderAdminShippingZone,
  renderAdminDiscounts:    renderAdminDiscounts,
  renderAdminConfirm:      renderAdminConfirm,
};
