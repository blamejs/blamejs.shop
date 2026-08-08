#!/usr/bin/env node
"use strict";
/**
 * Verify an upstream release artifact before it is unpacked into lib/vendor/.
 *
 * This is the INBOUND half of the release-signing story. `sign-release-artifact.js`
 * signs what this project publishes; this checks what this project consumes. They
 * are separate concerns with separate keys and opposite trust directions, which is
 * why they are separate files.
 *
 * The vendored framework is the single largest piece of code this project ships and
 * it arrives over the network. Fetching it with a bare `git clone` trusts whatever
 * the host serves at that moment: a tag can be moved, a release re-cut, a mirror
 * interposed. blamejs publishes an ML-DSA-65 signature and a SHA3-512 digest for
 * exactly this reason, so the refresh verifies both and refuses to unpack anything
 * that does not match.
 *
 * Two checks, in order, both fatal:
 *
 *   1. SHA3-512 of the tarball equals the digest published alongside it. This
 *      catches truncation and corruption cheaply, before any parsing.
 *   2. The ML-DSA-65 signature verifies against the PINNED public key in
 *      keys/vendor-blamejs-pqc-pub.json — not against a key fetched at run time
 *      from the same host that served the artifact, which would prove nothing.
 *      An upstream key rotation therefore FAILS CLOSED and needs a reviewed,
 *      deliberate update to the pinned copy.
 *
 * The digest is verified before the signature so a truncated download reports the
 * obvious problem rather than an alarming-looking signature failure.
 *
 * Bootstrapping note: the ML-DSA-65 implementation used here is the one in the
 * CURRENTLY vendored framework, i.e. the version being replaced. That is the normal
 * shape for a pinned-key trust chain — each vendored version vouches for the next —
 * and it is why the pinned key matters more than the transport.
 *
 *   node scripts/verify-vendor-artifact.js <artifact> <sig> <sha3-512-file> [pubkey]
 */

var fs   = require("node:fs");
var path = require("node:path");
var nodeCrypto = require("node:crypto");

var REPO_ROOT  = path.resolve(__dirname, "..");
var DEFAULT_KEY = path.join(REPO_ROOT, "keys", "vendor-blamejs-pqc-pub.json");

var b = require(path.join(REPO_ROOT, "lib", "vendor", "blamejs"));

function fail(msg) {
  process.stderr.write("[verify-vendor] " + msg + "\n");
  process.exit(1);
}

var artifactPath = process.argv[2];
var sigPath      = process.argv[3];
var digestPath   = process.argv[4];
var keyPath      = process.argv[5] || DEFAULT_KEY;

if (!artifactPath || !sigPath || !digestPath) {
  fail("usage: node scripts/verify-vendor-artifact.js <artifact> <sig> <sha3-512-file> [pubkey]");
}
[artifactPath, sigPath, digestPath, keyPath].forEach(function (p) {
  if (!fs.existsSync(p)) fail("missing required file: " + p);
});

var artifact = fs.readFileSync(artifactPath);

// ---- 1. SHA3-512 -----------------------------------------------------------
// The published file is `sha512sum`-shaped: "<hex>  <filename>". Take the first
// whitespace-delimited field and ignore the name, which reflects the upstream
// build directory rather than wherever the download landed.
var digestRaw = fs.readFileSync(digestPath, "utf8").trim();
var expected  = digestRaw.split(/\s+/)[0].toLowerCase();
if (!/^[0-9a-f]{128}$/.test(expected)) {
  fail("could not parse a SHA3-512 hex digest from " + digestPath + " (got '" + digestRaw.slice(0, 80) + "')");
}
var actual = nodeCrypto.createHash("sha3-512").update(artifact).digest("hex");
if (actual !== expected) {
  fail("SHA3-512 MISMATCH — refusing to unpack.\n" +
       "  expected " + expected + "\n" +
       "  actual   " + actual);
}

// ---- 2. ML-DSA-65 signature ------------------------------------------------
var key = JSON.parse(fs.readFileSync(keyPath, "utf8"));
if (key.algorithm !== "ml-dsa-65") {
  fail("pinned key " + keyPath + " declares algorithm '" + key.algorithm + "', expected 'ml-dsa-65'");
}
var pubBytes = Buffer.from(String(key.publicKey), "base64url");

// Re-derive the key's own fingerprint rather than trusting the field beside it,
// so a hand-edit that swaps the key but leaves the fingerprint is caught here.
if (key.fingerprint_sha3_512) {
  var fp = nodeCrypto.createHash("sha3-512").update(pubBytes).digest("hex");
  if (fp !== String(key.fingerprint_sha3_512).toLowerCase()) {
    fail("pinned key is INTERNALLY INCONSISTENT — publicKey does not match its recorded fingerprint.\n" +
         "  recorded " + key.fingerprint_sha3_512 + "\n" +
         "  derived  " + fp);
  }
}

// The signature ships as raw bytes; tolerate a base64url-encoded variant so a
// transport that mangles binary is a clear error rather than a silent mismatch.
var sigBytes = fs.readFileSync(sigPath);
if (sigBytes.length !== 3309) {
  var decoded = Buffer.from(sigBytes.toString("utf8").trim(), "base64url");
  if (decoded.length !== 3309) {
    fail("signature is " + sigBytes.length + " bytes (and " + decoded.length +
         " decoded); ML-DSA-65 signatures are 3309 bytes");
  }
  sigBytes = decoded;
}

var ok = b.pqcSoftware.ml_dsa_65.verify(sigBytes, artifact, pubBytes);
if (!ok) {
  fail("ML-DSA-65 SIGNATURE VERIFICATION FAILED against " + path.relative(REPO_ROOT, keyPath) + ".\n" +
       "  The artifact is not signed by the key this repository has pinned. Either the\n" +
       "  download was tampered with, or upstream rotated its release key. Do NOT re-copy\n" +
       "  the upstream key to clear this — re-review it out of band first.");
}

console.log("[verify-vendor] OK — SHA3-512 matches and the ML-DSA-65 signature verifies against " +
  path.relative(REPO_ROOT, keyPath));
