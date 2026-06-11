"use strict";
/**
 * Product media ordering + upload hardening — the browser-side admin
 * controls for a single product's image gallery.
 *
 * The PDP renders a product's media in list order with the first row as the
 * hero, and `catalog.media.listForProduct` orders by `position`. This drives
 * the two console controls that own that order:
 *
 *   - reorder: a comma-joined `ordered_media_ids` form that rewrites every
 *     row's position to match (a partial / foreign / unknown set is a clean
 *     4xx, never a 500, and leaves the order untouched).
 *   - set-primary: a per-card POST that promotes one row to position 0 and
 *     shifts the rest down, preserving their relative order.
 *
 * Plus the direct-file upload security contract through the wired multipart
 * body-parser + a mock R2 bridge: a valid PNG creates a media row and writes
 * to R2; a disallowed type and a script-bearing SVG are clean 4xx with no
 * row + no write; an oversize file is a clean 4xx. A clean SVG is sanitized
 * through the framework's SVG guard before it reaches the bucket.
 *
 * Reuses the shared `check` helper + cookie jar (the helper echoes the
 * captured CSRF cookie as X-CSRF-Token on a jar form POST, so the session
 * POSTs satisfy csrfProtect the way a real browser's `_csrf` field does).
 *
 * Network: zero — every request lands on 127.0.0.1; the R2 bridge is mocked.
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

var TOKEN = "admin-token-0123456789abcdef-media";
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql"]
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

// Build a multipart/form-data body from a list of parts. Text parts:
// { name, value }. File parts: { name, filename, contentType, bytes }.
function _multipart(parts) {
  var boundary = "----blamejsMediaOrder" + Date.now();
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

// No state-changing response may carry a raw storage-engine / parser
// internal in its body or Location.
function _noLeak(label, resp) {
  var hay = String(resp.body || "") + " " + String((resp.headers && resp.headers.location) || "");
  var lower = hay.toLowerCase();
  check(label + ": no 'constraint failed'", lower.indexOf("constraint failed") === -1);
  check(label + ": no 'json at position'",  lower.indexOf("json at position") === -1);
  check(label + ": no posix fs path",       !/\/(?:home|users|var|tmp|root)\//i.test(lower));
  check(label + ": no windows fs path",     !/[a-z]:\\/i.test(lower));
}

// ---- reorder + set-primary (DB-only; no R2 bridge) ----------------------
async function _runOrdering() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "media-order" });
  var order   = bShop.order.create({ query: query, cursorSecret: "media-order" });
  var prod    = await catalog.products.create({ slug: "gallery-product", title: "Gallery Product", status: "active" });
  var other   = await catalog.products.create({ slug: "other-product",   title: "Other Product",   status: "active" });

  // Three media on the gallery product at positions 0,1,2; one on the other.
  var m0 = await catalog.media.attach({ product_id: prod.id, r2_key: "media/a.png", content_type: "image/png", position: 0 });
  var m1 = await catalog.media.attach({ product_id: prod.id, r2_key: "media/b.png", content_type: "image/png", position: 1 });
  var m2 = await catalog.media.attach({ product_id: prod.id, r2_key: "media/c.png", content_type: "image/png", position: 2 });
  var foreign = await catalog.media.attach({ product_id: other.id, r2_key: "media/x.png", content_type: "image/png", position: 0 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-media-order-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var P = "/admin/products/" + prod.id;

  try {
    var jar = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });

    // Baseline order is 0,1,2 = a,b,c with a as hero.
    var base = await catalog.media.listForProduct(prod.id);
    check("baseline media order a,b,c",          base.map(function (m) { return m.r2_key; }).join() === "media/a.png,media/b.png,media/c.png");

    // The detail screen renders the reorder panel + per-card primary control.
    var detail = await helpers.httpRequest({ port: port, path: P, jar: jar });
    check("detail shows reorder form",           detail.body.indexOf(P + "/media/reorder") !== -1);
    check("detail seeds current id list",        detail.body.indexOf(m0.id + "," + m1.id + "," + m2.id) !== -1);
    check("detail marks the hero Primary",       detail.body.indexOf(">Primary<") !== -1);
    check("detail offers Make primary",          detail.body.indexOf("Make primary") !== -1);
    check("non-hero card posts to primary",      detail.body.indexOf(P + "/media/" + m1.id + "/primary") !== -1);

    // Reverse the order via the browser form → 303 saved; positions rewritten.
    var rev = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST", jar: jar,
      form: { ordered_media_ids: [m2.id, m1.id, m0.id].join(",") },
    });
    check("reorder then 303",                    rev.status === 303);
    check("reorder redirects saved",             (rev.headers.location || "").indexOf("saved=1") !== -1);
    var afterRev = await catalog.media.listForProduct(prod.id);
    check("reorder rewrote positions",           afterRev.map(function (m) { return m.r2_key; }).join() === "media/c.png,media/b.png,media/a.png");
    check("reorder set new hero (position 0)",   afterRev[0].id === m2.id && afterRev[0].position === 0);

    // A foreign id in the set → ?err=1, order unchanged, no leak.
    var withForeign = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST", jar: jar,
      form: { ordered_media_ids: [m2.id, m1.id, foreign.id].join(",") },
    });
    check("foreign-id reorder flags err",        (withForeign.headers.location || "").indexOf("err=1") !== -1);
    _noLeak("foreign-id reorder", withForeign);
    var afterForeign = await catalog.media.listForProduct(prod.id);
    check("foreign-id reorder left order intact", afterForeign.map(function (m) { return m.id; }).join() === [m2.id, m1.id, m0.id].join());
    var foreignRow = await catalog.media.get(foreign.id);
    check("foreign row position untouched",       foreignRow.position === 0);

    // A short (partial) set → ?err=1, order unchanged.
    var partial = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST", jar: jar,
      form: { ordered_media_ids: [m2.id, m1.id].join(",") },
    });
    check("partial reorder flags err",           (partial.headers.location || "").indexOf("err=1") !== -1);
    check("partial reorder left order intact",   (await catalog.media.listForProduct(prod.id)).map(function (m) { return m.id; }).join() === [m2.id, m1.id, m0.id].join());

    // An empty set → ?err=1.
    var empty = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST", jar: jar,
      form: { ordered_media_ids: "" },
    });
    check("empty reorder flags err",             (empty.headers.location || "").indexOf("err=1") !== -1);

    // Set-primary on the current last row (a.png at position 2) → it leads,
    // the others shift down preserving relative order (c,b).
    var setP = await helpers.httpRequest({
      port: port, path: P + "/media/" + m0.id + "/primary", method: "POST", jar: jar,
    });
    check("set-primary then 303",                setP.status === 303);
    check("set-primary redirects saved",         (setP.headers.location || "").indexOf("saved=1") !== -1);
    var afterPrimary = await catalog.media.listForProduct(prod.id);
    check("set-primary promoted to hero",        afterPrimary[0].id === m0.id && afterPrimary[0].position === 0);
    check("set-primary preserved relative order", afterPrimary.map(function (m) { return m.r2_key; }).join() === "media/a.png,media/c.png,media/b.png");

    // Set-primary naming THIS product's path but a media id that belongs to
    // ANOTHER product is refused: the route asserts the media row's product_id
    // matches the :id segment before promoting, so a path that names product A
    // can never act on product B's media. It flags ?err=1, touches no rows on
    // either product, and never leaks.
    var crossP = await helpers.httpRequest({
      port: port, path: P + "/media/" + foreign.id + "/primary", method: "POST", jar: jar,
    });
    check("cross-product set-primary flags err",  (crossP.headers.location || "").indexOf("err=1") !== -1);
    check("cross-product set-primary not 2xx",    crossP.status !== 200);
    _noLeak("cross-product set-primary", crossP);
    check("this product's order unchanged",        (await catalog.media.listForProduct(prod.id)).map(function (m) { return m.id; }).join() === [m0.id, m2.id, m1.id].join());
    check("foreign product's row untouched",       (await catalog.media.get(foreign.id)).position === 0);

    // Set-primary on an unknown id → ?err=1 (false from the primitive).
    var unknown = await helpers.httpRequest({
      port: port, path: P + "/media/" + b.uuid.v7() + "/primary", method: "POST", jar: jar,
    });
    check("unknown set-primary flags err",       (unknown.headers.location || "").indexOf("err=1") !== -1);

    // Malformed media id in the path → ?err=1, never a 500.
    var malformed = await helpers.httpRequest({
      port: port, path: P + "/media/not-a-uuid/primary", method: "POST", jar: jar,
    });
    check("malformed set-primary not a 500",     malformed.status !== 500);
    check("malformed set-primary flags err",     (malformed.headers.location || "").indexOf("err=1") !== -1);
    _noLeak("malformed set-primary", malformed);

    // Bearer JSON contract on both routes.
    var apiReorder = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({ ordered_media_ids: [m1.id, m0.id, m2.id] }),
    });
    check("bearer reorder 200 JSON",             apiReorder.status === 200 && JSON.parse(apiReorder.body).ok === true);
    var apiPrimary = await helpers.httpRequest({
      port: port, path: P + "/media/" + m2.id + "/primary", method: "POST", headers: bearer,
    });
    check("bearer set-primary 200 JSON",         apiPrimary.status === 200 && JSON.parse(apiPrimary.body).ok === true);
    // Bearer reorder with a bad array → 400, no leak.
    var apiBad = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({ ordered_media_ids: [m0.id] }),
    });
    check("bearer bad reorder 400",              apiBad.status === 400);
    _noLeak("bearer bad reorder", apiBad);
    // Bearer set-primary on an unknown id → 404.
    var apiMiss = await helpers.httpRequest({
      port: port, path: P + "/media/" + b.uuid.v7() + "/primary", method: "POST", headers: bearer,
    });
    check("bearer unknown set-primary 404",      apiMiss.status === 404);
    // Bearer set-primary whose :mid belongs to ANOTHER product than the :id
    // path segment → 404, no leak (the route asserts the pairing). The correct
    // pairing (apiPrimary above, m2 under prod) is the 200 happy path.
    var apiCross = await helpers.httpRequest({
      port: port, path: P + "/media/" + foreign.id + "/primary", method: "POST", headers: bearer,
    });
    check("bearer cross-product set-primary 404", apiCross.status === 404);
    _noLeak("bearer cross-product set-primary", apiCross);
    // Bearer reorder naming THIS product's path but a foreign product's media
    // id in the set → 400 (the primitive refuses a set that isn't exactly this
    // product's current media), no leak. The route already passes :id through.
    var apiCrossReorder = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({ ordered_media_ids: [m2.id, m1.id, foreign.id] }),
    });
    check("bearer cross-product reorder 400",     apiCrossReorder.status === 400);
    _noLeak("bearer cross-product reorder", apiCrossReorder);

    // Auth gate: a state-changing POST with a WRONG csrf token is refused.
    var noCsrf = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST", jar: jar,
      headers: { "x-csrf-token": "wrong-token-value" },
      form: { ordered_media_ids: "x" },
    });
    check("wrong-csrf reorder refused (403)",    noCsrf.status === 403);
    // Anonymous (no session) → not data; bounced to /admin.
    var anon = await helpers.httpRequest({
      port: port, path: P + "/media/reorder", method: "POST",
      form: { ordered_media_ids: "x" },
    });
    check("anon reorder not 200",                anon.status !== 200);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

// ---- upload hardening (wired R2 bridge + SVG guard) ---------------------
async function _runUploadHardening() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "media-upload" });
  var order   = bShop.order.create({ query: query, cursorSecret: "media-upload" });
  var prod    = await catalog.products.create({ slug: "uploadable-hardening", title: "Uploadable", status: "active" });

  var puts = [];
  var r2Mock = { put: async function (key, body, contentType) {
    puts.push({ key: key, bytes: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType: contentType });
    return { ok: true, key: key, size: body.length };
  } };

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-media-upload-"));
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
  var P = "/admin/products/" + prod.id;

  try {
    var jar = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });

    // Valid PNG → 303 saved; written to R2 + a media row created.
    var mpPng = _multipart([
      { name: "alt_text", value: "Hero" },
      { name: "file", filename: "hero.png", contentType: "image/png", bytes: TINY_PNG },
    ]);
    var png = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpPng.contentType }, body: mpPng.body,
    });
    check("png upload then 303",                 png.status === 303);
    check("png upload saved",                    (png.headers.location || "").indexOf("saved=1") !== -1);
    check("png written to R2",                   puts.length === 1 && /^media\/.*\.png$/.test(puts[0].key));
    var rowsAfterPng = await catalog.media.listForProduct(prod.id);
    check("png row created",                     rowsAfterPng.length === 1 && rowsAfterPng[0].r2_key === puts[0].key);

    // Disallowed type (text/plain) → ?err=1, no write, no row, no leak.
    var mpText = _multipart([
      { name: "file", filename: "note.txt", contentType: "text/plain", bytes: Buffer.from("hello, not an image") },
    ]);
    var txt = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpText.contentType }, body: mpText.body,
    });
    check("text upload flags err",               (txt.headers.location || "").indexOf("err=1") !== -1);
    check("text upload wrote nothing",           puts.length === 1);
    check("text upload created no row",          (await catalog.media.listForProduct(prod.id)).length === 1);
    _noLeak("text upload", txt);

    // Script-bearing SVG declared image/svg+xml → ?err=1, no write, no row.
    // The bytes pass the declared-type allowlist (svg can't be sniffed) but
    // the framework's SVG guard refuses the <script> before it reaches R2.
    var hostileSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(document.cookie)</script><circle r=\"5\"/></svg>";
    var mpSvgBad = _multipart([
      { name: "file", filename: "x.svg", contentType: "image/svg+xml", bytes: Buffer.from(hostileSvg, "utf8") },
    ]);
    var svgBad = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpSvgBad.contentType }, body: mpSvgBad.body,
    });
    check("script-svg upload flags err",         (svgBad.headers.location || "").indexOf("err=1") !== -1);
    check("script-svg wrote nothing",            puts.length === 1);
    check("script-svg created no row",           (await catalog.media.listForProduct(prod.id)).length === 1);
    _noLeak("script-svg upload", svgBad);

    // onload-handler SVG → refused the same way (the on* family is critical).
    var onloadSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\" onload=\"alert(1)\"><circle r=\"5\"/></svg>";
    var mpSvgOnload = _multipart([
      { name: "file", filename: "y.svg", contentType: "image/svg+xml", bytes: Buffer.from(onloadSvg, "utf8") },
    ]);
    var svgOnload = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpSvgOnload.contentType }, body: mpSvgOnload.body,
    });
    check("onload-svg upload flags err",         (svgOnload.headers.location || "").indexOf("err=1") !== -1);
    check("onload-svg wrote nothing",            puts.length === 1);

    // A clean SVG → stored. The guard passes it through (serve) and the row
    // lands; the bytes written to R2 carry no <script>.
    var cleanSvg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><circle cx=\"5\" cy=\"5\" r=\"5\"/></svg>";
    var mpSvgOk = _multipart([
      { name: "file", filename: "ok.svg", contentType: "image/svg+xml", bytes: Buffer.from(cleanSvg, "utf8") },
    ]);
    var svgOk = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpSvgOk.contentType }, body: mpSvgOk.body,
    });
    check("clean-svg upload then 303",           svgOk.status === 303);
    check("clean-svg saved",                     (svgOk.headers.location || "").indexOf("saved=1") !== -1);
    check("clean-svg written to R2",             puts.length === 2 && /^media\/.*\.svg$/.test(puts[1].key));
    check("clean-svg bytes carry no <script>",   puts[1].bytes.toString("utf8").indexOf("<script") === -1);
    check("clean-svg row created",               (await catalog.media.listForProduct(prod.id)).length === 2);

    // Oversize file → clean 4xx (?err=1), no write. The multipart sub-parser
    // caps file size, so an over-cap part is rejected before the handler; the
    // route surfaces a clean notice either way (never a 500).
    var bigBytes = Buffer.alloc(11 * 1024 * 1024, 0x41);   // 11 MiB > 10 MiB cap
    // Prefix valid PNG magic so a partial read still classifies as png; the
    // size gate fires regardless.
    TINY_PNG.copy(bigBytes, 0);
    var mpBig = _multipart([
      { name: "file", filename: "huge.png", contentType: "image/png", bytes: bigBytes },
    ]);
    // The wire outcome of an over-cap upload is inherently two-shaped: the
    // parser's 413 rejection mid-stream can flush a response, or the
    // teardown's RST can discard it and the client sees a connection reset
    // (exactly what a real browser gets from capped endpoints). Both are
    // refusals; the durable contract asserted here is no R2 write, no row,
    // and never a 500/saved success.
    var big = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpBig.contentType }, body: mpBig.body,
      tolerateEarlyClose: true,
    });
    check("oversize upload refused (4xx/err or wire reset)",
      big.reset === true || big.status === 413 || (big.headers.location || "").indexOf("err=1") !== -1);
    check("oversize upload not 2xx/3xx-saved",   !( (big.headers.location || "").indexOf("saved=1") !== -1 ));
    check("oversize upload not a 500 leak",      big.status !== 500);
    check("oversize wrote nothing",              puts.length === 2);
    check("oversize created no row",             (await catalog.media.listForProduct(prod.id)).length === 2);
    if (!big.reset) _noLeak("oversize upload", big);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

// ---- upload-from-URL response-size cap (stubbed httpClient) --------------
// The upload-from-URL path fetches `source_url` via the framework's shared
// `b.httpClient` and buffers the body. It must pass the media budget as the
// client's `maxResponseBytes` so an over-cap source is refused with a clean
// 4xx (never a 500 / OOM) BEFORE the magic-byte sniff. This stub stands in
// for `b.httpClient.request`, honoring `maxResponseBytes` exactly as the real
// client does (reject with a `RESPONSE_TOO_LARGE`-coded error past the cap),
// so the assertion proves the route wires the cap through. b.httpClient is the
// same singleton admin.js captured at module top, so the patch is observed.
async function _runUrlUploadCap() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query, cursorSecret: "media-url-cap" });
  var order   = bShop.order.create({ query: query, cursorSecret: "media-url-cap" });
  var prod    = await catalog.products.create({ slug: "url-uploadable", title: "URL Uploadable", status: "active" });

  var puts = [];
  var r2Mock = { put: async function (key, body, contentType) {
    puts.push({ key: key, bytes: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType: contentType });
    return { ok: true, key: key, size: body.length };
  } };

  // The bytes the next fetch should "serve". The stub enforces maxResponseBytes
  // the way the real http-client does. capSeen records the cap the route asked
  // for, proving it forwarded _UPLOAD_MAX_BYTES rather than the ~1 GiB default.
  var TEN_MIB = 10 * 1024 * 1024;
  var nextBody = TINY_PNG;
  var capSeen  = null;
  var realRequest = b.httpClient.request;
  b.httpClient.request = function (opts) {
    capSeen = opts.maxResponseBytes;
    if (typeof opts.maxResponseBytes === "number" && nextBody.length > opts.maxResponseBytes) {
      var e = new Error("response body exceeds " + opts.maxResponseBytes + " bytes");
      e.code = "RESPONSE_TOO_LARGE";
      return Promise.reject(e);
    }
    return Promise.resolve({
      statusCode: 200,
      headers:    { "content-type": "image/png" },
      body:       nextBody,
    });
  };

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-media-urlcap-"));
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
    // Under-cap source (a tiny PNG) → happy path: 201, written to R2, row created.
    nextBody = TINY_PNG;
    var okUp = await helpers.httpRequest({
      port: port, path: P + "/media/upload", method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({ source_url: "https://example.test/a.png", content_type: "image/png" }),
    });
    check("url upload under cap 201",            okUp.status === 201);
    check("url upload forwarded the media cap",  capSeen === TEN_MIB);
    check("url upload wrote to R2",              puts.length === 1 && /^media\/.*\.png$/.test(puts[0].key));
    check("url upload created a row",            (await catalog.media.listForProduct(prod.id)).length === 1);

    // Over-cap source → clean 4xx (413), NOT a 500, no write, no row, no leak.
    nextBody = Buffer.alloc(TEN_MIB + 1, 0x41);
    TINY_PNG.copy(nextBody, 0);
    var bigUp = await helpers.httpRequest({
      port: port, path: P + "/media/upload", method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({ source_url: "https://example.test/huge.png", content_type: "image/png" }),
    });
    check("url upload over cap is 4xx",          bigUp.status >= 400 && bigUp.status < 500);
    check("url upload over cap not a 500",       bigUp.status !== 500);
    check("url upload over cap is 413",          bigUp.status === 413);
    check("url upload over cap wrote nothing",   puts.length === 1);
    check("url upload over cap created no row",  (await catalog.media.listForProduct(prod.id)).length === 1);
    _noLeak("url upload over cap", bigUp);

    // Browser alias over cap → ?err=1, no write, never a 500.
    var jar = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    nextBody = Buffer.alloc(TEN_MIB + 1, 0x42);
    TINY_PNG.copy(nextBody, 0);
    var bigBrowser = await helpers.httpRequest({
      port: port, path: P + "/media/upload", method: "POST", jar: jar,
      form: { source_url: "https://example.test/huge2.png", content_type: "image/png" },
    });
    check("browser url upload over cap not saved", (bigBrowser.headers.location || "").indexOf("saved=1") === -1);
    check("browser url upload over cap not 500",   bigBrowser.status !== 500);
    check("browser url upload over cap wrote nothing", puts.length === 1);
    _noLeak("browser url upload over cap", bigBrowser);
  } finally {
    b.httpClient.request = realRequest;
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

async function run() {
  await _runOrdering();
  await _runUploadHardening();
  await _runUrlUploadCap();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    process.stdout.write("admin-media-ordering OK\n");
  }).catch(function (e) {
    process.stderr.write((e && e.stack || String(e)) + "\n");
    process.exit(1);
  });
}
