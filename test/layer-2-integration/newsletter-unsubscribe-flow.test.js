"use strict";
/**
 * Newsletter unsubscribe — full HTTP integration of the CAN-SPAM /
 * RFC 8058 one-click opt-out flow.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * newsletter dep, against one in-memory `node:sqlite` DB loaded from the
 * live migrations. The unsubscribe token is an opaque, single-use,
 * timing-safe bearer; the GET confirm page + the POST one-click target are
 * both unauthenticated (the token is the credential) and CSRF-exempt.
 *
 * Covers:
 *   - issue a token, GET /unsubscribe?token=… → 200 confirm page with a
 *     POST form that carries the token in a hidden field.
 *   - POST /unsubscribe with the token → 200, the success page (offers a
 *     re-subscribe form), and the signup row is stamped unsubscribed.
 *   - POST again with the same (now-consumed) token → 200, the friendly
 *     "already unsubscribed" page — never a 500.
 *   - an unknown / garbage token → 200, the generic "not valid" page.
 *   - an expired token (a row whose expires_at is in the past) → 200, the
 *     "expired" page.
 *   - re-subscribe via POST /newsletter clears the unsubscribed stamp.
 *   - every response is a clean status with no raw error string leaked.
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

var MIGS = [
  "0001_catalog.sql",
  "0002_cart.sql",
  "0010_newsletter_signups.sql",
  "0014_newsletter_unsubscribe_tokens.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _splitSchema(text) {
  var noComments = text.replace(/--[^\n]*\n/g, "\n");
  return noComments.split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean);
}

function _makeQuery(db) {
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-unsub-"));
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

async function _teardown(handle) {
  if (!handle) return;
  try { await handle.app.shutdown(); } catch (_e) { /* best-effort */ }
  try { nodeFs.rmSync(handle.dataDir, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}

function _unsubStamp(db, emailHash) {
  var row = db.prepare("SELECT unsubscribed_at FROM newsletter_signups WHERE email_hash = ?1").get(emailHash);
  return row ? row.unsubscribed_at : undefined;
}

// A response body must never echo a raw error / stack frame on these
// public, unauthenticated pages.
function _noRawErrorLeak(body) {
  return body.indexOf("TypeError") === -1 &&
         body.indexOf("    at ") === -1 &&
         body.toLowerCase().indexOf("stack") === -1;
}

async function _run() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) {
    var stmts = _splitSchema(nodeFs.readFileSync(p, "utf8"));
    for (var i = 0; i < stmts.length; i += 1) db.prepare(stmts[i]).run();
  });
  var query = _makeQuery(db);

  var catalog    = bShop.catalog.create({ query: query });
  var cart       = bShop.cart.create({ query: query, catalog: catalog });
  var newsletter = bShop.newsletter.create({ query: query });

  await catalog.products.create({ slug: "widget", title: "Widget", description: "x", status: "active" });

  var handle = await _bootApp({ catalog: catalog, cart: cart, newsletter: newsletter });

  try {
    // ---- enroll an address + issue a one-shot unsubscribe token --------
    var signup = await newsletter.signup({ email: "reader@example.com", source: "storefront-footer" });
    check("signup created", signup.status === "new");
    var emailHash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, "reader@example.com");
    check("signup is active (no unsubscribe stamp)", _unsubStamp(db, emailHash) == null);

    var issued = await newsletter.issueUnsubscribeToken(signup.id);
    var token = issued.token;
    check("token issued", typeof token === "string" && token.length > 0);

    // ---- GET confirm page (200) ----------------------------------------
    var confirm = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe?token=" + encodeURIComponent(token),
    });
    check("confirm page 200",                 confirm.status === 200);
    check("confirm page has unsubscribe form", confirm.body.indexOf("action=\"/unsubscribe\"") !== -1);
    check("confirm page carries the token",    confirm.body.indexOf("name=\"token\"") !== -1 &&
                                               confirm.body.indexOf(token) !== -1);
    check("confirm page is a confirm prompt",  confirm.body.indexOf("Unsubscribe from the list?") !== -1);
    check("confirm page no raw error",         _noRawErrorLeak(confirm.body));
    // The token-bearer page is kept out of search.
    check("confirm page is noindex",           confirm.body.indexOf("content=\"noindex,nofollow\"") !== -1);

    // ---- POST consume → success (unsubscribed) -------------------------
    var unsub = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST", form: { token: token },
    });
    check("unsubscribe POST 200",                 unsub.status === 200);
    check("unsubscribe success copy",             unsub.body.indexOf("You're unsubscribed.") !== -1);
    check("unsubscribe offers re-subscribe form", unsub.body.indexOf("action=\"/newsletter\"") !== -1);
    check("unsubscribe POST no raw error",        _noRawErrorLeak(unsub.body));
    var stampAfter = _unsubStamp(db, emailHash);
    check("signup row stamped unsubscribed", stampAfter != null && Number(stampAfter) > 0);

    // ---- POST again with the consumed token → already-unsubscribed -----
    var again = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST", form: { token: token },
    });
    check("repeat unsubscribe is 200 (not 500)", again.status === 200);
    check("repeat shows already-unsubscribed",   again.body.indexOf("Already unsubscribed.") !== -1);
    check("repeat no raw error",                 _noRawErrorLeak(again.body));

    // ---- unknown / garbage token → friendly not-valid ------------------
    var bogus = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST", form: { token: "not-a-real-token" },
    });
    check("bogus token is 200 (not 500)", bogus.status === 200);
    check("bogus token shows not-valid",  bogus.body.indexOf("This link isn't valid.") !== -1);
    check("bogus token no raw error",     _noRawErrorLeak(bogus.body));

    // an empty token is handled identically (the consume API returns
    // not-found for an empty bearer).
    var empty = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST", form: { token: "" },
    });
    check("empty token is 200 (not 500)", empty.status === 200);
    check("empty token shows not-valid",  empty.body.indexOf("This link isn't valid.") !== -1);

    // ---- expired token → friendly expired page -------------------------
    // Enroll a second address + insert an unsubscribe token row whose
    // expires_at is already in the past, then consume it over HTTP.
    var s2 = await newsletter.signup({ email: "lapsed@example.com", source: "storefront-footer" });
    var plaintext2 = "expired-token-fixture-aaaaaaaaaaaa";
    var tokenHash2 = b.crypto.namespaceHash("newsletter-unsubscribe", plaintext2);
    var past = Date.now() - 1000;
    await query(
      "INSERT INTO newsletter_unsubscribe_tokens (token_hash, signup_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
      [tokenHash2, s2.id, past - 1000, past]
    );
    var expired = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST", form: { token: plaintext2 },
    });
    check("expired token is 200 (not 500)", expired.status === 200);
    check("expired token shows expired page", expired.body.indexOf("That link has expired.") !== -1);
    check("expired token no raw error",     _noRawErrorLeak(expired.body));
    // The expired path did NOT unsubscribe the second address.
    var emailHash2 = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, "lapsed@example.com");
    check("expired token left the address subscribed", _unsubStamp(db, emailHash2) == null);

    // ---- re-subscribe clears the stamp ---------------------------------
    var resub = await newsletter.resubscribe({ email: "reader@example.com" });
    check("resubscribe ok",            resub.ok === true);
    check("resubscribe cleared stamp", _unsubStamp(db, emailHash) == null);

    // The first address can be issued a fresh token + unsubscribed again
    // (full round-trip after re-subscribing).
    var reIssued = await newsletter.issueUnsubscribeToken(signup.id);
    var reUnsub = await helpers.httpRequest({
      port: handle.port, path: "/unsubscribe", method: "POST", form: { token: reIssued.token },
    });
    check("re-issued token unsubscribes again", reUnsub.status === 200 &&
                                                reUnsub.body.indexOf("You're unsubscribed.") !== -1);
    check("re-unsubscribed stamp set again", _unsubStamp(db, emailHash) != null);

    // ---- RFC 8058 native one-click POST (token in the URL, not the body) ----
    // A mail client fires List-Unsubscribe-Post at the EXACT List-Unsubscribe
    // URL with a `List-Unsubscribe=One-Click` body and NO token of its own.
    // The handler must read the token from the `?token=` query string — the
    // earlier shape read body.token, so a native one-click carried no token
    // and never unsubscribed. No cookie / CSRF token (the path is in
    // EDGE_POST_PATHS) — the URL token IS the bearer.
    await newsletter.resubscribe({ email: "reader@example.com" });
    check("one-click setup: re-subscribed", _unsubStamp(db, emailHash) == null);
    var oneClickIssued = await newsletter.issueUnsubscribeToken(signup.id);
    var oneClick = await helpers.httpRequest({
      port:   handle.port,
      path:   "/unsubscribe?token=" + encodeURIComponent(oneClickIssued.token),
      method: "POST",
      form:   { "List-Unsubscribe": "One-Click" },   // the RFC 8058 body — no `token` field
    });
    check("one-click POST is 200",            oneClick.status === 200);
    check("one-click POST unsubscribes",      oneClick.body.indexOf("You're unsubscribed.") !== -1);
    check("one-click POST stamped the row",   _unsubStamp(db, emailHash) != null);

    // Idempotent: the mail client may re-fire; a second one-click POST of the
    // consumed token is the friendly already-page, never a 500.
    var oneClickAgain = await helpers.httpRequest({
      port:   handle.port,
      path:   "/unsubscribe?token=" + encodeURIComponent(oneClickIssued.token),
      method: "POST",
      form:   { "List-Unsubscribe": "One-Click" },
    });
    check("repeat one-click is 200 (not 500)", oneClickAgain.status === 200);
    check("repeat one-click already-page",     oneClickAgain.body.indexOf("Already unsubscribed.") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
