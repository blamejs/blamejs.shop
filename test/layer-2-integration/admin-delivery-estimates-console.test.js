"use strict";
/**
 * Delivery-estimate console — the browser-side admin screen managing the four
 * "Get it by <date>" tables: carrier transits, origin cutoffs, observed
 * holidays, and postal-prefix → zone mappings.
 *
 * Boots b.createApp with admin.mount wired to the deliveryEstimate primitive,
 * then exercises each table's create + list + (where applicable) archive over a
 * browser cookie session, the bearer JSON contract, the auth gate, the
 * TypeError → 400 notice mapping for bad input, and that a holiday `name`
 * carrying an XSS payload is escaped on render. Network: zero.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0117_delivery_estimate.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

async function _run() {
  var mq      = helpers.memD1Query(MIGS);
  var query   = mq.query;
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "delivery-est" });
  var config  = bShop.config.create({ query: query });
  var deliveryEstimate = bShop.deliveryEstimate.create({ query: query });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-delivery-cfg-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, catalog: catalog, order: order, config: config, shop_name: "Test Shop",
        deliveryEstimate: deliveryEstimate,
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

    // Nav link present.
    var home = await helpers.httpRequest({ port: port, path: "/admin", jar: jar });
    check("nav includes Delivery estimates",     home.body.indexOf("\"/admin/delivery-estimates\"") !== -1);

    // Empty landing renders the four create forms, no rows yet.
    var landing = await helpers.httpRequest({ port: port, path: "/admin/delivery-estimates", jar: jar });
    check("delivery page then 200",              landing.status === 200);
    check("shows transit form",                  landing.body.indexOf("Add a carrier transit") !== -1);
    check("shows cutoff form",                   landing.body.indexOf("Add an origin cutoff") !== -1);
    check("shows holiday form",                  landing.body.indexOf("Add an observed holiday") !== -1);
    check("shows postal-zone form",              landing.body.indexOf("Add a postal-prefix zone") !== -1);
    check("empty transit state",                 landing.body.indexOf("No carrier transits yet.") !== -1);

    // ---- carrier transit ----------------------------------------------
    var transitCreate = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/transits", method: "POST", jar: jar,
      form: { from_zone: "dc-east", to_zone: "us-west", carrier: "ups", service_level: "GROUND", transit_days: "4" },
    });
    check("transit create then 303",             transitCreate.status === 303);
    check("transit create redirects created",    (transitCreate.headers.location || "").indexOf("created=transit") !== -1);
    var transits = await deliveryEstimate.listTransits({});
    check("transit persisted",                   transits.length === 1 && transits[0].transit_days === 4 && transits[0].carrier === "ups");
    var transitId = transits[0].id;

    var transitList = await helpers.httpRequest({ port: port, path: "/admin/delivery-estimates", jar: jar });
    check("transit list shows the row",          transitList.body.indexOf("dc-east") !== -1 && transitList.body.indexOf("GROUND") !== -1);

    // Bad transit (out-of-range days) re-renders 400, not 500.
    var transitBad = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/transits", method: "POST", jar: jar,
      form: { from_zone: "dc-east", to_zone: "us-west", carrier: "ups", service_level: "GROUND", transit_days: "9999" },
    });
    check("transit bad days then 400",           transitBad.status === 400);
    check("transit bad re-renders screen",       transitBad.body.indexOf("Add a carrier transit") !== -1);

    // ---- origin cutoff ------------------------------------------------
    var cutoffCreate = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/cutoffs", method: "POST", jar: jar,
      form: { origin_location: "dc-east", daily_cutoff_local_time: "14:00", timezone: "America/New_York" },
    });
    check("cutoff create then 303",              cutoffCreate.status === 303);
    var cutoffs = await deliveryEstimate.listCutoffs();
    check("cutoff persisted",                    cutoffs.length === 1 && cutoffs[0].origin_location === "dc-east" && cutoffs[0].timezone === "America/New_York");

    // Bad timezone is a 400, not a 500.
    var cutoffBad = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/cutoffs", method: "POST", jar: jar,
      form: { origin_location: "dc-west", daily_cutoff_local_time: "14:00", timezone: "Made/Up_Place" },
    });
    check("cutoff bad tz then 400",              cutoffBad.status === 400);

    // ---- holiday (XSS on free-text name) ------------------------------
    var XSS = "<script>alert('delivery')</script>";
    var holidayCreate = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/holidays", method: "POST", jar: jar,
      form: { region: "us", date: "2026-07-04", name: XSS },
    });
    check("holiday create then 303",             holidayCreate.status === 303);
    var holidays = await deliveryEstimate.listHolidays({});
    check("holiday persisted",                   holidays.length === 1 && holidays[0].region === "us" && holidays[0].date === "2026-07-04");
    var holidayId = holidays[0].id;

    var holidayList = await helpers.httpRequest({ port: port, path: "/admin/delivery-estimates", jar: jar });
    check("holiday name escaped (no raw script)", holidayList.body.indexOf("<script>alert('delivery')") === -1);
    check("holiday name escaped (entity form)",   holidayList.body.indexOf("&lt;script&gt;") !== -1);

    // Bad holiday date (Feb 30 — passes the regex, fails the calendar check) → 400.
    var holidayBad = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/holidays", method: "POST", jar: jar,
      form: { region: "us", date: "2026-02-30", name: "Nope" },
    });
    check("holiday bad date then 400",           holidayBad.status === 400);

    // ---- postal-prefix zone -------------------------------------------
    var zoneCreate = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/postal-zones", method: "POST", jar: jar,
      form: { country: "US", postal_prefix: "902", zone: "us-west" },
    });
    check("postal-zone create then 303",         zoneCreate.status === 303);
    var pzones = await deliveryEstimate.listPostalZones({});
    check("postal-zone persisted",               pzones_ok(pzones));

    // ---- bearer JSON contract -----------------------------------------
    var api = await helpers.httpRequest({ port: port, path: "/admin/delivery-estimates", headers: bearer });
    check("delivery API JSON",                   (api.headers["content-type"] || "").indexOf("application/json") === 0);
    var model = JSON.parse(api.body);
    check("API returns all four tables",         model.transits.length === 1 && model.cutoffs.length === 1 &&
                                                 model.holidays.length === 1 && model.postal_zones.length === 1);

    // ---- archive transit + holiday ------------------------------------
    var transitArchive = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/transits/" + transitId + "/archive", method: "POST", jar: jar,
    });
    check("transit archive then 303",            transitArchive.status === 303);
    check("transit off live list",               (await deliveryEstimate.listTransits({})).length === 0);

    var holidayArchive = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/holidays/" + holidayId + "/archive", method: "POST", jar: jar,
    });
    check("holiday archive then 303",            holidayArchive.status === 303);
    check("holiday off live list",               (await deliveryEstimate.listHolidays({})).length === 0);

    // Archiving a bogus uuid is a 400 (bad shape), never a 500.
    var archiveBad = await helpers.httpRequest({
      port: port, path: "/admin/delivery-estimates/transits/not-a-uuid/archive", method: "POST", jar: jar,
    });
    check("archive bad uuid → recoverable",      archiveBad.status === 303 || archiveBad.status === 400);

    // ---- auth gate ----------------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: "/admin/delivery-estimates" });
    check("anon delivery → login form",          anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

// definePostalZone returns the hydrated row; assert the persisted tuple.
function pzones_ok(rows) {
  return rows.length === 1 && rows[0].country === "US" && rows[0].postal_prefix === "902" && rows[0].zone === "us-west";
}

module.exports = { run: _run };
