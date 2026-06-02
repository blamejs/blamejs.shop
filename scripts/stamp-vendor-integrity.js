"use strict";
/**
 * Stamp per-file integrity hashes for the vendored blamejs tree into
 * lib/vendor/MANIFEST.json.
 *
 * Run by scripts/vendor-update.sh after a refresh (and once, by hand, to
 * stamp the currently-committed tree). It populates
 * `packages.blamejs.files` + `packages.blamejs.hashes` with one entry PER
 * FILE — the shape the framework's `b.configDrift.verifyVendorIntegrity`
 * iterates (`files[kind] → hashes[kind]`, with hashes as `"sha256:<hex>"`).
 * scripts/check-vendor-integrity.js then recomputes and compares, so a
 * hand-edit to any vendored source — or a refresh that forgot to
 * re-stamp — fails smoke / CI.
 *
 * CROSS-OS DETERMINISM. The gate runs in the smoke matrix
 * (Windows + macOS + Linux) and in the worker-excluded in-image container
 * smoke. For the SHA-256s to match on every runner the vendored bytes must
 * be byte-identical on every checkout:
 *   - `.gitattributes` pins `lib/vendor/** -text binary`, so git stores
 *     and checks out the vendored blobs VERBATIM with no LF↔CRLF
 *     conversion. Whatever bytes are committed are the bytes every OS
 *     checks out — the working tree equals the blob on Windows and Linux
 *     alike, so a hash over working-tree bytes is the same everywhere.
 *   - Relative paths are POSIX-normalized (forward slashes) and sorted
 *     lexicographically, so the manifest serialization is stable
 *     regardless of the host filesystem's directory-read order.
 *
 * SHA-256 vs PQC-first: the project default is PQC-first crypto, but this
 * stamper matches the EXACT format the vendored primitive verifies
 * (`"sha256:" + sha256(bytes)`), so the gate composes the framework's own
 * integrity check rather than hand-rolling a second hasher. node:crypto
 * here lives in scripts/ (outside the lib + worker scope the `no-sha2`
 * detector scans), and SHA-256 used purely as a tamper-detection digest is
 * exactly the integrity use that detector's reason text permits.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");
var nodeCrypto = require("node:crypto");

var REPO_ROOT    = nodePath.resolve(__dirname, "..");
var VENDOR_DIR   = nodePath.join(REPO_ROOT, "lib", "vendor", "blamejs");
var MANIFEST     = nodePath.join(REPO_ROOT, "lib", "vendor", "MANIFEST.json");
var REL_PREFIX   = "lib/vendor/blamejs/"; // the path prefix stored in `files`

// Recursively collect every file under `dir`, returning POSIX-normalized
// paths relative to the vendor root. Mirrors the `_walk` recursion shape
// in sync-r2-assets.js.
function _walk(dir, prefixParts, out) {
  nodeFs.readdirSync(dir, { withFileTypes: true }).forEach(function (ent) {
    var abs = nodePath.join(dir, ent.name);
    var parts = prefixParts.concat([ent.name]);
    if (ent.isDirectory()) { _walk(abs, parts, out); }
    else if (ent.isFile()) { out.push(parts.join("/")); }
  });
  return out;
}

function _sha256(abs) {
  var bytes = nodeFs.readFileSync(abs);
  return "sha256:" + nodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

function main() {
  if (!nodeFs.existsSync(VENDOR_DIR)) {
    process.stderr.write("[stamp-vendor-integrity] vendor dir missing: " + VENDOR_DIR + "\n");
    process.exit(1);
  }
  // Lexicographic sort → stable serialization independent of readdir order.
  var rels = _walk(VENDOR_DIR, [], []).sort();

  var manifest = JSON.parse(nodeFs.readFileSync(MANIFEST, "utf8"));
  manifest.packages = manifest.packages || {};
  manifest.packages.blamejs = manifest.packages.blamejs || {};
  var pkg = manifest.packages.blamejs;

  var files = {};
  var hashes = {};
  for (var i = 0; i < rels.length; i += 1) {
    var rel = rels[i];
    files[rel]  = REL_PREFIX + rel;
    hashes[rel] = _sha256(nodePath.join(VENDOR_DIR, rel));
  }
  // Replace the old single `files.server` directory entry with the per-file
  // maps; leave version / tag / license / source / bundler / _about intact.
  pkg.files  = files;
  pkg.hashes = hashes;

  // Byte-identical serializer to vendor-update.sh's inline MANIFEST writer
  // (JSON.stringify(m, null, 2) + "\n") so smoke's vendor-drift posture is
  // stable.
  nodeFs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  process.stdout.write("[stamp-vendor-integrity] stamped " + rels.length +
    " files into " + nodePath.relative(REPO_ROOT, MANIFEST) + "\n");
}

main();
