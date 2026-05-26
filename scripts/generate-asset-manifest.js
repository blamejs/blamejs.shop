"use strict";
/**
 * Generate the asset integrity + version manifest.
 *
 * The storefront and admin renderers stamp a Subresource Integrity digest
 * (sha384) and a `?v=` cache-buster onto the `<link>` / `<script>` tags
 * they emit for the shipped default theme. Computing the digest by reading
 * the asset off disk at render time fails in production — the container
 * image doesn't ship `themes/`, and the edge Worker has no filesystem — so
 * the attribute was silently omitted live and the Worker fell back to a
 * `0.0.0` version. This bakes both into a committed manifest that the
 * container renderers (`require`) and the edge Worker (bundled `import`)
 * read directly, so the integrity + version are present in every runtime.
 *
 * Two identical copies are written so each runtime imports from its own
 * tree: `lib/asset-manifest.json` (container) and `worker/asset-manifest.json`
 * (bundled into the Worker). Keys are the path under the default theme's
 * asset root (e.g. `css/main.css`, `js/passkey-login.js`) — exactly the
 * argument the renderers already pass.
 *
 *   node scripts/generate-asset-manifest.js --rebuild   # write both copies
 *   node scripts/generate-asset-manifest.js --check      # fail on drift
 */

var fs   = require("node:fs");
var path = require("node:path");
var b    = require("../lib/vendor/blamejs");

var REPO_ROOT  = path.resolve(__dirname, "..");
var ASSET_ROOT = path.join(REPO_ROOT, "themes", "default", "assets");
var VERSION    = require("../package.json").version;
// Both runtimes read a committed copy. `lib/` is REQUIRED — the container
// runtime (lib/storefront.js, lib/admin.js) unconditionally requires it and
// it's present in every build context that runs this check. `worker/` is
// OPTIONAL for the check — the container image build excludes worker/
// (.dockerignore), so it's legitimately absent there; its drift is caught
// in the full-tree CI run and the edge build, where it IS present.
var TARGETS    = [
  { file: path.join(REPO_ROOT, "lib", "asset-manifest.json"),    required: true },
  { file: path.join(REPO_ROOT, "worker", "asset-manifest.json"), required: false },
];

// Extensions that get an integrity attribute on a <link>/<script>. Fonts
// load via @font-face url(), which carries no integrity, so they're out.
var HASHED_EXTS = { ".css": true, ".js": true, ".mjs": true };

function _walk(dir, prefix, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    var rel = prefix ? prefix + "/" + ent.name : ent.name;
    if (ent.isDirectory()) { _walk(path.join(dir, ent.name), rel, out); return; }
    if (HASHED_EXTS[path.extname(ent.name).toLowerCase()]) {
      out[rel] = b.crypto.sri(fs.readFileSync(path.join(dir, ent.name)), { algorithm: "sha384" });
    }
  });
}

function build() {
  var assets = {};
  _walk(ASSET_ROOT, "", assets);
  // Stable key order so the serialized manifest is diff-friendly.
  var ordered = {};
  Object.keys(assets).sort().forEach(function (k) { ordered[k] = assets[k]; });
  return JSON.stringify({ version: VERSION, assets: ordered }, null, 2) + "\n";
}

var mode = process.argv.indexOf("--check") !== -1 ? "check" : "rebuild";
var manifest = build();

if (mode === "check") {
  var drift = false;
  var checked = 0;
  TARGETS.forEach(function (t) {
    var rel = path.relative(REPO_ROOT, t.file);
    if (!fs.existsSync(t.file)) {
      if (t.required) {
        // A required copy must be present wherever the check runs — its
        // absence means an accidental deletion (or a never-generated
        // manifest), and the runtime that requires it would break.
        drift = true;
        console.error("[asset-manifest] MISSING — " + rel +
          " is required; run `node scripts/generate-asset-manifest.js --rebuild`");
      } else {
        // Optional copy absent from this build context (e.g. the container
        // image excludes worker/). Its drift is caught in the full-tree CI
        // run + the edge build, where it IS present.
        console.log("[asset-manifest] skip — " + rel + " not in this context");
      }
      return;
    }
    checked += 1;
    if (fs.readFileSync(t.file, "utf8") !== manifest) {
      drift = true;
      console.error("[asset-manifest] DRIFT — " + rel +
        " is stale; run `node scripts/generate-asset-manifest.js --rebuild`");
    }
  });
  if (drift) process.exit(1);
  console.log("[asset-manifest] OK — " + checked + " manifest(s) match the on-disk assets (v" + VERSION + ")");
} else {
  TARGETS.forEach(function (t) { fs.writeFileSync(t.file, manifest); });
  var n = Object.keys(JSON.parse(manifest).assets).length;
  console.log("[asset-manifest] OK — wrote " + n + " asset digest(s) at v" + VERSION + " to lib/ + worker/");
}
