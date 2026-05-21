"use strict";
/**
 * @module shop.email
 * @title  Transactional email — composed on b.mail
 *
 * @intro
 *   Operator-facing transactional templates: order receipt, ship
 *   notification, refund confirmation. Composed on `b.mail` (DKIM /
 *   SPF / DMARC / BIMI / ARC owned upstream — we just hand the
 *   mailer a templated message). Templates render via a strict
 *   `{{var}}` substitution with HTML-escaped values; the theme
 *   primitive will swap these for `b.template`-backed renders when
 *   it lands.
 *
 *   The factory takes an injected mailer (a `b.mail.create(...)`
 *   result) so operators choose the transport once at boot:
 *
 *     var mailer = b.mail.create({
 *       transport: b.mail.transports.smtp({ host, port, ... }),
 *       defaults:  { from: "shop@example.com" },
 *     });
 *     var email = bShop.email.create({ mailer: mailer });
 *
 *   For dev / tests, `b.mail.transports.memory()` records every
 *   send in an in-memory array so the smoke gate can assert on the
 *   message shape without a real SMTP server.
 */

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

var HTML_ESCAPE_MAP = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
};
function _htmlEscape(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, function (c) { return HTML_ESCAPE_MAP[c]; });
}

// Strict {{var}} renderer. Refuses unrecognized placeholders so a
// typo in the template surfaces at render time instead of leaking
// `{{customer_name}}` literal text into a customer-facing email.
function _render(template, vars) {
  var seen = new Set();
  var out = template.replace(/\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/gi, function (_match, key) {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      throw new Error("email: template references unknown variable {{" + key + "}}");
    }
    seen.add(key);
    return _htmlEscape(vars[key]);
  });
  // Surface unused vars too — silent ignore is rarely what the caller
  // meant, and catches the common bug of renaming a template field
  // without updating its caller.
  Object.keys(vars).forEach(function (k) {
    if (!seen.has(k)) {
      throw new Error("email: template did not reference variable " + JSON.stringify(k));
    }
  });
  return out;
}

function _formatMoney(amountMinor, currency) {
  // Delegate to pricing.format so locale + zero-decimal currency
  // handling stays consistent across surfaces. pricing is required
  // — the email module ships with it as a peer in lib/index.js.
  return _b() && require("./pricing").format(amountMinor, currency);
}

// ---- templates ----------------------------------------------------------
//
// Inline HTML — terse, customer-facing. Each template declares its
// required variable set so the renderer can refuse unknown / missing
// keys at composition time. Plain-text alternate parts use the same
// data; mail clients pick whichever they prefer.

var ORDER_RECEIPT_HTML =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Order receipt — {{order_id}}</title></head><body>\n" +
  "<h1>Thanks for your order</h1>\n" +
  "<p>Hi {{customer_name}},</p>\n" +
  "<p>We've received your order <strong>{{order_id}}</strong>. Here's a summary:</p>\n" +
  "<table border=\"0\" cellpadding=\"6\" cellspacing=\"0\">\n" +
  "  <tr><td>Subtotal</td><td align=\"right\">{{subtotal_formatted}}</td></tr>\n" +
  "  <tr><td>Tax ({{tax_jurisdiction}})</td><td align=\"right\">{{tax_formatted}}</td></tr>\n" +
  "  <tr><td>Shipping</td><td align=\"right\">{{shipping_formatted}}</td></tr>\n" +
  "  <tr><td><strong>Total</strong></td><td align=\"right\"><strong>{{grand_total_formatted}}</strong></td></tr>\n" +
  "</table>\n" +
  "<p>We'll email you again when your order ships.</p>\n" +
  "</body></html>\n";

var ORDER_RECEIPT_TEXT =
  "Thanks for your order, {{customer_name}}.\n\n" +
  "Order: {{order_id}}\n" +
  "Subtotal:                  {{subtotal_formatted}}\n" +
  "Tax ({{tax_jurisdiction}}):                {{tax_formatted}}\n" +
  "Shipping:                  {{shipping_formatted}}\n" +
  "-------------------------------------\n" +
  "Total:                     {{grand_total_formatted}}\n\n" +
  "We'll email you again when your order ships.\n";

var SHIP_NOTIFICATION_HTML =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Your order is on its way</title></head><body>\n" +
  "<h1>Your order shipped</h1>\n" +
  "<p>Hi {{customer_name}},</p>\n" +
  "<p>Order <strong>{{order_id}}</strong> is on its way via {{carrier}}.</p>\n" +
  "<p>Tracking: <code>{{tracking_number}}</code></p>\n" +
  "</body></html>\n";

var SHIP_NOTIFICATION_TEXT =
  "Hi {{customer_name}},\n\n" +
  "Order {{order_id}} is on its way via {{carrier}}.\n" +
  "Tracking: {{tracking_number}}\n";

var REFUND_HTML =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Refund issued</title></head><body>\n" +
  "<h1>Refund issued</h1>\n" +
  "<p>Hi {{customer_name}},</p>\n" +
  "<p>We've issued a refund of <strong>{{amount_formatted}}</strong> against order {{order_id}}.</p>\n" +
  "<p>The funds will appear on your statement within 5-10 business days.</p>\n" +
  "</body></html>\n";

var REFUND_TEXT =
  "Hi {{customer_name}},\n\n" +
  "We've issued a refund of {{amount_formatted}} against order {{order_id}}.\n" +
  "The funds will appear on your statement within 5-10 business days.\n";

// ---- factory ------------------------------------------------------------

function _email(s) {
  // sanitize() only strips unicode / control / bidi smuggling —
  // address-shape rejection is in validate(). Run validate first,
  // then sanitize for canonical form.
  var v = _b().guardEmail.validate(s, { profile: "strict" });
  if (!v.ok) {
    var ruleId = v.issues && v.issues[0] && v.issues[0].ruleId || "shape";
    throw new TypeError("email: address rejected (" + ruleId + ")");
  }
  return _b().guardEmail.sanitize(s, { profile: "strict" });
}

function create(opts) {
  opts = opts || {};
  if (!opts.mailer || typeof opts.mailer.send !== "function") {
    throw new TypeError("email.create: opts.mailer (a b.mail.create result with .send()) is required");
  }
  var mailer = opts.mailer;

  async function _send(to, subject, html, text, replyTo) {
    var msg = {
      to:      _email(to),
      subject: subject,
      html:    html,
      text:    text,
    };
    if (opts.from)         msg.from = opts.from;
    if (opts.from_name)    msg.from_name = opts.from_name;
    if (replyTo)           msg.replyTo = _email(replyTo);
    return await mailer.send(msg);
  }

  function _orderVars(order, customer) {
    if (!order || typeof order !== "object")     throw new TypeError("email: order object required");
    if (!customer || typeof customer !== "object") throw new TypeError("email: customer object required");
    var format = require("./pricing").format;
    return {
      order_id:               order.id,
      customer_name:          customer.name || "there",
      tax_jurisdiction:       customer.tax_jurisdiction || "—",
      subtotal_formatted:     format(order.subtotal_minor,    order.currency),
      tax_formatted:          format(order.tax_minor,         order.currency),
      shipping_formatted:     format(order.shipping_minor,    order.currency),
      grand_total_formatted:  format(order.grand_total_minor, order.currency),
    };
  }

  return {
    orderReceipt: async function (input) {
      if (!input) throw new TypeError("email.orderReceipt: input object required");
      var vars = _orderVars(input.order, input.customer);
      var html = _render(ORDER_RECEIPT_HTML, vars);
      var text = _render(ORDER_RECEIPT_TEXT, vars);
      return await _send(input.customer.email, "Your order " + input.order.id, html, text, input.replyTo);
    },

    shipNotification: async function (input) {
      if (!input) throw new TypeError("email.shipNotification: input object required");
      if (!input.tracking) throw new TypeError("email.shipNotification: tracking object required");
      var vars = {
        order_id:        input.order.id,
        customer_name:   input.customer.name || "there",
        carrier:         input.tracking.carrier || "the carrier",
        tracking_number: input.tracking.tracking_number || "—",
      };
      var html = _render(SHIP_NOTIFICATION_HTML, vars);
      var text = _render(SHIP_NOTIFICATION_TEXT, vars);
      return await _send(input.customer.email, "Your order shipped — " + input.order.id, html, text, input.replyTo);
    },

    refundConfirmation: async function (input) {
      if (!input) throw new TypeError("email.refundConfirmation: input object required");
      if (!Number.isInteger(input.amount_minor) || input.amount_minor < 0) {
        throw new TypeError("email.refundConfirmation: amount_minor must be a non-negative integer");
      }
      var format = require("./pricing").format;
      var vars = {
        order_id:         input.order.id,
        customer_name:    input.customer.name || "there",
        amount_formatted: format(input.amount_minor, input.order.currency),
      };
      var html = _render(REFUND_HTML, vars);
      var text = _render(REFUND_TEXT, vars);
      return await _send(input.customer.email, "Refund issued — " + input.order.id, html, text, input.replyTo);
    },
  };
}

module.exports = {
  create:                  create,
  _render:                 _render,
  // Templates exported so operators forking the framework can swap
  // them without monkey-patching the module. The contract is stable
  // — operators may inject their own strings via opts.templates
  // (added in a follow-up patch alongside b.theme).
  templates: {
    ORDER_RECEIPT_HTML:      ORDER_RECEIPT_HTML,
    ORDER_RECEIPT_TEXT:      ORDER_RECEIPT_TEXT,
    SHIP_NOTIFICATION_HTML:  SHIP_NOTIFICATION_HTML,
    SHIP_NOTIFICATION_TEXT:  SHIP_NOTIFICATION_TEXT,
    REFUND_HTML:             REFUND_HTML,
    REFUND_TEXT:             REFUND_TEXT,
  },
};
