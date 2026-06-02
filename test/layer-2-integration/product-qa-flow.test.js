"use strict";
/**
 * Product Q&A — full HTTP integration of the ask / moderate / display
 * flow.
 *
 * Boots a real `b.createApp` HTTP server with the storefront mounted the
 * way `server.js` mounts it, wired with the productQa + customers deps so
 * the auth-gated ask-a-question route is live. Catalog + cart + productQa
 * all run against one in-memory `node:sqlite` database loaded from the
 * live migrations, so every CHECK / FK the production D1 enforces is
 * exercised end-to-end.
 *
 * Auth: asking a question requires a logged-in customer (no verified-
 * purchase gate). The route reads only `{ customer_id, exp }` from the
 * sealed `shop_auth` cookie, so the test mints the cookie directly via
 * `b.vault.seal` after boot rather than driving a WebAuthn ceremony. The
 * customers primitive is wired, so the questioner's customer row must
 * exist — the test seeds it.
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

var MIGS = ["0001_catalog.sql", "0002_cart.sql", "0006_customers.sql", "0133_product_qa.sql"]
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

// Raw-insert a customer row so the wired customers primitive's existence
// check passes when the questioner stamps a question.
async function _seedCustomer(query, customerId) {
  var now = Date.now();
  await query(
    "INSERT INTO customers (id, email_hash, display_name, created_at, updated_at) " +
    "VALUES (?1, ?2, 'Test Asker', ?3, ?3)",
    [customerId, b.crypto.namespaceHash("test-customer", customerId), now],
  );
}

async function _bootApp(deps) {
  var dataDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-shop-qa-"));
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
  var query   = _makeQuery();
  var catalog = bShop.catalog.create({ query: query });
  var cart    = bShop.cart.create({ query: query, catalog: catalog });
  var customers = bShop.customers.create({ query: query });
  var productQa = bShop.productQA.create({ query: query, customers: customers });

  var product = await catalog.products.create({ slug: "widget-pro", title: "Widget Pro", description: "Pro widget.", status: "active" });
  var variant = await catalog.variants.create(product.id, { sku: "WDG-PRO-L", options: { size: "L" } });
  await catalog.prices.set(variant.id, { currency: "USD", amount_minor: 2999 });

  var askerId = b.uuid.v7();
  await _seedCustomer(query, askerId);

  var handle = await _bootApp({ catalog: catalog, cart: cart, customers: customers, productQa: productQa });

  try {
    var P = "/products/widget-pro/question";

    // A jar for the asker: the authenticated GET form below seeds the
    // double-submit CSRF cookie, echoed as X-CSRF-Token on the ask POSTs
    // (the real gate, no bypass).
    var askerJar = helpers.cookieJar();
    askerJar.capture({ "set-cookie": [_authCookie(askerId)] });

    // PDP shows the Q&A section + CTA, empty state before any question.
    var pdp0 = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows Q&A section",                pdp0.body.indexOf("Questions &amp; answers") !== -1);
    check("pdp shows ask-a-question CTA",          pdp0.body.indexOf("/products/widget-pro/question") !== -1);
    check("pdp empty-Q&A state",                   pdp0.body.indexOf("No questions yet") !== -1);

    // GET form, not logged in → redirect to login.
    var anon = await helpers.httpRequest({ port: handle.port, path: P });
    check("form GET anon → 303",                   anon.status === 303);
    check("form GET anon → /account/login",        (anon.headers["location"] || "") === "/account/login");

    // GET form, logged in → the form renders.
    var askerForm = await helpers.httpRequest({ port: handle.port, path: P, jar: askerJar });
    check("form GET asker → 200",                  askerForm.status === 200);
    check("form GET asker → question textarea",    askerForm.body.indexOf("name=\"body\"") !== -1);
    check("form GET asker → review-form class",    askerForm.body.indexOf("class=\"review-form\"") !== -1);

    // POST submit, empty body → 400 + form with notice (malformed input).
    var badPost = await helpers.httpRequest({
      port: handle.port, path: P, method: "POST",
      jar: askerJar,
      form: { body: "" },
    });
    check("submit empty body → 400",               badPost.status === 400);
    check("submit empty body → notice shown",      badPost.body.indexOf("form-notice--error") !== -1);
    // WCAG 3.3.1/3.3.3 — the rejected body textarea is marked + wired.
    check("empty body → aria-invalid on textarea",  badPost.body.indexOf("aria-invalid=\"true\"") !== -1);
    check("empty body → error span wired",          badPost.body.indexOf("id=\"qa-err-body\"") !== -1 && badPost.body.indexOf("aria-describedby=\"qa-err-body\"") !== -1);
    check("clean Q&A form GET has no aria-invalid",  askerForm.body.indexOf("aria-invalid") === -1);

    // POST submit, valid → 200 thanks; question lands pending.
    var ok = await helpers.httpRequest({
      port: handle.port, path: P, method: "POST",
      jar: askerJar,
      form: { body: "Is this dishwasher safe?" },
    });
    check("submit asker valid → 200",              ok.status === 200);
    check("submit asker valid → thanks copy",      ok.body.indexOf("pending moderation") !== -1);

    var pending = await productQa.listQuestionsByStatus("pending", { limit: 10 });
    check("one pending question persisted",        pending.length === 1);
    var questionId = pending[0].id;

    // Pending question is NOT shown on the PDP.
    var pdpPending = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp hides pending question",            pdpPending.body.indexOf("dishwasher safe") === -1);
    check("pdp still empty-state pre-approve",     pdpPending.body.indexOf("No questions yet") !== -1);

    // Operator approves the question → it surfaces on the PDP.
    await productQa.approveQuestion(questionId);
    var pdpApproved = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows approved question",           pdpApproved.body.indexOf("Is this dishwasher safe?") !== -1);
    check("pdp shows awaiting-answer state",       pdpApproved.body.indexOf("Awaiting an answer") !== -1);

    // Operator posts an answer (lands pending → not shown until approved).
    var answer = await productQa.submitAnswer({ question_id: questionId, author: "operator", body: "Yes, top rack only." });
    var pdpAnsPending = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp hides pending answer",              pdpAnsPending.body.indexOf("top rack only") === -1);

    // Approve the answer → it shows with the seller badge.
    await productQa.approveAnswer(answer.id);
    var pdpAnswered = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows approved answer",             pdpAnswered.body.indexOf("Yes, top rack only.") !== -1);
    check("pdp shows seller-answer badge",         pdpAnswered.body.indexOf("Answered by the seller") !== -1);

    // Pin the answer → it carries the top-answer badge.
    await productQa.pinAnswer(answer.id);
    var pdpPinned = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp shows top-answer badge",            pdpPinned.body.indexOf("Top answer") !== -1);

    // Reject path: a second question, then reject → hidden on the PDP.
    var q2 = await productQa.submitQuestion({ product_id: product.id, customer_id: askerId, body: "What is the warranty?" });
    await productQa.rejectQuestion(q2.id, "spam");
    var pdpRejected = await helpers.httpRequest({ port: handle.port, path: "/products/widget-pro" });
    check("pdp hides rejected question",           pdpRejected.body.indexOf("What is the warranty?") === -1);

    // Failure mode: unknown product slug on the form route → 404.
    var noProd = await helpers.httpRequest({
      port: handle.port, path: "/products/does-not-exist/question",
      jar: askerJar,
    });
    check("form GET unknown product → 404",        noProd.status === 404);

    // Failure mode: moderation of a bad id is a no-op error, not a throw.
    var threw = false;
    try { await productQa.approveQuestion(b.uuid.v7()); }
    catch (e) { threw = true; check("approve unknown id → not-found code", e && e.code === "PRODUCT_QA_QUESTION_NOT_FOUND"); }
    check("approve unknown id rejected",           threw);
  } finally {
    await _teardown(handle);
  }
}

module.exports = { run: _run };
