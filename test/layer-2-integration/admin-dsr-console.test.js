"use strict";
/**
 * Operator DSR queue — admin console for the GDPR / CCPA / LGPD
 * subject-access-request lifecycle (/admin/dsr).
 *
 * Boots b.createApp with admin.mount (token + catalog + order +
 * complianceExport + the reader adapters + the per-domain handles) over one
 * in-memory node:sqlite DB. Cookie-login via POST /admin/login {token};
 * bearer for the JSON path. Covers:
 *   - anon → sign-in form, never data,
 *   - queue renders chips + nav "Privacy requests"; empty state,
 *   - seed an export request → it shows in the list + detail w/ a Fulfil form,
 *   - POST /admin/dsr/:id/fulfill → 303 ?moved=1; status flips to fulfilled,
 *   - GET /admin/dsr/:id/export.json → 200 JSON attachment, parses, has data,
 *   - seed a deletion → ?preview=1 shows dry-run counts WITHOUT mutating
 *     (re-read: address still present),
 *   - execute via the confirm interstitial → row fulfilled, address archived,
 *   - malformed id → 404 (not 500),
 *   - XSS: a dismiss_reason HTML payload renders escaped on the detail,
 *   - bearer JSON GET /admin/dsr → { rows, status }.
 *
 * Network: zero — every request lands on 127.0.0.1.
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
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0026_customer_addresses.sql", "0009_subscriptions.sql",
  "0047_support_tickets.sql", "0022_loyalty.sql", "0237_loyalty_txn_running_balance.sql", "0109_compliance_export.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// Same reader shims + streaming helper server.js builds.
function _buildReaders(h, query) {
  return {
    customers: {
      forCustomerExport: async function (id) {
        try {
          var row = await h.customers.get(id);
          var passkeys = []; try { passkeys = await h.customers.listPasskeys(id); } catch (_e) { passkeys = []; }
          var methods = null; try { methods = await h.customers.signInMethodsByCustomer([id]); } catch (_e) { methods = null; }
          return { customer: row || null, passkeys: passkeys || [], sign_in_methods: methods || null };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try {
          var ex = await h.customers.get(id); if (!ex) return { table: "customers", deleted: 0 };
          if (dry) return { table: "customers", deleted: 1 };
          await h.customers.update(id, { display_name: "[erased customer " + String(id).slice(0, 8) + "]" });
          return { table: "customers", deleted: 1 };
        } catch (_e) { return { table: "customers", deleted: 0 }; }
      },
    },
    addresses: {
      forCustomerExport: async function (id) { try { return await h.addresses.listForCustomer(id, { include_archived: true }); } catch (_e) { return []; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try {
          var rows = await h.addresses.listForCustomer(id, {});
          if (dry) return { table: "customer_addresses", deleted: rows.length };
          var n = 0; for (var i = 0; i < rows.length; i += 1) { if (await h.addresses.archive(rows[i].id)) n += 1; }
          return { table: "customer_addresses", deleted: n };
        } catch (_e) { return { table: "customer_addresses", deleted: 0 }; }
      },
    },
    order: {
      forCustomerExport: async function (id) { try { return (await h.order.listForCustomer(id, { limit: 100 })).rows; } catch (_e) { return []; } },
      forCustomerDeletion: async function () { return { table: "orders", deleted: 0, note: "retained-for-accounting" }; },
    },
    orderNotes: { forCustomerExport: async function () { return []; } },
    subscriptions: {
      forCustomerExport: async function (id) { try { return await h.subscriptions.subscriptions.list({ customer_id: id }); } catch (_e) { return []; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run); var TERMINAL = ["canceled", "incomplete_expired"];
        try {
          var rows = await h.subscriptions.subscriptions.list({ customer_id: id });
          var live = rows.filter(function (r) { return TERMINAL.indexOf(r.status) === -1; });
          if (dry) return { table: "subscriptions", deleted: live.length };
          var n = 0; var ts = Date.now();
          for (var i = 0; i < live.length; i += 1) { var res = await query("UPDATE subscriptions SET status='canceled', updated_at=?1 WHERE id=?2", [ts, live[i].id]); if (res && res.rowCount) n += Number(res.rowCount); }
          return { table: "subscriptions", deleted: n };
        } catch (_e) { return { table: "subscriptions", deleted: 0 }; }
      },
    },
    paymentMethods: { forCustomerExport: async function () { return []; } },
    supportTickets: {
      forCustomerExport: async function (id) { try { return (await h.supportTickets.listByCustomerId(id, { limit: 100 })).rows; } catch (_e) { return []; } },
      forCustomerDeletion: async function () { return { table: "support_tickets", deleted: 0, note: "retained" }; },
    },
    loyalty: {
      forCustomerExport: async function (id) {
        try { var balance = await h.loyalty.balance(id); var history = []; try { history = (await h.loyalty.history(id, { limit: 200 })).rows; } catch (_e) { history = []; } return { balance: balance, history: history }; }
        catch (_e) { return null; }
      },
      forCustomerDeletion: async function () { return { table: "loyalty", deleted: 0, note: "retained-ledger" }; },
    },
  };
}

async function _streamDsrBundle(res, readers, sections, row) {
  res.status(200);
  if (res.setHeader) {
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("content-disposition", "attachment; filename=\"dsr-export-" + String(row.id).replace(/[^A-Za-z0-9._-]/g, "") + ".json\"");
    res.setHeader("x-content-type-options", "nosniff");
  }
  var canWrite = typeof res.write === "function" && typeof res.end === "function";
  var buf = "";
  function emit(s) { if (canWrite) res.write(s); else buf += s; }
  emit("{\"request_id\":" + JSON.stringify(row.id) + ",\"customer_id\":" + JSON.stringify(row.customer_id) +
       ",\"jurisdiction\":" + JSON.stringify(row.jurisdiction) + ",\"scope\":" + JSON.stringify(row.scope) + ",\"data\":{");
  var first = true;
  for (var i = 0; i < sections.length; i += 1) {
    var name = sections[i]; var reader = readers[name];
    if (!reader || typeof reader.forCustomerExport !== "function") continue;
    var section; try { section = await reader.forCustomerExport(row.customer_id); } catch (_e) { section = null; }
    emit((first ? "" : ",") + JSON.stringify(name) + ":" + JSON.stringify(section == null ? null : section));
    first = false;
  }
  emit("}}");
  if (canWrite) res.end(); else (res.end ? res.end(buf) : res.send(buf));
}

async function _seedCustomer(query, id, displayName) {
  var ts = Date.now();
  await query("INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [id, "hash-" + id, displayName, ts]);
}

async function _run() {
  var mem   = helpers.memD1Query(MIGS);
  var query = mem.query;

  var catalog       = bShop.catalog.create({ query: query });
  var customers     = bShop.customers.create({ query: query, cursorSecret: "adsr-cust" });
  var order         = bShop.order.create({ query: query, cursorSecret: "adsr-order" });
  var addresses     = bShop.addresses.create({ query: query });
  var subscriptions = bShop.subscriptions.create({ query: query, payment: null });
  var supportTickets = bShop.supportTickets.create({ query: query, cursorSecret: "adsr-support" });
  var loyalty       = bShop.loyalty.create({ query: query });

  var readers = _buildReaders({
    customers: customers, addresses: addresses, order: order,
    subscriptions: subscriptions, supportTickets: supportTickets, loyalty: loyalty,
  }, query);
  var dsr = bShop.complianceExport.create({
    query: query, customers: readers.customers, addresses: readers.addresses, order: readers.order,
    orderNotes: readers.orderNotes, subscriptions: readers.subscriptions, paymentMethods: readers.paymentMethods,
    supportTickets: readers.supportTickets, loyalty: readers.loyalty,
  });
  var SECTIONS = bShop.complianceExport.SCOPE_SECTIONS;

  var cust = b.uuid.v7();
  await _seedCustomer(query, cust, "Cara Customer");
  await addresses.add({
    customer_id: cust, recipient_name: "Cara Customer", street_line1: "1 Privacy Way",
    city: "Brussels", postal_code: "1000", country: "BE", is_default_shipping: true, is_default_billing: false,
  });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-adsr-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order,
        customers: customers, addresses: addresses, subscriptions: subscriptions,
        supportTickets: supportTickets, loyalty: loyalty,
        complianceExport: dsr, complianceExportReaders: readers, complianceExportSections: SECTIONS,
        streamDsrBundle: _streamDsrBundle,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    // ---- anon → login, never data ----
    var anon = await helpers.httpRequest({ port: port, path: "/admin/dsr" });
    check("anon dsr → login form", anon.body.indexOf("Admin API key") !== -1);
    check("anon does not leak the queue", anon.body.indexOf("Privacy requests</h2>") === -1);

    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login → 303", login.status === 303);

    // ---- empty queue + nav ----
    var empty = await helpers.httpRequest({ port: port, path: "/admin/dsr", jar: jar });
    check("dsr page → 200", empty.status === 200);
    check("nav includes Privacy requests", empty.body.indexOf("\"/admin/dsr\"") !== -1);
    check("queue shows status chips", empty.body.indexOf("/admin/dsr?status=received") !== -1);
    check("empty state shows", empty.body.indexOf("privacy requests") !== -1);

    // ---- seed an export request, list + detail ----
    var exReq = await dsr.requestExport({ customer_id: cust, requested_by: "operator-1", jurisdiction: "gdpr", scope: "full" });
    var list = await helpers.httpRequest({ port: port, path: "/admin/dsr", jar: jar });
    check("list shows the request row", list.body.indexOf("/admin/dsr/" + exReq.id) !== -1);

    var detail = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + exReq.id, jar: jar });
    check("detail → 200", detail.status === 200);
    check("detail shows the Fulfil form", detail.body.indexOf("/admin/dsr/" + exReq.id + "/fulfill") !== -1);

    // ---- fulfil → 303 ?moved=1; status flips ----
    var fulfill = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + exReq.id + "/fulfill", method: "POST", jar: jar });
    check("fulfill → 303 ?moved=1", fulfill.status === 303 && (fulfill.headers["location"] || "").indexOf("?moved=1") !== -1);
    var fulfilledRow = await dsr.getRequest(exReq.id);
    check("status is fulfilled", fulfilledRow.status === "fulfilled");

    // ---- export.json download ----
    var dl = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + exReq.id + "/export.json", jar: jar });
    check("export.json → 200", dl.status === 200);
    check("export.json is JSON", (dl.headers["content-type"] || "").indexOf("application/json") === 0);
    check("export.json is an attachment", (dl.headers["content-disposition"] || "").indexOf("attachment") === 0);
    var parsed = JSON.parse(dl.body);
    check("export.json carries data.customers", parsed && parsed.data && parsed.data.customers && parsed.data.customers.customer && parsed.data.customers.customer.id === cust);
    check("export.json addresses non-empty", Array.isArray(parsed.data.addresses) && parsed.data.addresses.length === 1);

    // ---- bearer JSON list ----
    var apiList = await helpers.httpRequest({ port: port, path: "/admin/dsr", headers: bearer });
    check("bearer dsr is JSON", (apiList.headers["content-type"] || "").indexOf("application/json") === 0);
    var lj = JSON.parse(apiList.body);
    check("bearer dsr → { rows, status }", Array.isArray(lj.rows) && typeof lj.status === "string" && lj.rows.length === 1);

    // ---- seed a deletion, dry-run preview WITHOUT mutating ----
    var delReq = await dsr.requestDeletion({ customer_id: cust, requested_by: "operator-1", jurisdiction: "gdpr", reason: "right to erasure" });
    var addrBefore = await addresses.listForCustomer(cust, {});
    var preview = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + delReq.id + "?preview=1", jar: jar });
    check("preview → 200", preview.status === 200);
    check("preview shows the dry-run panel", preview.body.indexOf("dry run") !== -1);
    check("preview shows the addresses table row", preview.body.indexOf("customer_addresses") !== -1);
    var addrAfterPreview = await addresses.listForCustomer(cust, {});
    check("preview did NOT archive the address", addrAfterPreview.length === addrBefore.length && addrAfterPreview.length === 1);
    var delRowAfterPreview = await dsr.getRequest(delReq.id);
    check("preview did NOT advance status", delRowAfterPreview.status === "received");

    // ---- execute via the confirm interstitial ----
    var confirmPage = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + delReq.id + "/delete/confirm", method: "POST", jar: jar });
    check("execute (unconfirmed) → confirm interstitial", confirmPage.status === 200 && confirmPage.body.indexOf("Execute erasure") !== -1);
    var execute = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + delReq.id + "/delete/confirm", method: "POST", jar: jar, form: { confirmed: "1" } });
    check("execute (confirmed) → 303 ?moved=1", execute.status === 303 && (execute.headers["location"] || "").indexOf("?moved=1") !== -1);
    var execRow = await dsr.getRequest(delReq.id);
    check("deletion row now fulfilled", execRow.status === "fulfilled");
    var addrAfterExec = await addresses.listForCustomer(cust, {});
    check("execute archived the address", addrAfterExec.length === 0);
    var custRowAfter = await customers.get(cust);
    check("execute anonymized the customer row", custRowAfter && custRowAfter.display_name.indexOf("[erased customer") === 0);

    // ---- malformed id → 404, not 500 ----
    var malformed = await helpers.httpRequest({ port: port, path: "/admin/dsr/not-a-uuid", jar: jar });
    check("malformed id → 404", malformed.status === 404);

    // ---- XSS: a dismiss_reason payload renders escaped on the detail ----
    var dismissReq = await dsr.requestExport({ customer_id: cust, requested_by: "operator-1", jurisdiction: "ccpa", scope: "identity_only" });
    var XSS = "<script>alert(1)</script>";
    var dismissed = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + dismissReq.id + "/dismiss", method: "POST", jar: jar, form: { dismiss_reason: "duplicate " + XSS } });
    check("dismiss → 303 ?moved=1", dismissed.status === 303 && (dismissed.headers["location"] || "").indexOf("?moved=1") !== -1);
    var dismissedDetail = await helpers.httpRequest({ port: port, path: "/admin/dsr/" + dismissReq.id, jar: jar });
    check("dismiss reason renders escaped", dismissedDetail.body.indexOf("&lt;script&gt;") !== -1);
    check("dismiss reason never renders raw", dismissedDetail.body.indexOf("<script>alert(1)</script>") === -1);

    console.log("admin-dsr-console: " + helpers.getChecks() + " checks passed");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
