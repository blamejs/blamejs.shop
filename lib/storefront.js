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
  "  <link href=\"https://fonts.googleapis.com/css2?family=Montserrat:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap\" rel=\"stylesheet\">\n" +
  "  <style>\n" +
  "    :root {\n" +
  "      /* ---- palette ---- */\n" +
  "      --ink:        #191919;\n" +
  "      --ink-2:      #414141;\n" +
  "      --mute:       #5e5e5e;\n" +
  "      --mute-2:     #8a8a8a;\n" +
  "      --hair:       #e6e6e6;\n" +
  "      --hair-2:     #f0f0f0;\n" +
  "      --paper:      #ffffff;\n" +
  "      --bg:         #fafafa;\n" +
  "      --bg-2:       #f4f4f4;\n" +
  "      --accent:     #fa4f09;\n" +
  "      --accent-d:   #d8410a;\n" +
  "      --accent-l:   #ffece2;\n" +
  "      --danger:     #b3261e;\n" +
  "      --focus-ring: var(--accent);\n" +
  "      /* ---- typography ---- */\n" +
  "      --font-display: 'Montserrat', ui-sans-serif, system-ui, sans-serif;\n" +
  "      --font-body:    'Inter', ui-sans-serif, system-ui, sans-serif;\n" +
  "      --font-mono:    ui-monospace, SFMono-Regular, Menlo, monospace;\n" +
  "      --text-xs:    0.75rem;\n" +
  "      --text-sm:    0.875rem;\n" +
  "      --text-base:  1rem;\n" +
  "      --text-lg:    1.125rem;\n" +
  "      --text-xl:    1.375rem;\n" +
  "      --text-2xl:   1.75rem;\n" +
  "      --text-3xl:   2.5rem;\n" +
  "      --lh-tight:   1.15;\n" +
  "      --lh-snug:    1.35;\n" +
  "      --lh-body:    1.6;\n" +
  "      /* ---- spacing scale (4px base) ---- */\n" +
  "      --space-0:    0;\n" +
  "      --space-1:    0.25rem;\n" +
  "      --space-2:    0.5rem;\n" +
  "      --space-3:    0.75rem;\n" +
  "      --space-4:    1rem;\n" +
  "      --space-5:    1.5rem;\n" +
  "      --space-6:    2rem;\n" +
  "      --space-7:    3rem;\n" +
  "      --space-8:    4.5rem;\n" +
  "      /* ---- radius + shadow ---- */\n" +
  "      --radius-sm:  4px;\n" +
  "      --radius-md:  8px;\n" +
  "      --radius-lg:  14px;\n" +
  "      --radius-pill: 999px;\n" +
  "      --shadow-sm:  0 1px 2px rgba(25,25,25,.06);\n" +
  "      --shadow-md:  0 8px 24px -12px rgba(25,25,25,.18);\n" +
  "      --shadow-lg:  0 24px 48px -20px rgba(25,25,25,.22);\n" +
  "      /* ---- motion ---- */\n" +
  "      --ease-out:       cubic-bezier(.2, .7, .2, 1);\n" +
  "      --duration-fast:  120ms;\n" +
  "      --duration-mid:   220ms;\n" +
  "      /* ---- layout ---- */\n" +
  "      --container:  72rem;\n" +
  "    }\n" +
  "    *, *::before, *::after { box-sizing: border-box; }\n" +
  "    html, body { margin: 0; padding: 0; }\n" +
  "    html { -webkit-text-size-adjust: 100%; }\n" +
  "    body {\n" +
  "      font-family: var(--font-body);\n" +
  "      color: var(--ink);\n" +
  "      background: var(--bg);\n" +
  "      font-size: var(--text-base);\n" +
  "      line-height: var(--lh-body);\n" +
  "      -webkit-font-smoothing: antialiased;\n" +
  "      text-rendering: optimizeLegibility;\n" +
  "      min-height: 100vh;\n" +
  "      display: flex;\n" +
  "      flex-direction: column;\n" +
  "    }\n" +
  "    h1, h2, h3, h4 {\n" +
  "      font-family: var(--font-display);\n" +
  "      font-weight: 700;\n" +
  "      letter-spacing: -0.01em;\n" +
  "      line-height: var(--lh-tight);\n" +
  "      margin: 0 0 var(--space-3);\n" +
  "      color: var(--ink);\n" +
  "    }\n" +
  "    h1 { font-size: var(--text-3xl); }\n" +
  "    h2 { font-size: var(--text-2xl); }\n" +
  "    h3 { font-size: var(--text-xl); }\n" +
  "    h4 { font-size: var(--text-lg); }\n" +
  "    p  { margin: 0 0 var(--space-4); }\n" +
  "    small { color: var(--mute); }\n" +
  "    a { color: var(--ink); text-decoration: none; }\n" +
  "    a:hover { color: var(--accent); }\n" +
  "    *:focus { outline: none; }\n" +
  "    *:focus-visible {\n" +
  "      outline: 2px solid var(--focus-ring);\n" +
  "      outline-offset: 2px;\n" +
  "      border-radius: var(--radius-sm);\n" +
  "    }\n" +
  "    img { max-width: 100%; height: auto; display: block; }\n" +
  "    /* ---- skip link (a11y) ---- */\n" +
  "    .skip-link {\n" +
  "      position: absolute; left: -9999px; top: 0;\n" +
  "      background: var(--ink); color: var(--paper);\n" +
  "      padding: var(--space-2) var(--space-4);\n" +
  "      font-family: var(--font-display); font-size: var(--text-sm);\n" +
  "      z-index: 100;\n" +
  "    }\n" +
  "    .skip-link:focus { left: var(--space-4); top: var(--space-2); color: var(--paper); }\n" +
  "    /* ---- header ---- */\n" +
  "    .site-header {\n" +
  "      border-bottom: 1px solid var(--hair);\n" +
  "      background: rgba(255,255,255,.92);\n" +
  "      backdrop-filter: saturate(140%) blur(8px);\n" +
  "      -webkit-backdrop-filter: saturate(140%) blur(8px);\n" +
  "      position: sticky;\n" +
  "      top: 0;\n" +
  "      z-index: 20;\n" +
  "      box-shadow: var(--shadow-sm);\n" +
  "    }\n" +
  "    .site-header__inner {\n" +
  "      max-width: var(--container); margin: 0 auto;\n" +
  "      padding: var(--space-4) var(--space-5);\n" +
  "      display: grid;\n" +
  "      grid-template-columns: auto 1fr auto;\n" +
  "      align-items: center;\n" +
  "      gap: var(--space-5);\n" +
  "    }\n" +
  "    .brand {\n" +
  "      display: inline-flex; align-items: center; gap: var(--space-2);\n" +
  "      font-family: var(--font-display); font-weight: 700;\n" +
  "      font-size: var(--text-lg);\n" +
  "      letter-spacing: -0.01em;\n" +
  "      color: var(--ink);\n" +
  "    }\n" +
  "    .brand img { height: 1.75rem; width: auto; }\n" +
  "    .brand:hover { color: var(--accent); }\n" +
  "    .site-search { display: flex; min-width: 0; }\n" +
  "    .site-search__inner {\n" +
  "      display: flex; align-items: stretch; width: 100%;\n" +
  "      max-width: 28rem; margin: 0 auto;\n" +
  "      background: var(--bg-2);\n" +
  "      border: 1px solid transparent;\n" +
  "      border-radius: var(--radius-pill);\n" +
  "      overflow: hidden;\n" +
  "    }\n" +
  "    .site-search__inner:focus-within { background: var(--paper); border-color: var(--ink); }\n" +
  "    .site-search input[type=\"search\"] {\n" +
  "      flex: 1; min-width: 0;\n" +
  "      border: none; background: transparent;\n" +
  "      padding: var(--space-2) var(--space-4);\n" +
  "      font: 500 var(--text-sm)/1.4 var(--font-body);\n" +
  "      color: var(--ink);\n" +
  "    }\n" +
  "    .site-search input[type=\"search\"]:focus { outline: none; }\n" +
  "    .site-search input[type=\"search\"]::placeholder { color: var(--mute-2); }\n" +
  "    .site-search button {\n" +
  "      border: none; background: var(--ink); color: var(--paper);\n" +
  "      padding: var(--space-2) var(--space-4);\n" +
  "      font: 600 var(--text-sm)/1 var(--font-display);\n" +
  "      letter-spacing: 0.02em; text-transform: uppercase;\n" +
  "      cursor: pointer;\n" +
  "    }\n" +
  "    .site-search button:hover { background: var(--accent); }\n" +
  "    .site-nav {\n" +
  "      display: inline-flex; gap: var(--space-5); align-items: center;\n" +
  "      font-family: var(--font-display);\n" +
  "      font-size: var(--text-sm); font-weight: 600;\n" +
  "      letter-spacing: 0.02em; text-transform: uppercase;\n" +
  "      justify-self: end;\n" +
  "    }\n" +
  "    .site-nav a { color: var(--ink-2); }\n" +
  "    .site-nav a:hover { color: var(--accent); }\n" +
  "    .cart-pill {\n" +
  "      display: inline-flex; align-items: center; gap: var(--space-2);\n" +
  "      padding: var(--space-2) var(--space-4);\n" +
  "      border-radius: var(--radius-pill);\n" +
  "      background: var(--ink); color: var(--paper) !important;\n" +
  "      font-family: var(--font-display); font-weight: 600;\n" +
  "      font-size: var(--text-xs); letter-spacing: 0.04em;\n" +
  "    }\n" +
  "    .cart-pill:hover { background: var(--accent); }\n" +
  "    /* ---- main + footer scaffold ---- */\n" +
  "    main {\n" +
  "      flex: 1 0 auto;\n" +
  "      max-width: var(--container); width: 100%;\n" +
  "      margin: 0 auto;\n" +
  "      padding: var(--space-7) var(--space-5) var(--space-8);\n" +
  "    }\n" +
  "    .site-footer {\n" +
  "      flex-shrink: 0;\n" +
  "      border-top: 1px solid var(--hair);\n" +
  "      background: var(--ink); color: var(--paper);\n" +
  "    }\n" +
  "    .site-footer__inner {\n" +
  "      max-width: var(--container); margin: 0 auto;\n" +
  "      padding: var(--space-7) var(--space-5);\n" +
  "      display: grid;\n" +
  "      grid-template-columns: 1fr auto;\n" +
  "      gap: var(--space-5);\n" +
  "      align-items: end;\n" +
  "    }\n" +
  "    .site-footer__brand h3 {\n" +
  "      color: var(--paper); margin: 0 0 var(--space-2);\n" +
  "      font-size: var(--text-xl);\n" +
  "    }\n" +
  "    .site-footer__tagline { color: rgba(255,255,255,.72); margin: 0 0 var(--space-3); max-width: 32rem; }\n" +
  "    .site-footer__primitives {\n" +
  "      list-style: none; padding: 0; margin: 0;\n" +
  "      display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4);\n" +
  "      font-family: var(--font-display); font-size: var(--text-xs);\n" +
  "      letter-spacing: 0.06em; text-transform: uppercase;\n" +
  "      color: rgba(255,255,255,.6);\n" +
  "    }\n" +
  "    .site-footer__primitives li::before { content: '\\2022'; margin-right: var(--space-2); color: var(--accent); }\n" +
  "    .site-footer__primitives li:first-child::before { content: ''; margin-right: 0; }\n" +
  "    .site-footer__copy { color: rgba(255,255,255,.55); font-size: var(--text-xs); white-space: nowrap; }\n" +
  "    /* ---- shared building blocks (page renderers compose these) ---- */\n" +
  "    .grid {\n" +
  "      display: grid;\n" +
  "      grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));\n" +
  "      gap: var(--space-5);\n" +
  "    }\n" +
  "    .card {\n" +
  "      background: var(--paper);\n" +
  "      border: 1px solid var(--hair);\n" +
  "      border-radius: var(--radius-md);\n" +
  "      padding: var(--space-5);\n" +
  "    }\n" +
  "    .card h2, .card h3 { font-size: var(--text-lg); margin: 0 0 var(--space-2); }\n" +
  "    .card .price { color: var(--accent); font-weight: 700; font-size: var(--text-lg); margin: var(--space-1) 0 var(--space-4); font-variant-numeric: tabular-nums; }\n" +
  "    .card-link {\n" +
  "      display: inline-block;\n" +
  "      font-family: var(--font-display); font-weight: 600;\n" +
  "      font-size: var(--text-xs); letter-spacing: 0.06em; text-transform: uppercase;\n" +
  "      color: var(--ink);\n" +
  "      border-bottom: 1px solid var(--ink);\n" +
  "      padding-bottom: 2px;\n" +
  "    }\n" +
  "    .card-link:hover { color: var(--accent); border-bottom-color: var(--accent); }\n" +
  "    .btn, button[type=\"submit\"], a.btn {\n" +
  "      display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);\n" +
  "      background: var(--accent); color: var(--paper);\n" +
  "      border: 1px solid var(--accent);\n" +
  "      padding: var(--space-3) var(--space-5);\n" +
  "      border-radius: var(--radius-md);\n" +
  "      font-family: var(--font-display); font-weight: 600;\n" +
  "      font-size: var(--text-sm); letter-spacing: 0.04em; text-transform: uppercase;\n" +
  "      text-decoration: none;\n" +
  "      cursor: pointer;\n" +
  "    }\n" +
  "    .btn:hover, button[type=\"submit\"]:hover, a.btn:hover {\n" +
  "      background: var(--accent-d); border-color: var(--accent-d); color: var(--paper);\n" +
  "    }\n" +
  "    .btn:disabled, button[type=\"submit\"]:disabled {\n" +
  "      background: var(--mute-2); border-color: var(--mute-2); cursor: not-allowed;\n" +
  "    }\n" +
  "    .btn-secondary, a.btn-secondary {\n" +
  "      display: inline-flex; align-items: center; justify-content: center; gap: var(--space-2);\n" +
  "      background: transparent; color: var(--ink);\n" +
  "      border: 1px solid var(--hair);\n" +
  "      padding: var(--space-3) var(--space-5);\n" +
  "      border-radius: var(--radius-md);\n" +
  "      font-family: var(--font-display); font-weight: 600;\n" +
  "      font-size: var(--text-sm); letter-spacing: 0.04em; text-transform: uppercase;\n" +
  "      text-decoration: none;\n" +
  "      cursor: pointer;\n" +
  "    }\n" +
  "    .btn-secondary:hover, a.btn-secondary:hover { border-color: var(--ink); color: var(--ink); }\n" +
  "    input[type=\"text\"], input[type=\"email\"], input[type=\"number\"], input[type=\"search\"], select, textarea {\n" +
  "      font-family: var(--font-body);\n" +
  "      font-size: var(--text-sm);\n" +
  "      padding: var(--space-3);\n" +
  "      border: 1px solid var(--hair);\n" +
  "      border-radius: var(--radius-md);\n" +
  "      background: var(--paper);\n" +
  "      color: var(--ink);\n" +
  "    }\n" +
  "    input:hover, select:hover, textarea:hover { border-color: var(--mute-2); }\n" +
  "    form { display: inline-flex; gap: var(--space-2); align-items: center; }\n" +
  "    table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); }\n" +
  "    .table-scroll { overflow-x: auto; }\n" +
  "    thead th {\n" +
  "      text-align: left;\n" +
  "      padding: var(--space-3) var(--space-3);\n" +
  "      border-bottom: 2px solid var(--ink);\n" +
  "      font-family: var(--font-display); font-weight: 600;\n" +
  "      font-size: var(--text-xs); letter-spacing: 0.06em; text-transform: uppercase;\n" +
  "      color: var(--mute);\n" +
  "    }\n" +
  "    tbody td { padding: var(--space-3); border-bottom: 1px solid var(--hair); vertical-align: middle; }\n" +
  "    tbody tr:last-child td { border-bottom: none; }\n" +
  "    td.price, td.total, .price, .total { font-variant-numeric: tabular-nums; }\n" +
  "    .price { font-weight: 600; }\n" +
  "    .total { font-weight: 700; color: var(--ink); border-top: 2px solid var(--ink); }\n" +
  "    .empty { color: var(--mute); font-style: italic; text-align: center; padding: var(--space-7) var(--space-4); }\n" +
  "    .summary-table {\n" +
  "      max-width: 24rem;\n" +
  "      margin: var(--space-6) 0 0 auto;\n" +
  "      background: var(--bg-2);\n" +
  "      padding: var(--space-4) var(--space-5);\n" +
  "      border-radius: var(--radius-md);\n" +
  "    }\n" +
  "    .summary-table td { padding: var(--space-2) 0; border: none; }\n" +
  "    .hero {\n" +
  "      padding: var(--space-8) 0;\n" +
  "      text-align: center;\n" +
  "      border-bottom: 1px solid var(--hair);\n" +
  "      margin: 0 0 var(--space-7);\n" +
  "      background:\n" +
  "        radial-gradient(60rem 32rem at 50% -10rem, var(--accent-l) 0%, transparent 60%),\n" +
  "        linear-gradient(180deg, var(--paper) 0%, var(--bg) 100%);\n" +
  "    }\n" +
  "    .hero h2 { font-size: var(--text-3xl); margin: 0 auto var(--space-4); max-width: 36rem; }\n" +
  "    .hero p { color: var(--mute); max-width: 32rem; margin: 0 auto; font-size: var(--text-lg); }\n" +
  "    .hero .accent { color: var(--accent); }\n" +
  "    /* ---- motion (reduced-motion safe) ---- */\n" +
  "    @media (prefers-reduced-motion: no-preference) {\n" +
  "      a, .card, .btn, .btn-secondary, button[type=\"submit\"], .site-nav a, .cart-pill,\n" +
  "      input, select, textarea, .site-search__inner {\n" +
  "        transition:\n" +
  "          color var(--duration-fast) var(--ease-out),\n" +
  "          background-color var(--duration-fast) var(--ease-out),\n" +
  "          border-color var(--duration-fast) var(--ease-out),\n" +
  "          transform var(--duration-mid) var(--ease-out),\n" +
  "          box-shadow var(--duration-mid) var(--ease-out);\n" +
  "      }\n" +
  "      .card:hover { transform: translateY(-2px); box-shadow: var(--shadow-md); border-color: var(--ink); }\n" +
  "    }\n" +
  "    /* ---- responsive ---- */\n" +
  "    @media (max-width: 48rem) {\n" +
  "      .site-header__inner {\n" +
  "        grid-template-columns: auto auto;\n" +
  "        grid-template-areas: 'brand nav' 'search search';\n" +
  "        gap: var(--space-3);\n" +
  "      }\n" +
  "      .brand { grid-area: brand; }\n" +
  "      .site-nav { grid-area: nav; gap: var(--space-3); }\n" +
  "      .site-search { grid-area: search; }\n" +
  "      .hero { padding: var(--space-7) var(--space-4); }\n" +
  "      .hero h2 { font-size: var(--text-2xl); }\n" +
  "      .hero p { font-size: var(--text-base); }\n" +
  "      .site-footer__inner { grid-template-columns: 1fr; }\n" +
  "      .grid { grid-template-columns: 1fr; }\n" +
  "      table { font-size: var(--text-xs); }\n" +
  "    }\n" +
  "    @media (max-width: 30rem) {\n" +
  "      main { padding: var(--space-5) var(--space-4) var(--space-7); }\n" +
  "      h1 { font-size: var(--text-2xl); }\n" +
  "      h2 { font-size: var(--text-xl); }\n" +
  "    }\n" +
  "  </style>\n" +
  "</head>\n" +
  "<body>\n" +
  "  <a class=\"skip-link\" href=\"#main\">Skip to content</a>\n" +
  "  <header class=\"site-header\">\n" +
  "    <div class=\"site-header__inner\">\n" +
  "      <a href=\"/\" class=\"brand\"><img src=\"/assets/brand/logo.png\" alt=\"{{shop_name}}\"> <span>{{shop_name}}</span></a>\n" +
  "      <form class=\"site-search\" action=\"/search\" method=\"get\" role=\"search\">\n" +
  "        <div class=\"site-search__inner\">\n" +
  "          <label for=\"site-search-q\" class=\"skip-link\">Search products</label>\n" +
  "          <input id=\"site-search-q\" type=\"search\" name=\"q\" value=\"{{search_q}}\" placeholder=\"Search products\" autocomplete=\"off\" spellcheck=\"false\" maxlength=\"200\">\n" +
  "          <button type=\"submit\">Search</button>\n" +
  "        </div>\n" +
  "      </form>\n" +
  "      <nav class=\"site-nav\" aria-label=\"Primary\">\n" +
  "        <a href=\"/\">Shop</a>\n" +
  "        <a href=\"/cart\" class=\"cart-pill\" aria-label=\"Cart, {{cart_count}} items\">Cart · {{cart_count}}</a>\n" +
  "      </nav>\n" +
  "    </div>\n" +
  "  </header>\n" +
  "  <main id=\"main\">{{body}}</main>\n" +
  "  <footer class=\"site-footer\">\n" +
  "    <div class=\"site-footer__inner\">\n" +
  "      <div class=\"site-footer__brand\">\n" +
  "        <h3>{{shop_name}}</h3>\n" +
  "        <p class=\"site-footer__tagline\">An open-source shop framework — server-rendered HTML, zero npm runtime dependencies, security defaults on.</p>\n" +
  "        <ul class=\"site-footer__primitives\">\n" +
  "          <li>Built on blamejs</li>\n" +
  "          <li>Server-rendered</li>\n" +
  "          <li>PQC-first</li>\n" +
  "        </ul>\n" +
  "      </div>\n" +
  "      <p class=\"site-footer__copy\">&copy; {{year}} {{shop_name}}</p>\n" +
  "    </div>\n" +
  "  </footer>\n" +
  "</body>\n" +
  "</html>\n";

function _wrap(opts) {
  return _render(LAYOUT, {
    title:      opts.title,
    shop_name:  opts.shop_name,
    cart_count: opts.cart_count == null ? 0 : opts.cart_count,
    year:       String(new Date().getUTCFullYear()),
    search_q:   opts.search_q == null ? "" : opts.search_q,
    body:       "RAW_BODY_PLACEHOLDER",
  }).replace("RAW_BODY_PLACEHOLDER", opts.body);
  // The body is RAW HTML (already rendered + escaped at the
  // per-fragment level). The placeholder swap is post-render so the
  // outer renderer's HTML-escape doesn't double-escape the inner
  // markup. `search_q` is HTML-escaped by the renderer like any
  // other placeholder, so a customer-supplied query like
  // `"><script>` lands as escaped text inside the input's `value`.
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
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var title     = opts.title || "Shop";
  var products  = opts.products.map(function (p) {
    var priceStr = p.starting_price_minor != null
      ? pricing.format(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
    return { title: p.title, price: priceStr, slug: p.slug };
  });
  if (opts.theme) {
    return opts.theme.render("home", {
      title:           title,
      shop_name:       shopName,
      cart_count:      cartCount,
      products:        products,
      has_products:    products.length > 0,
      asset_css_main:  opts.theme.assetUrl("css/main.css"),
    });
  }
  var cards = products.map(function (p) {
    return _render(PRODUCT_CARD, { title: p.title, price: p.price, slug: p.slug });
  }).join("\n");
  var grid = products.length === 0
    ? "<p class=\"empty\">No products yet.</p>"
    : "<div class=\"grid\">" + cards + "</div>";
  // Hero shows on the home page even when no products are loaded
  // yet — communicates the framework identity to the first visitor.
  var body = HOME_HERO + grid;
  return _wrap({
    title:      title,
    shop_name:  shopName,
    cart_count: cartCount,
    body:       body,
  });
}

// ---- search results -----------------------------------------------------

var SEARCH_HEADER =
  "<section class=\"search-header\">\n" +
  "  <h2>Search results</h2>\n" +
  "  <p>{{summary}}</p>\n" +
  "</section>\n";

function renderSearch(opts) {
  if (!opts || typeof opts.q !== "string") throw new TypeError("storefront.renderSearch: opts.q (string) required");
  var products = Array.isArray(opts.products) ? opts.products : [];
  var qTrim = opts.q.trim();
  var summary;
  if (qTrim.length === 0) {
    summary = "Type a query above to find products.";
  } else if (products.length === 0) {
    summary = "No products matched “" + qTrim + "”.";
  } else {
    summary = "Showing " + products.length + " match" + (products.length === 1 ? "" : "es") + " for “" + qTrim + "”.";
  }
  // The summary string is rendered via the strict template engine,
  // which HTML-escapes every substitution — `<script>` in `q` lands
  // as escaped text. Same posture as renderHome's product titles.
  var header = _render(SEARCH_HEADER, { summary: summary });
  var cards = products.map(function (p) {
    var priceStr = p.starting_price_minor != null
      ? pricing.format(p.starting_price_minor, p.starting_price_currency || "USD")
      : "—";
    return _render(PRODUCT_CARD, { title: p.title, price: priceStr, slug: p.slug });
  }).join("\n");
  var grid = products.length === 0
    ? ""
    : "<div class=\"grid\">" + cards + "</div>";
  return _wrap({
    title:      "Search",
    shop_name:  opts.shop_name || "blamejs.shop",
    cart_count: opts.cart_count,
    search_q:   opts.q,
    body:       header + grid,
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
  var shopName = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var description = opts.product.description || "";
  var rendered = variants.map(function (v) {
    var price = prices[v.id];
    var priceStr = price ? pricing.format(price.amount_minor, price.currency) : "—";
    var vTitle = v.title || (Object.keys(v.options || {}).map(function (k) { return v.options[k]; }).join(" / ") || "Default");
    return { id: v.id, sku: v.sku, title: vTitle, price: priceStr };
  });
  if (opts.theme) {
    return opts.theme.render("product", {
      title:          opts.product.title,
      shop_name:      shopName,
      cart_count:     cartCount,
      product:        { title: opts.product.title, description: description },
      variants:       rendered,
      has_variants:   rendered.length > 0,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var rows = rendered.map(function (v) {
    return _render(VARIANT_ROW, { title: v.title, sku: v.sku, price: v.price, variant_id: v.id });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"3\" class=\"empty\">No variants available.</td></tr>";
  var body = _render(PRODUCT_PAGE, {
    title:        opts.product.title,
    description:  description,
    variant_rows: "RAW_ROWS_PLACEHOLDER",
  }).replace("RAW_ROWS_PLACEHOLDER", rows);
  return _wrap({
    title:      opts.product.title,
    shop_name:  shopName,
    cart_count: cartCount,
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
  var shopName = opts.shop_name || "blamejs.shop";
  var subtotal = pricing.format(totals.subtotal_minor, totals.currency);
  if (opts.theme) {
    return opts.theme.render("checkout", {
      title:          "Checkout",
      shop_name:      shopName,
      cart_count:     lines.length,
      subtotal:       subtotal,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = _render(CHECKOUT_PAGE, { subtotal: subtotal });
  return _wrap({
    title:      "Checkout",
    shop_name:  shopName,
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
  var shopName    = opts.shop_name || "blamejs.shop";
  var cartCount   = opts.cart_count == null ? 0 : opts.cart_count;
  var grandTotal  = pricing.format(opts.order.grand_total_minor, opts.order.currency);
  // Stripe.js and client_secret values must be JSON-encoded so the
  // template engine treats them as raw expressions (`{{{ }}}` /
  // post-render replace) rather than HTML-escaping the quotes. The
  // values are otherwise opaque to the renderer — no string
  // concatenation possible at this layer.
  var pkJson      = JSON.stringify(opts.publishable_key);
  var secretJson  = JSON.stringify(opts.client_secret);
  if (opts.theme) {
    return opts.theme.render("pay", {
      title:               "Pay",
      shop_name:           shopName,
      cart_count:          cartCount,
      order_id:            opts.order.id,
      grand_total:         grandTotal,
      pk_json:             pkJson,
      client_secret_json:  secretJson,
      asset_css_main:      opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = _render(PAY_PAGE, {
    order_id:           opts.order.id,
    grand_total:        grandTotal,
    pk_json:            "RAW_PK",
    client_secret_json: "RAW_SECRET",
  }).replace("RAW_PK",     pkJson)
    .replace("RAW_SECRET", secretJson);
  return _wrap({
    title:      "Pay",
    shop_name:  shopName,
    cart_count: cartCount,
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
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  var rendered = lines.map(function (l) {
    return {
      sku:   l.sku,
      qty:   String(l.qty),
      unit:  pricing.format(l.unit_amount_minor, l.unit_currency),
      total: pricing.format(l.line_total_minor || (l.qty * l.unit_amount_minor), l.unit_currency),
    };
  });
  var subtotal = pricing.format(o.subtotal_minor,    o.currency);
  var tax      = pricing.format(o.tax_minor,         o.currency);
  var shipping = pricing.format(o.shipping_minor,    o.currency);
  var total    = pricing.format(o.grand_total_minor, o.currency);
  if (opts.theme) {
    return opts.theme.render("order", {
      title:          "Order " + o.id,
      shop_name:      shopName,
      cart_count:     cartCount,
      order_id:       o.id,
      status:         o.status,
      lines:          rendered,
      has_lines:      rendered.length > 0,
      subtotal:       subtotal,
      tax:            tax,
      shipping:       shipping,
      total:          total,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var rows = rendered.map(function (l) {
    return _render(CART_LINE, { sku: l.sku, qty: l.qty, unit: l.unit, total: l.total });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"4\" class=\"empty\">No items.</td></tr>";
  var body = _render(ORDER_PAGE, {
    order_id:  o.id,
    status:    o.status,
    line_rows: "RAW_LINES",
    subtotal:  subtotal,
    tax:       tax,
    shipping:  shipping,
    total:     total,
  }).replace("RAW_LINES", rows);
  return _wrap({
    title:      "Order " + o.id,
    shop_name:  shopName,
    cart_count: cartCount,
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
  var shopName = opts.shop_name || "blamejs.shop";
  var rendered = lines.map(function (l) {
    return {
      id:    l.id,
      sku:   l.sku,
      qty:   String(l.qty),
      unit:  pricing.format(l.unit_amount_minor, l.unit_currency),
      total: pricing.format(l.qty * l.unit_amount_minor, l.unit_currency),
    };
  });
  var subtotal = pricing.format(totals.subtotal_minor,    totals.currency);
  var total    = pricing.format(totals.grand_total_minor, totals.currency);
  if (opts.theme) {
    return opts.theme.render("cart", {
      title:          "Cart",
      shop_name:      shopName,
      cart_count:     lines.length,
      lines:          rendered,
      has_lines:      rendered.length > 0,
      subtotal:       subtotal,
      total:          total,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var rows = rendered.map(function (l) {
    return _render(CART_LINE_EDITABLE, {
      sku: l.sku, qty: l.qty, unit: l.unit, total: l.total, line_id: l.id,
    });
  }).join("");
  if (!rows) rows = "<tr><td colspan=\"5\" class=\"empty\">Your cart is empty.</td></tr>";
  var body = _render(CART_PAGE, {
    line_rows: "RAW_LINES",
    subtotal:  subtotal,
    total:     total,
  }).replace("RAW_LINES", rows);
  return _wrap({
    title:      "Cart",
    shop_name:  shopName,
    cart_count: lines.length,
    body:       body,
  });
}

// ---- 404 ---------------------------------------------------------------

function renderNotFound(opts) {
  opts = opts || {};
  var shopName  = opts.shop_name || "blamejs.shop";
  var cartCount = opts.cart_count == null ? 0 : opts.cart_count;
  if (opts.theme) {
    return opts.theme.render("notfound", {
      title:          "Not found",
      shop_name:      shopName,
      cart_count:     cartCount,
      asset_css_main: opts.theme.assetUrl("css/main.css"),
    });
  }
  var body = "<section><h2>Not found</h2><p>We couldn't find that page.</p><p><a href=\"/\">Back to the shop</a></p></section>";
  return _wrap({
    title:      "Not found",
    shop_name:  shopName,
    cart_count: cartCount,
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
  // Optional theme — when supplied, every renderer below dispatches
  // to file-backed templates under <themesDir>/<name>/. When absent,
  // the inline-string templates above stay in force (operators on
  // older deploys keep their current look without a migration step).
  var theme = deps.theme || null;

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
    var html = renderHome({ products: products, shop_name: shopName, theme: theme });
    _send(res, 200, html);
  });

  router.get("/search", async function (req, res) {
    var url = req.url ? new URL(req.url, "http://localhost") : null;
    var qRaw = url && url.searchParams.get("q");
    var q = typeof qRaw === "string" ? qRaw : "";
    // Cap at the validator's max length before handing to the
    // primitive — defends against a 10 MiB `?q=...` mass that would
    // otherwise round-trip through the LIKE escape function.
    if (q.length > 200) q = q.slice(0, 200);
    var products = [];
    if (q.trim().length > 0) {
      var page = await deps.catalog.products.search({ q: q, status: "active", limit: 24 });
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
    }
    var sid = _readSidCookie(req);
    var cartCount = 0;
    if (sid) {
      var c = await deps.cart.bySession(sid);
      if (c) {
        var lines = await deps.cart.listLines(c.id);
        cartCount = lines.length;
      }
    }
    _send(res, 200, renderSearch({
      q:          q,
      products:   products,
      shop_name:  shopName,
      cart_count: cartCount,
    }));
  });

  router.get("/products/:slug", async function (req, res) {
    var slug = req.params && req.params.slug;
    if (!slug) return _send(res, 400, renderNotFound({ shop_name: shopName, theme: theme }));
    var product = await deps.catalog.products.bySlug(slug);
    if (!product) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
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
      theme:      theme,
    });
    _send(res, 200, html);
  });

  router.get("/cart", async function (req, res) {
    var sid = _readSidCookie(req);
    if (!sid) {
      return _send(res, 200, renderCart({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName, theme: theme,
      }));
    }
    var c = await deps.cart.bySession(sid);
    if (!c) {
      return _send(res, 200, renderCart({
        lines: [], totals: { subtotal_minor: 0, grand_total_minor: 0, currency: "USD" },
        shop_name: shopName, theme: theme,
      }));
    }
    var lines = await deps.cart.listLines(c.id);
    var totals = pricing.totals(c, lines, {});
    _send(res, 200, renderCart({ lines: lines, totals: totals, shop_name: shopName, theme: theme }));
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
      _send(res, 200, renderCheckoutForm({ lines: lines, totals: totals, shop_name: shopName, theme: theme }));
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
        // default_shipping_id may be a literal string or an
        // operator-supplied async resolver (e.g. backed by the
        // config primitive) so re-reads happen per request without
        // a container restart.
        var defaultShipId;
        if (typeof deps.default_shipping_id === "function") {
          defaultShipId = await deps.default_shipping_id();
        } else {
          defaultShipId = deps.default_shipping_id;
        }
        var result = await deps.checkout.confirm({
          cart_id:              c.id,
          ship_to:              shipTo,
          selected_shipping_id: defaultShipId || "std",
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
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
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
        theme:           theme,
      }));
    });

    router.get("/orders/:order_id", async function (req, res) {
      var orderId = req.params && req.params.order_id;
      if (!orderId) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      var o = await deps.order.get(orderId);
      if (!o) return _send(res, 404, renderNotFound({ shop_name: shopName, theme: theme }));
      _send(res, 200, renderOrder({ order: o, shop_name: shopName, theme: theme }));
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
  renderSearch:        renderSearch,
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
