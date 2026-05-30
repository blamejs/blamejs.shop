"use strict";
/**
 * check-currency.js — release gate: fail the cut when a pinned GitHub Action
 * or a vendored dependency is behind its latest upstream release.
 *
 * Wired into `node scripts/release.js prepare` (static gates). Two surfaces:
 *
 *   1. ACTION PINS — every `uses: owner/repo[/subpath]@<40-hex-sha>  # vX.Y.Z`
 *      in `.github/workflows/*` and `.github/actions/**`. A SHA pin without a
 *      moving tag is supply-chain-correct but goes stale silently; this gate
 *      compares the `# vX.Y.Z` comment against the repo's latest release.
 *
 *   2. VENDORED PACKAGES — every entry in `lib/vendor/MANIFEST.json` `packages`,
 *      compared against its GitHub `source` repo's latest release.
 *
 * On a stale pin the gate exits non-zero and prints, per finding, a PASTE-READY
 * replacement line plus EVERY file:line that uses the stale pin, so the fix is
 * copy-paste:
 *
 *   STALE ACTION  actions/checkout  v6.0.0 → v6.1.0
 *     paste:  uses: actions/checkout@<latest-sha>  # v6.1.0
 *     used:   .github/workflows/ci.yml:31
 *     used:   .github/workflows/codeql.yml:26
 *
 * Needs the `gh` CLI authenticated (the same tool release.js already uses).
 * When the GitHub API cannot resolve a release (network / rate limit / a repo
 * that cuts no releases), the affected entry is reported UNVERIFIED and does
 * NOT block — only a CONFIRMED newer release fails the cut, so a transient gh
 * outage never bricks a release (the next prepare re-checks).
 *
 * Conscious deferral (e.g. a major bump you are not ready to adopt):
 *   RELEASE_ALLOW_STALE_PINS=1  — downgrades every stale finding to a warning
 *   and exits 0. The paste-ready lines still print so the debt stays visible.
 */
var fs = require("node:fs");
var path = require("node:path");
var cp = require("node:child_process");

var ROOT = path.resolve(__dirname, "..");
var MANIFEST = path.join(ROOT, "lib", "vendor", "MANIFEST.json");
var ALLOW_STALE = process.env.RELEASE_ALLOW_STALE_PINS === "1";

// `gh` is a native exe release.js spawns directly (no shell shim), so do the
// same. Returns { ok, out } — `out` is the trimmed stdout (jq-reduced if given).
function gh(apiPath, jq) {
  var args = ["api", apiPath];
  if (jq) args.push("--jq", jq);
  var rv = cp.spawnSync("gh", args, { encoding: "utf8" });
  return { ok: rv.status === 0, out: (rv.stdout || "").trim() };
}

// vMAJOR.MINOR.PATCH compare; tolerates a leading `v` and ignores any
// pre-release/build suffix. Returns null on an unparseable string.
function parseVer(v) {
  var m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function cmpVer(a, b) {
  for (var i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; }
  return 0;
}

// Latest SEMVER release tag for a repo: prefer releases/latest, fall back to
// the highest semver tag (some repos cut tags but no "latest" release, or tag
// the newest release with a non-semver name). Cached per repo.
var _verCache = {};
function latestVersion(repo) {
  if (Object.prototype.hasOwnProperty.call(_verCache, repo)) return _verCache[repo];
  var v = null;
  var r = gh("repos/" + repo + "/releases/latest", ".tag_name");
  if (r.ok && r.out && parseVer(r.out)) v = r.out;
  if (!v) {
    var t = gh("repos/" + repo + "/tags?per_page=100");
    if (t.ok && t.out) {
      try {
        var best = null, bestV = null;
        JSON.parse(t.out).forEach(function (tg) {
          var pv = parseVer(tg.name);
          if (pv && (!bestV || cmpVer(pv, bestV) > 0)) { bestV = pv; best = tg.name; }
        });
        v = best;
      } catch (_e) { /* leave null → UNVERIFIED */ }
    }
  }
  _verCache[repo] = v;
  return v;
}

// Resolve a tag to its commit SHA, dereferencing an annotated tag object to
// the commit it points at (so the paste-ready pin is the real commit, never
// the annotated-tag object).
function tagSha(repo, tag) {
  var ref = gh("repos/" + repo + "/git/ref/tags/" + tag, ".object.type + \" \" + .object.sha");
  if (!ref.ok || !ref.out) return null;
  var parts = ref.out.split(" ");
  if (parts[0] === "tag") {
    var d = gh("repos/" + repo + "/git/tags/" + parts[1], ".object.sha");
    return d.ok && d.out ? d.out : null;
  }
  return parts[1] || null;
}

// ---- scan action pins across .github ------------------------------------
function ymlFiles() {
  var out = [];
  [path.join(ROOT, ".github", "workflows"), path.join(ROOT, ".github", "actions")].forEach(function (r) {
    (function walk(dir) {
      var entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
      entries.forEach(function (e) {
        var p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ya?ml$/.test(e.name)) out.push(p);
      });
    })(r);
  });
  return out;
}

// `uses: owner/repo[/subpath]@<40-hex>  # vX.Y.Z` — only SHA pins carrying a
// version comment are checkable (the comment is the asserted version).
var PIN_RE = /uses:\s+([A-Za-z0-9][A-Za-z0-9._/-]+)@([0-9a-f]{40})\s+#\s*(v?[0-9][0-9A-Za-z.+-]*)/;
function scanPins() {
  var byRef = {}; // usesRef -> { repo, version, occ: ["relfile:line"] }
  ymlFiles().forEach(function (file) {
    var rel = path.relative(ROOT, file).replace(/\\/g, "/");
    fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line, i) {
      var m = PIN_RE.exec(line);
      if (!m) return;
      var ref = m[1];
      var segs = ref.split("/");
      if (segs.length < 2) return;
      if (!byRef[ref]) byRef[ref] = { repo: segs[0] + "/" + segs[1], version: m[3], occ: [] };
      byRef[ref].occ.push(rel + ":" + (i + 1));
    });
  });
  return byRef;
}

function checkActions() {
  var pins = scanPins();
  var refs = Object.keys(pins).sort();
  var stale = [], unverified = [];
  refs.forEach(function (ref) {
    var info = pins[ref];
    var latest = latestVersion(info.repo);
    if (!latest) { unverified.push({ id: ref, reason: "no release/tag resolvable for " + info.repo }); return; }
    var pv = parseVer(info.version), lv = parseVer(latest);
    if (!pv || !lv) { unverified.push({ id: ref, reason: "unparseable version (pinned " + info.version + ", latest " + latest + ")" }); return; }
    if (cmpVer(lv, pv) > 0) {
      stale.push({ ref: ref, pinnedVer: info.version, latestVer: latest, latestSha: tagSha(info.repo, latest), occ: info.occ });
    }
  });
  return { count: refs.length, stale: stale, unverified: unverified };
}

// ---- vendored package currency ------------------------------------------
function checkVendor() {
  var manifest;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8")); }
  catch (_e) { return { count: 0, stale: [], unverified: [{ id: "vendor", reason: "MANIFEST.json unreadable" }] }; }
  var pkgs = manifest.packages || {};
  var names = Object.keys(pkgs);
  var stale = [], unverified = [];
  names.forEach(function (name) {
    var p = pkgs[name];
    var repo = String(p.source || "").replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^[^/]+\/[^/]+$/.test(repo)) { unverified.push({ id: name, reason: "no github source in manifest" }); return; }
    var latest = latestVersion(repo);
    if (!latest) { unverified.push({ id: name, reason: "no release/tag resolvable for " + repo }); return; }
    var pv = parseVer(p.version), lv = parseVer(latest);
    if (!pv || !lv) { unverified.push({ id: name, reason: "unparseable (vendored " + p.version + ", latest " + latest + ")" }); return; }
    if (cmpVer(lv, pv) > 0) stale.push({ name: name, vendoredVer: p.version, latestVer: latest });
  });
  return { count: names.length, stale: stale, unverified: unverified };
}

// ---- run ----------------------------------------------------------------
var actions = checkActions();
var vendor = checkVendor();

console.log("[check-currency] scanned " + actions.count + " pinned action(s) + " + vendor.count + " vendored package(s)");

var report = [];
actions.stale.forEach(function (s) {
  report.push("STALE ACTION  " + s.ref + "  " + s.pinnedVer + " → " + s.latestVer);
  if (s.latestSha) report.push("  paste:  uses: " + s.ref + "@" + s.latestSha + "  # " + s.latestVer);
  else report.push("  (could not resolve the commit SHA for " + s.latestVer + " — check the repo manually)");
  s.occ.forEach(function (o) { report.push("  used:   " + o); });
  report.push("");
});
vendor.stale.forEach(function (s) {
  report.push("STALE VENDOR  " + s.name + "  v" + s.vendoredVer + " → " + s.latestVer);
  report.push("  refresh: bash scripts/vendor-update.sh " + s.name + " " + s.latestVer);
  report.push("");
});

var unverified = actions.unverified.concat(vendor.unverified);
if (unverified.length) {
  console.warn("[check-currency] " + unverified.length + " entry(ies) UNVERIFIED (not blocking — gh/network):");
  unverified.forEach(function (u) { console.warn("  - " + u.id + ": " + u.reason); });
}

var staleCount = actions.stale.length + vendor.stale.length;
if (staleCount === 0) {
  console.log("[check-currency] OK — every pinned action + vendored package is at its latest release");
  process.exit(0);
}

console.error("");
report.forEach(function (l) { console.error(l); });
if (ALLOW_STALE) {
  console.warn("[check-currency] " + staleCount + " stale pin(s) — RELEASE_ALLOW_STALE_PINS=1 set, continuing (deferred).");
  process.exit(0);
}
console.error("[check-currency] FAIL — " + staleCount + " stale pin(s). Update the line(s) above, or set RELEASE_ALLOW_STALE_PINS=1 to consciously defer.");
process.exit(1);
