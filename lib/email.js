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

var b = require("./vendor/blamejs");

function _htmlEscape(s) {
  if (s == null) return "";
  return b.template.escapeHtml(String(s));
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
  return b && require("./pricing").format(amountMinor, currency);
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

// Wishlist discount — a watched product just dropped in price.
// Brand tokens: #0d0d0d ink, #fa4f09 accent, #ffffff paper.

var WISHLIST_DISCOUNT_HTML =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Price drop on {{product_title}}</title></head>" +
  "<body style=\"margin:0;background:#ffffff;color:#0d0d0d;font-family:system-ui,sans-serif;\">\n" +
  "<div style=\"max-width:560px;margin:0 auto;padding:24px;\">\n" +
  "  <h1 style=\"color:#0d0d0d;margin:0 0 12px;\">Price drop on your wishlist</h1>\n" +
  "  <p style=\"margin:0 0 16px;\"><strong>{{product_title}}</strong> just dropped to <strong style=\"color:#fa4f09;\">{{new_price}}</strong> (was <s>{{old_price}}</s>) — that's <strong>{{discount_pct}}% off</strong>.</p>\n" +
  "  <p style=\"margin:0 0 16px;\">Expires: {{expires_at}}</p>\n" +
  "  <p style=\"margin:24px 0;\"><a href=\"{{product_url}}\" style=\"background:#fa4f09;color:#ffffff;padding:12px 20px;text-decoration:none;display:inline-block;font-weight:bold;\">Buy now</a></p>\n" +
  "  <p style=\"margin:0;color:#0d0d0d;font-size:13px;\">Link: {{product_url}}</p>\n" +
  "</div>\n" +
  "</body></html>\n";

var WISHLIST_DISCOUNT_TEXT =
  "Price drop on your wishlist\n\n" +
  "{{product_title}} just dropped to {{new_price}} (was {{old_price}}) — {{discount_pct}}% off.\n" +
  "Expires: {{expires_at}}\n\n" +
  "Buy now: {{product_url}}\n";

// Abandoned cart — items still in cart 24h+ later.
//
// Loop templates ({{var}}-rendered once per line, then joined) live
// alongside the outer document. The outer document is split into
// `_BEFORE_LINES` + `_AFTER_LINES` so the assembled (already-safe)
// line HTML can be concatenated between two `_render()` halves —
// the strict renderer keeps escaping every substituted value at
// both ends, no raw HTML ever flows through a {{var}} slot.

var ABANDONED_CART_HTML_BEFORE_LINES =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>You left something behind</title></head>" +
  "<body style=\"margin:0;background:#ffffff;color:#0d0d0d;font-family:system-ui,sans-serif;\">\n" +
  "<div style=\"max-width:560px;margin:0 auto;padding:24px;\">\n" +
  "  <h1 style=\"color:#0d0d0d;margin:0 0 12px;\">You left something behind</h1>\n" +
  "  <p style=\"margin:0 0 16px;\">Hi {{customer_name}}, your cart is still waiting:</p>\n" +
  "  <table border=\"0\" cellpadding=\"6\" cellspacing=\"0\" style=\"border-collapse:collapse;width:100%;color:#0d0d0d;\">\n";

var ABANDONED_CART_HTML_LINE =
  "    <tr><td>{{title}} &times; {{qty}}</td><td align=\"right\">{{price}}</td></tr>\n";

var ABANDONED_CART_HTML_AFTER_LINES =
  "    <tr><td style=\"border-top:2px solid #0d0d0d;\"><strong>Total</strong></td><td align=\"right\" style=\"border-top:2px solid #0d0d0d;\"><strong>{{total}}</strong></td></tr>\n" +
  "  </table>\n" +
  "  <p style=\"margin:16px 0;color:#0d0d0d;\">{{notes}}</p>\n" +
  "  <p style=\"margin:24px 0;\"><a href=\"{{cart_url}}\" style=\"background:#fa4f09;color:#ffffff;padding:12px 20px;text-decoration:none;display:inline-block;font-weight:bold;\">Return to cart</a></p>\n" +
  "</div>\n" +
  "</body></html>\n";

var ABANDONED_CART_TEXT_BEFORE_LINES =
  "You left something behind\n\n" +
  "Hi {{customer_name}}, your cart is still waiting:\n\n";

var ABANDONED_CART_TEXT_LINE =
  "  {{title}} x {{qty}} — {{price}}\n";

var ABANDONED_CART_TEXT_AFTER_LINES =
  "-------------------------------------\n" +
  "Total: {{total}}\n\n" +
  "{{notes}}\n\n" +
  "Return to cart: {{cart_url}}\n";

// Review request — sent ~7 days after ship. Per-product review
// links use the same before/lines/after split as the abandoned
// cart so the strict renderer keeps its escape-everything property.

var REVIEW_REQUEST_HTML_BEFORE_LINES =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>How was your order?</title></head>" +
  "<body style=\"margin:0;background:#ffffff;color:#0d0d0d;font-family:system-ui,sans-serif;\">\n" +
  "<div style=\"max-width:560px;margin:0 auto;padding:24px;\">\n" +
  "  <h1 style=\"color:#0d0d0d;margin:0 0 12px;\">How was your order?</h1>\n" +
  "  <p style=\"margin:0 0 16px;\">Hi {{customer_name}}, hope you're enjoying order <strong>{{order_id}}</strong>. A quick review helps the next customer:</p>\n" +
  "  <ul style=\"padding-left:20px;margin:0 0 16px;color:#0d0d0d;\">\n";

var REVIEW_REQUEST_HTML_LINE =
  "    <li><a href=\"{{review_url}}\" style=\"color:#fa4f09;\">Review {{title}}</a></li>\n";

var REVIEW_REQUEST_HTML_AFTER_LINES =
  "  </ul>\n" +
  "  <p style=\"margin:16px 0;color:#0d0d0d;font-size:13px;\">Each link takes about a minute. Thank you.</p>\n" +
  "</div>\n" +
  "</body></html>\n";

var REVIEW_REQUEST_TEXT_BEFORE_LINES =
  "How was your order?\n\n" +
  "Hi {{customer_name}}, hope you're enjoying order {{order_id}}.\n" +
  "A quick review helps the next customer:\n\n";

var REVIEW_REQUEST_TEXT_LINE =
  "  Review {{title}}: {{review_url}}\n";

var REVIEW_REQUEST_TEXT_AFTER_LINES =
  "\nEach link takes about a minute. Thank you.\n";

// Back-in-stock — double-opt-in confirmation + the fired notification.
// Both auto-escape every field through the strict `{{var}}` renderer
// (product_title / sku are catalog data; escape anyway).

var STOCK_ALERT_CONFIRM_HTML =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Confirm your back-in-stock alert</title></head>" +
  "<body style=\"margin:0;background:#ffffff;color:#0d0d0d;font-family:system-ui,sans-serif;\">\n" +
  "<div style=\"max-width:560px;margin:0 auto;padding:24px;\">\n" +
  "  <h1 style=\"color:#0d0d0d;margin:0 0 12px;\">Confirm your back-in-stock alert</h1>\n" +
  "  <p style=\"margin:0 0 16px;\">You asked to be emailed when <strong>{{product_title}}</strong> (SKU {{sku}}) is back in stock. Confirm below and we'll email you once, the moment it returns.</p>\n" +
  "  <p style=\"margin:24px 0;\"><a href=\"{{confirm_url}}\" style=\"background:#fa4f09;color:#ffffff;padding:12px 20px;text-decoration:none;display:inline-block;font-weight:bold;\">Confirm my alert</a></p>\n" +
  "  <p style=\"margin:0;color:#0d0d0d;font-size:13px;\">If you didn't request this, ignore this email — no alert is set until you confirm. Link: {{confirm_url}}</p>\n" +
  "</div>\n" +
  "</body></html>\n";

var STOCK_ALERT_CONFIRM_TEXT =
  "Confirm your back-in-stock alert\n\n" +
  "You asked to be emailed when {{product_title}} (SKU {{sku}}) is back in stock.\n" +
  "Confirm to set the alert — we'll email you once, the moment it returns.\n\n" +
  "Confirm: {{confirm_url}}\n\n" +
  "If you didn't request this, ignore this email — no alert is set until you confirm.\n";

var BACK_IN_STOCK_HTML =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\"><head><meta charset=\"utf-8\"><title>Back in stock: {{product_title}}</title></head>" +
  "<body style=\"margin:0;background:#ffffff;color:#0d0d0d;font-family:system-ui,sans-serif;\">\n" +
  "<div style=\"max-width:560px;margin:0 auto;padding:24px;\">\n" +
  "  <h1 style=\"color:#0d0d0d;margin:0 0 12px;\">It's back in stock</h1>\n" +
  "  <p style=\"margin:0 0 16px;\"><strong>{{product_title}}</strong> (SKU {{sku}}) is available again. Stock can move fast — grab it while it's here.</p>\n" +
  "  <p style=\"margin:24px 0;\"><a href=\"{{product_url}}\" style=\"background:#fa4f09;color:#ffffff;padding:12px 20px;text-decoration:none;display:inline-block;font-weight:bold;\">View the product</a></p>\n" +
  "  <p style=\"margin:0;color:#0d0d0d;font-size:13px;\">Link: {{product_url}}</p>\n" +
  "  <p style=\"margin:16px 0 0;color:#0d0d0d;font-size:13px;\">Don't want these alerts? Unsubscribe: {{unsubscribe_url}}</p>\n" +
  "</div>\n" +
  "</body></html>\n";

var BACK_IN_STOCK_TEXT =
  "It's back in stock\n\n" +
  "{{product_title}} (SKU {{sku}}) is available again.\n" +
  "Stock can move fast — grab it while it's here.\n\n" +
  "View the product: {{product_url}}\n\n" +
  "Don't want these alerts? Unsubscribe: {{unsubscribe_url}}\n";

// ---- factory ------------------------------------------------------------

function _email(s) {
  // sanitize() only strips unicode / control / bidi smuggling —
  // address-shape rejection is in validate(). Run validate first,
  // then sanitize for canonical form.
  var v = b.guardEmail.validate(s, { profile: "strict" });
  if (!v.ok) {
    var ruleId = v.issues && v.issues[0] && v.issues[0].ruleId || "shape";
    throw new TypeError("email: address rejected (" + ruleId + ")");
  }
  return b.guardEmail.sanitize(s, { profile: "strict" });
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

    // Wishlist discount — a watched product just dropped in price.
    // Operator passes already-formatted `old_price` / `new_price`
    // strings; pricing rules vary (locale, multi-currency, promo
    // overlay) and email shouldn't re-derive them. `expires_at` is
    // optional — defaults to "no expiry" so the template's required
    // slot still receives an escaped string.
    sendWishlistDiscount: async function (input) {
      if (!input) throw new TypeError("email.sendWishlistDiscount: input object required");
      if (typeof input.customer_email !== "string" || !input.customer_email) {
        throw new TypeError("email.sendWishlistDiscount: customer_email required");
      }
      if (typeof input.product_title !== "string" || !input.product_title) {
        throw new TypeError("email.sendWishlistDiscount: product_title required");
      }
      if (typeof input.product_url !== "string" || !input.product_url) {
        throw new TypeError("email.sendWishlistDiscount: product_url required");
      }
      var vars = {
        product_title: input.product_title,
        product_url:   input.product_url,
        old_price:     input.old_price == null ? "—" : String(input.old_price),
        new_price:     input.new_price == null ? "—" : String(input.new_price),
        discount_pct:  input.discount_pct == null ? "—" : String(input.discount_pct),
        expires_at:    input.expires_at ? String(input.expires_at) : "no expiry",
      };
      var html = _render(WISHLIST_DISCOUNT_HTML, vars);
      var text = _render(WISHLIST_DISCOUNT_TEXT, vars);
      return await _send(
        input.customer_email,
        "Price drop on " + input.product_title,
        html, text, input.replyTo
      );
    },

    // Abandoned cart — items still in cart 24h+ later. The line set
    // is rendered through the strict renderer once per line so each
    // line's `title` / `qty` / `price` is HTML-escaped independently,
    // then concatenated between the BEFORE/AFTER halves. No raw HTML
    // ever flows through a {{var}} slot.
    sendAbandonedCartReminder: async function (input) {
      if (!input) throw new TypeError("email.sendAbandonedCartReminder: input object required");
      if (typeof input.customer_email !== "string" || !input.customer_email) {
        throw new TypeError("email.sendAbandonedCartReminder: customer_email required");
      }
      if (typeof input.cart_url !== "string" || !input.cart_url) {
        throw new TypeError("email.sendAbandonedCartReminder: cart_url required");
      }
      if (!Array.isArray(input.lines) || input.lines.length === 0) {
        throw new TypeError("email.sendAbandonedCartReminder: lines array required");
      }
      var i;
      for (i = 0; i < input.lines.length; i += 1) {
        var ln = input.lines[i];
        if (!ln || typeof ln !== "object") {
          throw new TypeError("email.sendAbandonedCartReminder: lines[" + i + "] must be an object");
        }
        if (typeof ln.title !== "string" || !ln.title) {
          throw new TypeError("email.sendAbandonedCartReminder: lines[" + i + "].title required");
        }
      }
      var headerVars = { customer_name: input.customer_name || "there" };
      var footerVars = {
        total:    input.total == null ? "—" : String(input.total),
        notes:    input.notes || "",
        cart_url: input.cart_url,
      };
      var htmlLines = "";
      var textLines = "";
      for (i = 0; i < input.lines.length; i += 1) {
        var lineVars = {
          title: input.lines[i].title,
          qty:   input.lines[i].qty == null ? "—" : String(input.lines[i].qty),
          price: input.lines[i].price == null ? "—" : String(input.lines[i].price),
        };
        htmlLines += _render(ABANDONED_CART_HTML_LINE, lineVars);
        textLines += _render(ABANDONED_CART_TEXT_LINE, lineVars);
      }
      var html =
        _render(ABANDONED_CART_HTML_BEFORE_LINES, headerVars) +
        htmlLines +
        _render(ABANDONED_CART_HTML_AFTER_LINES, footerVars);
      var text =
        _render(ABANDONED_CART_TEXT_BEFORE_LINES, headerVars) +
        textLines +
        _render(ABANDONED_CART_TEXT_AFTER_LINES, footerVars);
      return await _send(
        input.customer_email,
        "You left something behind",
        html, text, input.replyTo
      );
    },

    // Review request — sent ~7 days after ship. Per-product review
    // links are derived from review_base_url + "/" + slug + "/review",
    // then HTML-escaped through the strict renderer with the rest of
    // the per-line substitutions.
    sendReviewRequest: async function (input) {
      if (!input) throw new TypeError("email.sendReviewRequest: input object required");
      if (typeof input.customer_email !== "string" || !input.customer_email) {
        throw new TypeError("email.sendReviewRequest: customer_email required");
      }
      if (typeof input.order_id !== "string" || !input.order_id) {
        throw new TypeError("email.sendReviewRequest: order_id required");
      }
      if (!Array.isArray(input.products) || input.products.length === 0) {
        throw new TypeError("email.sendReviewRequest: products array required");
      }
      if (typeof input.review_base_url !== "string" || !input.review_base_url) {
        throw new TypeError("email.sendReviewRequest: review_base_url required");
      }
      var i;
      for (i = 0; i < input.products.length; i += 1) {
        var p = input.products[i];
        if (!p || typeof p !== "object") {
          throw new TypeError("email.sendReviewRequest: products[" + i + "] must be an object");
        }
        if (typeof p.title !== "string" || !p.title) {
          throw new TypeError("email.sendReviewRequest: products[" + i + "].title required");
        }
        if (typeof p.slug !== "string" || !p.slug) {
          throw new TypeError("email.sendReviewRequest: products[" + i + "].slug required");
        }
      }
      var headerVars = {
        customer_name: input.customer_name || "there",
        order_id:      input.order_id,
      };
      var htmlLines = "";
      var textLines = "";
      for (i = 0; i < input.products.length; i += 1) {
        var pr = input.products[i];
        var lineVars = {
          title:      pr.title,
          review_url: input.review_base_url + "/" + pr.slug + "/review",
        };
        htmlLines += _render(REVIEW_REQUEST_HTML_LINE, lineVars);
        textLines += _render(REVIEW_REQUEST_TEXT_LINE, lineVars);
      }
      var html =
        _render(REVIEW_REQUEST_HTML_BEFORE_LINES, headerVars) +
        htmlLines +
        REVIEW_REQUEST_HTML_AFTER_LINES;
      var text =
        _render(REVIEW_REQUEST_TEXT_BEFORE_LINES, headerVars) +
        textLines +
        REVIEW_REQUEST_TEXT_AFTER_LINES;
      return await _send(
        input.customer_email,
        "How was your order " + input.order_id + "?",
        html, text, input.replyTo
      );
    },

    // Back-in-stock double-opt-in confirmation. `confirm_url` is built by
    // the route from SHOP_ORIGIN + the plaintext token returned once by
    // stockAlerts.subscribe. product_title / sku are catalog data; the
    // strict renderer escapes every field anyway (escape-by-default).
    sendStockAlertConfirmation: async function (input) {
      if (!input) throw new TypeError("email.sendStockAlertConfirmation: input object required");
      if (typeof input.to !== "string" || !input.to) {
        throw new TypeError("email.sendStockAlertConfirmation: to required");
      }
      if (typeof input.confirm_url !== "string" || !input.confirm_url) {
        throw new TypeError("email.sendStockAlertConfirmation: confirm_url required");
      }
      var vars = {
        product_title: input.product_title == null ? input.sku || "this item" : String(input.product_title),
        sku:           input.sku == null ? "—" : String(input.sku),
        confirm_url:   input.confirm_url,
      };
      var html = _render(STOCK_ALERT_CONFIRM_HTML, vars);
      var text = _render(STOCK_ALERT_CONFIRM_TEXT, vars);
      return await _send(input.to, "Confirm your back-in-stock alert", html, text, input.replyTo);
    },

    // Back-in-stock fired notification. Subject is built from the same
    // already-escaped var path as the body (the subject string itself is
    // never HTML — it carries the raw title; the mailer transport escapes
    // header-injection, and the body is rendered through the strict
    // escaping renderer).
    sendBackInStock: async function (input) {
      if (!input) throw new TypeError("email.sendBackInStock: input object required");
      if (typeof input.to !== "string" || !input.to) {
        throw new TypeError("email.sendBackInStock: to required");
      }
      if (typeof input.product_url !== "string" || !input.product_url) {
        throw new TypeError("email.sendBackInStock: product_url required");
      }
      var title = input.product_title == null ? (input.sku || "this item") : String(input.product_title);
      var vars = {
        product_title:   title,
        sku:             input.sku == null ? "—" : String(input.sku),
        product_url:     input.product_url,
        unsubscribe_url: input.unsubscribe_url == null ? "" : String(input.unsubscribe_url),
      };
      var html = _render(BACK_IN_STOCK_HTML, vars);
      var text = _render(BACK_IN_STOCK_TEXT, vars);
      return await _send(input.to, "Back in stock: " + title, html, text, input.replyTo);
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
    WISHLIST_DISCOUNT_HTML:  WISHLIST_DISCOUNT_HTML,
    WISHLIST_DISCOUNT_TEXT:  WISHLIST_DISCOUNT_TEXT,
    ABANDONED_CART_HTML_BEFORE_LINES: ABANDONED_CART_HTML_BEFORE_LINES,
    ABANDONED_CART_HTML_LINE:         ABANDONED_CART_HTML_LINE,
    ABANDONED_CART_HTML_AFTER_LINES:  ABANDONED_CART_HTML_AFTER_LINES,
    ABANDONED_CART_TEXT_BEFORE_LINES: ABANDONED_CART_TEXT_BEFORE_LINES,
    ABANDONED_CART_TEXT_LINE:         ABANDONED_CART_TEXT_LINE,
    ABANDONED_CART_TEXT_AFTER_LINES:  ABANDONED_CART_TEXT_AFTER_LINES,
    REVIEW_REQUEST_HTML_BEFORE_LINES: REVIEW_REQUEST_HTML_BEFORE_LINES,
    REVIEW_REQUEST_HTML_LINE:         REVIEW_REQUEST_HTML_LINE,
    REVIEW_REQUEST_HTML_AFTER_LINES:  REVIEW_REQUEST_HTML_AFTER_LINES,
    REVIEW_REQUEST_TEXT_BEFORE_LINES: REVIEW_REQUEST_TEXT_BEFORE_LINES,
    REVIEW_REQUEST_TEXT_LINE:         REVIEW_REQUEST_TEXT_LINE,
    REVIEW_REQUEST_TEXT_AFTER_LINES:  REVIEW_REQUEST_TEXT_AFTER_LINES,
    STOCK_ALERT_CONFIRM_HTML:         STOCK_ALERT_CONFIRM_HTML,
    STOCK_ALERT_CONFIRM_TEXT:         STOCK_ALERT_CONFIRM_TEXT,
    BACK_IN_STOCK_HTML:               BACK_IN_STOCK_HTML,
    BACK_IN_STOCK_TEXT:               BACK_IN_STOCK_TEXT,
  },
};
