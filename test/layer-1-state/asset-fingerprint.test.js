"use strict";
/**
 * Content-fingerprinted asset URLs.
 *
 * The asset pipeline is order-independent: the renderers reference each
 * SRI-bearing asset (`css/main.css`, `css/admin.css`, the island scripts)
 * by a content-fingerprinted name (`main.<hash>.css`) with no `?v=` query,
 * so a Worker that rolls before R2 has the new bytes serves a 404 for the
 * not-yet-synced object instead of stale bytes whose hash mismatches the
 * committed SRI. These tests pin:
 *
 *   (a) the manifest entry shape — { integrity, fingerprinted } per asset;
 *   (b) the container renderer emits the fingerprinted URL, no `?v=`, and a
 *       matching integrity;
 *   (c) edge/container parity — the edge Worker render emits a byte-identical
 *       stylesheet <link> (same fingerprinted href + integrity);
 *   (d) the fingerprint tracks the bytes — a one-byte change moves it.
 *
 * The edge render modules are ESM that import the manifest with esbuild's
 * bundler syntax (bare `import x from "./asset-manifest.json"`); a sync
 * module hook supplies the `type: "json"` attribute Node's native loader
 * requires so the same source runs unbundled here.
 */

var nodeModule = require("node:module");
var nodePath   = require("node:path");
var nodeUrl    = require("node:url");

var bShop   = require("../../lib");
var b       = require("../../lib/vendor/blamejs");
var helpers = require("../helpers");
var check   = helpers.check;

var storefront = bShop.storefront;
var admin      = bShop.admin;
var manifest   = require("../../lib/asset-manifest.json");

var REPO_ROOT  = nodePath.resolve(__dirname, "..", "..");
var WORKER_DIR = nodePath.join(REPO_ROOT, "worker", "render");

// Add the `type: "json"` import attribute the bundler injects at build time,
// so the unbundled edge ESM loads under Node's native loader. Registered once;
// the hook only touches `.json` ESM resolutions, which nothing else in the
// container test process performs.
var _hookRegistered = false;
function _registerJsonHook() {
  if (_hookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _hookRegistered = true;
}

function _stylesheetLink(html) {
  var m = html.match(/<link rel="stylesheet"[^>]*>/);
  return m ? m[0] : null;
}

function _manifestShape() {
  var keys = ["css/main.css", "css/admin.css", "js/passkey-login.js", "js/passkey-register.js"];
  for (var i = 0; i < keys.length; i += 1) {
    var entry = manifest.assets[keys[i]];
    check("manifest entry " + keys[i] + " is an object",          entry != null && typeof entry === "object");
    check("manifest entry " + keys[i] + " carries integrity",     typeof entry.integrity === "string" && entry.integrity.indexOf("sha384-") === 0);
    check("manifest entry " + keys[i] + " carries fingerprinted", typeof entry.fingerprinted === "string");
  }
  // The fingerprinted name embeds a 16-hex content hash as
  // `basename.<hash>.ext` — and MUST satisfy the Worker's immutable-cache
  // detector `/\.[a-f0-9]{8,}\.[a-z0-9]+$/` so the asset gets a long cache.
  var fp = manifest.assets["css/main.css"].fingerprinted;
  check("css/main fingerprinted is css/main.<16hex>.css", /^css\/main\.[a-f0-9]{16}\.css$/.test(fp));
  check("fingerprinted name matches the Worker immutable detector", /\.[a-f0-9]{8,}\.[a-z0-9]+$/.test(fp));
  check("manifest still carries the release version",     typeof manifest.version === "string" && manifest.version.length > 0);
}

function _containerEmitsFingerprinted() {
  var mainFp  = manifest.assets["css/main.css"].fingerprinted;       // "css/main.<hash>.css"
  var mainSri = manifest.assets["css/main.css"].integrity;
  var expectedHref = "/assets/themes/default/" + mainFp;

  var home = storefront.renderHome({ products: [], shop_name: "Acme" });
  var link = _stylesheetLink(home);
  check("storefront emits a stylesheet link",          link !== null);
  check("storefront link uses the fingerprinted href", link.indexOf("href=\"" + expectedHref + "\"") !== -1);
  check("storefront link carries no ?v= cache-buster", link.indexOf("?v=") === -1);
  check("storefront link carries the matching integrity", link.indexOf("integrity=\"" + mainSri + "\"") !== -1);
  check("expected href is /assets/themes/default/css/main.<hash>.css",
    expectedHref === "/assets/themes/default/css/main." + mainFp.split(".")[1] + ".css");

  // Admin console stylesheet — same discipline, separate asset.
  var adminFp  = manifest.assets["css/admin.css"].fingerprinted;
  var adminSri = manifest.assets["css/admin.css"].integrity;
  var adminExpected = "/assets/themes/default/" + adminFp;
  var login = admin.renderAdminLogin({ shop_name: "Acme" });
  var adminLink = _stylesheetLink(login);
  check("admin emits a stylesheet link",               adminLink !== null);
  check("admin link uses the fingerprinted href",      adminLink.indexOf("href=\"" + adminExpected + "\"") !== -1);
  check("admin link carries no ?v= cache-buster",      adminLink.indexOf("?v=") === -1);
  check("admin link carries the matching integrity",   adminLink.indexOf("integrity=\"" + adminSri + "\"") !== -1);
}

async function _edgeContainerParity() {
  // The edge render modules live under worker/, which the container build
  // context excludes (.dockerignore) — so in the in-image smoke gate
  // worker/render/home.js isn't present. Skip the edge-parity assertions in
  // that context; they're covered by the full-tree CI run where worker/ IS
  // present, and the container-side fingerprint checks above still exercise
  // this image. Mirrors the asset-manifest check treating the worker copy as
  // optional outside the full tree.
  var fs = require("node:fs");
  var edgeHomePath = nodePath.join(WORKER_DIR, "home.js");
  if (!fs.existsSync(edgeHomePath)) return;

  _registerJsonHook();
  // Dynamic import needs a file:// URL (Windows absolute paths aren't valid
  // ESM specifiers otherwise). Node prints a one-shot
  // MODULE_TYPELESS_PACKAGE_JSON notice when it reparses the typeless edge
  // `.js` as ESM — expected and harmless: production bundles the edge with
  // esbuild, and this repo can't set `"type":"module"` because lib/ is
  // CommonJS. It's an informational stderr line, not a test signal.
  var edgeHome = await import(nodeUrl.pathToFileURL(edgeHomePath).href);

  var containerHome = storefront.renderHome({ products: [], shop_name: "Acme" });
  var edgeHomeHtml  = edgeHome.renderHome({ products: [], shopName: "Acme", version: manifest.version });

  var containerLink = _stylesheetLink(containerHome);
  var edgeLink      = _stylesheetLink(edgeHomeHtml);
  check("edge home emits a stylesheet link", edgeLink !== null);
  check("edge + container stylesheet links are byte-identical", containerLink === edgeLink);

  // The fingerprinted href the edge emits must equal the manifest entry —
  // the same key sync-r2-assets.js uploads — so the deploy is consistent.
  var expectedHref = "/assets/themes/default/" + manifest.assets["css/main.css"].fingerprinted;
  check("edge link points at the manifest fingerprinted path",
    edgeLink.indexOf("href=\"" + expectedHref + "\"") !== -1);
}

function _fingerprintTracksBytes() {
  // Reproduce the manifest's fingerprint rule (first 16 hex of SHA3-512)
  // over a fixture, then flip one byte and confirm the fingerprint moves.
  function fingerprint(bytes) { return b.crypto.sha3Hash(bytes).slice(0, 16); }
  var fixtureA = Buffer.from(".btn { color: #fa4f09 }\n", "utf8");
  var fixtureB = Buffer.from(".btn { color: #fa4f0a }\n", "utf8");  // one hex digit changed
  var fpA = fingerprint(fixtureA);
  var fpB = fingerprint(fixtureB);
  check("fingerprint is 16 lowercase-hex chars", /^[a-f0-9]{16}$/.test(fpA));
  check("fingerprint is deterministic for the same bytes", fingerprint(fixtureA) === fpA);
  check("fingerprint changes when the asset bytes change", fpA !== fpB);

  // And the live css/main.css fingerprint equals the manifest's, proving the
  // committed manifest is in sync with the bytes the renderer references.
  var fs       = require("node:fs");
  var mainBytes = fs.readFileSync(nodePath.join(REPO_ROOT, "themes", "default", "assets", "css", "main.css"));
  var liveFp    = fingerprint(mainBytes);
  var manifestFp = manifest.assets["css/main.css"].fingerprinted.split(".")[1];
  check("manifest css/main fingerprint matches the on-disk bytes", liveFp === manifestFp);
}

async function run() {
  _manifestShape();
  _containerEmitsFingerprinted();
  await _edgeContainerParity();
  _fingerprintTracksBytes();
}

module.exports = { run: run };
