"use strict";
/**
 * Consent-gated browse→buy event recording — full HTTP integration.
 *
 * The /admin/analytics screen renders a funnel + top-search-terms +
 * most-viewed tables over the `analytics_events` stream. This pins the
 * storefront's recording side of that stream:
 *
 *   - With the visitor's `analytics` consent category opted IN, the
 *     storefront records one event at each browse→buy point — PDP view,
 *     search, add-to-cart, checkout start, checkout complete — and the
 *     dashboard's own queries (`funnel`, `topSearchTerms`,
 *     `topViewedProducts`) read those rows back end-to-end.
 *   - With NO consent decision (default-deny), the SAME requests record
 *     zero rows — no anonymised fallback.
 *   - DNT collapses the analytics category to deny even when the stored
 *     decision opted it in (browser-level opt-out wins).
 *   - A recording failure (broken query handle) is drop-silent: the
 *     request still succeeds and nothing leaks into the response.
 *
 * Recording is container-served only by design (anonymous PDP/search
 * GETs are edge-cached and never reach the container); the events here
 * fire on the container path a session-cookie-carrying request takes,
 * which is exactly the cohort whose consent the server can read.
 *
 * Network: zero — every request lands on 127.0.0.1; payment is a stub.
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

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql", "0228_orders_payment_provider.sql", "0229_orders_paypal_capture_id.sql", "0004_shop_config.sql",
  "0206_orders_email_hash.sql",
  "0019_analytics_events.sql", "0103_cookie_consent.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}

// Returns { query, db } so the test can both wire the primitives and
// count rows in analytics_events directly (the dashboard-query reads run
// through the analytics primitive itself).
function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  function query(sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return Promise.resolve({ rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null });
    }
    var rows = stmt.all.apply(stmt, params || []);
    return Promise.resolve({ rows: rows, rowCount: rows.length });
  }
  return { query: query, db: db };
}

function _stubPayment() {
  var n = 0;
  return {
    name: "fake-stripe",
    createPaymentIntent: async function (input) {
      n += 1;
      return { id: "pi_" + n, client_secret: "pi_" + n + "_secret", status: "requires_payment_method", _amount: input.amount_minor };
    },
    verifyWebhook: async function () { return { ok: false, reason: "unused" }; },
  };
}

function _countEvents(db, eventType) {
  if (eventType) {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE event_type = ?").get(eventType).n);
  }
  return Number(db.prepare("SELECT COUNT(*) AS n FROM analytics_events").get().n);
}

async function _run() {
  var q       = _makeQuery();
  var query   = q.query;
  var db      = q.db;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var order   = bShop.order.create({ query: query, cursorSecret: "analytics-flow-cursor" });
  var tax     = bShop.tax.create({ rules: [{ country: "US", rate_bps: 875 }] });
  var shipping = bShop.shipping.create({ services: [
    { id: "std", label: "Standard", zones: [{ country: "US", flat_amount_minor: 695 }] },
  ] });
  var payment = _stubPayment();
  var checkout = bShop.checkout.create({
    catalog: catalog, cart: cart, pricing: bShop.pricing,
    tax: tax, shipping: shipping, payment: payment, order: order,
  });
  var cookieConsent = bShop.cookieConsent.create({ query: query });
  // The analytics handle the /admin/analytics screen reads — wired into
  // the storefront so the browse→buy points can record. Its query handle
  // is the shared in-memory DB (mirrors server.js threading the same
  // analytics instance into both admin + sfDeps).
  var analytics = bShop.analytics.create({ query: query });

  // One in-stock product with a priced variant — the unit every event
  // point exercises.
  var p1 = await catalog.products.create({ slug: "widget", title: "Widget", description: "x", status: "active" });
  var v1 = await catalog.variants.create(p1.id, { sku: "WID-1", weight_grams: 100 });
  await catalog.prices.set(v1.id, { currency: "USD", amount_minor: 2999 });
  await catalog.inventory.create("WID-1", { stock_on_hand: 50 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-analytics-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart, order: order, checkout: checkout,
        cookieConsent: cookieConsent, analytics: analytics,
        default_shipping_id: "std",
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  // Drive the real /consent accept-all flow so the sealed `shop_consent`
  // cookie the server-side gate reads is set in `jar` (analytics category
  // opted in). The leading GET seeds the CSRF cookie the POST echoes.
  async function _grantConsent(jar) {
    await helpers.httpRequest({ port: port, path: "/", jar: jar });
    var r = await helpers.httpRequest({
      port: port, path: "/consent", method: "POST", jar: jar,
      form: { choice: "accept_all", return_to: "/" },
    });
    check("consent accept-all 303",            r.status === 303);
    check("consent sealed cookie set",         jar.get("shop_consent") !== null);
    return jar;
  }

  try {
    // ================================================================
    // 1. Consent granted → every browse→buy point records a row, and
    //    the dashboard's own queries read them back.
    // ================================================================
    var jar = await _grantConsent(helpers.cookieJar());

    // ---- PDP view -------------------------------------------------
    var pdp = await helpers.httpRequest({ port: port, path: "/products/widget", jar: jar });
    check("PDP renders 200",                   pdp.status === 200);
    await helpers.waitUntil(function () { return _countEvents(db, "pdp_view") === 1; },
      { label: "pdp_view recorded under consent" });

    // ---- search ---------------------------------------------------
    var search = await helpers.httpRequest({ port: port, path: "/search?q=widget", jar: jar });
    check("search renders 200",                search.status === 200);
    await helpers.waitUntil(function () { return _countEvents(db, "search_query") === 1; },
      { label: "search_query recorded under consent" });

    // An empty query is NOT a search event (no demand signal to record).
    await helpers.httpRequest({ port: port, path: "/search?q=", jar: jar });
    await helpers.httpRequest({ port: port, path: "/search", jar: jar });
    check("empty query records no search event", _countEvents(db, "search_query") === 1);

    // ---- add-to-cart ----------------------------------------------
    var add = await helpers.httpRequest({
      port: port, path: "/cart/lines", method: "POST", jar: jar,
      form: { variant_id: v1.id, qty: "1" },
    });
    check("add-to-cart 303",                   add.status === 303);
    await helpers.waitUntil(function () { return _countEvents(db, "cart_add") === 1; },
      { label: "cart_add recorded under consent" });

    // ---- checkout start (GET /checkout with a non-empty cart) ------
    var coGet = await helpers.httpRequest({ port: port, path: "/checkout", jar: jar });
    check("checkout form 200",                 coGet.status === 200);
    await helpers.waitUntil(function () { return _countEvents(db, "checkout_start") === 1; },
      { label: "checkout_start recorded under consent" });

    // ---- checkout complete (POST /checkout → order placed) --------
    var coPost = await helpers.httpRequest({
      port: port, path: "/checkout", method: "POST", jar: jar,
      form: { email: "buyer@example.com", name: "Buyer", line1: "1 Main St", city: "SF", country: "US", state: "CA", postal: "94103" },
    });
    check("checkout confirm 303 → /pay",       coPost.status === 303 && (coPost.headers.location || "").indexOf("/pay/") === 0);
    // The Stripe-path order is only PENDING at confirm — no completion event
    // yet. It records on the post-payment return (?redirect_status=succeeded),
    // which 303s to the bare URL so refreshes never double-count.
    check("no completion recorded at confirm (payment pending)",
      _countEvents(db, "checkout_complete") === 0);
    var payOrderId = (coPost.headers.location || "").slice("/pay/".length);
    var ret = await helpers.httpRequest({
      port: port, path: "/orders/" + payOrderId + "?payment_intent=pi_x&redirect_status=succeeded", jar: jar,
    });
    check("payment return 303-strips the params",
      ret.status === 303 && (ret.headers.location || "") === "/orders/" + payOrderId);
    await helpers.waitUntil(function () { return _countEvents(db, "checkout_complete") === 1; },
      { label: "checkout_complete recorded on the settled return" });
    var clean = await helpers.httpRequest({ port: port, path: "/orders/" + payOrderId, jar: jar });
    check("clean confirmation URL renders (200)", clean.status === 200);
    check("refresh/revisit records no duplicate", _countEvents(db, "checkout_complete") === 1);

    // ---- the dashboard's OWN queries read the recorded rows -------
    // Drive the end-to-end read path the /admin/analytics screen uses.
    // The event-window queries use an exclusive `occurred_at < to` upper
    // bound with `to = Date.now()`, so a row recorded in the SAME ms the
    // query computes its window is momentarily out of range — poll until
    // wall-clock advances the window past it (a real screen refresh lands
    // a tick later regardless). Each poll re-runs the full primitive query.
    var funnel = await helpers.waitUntil(async function () {
      var f = await analytics.funnel({});
      return (f.pdp_views === 1 && f.cart_adds === 1 &&
              f.checkout_starts === 1 && f.checkout_completes === 1) ? f : false;
    }, { label: "funnel reads all four browse→buy steps" });
    check("funnel reads the pdp_view",         funnel.pdp_views === 1);
    check("funnel reads the cart_add",         funnel.cart_adds === 1);
    check("funnel reads the checkout_start",   funnel.checkout_starts === 1);
    check("funnel reads the checkout_complete", funnel.checkout_completes === 1);
    check("funnel conversion = completes/pdp", funnel.conversion_rate === 1);

    var terms = await helpers.waitUntil(async function () {
      var t = await analytics.topSearchTerms({});
      return (t.length === 1 && t[0].search_q === "widget" && t[0].count === 1) ? t : false;
    }, { label: "topSearchTerms reads the recorded term" });
    check("topSearchTerms reads the term",     terms.length === 1 && terms[0].search_q === "widget" && terms[0].count === 1);

    var viewed = await helpers.waitUntil(async function () {
      var v = await analytics.topViewedProducts({});
      return (v.length === 1 && v[0].product_id === p1.id && v[0].count === 1) ? v : false;
    }, { label: "topViewedProducts reads the recorded product" });
    check("topViewedProducts reads the product", viewed.length === 1 && viewed[0].product_id === p1.id && viewed[0].count === 1);

    // ---- no PII / raw session id reached the table ----------------
    // recordEvent namespace-hashes the session id; the raw `shop_sid`
    // value never lands in session_id_hash, and no email/name column
    // exists. Assert the join key is a hash, not the raw cookie value.
    var sidRaw = jar.get("shop_sid");
    var hashRow = db.prepare("SELECT session_id_hash FROM analytics_events LIMIT 1").get();
    check("session id hashed (raw never stored)",
      sidRaw && hashRow && hashRow.session_id_hash !== sidRaw && hashRow.session_id_hash.length > 0);

    // recordEvent hashes the session id with the "analytics-session"
    // namespace before storage — compute the same hash to assert directly
    // on a given session's rows (order-independent, no timing).
    function _rowsForSession(sid) {
      var h = b.crypto.namespaceHash("analytics-session", sid);
      return Number(db.prepare("SELECT COUNT(*) AS n FROM analytics_events WHERE session_id_hash = ?").get(h).n);
    }

    // ================================================================
    // 2. No consent → the SAME requests record NOTHING (default-deny,
    //    no anonymised fallback row).
    // ================================================================
    // A fresh session with a cart but NO consent decision cookie.
    var noJar = helpers.cookieJar();
    var sid2 = b.uuid.v7();
    var c2 = await cart.create(sid2, { currency: "USD" });
    await cart.addLine(c2.id, { variant_id: v1.id, qty: 1 });
    noJar.capture({ "set-cookie": ["shop_sid=" + sid2 + "; Path=/"] });

    var pdpNo = await helpers.httpRequest({ port: port, path: "/products/widget", jar: noJar });
    check("PDP still renders 200 without consent", pdpNo.status === 200);
    var searchNo = await helpers.httpRequest({ port: port, path: "/search?q=widget", jar: noJar });
    check("search still renders 200 without consent", searchNo.status === 200);
    var addNo = await helpers.httpRequest({
      port: port, path: "/cart/lines", method: "POST", jar: noJar,
      form: { variant_id: v1.id, qty: "1" },
    });
    check("add-to-cart still 303 without consent", addNo.status === 303);
    var coGetNo = await helpers.httpRequest({ port: port, path: "/checkout", jar: noJar });
    check("checkout form still 200 without consent", coGetNo.status === 200);

    // Barrier: fire ONE consent-granted PDP on the SAME no-consent session
    // shape and wait for a granted row to land, so any in-flight write the
    // no-consent requests might (incorrectly) have issued has drained. Then
    // assert sid2 has ZERO rows — addressed by its own hash, so the check
    // is independent of write-completion ordering.
    await helpers.httpRequest({ port: port, path: "/products/widget", jar: jar });   // `jar` still holds granted consent
    await helpers.waitUntil(function () { return _countEvents(db, "pdp_view") >= 2; },
      { label: "barrier granted pdp_view landed after no-consent requests" });
    check("no-consent session recorded zero rows", _rowsForSession(sid2) === 0);

    // ================================================================
    // 3. DNT collapses analytics to deny even with a stored opt-in.
    // ================================================================
    var dntJar = helpers.cookieJar();
    // Pin a known session id so the DNT request carries one — this session
    // has consent granted AND a sid, so it WOULD record but for the DNT
    // header. (A PDP GET doesn't mint a sid; cart routes do.)
    var dntSid = b.uuid.v7();
    dntJar.capture({ "set-cookie": ["shop_sid=" + dntSid + "; Path=/"] });
    await _grantConsent(dntJar);
    var dntPdp = await helpers.httpRequest({
      port: port, path: "/products/widget", jar: dntJar, headers: { dnt: "1" },
    });
    check("PDP renders 200 under DNT",         dntPdp.status === 200);
    // Barrier again: a consent-granted PDP (no DNT) on `jar` drains the
    // pipeline; the DNT session must still hold zero rows despite its
    // stored accept-all decision (browser-level opt-out wins).
    await helpers.httpRequest({ port: port, path: "/products/widget", jar: jar });
    await helpers.waitUntil(function () { return _countEvents(db, "pdp_view") >= 3; },
      { label: "barrier granted pdp_view landed after the DNT request" });
    check("DNT suppresses analytics recording", dntSid && _rowsForSession(dntSid) === 0);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }

  // ================================================================
  // 4. Drop-silent on a broken query handle — a recording failure must
  //    never affect the request that triggered it.
  // ================================================================
  await _runBrokenHandle();
}

// A second app whose analytics handle throws on every write. With consent
// granted, the PDP must still render 200 (the recording failure is swallowed
// fire-and-forget; nothing reaches the response).
async function _runBrokenHandle() {
  var q       = _makeQuery();
  var query   = q.query;
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var cookieConsent = bShop.cookieConsent.create({ query: query });
  // A handle that succeeds for catalog/cart reads but throws when the
  // analytics primitive tries to INSERT — i.e. analytics gets its own
  // broken query function while the storefront's other deps stay healthy.
  var brokenQuery = function () { return Promise.reject(new Error("analytics DB exploded")); };
  var analytics = bShop.analytics.create({ query: brokenQuery });

  var p1 = await catalog.products.create({ slug: "widget", title: "Widget", description: "x", status: "active" });
  await catalog.variants.create(p1.id, { sku: "WID-1", weight_grams: 100 });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-analytics-broken-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, {
        catalog: catalog, cart: cart,
        cookieConsent: cookieConsent, analytics: analytics,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;

  try {
    var jar = helpers.cookieJar();
    await helpers.httpRequest({ port: port, path: "/", jar: jar });
    await helpers.httpRequest({
      port: port, path: "/consent", method: "POST", jar: jar,
      form: { choice: "accept_all", return_to: "/" },
    });
    var pdp = await helpers.httpRequest({ port: port, path: "/products/widget", jar: jar });
    check("PDP still 200 when analytics write throws", pdp.status === 200);
    check("broken-handle PDP body carries no error leak",
      pdp.body.indexOf("analytics DB exploded") === -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* best-effort */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}

module.exports = { run: _run };
