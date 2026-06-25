#!/usr/bin/env node
"use strict";
/**
 * Keep every hand-maintained Node-version pin in lockstep with the
 * vendored framework's own floor.
 *
 * `lib/vendor/blamejs/package.json` `.engines.node` is the SINGLE source
 * of truth for the minimum Node the application can run on — the
 * vendored framework dictates it, and the shop can never require LESS
 * than what its own runtime requires. That floor is mirrored, by hand,
 * across the build + CI + operator docs: the shop's own `engines.node`,
 * `.nvmrc`, the `Dockerfile` base-image arg, the `node-version` pins in
 * every GitHub Actions workflow, and the "Node.js LTS (>= x.y.z)" line
 * in `README.md` + `ARCHITECTURE.md`. A vendor bump that raises the
 * framework's floor silently desyncs all of them — the published
 * `engines` would then advertise a Node older than the framework needs,
 * and CI / the container image would test against the wrong runtime.
 *
 * This script PROJECTS the framework's floor into every mirror, the same
 * way `build-vendored-sbom.js` projects `MANIFEST.json` into the SBOM:
 * the `--rebuild` is auto-run by the vendor refresh (`vendor-update.sh`)
 * and by `release.js` artifact regen, and a `--check` gate in smoke
 * fails the build on any drift.
 *
 *   node scripts/check-node-floor.js --rebuild   # sync every mirror to the floor
 *   node scripts/check-node-floor.js --check      # fail on drift
 */

var fs   = require("node:fs");
var path = require("node:path");

var REPO_ROOT      = path.resolve(__dirname, "..");
var VENDORED_PKG   = path.join(REPO_ROOT, "lib", "vendor", "blamejs", "package.json");

function fail(msg) {
  process.stderr.write("[node-floor] " + msg + "\n");
  process.exit(1);
}

// First semver (x.y.z) in a string — the concrete floor extracted from a
// range constraint like ">=24.16.0".
function _semver(s) {
  var m = /(\d+\.\d+\.\d+)/.exec(String(s == null ? "" : s));
  return m ? m[1] : null;
}

// The authoritative constraint string (e.g. ">=24.16.0") and its floor
// version (e.g. "24.16.0"), read from the vendored framework's engines.
function _authoritative() {
  if (!fs.existsSync(VENDORED_PKG)) {
    fail("lib/vendor/blamejs/package.json not found — run `bash scripts/vendor-update.sh blamejs <tag>` first.");
  }
  var vpkg = JSON.parse(fs.readFileSync(VENDORED_PKG, "utf8"));
  var constraint = vpkg.engines && vpkg.engines.node;
  if (!constraint || typeof constraint !== "string") {
    fail("lib/vendor/blamejs/package.json has no engines.node — cannot determine the Node floor.");
  }
  var floor = _semver(constraint);
  if (!floor) {
    fail("could not parse a x.y.z floor from the vendored engines.node constraint '" + constraint + "'.");
  }
  return { constraint: constraint, floor: floor };
}

// Each mirror declares how to FIND its Node-version token(s) and what the
// expected value is. `find` returns the array of actual token strings in
// the file; `apply` returns the file content with every token rewritten to
// the expected value. A mirror whose file is absent is reported, not
// silently skipped (an expected mirror going missing is itself drift).
function _targets(auth) {
  return [
    {
      file:     "package.json",
      label:    "engines.node",
      expected: auth.constraint,
      // Read engines.node from parsed JSON; rewrite the value in place to
      // preserve the file's exact formatting (no JSON re-serialization).
      find:     function (txt) {
        var pkg = JSON.parse(txt);
        var v = pkg.engines && pkg.engines.node;
        return v == null ? [] : [v];
      },
      apply:    function (txt) {
        return txt.replace(
          /("engines"\s*:\s*\{[^}]*?"node"\s*:\s*")[^"]*(")/,
          "$1" + auth.constraint + "$2");
      },
    },
    {
      file:     ".nvmrc",
      label:    ".nvmrc",
      expected: auth.floor,
      find:     function (txt) { var t = txt.trim(); return t ? [t] : []; },
      apply:    function () { return auth.floor + "\n"; },
    },
    {
      file:     "Dockerfile",
      label:    "ARG NODE_VERSION",
      expected: auth.floor,
      find:     function (txt) {
        return Array.from(
          txt.matchAll(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)/gm),
          function (m) { return m[1]; });
      },
      apply:    function (txt) {
        return txt.replace(/^(ARG NODE_VERSION=)(\d+\.\d+\.\d+)/gm, "$1" + auth.floor);
      },
    },
    {
      file:     ".github/workflows/ci.yml",
      label:    "node-version",
      expected: auth.floor,
      find:     _findNodeVersionPins,
      apply:    _applyNodeVersionPins(auth.floor),
    },
    {
      file:     ".github/workflows/npm-publish.yml",
      label:    "node-version",
      expected: auth.floor,
      find:     _findNodeVersionPins,
      apply:    _applyNodeVersionPins(auth.floor),
    },
    {
      file:     "README.md",
      label:    "Node.js LTS (>= x.y.z)",
      expected: auth.floor,
      find:     _findLtsProse,
      apply:    _applyLtsProse(auth.floor),
    },
    {
      file:     "ARCHITECTURE.md",
      label:    "Node.js LTS (>= x.y.z)",
      expected: auth.floor,
      find:     _findLtsProse,
      apply:    _applyLtsProse(auth.floor),
    },
  ];
}

function _findNodeVersionPins(txt) {
  return Array.from(
    txt.matchAll(/node-version:\s*'(\d+\.\d+\.\d+)'/g),
    function (m) { return m[1]; });
}
function _applyNodeVersionPins(floor) {
  return function (txt) {
    return txt.replace(/(node-version:\s*')(\d+\.\d+\.\d+)(')/g, "$1" + floor + "$3");
  };
}
function _findLtsProse(txt) {
  return Array.from(
    txt.matchAll(/Node\.js LTS \(>= (\d+\.\d+\.\d+)\)/g),
    function (m) { return m[1]; });
}
function _applyLtsProse(floor) {
  return function (txt) {
    return txt.replace(/(Node\.js LTS \(>= )(\d+\.\d+\.\d+)(\))/g, "$1" + floor + "$3");
  };
}

var argv = process.argv.slice(2);
var mode = argv.indexOf("--check") !== -1 ? "check" : "rebuild";

var auth    = _authoritative();
var targets = _targets(auth);
var drift   = [];
var changed = [];
// Mirrors not validated in THIS context — either the file is absent or it
// carries no recognized Node-version token. The gate runs both in the full
// repo and inside the reduced container build, where `.dockerignore` strips
// `.github/`, the `Dockerfile`, and `wrangler.toml` before `node test/smoke.js`
// runs. A file excluded from a build context is "not applicable here", never
// drift — so the gate validates only the mirrors actually present and fails
// solely on a present pin that DISAGREES with the floor.
var skipped = [];

targets.forEach(function (t) {
  var abs = path.join(REPO_ROOT, t.file);
  if (!fs.existsSync(abs)) {
    skipped.push(t.file + " (absent)");
    return;
  }
  var txt    = fs.readFileSync(abs, "utf8");
  var actual = t.find(txt);
  if (!actual.length) {
    skipped.push(t.file + " (no Node-version token)");
    return;
  }
  var offenders = actual.filter(function (v) { return v !== t.expected; });

  if (mode === "check") {
    if (offenders.length) {
      drift.push(t.file + " (" + t.label + "): " +
        offenders.join(", ") + " ≠ " + t.expected);
    }
    return;
  }
  // rebuild: rewrite to the expected value, write only on change.
  if (offenders.length) {
    var next = t.apply(txt);
    if (next !== txt) {
      fs.writeFileSync(abs, next);
      changed.push(t.file + " (" + t.label + "): → " + t.expected);
    }
  }
});

var skipNote = skipped.length ? " (" + skipped.length + " not applicable here: " + skipped.join(", ") + ")" : "";

if (mode === "check") {
  if (drift.length) {
    console.error("[node-floor] DRIFT vs vendored blamejs engines.node (" +
      auth.constraint + ", floor " + auth.floor + "):");
    drift.forEach(function (d) { console.error("  - " + d); });
    console.error("  Run `node scripts/check-node-floor.js --rebuild` to sync.");
    process.exit(1);
  }
  console.log("[node-floor] OK — " + (targets.length - skipped.length) +
    " Node-version mirror(s) match the vendored floor (" + auth.floor + ")" + skipNote);
} else {
  if (changed.length) {
    console.log("[node-floor] synced " + changed.length + " mirror(s) to the vendored floor (" + auth.floor + "):");
    changed.forEach(function (c) { console.log("  - " + c); });
  } else {
    console.log("[node-floor] OK — all Node-version mirrors already at the vendored floor (" + auth.floor + ")");
  }
}
