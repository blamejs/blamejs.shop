"use strict";
/**
 * email — order receipt, ship notification, refund confirmation.
 *
 * Layer 1 against b.mail's memory transport so every send is
 * recorded for assertion without a real SMTP server.
 *
 * Coverage:
 *   - orderReceipt renders subject + html + text + sends via mailer
 *   - shipNotification with tracking object
 *   - refundConfirmation with amount_minor
 *   - HTML-escapes injected variables (XSS guard)
 *   - strict {{var}} renderer refuses unknown / missing variables
 *   - rejects malformed customer.email
 */

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var b     = bShop.framework;
var email = bShop.email;

function _setup() {
  var sent = [];
  // Inline fake mailer matching b.mail.create result shape — minimum
  // surface email.create needs is .send(msg).
  var mailer = {
    send: async function (msg) {
      sent.push(msg);
      return { ok: true, id: "msg_" + sent.length };
    },
  };
  var e = email.create({ mailer: mailer, from: "shop@example.com" });
  return { sent: sent, email: e };
}

function _order() {
  return {
    id:                "ord_test_1",
    currency:          "USD",
    subtotal_minor:    5998,
    tax_minor:         525,
    shipping_minor:    695,
    grand_total_minor: 7218,
  };
}

async function _orderReceipt() {
  var s = _setup();
  var r = await s.email.orderReceipt({
    order:    _order(),
    customer: { name: "Alice", email: "alice@example.com", tax_jurisdiction: "US/CA" },
  });
  check("orderReceipt returns mailer result", r.ok === true);
  check("one message sent",                    s.sent.length === 1);
  var msg = s.sent[0];
  check("to set",                              msg.to === "alice@example.com");
  check("subject mentions order id",            msg.subject.indexOf("ord_test_1") !== -1);
  check("html includes total",                  msg.html.indexOf("$72.18") !== -1);
  check("text includes total",                  msg.text.indexOf("$72.18") !== -1);
  check("html includes tax jurisdiction",        msg.html.indexOf("US/CA") !== -1);
  check("from set from create",                  msg.from === "shop@example.com");
}

async function _shipNotification() {
  var s = _setup();
  await s.email.shipNotification({
    order:    _order(),
    customer: { name: "Alice", email: "alice@example.com" },
    tracking: { carrier: "UPS", tracking_number: "1Z999AA10123456784" },
  });
  var msg = s.sent[0];
  check("ship subject mentions order",          msg.subject.indexOf("ord_test_1") !== -1);
  check("ship html includes carrier",            msg.html.indexOf("UPS") !== -1);
  check("ship html includes tracking number",    msg.html.indexOf("1Z999AA10123456784") !== -1);
}

async function _refundConfirmation() {
  var s = _setup();
  await s.email.refundConfirmation({
    order:        _order(),
    customer:     { name: "Alice", email: "alice@example.com" },
    amount_minor: 2999,
  });
  var msg = s.sent[0];
  check("refund subject mentions order",         msg.subject.indexOf("ord_test_1") !== -1);
  check("refund html includes amount",            msg.html.indexOf("$29.99") !== -1);
}

async function _htmlEscapes() {
  // XSS attempt via customer name should be escaped in the rendered
  // HTML — the renderer escapes every substituted value.
  var s = _setup();
  await s.email.orderReceipt({
    order:    _order(),
    customer: { name: "<script>alert(1)</script>", email: "x@example.com", tax_jurisdiction: "US" },
  });
  var msg = s.sent[0];
  check("html-escaped <script> in name",  msg.html.indexOf("<script>") === -1);
  check("escaped form present",            msg.html.indexOf("&lt;script&gt;") !== -1);
}

async function _strictRenderer() {
  // Unknown placeholder in a template → throws at render time.
  assert.throws(function () {
    email._render("Hello {{not_a_known_var}}", {});
  }, /unknown variable/);
  // Provided variable not referenced by the template → also throws
  // (catches the "renamed a template field but caller still passes it" bug).
  assert.throws(function () {
    email._render("Hello world", { unused: "x" });
  }, /did not reference variable/);
  // Happy path
  check("strict renderer escapes value",  email._render("Hi {{n}}", { n: "<b>" }) === "Hi &lt;b&gt;");
}

async function _validation() {
  var s = _setup();
  await assert.rejects(s.email.orderReceipt({
    order:    _order(),
    customer: { name: "X", email: "not-an-email", tax_jurisdiction: "US" },
  }), /address/);

  assert.throws(function () {
    email.create({});
  }, /opts\.mailer/);

  await assert.rejects(s.email.shipNotification({ order: _order(), customer: { email: "x@example.com" } }),
    /tracking object required/);

  await assert.rejects(s.email.refundConfirmation({
    order: _order(), customer: { email: "x@example.com" }, amount_minor: -1,
  }), /amount_minor must be a non-negative/);
}

async function run() {
  void b;   // satisfy linter about b being unused — kept available for future extensions
  await _orderReceipt();
  await _shipNotification();
  await _refundConfirmation();
  await _htmlEscapes();
  await _strictRenderer();
  await _validation();
}

module.exports = { run: run };
