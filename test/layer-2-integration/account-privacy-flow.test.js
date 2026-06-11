"use strict";
/**
 * Customer privacy & data surface — full HTTP integration of
 * /account/privacy + /account/delete + the ownership-scoped streaming
 * export download.
 *
 * Boots a real b.createApp storefront wired with catalog/cart/customers/
 * order/addresses/subscriptions/supportTickets/loyalty + the DSR primitive
 * (real reader adapters) over one in-memory node:sqlite DB. The signed-in
 * customer rides the sealed shop_auth cookie (helpers.authCookie). Covers:
 *   - anon → 303 /account/login,
 *   - buyer sees the export form + a link to /account/delete,
 *   - filing an export request (good enum → 303 ?ok=export; the row exists),
 *   - bad enum → 400 re-render, NO row created, never 500,
 *   - filing a deletion request → 303 ?ok=deletion, filed (NOT executed —
 *     the buyer's customer row is untouched),
 *   - IDOR: after an operator fulfils the buyer's export, the buyer can
 *     download it (200 JSON attachment, body parses, data.customers present);
 *     a STRANGER requesting the buyer's export → 404,
 *   - XSS: a deletion reason carrying <script> renders escaped in history,
 *   - streaming-completeness: the downloaded JSON parses + carries every
 *     scoped section key.
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

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0006_customers.sql", "0026_customer_addresses.sql", "0009_subscriptions.sql",
  "0047_support_tickets.sql", "0022_loyalty.sql", "0109_compliance_export.sql",
  // The customer-keyed personalization / feedback / consent domains the
  // full export now covers.
  "0011_reviews.sql", "0185_consent_ledger.sql", "0012_wishlist.sql",
  "0128_customer_surveys.sql", "0050_recently_viewed.sql",
  // The feedback / holdover / wallet domains added to the full export.
  "0181_suggestion_box.sql", "0041_save_for_later.sql", "0094_store_credit.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// The SAME reader shims + streaming helper server.js builds (mirrors
// _dsrReader / _streamDsrBundle so the wired path is exercised exactly).
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
      forCustomerExport: async function (id) { try { return await h.supportTickets.listByCustomerId(id, { limit: 100 }); } catch (_e) { return []; } },
      forCustomerDeletion: async function () { return { table: "support_tickets", deleted: 0, note: "retained" }; },
    },
    loyalty: {
      forCustomerExport: async function (id) {
        try { var balance = await h.loyalty.balance(id); var history = []; try { history = (await h.loyalty.history(id, { limit: 200 })).rows; } catch (_e) { history = []; } return { balance: balance, history: history }; }
        catch (_e) { return null; }
      },
      forCustomerDeletion: async function () { return { table: "loyalty", deleted: 0, note: "retained-ledger" }; },
    },
    reviews: {
      forCustomerExport: async function (id) { try { return (await h.reviews.byCustomer(h.reviews.hashCustomerId(id), { limit: 100 })).rows; } catch (_e) { return []; } },
      forCustomerDeletion: async function () { return { table: "reviews", deleted: 0, note: "retained-published-content" }; },
    },
    consentLedger: {
      forCustomerExport: async function (id) { try { return await h.consentLedger.historyForCustomer(id); } catch (_e) { return []; } },
      forCustomerDeletion: async function () { return { table: "consent_ledger", deleted: 0, note: "retained-consent-evidence" }; },
    },
    wishlist: {
      forCustomerExport: async function (id) { try { return (await h.wishlist.listForCustomer(id, { limit: 100 })).rows; } catch (_e) { return []; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try {
          if (dry) { var c = (await query("SELECT COUNT(*) AS n FROM wishlist_entries WHERE customer_id = ?1", [id])).rows[0]; return { table: "wishlist_entries", deleted: c ? Number(c.n) : 0 }; }
          var res = await query("DELETE FROM wishlist_entries WHERE customer_id = ?1", [id]);
          return { table: "wishlist_entries", deleted: Number((res && res.rowCount) || 0) };
        } catch (_e) { return { table: "wishlist_entries", deleted: 0 }; }
      },
    },
    surveys: {
      forCustomerExport: async function (id) { try { return await h.customerSurveys.invitationsForCustomer(id, { limit: 100 }); } catch (_e) { return []; } },
      forCustomerDeletion: async function () { return { table: "survey_invitations", deleted: 0, note: "retained" }; },
    },
    recentlyViewed: {
      forCustomerExport: async function (id) { try { return await h.recentlyViewed.forCustomer(id, { limit: 100 }); } catch (_e) { return []; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try {
          if (dry) { var c = (await query("SELECT COUNT(*) AS n FROM recently_viewed WHERE customer_id = ?1", [id])).rows[0]; return { table: "recently_viewed", deleted: c ? Number(c.n) : 0 }; }
          var out = await h.recentlyViewed.purgeCustomer(id);
          return { table: "recently_viewed", deleted: Number((out && out.removed) || 0) };
        } catch (_e) { return { table: "recently_viewed", deleted: 0 }; }
      },
    },
    suggestionBox: {
      forCustomerExport: async function (id) { try { return await h.suggestionBox.exportForCustomer({ customer_id: id }); } catch (_e) { return []; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try { return await h.suggestionBox.eraseForCustomer({ customer_id: id, dry_run: dry }); }
        catch (_e) { return { table: "suggestions", deleted: 0 }; }
      },
    },
    saveForLater: {
      forCustomerExport: async function (id) { try { return await h.saveForLater.exportForCustomer(id); } catch (_e) { return []; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try { return await h.saveForLater.eraseForCustomer(id, { dry_run: dry }); }
        catch (_e) { return { table: "save_for_later", deleted: 0 }; }
      },
    },
    storeCredit: {
      forCustomerExport: async function (id) { try { return await h.storeCredit.exportForCustomer(id); } catch (_e) { return null; } },
      forCustomerDeletion: async function (id, opts) {
        var dry = !!(opts && opts.dry_run);
        try { return await h.storeCredit.eraseForCustomer(id, { dry_run: dry }); }
        catch (_e) { return { table: "store_credit_ledger", deleted: 0, note: "retained-financial-ledger" }; }
      },
    },
  };
}

// Mirrors server.js _streamDsrBundle, including the completeness manifest:
// every scope section lands in `manifest` with status exported / empty /
// absent so an unexported table is never silently dropped from the bundle.
function _dsrSectionFilled(section) {
  if (section == null) return false;
  if (Array.isArray(section)) return section.length > 0;
  if (typeof section === "object") {
    var keys = Object.keys(section);
    for (var i = 0; i < keys.length; i += 1) { if (_dsrSectionFilled(section[keys[i]])) return true; }
    return false;
  }
  return true;
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
  var manifest = [];
  var first = true;
  for (var i = 0; i < sections.length; i += 1) {
    var name = sections[i]; var reader = readers[name];
    if (!reader || typeof reader.forCustomerExport !== "function") { manifest.push({ section: name, status: "absent" }); continue; }
    var section; try { section = await reader.forCustomerExport(row.customer_id); } catch (_e) { section = null; }
    emit((first ? "" : ",") + JSON.stringify(name) + ":" + JSON.stringify(section == null ? null : section));
    first = false;
    manifest.push({ section: name, status: _dsrSectionFilled(section) ? "exported" : "empty" });
  }
  emit("},\"manifest\":" + JSON.stringify(manifest) + "}");
  if (canWrite) res.end(); else (res.end ? res.end(buf) : res.send(buf));
}

async function _seedCustomer(query, id, displayName) {
  var ts = Date.now();
  // email_hash derived from the FULL id — a v7-UUID prefix slice collides
  // for two same-ms generations (UNIQUE constraint).
  await query("INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)",
    [id, "hash-" + id, displayName, ts]);
}

async function _run() {
  var mem   = helpers.memD1Query(MIGS);
  var query = mem.query;

  var catalog       = bShop.catalog.create({ query: query });
  var cart          = bShop.cart.create({ query: query, catalog: catalog });
  var customers     = bShop.customers.create({ query: query, cursorSecret: "priv-cust" });
  var order         = bShop.order.create({ query: query, cursorSecret: "priv-order" });
  var addresses     = bShop.addresses.create({ query: query });
  var subscriptions = bShop.subscriptions.create({ query: query, payment: null });
  var supportTickets = bShop.supportTickets.create({ query: query, cursorSecret: "priv-support" });
  var loyalty       = bShop.loyalty.create({ query: query });
  var reviews        = bShop.reviews.create({ cursorSecret: "priv-reviews" });
  var consentLedger  = bShop.consentLedger.create({});
  var wishlist       = bShop.wishlist.create({ cursorSecret: "priv-wishlist" });
  var customerSurveys = bShop.customerSurveys.create({});
  var recentlyViewed = bShop.recentlyViewed.create({ catalog: catalog });
  var suggestionBox  = bShop.suggestionBox.create({ query: query, cursorSecret: "priv-sugg" });
  var saveForLater   = bShop.saveForLater.create({ query: query, catalog: catalog, cursorSecret: "priv-sfl" });
  var storeCredit    = bShop.storeCredit.create({ query: query });

  var readers = _buildReaders({
    customers: customers, addresses: addresses, order: order,
    subscriptions: subscriptions, supportTickets: supportTickets, loyalty: loyalty,
    reviews: reviews, consentLedger: consentLedger, wishlist: wishlist,
    customerSurveys: customerSurveys, recentlyViewed: recentlyViewed,
    suggestionBox: suggestionBox, saveForLater: saveForLater, storeCredit: storeCredit,
  }, query);
  var dsr = bShop.complianceExport.create({
    query: query, customers: readers.customers, addresses: readers.addresses, order: readers.order,
    orderNotes: readers.orderNotes, subscriptions: readers.subscriptions, paymentMethods: readers.paymentMethods,
    supportTickets: readers.supportTickets, loyalty: readers.loyalty,
    reviews: readers.reviews, consentLedger: readers.consentLedger, wishlist: readers.wishlist,
    surveys: readers.surveys, recentlyViewed: readers.recentlyViewed,
    suggestionBox: readers.suggestionBox, saveForLater: readers.saveForLater, storeCredit: readers.storeCredit,
  });
  var SECTIONS = bShop.complianceExport.SCOPE_SECTIONS;

  var buyer    = b.uuid.v7();
  var stranger = b.uuid.v7();
  await _seedCustomer(query, buyer, "Bea Buyer");
  await _seedCustomer(query, stranger, "Stan Stranger");
  // Give the buyer one address so the export's identity section is non-empty.
  await addresses.add({
    customer_id: buyer, recipient_name: "Bea Buyer", street_line1: "1 Privacy Way",
    city: "Brussels", postal_code: "1000", country: "BE", is_default_shipping: true, is_default_billing: false,
  });
  // Feedback / holdover / wallet rows so those export sections are non-empty.
  await suggestionBox.submitSuggestion({ customer_id: buyer, title: "Add a dark theme", body: "My eyes thank you.", category: "feature_request" });
  await saveForLater.add({ customer_id: buyer, sku: "PRIV-SKU", quantity: 1, snapshot_price_minor: 1299 });
  await storeCredit.credit({ customer_id: buyer, amount_minor: 500, source: "goodwill" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-privacy-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, customers: customers, order: order, addresses: addresses,
        subscriptions: subscriptions, supportTickets: supportTickets, loyalty: loyalty,
        complianceExport: dsr, complianceExportReaders: readers, complianceExportSections: SECTIONS,
        streamDsrBundle: _streamDsrBundle, config: { shop_name: "blamejs.shop" },
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    jar.capture({ "set-cookie": [helpers.authCookie(b, buyer)] });

    // ---- anon → login ----
    var anon = await helpers.httpRequest({ port: port, path: "/account/privacy" });
    check("anon privacy → 303 login", anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    // ---- buyer sees the form + the delete link ----
    var page = await helpers.httpRequest({ port: port, path: "/account/privacy", jar: jar });
    check("privacy page → 200", page.status === 200);
    check("page shows the export form", page.body.indexOf("/account/privacy/export") !== -1);
    check("page has a jurisdiction select", page.body.indexOf("name=\"jurisdiction\"") !== -1);
    check("page has a scope select", page.body.indexOf("name=\"scope\"") !== -1);
    check("page links to /account/delete", page.body.indexOf("/account/delete") !== -1);

    // ---- file an export request (good enum) ----
    var exPost = await helpers.httpRequest({ port: port, path: "/account/privacy/export", method: "POST", jar: jar, form: { jurisdiction: "gdpr", scope: "full" } });
    check("export filed → 303 ?ok=export", exPost.status === 303 && (exPost.headers["location"] || "").indexOf("?ok=export") !== -1);
    var hist1 = await dsr.auditForCustomer(buyer);
    check("export row exists", hist1.length === 1 && hist1[0].request_kind === "export" && hist1[0].status === "received");
    check("export row requested_by is self-service", hist1[0].requested_by === "customer-self-service");
    var exportId = hist1[0].id;

    // ---- bad enum → 400, no new row ----
    var badEnum = await helpers.httpRequest({ port: port, path: "/account/privacy/export", method: "POST", jar: jar, form: { jurisdiction: "gdpr", scope: "bogus" } });
    check("bad scope → 400", badEnum.status === 400);
    check("bad scope re-render carries no 500", badEnum.body.indexOf("Privacy &amp; data") !== -1 || badEnum.body.indexOf("Privacy & data") !== -1);
    var hist2 = await dsr.auditForCustomer(buyer);
    check("bad enum created NO new row", hist2.length === 1);

    // ---- file a deletion request (XSS payload in reason) ----
    var XSS = "<script>alert(1)</script>";
    var delPost = await helpers.httpRequest({ port: port, path: "/account/delete", method: "POST", jar: jar, form: { jurisdiction: "gdpr", reason: "right to erasure " + XSS } });
    check("deletion filed → 303 ?ok=deletion", delPost.status === 303 && (delPost.headers["location"] || "").indexOf("?ok=deletion") !== -1);
    var hist3 = await dsr.auditForCustomer(buyer);
    var delRow = hist3.filter(function (r) { return r.request_kind === "deletion"; })[0];
    check("deletion row filed status=received", delRow && delRow.status === "received");

    // ---- deletion is FILED, NOT executed — the buyer row is untouched ----
    var custRow = await customers.get(buyer);
    check("buyer row NOT anonymized by self-service", custRow && custRow.display_name === "Bea Buyer");

    // ---- XSS: history re-render escapes the payload, never raw ----
    var afterDel = await helpers.httpRequest({ port: port, path: "/account/privacy", jar: jar });
    check("history shows the escaped payload", afterDel.body.indexOf("&lt;script&gt;") !== -1);
    check("history never shows the raw payload", afterDel.body.indexOf("<script>alert(1)</script>") === -1);

    // ---- IDOR + ownership: operator fulfils, buyer downloads ----
    await dsr.fulfillRequest({ request_id: exportId });
    var dl = await helpers.httpRequest({ port: port, path: "/account/privacy/" + exportId + "/export.json", jar: jar });
    check("buyer download → 200", dl.status === 200);
    check("download is JSON", (dl.headers["content-type"] || "").indexOf("application/json") === 0);
    check("download is an attachment", (dl.headers["content-disposition"] || "").indexOf("attachment") === 0);
    var parsed = JSON.parse(dl.body);   // streaming-completeness proxy: parses cleanly
    check("download body parses + carries customers", parsed && parsed.data && parsed.data.customers && parsed.data.customers.customer && parsed.data.customers.customer.id === buyer);
    // Every scoped section key present (full scope) — a truncated/buffered-wrong
    // stream would drop a key or fail JSON.parse above. All readers are wired,
    // so every section streams into `data` (empty ones as []).
    SECTIONS.full.forEach(function (name) {
      check("download carries section " + name, Object.prototype.hasOwnProperty.call(parsed.data, name));
    });
    check("download addresses section non-empty", Array.isArray(parsed.data.addresses) && parsed.data.addresses.length === 1);
    // The completeness manifest covers every scope section so an absent
    // table is visible, never silently dropped.
    check("download carries a manifest", Array.isArray(parsed.manifest) && parsed.manifest.length === SECTIONS.full.length);
    var manifestSections = parsed.manifest.map(function (m) { return m.section; });
    SECTIONS.full.forEach(function (name) {
      check("manifest covers section " + name, manifestSections.indexOf(name) !== -1);
    });

    // ---- stranger cannot download the buyer's bundle ----
    var sjar = helpers.cookieJar();
    sjar.capture({ "set-cookie": [helpers.authCookie(b, stranger)] });
    var idor = await helpers.httpRequest({ port: port, path: "/account/privacy/" + exportId + "/export.json", jar: sjar });
    check("stranger download → 404 (IDOR)", idor.status === 404);
    check("stranger never sees the buyer bundle", idor.body.indexOf("\"customers\"") === -1 || idor.body.indexOf(buyer) === -1);

    // ---- malformed id → 404, not 500 ----
    var malformed = await helpers.httpRequest({ port: port, path: "/account/privacy/not-a-uuid/export.json", jar: jar });
    check("malformed export id → 404", malformed.status === 404);

    // ---- an un-fulfilled export (received) is not downloadable ----
    var pendingPost = await helpers.httpRequest({ port: port, path: "/account/privacy/export", method: "POST", jar: jar, form: { jurisdiction: "ccpa", scope: "orders_only" } });
    check("second export filed → 303", pendingPost.status === 303);
    var histP = await dsr.auditForCustomer(buyer);
    var pendingExport = histP.filter(function (r) { return r.request_kind === "export" && r.status === "received"; })[0];
    var notReady = await helpers.httpRequest({ port: port, path: "/account/privacy/" + pendingExport.id + "/export.json", jar: jar });
    check("un-fulfilled export download → 404", notReady.status === 404);

    console.log("account-privacy-flow: " + helpers.getChecks() + " checks passed");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
