"use strict";
/**
 * Generate the asset integrity + fingerprint + version manifest.
 *
 * The storefront and admin renderers stamp a Subresource Integrity digest
 * (sha384) onto the `<link>` / `<script>` tags they emit for the shipped
 * default theme, and reference each asset by a content-fingerprinted name
 * (`main.<hash>.css`). Computing those by reading the asset off disk at
 * render time fails in production — the container image doesn't ship
 * `themes/`, and the edge Worker has no filesystem — so the integrity was
 * silently omitted live and the Worker fell back to a `0.0.0` cache-buster.
 * This bakes both into a committed manifest that the container renderers
 * (`require`) and the edge Worker (bundled `import`) read directly, so the
 * integrity + fingerprinted path are present in every runtime.
 *
 * The fingerprint makes the asset pipeline order-independent. The Worker
 * (HTML) and the R2 object store sync on separate, unordered workflows; a
 * plain `main.css?v=<release>` URL points at one mutable object, so a Worker
 * that rolls before R2 has the new bytes serves stale bytes whose hash no
 * longer matches the committed SRI and the browser BLOCKS the asset. A
 * fingerprinted URL maps one-to-one onto a byte-content: a not-yet-synced
 * object 404s (missing) instead of mismatching, and pages already in flight
 * keep working because the old fingerprinted object still exists in R2.
 *
 * Each asset entry carries both the SRI digest and the fingerprinted path
 * under the theme asset root:
 *
 *   "css/main.css": {
 *     "integrity":    "sha384-…",
 *     "fingerprinted": "css/main.<hash>.css"
 *   }
 *
 * The fingerprint is the first 16 lowercase-hex chars of the SHA3-512 of the
 * asset bytes — long enough to be collision-safe for cache-busting and to
 * satisfy the Worker's immutable-cache detector `/\.[a-f0-9]{8,}\.[a-z0-9]+$/`.
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

// Extensions that get an integrity attribute on a <link>/<script> and a
// content-fingerprinted name. Fonts load via @font-face url(), which carries
// no integrity, so they keep their plain names and stay out of the manifest.
var HASHED_EXTS = { ".css": true, ".js": true, ".mjs": true };

// Content fingerprint: first 16 lowercase-hex chars of the SHA3-512 of the
// asset bytes, embedded as `basename.<hash>.ext`. (SHA3-512 is the digest
// the PQC-first crypto surface exposes synchronously; truncating to 16 hex
// chars is collision-safe for cache-busting and satisfies the Worker's
// `/\.[a-f0-9]{8,}\.[a-z0-9]+$/` immutable-cache detector.)
function _fingerprint(rel, bytes) {
  var hash = b.crypto.sha3Hash(bytes).slice(0, 16);
  var dot  = rel.lastIndexOf(".");
  return rel.slice(0, dot) + "." + hash + rel.slice(dot);
}

function _walk(dir, prefix, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    var rel = prefix ? prefix + "/" + ent.name : ent.name;
    if (ent.isDirectory()) { _walk(path.join(dir, ent.name), rel, out); return; }
    if (HASHED_EXTS[path.extname(ent.name).toLowerCase()]) {
      var bytes = fs.readFileSync(path.join(dir, ent.name));
      out[rel] = {
        integrity:    b.crypto.sri(bytes, { algorithm: "sha384" }),
        fingerprinted: _fingerprint(rel, bytes),
      };
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
