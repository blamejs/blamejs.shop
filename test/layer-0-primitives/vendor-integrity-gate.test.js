"use strict";
/**
 * BLIND-6 integrity-gate behaviour. Proves the gate (scripts/check-vendor-
 * integrity.js, which composes b.configDrift.verifyVendorIntegrity) actually
 * FAILS on tamper — the whole point of pinning per-file hashes in
 * lib/vendor/MANIFEST.json.
 *
 * Runs against a TEMP fixture (manifest + dir), never the real vendored
 * tree, so the test is hermetic and cannot wedge the self-referential smoke
 * gate. Uses ABSOLUTE file paths in the fixture manifest so the primitive's
 * process.cwd()-relative resolution is irrelevant here. Calls the vendored
 * primitive directly — does NOT hand-roll a second hasher (CLAUDE.md
 * rule #1).
 *
 * Also asserts the committed real tree verifies (checkedCount > 0) so a
 * regression in the stamper/manifest surfaces here too.
 *
 * NO worker/ import.
 */

var nodeFs   = require("node:fs");
var nodeOs   = require("node:os");
var nodePath = require("node:path");
var nodeCrypto = require("node:crypto");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;

var b = bShop.framework;

function _sha256(abs) {
  return "sha256:" + nodeCrypto.createHash("sha256").update(nodeFs.readFileSync(abs)).digest("hex");
}

async function _run() {
  var REPO_ROOT  = nodePath.resolve(__dirname, "..", "..");
  var LIB_VENDOR = nodePath.join(REPO_ROOT, "lib", "vendor");
  var MANIFEST   = nodePath.join(LIB_VENDOR, "MANIFEST.json");

  // 1. The committed real tree verifies (the gate is green on commit).
  var real = b.configDrift.verifyVendorIntegrity({ libVendorDir: LIB_VENDOR, manifestPath: MANIFEST });
  check("committed tree verifies ok",   real.ok === true);
  check("committed tree checks >0 files", real.checkedCount > 0);
  check("committed tree no mismatches",  real.mismatches.length === 0);

  // Hermetic fixture: a tiny dir + manifest with ABSOLUTE file paths.
  var dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "blamejs-vint-"));
  try {
    var fileA = nodePath.join(dir, "a.js");
    nodeFs.writeFileSync(fileA, "module.exports = 1;\n");
    var manifestPath = nodePath.join(dir, "MANIFEST.json");
    var manifest = { packages: { x: { files: { a: fileA }, hashes: { a: _sha256(fileA) } } } };
    nodeFs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    // 2. Matching hash → ok.
    var good = b.configDrift.verifyVendorIntegrity({ libVendorDir: dir, manifestPath: manifestPath });
    check("fixture ok when bytes match",   good.ok === true && good.checkedCount === 1);

    // 3. Flip one byte → mismatch (tamper detected).
    nodeFs.writeFileSync(fileA, "module.exports = 2;\n");
    var tampered = b.configDrift.verifyVendorIntegrity({ libVendorDir: dir, manifestPath: manifestPath });
    check("fixture not ok after tamper",   tampered.ok === false);
    check("fixture reports the mismatch",  tampered.mismatches.length === 1 && tampered.mismatches[0].path === fileA);

    // 4. Missing manifest → VENDOR_MANIFEST_MISSING ConfigDriftError.
    var missingThrew = null;
    try {
      b.configDrift.verifyVendorIntegrity({
        libVendorDir: dir,
        manifestPath: nodePath.join(dir, "does-not-exist.json"),
      });
    } catch (e) { missingThrew = e; }
    check("missing manifest throws",        !!missingThrew);
    check("error code VENDOR_MANIFEST_MISSING", missingThrew && missingThrew.code === "VENDOR_MANIFEST_MISSING");
  } finally {
    try { nodeFs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* */ }
  }
}

module.exports = { run: _run };
