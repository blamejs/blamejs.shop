"use strict";
/**
 * complianceExport — GDPR / CCPA / LGPD subject-access-request export
 * + deletion lifecycle. The customer (or operator on their behalf)
 * asks for a copy of their data or asks for erasure; the primitive
 * composes injected per-domain readers + tracks the request through
 * received -> processing -> fulfilled -> delivered (export) or
 * received -> processing -> fulfilled (deletion).
 *
 * Layer 1 against in-memory node:sqlite loaded from migration
 * `0109_compliance_export.sql`.
 *
 * Coverage:
 *   - requestExport persists the row with scope + jurisdiction +
 *     status='received'; refuses bad input shape
 *   - listRequests filters by status + jurisdiction
 *   - fulfillRequest with `full` scope walks every injected reader,
 *     bundles their output, flips status to fulfilled + stamps
 *     fulfilled_at
 *   - fulfillRequest with `orders_only` scope only invokes order +
 *     orderNotes readers; identity / loyalty / etc. readers reported
 *     as sections_absent
 *   - fulfillRequest with `identity_only` scope only invokes
 *     customers + addresses readers
 *   - dispatchExport flips fulfilled -> delivered with method +
 *     address; refuses when not fulfilled
 *   - requestDeletion + processDeletion(dry_run: true) reports
 *     per-domain counts without mutating; processDeletion(dry_run:
 *     false) flips status to fulfilled
 *   - auditForCustomer returns the customer's complete history
 *     across kinds + jurisdictions in DESC order
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var { DatabaseSync } = require("node:sqlite");

var bShop             = require("../../lib");
var complianceExport  = require("../../lib/compliance-export");
var helpers           = require("../helpers");
var check             = helpers.check;
var assert            = helpers.assert;

var MIG = nodePath.resolve(__dirname, "..", "..", "migrations-d1", "0109_compliance_export.sql");

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  _splitSchema(nodeFs.readFileSync(MIG, "utf8")).forEach(function (s) { db.prepare(s).run(); });
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

function _uuid() { return bShop.framework.uuid.v7(); }

// ---- mock injected readers ---------------------------------------------
//
// Each one implements the two-method contract the primitive consumes:
//   - forCustomerExport(customer_id)
//   - forCustomerDeletion(customer_id, { dry_run })
// The deletion handler honors `dry_run` by reporting counts without
// mutating its internal store — same contract the primitive demands
// of a real per-domain reader.

function _mockReader(name, table, exportPayload, rowCount) {
  var store = { rows: rowCount };
  return {
    name:  name,
    table: table,
    forCustomerExport: async function (_customerId) {
      return exportPayload;
    },
    forCustomerDeletion: async function (_customerId, opts) {
      var n = store.rows;
      if (!opts || opts.dry_run !== true) store.rows = 0;
      return { table: table, deleted: n };
    },
    _peekStore: function () { return store; },
  };
}

// ---- requestExport happy path + refusals -------------------------------

async function _requestExportShape() {
  var q  = _makeQuery();
  var ce = complianceExport.create({ query: q });

  var customerId = _uuid();
  var req = await ce.requestExport({
    customer_id:  customerId,
    requested_by: "customer-portal",
    jurisdiction: "gdpr",
    scope:        "full",
  });
  check("requestExport returns row",        req && typeof req === "object");
  check("requestExport id is UUID",         typeof req.id === "string" && req.id.length > 0);
  check("requestExport kind=export",        req.request_kind === "export");
  check("requestExport jurisdiction=gdpr",  req.jurisdiction === "gdpr");
  check("requestExport scope=full",         req.scope === "full");
  check("requestExport status=received",    req.status === "received");
  check("requestExport requested_by",       req.requested_by === "customer-portal");
  check("requestExport requested_at int",   Number.isInteger(req.requested_at));
  check("requestExport fulfilled_at null",  req.fulfilled_at === null);
  check("requestExport delivered_at null",  req.delivered_at === null);
  check("requestExport delivery_method null", req.delivery_method === null);

  var fetched = await ce.getRequest(req.id);
  check("getRequest round-trips",           fetched.id === req.id);

  // Refusals
  await assert.rejects(ce.requestExport(), /input object required/);
  await assert.rejects(ce.requestExport({
    customer_id: "not-a-uuid", requested_by: "x", jurisdiction: "gdpr", scope: "full",
  }), /customer_id/);
  await assert.rejects(ce.requestExport({
    customer_id: customerId, requested_by: "", jurisdiction: "gdpr", scope: "full",
  }), /requested_by/);
  await assert.rejects(ce.requestExport({
    customer_id: customerId, requested_by: "x", jurisdiction: "unknown", scope: "full",
  }), /jurisdiction/);
  await assert.rejects(ce.requestExport({
    customer_id: customerId, requested_by: "x", jurisdiction: "gdpr", scope: "bogus",
  }), /scope/);
}

// ---- listRequests filter -----------------------------------------------

async function _listRequestsFilter() {
  var q  = _makeQuery();
  var ce = complianceExport.create({ query: q });
  var c1 = _uuid();
  var c2 = _uuid();

  await ce.requestExport({ customer_id: c1, requested_by: "p", jurisdiction: "gdpr", scope: "full" });
  await ce.requestExport({ customer_id: c2, requested_by: "p", jurisdiction: "ccpa", scope: "orders_only" });
  await ce.requestDeletion({ customer_id: c1, requested_by: "p", jurisdiction: "gdpr", reason: "customer right to erasure" });

  var allList = await ce.listRequests();
  check("listRequests no filter returns 3",     allList.length === 3);

  var gdprOnly = await ce.listRequests({ jurisdiction: "gdpr" });
  check("listRequests jurisdiction filter",     gdprOnly.length === 2);

  var ccpaOnly = await ce.listRequests({ jurisdiction: "ccpa" });
  check("listRequests ccpa filter narrows to 1", ccpaOnly.length === 1);

  var receivedOnly = await ce.listRequests({ status: "received" });
  check("listRequests status filter",            receivedOnly.length === 3);

  await assert.rejects(ce.listRequests({ status: "bogus" }), /status/);
  await assert.rejects(ce.listRequests({ jurisdiction: "bogus" }), /jurisdiction/);
  await assert.rejects(ce.listRequests({ limit: 0 }), /limit/);
}

// ---- fulfillRequest full-scope bundles all sections --------------------

async function _fulfillFullScope() {
  var q = _makeQuery();
  var customersReader      = _mockReader("customers",      "customers",       { email: "redacted-hash" }, 1);
  var orderReader          = _mockReader("order",          "orders",          [{ order_id: "ord-1" }, { order_id: "ord-2" }], 2);
  var orderNotesReader     = _mockReader("orderNotes",     "order_notes",     [{ note: "n1" }], 1);
  var subscriptionsReader  = _mockReader("subscriptions",  "subscriptions",   [{ sub_id: "s-1" }], 1);
  var addressesReader      = _mockReader("addresses",      "addresses",       [{ postal: "12345" }], 1);
  var paymentMethodsReader = _mockReader("paymentMethods", "payment_methods", [{ brand: "visa", last4: "1234" }], 1);
  var supportTicketsReader = _mockReader("supportTickets", "support_tickets", [{ ticket: "t-1" }], 1);
  var loyaltyReader        = _mockReader("loyalty",        "loyalty",         { points: 100 }, 1);
  // The customer-keyed personalization / feedback / consent domains: every
  // table that holds a row keyed by the customer belongs in a full export.
  var reviewsReader        = _mockReader("reviews",        "reviews",         [{ review_id: "rv-1" }], 1);
  var consentLedgerReader  = _mockReader("consentLedger",  "consent_ledger",  [{ consent_kind: "marketing", state: "granted" }], 1);
  var wishlistReader       = _mockReader("wishlist",       "wishlist",        [], 0);   // wired, but empty for this customer
  var surveysReader        = _mockReader("surveys",        "survey_invitations", [{ survey_slug: "nps" }], 1);
  var recentlyViewedReader = _mockReader("recentlyViewed", "recently_viewed", [{ product_id: "p-1" }], 1);
  // The feedback / holdover / wallet domains: each keys a row by the customer.
  var suggestionBoxReader  = _mockReader("suggestionBox",  "suggestions",     [{ id: "sg-1", title: "Stock more sizes" }], 1);
  var saveForLaterReader   = _mockReader("saveForLater",   "save_for_later",  [{ sku: "SKU-1", quantity: 2 }], 1);
  var storeCreditReader    = _mockReader("storeCredit",    "store_credit_ledger", { balance_minor: 500, history: [{ kind: "credit", amount_minor: 500 }] }, 1);
  // The remaining customer-keyed domains: the guest-order claim audit
  // trail, stock alerts, quotes, ratings, Q&A, CRM notes, gift cards,
  // and referral activity.
  var guestReconReader     = _mockReader("guestOrderReconciliations", "guest_order_reconciliations", [{ order_id: "ord-1", linked_via: "magic-link" }], 1);
  var stockAlertsReader    = _mockReader("stockAlerts",    "stock_alerts",    [{ sku: "SKU-1", email_normalised: "subject@example.com" }], 1);
  var quotesReader         = _mockReader("quotes",         "quotes",          [{ id: "q-1", message: "bulk pricing?" }], 1);
  var orderRatingsReader   = _mockReader("orderRatings",   "order_ratings",   [{ order_id: "ord-1", comment: "quick" }], 1);
  var productQaReader      = _mockReader("productQa",      "product_qa_questions", [{ body: "Does it ship to BE?" }], 1);
  var customerNotesReader  = _mockReader("customerNotes",  "customer_notes",  [{ body: "VIP" }], 1);
  var giftcardsReader      = _mockReader("giftcards",      "giftcards",       [{ code_hint: "WXYZ", balance_minor: 2500 }], 1);
  var referralsReader      = _mockReader("referrals",      "referral_invitations", { as_referrer: null, invitations_sent: [], as_referee: [{ reward_status: "pending" }] }, 1);

  // Support sessions opened on the account. In the export because when
  // someone looked at your account, why, and which pages is personal data
  // about you; retained on erasure because it is also the store's own record
  // that the access happened.
  var impersonationReader  = _mockReader("customerImpersonation", "impersonations",
    [{ session: { id: "imp-1", reason: "cart total looked wrong", status: "ended" }, actions: [] }], 0);

  var ce = complianceExport.create({
    query:          q,
    customers:      customersReader,
    order:          orderReader,
    orderNotes:     orderNotesReader,
    subscriptions:  subscriptionsReader,
    addresses:      addressesReader,
    paymentMethods: paymentMethodsReader,
    supportTickets: supportTicketsReader,
    loyalty:        loyaltyReader,
    reviews:        reviewsReader,
    consentLedger:  consentLedgerReader,
    wishlist:       wishlistReader,
    surveys:        surveysReader,
    recentlyViewed: recentlyViewedReader,
    suggestionBox:  suggestionBoxReader,
    saveForLater:   saveForLaterReader,
    storeCredit:    storeCreditReader,
    guestOrderReconciliations: guestReconReader,
    stockAlerts:    stockAlertsReader,
    quotes:         quotesReader,
    orderRatings:   orderRatingsReader,
    productQa:      productQaReader,
    customerNotes:  customerNotesReader,
    customerImpersonation: impersonationReader,
    giftcards:      giftcardsReader,
    referrals:      referralsReader,
  });

  var customerId = _uuid();
  var req = await ce.requestExport({
    customer_id: customerId, requested_by: "customer-portal",
    jurisdiction: "gdpr", scope: "full",
  });

  var fullScopeLen = complianceExport.SCOPE_SECTIONS.full.length;
  var bundle = await ce.fulfillRequest({ request_id: req.id });
  check("fulfill returns bundle",                  bundle && typeof bundle === "object");
  check("fulfill carries request_id",              bundle.request_id === req.id);
  check("fulfill carries customer_id",             bundle.customer_id === customerId);
  check("fulfill scope=full",                      bundle.scope === "full");
  check("fulfill sections_present has every wired domain", bundle.sections_present.length === fullScopeLen);
  check("fulfill sections_absent empty",           bundle.sections_absent.length === 0);
  check("fulfill data.customers present",          bundle.data.customers && bundle.data.customers.email === "redacted-hash");
  check("fulfill data.order has 2 orders",         Array.isArray(bundle.data.order) && bundle.data.order.length === 2);
  check("fulfill data.orderNotes has 1 note",      Array.isArray(bundle.data.orderNotes) && bundle.data.orderNotes.length === 1);
  check("fulfill data.subscriptions present",      Array.isArray(bundle.data.subscriptions));
  check("fulfill data.addresses present",          Array.isArray(bundle.data.addresses));
  check("fulfill data.paymentMethods present",     Array.isArray(bundle.data.paymentMethods));
  check("fulfill data.supportTickets present",     Array.isArray(bundle.data.supportTickets));
  check("fulfill data.loyalty present",            bundle.data.loyalty && bundle.data.loyalty.points === 100);
  // The newly-covered customer-keyed domains.
  check("fulfill data.reviews present",            Array.isArray(bundle.data.reviews) && bundle.data.reviews.length === 1);
  check("fulfill data.consentLedger present",      Array.isArray(bundle.data.consentLedger) && bundle.data.consentLedger.length === 1);
  check("fulfill data.wishlist present (empty)",   Array.isArray(bundle.data.wishlist) && bundle.data.wishlist.length === 0);
  check("fulfill data.surveys present",            Array.isArray(bundle.data.surveys) && bundle.data.surveys.length === 1);
  check("fulfill data.recentlyViewed present",     Array.isArray(bundle.data.recentlyViewed) && bundle.data.recentlyViewed.length === 1);
  check("fulfill data.suggestionBox present",      Array.isArray(bundle.data.suggestionBox) && bundle.data.suggestionBox.length === 1);
  check("fulfill data.saveForLater present",       Array.isArray(bundle.data.saveForLater) && bundle.data.saveForLater.length === 1);
  check("fulfill data.storeCredit present",        bundle.data.storeCredit && bundle.data.storeCredit.balance_minor === 500);
  check("fulfill data.guestOrderReconciliations present",
    Array.isArray(bundle.data.guestOrderReconciliations) && bundle.data.guestOrderReconciliations.length === 1);
  check("fulfill data.stockAlerts present",        Array.isArray(bundle.data.stockAlerts) && bundle.data.stockAlerts.length === 1);
  check("fulfill data.quotes present",             Array.isArray(bundle.data.quotes) && bundle.data.quotes.length === 1);
  check("fulfill data.orderRatings present",       Array.isArray(bundle.data.orderRatings) && bundle.data.orderRatings.length === 1);
  check("fulfill data.productQa present",          Array.isArray(bundle.data.productQa) && bundle.data.productQa.length === 1);
  check("fulfill data.customerNotes present",      Array.isArray(bundle.data.customerNotes) && bundle.data.customerNotes.length === 1);
  check("fulfill data.giftcards present",          Array.isArray(bundle.data.giftcards) && bundle.data.giftcards.length === 1);
  check("fulfill data.referrals present",          bundle.data.referrals && Array.isArray(bundle.data.referrals.as_referee) && bundle.data.referrals.as_referee.length === 1);

  // Completeness manifest — one entry per scope section, classified
  // exported / empty / absent so an unexported table is never silent.
  check("fulfill carries a manifest",              Array.isArray(bundle.manifest));
  check("manifest covers every scope section",     bundle.manifest.length === fullScopeLen);
  function _manifestStatus(name) {
    var e = bundle.manifest.filter(function (m) { return m.section === name; })[0];
    return e ? e.status : null;
  }
  check("manifest marks reviews exported",         _manifestStatus("reviews") === "exported");
  check("manifest marks wishlist empty",           _manifestStatus("wishlist") === "empty");
  check("manifest marks customers exported",       _manifestStatus("customers") === "exported");

  // Lifecycle row flipped to fulfilled
  var afterRow = await ce.getRequest(req.id);
  check("fulfill flips status to fulfilled",       afterRow.status === "fulfilled");
  check("fulfill stamps fulfilled_at",             Number.isInteger(afterRow.fulfilled_at));

  // Re-fulfilling a fulfilled request refuses
  await assert.rejects(ce.fulfillRequest({ request_id: req.id }), /fulfilled/);

  // A wired-but-absent domain surfaces in the manifest as `absent`, never
  // silently dropped — the completeness guarantee the bundle is built for.
  var qAbsent = _makeQuery();
  var ceAbsent = complianceExport.create({ query: qAbsent, customers: customersReader });
  var cAbsent = _uuid();
  var rAbsent = await ceAbsent.requestExport({
    customer_id: cAbsent, requested_by: "p", jurisdiction: "gdpr", scope: "full",
  });
  var bAbsent = await ceAbsent.fulfillRequest({ request_id: rAbsent.id });
  var absentManifest = bAbsent.manifest.filter(function (m) { return m.section === "reviews"; })[0];
  check("unwired reviews domain is manifest-absent", absentManifest && absentManifest.status === "absent");
  check("unwired reviews in sections_absent",        bAbsent.sections_absent.indexOf("reviews") !== -1);
}

// ---- fulfillRequest scope filters --------------------------------------

async function _fulfillScopeFilters() {
  // orders_only: only order + orderNotes contribute
  var q1 = _makeQuery();
  var customersReader  = _mockReader("customers",  "customers",   { email: "x" }, 1);
  var orderReader      = _mockReader("order",      "orders",      [{ id: "o1" }], 1);
  var orderNotesReader = _mockReader("orderNotes", "order_notes", [{ id: "n1" }], 1);
  var loyaltyReader    = _mockReader("loyalty",    "loyalty",     { points: 5 }, 1);
  var addressesReader  = _mockReader("addresses",  "addresses",   [], 0);

  var ceOrders = complianceExport.create({
    query:      q1,
    customers:  customersReader,
    order:      orderReader,
    orderNotes: orderNotesReader,
    loyalty:    loyaltyReader,
    addresses:  addressesReader,
  });

  var c1 = _uuid();
  var rOrders = await ceOrders.requestExport({
    customer_id: c1, requested_by: "p", jurisdiction: "ccpa", scope: "orders_only",
  });
  var bOrders = await ceOrders.fulfillRequest({ request_id: rOrders.id });
  check("orders_only sections_present=2",          bOrders.sections_present.length === 2);
  check("orders_only includes order",              bOrders.sections_present.indexOf("order") !== -1);
  check("orders_only includes orderNotes",         bOrders.sections_present.indexOf("orderNotes") !== -1);
  check("orders_only excludes customers",          bOrders.sections_present.indexOf("customers") === -1);
  check("orders_only excludes loyalty",            bOrders.sections_present.indexOf("loyalty") === -1);
  check("orders_only bundle has no customers key", bOrders.data.customers === undefined);
  check("orders_only bundle has no loyalty key",   bOrders.data.loyalty === undefined);

  // identity_only: only customers + addresses contribute
  var q2 = _makeQuery();
  var ceIdentity = complianceExport.create({
    query:      q2,
    customers:  _mockReader("customers", "customers", { email: "y" }, 1),
    addresses:  _mockReader("addresses", "addresses", [{ postal: "9" }], 1),
    order:      _mockReader("order",     "orders",    [{ id: "o" }], 1),
    loyalty:    _mockReader("loyalty",   "loyalty",   { points: 0 }, 1),
  });
  var c2 = _uuid();
  var rIdent = await ceIdentity.requestExport({
    customer_id: c2, requested_by: "p", jurisdiction: "lgpd", scope: "identity_only",
  });
  var bIdent = await ceIdentity.fulfillRequest({ request_id: rIdent.id });
  check("identity_only sections=2",                bIdent.sections_present.length === 2);
  check("identity_only includes customers",        bIdent.sections_present.indexOf("customers") !== -1);
  check("identity_only includes addresses",        bIdent.sections_present.indexOf("addresses") !== -1);
  check("identity_only excludes order",            bIdent.sections_present.indexOf("order") === -1);

  // Section absent when reader not injected
  var q3 = _makeQuery();
  var cePartial = complianceExport.create({
    query: q3,
    customers: _mockReader("customers", "customers", { email: "z" }, 1),
    // intentionally NO order / addresses / etc.
  });
  var c3 = _uuid();
  var rPart = await cePartial.requestExport({
    customer_id: c3, requested_by: "p", jurisdiction: "gdpr", scope: "full",
  });
  var bPart = await cePartial.fulfillRequest({ request_id: rPart.id });
  check("partial wiring: 1 section present",       bPart.sections_present.length === 1);
  check("partial wiring: rest absent",             bPart.sections_absent.length === complianceExport.SCOPE_SECTIONS.full.length - 1);
  check("partial wiring: order absent",            bPart.sections_absent.indexOf("order") !== -1);
}

// ---- dispatchExport ----------------------------------------------------

async function _dispatchExport() {
  var q = _makeQuery();
  var ce = complianceExport.create({
    query: q,
    customers: _mockReader("customers", "customers", { email: "x" }, 1),
  });

  var customerId = _uuid();
  var req = await ce.requestExport({
    customer_id: customerId, requested_by: "p", jurisdiction: "gdpr", scope: "identity_only",
  });

  // Dispatch before fulfillment refused
  await assert.rejects(ce.dispatchExport({
    request_id:      req.id,
    delivery_method: "email",
    delivery_address: "customer@example.com",
  }), /fulfilled/);

  await ce.fulfillRequest({ request_id: req.id });
  var dispatched = await ce.dispatchExport({
    request_id:      req.id,
    delivery_method: "email",
    delivery_address: "customer@example.com",
  });
  check("dispatch flips status to delivered",   dispatched.status === "delivered");
  check("dispatch stamps delivered_at",         Number.isInteger(dispatched.delivered_at));
  check("dispatch persists delivery_method",    dispatched.delivery_method === "email");
  check("dispatch persists delivery_address",   dispatched.delivery_address === "customer@example.com");

  // Re-dispatch refuses (terminal)
  await assert.rejects(ce.dispatchExport({
    request_id:      req.id,
    delivery_method: "email",
    delivery_address: "customer@example.com",
  }), /fulfilled/);

  // Bad delivery method
  var req2 = await ce.requestExport({
    customer_id: customerId, requested_by: "p", jurisdiction: "gdpr", scope: "identity_only",
  });
  await ce.fulfillRequest({ request_id: req2.id });
  await assert.rejects(ce.dispatchExport({
    request_id: req2.id, delivery_method: "Has Space", delivery_address: "x@y.com",
  }), /delivery_method/);
  await assert.rejects(ce.dispatchExport({
    request_id: req2.id, delivery_method: "email", delivery_address: "",
  }), /delivery_address/);
}

// ---- requestDeletion + processDeletion(dry_run + wet) ------------------

async function _deletionFlow() {
  var q  = _makeQuery();
  var customersReader      = _mockReader("customers",      "customers",       { email: "x" }, 1);
  var orderReader          = _mockReader("order",          "orders",          [{ id: "o1" }, { id: "o2" }], 2);
  var orderNotesReader     = _mockReader("orderNotes",     "order_notes",     [{ id: "n1" }], 1);
  var loyaltyReader        = _mockReader("loyalty",        "loyalty",         { points: 0 }, 1);
  var addressesReader      = _mockReader("addresses",      "addresses",       [], 3);

  var ce = complianceExport.create({
    query:      q,
    customers:  customersReader,
    order:      orderReader,
    orderNotes: orderNotesReader,
    loyalty:    loyaltyReader,
    addresses:  addressesReader,
  });

  var customerId = _uuid();
  var del = await ce.requestDeletion({
    customer_id:  customerId,
    requested_by: "operator-csr",
    jurisdiction: "gdpr",
    reason:       "Customer invoked right to erasure under GDPR Art. 17",
  });
  check("requestDeletion kind=deletion",        del.request_kind === "deletion");
  check("requestDeletion scope null",           del.scope === null);
  check("requestDeletion jurisdiction gdpr",    del.jurisdiction === "gdpr");
  check("requestDeletion reason persisted",     del.reason && del.reason.indexOf("Art. 17") !== -1);

  // Dry run — counts surface without mutating
  var preview = await ce.processDeletion({ request_id: del.id, dry_run: true });
  check("dry-run dry_run flag true",            preview.dry_run === true);
  check("dry-run domains has 5 entries",        preview.domains.length === 5);
  check("dry-run total_affected = 1+2+1+1+3",   preview.total_affected === 8);
  check("dry-run report includes order table",  preview.domains.some(function (d) { return d.domain === "order" && d.deleted === 2; }));
  check("dry-run report includes loyalty",      preview.domains.some(function (d) { return d.domain === "loyalty"; }));

  // Store still intact after dry run
  check("dry-run store: order still 2 rows",    orderReader._peekStore().rows === 2);
  check("dry-run store: customers still 1 row", customersReader._peekStore().rows === 1);

  // Lifecycle row still at received after dry-run
  var afterDryRow = await ce.getRequest(del.id);
  check("dry-run leaves status=received",       afterDryRow.status === "received");

  // Domains absent surface — every domain in the deletion order that
  // wasn't injected (subscriptions / paymentMethods / supportTickets /
  // reviews / consentLedger / wishlist / surveys / recentlyViewed /
  // suggestionBox / saveForLater / storeCredit /
  // guestOrderReconciliations / stockAlerts / quotes / orderRatings /
  // productQa / customerNotes / giftcards / referrals /
  // customerImpersonation). 5 of the 25 deletion domains are wired here, so
  // 20 surface as absent.
  check("dry-run reports absent domains",       preview.domains_absent.length === 20);
  check("dry-run absent includes paymentMethods", preview.domains_absent.indexOf("paymentMethods") !== -1);
  check("dry-run absent includes wishlist",     preview.domains_absent.indexOf("wishlist") !== -1);
  check("dry-run absent includes saveForLater", preview.domains_absent.indexOf("saveForLater") !== -1);
  check("dry-run absent includes storeCredit",  preview.domains_absent.indexOf("storeCredit") !== -1);
  check("dry-run absent includes guestOrderReconciliations",
    preview.domains_absent.indexOf("guestOrderReconciliations") !== -1);
  check("dry-run absent includes stockAlerts",  preview.domains_absent.indexOf("stockAlerts") !== -1);
  check("dry-run absent includes giftcards",    preview.domains_absent.indexOf("giftcards") !== -1);
  check("dry-run absent includes referrals",    preview.domains_absent.indexOf("referrals") !== -1);

  // Wet run — counts + flips status
  var wet = await ce.processDeletion({ request_id: del.id });
  check("wet dry_run flag false",               wet.dry_run === false);
  check("wet total_affected = 8",               wet.total_affected === 8);
  check("wet store: order rows now 0",          orderReader._peekStore().rows === 0);
  check("wet store: customers now 0",           customersReader._peekStore().rows === 0);
  check("wet store: orderNotes now 0",          orderNotesReader._peekStore().rows === 0);

  var afterWetRow = await ce.getRequest(del.id);
  check("wet flips status to fulfilled",        afterWetRow.status === "fulfilled");
  check("wet stamps fulfilled_at",              Number.isInteger(afterWetRow.fulfilled_at));

  // Re-processing the fulfilled deletion refused
  await assert.rejects(ce.processDeletion({ request_id: del.id }), /fulfilled/);

  // Refusals
  await assert.rejects(ce.requestDeletion(), /input object required/);
  await assert.rejects(ce.requestDeletion({
    customer_id: customerId, requested_by: "p", jurisdiction: "gdpr", reason: "",
  }), /reason/);
  await assert.rejects(ce.processDeletion({ request_id: del.id, dry_run: "yes" }), /dry_run/);

  // Wrong-kind crossover refusals
  var exp = await ce.requestExport({
    customer_id: customerId, requested_by: "p", jurisdiction: "gdpr", scope: "full",
  });
  await assert.rejects(ce.processDeletion({ request_id: exp.id }),
                       /use fulfillRequest for export/);
  await assert.rejects(ce.fulfillRequest({ request_id: del.id }),
                       /use processDeletion for deletion/);
}

// A domain handler that throws must NOT abort the whole erasure: the
// access-cut (`customers` — passkeys/OAuth/email-hash/sessions) runs FIRST
// so the account can no longer sign in even when a later domain fails, the
// domains after the failing one still erase (not stranded), the run reports
// incomplete and stays `processing` (retryable, never falsely fulfilled),
// and a retry once the transient clears converges to fulfilled.
async function _deletionResilientAccessFirst() {
  var q  = _makeQuery();
  var customersReader  = _mockReader("customers",  "customers",   { email: "x" }, 1);
  var orderNotesReader = _mockReader("orderNotes", "order_notes", [{ id: "n1" }], 1);
  var loyaltyReader    = _mockReader("loyalty",    "loyalty",     { points: 0 }, 1);
  var addressesReader  = _mockReader("addresses",  "addresses",   [], 3);

  // `order` throws on its first wet-run, then behaves on retry.
  var orderStore  = { rows: 2 };
  var orderThrows = true;
  var orderReader = {
    name: "order", table: "orders",
    forCustomerExport: async function () { return [{ id: "o1" }]; },
    forCustomerDeletion: async function (_id, opts) {
      if (orderThrows && (!opts || opts.dry_run !== true)) {
        throw new Error("order erase failed (simulated transient)");
      }
      var n = orderStore.rows;
      if (!opts || opts.dry_run !== true) orderStore.rows = 0;
      return { table: "orders", deleted: n };
    },
    _peekStore: function () { return orderStore; },
  };

  var ce = complianceExport.create({
    query:      q,
    customers:  customersReader,
    orderNotes: orderNotesReader,
    order:      orderReader,
    loyalty:    loyaltyReader,
    addresses:  addressesReader,
  });

  var customerId = _uuid();
  var del = await ce.requestDeletion({
    customer_id:  customerId,
    requested_by: "operator-csr",
    jurisdiction: "gdpr",
    reason:       "Customer invoked right to erasure under GDPR Art. 17",
  });

  // Wet run while `order` throws — the erasure must not abort.
  var first = await ce.processDeletion({ request_id: del.id });
  check("resilient: run reports incomplete",              first.complete === false);
  check("resilient: order recorded as a failure",         first.failures.some(function (f) { return f.domain === "order"; }));
  // Access-cut ran FIRST — customers erased even though a later domain threw.
  check("access-first: customers erased despite later throw", customersReader._peekStore().rows === 0);
  // The domain BEFORE the failing one and the ones AFTER it all still erase.
  check("resilient: orderNotes still erased",             orderNotesReader._peekStore().rows === 0);
  check("resilient: loyalty (after order) still erased",  loyaltyReader._peekStore().rows === 0);
  check("resilient: addresses (after order) still erased", addressesReader._peekStore().rows === 0);
  check("resilient: failing domain keeps its rows",       orderReader._peekStore().rows === 2);
  // Incomplete run stays processing — retryable, never falsely fulfilled.
  var midRow = await ce.getRequest(del.id);
  check("resilient: incomplete run stays processing",     midRow.status === "processing");

  // Retry once the transient clears — converges to fulfilled.
  orderThrows = false;
  var second = await ce.processDeletion({ request_id: del.id });
  check("retry: second run complete",                     second.complete === true);
  check("retry: no failures on the clean pass",           second.failures.length === 0);
  check("retry: order finally erased",                    orderReader._peekStore().rows === 0);
  var finalRow = await ce.getRequest(del.id);
  check("retry: status converges to fulfilled",           finalRow.status === "fulfilled");
}

// ---- auditForCustomer --------------------------------------------------

async function _auditHistory() {
  var q  = _makeQuery();
  var ce = complianceExport.create({
    query:     q,
    customers: _mockReader("customers", "customers", { email: "x" }, 1),
  });

  var c1 = _uuid();
  var c2 = _uuid();

  var r1 = await ce.requestExport({
    customer_id: c1, requested_by: "p", jurisdiction: "gdpr", scope: "full",
  });
  // Wait so requested_at values land in distinct milliseconds — the
  // DESC sort breaks ties by id, which is monotonic via uuid.v7,
  // but the assertion below reads more cleanly with distinct stamps.
  await helpers.waitUntil(function () { return Date.now() > r1.requested_at; }, {
    label: "audit-history: clock advances past r1.requested_at",
  });
  var r2 = await ce.requestDeletion({
    customer_id: c1, requested_by: "p", jurisdiction: "ccpa", reason: "erasure request",
  });
  await helpers.waitUntil(function () { return Date.now() > r2.requested_at; }, {
    label: "audit-history: clock advances past r2.requested_at",
  });
  var r3 = await ce.requestExport({
    customer_id: c1, requested_by: "p", jurisdiction: "lgpd", scope: "identity_only",
  });

  // Unrelated customer's request — must NOT surface in c1's audit
  await ce.requestExport({
    customer_id: c2, requested_by: "p", jurisdiction: "gdpr", scope: "full",
  });

  var hist = await ce.auditForCustomer(c1);
  check("audit returns 3 rows for c1",          hist.length === 3);
  check("audit DESC: r3 first",                 hist[0].id === r3.id);
  check("audit DESC: r1 last",                  hist[2].id === r1.id);
  check("audit mixes kinds",                    hist.some(function (h) { return h.request_kind === "deletion"; })
                                              && hist.some(function (h) { return h.request_kind === "export"; }));
  check("audit mixes jurisdictions",            hist.some(function (h) { return h.jurisdiction === "gdpr"; })
                                              && hist.some(function (h) { return h.jurisdiction === "ccpa"; })
                                              && hist.some(function (h) { return h.jurisdiction === "lgpd"; }));

  // Other customer's audit is independent
  var hist2 = await ce.auditForCustomer(c2);
  check("audit isolates by customer_id",        hist2.length === 1);

  await assert.rejects(ce.auditForCustomer("not-a-uuid"), /customer_id/);
}

// ---- statutory response-window clock -----------------------------------
//
// Every hydrated request carries a derived `statutory_deadline` computed
// from jurisdiction + requested_at: GDPR one month (30d), CCPA 45d, LGPD
// 15d; `other` carries no statutory clock. The deadline is never persisted —
// it always reflects the current registry — so an export/erasure request
// surfaces the wall a supervisory authority measures the controller against.
var _DAY_MS = bShop.framework.constants.TIME.days(1);

async function _statutoryDeadline() {
  var q  = _makeQuery();
  var ce = complianceExport.create({ query: q });
  var cid = _uuid();

  var gdpr = await ce.requestExport({ customer_id: cid, requested_by: "p", jurisdiction: "gdpr", scope: "full" });
  check("gdpr deadline present",     gdpr.statutory_deadline && gdpr.statutory_deadline.days === 30);
  check("gdpr deadline = +30 days",  gdpr.statutory_deadline.due_by === gdpr.requested_at + 30 * _DAY_MS);
  check("gdpr deadline cites Art. 12(3)", gdpr.statutory_deadline.statute.indexOf("Art. 12(3)") !== -1);

  var ccpa = await ce.requestExport({ customer_id: cid, requested_by: "p", jurisdiction: "ccpa", scope: "full" });
  check("ccpa deadline = +45 days",  ccpa.statutory_deadline.days === 45 &&
    ccpa.statutory_deadline.due_by === ccpa.requested_at + 45 * _DAY_MS);

  var lgpd = await ce.requestDeletion({ customer_id: cid, requested_by: "p", jurisdiction: "lgpd", reason: "erasure" });
  check("lgpd deadline = +15 days",  lgpd.statutory_deadline.days === 15 &&
    lgpd.statutory_deadline.due_by === lgpd.requested_at + 15 * _DAY_MS);

  var other = await ce.requestExport({ customer_id: cid, requested_by: "p", jurisdiction: "other", scope: "full" });
  check("other jurisdiction has no statutory clock", other.statutory_deadline === null);

  // The deadline survives a round-trip through getRequest (it's derived in
  // _hydrate, so listRequests/getRequest/auditForCustomer all carry it).
  var fetched = await ce.getRequest(gdpr.id);
  check("getRequest carries the derived deadline",
    fetched.statutory_deadline && fetched.statutory_deadline.due_by === gdpr.statutory_deadline.due_by);

  // The exported registry + calculator are the single source of truth.
  var direct = complianceExport.statutoryDeadline("gdpr", 1_700_000_000_000);
  check("statutoryDeadline helper matches registry",
    direct.due_by === 1_700_000_000_000 + 30 * _DAY_MS);
  check("statutoryDeadline returns null for `other`",
    complianceExport.statutoryDeadline("other", 1_700_000_000_000) === null);
  check("DSR_RESPONSE_WINDOW registry exported",
    complianceExport.DSR_RESPONSE_WINDOW.gdpr.days === 30 &&
    complianceExport.DSR_RESPONSE_WINDOW.ccpa.days === 45 &&
    complianceExport.DSR_RESPONSE_WINDOW.lgpd.days === 15 &&
    complianceExport.DSR_RESPONSE_WINDOW.other === null);

  // The framework carries the same statutory clocks in b.dsr. This registry
  // deliberately does NOT read them: each entry pairs the deadline with the
  // statute it comes from, and that citation is operator-facing text the
  // framework does not supply — sourcing the number remotely while keeping the
  // citation here is how the two silently come to disagree. The jurisdiction
  // keys differ too (this table's `lgpd` is persisted in a CHECK constraint;
  // the framework says `lgpd-br`).
  //
  // What is worth catching is DIVERGENCE. If upstream revises a window, this
  // fails and someone decides whether the citation beside it still holds,
  // rather than the two drifting apart unnoticed.
  var b = require("../../lib/vendor/blamejs");
  var FRAMEWORK_KEY = { gdpr: "gdpr", ccpa: "ccpa", lgpd: "lgpd-br" };
  Object.keys(FRAMEWORK_KEY).forEach(function (ours) {
    var mine  = complianceExport.DSR_RESPONSE_WINDOW[ours].days;
    var their = b.dsr.POSTURE_DEADLINE_MS[FRAMEWORK_KEY[ours]] / _DAY_MS;
    check("statutory window for " + ours + " agrees with the framework (" + mine + "d)",
      mine === their);
  });
}

async function run() {
  await _requestExportShape();
  await _listRequestsFilter();
  await _fulfillFullScope();
  await _fulfillScopeFilters();
  await _dispatchExport();
  await _deletionFlow();
  await _deletionResilientAccessFirst();
  await _auditHistory();
  await _statutoryDeadline();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("OK - compliance-export (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - compliance-export: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
