"use strict";
/**
 * Cookie-prefix hardening — full HTTP integration of the `__Host-` /
 * `__Secure-` prefix invariants on the session / auth / admin cookies.
 *
 * The prefix is a browser-enforced integrity marker that must move in
 * lockstep with the Secure attribute:
 *
 *   - https (public TLS, signalled to the container by the Worker's
 *     `x-forwarded-proto: https`) → the PREFIXED name with Secure +
 *     Path=/ (and no Domain for `__Host-`), which a browser will store.
 *   - http  (local dev + this harness) → the BARE name with Secure OFF,
 *     because a real browser silently drops a Secure cookie over http and
 *     refuses a prefixed cookie that isn't Secure — so the bare name is
 *     the only thing that keeps a dev/e2e session working.
 *
 * Read sites resolve the prefixed name first and the bare name second, so
 * a request finds its session regardless of which environment wrote it.
 *
 * This boots the storefront + admin over http (like every other layer-2
 * flow), then drives the two protocols by toggling the forwarded-proto
 * header on the request: the bare path is the default; the prefixed path
 * sends `x-forwarded-proto: https`. Network: zero — every request lands
 * on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var ADMIN_TOKEN = "admin-token-0123456789abcdef-test"; // ≥ 16 chars

var SF_MIGS = ["0001_catalog.sql", "0002_cart.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });
var ADMIN_MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  return text.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function _makeQuery(migs) {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  migs.forEach(function (p) {
    _splitSchema(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

// Pull the raw Set-Cookie line whose cookie name matches `nameRe` from a
// response's `set-cookie` header (string or array). Returns the line or
// null. The match is on the leading `name=` token so an attribute value
// elsewhere on a different cookie can't false-positive.
function _setCookieLine(headers, nameRe) {
  var raw = headers && headers["set-cookie"];
  if (!raw) return null;
  var list = Array.isArray(raw) ? raw : [raw];
  for (var i = 0; i < list.length; i += 1) {
    var line = String(list[i]);
    var name = line.split("=")[0].trim();
    if (nameRe.test(name)) return line;
  }
  return null;
}

async function _seedCatalog(catalog) {
  var product = await catalog.products.create({ slug: "prefix-widget", title: "Prefix Widget", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "PFX-1", title: "Default" });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2500 });
  return { product: product, variant: variant };
}

async function _bootStorefront(catalog, cart) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-cookie-sf-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, { catalog: catalog, cart: cart });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _bootAdmin(query) {
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "cookie-prefix-admin" });
  var config  = bShop.config.create({ query: query });
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-cookie-adm-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: ADMIN_TOKEN, catalog: catalog, order: order, config: config,
        shop_name: "Prefix Shop", integrations: {},
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var sfQuery = _makeQuery(SF_MIGS);
  var catalog = bShop.catalog.create({ query: sfQuery });
  var cart    = bShop.cart.create({ query: sfQuery, catalog: catalog });
  var seeded  = await _seedCatalog(catalog);

  var sf    = await _bootStorefront(catalog, cart);
  var admin = await _bootAdmin(_makeQuery(ADMIN_MIGS));

  try {
    // ---- storefront session cookie: http path (bare, no Secure) --------
    var httpJar = helpers.cookieJar();
    var addHttp = await helpers.httpRequest({
      port: sf.port, path: "/cart/lines", method: "POST",
      form: { variant_id: seeded.variant.id, qty: 1 }, jar: httpJar,
    });
    check("http add-to-cart 303",                 addHttp.status === 303);
    var httpSid = _setCookieLine(addHttp.headers, /^shop_sid$/);
    check("http emits BARE shop_sid",             httpSid !== null);
    check("http shop_sid is NOT __Host- prefixed", _setCookieLine(addHttp.headers, /^__Host-shop_sid$/) === null);
    check("http shop_sid carries NO Secure",      httpSid !== null && !/;\s*Secure/i.test(httpSid));
    check("http jar stores bare name",            !!httpJar.get("shop_sid"));

    // ---- storefront session cookie: https path (__Host-, Secure) -------
    // `x-forwarded-proto: https` is what the Cloudflare Worker forwards to
    // the container when the public connection is TLS. `trustProxy` in the
    // shop's protocol read honours it, so the cookie hardens to `__Host-`.
    var httpsJar = helpers.cookieJar();
    var addHttps = await helpers.httpRequest({
      port: sf.port, path: "/cart/lines", method: "POST",
      headers: { "x-forwarded-proto": "https" },
      form: { variant_id: seeded.variant.id, qty: 1 }, jar: httpsJar,
    });
    check("https add-to-cart 303",                addHttps.status === 303);
    var hostSid = _setCookieLine(addHttps.headers, /^__Host-shop_sid$/);
    check("https emits __Host-shop_sid",          hostSid !== null);
    check("https does NOT emit bare shop_sid",    _setCookieLine(addHttps.headers, /^shop_sid$/) === null);
    // The `__Host-` invariant the browser enforces before STORING the
    // cookie: Secure + Path=/ + no Domain. Get any of these wrong and prod
    // has zero working sessions, so assert each explicitly.
    check("__Host-shop_sid carries Secure",       hostSid !== null && /;\s*Secure/i.test(hostSid));
    check("__Host-shop_sid carries Path=/",       hostSid !== null && /;\s*Path=\/(?:;|\s*$)/i.test(hostSid));
    check("__Host-shop_sid carries NO Domain",    hostSid !== null && !/;\s*Domain=/i.test(hostSid));

    // ---- read resolution: prefixed name resolves over https ------------
    // Re-issue the cart-count read carrying ONLY the `__Host-` cookie the
    // https write just set; the count must reflect the bound session (1
    // line), proving the read side resolves the prefixed name.
    var hostCount = await helpers.httpRequest({
      port: sf.port, path: "/cart/count",
      headers: { "x-forwarded-proto": "https" }, jar: httpsJar,
    });
    check("https /cart/count 200",                hostCount.status === 200);
    check("__Host- cookie resolves to the cart",  JSON.parse(hostCount.body).count === 1);

    // ---- read resolution: bare-name fallback even over https -----------
    // A request that still carries the OLD bare cookie (mid-rollout) must
    // resolve too. Forge a bare-named jar pointing at the same session id
    // and read /cart/count over https — the bare fallback must find it.
    var sidValue = decodeURIComponent(String(hostSid).split("=")[1].split(";")[0]);
    var bareFallbackJar = helpers.cookieJar();
    bareFallbackJar.capture({ "set-cookie": ["shop_sid=" + sidValue + "; Path=/"] });
    var bareCount = await helpers.httpRequest({
      port: sf.port, path: "/cart/count",
      headers: { "x-forwarded-proto": "https" }, jar: bareFallbackJar,
    });
    check("bare cookie resolves over https too",  JSON.parse(bareCount.body).count === 1);

    // ---- admin session cookie: http path (bare, no Secure) -------------
    var admHttpJar = helpers.cookieJar();
    var admHttp = await helpers.httpRequest({
      port: admin.port, path: "/admin/login", method: "POST",
      form: { token: ADMIN_TOKEN }, jar: admHttpJar,
    });
    check("http admin login 303",                 admHttp.status === 303);
    var admHttpLine = _setCookieLine(admHttp.headers, /^shop_admin$/);
    check("http emits BARE shop_admin",           admHttpLine !== null);
    check("http shop_admin NOT __Secure- prefixed", _setCookieLine(admHttp.headers, /^__Secure-shop_admin$/) === null);
    check("http shop_admin carries NO Secure",    admHttpLine !== null && !/;\s*Secure/i.test(admHttpLine));
    // The bare-name admin session authenticates the dashboard over http.
    var admDash = await helpers.httpRequest({ port: admin.port, path: "/admin", jar: admHttpJar });
    check("http admin cookie authenticates",      admDash.status === 200 && admDash.body.indexOf("Admin API key") === -1);

    // ---- admin session cookie: https path (__Secure-, Secure) ----------
    // The admin cookie is Path=/admin so it CANNOT be `__Host-` (which
    // mandates Path=/); the correct hardened prefix is `__Secure-`, which
    // requires only Secure.
    var admHttpsJar = helpers.cookieJar();
    var admHttps = await helpers.httpRequest({
      port: admin.port, path: "/admin/login", method: "POST",
      headers: { "x-forwarded-proto": "https" },
      form: { token: ADMIN_TOKEN }, jar: admHttpsJar,
    });
    check("https admin login 303",                admHttps.status === 303);
    var admSecureLine = _setCookieLine(admHttps.headers, /^__Secure-shop_admin$/);
    check("https emits __Secure-shop_admin",      admSecureLine !== null);
    check("https does NOT emit bare shop_admin",  _setCookieLine(admHttps.headers, /^shop_admin$/) === null);
    check("__Secure-shop_admin carries Secure",   admSecureLine !== null && /;\s*Secure/i.test(admSecureLine));
    check("__Secure-shop_admin keeps Path=/admin", admSecureLine !== null && /;\s*Path=\/admin/i.test(admSecureLine));
    // The prefixed cookie authenticates the dashboard over https.
    var admDashHttps = await helpers.httpRequest({
      port: admin.port, path: "/admin",
      headers: { "x-forwarded-proto": "https" }, jar: admHttpsJar,
    });
    check("__Secure- admin cookie authenticates", admDashHttps.status === 200 && admDashHttps.body.indexOf("Admin API key") === -1);
  } finally {
    await _teardown(sf);
    await _teardown(admin);
  }
}

module.exports = { run: _run };
