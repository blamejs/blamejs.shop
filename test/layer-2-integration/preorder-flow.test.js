"use strict";
/**
 * Pre-order campaigns — full HTTP integration of the reservation surface.
 *
 * Boots a real `b.createApp` server with the storefront + admin wired to a
 * shared `preorder` instance (backed by the order primitive through the same
 * createFromCart adapter server.js uses, so a launch-time conversion lands a
 * real pending order). One in-memory `node:sqlite` DB loaded from the live
 * migrations (catalog / cart / order / customers / preorder). The signed-in
 * customer is read from the sealed `shop_auth` cookie (helpers.authCookie).
 *
 * Coverage:
 *   - an operator opens a campaign for a SKU (admin POST) → the PDP swaps the
 *     add-to-cart buy box for the pre-order CTA + release date + remaining.
 *   - a logged-in customer reserves → it appears in /account/preorders +
 *     decrements availability; the PDP remaining count drops.
 *   - over-cap reserve → clean 4xx PRG (?preorder=unavailable), nothing
 *     reserved (counter unchanged).
 *   - a foreign customer cannot cancel another customer's reservation
 *     (404 IDOR), the reservation stays active.
 *   - cancel (owner) → frees availability; the reservation flips to cancelled.
 *   - launch walks the campaign lifecycle (admin POST /launch) and
 *     convertReservationToOrder lands a real order (the reservation flips to
 *     converted, carrying converted_order_id; the order primitive resolves it).
 *   - unknown campaign / reservation id → 404, never 500; no raw error leak.
 *   - anon reserve / list → 303 to /account/login.
 *
 * The edge↔container CTA parity is asserted by comparing the container PDP's
 * pre-order block against the edge renderer's output for the same campaign
 * shape (both go through the shared preorderCtaShape + _buildPreorderCta).
 *
 * Network: zero — every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs     = require("node:fs");
var nodeOs     = require("node:os");
var nodePath   = require("node:path");
var nodeUrl    = require("node:url");
var nodeModule = require("node:module");
var { DatabaseSync } = require("node:sqlite");

// Let `await import()` of the edge ESM resolve its `import x from "*.json"`
// statements — Node's ESM loader otherwise refuses a JSON import without an
// explicit attribute (worker/render/_lib.js imports asset-manifest.json). The
// wrangler bundler supplies the attribute at build time; this resolve hook
// mirrors it so the parity check can load the edge renderer in-process.
var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

var DAY_MS = 24 * 60 * 60 * 1000;
var TOKEN  = "admin-token-0123456789abcdef-preorder";

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql", "0006_customers.sql", "0124_preorder.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
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

// The createFromCart adapter that bridges the preorder primitive's per-line
// call into the order primitive's signature — identical in shape to the one
// server.js wires so the conversion lands a real pending order.
function _preorderOrderAdapter(order, cart, catalog) {
  return {
    createFromCart: async function (input) {
      var lines = (input && input.lines) || [];
      var currency = (lines[0] && lines[0].currency) || "USD";
      var subtotal = 0;
      var orderLines = [];
      for (var li = 0; li < lines.length; li += 1) {
        var l = lines[li];
        var qty = Number(l.quantity) || 0;
        var unit = Number(l.unit_price_minor) || 0;
        subtotal += qty * unit;
        var variantId = l.variant_id;
        if (variantId == null) { var vrow = await catalog.variants.bySku(l.sku); variantId = vrow ? vrow.id : null; }
        orderLines.push({ variant_id: variantId, sku: l.sku, qty: qty, unit_amount_minor: unit, unit_currency: l.currency || currency });
      }
      var sessionId = b.uuid.v7();
      var madeCart = await cart.create(sessionId, { currency: currency });
      return await order.createFromCart({
        cart_id: madeCart.id, session_id: sessionId, customer_id: input.customer_id,
        currency: currency, lines: orderLines,
        subtotal_minor: subtotal, discount_minor: 0, tax_minor: 0, shipping_minor: 0, grand_total_minor: subtotal,
        ship_to: { country: "US" }, reason: "preorder-launch:" + (input.preorder_campaign_slug || ""),
      });
    },
  };
}

async function _bootApp(deps, adminDeps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-preorder-"));
  process.env.ADMIN_API_KEY = TOKEN;
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, adminDeps);
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

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var order     = bShop.order.create({ query: query, cursorSecret: "preorder-flow-order" });
  var customers = bShop.customers.create({ query: query });
  var preorder  = bShop.preorder.create({ query: query, order: _preorderOrderAdapter(order, cart, catalog) });

  // A product whose lead variant is the campaign's SKU.
  var product = await catalog.products.create({ slug: "starlight-deck", title: "Starlight Deck", description: "A pre-release deck.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "STAR-DECK", options: { edition: "first" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 4999 });

  var launchAt = Date.now() + 30 * DAY_MS;

  var handle = await _bootApp(
    {
      catalog:   catalog,
      cart:      cart,
      order:     order,
      customers: customers,
      preorder:  preorder,
      config:    { shop_name: "blamejs.shop" },
    },
    {
      token:     TOKEN,
      shop_name: "blamejs.shop",
      catalog:   catalog,
      order:     order,
      preorder:  preorder,
    },
  );

  try {
    // ---- admin opens a campaign (capped at 2 units) ----------------------
    var adminJar = helpers.cookieJar();
    var adminLogin = await helpers.httpRequest({ port: handle.port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: adminJar });
    check("admin login then 303",                adminLogin.status === 303);

    var launchLocal = new Date(launchAt).toISOString().slice(0, 16);   // datetime-local
    var define = await helpers.httpRequest({
      port: handle.port, path: "/admin/preorders", method: "POST", jar: adminJar,
      form: {
        slug: "starlight-launch", sku: "STAR-DECK",
        launch_at: launchLocal, full_price_minor: "4999", deposit_minor: "999",
        max_units_available: "2", currency: "USD", marketing_copy: "Reserve the first edition.",
      },
    });
    check("define campaign then 303 ?ok=created", define.status === 303 && (define.headers.location || "").indexOf("ok=created") !== -1);
    var campaignRow = await preorder.getCampaign("starlight-launch");
    check("campaign persisted active",            campaignRow && campaignRow.status === "active" && Number(campaignRow.max_units_available) === 2);

    // The admin list shows the campaign with reserved/cap + a Close action
    // (launch button hidden — the release date hasn't arrived).
    var adminList = await helpers.httpRequest({ port: handle.port, path: "/admin/preorders", jar: adminJar });
    check("admin list then 200",                  adminList.status === 200);
    check("admin list shows the campaign slug",   adminList.body.indexOf("starlight-launch") !== -1);
    check("admin list shows reserved/cap 0 / 2",  adminList.body.indexOf("0</td><td class=\"num\">∞") === -1 && adminList.body.indexOf("0 / 2") !== -1);
    check("admin list offers Close",              adminList.body.indexOf("/admin/preorders/starlight-launch/close") !== -1);
    check("admin list hides Launch (pre-date)",   adminList.body.indexOf("/admin/preorders/starlight-launch/launch") === -1);

    // ---- the PDP shows the pre-order CTA (container render) ---------------
    var pdp = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck" });
    check("PDP then 200",                         pdp.status === 200);
    check("PDP shows the pre-order CTA",          pdp.body.indexOf("Reserve your pre-order") !== -1);
    check("PDP shows the pre-order buy box class", pdp.body.indexOf("pdp__buybox--preorder") !== -1);
    // The server parses the datetime-local form value (launchLocal) as LOCAL
    // time, so the stored instant — and thus the rendered UTC release date —
    // derives from launchLocal, not the original launchAt. Deriving the
    // expected date the same way keeps this correct regardless of the runner's
    // timezone / time-of-day (a UTC-wall string parsed as local can land on
    // the next UTC day).
    check("PDP shows the release date",           pdp.body.indexOf("ships " + new Date(launchLocal).toISOString().slice(0, 10)) !== -1);
    check("PDP shows 2 of 2 remaining",           pdp.body.indexOf("2 of 2 reservations remaining") !== -1);
    check("PDP shows the deposit line",           pdp.body.indexOf("deposit") !== -1);
    check("PDP reserve form posts to the route",  pdp.body.indexOf("action=\"/products/starlight-deck/preorder\"") !== -1);
    check("PDP suppresses the add-to-cart box",   pdp.body.indexOf("$ add to cart") === -1);

    // ---- edge↔container CTA parity ---------------------------------------
    // The edge renderer is loaded as an ES module and exercised with the same
    // campaign shape; its pre-order block must match the container's so the
    // dual render stays consistent. Guard the import behind fs.existsSync —
    // worker/ is excluded from the container build context.
    var edgeProductPath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "product.js");
    if (nodeFs.existsSync(edgeProductPath)) {
      _registerJsonHook();
      var edgeMod = await import(nodeUrl.pathToFileURL(edgeProductPath).href);
      var fmt = function (minor, ccy) { try { return b.money.of(BigInt(minor), ccy).toString(); } catch (_e) { return String(minor); } };
      var edgeShape = edgeMod.preorderCtaShape(campaignRow, 2, fmt, "starlight-deck");
      check("edge preorderCtaShape resolves",      !!edgeShape && edgeShape.product_slug === "starlight-deck");
      check("edge shape release date matches",     edgeShape.release_date_iso === new Date(launchLocal).toISOString().slice(0, 10));
      check("edge shape remaining matches",        edgeShape.remaining_units === 2);
      check("edge shape not sold out",             edgeShape.sold_out === false);
      // A launched campaign yields no CTA shape in either substrate.
      check("edge shape null for non-active",      edgeMod.preorderCtaShape({ status: "launched" }, 0, fmt, "x") === null);
    }

    // ---- anon reserve / list redirect to login ---------------------------
    var anonReserve = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck/preorder", method: "POST", form: { qty: "1" } });
    check("anon reserve then 303 login",          anonReserve.status === 303 && (anonReserve.headers.location || "") === "/account/login");
    var anonList = await helpers.httpRequest({ port: handle.port, path: "/account/preorders" });
    check("anon preorders then 303 login",        anonList.status === 303 && (anonList.headers.location || "") === "/account/login");

    // ---- a logged-in customer reserves -----------------------------------
    var buyer    = b.uuid.v7();
    var stranger = b.uuid.v7();
    var buyerJar = helpers.cookieJar();
    buyerJar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // Seed the double-submit CSRF cookie via an authenticated GET before the
    // reserve POST — the jar replays it as X-CSRF-Token, exercising the real
    // CSRF gate end-to-end (no bypass), exactly as the subscriptions flow does.
    var seed1 = await helpers.httpRequest({ port: handle.port, path: "/account/preorders", jar: buyerJar });
    check("authed preorders list then 200",       seed1.status === 200);

    var reserve = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck/preorder", method: "POST", jar: buyerJar, form: { qty: "1" } });
    check("reserve then 303 ?preorder=reserved",  reserve.status === 303 && (reserve.headers.location || "").indexOf("preorder=reserved") !== -1);

    // Availability decremented.
    var avail1 = await preorder.availability({ slug: "starlight-launch" });
    check("availability decremented to 1",        avail1 && avail1.remaining_units === 1 && avail1.units_reserved === 1);

    // The reservation appears in the customer's list with an active pill + a
    // cancel control.
    var list1 = await helpers.httpRequest({ port: handle.port, path: "/account/preorders", jar: buyerJar });
    check("preorders page then 200",              list1.status === 200);
    check("list shows the campaign",              list1.body.indexOf("starlight-launch") !== -1);
    check("list shows the reserved pill",         list1.body.indexOf("preorder-status--active") !== -1);
    var buyerResvs = await preorder.reservationsForCustomer(buyer);
    check("buyer holds one reservation",          buyerResvs.length === 1 && buyerResvs[0].status === "active");
    var resvId = buyerResvs[0].id;
    check("list shows a cancel control",          list1.body.indexOf("/account/preorders/" + resvId + "/cancel") !== -1);

    // The PDP remaining count now reads 1 of 2.
    var pdp2 = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck" });
    check("PDP now shows 1 of 2 remaining",       pdp2.body.indexOf("1 of 2 reservations remaining") !== -1);

    // ---- a second reservation fills the cap; a third over-caps -----------
    var buyer2Jar = helpers.cookieJar();
    buyer2Jar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });
    var seed2 = await helpers.httpRequest({ port: handle.port, path: "/account/preorders", jar: buyer2Jar });
    check("stranger preorders list then 200",      seed2.status === 200);
    var reserve2 = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck/preorder", method: "POST", jar: buyer2Jar, form: { qty: "1" } });
    check("second reserve then 303 reserved",     reserve2.status === 303 && (reserve2.headers.location || "").indexOf("preorder=reserved") !== -1);
    var avail2 = await preorder.availability({ slug: "starlight-launch" });
    check("availability now 0 (cap reached)",     avail2 && avail2.remaining_units === 0);

    // Over-cap reserve by the buyer → clean 4xx PRG, nothing reserved.
    var overCap = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck/preorder", method: "POST", jar: buyerJar, form: { qty: "1" } });
    check("over-cap reserve then 303 unavailable", overCap.status === 303 && (overCap.headers.location || "").indexOf("preorder=unavailable") !== -1);
    var availAfterOver = await preorder.availability({ slug: "starlight-launch" });
    check("over-cap left the counter at 0",       availAfterOver && availAfterOver.units_reserved === 2);

    // The sold-out PDP renders the disabled control + spoken-for note.
    var pdpFull = await helpers.httpRequest({ port: handle.port, path: "/products/starlight-deck" });
    check("sold-out PDP disables the CTA",         pdpFull.body.indexOf("Pre-orders full") !== -1);

    // ---- IDOR: stranger cannot cancel the buyer's reservation ------------
    var idor = await helpers.httpRequest({ port: handle.port, path: "/account/preorders/" + resvId + "/cancel", method: "POST", jar: buyer2Jar, form: {} });
    check("foreign cancel then 404 (IDOR)",        idor.status === 404);
    var stillActive = await preorder.getReservation(resvId);
    check("foreign cancel left it active",         stillActive && stillActive.status === "active");

    // Malformed + unknown reservation ids → 404, not 500.
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/account/preorders/not-a-uuid/cancel", method: "POST", jar: buyerJar, form: {} });
    check("malformed cancel id then 404",          malformed.status === 404);
    var unknown = await helpers.httpRequest({ port: handle.port, path: "/account/preorders/" + b.uuid.v7() + "/cancel", method: "POST", jar: buyerJar, form: {} });
    check("unknown reservation id then 404",       unknown.status === 404);
    check("no raw error text on 404",              unknown.body.indexOf("preorder:") === -1);

    // ---- owner cancels → frees capacity ----------------------------------
    var cancel = await helpers.httpRequest({ port: handle.port, path: "/account/preorders/" + resvId + "/cancel", method: "POST", jar: buyerJar, form: {} });
    check("owner cancel then 303 ?ok=canceled",    cancel.status === 303 && (cancel.headers.location || "").indexOf("ok=canceled") !== -1);
    var cancelled = await preorder.getReservation(resvId);
    check("reservation now cancelled",             cancelled && cancelled.status === "cancelled");
    var availFreed = await preorder.availability({ slug: "starlight-launch" });
    check("cancel freed one unit",                 availFreed && availFreed.remaining_units === 1 && availFreed.units_reserved === 1);

    // The cancelled reservation reads as "Canceled" + offers no cancel control.
    var list2 = await helpers.httpRequest({ port: handle.port, path: "/account/preorders", jar: buyerJar });
    check("list shows the canceled status",        list2.body.indexOf("preorder-status--cancelled") !== -1);
    check("canceled row hides cancel control",     list2.body.indexOf("/account/preorders/" + resvId + "/cancel") === -1);

    // ---- launch walks the lifecycle + convertReservationToOrder ----------
    // Open a separate campaign with a release date already in the past so the
    // calendar-gated launch is reachable, reserve against it, then launch.
    var pastLaunch = Date.now() - DAY_MS;
    await preorder.defineCampaign({
      slug: "moonlight-launch", sku: "STAR-DECK", launch_at: pastLaunch,
      full_price_minor: 4999, currency: "USD",
    });
    // (Two active campaigns name the same SKU; openCampaignForSku picks the
    // most recently updated — that's the moonlight one now.)
    var resv2 = await preorder.reserve({ campaign_slug: "moonlight-launch", customer_id: buyer, quantity: 1 });
    check("seeded a reservation on the launchable campaign", resv2 && resv2.status === "active");

    var launch = await helpers.httpRequest({ port: handle.port, path: "/admin/preorders/moonlight-launch/launch", method: "POST", jar: adminJar, form: {} });
    check("launch then 303 ?ok=launched",          launch.status === 303 && (launch.headers.location || "").indexOf("ok=launched") !== -1);
    var launchedCampaign = await preorder.getCampaign("moonlight-launch");
    check("campaign now launched",                 launchedCampaign && launchedCampaign.status === "launched");
    var converted = await preorder.getReservation(resv2.id);
    check("reservation now converted",             converted && converted.status === "converted");
    check("converted carries an order id",         converted && typeof converted.converted_order_id === "string" && converted.converted_order_id.length > 0);
    // convertReservationToOrder produced a REAL pending order.
    var landedOrder = await order.get(converted.converted_order_id);
    check("converted order exists (pending)",      landedOrder && landedOrder.status === "pending");
    check("order line carries the reserved SKU",   landedOrder && landedOrder.lines.some(function (l) { return l.sku === "STAR-DECK"; }));
    check("order pinned to the reserving customer", landedOrder && landedOrder.customer_id === buyer);

    // ---- close walks the lifecycle ---------------------------------------
    var closeCampaign = await helpers.httpRequest({ port: handle.port, path: "/admin/preorders/starlight-launch/close", method: "POST", jar: adminJar, form: { reason: "batch fell through" } });
    check("close then 303 ?ok=closed",             closeCampaign.status === 303 && (closeCampaign.headers.location || "").indexOf("ok=closed") !== -1);
    var closed = await preorder.getCampaign("starlight-launch");
    check("campaign now closed",                   closed && closed.status === "closed");

    // ---- unknown campaign launch/close → 404 / clean 4xx, never 500 ------
    var badLaunch = await helpers.httpRequest({ port: handle.port, path: "/admin/preorders/no-such-campaign/launch", method: "POST", jar: adminJar, form: {} });
    check("unknown campaign launch then 303 err",  badLaunch.status === 303 && (badLaunch.headers.location || "").indexOf("err=1") !== -1);

    // A bearer client gets a clean 400 problem (no 500) on a bad launch.
    var bearerBadLaunch = await helpers.httpRequest({ port: handle.port, path: "/admin/preorders/no-such-campaign/launch", method: "POST", headers: { authorization: "Bearer " + TOKEN } });
    check("bearer unknown launch then 400",        bearerBadLaunch.status === 400);
    check("bearer 400 leaks no raw error",         bearerBadLaunch.body.indexOf("preorder:") === -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
