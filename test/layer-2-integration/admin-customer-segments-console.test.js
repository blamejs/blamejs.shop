"use strict";
/**
 * Customer-segments admin console — the operator screen that manages
 * RFM-style segment DEFINITIONS and triggers a membership recompute.
 *
 * Boots b.createApp with admin.mount wired to the customerSegments
 * primitive (the same dep the customer-detail screen already used
 * read-only), seeds a customer + a paid order so a rule can match, then
 * drives the whole definition lifecycle through the browser cookie
 * surface and the bearer JSON contract:
 *
 *   - create a segment with a valid rule -> it appears in /admin/segments
 *     with a member count column
 *   - recompute -> surfaces the resulting member count in the PRG banner
 *     (this is the action that populates the rule-derived cache)
 *   - edit its rule -> persisted (listSegments reflects the new rule)
 *   - archive -> moves to the archived filter + drops from active
 *   - unarchive -> back to active
 *   - a bad / missing rule on create -> clean 4xx, no stack leak, no
 *     partial write
 *   - a bad slug -> 404
 *   - the bearer JSON contract returns the data
 *   - anon -> the sign-in form
 *
 * Membership is RULE-DERIVED — there is no manual per-customer assign
 * route; the screen manages definitions + recompute only. Network: zero.
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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0006_customers.sql", "0049_customer_segments.sql",
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

// A minimal paid-shaped order for a customer so a frequency/recency rule
// can match. The orders FK references carts(id), so seed the cart first.
async function _seedOrder(query, order, customerId) {
  var cartId = b.uuid.v7();
  var sessionId = b.uuid.v7();
  var now = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, sessionId, customerId, now, now + 86400000],
  );
  return order.createFromCart({
    cart_id:           cartId,
    session_id:        sessionId,
    customer_id:       customerId,
    lines:             [{ variant_id: b.uuid.v7(), sku: "SKU-1", qty: 1, unit_amount_minor: 2500 }],
    currency:          "USD",
    subtotal_minor:    2500,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 2500,
    ship_to:           { country: "US" },
  });
}

async function _run() {
  var query            = _makeQuery();
  var catalog          = bShop.catalog.create({ query: query });
  var order            = bShop.order.create({ query: query, cursorSecret: "seg-console-order" });
  var config           = bShop.config.create({ query: query });
  var customers        = bShop.customers.create({ query: query, cursorSecret: "seg-console-customers" });
  var customerSegments = bShop.customerSegments.create({ query: query, cursorSecret: "seg-console-segments" });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });
  await _seedOrder(query, order, alice.id);

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-seg-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        customers: customers, customerSegments: customerSegments,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  // Spy on b.audit.safeEmit so the export-event assertion is deterministic
  // and touches no DB / chain read path (fragile across the shared-process
  // smoke ordering). The export route fires safeEmit like every admin
  // mutation, so the spy captures it.
  var auditCaptured = [];
  var _origSafeEmit = b.audit.safeEmit;
  b.audit.safeEmit = function (ev) { auditCaptured.push(ev); return _origSafeEmit.apply(this, arguments); };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303",                login.status === 303);

    // ---- nav + empty state ---------------------------------------------
    var emptyList = await helpers.httpRequest({ port: port, path: "/admin/segments", jar: jar });
    check("segments list then 200",              emptyList.status === 200);
    check("nav links to segments",               emptyList.body.indexOf("href=\"/admin/segments\"") !== -1);
    check("empty state shown",                   emptyList.body.indexOf("No active segments yet") !== -1);

    // ---- create with a valid rule --------------------------------------
    var newForm = await helpers.httpRequest({ port: port, path: "/admin/segments/new", jar: jar });
    check("new-segment form then 200",           newForm.status === 200);
    check("new form posts to /admin/segments",   newForm.body.indexOf("action=\"/admin/segments\"") !== -1);
    check("new form offers an RFM rule field",   newForm.body.indexOf("name=\"frequency_orders_min\"") !== -1);

    var create = await helpers.httpRequest({
      port: port, path: "/admin/segments", method: "POST", jar: jar,
      form: { slug: "any-buyer", title: "Any buyer", description: "Has ordered at least once.", frequency_orders_min: "1" },
    });
    check("create then 303",                     create.status === 303);
    check("create redirects ?created",           (create.headers.location || "").indexOf("created=1") !== -1);

    var afterCreate = await customerSegments.listSegments({ include_archived: false });
    check("segment persisted with the rule",     afterCreate.length === 1 && afterCreate[0].rules.frequency_orders_min === 1);
    check("create did not auto-populate",         afterCreate[0].last_member_count === 0);

    var list = await helpers.httpRequest({ port: port, path: "/admin/segments", jar: jar });
    check("list shows the segment title",        list.body.indexOf("Any buyer") !== -1);
    check("list shows a member-count column",    list.body.indexOf(">Members<") !== -1);

    // ---- recompute surfaces the member count ---------------------------
    var recompute = await helpers.httpRequest({
      port: port, path: "/admin/segments/any-buyer/recompute", method: "POST", jar: jar, form: {},
    });
    check("recompute then 303",                  recompute.status === 303);
    check("recompute redirects ?recomputed",     (recompute.headers.location || "").indexOf("recomputed=1") !== -1);
    check("recompute surfaces a member count",   (recompute.headers.location || "").indexOf("members=1") !== -1);
    var stats = await customerSegments.stats("any-buyer");
    check("membership cache populated",          stats.member_count === 1);

    // The detail screen renders the recomputed member count.
    var detail = await helpers.httpRequest({ port: port, path: "/admin/segments/any-buyer?recomputed=1&members=1", jar: jar });
    check("detail then 200",                     detail.status === 200);
    check("detail shows the member count",       detail.body.indexOf("1 member(s)") !== -1);
    check("detail prefills the rule field",      detail.body.indexOf("name=\"frequency_orders_min\" value=\"1\"") !== -1);

    // ---- edit the rule -> persisted ------------------------------------
    var edit = await helpers.httpRequest({
      port: port, path: "/admin/segments/any-buyer/edit", method: "POST", jar: jar,
      form: { title: "Repeat buyers", rules_present: "1", frequency_orders_min: "3" },
    });
    check("edit then 303",                       edit.status === 303);
    check("edit redirects ?updated",             (edit.headers.location || "").indexOf("updated=1") !== -1);
    var afterEdit = await customerSegments.listSegments({ include_archived: false });
    check("rule change persisted",               afterEdit[0].rules.frequency_orders_min === 3);
    check("title change persisted",              afterEdit[0].title === "Repeat buyers");

    // A title-only edit (no rules_present marker) must not wipe the rules.
    var titleOnly = await helpers.httpRequest({
      port: port, path: "/admin/segments/any-buyer/edit", method: "POST", jar: jar,
      form: { title: "Repeat buyers v2" },
    });
    check("title-only edit then 303",            titleOnly.status === 303);
    var afterTitleOnly = await customerSegments.listSegments({ include_archived: false });
    check("title-only edit kept the rules",      afterTitleOnly[0].rules.frequency_orders_min === 3 && afterTitleOnly[0].title === "Repeat buyers v2");

    // ---- archive -> moves to archived filter, drops from active ---------
    var archive = await helpers.httpRequest({
      port: port, path: "/admin/segments/any-buyer/archive", method: "POST", jar: jar, form: {},
    });
    check("archive then 303",                    archive.status === 303);
    check("archive redirects ?archived",         (archive.headers.location || "").indexOf("archived=1") !== -1);

    var activeAfter = await helpers.httpRequest({ port: port, path: "/admin/segments?filter=active", jar: jar });
    check("archived drops from active filter",   activeAfter.body.indexOf("Repeat buyers v2") === -1);
    var archivedAfter = await helpers.httpRequest({ port: port, path: "/admin/segments?filter=archived", jar: jar });
    check("archived shows in archived filter",   archivedAfter.body.indexOf("Repeat buyers v2") !== -1);

    // ---- unarchive -> back to active -----------------------------------
    var unarchive = await helpers.httpRequest({
      port: port, path: "/admin/segments/any-buyer/unarchive", method: "POST", jar: jar, form: {},
    });
    check("unarchive then 303",                  unarchive.status === 303);
    check("unarchive redirects ?unarchived",     (unarchive.headers.location || "").indexOf("unarchived=1") !== -1);
    var activeReturned = await helpers.httpRequest({ port: port, path: "/admin/segments", jar: jar });
    check("segment back on the active list",     activeReturned.body.indexOf("Repeat buyers v2") !== -1);

    // ---- bad / missing rule on create -> clean 4xx, no partial write ----
    // No rule fields supplied -> defineSegment throws (rules need >= 1
    // predicate). Bearer JSON path returns a clean 4xx with no stack leak.
    var noRule = await helpers.httpRequest({
      port: port, path: "/admin/segments", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "empty-seg", title: "Empty" }),
    });
    check("missing-rule create then 4xx",        noRule.status >= 400 && noRule.status < 500);
    // The body is a problem-details JSON, never a raw JS stack trace
    // (no "\n    at <fn> (<file>:<line>)" frames leaked to the client).
    check("missing-rule body has no stack frame", !/\n\s+at\s+\S+\s*\(/.test(noRule.body));
    var stillOne = await customerSegments.listSegments({ include_archived: true });
    check("missing-rule wrote nothing",          stillOne.length === 1);

    // A bad integer in a rule field is also a clean 4xx, no write.
    var badInt = await helpers.httpRequest({
      port: port, path: "/admin/segments", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "bad-int", title: "Bad", rules: { frequency_orders_min: "12abc" } }),
    });
    check("bad-rule-value create then 4xx",      badInt.status >= 400 && badInt.status < 500);
    check("bad-rule-value wrote nothing",        (await customerSegments.listSegments({ include_archived: true })).length === 1);

    // The browser path for a bad create bounces back to the new-form err
    // state, never a 500.
    var badBrowser = await helpers.httpRequest({
      port: port, path: "/admin/segments", method: "POST", jar: jar,
      form: { slug: "browser-empty", title: "Empty browser" },
    });
    check("bad browser create then 303",         badBrowser.status === 303);
    check("bad browser create -> new?err",       (badBrowser.headers.location || "").indexOf("/admin/segments/new?err=1") !== -1);

    // ---- bad slug -> 404 -----------------------------------------------
    var missing = await helpers.httpRequest({ port: port, path: "/admin/segments/no-such-segment", headers: bearer });
    check("unknown slug detail then 404",        missing.status === 404);

    // ---- bearer JSON contract ------------------------------------------
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/segments", headers: bearer });
    check("bearer list 200 JSON",                apiList.status === 200 && (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    var apiJson = JSON.parse(apiList.body);
    check("bearer list carries the segment",     Array.isArray(apiJson.segments) && apiJson.segments[0].slug === "any-buyer");

    var apiDetail = await helpers.httpRequest({ port: port, path: "/admin/segments/any-buyer", headers: bearer });
    check("bearer detail 200 JSON",              apiDetail.status === 200 && (apiDetail.headers["content-type"] || "").indexOf("application/json") === 0);
    var apiDetailJson = JSON.parse(apiDetail.body);
    check("bearer detail carries stats",         apiDetailJson.stats && typeof apiDetailJson.stats.member_count === "number");

    // The rule now requires 3 lifetime orders (the edit above) and Alice has
    // 1, so a recompute against the current rule yields 0 members — proving
    // the recompute reflects the edited rule, not the stale 1-order count.
    var apiRecompute = await helpers.httpRequest({
      port: port, path: "/admin/segments/any-buyer/recompute", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("bearer recompute 200 JSON",           apiRecompute.status === 200);
    check("bearer recompute returns the count",  JSON.parse(apiRecompute.body).member_count === 0);
    check("recompute reflects the edited rule",  (await customerSegments.stats("any-buyer")).member_count === 0);

    // ---- members CSV export --------------------------------------------
    // Re-seed a matching member so the export has a row: recompute the rule
    // back to "any buyer" (1 order) first, since the edit above set it to 3.
    await customerSegments.update("any-buyer", { rules: { frequency_orders_min: 1 } });
    await customerSegments.recompute({ slugs: ["any-buyer"] });
    check("export precondition: one member",     (await customerSegments.stats("any-buyer")).member_count === 1);

    // The list + detail screens expose an Export CSV affordance.
    var listForExport = await helpers.httpRequest({ port: port, path: "/admin/segments", jar: jar });
    check("list offers an Export CSV link",      listForExport.body.indexOf("/admin/segments/any-buyer/members.csv") !== -1);
    var detailForExport = await helpers.httpRequest({ port: port, path: "/admin/segments/any-buyer", jar: jar });
    check("detail offers an Export CSV link",    detailForExport.body.indexOf("/admin/segments/any-buyer/members.csv") !== -1);
    check("detail states no email in export",    detailForExport.body.toLowerCase().indexOf("no email") !== -1 || detailForExport.body.indexOf("one-way hash") !== -1);

    // Browser download streams the CSV with the expected columns + Alice's
    // row, and NO email column.
    var csv = await helpers.httpRequest({ port: port, path: "/admin/segments/any-buyer/members.csv", jar: jar });
    check("members CSV then 200",                csv.status === 200);
    check("members CSV content-type",            (csv.headers["content-type"] || "").indexOf("text/csv") === 0);
    check("members CSV is an attachment",        (csv.headers["content-disposition"] || "").indexOf("attachment") !== -1);
    check("members CSV header columns",          csv.body.indexOf("\"customer_id\",\"display_name\",\"joined_segment_at\",\"order_count\"") !== -1);
    check("members CSV leading comment row",     csv.body.indexOf("email addresses are omitted") !== -1);
    check("members CSV carries the member id",   csv.body.indexOf(alice.id) !== -1);
    check("members CSV carries the display name", csv.body.indexOf("Alice Anderson") !== -1);
    check("members CSV carries the order count", csv.body.indexOf("\"1\"") !== -1);
    // No email column header and no address anywhere in the export.
    check("members CSV has no email column",     csv.body.toLowerCase().indexOf("\"email\"") === -1);
    check("members CSV leaks no address",        csv.body.indexOf("alice@example.com") === -1);

    // The export is audited — the spy captured the safeEmit the route fired.
    var exportRows = auditCaptured.filter(function (r) {
      return r.action === "shop_admin.customer_segment.export" && r.metadata && r.metadata.slug === "any-buyer";
    });
    check("export recorded an audit row",        exportRows.length >= 1);

    // The bearer JSON surface serves the same file (a download, not JSON).
    var csvApi = await helpers.httpRequest({ port: port, path: "/admin/segments/any-buyer/members.csv", headers: bearer });
    check("bearer members CSV 200",              csvApi.status === 200 && (csvApi.headers["content-type"] || "").indexOf("text/csv") === 0);
    check("bearer members CSV carries the id",   csvApi.body.indexOf(alice.id) !== -1);

    // An unknown / foreign segment 404s instead of streaming an empty file.
    var csvMissing = await helpers.httpRequest({ port: port, path: "/admin/segments/no-such-segment/members.csv", headers: bearer });
    check("unknown-segment export then 404",     csvMissing.status === 404);
    var csvMissingHtml = await helpers.httpRequest({ port: port, path: "/admin/segments/no-such-segment/members.csv", jar: jar });
    check("unknown-segment export (browser) 404", csvMissingHtml.status === 404);

    // ---- anon -> sign-in form ------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: "/admin/segments" });
    check("anon list -> login form",             anon.body.indexOf("Admin API key") !== -1);
    // The export route is gated too — anon gets the sign-in form, never a file.
    var anonCsv = await helpers.httpRequest({ port: port, path: "/admin/segments/any-buyer/members.csv" });
    check("anon export -> login form, not a file", anonCsv.body.indexOf("Admin API key") !== -1 && (anonCsv.headers["content-type"] || "").indexOf("text/csv") !== 0);
  } finally {
    try { b.audit.safeEmit = _origSafeEmit; } catch (_e) { /* */ }
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
