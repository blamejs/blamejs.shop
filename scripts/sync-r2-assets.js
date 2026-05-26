"use strict";
/**
 * Sync repo-sourced static assets to the R2 bucket the Worker serves
 * `/assets/*` from.
 *
 * `wrangler deploy` ships the Worker + container but does NOT upload R2
 * objects, so a theme-CSS change silently drifts from the freshly-deployed
 * HTML — the page markup is new while `main.css` is whatever was last
 * hand-uploaded. (That gap once shipped an "old UI" cart: new classes,
 * stale stylesheet.) Run this after every deploy so R2 matches the code;
 * `npm run deploy` chains `wrangler deploy` + this script.
 *
 *   node scripts/sync-r2-assets.js            # uploads to the remote bucket
 *   node scripts/sync-r2-assets.js --dry-run  # print what would upload
 *
 * Mapping: a theme keeps its static files under `themes/<name>/assets/…`
 * in the repo, and the Worker serves them at `/assets/themes/<name>/…`
 * (assetPrefix `/assets/` + the R2 key). So the R2 key drops the per-theme
 * `assets/` segment: `themes/default/assets/css/main.css` →
 * `themes/default/css/main.css`. Brand images / media are operator-managed
 * in R2 directly and are not repo-sourced, so they're left untouched.
 *
 * Content-fingerprinted keys: the renderers reference SRI-bearing assets
 * (`.css` / `.js` / `.mjs`) by a content-fingerprinted name
 * (`css/main.<hash>.css`) so the Worker/R2 deploy order doesn't matter. For
 * each such default-theme asset this uploads the SAME bytes a SECOND time
 * under the fingerprinted key (`themes/default/css/main.<hash>.css`) IN
 * ADDITION to the plain key — the plain key still serves any non-default
 * theme and any direct fetch. The logical→fingerprinted map is read from the
 * committed manifest (lib/asset-manifest.json), the same source the
 * renderers read, so the uploaded key matches the emitted `<link>`/`<script>`
 * URL exactly. Previously-uploaded fingerprinted objects are NEVER deleted:
 * pages already served reference the old hash, and the old object is what
 * keeps them working until they're re-fetched. Non-hashed assets (fonts,
 * images, brand) keep only their plain keys.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var childProc = require("node:child_process");

var BUCKET    = "blamejs-shop-assets";
var REPO_ROOT = nodePath.resolve(__dirname, "..");
var THEMES    = nodePath.join(REPO_ROOT, "themes");
var DRY_RUN   = process.argv.indexOf("--dry-run") !== -1;

// The asset manifest maps a default-theme asset path (`css/main.css`) to its
// content-fingerprinted name (`css/main.<hash>.css`). Read from lib/ — the
// container copy is always present and is the byte-identical twin of the
// worker copy the edge bundles. Only the default theme is fingerprinted
// (it's the only theme whose bytes the framework ships and hashes).
var FINGERPRINT_MANIFEST = require("../lib/asset-manifest.json");
var FINGERPRINTED_EXTS   = { ".css": true, ".js": true, ".mjs": true };

// Content types by extension — set explicitly so a stylesheet is served as
// text/css (a wrong type makes the browser refuse it under strict MIME).
var CONTENT_TYPES = {
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff",
  ".json": "application/json", ".txt": "text/plain", ".xml": "application/xml",
};

function _walk(dir, prefixParts, out) {
  nodeFs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    var abs = nodePath.join(dir, ent.name);
    var parts = prefixParts.concat([ent.name]);
    if (ent.isDirectory()) { _walk(abs, parts, out); }
    else if (ent.isFile()) { out.push({ file: abs, rel: parts.join("/") }); }
  });
  return out;
}

function _collectJobs() {
  var jobs = [];
  if (!nodeFs.existsSync(THEMES)) return jobs;
  nodeFs.readdirSync(THEMES, { withFileTypes: true }).forEach(function (ent) {
    if (!ent.isDirectory()) return;
    var assetsDir = nodePath.join(THEMES, ent.name, "assets");
    if (!nodeFs.existsSync(assetsDir)) return;
    var isDefault = ent.name === "default";
    _walk(assetsDir, [], []).forEach(function (f) {
      // Always upload under the plain key.
      jobs.push({ file: f.file, key: "themes/" + ent.name + "/" + f.rel });
      // For the default theme's SRI-bearing assets, also upload the SAME
      // bytes under the fingerprinted key the renderers emit. The manifest
      // is keyed by the asset path under the theme root (e.g. `css/main.css`)
      // and carries the fingerprinted name (`css/main.<hash>.css`).
      if (!isDefault) return;
      if (!FINGERPRINTED_EXTS[nodePath.extname(f.rel).toLowerCase()]) return;
      var entry = FINGERPRINT_MANIFEST.assets[f.rel];
      if (!entry || !entry.fingerprinted) return;
      jobs.push({ file: f.file, key: "themes/" + ent.name + "/" + entry.fingerprinted });
    });
  });
  return jobs;
}

// Run wrangler by invoking its JS entry with the current Node binary —
// not `npx`/`wrangler.cmd`, which spawn can't launch without a shell on
// Windows (EINVAL). An argv array (shell:false) handles the spaces +
// parens in the repo path natively and has no injection surface.
function _wranglerArgs(rest) { return [require.resolve("wrangler/bin/wrangler.js")].concat(rest); }

function main() {
  var jobs = _collectJobs();
  if (jobs.length === 0) {
    process.stdout.write("[sync-r2-assets] no theme assets found under themes/*/assets/\n");
    return;
  }
  for (var i = 0; i < jobs.length; i += 1) {
    var job = jobs[i];
    var ext = nodePath.extname(job.key).toLowerCase();
    var ct  = CONTENT_TYPES[ext] || "application/octet-stream";
    process.stdout.write("[sync-r2-assets] " + (DRY_RUN ? "(dry-run) " : "") + job.key + "  (" + ct + ")\n");
    if (DRY_RUN) continue;
    var args = _wranglerArgs(["r2", "object", "put", BUCKET + "/" + job.key,
                "--file", job.file, "--content-type", ct, "--remote"]);
    var res = childProc.spawnSync(process.argv[0], args, { stdio: "inherit", shell: false });
    if (res.error) { process.stderr.write("[sync-r2-assets] FAILED " + job.key + ": " + res.error.message + "\n"); process.exit(1); }
    if (res.status !== 0) { process.stderr.write("[sync-r2-assets] FAILED " + job.key + " (exit " + res.status + ")\n"); process.exit(res.status || 1); }
  }
  process.stdout.write("[sync-r2-assets] OK — " + jobs.length + " asset(s) synced to " + BUCKET + "\n");
}

main();
