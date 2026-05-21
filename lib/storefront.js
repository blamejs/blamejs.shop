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

var LAYOUT =
  "<!DOCTYPE html>\n" +
  "<html lang=\"en\">\n" +
  "<head>\n" +
  "  <meta charset=\"utf-8\">\n" +
  "  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n" +
  "  <title>{{title}} — {{shop_name}}</title>\n" +
  "  <style>\n" +
  "    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 0; color: #1a1a1a; }\n" +
  "    header { padding: 1rem 1.5rem; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }\n" +
  "    header h1 { margin: 0; font-size: 1.25rem; }\n" +
  "    nav a { margin-left: 1rem; color: #1a1a1a; text-decoration: none; }\n" +
  "    main { max-width: 60rem; margin: 0 auto; padding: 2rem 1.5rem; }\n" +
  "    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr)); gap: 1.5rem; }\n" +
  "    .card { border: 1px solid #eee; border-radius: 6px; padding: 1rem; }\n" +
  "    .card h2 { margin: 0 0 .5rem; font-size: 1rem; }\n" +
  "    .price { font-weight: 600; }\n" +
  "    table { width: 100%; border-collapse: collapse; }\n" +
  "    th, td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid #f0f0f0; }\n" +
  "    .total { font-weight: 600; }\n" +
  "    .empty { color: #888; font-style: italic; }\n" +
  "  </style>\n" +
  "</head>\n" +
  "<body>\n" +
  "  <header>\n" +
  "    <h1>{{shop_name}}</h1>\n" +
  "    <nav><a href=\"/\">Shop</a> <a href=\"/cart\">Cart ({{cart_count}})</a></nav>\n" +
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
  "  <p><a href=\"/products/{{slug}}\">View</a></p>\n" +
  "</div>\n";

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
  return _wrap({
    title:      opts.title || "Shop",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    body:       grid,
  });
}

// ---- product detail -----------------------------------------------------

var VARIANT_ROW =
  "<tr><td>{{title}}</td><td>{{sku}}</td><td class=\"price\">{{price}}</td></tr>\n";

var PRODUCT_PAGE =
  "<article>\n" +
  "  <h2>{{title}}</h2>\n" +
  "  <p>{{description}}</p>\n" +
  "  <table>\n" +
  "    <thead><tr><th>Variant</th><th>SKU</th><th>Price</th></tr></thead>\n" +
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
      sku:   v.sku,
      price: priceStr,
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

var CART_PAGE =
  "<section>\n" +
  "  <h2>Your cart</h2>\n" +
  "  <table>\n" +
  "    <thead><tr><th>SKU</th><th>Qty</th><th>Unit</th><th>Total</th></tr></thead>\n" +
  "    <tbody>{{line_rows}}</tbody>\n" +
  "  </table>\n" +
  "  <table style=\"max-width: 22rem; margin-left: auto; margin-top: 1.5rem;\">\n" +
  "    <tr><td>Subtotal</td><td align=\"right\">{{subtotal}}</td></tr>\n" +
  "    <tr class=\"total\"><td>Total</td><td align=\"right\">{{total}}</td></tr>\n" +
  "  </table>\n" +
  "</section>\n";

function renderCart(opts) {
  if (!opts) throw new TypeError("storefront.renderCart: opts required");
  var lines  = opts.lines  || [];
  var totals = opts.totals || { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" };
  var rows = lines.map(function (l) {
    return _render(CART_LINE, {
      sku:   l.sku,
      qty:   String(l.qty),
      unit:  pricing.format(l.unit_amount_minor, l.unit_currency),
      total: pricing.format(l.qty * l.unit_amount_minor, l.unit_currency),
    });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">Your cart is empty.</td></tr>";
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

function mount(router, deps) {
  if (!router || typeof router.get !== "function") throw new TypeError("storefront.mount: router with .get() required");
  if (!deps || !deps.catalog || !deps.cart) throw new TypeError("storefront.mount: deps.catalog + deps.cart required");
  var shopName = (deps.config && deps.config.shop_name) || "blamejs.shop";

  function _send(res, status, html) {
    res.status(status);
    res.setHeader && res.setHeader("content-type", "text/html; charset=utf-8");
    res.end ? res.end(html) : res.send(html);
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
    var html = renderProduct({ product: product, variants: variants, prices: prices, shop_name: shopName });
    _send(res, 200, html);
  });

  router.get("/cart", async function (req, res) {
    // The cart_id-from-sealed-cookie story lands with the POST
    // /cart/lines route in the next patch. For now, the cart route
    // reads a `cart_id` query param when present (for demo / debug)
    // or shows the empty-cart view.
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var cartId = url && url.searchParams.get("cart_id");
    if (!cartId) {
      var html = renderCart({ lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" }, shop_name: shopName });
      return _send(res, 200, html);
    }
    var c = await deps.cart.get(cartId);
    if (!c)  return _send(res, 404, renderNotFound({ shop_name: shopName }));
    var lines = await deps.cart.listLines(c.id);
    var totals = pricing.totals(c, lines, {});
    var html = renderCart({ lines: lines, totals: totals, shop_name: shopName });
    _send(res, 200, html);
  });
}

module.exports = {
  mount:           mount,
  renderHome:      renderHome,
  renderProduct:   renderProduct,
  renderCart:      renderCart,
  renderNotFound:  renderNotFound,
  // Layout exposed so operators forking the framework can override.
  _wrap:           _wrap,
  LAYOUT:          LAYOUT,
};
