#!/usr/bin/env node
"use strict";
/**
 * release.js — orchestrate the full release flow as a sequence of
 * idempotent subcommands. Modelled on the vendored blamejs release
 * script: each subcommand performs ONE phase, prints what it did, and
 * exits with a code that's safe to script against in a terminal.
 *
 * Usage:
 *   node scripts/release.js prepare [--minor]  # bump + regen CHANGELOG/manifest + static gates
 *   node scripts/release.js regen              # re-regen after release-notes edits (no bump)
 *   node scripts/release.js smoke              # node test/smoke.js
 *   node scripts/release.js commit             # release branch + signed commit
 *   node scripts/release.js push               # gitleaks + push + open PR
 *   node scripts/release.js watch              # gh pr checks --watch + flag Codex review threads
 *   node scripts/release.js merge              # squash-merge if CLEAN + zero unresolved threads
 *   node scripts/release.js deploy             # apply D1 migrations + sync R2 assets + watch
 *                                              #   the Cloudflare Workers Build + verify prod health
 *   node scripts/release.js tag                # signed tag + push tag (triggers npm-publish)
 *   node scripts/release.js publish            # watch npm-publish workflow + verify npm version
 *   node scripts/release.js all [--minor]      # every phase in sequence
 *   node scripts/release.js status             # what phase the current branch is in
 *   node scripts/release.js help               # this banner
 *
 * Deploy model:
 *   Cloudflare's git-integration "Workers Builds" rolls the Worker +
 *   container automatically on every push to main. It does NOT apply D1
 *   migrations or sync R2 theme assets — the `deploy` phase here owns
 *   exactly those two steps (the merge push having already triggered the
 *   native build), then watches that build to completion and verifies a
 *   live route. Nothing in this script runs `wrangler deploy`: a second
 *   Worker/container roll would race the native build.
 *
 * Pre-conditions:
 *   - release-notes/v<next>.json MUST exist before `prepare` (the
 *     headline/summary/sections need human judgment; `prepare` prints a
 *     stub and exits if it's missing).
 *   - Git SSH signing configured (commit.gpgsign + gpg.format=ssh +
 *     ~/.ssh/allowed_signers; one-time operator setup).
 *   - wrangler authenticated (for the `deploy` phase migrations + R2).
 *
 * Judgment-requiring parts stay manual: writing release-notes content,
 * reviewing Codex P1/P2 findings (watch flags + stops), and minor-vs-patch
 * (default patch; `--minor` on prepare).
 */

var fs = require("node:fs");
var path = require("node:path");
var https = require("node:https");
var childProcess = require("node:child_process");

var ROOT = path.resolve(__dirname, "..");
var REPO = "blamejs/blamejs.shop";
var NPM_PKG = "@blamejs/blamejs-shop";
var D1_DB = "blamejs-shop";
var PROD_ORIGIN = "https://blamejs.shop";

// ---- Helpers -------------------------------------------------------------

// Windows resolves npm/npx as .cmd shims that spawn only through a shell.
// gh / git / docker / node / wrangler are native exes that spawn directly.
function _needsShell(cmd) {
  if (process.platform !== "win32") return false;
  return cmd === "npm" || cmd === "npx" || cmd === "bash";
}

// Quote a single token for cmd.exe (the only shell _needsShell selects, on
// Windows): bare when it has no metacharacters, double-quoted (with embedded
// quotes doubled, the cmd.exe convention) otherwise.
function _shellQuote(token) {
  token = String(token);
  if (/^[A-Za-z0-9_.:/\\=@+-]+$/.test(token)) return token;
  return "\"" + token.replace(/"/g, "\"\"") + "\"";
}

// Spawn synchronously. A Windows .cmd shim (npm/npx/bash) must go through a
// shell, but passing an args ARRAY together with shell:true is deprecated
// (Node DEP0190) — the array is concatenated onto the command line without
// shell-escaping. So for the shell path we build one per-token-quoted command
// string and pass NO args array; native exes spawn directly with shell:false.
function _spawnSync(cmd, args, options) {
  if (_needsShell(cmd)) {
    var line = [cmd].concat(args || []).map(_shellQuote).join(" ");
    return childProcess.spawnSync(line, Object.assign({}, options, { shell: true }));
  }
  return childProcess.spawnSync(cmd, args, Object.assign({}, options, { shell: false }));
}

function _run(cmd, args, opts) {
  opts = opts || {};
  var rv = _spawnSync(cmd, args, {
    cwd:   opts.cwd   || ROOT,
    stdio: opts.stdio || "inherit",
    env:   Object.assign({}, process.env, opts.env || {}),
  });
  if (rv.status !== 0 && !opts.allowFail) {
    throw new Error("release: " + cmd + " " + (args || []).join(" ") +
                    " failed with status " + rv.status);
  }
  return rv;
}

function _capture(cmd, args, opts) {
  opts = opts || {};
  var rv = _spawnSync(cmd, args, {
    cwd:   opts.cwd || ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env:   Object.assign({}, process.env, opts.env || {}),
  });
  return {
    status: rv.status,
    stdout: (rv.stdout || "").toString().trim(),
    stderr: (rv.stderr || "").toString().trim(),
  };
}

function _readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

function _writePackageVersion(next) {
  var pkgPath = path.join(ROOT, "package.json");
  var content = fs.readFileSync(pkgPath, "utf8");
  var updated = content.replace(/"version":\s*"[^"]+"/, '"version": "' + next + '"');
  if (updated === content) throw new Error("release: failed to rewrite package.json version line");
  fs.writeFileSync(pkgPath, updated);
}

function _bumpPatch(v) {
  var p = v.split(".").map(Number);
  if (p.length !== 3 || p.some(isNaN)) throw new Error("release: unparseable version '" + v + "'");
  return p[0] + "." + p[1] + "." + (p[2] + 1);
}
function _bumpMinor(v) {
  var p = v.split(".").map(Number);
  if (p.length !== 3 || p.some(isNaN)) throw new Error("release: unparseable version '" + v + "'");
  return p[0] + "." + (p[1] + 1) + ".0";
}

function _gitClean()    { return _capture("git", ["status", "--porcelain"]).stdout === ""; }
function _gitBranch()   { return _capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout; }
function _gitOnMain()   { return _gitBranch() === "main"; }
function _gitOnRelease(){ return /^release\/v\d+\.\d+\.\d+$/.test(_gitBranch()); }
function _releaseBranchFor(v) { return "release/v" + v; }
function _releaseNotesPath(v)  { return path.join(ROOT, "release-notes", "v" + v + ".json"); }

function _section(t) { console.log("\n=== " + t + " ==="); }
function _ok(m)      { console.log("ok: " + m); }

function _ensureReleaseNotes(version) {
  var p = _releaseNotesPath(version);
  if (!fs.existsSync(p)) {
    var stub = {
      $schema: "../scripts/release-notes-schema.json",
      version: version,
      date: new Date().toISOString().slice(0, 10),
      headline: "<one-line operator-facing summary>",
      summary: "<one-paragraph why-it-matters>",
      sections: [{ heading: "Added", items: [{ title: "<short title>", body: "<one-paragraph body.>" }] }],
    };
    console.error("\nrelease: missing " + p + "\n\nCreate it before re-running. Stub:\n");
    console.error(JSON.stringify(stub, null, 2) + "\n");
    process.exit(2);
  }
  return p;
}

function _regenArtifacts(opts) {
  opts = opts || {};
  if (opts.rollupOnMinor) {
    _run("node", ["scripts/consolidate-release-notes.js", "--prune"], { allowFail: true });
    _ok("prior minor's release-notes rolled up");
  }
  _run("node", ["scripts/generate-changelog-entry.js", "--rebuild"]);
  _run("node", ["scripts/generate-asset-manifest.js", "--rebuild"]);
  _ok("CHANGELOG + asset-manifest regenerated");
}

function _verifyCommitSignature(label) {
  var verify = _capture("git", ["verify-commit", "HEAD"]);
  if (verify.status !== 0) {
    var hint = "release: " + label + " commit signature is not Good — check SSH signing " +
               "(commit.gpgsign=true + gpg.format=ssh + ~/.ssh/allowed_signers).";
    if (verify.stderr) hint += "\n" + verify.stderr;
    throw new Error(hint);
  }
  var sig = _capture("git", ["log", "-1", "--pretty=%h %G? %GS"]);
  console.log("signature: " + (sig.stdout || "(empty — verify-commit reports Good)"));
  _ok(label + " commit signature verified");
}

function _openPrNumber() {
  return _capture("gh", ["pr", "list", "--head", _releaseBranchFor(_readPackageVersion()),
                         "--state", "open", "--json", "number", "--jq", ".[0].number"]).stdout;
}

function _unresolvedThreads(prNum) {
  var owner = REPO.split("/")[0], name = REPO.split("/")[1];
  var q = "query { repository(owner:\"" + owner + "\",name:\"" + name + "\") { pullRequest(number:" +
          prNum + ") { reviewThreads(first:50) { nodes { isResolved comments(first:1) { nodes { author{login} body } } } } } } }";
  var rv = _capture("gh", ["api", "graphql", "-f", "query=" + q,
    "--jq", ".data.repository.pullRequest.reviewThreads.nodes | map(select(.isResolved==false))"]);
  try { return JSON.parse(rv.stdout || "[]"); } catch (_e) { return []; }
}

// GET a prod route with browser-shaped headers (the bot-guard 403s
// header-less clients by design), following no redirect so a 303 from a
// login-gated route reads as healthy. Resolves the numeric status.
function _probe(pathname) {
  return new Promise(function (resolve) {
    var req = https.request(PROD_ORIGIN + pathname, {
      method: "GET",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-dest": "document",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
      },
    }, function (res) { res.resume(); resolve(res.statusCode); });
    req.setTimeout(45000, function () { req.destroy(); resolve(0); });
    req.on("error", function () { resolve(0); });
    req.end();
  });
}

function _sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ---- Subcommands ---------------------------------------------------------

function cmdPrepare(opts) {
  _section("prepare");
  if (!_gitOnMain()) throw new Error("release: prepare must run on main (on " + _gitBranch() + ")");
  // This repo ships the feature + version bump in ONE release commit, so the
  // feature changes are expected in the working tree at prepare time. prepare
  // bumps + regenerates artifacts on top of them; `commit` then commits
  // everything together on the release branch. (A clean tree is fine too — a
  // bump-only release.) An accidental re-bump is guarded by the release-notes
  // precondition below: the next version's notes must exist.
  if (!_gitClean()) {
    console.log("working-tree changes to bundle into this release:");
    _run("git", ["status", "--short"], { allowFail: true });
  }

  var current = _readPackageVersion();
  var next = opts.minor ? _bumpMinor(current) : _bumpPatch(current);
  console.log("current: " + current + "  next: " + next + " (" + (opts.minor ? "minor" : "patch") + ")");

  _ensureReleaseNotes(next);
  _writePackageVersion(next);
  _ok("bumped package.json → " + next);

  _section("regen artifacts");
  _regenArtifacts({ rollupOnMinor: current.split(".")[1] !== next.split(".")[1] });

  _section("static gates");
  _run("npx", ["--yes", "eslint@latest", "--max-warnings", "0", "."]);
  _run("node", ["test/layer-0-primitives/codebase-patterns.test.js"]);
  _run("node", ["scripts/generate-changelog-entry.js", "--check"]);
  _run("node", ["scripts/consolidate-release-notes.js", "--check"]);
  _run("node", ["scripts/generate-asset-manifest.js", "--check"]);
  // Currency gate — a stale pinned GitHub Action or vendored dependency fails
  // the cut with a paste-ready `uses: owner/repo@<sha>  # vX.Y.Z` line and every
  // file:line using it. Conscious deferral: RELEASE_ALLOW_STALE_PINS=1.
  _run("node", ["scripts/check-currency.js"]);
  // Gate-contract coverage — asserts every declared preventable bug-class
  // maps to a live codebase-patterns detector + an enforced gate, and flags
  // new outbound-URL / money-binding-currency / admin-5xx surfaces that look
  // like they need a declared gate but aren't covered. Conscious deferral:
  // RELEASE_ALLOW_GATE_GAPS=1.
  _run("node", ["scripts/gate-contract.js"]);
  _ok("static gates clean");

  console.log("\nnext: node scripts/release.js smoke");
}

function cmdRegen() {
  _section("regen");
  _ensureReleaseNotes(_readPackageVersion());
  _regenArtifacts();
  console.log("\nnext: re-run the phase you were on (commit / push / ...)");
}

function cmdSmoke() {
  _section("smoke");
  _run("node", ["test/smoke.js"]);
  _ok("smoke clean");
  console.log("\nnext: node scripts/release.js commit");
}

function cmdCommit() {
  _section("commit");
  var next = _readPackageVersion();
  var branch = _releaseBranchFor(next);
  var current = _gitBranch();

  if (current === branch) {
    _ok("already on " + branch + " (resume)");
  } else if (current === "main") {
    var exists = _capture("git", ["rev-parse", "--verify", "--quiet", branch]).status === 0;
    _run("git", ["checkout"].concat(exists ? [branch] : ["-b", branch]));
    _ok((exists ? "checked out existing " : "created ") + branch);
  } else {
    throw new Error("release: commit must run on main or " + branch + " (on " + current + ")");
  }

  var headSubject = _capture("git", ["log", "-1", "--pretty=%s"]).stdout;
  if (headSubject.indexOf(next + " — ") === 0) {
    _ok("HEAD already carries a " + next + " release commit (resume)");
    _verifyCommitSignature("existing");
    console.log("\nnext: node scripts/release.js push");
    return;
  }

  var rn = JSON.parse(fs.readFileSync(_releaseNotesPath(next), "utf8"));
  var lines = [next + " — " + rn.headline, "", rn.summary];
  if (Array.isArray(rn.sections)) {
    rn.sections.forEach(function (s) {
      if (!Array.isArray(s.items) || s.items.length === 0) return;
      lines.push("", s.heading + ":");
      s.items.forEach(function (it) { lines.push("  - " + it.title); });
    });
  }
  var msgPath = path.join(ROOT, ".scratch", "release-commit-msg.txt");
  try { fs.mkdirSync(path.dirname(msgPath), { recursive: true }); } catch (_e) { /* ignore */ }
  fs.writeFileSync(msgPath, lines.join("\n") + "\n");

  _run("git", ["add", "-A"]);
  _run("git", ["commit", "-F", msgPath]);
  _ok("signed commit");
  _verifyCommitSignature("new");

  console.log("\nnext: node scripts/release.js push");
}

function cmdPush() {
  _section("push");
  if (!_gitOnRelease()) throw new Error("release: push must run on a release/vX.Y.Z branch");
  var next = _readPackageVersion();

  _section("gitleaks");
  var mount;
  if (process.platform === "win32") {
    var posix = ROOT.replace(/\\/g, "/");
    mount = "//" + posix.charAt(0).toLowerCase() + posix.slice(2);  // C:/x → //c/x
  } else {
    mount = ROOT;
  }
  _run("docker", ["run", "--rm", "-v", mount + ":/repo", "-w", "//repo",
                  "zricethezav/gitleaks:latest",
                  "git", "--config=.gitleaks.toml", "--redact", "--exit-code=1"]);
  _ok("gitleaks clean");

  _run("git", ["push", "-u", "origin", _releaseBranchFor(next)]);
  _ok("pushed " + _releaseBranchFor(next));

  _section("open PR");
  var rn = JSON.parse(fs.readFileSync(_releaseNotesPath(next), "utf8"));
  var body = ["## Summary", "", rn.summary, "", "## Test plan", "",
              "- [x] `node test/smoke.js`", "- [x] codebase-patterns + asset-manifest + changelog checks",
              "- [x] gitleaks", "- [ ] CI green"].join("\n");
  _run("gh", ["pr", "create", "--base", "main", "--head", _releaseBranchFor(next),
              "--title", next + " — " + rn.headline, "--body", body]);
  _ok("PR opened");

  console.log("\nnext: node scripts/release.js watch");
}

function cmdWatch() {
  _section("watch");
  var prNum = _openPrNumber();
  if (!prNum) throw new Error("release: no open PR for " + _releaseBranchFor(_readPackageVersion()));
  console.log("PR #" + prNum);

  _run("gh", ["pr", "checks", prNum, "--watch"], { allowFail: true });

  var unresolved = _unresolvedThreads(prNum);
  if (unresolved.length > 0) {
    console.log("\nunresolved review threads (" + unresolved.length + "):");
    unresolved.forEach(function (t) {
      var c = t.comments && t.comments.nodes && t.comments.nodes[0];
      if (c) console.log("  - " + c.author.login + ": " + c.body.split("\n")[0].slice(0, 120));
    });
    console.log("\nResolve threads + push fixes, then re-run: node scripts/release.js watch");
    process.exit(3);
  }
  _ok("zero unresolved threads");
  console.log("\nnext: node scripts/release.js merge");
}

function cmdMerge() {
  _section("merge");
  var prNum = _openPrNumber();
  if (!prNum) throw new Error("release: no open PR for " + _releaseBranchFor(_readPackageVersion()));

  var state = JSON.parse(_capture("gh", ["pr", "view", prNum, "--json", "mergeStateStatus,mergeable"]).stdout || "{}");
  if (state.mergeStateStatus !== "CLEAN" || state.mergeable !== "MERGEABLE") {
    throw new Error("release: PR #" + prNum + " not mergeable (state=" + state.mergeStateStatus +
                    " mergeable=" + state.mergeable + ")");
  }
  var unresolved = _unresolvedThreads(prNum);
  if (unresolved.length > 0) {
    throw new Error("release: refusing to merge PR #" + prNum + " — " + unresolved.length + " unresolved review thread(s)");
  }
  _run("gh", ["pr", "merge", prNum, "--squash", "--delete-branch"]);
  _ok("PR #" + prNum + " squash-merged");

  _run("git", ["checkout", "main"]);
  _run("git", ["pull", "origin", "main"]);
  console.log("\nnext: node scripts/release.js deploy");
}

// Migration + asset automation — the two steps Cloudflare Workers Builds
// (which rolls the Worker + container on the merge push) doesn't cover.
// Runs after merge: applies pending D1 migrations + syncs R2 theme assets
// (both idempotent), then watches the native build to completion and
// verifies a live route. NEVER runs `wrangler deploy`.
async function cmdDeploy() {
  _section("deploy");
  if (!_gitOnMain()) throw new Error("release: deploy must run on main (post-merge)");

  _section("D1 migrations");
  _run("node", ["node_modules/wrangler/bin/wrangler.js", "d1", "migrations", "apply", D1_DB, "--remote"],
       { env: { CI: "true" } });
  _ok("pending D1 migrations applied (idempotent)");

  _section("R2 theme assets");
  _run("node", ["scripts/sync-r2-assets.js"]);
  _ok("R2 theme assets synced");

  _section("Cloudflare Workers Build");
  // The merge push triggers the native Worker+container build. Poll its
  // commit check until it concludes so the release reflects the real
  // deploy outcome rather than assuming success.
  var conclusion = "";
  for (var i = 0; i < 30; i += 1) {
    var st = _capture("gh", ["api", "repos/" + REPO + "/commits/main/check-runs",
      "--jq", "[.check_runs[]? | select(.name|test(\"Workers Builds\";\"i\"))] | last | \"\\(.status)/\\(.conclusion // \"running\")\""]).stdout;
    console.log("[" + (i * 20) + "s] Workers Build: " + (st || "(no check yet)"));
    // Break on ANY terminal conclusion — `completed/<conclusion>` covers
    // success, failure, cancelled, timed_out, action_required, etc. Only
    // `success` is a confirmed rollout; every other terminal state must
    // fail the release rather than fall through to tag/publish.
    var done = st.match(/^completed\/(.+)$/);
    if (done) { conclusion = done[1]; break; }
    await _sleep(20000);
  }
  if (conclusion === "") {
    throw new Error("release: Cloudflare Workers Build did not conclude within the poll window — " +
                    "rollout unconfirmed. Check the dashboard build status before tagging.");
  }
  if (conclusion !== "success") {
    throw new Error("release: Cloudflare Workers Build ended '" + conclusion + "' (not success) — " +
                    "open the build log in the dashboard. Worker/container did NOT roll; D1 + R2 already " +
                    "applied. Fix the build, then re-run deploy.");
  } else {
    _ok("Workers Build succeeded");
  }

  _section("verify prod (cold-start tolerant)");
  var live = false;
  for (var j = 0; j < 20; j += 1) {
    var code = await _probe("/account");        // login-gated → healthy = 303 (or 200)
    console.log("[" + (j * 15) + "s] /account=" + code);
    if (code === 303 || code === 200) { live = true; break; }
    await _sleep(15000);
  }
  if (!live) {
    throw new Error("release: /account not serving after the build — container may be cold-looping; check `wrangler tail`.");
  }
  var home = await _probe("/");
  console.log("/ = " + home);
  _ok("prod serving on v" + _readPackageVersion());

  console.log("\nnext: node scripts/release.js tag");
}

function cmdTag() {
  _section("tag");
  if (!_gitOnMain()) throw new Error("release: tag must run on main (post-merge)");
  var tag = "v" + _readPackageVersion();
  if (_capture("git", ["tag", "-l", tag]).stdout === tag) {
    throw new Error("release: tag " + tag + " already exists locally");
  }
  _run("git", ["tag", "-s", tag, "-m", tag]);
  _run("git", ["push", "origin", tag]);
  _ok("tagged + pushed " + tag);

  var v = _capture("git", ["tag", "-v", tag]);
  if (v.stderr.indexOf("Good") === -1 && v.stdout.indexOf("Good") === -1) {
    console.error("warning: `git tag -v " + tag + "` did not report Good:\n" + (v.stderr || v.stdout));
  } else {
    _ok("tag signature: Good");
  }
  console.log("\nnext: node scripts/release.js publish");
}

function cmdPublish() {
  _section("publish");
  var next = _readPackageVersion();
  var runId = _capture("gh", ["run", "list", "--workflow=npm-publish.yml", "--limit", "1",
                              "--json", "databaseId", "--jq", ".[0].databaseId"]).stdout;
  if (runId) {
    // No allowFail: `--exit-status` makes a failed npm-publish run exit
    // non-zero, which must fail the release rather than be swallowed.
    _run("gh", ["run", "watch", runId, "--exit-status"]);
  } else {
    console.log("no npm-publish run found yet (the tag push may still be registering)");
  }
  var npmVersion = _capture("npm", ["view", NPM_PKG, "version"]).stdout;
  console.log("npm " + NPM_PKG + ": " + (npmVersion || "(unable to query)") + "  (expected " + next + ")");
  if (npmVersion === next) _ok("npm matches " + next);
  else console.error("warning: npm version != " + next + " — workflow may still be in flight");
}

async function cmdAll(opts) {
  cmdPrepare(opts);
  cmdSmoke();
  cmdCommit();
  cmdPush();
  cmdWatch();
  cmdMerge();
  await cmdDeploy();
  cmdTag();
  cmdPublish();
}

function cmdStatus() {
  _section("status");
  var v = _readPackageVersion();
  console.log("branch:          " + _gitBranch());
  console.log("clean:           " + _gitClean());
  console.log("package version: " + v);
  console.log("release-notes:   " + (fs.existsSync(_releaseNotesPath(v)) ? "present" : "missing"));
  var pr = _capture("gh", ["pr", "list", "--head", _releaseBranchFor(v), "--state", "open",
                           "--json", "number,mergeStateStatus,mergeable", "--jq", ".[0]"]).stdout;
  console.log("open PR:         " + (pr || "(none)"));
}

function cmdHelp() {
  console.log("release.js — orchestrated release flow (Workers Builds rolls Worker+container; this owns D1+R2)\n");
  console.log("  prepare [--minor]   bump + regen CHANGELOG/manifest + static gates");
  console.log("  regen               re-regen artifacts after release-notes edits");
  console.log("  smoke               node test/smoke.js");
  console.log("  commit              release branch + signed commit");
  console.log("  push                gitleaks + push + open PR");
  console.log("  watch               CI watch + flag Codex review threads");
  console.log("  merge               squash-merge if CLEAN + zero threads");
  console.log("  deploy              D1 migrations + R2 sync + watch Workers Build + verify prod");
  console.log("  tag                 signed tag + push (triggers npm-publish)");
  console.log("  publish             watch npm-publish + verify npm version");
  console.log("  all [--minor]       every phase in sequence");
  console.log("  status              current branch + version state");
}

// ---- Dispatch ------------------------------------------------------------

var sub = process.argv[2] || "help";
var opts = { minor: process.argv.slice(3).indexOf("--minor") !== -1 };

(async function () {
  try {
    switch (sub) {
      case "prepare": cmdPrepare(opts); break;
      case "regen":   cmdRegen();       break;
      case "smoke":   cmdSmoke();       break;
      case "commit":  cmdCommit();      break;
      case "push":    cmdPush();        break;
      case "watch":   cmdWatch();       break;
      case "merge":   cmdMerge();       break;
      case "deploy":  await cmdDeploy(); break;
      case "tag":     cmdTag();         break;
      case "publish": cmdPublish();     break;
      case "all":     await cmdAll(opts); break;
      case "status":  cmdStatus();      break;
      case "help": case "--help": case "-h": cmdHelp(); break;
      default:
        console.error("release: unknown subcommand '" + sub + "'");
        cmdHelp();
        process.exit(1);
    }
  } catch (e) {
    console.error("\nrelease: FAIL — " + (e.message || e));
    process.exit(1);
  }
})();
