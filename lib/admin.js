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

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

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
  return _b().template.escapeHtml(String(s));
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
  return _b().crypto.timingSafeEqual(token, expected);
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
    _adminJarMemo = _b().cookies.create({
      vault:    _b().vault,
      defaults: { httpOnly: true, secure: true, sameSite: "Strict", path: "/admin" },
    });
  }
  return _adminJarMemo;
}

function _setAdminCookie(res) {
  _adminJar().writeSealed(res, ADMIN_COOKIE_NAME, JSON.stringify({
    admin: true,
    exp:   Date.now() + _b().constants.TIME.hours(12),
  }), { expires: new Date(Date.now() + _b().constants.TIME.hours(12)) });
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
  return _b().problemDetails.send(res, {
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
        _b().audit.safeEmit({
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

  try { _b().audit.registerNamespace(AUDIT_NAMESPACE); } catch (_e) { /* idempotent */ }

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
            shop_name: deps.shop_name, products: page.rows || [],
            notice: (e && e.message) || "Couldn't create that product.",
          }));
        }
        throw e;
      }
      _b().audit.safeEmit({ action: AUDIT_NAMESPACE + ".product.create", outcome: "success", metadata: {} });
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
      _sendHtml(res, 200, renderAdminProducts({ shop_name: deps.shop_name, products: page.rows || [], created: created }));
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
        _b().audit.safeEmit({ action: AUDIT_NAMESPACE + "." + audit, outcome: "success", metadata: { id: req.params.id } });
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

  router.post("/admin/inventory", W("inventory.create", async function (req, res) {
    var body = req.body || {};
    if (!body.sku) throw new TypeError("admin.inventory.create: body.sku required");
    var inv = await catalog.inventory.create(body.sku, body);
    _json(res, 201, inv);
    return Object.assign({ id: body.sku }, inv);
  }));

  router.post("/admin/inventory/:sku/restock", W("inventory.restock", async function (req, res) {
    var qty = parseInt((req.body || {}).qty, 10);
    if (!Number.isFinite(qty)) throw new TypeError("admin.inventory.restock: body.qty required (integer)");
    var inv = await catalog.inventory.restock(req.params.sku, qty);
    if (!inv) return _problem(res, 404, "inventory-not-found");
    _json(res, 200, inv);
    return Object.assign({ id: req.params.sku }, inv);
  }));

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
        fetched = await _b().httpClient.request({
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
      var id  = _b().uuid.v7();
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
        shop_name: deps.shop_name, orders: list.rows || [],
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
        shop_name: deps.shop_name, orders: [], notice: "Order not found.",
      }));
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      _sendHtml(res, 200, renderAdminOrder({
        shop_name:   deps.shop_name,
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
      _b().audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.transition", outcome: "success", metadata: { id: id, event: event } });
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
      var refundIdempotencyKey = "refund:" + o.id + ":" + (body.idempotency_suffix || _b().uuid.v7());
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
        _b().audit.safeEmit({ action: AUDIT_NAMESPACE + ".order.refund", outcome: "success", metadata: { id: id } });
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
    router.get("/admin/reviews", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var status = (url && url.searchParams.get("status")) || "pending";
      var cursor = url && url.searchParams.get("cursor");
      var limitS = url && url.searchParams.get("limit");
      var limit  = limitS == null ? undefined : parseInt(limitS, 10);
      var page = await reviews.listByStatus(status, { cursor: cursor || undefined, limit: limit });
      _json(res, 200, page);
    }));

    router.get("/admin/reviews/:id", R(async function (req, res) {
      var rev = await reviews.get(req.params.id);
      if (!rev) return _problem(res, 404, "review-not-found");
      _json(res, 200, rev);
    }));

    router.post("/admin/reviews/:id/publish", W("review.publish", async function (req, res) {
      var rev;
      try {
        rev = await reviews.publish(req.params.id);
      } catch (e) {
        if (e && e.code === "REVIEW_NOT_FOUND") return _problem(res, 404, "review-not-found");
        throw e;
      }
      _json(res, 200, rev);
      return rev;
    }));

    router.post("/admin/reviews/:id/reject", W("review.reject", async function (req, res) {
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
    }));
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
          shop_name: deps.shop_name, returns: rows, status: status, notice: notice,
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
          shop_name: deps.shop_name, returns: [], status: "pending", notice: "Return not found.",
        }));
        var url = req.url ? new URL(req.url, "http://localhost") : null;
        _sendHtml(res, 200, renderAdminReturn({
          shop_name:   deps.shop_name,
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
        _b().audit.safeEmit({ action: AUDIT_NAMESPACE + "." + auditEvent, outcome: "success", metadata: { id: id } });
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
        // Browser form fields arrive as strings — coerce the amount to an
        // integer minor value (a bad value throws → notice via _returnAction).
        var amount = parseInt(body.refund_amount_minor, 10);
        return returns.approve(id, {
          refund_amount_minor: Number.isNaN(amount) ? body.refund_amount_minor : amount,
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
    router.post("/admin/webhooks", W("webhook.create", async function (req, res) {
      var body = req.body || {};
      var ep = await webhooks.endpoints.create({ url: body.url, events: body.events });
      _json(res, 201, ep);
      return ep;
    }));

    router.get("/admin/webhooks", R(async function (_req, res) {
      var rows = await webhooks.endpoints.list();
      _json(res, 200, { rows: rows });
    }));

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

    router.get("/admin/webhooks/:id/deliveries", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var limitS = url && url.searchParams.get("limit");
      var limit  = limitS == null ? 50 : parseInt(limitS, 10);
      var rows = await webhooks.deliveries.list(req.params.id, { limit: limit });
      _json(res, 200, { rows: rows });
    }));

    router.post("/admin/webhooks/deliveries/:id/retry", W("webhook.retry", async function (req, res) {
      var d = await webhooks.deliveries.retry(req.params.id);
      if (!d) return _problem(res, 404, "delivery-not-found");
      _json(res, 200, d);
      return { id: req.params.id };
    }));
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
      }));
    });
  }

  // ---- subscriptions --------------------------------------------------

  var subscriptions = deps.subscriptions || null;
  if (subscriptions) {
    router.post("/admin/subscription-plans", W("subscription_plan.create", async function (req, res) {
      var p = await subscriptions.plans.create(req.body || {});
      _json(res, 201, p);
      return p;
    }));

    router.get("/admin/subscription-plans", R(async function (req, res) {
      var url = req.url ? new URL(req.url, "http://localhost") : null;
      var variantId = url && url.searchParams.get("variant_id");
      var activeS   = url && url.searchParams.get("active");
      var filter = {};
      if (variantId) filter.variant_id = variantId;
      if (activeS != null) filter.active = activeS === "1" || activeS === "true";
      var rows = await subscriptions.plans.list(filter);
      _json(res, 200, { rows: rows });
    }));

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

    router.post("/admin/subscription-plans/:id/archive", W("subscription_plan.archive", async function (req, res) {
      var p = await subscriptions.plans.archive(req.params.id);
      if (!p) return _problem(res, 404, "subscription-plan-not-found");
      _json(res, 200, p);
      return p;
    }));

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

    router.post("/admin/subscriptions/:id/cancel", W("subscription.cancel", async function (req, res) {
      var body = req.body || {};
      var s = await subscriptions.subscriptions.cancel(req.params.id, { at_period_end: !!body.at_period_end });
      if (!s) return _problem(res, 404, "subscription-not-found");
      _json(res, 200, s);
      return s;
    }));
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
      _sendHtml(res, 200, renderAdminSetup({ shop_name: deps.shop_name, values: values, saved: saved }));
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
        var emailReport = _b().guardEmail.validate(values.contact_email, { profile: "strict" });
        if (!emailReport || emailReport.ok === false) notice = "That contact email doesn't look valid.";
      }
      if (!notice && values.support_url) {
        var u = _b().safeUrl.parse(values.support_url);
        if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) notice = "Support URL must be a valid http(s) URL.";
      }
      if (notice) {
        return _sendHtml(res, 400, renderAdminSetup({ shop_name: deps.shop_name, values: values, notice: notice }));
      }
      try {
        await config.put("shop.name", values.shop_name);
        if (values.contact_email) await config.put("shop.contact_email", values.contact_email);
        if (values.currency)      await config.put("shop.currency", values.currency);
        if (values.support_url)   await config.put("shop.support_url", values.support_url);
        await config.put("setup.completed", true);
      } catch (e) {
        return _sendHtml(res, 500, renderAdminSetup({
          shop_name: deps.shop_name, values: values,
          notice: "Couldn't save — " + ((e && e.message) || "please try again."),
        }));
      }
      _b().audit.safeEmit({ action: AUDIT_NAMESPACE + ".setup.save", outcome: "success", metadata: {} });
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
var ADMIN_NAV_ITEMS = [
  { key: "home",         href: "/admin",              label: "Home" },
  { key: "dashboard",    href: "/admin/dashboard",    label: "Dashboard" },
  { key: "products",     href: "/admin/products",     label: "Products" },
  { key: "orders",       href: "/admin/orders",       label: "Orders" },
  { key: "returns",      href: "/admin/returns",      label: "Returns" },
  { key: "integrations", href: "/admin/integrations", label: "Integrations" },
  { key: "setup",        href: "/admin/setup",        label: "Setup" },
];
function _adminNav(active) {
  if (active === null || active === undefined || active === false) return "";
  var links = ADMIN_NAV_ITEMS.map(function (it) {
    return "<a href=\"" + it.href + "\"" + (it.key === active ? " class=\"active\"" : "") + ">" +
      _htmlEscape(it.label) + "</a>";
  }).join("");
  return "<nav class=\"admin-nav\"><div class=\"admin-nav__inner\">" + links + "</div></nav>";
}

function _renderAdminShell(shopName, subtitle, bodyHtml, active) {
  return _renderTemplate(DASHBOARD_LAYOUT, {
    shop_name:    shopName || "blamejs.shop",
    window_label: subtitle || "",
    nav:          "RAW_NAV",
    body:         "RAW_BODY",
  }).replace("RAW_NAV", _adminNav(active)).replace("RAW_BODY", bodyHtml);
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
  return _renderAdminShell(opts.shop_name, "", body, "home");
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
  return _renderAdminShell(opts.shop_name, "Setup", body, "setup");
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
  return _renderAdminShell(opts.shop_name, "Integrations", body, "integrations");
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
  return _renderAdminShell(opts.shop_name, "Products", body, "products");
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
  return _renderAdminShell(opts.shop_name, "Orders", body, "orders");
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
  return _renderAdminShell(opts.shop_name, "Order " + o.id.slice(0, 8), body, "orders");
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
  return _renderAdminShell(opts.shop_name, "Returns", body, "returns");
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
  return _renderAdminShell(opts.shop_name, "Return " + (r.rma_code || r.id.slice(0, 8)), body, "returns");
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
  renderAdminOrders:       renderAdminOrders,
  renderAdminOrder:        renderAdminOrder,
  renderAdminReturns:      renderAdminReturns,
  renderAdminReturn:       renderAdminReturn,
};
