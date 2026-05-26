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
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var childProc = require("node:child_process");

var BUCKET    = "blamejs-shop-assets";
var REPO_ROOT = nodePath.resolve(__dirname, "..");
var THEMES    = nodePath.join(REPO_ROOT, "themes");
var DRY_RUN   = process.argv.indexOf("--dry-run") !== -1;

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
    _walk(assetsDir, [], []).forEach(function (f) {
      jobs.push({ file: f.file, key: "themes/" + ent.name + "/" + f.rel });
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
