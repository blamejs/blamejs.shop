"use strict";
/**
 * Role gate on the privacy/DSR admin routes (/admin/dsr/:id/...).
 *
 * The DSR queue administers a customer's personal data: a PII export
 * (fulfill / dispatch) and an irreversible GDPR erasure (delete). These are
 * mutating actions and must be refused for a read-only viewer, exactly like
 * every other customer-record write — they gate on `customers.write`.
 *
 * This pins the boundary end to end against the live admin chokepoint:
 *   - a VIEWER (no write grant) is refused (403) on fulfill / dispatch /
 *     dismiss / delete-confirm — and the export never runs, the customer is
 *     never erased,
 *   - a MANAGER (holds customers.write) is allowed those same actions,
 *   - the break-glass ADMIN_API_KEY bearer (owner) is allowed (never locked
 *     out by the role layer),
 *   - the viewer's denied attempts are chained through the operator audit
 *     log.
 *
 * Network: zero — every request lands on 127.0.0.1. NO worker/ import.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var TOKEN = "admin-token-0123456789abcdef-test"; // >= 16 chars

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0026_customer_addresses.sql", "0009_subscriptions.sql",
  "0047_support_tickets.sql", "0022_loyalty.sql", "0109_compliance_export.sql",
  "0074_operator_audit_log.sql", "0213_operator_accounts.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// Reader shims + streaming helper, mirroring server.js (and the DSR console
// test) so the export/erasure primitives have a real data path.
function _buildReaders(h, query) {
  return {
    customers: {
      forCustomerExport: async function (id) {
        try {
          var row = await h.customers.get(id);
          return { customer: row || null, passkeys: [], sign_in_methods: null };
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
    orderNotes:     { forCustomerExport: async function () { return []; } },
    subscriptions:  { forCustomerExport: async function () { return []; }, forCustomerDeletion: async function () { return { table: "subscriptions", deleted: 0 }; } },
    paymentMethods: { forCustomerExport: async function () { return []; } },
    supportTickets: { forCustomerExport: async function () { return []; }, forCustomerDeletion: async function () { return { table: "support_tickets", deleted: 0, note: "retained" }; } },
    loyalty:        { forCustomerExport: async function () { return null; }, forCustomerDeletion: async function () { return { table: "loyalty", deleted: 0, note: "retained-ledger" }; } },
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
  emit("{\"request_id\":" + JSON.stringify(row.id) + ",\"data\":{}}");
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
  var customers     = bShop.customers.create({ query: query, cursorSecret: "rgate-cust" });
  var order         = bShop.order.create({ query: query, cursorSecret: "rgate-order" });
  var addresses     = bShop.addresses.create({ query: query });
  var config        = bShop.config.create({ query: query });
  var operatorAuditLog = bShop.operatorAuditLog.create({ query: query });
  var operatorAccounts = bShop.operatorAccounts.create({ query: query, operatorAuditLog: operatorAuditLog });

  var readers = _buildReaders({ customers: customers, addresses: addresses, order: order }, query);
  var dsr = bShop.complianceExport.create({
    query: query, customers: readers.customers, addresses: readers.addresses, order: readers.order,
    orderNotes: readers.orderNotes, subscriptions: readers.subscriptions, paymentMethods: readers.paymentMethods,
    supportTickets: readers.supportTickets, loyalty: readers.loyalty,
  });
  var SECTIONS = bShop.complianceExport.SCOPE_SECTIONS;

  // Two customers so a denied erasure on one is provable independent of the
  // manager's allowed erasure on the other.
  var custA = b.uuid.v7();
  var custB = b.uuid.v7();
  await _seedCustomer(query, custA, "Cara Customer");
  await _seedCustomer(query, custB, "Bob Buyer");
  await addresses.add({ customer_id: custA, recipient_name: "Cara Customer", street_line1: "1 Privacy Way", city: "Brussels", postal_code: "1000", country: "BE", is_default_shipping: true, is_default_billing: false });
  await addresses.add({ customer_id: custB, recipient_name: "Bob Buyer", street_line1: "2 Privacy Way", city: "Brussels", postal_code: "1000", country: "BE", is_default_shipping: true, is_default_billing: false });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-dsr-rgate-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        customers: customers, addresses: addresses,
        complianceExport: dsr, complianceExportReaders: readers, complianceExportSections: SECTIONS,
        streamDsrBundle: _streamDsrBundle,
        operatorAccounts: operatorAccounts, operatorAuditLog: operatorAuditLog,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;
  var ownerBearer = { authorization: "Bearer " + TOKEN };

  try {
    // --- Bootstrap a viewer + a manager via the break-glass owner ----------
    var vwr = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "viewer@example.com", display_name: "Vic Viewer", password: "viewer-pass-1234", role: "viewer", mint_api_key: "1" },
    });
    check("bootstrap viewer (201)", vwr.status === 201);
    var viewerBearer = { authorization: "Bearer " + JSON.parse(vwr.body).api_key };

    var mgr = await helpers.httpRequest({
      port: port, path: "/admin/operators", method: "POST", headers: ownerBearer,
      form: { email: "manager@example.com", display_name: "Mae Manager", password: "manager-pass-1234", role: "manager", mint_api_key: "1" },
    });
    check("bootstrap manager (201)", mgr.status === 201);
    var managerBearer = { authorization: "Bearer " + JSON.parse(mgr.body).api_key };

    // Read routes still admit a viewer — the DSR queue is visible, not hidden.
    var viewerReadsQueue = await helpers.httpRequest({ port: port, path: "/admin/dsr", headers: viewerBearer });
    check("viewer ALLOWED the read DSR queue (200)", viewerReadsQueue.status === 200);

    // --- VIEWER DENIED: export fulfill ------------------------------------
    var exReqA = await dsr.requestExport({ customer_id: custA, requested_by: "operator-1", jurisdiction: "gdpr", scope: "full" });
    var viewerFulfill = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + exReqA.id + "/fulfill", method: "POST", headers: viewerBearer, form: {},
    });
    check("viewer DENIED export fulfill (403, not hidden)", viewerFulfill.status === 403);
    var rowAfterViewerFulfill = await dsr.getRequest(exReqA.id);
    check("viewer's fulfill did NOT run (status still received)", rowAfterViewerFulfill.status === "received");

    // --- VIEWER DENIED: dismiss -------------------------------------------
    var viewerDismiss = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + exReqA.id + "/dismiss", method: "POST", headers: viewerBearer, form: { dismiss_reason: "nope" },
    });
    check("viewer DENIED dismiss (403)", viewerDismiss.status === 403);

    // --- VIEWER DENIED: irreversible erasure ------------------------------
    var delReqA = await dsr.requestDeletion({ customer_id: custA, requested_by: "operator-1", jurisdiction: "gdpr", reason: "right to erasure" });
    // The unconfirmed first POST (which would otherwise render the erasure
    // interstitial) is refused on the verb too — a viewer never even reaches
    // the consequence screen.
    var viewerEraseInterstitial = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + delReqA.id + "/delete/confirm", method: "POST", headers: viewerBearer, form: {},
    });
    check("viewer DENIED the erasure interstitial (403)", viewerEraseInterstitial.status === 403);
    var viewerErase = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + delReqA.id + "/delete/confirm", method: "POST", headers: viewerBearer, form: { confirmed: "1" },
    });
    check("viewer DENIED irreversible erasure (403)", viewerErase.status === 403);
    var delRowAfterViewer = await dsr.getRequest(delReqA.id);
    check("viewer's erasure did NOT run (status still received)", delRowAfterViewer.status === "received");
    var custAStill = await customers.get(custA);
    check("viewer's erasure did NOT anonymize the customer", custAStill && custAStill.display_name === "Cara Customer");
    var addrAStill = await addresses.listForCustomer(custA, {});
    check("viewer's erasure did NOT archive the address", addrAStill.length === 1);

    // --- MANAGER ALLOWED: fulfill + irreversible erasure ------------------
    var mgrFulfill = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + exReqA.id + "/fulfill", method: "POST", headers: managerBearer, form: {},
    });
    check("manager ALLOWED export fulfill (2xx)", mgrFulfill.status >= 200 && mgrFulfill.status < 300);
    var rowAfterMgrFulfill = await dsr.getRequest(exReqA.id);
    check("manager's fulfill advanced the status", rowAfterMgrFulfill.status === "fulfilled");

    var delReqB = await dsr.requestDeletion({ customer_id: custB, requested_by: "operator-1", jurisdiction: "gdpr", reason: "right to erasure" });
    var mgrErase = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + delReqB.id + "/delete/confirm", method: "POST", headers: managerBearer, form: { confirmed: "1" },
    });
    check("manager ALLOWED erasure (2xx)", mgrErase.status >= 200 && mgrErase.status < 300);
    var custBAfter = await customers.get(custB);
    check("manager's erasure anonymized the customer", custBAfter && custBAfter.display_name.indexOf("[erased customer") === 0);

    // --- TRAP: break-glass ADMIN_API_KEY (owner) still allowed ------------
    var ownerErasureReq = await dsr.requestDeletion({ customer_id: custA, requested_by: "operator-1", jurisdiction: "gdpr", reason: "owner erase" });
    var ownerErase = await helpers.httpRequest({
      port: port, path: "/admin/dsr/" + ownerErasureReq.id + "/delete/confirm", method: "POST", headers: ownerBearer, form: {},
    });
    check("break-glass ADMIN_API_KEY ALLOWED erasure (2xx, never locked out)", ownerErase.status >= 200 && ownerErase.status < 300);

    // --- The viewer's denials were chained through the operator audit log --
    var deniedRows = mem.db.prepare(
      "SELECT COUNT(*) AS n FROM operator_audit_events WHERE action LIKE 'permission.denied:customer.dsr_%'"
    ).get();
    check("DSR role-denials are audited (>=3)", deniedRows && Number(deniedRows.n) >= 3);

    console.log("admin-dsr-role-gate: " + helpers.getChecks() + " checks passed");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
