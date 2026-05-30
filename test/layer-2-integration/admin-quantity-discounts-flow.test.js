"use strict";
/**
 * Quantity-discounts console — browser-side admin manager for the
 * automatic per-line quantity-break tier sets the pricing engine already
 * applies at PDP / cart / checkout.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * quantityDiscounts), seeds a product + variant + SKU so a sku-scoped tier
 * set validates against the catalog, then exercises the list (HTML +
 * JSON), the active/archived filter, create via the browser form, the
 * detail screen (schedule + tierBreakdown preview), the schedule rewrite,
 * archive + unarchive, the bearer JSON contract, the auth gate, and the
 * bad-input path (4xx with nothing written, never a 500). Network: zero.
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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
  "0004_shop_config.sql", "0044_quantity_discounts.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// Build an application/x-www-form-urlencoded body from an array of
// [key, value] pairs. Repeated keys (e.g. tier_min appearing three
// times) survive as repeated wire keys, which the framework bodyParser
// reads back as an array — exactly what a real browser sends for a set
// of same-named inputs. The helper's `form:` option can't express this
// (it comma-joins array values into one field), so the multi-tier POSTs
// post a hand-built body instead.
function _formBody(pairs) {
  return pairs.map(function (p) {
    return encodeURIComponent(p[0]) + "=" + encodeURIComponent(p[1] == null ? "" : String(p[1]));
  }).join("&");
}
function _postForm(port, path, jar, pairs) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST", jar: jar,
    body: _formBody(pairs),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

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
  var order   = bShop.order.create({ query: query, cursorSecret: "qd-console" });
  var config  = bShop.config.create({ query: query });
  var quantityDiscounts = bShop.quantityDiscounts.create({ query: query, catalog: catalog });

  // Seed a product + variant with a real SKU so a sku-scoped tier set
  // passes the engine's referential check (defineTier calls
  // catalog.variants.bySku for scope = 'sku').
  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", status: "active" });
  var SKU = "WDG-PRO-L";
  await catalog.variants.create(product.id, { sku: SKU, options: { size: "L" } });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-qd-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, quantityDiscounts: quantityDiscounts, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Empty list renders the page (no rows yet) for the browser.
    var empty = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts", jar: jar });
    check("qd page then 200",                    empty.status === 200);
    check("nav includes Quantity breaks",        empty.body.indexOf("\"/admin/quantity-discounts\"") !== -1);
    check("empty state shown",                   empty.body.indexOf("No quantity breaks") !== -1);
    check("create form shows scope dropdown",    empty.body.indexOf("name=\"scope\"") !== -1 && empty.body.indexOf(">sku<") !== -1);
    check("create form shows kind dropdown",     empty.body.indexOf("percent_off") !== -1);

    // Create a sku-scoped tier set via the browser form (two tiers, plus
    // a blank spare row that must be dropped) → 303 PRG.
    var createOk = await _postForm(port, "/admin/quantity-discounts", jar, [
      ["scope", "sku"], ["scope_id", SKU], ["exclusive", "on"],
      ["tier_min", "5"],  ["tier_kind", "percent_off"],     ["tier_value", "1000"],
      ["tier_min", "10"], ["tier_kind", "amount_off_each"], ["tier_value", "150"],
      ["tier_min", ""],   ["tier_kind", ""],                ["tier_value", ""],
    ]);
    check("create then 303",                     createOk.status === 303);
    check("create redirects created",            (createOk.headers.location || "").indexOf("created=1") !== -1);

    var afterCreate = await quantityDiscounts.list({ archived: null, limit: 50 });
    check("tier set persisted",                  afterCreate.length === 1);
    var setId = afterCreate[0].id;
    check("tier set scope persisted",            afterCreate[0].scope === "sku" && afterCreate[0].scope_id === SKU);
    check("tier set exclusive persisted",        afterCreate[0].exclusive === true);
    check("two tiers persisted",                 afterCreate[0].tiers.length === 2);
    check("blank tier row dropped",              afterCreate[0].tiers.map(function (t) { return t.min_quantity; }).indexOf(0) === -1);

    // List now shows it (HTML); JSON contract for bearer.
    var listed = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts", jar: jar });
    check("list shows the scope",                listed.body.indexOf(SKU) !== -1);
    check("list shows exclusive pill",           listed.body.indexOf("exclusive") !== -1);
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts", headers: bearer });
    check("qd API still JSON",                   (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    check("qd API returns rows",                 JSON.parse(apiList.body).rows.length === 1);

    // Detail page lists the schedule + preview; bearer detail is JSON.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts/" + encodeURIComponent(setId), jar: jar });
    check("detail page then 200",                detail.status === 200);
    check("detail shows the tier values",        detail.body.indexOf("value=\"5\"") !== -1 && detail.body.indexOf("value=\"10\"") !== -1);
    check("detail shows schedule preview",       detail.body.indexOf("Schedule preview") !== -1);
    check("detail preview computed a row",       detail.body.indexOf("Unit @ min") !== -1);
    check("detail preview computes the discounted unit (10% off 1000 = 900)", detail.body.indexOf(">900<") !== -1);
    var detailApi = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts/" + encodeURIComponent(setId), headers: bearer });
    check("detail API JSON tiers",               JSON.parse(detailApi.body).tiers.length === 2);

    // Rewrite the schedule (single tier, different kind) + un-toggle
    // exclusive via the edit form → 303 saved; persists wholesale.
    var edit = await _postForm(port, "/admin/quantity-discounts/" + encodeURIComponent(setId) + "/edit", jar, [
      ["exclusive_present", "1"],               // checkbox rendered, left unchecked → exclusive=false
      ["tier_min", "3"], ["tier_kind", "fixed_each_price"], ["tier_value", "799"],
      ["tier_min", ""],  ["tier_kind", ""],                 ["tier_value", ""],
    ]);
    check("edit then 303",                       edit.status === 303);
    check("edit redirects saved",                (edit.headers.location || "").indexOf("saved=1") !== -1);
    var afterEdit = await quantityDiscounts.list({ archived: null, limit: 50 });
    check("schedule rewritten to one tier",      afterEdit[0].tiers.length === 1);
    check("rewritten tier values persisted",     afterEdit[0].tiers[0].min_quantity === 3 && afterEdit[0].tiers[0].discount_kind === "fixed_each_price" && afterEdit[0].tiers[0].value === 799);
    check("exclusive toggled off",               afterEdit[0].exclusive === false);

    // Archive → set no longer active.
    var archive = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts/" + encodeURIComponent(setId) + "/archive", method: "POST", jar: jar });
    check("archive then 303",                    archive.status === 303);
    check("archive redirects archived_ok",       (archive.headers.location || "").indexOf("archived_ok=1") !== -1);
    var activeOnly = await quantityDiscounts.list({ archived: false, limit: 50 });
    check("archived set not in active list",     activeOnly.length === 0);

    // An archived set's detail suppresses the live preview — tierBreakdown
    // filters to active rules, which would otherwise show foreign-scope rules.
    var archivedDetail = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts/" + encodeURIComponent(setId), jar: jar });
    check("archived detail suppresses live preview", archivedDetail.body.indexOf("archived, so its schedule isn't active") !== -1);

    // Active filter hides it; archived filter shows it.
    var act = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts?archived=0", jar: jar });
    check("active filter hides archived",        act.body.indexOf(SKU) === -1);
    var arc = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts?archived=1", jar: jar });
    check("archived filter shows archived",      arc.body.indexOf(SKU) !== -1);
    check("archived row offers Restore",         arc.body.indexOf("/unarchive") !== -1);

    // Unarchive → active again.
    var unarchive = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts/" + encodeURIComponent(setId) + "/unarchive", method: "POST", jar: jar });
    check("unarchive then 303",                  unarchive.status === 303);
    var activeAgain = await quantityDiscounts.list({ archived: false, limit: 50 });
    check("set active again",                    activeAgain.length === 1 && activeAgain[0].id === setId);

    // Bad input: min_quantity 0 → 4xx and nothing written. Snapshot the
    // tier count first so we can assert no row was added.
    var beforeBad = (await quantityDiscounts.list({ archived: null, limit: 50 })).length;
    var bad = await _postForm(port, "/admin/quantity-discounts", jar, [
      ["scope", "sku"], ["scope_id", SKU],
      ["tier_min", "0"], ["tier_kind", "percent_off"], ["tier_value", "1000"],
    ]);
    check("bad create then 400",                 bad.status === 400);
    check("bad create surfaces validator msg",   bad.body.indexOf("min_quantity") !== -1);
    var afterBad = (await quantityDiscounts.list({ archived: null, limit: 50 })).length;
    check("bad create wrote nothing",            afterBad === beforeBad);

    // Bad input: percent_off value over 10000 basis points → 4xx, nothing written.
    var bad2 = await _postForm(port, "/admin/quantity-discounts", jar, [
      ["scope", "sku"], ["scope_id", SKU],
      ["tier_min", "5"], ["tier_kind", "percent_off"], ["tier_value", "20000"],
    ]);
    check("over-100% percent then 400",          bad2.status === 400);
    check("over-100% wrote nothing",             (await quantityDiscounts.list({ archived: null, limit: 50 })).length === beforeBad);

    // Bad input: unknown SKU on a sku-scoped set → 4xx, nothing written.
    var bad3 = await _postForm(port, "/admin/quantity-discounts", jar, [
      ["scope", "sku"], ["scope_id", "NO-SUCH-SKU"],
      ["tier_min", "5"], ["tier_kind", "percent_off"], ["tier_value", "1000"],
    ]);
    check("unknown sku then 400",                bad3.status === 400);
    check("unknown sku wrote nothing",           (await quantityDiscounts.list({ archived: null, limit: 50 })).length === beforeBad);

    // Bearer create still returns 201 JSON (API contract unchanged).
    var apiCreate = await helpers.httpRequest({
      port: port, path: "/admin/quantity-discounts", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", exclusive: false, tiers: [{ min_quantity: 12, discount_kind: "percent_off", value: 500 }] }),
    });
    check("bearer create returns 201 JSON",      apiCreate.status === 201 && (apiCreate.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer-created global set persisted", (await quantityDiscounts.list({ scope: "global", archived: false, limit: 50 })).length === 1);

    // Unknown id detail is a 404 page, never a 500.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts/00000000-0000-0000-0000-000000000000", jar: jar });
    check("unknown id then 404",                 miss.status === 404);
    check("unknown id shows not-found notice",   miss.body.indexOf("not found") !== -1);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/quantity-discounts" });
    check("anon qd → login form",                anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
