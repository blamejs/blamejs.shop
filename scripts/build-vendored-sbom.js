#!/usr/bin/env node
"use strict";
/**
 * Generate the vendored-dependency SBOM — a CycloneDX 1.6 document
 * describing the contents of `lib/vendor/` that ship inside this
 * package's tarball but don't appear in `npm sbom` (they're
 * shallow-cloned source trees, not npm-installed packages).
 *
 * `lib/vendor/MANIFEST.json` is the SINGLE source of truth for what's
 * vendored (name + version + tag + license + source + the per-file
 * integrity map). This script mechanically PROJECTS that manifest into
 * the committed parent SBOM `sbom.vendored.cdx.json`, so the SBOM's
 * component versions can never silently fall behind the vendored tree:
 * the projection is auto-run by the vendor refresh (`vendor-update.sh`)
 * and by `release.js` artifact regen, and a `--check` gate in smoke
 * fails the build on any drift — the same protection the CHANGELOG, the
 * release-notes rollup, and the asset-manifest already carry.
 *
 * The output is DETERMINISTIC (a pure function of MANIFEST.json +
 * package.json), so `--check` can byte-compare the committed file
 * against a fresh build:
 *   - `metadata.timestamp` is the latest vendored `bundledAt` (the day
 *     the tree was refreshed), not the wall clock.
 *   - `serialNumber` is a name-based (v5) UUID derived from the SBOM
 *     content, not a random v4 — identical inputs yield an identical
 *     URN.
 *
 * Each MANIFEST entry becomes one CycloneDX component (name, version,
 * `pkg:generic` purl, SPDX license, upstream external references). The
 * document is paired with `npm sbom` (the npm-tree SBOM — empty for
 * this zero-runtime-dep package) and cosign-signed in the publish
 * workflow; both SBOMs ship with their `.sigstore` bundles as release
 * assets.
 *
 *   node scripts/build-vendored-sbom.js --rebuild   # write the committed SBOM
 *   node scripts/build-vendored-sbom.js --check      # fail on drift
 *   node scripts/build-vendored-sbom.js --stdout     # stream to stdout (ad-hoc)
 */

var fs   = require("node:fs");
var path = require("node:path");
var b    = require("../lib/vendor/blamejs");

var REPO_ROOT     = path.resolve(__dirname, "..");
var MANIFEST_PATH = path.join(REPO_ROOT, "lib", "vendor", "MANIFEST.json");
var PKG_PATH      = path.join(REPO_ROOT, "package.json");
var SBOM_PATH     = path.join(REPO_ROOT, "sbom.vendored.cdx.json");

function fail(msg) {
  process.stderr.write("[vendored-sbom] " + msg + "\n");
  process.exit(1);
}

// Name-based (v5) UUID derived from the SBOM content digest. A random
// v4 serialNumber would make the document non-reproducible and defeat
// the `--check` byte-compare; deriving it from the content keeps the
// URN stable across runs while still uniquely keying a given SBOM.
function _uuidFromHashHex(hex) {
  var h = hex.slice(0, 32).split("");
  h[12] = "5"; // version 5 (name-based)
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16); // RFC 4122 variant
  var s = h.join("");
  return s.slice(0, 8) + "-" + s.slice(8, 12) + "-" + s.slice(12, 16) +
    "-" + s.slice(16, 20) + "-" + s.slice(20, 32);
}

// Build the deterministic CycloneDX 1.6 SBOM string from the vendored
// manifest. Pure function of MANIFEST.json + package.json.
function build() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    fail("lib/vendor/MANIFEST.json not found — run `bash scripts/vendor-update.sh blamejs <tag>` first.");
  }
  if (!fs.existsSync(PKG_PATH)) {
    fail("package.json not found at repo root.");
  }

  var manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  var pkg      = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));

  if (!manifest.packages || typeof manifest.packages !== "object") {
    fail("MANIFEST.json missing `packages` map.");
  }

  // Sorted package names so the component order — and therefore the
  // serialized document — is stable regardless of manifest key order.
  var names = Object.keys(manifest.packages).sort();
  if (!names.length) fail("MANIFEST.json `packages` map is empty.");

  // The document timestamp is the most recent vendored `bundledAt`
  // (ISO dates sort lexically), expressed as a CycloneDX datetime. It
  // changes only when the vendored tree is refreshed — never on a bare
  // re-run — so the committed SBOM is reproducible.
  var latestBundledAt = "";

  var components = names.map(function (name) {
    var entry = manifest.packages[name];
    if (!entry.version) fail("MANIFEST.json[" + name + "] missing `version`.");
    if (!entry.source)  fail("MANIFEST.json[" + name + "] missing `source` (upstream URL).");
    if (entry.bundledAt && entry.bundledAt > latestBundledAt) latestBundledAt = entry.bundledAt;
    var purl = "pkg:generic/" + encodeURIComponent(name)
      + "@" + encodeURIComponent(entry.version)
      + "?vcs_url=" + encodeURIComponent(entry.source);
    var component = {
      "bom-ref":     "vendored/" + name + "@" + entry.version,
      "type":        "library",
      "name":        name,
      "version":     entry.version,
      "purl":        purl,
      "scope":       "required",
      "description": "Vendored under " + (entry.files && entry.files.server || "lib/vendor/" + name + "/")
        + " (" + (entry.bundler || "vendored source tree") + ")."
    };
    if (entry.license) {
      component.licenses = [ { "license": { "id": entry.license } } ];
    }
    if (entry.author) {
      component.author = entry.author;
    }
    component.externalReferences = [
      { "type": "vcs",      "url": entry.source },
      { "type": "website",  "url": entry.source }
    ];
    return component;
  });

  var timestamp = (latestBundledAt || "1970-01-01") + "T00:00:00Z";

  // serialNumber is derived from the stable inputs that fully determine
  // the document (package identity + timestamp + the component set), so
  // it is reproducible across runs but unique per SBOM content.
  var serialSeed = b.canonicalJson.stringify({
    name:       pkg.name,
    version:    pkg.version,
    timestamp:  timestamp,
    components: components
  });
  var serial = _uuidFromHashHex(b.crypto.sha3Hash(Buffer.from(serialSeed, "utf8")));

  var sbom = {
    "$schema":      "http://cyclonedx.org/schema/bom-1.6.schema.json",
    "bomFormat":    "CycloneDX",
    "specVersion":  "1.6",
    "serialNumber": "urn:uuid:" + serial,
    "version":      1,
    "metadata": {
      "timestamp": timestamp,
      "tools": [ {
        "vendor":  "blamejs.shop",
        "name":    "build-vendored-sbom.js",
        "version": pkg.version
      } ],
      "component": {
        "bom-ref":     "root/" + pkg.name + "@" + pkg.version,
        "type":        "application",
        "name":        pkg.name,
        "version":     pkg.version,
        "description": "Vendored-dependency SBOM for " + pkg.name
          + " — describes what's under lib/vendor/ that doesn't appear in `npm sbom`."
      }
    },
    "components": components
  };

  return JSON.stringify(sbom, null, 2) + "\n";
}

var argv = process.argv.slice(2);
var mode = argv.indexOf("--check") !== -1 ? "check"
  : argv.indexOf("--stdout") !== -1 ? "stdout"
  : "rebuild";

var sbom = build();
var relPath = path.relative(REPO_ROOT, SBOM_PATH);

if (mode === "stdout") {
  process.stdout.write(sbom);
} else if (mode === "check") {
  if (!fs.existsSync(SBOM_PATH)) {
    console.error("[vendored-sbom] MISSING — " + relPath +
      " is not committed; run `node scripts/build-vendored-sbom.js --rebuild`");
    process.exit(1);
  }
  if (fs.readFileSync(SBOM_PATH, "utf8") !== sbom) {
    console.error("[vendored-sbom] DRIFT — " + relPath +
      " is stale vs lib/vendor/MANIFEST.json; run `node scripts/build-vendored-sbom.js --rebuild`");
    process.exit(1);
  }
  var n = JSON.parse(sbom).components.length;
  console.log("[vendored-sbom] OK — " + relPath + " matches the vendored manifest (" + n + " component(s))");
} else {
  fs.writeFileSync(SBOM_PATH, sbom);
  var c = JSON.parse(sbom).components;
  console.log("[vendored-sbom] OK — wrote " + relPath + " (" +
    c.map(function (x) { return x.name + "@" + x.version; }).join(", ") + ")");
}
