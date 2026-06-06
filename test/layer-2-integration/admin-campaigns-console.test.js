"use strict";
/**
 * Email-campaign admin console — the consent-gated broadcast surface.
 *
 * Boots b.createApp with admin.mount wired to the emailCampaigns
 * primitive (composed over the newsletter subscriber list, mailing
 * audiences, and email suppressions — the same primitives server.js
 * wires). Customer email is stored hash-only in this store, so the
 * newsletter list is the ONLY deliverable-address source; the test seeds
 * subscribers there and drives the whole authoring → preview → send
 * lifecycle through the browser cookie surface and the bearer JSON
 * contract, asserting the consent invariants that are the design center:
 *
 *   - create a campaign targeting a mailing audience -> appears in
 *     /admin/campaigns
 *   - the detail screen resolves the REACHABLE count live: only
 *     marketing-consented (newsletter-subscribed, not suppressed)
 *     subscribers count, never the raw audience membership
 *   - preview renders escape-by-default: a <script> in the body lands as
 *     text, never executable markup (no stored XSS into the console)
 *   - send (broadcast) reaches ONLY the consented subscribers; an
 *     unsubscribed subscriber and a marketing-suppressed one are skipped
 *   - every sent message carries the RFC 8058 one-click List-Unsubscribe
 *     header pair plus an in-body unsubscribe link
 *   - a subscriber who unsubscribes AFTER the send starts is honored
 *     mid-send (per-recipient consent re-check at the send moment)
 *   - test-send mails one operator-supplied address, bypassing the
 *     audience gate
 *   - a bad create -> clean 4xx / err redirect, no partial write
 *   - the bearer JSON contract returns the data; anon -> the sign-in form
 *
 * The mailer is a capture stub (records every send); network: zero.
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

var TOKEN = "admin-token-0123456789abcdef-test";
var MIGS = [
  "0001_catalog.sql", "0002_cart.sql", "0003_order.sql",
  "0004_shop_config.sql", "0006_customers.sql",
  "0010_newsletter_signups.sql", "0014_newsletter_unsubscribe_tokens.sql",
  "0028_email_suppressions.sql", "0056_mailing_audiences.sql",
  "0087_email_campaigns.sql", "0212_email_campaign_sends.sql",
].map(function (n) { return nodePath.resolve(__dirname, "..", "..", "migrations-d1", n); });

function _split(t) { return t.replace(/--[^\n]*\n/g, "\n").split(/;\s*(?:\n|$)/).map(function (s) { return s.trim(); }).filter(Boolean); }
function _makeDb() {
  var db = new DatabaseSync(":memory:");
  db.prepare("PRAGMA foreign_keys = ON").run();
  MIGS.forEach(function (p) { _split(nodeFs.readFileSync(p, "utf8")).forEach(function (s) { db.prepare(s).run(); }); });
  return db;
}
function _query(db) {
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

async function _run() {
  var db    = _makeDb();
  var query = _query(db);

  var catalog    = bShop.catalog.create({ query: query });
  var order      = bShop.order.create({ query: query, cursorSecret: "camp-console-order" });
  var config     = bShop.config.create({ query: query });
  var newsletter = bShop.newsletter.create({ query: query });
  var suppressions = bShop.emailSuppressions.create({ query: query, cursorSecret: "camp-suppress-cursor-secret-test-value" });
  var audiences  = bShop.mailingAudiences.create({
    query: query, newsletter: newsletter, emailSuppressions: suppressions,
    cursorSecret: "camp-audience-cursor-secret-test-value",
  });

  // Capture mailer — records every send; mid-send hook lets us unsubscribe
  // a recipient AFTER the broadcast starts to prove the send-moment
  // consent re-check.
  var sent = [];
  var onSend = null;
  var mailer = { send: async function (msg) { sent.push(msg); if (onSend) await onSend(msg); return { ok: true, id: "m" + sent.length }; } };

  var emailCampaigns = bShop.emailCampaigns.create({
    query: query, mailingAudiences: audiences, email: mailer,
    emailSuppressions: suppressions, newsletter: newsletter,
    unsubscribeBaseUrl: "https://shop.example", listId: "marketing.shop.example",
    sendRatePerMin: 1000,
  });

  // Four subscribers: alice (consented), bob (unsubscribed), carol
  // (marketing-suppressed), dave (consented — unsubscribed mid-send).
  // Seed the signup rows with EXPLICIT, lexicographically-ordered ids so
  // the audience membership cache (ordered signup_id ASC) drains in a
  // deterministic order — alice first, dave last. The mid-send
  // unsubscribe of dave (fired on alice's send below) then reliably
  // lands before dave is reached, proving the per-recipient consent
  // re-check at the send moment. v7-uuid signups would tie on the same
  // millisecond and sort by their random tail, making the order (and the
  // assertion) flaky.
  var nlNow = Date.now();
  async function _seedSignup(seqChar, email) {
    var id = "0000000a-0000-7000-8000-00000000000" + seqChar;
    var hash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, email);
    await query(
      "INSERT INTO newsletter_signups (id, email_hash, email_normalized, source, created_at) VALUES (?1, ?2, ?3, 'storefront-footer', ?4)",
      [id, hash, email, nlNow],
    );
    return id;
  }
  await _seedSignup("1", "alice@example.com");
  await _seedSignup("2", "bob@example.com");
  await _seedSignup("3", "carol@example.com");
  await _seedSignup("4", "dave@example.com");
  var bobHash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, "bob@example.com");
  await query("UPDATE newsletter_signups SET unsubscribed_at = ?1 WHERE email_hash = ?2", [Date.now(), bobHash]);
  await suppressions.add({ email: "carol@example.com", suppression_type: "unsubscribe", scope: "marketing", reason: "opted out" });
  await audiences.defineAudience({ slug: "all-news", title: "All subscribers", rules: { source_in: ["storefront-footer"] } });
  await audiences.recompute();

  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-camp-console-"));
  var app = await b.createApp({
    dataDir: dataDir, vault: { mode: "plaintext" }, db: { atRest: "plain", auditSigning: { mode: "plaintext" } },
    middleware: { botGuard: false, rateLimit: false },
    routes: function (r) {
      r.use(b.middleware.bodyParser());
      bShop.admin.mount(r, {
        token: TOKEN, shop_name: "Test Shop", catalog: catalog, order: order, config: config,
        emailCampaigns: emailCampaigns, mailingAudiences: audiences,
      });
    },
  });
  var bound = await app.listen({ port: 0, host: "127.0.0.1" });
  var port = bound.port;
  var bearer = { authorization: "Bearer " + TOKEN };

  try {
    var jar = helpers.cookieJar();
    var login = await helpers.httpRequest({ port: port, path: "/admin/login", method: "POST", form: { token: TOKEN }, jar: jar });
    check("admin login then 303", login.status === 303);

    // ---- nav + empty state ---------------------------------------------
    var emptyList = await helpers.httpRequest({ port: port, path: "/admin/campaigns", jar: jar });
    check("campaigns list then 200",        emptyList.status === 200);
    check("nav links to campaigns",          emptyList.body.indexOf("href=\"/admin/campaigns\"") !== -1);
    check("empty state shown",               emptyList.body.indexOf("No campaigns yet") !== -1);
    check("broadcast wired -> no unavailable banner", emptyList.body.indexOf("Sending is unavailable") === -1);

    // ---- new-campaign form offers the audience picker ------------------
    var newForm = await helpers.httpRequest({ port: port, path: "/admin/campaigns/new", jar: jar });
    check("new-campaign form then 200",      newForm.status === 200);
    check("new form posts to /admin/campaigns", newForm.body.indexOf("action=\"/admin/campaigns\"") !== -1);
    check("new form lists the seeded audience", newForm.body.indexOf("All subscribers") !== -1);

    // ---- create with a hostile body -> escape-by-default preview -------
    var create = await helpers.httpRequest({
      port: port, path: "/admin/campaigns", method: "POST", jar: jar,
      form: {
        slug: "spring-launch", subject: "Spring is here",
        body_html: "# Big news\n\nVisit [our shop](https://shop.example/sale) <script>alert(1)</script>",
        audience_slug: "all-news", from_address: "news@shop.example", from_name: "Test Shop",
      },
    });
    check("create then 303",                 create.status === 303);
    check("create redirects ?saved",         (create.headers.location || "").indexOf("saved=1") !== -1);
    var persisted = await emailCampaigns.getCampaign("spring-launch");
    check("campaign persisted as draft",     persisted && persisted.status === "draft");

    var list = await helpers.httpRequest({ port: port, path: "/admin/campaigns", jar: jar });
    check("list shows the campaign subject", list.body.indexOf("Spring is here") !== -1);

    // ---- detail: reachable count + escape-by-default preview -----------
    var detail = await helpers.httpRequest({ port: port, path: "/admin/campaigns/spring-launch", jar: jar });
    check("detail then 200",                 detail.status === 200);
    check("detail resolves reachable=2 (alice + dave; bob unsub, carol suppressed)",
      detail.body.indexOf(">2</p>") !== -1 || /Reachable[\s\S]*?<p class="big-stat">2</.test(detail.body));
    check("preview escapes a script payload (no executable markup)",
      detail.body.indexOf("<script>alert(1)</script>") === -1 && detail.body.indexOf("&lt;script&gt;") !== -1);
    check("preview renders the safe https link",
      detail.body.indexOf("href=\"https://shop.example/sale\"") !== -1);

    var detailJson = await helpers.httpRequest({ port: port, path: "/admin/campaigns/spring-launch", headers: bearer });
    var dj = JSON.parse(detailJson.body);
    check("bearer detail exposes reachability.reachable=2", dj.reachability && dj.reachability.reachable === 2);
    check("bearer detail exposes can_broadcast",            dj.can_broadcast === true);

    // ---- test-send mails one operator address, bypassing the gate ------
    sent.length = 0;
    var test = await helpers.httpRequest({
      port: port, path: "/admin/campaigns/spring-launch/test", method: "POST", jar: jar,
      form: { to: "operator@shop.example" },
    });
    check("test-send then 303",              test.status === 303);
    check("test-send redirects ?tested",     (test.headers.location || "").indexOf("tested=1") !== -1);
    check("test-send mailed exactly the operator address",
      sent.length === 1 && sent[0].to === "operator@shop.example");
    check("test-send subject is marked [TEST]", /^\[TEST\]/.test(sent[0].subject));

    // ---- send: only consented subscribers receive; dave unsubscribes
    //      MID-SEND and is honored ---------------------------------------
    sent.length = 0;
    onSend = async function (msg) {
      // The first real broadcast send (alice) triggers dave's mid-send
      // unsubscribe — the per-recipient consent re-check must then skip him.
      if (msg.to === "alice@example.com") {
        var daveHash = b.crypto.namespaceHash(newsletter.EMAIL_NAMESPACE, "dave@example.com");
        await query("UPDATE newsletter_signups SET unsubscribed_at = ?1 WHERE email_hash = ?2", [Date.now(), daveHash]);
      }
    };
    var send = await helpers.httpRequest({
      port: port, path: "/admin/campaigns/spring-launch/send", method: "POST", jar: jar, form: {},
    });
    check("send then 303",                   send.status === 303);
    check("send redirects ?sent",            (send.headers.location || "").indexOf("sent=1") !== -1);

    var recipients = sent.map(function (m) { return m.to; });
    check("only alice received (bob unsub, carol suppressed, dave unsub mid-send)",
      sent.length === 1 && recipients.indexOf("alice@example.com") !== -1);
    check("bob (unsubscribed) did NOT receive",   recipients.indexOf("bob@example.com") === -1);
    check("carol (suppressed) did NOT receive",   recipients.indexOf("carol@example.com") === -1);
    check("dave (unsubscribed mid-send) did NOT receive", recipients.indexOf("dave@example.com") === -1);

    // ---- RFC 8058 one-click unsubscribe headers + in-body link ---------
    var aliceMsg = sent[0];
    check("sent message carries List-Unsubscribe header",
      aliceMsg.headers && typeof aliceMsg.headers["List-Unsubscribe"] === "string" && aliceMsg.headers["List-Unsubscribe"].indexOf("https://") !== -1);
    check("sent message carries the RFC 8058 one-click Post header",
      aliceMsg.headers && aliceMsg.headers["List-Unsubscribe-Post"] === "List-Unsubscribe=One-Click");
    check("sent message carries List-Id",
      aliceMsg.headers && aliceMsg.headers["List-Id"] === "<marketing.shop.example>");
    check("sent body carries an in-body unsubscribe link",
      aliceMsg.html.indexOf("/newsletter/unsubscribe?token=") !== -1);

    // ---- send ledger rollup reflects every consent decision ------------
    var counts = await emailCampaigns.sendCounts("spring-launch");
    check("ledger: 1 sent",                  counts.sent === 1);
    check("ledger: 1 skipped_unsubscribed (dave mid-send)", counts.skipped_unsubscribed === 1);
    var afterSend = await emailCampaigns.getCampaign("spring-launch");
    check("campaign transitioned to sent",   afterSend.status === "sent");

    // The detail screen now shows the delivery counts.
    var detailAfter = await helpers.httpRequest({ port: port, path: "/admin/campaigns/spring-launch", jar: jar });
    check("detail shows the sent count",     detailAfter.body.indexOf(">Sent<") !== -1);

    // A re-send of a terminal campaign is refused cleanly (400, no resend).
    sent.length = 0;
    var resend = await helpers.httpRequest({
      port: port, path: "/admin/campaigns/spring-launch/send", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" }, body: "{}",
    });
    check("re-send of a sent campaign is 4xx", resend.status >= 400 && resend.status < 500);
    check("re-send mailed nobody",           sent.length === 0);

    // ---- bad create -> clean 4xx, no partial write ---------------------
    var badCreate = await helpers.httpRequest({
      port: port, path: "/admin/campaigns", method: "POST",
      headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
      body: JSON.stringify({ slug: "no-subject", body_html: "x", audience_slug: "all-news", from_address: "x@y.com", from_name: "X" }),
    });
    check("missing-subject create then 4xx", badCreate.status >= 400 && badCreate.status < 500);
    check("bad create body has no stack frame", !/\n\s+at\s+\S+\s*\(/.test(badCreate.body));
    check("bad create wrote nothing",        !(await emailCampaigns.getCampaign("no-subject")));

    // ---- unknown slug -> 404; anon -> sign-in form ---------------------
    var missing = await helpers.httpRequest({ port: port, path: "/admin/campaigns/no-such", headers: bearer });
    check("unknown slug detail then 404",    missing.status === 404);
    var anon = await helpers.httpRequest({ port: port, path: "/admin/campaigns" });
    check("anon campaigns -> sign-in form",  anon.status === 200 && anon.body.indexOf("Admin API key") !== -1);
  } finally {
    try { await app.shutdown(); } catch (_e) { /* */ }
    try { nodeFs.rmSync(dataDir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };

if (require.main === module) {
  _run().then(function () {
    process.stdout.write("admin-campaigns-console: " + helpers.getChecks() + " checks passed\n");
  }).catch(function (e) { process.stderr.write(String(e && e.stack || e) + "\n"); process.exit(1); });
}
