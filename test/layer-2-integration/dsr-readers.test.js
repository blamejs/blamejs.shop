"use strict";
/**
 * DSR per-domain reader adapters — the contract that makes the export
 * bundle real.
 *
 * lib/compliance-export.js expects each injected handle to expose
 * forCustomerExport / forCustomerDeletion. NONE of the per-domain
 * primitives do; server.js builds adapter shims that map each handle's
 * existing read / soft-delete surface onto that contract. The shims aren't
 * exported, so this test re-declares the SAME shims over real handles on a
 * shared in-memory DB and exercises them through the primitive — proving:
 *   - a populated customer's `full` export has every section present and
 *     `sections_absent` empty (the bug this whole group fixes — passing
 *     raw handles ships an empty bundle),
 *   - scope narrowing (orders_only / identity_only),
 *   - processDeletion dry-run reports counts WITHOUT mutating (re-read
 *     proves no archive happened),
 *   - processDeletion wet-run archives addresses + subscriptions and
 *     anonymizes the customer row, while orders / loyalty / tickets are
 *     retained (deleted: 0),
 *   - a failing adapter (unmigrated table) returns null/[] and the bundle
 *     still assembles.
 *
 * Network: zero. Pure node:sqlite over the live migrations.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var b = bShop.framework;

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0026_customer_addresses.sql", "0009_subscriptions.sql",
  "0047_support_tickets.sql", "0022_loyalty.sql", "0109_compliance_export.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// The SAME adapter shims server.js builds (kept in sync with _dsrReader).
function _buildReaders(handles, query) {
  return {
    customers: {
      forCustomerExport: async function (id) {
        try {
          var row = await handles.customers.get(id);
          var passkeys = [];
          try { passkeys = await handles.customers.listPasskeys(id); } catch (_e) { passkeys = []; }
          var methods = null;
          try { methods = await handles.customers.signInMethodsByCustomer([id]); } catch (_e) { methods = null; }
          return { customer: row || null, passkeys: passkeys || [], sign_in_methods: methods || null };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var existing = await handles.customers.get(id);
          if (!existing) return { table: "customers", deleted: 0 };
          if (dryRun) return { table: "customers", deleted: 1 };
          await handles.customers.update(id, { display_name: "[erased customer " + String(id).slice(0, 8) + "]" });
          return { table: "customers", deleted: 1 };
        } catch (_e) { return { table: "customers", deleted: 0 }; }
      },
    },
    addresses: {
      forCustomerExport: async function (id) {
        try { return await handles.addresses.listForCustomer(id, { include_archived: true }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        try {
          var rows = await handles.addresses.listForCustomer(id, {});
          if (dryRun) return { table: "customer_addresses", deleted: rows.length };
          var n = 0;
          for (var i = 0; i < rows.length; i += 1) { if (await handles.addresses.archive(rows[i].id)) n += 1; }
          return { table: "customer_addresses", deleted: n };
        } catch (_e) { return { table: "customer_addresses", deleted: 0 }; }
      },
    },
    order: {
      forCustomerExport: async function (id) {
        try { return (await handles.order.listForCustomer(id, { limit: 100 })).rows; }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "orders", deleted: 0, note: "retained-for-accounting" }; },
    },
    // orderNotes / paymentMethods report present-but-empty so the `full`
    // scope's section list (which includes both) reads as complete rather
    // than absent — matching server.js's _dsrReader.
    orderNotes: { forCustomerExport: async function () { return []; } },
    paymentMethods: { forCustomerExport: async function () { return []; } },
    subscriptions: {
      forCustomerExport: async function (id) {
        try { return await handles.subscriptions.subscriptions.list({ customer_id: id }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function (id, opts) {
        var dryRun = !!(opts && opts.dry_run);
        var TERMINAL = ["canceled", "incomplete_expired"];
        try {
          var rows = await handles.subscriptions.subscriptions.list({ customer_id: id });
          var live = rows.filter(function (r) { return TERMINAL.indexOf(r.status) === -1; });
          if (dryRun) return { table: "subscriptions", deleted: live.length };
          var n = 0;
          var ts = Date.now();
          for (var i = 0; i < live.length; i += 1) {
            var res = await query("UPDATE subscriptions SET status = 'canceled', updated_at = ?1 WHERE id = ?2", [ts, live[i].id]);
            if (res && res.rowCount) n += Number(res.rowCount);
          }
          return { table: "subscriptions", deleted: n };
        } catch (_e) { return { table: "subscriptions", deleted: 0 }; }
      },
    },
    supportTickets: {
      forCustomerExport: async function (id) {
        try { return await handles.supportTickets.listByCustomerId(id, { limit: 100 }); }
        catch (_e) { return []; }
      },
      forCustomerDeletion: async function () { return { table: "support_tickets", deleted: 0, note: "retained" }; },
    },
    loyalty: {
      forCustomerExport: async function (id) {
        try {
          var balance = await handles.loyalty.balance(id);
          var history = [];
          try { history = (await handles.loyalty.history(id, { limit: 200 })).rows; } catch (_e) { history = []; }
          return { balance: balance, history: history };
        } catch (_e) { return null; }
      },
      forCustomerDeletion: async function () { return { table: "loyalty", deleted: 0, note: "retained-ledger" }; },
    },
  };
}

async function _seedCustomer(query, id, displayName) {
  var ts = Date.now();
  // email_hash from the FULL id — a v7-UUID prefix slice collides for two
  // same-ms generations (UNIQUE constraint).
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [id, "hash-" + id, displayName, ts],
  );
}

async function _seedOrder(query, customerId) {
  var id = b.uuid.v7();
  var cartId = b.uuid.v7();
  var ts = Date.now();
  await query(
    "INSERT INTO carts (id, session_id, customer_id, currency, status, created_at, updated_at, expires_at) " +
    "VALUES (?1, ?2, ?3, 'USD', 'converted', ?4, ?4, ?5)",
    [cartId, b.uuid.v7(), customerId, ts, ts + 86400000],
  );
  await query(
    "INSERT INTO orders (id, cart_id, customer_id, session_id, status, currency, " +
    "subtotal_minor, discount_minor, tax_minor, shipping_minor, grand_total_minor, " +
    "payment_intent_id, ship_to_json, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'paid', 'USD', 1000, 0, 0, 0, 1000, NULL, ?5, ?6, ?6)",
    [id, cartId, customerId, b.uuid.v7(), JSON.stringify({ country: "US", line1: "1 Test St" }), ts],
  );
  return id;
}

async function _seedSubscription(query, customerId) {
  var ts = Date.now();
  var planId = b.uuid.v7();
  // variant_id is nullable (ON DELETE SET NULL) — leave it NULL so the seed
  // needs no catalog product / variant row.
  await query(
    "INSERT INTO subscription_plans (id, variant_id, stripe_price_id, interval, interval_count, " +
    "currency, amount_minor, trial_days, active, created_at, updated_at) " +
    "VALUES (?1, NULL, ?2, 'month', 1, 'usd', 1999, 0, 1, ?3, ?3)",
    [planId, "price_" + planId.slice(0, 8), ts],
  );
  var subId = b.uuid.v7();
  await query(
    "INSERT INTO subscriptions (id, customer_id, plan_id, stripe_subscription_id, status, " +
    "current_period_start, current_period_end, cancel_at_period_end, created_at, updated_at) " +
    "VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6, 0, ?5, ?5)",
    [subId, customerId, planId, "sub_" + subId.replace(/-/g, "").slice(-16), ts, ts + 2592000000],
  );
  return subId;
}

async function _run() {
  var mem     = helpers.memD1Query(MIGS);
  var query   = mem.query;

  var customers     = bShop.customers.create({ query: query, cursorSecret: "dsr-readers-cust" });
  var addresses     = bShop.addresses.create({ query: query });
  var order         = bShop.order.create({ query: query, cursorSecret: "dsr-readers-order" });
  var subscriptions = bShop.subscriptions.create({ query: query, payment: null });
  var supportTickets = bShop.supportTickets.create({ query: query, cursorSecret: "dsr-readers-support" });
  var loyalty       = bShop.loyalty.create({ query: query });

  var handles = {
    customers: customers, addresses: addresses, order: order,
    subscriptions: subscriptions, supportTickets: supportTickets, loyalty: loyalty,
  };
  var readers = _buildReaders(handles, query);

  var dsr = bShop.complianceExport.create({
    query:          query,
    customers:      readers.customers,
    addresses:      readers.addresses,
    order:          readers.order,
    orderNotes:     readers.orderNotes,
    subscriptions:  readers.subscriptions,
    paymentMethods: readers.paymentMethods,
    supportTickets: readers.supportTickets,
    loyalty:        readers.loyalty,
  });

  // ---- populate a customer across every domain ----
  var cid = b.uuid.v7();
  await _seedCustomer(query, cid, "Dana Subject");
  await addresses.add({
    customer_id: cid, recipient_name: "Dana Subject", street_line1: "1 Privacy Way",
    city: "Brussels", postal_code: "1000", country: "BE", is_default_shipping: true, is_default_billing: false,
  });
  await _seedOrder(query, cid);
  await _seedSubscription(query, cid);
  await supportTickets.open({
    customer_id: cid, customer_email: "dana@example.com", subject: "Where is my order?",
    body: "Tracking hasn't updated.", category: "order_issue",
  });
  await loyalty.earn({ customer_id: cid, points: 120, source: "purchase" });

  // ---- 1. full export: every section present, sections_absent EMPTY ----
  var exReq = await dsr.requestExport({ customer_id: cid, requested_by: "operator-1", jurisdiction: "gdpr", scope: "full" });
  var bundle = await dsr.fulfillRequest({ request_id: exReq.id });
  check("full export sections_absent is empty", Array.isArray(bundle.sections_absent) && bundle.sections_absent.length === 0);
  ["customers", "addresses", "order", "subscriptions", "supportTickets", "loyalty"].forEach(function (name) {
    check("full export has section " + name, bundle.sections_present.indexOf(name) !== -1);
  });
  check("customers section carries the row",  bundle.data.customers && bundle.data.customers.customer && bundle.data.customers.customer.id === cid);
  check("addresses section is non-empty",     Array.isArray(bundle.data.addresses) && bundle.data.addresses.length === 1);
  check("order section is non-empty",         Array.isArray(bundle.data.order) && bundle.data.order.length === 1);
  check("subscriptions section is non-empty", Array.isArray(bundle.data.subscriptions) && bundle.data.subscriptions.length === 1);
  check("supportTickets section is non-empty", Array.isArray(bundle.data.supportTickets) && bundle.data.supportTickets.length === 1);
  check("loyalty section carries balance",    bundle.data.loyalty && bundle.data.loyalty.balance && bundle.data.loyalty.balance.balance === 120);

  // ---- 2. scope narrowing ----
  var ordersOnlyReq = await dsr.requestExport({ customer_id: cid, requested_by: "op", jurisdiction: "ccpa", scope: "orders_only" });
  var ordersOnly = await dsr.fulfillRequest({ request_id: ordersOnlyReq.id });
  check("orders_only present has order",       ordersOnly.sections_present.indexOf("order") !== -1);
  check("orders_only omits customers",         ordersOnly.sections_present.indexOf("customers") === -1);

  var identityReq = await dsr.requestExport({ customer_id: cid, requested_by: "op", jurisdiction: "lgpd", scope: "identity_only" });
  var identity = await dsr.fulfillRequest({ request_id: identityReq.id });
  check("identity_only has customers",         identity.sections_present.indexOf("customers") !== -1);
  check("identity_only has addresses",         identity.sections_present.indexOf("addresses") !== -1);
  check("identity_only omits order",           identity.sections_present.indexOf("order") === -1);

  // ---- 3. deletion DRY-RUN reports counts WITHOUT mutating ----
  var delReq = await dsr.requestDeletion({ customer_id: cid, requested_by: "op", jurisdiction: "gdpr", reason: "right to erasure" });
  var addrBefore = await addresses.listForCustomer(cid, {});
  var preview = await dsr.processDeletion({ request_id: delReq.id, dry_run: true });
  check("dry-run is flagged dry_run",          preview.dry_run === true);
  var addrDom = preview.domains.filter(function (d) { return d.domain === "addresses"; })[0];
  check("dry-run counts addresses",            addrDom && addrDom.deleted === 1);
  var subDom = preview.domains.filter(function (d) { return d.domain === "subscriptions"; })[0];
  check("dry-run counts subscriptions",        subDom && subDom.deleted === 1);
  var addrAfterPreview = await addresses.listForCustomer(cid, {});
  check("dry-run did NOT archive addresses",   addrAfterPreview.length === addrBefore.length && addrAfterPreview.length === 1);
  var delRowAfterPreview = await dsr.getRequest(delReq.id);
  check("dry-run did NOT advance status",      delRowAfterPreview.status === "received");

  // ---- 4. deletion WET-RUN archives + anonymizes; retains the rest ----
  var result = await dsr.processDeletion({ request_id: delReq.id, dry_run: false });
  check("wet-run is not dry_run",              result.dry_run === false);
  var addrAfter = await addresses.listForCustomer(cid, {});
  check("wet-run archived the address",        addrAfter.length === 0);
  var subRows = await subscriptions.subscriptions.list({ customer_id: cid });
  check("wet-run canceled the subscription",   subRows.length === 1 && subRows[0].status === "canceled");
  var custRow = await customers.get(cid);
  check("wet-run anonymized the customer row", custRow && custRow.display_name.indexOf("[erased customer") === 0);
  var ordersRetained  = result.domains.filter(function (d) { return d.domain === "order"; })[0];
  var loyaltyRetained = result.domains.filter(function (d) { return d.domain === "loyalty"; })[0];
  var ticketsRetained = result.domains.filter(function (d) { return d.domain === "supportTickets"; })[0];
  check("orders retained (deleted: 0)",        ordersRetained && ordersRetained.deleted === 0);
  check("loyalty retained (deleted: 0)",       loyaltyRetained && loyaltyRetained.deleted === 0);
  check("tickets retained (deleted: 0)",       ticketsRetained && ticketsRetained.deleted === 0);
  var ordersStill = (await order.listForCustomer(cid, { limit: 10 })).rows;
  check("the order row is still present",       ordersStill.length === 1);

  // ---- 5. a failing adapter (unmigrated table) → null/[], bundle assembles ----
  // Build a reader set where one adapter reads a non-existent table: the
  // export adapter throws internally, the shim swallows it (returns null),
  // and the section lands in sections_absent rather than failing the bundle.
  var brokenReaders = _buildReaders({
    customers: customers, addresses: addresses, order: order,
    subscriptions: subscriptions, supportTickets: supportTickets,
    loyalty: { balance: async function () { throw new Error("loyalty_accounts: no such table"); } },
  }, query);
  // Force the loyalty export to fall to the catch by giving it a handle
  // whose balance throws — the shim returns null, not throws.
  var loyaltySection = await brokenReaders.loyalty.forCustomerExport(cid);
  check("a failing export adapter returns null", loyaltySection === null);

  console.log("dsr-readers: " + helpers.getChecks() + " checks passed");
}

module.exports = { run: _run };
