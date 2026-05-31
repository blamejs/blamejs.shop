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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql"]
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

    // Set-primary on a foreign product's row from THIS product's path still
    // only touches that row's own product — no cross-product reshuffle. The
    // primitive scopes every UPDATE by product_id, so it succeeds for the
    // foreign row but never moves this product's rows.
    var crossP = await helpers.httpRequest({
      port: port, path: P + "/media/" + foreign.id + "/primary", method: "POST", jar: jar,
    });
    check("cross-product set-primary 303",       crossP.status === 303);
    check("this product's order unchanged",      (await catalog.media.listForProduct(prod.id)).map(function (m) { return m.id; }).join() === [m0.id, m2.id, m1.id].join());

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
    var big = await helpers.httpRequest({
      port: port, path: P + "/media/upload-file", method: "POST", jar: jar,
      headers: { "content-type": mpBig.contentType }, body: mpBig.body,
    });
    check("oversize upload not 2xx/3xx-saved",   !( (big.headers.location || "").indexOf("saved=1") !== -1 ));
    check("oversize upload not a 500 leak",      big.status !== 500);
    check("oversize wrote nothing",              puts.length === 2);
    _noLeak("oversize upload", big);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

async function run() {
  await _runOrdering();
  await _runUploadHardening();
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
