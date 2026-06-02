"use strict";
/**
 * Recompute-and-compare gate for the vendored blamejs tree.
 *
 * Composes the framework's own `b.configDrift.verifyVendorIntegrity`: it
 * re-hashes every file listed in lib/vendor/MANIFEST.json (stamped by
 * scripts/stamp-vendor-integrity.js) and compares each digest against the
 * pinned `"sha256:<hex>"`. A hand-edit to ANY vendored source — or a
 * vendor refresh that forgot to re-stamp — produces a mismatch and exits
 * non-zero, giving CLAUDE.md hard rules #1 / #11 (no hand-edits to
 * lib/vendor/) real enforcement teeth.
 *
 * Wired into test/smoke.js as a static gate, so it runs in the smoke
 * matrix (Windows + macOS + Linux) AND inside the worker-excluded in-image
 * container smoke. lib/vendor/ ships in the container image (only worker/
 * is excluded — .dockerignore), so the tree is present there too.
 *
 * cwd-independence: the vendored primitive resolves the manifest's
 * relative file paths against `process.cwd()`. Smoke spawns gates with
 * cwd = repo root, but to be robust regardless of where this is invoked
 * from, chdir to the repo root (derived from __dirname) before calling and
 * pass explicit absolute `libVendorDir` / `manifestPath`.
 *
 * Cross-OS hash stability comes from `.gitattributes`
 * `lib/vendor/** -text binary` (the vendored blobs check out byte-for-byte
 * identical on every OS) — see scripts/stamp-vendor-integrity.js.
 *
 * The primitive also `safeEmit`s `vendor.integrity.verified/tampered` to
 * the audit chain, but at gate time there's no booted vault/db so that
 * emit is drop-silent by design. The gate's signal is its exit code.
 */

var nodePath = require("node:path");

var REPO_ROOT    = nodePath.resolve(__dirname, "..");
var LIB_VENDOR   = nodePath.join(REPO_ROOT, "lib", "vendor");
var MANIFEST     = nodePath.join(LIB_VENDOR, "MANIFEST.json");

// chdir so the primitive's process.cwd()-relative `files` resolution lands
// on the repo's vendored tree no matter where the gate was invoked.
process.chdir(REPO_ROOT);

var b = require("../lib/vendor/blamejs");

function main() {
  var result;
  try {
    result = b.configDrift.verifyVendorIntegrity({
      libVendorDir: LIB_VENDOR,
      manifestPath: MANIFEST,
    });
  } catch (e) {
    // VENDOR_MANIFEST_MISSING / VENDOR_MANIFEST_SHAPE (ConfigDriftError) —
    // a missing or unstamped manifest is a gate failure, not a crash.
    var code = (e && e.code) || "ERROR";
    process.stderr.write("[vendor-integrity] FAILED — " + code + ": " + (e && e.message || e) + "\n");
    process.exit(1);
    return;
  }

  if (!result.ok) {
    process.stderr.write("[vendor-integrity] TAMPER DETECTED — " +
      result.mismatches.length + " file(s) differ from the manifest:\n");
    result.mismatches.forEach(function (m) {
      process.stderr.write("  " + m.path + "\n" +
        "    expected " + m.expected + "\n" +
        "    actual   " + m.actual + "\n");
    });
    process.stderr.write("\nIf you refreshed the vendored tree, re-stamp it:\n" +
      "  node scripts/stamp-vendor-integrity.js\n" +
      "Hand-edits to lib/vendor/ are forbidden (CLAUDE.md rule #1 / #11) — " +
      "file the change upstream or compose around it.\n");
    process.exit(1);
    return;
  }

  process.stdout.write("[vendor-integrity] OK — " + result.checkedCount + " files verified\n");
}

main();
