"use strict";
/**
 * Admin console shell — the strict `style-src 'self'` / `font-src 'self'`
 * CSP that governs container-served routes refuses an inline <style>
 * block, inline style="" attributes, AND a cross-origin font stylesheet.
 * When the console inlined all three it rendered unstyled in production.
 *
 * This guards the contract: every admin screen links the external
 * /assets stylesheet with a matching Subresource Integrity digest, ships
 * no inline styles, and pulls no third-party font host. It also asserts
 * the self-hosted fonts the stylesheets reference actually exist on disk
 * (the deploy's asset sync uploads them to R2).
 *
 * Network: zero — pure render assertions.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var admin   = bShop.admin;
var b       = bShop.framework;
var helpers = require("../helpers");
var check   = helpers.check;

var ASSETS   = nodePath.join(__dirname, "..", "..", "themes", "default", "assets");
var manifest = require("../../lib/asset-manifest.json");

// Minimal opts for the two screens that dereference a required record;
// every other renderAdmin* defaults its opts.
var MINIMAL = {
  renderAdminOrder: { order: { id: "abcdef123456", status: "paid", currency: "USD",
    subtotal_minor: 100, tax_minor: 0, shipping_minor: 0, grand_total_minor: 100,
    created_at: Date.now(), updated_at: Date.now(), lines: [], ship_to: {} }, transitions: [] },
  renderAdminReturn: { rma: { id: "r1234567", status: "pending", reason: "x",
    order_id: "o1234567", created_at: Date.now(), lines: [] }, transitions: [] },
};

async function _run() {
  // The integrity the browser will check against the served bytes.
  var adminCssBytes = nodeFs.readFileSync(nodePath.join(ASSETS, "css", "admin.css"));
  var adminCssSri   = b.crypto.sri(adminCssBytes, { algorithm: "sha384" });
  // The content-fingerprinted path the link should carry (no `?v=`).
  var adminCssFp    = manifest.assets["css/admin.css"].fingerprinted;

  var fns = Object.keys(admin).filter(function (k) {
    return /^renderAdmin/.test(k) && typeof admin[k] === "function";
  });
  check("admin exposes render functions", fns.length >= 10);

  fns.forEach(function (fn) {
    var html = admin[fn](MINIMAL[fn] || {});
    check(fn + ": no inline <style> block",      html.indexOf("<style") === -1);
    check(fn + ": no inline style=\"\" attr",    html.indexOf("style=\"") === -1);
    check(fn + ": no Google Fonts stylesheet",   !(/https?:\/\/fonts\.googleapis\.com\//.test(html)));
    check(fn + ": no Google Fonts preconnect",   !(/https?:\/\/fonts\.gstatic\.com/.test(html)));
    // admin.css is referenced by its content-fingerprinted name
    // (`admin.<hash>.css`, no `?v=`) so the Worker/R2 deploy order can't
    // poison the SRI: a not-yet-synced object 404s instead of mismatching.
    check(fn + ": links fingerprinted admin.css", html.indexOf("/assets/themes/default/" + adminCssFp) !== -1);
    check(fn + ": admin.css link has no ?v=",     html.indexOf("/assets/themes/default/css/admin.css?v=") === -1);
    check(fn + ": pins admin.css with SRI",      html.indexOf("integrity=\"" + adminCssSri + "\"") !== -1);
  });

  // Sign-in is the unauthenticated landing — it must carry the upgraded
  // card, not a bare form, since it's the first thing an operator sees.
  var login = admin.renderAdminLogin({ shop_name: "Acme" });
  check("sign-in renders the card shell",        login.indexOf("class=\"signin-card\"") !== -1);
  check("sign-in still posts to /admin/login",   login.indexOf("action=\"/admin/login\"") !== -1);

  // Self-hosted typography: both stylesheets declare @font-face against
  // ../fonts, and every referenced woff2 exists on disk as a real WOFF2.
  var fontFiles = ["inter-400.woff2", "inter-500.woff2", "inter-600.woff2",
                   "inter-tight-600.woff2", "inter-tight-700.woff2"];
  ["css/admin.css", "css/main.css"].forEach(function (rel) {
    var css = nodeFs.readFileSync(nodePath.join(ASSETS, rel), "utf8");
    check(rel + " declares @font-face",          css.indexOf("@font-face") !== -1);
    check(rel + " has no cross-origin font URL", !(/https?:\/\/fonts\.(googleapis|gstatic)\.com/.test(css)));
    fontFiles.forEach(function (f) {
      check(rel + " references " + f,            css.indexOf(f) !== -1);
    });
  });
  fontFiles.forEach(function (f) {
    var p = nodePath.join(ASSETS, "fonts", f);
    check("vendored font present: " + f,         nodeFs.existsSync(p));
    check("vendored font is real WOFF2: " + f,   nodeFs.readFileSync(p).slice(0, 4).toString("latin1") === "wOF2");
  });
  check("font license shipped (OFL)",            nodeFs.existsSync(nodePath.join(ASSETS, "fonts", "OFL.txt")));
}

module.exports = { run: _run };
