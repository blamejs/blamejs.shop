"use strict";
/**
 * Notify-form dual-render parity — the back-in-stock "Notify me" form must
 * land BYTE-IDENTICAL in the container's lib/storefront.js#_buildBuyBox and
 * the edge twin worker/render/product.js#_buildBuyBox. A drift between the two
 * substrates would break the render-parity gate (the PDP buy box is dual-
 * rendered, byte-identical for every visitor on edge-cached HTML).
 *
 * The worker/ tree is EXCLUDED from the container build context, so the read
 * of worker/render/product.js is GUARDED with fs.existsSync IMMEDIATELY before
 * the read — an unguarded read ENOENT-bricks the in-image smoke and the deploy
 * (see [[worker-test-inimage-deploy-brick]]). When worker/ is absent the test
 * early-returns clean.
 *
 * Network: zero — pure source-string comparison.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

// Extract the byte-for-byte source of the `_notifyForm` helper from a file's
// _buildBuyBox. Both substrates define it identically; this isolates the exact
// markup-producing function so the comparison is precise.
function _extractNotifyForm(src) {
  var start = src.indexOf("function _notifyForm(");
  if (start === -1) return null;
  var end = src.indexOf("\n  }\n", start);
  if (end === -1) return null;
  return src.slice(start, end);
}

// Extract the OOS chip/single tail (addControl + notifyBlock + the return
// statement) — the other place the notify markup is spliced.
function _extractOosTail(src) {
  var start = src.indexOf("var addControl = inStock");
  if (start === -1) return null;
  var rt = src.indexOf("trustLine;", start);
  if (rt === -1) return null;
  var end = src.indexOf("}", rt);
  if (end === -1) return null;
  return src.slice(start, end + 1);
}

function _norm(s) { return s == null ? s : s.replace(/\r\n/g, "\n"); }

async function _run() {
  var containerPath = nodePath.resolve(__dirname, "..", "..", "lib", "storefront.js");
  var workerPath    = nodePath.resolve(__dirname, "..", "..", "worker", "render", "product.js");

  var containerSrc = _norm(nodeFs.readFileSync(containerPath, "utf8"));

  // GUARD: worker/ is excluded from the container build context. An unguarded
  // read would ENOENT-brick the in-image smoke and the deploy. Skip cleanly
  // when worker/render/product.js is absent.
  if (!nodeFs.existsSync(workerPath)) {
    check("buybox parity skipped (worker/ excluded from this build)", true);
    return;
  }
  var workerSrc = _norm(nodeFs.readFileSync(workerPath, "utf8"));

  var cForm = _extractNotifyForm(containerSrc);
  var wForm = _extractNotifyForm(workerSrc);
  check("container _notifyForm extracted",       !!cForm);
  check("worker _notifyForm extracted",          !!wForm);
  check("notify-form helper byte-identical",     cForm != null && cForm === wForm);

  var cTail = _extractOosTail(containerSrc);
  var wTail = _extractOosTail(workerSrc);
  check("container OOS tail extracted",          !!cTail);
  check("worker OOS tail extracted",             !!wTail);
  check("OOS chip/single tail byte-identical",   cTail != null && cTail === wTail);

  // The per-row table splice line must also match.
  var splice = "soldOutRowBtn + _notifyForm(v.sku, v.id)";
  check("container per-row splice present",       containerSrc.indexOf(splice) !== -1);
  check("worker per-row splice present",          workerSrc.indexOf(splice) !== -1);
}

module.exports = { run: _run };
