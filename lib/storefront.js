"use strict";
/**
 * @module shop.storefront
 * @title  Storefront — server-rendered HTML for end customers
 *
 * @intro
 *   v1 ships a minimum viable storefront: read-only HTML routes
 *   for the home page (product list), the product detail page
 *   (PDP), and the cart view. Each renderer is a pure function
 *   returning an HTML string; `mount(router, deps)` wires the
 *   routes into a `b.router` instance and reads data via the
 *   provided catalog / cart primitives.
 *
 *   Templates are inline string templates with the same strict
 *   `{{var}}` renderer the email primitive uses — HTML-escaped
 *   substitution, refusal of unknown / unused placeholders at
 *   composition time. The full theme primitive (with file-backed
 *   templates via `b.template`, asset fingerprinting via
 *   `b.objectStore`, theme inheritance + override resolution) lands
 *   in v1.x; the inline shape exists so the storefront is
 *   demonstrable today.
 *
 *   POST routes (add-to-cart, checkout submit) land in the next
 *   patch alongside the Stripe Elements wiring — v0.0.8 is
 *   read-only HTML.
 */

var emailModule = require("./email");
var pricing      = require("./pricing");

var bShop;
function _b() {
  if (!bShop) bShop = require("./index");
  return bShop.framework;
}

// Re-use the strict renderer from the email primitive (same shape,
// same XSS guard, same unknown / unused refusal).
var _render = emailModule._render;

// ---- shared layout ------------------------------------------------------

// Visual identity reference: the framework ships with two
// reference ecommerce templates (Lager + odor-buyer-file in
// .template/) — the layout below adopts odor's monochrome-plus-
// orange-accent palette (#191919 / #fa4f09 / #ffffff) and
// Montserrat headlines as the default theme. Customers fork the
// theme later by overriding LAYOUT + the per-page templates; the
// theme primitive (v1.x) makes that swap a per-directory drop-in.
//
// Brand assets live under R2 at `brand/<file>` — the layout
// references `/assets/brand/logo.png` which the Worker resolves to
// the bound R2 bucket. The 1536×1024 source PNG is committed
// only to .template/ (local-only) and uploaded once via
// `wrangler r2 object put`.
var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <link rel=\"icon\" type=\"image/png\" href=\"/assets/brand/logo.png\">\n" +
  "  <link rel=\"preconnect\" href=\"https://fonts.googleapis.com\">\n" +
  "  <link rel=\"preconnect\" href=\"https://fonts.gstatic.com\" crossorigin>\n" +
  "  <link href=\"https://fonts.googleapis.com/css2?family=Montserrat:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap\" rel=\"stylesheet\">\n" +
  "  <style>\n" +
  "    :root {\n" +
  "      --ink:      #191919;\n" +
  "      --ink-2:    #414141;\n" +
  "      --mute:     #727272;\n" +
  "      --hair:     #d9d9d9;\n" +
  "      --paper:    #ffffff;\n" +
  "      --bg:       #fafafa;\n" +
  "      --accent:   #fa4f09;\n" +
  "      --accent-d: #d8410a;\n" +
  "    }\n" +
  "    * { box-sizing: border-box; }\n" +
  "    html, body { margin: 0; padding: 0; }\n" +
  "    body { font-family: 'Inter', ui-sans-serif, system-ui, sans-serif; color: var(--ink); background: var(--paper); font-size: 16px; line-height: 1.6; }\n" +
  "    h1, h2, h3 { font-family: 'Montserrat', ui-sans-serif, system-ui, sans-serif; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; margin: 0 0 .75rem; }\n" +
  "    a { color: var(--ink); text-decoration: none; }\n" +
  "    a:hover { color: var(--accent); }\n" +
  "    .site-header { border-bottom: 1px solid var(--hair); background: var(--paper); position: sticky; top: 0; z-index: 10; }\n" +
  "    .site-header__inner { max-width: 72rem; margin: 0 auto; padding: 1.25rem 1.5rem; display: flex; justify-content: space-between; align-items: center; gap: 1.5rem; }\n" +
  "    .brand { display: flex; align-items: center; gap: .65rem; font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 1.15rem; }\n" +
  "    .brand img { height: 2rem; width: auto; display: block; }\n" +
  "    .site-nav { display: flex; gap: 1.75rem; align-items: center; font-size: .95rem; font-weight: 500; }\n" +
  "    .site-nav .cart-pill { display: inline-flex; align-items: center; gap: .4rem; padding: .35rem .8rem; border-radius: 999px; background: var(--ink); color: var(--paper); font-size: .85rem; }\n" +
  "    .site-nav .cart-pill:hover { background: var(--accent); }\n" +
  "    main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }\n" +
  "    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1.5rem; }\n" +
  "    .card { background: var(--paper); border: 1px solid var(--hair); border-radius: 8px; padding: 1.25rem; transition: transform .15s ease, box-shadow .15s ease; }\n" +
  "    .card:hover { transform: translateY(-2px); box-shadow: 0 8px 24px -12px rgba(25,25,25,.15); }\n" +
  "    .card h2 { margin: 0 0 .5rem; font-size: 1.05rem; }\n" +
  "    .card .price { color: var(--accent); font-weight: 600; font-size: 1.05rem; margin: .25rem 0 1rem; }\n" +
  "    .card-link { display: inline-block; color: var(--ink); border-bottom: 1px solid currentColor; padding-bottom: 1px; font-size: .9rem; font-weight: 500; }\n" +
  "    .card-link:hover { color: var(--accent); }\n" +
  "    article h2 { font-size: 2rem; margin-bottom: 1rem; }\n" +
  "    article p { color: var(--ink-2); margin-bottom: 2rem; max-width: 44rem; }\n" +
  "    table { width: 100%; border-collapse: collapse; font-size: .95rem; }\n" +
  "    thead th { text-align: left; padding: .8rem .9rem; border-bottom: 2px solid var(--ink); font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: .8rem; letter-spacing: .04em; text-transform: uppercase; color: var(--mute); }\n" +
  "    tbody td { padding: .9rem; border-bottom: 1px solid var(--hair); vertical-align: middle; }\n" +
  "    tbody tr:last-child td { border-bottom: none; }\n" +
  "    .price { font-weight: 600; }\n" +
  "    .total { font-weight: 700; color: var(--ink); border-top: 2px solid var(--ink); }\n" +
  "    .empty { color: var(--mute); font-style: italic; text-align: center; padding: 3rem 1rem; }\n" +
  "    .summary-table { max-width: 24rem; margin-left: auto; margin-top: 2rem; background: var(--bg); padding: 1rem 1.25rem; border-radius: 8px; }\n" +
  "    .summary-table td { padding: .4rem 0; border: none; }\n" +
  "    .btn, button[type=\"submit\"] { background: var(--accent); color: var(--paper); border: none; padding: .55rem 1.1rem; border-radius: 6px; font-family: 'Inter', sans-serif; font-weight: 500; font-size: .9rem; cursor: pointer; transition: background .15s ease; }\n" +
  "    .btn:hover, button[type=\"submit\"]:hover { background: var(--accent-d); }\n" +
  "    input[type=\"number\"] { padding: .45rem .55rem; border: 1px solid var(--hair); border-radius: 6px; font-family: inherit; font-size: .9rem; }\n" +
  "    form { display: inline-flex; gap: .5rem; align-items: center; }\n" +
  "    .hero { padding: 4rem 0 5rem; text-align: center; border-bottom: 1px solid var(--hair); margin-bottom: 3.5rem; background: linear-gradient(180deg, var(--paper) 0%, var(--bg) 100%); }\n" +
  "    .hero h2 { font-size: 2.75rem; margin-bottom: 1rem; max-width: 32rem; margin-left: auto; margin-right: auto; }\n" +
  "    .hero p { color: var(--mute); max-width: 32rem; margin: 0 auto; font-size: 1.05rem; }\n" +
  "    .hero .accent { color: var(--accent); }\n" +
  "  </style>\n" +
  "</head>\n" +
  "<body>\n" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"> <span>{{shop_name}}</span></a>\n" +
  "      <nav class=\"site-nav\">\n" +
  "        <a href=\"/\">Shop</a>\n" +
  "        <a href=\"/cart\" class=\"cart-pill\">Cart · {{cart_count}}</a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <main>{{body}}</main>\n" +
  "</body>\n" +
  "</html>\n";

function _wrap(opts) {
  return _render(LAYOUT, {
    title:      opts.title,
    shop_name:  opts.shop_name,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    body:       "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_BODY_PLACEHOLDER", opts.body);
  // The body is RAW HTML (already rendered + escaped at the
  // per-fragment level). The placeholder swap is post-render so the
  // outer renderer's HTML-escape doesn't double-escape the inner
  // markup.
}

// ---- home --------------------------------------------------------------

var PRODUCT_CARD =
  "<div class=\"card\">\n" +
  "  <h2>{{title}}</h2>\n" +
  "  <p class=\"price\">{{price}}</p>\n" +
  "  <a href=\"/products/{{slug}}\" class=\"card-link\">View product →</a>\n" +
  "</div>\n";

var HOME_HERO =
  "<section class=\"hero\">\n" +
  "  <h2>An open-source shop, <span class=\"accent\">built on blamejs</span>.</h2>\n" +
  "  <p>Server-rendered HTML, PQC-first crypto, zero npm runtime dependencies. Composed on the vendored blamejs framework.</p>\n" +
  "</section>\n";

function renderHome(opts) {
  if (!opts || !Array.isArray(opts.products)) throw new TypeError("storefront.renderHome: opts.products required");
  var cards = opts.products.map(function (p) {
    var priceStr = p.starting_price_minor != null
      ? pricing.format(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
    return _render(PRODUCT_CARD, { title: p.title, price: priceStr, slug: p.slug });
  }).join("\n");
  var grid = opts.products.length === 0
    ? "<p class=\"empty\">No products yet.</p>"
    : "<div class=\"grid\">" + cards + "</div>";
  // Hero shows on the home page even when no products are loaded
  // yet — communicates the framework identity to the first visitor.
  var body = HOME_HERO + grid;
  return _wrap({
    title:      opts.title || "Shop",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       body,
  });
}

// ---- product detail -----------------------------------------------------

// Cart-add form. CSRF defense rests on the `shop_sid` session
// cookie's SameSite=Lax attribute — a cross-site form POST won't
// carry the cookie, so any cross-site "add to cart" lands in a
// fresh anonymous session that the victim never sees. Token-based
// CSRF as defense-in-depth is added alongside the Stripe Elements
// payment route in the next patch.
var VARIANT_ROW =
  "<tr>\n" +
  "  <td>{{title}}</td><td>{{sku}}</td><td class=\"price\">{{price}}</td>\n" +
  "  <td>\n" +
  "    <form method=\"post\" action=\"/cart/lines\">\n" +
  "      <input type=\"hidden\" name=\"variant_id\" value=\"{{variant_id}}\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" style=\"width:4rem\">\n" +
  "      <button type=\"submit\">Add to cart</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "</tr>\n";

var PRODUCT_PAGE =
  "<article>\n" +
  "  <h2>{{title}}</h2>\n" +
  "  <p>{{description}}</p>\n" +
  "  <table>\n" +
  "    <thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th></th></tr></thead>\n" +
  "    <tbody>{{variant_rows}}</tbody>\n" +
  "  </table>\n" +
  "</article>\n";

function renderProduct(opts) {
  if (!opts || !opts.product) throw new TypeError("storefront.renderProduct: opts.product required");
  var variants = opts.variants || [];
  var prices   = opts.prices   || {};   // { variant_id: { currency, amount_minor } }
  var rows = variants.map(function (v) {
    var price = prices[v.id];
    var priceStr = price ? pricing.format(price.amount_minor, price.currency) : "—";
    return _render(VARIANT_ROW, {
      title: v.title || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || "Default"),
      sku:        v.sku,
      price:      priceStr,
      variant_id: v.id,
    });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"3\" class=\"empty\">No variants available.</td></tr>";
  var body = _render(PRODUCT_PAGE, {
    title:        opts.product.title,
    description:  opts.product.description || "",
    variant_rows: "RAW_ROWS_PLACEHOLDER",
  }).replace("RAW_ROWS_PLACEHOLDER", rows);
  return _wrap({
    title:      opts.product.title,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       body,
  });
}

// ---- cart --------------------------------------------------------------

var CART_LINE =
  "<tr><td>{{sku}}</td><td>{{qty}}</td><td class=\"price\">{{unit}}</td><td class=\"price\">{{total}}</td></tr>\n";

// Editable cart line — shown on the /cart page. Includes an inline
// qty form (POST /cart/lines/:id/update) and a remove form (POST
// /cart/lines/:id/remove). HTML forms don't natively support
// PATCH/DELETE so the framework routes use POST with verb-suffix
// paths.
var CART_LINE_EDITABLE =
  "<tr>\n" +
  "  <td>{{sku}}</td>\n" +
  "  <td>\n" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/update\" style=\"display:inline-flex; gap:.4rem;\">\n" +
  "      <input type=\"number\" name=\"qty\" value=\"{{qty}}\" min=\"1\" max=\"99\" style=\"width:4rem;\">\n" +
  "      <button type=\"submit\" style=\"background:transparent; color:var(--mute); padding:.45rem .7rem; border:1px solid var(--hair);\">Update</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "  <td class=\"price\">{{unit}}</td>\n" +
  "  <td class=\"price\">{{total}}</td>\n" +
  "  <td>\n" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/remove\">\n" +
  "      <button type=\"submit\" style=\"background:transparent; color:var(--mute); padding:.45rem .7rem; border:1px solid var(--hair);\">Remove</button>\n" +
  "    </form>\n" +
  "  </td>\n" +
  "</tr>\n";

// ---- checkout form + payment page + order confirmation -----------------

var CHECKOUT_PAGE =
  "<section>\n" +
  "  <h2>Checkout</h2>\n" +
  "  <p>Enter your shipping details to proceed to payment.</p>\n" +
  "  <form method=\"post\" action=\"/checkout\" style=\"display:block; max-width:32rem; margin-top:2rem;\">\n" +
  "    <p><label>Email<br><input type=\"email\" name=\"email\" required style=\"width:100%; padding:.55rem .65rem; border:1px solid var(--hair); border-radius:6px;\"></label></p>\n" +
  "    <p><label>Name<br><input type=\"text\" name=\"name\" required style=\"width:100%; padding:.55rem .65rem; border:1px solid var(--hair); border-radius:6px;\"></label></p>\n" +
  "    <p><label>Country (ISO 3166-1 alpha-2)<br><input type=\"text\" name=\"country\" value=\"US\" maxlength=\"2\" pattern=\"[A-Z]{2}\" required style=\"width:6rem; padding:.55rem .65rem; border:1px solid var(--hair); border-radius:6px;\"></label></p>\n" +
  "    <p><label>State<br><input type=\"text\" name=\"state\" maxlength=\"5\" style=\"width:6rem; padding:.55rem .65rem; border:1px solid var(--hair); border-radius:6px;\"></label></p>\n" +
  "    <p><label>Postal code<br><input type=\"text\" name=\"postal\" maxlength=\"16\" style=\"width:10rem; padding:.55rem .65rem; border:1px solid var(--hair); border-radius:6px;\"></label></p>\n" +
  "    <table class=\"summary-table\">\n" +
  "      <tr><td>Subtotal</td><td align=\"right\">{{subtotal}}</td></tr>\n" +
  "      <tr class=\"total\"><td>Total <small style=\"font-weight:400; color:var(--mute);\">(plus tax + shipping)</small></td><td align=\"right\">{{subtotal}}</td></tr>\n" +
  "    </table>\n" +
  "    <p style=\"margin-top:1.5rem;\"><button type=\"submit\">Continue to payment →</button></p>\n" +
  "  </form>\n" +
  "</section>\n";

function renderCheckoutForm(opts) {
  if (!opts) throw new TypeError("storefront.renderCheckoutForm: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, currency: "USD" };
  var body = _render(CHECKOUT_PAGE, {
    subtotal: pricing.format(totals.subtotal_minor, totals.currency),
  });
  return _wrap({
    title:      "Checkout",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: lines.length,
    body:       body,
  });
}

// Stripe Elements payment page — embeds Stripe.js + a minimal
// mount block. The publishable key is operator-supplied (env
// `STRIPE_PUBLISHABLE_KEY` → forwarded into the rendered HTML).
// The client_secret is per-order; never logged, never persisted.
var PAY_PAGE =
  "<section>\n" +
  "  <h2>Payment</h2>\n" +
  "  <p>Order {{order_id}} · {{grand_total}}</p>\n" +
  "  <div id=\"payment-element\" style=\"margin:1.5rem 0;\"></div>\n" +
  "  <button id=\"submit\" type=\"button\">Pay {{grand_total}}</button>\n" +
  "  <p id=\"payment-message\" style=\"color: var(--accent); margin-top: 1rem; min-height: 1.5rem;\"></p>\n" +
  "  <script src=\"https://js.stripe.com/v3/\"></script>\n" +
  "  <script>\n" +
  "    (function () {\n" +
  "      var stripe = Stripe({{pk_json}});\n" +
  "      var elements = stripe.elements({ clientSecret: {{client_secret_json}}, appearance: { theme: \"stripe\" } });\n" +
  "      var paymentElement = elements.create(\"payment\");\n" +
  "      paymentElement.mount(\"#payment-element\");\n" +
  "      document.getElementById(\"submit\").addEventListener(\"click\", function () {\n" +
  "        document.getElementById(\"payment-message\").textContent = \"Processing...\";\n" +
  "        stripe.confirmPayment({ elements: elements, confirmParams: { return_url: window.location.origin + \"/orders/{{order_id}}\" } }).then(function (result) {\n" +
  "          if (result.error) { document.getElementById(\"payment-message\").textContent = result.error.message || \"Payment failed.\"; }\n" +
  "        });\n" +
  "      });\n" +
  "    })();\n" +
  "  </script>\n" +
  "</section>\n";

function renderPayPage(opts) {
  if (!opts || !opts.order)              throw new TypeError("storefront.renderPayPage: opts.order required");
  if (!opts.client_secret)               throw new TypeError("storefront.renderPayPage: opts.client_secret required");
  if (!opts.publishable_key)              throw new TypeError("storefront.renderPayPage: opts.publishable_key required");
  // Stripe.js and client_secret values must be JSON-encoded so the
  // injection-safe template won't HTML-escape the quotes. The
  // values are otherwise opaque to the renderer — no string
  // concatenation possible at this layer.
  var body = _render(PAY_PAGE, {
    order_id:           opts.order.id,
    grand_total:        pricing.format(opts.order.grand_total_minor, opts.order.currency),
    pk_json:            "RAW_PK",
    client_secret_json: "RAW_SECRET",
  }).replace("RAW_PK",     JSON.stringify(opts.publishable_key))
    .replace("RAW_SECRET", JSON.stringify(opts.client_secret));
  return _wrap({
    title:      "Pay",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       body,
  });
}

var ORDER_PAGE =
  "<section>\n" +
  "  <h2>Order {{order_id}}</h2>\n" +
  "  <p style=\"color: var(--mute);\">Status: <strong style=\"color: var(--ink);\">{{status}}</strong></p>\n" +
  "  <h3 style=\"margin-top:2rem;\">Items</h3>\n" +
  "  <table>\n" +
  "    <thead><tr><th>SKU</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>\n" +
  "    <tbody>{{line_rows}}</tbody>\n" +
  "  </table>\n" +
  "  <table class=\"summary-table\">\n" +
  "    <tr><td>Subtotal</td><td align=\"right\">{{subtotal}}</td></tr>\n" +
  "    <tr><td>Tax</td><td align=\"right\">{{tax}}</td></tr>\n" +
  "    <tr><td>Shipping</td><td align=\"right\">{{shipping}}</td></tr>\n" +
  "    <tr class=\"total\"><td>Total</td><td align=\"right\">{{total}}</td></tr>\n" +
  "  </table>\n" +
  "</section>\n";

function renderOrder(opts) {
  if (!opts || !opts.order) throw new TypeError("storefront.renderOrder: opts.order required");
  var o = opts.order;
  var lines = o.lines || [];
  var rows = lines.map(function (l) {
    return _render(CART_LINE, {
      sku:   l.sku,
      qty:   String(l.qty),
      unit:  pricing.format(l.unit_amount_minor, l.unit_currency),
      total: pricing.format(l.line_total_minor || (l.qty * l.unit_amount_minor), l.unit_currency),
    });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No items.</td></tr>";
  var body = _render(ORDER_PAGE, {
    order_id:  o.id,
    status:    o.status,
    line_rows: "RAW_LINES",
    subtotal:  pricing.format(o.subtotal_minor,    o.currency),
    tax:       pricing.format(o.tax_minor,         o.currency),
    shipping:  pricing.format(o.shipping_minor,    o.currency),
    total:     pricing.format(o.grand_total_minor, o.currency),
  }).replace("RAW_LINES", rows);
  return _wrap({
    title:      "Order " + o.id,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       body,
  });
}

var CART_PAGE =
  "<section>\n" +
  "  <h2>Your cart</h2>\n" +
  "  <table>\n" +
  "    <thead><tr><th>SKU</th><th>Qty</th><th>Unit</th><th>Total</th><th></th></tr></thead>\n" +
  "    <tbody>{{line_rows}}</tbody>\n" +
  "  </table>\n" +
  "  <form method=\"post\" action=\"/cart/coupon\" style=\"margin-top:1.5rem; max-width:24rem; margin-left:auto; display:flex; gap:.5rem;\">\n" +
  "    <input type=\"text\" name=\"code\" value=\"{{coupon_input_value}}\" placeholder=\"Coupon code\" maxlength=\"32\" style=\"flex:1; padding:.45rem .65rem; border:1px solid var(--hair); border-radius:6px;\">\n" +
  "    <button type=\"submit\" style=\"background:transparent; color:var(--ink); padding:.45rem .9rem; border:1px solid var(--hair);\">Apply</button>\n" +
  "  </form>\n" +
  "  {{coupon_status}}" +
  "  <table class=\"summary-table\">\n" +
  "    <tr><td>Subtotal</td><td align=\"right\">{{subtotal}}</td></tr>\n" +
  "    {{discount_row}}" +
  "    <tr class=\"total\"><td>Total</td><td align=\"right\">{{total}}</td></tr>\n" +
  "  </table>\n" +
  "  <p style=\"text-align:right; margin-top:1.5rem;\"><a href=\"/checkout\" class=\"btn\" style=\"display:inline-block; text-decoration:none;\">Checkout →</a></p>\n" +
  "</section>\n";

// Human-readable strings for coupon refusal reasons. Operator-facing
// (read by end customers); short enough to fit in the cart-summary
// strip without wrapping awkwardly. Reason codes mirror the ones
// `discounts.resolve(...)` returns.
var COUPON_REASON_TEXT = Object.freeze({
  "unknown-code":        "We couldn't find that coupon.",
  "not-active":          "That coupon isn't active right now.",
  "expired":             "That coupon has expired.",
  "not-yet-active":      "That coupon isn't active yet.",
  "below-min-subtotal":  "Cart total is below the coupon's minimum.",
  "wrong-currency":      "That coupon doesn't apply to this currency.",
  "max-uses-exhausted":  "That coupon has been fully redeemed.",
});

function _renderCouponStatus(applied, currency) {
  if (!applied) return "";
  if (applied.reason) {
    var msg = COUPON_REASON_TEXT[applied.reason] || "Coupon could not be applied.";
    return "<p style=\"max-width:24rem; margin:.75rem 0 0 auto; padding:.6rem .75rem; background:#fdecea; color:#a31515; border-radius:6px; font-size:.9rem;\">" + _escape(msg) + "</p>\n";
  }
  if (applied.discount && applied.discount.code) {
    var formatted = pricing.format(applied.discount_minor, currency);
    return "<p style=\"max-width:24rem; margin:.75rem 0 0 auto; padding:.6rem .75rem; background:#eaf6ec; color:#166534; border-radius:6px; font-size:.9rem;\">Coupon <strong>" + _escape(applied.discount.code) + "</strong> applied — −" + _escape(formatted) + ".</p>\n";
  }
  return "";
}

// Lightweight HTML-escaper for the snippets we splice into raw-HTML
// placeholders. The `_render` template renderer escapes its inputs,
// but the coupon-status block is itself raw HTML (so it can carry
// the green/red wrapper), so we escape the dynamic text manually.
function _escape(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;";
  });
}

function renderCart(opts) {
  if (!opts) throw new TypeError("storefront.renderCart: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" };
  var applied = opts.applied_coupon || null;
  var rows = lines.map(function (l) {
    return _render(CART_LINE_EDITABLE, {
      sku:     l.sku,
      qty:     String(l.qty),
      unit:    pricing.format(l.unit_amount_minor, l.unit_currency),
      total:   pricing.format(l.qty * l.unit_amount_minor, l.unit_currency),
      line_id: l.id,
    });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"5\" class=\"empty\">Your cart is empty.</td></tr>";
  var couponStatusHtml = _renderCouponStatus(applied, totals.currency);
  // Pre-fill the input with the customer's most recent submission so a
  // refused code stays visible (so they can correct a typo) rather
  // than vanishing on the next render.
  var couponInputValue = applied && applied.discount && applied.discount.code
    ? applied.discount.code
    : (opts.coupon_input_value || "");
  var discountRow = "";
  if (totals.discount_minor && totals.discount_minor > 0) {
    discountRow = "<tr><td>Discount</td><td align=\"right\">−" + _escape(pricing.format(totals.discount_minor, totals.currency)) + "</td></tr>\n";
  }
  var body = _render(CART_PAGE, {
    line_rows:           "RAW_LINES",
    subtotal:            pricing.format(totals.subtotal_minor,    totals.currency),
    total:               pricing.format(totals.grand_total_minor, totals.currency),
    coupon_input_value:  couponInputValue,
    coupon_status:       "RAW_COUPON_STATUS",
    discount_row:        "RAW_DISCOUNT_ROW",
  }).replace("RAW_LINES", rows)
    .replace("RAW_COUPON_STATUS", couponStatusHtml)
    .replace("RAW_DISCOUNT_ROW", discountRow);
  return _wrap({
    title:      "Cart",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: lines.length,
    body:       body,
  });
}

// ---- 404 ---------------------------------------------------------------

function renderNotFound(opts) {
  opts = opts || {};
  var body = "<section><h2>Not found</h2><p>We couldn't find that page.</p><p><a href=\"/\">Back to the shop</a></p></section>";
  return _wrap({
    title:      "Not found",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       body,
  });
}

// ---- route mount -------------------------------------------------------
//
// Caller (server.js) hands us a b.router instance + the data deps.
// We mount the read-only HTML routes. POST routes for cart mutation
// land alongside Stripe Elements wiring in the next patch.

// Session-id cookie binding — carries the cart's session_id across
// requests. Plain HttpOnly + Secure + SameSite=Lax is sufficient here
// because the value (a UUID) is unguessable and grants ZERO authority
// — it's a routing key, not an authentication token. The cart itself
// transitions to `customer_id` on login via cart.setCustomer.
var SESSION_COOKIE_NAME = "shop_sid";
var SESSION_COOKIE_MAX  = 60 * 60 * 24 * 30;   // 30 days

// Coupon cookie — carries the most recently applied coupon code so the
// cart + checkout pages render the same totals across navigations.
// Scoped to /cart + /checkout via two Set-Cookie headers (cookies don't
// support multiple paths in a single header). SameSite=Lax matches the
// session cookie; the value grants no authority on its own — it's
// re-validated against the discounts table on every render.
var COUPON_COOKIE_NAME = "shop_coupon";
var COUPON_COOKIE_MAX  = 60 * 60 * 24 * 7;     // 7 days

function _readSidCookie(req) {
  var raw = (req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
  if (!raw) return null;
  var parts = raw.split(";");
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i].trim();
    var eq = p.indexOf("=");
    if (eq <= 0) continue;
    if (p.slice(0, eq) === SESSION_COOKIE_NAME) {
      var v = p.slice(eq + 1);
      // Cookie values are URL-encoded.
      try { return decodeURIComponent(v); } catch (_e) { return null; }
    }
  }
  return null;
}

function _setSidCookie(res, sid) {
  var attrs = "Max-Age=" + SESSION_COOKIE_MAX + "; Path=/; HttpOnly; Secure; SameSite=Lax";
  var header = SESSION_COOKIE_NAME + "=" + encodeURIComponent(sid) + "; " + attrs;
  if (typeof res.appendHeader === "function") res.appendHeader("Set-Cookie", header);
  else if (typeof res.setHeader === "function") res.setHeader("Set-Cookie", header);
}

function _readCouponCookie(req) {
  var raw = (req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
  if (!raw) return null;
  var parts = raw.split(";");
  for (var i = 0; i < parts.length; i += 1) {
    var p = parts[i].trim();
    var eq = p.indexOf("=");
    if (eq <= 0) continue;
    if (p.slice(0, eq) === COUPON_COOKIE_NAME) {
      var v = p.slice(eq + 1);
      try { return decodeURIComponent(v); } catch (_e) { return null; }
    }
  }
  return null;
}

function _appendCookie(res, header) {
  if (typeof res.appendHeader === "function") res.appendHeader("Set-Cookie", header);
  else if (typeof res.setHeader === "function") res.setHeader("Set-Cookie", header);
}

// Two cookies share the same name but different Path scopes so that
// /cart and /checkout both receive the value (cookies are sent only
// when the request path is under the cookie's Path attribute). HttpOnly
// keeps the value out of `document.cookie`, SameSite=Lax matches the
// session cookie's CSRF defense.
function _setCouponCookie(res, code) {
  var encoded = encodeURIComponent(code);
  _appendCookie(res, COUPON_COOKIE_NAME + "=" + encoded + "; Max-Age=" + COUPON_COOKIE_MAX + "; Path=/cart; HttpOnly; Secure; SameSite=Lax");
  _appendCookie(res, COUPON_COOKIE_NAME + "=" + encoded + "; Max-Age=" + COUPON_COOKIE_MAX + "; Path=/checkout; HttpOnly; Secure; SameSite=Lax");
}

function _clearCouponCookie(res) {
  _appendCookie(res, COUPON_COOKIE_NAME + "=; Max-Age=0; Path=/cart; HttpOnly; Secure; SameSite=Lax");
  _appendCookie(res, COUPON_COOKIE_NAME + "=; Max-Age=0; Path=/checkout; HttpOnly; Secure; SameSite=Lax");
}

function mount(router, deps) {
  if (!router || typeof router.get !== "function") throw new TypeError("storefront.mount: router with .get() required");
  if (!deps || !deps.catalog || !deps.cart) throw new TypeError("storefront.mount: deps.catalog + deps.cart required");
  var shopName = (deps.config && deps.config.shop_name) || "blamejs.shop";

  function _send(res, status, html) {
    res.status(status);
    res.setHeader && res.setHeader("content-type", "text/html; charset=utf-8");
    res.end ? res.end(html) : res.send(html);
  }

  // Resolve the cart for this request — read session_id from the
  // sealed cookie, create one (and the cart) if absent. Returns
  // the cart row OR null when the cart was just created (caller can
  // use { sid, cart: null } to skip lookup).
  async function _getOrCreateCart(req, res, currency) {
    var sid = _readSidCookie(req);
    if (!sid) {
      sid = _b().uuid.v7();
      _setSidCookie(res, sid);
    }
    var existing = await deps.cart.bySession(sid);
    if (existing) return { sid: sid, cart: existing };
    var created = await deps.cart.create(sid, { currency: currency || "USD" });
    return { sid: sid, cart: created };
  }

  router.get("/", async function (_req, res) {
    var page = await deps.catalog.products.list({ status: "active", limit: 24 });
    // Best-effort "starting price" lookup — first variant's USD price.
    var products = [];
    for (var i = 0; i < page.rows.length; i += 1) {
      var p = page.rows[i];
      var variants = await deps.catalog.variants.listForProduct(p.id);
      var startingPrice = null;
      if (variants.length) {
        var price = await deps.catalog.prices.current(variants[0].id, "USD");
        if (price) startingPrice = price;
      }
      products.push(Object.assign({}, p, {
        starting_price_minor:    startingPrice ? startingPrice.amount_minor : null,
        starting_price_currency: startingPrice ? startingPrice.currency      : "USD",
      }));
    }
    var html = renderHome({ products: products, shop_name: shopName });
    _send(res, 200, html);
  });

  router.get("/products/:slug", async function (req, res) {
    var slug = req.params && req.params.slug;
    if (!slug) return _send(res, 400, renderNotFound({ shop_name: shopName }));
    var product = await deps.catalog.products.bySlug(slug);
    if (!product) return _send(res, 404, renderNotFound({ shop_name: shopName }));
    var variants = await deps.catalog.variants.listForProduct(product.id);
    var prices = {};
    for (var i = 0; i < variants.length; i += 1) {
      var p = await deps.catalog.prices.current(variants[i].id, "USD");
      if (p) prices[variants[i].id] = p;
    }
    // Render cart count from the current session's cart, if any.
    var sid = _readSidCookie(req);
    var cartCount = 0;
    if (sid) {
      var c = await deps.cart.bySession(sid);
      if (c) {
        var lines = await deps.cart.listLines(c.id);
        cartCount = lines.length;
      }
    }
    var html = renderProduct({
      product:    product,
      variants:   variants,
      prices:     prices,
      shop_name:  shopName,
      cart_count: cartCount,
    });
    _send(res, 200, html);
  });

  router.get("/cart", async function (req, res) {
    var sid = _readSidCookie(req);
    if (!sid) {
      return _send(res, 200, renderCart({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName,
      }));
    }
    var c = await deps.cart.bySession(sid);
    if (!c) {
      return _send(res, 200, renderCart({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName,
      }));
    }
    var lines = await deps.cart.listLines(c.id);
    var subRow = pricing.subtotal(lines, { currency: c.currency });
    // If the customer applied a coupon (cookie present + discounts
    // primitive wired), resolve it against the live subtotal so the
    // cart shows the applied discount + drives the priced quote. The
    // resolver never throws on refusal — refusal shows up inline as a
    // reason and the totals stay un-discounted.
    var couponCode = _readCouponCookie(req);
    var applied = null;
    var ctx = {};
    if (couponCode && deps.discounts) {
      applied = await deps.discounts.resolve({
        code:           couponCode,
        subtotal_minor: subRow.amount_minor,
        currency:       c.currency,
      });
      if (applied && !applied.reason) ctx.discount_minor = applied.discount_minor;
    }
    var totals = pricing.totals(c, lines, ctx);
    _send(res, 200, renderCart({
      lines:           lines,
      totals:          totals,
      shop_name:       shopName,
      applied_coupon:  applied,
    }));
  });

  // POST /cart/coupon — apply a coupon code. Stores the (uppercased)
  // code in a cookie scoped to /cart + /checkout. The cookie is the
  // single source of truth for "which coupon does the customer
  // currently have applied"; every cart / checkout render re-resolves
  // against the live discounts table. Empty / blank submission clears
  // the cookie (so the customer can remove the applied coupon).
  router.post("/cart/coupon", async function (req, res) {
    var body = req.body || {};
    var raw  = (body.code == null ? "" : String(body.code)).trim().toUpperCase();
    if (!raw) {
      _clearCouponCookie(res);
    } else if (/^[A-Z0-9][A-Z0-9-]{2,31}$/.test(raw)) {
      _setCouponCookie(res, raw);
    }
    // Bad input is silently discarded — the next cart render shows the
    // existing cookie state unchanged. (We don't surface a 400 here:
    // the user-facing refusal is rendered on /cart via the resolve
    // result, including malformed-shape → `unknown-code`.)
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // ---- checkout flow -------------------------------------------------
  //
  // GET  /checkout         — renders the shipping form
  // POST /checkout         — calls checkout.confirm; redirects to /pay/:order_id
  // GET  /pay/:order_id    — Stripe Elements payment page
  // GET  /orders/:order_id — order confirmation (post-purchase landing)
  //
  // The checkout / payment / order deps are optional in mount(); the
  // routes only register when supplied. This lets the framework boot
  // in pure-storefront mode (catalog + cart only) for stores that
  // are still configuring payment.
  if (deps.checkout && deps.order) {
    router.get("/checkout", async function (req, res) {
      var sid = _readSidCookie(req);
      if (!sid) return _send(res, 303, "<a href=\"/cart\">Cart is empty</a>"), res.setHeader && res.setHeader("location", "/cart");
      var c = await deps.cart.bySession(sid);
      if (!c) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var lines = await deps.cart.listLines(c.id);
      if (!lines.length) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var totals = pricing.totals(c, lines, {});
      _send(res, 200, renderCheckoutForm({ lines: lines, totals: totals, shop_name: shopName }));
    });

    router.post("/checkout", async function (req, res) {
      var body = req.body || {};
      var sid = _readSidCookie(req);
      if (!sid) {
        res.status(400); return res.end ? res.end("No session") : res.send("No session");
      }
      var c = await deps.cart.bySession(sid);
      if (!c) {
        res.status(400); return res.end ? res.end("No cart") : res.send("No cart");
      }
      // Defensive cart-state guard — if the cart has already been
      // converted (e.g. duplicate-submit on POST refresh), redirect
      // to the most recent order for this session.
      if (c.status !== "active") {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var shipTo = {
        country: (body.country || "").toUpperCase(),
        state:   body.state ? String(body.state).toUpperCase() : undefined,
        postal:  body.postal || undefined,
      };
      try {
        var couponCode = _readCouponCookie(req);
        var result = await deps.checkout.confirm({
          cart_id:              c.id,
          ship_to:              shipTo,
          selected_shipping_id: deps.default_shipping_id || "std",
          customer:             { email: body.email, name: body.name },
          discount_code:        couponCode || undefined,
          idempotency_key:      "checkout:" + c.id + ":" + _b().uuid.v7(),
        });
        // Set a short-lived pay cookie so /pay/:order_id can serve the
        // client_secret without re-running confirm.
        var payCookie = "shop_pay=" + encodeURIComponent(result.payment_intent.client_secret) +
          "; Max-Age=900; Path=/pay/; HttpOnly; Secure; SameSite=Strict";
        if (res.appendHeader)      res.appendHeader("Set-Cookie", payCookie);
        else if (res.setHeader)    res.setHeader("Set-Cookie", payCookie);
        // Clear the coupon cookie post-confirm so a follow-on session
        // doesn't carry the stale (now-redeemed) code into the next
        // cart. The discount is durably recorded on the order row +
        // the redemption ledger; the cookie's job is done.
        if (couponCode) _clearCouponCookie(res);
        res.status(303);
        res.setHeader && res.setHeader("location", "/pay/" + result.order.id);
        return res.end ? res.end() : res.send("");
      } catch (e) {
        res.status(e instanceof TypeError ? 400 : 500);
        var msg = (e && e.message) || "checkout failed";
        return res.end ? res.end(msg) : res.send(msg);
      }
    });

    router.get("/pay/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName }));
      // Read the client_secret from the shop_pay cookie set on POST
      // /checkout. The cookie is scoped Path=/pay/ + SameSite=Strict
      // so it's only sent to the pay route and never cross-origin.
      var rawCookies = (req.headers && (req.headers.cookie || req.headers.Cookie)) || "";
      var clientSecret = null;
      rawCookies.split(";").forEach(function (p) {
        var t = p.trim();
        if (t.indexOf("shop_pay=") === 0) {
          try { clientSecret = decodeURIComponent(t.slice("shop_pay=".length)); } catch (_e) { /* drop */ }
        }
      });
      if (!clientSecret) {
        res.status(303); res.setHeader && res.setHeader("location", "/cart");
        return res.end ? res.end() : res.send("");
      }
      var pk = deps.stripe_publishable_key || "";
      if (!pk) {
        res.status(503);
        return res.end ? res.end("Stripe publishable key not configured") : res.send("Stripe publishable key not configured");
      }
      _send(res, 200, renderPayPage({
        order:           o,
        client_secret:   clientSecret,
        publishable_key: pk,
        shop_name:       shopName,
      }));
    });

    router.get("/orders/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName }));
      _send(res, 200, renderOrder({ order: o, shop_name: shopName }));
    });
  }

  // POST /cart/lines — add a line. Reads variant_id + qty from the
  // form body (b.middleware.bodyParser parses it into req.body).
  // CSRF token validation is the responsibility of the csrfProtect
  // middleware mounted at the app level (server.js). Redirects to
  // /cart on success so a refresh doesn't re-submit the form.
  router.post("/cart/lines", async function (req, res) {
    var body = req.body || {};
    var variantId = body.variant_id;
    var qtyRaw    = body.qty;
    var qty       = parseInt(qtyRaw, 10);
    if (!variantId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    var resolved = await _getOrCreateCart(req, res, "USD");
    try {
      await deps.cart.addLine(resolved.cart.id, { variant_id: variantId, qty: qty });
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // POST /cart/lines/:line_id/update — change qty on an existing
  // line. Form value `qty` is the new quantity (1..99). HTML forms
  // only support GET/POST so the verb is in the path.
  router.post("/cart/lines/:line_id/update", async function (req, res) {
    var lineId = req.params && req.params.line_id;
    var qty    = parseInt((req.body || {}).qty, 10);
    if (!lineId || !Number.isFinite(qty) || qty < 1 || qty > 99) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    try {
      var updated = await deps.cart.updateLine(lineId, { qty: qty });
      if (!updated) {
        res.status(404);
        return res.end ? res.end("Line not found") : res.send("Line not found");
      }
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });

  // POST /cart/lines/:line_id/remove — delete the line outright.
  router.post("/cart/lines/:line_id/remove", async function (req, res) {
    var lineId = req.params && req.params.line_id;
    if (!lineId) {
      res.status(400);
      return res.end ? res.end("Invalid request") : res.send("Invalid request");
    }
    try {
      await deps.cart.removeLine(lineId);
    } catch (e) {
      res.status(e instanceof TypeError ? 400 : 500);
      return res.end ? res.end((e && e.message) || "Error") : res.send((e && e.message) || "Error");
    }
    res.status(303);
    res.setHeader && res.setHeader("location", "/cart");
    res.end ? res.end() : res.send("");
  });
}

module.exports = {
  mount:               mount,
  renderHome:          renderHome,
  renderProduct:       renderProduct,
  renderCart:          renderCart,
  renderCheckoutForm:  renderCheckoutForm,
  renderPayPage:       renderPayPage,
  renderOrder:         renderOrder,
  renderNotFound:      renderNotFound,
  // Layout exposed so operators forking the framework can override.
  _wrap:               _wrap,
  LAYOUT:              LAYOUT,
};
