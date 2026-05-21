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
//
// Home page surface — hero + product grid. Home-specific styles ride
// inline at the top of the rendered body so the page reads correctly
// even before the layout-level token sweep lands the shared design
// system. Class names that DO exist in LAYOUT (`.hero`, `.card`,
// `.grid`, `.empty`, `.btn`) are inherited as-is; `.hero-home` and
// `.product-card` carry home-only refinements that won't bleed into
// other renderers.
var HOME_STYLES =
  "<style>\n" +
  "  .hero-home { position: relative; overflow: hidden; padding: 5rem 1.5rem 5.5rem; text-align: left; background: var(--paper); border-bottom: 1px solid var(--hair); margin: 0 -1.5rem 3rem; }\n" +
  "  .hero-home::before { content: \"\"; position: absolute; inset: 0; background: radial-gradient(60rem 24rem at 92% -10%, rgba(250,79,9,.10), transparent 60%), radial-gradient(40rem 32rem at 10% 110%, rgba(25,25,25,.06), transparent 60%); pointer-events: none; }\n" +
  "  .hero-home__inner { position: relative; max-width: 48rem; }\n" +
  "  .hero-home__eyebrow { display: inline-block; font-family: 'Montserrat', sans-serif; font-size: .72rem; letter-spacing: .14em; text-transform: uppercase; color: var(--mute); padding: .3rem .6rem; border: 1px solid var(--hair); border-radius: 999px; margin-bottom: 1.25rem; }\n" +
  "  .hero-home h1 { font-size: clamp(2.25rem, 5vw + 1rem, 3.75rem); line-height: 1.05; letter-spacing: -0.025em; margin: 0 0 1.25rem; max-width: 22ch; }\n" +
  "  .hero-home h1 .accent { color: var(--accent); }\n" +
  "  .hero-home__sub { font-size: 1.1rem; line-height: 1.55; color: var(--ink-2); max-width: 42ch; margin: 0 0 2rem; }\n" +
  "  .hero-home__ctas { display: flex; flex-wrap: wrap; gap: .85rem; align-items: center; }\n" +
  "  .hero-home__cta-secondary { display: inline-flex; align-items: center; gap: .4rem; padding: .55rem 1rem; border: 1px solid var(--ink); border-radius: 6px; color: var(--ink); font-weight: 500; font-size: .9rem; background: transparent; }\n" +
  "  .hero-home__cta-secondary:hover { background: var(--ink); color: var(--paper); }\n" +
  "  .hero-home__cta-primary { padding: .65rem 1.15rem; background: var(--accent); color: var(--paper); border-radius: 6px; font-weight: 500; font-size: .95rem; display: inline-flex; align-items: center; gap: .4rem; }\n" +
  "  .hero-home__cta-primary:hover { background: var(--accent-d); color: var(--paper); }\n" +
  "  .product-grid-anchor { display: block; height: 0; visibility: hidden; }\n" +
  "  .grid { gap: 1.75rem; }\n" +
  "  .product-card { position: relative; padding: 0; overflow: hidden; background: var(--paper); border: 1px solid var(--hair); border-radius: 10px; transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease; }\n" +
  "  .product-card:hover { border-color: var(--ink); }\n" +
  "  .product-card__link { display: block; color: inherit; }\n" +
  "  .product-card__media { position: relative; aspect-ratio: 4 / 3; background: var(--bg); background-image: linear-gradient(135deg, var(--bg) 0%, var(--paper) 100%); border-bottom: 1px solid var(--hair); }\n" +
  "  .product-card__media-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 1.8rem; color: var(--hair); letter-spacing: -0.02em; }\n" +
  "  .product-card__media img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }\n" +
  "  .product-card__badge { position: absolute; top: .75rem; left: .75rem; padding: .25rem .55rem; font-family: 'Montserrat', sans-serif; font-size: .7rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--paper); background: var(--accent); border-radius: 4px; }\n" +
  "  .product-card__body { padding: 1.1rem 1.25rem 1.25rem; }\n" +
  "  .product-card__title { font-family: 'Montserrat', sans-serif; font-weight: 600; font-size: 1rem; letter-spacing: -0.01em; margin: 0 0 .35rem; color: var(--ink); }\n" +
  "  .product-card__price { color: var(--accent); font-weight: 600; font-size: 1.15rem; margin: 0 0 .85rem; font-variant-numeric: tabular-nums; }\n" +
  "  .product-card__price--unset { color: var(--mute); }\n" +
  "  .product-card__cta { font-size: .85rem; font-weight: 500; color: var(--ink-2); display: inline-flex; align-items: center; gap: .25rem; border-bottom: 1px solid transparent; padding-bottom: 1px; }\n" +
  "  .product-card:hover .product-card__cta { color: var(--accent); border-bottom-color: var(--accent); }\n" +
  "  .product-card__cta-arrow { transition: transform .18s ease; display: inline-block; }\n" +
  "  .product-card:hover .product-card__cta-arrow { transform: translateX(2px); }\n" +
  "  .home-empty { text-align: center; padding: 5rem 1.5rem; border: 1px dashed var(--hair); border-radius: 12px; background: var(--bg); color: var(--mute); }\n" +
  "  .home-empty h3 { font-size: 1.4rem; color: var(--ink); margin-bottom: .75rem; }\n" +
  "  .home-empty p { max-width: 32rem; margin: 0 auto; color: var(--mute); font-size: 1rem; }\n" +
  "  .home-empty code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; background: var(--paper); border: 1px solid var(--hair); padding: .1rem .35rem; border-radius: 4px; color: var(--ink); }\n" +
  "  @media (max-width: 640px) {\n" +
  "    .hero-home { padding: 3rem 1.25rem 3.5rem; margin-left: -1.5rem; margin-right: -1.5rem; }\n" +
  "    .hero-home h1 { font-size: 2rem; max-width: 100%; }\n" +
  "    .hero-home__sub { font-size: 1rem; }\n" +
  "    .hero-home__ctas { flex-direction: column; align-items: stretch; }\n" +
  "    .hero-home__cta-primary, .hero-home__cta-secondary { justify-content: center; }\n" +
  "  }\n" +
  "  @media (prefers-reduced-motion: no-preference) {\n" +
  "    .product-card:hover { transform: translateY(-3px); box-shadow: 0 12px 32px -16px rgba(25,25,25,.18); }\n" +
  "  }\n" +
  "</style>\n";

var HOME_HERO =
  HOME_STYLES +
  "<section class=\"hero hero-home\" aria-labelledby=\"home-hero-title\">\n" +
  "  <div class=\"hero-home__inner\">\n" +
  "    <span class=\"hero-home__eyebrow\">Open framework · Pre-1.0</span>\n" +
  "    <h1 id=\"home-hero-title\">An <span class=\"accent\">open-source</span> shop, built on blamejs.</h1>\n" +
  "    <p class=\"hero-home__sub\">Server-rendered HTML. PQC-first crypto. Zero npm dependencies. Composable on a vendored framework.</p>\n" +
  "    <div class=\"hero-home__ctas\">\n" +
  "      <a href=\"#products\" class=\"hero-home__cta-primary\">Explore shop <span aria-hidden=\"true\">↓</span></a>\n" +
  "      <a href=\"https://github.com/blamejs/blamejs.shop\" class=\"hero-home__cta-secondary\" rel=\"noopener\">View source</a>\n" +
  "    </div>\n" +
  "  </div>\n" +
  "</section>\n" +
  "<a id=\"products\" class=\"product-grid-anchor\" aria-hidden=\"true\"></a>\n";

var PRODUCT_CARD =
  "<article class=\"card product-card\">\n" +
  "  <a href=\"/products/{{slug}}\" class=\"product-card__link\">\n" +
  "    <div class=\"product-card__media\">\n" +
  "      <span class=\"product-card__badge\">{{sku_badge}}</span>\n" +
  "      <span class=\"product-card__media-fallback\" aria-hidden=\"true\">{{initials}}</span>\n" +
  "    </div>\n" +
  "    <div class=\"product-card__body\">\n" +
  "      <h2 class=\"product-card__title\">{{title}}</h2>\n" +
  "      <p class=\"product-card__price {{price_class}}\">{{price}}</p>\n" +
  "      <span class=\"product-card__cta\">View product <span class=\"product-card__cta-arrow\" aria-hidden=\"true\">→</span></span>\n" +
  "    </div>\n" +
  "  </a>\n" +
  "</article>\n";

// Derive a 1-2 character "initials" placeholder from a product title
// for the media-fallback area. Strips non-letters, takes first chars
// of up to two words. Falls back to "·" when title is whitespace.
function _initialsOf(title) {
  var words = String(title || "").replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/);
  if (!words[0]) return "·";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function renderHome(opts) {
  if (!opts || !Array.isArray(opts.products)) throw new TypeError("storefront.renderHome: opts.products required");
  var cards = opts.products.map(function (p) {
    var hasPrice  = p.starting_price_minor != null;
    var priceStr  = hasPrice
      ? pricing.format(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
    // SKU badge: short, capped at 8 chars so a long SKU doesn't blow
    // the corner badge layout. Falls back to "NEW" when the catalog
    // row has no sku field (the catalog product itself doesn't carry
    // a sku — variants do — so this is the common path on home).
    var badge     = String(p.sku || "NEW").slice(0, 8).toUpperCase();
    return _render(PRODUCT_CARD, {
      title:       p.title,
      price:       priceStr,
      price_class: hasPrice ? "" : "product-card__price--unset",
      slug:        p.slug,
      sku_badge:   badge,
      initials:    _initialsOf(p.title),
    });
  }).join("\n");
  var grid;
  if (opts.products.length === 0) {
    grid =
      "<div class=\"empty home-empty\">\n" +
      "  <h3>No products yet</h3>\n" +
      "  <p>Set up your catalog via the admin API to populate this grid — start with <code>POST /admin/products</code>, then attach variants and prices.</p>\n" +
      "</div>\n";
  } else {
    grid = "<div class=\"grid\">" + cards + "</div>";
  }
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
  "  <table class=\"summary-table\">\n" +
  "    <tr><td>Subtotal</td><td align=\"right\">{{subtotal}}</td></tr>\n" +
  "    <tr class=\"total\"><td>Total</td><td align=\"right\">{{total}}</td></tr>\n" +
  "  </table>\n" +
  "  <p style=\"text-align:right; margin-top:1.5rem;\"><a href=\"/checkout\" class=\"btn\" style=\"display:inline-block; text-decoration:none;\">Checkout →</a></p>\n" +
  "</section>\n";

function renderCart(opts) {
  if (!opts) throw new TypeError("storefront.renderCart: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" };
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
  var body = _render(CART_PAGE, {
    line_rows: "RAW_LINES",
    subtotal:  pricing.format(totals.subtotal_minor,    totals.currency),
    total:     pricing.format(totals.grand_total_minor, totals.currency),
  }).replace("RAW_LINES", rows);
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
