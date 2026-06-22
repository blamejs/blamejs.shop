"use strict";
/**
 * Passkey self-management + profile edit — full HTTP integration.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * customers dep, against one in-memory `node:sqlite` DB loaded from the
 * live migrations. Per-customer; routes read the customer from the sealed
 * `shop_auth` cookie (minted via b.vault.seal after boot). Passkeys are
 * seeded through the customers primitive (the WebAuthn enroll ceremony
 * needs a real authenticator, so the begin endpoint is exercised for its
 * challenge shape and the rest is driven against seeded credentials).
 *
 * Covers: list, revoke confirm + POST, the last-credential guard (with and
 * without an OAuth fallback), cross-customer IDOR, the add-begin challenge,
 * and the profile display-name edit + email-change refusal.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0205_customer_oauth_identities.sql",
  "0222_customer_session_revocations.sql"]
  .map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
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

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-pk-"));
  var app = await b.createApp({
    dataDir:    dataDir,
    vault:      { mode: "plaintext" },
    db:         { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.storefront.mount(r, deps);
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  return { app: app, port: bound.port, dataDir: dataDir };
}

function _authCookie(customerId) {
  return helpers.authCookie(b, customerId);
}

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

async function _run() {
  var query     = _makeQuery();
  var catalog   = bShop.catalog.create({ query: query });
  var cart      = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });

  // Two customers: A has two passkeys, B has one + a linked OAuth identity.
  var custA = await customers.register({ email: "alice@example.com", display_name: "Alice" });
  var custB = await customers.register({ email: "bob@example.com",   display_name: "Bob" });
  var pkA1 = await customers.addPasskey(custA.id, { credential_id: "alice-cred-1", public_key: "k1", transports: "internal" });
  var pkA2 = await customers.addPasskey(custA.id, { credential_id: "alice-cred-2", public_key: "k2", transports: "usb" });
  var pkB1 = await customers.addPasskey(custB.id, { credential_id: "bob-cred-1",   public_key: "k3", transports: "hybrid" });
  // Bob also has a federated identity, so revoking his last passkey is safe.
  await customers.signInWithOIDC({ provider: "google", subject: "bob-sub", email: "bob@example.com", email_verified: true });

  var handle = await _bootApp({ catalog: catalog, cart: cart, customers: customers });

  try {
    // A jar per customer: the first authenticated GET seeds the
    // double-submit CSRF cookie, echoed as X-CSRF-Token on each customer's
    // subsequent POSTs (real gate, no bypass). B's first action is a POST,
    // so a benign authed GET seeds its token first.
    var jarA = helpers.cookieJar();
    jarA.capture({ "set-cookie": [_authCookie(custA.id)] });
    var jarB = helpers.cookieJar();
    jarB.capture({ "set-cookie": [_authCookie(custB.id)] });

    // ---- passkeys list ------------------------------------------------
    // Anon → redirect to login.
    var anon = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys" });
    check("anon passkeys then 303 login",       anon.status === 303 && (anon.headers["location"] || "") === "/account/login");

    var listA = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys", jar: jarA });
    check("passkeys page then 200",             listA.status === 200);
    check("list shows both A credentials",       listA.body.indexOf("alice-cred-1") !== -1 && listA.body.indexOf("alice-cred-2") !== -1);
    check("list offers revoke for A (2 keys)",   listA.body.indexOf("/account/passkeys/" + pkA1.id + "/remove") !== -1 &&
                                                 listA.body.indexOf("/account/passkeys/" + pkA2.id + "/remove") !== -1);
    check("list shows the add-another island",   listA.body.indexOf("id=\"passkey-add-btn\"") !== -1);

    // ---- revoke confirm + POST ---------------------------------------
    var confirm = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/" + pkA1.id + "/remove", jar: jarA });
    check("revoke confirm page then 200",        confirm.status === 200);
    check("revoke confirm asks first",           confirm.body.indexOf("Revoke this passkey?") !== -1);
    check("revoke confirm POSTs to revoke",       confirm.body.indexOf("action=\"/account/passkeys/" + pkA1.id + "/revoke\"") !== -1);

    var revoke = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/" + pkA1.id + "/revoke", method: "POST", jar: jarA });
    check("revoke then 303",                     revoke.status === 303 && (revoke.headers["location"] || "") === "/account/passkeys?ok=revoked");
    check("revoked credential gone from DB",      (await customers.listPasskeys(custA.id)).length === 1);
    // SECURITY: revoking a passkey (a lost/compromised authenticator) must
    // also move the session-revocation boundary forward so the account's live
    // sealed auth cookies — which are otherwise self-validating for 14 days —
    // die on their next request. Deleting the credential alone left them live.
    check("revoke moved the session-revocation boundary forward",
                                                 (await customers.sessionsValidFrom(custA.id)) > 0);

    // ---- last-credential guard (NO oauth) ----------------------------
    // A now has exactly one passkey and no OAuth → revoking it is refused.
    var soleA = (await customers.listPasskeys(custA.id))[0];
    var guard = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/" + soleA.id + "/revoke", method: "POST", jar: jarA });
    check("last-credential revoke then 409",      guard.status === 409);
    check("guard surfaces a clear notice",        guard.body.indexOf("only way to sign in") !== -1);
    check("last credential NOT removed",          (await customers.listPasskeys(custA.id)).length === 1);

    // The list page for A now withholds the revoke control entirely.
    var listAsolo = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys", jar: jarA });
    check("solo list withholds revoke",           listAsolo.body.indexOf("/account/passkeys/" + soleA.id + "/remove") === -1);
    check("solo list shows only-method note",      listAsolo.body.indexOf("Only sign-in method") !== -1);

    // ---- last-credential WITH oauth fallback -------------------------
    // B has one passkey but a linked Google identity → revoke is allowed.
    // Seed B's CSRF cookie with a benign authed GET before its first POST.
    await helpers.httpRequest({ port: handle.port, path: "/account/passkeys", jar: jarB });
    var revokeB = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/" + pkB1.id + "/revoke", method: "POST", jar: jarB });
    check("oauth-fallback last revoke then 303",  revokeB.status === 303);
    check("B's last passkey removed (oauth left)", (await customers.listPasskeys(custB.id)).length === 0);

    // ---- cross-customer IDOR -----------------------------------------
    // B cannot view/revoke A's remaining credential.
    var idorView = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/" + soleA.id + "/remove", jar: jarB });
    check("IDOR confirm then 404",                idorView.status === 404);
    var idorRevoke = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/" + soleA.id + "/revoke", method: "POST", jar: jarB });
    check("IDOR revoke then 404",                 idorRevoke.status === 404);
    check("A's credential untouched by B",        (await customers.listPasskeys(custA.id)).length === 1);

    // Malformed (non-UUID) id is a clean 404, not a 500.
    var malformed = await helpers.httpRequest({ port: handle.port, path: "/account/passkeys/not-a-uuid/remove", jar: jarA });
    check("malformed passkey id then 404",        malformed.status === 404);

    // ---- add-another begin challenge ---------------------------------
    var addBegin = await helpers.httpRequest({ port: handle.port, path: "/account/passkey/add-begin", method: "POST", jar: jarA, headers: { "content-type": "application/json" }, body: "{}" });
    check("add-begin then 200",                   addBegin.status === 200);
    var opts = JSON.parse(addBegin.body);
    check("add-begin returns a challenge",        typeof opts.challenge === "string" && opts.challenge.length > 0);
    check("add-begin excludes existing creds",     Array.isArray(opts.excludeCredentials) && opts.excludeCredentials.length === 1);
    // Anon add-begin → login redirect (never mints a challenge).
    var addBeginAnon = await helpers.httpRequest({ port: handle.port, path: "/account/passkey/add-begin", method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    check("anon add-begin then 303 login",        addBeginAnon.status === 303);

    // ---- SECURITY: public register cannot take over an existing account
    //      by email knowledge alone ----------------------------------------
    // An anonymous attacker who knows a registered email must NOT be able to
    // enroll their own authenticator onto that account. The public
    // register-begin path creates NEW accounts only — it refuses ANY email
    // that already has an account (passkey, OAuth, or guest-claim-pending),
    // so the attacker never receives a challenge bound to the victim's id.

    // (a) An account WITH a passkey (custA).
    var preTakeover = (await customers.listPasskeys(custA.id)).length;
    var takeover = await helpers.httpRequest({
      port: handle.port, path: "/account/passkey/register-begin", method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.com", display_name: "Mallory" }),
    });
    check("takeover register-begin on a passkey account then 409", takeover.status === 409);
    check("takeover response mints NO challenge",  takeover.body.indexOf("challenge") === -1);
    check("takeover response says account_exists",  takeover.body.indexOf("account_exists") !== -1);
    check("victim credential count unchanged",      (await customers.listPasskeys(custA.id)).length === preTakeover);

    // (b) An account with NO passkey but a linked OAuth identity (custB —
    //     Bob's last passkey was revoked above; his Google identity remains).
    //     A zero-passkey account is NOT a safely-reusable shell; this is the
    //     exact gap a passkey-count-only check would miss.
    check("precondition: B has zero passkeys, OAuth only", (await customers.listPasskeys(custB.id)).length === 0);
    var oauthTakeover = await helpers.httpRequest({
      port: handle.port, path: "/account/passkey/register-begin", method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "bob@example.com", display_name: "Mallory" }),
    });
    check("takeover register-begin on an OAuth-only account then 409", oauthTakeover.status === 409);
    check("OAuth-account takeover mints NO challenge",  oauthTakeover.body.indexOf("challenge") === -1);
    check("B gains no passkey from the attempt",        (await customers.listPasskeys(custB.id)).length === 0);

    // (c) A bare existing row with no sign-in method (e.g. a guest-order
    //     claim row awaiting a magic-link) is ALSO refused — it has a real
    //     owner reachable by the claim email.
    await customers.register({ email: "guest@example.com", display_name: "Guest" });
    var guestTakeover = await helpers.httpRequest({
      port: handle.port, path: "/account/passkey/register-begin", method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "guest@example.com", display_name: "Mallory" }),
    });
    check("takeover register-begin on a credential-less account then 409", guestTakeover.status === 409);

    // A brand-new email still registers — begin mints a challenge.
    var freshBegin = await helpers.httpRequest({
      port: handle.port, path: "/account/passkey/register-begin", method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "newcomer@example.com", display_name: "Newcomer" }),
    });
    check("new-email register-begin then 200",     freshBegin.status === 200);
    check("new-email register-begin mints a challenge", JSON.parse(freshBegin.body).challenge.length > 0);
    // SECURITY: register-begin must NOT persist a customer row before the
    // WebAuthn ceremony completes — the row is created only on a verified
    // register-finish. An abandoned (or scripted) begin therefore can't squat
    // an email or mint junk accounts. The pending signup rides in the sealed
    // challenge cookie until finish.
    check("new-email register-begin persists NO customer row yet",
                                                 (await customers.byEmailHash(customers.hashEmail("newcomer@example.com"))) === null);

    // ---- profile edit -------------------------------------------------
    var profGet = await helpers.httpRequest({ port: handle.port, path: "/account/profile", jar: jarA });
    check("profile page then 200",                profGet.status === 200);
    check("profile pre-fills display name",        profGet.body.indexOf("value=\"Alice\"") !== -1);
    check("profile email field disabled",          profGet.body.indexOf("disabled") !== -1);

    var profPost = await helpers.httpRequest({ port: handle.port, path: "/account/profile", method: "POST", jar: jarA, form: { display_name: "Alice Cooper" } });
    check("profile update then 303",              profPost.status === 303 && (profPost.headers["location"] || "") === "/account/profile?ok=updated");
    var beforeHash = custA.email_hash;
    var afterEdit = await customers.get(custA.id);
    check("display name persisted",               afterEdit.display_name === "Alice Cooper");
    check("email hash unchanged by edit",          afterEdit.email_hash === beforeHash);

    // Bad display name (control bytes) re-renders 400 with the value kept.
    var profBad = await helpers.httpRequest({ port: handle.port, path: "/account/profile", method: "POST", jar: jarA, form: { display_name: "" } });
    check("profile empty name then 400",          profBad.status === 400);
    check("profile 400 shows error notice",        profBad.body.indexOf("form-notice--error") !== -1);

    // PRG success notice renders on the redirected GET.
    var profOk = await helpers.httpRequest({ port: handle.port, path: "/account/profile?ok=updated", jar: jarA });
    check("profile success notice via role=status", profOk.body.indexOf("role=\"status\"") !== -1 && profOk.body.indexOf("Profile updated.") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
