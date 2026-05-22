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

async function _wishlistDiscount() {
  var s = _setup();
  var r = await s.email.sendWishlistDiscount({
    customer_email: "alice@example.com",
    product_title:  "Brass kettle",
    product_url:    "https://shop.example.com/p/brass-kettle",
    old_price:      "$99.00",
    new_price:      "$69.00",
    discount_pct:   30,
    expires_at:     "2026-06-01",
  });
  check("wishlist returns mailer result",          r.ok === true);
  check("wishlist one message",                    s.sent.length === 1);
  var msg = s.sent[0];
  check("wishlist to set",                          msg.to === "alice@example.com");
  check("wishlist subject mentions product",         msg.subject.indexOf("Brass kettle") !== -1);
  check("wishlist html includes product title",      msg.html.indexOf("Brass kettle") !== -1);
  check("wishlist html includes new price",          msg.html.indexOf("$69.00") !== -1);
  check("wishlist html includes CTA url",            msg.html.indexOf("https://shop.example.com/p/brass-kettle") !== -1);
  check("wishlist text includes product title",      msg.text.indexOf("Brass kettle") !== -1);
  check("wishlist text includes new price",          msg.text.indexOf("$69.00") !== -1);
  check("wishlist text includes CTA url",            msg.text.indexOf("https://shop.example.com/p/brass-kettle") !== -1);
  check("wishlist text includes discount pct",       msg.text.indexOf("30") !== -1);

  // optional expires_at: defaults to "no expiry" — template slot stays filled.
  var s2 = _setup();
  await s2.email.sendWishlistDiscount({
    customer_email: "bob@example.com",
    product_title:  "Copper pan",
    product_url:    "https://shop.example.com/p/copper-pan",
    old_price:      "$50.00",
    new_price:      "$40.00",
    discount_pct:   20,
  });
  check("wishlist optional expires_at default",     s2.sent[0].text.indexOf("no expiry") !== -1);
}

async function _abandonedCart() {
  var s = _setup();
  await s.email.sendAbandonedCartReminder({
    customer_email: "alice@example.com",
    customer_name:  "Alice",
    cart_url:       "https://shop.example.com/cart",
    lines: [
      { title: "Brass kettle", qty: 1, price: "$69.00" },
      { title: "Copper pan",   qty: 2, price: "$80.00" },
    ],
    total: "$229.00",
    notes: "Free shipping on orders over $200.",
  });
  var msg = s.sent[0];
  check("cart subject set",                          msg.subject.indexOf("left something behind") !== -1);
  check("cart html includes first line title",       msg.html.indexOf("Brass kettle") !== -1);
  check("cart html includes second line title",      msg.html.indexOf("Copper pan") !== -1);
  check("cart html includes first qty",              msg.html.indexOf("&times; 1") !== -1);
  check("cart html includes second qty",             msg.html.indexOf("&times; 2") !== -1);
  check("cart html includes total",                  msg.html.indexOf("$229.00") !== -1);
  check("cart html includes notes",                  msg.html.indexOf("Free shipping on orders over $200.") !== -1);
  check("cart html includes cart url",               msg.html.indexOf("https://shop.example.com/cart") !== -1);
  check("cart text includes both lines",             msg.text.indexOf("Brass kettle") !== -1 && msg.text.indexOf("Copper pan") !== -1);
  check("cart text includes total",                  msg.text.indexOf("$229.00") !== -1);

  // notes is optional — empty when omitted.
  var s2 = _setup();
  await s2.email.sendAbandonedCartReminder({
    customer_email: "x@example.com",
    cart_url:       "https://shop.example.com/cart",
    lines: [{ title: "Just one", qty: 1, price: "$10.00" }],
    total: "$10.00",
  });
  check("cart without notes still sends",            s2.sent.length === 1);
}

async function _reviewRequest() {
  var s = _setup();
  await s.email.sendReviewRequest({
    customer_email:  "alice@example.com",
    customer_name:   "Alice",
    order_id:        "ord_test_7",
    products: [
      { title: "Brass kettle", slug: "brass-kettle" },
      { title: "Copper pan",   slug: "copper-pan" },
    ],
    review_base_url: "https://shop.example.com/r",
  });
  var msg = s.sent[0];
  check("review subject mentions order",             msg.subject.indexOf("ord_test_7") !== -1);
  check("review html includes order id",             msg.html.indexOf("ord_test_7") !== -1);
  check("review html includes first review link",     msg.html.indexOf("https://shop.example.com/r/brass-kettle/review") !== -1);
  check("review html includes second review link",    msg.html.indexOf("https://shop.example.com/r/copper-pan/review") !== -1);
  check("review html includes both titles",           msg.html.indexOf("Brass kettle") !== -1 && msg.html.indexOf("Copper pan") !== -1);
  check("review text includes first review link",     msg.text.indexOf("https://shop.example.com/r/brass-kettle/review") !== -1);
  check("review text includes second review link",    msg.text.indexOf("https://shop.example.com/r/copper-pan/review") !== -1);
}

async function _newTemplateValidation() {
  var s = _setup();

  // ---- wishlist ----
  await assert.rejects(s.email.sendWishlistDiscount({
    product_title: "x", product_url: "https://x.example.com",
  }), /customer_email required/);
  await assert.rejects(s.email.sendWishlistDiscount({
    customer_email: "not-an-email",
    product_title:  "x",
    product_url:    "https://x.example.com",
  }), /address/);
  await assert.rejects(s.email.sendWishlistDiscount({
    customer_email: "x@example.com",
    product_url:    "https://x.example.com",
  }), /product_title required/);
  await assert.rejects(s.email.sendWishlistDiscount({
    customer_email: "x@example.com",
    product_title:  "x",
  }), /product_url required/);

  // ---- abandoned cart ----
  await assert.rejects(s.email.sendAbandonedCartReminder({
    cart_url: "https://x.example.com/cart",
    lines: [{ title: "a", qty: 1, price: "$1" }],
  }), /customer_email required/);
  await assert.rejects(s.email.sendAbandonedCartReminder({
    customer_email: "not-an-email",
    cart_url:       "https://x.example.com/cart",
    lines: [{ title: "a", qty: 1, price: "$1" }],
  }), /address/);
  await assert.rejects(s.email.sendAbandonedCartReminder({
    customer_email: "x@example.com",
    lines: [{ title: "a", qty: 1, price: "$1" }],
  }), /cart_url required/);
  await assert.rejects(s.email.sendAbandonedCartReminder({
    customer_email: "x@example.com",
    cart_url:       "https://x.example.com/cart",
    lines:          [],
  }), /lines array required/);
  await assert.rejects(s.email.sendAbandonedCartReminder({
    customer_email: "x@example.com",
    cart_url:       "https://x.example.com/cart",
  }), /lines array required/);

  // ---- review request ----
  await assert.rejects(s.email.sendReviewRequest({
    order_id: "o1",
    products: [{ title: "t", slug: "s" }],
    review_base_url: "https://x.example.com/r",
  }), /customer_email required/);
  await assert.rejects(s.email.sendReviewRequest({
    customer_email: "not-an-email",
    order_id:       "o1",
    products:       [{ title: "t", slug: "s" }],
    review_base_url: "https://x.example.com/r",
  }), /address/);
  await assert.rejects(s.email.sendReviewRequest({
    customer_email:  "x@example.com",
    products:        [{ title: "t", slug: "s" }],
    review_base_url: "https://x.example.com/r",
  }), /order_id required/);
  await assert.rejects(s.email.sendReviewRequest({
    customer_email:  "x@example.com",
    order_id:        "o1",
    review_base_url: "https://x.example.com/r",
  }), /products array required/);
  await assert.rejects(s.email.sendReviewRequest({
    customer_email:  "x@example.com",
    order_id:        "o1",
    products:        [],
    review_base_url: "https://x.example.com/r",
  }), /products array required/);
  await assert.rejects(s.email.sendReviewRequest({
    customer_email:  "x@example.com",
    order_id:        "o1",
    products:        [{ title: "t", slug: "s" }],
  }), /review_base_url required/);
}

async function _newTemplateHtmlEscapes() {
  // XSS-via-product-title on each new entry point — strict renderer
  // must escape every substituted value.
  var s = _setup();
  await s.email.sendWishlistDiscount({
    customer_email: "x@example.com",
    product_title:  "<script>alert(1)</script>",
    product_url:    "https://x.example.com/p",
    old_price:      "$1",
    new_price:      "$1",
    discount_pct:   0,
  });
  check("wishlist escapes <script>",                s.sent[0].html.indexOf("<script>alert(1)") === -1);
  check("wishlist escaped form present",            s.sent[0].html.indexOf("&lt;script&gt;") !== -1);

  var s2 = _setup();
  await s2.email.sendAbandonedCartReminder({
    customer_email: "x@example.com",
    cart_url:       "https://x.example.com/cart",
    lines: [{ title: "<img src=x onerror=1>", qty: 1, price: "$1" }],
    total: "$1",
  });
  check("cart escapes line title",                  s2.sent[0].html.indexOf("<img src=x") === -1);
  check("cart escaped form present",                s2.sent[0].html.indexOf("&lt;img") !== -1);

  var s3 = _setup();
  await s3.email.sendReviewRequest({
    customer_email:  "x@example.com",
    order_id:        "o1",
    products:        [{ title: "<b>boom</b>", slug: "boom" }],
    review_base_url: "https://x.example.com/r",
  });
  check("review escapes product title",             s3.sent[0].html.indexOf("<b>boom</b>") === -1);
  check("review escaped form present",              s3.sent[0].html.indexOf("&lt;b&gt;boom&lt;/b&gt;") !== -1);
}

async function run() {
  void b;   // satisfy linter about b being unused — kept available for future extensions
  await _orderReceipt();
  await _shipNotification();
  await _refundConfirmation();
  await _htmlEscapes();
  await _strictRenderer();
  await _validation();
  await _wishlistDiscount();
  await _abandonedCart();
  await _reviewRequest();
  await _newTemplateValidation();
  await _newTemplateHtmlEscapes();
}

module.exports = { run: run };
