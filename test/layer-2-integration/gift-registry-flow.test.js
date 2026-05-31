"use strict";
/**
 * Gift registry — full HTTP integration of the owner manage surface and the
 * public, no-auth giver view.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * gift-registry + cart + catalog + customers deps, against one in-memory
 * `node:sqlite` DB loaded from the live migrations. Owner actions read
 * `{ customer_id }` from the sealed `shop_auth` cookie (minted via
 * `b.vault.seal` after boot, not a WebAuthn ceremony); the public giver view
 * takes no auth at all — the slug (resolved through the privacy gate) IS the
 * access.
 *
 * Covers: an owner creates a registry + adds an item → it appears on
 * /account/registry with progress; the public /registry/:slug (no auth)
 * renders the item + desired qty; a private registry is 404 publicly; a giver
 * mark-purchased action decrements remaining (progressFor) + reflects on the
 * page; a second customer cannot manage (add/remove/close) the first owner's
 * registry (ownership 404); an unknown slug 404s (no 500); the public page
 * carries noindex + leaks neither the owner customer id / shipping address nor
 * any buyer identity.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0086_gift_registry.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-reg-"));
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

async function _run() {
  var query        = _makeQuery();
  var catalog      = bShop.catalog.create({ query: query });
  var cart         = bShop.cart.create({ query: query, catalog: catalog });
  var giftRegistry = bShop.giftRegistry.create({ query: query, catalog: catalog });
  var customers    = bShop.customers.create({ query: query });

  // A sellable product whose sku the registry item references.
  var product = await catalog.products.create({ slug: "stand-mixer", title: "Stand Mixer", description: "A giftable stand mixer.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "MIXER-PRO", options: { color: "violet" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 24999 });

  var ownerId    = b.uuid.v7();
  var strangerId = b.uuid.v7();
  // A shipping address id seeded onto the registry so the public view can be
  // asserted NOT to leak it (owner PII).
  var secretShipId = b.uuid.v7();

  var handle = await _bootApp({
    catalog: catalog, cart: cart, giftRegistry: giftRegistry, customers: customers,
  });

  try {
    var ownerJar = helpers.cookieJar();
    ownerJar.capture({ "set-cookie": [_authCookie(ownerId)] });

    // ---- anon owner actions redirect to login --------------------------
    var anonCreate = await helpers.httpRequest({ port: handle.port, path: "/account/registry", method: "POST", form: { slug: "x", title: "X", recipient_name: "X", occasion: "wedding", privacy: "public" } });
    check("anon create-registry → 303 login", anonCreate.status === 303 && (anonCreate.headers["location"] || "") === "/account/login");

    // ---- owner registry list page (seeds CSRF cookie) ------------------
    var listPage = await helpers.httpRequest({ port: handle.port, path: "/account/registry", jar: ownerJar });
    check("owner registry list → 200",            listPage.status === 200);
    check("owner registry list shows create form", /action="\/account\/registry"/.test(listPage.body));
    check("owner registry list is noindex",        /<meta name="robots" content="noindex/.test(listPage.body));

    // ---- create a PUBLIC registry --------------------------------------
    var created = await helpers.httpRequest({
      port: handle.port, path: "/account/registry", method: "POST", jar: ownerJar,
      form: { slug: "alice-and-bob-2026", title: "Alice & Bob's Wedding", recipient_name: "Alice & Bob", occasion: "wedding", privacy: "public", event_date: "2026-09-01" },
    });
    check("create-registry → 303 to manage",      created.status === 303 && (created.headers["location"] || "").indexOf("/account/registry/alice-and-bob-2026") === 0);

    // It is persisted + owner-scoped.
    var ownerRegs = await giftRegistry.listForOwner(ownerId);
    check("registry persisted for the owner",      ownerRegs.length === 1);
    check("registry owner-scoped",                 ownerRegs[0].owner_customer_id === ownerId);
    check("registry slug as posted",               ownerRegs[0].slug === "alice-and-bob-2026");
    // Seed an owner-PII shipping address id directly (the create form doesn't
    // collect it) so the public-view redaction assertion has a real secret.
    await giftRegistry.update("alice-and-bob-2026", { shipping_address_id: secretShipId });

    // ---- add an item via the owner route -------------------------------
    var addItem = await helpers.httpRequest({
      port: handle.port, path: "/account/registry/alice-and-bob-2026/items", method: "POST", jar: ownerJar,
      form: { sku: "MIXER-PRO", quantity_desired: "2", priority: "1" },
    });
    check("add-item → 303",                        addItem.status === 303 && (addItem.headers["location"] || "").indexOf("ok=added") !== -1);

    // The manage page now shows the item with progress + the share URL.
    var managePage = await helpers.httpRequest({ port: handle.port, path: "/account/registry/alice-and-bob-2026", jar: ownerJar });
    check("manage page → 200",                     managePage.status === 200);
    check("manage page shows the product",         managePage.body.indexOf("Stand Mixer") !== -1);
    check("manage page shows progress (0 of 2)",   managePage.body.indexOf("0 of 2 purchased") !== -1);
    check("manage page surfaces the public share URL",
      /https?:\/\/[^/"\s]+\/registry\/alice-and-bob-2026/.test(managePage.body));
    // The share URL is a correct absolute <origin>/registry/<slug> — not a
    // path-mangled one built by trimming a path off the canonical.
    var shareUrl = (managePage.body.match(/https?:\/\/[^"\s]*\/registry\/alice-and-bob-2026/) || [])[0];
    check("share URL is <origin>/registry/<slug>, no mangled path",
      shareUrl != null && /^https?:\/\/[^/]+\/registry\/alice-and-bob-2026$/.test(shareUrl));

    // ---- public giver view (NO auth) -----------------------------------
    var pub = await helpers.httpRequest({ port: handle.port, path: "/registry/alice-and-bob-2026" });
    check("public registry view → 200",            pub.status === 200);
    check("public view renders the registry title", pub.body.indexOf("Alice &amp; Bob&#x27;s Wedding") !== -1 || pub.body.indexOf("Alice &amp; Bob's Wedding") !== -1);
    check("public view renders the item",          pub.body.indexOf("Stand Mixer") !== -1);
    check("public view shows desired qty (0 of 2)", pub.body.indexOf("0 of 2 purchased") !== -1);
    check("public view links the PDP",             pub.body.indexOf("/products/stand-mixer") !== -1);
    check("public view is noindex",                /<meta name="robots" content="noindex/.test(pub.body));
    // Redaction — owner customer id + shipping address id must NOT appear.
    check("public view redacts owner customer id", pub.body.indexOf(ownerId) === -1);
    check("public view redacts owner shipping address id", pub.body.indexOf(secretShipId) === -1);
    // The mark-purchased + add-to-cart controls are present for the unfilled item.
    check("public view offers a mark-purchased form", /action="\/registry\/alice-and-bob-2026\/items\/[^"]+\/purchase"/.test(pub.body));
    check("public view offers an add-to-cart form",   /action="\/cart\/lines"/.test(pub.body) && pub.body.indexOf("name=\"variant_id\"") !== -1);

    // ---- a giver marks one purchased (anonymous) -----------------------
    var rawItems = (await giftRegistry.getBySlug("alice-and-bob-2026")).items;
    var itemId = rawItems[0].id;
    var giverJar = helpers.cookieJar();
    // Seed the CSRF cookie for the anonymous giver via a GET of the public page.
    await helpers.httpRequest({ port: handle.port, path: "/registry/alice-and-bob-2026", jar: giverJar });
    var gift = await helpers.httpRequest({
      port: handle.port, path: "/registry/alice-and-bob-2026/items/" + itemId + "/purchase", method: "POST", jar: giverJar,
      form: { quantity: "1" },
    });
    check("giver mark-purchased → 303",            gift.status === 303 && (gift.headers["location"] || "").indexOf("ok=gifted") !== -1);

    // progressFor reflects the decrement (1 of 2 now purchased, 1 remaining).
    var prog = await giftRegistry.progressFor("alice-and-bob-2026");
    check("progressFor: 1 purchased",              prog.total_purchased === 1);
    check("progressFor: item remaining decremented to 1", prog.items[0].remaining === 1);

    // The public page reflects the new count.
    var pubAfter = await helpers.httpRequest({ port: handle.port, path: "/registry/alice-and-bob-2026" });
    check("public view reflects 1 of 2 purchased", pubAfter.body.indexOf("1 of 2 purchased") !== -1);
    // An anonymous gift records no buyer id (redaction at the primitive layer).
    var withPurchases = await giftRegistry.getBySlug("alice-and-bob-2026", { include_purchased: true });
    check("anonymous gift records no revealed buyer", withPurchases.purchases.length === 1 && withPurchases.purchases[0].buyer_customer_id == null);

    // ---- a stranger cannot manage the owner's registry (ownership 404) --
    var strangerJar = helpers.cookieJar();
    strangerJar.capture({ "set-cookie": [_authCookie(strangerId)] });
    await helpers.httpRequest({ port: handle.port, path: "/account/registry", jar: strangerJar }); // seed CSRF
    var strangerAdd = await helpers.httpRequest({
      port: handle.port, path: "/account/registry/alice-and-bob-2026/items", method: "POST", jar: strangerJar,
      form: { sku: "MIXER-PRO", quantity_desired: "1" },
    });
    check("stranger add-item → 404 (ownership)",   strangerAdd.status === 404);
    var strangerClose = await helpers.httpRequest({
      port: handle.port, path: "/account/registry/alice-and-bob-2026/close", method: "POST", jar: strangerJar, form: {},
    });
    check("stranger close → 404 (ownership)",      strangerClose.status === 404);
    var strangerManage = await helpers.httpRequest({ port: handle.port, path: "/account/registry/alice-and-bob-2026", jar: strangerJar });
    check("stranger manage page → 404 (ownership)", strangerManage.status === 404);
    // The registry is untouched after the refused stranger writes.
    var stillThere = await giftRegistry.getRegistry("alice-and-bob-2026");
    check("stranger writes left the registry active + intact", stillThere && stillThere.status === "active");
    var stillOneItem = (await giftRegistry.getBySlug("alice-and-bob-2026")).items;
    check("stranger add-item didn't land an item", stillOneItem.length === 1);

    // ---- a PRIVATE registry is not publicly viewable -------------------
    await giftRegistry.createRegistry({
      owner_customer_id: ownerId, slug: "private-shower-2026", title: "Private Shower",
      recipient_name: "Carol", occasion: "baby", privacy: "private",
    });
    var privatePub = await helpers.httpRequest({ port: handle.port, path: "/registry/private-shower-2026" });
    check("private registry → 404 publicly",       privatePub.status === 404);
    check("private 404 leaks no stack",            privatePub.body.indexOf("at Object.") === -1 && privatePub.body.indexOf("Error:") === -1);
    // The owner CAN still manage their own private registry.
    var ownerPrivate = await helpers.httpRequest({ port: handle.port, path: "/account/registry/private-shower-2026", jar: ownerJar });
    check("owner can manage their own private registry", ownerPrivate.status === 200);
    check("private manage page notes no public link", ownerPrivate.body.indexOf("This registry is private") !== -1);

    // ---- unknown / garbage slugs 404, never 500 ------------------------
    var unknown = await helpers.httpRequest({ port: handle.port, path: "/registry/no-such-registry-9999" });
    check("unknown slug → 404",                    unknown.status === 404);
    var garbage = await helpers.httpRequest({ port: handle.port, path: "/registry/Not_A_Valid_Slug" });
    check("garbage slug → 404 (no 500)",           garbage.status === 404);
    check("garbage slug → no raw error leak",      garbage.body.indexOf("TypeError") === -1 && garbage.body.indexOf("at Object.") === -1);
    // A purchase POST against an unknown registry 404s, never 500s.
    var ghostBuy = await helpers.httpRequest({ port: handle.port, path: "/registry/no-such-registry-9999/items/" + itemId + "/purchase", method: "POST", jar: giverJar, form: { quantity: "1" } });
    check("purchase on unknown registry → 404 (no 500)", ghostBuy.status === 404);

    // ---- owner closes their registry (FSM transition) ------------------
    var close = await helpers.httpRequest({ port: handle.port, path: "/account/registry/alice-and-bob-2026/close", method: "POST", jar: ownerJar, form: {} });
    check("owner close → 303",                     close.status === 303 && (close.headers["location"] || "").indexOf("ok=closed") !== -1);
    var closed = await giftRegistry.getRegistry("alice-and-bob-2026");
    check("registry now closed",                   closed.status === "closed");
    // A closed registry refuses a further giver purchase (no new gift lands).
    var afterCloseBuy = await helpers.httpRequest({ port: handle.port, path: "/registry/alice-and-bob-2026/items/" + itemId + "/purchase", method: "POST", jar: giverJar, form: { quantity: "1" } });
    check("purchase on a closed registry → 303 (no 500)", afterCloseBuy.status === 303);
    var progAfterClose = await giftRegistry.progressFor("alice-and-bob-2026");
    check("closed-registry purchase landed nothing", progAfterClose.total_purchased === 1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
