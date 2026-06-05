"use strict";
/**
 * Commerce-config console — the browser-side admin screens for tax
 * rates, shipping zones, and discounts (automatic rules + coupon-
 * stacking policies).
 *
 * Boots b.createApp with admin.mount wired to the taxRates / shipping-
 * Zones / autoDiscount / couponStacking primitives, then exercises each
 * screen's create / list / edit / archive end-to-end over a browser
 * cookie session, plus the bearer JSON contract and the auth gate.
 * Network: zero.
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
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql",
  "0058_tax_rates.sql", "0106_shipping_zones.sql", "0107_auto_discount.sql",
  "0209_auto_discount_unlock_code.sql", "0067_coupon_stacking.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

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
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "commerce-config" });
  var config  = bShop.config.create({ query: query });
  var taxRates       = bShop.taxRates.create({ query: query });
  var shippingZones  = bShop.shippingZones.create({ query: query });
  var autoDiscount   = bShop.autoDiscount.create({ query: query });
  var couponStacking = bShop.couponStacking.create({ query: query });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-commerce-cfg-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop",
        taxRates: taxRates, shippingZones: shippingZones,
        autoDiscount: autoDiscount, couponStacking: couponStacking,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Nav links present for all three wired sections.
    var home = await helpers.httpRequest({ port: port, path: "/admin", jar: jar });
    check("nav includes Tax",                    home.body.indexOf("\"/admin/tax-rates\"") !== -1);
    check("nav includes Shipping",               home.body.indexOf("\"/admin/shipping\"") !== -1);
    check("nav includes Discounts",              home.body.indexOf("\"/admin/discounts\"") !== -1);

    // ---- tax rates ----------------------------------------------------

    // Empty jurisdiction → the picker form, no table.
    var taxLanding = await helpers.httpRequest({ port: port, path: "/admin/tax-rates", jar: jar });
    check("tax page then 200",                   taxLanding.status === 200);
    check("tax shows jurisdiction picker",       taxLanding.body.indexOf("name=\"jurisdiction\"") !== -1);

    // Create a default rate for US.
    var taxCreate = await helpers.httpRequest({
      port: port, path: "/admin/tax-rates", method: "POST", jar: jar,
      form: { jurisdiction: "US", rate_bps: "725", source: "manual" },
    });
    check("tax create then 303",                 taxCreate.status === 303);
    check("tax create redirects created",        (taxCreate.headers.location || "").indexOf("created=1") !== -1);
    var usRates = await taxRates.listForJurisdiction({ jurisdiction: "US", include_expired: true });
    check("tax rate persisted",                  usRates.length === 1 && Number(usRates[0].rate_bps) === 725);
    var rateId = usRates[0].id;

    // The list renders the rate for the jurisdiction.
    var taxList = await helpers.httpRequest({ port: port, path: "/admin/tax-rates?jurisdiction=US", jar: jar });
    check("tax list shows the rate",             taxList.body.indexOf("7.25%") !== -1);
    check("tax list shows add form",             taxList.body.indexOf("Add a rate for US") !== -1);

    // Edit the rate's bps via the row form → 303 updated; persists.
    var taxEdit = await helpers.httpRequest({
      port: port, path: "/admin/tax-rates/" + rateId + "/edit", method: "POST", jar: jar,
      form: { jurisdiction: "US", rate_bps: "800" },
    });
    check("tax edit then 303",                   taxEdit.status === 303);
    check("tax edit redirects updated",          (taxEdit.headers.location || "").indexOf("updated=1") !== -1);
    var afterEdit = await taxRates.listForJurisdiction({ jurisdiction: "US", include_expired: true });
    check("tax rate bps updated",                Number(afterEdit[0].rate_bps) === 800);

    // Bearer JSON list contract.
    var taxApi = await helpers.httpRequest({ port: port, path: "/admin/tax-rates?jurisdiction=US", headers: bearer });
    check("tax API JSON",                        (taxApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("tax API returns the rate",            JSON.parse(taxApi.body).rows.length === 1);

    // Archive via the row form → 303 archived; rate drops from live list.
    var taxArchive = await helpers.httpRequest({
      port: port, path: "/admin/tax-rates/" + rateId + "/archive", method: "POST", jar: jar,
      form: { jurisdiction: "US" },
    });
    check("tax archive then 303",                taxArchive.status === 303);
    var liveAfter = await taxRates.listForJurisdiction({ jurisdiction: "US" });
    check("tax rate archived (off live list)",   liveAfter.length === 0);

    // A bad rate (out-of-range bps) re-renders with a notice, never 500.
    var taxBad = await helpers.httpRequest({
      port: port, path: "/admin/tax-rates", method: "POST", jar: jar,
      form: { jurisdiction: "US", rate_bps: "99999", source: "manual" },
    });
    check("tax bad bps then 400",                taxBad.status === 400);

    // ---- shipping zones -----------------------------------------------

    var shipCreate = await helpers.httpRequest({
      port: port, path: "/admin/shipping", method: "POST", jar: jar,
      form: { slug: "domestic-us", title: "Domestic (US)", country: "US", service_label: "Standard", rate_minor: "500", currency: "USD" },
    });
    check("shipping create then 303",            shipCreate.status === 303);
    check("shipping create redirects created",   (shipCreate.headers.location || "").indexOf("created=1") !== -1);
    var zone = await shippingZones.getZone("domestic-us");
    check("zone persisted",                      !!zone && zone.regions[0].country === "US" && zone.rates[0].rate_minor === 500);

    var shipList = await helpers.httpRequest({ port: port, path: "/admin/shipping", jar: jar });
    check("shipping list shows the zone",        shipList.body.indexOf("Domestic (US)") !== -1);
    check("shipping list links manage",          shipList.body.indexOf("/admin/shipping/domestic-us") !== -1);

    // Zone detail + edit (title change + rates JSON replace).
    var zoneDetail = await helpers.httpRequest({ port: port, path: "/admin/shipping/domestic-us", jar: jar });
    check("zone detail then 200",                zoneDetail.status === 200);
    check("zone detail shows rate",              zoneDetail.body.indexOf("Standard") !== -1);
    var shipEdit = await helpers.httpRequest({
      port: port, path: "/admin/shipping/domestic-us/edit", method: "POST", jar: jar,
      form: { title: "Domestic US (lower 48)", active_present: "1", active: "on",
              rates_json: "[{\"rate_minor\":700,\"currency\":\"USD\",\"service_label\":\"Ground\"}]" },
    });
    check("zone edit then 303",                  shipEdit.status === 303);
    var editedZone = await shippingZones.getZone("domestic-us");
    check("zone title + rates updated",          editedZone.title === "Domestic US (lower 48)" && editedZone.rates[0].rate_minor === 700 && editedZone.rates[0].service_label === "Ground");

    // Bearer JSON contract.
    var shipApi = await helpers.httpRequest({ port: port, path: "/admin/shipping", headers: bearer });
    check("shipping API JSON",                   (shipApi.headers["content-type"] || "").indexOf("application/json") === 0);
    check("shipping API returns the zone",       JSON.parse(shipApi.body).rows.length === 1);

    // Archive.
    var shipArchive = await helpers.httpRequest({ port: port, path: "/admin/shipping/domestic-us/archive", method: "POST", jar: jar });
    check("shipping archive then 303",           shipArchive.status === 303);
    check("zone archived",                       (await shippingZones.getZone("domestic-us")).archived_at != null);

    // Duplicate slug re-render is a 400 notice, not a 500.
    var shipDup = await helpers.httpRequest({
      port: port, path: "/admin/shipping", method: "POST", jar: jar,
      form: { slug: "domestic-us", title: "dup", country: "US", service_label: "X", rate_minor: "1", currency: "USD" },
    });
    check("shipping dup slug then 400",          shipDup.status === 400);

    // ---- discounts (auto rules + stacking policies) -------------------

    var discCreate = await helpers.httpRequest({
      port: port, path: "/admin/discounts", method: "POST", jar: jar,
      form: { slug: "free-ship-50", title: "Free shipping over 50", trigger_kind: "cart_total_min", trigger_min_minor: "5000", value_kind: "free_shipping", priority: "10" },
    });
    check("discount create then 303",            discCreate.status === 303);
    check("discount create redirects created",   (discCreate.headers.location || "").indexOf("created=1") !== -1);
    var rule = await autoDiscount.getRule("free-ship-50");
    check("rule persisted",                      !!rule && rule.trigger.kind === "cart_total_min" && rule.value.kind === "free_shipping" && rule.priority === 10);

    var discList = await helpers.httpRequest({ port: port, path: "/admin/discounts", jar: jar });
    check("discount list shows the rule",        discList.body.indexOf("Free shipping over 50") !== -1);
    check("discount list shows create form",     discList.body.indexOf("Add a rule") !== -1);
    check("discount list shows policy form",     discList.body.indexOf("Add a stacking policy") !== -1);

    // Edit: re-prioritise + pause.
    var discEdit = await helpers.httpRequest({
      port: port, path: "/admin/discounts/free-ship-50/edit", method: "POST", jar: jar,
      form: { priority: "20", active_present: "1" },
    });
    check("discount edit then 303",              discEdit.status === 303);
    var editedRule = await autoDiscount.getRule("free-ship-50");
    check("rule re-prioritised + paused",        editedRule.priority === 20 && editedRule.active === false);

    // A percent_off rule via the create form.
    var pctCreate = await helpers.httpRequest({
      port: port, path: "/admin/discounts", method: "POST", jar: jar,
      form: { slug: "ten-off-3", title: "10% off 3+ items", trigger_kind: "item_count_min", trigger_min_count: "3", value_kind: "percent_off", value_basis_points: "1000" },
    });
    check("percent rule create then 303",        pctCreate.status === 303);
    var pctRule = await autoDiscount.getRule("ten-off-3");
    check("percent rule persisted",              pctRule.value.kind === "percent_off" && pctRule.value.basis_points === 1000 && pctRule.trigger.min_count === 3);

    // Bearer JSON contract.
    var discApi = await helpers.httpRequest({ port: port, path: "/admin/discounts", headers: bearer });
    check("discount API JSON",                   (discApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var discModel = JSON.parse(discApi.body);
    check("discount API returns rules",          discModel.rules.length === 2 && Array.isArray(discModel.policies));

    // Archive a rule.
    var discArchive = await helpers.httpRequest({ port: port, path: "/admin/discounts/ten-off-3/archive", method: "POST", jar: jar });
    check("discount archive then 303",           discArchive.status === 303);
    check("rule archived",                       (await autoDiscount.getRule("ten-off-3")).archived_at != null);

    // Stacking policy create + archive.
    var polCreate = await helpers.httpRequest({
      port: port, path: "/admin/discounts/policies", method: "POST", jar: jar,
      form: { slug: "default-stack", title: "Default stacking", max_codes_per_order: "2", with_other_codes: "on", order_min_minor: "0" },
    });
    check("policy create then 303",              polCreate.status === 303);
    check("policy create redirects",             (polCreate.headers.location || "").indexOf("policy_created=1") !== -1);
    var policy = await couponStacking.getPolicy("default-stack");
    check("policy persisted",                    !!policy && policy.max_codes_per_order === 2 && policy.allow_combine.with_other_codes === true);

    var polArchive = await helpers.httpRequest({ port: port, path: "/admin/discounts/policies/default-stack/archive", method: "POST", jar: jar });
    check("policy archive then 303",             polArchive.status === 303);
    check("policy archived",                     (await couponStacking.getPolicy("default-stack")).archived_at != null);

    // A bad rule (missing required value field) re-renders, not a 500.
    var discBad = await helpers.httpRequest({
      port: port, path: "/admin/discounts", method: "POST", jar: jar,
      form: { slug: "bad-rule", title: "bad", trigger_kind: "cart_total_min", trigger_min_minor: "100", value_kind: "percent_off" },
    });
    check("bad rule then 400",                   discBad.status === 400);

    // ---- auth gate ----------------------------------------------------

    var anonTax = await helpers.httpRequest({ port: port, path: "/admin/tax-rates" });
    check("anon tax → login form",               anonTax.body.indexOf("Admin API key") !== -1);
    var anonShip = await helpers.httpRequest({ port: port, path: "/admin/shipping" });
    check("anon shipping → login form",          anonShip.body.indexOf("Admin API key") !== -1);
    var anonDisc = await helpers.httpRequest({ port: port, path: "/admin/discounts" });
    check("anon discounts → login form",         anonDisc.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
