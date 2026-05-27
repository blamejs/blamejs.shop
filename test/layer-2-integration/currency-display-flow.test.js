"use strict";
/**
 * Multi-currency display flow — full HTTP integration.
 *
 * Boots the storefront on an ephemeral port with the catalog + cart wired
 * against an in-memory `node:sqlite` database (the live catalog / cart /
 * fx_rates / currency_rounding migrations), plus the multi-currency
 * display deps (currencyDisplay + currencyRounding). Seeds a USD product,
 * an FX rate (USD→EUR, USD→CHF), and a CHF display-rounding rule, then
 * drives the visitor flow over real HTTP.
 *
 * Covers:
 *   - the footer currency switcher renders the operator's allow-list
 *   - POST /currency sets the sealed cookie + 303-redirects
 *   - PDP + cart prices convert to the chosen currency
 *   - the "charged in <base>" disclosure appears when converting
 *   - base fallback for an unknown currency + a currency with no FX rate
 *   - the CHF display-rounding rule snaps the converted total
 *   - THE CART / ORDER CHARGE CURRENCY STAYS BASE regardless of the
 *     chosen display currency (the authoritative invariant)
 *
 * Network: zero. Every request lands on 127.0.0.1.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var b = bShop.framework;

var MIG_DIR     = nodePath.resolve(__dirname, "..", "..", "migrations-d1");
var MIG_CATALOG = nodePath.join(MIG_DIR, "0001_catalog.sql");
var MIG_CART    = nodePath.join(MIG_DIR, "0002_cart.sql");
var MIG_FX      = nodePath.join(MIG_DIR, "0029_fx_rates.sql");
var MIG_ROUND   = nodePath.join(MIG_DIR, "0132_currency_rounding.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  [MIG_CATALOG, MIG_CART, MIG_FX, MIG_ROUND].forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return {
        rows:      [],
        rowCount:  Number(info.changes),
        lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null,
      };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _seedCatalog(catalog) {
  var product = await catalog.products.create({
    slug:        "widget-pro",
    title:       "Widget Pro",
    description: "The pro variant of the widget.",
    status:      "active",
  });
  var variant = await catalog.variants.create(product.id, {
    sku:     "WDG-PRO-BLK-L",
    options: { color: "black", size: "L" },
  });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });
  return { product: product, variant: variant };
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-ccy-"));
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

// Drive the switcher: POST /currency with a chosen currency, asserting the
// 303 redirect + that the sealed cookie was set, then return the redirect
// target. Reuses the shared cookie jar so the choice rides forward.
async function _chooseCurrency(port, jar, currency, redirectTo) {
  return await helpers.httpRequest({
    port:   port,
    path:   "/currency",
    method: "POST",
    form:   { currency: currency, redirect_to: redirectTo || "/" },
    jar:    jar,
  });
}

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var fx       = bShop.currencyDisplay.create({ query: query });
  var rounding = bShop.currencyRounding.create({ query: query });

  var seeded  = await _seedCatalog(catalog);

  // Operator FX rates: USD→EUR 0.92, USD→CHF 0.90. USD→GBP is left UNSET
  // so the "currency with no FX rate" path falls back to base.
  await fx.setRate({ base: "USD", quote: "EUR", rate: 0.92, source: "ecb" });
  await fx.setRate({ base: "USD", quote: "CHF", rate: 0.90, source: "ecb" });
  // CHF display rounding: nearest 0.05 (Rappenrundung), half_up, display-only.
  await rounding.defineRule({ currency: "CHF", increment_minor: 5, mode: "half_up", applies_to: "display_only" });

  var deps = {
    catalog:                    catalog,
    cart:                       cart,
    currencyDisplay:            fx,
    currencyRounding:           rounding,
    currency_base:              "USD",
    currency_display_options:   ["USD", "EUR", "GBP", "CHF"],
  };

  var handle = await _bootApp(deps);

  try {
    // ---- baseline: no currency cookie → base (USD) display -------------
    var jar0 = helpers.cookieJar();
    var home0 = await helpers.httpRequest({ port: handle.port, path: "/", jar: jar0 });
    check("home returns 200",                       home0.status === 200);
    check("home renders base USD price",            home0.body.indexOf("$29.99") !== -1);
    check("home shows the currency switcher",       home0.body.indexOf("currency-switcher") !== -1);
    check("switcher lists EUR option",              /<option value="EUR"/.test(home0.body));
    check("switcher lists GBP option",              /<option value="GBP"/.test(home0.body));
    check("no disclosure note at base",             home0.body.indexOf("charged in USD") === -1);

    var pdp0 = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro", jar: jar0 });
    check("pdp base shows USD price",               pdp0.body.indexOf("$29.99") !== -1);

    // ---- choose EUR → PDP + grid convert -------------------------------
    var jarEur = helpers.cookieJar();
    var setEur = await _chooseCurrency(handle.port, jarEur, "EUR", "/products/widget-pro");
    check("POST /currency returns 303",             setEur.status === 303);
    check("POST /currency redirects to PDP",        (setEur.headers["location"] || "") === "/products/widget-pro");
    check("POST /currency sets shop_ccy cookie",    !!jarEur.get("shop_ccy"));

    var pdpEur = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro", jar: jarEur });
    check("pdp EUR converts 29.99→27,59",           pdpEur.body.indexOf("27,59") !== -1);
    check("pdp EUR drops the USD string",           pdpEur.body.indexOf("$29.99") === -1);
    check("pdp EUR shows charge disclosure",        pdpEur.body.indexOf("charged in USD") !== -1);
    check("pdp EUR switcher pre-selects EUR",       /<option value="EUR" selected>/.test(pdpEur.body));

    var homeEur = await helpers.httpRequest({ port: handle.port, path: "/", jar: jarEur });
    check("home grid EUR converts price",           homeEur.body.indexOf("27,59") !== -1);

    // ---- cart line + totals convert; CHARGE CURRENCY STAYS USD ---------
    // Add the variant (binds a session) then read the cart in EUR.
    var addEur = await helpers.httpRequest({
      port: handle.port, path: "/cart/lines", method: "POST",
      form: { variant_id: seeded.variant.id, qty: 2 }, jar: jarEur,
    });
    check("add-to-cart returns 303",                addEur.status === 303);

    var cartEur = await helpers.httpRequest({ port: handle.port, path: "/cart", jar: jarEur });
    check("cart returns 200",                       cartEur.status === 200);
    // 2 × 2999 = 5998 USD → ×0.92 = 5518 EUR minor = 55,18 €.
    check("cart EUR line total converts",           cartEur.body.indexOf("55,18") !== -1);
    check("cart EUR shows charge disclosure",       cartEur.body.indexOf("charged in USD") !== -1);
    check("cart EUR drops the USD total string",    cartEur.body.indexOf("$59.98") === -1);

    // The authoritative invariant: the cart row's currency (what the
    // checkout charges) is the base currency, NOT the display currency.
    // Read it straight from the cart primitive — the display layer must
    // never have mutated it.
    var sid = jarEur.get("shop_sid");
    check("cart bound a session",                   !!sid);
    var cartRow = await cart.bySession(sid);
    check("cart row exists",                        !!cartRow);
    check("cart CHARGE currency is base USD",       cartRow.currency === "USD");
    var cartLines = await cart.listLines(cartRow.id);
    check("cart line stored in base USD",           cartLines.length === 1 && cartLines[0].unit_currency === "USD");
    check("cart line unit_amount unchanged (2999)", cartLines[0].unit_amount_minor === 2999);

    // ---- CHF rounding rule snaps the converted price -------------------
    var jarChf = helpers.cookieJar();
    await _chooseCurrency(handle.port, jarChf, "CHF", "/products/widget-pro");
    var pdpChf = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro", jar: jarChf });
    // 2999 USD × 0.90 = 2699 CHF minor; nearest 0.05 (5 minor) half_up → 2700 = 27.00.
    check("pdp CHF rounds 26.99→27.00 (0.05 step)", pdpChf.body.indexOf("27.00") !== -1);
    check("pdp CHF does not show unrounded 26.99",  pdpChf.body.indexOf("26.99") === -1);

    // ---- failure mode: unknown / not-allow-listed currency → base ------
    var jarBad = helpers.cookieJar();
    var setBad = await _chooseCurrency(handle.port, jarBad, "ZZZ", "/");
    check("unknown currency POST still 303",        setBad.status === 303);
    // ZZZ isn't in the allow-list → the route clears the cookie → base.
    var homeBad = await helpers.httpRequest({ port: handle.port, path: "/", jar: jarBad });
    check("unknown currency → base USD display",    homeBad.body.indexOf("$29.99") !== -1);
    check("unknown currency → no disclosure",       homeBad.body.indexOf("charged in USD") === -1);

    // ---- failure mode: allow-listed currency with NO FX rate → base ----
    // GBP is in the allow-list but has no fx_rates row → base fallback,
    // never a broken / NaN price.
    var jarGbp = helpers.cookieJar();
    await _chooseCurrency(handle.port, jarGbp, "GBP", "/");
    var homeGbp = await helpers.httpRequest({ port: handle.port, path: "/", jar: jarGbp });
    check("no-rate currency → base USD display",    homeGbp.body.indexOf("$29.99") !== -1);
    // Scan for a broken price in the visible document, not in opaque SRI
    // blobs — a base64 `integrity="sha384-…"` digest can legitimately
    // contain the substring "NaN" (the consent island's hash does), so
    // strip integrity attributes before the check. Fingerprinted asset
    // names are hex and can't contain "NaN", so only SRI needs stripping.
    var visibleGbp = homeGbp.body.replace(/ integrity="[^"]*"/g, "");
    check("no-rate currency → no broken price",     visibleGbp.indexOf("NaN") === -1 && visibleGbp.indexOf("£") === -1);
    check("no-rate currency → no disclosure",       homeGbp.body.indexOf("charged in USD") === -1);

    // ---- failure mode: garbage cookie value → base --------------------
    // A cookie that isn't a sealed 3-letter code reads as "unset".
    var garbageHome = await helpers.httpRequest({
      port: handle.port, path: "/",
      headers: { cookie: "shop_ccy=not-a-currency" },
    });
    check("garbage cookie → base USD display",      garbageHome.body.indexOf("$29.99") !== -1);
    check("garbage cookie → 200 (no 500)",          garbageHome.status === 200);

    assert.strictEqual(home0.status, 200);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
