"use strict";
/**
 * Collection product-list pagination — full HTTP integration of the
 * storefront.
 *
 * The collection page (`GET /collections/:slug`) used to render only the
 * first 24 members of a collection and thread no cursor, so every product
 * past the 24th was silently unreachable. It now threads the lib's opaque
 * forward cursor through a `?cursor=` trail and paints a prev/next nav that
 * mirrors the search pagination shell, so a collection larger than one page
 * is fully reachable by following the next link.
 *
 * Boots a real `b.createApp` server with the storefront wired against one
 * in-memory `node:sqlite` DB loaded from the live migrations, seeds a manual
 * collection with 30 members (> one 24-card page), then asserts:
 *
 *   1. Page 1 renders exactly the page size (24) cards and a next link.
 *   2. Following the next cursor returns the REMAINING 6 products, disjoint
 *      from page 1 — products past the first 24 are no longer unreachable.
 *   3. The last page carries no next link (the forward cursor is exhausted)
 *      and a working Previous link back toward page 1.
 *   4. Page 1 + the next page together reach all 30 distinct members.
 *   5. A garbage `?cursor=` does NOT 500 — it serves page 1, matching how
 *      `/search` treats a bad `?page=`.
 *   6. The canonical stays the bare collection URL on every page (query
 *      stripped), mirroring the search canonical.
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs     = require("node:fs");
var nodeOs     = require("node:os");
var nodePath   = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0043_collections.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-colpgn-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
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

function _canonical(html) {
  var m = html.match(/<link rel="canonical" href="([^"]*)">/);
  return m ? m[1] : null;
}

// Product-card slugs in render order.
function _slugsOf(html) {
  var slugs = [];
  var re = /href="\/products\/([a-z0-9-]+)"/g;
  var m;
  while ((m = re.exec(html)) !== null) slugs.push(m[1]);
  return slugs;
}

// Pull the `href` of the collection pagination "Next" anchor (rel="next"
// inside the prev/next nav). Returns null when there is no next link.
function _nextHref(html) {
  var m = html.match(/<a class="search-pagination__link search-pagination__next" href="([^"]*)" rel="next">/);
  return m ? m[1] : null;
}

// The `?cursor=` query of a same-origin collection href, ready to re-issue.
function _pathOf(href) {
  // Hrefs are root-relative ("/collections/<slug>?cursor=…"); HTML-escaped
  // `&` is not present (a single cursor param, no ampersand) so no unescape
  // is needed for the trail itself.
  return href;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "col-pgn-cursor" });

  // ---- seed a 30-member manual collection ----
  // 30 members so the list spans more than one 24-card page. Membership
  // position is the insertion index, so the (position, id) keyset paging is
  // deterministic 1..30.
  async function _seedProduct(slug, title) {
    var p = await catalog.products.create({ slug: slug, title: title, status: "active" });
    var v = await catalog.variants.create(p.id, { sku: slug.toUpperCase() + "-1", options: { size: "M" } });
    await catalog.prices.set(v.id, { currency: "USD", amount_minor: 1500 });
    return p;
  }

  var now = Date.now();
  await query(
    "INSERT INTO collections (slug, type, title, description, sort_strategy, created_at, updated_at) " +
    "VALUES ('gear', 'manual', 'Gear', 'Everything we stock.', 'manual', ?1, ?1)",
    [now],
  );

  var TOTAL = 30;
  for (var i = 0; i < TOTAL; i += 1) {
    var n = i + 1;
    var pad = n < 10 ? "0" + n : String(n);
    var p = await _seedProduct("gear-" + pad, "Gear " + pad);
    await query(
      "INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      [b.uuid.v7(), "gear", p.id, i, now],
    );
  }

  var handle = await _bootApp({ catalog: catalog, cart: cart, collections: collections });

  var HOST = "shop.example";
  var hdr  = { host: HOST };

  try {
    // ====================================================================
    // collection page 1 — first 24 + a next link, no previous
    // ====================================================================
    var p1 = await helpers.httpRequest({ port: handle.port, path: "/collections/gear", headers: hdr });
    check("collection page 1 then 200", p1.status === 200);
    var page1Slugs = _slugsOf(p1.body);
    check("collection page 1 shows exactly the page size (24) cards", page1Slugs.length === 24);
    check("collection page 1 renders a pagination nav", p1.body.indexOf("collection-pagination") !== -1);
    check("collection page 1 has a next link", _nextHref(p1.body) != null);
    check("collection page 1 previous is disabled (first page)",
      p1.body.indexOf("search-pagination__prev is-disabled") !== -1);
    check("collection page 1 canonical is the bare collection URL",
      _canonical(p1.body) === "https://" + HOST + "/collections/gear");

    // ====================================================================
    // follow the next cursor — the REMAINING 6, disjoint from page 1
    // ====================================================================
    var nextHref = _nextHref(p1.body);
    var p2 = await helpers.httpRequest({ port: handle.port, path: _pathOf(nextHref), headers: hdr });
    check("collection page 2 then 200", p2.status === 200);
    var page2Slugs = _slugsOf(p2.body);
    check("collection page 2 shows the remaining 6 cards", page2Slugs.length === 6);
    var overlap = page2Slugs.filter(function (s) { return page1Slugs.indexOf(s) !== -1; });
    check("collection page 2 products are disjoint from page 1", overlap.length === 0);
    var union = {};
    page1Slugs.concat(page2Slugs).forEach(function (s) { union[s] = true; });
    check("page 1 + page 2 reach all 30 distinct members", Object.keys(union).length === 30);

    // Last page: no next link, and a working previous link back to page 1.
    check("collection last page has no next link", _nextHref(p2.body) == null);
    check("collection last page next is disabled", p2.body.indexOf("search-pagination__next is-disabled") !== -1);
    check("collection last page has a previous link",
      p2.body.indexOf("search-pagination__prev\" href=\"/collections/gear\"") !== -1);
    check("collection page 2 canonical is still the bare collection URL (query stripped)",
      _canonical(p2.body) === "https://" + HOST + "/collections/gear");

    // Following Previous from the last page lands back on page 1's 24 cards.
    var prevM = p2.body.match(/<a class="search-pagination__link search-pagination__prev" href="([^"]*)" rel="prev">/);
    check("collection last page exposes a prev href", prevM != null);
    var pBack = await helpers.httpRequest({ port: handle.port, path: prevM[1], headers: hdr });
    check("collection previous-page then 200", pBack.status === 200);
    check("collection previous-page returns page 1's 24 cards", _slugsOf(pBack.body).length === 24);

    // ====================================================================
    // a garbage cursor does NOT 500 — it serves page 1 (matches search)
    // ====================================================================
    var pBad = await helpers.httpRequest({ port: handle.port, path: "/collections/gear?cursor=not-a-real-cursor", headers: hdr });
    check("garbage cursor does not 500", pBad.status === 200);
    check("garbage cursor serves page 1 (24 cards)", _slugsOf(pBad.body).length === 24);

    // A well-shaped but HMAC-invalid cursor (base64url.base64url) also
    // degrades to page 1 rather than 404/500 — the lib rejects the tag, the
    // route retries page 1.
    var pTampered = await helpers.httpRequest({ port: handle.port, path: "/collections/gear?cursor=YWJj.ZGVm", headers: hdr });
    check("tampered (well-shaped) cursor does not 500", pTampered.status === 200);
    check("tampered cursor serves page 1 (24 cards)", _slugsOf(pTampered.body).length === 24);

    // An unknown collection slug is still a 404 (cursor handling didn't mask
    // the missing-collection 404).
    var pUnknown = await helpers.httpRequest({ port: handle.port, path: "/collections/nope", headers: hdr });
    check("unknown collection is 404", pUnknown.status === 404);

    // ====================================================================
    // exact page-boundary collection — a size that is a multiple of the
    // page size must NOT advertise a phantom next page on the final full
    // page (following it would land on an empty page). 48 = 24 + 24.
    // ====================================================================
    await query(
      "INSERT INTO collections (slug, type, title, description, sort_strategy, created_at, updated_at) " +
      "VALUES ('bundle', 'manual', 'Bundle', 'Exactly two full pages.', 'manual', ?1, ?1)",
      [now],
    );
    for (var j = 0; j < 48; j += 1) {
      var jn   = j + 1;
      var jpad = jn < 10 ? "0" + jn : String(jn);
      var bp   = await _seedProduct("bundle-" + jpad, "Bundle " + jpad);
      await query(
        "INSERT INTO collection_members (id, collection_slug, product_id, position, added_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        [b.uuid.v7(), "bundle", bp.id, j, now],
      );
    }
    var b1 = await helpers.httpRequest({ port: handle.port, path: "/collections/bundle", headers: hdr });
    check("boundary collection page 1 then 200", b1.status === 200);
    var b1Slugs = _slugsOf(b1.body);
    check("boundary collection page 1 shows 24 cards", b1Slugs.length === 24);
    check("boundary collection page 1 has a next link", _nextHref(b1.body) != null);
    var b2 = await helpers.httpRequest({ port: handle.port, path: _pathOf(_nextHref(b1.body)), headers: hdr });
    check("boundary collection page 2 then 200", b2.status === 200);
    var b2Slugs = _slugsOf(b2.body);
    check("boundary collection page 2 shows the final 24 cards", b2Slugs.length === 24);
    check("boundary collection page 2 has NO phantom next link (size is an exact multiple of the page size)",
      _nextHref(b2.body) == null);
    var bUnion = {};
    b1Slugs.concat(b2Slugs).forEach(function (s) { bUnion[s] = true; });
    check("boundary collection both pages reach all 48 distinct members", Object.keys(bUnion).length === 48);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
