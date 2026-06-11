"use strict";
/**
 * Collections console — browser-side admin manager for manual + smart
 * product collections.
 *
 * Boots b.createApp with admin.mount (token + catalog + order + config +
 * collections), seeds two catalog products, then exercises the list
 * (HTML + JSON), the active/archived filter, manual + smart create via
 * the browser form, the manual member manager (add / list / remove), the
 * smart rule editor + live preview, the bearer JSON contract, archive,
 * the auth gate, and the bad-slug path (404 / notice, never a 500).
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0004_shop_config.sql", "0043_collections.sql"]
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var order   = bShop.order.create({ query: query, cursorSecret: "collections-console" });
  var config  = bShop.config.create({ query: query });
  var collections = bShop.collections.create({ query: query, catalog: catalog, cursorSecret: "collections-console" });

  // Seed two active catalog products so the manual member + smart preview
  // paths have real product rows to reference.
  var prodA = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", status: "active" });
  var prodB = await catalog.products.create({ slug: "widget-lite", title: "Widget Lite", status: "active" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-collections-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, collections: collections, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // Empty list renders the page (no rows yet) for the browser; JSON for bearer.
    var empty = await helpers.httpRequest({ port: port, path: "/admin/collections", jar: jar });
    check("collections page then 200",           empty.status === 200);
    check("nav includes Collections",            empty.body.indexOf("\"/admin/collections\"") !== -1);
    check("empty state shown",                   empty.body.indexOf("No collections") !== -1);

    // Create a MANUAL collection via the browser form → 303 PRG.
    var createManual = await helpers.httpRequest({
      port: port, path: "/admin/collections", method: "POST", jar: jar,
      form: { type: "manual", title: "Summer Picks", slug: "summer-picks", description: "Hand-picked" },
    });
    check("create manual then 303",              createManual.status === 303);
    check("manual create redirects created",     (createManual.headers.location || "").indexOf("created=1") !== -1);
    var afterManual = await collections.get("summer-picks");
    check("manual collection persisted",         afterManual && afterManual.type === "manual");

    // List now shows it (HTML); JSON contract for bearer.
    var listed = await helpers.httpRequest({ port: port, path: "/admin/collections", jar: jar });
    check("list shows the manual collection",    listed.body.indexOf("Summer Picks") !== -1 && listed.body.indexOf("summer-picks") !== -1);
    check("list shows the manual type pill",     listed.body.indexOf(">manual<") !== -1);
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/collections", headers: bearer });
    check("collections API still JSON",          (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    check("collections API returns rows",        JSON.parse(apiList.body).rows.length === 1);

    // Add a seeded product as a member via the browser form → 303, member persists.
    var addMember = await helpers.httpRequest({
      port: port, path: "/admin/collections/summer-picks/members/add", method: "POST", jar: jar,
      form: { product_id: prodA.id },
    });
    check("add member then 303",                 addMember.status === 303);
    check("add member redirects updated",        (addMember.headers.location || "").indexOf("updated=1") !== -1);
    var members = await collections.productsIn({ slug: "summer-picks", limit: 50 });
    check("member persisted",                    (members.rows || []).length === 1 && members.rows[0].product_id === prodA.id);

    // Detail page lists the member (browser); bearer detail is JSON with the member.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/collections/summer-picks", jar: jar });
    check("detail page then 200",                detail.status === 200);
    check("detail lists the member id",          detail.body.indexOf(prodA.id) !== -1);
    check("detail shows add-member form",        detail.body.indexOf("/members/add") !== -1);
    var detailApi = await helpers.httpRequest({ port: port, path: "/admin/collections/summer-picks", headers: bearer });
    check("detail API JSON members",             JSON.parse(detailApi.body).members.length === 1);

    // Remove the member via the row form → 303 updated; member gone.
    var removeMember = await helpers.httpRequest({
      port: port, path: "/admin/collections/summer-picks/members/remove", method: "POST", jar: jar,
      form: { product_id: prodA.id },
    });
    check("remove member then 303",              removeMember.status === 303);
    check("member removed",                      (await collections.productsIn({ slug: "summer-picks", limit: 50 })).rows.length === 0);

    // Removing an unknown product is a no-op notice (?err=1), never a false success.
    var removeMiss = await helpers.httpRequest({
      port: port, path: "/admin/collections/summer-picks/members/remove", method: "POST", jar: jar,
      form: { product_id: prodB.id },
    });
    check("remove unknown flags err",            (removeMiss.headers.location || "").indexOf("err=1") !== -1);

    // Create a SMART collection with a rule via the browser form → 303.
    var createSmart = await helpers.httpRequest({
      port: port, path: "/admin/collections", method: "POST", jar: jar,
      form: { type: "smart", title: "Active Stock", slug: "active-stock", sort_strategy: "newest", rule_field: "tags", rule_op: "contains", rule_value: "sale" },
    });
    check("create smart then 303",               createSmart.status === 303);
    var smartCol = await collections.get("active-stock");
    check("smart collection persisted",          smartCol && smartCol.type === "smart");
    check("smart rule stored",                   smartCol && smartCol.rules && smartCol.rules.all.length === 1 && smartCol.rules.all[0].op === "contains");

    // Smart detail renders the rule editor + a live preview section.
    var smartDetail = await helpers.httpRequest({ port: port, path: "/admin/collections/active-stock", jar: jar });
    check("smart detail then 200",               smartDetail.status === 200);
    check("smart detail shows rule editor",      smartDetail.body.indexOf("rule_field") !== -1 && smartDetail.body.indexOf("Rules") !== -1);
    check("smart detail shows preview section",  smartDetail.body.indexOf("live preview") !== -1);

    // Edit the smart collection's rules + title via the browser form → 303 updated.
    var editSmart = await helpers.httpRequest({
      port: port, path: "/admin/collections/active-stock/edit", method: "POST", jar: jar,
      form: { title: "Active Stock (v2)", sort_strategy: "newest", rule_field: "inventory_count", rule_op: "gt", rule_value: "0" },
    });
    check("edit smart then 303",                 editSmart.status === 303);
    check("edit redirects updated",              (editSmart.headers.location || "").indexOf("updated=1") !== -1);
    var editedSmart = await collections.get("active-stock");
    check("smart title updated",                 editedSmart.title === "Active Stock (v2)");
    check("smart rules updated",                 editedSmart.rules.all[0].field === "inventory_count" && editedSmart.rules.all[0].value === 0);

    // A bad-shape create (missing slug) re-renders the form with the
    // validator's message, not a 500.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/collections", method: "POST", jar: jar,
      form: { type: "manual", title: "No Slug" },
    });
    check("bad create then 400",                 bad.status === 400);
    check("bad create surfaces validator msg",   bad.body.indexOf("slug") !== -1);

    // Bearer create still returns 201 JSON (API contract unchanged).
    var apiCreate = await helpers.httpRequest({
      port: port, path: "/admin/collections", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ type: "manual", title: "API Made", slug: "api-made" }),
    });
    check("bearer create returns 201 JSON",      apiCreate.status === 201 && (apiCreate.headers["content-type"] || "").indexOf("application/json") === 0);

    // Archive the manual collection via the row form → 303 archived.
    var archive = await helpers.httpRequest({ port: port, path: "/admin/collections/summer-picks/archive", method: "POST", jar: jar });
    check("archive then 303",                    archive.status === 303);
    check("archive redirects archived",          (archive.headers.location || "").indexOf("archived=1") !== -1);
    check("collection now archived",             (await collections.get("summer-picks")).archived_at != null);

    // Active filter hides the archived one; archived filter shows it.
    var act = await helpers.httpRequest({ port: port, path: "/admin/collections?active=1", jar: jar });
    check("active filter hides archived",        act.body.indexOf("summer-picks") === -1);
    var arc = await helpers.httpRequest({ port: port, path: "/admin/collections?active=0", jar: jar });
    check("archived filter shows archived",      arc.body.indexOf("summer-picks") !== -1);
    check("archived filter hides active",        arc.body.indexOf("active-stock") === -1);
    // Bearer JSON archived filter is archived-only too (same predicate).
    var arcApi = await helpers.httpRequest({ port: port, path: "/admin/collections?active=0", headers: bearer });
    var arcSlugs = JSON.parse(arcApi.body).rows.map(function (c) { return c.slug; });
    check("bearer archived filter = archived-only", arcSlugs.indexOf("summer-picks") !== -1 && arcSlugs.indexOf("active-stock") === -1);

    // A bad / unknown slug is a 404 page (notice), never a 500.
    var miss = await helpers.httpRequest({ port: port, path: "/admin/collections/does-not-exist", jar: jar });
    check("unknown slug then 404",               miss.status === 404);
    check("unknown slug shows not-found notice", miss.body.indexOf("not found") !== -1);
    // A malformed slug (uppercase / illegal char) throws TypeError in the
    // primitive — must surface as a 404 page, not a 500.
    var badSlug = await helpers.httpRequest({ port: port, path: "/admin/collections/Bad_Slug!", jar: jar });
    check("malformed slug not a 500",            badSlug.status === 404);

    // Auth gate: anon → sign-in form, not data.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/collections" });
    check("anon collections → login form",       anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
