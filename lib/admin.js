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

function _setAdminCookie(res) {
  _adminJar().writeSealed(res, ADMIN_COOKIE_NAME, JSON.stringify({
    admin: true,
    exp:   Date.now() + b.constants.TIME.hours(12),
  }), { expires: new Date(Date.now() + b.constants.TIME.hours(12)) });
}
function _clearAdminCookie(res) {
  _adminJar().clear(res, ADMIN_COOKIE_NAME);
}
function _adminCookieValid(req) {
  var raw = _adminJar().readSealed(req, ADMIN_COOKIE_NAME);
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
  var returns       = deps.returns       || null;   // RMA moderation endpoints disabled when absent

  // Which optional console sections are wired — gates their nav links so a
  // signed-in admin is never sent to a route that wasn't mounted. Passed
  // into every authed render call as `nav_available`.
  var navAvailable = { returns: !!returns, reviews: !!reviews, subscriptions: !!deps.subscriptions, webhooks: !!deps.webhooks, collections: !!deps.collections };

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

  router.get("/admin/products/:id", R(async function (req, res) {
    var p = await catalog.products.get(req.params.id);
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
  }));

  router.patch("/admin/products/:id", W("product.update", async function (req, res) {
    var p = await catalog.products.update(req.params.id, req.body || {});
    if (!p) return _problem(res, 404, "product-not-found");
    _json(res, 200, p);
    return p;
  }));

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

  router.patch("/admin/variants/:id", W("variant.update", async function (req, res) {
    var v = await catalog.variants.update(req.params.id, req.body || {});
    if (!v) return _problem(res, 404, "variant-not-found");
    _json(res, 200, v);
    return v;
  }));

  router.delete("/admin/variants/:id", W("variant.delete", async function (req, res) {
    var ok = await catalog.variants.delete(req.params.id);
    if (!ok) return _problem(res, 404, "variant-not-found");
    _json(res, 200, { ok: true });
    return { id: req.params.id };
  }));

  // ---- prices ---------------------------------------------------------

  router.post("/admin/variants/:id/prices", W("price.set", async function (req, res) {
    var p = await catalog.prices.set(req.params.id, req.body || {});
    _json(res, 201, p);
    return p;
  }));

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

  // --- media upload (r2 bridge) ---------------------------------------
  // POST /admin/media/upload — fetches `source_url` via b.httpClient
  // (SSRF gate + size cap), uploads to R2 through the bridge, then
  // records the media row. Endpoint is omitted entirely when no
  // r2_bridge is wired (operator hasn't set D1_BRIDGE_URL +
  // D1_BRIDGE_SECRET).
  if (r2) {
    router.post("/admin/media/upload", W("media.upload", async function (req, res) {
      var body = req.body || {};
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
        return _problem(res, 502, "source-fetch-failed", (e && e.message) || String(e));
      }
      if (fetched.statusCode < 200 || fetched.statusCode >= 300) {
        return _problem(res, 502, "source-fetch-status",
          "source_url returned HTTP " + fetched.statusCode);
      }
      var fetchedCT = String(fetched.headers && (fetched.headers["content-type"] || fetched.headers["Content-Type"]) || "");
      // Loose match — the declared content_type must be a prefix of
      // (or equal to) the server's content-type up to parameters. So
      // `image/png` accepts `image/png; charset=binary` but refuses
      // `application/zip` smuggled past the operator's intent.
      var declared = body.content_type.split(";")[0].trim().toLowerCase();
      var served   = fetchedCT.split(";")[0].trim().toLowerCase();
      if (served && declared !== served) {
        return _problem(res, 422, "content-type-mismatch",
          "source_url served `" + served + "` but operator declared `" + declared + "`");
      }
      var buf = fetched.body && Buffer.isBuffer(fetched.body) ? fetched.body
              : Buffer.from(fetched.body || "");
      if (buf.length === 0) {
        return _problem(res, 422, "source-empty", "source_url returned an empty body");
      }
      // Generate the R2 key. The extension is inferred from the
      // declared content-type so the operator can preview the asset
      // without a content-disposition round-trip.
      var ext = _extFromContentType(declared);
      var id  = b.uuid.v7();
      var key = "media/" + id + (ext ? "." + ext : "");
      try {
        await r2.put(key, buf, body.content_type);
      } catch (e) {
        return _problem(res, 502, "r2-upload-failed", (e && e.message) || String(e));
      }
      var m;
      try {
        m = await catalog.media.attach({
          product_id:   body.product_id || undefined,
          variant_id:   body.variant_id || undefined,
          r2_key:       key,
          content_type: body.content_type,
          width:        body.width    || 0,
          height:       body.height   || 0,
          position:     body.position || 0,
          alt_text:     body.alt_text || "",
        });
      } catch (e) {
        // The R2 write succeeded but the DB row didn't land — surface
        // the orphan key so the operator can reconcile or re-attach.
        var problem = e instanceof TypeError ? 400 : 500;
        return _problem(res, problem, "media-attach-failed",
          (e && e.message || String(e)) + " (orphan r2_key=" + key + ")");
      }
      // Expose the public asset URL alongside the media row so the
      // admin UI can preview without an extra round-trip.
      var rec = Object.assign({}, m, { asset_url: assetPrefix + key });
      _json(res, 201, rec);
      return rec;
    }));
  }

  router.delete("/admin/media/:id", W("media.delete", async function (req, res) {
    var ok = await catalog.media.delete(req.params.id);
    if (!ok) return _problem(res, 404, "media-not-found");
    _json(res, 200, { ok: true });
    return { id: req.params.id };
  }));

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
      _sendHtml(res, 200, renderAdminOrder({
        shop_name:   deps.shop_name,
        nav_available: navAvailable,
        order:       o,
        transitions: order.transitionsFrom(o.status),
        // Refund moves money, so the console only offers it when a payment
        // provider is wired AND the order has a captured intent to refund.
        can_refund:  !!(payment && o.payment_intent_id),
        moved:       url && url.searchParams.get("moved"),
        notice:      url && url.searchParams.get("err") ? "That action couldn't be completed for this order." : null,
      }));
    },
  ));

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
        _sendHtml(res, 200, renderAdminReturn({
          shop_name:   deps.shop_name,
          nav_available: navAvailable,
          rma:         rma,
          transitions: returns.transitionsFrom(rma.status),
          moved:       url && url.searchParams.get("moved"),
          notice:      url && url.searchParams.get("err") ? "That action couldn't be completed for this return." : null,
        }));
      },
    ));

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

    router.post("/admin/returns/:id/refund", _returnAction(
      W("return.refund", async function (req, res) {
        var body = req.body || {};
        var rma;
        try {
          rma = await returns.refund(req.params.id, { operator_notes: body.operator_notes });
        } catch (e) {
          var ce = _returnsClientError(e);
          if (ce) return _problem(res, ce.status, ce.slug, e.message);
          throw e;
        }
        _json(res, 200, rma);
        return rma;
      }),
      "return.refund",
      function (id, body) { return returns.refund(id, { operator_notes: body.operator_notes || undefined }); },
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
        if (body.amount_minor   != null && body.amount_minor   !== "") input.amount_minor   = parseInt(body.amount_minor, 10);
        if (body.interval_count != null && body.interval_count !== "") input.interval_count = parseInt(body.interval_count, 10);
        if (body.trial_days     != null && body.trial_days     !== "") input.trial_days     = parseInt(body.trial_days, 10);
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
      nav_available:  navAvailable,
    }));
  });

  router.post("/admin/login", async function (req, res) {
    var body  = req.body || {};
    var token = typeof body.token === "string" ? body.token : "";
    if (!_authOk(token, expectedToken)) {
      return _sendHtml(res, 401, renderAdminLogin({ shop_name: deps.shop_name, error: true }));
    }
    try { _setAdminCookie(res); }
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

  router.post("/admin/logout", async function (_req, res) {
    _clearAdminCookie(res);
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
// matching the storefront's brand palette (#191919 ink, #fa4f09
// accent, Montserrat headlines). No client-side JS — the SVG sparkline
// is rendered server-side from the revenue-by-day rows.

var DASHBOARD_LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <meta name=\"robots\" content=\"noindex,nofollow\">\n" +
  "  <title>Admin dashboard — {{shop_name}}</title>\n" +
  "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n" +
  "  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n" +
  "  <link href=\"https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Inter:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n" +
  "  <style>\n" +
  "    :root { --ink:#191919; --ink-2:#414141; --mute:#727272; --hair:#d9d9d9; --paper:#ffffff; --bg:#fafafa; --accent:#fa4f09; --accent-d:#d8410a; }\n" +
  "    * { box-sizing: border-box; }\n" +
  "    html, body { margin:0; padding:0; background:var(--bg); }\n" +
  "    body { font-family:'Inter',ui-sans-serif,system-ui,sans-serif; color:var(--ink); font-size:15px; line-height:1.55; }\n" +
  "    h1, h2, h3 { font-family:'Montserrat',sans-serif; font-weight:700; letter-spacing:-0.01em; margin:0 0 .65rem; }\n" +
  "    .admin-header { background:var(--ink); color:var(--paper); border-bottom:3px solid var(--accent); }\n" +
  "    .admin-header__inner { max-width:80rem; margin:0 auto; padding:1.2rem 1.5rem; display:flex; align-items:center; justify-content:space-between; }\n" +
  "    .admin-header h1 { color:var(--paper); font-size:1.1rem; margin:0; font-weight:600; letter-spacing:.02em; text-transform:uppercase; }\n" +
  "    .admin-header .brand-accent { color:var(--accent); }\n" +
  "    main { max-width:80rem; margin:0 auto; padding:2.5rem 1.5rem 5rem; }\n" +
  "    section { margin-bottom:2.5rem; }\n" +
  "    section h2 { font-size:1.1rem; text-transform:uppercase; letter-spacing:.05em; color:var(--mute); font-weight:600; margin-bottom:1rem; }\n" +
  "    .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(12rem, 1fr)); gap:1rem; }\n" +
  "    .stat-card { background:var(--paper); border:1px solid var(--hair); border-radius:8px; padding:1.25rem 1.4rem; }\n" +
  "    .stat-card .label { font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; color:var(--mute); font-weight:600; }\n" +
  "    .stat-card .value { font-family:'Montserrat',sans-serif; font-weight:700; font-size:1.8rem; color:var(--ink); margin-top:.35rem; line-height:1.1; }\n" +
  "    .stat-card .value.accent { color:var(--accent); }\n" +
  "    .panel { background:var(--paper); border:1px solid var(--hair); border-radius:8px; padding:1.5rem; }\n" +
  "    .two-col { display:grid; grid-template-columns: 2fr 1fr; gap:1.5rem; align-items:start; }\n" +
  "    @media (max-width: 56rem) { .two-col { grid-template-columns: 1fr; } }\n" +
  "    table { width:100%; border-collapse:collapse; font-size:.9rem; }\n" +
  "    thead th { text-align:left; padding:.65rem .75rem; border-bottom:2px solid var(--ink); font-family:'Montserrat',sans-serif; font-weight:600; font-size:.72rem; letter-spacing:.05em; text-transform:uppercase; color:var(--mute); }\n" +
  "    tbody td { padding:.65rem .75rem; border-bottom:1px solid var(--hair); }\n" +
  "    tbody tr:last-child td { border-bottom:none; }\n" +
  "    td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }\n" +
  "    .status-pill { display:inline-block; padding:.15rem .55rem; border-radius:999px; font-size:.72rem; font-weight:600; text-transform:uppercase; letter-spacing:.04em; background:var(--bg); color:var(--ink-2); border:1px solid var(--hair); }\n" +
  "    .status-pill.paid, .status-pill.fulfilling, .status-pill.shipped, .status-pill.delivered { background:#e9f5ec; color:#1f6b3a; border-color:#bfe1c9; }\n" +
  "    .status-pill.refunded { background:#fff1eb; color:var(--accent-d); border-color:#f6c5af; }\n" +
  "    .status-pill.cancelled { background:#f4f4f4; color:var(--mute); }\n" +
  "    .status-pill.pending { background:#fff8e1; color:#7a5d0f; border-color:#f1e1a8; }\n" +
  "    .spark { width:100%; height:8rem; background:var(--bg); border:1px solid var(--hair); border-radius:6px; padding:.5rem; }\n" +
  "    .spark svg { display:block; width:100%; height:100%; }\n" +
  "    .empty { color:var(--mute); font-style:italic; padding:1rem 0; text-align:center; }\n" +
  "    .meta { color:var(--mute); font-size:.85rem; margin-bottom:1rem; }\n" +
  "    .order-id { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.78rem; color:var(--ink-2); }\n" +
  "    .form-field { display:block; margin-bottom:1.1rem; }\n" +
  "    .form-field span { display:block; font-size:.78rem; text-transform:uppercase; letter-spacing:.05em; color:var(--mute); font-weight:600; margin-bottom:.35rem; }\n" +
  "    .form-field input { width:100%; max-width:28rem; padding:.6rem .75rem; border:1px solid var(--hair); border-radius:6px; font:inherit; }\n" +
  "    .form-field input:focus { outline:2px solid var(--accent); outline-offset:1px; border-color:var(--accent); }\n" +
  "    .form-field small { display:block; color:var(--mute); font-size:.78rem; margin-top:.3rem; }\n" +
  "    .btn { display:inline-flex; align-items:center; gap:.4rem; background:var(--accent); color:var(--paper); border:1px solid var(--accent); padding:.6rem 1.1rem; border-radius:6px; font-family:'Montserrat',sans-serif; font-weight:700; font-size:.82rem; letter-spacing:.04em; text-transform:uppercase; text-decoration:none; cursor:pointer; }\n" +
  "    .btn:hover { background:var(--accent-d); border-color:var(--accent-d); }\n" +
  "    .btn--ghost { background:transparent; color:var(--ink); border-color:var(--ink); }\n" +
  "    .btn--ghost:hover { background:var(--ink); color:var(--paper); }\n" +
  "    .btn--danger { background:transparent; color:var(--accent-d); border-color:var(--accent-d); }\n" +
  "    .btn--danger:hover { background:var(--accent-d); color:var(--paper); }\n" +
  "    .order-filters { display:flex; flex-wrap:wrap; gap:.5rem; margin-bottom:1.25rem; }\n" +
  "    .chip { display:inline-block; padding:.3rem .8rem; border-radius:999px; border:1px solid var(--hair); color:var(--ink-2); text-decoration:none; font-size:.78rem; text-transform:capitalize; }\n" +
  "    .chip:hover { border-color:var(--accent); }\n" +
  "    .chip--on { background:var(--ink); color:var(--paper); border-color:var(--ink); }\n" +
  "    .order-totals { width:100%; }\n" +
  "    .order-totals td { padding:.3rem 0; }\n" +
  "    .order-actions { display:flex; flex-wrap:wrap; gap:.6rem; }\n" +
  "    .return-actions { display:grid; grid-template-columns:repeat(auto-fit,minmax(16rem,1fr)); gap:1.25rem; }\n" +
  "    .return-action { border:1px solid var(--hair); border-radius:8px; padding:1rem; }\n" +
  "    .return-action h4 { margin:0 0 .6rem; font-size:.9rem; }\n" +
  "    .review-card { margin-bottom:1rem; }\n" +
  "    .review-card__head { display:flex; flex-wrap:wrap; align-items:center; gap:.5rem; margin-bottom:.5rem; }\n" +
  "    .review-card__body { margin:.25rem 0 .75rem; white-space:pre-wrap; }\n" +
  "    .review-stars { color:#c9821f; letter-spacing:.1em; }\n" +
  "    .review-reject { display:inline-flex; gap:.4rem; align-items:center; }\n" +
  "    .review-reject input { padding:.45rem .6rem; border:1px solid var(--hair); border-radius:6px; font-size:.82rem; }\n" +
  "    .inv-row-form { display:flex; gap:.4rem; align-items:center; }\n" +
  "    .inv-row-form input { padding:.4rem .5rem; border:1px solid var(--hair); border-radius:6px; font-size:.82rem; }\n" +
  "    tr.row--low td { background:#fff8e1; }\n" +
  "    .nav-cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(14rem,1fr)); gap:1rem; }\n" +
  "    .nav-card { display:block; background:var(--paper); border:1px solid var(--hair); border-radius:8px; padding:1.4rem; text-decoration:none; color:var(--ink); }\n" +
  "    .nav-card:hover { border-color:var(--accent); box-shadow:0 8px 20px -12px rgba(0,0,0,.25); }\n" +
  "    .nav-card h3 { margin:0 0 .35rem; font-size:1.05rem; }\n" +
  "    .nav-card p { margin:0; color:var(--mute); font-size:.88rem; }\n" +
  "    .banner { padding:.9rem 1.1rem; border-radius:8px; margin-bottom:1.5rem; font-size:.92rem; }\n" +
  "    .banner--warn { background:#fff8e1; border:1px solid #f1e1a8; color:#7a5d0f; }\n" +
  "    .banner--ok { background:#e9f5ec; border:1px solid #bfe1c9; color:#1f6b3a; }\n" +
  "    .banner--err { background:#fff1eb; border:1px solid #f6c5af; color:var(--accent-d); }\n" +
  "    .actions-row { display:flex; gap:.75rem; flex-wrap:wrap; align-items:center; margin-top:1.5rem; }\n" +
  "    .admin-nav { background:var(--paper); border-bottom:1px solid var(--hair); }\n" +
  "    .admin-nav__inner { max-width:80rem; margin:0 auto; padding:0 1.5rem; display:flex; gap:.1rem; flex-wrap:wrap; }\n" +
  "    .admin-nav a { display:inline-block; padding:.85rem .9rem; color:var(--ink-2); text-decoration:none; font-size:.84rem; font-weight:600; border-bottom:2px solid transparent; }\n" +
  "    .admin-nav a:hover { color:var(--ink); }\n" +
  "    .admin-nav a.active { color:var(--accent); border-bottom-color:var(--accent); }\n" +
  "  </style>\n" +
  "</head>\n" +
  "<body>\n" +
  "  <header class=\"admin-header\">\n" +
  "    <div class=\"admin-header__inner\">\n" +
  "      <h1>{{shop_name}} <span class=\"brand-accent\">/ admin</span></h1>\n" +
  "      <span style=\"font-size:.8rem; color:var(--mute);\">{{window_label}}</span>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  {{nav}}\n" +
  "  <main>{{body}}</main>\n" +
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
         "<path d=\"" + path + "\" fill=\"none\" stroke=\"#fa4f09\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>" +
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
      "<table><thead><tr><th>Currency</th><th class=\"num\">Orders</th><th class=\"num\">Revenue</th></tr></thead><tbody>" + rows + "</tbody></table>" +
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
    "    <h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Top SKUs by units sold</h3>" +
    "    <table><thead><tr><th>SKU</th><th class=\"num\">Units</th><th class=\"num\">Revenue</th></tr></thead><tbody>" + topRows + "</tbody></table>" +
    "  </div>" +
    "  <div class=\"panel\">" +
    "    <h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Recent orders</h3>" +
    "    <table><thead><tr><th>Order</th><th>Status</th><th class=\"num\">Total</th></tr></thead><tbody>" + recentRows + "</tbody></table>" +
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
  { key: "returns",      href: "/admin/returns",      label: "Returns",      requires: "returns" },
  { key: "reviews",      href: "/admin/reviews",      label: "Reviews",      requires: "reviews" },
  { key: "subscriptions", href: "/admin/subscription-plans", label: "Subscriptions", requires: "subscriptions" },
  { key: "collections",  href: "/admin/collections",  label: "Collections",  requires: "collections" },
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
    return "<a href=\"" + it.href + "\"" + (it.key === active ? " class=\"active\"" : "") + ">" +
      _htmlEscape(it.label) + "</a>";
  }).join("");
  return "<nav class=\"admin-nav\"><div class=\"admin-nav__inner\">" + links + "</div></nav>";
}

function _renderAdminShell(shopName, subtitle, bodyHtml, active, available) {
  return _renderTemplate(DASHBOARD_LAYOUT, {
    shop_name:    shopName || "blamejs.shop",
    window_label: subtitle || "",
    nav:          "RAW_NAV",
    body:         "RAW_BODY",
  }).replace("RAW_NAV", _adminNav(active, available)).replace("RAW_BODY", bodyHtml);
}

function renderAdminLogin(opts) {
  opts = opts || {};
  var err = opts.error
    ? "<div class=\"banner banner--err\">That key didn't match. Check the ADMIN_API_KEY this deployment was started with.</div>"
    : "";
  var body =
    "<section style=\"max-width:30rem;\">" +
      "<h2>Sign in</h2>" + err +
      "<form method=\"post\" action=\"/admin/login\">" +
        "<label class=\"form-field\"><span>Admin API key</span>" +
          "<input type=\"password\" name=\"token\" autocomplete=\"off\" autofocus required>" +
          "<small>Paste the ADMIN_API_KEY this deployment was started with.</small>" +
        "</label>" +
        "<button type=\"submit\" class=\"btn\">Sign in</button>" +
      "</form>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Sign in", body, null);
}

function renderAdminLanding(opts) {
  opts = opts || {};
  var setupBanner = opts.setup_complete
    ? ""
    : "<div class=\"banner banner--warn\">Your shop isn't set up yet. <a href=\"/admin/setup\">Finish setup &rarr;</a></div>";
  var body =
    "<section>" + setupBanner +
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
    "<section style=\"max-width:34rem;\">" +
      "<h2>Shop setup</h2>" +
      "<p class=\"meta\">Set the basics customers see across the storefront. You can change these any time.</p>" +
      saved + notice +
      "<form method=\"post\" action=\"/admin/setup\">" +
        _setupField("Shop name", "shop_name", v.shop_name, "text", "Shown in the header, page titles, and emails.", " maxlength=\"80\" required") +
        _setupField("Contact email", "contact_email", v.contact_email, "email", "Where customer replies and operational mail land.", " maxlength=\"160\"") +
        _setupField("Default currency", "currency", v.currency, "text", "3-letter ISO 4217 code (e.g. USD, EUR, GBP).", " maxlength=\"3\" style=\"text-transform:uppercase;max-width:8rem;\"") +
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
        "<thead><tr><th>Integration</th><th>Status</th><th>To enable</th></tr></thead>" +
        "<tbody>" + rows + "</tbody>" +
      "</table></div>" +
      "<p class=\"meta\" style=\"margin-top:1.25rem;\">Sign in with Apple and PayPal are planned. “Sign in with Shop” / Shop Pay isn't available to a self-hosted store. See the README “Optional integrations” section for full setup steps.</p>" +
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
    return "<tr><td><strong>" + _htmlEscape(p.title) + "</strong></td>" +
      "<td><code class=\"order-id\">" + _htmlEscape(p.slug) + "</code></td>" +
      "<td><span class=\"status-pill " + cls + "\">" + _htmlEscape(p.status) + "</span></td>" +
      "<td>" + action + "</td></tr>";
  }).join("");
  var table = products.length
    ? "<div class=\"panel\"><table><thead><tr><th>Title</th><th>Slug</th><th>Status</th><th>Action</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No products yet — create your first one below.</p>";
  var body =
    "<section><h2>Products</h2>" + created + notice + table +
      "<div class=\"panel\" style=\"margin-top:1.5rem; max-width:34rem;\">" +
        "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">New product</h3>" +
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
    ? "<div class=\"panel\"><table><thead><tr><th>Order</th><th>Status</th><th class=\"num\">Items</th><th class=\"num\">Total</th><th>Placed</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    : "<p class=\"empty\">No orders" + (active ? " with status “" + _htmlEscape(active) + "”" : " yet") + ".</p>";

  var body = "<section><h2>Orders</h2>" + notice + chips + table + "</section>";
  return _renderAdminShell(opts.shop_name, "Orders", body, "orders", opts.nav_available);
}

function renderAdminOrder(opts) {
  opts = opts || {};
  var o = opts.order;
  var transitions = opts.transitions || [];
  var moved  = opts.moved  ? "<div class=\"banner banner--ok\">Order updated.</div>" : "";
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
    ? "<table><thead><tr><th>SKU</th><th class=\"num\">Qty</th><th class=\"num\">Unit</th><th class=\"num\">Line</th></tr></thead><tbody>" + lineRows + "</tbody></table>"
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
      return "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/refund\" style=\"display:inline;\">" +
        "<button class=\"btn btn--danger\" type=\"submit\">" + _htmlEscape(t.label) + "</button>" +
        "</form>";
    }
    var danger = (t.on === "cancel");
    return "<form method=\"post\" action=\"/admin/orders/" + _htmlEscape(o.id) + "/transition\" style=\"display:inline;\">" +
      "<input type=\"hidden\" name=\"event\" value=\"" + _htmlEscape(t.on) + "\">" +
      "<button class=\"btn" + (danger ? " btn--danger" : "") + "\" type=\"submit\">" + _htmlEscape(t.label) + "</button>" +
      "</form>";
  }).filter(Boolean).join(" ");
  var actions = actionForms || "<span class=\"meta\">This order is in a final state — no further changes.</span>";

  var body =
    "<section style=\"max-width:48rem;\">" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/orders\">&larr; Orders</a></div>" +
      "<h2>Order <code class=\"order-id\">" + _htmlEscape(o.id.slice(0, 8)) + "</code> " +
        "<span class=\"status-pill " + _htmlEscape(o.status) + "\">" + _htmlEscape(o.status) + "</span></h2>" +
      "<p class=\"meta\">Placed " + _htmlEscape(_fmtDate(o.created_at)) + " · last updated " + _htmlEscape(_fmtDate(o.updated_at)) +
        (o.payment_intent_id ? " · payment <code class=\"order-id\">" + _htmlEscape(o.payment_intent_id) + "</code>" : "") + "</p>" +
      moved + notice +
      "<div class=\"two-col\">" +
        "<div class=\"panel\"><h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Items</h3>" + linesTable + "</div>" +
        "<div class=\"panel\"><h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Ship to</h3>" +
          (shipLines || "<span class=\"meta\">No shipping address.</span>") +
          "<h3 style=\"font-size:.95rem; margin:1.25rem 0 .75rem;\">Totals</h3>" + totals +
        "</div>" +
      "</div>" +
      "<div class=\"panel\" style=\"margin-top:1.5rem;\"><h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Actions</h3>" +
        "<div class=\"order-actions\">" + actions + "</div>" +
      "</div>" +
    "</section>";
  return _renderAdminShell(opts.shop_name, "Order " + o.id.slice(0, 8), body, "orders", opts.nav_available);
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
    ? "<div class=\"panel\"><table><thead><tr><th>RMA</th><th>Order</th><th>Reason</th><th>Status</th><th class=\"num\">Items</th><th class=\"num\">Refund</th><th>Requested</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
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
    ? "<table><thead><tr><th>SKU</th><th class=\"num\">Qty</th><th>Reason</th></tr></thead><tbody>" + lineRows + "</tbody></table>"
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
        _setupField("Refund currency", "refund_currency", r.refund_currency || "USD", "text", "3-letter ISO 4217.", " maxlength=\"3\" style=\"text-transform:uppercase;max-width:8rem;\"") +
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
    actionBlocks.push(
      "<form method=\"post\" action=\"/admin/returns/" + _htmlEscape(r.id) + "/refund\" class=\"return-action\">" +
        "<h4>Refund</h4><p class=\"meta\">Record the refund" + (refundShown ? " of " + _htmlEscape(refundShown) : "") + " for this return.</p>" +
        _setupField("Operator notes", "operator_notes", "", "text", "", " maxlength=\"500\"") +
        "<button class=\"btn\" type=\"submit\">Refund</button>" +
      "</form>");
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
    "<section style=\"max-width:48rem;\">" +
      "<div class=\"actions-row\"><a class=\"btn btn--ghost\" href=\"/admin/returns\">&larr; Returns</a></div>" +
      "<h2>Return <code class=\"order-id\">" + _htmlEscape(r.rma_code || r.id.slice(0, 8)) + "</code> " +
        "<span class=\"status-pill " + _returnPillClass(r.status) + "\">" + _htmlEscape(r.status) + "</span></h2>" +
      "<p class=\"meta\">Requested " + _htmlEscape(_fmtDate(r.created_at)) +
        " · order <a class=\"order-id\" href=\"/admin/orders/" + _htmlEscape(r.order_id) + "\">" + _htmlEscape(String(r.order_id).slice(0, 8)) + "</a></p>" +
      moved + notice +
      "<div class=\"two-col\">" +
        "<div class=\"panel\"><h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Items</h3>" + linesTable + "</div>" +
        "<div class=\"panel\"><h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Details</h3>" +
          _field("Reason", r.reason) +
          _field("Customer detail", r.reason_detail) +
          _field("Customer notes", r.customer_notes) +
          (refundShown ? _field("Refund", refundShown) : "") +
          (r.operator_notes ? _field("Operator notes", r.operator_notes) : "") +
          (r.rejected_reason ? _field("Rejection reason", r.rejected_reason) : "") +
        "</div>" +
      "</div>" +
      "<div class=\"panel\" style=\"margin-top:1.5rem;\"><h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Actions</h3>" +
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
    var pub = "<form method=\"post\" action=\"/admin/reviews/" + _htmlEscape(rv.id) + "/publish\" style=\"display:inline;\">" +
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
      "<td><code class=\"order-id\">" + _htmlEscape(r.sku) + "</code>" + (isLow ? " <span class=\"status-pill pending\">low</span>" : "") + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(r.stock_on_hand)) + "</td>" +
      "<td class=\"num\">" + _htmlEscape(String(r.stock_held)) + "</td>" +
      "<td class=\"num\"><strong>" + _htmlEscape(String(available)) + "</strong></td>" +
      "<td>" +
        "<form method=\"post\" action=\"/admin/inventory/" + _htmlEscape(r.sku) + "/restock\" class=\"inv-row-form\">" +
          "<input type=\"number\" name=\"qty\" min=\"1\" placeholder=\"+ qty\" style=\"width:6rem;\">" +
          "<input type=\"number\" name=\"threshold\" min=\"0\" value=\"" + _htmlEscape(thVal) + "\" placeholder=\"alert ≤\" title=\"low-stock threshold (blank clears)\" style=\"width:6rem;\">" +
          "<button class=\"btn btn--ghost\" type=\"submit\">Save</button>" +
        "</form>" +
      "</td></tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th>SKU</th><th class=\"num\">On hand</th><th class=\"num\">Held</th><th class=\"num\">Available</th><th>Restock / threshold</th></tr></thead><tbody>" + body + "</tbody></table></div>"
    : "<p class=\"empty\">No inventory rows" + (opts.low ? " below threshold" : " yet") + ".</p>";

  var createForm =
    "<div class=\"panel\" style=\"margin-top:1.5rem; max-width:34rem;\">" +
      "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Track a new SKU</h3>" +
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
      ? "<form method=\"post\" action=\"/admin/subscription-plans/" + _htmlEscape(p.id) + "/archive\" style=\"display:inline;\">" +
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
    ? "<div class=\"panel\"><table><thead><tr><th>Price / interval</th><th>Stripe price</th><th>Variant</th><th>Status</th><th>Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No subscription plans" + (af === "0" ? " archived" : af === "1" ? " active" : " yet") + ".</p>";

  var intervalOpts = ["month", "year", "week", "day"].map(function (iv) {
    return "<option value=\"" + iv + "\">" + iv + "</option>";
  }).join("");

  var createForm =
    "<div class=\"panel\" style=\"margin-top:1.5rem; max-width:34rem;\">" +
      "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Create a plan</h3>" +
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
        "<form method=\"post\" action=\"/admin/webhooks/" + _htmlEscape(e.id) + "/toggle\" style=\"display:inline;\"><button class=\"btn btn--ghost\" type=\"submit\">" + (isActive ? "Disable" : "Enable") + "</button></form> " +
        "<form method=\"post\" action=\"/admin/webhooks/" + _htmlEscape(e.id) + "/delete\" style=\"display:inline;\"><button class=\"btn btn--danger\" type=\"submit\">Delete</button></form>" +
      "</td></tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th>URL</th><th>Events</th><th>Status</th><th class=\"num\">Rate</th><th>Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
    : "<p class=\"empty\">No webhook endpoints yet.</p>";

  var eventChecks = known.map(function (ev) {
    return "<label style=\"display:block; margin:.3rem 0;\"><input type=\"checkbox\" name=\"evt_" + _htmlEscape(ev) + "\"> <code>" + _htmlEscape(ev) + "</code></label>";
  }).join("");

  var createForm =
    "<div class=\"panel\" style=\"margin-top:1.5rem; max-width:40rem;\">" +
      "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Add an endpoint</h3>" +
      "<p class=\"meta\">Deliveries are signed (HMAC-SHA3-512); the signing secret is shown once, right after you create the endpoint. Only https:// URLs are accepted.</p>" +
      "<form method=\"post\" action=\"/admin/webhooks\">" +
        _setupField("Endpoint URL", "url", "", "url", "Where deliveries are POSTed (https:// only).", " maxlength=\"2048\" required") +
        "<fieldset style=\"border:1px solid var(--hair); border-radius:.5rem; padding:.75rem 1rem; margin:1rem 0;\">" +
          "<legend style=\"padding:0 .4rem; font-size:.85rem;\">Events</legend>" +
          "<label style=\"display:block; margin:.3rem 0;\"><input type=\"checkbox\" name=\"events_all\"> <strong>All events (*)</strong></label>" +
          eventChecks +
          "<small style=\"color:var(--mute);\">Pick specific events, or check “All events” to subscribe to everything.</small>" +
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
    "<section style=\"max-width:42rem;\">" +
      "<h2>Endpoint created</h2>" +
      "<div class=\"banner banner--ok\">Copy the signing secret now — it is shown once and cannot be retrieved again.</div>" +
      "<div class=\"panel\">" +
        "<p class=\"meta\">Endpoint</p><p><code class=\"order-id\">" + _htmlEscape(e.url || "") + "</code></p>" +
        "<p class=\"meta\">Signing secret (HMAC-SHA3-512, key id <code>v1</code>)</p>" +
        "<pre style=\"white-space:pre-wrap; word-break:break-all; background:var(--bg); border:1px solid var(--hair); border-radius:.5rem; padding:.75rem;\"><code>" + _htmlEscape(e.secret || "") + "</code></pre>" +
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
      : "<form method=\"post\" action=\"/admin/webhooks/deliveries/" + _htmlEscape(d.id) + "/retry\" style=\"display:inline;\"><button class=\"btn btn--ghost\" type=\"submit\">Retry</button></form>";
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
    ? "<div class=\"panel\"><table><thead><tr><th>Event</th><th>Status</th><th class=\"num\">Code</th><th class=\"num\">Attempts</th><th>Last error</th><th>Created</th><th></th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
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
          "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(encodeURIComponent(c.slug)) + "/archive\" style=\"display:inline;\">" +
            "<button class=\"btn btn--danger\" type=\"submit\">Archive</button></form>") +
      "</div></td>" +
    "</tr>";
  }).join("");

  var table = rows.length
    ? "<div class=\"panel\"><table><thead><tr><th>Title</th><th>Slug</th><th>Type</th><th>Status</th><th class=\"num\">Products</th><th>Actions</th></tr></thead><tbody>" + bodyRows + "</tbody></table></div>"
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
    "<div class=\"panel\" style=\"margin-top:1.5rem; max-width:40rem;\">" +
      "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Create a collection</h3>" +
      "<p class=\"meta\">Manual collections are handpicked; smart collections match products by a rule set. Slug is the storefront URL (/collections/&lt;slug&gt;).</p>" +
      "<form method=\"post\" action=\"/admin/collections\">" +
        "<label class=\"form-field\"><span>Type</span><select name=\"type\">" +
          "<option value=\"manual\"" + (startType === "manual" ? " selected" : "") + ">manual</option>" +
          "<option value=\"smart\""  + (startType === "smart"  ? " selected" : "") + ">smart</option>" +
        "</select></label>" +
        _setupField("Title", "title", "", "text", "", " maxlength=\"500\" required") +
        _setupField("Slug", "slug", "", "text", "Lowercase, hyphenated.", " maxlength=\"200\" required") +
        _setupField("Description (optional)", "description", "", "text", "", " maxlength=\"2000\"") +
        "<fieldset style=\"border:1px solid var(--hair); border-radius:.5rem; padding:.75rem 1rem; margin:1rem 0;\">" +
          "<legend style=\"padding:0 .4rem; font-size:.85rem;\">Smart rule (used only for smart collections)</legend>" +
          "<div class=\"actions-row\">" +
            "<select name=\"rule_field\"><option value=\"\">field…</option>" + fieldOpts + "</select>" +
            "<select name=\"rule_op\"><option value=\"\">op…</option>" + opOpts + "</select>" +
            "<input type=\"text\" name=\"rule_value\" placeholder=\"value (lists + between: comma-separated)\" maxlength=\"500\">" +
          "</div>" +
          "<small style=\"color:var(--mute);\">Numeric fields (price_minor, inventory_count, created_at) compare as integers. Add more rules after creating.</small>" +
        "</fieldset>" +
        "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Create collection</button></div>" +
      "</form>" +
    "</div>";

  var bodyHtml = "<section><h2>Collections</h2>" + created + archived + notice + chips + table + createForm + "</section>";
  return _renderAdminShell(opts.shop_name, "Collections", bodyHtml, "collections", opts.nav_available);
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
    "<div class=\"panel\" style=\"max-width:40rem;\">" +
      "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Details</h3>" +
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
      return "<div class=\"actions-row\" style=\"margin:.4rem 0;\">" +
        "<select name=\"rule_field\">" + fieldOpts + "</select>" +
        "<select name=\"rule_op\">" + opOpts + "</select>" +
        "<input type=\"text\" name=\"rule_value\" value=\"" + _htmlEscape(String(rv)) + "\" placeholder=\"value\" maxlength=\"500\">" +
      "</div>";
    }).join("");
    editForm +=
      "<fieldset style=\"border:1px solid var(--hair); border-radius:.5rem; padding:.75rem 1rem; margin:1rem 0;\">" +
        "<legend style=\"padding:0 .4rem; font-size:.85rem;\">Rules (all must match)</legend>" +
        ruleRows +
        "<small style=\"color:var(--mute);\">Leave a row blank to drop it. Lists (in / not_in) + between use comma-separated values.</small>" +
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
        "<td><form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/members/remove\" style=\"display:inline;\">" +
          "<input type=\"hidden\" name=\"product_id\" value=\"" + _htmlEscape(m.product_id) + "\">" +
          "<button class=\"btn btn--danger\" type=\"submit\">Remove</button></form></td>" +
      "</tr>";
    }).join("");
    var memberTable = members.length
      ? "<div class=\"panel\"><table><thead><tr><th class=\"num\">#</th><th>Product id</th><th></th></tr></thead><tbody>" + memberRows + "</tbody></table></div>"
      : "<p class=\"empty\">No members yet — add a product below.</p>";

    // Reorder: a single field of the current ids, comma-joined, that the
    // operator can rewrite into the new order. v1-defensible without
    // client JS — the primitive normalises positions to 0..N-1.
    var currentIds = members.map(function (m) { return m.product_id; }).join(",");
    var reorderForm = members.length > 1
      ? "<div class=\"panel\" style=\"margin-top:1rem; max-width:40rem;\">" +
          "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Reorder members</h3>" +
          "<p class=\"meta\">Rewrite the comma-separated id list into the order you want. Must list every current member.</p>" +
          "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/members/reorder\">" +
            "<label class=\"form-field\"><span>Ordered product ids</span>" +
              "<input type=\"text\" name=\"ordered_product_ids\" value=\"" + _htmlEscape(currentIds) + "\"></label>" +
            "<div class=\"actions-row\"><button class=\"btn btn--ghost\" type=\"submit\">Apply order</button></div>" +
          "</form>" +
        "</div>"
      : "";

    var addForm =
      "<div class=\"panel\" style=\"margin-top:1rem; max-width:40rem;\">" +
        "<h3 style=\"font-size:.95rem; margin-bottom:.75rem;\">Add a member</h3>" +
        "<form method=\"post\" action=\"/admin/collections/" + _htmlEscape(enc) + "/members/add\">" +
          _setupField("Product id", "product_id", "", "text", "The catalog product's UUID.", " maxlength=\"64\" required") +
          "<div class=\"actions-row\"><button class=\"btn\" type=\"submit\">Add product</button></div>" +
        "</form>" +
      "</div>";

    detailBody = "<section style=\"margin-top:1.5rem;\"><h3 style=\"font-size:1.05rem;\">Members</h3>" +
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
      ? "<div class=\"panel\"><table><thead><tr><th>Title</th><th>Slug</th><th>Status</th></tr></thead><tbody>" + previewCards + "</tbody></table></div>"
      : "<p class=\"empty\">No products match these rules yet.</p>";
    detailBody = "<section style=\"margin-top:1.5rem;\"><h3 style=\"font-size:1.05rem;\">Matched products (live preview)</h3>" +
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

module.exports = {
  mount:           mount,
  AUDIT_NAMESPACE: AUDIT_NAMESPACE,
  renderDashboard: renderDashboard,
  renderAdminLogin:        renderAdminLogin,
  renderAdminLanding:      renderAdminLanding,
  renderAdminSetup:        renderAdminSetup,
  renderAdminIntegrations: renderAdminIntegrations,
  renderAdminProducts:     renderAdminProducts,
  renderAdminInventory:    renderAdminInventory,
  renderAdminOrders:       renderAdminOrders,
  renderAdminOrder:        renderAdminOrder,
  renderAdminReturns:      renderAdminReturns,
  renderAdminReturn:       renderAdminReturn,
  renderAdminReviews:      renderAdminReviews,
  renderAdminCollections:  renderAdminCollections,
  renderAdminCollection:   renderAdminCollection,
};
