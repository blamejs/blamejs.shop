"use strict";
/**
 * Auto-discount terms edit console — the browser-side detail + edit
 * screen for an automatic-discount rule's TERMS.
 *
 * Boots b.createApp with admin.mount wired to the autoDiscount
 * primitive, seeds a percent-off rule, then drives the detail screen
 * (GET /admin/discounts/:slug) and the edit path
 * (POST /admin/discounts/:slug/edit, browser + bearer JSON). The edit
 * changes the VALUE (percentage) and the TRIGGER (threshold) — the two
 * columns autoDiscount.updateRule accepts that the console edit path
 * previously dropped (the inline row form reached only priority +
 * active). Asserts the change persisted via autoDiscount.getRule, the
 * inline priority/active edit still works untouched, a bad terms value
 * is a clean 4xx, and the rule's slug is preserved. Network: zero.
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
var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0004_shop_config.sql", "0107_auto_discount.sql"]
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
  var order   = bShop.order.create({ query: query, cursorSecret: "disc-terms-edit" });
  var config  = bShop.config.create({ query: query });
  var autoDiscount = bShop.autoDiscount.create({ query: query });

  // Seed a percent-off rule keyed on a cart-total threshold.
  await autoDiscount.defineRule({
    slug: "ten-off-50", title: "10% off over 50",
    trigger: { kind: "cart_total_min", min_minor: 5000 },
    value:   { kind: "percent_off", basis_points: 1000 },
    priority: 5,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-disc-edit-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, { token: TOKEN, catalog: catalog, order: order, config: config, autoDiscount: autoDiscount, shop_name: "Test Shop" });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // The list now offers an "Edit terms" affordance per active rule.
    var list = await helpers.httpRequest({ port: port, path: "/admin/discounts", jar: jar });
    check("list then 200",                       list.status === 200);
    check("list shows Edit terms affordance",    list.body.indexOf("/admin/discounts/ten-off-50\">Edit terms") !== -1);

    // Detail screen renders the full terms edit form, prefilled.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/discounts/ten-off-50", jar: jar });
    check("detail then 200",                     detail.status === 200);
    check("detail prefills the percent (bps)",   detail.body.indexOf("name=\"value_basis_points\" value=\"1000\"") !== -1);
    check("detail prefills the threshold",       detail.body.indexOf("name=\"trigger_min_minor\" value=\"5000\"") !== -1);
    check("detail posts to the edit route",      detail.body.indexOf("/admin/discounts/ten-off-50/edit") !== -1);

    // Edit the VALUE (percent) AND the TRIGGER (threshold) — the columns
    // the console edit path could not reach before. PRG to ?updated,
    // change persists.
    var edit = await helpers.httpRequest({
      port: port, path: "/admin/discounts/ten-off-50/edit", method: "POST", jar: jar,
      form: {
        title: "15% off over 80", active_present: "1", active: "on", priority: "5",
        trigger_kind: "cart_total_min", trigger_min_minor: "8000",
        value_kind: "percent_off", value_basis_points: "1500",
      },
    });
    check("terms edit then 303",                 edit.status === 303);
    check("terms edit redirects ?updated",       (edit.headers.location || "").indexOf("updated=1") !== -1);
    var after = await autoDiscount.getRule("ten-off-50");
    check("value (percent) changed to 1500 bps", after.value.kind === "percent_off" && after.value.basis_points === 1500);
    check("trigger threshold changed to 8000",   after.trigger.kind === "cart_total_min" && after.trigger.min_minor === 8000);
    check("title changed too",                   after.title === "15% off over 80");
    check("slug preserved",                      after.slug === "ten-off-50");

    // A trigger KIND change is reachable too: switch to item_count_min.
    var kindEdit = await helpers.httpRequest({
      port: port, path: "/admin/discounts/ten-off-50/edit", method: "POST", jar: jar,
      form: {
        title: "15% off 3+ items", active_present: "1", active: "on", priority: "5",
        trigger_kind: "item_count_min", trigger_min_count: "3",
        value_kind: "percent_off", value_basis_points: "1500",
      },
    });
    check("trigger-kind edit then 303",          kindEdit.status === 303);
    var afterKind = await autoDiscount.getRule("ten-off-50");
    check("trigger kind switched",               afterKind.trigger.kind === "item_count_min" && afterKind.trigger.min_count === 3);

    // The inline row edit (priority + active only) still works unchanged
    // — a partial form that doesn't name a trigger/value kind leaves the
    // terms untouched.
    var inline = await helpers.httpRequest({
      port: port, path: "/admin/discounts/ten-off-50/edit", method: "POST", jar: jar,
      form: { priority: "20", active_present: "1" },
    });
    check("inline priority/active edit then 303", inline.status === 303);
    var afterInline = await autoDiscount.getRule("ten-off-50");
    check("re-prioritised + paused via inline",  afterInline.priority === 20 && afterInline.active === false);
    check("inline edit left terms untouched",    afterInline.value.basis_points === 1500 && afterInline.trigger.kind === "item_count_min");

    // Bearer JSON edit of the terms returns 200 JSON.
    var apiEdit = await helpers.httpRequest({
      port: port, path: "/admin/discounts/ten-off-50/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ value_kind: "amount_off_total", value_minor: "500" }),
    });
    check("bearer terms edit 200 JSON",          apiEdit.status === 200 && (apiEdit.headers["content-type"] || "").indexOf("application/json") === 0);
    check("bearer terms edit persisted",         (await autoDiscount.getRule("ten-off-50")).value.kind === "amount_off_total");

    // Bad terms value (non-integer bps) is a clean 4xx with no raw error
    // leak in the bearer body, never a 500 or a partial write.
    var bad = await helpers.httpRequest({
      port: port, path: "/admin/discounts/ten-off-50/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ value_kind: "percent_off", value_basis_points: "12abc" }),
    });
    check("bad terms value then 4xx",            bad.status >= 400 && bad.status < 500);
    check("bad terms edit did not persist",      (await autoDiscount.getRule("ten-off-50")).value.kind === "amount_off_total");

    // Bad terms value via the browser detail form → err redirect back to
    // the detail screen so the operator sees it in context.
    var badBrowser = await helpers.httpRequest({
      port: port, path: "/admin/discounts/ten-off-50/edit", method: "POST", jar: jar,
      form: { trigger_kind: "cart_total_min", trigger_min_minor: "notanumber", value_kind: "percent_off", value_basis_points: "1000", active_present: "1" },
    });
    check("bad browser terms edit then 303",     badBrowser.status === 303);
    check("bad browser terms edit → detail err", (badBrowser.headers.location || "").indexOf("/admin/discounts/ten-off-50?err=1") !== -1);

    // Detail JSON over bearer unchanged for tooling.
    var apiGet = await helpers.httpRequest({ port: port, path: "/admin/discounts/ten-off-50", headers: bearer });
    check("detail API JSON",                      (apiGet.headers["content-type"] || "").indexOf("application/json") === 0);

    // Anon → sign-in form.
    var anon = await helpers.httpRequest({ port: port, path: "/admin/discounts/ten-off-50" });
    check("anon detail → login form",            anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
