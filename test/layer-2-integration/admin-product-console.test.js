"use strict";
/**
 * Product detail console — the browser-side admin manager for a single
 * catalog product: its fields, variants, prices, and media.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config),
 * seeds a product, then exercises the detail page (HTML + JSON), the
 * product-fields edit POST alias, the variant create / edit / delete
 * flow (with the server-rendered delete confirm step), the price-set
 * form (current + append-only history), media attach-by-key + the delete
 * confirm step, the bearer JSON contract on each canonical route, and
 * the auth gate. Network: zero (media upload-from-URL needs the R2
 * bridge, which isn't wired here — covered by the unit-level upload
 * route; the attach-by-key path is the no-bridge media path).
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

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "product-console" });
  var order   = bShop.order.create({ query: query, cursorSecret: "product-console" });
  var config  = bShop.config.create({ query: query });

  // A default currency so the price form pre-fills it.
  await config.put("shop.currency", "EUR");

  var prod = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", status: "draft" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-product-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var P = "/admin/products/" + prod.id;

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Product list now links the title to the detail screen.
    var list = await helpers.httpRequest({ port: port, path: "/admin/products", jar: jar });
    check("product list links to detail",        list.body.indexOf("href=\"/admin/products/" + prod.id + "\"") !== -1);

    // Detail page renders for the browser; bearer gets JSON of the model.
    var detail = await helpers.httpRequest({ port: port, path: P, jar: jar });
    check("detail page then 200",                detail.status === 200);
    check("detail shows the title",              detail.body.indexOf("Widget Pro") !== -1);
    check("detail shows the edit form",          detail.body.indexOf("action=\"" + P + "/edit\"") !== -1);
    check("detail shows add-variant form",       detail.body.indexOf(P + "/variants/create") !== -1);
    check("detail shows attach-media form",      detail.body.indexOf(P + "/media/attach") !== -1);
    check("detail price form defaults currency", detail.body.indexOf("value=\"EUR\"") !== -1 || detail.body.indexOf("No variants") !== -1);
    var detailApi = await helpers.httpRequest({ port: port, path: P, headers: bearer });
    check("detail API JSON",                     (detailApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var model = JSON.parse(detailApi.body);
    check("detail API has product + variants",   model.product.id === prod.id && Array.isArray(model.variants));

    // Edit the product fields via the browser form → 303 saved; persists.
    var edit = await helpers.httpRequest({
      port: port, path: P + "/edit", method: "POST", jar: jar,
      form: { slug: "widget-pro", title: "Widget Pro X", description: "Now bigger", status: "active" },
    });
    check("product edit then 303",               edit.status === 303);
    check("product edit redirects saved",        (edit.headers.location || "").indexOf("saved=1") !== -1);
    var afterEdit = await catalog.products.get(prod.id);
    check("product fields persisted",            afterEdit.title === "Widget Pro X" && afterEdit.status === "active" && afterEdit.description === "Now bigger");

    // Bearer PATCH still works (JSON contract unchanged).
    var apiPatch = await helpers.httpRequest({
      port: port, path: P, method: "PATCH",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ title: "Widget Pro X2" }),
    });
    check("bearer PATCH returns 200 JSON",       apiPatch.status === 200 && JSON.parse(apiPatch.body).title === "Widget Pro X2");

    // Create a variant via the browser form → 303 saved; persists with
    // parsed options + coerced weight / requires_shipping.
    var createVar = await helpers.httpRequest({
      port: port, path: P + "/variants/create", method: "POST", jar: jar,
      form: { sku: "WID-L-BLUE", title: "Large / Blue", options: "size=L, color=blue", weight_grams: "250", requires_shipping: "1" },
    });
    check("variant create then 303",             createVar.status === 303);
    check("variant create redirects saved",      (createVar.headers.location || "").indexOf("saved=1") !== -1);
    var variants = await catalog.variants.listForProduct(prod.id);
    check("variant persisted",                   variants.length === 1 && variants[0].sku === "WID-L-BLUE");
    check("variant options parsed",              variants[0].options.size === "L" && variants[0].options.color === "blue");
    check("variant weight coerced",              variants[0].weight_grams === 250);
    var variant = variants[0];
    var V = "/admin/variants/" + variant.id;

    // A bad variant create (missing sku) is a ?err=1 notice, never a 500.
    var badVar = await helpers.httpRequest({
      port: port, path: P + "/variants/create", method: "POST", jar: jar,
      form: { title: "no sku" },
    });
    check("bad variant create flags err",        (badVar.headers.location || "").indexOf("err=1") !== -1);

    // The detail page now renders the variant + its price form.
    var detail2 = await helpers.httpRequest({ port: port, path: P, jar: jar });
    check("detail shows the variant sku",        detail2.body.indexOf("WID-L-BLUE") !== -1);
    check("detail shows the price-set form",     detail2.body.indexOf(V + "/prices/set") !== -1);
    check("detail shows the variant edit form",  detail2.body.indexOf(V + "/edit") !== -1);

    // Set a price via the browser form → 303 saved; current + history.
    var setPrice = await helpers.httpRequest({
      port: port, path: V + "/prices/set", method: "POST", jar: jar,
      form: { currency: "usd", amount_minor: "2999" },
    });
    check("price set then 303",                  setPrice.status === 303);
    var cur1 = await catalog.prices.current(variant.id, "USD");
    check("price persisted (uppercased cur)",    cur1 && cur1.amount_minor === 2999);

    // Set a new price → prior version retained in history.
    await helpers.httpRequest({
      port: port, path: V + "/prices/set", method: "POST", jar: jar,
      form: { currency: "USD", amount_minor: "2499" },
    });
    var hist = await catalog.prices.history(variant.id, "USD");
    check("price history append-only",           hist.length === 2 && hist[0].amount_minor === 2499);

    // Detail shows current price + history.
    var detail3 = await helpers.httpRequest({ port: port, path: P, jar: jar });
    check("detail shows current price",          detail3.body.indexOf("24.99") !== -1);
    check("detail shows price history",          detail3.body.indexOf("29.99") !== -1);

    // A non-integer amount is a ?err=1 notice (strict int reader), not a 500.
    var badPrice = await helpers.httpRequest({
      port: port, path: V + "/prices/set", method: "POST", jar: jar,
      form: { currency: "USD", amount_minor: "29.99" },
    });
    check("non-integer price flags err",         (badPrice.headers.location || "").indexOf("err=1") !== -1);

    // Bearer price route still 201 JSON (contract unchanged).
    var apiPrice = await helpers.httpRequest({
      port: port, path: V + "/prices", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ currency: "GBP", amount_minor: 1999 }),
    });
    check("bearer price set returns 201 JSON",   apiPrice.status === 201);

    // Edit the variant via the browser form → 303 saved; persists.
    var editVar = await helpers.httpRequest({
      port: port, path: V + "/edit", method: "POST", jar: jar,
      form: { sku: "WID-L-BLUE", title: "Large / Navy", options: "size=L, color=navy", weight_grams: "260", requires_shipping: "0" },
    });
    check("variant edit then 303",               editVar.status === 303);
    var editedVar = await catalog.variants.get(variant.id);
    check("variant edit persisted",              editedVar.title === "Large / Navy" && editedVar.options.color === "navy" && editedVar.weight_grams === 260 && editedVar.requires_shipping === 0);

    // Attach media by R2 key via the browser form → 303 saved; persists.
    var attach = await helpers.httpRequest({
      port: port, path: P + "/media/attach", method: "POST", jar: jar,
      form: { r2_key: "media/widget-main.webp", content_type: "image/webp", alt_text: "Front view" },
    });
    check("media attach then 303",               attach.status === 303);
    var mediaRows = await catalog.media.listForProduct(prod.id);
    check("media persisted",                     mediaRows.length === 1 && mediaRows[0].r2_key === "media/widget-main.webp");
    var media = mediaRows[0];

    // A bad attach (r2_key with "..") is a ?err=1 notice, never a 500.
    var badAttach = await helpers.httpRequest({
      port: port, path: P + "/media/attach", method: "POST", jar: jar,
      form: { r2_key: "../escape", content_type: "image/png" },
    });
    check("bad media attach flags err",          (badAttach.headers.location || "").indexOf("err=1") !== -1);

    // Detail renders the media card + its delete confirm link.
    var detail4 = await helpers.httpRequest({ port: port, path: P, jar: jar });
    check("detail shows media key",              detail4.body.indexOf("media/widget-main.webp") !== -1);
    check("detail links media delete confirm",   detail4.body.indexOf("/admin/media/" + media.id + "/delete/confirm-page") !== -1);

    // No R2 bridge wired → the upload-from-URL form is absent from the
    // detail screen (the attach-by-key form is the no-bridge media path).
    check("upload form absent without bridge",   detail4.body.indexOf(P + "/media/upload") === -1);

    // Media delete: the confirm page renders, then the POST removes it.
    var mDel = "/admin/media/" + media.id;
    var mConfirm = await helpers.httpRequest({ port: port, path: mDel + "/delete/confirm-page", jar: jar });
    check("media delete confirm page 200",       mConfirm.status === 200);
    check("media confirm states consequence",    mConfirm.body.indexOf("detaches the asset") !== -1);
    check("media confirm posts to delete",       mConfirm.body.indexOf("action=\"" + mDel + "/delete\"") !== -1);
    var mDelete = await helpers.httpRequest({ port: port, path: mDel + "/delete", method: "POST", jar: jar });
    check("media delete then 303",               mDelete.status === 303);
    check("media gone",                          (await catalog.media.listForProduct(prod.id)).length === 0);

    // Variant delete: the confirm page renders, then the POST removes it
    // (and its prices via the FK cascade).
    var vConfirm = await helpers.httpRequest({ port: port, path: V + "/delete/confirm-page", jar: jar });
    check("variant delete confirm page 200",     vConfirm.status === 200);
    check("variant confirm states consequence",  vConfirm.body.indexOf("permanent") !== -1);
    check("variant confirm posts to delete",     vConfirm.body.indexOf("action=\"" + V + "/delete\"") !== -1);
    var vDelete = await helpers.httpRequest({ port: port, path: V + "/delete", method: "POST", jar: jar });
    check("variant delete then 303",             vDelete.status === 303);
    check("variant gone",                        (await catalog.variants.listForProduct(prod.id)).length === 0);

    // Bearer DELETE on a fresh variant still works (JSON contract).
    var v2 = await catalog.variants.create(prod.id, { sku: "WID-2" });
    var apiDel = await helpers.httpRequest({
      port: port, path: "/admin/variants/" + v2.id, method: "DELETE", headers: bearer,
    });
    check("bearer variant DELETE returns 200",   apiDel.status === 200);

    // An unknown product id is a 404 page (notice), never a 500.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/products/" + b.uuid.v7(), jar: jar });
    check("unknown product then 404",            miss.status === 404);
    check("unknown product shows notice",        miss.body.indexOf("not found") !== -1);
    // A malformed id throws TypeError in the primitive — must be 404, not 500.
    var badId = await helpers.httpRequest({ port: port, path: "/admin/products/not-a-uuid", jar: jar });
    check("malformed product id not a 500",      badId.status === 404);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: P });
    check("anon detail → login form",            anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

// Build a multipart/form-data body from a list of parts. Text parts:
// { name, value }. File parts: { name, filename, contentType, bytes }.
// Returns { body: Buffer, contentType: string } so the test can post the
// real wire bytes through the framework's multipart body-parser.
function _multipart(parts) {
  var boundary = "----blamejsAdminUpload" + Date.now();
  var chunks = [];
  parts.forEach(function (p) {
    chunks.push(Buffer.from("--" + boundary + "\r\n"));
    if (p.filename !== undefined) {
      chunks.push(Buffer.from(
        "Content-Disposition: form-data; name=\"" + p.name + "\"; filename=\"" + p.filename + "\"\r\n" +
        "Content-Type: " + p.contentType + "\r\n\r\n"));
      chunks.push(Buffer.isBuffer(p.bytes) ? p.bytes : Buffer.from(p.bytes));
      chunks.push(Buffer.from("\r\n"));
    } else {
      chunks.push(Buffer.from(
        "Content-Disposition: form-data; name=\"" + p.name + "\"\r\n\r\n" + p.value + "\r\n"));
    }
  });
  chunks.push(Buffer.from("--" + boundary + "--\r\n"));
  return { body: Buffer.concat(chunks), contentType: "multipart/form-data; boundary=" + boundary };
}

// 1x1 PNG — valid magic bytes so b.fileType.detect classifies it.
var TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000a49444154789c6360000002000100ffff", "hex");

// Direct-file upload through the wired multipart body-parser + a mock R2
// bridge. Confirms the file-upload form renders on the detail screen, a
// valid PNG multipart POST stores to R2 + attaches the media row + PRGs
// back saved, a disallowed type is a clean ?err=1 (never a 500), and the
// bearer JSON route returns 201 with the stored record.
async function _runFileUpload() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "upload-console" });
  var order   = bShop.order.create({ query: query, cursorSecret: "upload-console" });
  var prod    = await catalog.products.create({ slug: "uploadable", title: "Uploadable", status: "active" });

  var puts = [];
  var r2Mock = { put: async function (key, body, contentType) {
    puts.push({ key: key, size: body.length, contentType: contentType });
    return { ok: true, key: key, size: body.length };
  } };

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-upload-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, r2_bridge: r2Mock, asset_prefix: "/assets/", shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var P = "/admin/products/" + prod.id;

  try {
    var jar = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });

    // The file-upload form now renders on the detail screen (bridge wired).
    var detail = await helpers.httpRequest({ port: port, path: P, jar: jar });
    check("detail shows file-upload form",       detail.body.indexOf(P + "/media/upload-file") !== -1);
    check("file form is multipart",              detail.body.indexOf("enctype=\"multipart/form-data\"") !== -1);
    check("file input present + accept-gated",   detail.body.indexOf("type=\"file\"") !== -1 && detail.body.indexOf("accept=\"image/png") !== -1);

    // Browser multipart POST: PNG file + alt text → 303 saved; stored +
    // attached.
    var mp = _multipart([
      { name: "alt_text", value: "Uploaded hero" },
      { name: "file", filename: "hero.png", contentType: "image/png", bytes: TINY_PNG },
    ]);
    var up = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mp.contentType }, body: mp.body,
    });
    check("file upload then 303",                up.status === 303);
    check("file upload redirects saved",         (up.headers.location || "").indexOf("saved=1") !== -1);
    check("file upload stored to R2",            puts.length === 1 && /^media\/.*\.png$/.test(puts[0].key));
    var rows = await catalog.media.listForProduct(prod.id);
    check("file upload media persisted",         rows.length === 1 && rows[0].r2_key === puts[0].key && rows[0].alt_text === "Uploaded hero");

    // Disallowed type via the browser form → ?err=1 notice, never a 500.
    var mpBad = _multipart([
      { name: "file", filename: "doc.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF-1.4\n") },
    ]);
    var bad = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpBad.contentType }, body: mpBad.body,
    });
    check("disallowed file flags err",           (bad.headers.location || "").indexOf("err=1") !== -1);
    check("disallowed file stored nothing",      puts.length === 1);

    // Bearer JSON API route → 201 with the stored record.
    var mpApi = _multipart([
      { name: "product_id", value: prod.id },
      { name: "file", filename: "api.png", contentType: "image/png", bytes: TINY_PNG },
    ]);
    var api = await helpers.httpRequest({
      port: port, path: "/admin/media/upload-file", method: "POST",
      headers: Object.assign({ "content-type": mpApi.contentType }, bearer), body: mpApi.body,
    });
    check("bearer file upload 201 JSON",         api.status === 201);
    var apiRec = JSON.parse(api.body);
    check("bearer file upload returns record",   apiRec.r2_key === puts[1].key && apiRec.content_type === "image/png");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

async function run() {
  await _run();
  await _runFileUpload();
}

module.exports = { run: run };
