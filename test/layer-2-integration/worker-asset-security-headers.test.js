"use strict";
/**
 * R2 asset response hardening — the edge Worker serves /assets/* straight
 * from R2, and the media upload path writes arbitrary operator-supplied bytes
 * into that bucket. So an asset leaves the bucket carrying a content-type the
 * operator declared, not one the edge verified. Without protective headers a
 * browser can MIME-sniff a mis-typed upload into something executable, one
 * origin's bytes can be embedded cross-site, and a directly-navigated SVG can
 * run script in the document's own origin (even though the upload path
 * sanitizes SVG before storage).
 *
 * This proves the asset-serving branch stamps the protective headers:
 *   - X-Content-Type-Options: nosniff      on EVERY asset response.
 *   - Cross-Origin-Resource-Policy: same-origin  on every asset response
 *     (the storefront references each asset same-origin, so same-origin is the
 *     tightest value that doesn't break the page).
 *   - Content-Security-Policy sandbox        on an image/svg+xml asset, so a
 *     direct hit on an SVG can't run script (defence in depth behind the
 *     container-side SVG sanitizer the upload path runs).
 *
 * The Worker imports the Cloudflare containers runtime + ESM render modules,
 * so it can't be `require()`d in a plain Node test. The check is anchored to
 * the shipped source: the asset branch must invoke `_hardenAssetResponse`
 * before responding, and the helper body must set the three header values.
 * Drift in any of those (e.g. dropping nosniff, weakening CORP, opening the
 * SVG CSP to script) changes the matched text and fails the assertion — the
 * same source-parity discipline document-policy-header.test.js uses for the
 * edge security-header set.
 *
 * Guarded by existsSync: worker/ is excluded from the container build context
 * (.dockerignore), so when worker/index.js isn't present (in-image smoke) the
 * assertions are skipped rather than crashing the gate; the full-tree CI run
 * has worker/ present and exercises this.
 *
 * Network: zero.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

// Extract the `_hardenAssetResponse` function body verbatim from
// worker/index.js so the assertions run against the SHIPPED bytes, not a copy
// that can drift. Matches `function _hardenAssetResponse(headers) { ... }` up
// to its balanced closing brace.
function _extractHardener(src) {
  var start = src.indexOf("function _hardenAssetResponse(");
  if (start === -1) return "";
  var open = src.indexOf("{", start);
  if (open === -1) return "";
  var depth = 0;
  for (var i = open; i < src.length; i += 1) {
    var ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return "";
}

function _run() {
  var workerIndexPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  if (!nodeFs.existsSync(workerIndexPath)) return;   // worker/ absent in-image — skip

  var src = nodeFs.readFileSync(workerIndexPath, "utf8");

  // (1) The asset-serving branch reads from R2 and MUST invoke the hardener
  //     right before responding — otherwise the helper exists but never runs
  //     on the R2 path.
  check("asset branch reads from R2 (env.ASSETS.get)",
    /env\.ASSETS\.get\(/.test(src));
  check("asset branch calls _hardenAssetResponse before responding",
    /_hardenAssetResponse\(\s*headers\s*\)\s*;[\s\S]{0,160}?return\s+new\s+Response\(\s*obj\.body/.test(src));

  // (2) The shipped helper body must stamp every protective header. Anchor to
  //     the helper's own bytes so an unrelated header elsewhere can't satisfy
  //     these by accident.
  var body = _extractHardener(src);
  check("worker defines a _hardenAssetResponse helper", body.length > 0);

  // X-Content-Type-Options: nosniff on every asset.
  check("hardener sets X-Content-Type-Options: nosniff",
    /headers\.set\(\s*["']x-content-type-options["']\s*,\s*["']nosniff["']\s*\)/i.test(body));

  // Cross-Origin-Resource-Policy: same-origin on every asset.
  check("hardener sets Cross-Origin-Resource-Policy: same-origin",
    /["']cross-origin-resource-policy["']\s*,\s*["']same-origin["']/i.test(body));

  // SVG-only hardening: a CSP gated on the image/svg+xml content-type.
  check("hardener branches on image/svg+xml",
    /image\/svg\+xml/.test(body));
  check("hardener sets a Content-Security-Policy on SVG",
    /headers\.set\(\s*["']content-security-policy["']/i.test(body));

  // The SVG CSP sandboxes script while still letting <img src=…svg> paint:
  // default-src 'none' (no fetch/script/plugin) + style-src 'unsafe-inline'.
  // The CSP literal is a double-quoted string whose value contains single
  // quotes (`'none'`), so capture between the double-quote delimiters and
  // allow single quotes inside the value.
  var cspMatch = body.match(/content-security-policy"\s*,\s*"([^"]+)"/i);
  var csp = cspMatch ? cspMatch[1] : "";
  check("SVG CSP starts from default-src 'none'",
    /default-src\s+'none'/.test(csp));
  check("SVG CSP grants no script source",
    csp.indexOf("script-src 'self'") === -1 && csp.indexOf("script-src 'unsafe-inline'") === -1);
  check("SVG CSP allows inline style so the vector still renders as <img>",
    /style-src\s+'unsafe-inline'/.test(csp));

  // The content-type read is normalized (split on `;`) so a parameterized
  // `image/svg+xml; charset=utf-8` from a real R2 object still matches.
  check("hardener normalizes content-type before matching (splits on ';')",
    /content-type["']?\s*\)\s*\|\|\s*["']{2}\s*\)\s*\.split\(\s*["'];["']\s*\)/.test(body) ||
    /\.split\(\s*["'];["']\s*\)/.test(body));
}

module.exports = { run: _run };

if (require.main === module) {
  _run();
  process.stdout.write("worker-asset-security-headers OK\n");
}
