"use strict";
/**
 * Delivery-estimate dual-render parity — the "Get it by <date>" markup builder
 * must land BYTE-IDENTICAL in the container's lib/storefront.js and the edge
 * twin worker/render/product.js. The PDP is dual-rendered (edge-cached HTML for
 * anonymous visitors, container HTML for signed-in ones); a drift between the
 * two substrates' builders would break the render-parity contract.
 *
 * The edge ALWAYS passes estimate=null (the arrival date is per-customer +
 * destination-specific and edge HTML is shared across visitors), so the EDGE
 * output is `_buildDeliveryEstimate(null)` === "" — verified here directly. The
 * builder + its date formatter are pinned byte-for-byte between the files.
 *
 * The worker/ tree is EXCLUDED from the container build context, so the read of
 * worker/render/product.js is GUARDED with fs.existsSync IMMEDIATELY before the
 * read — an unguarded read ENOENT-bricks the in-image smoke and the deploy.
 * When worker/ is absent the test early-returns clean.
 *
 * Network: zero — source-string comparison + a pure-function null check.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

// Extract a named top-level `function NAME(...) { ... }` body by matching to
// the first `\n}\n` after the declaration — the same isolation the buybox
// parity test uses. Both substrates declare these identically.
function _extractFn(src, name) {
  var start = src.indexOf("function " + name + "(");
  if (start === -1) return null;
  var end = src.indexOf("\n}\n", start);
  if (end === -1) return null;
  return src.slice(start, end);
}

function _norm(s) { return s == null ? s : s.replace(/\r\n/g, "\n"); }

async function _run() {
  var containerPath = nodePath.resolve(__dirname, "..", "..", "lib", "storefront.js");
  var workerPath    = nodePath.resolve(__dirname, "..", "..", "worker", "render", "product.js");

  var containerSrc = _norm(nodeFs.readFileSync(containerPath, "utf8"));

  // The builder renders empty for the null estimate the edge always passes —
  // assert that contract on the container source directly (the function is a
  // pure string builder). A non-empty return for null would mean the edge
  // bakes a date into shared cache.
  var cBuild = _extractFn(containerSrc, "_buildDeliveryEstimate");
  check("container _buildDeliveryEstimate extracted", !!cBuild);
  check("builder returns '' on null estimate",        cBuild != null &&
    cBuild.indexOf("if (!estimate || typeof estimate !== \"object\" || !estimate.deliver_by) return \"\";") !== -1);

  // GUARD: worker/ is excluded from the container build context. An unguarded
  // read would ENOENT-brick the in-image smoke and the deploy. Skip cleanly
  // when worker/render/product.js is absent.
  if (!nodeFs.existsSync(workerPath)) {
    check("delivery-estimate parity skipped (worker/ excluded from this build)", true);
    return;
  }
  var workerSrc = _norm(nodeFs.readFileSync(workerPath, "utf8"));

  var cFmt = _extractFn(containerSrc, "_formatDeliveryDate");
  var wFmt = _extractFn(workerSrc, "_formatDeliveryDate");
  check("container _formatDeliveryDate extracted",    !!cFmt);
  check("worker _formatDeliveryDate extracted",       !!wFmt);
  check("date formatter byte-identical",              cFmt != null && cFmt === wFmt);

  var wBuild = _extractFn(workerSrc, "_buildDeliveryEstimate");
  check("worker _buildDeliveryEstimate extracted",    !!wBuild);
  check("delivery-estimate builder byte-identical",   cBuild != null && cBuild === wBuild);

  // Both substrates carry the placeholder in their PDP template + splice it.
  check("container PDP has the placeholder",          containerSrc.indexOf("RAW_DELIVERYESTIMATE_PLACEHOLDER") !== -1);
  check("worker PDP has the placeholder",             workerSrc.indexOf("RAW_DELIVERYESTIMATE_PLACEHOLDER") !== -1);
}

module.exports = { run: _run };
