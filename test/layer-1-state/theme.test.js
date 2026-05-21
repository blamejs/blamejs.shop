"use strict";
/**
 * theme — file-backed templates + fallback resolution.
 *
 * Layer 1 against an ephemeral themes/ directory in os.tmpdir().
 * Coverage:
 *   - render dispatches to the active theme when the file exists
 *   - render falls back to the default theme when the active is missing
 *   - render throws when both miss
 *   - assetUrl shapes the prefix correctly + rejects traversal
 *   - exists reports active OR fallback hits truthy
 *   - validation: themesDir absence, bad slug, viewName slug
 */

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var theme = bShop.theme;

var _tmpRoot = null;

function _setup() {
  _tmpRoot = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "shop-theme-"));
  nodeFs.mkdirSync(nodePath.join(_tmpRoot, "default"), { recursive: true });
  nodeFs.mkdirSync(nodePath.join(_tmpRoot, "acme"),    { recursive: true });

  // Default theme: home + cart + notfound. Acme overrides home only.
  nodeFs.writeFileSync(
    nodePath.join(_tmpRoot, "default", "home.html"),
    "<h1>{{ shop_name }} default home — {{ title }}</h1>\n"
  );
  nodeFs.writeFileSync(
    nodePath.join(_tmpRoot, "default", "cart.html"),
    "<p>Default cart {{ subtotal }}</p>\n"
  );
  nodeFs.writeFileSync(
    nodePath.join(_tmpRoot, "default", "notfound.html"),
    "<p>Default 404</p>\n"
  );
  nodeFs.writeFileSync(
    nodePath.join(_tmpRoot, "acme", "home.html"),
    "<h1>ACME custom home — {{ shop_name }}</h1>\n"
  );
}

function _teardown() {
  if (_tmpRoot) {
    nodeFs.rmSync(_tmpRoot, { recursive: true, force: true });
    _tmpRoot = null;
  }
}

async function _renderActive() {
  _setup();
  try {
    var t = theme.create({ themesDir: _tmpRoot, name: "acme" });
    var html = t.render("home", { shop_name: "Acme Shop", title: "Home" });
    check("active theme renders own home", html.indexOf("ACME custom home — Acme Shop") !== -1);
    check("active theme does not include default copy", html.indexOf("default home") === -1);
  } finally { _teardown(); }
}

async function _renderFallback() {
  _setup();
  try {
    var t = theme.create({ themesDir: _tmpRoot, name: "acme" });
    // acme has no cart.html → fall back to default
    var html = t.render("cart", { subtotal: "$10.00" });
    check("fallback render reaches default theme",  html.indexOf("Default cart $10.00") !== -1);
  } finally { _teardown(); }
}

async function _renderMissingBoth() {
  _setup();
  try {
    var t = theme.create({ themesDir: _tmpRoot, name: "acme" });
    assert.throws(function () { t.render("checkout", {}); }, /view not found/);
  } finally { _teardown(); }
}

async function _exists() {
  _setup();
  try {
    var t = theme.create({ themesDir: _tmpRoot, name: "acme" });
    check("exists home (active)",     t.exists("home")     === true);
    check("exists cart (fallback)",    t.exists("cart")     === true);
    check("exists notfound (fallback)", t.exists("notfound") === true);
    check("exists missing → false",     t.exists("nope")     === false);
  } finally { _teardown(); }
}

async function _assetUrl() {
  _setup();
  try {
    var t = theme.create({ themesDir: _tmpRoot, name: "acme" });
    check("assetUrl shapes prefix",          t.assetUrl("css/main.css") === "/assets/themes/acme/css/main.css");
    check("assetUrl strips leading slash",    t.assetUrl("/img/logo.png") === "/assets/themes/acme/img/logo.png");
    assert.throws(function () { t.assetUrl(""); },          /path required/);
    assert.throws(function () { t.assetUrl("../etc"); },     /forbidden character/);
  } finally { _teardown(); }
}

async function _fallbackChainSelfIdentity() {
  // When name === fallback (e.g. operator runs the default theme as-is),
  // a missing view should still throw rather than infinite-recurse.
  _setup();
  try {
    var t = theme.create({ themesDir: _tmpRoot, name: "default" });
    check("default theme renders own home",  t.render("home", { shop_name: "X", title: "Y" }).indexOf("default home") !== -1);
    assert.throws(function () { t.render("nope", {}); }, /view not found/);
  } finally { _teardown(); }
}

async function _validation() {
  _setup();
  try {
    // themesDir absent (active dir resolves under it → directory-not-found)
    assert.throws(function () {
      theme.create({ themesDir: nodePath.join(_tmpRoot, "does-not-exist"), name: "acme" });
    }, /theme directory not found/);
    // Bad name shape
    assert.throws(function () {
      theme.create({ themesDir: _tmpRoot, name: "BadName!" });
    }, /name must match/);
    // Bad fallback
    assert.throws(function () {
      theme.create({ themesDir: _tmpRoot, name: "acme", fallback: "Bad Fallback" });
    }, /fallback must match/);
    // Active theme dir missing
    assert.throws(function () {
      theme.create({ themesDir: _tmpRoot, name: "missing-theme" });
    }, /theme directory not found/);
    // Bad viewName at render time
    var t = theme.create({ themesDir: _tmpRoot, name: "acme" });
    assert.throws(function () { t.render("BadView!", {}); },  /viewName must match/);
    assert.throws(function () { t.exists("../escape"); },     /viewName must match/);
  } finally { _teardown(); }
}

async function run() {
  await _renderActive();
  await _renderFallback();
  await _renderMissingBoth();
  await _exists();
  await _assetUrl();
  await _fallbackChainSelfIdentity();
  await _validation();
}

module.exports = { run: run };
