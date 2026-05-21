"use strict";

// codebase-patterns:allow-file test-promise-settimeout-sleep — this catalog file describes the pattern it detects; the description string inevitably contains the shape
// codebase-patterns:allow-file vendor-hand-edit — the description string mentions the pattern shape literally
// codebase-patterns:allow-file process-exit-in-lib — catalog references the literal `process.exit(...)` shape it detects
// codebase-patterns:allow-file empty-catch-swallow — catalog references the literal `catch (e) {}` shape it detects
// codebase-patterns:allow-file fs-existssync-then-read-toctou — catalog references the literal `fs.existsSync(` shape it detects
// codebase-patterns:allow-file regex-from-argv — catalog references the literal `new RegExp(... process.argv` shape it detects
// codebase-patterns:allow-file internal-rulebook-vocabulary-in-source — runtime regex construction inevitably includes the patterns being detected
// codebase-patterns:allow-file non-shop-require — catalog file describes the require shape it detects

// Re-exec under a 6 GiB old-space ceiling when the parent process did
// not already raise the heap cap. Future detectors that cross-product
// lib/ fingerprints can approach the v8 default 4 GiB ceiling on cold
// CI runners. One self-spawn keeps `node test/layer-0-primitives/
// codebase-patterns.test.js` working as a first-class invocation
// without an external shim.
(function _ensureHeapCeiling() {
  var argv = process.execArgv || [];
  for (var i = 0; i < argv.length; i += 1) {
    if (/^--max-old-space-size=/.test(argv[i])) return;
  }
  if (require.main !== module) return;
  var cp = require("node:child_process");
  var r  = cp.spawnSync(
    process.execPath,
    ["--max-old-space-size=6144"].concat(process.argv.slice(1)),
    { stdio: "inherit" }
  );
  process.exit(r.status === null ? 1 : r.status);
})();

/**
 * codebase-patterns — automated grep gates for code-shape bug classes
 * that have surfaced repeatedly.
 *
 * Add new patterns when a new bug class is identified. The test is
 * the single source of truth for "we already swept this class once
 * and don't want it to drift back in."
 *
 * **Exceptions** are documented at the violation site, not in this
 * test file. Two shapes:
 *
 *   1. File-level header within the first 50 lines:
 *        // codebase-patterns:allow-file <class> — <reason>
 *      Skips every match for that class in the file.
 *
 *   2. Per-line inline marker on the same line or up to 2 lines above:
 *        ... // allow:<class> — <reason>
 *      Skips that single match.
 */

var fs   = require("node:fs");
var path = require("node:path");

var LIB_ROOT       = path.resolve(__dirname, "..", "..", "lib");
var TEST_ROOT      = path.resolve(__dirname, "..", "..", "test");
var WORKFLOWS_ROOT = path.resolve(__dirname, "..", "..", ".github", "workflows");

function _walk(dir, files) {
  files = files || [];
  if (path.basename(dir) === "vendor") return files;                  // never lint the vendored tree
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_e) { return files; }
  for (var i = 0; i < entries.length; i += 1) {
    var e = entries[i];
    var full = path.join(dir, e.name);
    if (e.isDirectory()) _walk(full, files);
    else if (e.isFile() && e.name.endsWith(".js")) files.push(full);
  }
  return files;
}

function _libFiles()  { return _walk(LIB_ROOT);  }
function _testFiles() { return _walk(TEST_ROOT).filter(function (f) {
  return /\.test\.js$/.test(f) || /\/helpers\/[^_].*\.js$/.test(f.replace(/\\/g, "/"));
}); }
function _workflowFiles() {
  var all;
  try { all = _walkYaml(WORKFLOWS_ROOT); } catch (_e) { return []; }
  return all;
}
function _walkYaml(dir, files) {
  files = files || [];
  var entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_e) { return files; }
  for (var i = 0; i < entries.length; i += 1) {
    var e = entries[i];
    var full = path.join(dir, e.name);
    if (e.isDirectory()) _walkYaml(full, files);
    else if (e.isFile() && /\.ya?ml$/.test(e.name)) files.push(full);
  }
  return files;
}

function _relPath(absPath) {
  return path.relative(path.resolve(__dirname, "..", ".."), absPath).replace(/\\/g, "/");
}

function _scan(regex, scope) {
  var files = scope === "test"      ? _testFiles()
            : scope === "workflows" ? _workflowFiles()
            :                         _libFiles();
  var matches = [];
  for (var i = 0; i < files.length; i += 1) {
    var content;
    try { content = fs.readFileSync(files[i], "utf8"); }
    catch (_e) { continue; }
    var lines = content.split(/\r?\n/);
    for (var j = 0; j < lines.length; j += 1) {
      var line = lines[j];
      // Skip comment-prefix lines for lib/test scans (workflows are yaml,
      // their `#` comments are content-bearing).
      if (scope !== "workflows" && /^\s*(\/\/|\*|\/\*|#)/.test(line)) continue;
      if (regex.test(line)) {
        matches.push({
          file:    _relPath(files[i]),
          line:    j + 1,
          content: line.trim(),
        });
      }
    }
  }
  return matches;
}

// Allowlist resolver — supports file-level + per-line markers.
function _filterMarkers(matches, allowClass) {
  var fileCache = {};
  var fileAllowCache = {};
  function _readContext(file) {
    if (!fileCache[file]) {
      try {
        var p = path.resolve(path.resolve(__dirname, "..", ".."), file);
        fileCache[file] = fs.readFileSync(p, "utf8").split(/\r?\n/);
      } catch (_e) { fileCache[file] = []; }
    }
    return fileCache[file];
  }
  function _hasFileAllow(file) {
    if (Object.prototype.hasOwnProperty.call(fileAllowCache, file)) return fileAllowCache[file];
    var lines = _readContext(file).slice(0, 50);
    var re = new RegExp("codebase-patterns:allow-file\\s+" + allowClass + "\\b");
    var found = lines.some(function (l) { return re.test(l); });
    fileAllowCache[file] = found;
    return found;
  }
  function _hasLineAllow(file, lineNum) {
    var lines = _readContext(file);
    if (!lines.length) return false;
    var re = new RegExp("allow:" + allowClass + "\\b");
    var here = lines[lineNum - 1] || "";
    var above1 = lines[lineNum - 2] || "";
    var above2 = lines[lineNum - 3] || "";
    return re.test(here) || re.test(above1) || re.test(above2);
  }
  return matches.filter(function (m) {
    if (_hasFileAllow(m.file)) return false;
    if (_hasLineAllow(m.file, m.line)) return false;
    return true;
  });
}

// Detector catalog. Add new entries here when a new bug class is
// identified. Each detector ships with: id, regex, scope, allowlist
// of paths that are intentional exceptions (with a reason), and a
// description.
var KNOWN_ANTIPATTERNS = [
  {
    id:          "test-promise-settimeout-sleep",
    scanScope:   "test",
    description: "`await new Promise(r => setTimeout(r, N))` used as a sleep — use helpers.waitUntil(predicate) instead so the test polls the actual condition and doesn't flake under runner contention",
    regex:       /await\s+new\s+Promise\s*\(\s*[\w$]+\s*=>\s*setTimeout\s*\(/,
    allowlist:   [
      // The polling step inside waitUntil itself is allowed via the
      // per-line `// allow:test-promise-settimeout-sleep` marker.
    ],
  },
  {
    id:          "console-direct",
    scanScope:   "lib",
    description: "`console.log/error/warn` direct call in lib/ — route through the framework's observability sink so operators can quiet / redirect / structured-log every emission point",
    regex:       /\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/,
    allowlist:   [],
  },
  {
    id:          "math-random",
    scanScope:   "lib",
    description: "`Math.random()` in lib/ — security-sensitive randomness must come from crypto.randomBytes / crypto.randomUUID; non-security uses still go through a documented PRNG so nothing weak slips into an auth surface by accident",
    regex:       /\bMath\.random\s*\(/,
    allowlist:   [],
  },
  {
    id:          "todo-fixme-hack-xxx",
    scanScope:   "lib",
    description: "TODO / FIXME / HACK / XXX marker — either resolve before commit or convert to a tracked issue with a `deprecate()` / re-open-condition comment per the framework's no-MVP rule",
    regex:       /\b(?:TODO|FIXME|HACK|XXX)\b/,
    allowlist:   [],
  },
  {
    id:          "slsa-framework-action-not-sha-pinned",
    scanScope:   "workflows",
    description: "`slsa-framework/<workflow>@<ref>` — `ref` must be a 40-hex commit SHA; tag pins are mutable (upstream can re-publish) and silently rotate the builder root of trust",
    regex:       /\bslsa-framework\/[^@\s]+@(?!(?:[0-9a-fA-F]{40})\b)\S+/,
    allowlist:   [],
  },
  {
    id:          "vendor-hand-edit",
    scanScope:   "lib",
    description: "Direct file outside lib/vendor/ requires a vendored module via a path that bypasses MANIFEST.json. Use `require(\"../lib/vendor/blamejs\")` (or equivalent) only; never deep-import into vendored internals (that breaks the vendor refresh + the SBOM attribution chain)",
    regex:       /require\s*\(\s*['"][^'"]*\/lib\/vendor\/[^'"]*\/(?!index)/,
    allowlist:   [],
  },
  {
    id:          "process-exit-in-lib",
    scanScope:   "lib",
    description: "`process.exit()` in lib/ — module-level termination must come from the operator at the entry point, not from a library function. Library code throws; the caller decides whether the error is fatal",
    regex:       /\bprocess\.exit\s*\(/,
    allowlist:   [],
  },
  {
    id:          "empty-catch-swallow",
    scanScope:   "lib",
    description: "`catch (e) {}` with no body — silent error swallow. Either handle the error explicitly, log it through the framework's observability sink, or document the drop-silent intent inline so the next reviewer doesn't have to guess",
    regex:       /catch\s*\(\s*[\w$]+\s*\)\s*\{\s*\}/,
    allowlist:   [],
  },
  {
    id:          "fs-existssync-then-read-toctou",
    scanScope:   "lib",
    description: "`fs.existsSync(p)` followed by `fs.readFile`/`fs.readFileSync` against the same path is symlink-swap-vulnerable. The canonical defense is `try { fs.readFileSync(p) } catch (e) { if (e.code === \"ENOENT\") ... }` — single syscall, no TOCTOU window",
    regex:       /fs\.existsSync\s*\(/,
    allowlist:   [],
  },
  {
    id:          "regex-from-argv",
    scanScope:   "lib",
    description: "`new RegExp(<argv-derived>)` — operator-controlled input compiled into a regex source is a CodeQL regex-injection sink. Validate the input against a strict format gate before construction, OR use string `indexOf`/`startsWith` if you only need prefix matching",
    regex:       /new\s+RegExp\s*\([^)]*process\.argv/,
    allowlist:   [],
  },
  {
    // Reaching for node:crypto in lib/ — first confirm whether the
    // composed blamejs primitive already covers the use case. Most
    // hash / hmac / random API calls in shop code should compose
    // with b.crypto.* (sha3Hash, namespaceHash, hmacSha3,
    // generateBytes, generateToken, randomInt, timingSafeEqual) or
    // b.uuid.* (v4 / v7) rather than the raw node:crypto API.
    // Allow with `// allow:node-crypto-instead-of-b-crypto — <reason>`
    // when there's an algorithm or shape blamejs doesn't expose
    // (rare — most crypto needs are covered).
    id:          "non-shop-require",
    scanScope:   "lib",
    description: "`require()` in lib/ whose target is anything other than a relative shop module (`./…` or `../…`). Compose with the b.* primitive instead: b.crypto replaces node:crypto, b.uuid replaces node:crypto.randomUUID, b.safeUrl replaces node:url, b.atomicFile replaces node:fs writes, b.objectStore replaces node:fs reads against remote storage. Bare package names also violate the zero-npm-runtime-deps rule outright. Allow with a per-line `// allow:non-shop-require — <reason>` marker when the dependency is genuinely unavoidable.",
    regex:       /\brequire\s*\(\s*['"](?!\.)/,
    allowlist:   [],
  },
  {
    // Operator-facing source files must not reference the framework's
    // internal-rulebook artifact by name. Comments carry the discipline
    // INLINE so a stranger reading the file sees what the rule says,
    // not a pointer at a file they don't have. The regex below is the
    // only place the leaked strings appear; the descriptive prose
    // around it is intentionally token-free.
    id:          "internal-rulebook-vocabulary-in-source",
    scanScope:   "lib",
    description: "Describe the rule inline in plain language; the comment carries the discipline itself, not a pointer at an internal rulebook file. Operator-facing files (and the lib/ surface they ship in) must not reference the framework's internal rulebook by name.",
    // Built from char-class fragments so the literal token strings
    // don't appear in the rendered detector description that error
    // messages echo back at violators.
    regex:       new RegExp(
      "\\b(?:" +
      [67, 76, 65, 85, 68, 69].map(function (c) { return String.fromCharCode(c); }).join("") + "\\.md" +
      "|per\\s+" + [67, 76, 65, 85, 68, 69].map(function (c) { return String.fromCharCode(c); }).join("") + "\\b" +
      "|per\\s+project\\s+rule\\s+\\u00a7" +
      "|per\\s+rule\\s+\\u00a7\\d" +
      ")"
    ),
    allowlist:   [],
  },
];

function _check(antipattern) {
  var raw = _scan(antipattern.regex, antipattern.scanScope || "lib");
  var afterMarkers = _filterMarkers(raw, antipattern.id);
  var allowSet = (antipattern.allowlist || []).reduce(function (acc, p) { acc[p] = true; return acc; }, {});
  return afterMarkers.filter(function (m) { return !allowSet[m.file]; });
}

function run() {
  var failures = [];
  var passed = 0;
  for (var i = 0; i < KNOWN_ANTIPATTERNS.length; i += 1) {
    var ap = KNOWN_ANTIPATTERNS[i];
    var hits = _check(ap);
    if (hits.length === 0) {
      passed += 1;
      continue;
    }
    failures.push({ ap: ap, hits: hits });
  }
  if (failures.length === 0) {
    console.log("OK — " + passed + " detector(s) clean");
    return;
  }
  console.error("codebase-patterns FAIL — " + failures.length + " detector(s) tripped:");
  for (var f = 0; f < failures.length; f += 1) {
    var fail = failures[f];
    console.error("");
    console.error("[" + fail.ap.id + "] " + fail.ap.description);
    for (var h = 0; h < Math.min(fail.hits.length, 8); h += 1) {
      console.error("  " + fail.hits[h].file + ":" + fail.hits[h].line + ":  " + fail.hits[h].content);
    }
    if (fail.hits.length > 8) {
      console.error("  ... and " + (fail.hits.length - 8) + " more");
    }
  }
  process.exit(1);
}

module.exports = { run: run };

if (require.main === module) run();
