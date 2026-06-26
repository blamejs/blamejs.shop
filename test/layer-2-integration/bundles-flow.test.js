"use strict";
/**
 * Product bundles + quantity discounts — full HTTP integration.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * bundles + quantityDiscounts deps, against one in-memory `node:sqlite`
 * DB loaded from the live migrations. Exercises the customer-facing
 * surface end to end:
 *
 *   - a PDP renders the "Bundle & save" rail (member list + bundle
 *     price vs sum-of-parts) and the quantity-break table;
 *   - "Add bundle to cart" adds every member atomically and the cart
 *     subtotal equals the bundle's quoted price;
 *   - a cart line at a quantity that crosses a break is repriced
 *     server-side (unit + line + cart totals reflect the break);
 *   - a bundle with an out-of-stock member renders unavailable and the
 *     add bounces with a notice (no half-filled cart);
 *   - a malformed bundle add is a 400, an unknown one a 404.
 *
 * Network: zero — every request lands on 127.0.0.1. No hand-rolled
 * mocks; the in-memory query handle drives the production primitives.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0032_bundles.sql", "0044_quantity_discounts.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-bundles-"));
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

function _lineIdsFrom(html) {
  var ids = [];
  var re = /\/cart\/lines\/([0-9a-f-]{36})\/update/g;
  var m;
  while ((m = re.exec(html)) !== null) ids.push(m[1]);
  return ids;
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var bundles = bShop.bundles.create({ query: query, catalog: catalog, cursorSecret: "bundles-flow-cursor" });
  var qd      = bShop.quantityDiscounts.create({ query: query, catalog: catalog });

  // Anchor product (the PDP under test) + two companion products that
  // round out the bundle.
  var anchor = await catalog.products.create({ slug: "operator-tee", title: "Operator Tee", description: "Soft tee.", status: "active" });
  var anchorV = await catalog.variants.create(anchor.id, { sku: "OPR-TEE-L", options: { size: "L" } });
  await catalog.prices.set(anchorV.id, { currency: "USD", amount_minor: 3000 });
  await catalog.inventory.create(anchorV.sku, { stock_on_hand: 100 });

  var capP = await catalog.products.create({ slug: "operator-cap", title: "Operator Cap", description: "Cap.", status: "active" });
  var capV = await catalog.variants.create(capP.id, { sku: "OPR-CAP-OS", options: { size: "OS" } });
  await catalog.prices.set(capV.id, { currency: "USD", amount_minor: 2000 });
  await catalog.inventory.create(capV.sku, { stock_on_hand: 100 });

  // A second bundle member that we'll later mark out of stock.
  var sockP = await catalog.products.create({ slug: "operator-socks", title: "Operator Socks", description: "Socks.", status: "active" });
  var sockV = await catalog.variants.create(sockP.id, { sku: "OPR-SOCK-M", options: { size: "M" } });
  await catalog.prices.set(sockV.id, { currency: "USD", amount_minor: 1000 });
  await catalog.inventory.create(sockV.sku, { stock_on_hand: 50 });

  // A buyable bundle: tee + cap, 10% off the $50 sum-of-parts -> $45.
  await bundles.defineBundle({
    bundle_sku: "BNDL-STARTER",
    title:      "Starter Kit",
    bundle_discount_bps: 1000,
    components: [
      { sku: "OPR-TEE-L",  quantity: 1 },
      { sku: "OPR-CAP-OS", quantity: 1 },
    ],
  });

  // A bundle that includes the socks member (used for the OOS case).
  await bundles.defineBundle({
    bundle_sku: "BNDL-FULL",
    title:      "Full Kit",
    bundle_discount_bps: 0,
    components: [
      { sku: "OPR-TEE-L",   quantity: 1 },
      { sku: "OPR-SOCK-M",  quantity: 2 },
    ],
  });

  // A single multi-quantity member whose discounted price is NOT divisible
  // by the member quantity — exercises the bundle-allocation residual path
  // that has no quantity-1 line to absorb the shortfall exactly.
  //   socks 1000 x5 = 5000 list; 12.34% off -> discount floor(5000*1234/10000)
  //   = 617; quoted bundle price = 5000 - 617 = 4383. floor(4383/5) = 876, so
  //   a uniform integer per-unit price realizes 5*876 = 4380 (<= 4383) or, by
  //   rounding the last unit up, 5*877 = 4385 (> 4383 — an overcharge above
  //   the quote). The allocator must take 4380, never 4385.
  await bundles.defineBundle({
    bundle_sku: "BNDL-SOX5",
    title:      "Sock Five-Pack",
    bundle_discount_bps: 1234,
    components: [
      { sku: "OPR-SOCK-M", quantity: 5 },
    ],
  });

  // Two multi-quantity members (no quantity-1 line) whose floor residual IS
  // recoverable by a non-overshooting bump on the larger-quantity member —
  // a greedy smallest-first pass would strand it and undercharge, and the
  // pre-fix overshoot would have overcharged. cap 2000 x3 + sock 1000 x4 =
  // 10000 list; 10.03% off -> quote 8997. The floor leaves 4 cents, exactly
  // recoverable by +1 on the qty-4 sock line (4 cents), landing on 8997.
  await bundles.defineBundle({
    bundle_sku: "BNDL-RECOV",
    title:      "Cap & Socks Combo",
    bundle_discount_bps: 1003,
    components: [
      { sku: "OPR-CAP-OS",  quantity: 3 },
      { sku: "OPR-SOCK-M",  quantity: 4 },
    ],
  });

  // Quantity breaks on the tee: 5+ -> 10% off, 10+ -> 20% off.
  await qd.defineTier({
    scope:    "sku",
    scope_id: "OPR-TEE-L",
    tiers: [
      { min_quantity: 5,  discount_kind: "percent_off", value: 1000 },
      { min_quantity: 10, discount_kind: "percent_off", value: 2000 },
    ],
  });

  var handle = await _bootApp({ catalog: catalog, cart: cart, bundles: bundles, quantityDiscounts: qd });

  try {
    // ---- PDP rail + quantity-break table ------------------------------
    var pdp = await helpers.httpRequest({ port: handle.port, path: "/products/operator-tee" });
    check("PDP 200",                       pdp.status === 200);
    check("PDP shows Bundle & save",       pdp.body.indexOf("Bundle &amp; save") !== -1);
    check("PDP shows Starter Kit",         pdp.body.indexOf("Starter Kit") !== -1);
    check("PDP lists cap member",          pdp.body.indexOf("Operator Cap") !== -1);
    check("PDP shows sum-of-parts $50",    pdp.body.indexOf("$50.00") !== -1);
    check("PDP shows bundle price $45",    pdp.body.indexOf("$45.00") !== -1);
    check("PDP shows save $5",             pdp.body.indexOf("You save $5.00") !== -1);
    check("PDP has add-bundle form",       pdp.body.indexOf("/cart/bundle") !== -1);
    check("PDP shows qty-break table",     pdp.body.indexOf("Buy more, save more") !== -1);
    check("PDP qty break 5-9 -> $27",      pdp.body.indexOf("$27.00") !== -1);  // 30.00 - 10%
    check("PDP qty break 10+ -> $24",      pdp.body.indexOf("$24.00") !== -1);  // 30.00 - 20%

    // The Full Kit (with socks in stock) is also buyable here.
    check("PDP shows Full Kit",            pdp.body.indexOf("Full Kit") !== -1);

    // ---- add bundle to cart, atomic, at the bundle price --------------
    var jar = helpers.cookieJar();
    var addB = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-STARTER" }, jar: jar });
    check("add-bundle 303 -> /cart",       addB.status === 303 && (addB.headers["location"] || "") === "/cart");

    var cart1 = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar });
    check("cart has tee",                  cart1.body.indexOf("OPR-TEE-L") !== -1);
    check("cart has cap",                  cart1.body.indexOf("OPR-CAP-OS") !== -1);
    var sid = jar.get("shop_sid");
    check("cart session set",              !!sid);

    // Subtotal must equal the bundle's quoted price ($45.00), not the
    // $50 sum of list prices — the discount allocation is authoritative.
    var c = await cart.bySession(sid);
    var lines = await cart.listLines(c.id);
    var subtotal = 0;
    for (var i = 0; i < lines.length; i += 1) subtotal += lines[i].qty * lines[i].unit_amount_minor;
    check("bundle cart subtotal == $45",   subtotal === 4500);
    check("cart subtotal renders $45.00",  cart1.body.indexOf("$45.00") !== -1);

    // ---- multi-quantity member: realized subtotal never exceeds the quote
    // The Sock Five-Pack quotes 4383 but a single integer per-unit price on a
    // qty-5 line can only realize a multiple of 5 (4380 or 4385). The allocator
    // must round the realized subtotal DOWN to 4380 (a 3-cent undercharge in
    // the customer's favour), never UP to 4385, which would charge above the
    // advertised bundle price.
    var jarSox = helpers.cookieJar();
    var addSox = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-SOX5" }, jar: jarSox });
    check("add sock-pack 303 -> /cart",    addSox.status === 303);
    var cSox = await cart.bySession(jarSox.get("shop_sid"));
    var linesSox = await cart.listLines(cSox.id);
    var subtotalSox = 0;
    for (var sx = 0; sx < linesSox.length; sx += 1) subtotalSox += linesSox[sx].qty * linesSox[sx].unit_amount_minor;
    check("sock-pack realized subtotal never exceeds the 4383 quote", subtotalSox <= 4383);
    check("sock-pack realized subtotal is the floored 4380 (not the 4385 overcharge)", subtotalSox === 4380);

    // ---- recoverable residual across multi-quantity members lands exactly
    // Cap & Socks Combo quotes 8997; the floor strands 4 cents recoverable by
    // a single +1 on the qty-4 sock line (4 cents). The allocator must take
    // that exact recovery (8997), not strand it (greedy undercharge 8993) nor
    // overshoot (pre-fix 8999).
    var jarRec = helpers.cookieJar();
    var addRec = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-RECOV" }, jar: jarRec });
    check("combo add 303 -> /cart",        addRec.status === 303);
    var cRec = await cart.bySession(jarRec.get("shop_sid"));
    var linesRec = await cart.listLines(cRec.id);
    var subtotalRec = 0;
    for (var rc = 0; rc < linesRec.length; rc += 1) subtotalRec += linesRec[rc].qty * linesRec[rc].unit_amount_minor;
    check("combo realized subtotal never exceeds the 8997 quote", subtotalRec <= 8997);
    check("combo recovers the residual exactly to the 8997 quote", subtotalRec === 8997);

    // ---- bundle add over a pre-existing member: keep qty, honor bundle price
    // A member already in the cart standalone (one tee at its $30 list price)
    // must KEEP that unit when the bundle is added, and the bundle's tee must
    // land at the bundle price — so the cart holds 2 tees worth $30 + $27 = $57
    // plus the $18 cap = $75. The bundle's own contribution stays the quoted
    // $45 (tee $27 + cap $18); the pre-existing tee neither vanishes (which
    // would undercharge by dropping it) nor steals the bundle discount (which
    // would undercharge the standalone unit). Before the fix the qty-bump kept
    // the $30 list price for the bundle's tee and overcharged.
    var jarSF = helpers.cookieJar();
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines", method: "POST", form: { variant_id: anchorV.id, qty: 1 }, jar: jarSF });
    await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-STARTER" }, jar: jarSF });
    var cSF = await cart.bySession(jarSF.get("shop_sid"));
    var linesSF = await cart.listLines(cSF.id);
    var teeSF = null, subtotalSF = 0;
    for (var sf = 0; sf < linesSF.length; sf += 1) {
      subtotalSF += linesSF[sf].qty * linesSF[sf].unit_amount_minor;
      if (linesSF[sf].variant_id === anchorV.id) teeSF = linesSF[sf];
    }
    check("standalone-first keeps both tee units", teeSF && teeSF.qty === 2);
    check("standalone-first subtotal == $75 (kept $30 tee + $45 bundle)", subtotalSF === 7500);

    // ---- adding the same bundle twice yields two bundles ------------------
    // Re-adding a bundle adds another bundle's worth of units (not idempotent,
    // not a no-op), so the realized subtotal is two bundles = $90.
    var jarTwice = helpers.cookieJar();
    await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-STARTER" }, jar: jarTwice });
    await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-STARTER" }, jar: jarTwice });
    var cTwice = await cart.bySession(jarTwice.get("shop_sid"));
    var linesTwice = await cart.listLines(cTwice.id);
    var subtotalTwice = 0;
    for (var tw = 0; tw < linesTwice.length; tw += 1) subtotalTwice += linesTwice[tw].qty * linesTwice[tw].unit_amount_minor;
    check("same-bundle-twice subtotal == $90 (two bundles)", subtotalTwice === 9000);

    // ---- quantity-break repricing in the cart -------------------------
    // Direct-add path: a fresh cart, add 5 tees at the catalog price,
    // confirm the 10%-off break drops the unit to $27 and the line to
    // $135.00 in the rendered totals.
    var jar2 = helpers.cookieJar();
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines", method: "POST", form: { variant_id: anchorV.id, qty: 5 }, jar: jar2 });
    var cartQ = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar2 });
    check("qty-break cart 200",            cartQ.status === 200);
    check("qty-break unit $27.00",         cartQ.body.indexOf("$27.00") !== -1);
    check("qty-break line $135.00",        cartQ.body.indexOf("$135.00") !== -1);

    // Push to 10 -> 20%-off break ($30->$24, line $240.00).
    var ids2 = _lineIdsFrom(cartQ.body);
    check("qty-break exposes line id",     ids2.length >= 1);
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines/" + ids2[0] + "/update", method: "POST", form: { qty: 10 }, jar: jar2 });
    var cartQ2 = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar2 });
    check("qty-break unit $24.00 at 10",   cartQ2.body.indexOf("$24.00") !== -1);
    check("qty-break line $240.00 at 10",  cartQ2.body.indexOf("$240.00") !== -1);

    // Below-the-first-break quantity falls back to the base price.
    var jar4 = helpers.cookieJar();
    await helpers.httpRequest({ port: handle.port, path: "/cart/lines", method: "POST", form: { variant_id: anchorV.id, qty: 2 }, jar: jar4 });
    var cartBase = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jar4 });
    check("below-break unit $30.00",       cartBase.body.indexOf("$30.00") !== -1);
    check("below-break line $60.00",       cartBase.body.indexOf("$60.00") !== -1);

    // ---- unavailable member: socks go out of stock -------------------
    // Hold all 50 socks so available stock hits 0; the Full Kit becomes
    // unavailable on the PDP and the add bounces with a notice.
    await query("UPDATE inventory SET stock_held = stock_on_hand WHERE sku = ?1", ["OPR-SOCK-M"]);
    var pdp2 = await helpers.httpRequest({ port: handle.port, path: "/products/operator-tee" });
    check("OOS bundle shows unavailable",  pdp2.body.indexOf("out of stock") !== -1);
    check("OOS bundle marked class",       pdp2.body.indexOf("bundle-card--unavailable") !== -1);

    var jar3 = helpers.cookieJar();
    var addOOS = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-FULL" }, jar: jar3 });
    check("OOS bundle add bounces",        addOOS.status === 303 && (addOOS.headers["location"] || "").indexOf("bundle=unavailable") !== -1);
    var sid3 = jar3.get("shop_sid");
    if (sid3) {
      var c3 = await cart.bySession(sid3);
      var lines3 = c3 ? await cart.listLines(c3.id) : [];
      check("OOS bundle added nothing",    lines3.length === 0);
    } else {
      check("OOS bundle added nothing",    true);
    }

    // ---- malformed + unknown bundle add ------------------------------
    var bad = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "not a sku!!" }, jar: helpers.cookieJar() });
    check("malformed bundle add 400",      bad.status === 400);
    var missing = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: { bundle_sku: "BNDL-NOPE" }, jar: helpers.cookieJar() });
    check("unknown bundle add 404",        missing.status === 404);
    var empty = await helpers.httpRequest({ port: handle.port, path: "/cart/bundle", method: "POST", form: {}, jar: helpers.cookieJar() });
    check("empty bundle add 400",          empty.status === 400);

    // ---- PDP with no bundles / no breaks renders no rail -------------
    var bareP = await catalog.products.create({ slug: "lonely-mug", title: "Lonely Mug", description: "Just a mug.", status: "active" });
    var bareV = await catalog.variants.create(bareP.id, { sku: "MUG-PLAIN", options: {} });
    await catalog.prices.set(bareV.id, { currency: "USD", amount_minor: 1500 });
    var bare = await helpers.httpRequest({ port: handle.port, path: "/products/lonely-mug" });
    check("bare PDP 200",                  bare.status === 200);
    check("bare PDP no bundle rail",       bare.body.indexOf("Bundle &amp; save") === -1);
    check("bare PDP no qty-break table",   bare.body.indexOf("Buy more, save more") === -1);

    // ---- malformed product slug is a 404, not a 500 -----------------
    var nf = await helpers.httpRequest({ port: handle.port, path: "/products/this-does-not-exist" });
    check("missing product 404",           nf.status === 404);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
