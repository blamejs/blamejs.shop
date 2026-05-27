"use strict";
/**
 * Customer surveys — full HTTP integration of the token-gated feedback flow.
 *
 * Boots a real `b.createApp` server with the storefront wired with the
 * customerSurveys dep, against one in-memory `node:sqlite` DB. An operator
 * defines a survey + issues an invitation (the single-use plaintext token is
 * returned once); the customer then opens /survey/:token, answers, and the
 * response lands in the rollup. The token IS the access — no login.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0128_customer_surveys.sql"]
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
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-srv-"));
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

async function _run() {
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var surveys = bShop.customerSurveys.create({ query: query });

  await surveys.defineSurvey({
    slug: "post-delivery", title: "How did we do?", kind: "nps", trigger: "manual",
    questions: [
      { id: "score", kind: "rating", label: "How likely are you to recommend us?", max: 10, required: true },
      { id: "reason", kind: "free_text", label: "Why?", required: false },
    ],
  });
  var buyerId = b.uuid.v7();
  var issued  = await surveys.issueInvitation({ survey_slug: "post-delivery", customer_id: buyerId });
  var token   = issued.plaintext_token;

  var handle = await _bootApp({ catalog: catalog, cart: cart, customerSurveys: surveys });

  try {
    // A garbage token → a clean 404 notice, never a 500.
    var bad = await helpers.httpRequest({ port: handle.port, path: "/survey/not-a-real-token" });
    check("bad token → 404",                     bad.status === 404);
    check("bad token → not-found notice",        bad.body.indexOf("Survey not found") !== -1);

    // Valid token → the survey form with the question.
    var form = await helpers.httpRequest({ port: handle.port, path: "/survey/" + token });
    check("valid token → 200",                   form.status === 200);
    check("form shows the survey title",         form.body.indexOf("How did we do?") !== -1);
    check("form shows the rating question",       form.body.indexOf("How likely are you to recommend us?") !== -1);
    check("form posts back to the token",        form.body.indexOf("action=\"/survey/" + token + "\"") !== -1);

    // Missing the required answer → re-render the form with a notice (400).
    var blank = await helpers.httpRequest({ port: handle.port, path: "/survey/" + token, method: "POST", form: { "q_reason": "" } });
    check("missing required → 400 re-render",    blank.status === 400 && blank.body.indexOf("How did we do?") !== -1);

    // Answer it → thank-you.
    var submit = await helpers.httpRequest({ port: handle.port, path: "/survey/" + token, method: "POST", form: { "q_score": "9", "q_reason": "Fast and secure." } });
    check("submit → 200 thank-you",              submit.status === 200 && submit.body.indexOf("Thank you") !== -1);

    // The response is in the rollup.
    var roll = await surveys.rollup({ slug: "post-delivery" });
    check("rollup counts the response",          roll.response_count === 1);

    // A second submit on the used token → already-responded notice.
    var again = await helpers.httpRequest({ port: handle.port, path: "/survey/" + token, method: "POST", form: { "q_score": "3" } });
    check("reused token → already-answered",     again.body.indexOf("Already answered") !== -1);

    // And the survey page now shows the responded state on GET too.
    var getDone = await helpers.httpRequest({ port: handle.port, path: "/survey/" + token });
    check("answered token GET → responded state", getDone.body.indexOf("Already answered") !== -1);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
