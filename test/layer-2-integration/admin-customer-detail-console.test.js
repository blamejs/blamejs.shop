"use strict";
/**
 * Customer detail console — the per-customer operator screen at
 * /admin/customers/:id, the action surface the roster (read-only list) never
 * had. Boots one b.createApp with admin.mount (token + catalog + order +
 * config + customers + storeCredit + customerNotes + customerSegments) over an
 * in-memory node:sqlite DB loaded from the live migrations.
 *
 * Exercises the consolidated per-customer surfaces from the console:
 *   - GET /admin/customers/:id renders the customer's identity + their recent
 *     orders (linked to the order page), HTML + bearer JSON, and the auth gate
 *   - STORE CREDIT: grant with a reason -> the balance changes and a ledger row
 *     records the reason; deduct with a reason; the bad paths (missing reason /
 *     non-integer amount / over-deduction) are clean 4xx/409 with NO change and
 *     no raw-error leak; the over-deduction is a 409 (route refuses before any
 *     write)
 *   - CUSTOMER NOTES: add a note -> it appears in the list; a blank body is a
 *     clean 4xx with nothing written. The full note lifecycle from the console:
 *     EDIT (the new text persists), PIN (flagged pinned + sorts first), ARCHIVE
 *     (drops from the default list, restored by UNARCHIVE). Ownership is scoped
 *     to the path :id customer — a note belonging to a DIFFERENT customer can't
 *     be edited / pinned / archived via this customer's id (a clean 404 with no
 *     mutation); a bad/empty edit and an unknown note id are clean 4xx
 *   - SEGMENTS: read-only membership reflects a recompute (the primitive has no
 *     per-customer manual assign — membership is rule-derived)
 *   - ACTIVITY: the read-only chronological timeline aggregates the wired
 *     source primitives (order transitions, wishlist saves, loyalty ledger,
 *     reviews) newest-first; an event carrying a free-text payload (a review
 *     title) is ESCAPED at render; a customer with no source events shows the
 *     empty state; the panel is a bounded newest-N read
 *   - an unknown / malformed customer id -> a clean 404
 *
 * Network: zero — every request lands on 127.0.0.1.
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

var TOKEN = "admin-token-0123456789abcdef-custdetail";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0950_orders_payment_provider.sql", "0951_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql",
  "0094_store_credit.sql", "0134_customer_notes.sql", "0049_customer_segments.sql",
  "0022_loyalty.sql",
  // Activity-timeline source tables + its memoization cache.
  "0011_reviews.sql", "0012_wishlist.sql", "0047_support_tickets.sql",
  "0153_customer_activity_cache.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}
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

function _post(port, path, jar, form, extraHeaders) {
  return helpers.httpRequest({
    port: port, path: path, method: "POST", jar: jar, form: form,
    headers: extraHeaders || undefined,
  });
}

// A minimal valid order for a customer — createFromCart needs a cart_id +
// session_id (UUID-shaped), one line, totals, and a ship_to with a country.
// The orders FK references carts(id), so seed the cart row first.
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
    lines:             [{ variant_id: b.uuid.v7(), sku: "SKU-1", qty: 1, unit_amount_minor: 1000 }],
    currency:          "USD",
    subtotal_minor:    1000,
    discount_minor:    0,
    tax_minor:         0,
    shipping_minor:    0,
    grand_total_minor: 1000,
    ship_to:           { country: "US" },
  });
}

async function _run() {
  var query            = _makeQuery();
  var catalog          = bShop.catalog.create({ query: query });
  var order            = bShop.order.create({ query: query, cursorSecret: "cust-detail-order" });
  var config           = bShop.config.create({ query: query });
  var customers        = bShop.customers.create({ query: query, cursorSecret: "cust-detail-customers" });
  var storeCredit      = bShop.storeCredit.create({ query: query });
  var customerNotes    = bShop.customerNotes.create({ query: query, cursorSecret: "cust-detail-notes" });
  var customerSegments = bShop.customerSegments.create({ query: query, cursorSecret: "cust-detail-segments" });
  var loyalty          = bShop.loyalty.create({ query: query });
  var wishlist         = bShop.wishlist.create({ query: query, cursorSecret: "cust-detail-wishlist" });
  var reviews          = bShop.reviews.create({ query: query, cursorSecret: "cust-detail-reviews" });
  // Customer activity — the read-only aggregator. Composes the source
  // primitives above; each peer marker flips its collector on. It records no
  // events of its own — the order FSM (order_transitions), wishlist, loyalty
  // ledger, and reviews already populate its source tables.
  var customerActivity = bShop.customerActivity.create({
    query: query, cursorSecret: "cust-detail-activity",
    order: order, wishlist: wishlist, loyalty: loyalty, reviews: reviews,
  });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Anderson" });
  // Two orders so the detail screen's recent-orders panel renders linked rows.
  // The order FSM stamps an order_transitions "create" row per order, which the
  // activity aggregator surfaces as an "Order placed" event — so the timeline
  // is fed by the existing write path with no extra recording call.
  var ord1 = await _seedOrder(query, order, alice.id);
  await _seedOrder(query, order, alice.id);
  await loyalty.ensureAccount(alice.id);

  // Seed a spread of activity across the wired sources so the timeline renders
  // multiple kinds newest-first. A loyalty earn, a wishlist save, and a review
  // whose title carries an HTML/script payload (to prove the panel escapes
  // free-text event bodies at render). The reviews table FKs product_id to
  // products(id), so seed a real product first and reuse it for both.
  var activityProduct = await catalog.products.create({
    slug: "activity-widget", title: "Activity Widget", description: "x", status: "active",
  });
  await loyalty.earn({ customer_id: alice.id, points: 120, source: "purchase" });
  await wishlist.add({ customer_id: alice.id, product_id: activityProduct.id });
  var REVIEW_XSS_TITLE = "<script>alert('activity-xss')</script>";
  await reviews.submit({
    customer_id: alice.id, product_id: activityProduct.id, rating: 5,
    title: REVIEW_XSS_TITLE, body: "Loved it, would buy again — genuinely great.",
  });
  // A SECOND customer (defined below as Bob) with NO source events proves the
  // empty-state path of the activity panel.

  // A SECOND customer with their own note — proves the per-note write routes
  // are scoped to the path :id customer (Bob's note can't be mutated through
  // Alice's id — the cross-customer IDOR guard).
  var bob = await customers.register({ email: "bob@example.com", display_name: "Bob Baxter" });
  var bobNote = await customerNotes.addNote({
    customer_id: bob.id, author: "operator", body: "Bob's private note — do not touch", kind: "warning",
  });

  // A segment Alice qualifies for after a recompute — proves read-only
  // membership reflects the rule-derived cache (the primitive has no manual
  // per-customer assign).
  await customerSegments.defineSegment({
    slug: "any-buyer", title: "Any buyer", rules: { lifetime_orders_min: 1 },
  });
  await customerSegments.recompute({ slugs: ["any-buyer"] });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-cust-detail-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        customers: customers, storeCredit: storeCredit, customerNotes: customerNotes,
        customerSegments: customerSegments, loyalty: loyalty,
        customerActivity: customerActivity,
      });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var base = "/admin/customers/" + encodeURIComponent(alice.id);

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- detail: record + recent orders --------------------------------
    var roster = await helpers.httpRequest({ port: port, path: "/admin/customers", jar: jar });
    check("roster links to the detail",         roster.body.indexOf(base) !== -1);

    var detail = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail then 200",                    detail.status === 200);
    check("detail shows the customer name",     detail.body.indexOf("Alice Anderson") !== -1);
    check("detail shows the customer id",       detail.body.indexOf(alice.id) !== -1);
    check("detail links a recent order",        detail.body.indexOf("/admin/orders/" + encodeURIComponent(ord1.id)) !== -1);
    check("detail shows the store-credit panel", detail.body.indexOf("Store credit") !== -1 && detail.body.indexOf("/store-credit\"") !== -1);
    check("detail shows the notes panel",       detail.body.indexOf(">Notes<") !== -1 && detail.body.indexOf("/notes\"") !== -1);
    check("detail shows segment membership",    detail.body.indexOf("Any buyer") !== -1);
    check("detail shows the loyalty panel",     detail.body.indexOf(">Loyalty<") !== -1);

    // ---- activity timeline: aggregated, newest-first, escaped -----------
    check("detail shows the activity panel",    detail.body.indexOf(">Activity<") !== -1);
    // Each wired source surfaced its event kind into the feed.
    check("activity shows the order event",     detail.body.indexOf("order.create") !== -1 && detail.body.indexOf("Order placed") !== -1);
    check("activity shows the loyalty event",   detail.body.indexOf("loyalty.earn") !== -1);
    check("activity shows the wishlist event",  detail.body.indexOf("wishlist.added") !== -1);
    check("activity shows the review event",    detail.body.indexOf("review.pending") !== -1);
    // The review title carried an XSS payload — the panel must escape it: no
    // live <script> in the rendered body, the angle brackets entity-encoded.
    check("activity escapes a free-text payload", detail.body.indexOf("<script>alert('activity-xss')") === -1 &&
                                                  detail.body.indexOf("&lt;script&gt;alert(") !== -1);
    // Newest-first: the most recent seeded event (the review) renders before
    // the oldest (the order placement). Compare first-occurrence positions of
    // their kind tokens in the rendered HTML.
    var posReview = detail.body.indexOf("review.pending");
    var posOrder  = detail.body.indexOf("order.create");
    check("activity renders newest-first",      posReview !== -1 && posOrder !== -1 && posReview < posOrder);

    var detailApi = await helpers.httpRequest({ port: port, path: base, headers: bearer });
    check("detail API JSON",                    (detailApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var detailJson = JSON.parse(detailApi.body);
    check("detail API carries the customer",    detailJson.customer.id === alice.id);
    check("detail API carries recent orders",   Array.isArray(detailJson.recent_orders) && detailJson.recent_orders.length === 2);
    check("detail API omits raw email",         detailJson.customer.email == null && typeof detailJson.customer.email_hash === "string");
    // The activity feed is present in the bearer JSON, newest-first, bounded.
    check("detail API carries activity",        Array.isArray(detailJson.activity) && detailJson.activity.length >= 4);
    check("detail API activity newest-first",   detailJson.activity[0].occurred_at >= detailJson.activity[detailJson.activity.length - 1].occurred_at);
    check("detail API activity bounded",        detailJson.activity.length <= 50);
    check("detail API activity carries kinds",  detailJson.activity.some(function (e) { return e.kind === "loyalty.earn"; }) &&
                                                detailJson.activity.some(function (e) { return e.kind === "wishlist.added"; }));

    // ---- store credit: grant with a reason -----------------------------
    var balBefore = await storeCredit.balance(alice.id);
    check("credit starts at zero",              balBefore.balance_minor === 0);
    var grant = await _post(port, base + "/store-credit", jar, {
      direction: "grant", amount_minor: "2500", reason: "goodwill for the late delivery",
    });
    check("grant then 303",                     grant.status === 303);
    check("grant redirects saved",              (grant.headers.location || "").indexOf("saved=1") !== -1);
    var balAfterGrant = await storeCredit.balance(alice.id);
    check("grant credited 2500 minor",          balAfterGrant.balance_minor === 2500);

    // The grant is recorded in the ledger WITH the reason in source_ref.
    var hist = await storeCredit.history({ customer_id: alice.id, limit: 10 });
    var creditRow = hist.rows.filter(function (h) { return h.kind === "credit"; })[0];
    check("ledger recorded the credit",         !!creditRow && creditRow.amount_minor === 2500);
    check("ledger row carries the reason",      creditRow.source_ref === "goodwill for the late delivery");
    check("ledger row source is goodwill",      creditRow.source === "goodwill");
    var detailAfterGrant = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail shows the new balance",       detailAfterGrant.body.indexOf("$25.00") !== -1);
    check("detail shows the reason in ledger",  detailAfterGrant.body.indexOf("goodwill for the late delivery") !== -1);

    // ---- store credit: deduct with a reason ----------------------------
    var deduct = await _post(port, base + "/store-credit", jar, {
      direction: "deduct", amount_minor: "1000", reason: "correcting an over-credit",
    });
    check("deduct then 303",                    deduct.status === 303);
    var balAfterDeduct = await storeCredit.balance(alice.id);
    check("deduct removed 1000 minor",          balAfterDeduct.balance_minor === 1500);
    var histAfterDeduct = await storeCredit.history({ customer_id: alice.id, limit: 10 });
    var expireRow = histAfterDeduct.rows.filter(function (h) { return h.kind === "expire"; })[0];
    check("deduct recorded an expire row",      !!expireRow && expireRow.amount_minor === 1000);
    check("deduct row carries the reason",      expireRow.source_ref === "correcting an over-credit");

    // ---- bad store-credit writes: clean 4xx, no change -----------------
    // (1) missing reason.
    var noReason = await _post(port, base + "/store-credit", jar, {
      direction: "grant", amount_minor: "500",
    });
    check("missing reason then 303 redirect",   noReason.status === 303);
    check("missing reason surfaces err",        (noReason.headers.location || "").indexOf("credit_err=") !== -1);
    check("missing reason: no balance change",  (await storeCredit.balance(alice.id)).balance_minor === 1500);

    // (2) non-integer amount.
    var badAmount = await _post(port, base + "/store-credit", jar, {
      direction: "grant", amount_minor: "12.5", reason: "x",
    });
    check("non-integer amount redirect err",    badAmount.status === 303 && (badAmount.headers.location || "").indexOf("credit_err=") !== -1);
    check("non-integer amount: no change",      (await storeCredit.balance(alice.id)).balance_minor === 1500);

    // (3) over-deduction (balance 1500, deduct 9999) -> 409 on the JSON path,
    // clean redirect-with-error on the browser path, NO change either way.
    var overApi = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ direction: "deduct", amount_minor: 9999, reason: "too much" }),
    });
    check("over-deduction API then 409",        overApi.status === 409);
    check("over-deduction API no change",       (await storeCredit.balance(alice.id)).balance_minor === 1500);
    var overHtml = await _post(port, base + "/store-credit", jar, {
      direction: "deduct", amount_minor: "9999", reason: "too much",
    });
    check("over-deduction HTML redirect err",   overHtml.status === 303 && (overHtml.headers.location || "").indexOf("credit_err=") !== -1);
    check("over-deduction HTML no change",       (await storeCredit.balance(alice.id)).balance_minor === 1500);

    // No bad path leaked a raw primitive/SQL string into the redirect target.
    [noReason, badAmount, overHtml].forEach(function (resp, idx) {
      var loc = resp.headers.location || "";
      check("bad credit #" + idx + " leaks no SQL", loc.indexOf("SQLITE") === -1 && loc.indexOf("constraint") === -1);
      check("bad credit #" + idx + " leaks no internal prefix", loc.indexOf("storeCredit") === -1 && loc.indexOf("admin.") === -1);
    });

    // ---- bearer JSON: a grant on the API path --------------------------
    var apiGrant = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ direction: "grant", amount_minor: 700, reason: "api goodwill" }),
    });
    check("bearer grant 200 JSON",              apiGrant.status === 200);
    check("bearer grant applied",               (await storeCredit.balance(alice.id)).balance_minor === 2200);
    var apiNoReason = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ direction: "grant", amount_minor: 700 }),
    });
    check("bearer grant missing reason then 400", apiNoReason.status === 400);
    check("bearer missing reason: no change",   (await storeCredit.balance(alice.id)).balance_minor === 2200);

    // ---- customer notes: add a note ------------------------------------
    var addNote = await _post(port, base + "/notes", jar, {
      kind: "preference", body: "VIP — comp shipping where possible",
    });
    check("add note then 303",                  addNote.status === 303);
    var notesAfter = await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 });
    check("note persisted",                     notesAfter.rows.length === 1 && notesAfter.rows[0].body === "VIP — comp shipping where possible");
    check("note author is operator",            notesAfter.rows[0].author === "operator");
    var detailAfterNote = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail lists the new note",          detailAfterNote.body.indexOf("VIP — comp shipping where possible") !== -1);

    // A blank-body note is a clean 4xx with nothing written.
    var blankNote = await _post(port, base + "/notes", jar, { kind: "general", body: "" });
    check("blank note redirect err",            blankNote.status === 303 && (blankNote.headers.location || "").indexOf("note_err=") !== -1);
    check("blank note: still one note",         (await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 })).rows.length === 1);

    // The note id we operate the lifecycle on (Alice's one note).
    var aliceNoteId = notesAfter.rows[0].id;
    var noteBase = base + "/notes/" + encodeURIComponent(aliceNoteId);
    // The detail screen renders the per-note controls (edit / pin / archive).
    var detailWithControls = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail renders edit control",        detailWithControls.body.indexOf(encodeURIComponent(aliceNoteId) + "/edit") !== -1);
    check("detail renders pin control",         detailWithControls.body.indexOf(encodeURIComponent(aliceNoteId) + "/pin") !== -1);
    check("detail renders archive control",     detailWithControls.body.indexOf(encodeURIComponent(aliceNoteId) + "/archive") !== -1);

    // ---- EDIT: the new text persists -----------------------------------
    var editNote = await _post(port, noteBase + "/edit", jar, {
      kind: "escalation", body: "VIP — comp shipping AND gift wrap",
    });
    check("edit note then 303",                 editNote.status === 303);
    check("edit redirects saved",               (editNote.headers.location || "").indexOf("saved=1") !== -1);
    var afterEdit = await customerNotes.getNote(aliceNoteId);
    check("edit persisted the new body",        afterEdit.body === "VIP — comp shipping AND gift wrap");
    check("edit persisted the new kind",        afterEdit.kind === "escalation");
    var detailAfterEdit = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail reflects the edited body",    detailAfterEdit.body.indexOf("VIP — comp shipping AND gift wrap") !== -1);

    // A blank edit is a clean 4xx with NO partial write (the body is unchanged).
    var blankEdit = await _post(port, noteBase + "/edit", jar, { kind: "general", body: "   " });
    check("blank edit redirect err",            blankEdit.status === 303 && (blankEdit.headers.location || "").indexOf("note_err=") !== -1);
    check("blank edit: no leak in redirect",    (blankEdit.headers.location || "").indexOf("customerNotes") === -1 && (blankEdit.headers.location || "").indexOf("SQLITE") === -1);
    check("blank edit: body unchanged",         (await customerNotes.getNote(aliceNoteId)).body === "VIP — comp shipping AND gift wrap");
    // The bearer JSON path: a blank edit is a clean 400.
    var blankEditApi = await helpers.httpRequest({
      port: port, path: noteBase + "/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });
    check("bearer blank edit then 400",         blankEditApi.status === 400);

    // ---- PIN: flagged pinned, sorts first ------------------------------
    // Add a SECOND note so pin-ordering is observable (the pinned one floats up).
    await customerNotes.addNote({ customer_id: alice.id, author: "operator", body: "later free-form note", kind: "general" });
    var pinNote = await _post(port, noteBase + "/pin", jar, {});
    check("pin note then 303",                  pinNote.status === 303);
    var afterPin = await customerNotes.getNote(aliceNoteId);
    check("pin flagged the note pinned",        Number(afterPin.pinned) === 1);
    var listPinned = await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 });
    check("pinned note sorts first",            listPinned.rows[0].id === aliceNoteId);
    var detailAfterPin = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("detail shows the Pinned pill",       detailAfterPin.body.indexOf("Pinned") !== -1);
    check("detail offers Unpin once pinned",    detailAfterPin.body.indexOf(encodeURIComponent(aliceNoteId) + "/unpin") !== -1);
    // Unpin restores the flag.
    var unpinNote = await _post(port, noteBase + "/unpin", jar, {});
    check("unpin note then 303",                unpinNote.status === 303);
    check("unpin cleared the flag",             Number((await customerNotes.getNote(aliceNoteId)).pinned) === 0);

    // ---- ARCHIVE: drops from the default list, UNARCHIVE restores ------
    var archiveNote = await _post(port, noteBase + "/archive", jar, {});
    check("archive note then 303",              archiveNote.status === 303);
    check("archived note has a tombstone",      (await customerNotes.getNote(aliceNoteId)).archived_at != null);
    var activeList = await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 });
    check("archived drops from default list",   activeList.rows.every(function (n) { return n.id !== aliceNoteId; }));
    var archivedList = await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10, include_archived: true });
    check("archived note in include_archived",  archivedList.rows.some(function (n) { return n.id === aliceNoteId; }));
    // The detail screen hides the archived note by default; ?notes_archived=1 reveals it.
    var detailDefault = await helpers.httpRequest({ port: port, path: base, jar: jar });
    check("default detail hides archived note", detailDefault.body.indexOf("VIP — comp shipping AND gift wrap") === -1);
    check("default detail offers Show archived", detailDefault.body.indexOf("notes_archived=1") !== -1);
    var detailArchived = await helpers.httpRequest({ port: port, path: base + "?notes_archived=1", jar: jar });
    check("archived view reveals the note",     detailArchived.body.indexOf("VIP — comp shipping AND gift wrap") !== -1);
    check("archived view shows Archived pill",  detailArchived.body.indexOf("Archived") !== -1);
    check("archived view offers Unarchive",     detailArchived.body.indexOf(encodeURIComponent(aliceNoteId) + "/unarchive") !== -1);
    // Unarchive brings it back to the active list.
    var unarchiveNote = await _post(port, noteBase + "/unarchive", jar, {});
    check("unarchive note then 303",            unarchiveNote.status === 303);
    check("unarchive cleared the tombstone",    (await customerNotes.getNote(aliceNoteId)).archived_at == null);
    check("unarchived back in default list",    (await customerNotes.notesForCustomer({ customer_id: alice.id, limit: 10 })).rows.some(function (n) { return n.id === aliceNoteId; }));

    // ---- bearer JSON contract on a lifecycle write ---------------------
    var pinApi = await helpers.httpRequest({
      port: port, path: noteBase + "/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("bearer pin then 200 JSON",           pinApi.status === 200 && (pinApi.headers["content-type"] || "").indexOf("application/json") === 0);
    var pinJson = JSON.parse(pinApi.body);
    check("bearer pin returns the note",        pinJson.id === aliceNoteId && Number(pinJson.pinned) === 1);
    await _post(port, noteBase + "/unpin", jar, {});

    // ---- IDOR: Bob's note can't be mutated through Alice's id ----------
    // The note id is Bob's; the path customer is Alice. Every lifecycle write
    // must 404 (note not on this customer) and leave Bob's note untouched.
    var bobNoteViaAlice = base + "/notes/" + encodeURIComponent(bobNote.id);
    var idorEdit = await helpers.httpRequest({
      port: port, path: bobNoteViaAlice + "/edit", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ body: "hijacked by Alice's operator" }),
    });
    check("IDOR edit (bearer) then 404",        idorEdit.status === 404);
    var idorPin = await helpers.httpRequest({
      port: port, path: bobNoteViaAlice + "/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("IDOR pin (bearer) then 404",         idorPin.status === 404);
    var idorArchive = await helpers.httpRequest({
      port: port, path: bobNoteViaAlice + "/archive", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("IDOR archive (bearer) then 404",     idorArchive.status === 404);
    // The browser path refuses identically (303 to a note_err redirect, no mutation).
    var idorEditHtml = await _post(port, bobNoteViaAlice + "/edit", jar, { body: "hijacked" });
    check("IDOR edit (HTML) redirect err",      idorEditHtml.status === 303 && (idorEditHtml.headers.location || "").indexOf("note_err=") !== -1);
    // Bob's note is byte-for-byte intact after every cross-customer attempt.
    var bobAfter = await customerNotes.getNote(bobNote.id);
    check("Bob's note body untouched",          bobAfter.body === "Bob's private note — do not touch");
    check("Bob's note kind untouched",          bobAfter.kind === "warning");
    check("Bob's note not pinned",              Number(bobAfter.pinned) === 0);
    check("Bob's note not archived",            bobAfter.archived_at == null);

    // ---- unknown / malformed note id under a valid customer -> clean 4xx
    var unknownNote = await helpers.httpRequest({
      port: port, path: base + "/notes/" + b.uuid.v7() + "/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("unknown note id then 404",           unknownNote.status === 404);
    var malformedNote = await helpers.httpRequest({
      port: port, path: base + "/notes/not-a-uuid/pin", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("malformed note id then 400 (not 500)", malformedNote.status === 400);

    // ---- unknown / malformed customer id -> clean 404 ------------------
    var unknownId = b.uuid.v7();
    var unknown = await helpers.httpRequest({ port: port, path: "/admin/customers/" + unknownId, jar: jar });
    check("unknown id then 404",                unknown.status === 404);
    check("unknown id shows not-found",         unknown.body.indexOf("Customer not found") !== -1);
    var unknownApi = await helpers.httpRequest({ port: port, path: "/admin/customers/" + unknownId, headers: bearer });
    check("unknown id API then 404",            unknownApi.status === 404);
    var malformed = await helpers.httpRequest({ port: port, path: "/admin/customers/not-a-uuid", jar: jar });
    check("malformed id then 404 (not 500)",    malformed.status === 404);
    var malformedGrant = await _post(port, "/admin/customers/not-a-uuid/store-credit", jar, {
      direction: "grant", amount_minor: "500", reason: "x",
    });
    check("malformed id write then 404 (not 500)", malformedGrant.status === 404);

    // ---- activity empty state ------------------------------------------
    // Bob has a CRM note but no source events (no order / loyalty / wishlist /
    // review), so his activity feed is empty — the panel shows the empty state.
    var bobBase = "/admin/customers/" + encodeURIComponent(bob.id);
    var bobDetail = await helpers.httpRequest({ port: port, path: bobBase, jar: jar });
    check("bob detail then 200",                bobDetail.status === 200);
    check("bob activity panel present",         bobDetail.body.indexOf(">Activity<") !== -1);
    check("bob activity shows empty state",     bobDetail.body.indexOf("No recorded activity yet") !== -1);
    var bobApi = await helpers.httpRequest({ port: port, path: bobBase, headers: bearer });
    check("bob activity API is empty",          Array.isArray(JSON.parse(bobApi.body).activity) && JSON.parse(bobApi.body).activity.length === 0);

    // ---- activity link guard: protocol-relative URLs are NOT linked -----
    // The activity panel renders an event's `link` as an href ONLY when it's a
    // same-origin path: a leading "/" that is NOT "//". A protocol-relative
    // "//evil.example/x" also starts with "/" but resolves to an off-site
    // origin, and the HTML escaper leaves "/" untouched — so without the
    // second-char guard it would survive into a working cross-origin href.
    // Render the panel directly with a malicious link and assert it never
    // becomes an href (it falls back to plain, un-linked text).
    var guardHtml = bShop.admin.renderAdminCustomerDetail({
      customer:     { id: alice.id, display_name: "Alice Anderson", created_at: Date.now() },
      currency:     "USD",
      can_activity: true,
      activity: [
        { kind: "order.create", occurred_at: Date.now(), title: "Off-site link", body: null, actor: "system", link: "//evil.example/x" },
        { kind: "order.create", occurred_at: Date.now() - 1, title: "Same-origin link", body: null, actor: "system", link: "/operator/orders/abc" },
      ],
    });
    check("link guard: no protocol-relative href", guardHtml.indexOf("href=\"//evil.example") === -1);
    check("link guard: off-site link not anchored", guardHtml.indexOf("//evil.example/x</a>") === -1);
    check("link guard: off-site title renders as plain text", guardHtml.indexOf("Off-site link") !== -1);
    check("link guard: same-origin link still anchored", guardHtml.indexOf("href=\"/operator/orders/abc\"") !== -1);

    // ---- auth gate -----------------------------------------------------
    var anon = await helpers.httpRequest({ port: port, path: base });
    check("anon detail → login form",           anon.body.indexOf("Admin API key") !== -1);
    check("anon detail does not leak the name", anon.body.indexOf("Alice Anderson") === -1);
    var anonGrant = await helpers.httpRequest({
      port: port, path: base + "/store-credit", method: "POST",
      form: { direction: "grant", amount_minor: "500", reason: "x" },
    });
    check("anon grant does not 5xx",            anonGrant.status < 500);
    check("anon grant did not apply",           (await storeCredit.balance(alice.id)).balance_minor === 2200);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
