#!/usr/bin/env node
"use strict";
/**
 * Keep every hand-maintained Node-version pin at or above the vendored
 * framework's own floor, and identical to each other.
 *
 * `lib/vendor/blamejs/package.json` `.engines.node` is the LOWER BOUND on the
 * minimum Node the application can run on: the shop can never require LESS
 * than what its own runtime requires. It may require MORE. A Node patch
 * release that fixes CVEs the framework's declared floor predates is a
 * legitimate reason for the shop to lead, and the framework's floor moves on
 * its own schedule. So the rule enforced here is `shop >= framework`, not
 * `shop == framework`.
 *
 * The floor is mirrored, by hand, across the build + CI + operator docs: the
 * shop's own `engines.node`, `.nvmrc`, the `Dockerfile` base-image arg, the
 * `node-version` pins in every GitHub Actions workflow, and the "Node.js LTS
 * (>= x.y.z)" line in `README.md` + `ARCHITECTURE.md`. Two things go wrong
 * without a gate: a vendor bump that raises the framework's floor leaves the
 * published `engines` advertising a Node older than the framework needs, and
 * a hand-edit to one mirror leaves CI or the container image testing against
 * a different runtime than the one that ships.
 *
 * `--check` fails on either of those: a mirror BELOW the framework floor, or
 * mirrors that disagree with EACH OTHER. `--rebuild` raises every mirror to
 * the effective floor — the higher of the framework's floor and the highest
 * pin already in the tree — and never lowers a deliberate lead. `--rebuild`
 * is auto-run by the vendor refresh (`vendor-update.sh`) and by `release.js`
 * artifact regen; `--check` runs as a smoke gate.
 *
 *   node scripts/check-node-floor.js --rebuild   # raise every mirror to the effective floor
 *   node scripts/check-node-floor.js --check     # fail on drift
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

// Numeric semver ordering. A lexical compare gets this wrong in exactly the
// case that matters here — "24.9.0" sorts above "24.18.0" as a string.
function _cmp(a, b) {
  var pa = String(a).split(".");
  var pb = String(b).split(".");
  for (var i = 0; i < 3; i += 1) {
    var d = Number(pa[i] || 0) - Number(pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Swap the version inside a constraint string while preserving its operator,
// so ">=24.18.0" becomes ">=24.19.0" rather than assuming the ">=" shape.
function _withVersion(constraint, version) {
  return String(constraint).replace(/\d+\.\d+\.\d+/, version);
}

// The framework's declared constraint (e.g. ">=24.18.0") and its floor
// version (e.g. "24.18.0"), read from the vendored tree.
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

// Each mirror declares how to FIND its Node-version token(s), how to reduce a
// token to a bare version for comparison, and what the expected value is at a
// given target. `find` returns the array of actual token strings in the file;
// `apply` returns the file content with every token rewritten to the target. A
// mirror whose file is absent is reported, not silently skipped (an expected
// mirror going missing is itself drift).
function _targets(auth, target) {
  return [
    {
      file:      "package.json",
      label:     "engines.node",
      expected:  _withVersion(auth.constraint, target),
      // The token is a RANGE (">=24.19.0"); compare on its version alone.
      toVersion: _semver,
      // Read engines.node from parsed JSON; rewrite the value in place to
      // preserve the file's exact formatting (no JSON re-serialization).
      find:      function (txt) {
        var pkg = JSON.parse(txt);
        var v = pkg.engines && pkg.engines.node;
        return v == null ? [] : [v];
      },
      apply:     function (txt) {
        return txt.replace(
          /("engines"\s*:\s*\{[^}]*?"node"\s*:\s*")[^"]*(")/,
          "$1" + _withVersion(auth.constraint, target) + "$2");
      },
    },
    {
      file:     ".nvmrc",
      label:    ".nvmrc",
      expected: target,
      find:     function (txt) { var t = txt.trim(); return t ? [t] : []; },
      apply:    function () { return target + "\n"; },
    },
    {
      file:     "Dockerfile",
      label:    "ARG NODE_VERSION",
      expected: target,
      find:     function (txt) {
        return Array.from(
          txt.matchAll(/^ARG NODE_VERSION=(\d+\.\d+\.\d+)/gm),
          function (m) { return m[1]; });
      },
      apply:    function (txt) {
        return txt.replace(/^(ARG NODE_VERSION=)(\d+\.\d+\.\d+)/gm, "$1" + target);
      },
    },
    {
      file:     ".github/workflows/ci.yml",
      label:    "node-version",
      expected: target,
      find:     _findNodeVersionPins,
      apply:    _applyNodeVersionPins(target),
    },
    {
      file:     ".github/workflows/npm-publish.yml",
      label:    "node-version",
      expected: target,
      find:     _findNodeVersionPins,
      apply:    _applyNodeVersionPins(target),
    },
    {
      file:     "README.md",
      label:    "Node.js LTS (>= x.y.z)",
      expected: target,
      find:     _findLtsProse,
      apply:    _applyLtsProse(target),
    },
    {
      file:     "ARCHITECTURE.md",
      label:    "Node.js LTS (>= x.y.z)",
      expected: target,
      find:     _findLtsProse,
      apply:    _applyLtsProse(target),
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

var auth = _authoritative();

// Pass 1 — read what every mirror currently says. The target depends on what
// the tree already holds, so probe with the framework floor and use only the
// target-independent halves of each entry (`find` / `toVersion`).
//
// Mirrors not validated in THIS context — either the file is absent or it
// carries no recognized Node-version token. The gate runs both in the full
// repo and inside the reduced container build, where `.dockerignore` strips
// `.github/`, the `Dockerfile`, and `wrangler.toml` before `node test/smoke.js`
// runs. A file excluded from a build context is "not applicable here", never
// drift — so the gate validates only the mirrors actually present.
var present = [];
var skipped = [];

_targets(auth, auth.floor).forEach(function (t) {
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
  var toV = t.toVersion || function (v) { return v; };
  present.push({
    file:     t.file,
    label:    t.label,
    versions: actual.map(function (v) { return toV(v) || v; }),
  });
});

// The effective floor: the framework's requirement, or a HIGHER pin the shop
// has deliberately adopted, whichever is greater. Taking the max is what makes
// `--rebuild` raise-only — it can never walk a deliberate lead back down to
// the framework's floor.
var target = auth.floor;
present.forEach(function (p) {
  p.versions.forEach(function (v) { if (_cmp(v, target) > 0) target = v; });
});

var targets  = _targets(auth, target);
var skipNote = skipped.length ? " (" + skipped.length + " not applicable here: " + skipped.join(", ") + ")" : "";
var leadNote = _cmp(target, auth.floor) > 0
  ? " — ahead of the vendored framework's " + auth.floor + ", which is allowed"
  : "";

if (mode === "check") {
  // Two distinct failures. BELOW the framework floor means the shop would
  // advertise a Node its own runtime cannot run on. DISAGREEING mirrors mean
  // CI, the container image, and the published `engines` do not all describe
  // the same runtime, whichever way they differ.
  var below    = [];
  var disagree = [];
  present.forEach(function (p) {
    p.versions.forEach(function (v) {
      if (_cmp(v, auth.floor) < 0) {
        below.push(p.file + " (" + p.label + "): " + v + " is below the framework floor " + auth.floor);
      } else if (_cmp(v, target) !== 0) {
        disagree.push(p.file + " (" + p.label + "): " + v + " ≠ " + target);
      }
    });
  });
  if (below.length || disagree.length) {
    console.error("[node-floor] DRIFT (vendored blamejs requires " + auth.constraint + "):");
    below.forEach(function (d) { console.error("  - " + d); });
    disagree.forEach(function (d) { console.error("  - " + d); });
    console.error("  Run `node scripts/check-node-floor.js --rebuild` to sync.");
    process.exit(1);
  }
  console.log("[node-floor] OK — " + present.length +
    " Node-version mirror(s) agree at " + target + leadNote + skipNote);
} else {
  var changed = [];
  targets.forEach(function (t) {
    var abs = path.join(REPO_ROOT, t.file);
    if (!fs.existsSync(abs)) return;
    var txt    = fs.readFileSync(abs, "utf8");
    var actual = t.find(txt);
    if (!actual.length) return;
    var offenders = actual.filter(function (v) { return v !== t.expected; });
    if (!offenders.length) return;
    var next = t.apply(txt);
    if (next !== txt) {
      fs.writeFileSync(abs, next);
      changed.push(t.file + " (" + t.label + "): → " + t.expected);
    }
  });
  if (changed.length) {
    console.log("[node-floor] raised " + changed.length + " mirror(s) to " + target + leadNote + ":");
    changed.forEach(function (c) { console.log("  - " + c); });
  } else {
    console.log("[node-floor] OK — all Node-version mirrors already at " + target + leadNote);
  }
}
