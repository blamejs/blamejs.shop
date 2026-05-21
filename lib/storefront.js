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

// PDP-scoped styles. The shared LAYOUT owns the palette + base button /
// summary-table tokens; this block adds component CSS that's specific
// to the PDP and Cart pages (media slot, variant cards, qty stepper,
// sticky summary, accordion). Kept in one place so a forked theme can
// swap it wholesale without touching LAYOUT.
var STOREFRONT_PAGE_STYLES =
  "<style>\n" +
  "  .pdp { display: grid; grid-template-columns: 1fr; gap: 2.5rem; }\n" +
  "  @media (min-width: 48rem) { .pdp { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); gap: 3rem; } }\n" +
  "  .pdp-media { aspect-ratio: 1 / 1; background: var(--bg); border: 1px solid var(--hair); border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--mute); font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: .9rem; letter-spacing: .04em; text-transform: uppercase; overflow: hidden; }\n" +
  "  .pdp-media img { width: 100%; height: 100%; object-fit: cover; display: block; }\n" +
  "  .pdp-info h1 { font-size: 2.25rem; line-height: 1.15; margin: 0 0 .65rem; }\n" +
  "  @media (min-width: 64rem) { .pdp-info h1 { font-size: 2.65rem; } }\n" +
  "  .pdp-price { color: var(--accent); font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: 1.5rem; margin: 0 0 1.5rem; }\n" +
  "  .pdp-description { color: var(--ink-2); max-width: 38rem; margin: 0 0 1.75rem; font-size: 1rem; }\n" +
  "  .variant-picker { display: flex; flex-direction: column; gap: .6rem; margin: 0 0 1.75rem; }\n" +
  "  .variant-picker__label { font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--mute); margin-bottom: .25rem; }\n" +
  "  .variant-card { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 1rem; padding: .95rem 1.1rem; border: 1px solid var(--hair); border-radius: 8px; cursor: pointer; background: var(--paper); transition: border-color .12s ease, box-shadow .12s ease; }\n" +
  "  .variant-card:hover { border-color: var(--ink-2); }\n" +
  "  .variant-card input[type=\"radio\"] { position: absolute; opacity: 0; pointer-events: none; }\n" +
  "  .variant-card__title { font-weight: 600; color: var(--ink); }\n" +
  "  .variant-card__sku { display: block; color: var(--mute); font-size: .82rem; font-weight: 400; margin-top: .15rem; }\n" +
  "  .variant-card__price { font-family: 'Montserrat', sans-serif; font-weight: 600; color: var(--ink); }\n" +
  "  .variant-card:has(input[type=\"radio\"]:checked) { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }\n" +
  "  .variant-card:has(input[type=\"radio\"]:checked) .variant-card__price { color: var(--accent); }\n" +
  "  .qty-stepper { display: inline-flex; align-items: stretch; border: 1px solid var(--hair); border-radius: 6px; overflow: hidden; }\n" +
  "  .qty-stepper button { width: 2.25rem; background: var(--paper); color: var(--ink); border: none; border-right: 1px solid var(--hair); font-size: 1.1rem; font-weight: 500; cursor: pointer; padding: 0; line-height: 1; }\n" +
  "  .qty-stepper button:last-of-type { border-right: none; border-left: 1px solid var(--hair); }\n" +
  "  .qty-stepper button:hover { background: var(--bg); color: var(--accent); }\n" +
  "  .qty-stepper input[type=\"number\"] { width: 3.25rem; border: none; text-align: center; -moz-appearance: textfield; padding: .5rem 0; font-weight: 500; }\n" +
  "  .qty-stepper input::-webkit-outer-spin-button, .qty-stepper input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }\n" +
  "  .pdp-actions { display: flex; flex-direction: column; gap: .85rem; margin: 0 0 1rem; }\n" +
  "  .pdp-actions .stepper-row { display: flex; align-items: center; gap: 1rem; }\n" +
  "  .pdp-actions .stepper-row__label { font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: .78rem; letter-spacing: .06em; text-transform: uppercase; color: var(--mute); }\n" +
  "  .btn-block { display: block; width: 100%; padding: .95rem 1.2rem; font-size: 1rem; text-align: center; text-decoration: none; }\n" +
  "  .pdp-quiet { color: var(--mute); font-size: .85rem; margin: 0; }\n" +
  "  .pdp-details { margin-top: 3rem; border-top: 1px solid var(--hair); }\n" +
  "  .pdp-details details { border-bottom: 1px solid var(--hair); }\n" +
  "  .pdp-details summary { padding: 1.1rem 0; cursor: pointer; font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: .95rem; color: var(--ink); list-style: none; display: flex; justify-content: space-between; align-items: center; }\n" +
  "  .pdp-details summary::-webkit-details-marker { display: none; }\n" +
  "  .pdp-details summary::after { content: \"+\"; color: var(--mute); font-size: 1.4rem; font-weight: 400; line-height: 1; }\n" +
  "  .pdp-details details[open] summary::after { content: \"−\"; }\n" +
  "  .pdp-details .body { padding: 0 0 1.4rem; color: var(--ink-2); max-width: 44rem; }\n" +
  "  .pdp-empty { padding: 2rem 1rem; text-align: center; color: var(--mute); font-style: italic; border: 1px dashed var(--hair); border-radius: 8px; }\n" +
  "  .cart-layout { display: grid; grid-template-columns: 1fr; gap: 2.5rem; }\n" +
  "  @media (min-width: 56rem) { .cart-layout { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); gap: 3rem; align-items: start; } }\n" +
  "  .cart-lines { list-style: none; padding: 0; margin: 0; border-top: 1px solid var(--hair); }\n" +
  "  .cart-line { display: grid; grid-template-columns: 1fr auto; gap: 1rem 1.5rem; padding: 1.25rem 0; border-bottom: 1px solid var(--hair); align-items: start; }\n" +
  "  .cart-line__title { font-weight: 600; color: var(--ink); margin: 0; font-size: 1rem; }\n" +
  "  .cart-line__sku { display: block; color: var(--mute); font-size: .82rem; margin: .2rem 0 .55rem; }\n" +
  "  .cart-line__remove { background: none; border: none; color: var(--mute); font-size: .82rem; padding: 0; cursor: pointer; text-decoration: underline; font-family: inherit; }\n" +
  "  .cart-line__remove:hover { color: var(--accent); }\n" +
  "  .cart-line__qty form { display: inline-flex; align-items: center; gap: .6rem; margin-top: .15rem; }\n" +
  "  .cart-line__qty button.update { background: transparent; color: var(--mute); border: 1px solid var(--hair); border-radius: 6px; padding: .45rem .75rem; font-size: .82rem; cursor: pointer; font-family: inherit; }\n" +
  "  .cart-line__qty button.update:hover { color: var(--accent); border-color: var(--accent); }\n" +
  "  .cart-line__total { font-family: 'Montserrat', sans-serif; font-weight: 600; color: var(--accent); text-align: right; white-space: nowrap; }\n" +
  "  .cart-summary { position: sticky; top: 6rem; background: var(--bg); border-radius: 10px; padding: 1.5rem 1.6rem; }\n" +
  "  .cart-summary h3 { font-size: 1rem; margin: 0 0 1rem; letter-spacing: .04em; text-transform: uppercase; color: var(--mute); }\n" +
  "  .cart-summary table { width: 100%; border: none; font-size: .95rem; }\n" +
  "  .cart-summary table td { padding: .45rem 0; border: none; }\n" +
  "  .cart-summary table td:last-child { text-align: right; font-weight: 500; }\n" +
  "  .cart-summary table tr.total td { border-top: 1px solid var(--ink); padding-top: .85rem; font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 1.1rem; }\n" +
  "  .cart-summary .muted-line { color: var(--mute); font-size: .82rem; margin: .35rem 0 1.1rem; }\n" +
  "  .cart-empty { text-align: center; padding: 5rem 1.5rem; }\n" +
  "  .cart-empty p { color: var(--mute); margin: 0 0 1.5rem; font-size: 1.05rem; }\n" +
  "  .cart-continue { display: inline-block; margin-top: 2rem; color: var(--mute); font-size: .9rem; }\n" +
  "  .cart-continue:hover { color: var(--accent); }\n" +
  "  .qty-stepper-js + noscript { display: none; }\n" +
  "</style>\n";

// PDP-only inline JS — wires the +/− buttons on the qty stepper. The
// stepper still works without JS (the number input itself takes
// keyboard / spinner input + the form posts with whatever value is
// present), so this is enhancement-only.
var STOREFRONT_PAGE_SCRIPT =
  "<script>\n" +
  "(function(){\n" +
  "  function bind(stepper){\n" +
  "    var input = stepper.querySelector('input[type=\"number\"]');\n" +
  "    if (!input) return;\n" +
  "    var min = parseInt(input.getAttribute('min'),10); if(!isFinite(min)) min=1;\n" +
  "    var max = parseInt(input.getAttribute('max'),10); if(!isFinite(max)) max=99;\n" +
  "    stepper.querySelectorAll('button[data-step]').forEach(function(b){\n" +
  "      b.addEventListener('click', function(){\n" +
  "        var v = parseInt(input.value,10); if(!isFinite(v)) v=min;\n" +
  "        v += parseInt(b.getAttribute('data-step'),10);\n" +
  "        if (v < min) v = min; if (v > max) v = max;\n" +
  "        input.value = v;\n" +
  "      });\n" +
  "    });\n" +
  "  }\n" +
  "  document.querySelectorAll('.qty-stepper').forEach(bind);\n" +
  "})();\n" +
  "</script>\n";

// Variant card. Real <input type=\"radio\"> so the form posts the
// selected variant_id; the visual selected-state is driven by CSS
// `:has(input:checked)`.
var VARIANT_ROW =
  "<label class=\"variant-card\">\n" +
  "  <input type=\"radio\" name=\"variant_id\" value=\"{{variant_id}}\"{{checked}}>\n" +
  "  <span class=\"variant-card__label\">\n" +
  "    <span class=\"variant-card__title\">{{title}}</span>\n" +
  "    <span class=\"variant-card__sku\">{{sku}}</span>\n" +
  "  </span>\n" +
  "  <span class=\"variant-card__price\">{{price}}</span>\n" +
  "</label>\n";

var PRODUCT_PAGE =
  "<article class=\"pdp\">\n" +
  "  <div class=\"pdp-media\">{{media}}</div>\n" +
  "  <div class=\"pdp-info\">\n" +
  "    <h1>{{title}}</h1>\n" +
  "    <p class=\"pdp-price\">{{starting_price}}</p>\n" +
  "    <p class=\"pdp-description\">{{short_description}}</p>\n" +
  "    {{form}}\n" +
  "  </div>\n" +
  "  <div class=\"pdp-details\" style=\"grid-column: 1 / -1;\">\n" +
  "    <details open>\n" +
  "      <summary>Description</summary>\n" +
  "      <div class=\"body\">{{description}}</div>\n" +
  "    </details>\n" +
  "    <details>\n" +
  "      <summary>Shipping</summary>\n" +
  "      <div class=\"body\">Orders ship within 1–2 business days. Tracking is sent by email. Free standard shipping on orders over $75.</div>\n" +
  "    </details>\n" +
  "    <details>\n" +
  "      <summary>Returns</summary>\n" +
  "      <div class=\"body\">Unworn items returnable within 30 days for a full refund. Contact support to start a return.</div>\n" +
  "    </details>\n" +
  "  </div>\n" +
  "</article>\n";

var PRODUCT_FORM =
  "<form method=\"post\" action=\"/cart/lines\" style=\"display:block;\">\n" +
  "  <div class=\"variant-picker\">\n" +
  "    <span class=\"variant-picker__label\">Choose a variant</span>\n" +
  "    {{variant_cards}}\n" +
  "  </div>\n" +
  "  <div class=\"pdp-actions\">\n" +
  "    <div class=\"stepper-row\">\n" +
  "      <span class=\"stepper-row__label\">Quantity</span>\n" +
  "      <span class=\"qty-stepper qty-stepper-js\">\n" +
  "        <button type=\"button\" data-step=\"-1\" aria-label=\"Decrease quantity\">−</button>\n" +
  "        <input type=\"number\" name=\"qty\" value=\"1\" min=\"1\" max=\"99\" inputmode=\"numeric\">\n" +
  "        <button type=\"button\" data-step=\"1\" aria-label=\"Increase quantity\">+</button>\n" +
  "      </span>\n" +
  "    </div>\n" +
  "    <button type=\"submit\" class=\"btn btn-block\">Add to cart →</button>\n" +
  "    <p class=\"pdp-quiet\">Free standard shipping on orders over $75.</p>\n" +
  "  </div>\n" +
  "</form>\n";

var PRODUCT_FORM_EMPTY =
  "<div class=\"pdp-empty\">No variants available.</div>\n";

function _placeholderMedia(opts) {
  // Caller may pass opts.media = [{ r2_key, alt_text }]; defensively
  // fall back to the SKU placeholder.
  var media = (opts && Array.isArray(opts.media)) ? opts.media[0] : null;
  if (media && media.r2_key) {
    return _render(
      "<img src=\"/assets/{{r2_key}}\" alt=\"{{alt}}\">",
      { r2_key: media.r2_key, alt: media.alt_text || (opts.product && opts.product.title) || "" }
    );
  }
  // Pick the first variant SKU (or the product slug) as the placeholder
  // badge — gives the empty media slot some identity.
  var badge = "";
  if (opts && opts.variants && opts.variants.length && opts.variants[0].sku) {
    badge = opts.variants[0].sku;
  } else if (opts && opts.product) {
    badge = opts.product.slug || opts.product.title || "";
  }
  return _render("<span>{{badge}}</span>", { badge: badge });
}

function renderProduct(opts) {
  if (!opts || !opts.product) throw new TypeError("storefront.renderProduct: opts.product required");
  var variants = opts.variants || [];
  var prices   = opts.prices   || {};   // { variant_id: { currency, amount_minor } }

  // Variant cards (radio group). First variant selected by default.
  var cards = variants.map(function (v, i) {
    var price = prices[v.id];
    var priceStr = price ? pricing.format(price.amount_minor, price.currency) : "—";
    var title = v.title
      || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / "))
      || "Default";
    return _render(VARIANT_ROW, {
      title:      title,
      sku:        v.sku,
      price:      priceStr,
      variant_id: v.id,
      checked:    i === 0 ? " checked" : "",
    });
  }).join("");

  // Starting price for the headline area = first variant's price (or —).
  var startingPriceStr = "—";
  if (variants.length) {
    var firstPrice = prices[variants[0].id];
    if (firstPrice) startingPriceStr = pricing.format(firstPrice.amount_minor, firstPrice.currency);
  }

  var formHtml;
  if (variants.length === 0) {
    formHtml = PRODUCT_FORM_EMPTY;
  } else {
    formHtml = _render(PRODUCT_FORM, { variant_cards: "RAW_CARDS" }).replace("RAW_CARDS", cards);
  }

  var mediaHtml = _placeholderMedia(opts);

  var descRaw = opts.product.description || "";
  // Short description = first ~140 chars for the headline area; full
  // description goes into the Description accordion below.
  var shortDesc = descRaw.length > 140 ? descRaw.slice(0, 140).replace(/\s+\S*$/, "") + "…" : descRaw;

  var body = _render(PRODUCT_PAGE, {
    title:             opts.product.title,
    starting_price:    startingPriceStr,
    short_description: shortDesc,
    description:       descRaw || "No description provided.",
    media:             "RAW_MEDIA",
    form:              "RAW_FORM",
  }).replace("RAW_MEDIA", mediaHtml)
    .replace("RAW_FORM",  formHtml);

  body = STOREFRONT_PAGE_STYLES + body + STOREFRONT_PAGE_SCRIPT;

  return _wrap({
    title:      opts.product.title,
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       body,
  });
}

// ---- cart --------------------------------------------------------------

// Compact cart line — used inside the order confirmation table (the
// PAY / ORDER pages). Read-only.
var CART_LINE =
  "<tr><td>{{sku}}</td><td>{{qty}}</td><td class=\"price\">{{unit}}</td><td class=\"price\">{{total}}</td></tr>\n";

// Editable cart line — shown on the /cart page as a list item with
// an inline qty form (POST /cart/lines/:id/update) and a quiet remove
// form (POST /cart/lines/:id/remove). HTML forms don't natively
// support PATCH/DELETE so the framework routes use POST with
// verb-suffix paths.
var CART_LINE_EDITABLE =
  "<li class=\"cart-line\">\n" +
  "  <div>\n" +
  "    <p class=\"cart-line__title\">{{title}}</p>\n" +
  "    <span class=\"cart-line__sku\">{{sku}}</span>\n" +
  "    <div class=\"cart-line__qty\">\n" +
  "      <form method=\"post\" action=\"/cart/lines/{{line_id}}/update\">\n" +
  "        <span class=\"qty-stepper qty-stepper-js\">\n" +
  "          <button type=\"button\" data-step=\"-1\" aria-label=\"Decrease quantity\">−</button>\n" +
  "          <input type=\"number\" name=\"qty\" value=\"{{qty}}\" min=\"1\" max=\"99\" inputmode=\"numeric\">\n" +
  "          <button type=\"button\" data-step=\"1\" aria-label=\"Increase quantity\">+</button>\n" +
  "        </span>\n" +
  "        <button type=\"submit\" class=\"update\">Update</button>\n" +
  "      </form>\n" +
  "    </div>\n" +
  "    <form method=\"post\" action=\"/cart/lines/{{line_id}}/remove\" style=\"display:block; margin-top:.6rem;\">\n" +
  "      <button type=\"submit\" class=\"cart-line__remove\">Remove</button>\n" +
  "    </form>\n" +
  "  </div>\n" +
  "  <div class=\"cart-line__total\">{{total}}<br><span style=\"font-weight:400; font-size:.78rem; color:var(--mute); font-family:'Inter',sans-serif;\">{{unit}} each</span></div>\n" +
  "</li>\n";

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
  "  <h2 style=\"margin-bottom:1.75rem;\">Your cart</h2>\n" +
  "  <div class=\"cart-layout\">\n" +
  "    <div>\n" +
  "      <ul class=\"cart-lines\">{{line_rows}}</ul>\n" +
  "      <a href=\"/\" class=\"cart-continue\">← Continue shopping</a>\n" +
  "    </div>\n" +
  "    <aside class=\"cart-summary summary-table\">\n" +
  "      <h3>Summary</h3>\n" +
  "      <table>\n" +
  "        <tr><td>Subtotal</td><td>{{subtotal}}</td></tr>\n" +
  "      </table>\n" +
  "      <p class=\"muted-line\">Tax and shipping calculated at checkout.</p>\n" +
  "      <table>\n" +
  "        <tr class=\"total\"><td>Total</td><td>{{total}}</td></tr>\n" +
  "      </table>\n" +
  "      <p style=\"margin:1.5rem 0 0;\"><a href=\"/checkout\" class=\"btn btn-block\">Checkout →</a></p>\n" +
  "    </aside>\n" +
  "  </div>\n" +
  "</section>\n";

var CART_PAGE_EMPTY =
  "<section class=\"cart-empty\">\n" +
  "  <h2>Your cart is empty</h2>\n" +
  "  <p>Nothing here yet — browse the shop to add something.</p>\n" +
  "  <p><a href=\"/\" class=\"btn\">Browse the shop →</a></p>\n" +
  "</section>\n";

function renderCart(opts) {
  if (!opts) throw new TypeError("storefront.renderCart: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" };

  if (!lines.length) {
    var emptyBody = STOREFRONT_PAGE_STYLES + CART_PAGE_EMPTY;
    return _wrap({
      title:      "Cart",
      shop_name:  opts.shop_name || "blamejs.shop",
      cart_count: 0,
      body:       emptyBody,
    });
  }

  var rows = lines.map(function (l) {
    var title = l.title
      || (l.variant_title)
      || l.sku;
    return _render(CART_LINE_EDITABLE, {
      title:   title,
      sku:     l.sku,
      qty:     String(l.qty),
      unit:    pricing.format(l.unit_amount_minor, l.unit_currency),
      total:   pricing.format(l.qty * l.unit_amount_minor, l.unit_currency),
      line_id: l.id,
    });
  }).join("");

  var body = _render(CART_PAGE, {
    line_rows: "RAW_LINES",
    subtotal:  pricing.format(totals.subtotal_minor,    totals.currency),
    total:     pricing.format(totals.grand_total_minor, totals.currency),
  }).replace("RAW_LINES", rows);

  body = STOREFRONT_PAGE_STYLES + body + STOREFRONT_PAGE_SCRIPT;

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
    var totals = pricing.totals(c, lines, {});
    _send(res, 200, renderCart({ lines: lines, totals: totals, shop_name: shopName }));
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
        var result = await deps.checkout.confirm({
          cart_id:              c.id,
          ship_to:              shipTo,
          selected_shipping_id: deps.default_shipping_id || "std",
          customer:             { email: body.email, name: body.name },
          idempotency_key:      "checkout:" + c.id + ":" + _b().uuid.v7(),
        });
        // Set a short-lived pay cookie so /pay/:order_id can serve the
        // client_secret without re-running confirm.
        var payCookie = "shop_pay=" + encodeURIComponent(result.payment_intent.client_secret) +
          "; Max-Age=900; Path=/pay/; HttpOnly; Secure; SameSite=Strict";
        if (res.appendHeader)      res.appendHeader("Set-Cookie", payCookie);
        else if (res.setHeader)    res.setHeader("Set-Cookie", payCookie);
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
