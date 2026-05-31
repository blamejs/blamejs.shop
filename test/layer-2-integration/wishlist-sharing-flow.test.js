"use strict";
/**
 * Wishlist sharing — full HTTP integration of the owner share-link flow
 * and the public, no-auth shared view.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * wishlist + wishlist-sharing + customers deps, against one in-memory
 * `node:sqlite` DB loaded from the live migrations. Owner actions read
 * `{ customer_id }` from the sealed `shop_auth` cookie (minted via
 * `b.vault.seal` after boot, not a WebAuthn ceremony); the public shared
 * view takes no auth at all — the token IS the access.
 *
 * Covers: create a share link → it appears in the owner's share list; the
 * public /wishlist/shared/:token (no auth) renders the saved items; revoke
 * → the public token now 404s; an unknown/garbage token 404s (no 500); a
 * second customer cannot revoke the first customer's link (ownership 404);
 * the public view does NOT leak the owner's identity (customer id) or the
 * private per-entry notes; the shared page carries noindex.
 *
 * Network: zero — every request lands on 127.0.0.1.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0012_wishlist.sql", "0150_wishlist_sharing.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-wls-"));
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

function _authCookie(customerId) {
  return helpers.authCookie(b, customerId);
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

// Pull the share token out of the create confirmation page (the read-only
// URL field carries the only copy the owner ever sees).
function _tokenFromPage(html) {
  var m = html.match(/\/wishlist\/shared\/([A-Za-z0-9_-]{43})/);
  return m ? m[1] : null;
}

async function _run() {
  var query           = _makeQuery();
  var catalog         = bShop.catalog.create({ query: query });
  var cart            = bShop.cart.create({ query: query, catalog: catalog });
  var wishlist        = bShop.wishlist.create({ query: query, cursorSecret: "wls-flow-cursor" });
  var wishlistSharing = bShop.wishlistSharing.create({ query: query, wishlist: wishlist });
  var customers       = bShop.customers.create({ query: query });

  var product = await catalog.products.create({ slug: "gift-widget", title: "Gift Widget", description: "A giftable widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "GFT-WDG-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 4999 });

  var ownerId    = b.uuid.v7();
  var strangerId = b.uuid.v7();

  // The owner saves the product + attaches a PRIVATE note (the note must
  // NEVER surface on the public shared view).
  await wishlist.add({ customer_id: ownerId, product_id: product.id, notes: "SECRET-NOTE-do-not-leak" });

  var handle = await _bootApp({
    catalog: catalog, cart: cart, wishlist: wishlist,
    wishlistSharing: wishlistSharing, customers: customers,
  });

  try {
    var ownerJar = helpers.cookieJar();
    ownerJar.capture({ "set-cookie": [_authCookie(ownerId)] });

    // ---- anon owner actions redirect to login --------------------------
    var anonCreate = await helpers.httpRequest({ port: handle.port, path: "/wishlist/share", method: "POST" });
    check("anon create-share → 303 login", anonCreate.status === 303 && (anonCreate.headers["location"] || "") === "/account/login");

    // ---- owner page shows the share control ----------------------------
    // A benign authed GET seeds the owner's double-submit CSRF cookie before
    // the share POSTs below (the helper echoes it as X-CSRF-Token).
    var wlPage = await helpers.httpRequest({ port: handle.port, path: "/account/wishlist", jar: ownerJar });
    check("owner wishlist → 200",                 wlPage.status === 200);
    check("owner wishlist shows share control",   wlPage.body.indexOf("Share this wishlist") !== -1);
    check("owner wishlist has create-share form", /action="\/wishlist\/share"/.test(wlPage.body));

    // ---- create a share link -------------------------------------------
    var created = await helpers.httpRequest({ port: handle.port, path: "/wishlist/share", method: "POST", jar: ownerJar, form: {} });
    check("create-share → 200",                   created.status === 200);
    check("create-share confirms creation",       created.body.indexOf("Share link created") !== -1);
    var token = _tokenFromPage(created.body);
    check("create-share surfaces a 43-char token", typeof token === "string" && token.length === 43);
    // The owner sees this URL ONCE — it must be a correct absolute link
    // (<origin>/wishlist/shared/<token>), not a path-mangled one. Deriving it
    // by trimming a path off the canonical URL produced a doubled
    // ".../wishlist/share/wishlist/shared/<token>" that a copying owner would
    // send broken.
    var displayedUrl = (created.body.match(/https?:\/\/[^"\s]*\/wishlist\/shared\/[A-Za-z0-9_-]{43}/) || [])[0];
    check("create-share displays a full absolute share URL", displayedUrl != null);
    check("displayed share URL is <origin>/wishlist/shared/<token> with no mangled path",
      displayedUrl != null && /^https?:\/\/[^/]+\/wishlist\/shared\/[A-Za-z0-9_-]{43}$/.test(displayedUrl));
    check("create-share shows an active link + revoke", /action="\/wishlist\/share\/[^"]+\/revoke"/.test(created.body));

    // The link appears in the owner's persisted share list.
    var ownerShares = await wishlistSharing.listSharesForOwner(ownerId);
    check("share persisted for the owner",        ownerShares.length === 1);
    check("share owner-scoped",                   ownerShares[0].owner_customer_id === ownerId);
    var shareId = ownerShares[0].id;

    // ---- public shared view (NO auth) ----------------------------------
    var pub = await helpers.httpRequest({ port: handle.port, path: "/wishlist/shared/" + token });
    check("public shared view → 200",             pub.status === 200);
    check("public shared view renders the product", pub.body.indexOf("Gift Widget") !== -1);
    check("public shared view links the PDP",     pub.body.indexOf("/products/gift-widget") !== -1);

    // Redaction — the owner's identity (customer id) and the private note
    // must NOT appear anywhere in the public HTML.
    check("public view redacts owner customer id", pub.body.indexOf(ownerId) === -1);
    check("public view redacts private notes",     pub.body.indexOf("SECRET-NOTE-do-not-leak") === -1);

    // noindex — a personal shared wishlist is not index material.
    check("public shared view is noindex",         /<meta name="robots" content="noindex/.test(pub.body));

    // The open bumped the owner's view counter (recordView).
    var afterView = await wishlistSharing.listSharesForOwner(ownerId);
    check("recordView bumped the view counter",    Number(afterView[0].view_count) >= 1);

    // ---- a stranger cannot revoke the owner's link (IDOR guard) --------
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [_authCookie(strangerId)] });
    await helpers.httpRequest({ port: handle.port, path: "/account/wishlist", jar: strangerJar }); // seed CSRF
    var strangerRevoke = await helpers.httpRequest({ port: handle.port, path: "/wishlist/share/" + shareId + "/revoke", method: "POST", jar: strangerJar, form: {} });
    check("stranger revoke → 404 (ownership)",     strangerRevoke.status === 404);
    var stillActive = await wishlistSharing.listSharesForOwner(ownerId);
    check("stranger revoke left the link active",  stillActive[0].revoked_at == null);
    // The public link still resolves after the refused stranger revoke.
    var pubStill = await helpers.httpRequest({ port: handle.port, path: "/wishlist/shared/" + token });
    check("public link survives stranger revoke",  pubStill.status === 200);

    // ---- owner revokes their own link ----------------------------------
    var revoke = await helpers.httpRequest({ port: handle.port, path: "/wishlist/share/" + shareId + "/revoke", method: "POST", jar: ownerJar, form: {} });
    check("owner revoke → 303",                    revoke.status === 303);
    check("owner revoke → back to wishlist",       (revoke.headers["location"] || "") === "/account/wishlist?share=revoked");
    var afterRevoke = await wishlistSharing.listSharesForOwner(ownerId);
    check("link now marked revoked",               afterRevoke[0].revoked_at != null);

    // The public token now 404s (revoked).
    var pubRevoked = await helpers.httpRequest({ port: handle.port, path: "/wishlist/shared/" + token });
    check("revoked token → 404",                   pubRevoked.status === 404);
    check("revoked token → 404 page, no stack",    pubRevoked.body.indexOf("at Object.") === -1 && pubRevoked.body.indexOf("Error:") === -1);

    // ---- unknown / garbage tokens 404, never 500 -----------------------
    var unknownToken = "A".repeat(43);   // well-formed shape, no such link
    var unknown = await helpers.httpRequest({ port: handle.port, path: "/wishlist/shared/" + unknownToken });
    check("unknown token → 404",                   unknown.status === 404);
    var garbage = await helpers.httpRequest({ port: handle.port, path: "/wishlist/shared/not-a-valid-token" });
    check("garbage token → 404 (no 500)",          garbage.status === 404);
    check("garbage token → no raw error leak",     garbage.body.indexOf("TypeError") === -1 && garbage.body.indexOf("at Object.") === -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
