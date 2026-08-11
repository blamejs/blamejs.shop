"use strict";
/**
 * Operator "view as customer" — the whole path, admin console through
 * storefront, against one booted app.
 *
 * The primitive's own state machine is covered at layer 1
 * (customer-impersonation.test.js). What this pins is the WIRING, which is
 * where a feature like this goes wrong: an authorization gate that is not
 * actually reached, a session that outlives the row behind it, or a
 * credential surface that stays open because nobody remembered to close it.
 *
 *   - starting requires a reason, and mints a single-use bearer
 *   - redeeming the bearer signs the operator in AS the customer
 *   - the impersonation marker rides the session, and /cart/count reports it
 *     so an edge-cached page can raise the banner
 *   - CREDENTIAL SURFACES ARE CLOSED: passkey enrolment, passkey revocation,
 *     identity linking, the emailed sign-in link, account deletion and the
 *     privacy export all refuse, and the refusal is recorded
 *   - ordinary customer actions still work — this is read-write support,
 *     not a read-only viewer
 *   - ending the session refuses the very next request, rather than waiting
 *     for the cookie to expire
 *   - the bearer is single-use in the sense that matters: once the row is no
 *     longer active, redeeming it again fails
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

var TOKEN = "admin-token-0123456789abcdef-impersonation";

var MIGS = [
  "0001_catalog.sql", "0002_cart.sql",
  "0003_order.sql", "0228_orders_payment_provider.sql",
  "0229_orders_paypal_capture_id.sql", "0206_orders_email_hash.sql",
  "0004_shop_config.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql",
  "0190_customer_impersonation.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) {
  return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/)
    .map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); });
  });
  return async function (sql, params) {
    var stmt = db.prepare(sql);
    var verb = sql.replace(/^\s+|\s*--[^\n]*\n/g, "").trim().split(/\s+/)[0].toUpperCase();
    if (verb === "INSERT" || verb === "UPDATE" || verb === "DELETE" || verb === "REPLACE") {
      var info = stmt.run.apply(stmt, params || []);
      return { rows: [], rowCount: Number(info.changes), lastRowId: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null };
    }
    var rows = stmt.all.apply(stmt, params || []);
    return { rows: rows, rowCount: rows.length };
  };
}

async function _run() {
  var query    = _makeQuery();
  var catalog  = bShop.catalog.create({ query: query });
  var cart     = bShop.cart.create({ query: query, catalog: catalog });
  var order    = bShop.order.create({ query: query });
  var config   = bShop.config.create({ query: query });
  var customers = bShop.customers.create({ query: query, cursorSecret: "impersonation-flow-customers" });
  var impersonation = bShop.customerImpersonation.create({ query: query });

  var alice = await customers.register({ email: "alice@example.com", display_name: "Alice Buyer" });

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-impersonation-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" },
    db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order,
        config: config, customers: customers,
        customerImpersonation: impersonation,
      });
      bShop.storefront.mount(r, {
        shop_name: "Test Shop", catalog: catalog, cart: cart, order: order,
        customers: customers, customerImpersonation: impersonation,
      });
    },
  });

  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port  = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };
  var startPath = "/admin/customers/" + encodeURIComponent(alice.id) + "/impersonate";

  try {
    // ---- a reason is required -------------------------------------------
    var noReason = await helpers.httpRequest({
      port: port, path: startPath, method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({}),
    });
    check("starting without a reason is refused", noReason.status === 400);

    // ---- start ------------------------------------------------------------
    var started = await helpers.httpRequest({
      port: port, path: startPath, method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, bearer),
      body: JSON.stringify({ reason: "customer reports the cart total is wrong" }),
    });
    check("starting with a reason succeeds", started.status === 200);
    var payload = JSON.parse(started.body);
    check("a session id comes back",  typeof payload.impersonation_id === "string");
    check("an open url comes back",   /^\/account\/impersonate\//.test(payload.open_url));
    check("the response carries no token field of its own",
      payload.plaintext_token === undefined);

    // ---- redeem -----------------------------------------------------------
    var jar = helpers.cookieJar();

    // Following the link only LOOKS — a prefetcher or preview bot must not be
    // able to spend a credential by fetching a URL.
    var landing = await helpers.httpRequest({
      port: port, path: payload.open_url, method: "GET", jar: jar,
    });
    check("following the link lands on a confirmation, not a session",
      landing.status === 200 && landing.body.indexOf("View the store as this customer?") !== -1);
    check("the confirmation names the operator's own stated reason",
      landing.body.indexOf("customer reports the cart total is wrong") !== -1);

    // ...and the GET consumed nothing, so the operator's own click still works.
    var afterLook = await impersonation.getSession(payload.impersonation_id);
    check("looking at the confirmation spends nothing", afterLook.status === "active");

    var redeemed = await helpers.httpRequest({
      port: port, path: "/account/impersonate/start", method: "POST", jar: jar,
      form: { token: decodeURIComponent(payload.open_url.split("/").pop()) },
    });
    check("confirming redirects into the account", redeemed.status === 303);

    var acct = await helpers.httpRequest({ port: port, path: "/account", method: "GET", jar: jar });
    check("the operator is now signed in as the customer", acct.status === 200);

    // The handoff link is spent by being followed. It stays in browser
    // history and anywhere it was pasted, so a second holder must not be able
    // to mint their own cookie for this customer while the session runs on.
    var secondHolder = await helpers.httpRequest({
      port: port, path: payload.open_url, method: "GET", jar: helpers.cookieJar(),
    });
    check("the link cannot be redeemed a second time while the session is live",
      secondHolder.status === 303 &&
      /\/account\/login/.test(String(secondHolder.headers.location || "")));
    var stillLive = await impersonation.getSession(payload.impersonation_id);
    check("spending the link does not end the session", stillLive.status === "active");

    // Two holders racing the SAME fresh link: exactly one may win. Verifying
    // is a read, so both can pass it before either writes — only the claim
    // decides, and only the winner gets a cookie.
    var raced = await impersonation.startImpersonation({
      operator_id: "owner", customer_id: alice.id, reason: "concurrency probe",
    });
    var both = await Promise.all([
      helpers.httpRequest({
        port: port, path: "/account/impersonate/start", method: "POST",
        jar: helpers.cookieJar(), form: { token: raced.plaintext_token },
      }),
      helpers.httpRequest({
        port: port, path: "/account/impersonate/start", method: "POST",
        jar: helpers.cookieJar(), form: { token: raced.plaintext_token },
      }),
    ]);
    var won = both.filter(function (r) {
      return r.status === 303 && String(r.headers.location || "") === "/account";
    }).length;
    check("two holders racing one link — exactly one is admitted", won === 1);

    // The claim itself, directly. Both callers verified the same token before
    // either wrote — that is the interleaving an HTTP-level race cannot force
    // on a single-threaded runtime, and it is the one that matters: only the
    // caller whose UPDATE still matched the hash may be handed a session.
    var claimed = await impersonation.startImpersonation({
      operator_id: "owner", customer_id: alice.id, reason: "claim probe",
    });
    var firstClaim  = await impersonation.consumeToken(claimed.impersonation_id, claimed.plaintext_token);
    var secondClaim = await impersonation.consumeToken(claimed.impersonation_id, claimed.plaintext_token);
    check("the first claim on a token wins",   firstClaim.consumed === true);
    check("a second claim on it does not",     secondClaim.consumed === false);
    check("and the session is still live",
      (await impersonation.getSession(claimed.impersonation_id)).status === "active");
    await impersonation.endImpersonation({
      impersonation_id: claimed.impersonation_id, ended_by: "operator", reason: "probe done",
    });
    await impersonation.endImpersonation({
      impersonation_id: raced.impersonation_id, ended_by: "operator", reason: "probe done",
    });

    // ---- the marker reaches the session-chrome island ---------------------
    var island = await helpers.httpRequest({
      port: port, path: "/cart/count", method: "GET", jar: jar,
      headers: { accept: "application/json" },
    });
    var islandBody = JSON.parse(island.body);
    check("the island reports the impersonation",
      islandBody.impersonating && islandBody.impersonating.customer_id === alice.id);

    // An ordinary visitor's island response is unchanged — no marker, and no
    // extra field that could leak the existence of a session.
    var plainIsland = await helpers.httpRequest({
      port: port, path: "/cart/count", method: "GET", headers: { accept: "application/json" },
    });
    check("an ordinary visitor sees no impersonation marker",
      JSON.parse(plainIsland.body).impersonating === undefined);

    // ---- credential surfaces are closed -----------------------------------
    var CLOSED = [
      "/account/delete",
      "/account/passkey/register-begin",
      "/account/passkey/add-begin",
      "/account/passkeys/some-id/revoke",
      "/account/login/link",
      "/account/privacy/export",
    ];
    for (var i = 0; i < CLOSED.length; i += 1) {
      var refused = await helpers.httpRequest({
        port: port, path: CLOSED[i], method: "POST", jar: jar,
        headers: { "content-type": "application/json" }, body: "{}",
      });
      check("closed under impersonation: " + CLOSED[i], refused.status === 403);
    }

    // The refusal page's exit control must actually work. It is rendered by a
    // guard that runs ahead of the middleware which normally supplies the
    // token, so without an explicit one the form would post without `_csrf`
    // and be rejected — leaving the operator with a dead button as their way
    // out of someone else's account. Read off the last refusal above.
    check("the refusal page offers a way out",
      refused.body.indexOf("/account/impersonate/end") !== -1);
    check("and that exit form carries a CSRF token",
      /name="_csrf" value="[^"]+"/.test(refused.body));

    // The refusals are on the record, not merely returned.
    var actions = await impersonation.actionsForSession(payload.impersonation_id);
    check("every refusal is recorded against the session",
      actions.filter(function (a) { return a.action === "refused"; }).length === CLOSED.length);

    // ---- "sign out" ends the SESSION, not the customer's logins -----------
    //
    // The account page's own sign-out posts to /account/logout, which revokes
    // every session the customer has. An operator reaching for it means "get
    // me out of here"; if it passed through, the customer would be signed out
    // of their phone and laptop by a support visit.
    var soReason = "sign-out probe";
    var soStart = await impersonation.startImpersonation({
      operator_id: "owner", customer_id: alice.id, reason: soReason,
    });
    var soJar = helpers.cookieJar();
    await helpers.httpRequest({
      port: port, path: "/account/impersonate/start", method: "POST", jar: soJar,
      form: { token: soStart.plaintext_token },
    });
    var signedOut = await helpers.httpRequest({
      port: port, path: "/account/logout", method: "POST", jar: soJar,
    });
    check("signing out of an impersonation redirects away", signedOut.status === 303);
    var soRow = await impersonation.getSession(soStart.impersonation_id);
    check("signing out ends the impersonation session", soRow.status === "ended");
    // The customer's own sessions are untouched: the cookie minted before this
    // probe still works, which it would not if logout had revoked them.
    var stillIn = await helpers.httpRequest({ port: port, path: "/account", method: "GET", jar: jar });
    check("the customer's other sessions survive an operator signing out",
      stillIn.status === 200);

    // ---- ...but ordinary customer surfaces still work ---------------------
    // This is support with write access, not a read-only viewer: the point is
    // to be able to fix the thing the customer called about.
    var wrote = await helpers.httpRequest({
      port: port, path: "/account/profile", method: "POST", jar: jar,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ display_name: "Alice B." }),
    });
    check("a non-credential write goes through while impersonating",
      wrote.status >= 200 && wrote.status < 400);
    var renamed = await customers.get(alice.id);
    check("and the write actually landed", renamed.display_name === "Alice B.");

    // ---- the customer is told, on their own account page ------------------
    //
    // This is the notification. The store holds customer email as a hash, so
    // there is no address to send to — the record has to be somewhere the
    // customer will actually see it, and it has to be there whether or not any
    // mailer exists.
    var acctPage = await helpers.httpRequest({ port: port, path: "/account", method: "GET", jar: jar });
    check("the account page names the access",
      acctPage.body.indexOf("Account access by our support team") !== -1);
    check("the operator's stated reason is shown to the customer",
      acctPage.body.indexOf("customer reports the cart total is wrong") !== -1);
    check("a live session reads as in progress",
      acctPage.body.indexOf("in progress now") !== -1);

    // ---- ending takes effect on the NEXT request --------------------------
    await impersonation.endImpersonation({
      impersonation_id: payload.impersonation_id,
      ended_by: "operator", reason: "done",
    });
    var afterEnd = await helpers.httpRequest({ port: port, path: "/account", method: "GET", jar: jar });
    check("the session is refused immediately after it ends, not at cookie expiry",
      afterEnd.status === 303 || afterEnd.status === 403);

    // ---- and the bearer cannot be redeemed again --------------------------
    var replay = await helpers.httpRequest({
      port: port, path: payload.open_url, method: "GET", jar: helpers.cookieJar(),
    });
    check("the link cannot be redeemed once the session is over",
      replay.status === 303 && /\/account\/login/.test(String(replay.headers.location || "")));

    // ---- expiry is swept so the record stops lying ------------------------
    //
    // Authority is already gone when the hour elapses — verify and the
    // liveness read both refuse an elapsed row. The sweep is what stops the
    // customer's panel reading "in progress now" for a session an operator
    // simply walked away from. Uses a FRESH session, left open, so what is
    // being measured is the sweep and not the explicit end above.
    var abandoned = await impersonation.startImpersonation({
      operator_id: "owner", customer_id: alice.id, reason: "walked away from this one",
    });
    var stillOpen = await impersonation.getSession(abandoned.impersonation_id);
    check("an abandoned session starts out active", stillOpen.status === "active");

    var twoHoursOn = Date.now() + 1000 * 60 * 60 * 2;
    var sweptResult = await impersonation.cleanupExpired({ now: twoHoursOn });
    check("the sweep flips it", sweptResult.swept >= 1);
    var afterSweep = await impersonation.getSession(abandoned.impersonation_id);
    check("an elapsed session no longer reads as active", afterSweep.status !== "active");
  } finally {
    try { await app.shutdown(); } catch (_e) { /* already down */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* temp dir */ }
  }
}

module.exports = { run: _run };

if (require.main === module) {
  _run().then(function () {
    process.stdout.write("customer-impersonation-flow: OK (" + helpers.getChecks() + " checks)\n");
  }).catch(function (e) {
    process.stderr.write("customer-impersonation-flow: FAIL — " + (e && e.stack || e) + "\n");
    process.exit(1);
  });
}
