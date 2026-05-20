#!/usr/bin/env node
"use strict";
/**
 * Build a CycloneDX 1.6 SBOM describing the contents of
 * `lib/vendor/` — the vendored dependencies that ship inside this
 * package's tarball but that don't appear in `npm sbom` (because
 * they're shallow-cloned source trees, not npm-installed packages).
 *
 * Reads `lib/vendor/MANIFEST.json` (the source of truth for what's
 * vendored, with name + version + tag + license + source + the
 * file mapping). Emits a CycloneDX 1.6 application-scope SBOM to
 * stdout. Each MANIFEST entry becomes one CycloneDX component with:
 *   - name, version, purl (`pkg:generic/<name>@<version>?vcs_url=...`)
 *   - license expression (SPDX id)
 *   - external reference back to the upstream repo
 *   - description tying the component to the vendored path
 *
 * The output is paired with `npm sbom` (which captures the npm-tree
 * SBOM — empty for blamejs.shop's zero-runtime-dep package) and
 * cosign-signed in the publish workflow. Both SBOMs ship with their
 * `.sigstore` bundles as GitHub release assets.
 *
 * Invocation:
 *   node scripts/build-vendored-sbom.js > sbom.vendored.cdx.json
 */

var fs   = require("node:fs");
var path = require("node:path");

var REPO_ROOT = path.resolve(__dirname, "..");
var MANIFEST_PATH = path.join(REPO_ROOT, "lib", "vendor", "MANIFEST.json");
var PKG_PATH = path.join(REPO_ROOT, "package.json");

function fail(msg) {
  process.stderr.write("[vendored-sbom] " + msg + "\n");
  process.exit(1);
}

if (!fs.existsSync(MANIFEST_PATH)) {
  fail("lib/vendor/MANIFEST.json not found — run `npm run vendor blamejs <tag>` first.");
}
if (!fs.existsSync(PKG_PATH)) {
  fail("package.json not found at repo root.");
}

var manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
var pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));

if (!manifest.packages || typeof manifest.packages !== "object") {
  fail("MANIFEST.json missing `packages` map.");
}

var components = Object.keys(manifest.packages).map(function (name) {
  var entry = manifest.packages[name];
  if (!entry.version) fail("MANIFEST.json[" + name + "] missing `version`.");
  if (!entry.source)  fail("MANIFEST.json[" + name + "] missing `source` (upstream URL).");
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

var nowIso = new Date().toISOString();
var sbom = {
  "$schema":     "http://cyclonedx.org/schema/bom-1.6.schema.json",
  "bomFormat":   "CycloneDX",
  "specVersion": "1.6",
  "version":     1,
  "serialNumber": "urn:uuid:" + require("node:crypto").randomUUID(),
  "metadata": {
    "timestamp": nowIso,
    "tools": [ {
      "vendor": "blamejs.shop",
      "name":   "build-vendored-sbom.js",
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

process.stdout.write(JSON.stringify(sbom, null, 2) + "\n");
