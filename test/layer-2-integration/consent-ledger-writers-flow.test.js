"use strict";
/**
 * Durable consent-ledger writers — full HTTP integration of the
 * per-customer GDPR Art. 7(1) consent of record populated from real
 * storefront consent events.
 *
 * Boots a real `b.createApp` storefront wired with catalog/cart/customers/
 * cookieConsent/consentLedger/newsletter over one in-memory node:sqlite DB
 * loaded from the live migrations. The signed-in customer rides the sealed
 * shop_auth cookie (helpers.authCookie). Covers:
 *   - an AUTHENTICATED customer's granular banner save mirrors the four
 *     cookie categories into the durable ledger (granted on the toggled-on
 *     categories, withdrawn on the toggled-off ones), in addition to the
 *     existing session-level cookie_consent_records row;
 *   - an ANONYMOUS banner save writes NOTHING to the durable ledger (the
 *     session-level record is still written) — no customer_id is fabricated;
 *   - a newsletter unsubscribe whose address ALSO belongs to a customer
 *     account records a marketing_email WITHDRAWAL in the durable ledger;
 *   - a newsletter unsubscribe for an email-only subscriber (no account)
 *     writes NOTHING to the durable ledger (it can't be customer-keyed);
 *   - a durable-ledger write that THROWS never breaks the banner save (303)
 *     or the unsubscribe (200) — the writes are drop-silent by design.
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
  "0001_catalog.sql", "0002_cart.sql",
  "0006_customers.sql", "0222_customer_session_revocations.sql",
  "0103_cookie_consent.sql",
  "0185_consent_ledger.sql", "0232_consent_ledger_lawful_basis.sql",
  "0010_newsletter_signups.sql", "0014_newsletter_unsubscribe_tokens.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

// Latest-state-per-kind map for one customer straight off the table, so the
// assertions read the durable ledger exactly as a supervisory-authority
// export would.
function _ledgerStateFor(db, customerId) {
  var rows = db.prepare(
    "SELECT consent_kind, state, source FROM consent_ledger " +
    "WHERE customer_id = ?1 ORDER BY occurred_at ASC, id ASC"
  ).all(customerId);
  var out = {};
  for (var i = 0; i < rows.length; i += 1) {
    out[rows[i].consent_kind] = { state: rows[i].state, source: rows[i].source };
  }
  return out;
}

function _ledgerRowCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM consent_ledger").get().n);
}

function _sessionRecordCount(db) {
  return Number(db.prepare("SELECT COUNT(*) AS n FROM cookie_consent_records").get().n);
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-clw-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    // createApp's default double-submit CSRF guard runs with
    // skipStateless:true — it exempts a cookieless request but ENFORCES a
    // token on a request that carries the sealed shop_auth credential
    // cookie. In production /consent is CSRF-exempt regardless of auth (it
    // sits in lib/security-middleware's EDGE_POST_PATHS skip set), so the
    // authed banner save never hits a token check. This harness doesn't
    // mount lib/security-middleware, so the raw default would 403 the authed
    // POST; turn CSRF off here so the test exercises the consent-ledger
    // WRITER under test, not the framework's CSRF gate (which the cookie-
    // consent-flow test covers for /consent). Not a shipped code path.
    middleware: { botGuard: false, rateLimit: false, csrf: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var mem   = helpers.memD1Query(MIGS);
  var query = mem.query;
  var db    = mem.db;

  var catalog       = bShop.catalog.create({ query: query });
  var cart          = bShop.cart.create({ query: query, catalog: catalog });
  var customers     = bShop.customers.create({ query: query, cursorSecret: "clw-cust" });
  var cookieConsent = bShop.cookieConsent.create({ query: query });
  var consentLedger = bShop.consentLedger.create({ query: query });
  var newsletter    = bShop.newsletter.create({ query: query });

  await catalog.products.create({ slug: "widget", title: "Widget", description: "x", status: "active" });

  // The signed-in customer. register() keys email_hash on the SAME namespace
  // customers.byEmailHash resolves against, so a later unsubscribe of the
  // same address re-hashes to this row.
  var buyer = await customers.register({ email: "buyer@example.com", display_name: "Bea Buyer" });

  var handle = await _bootApp({
    catalog: catalog, cart: cart, customers: customers,
    cookieConsent: cookieConsent, consentLedger: consentLedger, newsletter: newsletter,
  });

  try {
    // ---- 1) authed customer's granular banner save mirrors 4 rows -------
    // analytics + marketing ON; functional + preferences OFF (unchecked).
    var authedJar = helpers.cookieJar();
    authedJar.capture({ "set-cookie": [helpers.authCookie(b, buyer.id)] });

    var ledgerBefore = _ledgerRowCount(db);
    var sessBefore   = _sessionRecordCount(db);
    var authedSave = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: authedJar,
      form: { choice: "granular", return_to: "/", cat_analytics: "1", cat_marketing: "1" },
    });
    check("authed banner save 303",            authedSave.status === 303);
    check("authed save writes session record", _sessionRecordCount(db) === sessBefore + 1);
    check("authed save writes 4 ledger rows",  _ledgerRowCount(db) === ledgerBefore + 4);

    var st = _ledgerStateFor(db, buyer.id);
    check("ledger functional withdrawn",  st.cookies_functional  && st.cookies_functional.state  === "withdrawn");
    check("ledger analytics granted",     st.cookies_analytics   && st.cookies_analytics.state   === "granted");
    check("ledger marketing granted",     st.cookies_marketing   && st.cookies_marketing.state   === "granted");
    check("ledger preferences withdrawn", st.cookies_preferences && st.cookies_preferences.state === "withdrawn");
    check("ledger source is cookie_banner",
      st.cookies_analytics.source === "cookie_banner" && st.cookies_marketing.source === "cookie_banner");

    // A second authed save (reject all) appends 4 MORE rows — append-only
    // audit semantics, latest-state-per-kind now all withdrawn.
    var rowsAfterFirst = _ledgerRowCount(db);
    var authedReject = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: authedJar,
      form: { choice: "reject", return_to: "/" },
    });
    check("authed reject 303",                 authedReject.status === 303);
    check("re-save appends (append-only)",     _ledgerRowCount(db) === rowsAfterFirst + 4);
    var st2 = _ledgerStateFor(db, buyer.id);
    check("latest analytics now withdrawn",    st2.cookies_analytics.state === "withdrawn");
    check("latest marketing now withdrawn",    st2.cookies_marketing.state === "withdrawn");

    // ---- 1c) GPC / DNT collapses analytics + marketing in the ledger -----
    // A signed-in customer sends Sec-GPC:1 and ticks analytics + marketing +
    // functional. The runtime gate (_consentAllows) forces analytics +
    // marketing off under a browser opt-out, so the durable record must show
    // them WITHDRAWN even though the boxes were checked — otherwise the
    // customer record claims consent the app refuses to honor. functional is
    // not opt-out-collapsed, so it reflects the ticked box (granted).
    var rowsBeforeGpc = _ledgerRowCount(db);
    var gpcSave = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: authedJar,
      headers: { "sec-gpc": "1" },
      form: { choice: "granular", return_to: "/", cat_analytics: "1", cat_marketing: "1", cat_functional: "1" },
    });
    check("gpc banner save 303",                  gpcSave.status === 303);
    check("gpc save appends 4 ledger rows",       _ledgerRowCount(db) === rowsBeforeGpc + 4);
    var stGpc = _ledgerStateFor(db, buyer.id);
    check("gpc collapses analytics to withdrawn", stGpc.cookies_analytics.state === "withdrawn");
    check("gpc collapses marketing to withdrawn", stGpc.cookies_marketing.state === "withdrawn");
    check("gpc leaves functional granted",        stGpc.cookies_functional.state === "granted");

    // ---- 2) anonymous banner save writes NOTHING to the durable ledger --
    var ledgerBeforeAnon = _ledgerRowCount(db);
    var sessBeforeAnon   = _sessionRecordCount(db);
    var anonJar = helpers.cookieJar();
    var anonSave = await helpers.httpRequest({
      port: handle.port, path: "/consent", method: "POST", jar: anonJar,
      form: { choice: "accept_all", return_to: "/" },
    });
    check("anon banner save 303",              anonSave.status === 303);
    check("anon save writes session record",   _sessionRecordCount(db) === sessBeforeAnon + 1);
    check("anon save writes NO ledger rows",   _ledgerRowCount(db) === ledgerBeforeAnon);

    // ---- 3) unsubscribe of an ACCOUNT address records a withdrawal ------
    // Newsletter signup for the buyer's address, then issue + consume a
    // token via POST /unsubscribe. The address belongs to the buyer's
    // account, so the durable ledger gains a marketing_email withdrawal.
    var buyerSignup = await newsletter.signup({ email: "buyer@example.com", source: "storefront-footer" });
    var buyerToken  = await newsletter.issueUnsubscribeToken(buyerSignup.id);
    var emailLedgerBefore = _ledgerStateFor(db, buyer.id).marketing_email;
    check("no marketing_email row before unsub", emailLedgerBefore == null);

    var unsub = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST",
      form: { token: buyerToken.token },
    });
    check("account unsubscribe 200",           unsub.status === 200);
    check("account unsubscribe success copy",  unsub.body.indexOf("You're unsubscribed") !== -1);
    var stAfterUnsub = _ledgerStateFor(db, buyer.id);
    check("marketing_email withdrawal recorded",
      stAfterUnsub.marketing_email && stAfterUnsub.marketing_email.state === "withdrawn");
    check("marketing_email source preference_center",
      stAfterUnsub.marketing_email && stAfterUnsub.marketing_email.source === "preference_center");

    // ---- 4) unsubscribe of an EMAIL-ONLY subscriber writes nothing ------
    // An address with NO customer account. The unsubscribe still succeeds
    // (the newsletter row stamps unsubscribed_at), but nothing customer-
    // keyed can be written, so the durable ledger row-count is unchanged.
    var anonSignup = await newsletter.signup({ email: "stranger@example.com", source: "storefront-footer" });
    var anonToken  = await newsletter.issueUnsubscribeToken(anonSignup.id);
    var ledgerBeforeEmailOnly = _ledgerRowCount(db);
    var unsubAnon = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST",
      form: { token: anonToken.token },
    });
    check("email-only unsubscribe 200",        unsubAnon.status === 200);
    check("email-only unsubscribe success",    unsubAnon.body.indexOf("You're unsubscribed") !== -1);
    check("email-only unsub writes NO ledger row", _ledgerRowCount(db) === ledgerBeforeEmailOnly);

    // ---- 5) drop-silent: a throwing ledger never breaks the response ----
    // Boot a SECOND app whose consentLedger.recordConsentChange always
    // throws. The banner save must still 303 and the unsubscribe still 200.
    var throwingLedger = {
      recordConsentChange: async function () { throw new Error("ledger down"); },
    };
    var handle2 = await _bootApp({
      catalog: catalog, cart: cart, customers: customers,
      cookieConsent: cookieConsent, consentLedger: throwingLedger, newsletter: newsletter,
    });
    try {
      var authedJar2 = helpers.cookieJar();
      authedJar2.capture({ "set-cookie": [helpers.authCookie(b, buyer.id)] });
      var sessBeforeThrow = _sessionRecordCount(db);
      var saveDespiteThrow = await helpers.httpRequest({
        port: handle2.port, path: "/consent", method: "POST", jar: authedJar2,
        form: { choice: "accept_all", return_to: "/" },
      });
      check("banner save 303 despite ledger throw", saveDespiteThrow.status === 303);
      check("session record still written on throw", _sessionRecordCount(db) === sessBeforeThrow + 1);

      // An account-resolving unsubscribe whose ledger write throws must
      // still answer the success page (the unsubscribe itself committed).
      var throwSignup = await newsletter.signup({ email: "buyer@example.com", source: "storefront-footer" });
      var throwToken  = await newsletter.issueUnsubscribeToken(throwSignup.id);
      var unsubDespiteThrow = await helpers.httpRequest({
        port: handle2.port, path: "/unsubscribe", method: "POST",
        form: { token: throwToken.token },
      });
      check("unsubscribe 200 despite ledger throw", unsubDespiteThrow.status === 200);
      check("unsubscribe success copy despite throw", unsubDespiteThrow.body.indexOf("You're unsubscribed") !== -1);
    } finally {
      await _teardown(handle2);
    }

    console.log("consent-ledger-writers-flow: " + helpers.getChecks() + " checks passed");
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
