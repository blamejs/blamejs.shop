"use strict";

// codebase-patterns:allow-file test-promise-settimeout-sleep — this catalog file describes the pattern it detects; the description string inevitably contains the shape
// codebase-patterns:allow-file vendor-hand-edit — the description string mentions the pattern shape literally
// codebase-patterns:allow-file process-exit-in-lib — catalog references the literal `process.exit(...)` shape it detects
// codebase-patterns:allow-file empty-catch-swallow — catalog references the literal `catch (e) {}` shape it detects
// codebase-patterns:allow-file fs-existssync-then-read-toctou — catalog references the literal `fs.existsSync(` shape it detects
// codebase-patterns:allow-file regex-from-argv — catalog references the literal `new RegExp(... process.argv` shape it detects
// codebase-patterns:allow-file internal-rulebook-vocabulary-in-source — runtime regex construction inevitably includes the patterns being detected
// codebase-patterns:allow-file non-shop-require — catalog file describes the require shape it detects
// codebase-patterns:allow-file cursor-tamper-trailing-replace — catalog references the `next_cursor.slice(0, -N)` shape it detects
// codebase-patterns:allow-file hand-rolled-bankers-round — the description string contains the `% 2 === 0) ? floor` shape it detects

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
var WORKER_ROOT    = path.resolve(__dirname, "..", "..", "worker");
var TEST_ROOT      = path.resolve(__dirname, "..", "..", "test");
var SCRIPTS_ROOT   = path.resolve(__dirname, "..", "..", "scripts");
var WORKFLOWS_ROOT = path.resolve(__dirname, "..", "..", ".github", "workflows");
var SERVER_FILE    = path.resolve(__dirname, "..", "..", "server.js");

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

function _libFiles()    { return _walk(LIB_ROOT);    }
function _workerFiles() { return _walk(WORKER_ROOT); }
function _scriptFiles() { return _walk(SCRIPTS_ROOT); }
function _shopFiles()   { return _walk(LIB_ROOT).concat(_walk(WORKER_ROOT)); }
// The repo-root entry point (server.js) wires the HTTP routes + error
// mapping and isn't under lib/ or worker/, so no other scope reaches it.
function _serverFiles() { return fs.existsSync(SERVER_FILE) ? [SERVER_FILE] : []; }
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

function _scan(regex, scope, opts) {
  opts = opts || {};
  var files = scope === "test"      ? _testFiles()
            : scope === "workflows" ? _workflowFiles()
            : scope === "worker"    ? _workerFiles()
            : scope === "scripts"   ? _scriptFiles()
            : scope === "shop"      ? _shopFiles()
            : scope === "server"    ? _serverFiles()
            :                         _libFiles();
  var matches = [];
  // `matchOn: "basename"` — apply the regex against each file's
  // basename (the last `/`-separated component) rather than file
  // contents. Used by detectors that police naming conventions
  // (e.g. `release-named-test-file` refuses
  // `v0-8-41-additions.test.js` / `slot-19-enhancements.test.js`
  // shapes regardless of file body).
  if (opts.matchOn === "basename") {
    for (var bi = 0; bi < files.length; bi += 1) {
      var bname = path.basename(files[bi]);
      if (regex.test(bname)) {
        matches.push({ file: _relPath(files[bi]), line: 1, content: bname });
      }
    }
    return matches;
  }
  for (var i = 0; i < files.length; i += 1) {
    var content;
    try { content = fs.readFileSync(files[i], "utf8"); }
    catch (_e) { continue; }
    if (opts.multiline) {
      // Whole-file scan: regex spans line boundaries. `matchAll` walks
      // every non-overlapping match; line number is derived from the
      // byte offset by counting newlines before it.
      var multiFlags = regex.flags.indexOf("g") === -1 ? regex.flags + "g" : regex.flags;
      var globalRe   = new RegExp(regex.source, multiFlags);
      var allHits    = content.matchAll(globalRe);
      for (var hit of allHits) {
        var lineNum = content.slice(0, hit.index).split(/\r?\n/).length;
        matches.push({
          file:    _relPath(files[i]),
          line:    lineNum,
          content: hit[0].split(/\r?\n/)[0].trim(),
        });
      }
      continue;
    }
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
    id:          "cursor-tamper-trailing-replace",
    scanScope:   "test",
    description: "`<x>.next_cursor.slice(0, -N) + \"<literal>\"` rebuilds a tampered pagination cursor by replacing trailing chars — but it's a no-op when the cursor already ends in that literal, leaving the cursor valid and the expected HMAC-rejection missing (a flake that only surfaces on some cursor values). Flip a leading data char so the tamper always changes the cursor: `(c.charAt(0) === \"A\" ? \"B\" : \"A\") + c.slice(1)`",
    regex:       /\.next_?[Cc]ursor\.slice\(\s*0\s*,\s*-\d+\s*\)/,
    allowlist:   [],
  },
  {
    id:          "test-catch-discard-failure-assertion",
    scanScope:   "test",
    multiline:   true,
    description: "A failure-path test that catches the error into a throwaway boolean — a try whose catch binds an unused error and whose body only marks a flag, then checks that flag — discards the error, so the test passes on ANY throw (a setup bug, an early reject) and never asserts WHY it failed. Use assert.rejects(promise, /expected/) for an async rejection, or assert.throws(function () { ... }, /expected/) for a synchronous throw: both assert the operation fails AND for the expected reason, and need no caught variable. A catch that genuinely inspects the error (checks e.code / e.message) is not matched and is fine. Allow a deliberate exception with a per-line `// allow:test-catch-discard-failure-assertion — <reason>` marker.",
    regex:       /catch\s*\(\s*[\w$]+\s*\)\s*\{\s*[\w$]+\s*=\s*true\s*;?\s*\}/,
    allowlist:   [],
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
    id:          "hand-rolled-bankers-round",
    scanScope:   "lib",
    description: "A by-hand `(floor % 2 === 0) ? floor : floor + 1` tail is the round-half-to-even branch of a float-then-round money computation. Float intermediates lose precision over large minor-unit values (a tax filing summing many orders can pass 2^53). Compose the framework money primitive's half-even multiply on a BigInt round-trip — Number(b.money.fromMinorUnits(BigInt(minor), ccy).multiply([BigInt(num), BigInt(den)], { rounding: \"half-even\" }).toMinorUnits()) — it never touches a binary fraction",
    regex:       /%\s*2\s*===\s*0\s*\)?\s*\?\s*[\w$]*[Ff]loor/,
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
    id:          "error-discarded-return-failure-string",
    scanScope:   "shop",
    multiline:   true,
    description: "A catch that binds the error to a discarded (`_`-prefixed) name and whose only action is to `return` a hard-coded failure string (e.g. `catch (_e) { return \"failed\"; }`) — it SIGNALS that something failed while throwing away WHY, so the cause (a DB error, a provider error, a validation throw) is lost and resurfaces only as a later patch. eslint already forces a discarded caught error to be `_`-prefixed, so this shape is provably a swallow. If a step legitimately reports a failure status, OBSERVE the cause first: bind the error (`catch (e)`) and log it through the framework sink (`var _log = b.log.create({}); _log.error(\"<step> failed\", { err: (e && e.message) || String(e) })`) before returning the status, or re-throw / map it to a typed code. A catch that returns a NEUTRAL default (`\"\"`, `\"USD\"`, a fallback label) for a missing/garbage VALUE is the legitimate defensive-reader tier and is not matched (its returned string carries no failure word). Deliberate exceptions take a per-line `// allow:error-discarded-return-failure-string — <reason>` marker.",
    regex:       /catch\s*\(\s*_\w+\s*\)\s*\{\s*return\s+["'][^"']*(?:fail|unable|could ?not)[^"']*["']\s*;?\s*\}/i,
    allowlist:   [],
  },
  {
    id:          "subscription-mutator-create-without-payment",
    scanScope:   "server",
    multiline:   true,
    description: "The production wiring of `planChanges.create({...})` / `subscriptionControls.create({...})` in server.js omits the `payment` handle — so a plan / quantity change on a STRIPE-BACKED subscription updates the local plan but never pushes the price/quantity swap to Stripe, and the customer keeps being billed the old plan while the shop shows the new one (a silent local-vs-processor divergence). Pass the shared `payment` handle into the factory so the change syncs to Stripe (Stripe-first, before the local write). Scope is server.js only; integration tests that deliberately exercise the shop-local settlement path construct the factory without `payment` and are out of scope. Deliberate exceptions take a per-line `// allow:subscription-mutator-create-without-payment — <reason>` marker.",
    regex:       /\b(?:planChanges|subscriptionControls)\.create\(\s*\{(?:(?!payment)[\s\S])*?\}\s*\)/,
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

  // ---- blamejs primitive composition catchers ----------------------------
  //
  // Detector shape mirrors the vendored framework's own catalog at
  // `lib/vendor/blamejs/test/layer-0-primitives/codebase-patterns.test.js`
  // — `id` / `primitive` (canonical replacement) / `regex` / `allowlist` /
  // `reason`. Worker code that needs framework behavior composes
  // through `worker/b.js`; lib/ code composes through `_b()` (the
  // documented circular-load lazy loader the framework convention
  // already uses). Inline reinvention trips the detector.
  {
    id:        "worker-render-reinvented-primitive",
    primitive: "b.template.escapeHtml(value) — five-character HTML-entity escape (`&`, `<`, `>`, `\"`, `'` → `&#x27;`)",
    regex:     /\.replace\s*\(\s*\/&\/g\s*,\s*["']&amp;["']\s*\)/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Hand-rolled per-character escape misses an attack-relevant character about half the time (the four-char variants skip the apostrophe → single-quoted attribute injection) and drifts away from the canonical surface over time. `b.template.escapeHtml` is the one-call composition; the codebase-patterns sweep keeps any future copy from getting committed without an `allow:` marker citing the substrate constraint.",
  },
  {
    id:        "manual-html-escape-map",
    primitive: "b.template.escapeHtml(value) — the canonical five-character HTML-entity escape (`&`, `<`, `>`, `\"`, `'`); compose it instead of a local escape map + `.replace(/[&<>\"']/g, fn)`",
    regex:     /\.replace\s*\(\s*\/\[&<>["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "A local `HTML_ESCAPE_MAP` + `String(s).replace(/[&<>\\\"']/g, fn)` reinvents the framework's HTML escaper. Two copies drift (one adds a character, one normalizes an entity differently) and the canonical surface stops being the single source of truth. Compose `b.template.escapeHtml` (via `_b().template.escapeHtml` in lib).",
  },
  {
    id:        "intl-numberformat-currency-reinvented",
    primitive: "b.money.of(amount, currency).format(locale) — decimal-safe currency rendering composed off Intl.NumberFormat with currency-exponent normalization (zero / two / three-decimal currencies handled identically)",
    regex:     /new\s+Intl\s*\.\s*NumberFormat\s*\([^)]*style\s*:\s*["']currency["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`Intl.NumberFormat({style:\"currency\"})` callers reinvent the exponent normalization the framework's money primitive already handles (JPY=0, USD/EUR=2, BHD=3) and risk passing a Number where the framework's API would refuse one at the boundary (IEEE 754 binary-fraction drift). `b.money.of(BigInt(minor), currency).format(\"en-US\")` is the canonical call.",
  },
  {
    id:        "manual-timing-safe-equal",
    primitive: "b.crypto.timingSafeEqual(a, b) — refuses non-string non-Buffer input at the boundary (defends against prototype-pollution-influenced coercion) then routes to nodeCrypto.timingSafeEqual",
    regex:     /diff\s*\|\s*=\s*[\w$]+\s*\.\s*charCodeAt\s*\([\w$]+\)\s*\^\s*[\w$]+\s*\.\s*charCodeAt/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Hand-rolled `diff |= a.charCodeAt(i) ^ b.charCodeAt(i)` loops are correct when both inputs are equal-length ASCII strings, but bypass the framework's input-validation gate that refuses non-string non-Buffer values. A prototype-polluted toString() can redirect the compare; composing `b.crypto.timingSafeEqual` keeps that defense in scope.",
  },
  {
    id:        "inline-hmac-subtle-crypto",
    primitive: "b.crypto.hmacSha256(secret, message) — Worker-side HMAC-SHA256 extension composing node:crypto.createHmac (the same primitive the framework's internal hmac() helper uses); the framework also exposes b.crypto.hmacSha3 publicly as the PQC-first default",
    regex:     /crypto\s*\.\s*subtle\s*\.\s*sign\s*\(\s*["']HMAC["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Inline `crypto.subtle.sign(\"HMAC\", ...)` blocks for webhook signature verification reinvent two surfaces at once — the HMAC composition and the hex-encoding of the digest. The framework wrapper produces the same lowercase-hex output via a single call.",
  },
  {
    id:        "manual-random-uuid",
    primitive: "b.uuid.v7() — time-sortable UUIDv7 (sorts lexicographically by creation time, the framework default), or b.uuid.v4() when a v4-shape ID is explicitly required",
    regex:     /\bcrypto\s*\.\s*randomUUID\s*\(/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`crypto.randomUUID()` returns a v4 (random) UUID. The framework default is v7 — same 128 bits, but the timestamp prefix means rows sort by creation time without a separate `created_at` index. Composing `b.uuid.v7()` keeps any future migration to time-sortable IDs from drifting back to v4.",
  },
  {
    id:        "manual-random-bytes",
    primitive: "b.crypto.generateBytes(n) — CSPRNG-backed random bytes with the framework's entry-tier byte-count validation",
    regex:     /\bcrypto\s*\.\s*randomBytes\s*\(|^[^/]*\brandomBytes\s*\(\s*\d/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`crypto.randomBytes(n)` (or the `node:crypto` named import) reinvents the framework's randomness primitive. Composing `b.crypto.generateBytes(n)` keeps every CSPRNG draw auditable from one call site and applies the validation the framework already runs.",
  },
  {
    id:        "weak-hash-sha2",
    primitive: "b.crypto.sha3Hash(data) — SHA3-512 (PQC-first); for protocol-mandated SHA-2 (Stripe webhook digest, JWS, SRI, etc.) keep the inline call and mark with `allow:weak-hash-sha2 — <protocol> requires <algo>`",
    regex:     /createHash\s*\(\s*["'](?:sha256|sha384|sha512)["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "SHA-2 family hashes fall outside the framework's PQC-first crypto policy. Most application uses (content fingerprints, integrity checks, derived-column inputs, Merkle leaves) compose cleanly to SHA3-512 via `b.crypto.sha3Hash`. Genuine external-protocol exceptions (Stripe signature digest is SHA-256 by spec) live with an `allow:` marker citing the protocol.",
  },
  {
    id:        "manual-createhmac",
    primitive: "b.crypto.hmacSha3(key, data) — HMAC-SHA3-512 (PQC-first default), or b.crypto.hmacSha256 (Worker-side extension at worker/b.js) for protocol-mandated SHA-256 cases",
    regex:     /\bcreateHmac\s*\(/,
    scanScope: "shop",
    allowlist: [
      "worker/b.js",                              // the hmacSha256 Worker-side extension composes node:crypto.createHmac — this IS the documented composition site
    ],
    reason:    "`createHmac(...)` reinvents the framework's HMAC primitive. The PQC-first default is `b.crypto.hmacSha3`; protocol-mandated SHA-256 (Stripe webhooks) composes through `b.crypto.hmacSha256` wired into the Worker adapter. Direct `createHmac` calls outside `worker/b.js` get flagged.",
  },
  {
    id:        "manual-set-cookie-header",
    primitive: "b.cookies.create({ vault }).write / writeSealed / clear — RFC 6265 serialization (attribute order, encoding, __Host-/__Secure- prefix invariants) + vault-sealed cookie helpers that append the Set-Cookie header for you",
    regex:     /(?:setHeader|appendHeader)\s*\(\s*["']Set-Cookie["']/i,
    scanScope: "shop",
    allowlist: [],
    reason:    "Hand-built `Set-Cookie` strings written via setHeader/appendHeader reinvent the cookie primitive's serialization and skip the sealed-cookie helpers (so the cookie's seal/unseal + prefix invariants drift). Compose a `b.cookies.create({ vault })` jar once and call write/writeSealed/clear; the jar serializes + appends the header itself.",
  },
  {
    id:        "manual-cookie-header-parse",
    primitive: "b.cookies.create({ vault }).read(req, name) / readSealed(req, name) — parses the Cookie header through the framework's RFC 6265 parser instead of a hand-rolled split (the Worker, which has no Node req, feeds the header string to b.cookies.parseSafe for duplicate-name + control-byte detection)",
    regex:     /req\s*\.\s*headers\s*\.\s*[Cc]ookie\b/,
    scanScope: "lib",
    allowlist: [],
    reason:    "Reading `req.headers.cookie` and splitting it by hand reinvents the cookie primitive's parser and silently mishandles cookie-tossing (duplicate names, last-write-wins) and CR/LF/NUL header-injection. Compose `b.cookies.create({ vault }).read(req, name)` — or `b.cookies.parseSafe(header)` when you only hold the raw header string.",
  },
  {
    id:        "lazy-framework-accessor",
    primitive: "var b = require(\"./vendor/blamejs\"); … b.crypto / b.constants.TIME / b.middleware — capture the framework ONCE at module top (straight from the vendored tree, the same object index.js re-exports as `.framework`) and use `b.*` uniformly, like the worker. No lazy `_b()` indirection.",
    regex:     /\b_b\s*\(/,
    scanScope: "lib",
    allowlist: [],
    reason:    "The `var bShop; function _b() { … return bShop.framework; }` lazy accessor (and every `_b().<member>` call) is redundant indirection. Capture the framework at module top with `var b = require(\"./vendor/blamejs\");` and use `b.*` directly. (Do NOT use `require(\"./index\").framework` — see `index-require-in-leaf`: it triggers index's require cascade mid-module-eval and breaks leaf-first imports. The vendor tree has no circular dependency on shop modules, so requiring it directly is safe.) Drop in-function `var b = _b();` re-captures. Comment lines mentioning `_b()` are skipped by the scanner.",
  },
  {
    id:        "index-require-in-leaf",
    primitive: "var b = require(\"./vendor/blamejs\"); for the framework — NEVER require(\"./index\") from a leaf lib module. index.js COMPOSES the vendor + every leaf; a leaf that requires it at module-eval triggers index's cascade while the leaf is still initializing, so index snapshots the leaf's half-built (empty) exports and `require(\"blamejs-shop\").<leaf>` becomes `{}` on a leaf-first import order.",
    regex:     /require\(\s*["']\.\/index["']\s*\)/,
    scanScope: "lib",
    allowlist: [],
    reason:    "Requiring `./index` from a leaf module is a circular-load footgun: loading the leaf first (e.g. `require(\"blamejs-shop/lib/addresses\")`) makes index run its `Object.assign({ addresses: require(\"./addresses\"), … })` cascade while addresses.js is blocked on this very require, so index captures the leaf's default `{}` export (the module reassigns `module.exports` later) — `require(\"blamejs-shop\").addresses.create` is then undefined. Leaves need the FRAMEWORK, not the composing index: `var b = require(\"./vendor/blamejs\");` (identical object, no circular dependency). Only index.js itself composes the leaves.",
  },
  {
    id:          "raw-control-byte-in-source",
    primitive:   "Write control characters as escapes — \"\\u0000\" for a NUL separator, \"\\t\" for tab — never embed a raw C0 control byte in a source file. A raw NUL/control byte is byte-identical to its escape at runtime but turns the whole file binary to grep / `file` / diff / many editors.",
    regex:       /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/,
    scanScope:   "lib",
    multiline:   true,
    allowlist:   [],
    reason:      "A raw control byte in source (e.g. a literal NUL used as a composite-map-key separator, `sku + \"<raw-NUL>\" + loc`) makes the file register as binary: grep skips it, `file` reports 'data', diffs garble, some editors corrupt it on save. Use the escape sequence instead — `\"\\u0000\"` for a NUL separator is identical at runtime and keeps the source plain text, so framework access reads the same `var b = require(\"./index\").framework` everywhere with no special-cased 'binary' modules.",
  },
  {
    id:        "manual-request-body-stream-read",
    primitive: "b.middleware.bodyParser() (req.body ← parsed) or b.middleware.bodyParser.raw({ contentTypes }) (req.body ← raw Buffer) — the framework reads, size-caps, and smuggling-pre-flights the HTTP request body, instead of hand-attaching req.on('data')/'end' + Buffer.concat",
    regex:     /\breq\s*\.\s*on\s*\(\s*["']data["']/,
    scanScope: "lib",
    allowlist: [],
    reason:    "Hand-reading the HTTP request stream (`req.on('data')` + `Buffer.concat`) reinvents the body parser AND misses the router's await/next contract: this router awaits each middleware's return value and checks `next()` synchronously after, so a middleware that calls `next()` on the async `'end'` event returns before `next()` fires — the router stops the chain and the request hangs. For a route that needs the exact raw bytes (a webhook verifying a signature over the body), mount `b.middleware.bodyParser.raw({ contentTypes })` ahead of the JSON parser and read `req.body` (a Buffer). Reading a non-request Readable (file / import source) uses a different identifier (e.g. `stream.on`) and isn't matched.",
  },
  {
    id:        "fsm-name-not-audit-action-safe",
    primitive: "fsm.define({ name: \"<lowercase>[_<lowercase>]*\" }) — the framework's audit action validator at lib/vendor/blamejs/lib/audit.js:401 enforces `^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$` on every action, so the FSM `name` (which composes into `fsm.<name>.transition`) must match the same per-segment shape (`[a-z][a-z0-9_]*`)",
    regex:     /\bfsm\.define\s*\(\s*\{[\s\S]{0,200}?\bname\s*:\s*"(?![a-z][a-z0-9_]*"\s*,)[^"]*"/,
    scanScope: "lib",
    multiline: true,
    allowlist: [],
    reason:    "FSM names that contain uppercase letters or hyphens (e.g. `emailCampaign`, `dropship-forwarding`) compose into audit actions the audit validator refuses with `audit action must be 'namespace.verb[.qualifier...]' (lowercase, dot-separated)`. The audit module then drops the event silently with an error log, which masks the bug until it surfaces in a smoke run. Use snake_case identifiers (`email_campaign`) or single lowercase words (`order`) so the action validates cleanly at emit time.",
  },
  // ---- Ports from the vendored framework's catalog -----------------------
  //
  // The framework's `codebase-patterns.test.js` ships ~97 detectors;
  // most are framework-internal (helper-composition checks for code
  // that only exists inside blamejs itself). The block below ports the
  // ones that apply generically to any downstream consumer — primitive-
  // composition + security-discipline rules every blamejs.shop file
  // inherits. Each carries the same `id` / `primitive` / `regex` /
  // `reason` shape the upstream catalog uses so a future operator
  // diffing against blamejs sees the lineage.
  {
    id:        "raw-time-literal",
    primitive: "C.TIME.seconds / minutes / hours / days / weeks (n) — via `var C = _b().constants` (lib) or `b.constants` (worker) — so every duration has one source of truth instead of hand-multiplied `n * 60 * …` / `n * 1000` / bare ms literals",
    // High-signal duration-arithmetic shapes: a `* 1000` ms conversion,
    // a `* 60` / `* 3600` / `* 86400` time-base multiply, or a bare
    // second/ms duration literal (minute/hour/day/week). Standalone
    // counts that aren't time math don't match; a genuine non-duration
    // multiple (rare) takes a per-line `// allow:raw-time-literal —
    // <reason>` marker. Ported from the framework's own catalog.
    regex:     /[)\w.\]]\s*\*\s*1000\b|\b\d+\s*\*\s*(?:60|3600|86400)\b|\b(?:604800000|86400000|3600000|60000|604800|86400)\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Hand-multiplied durations (`30 * 24 * 60 * 60 * 1000`, `5 * 60`, bare `86400000`) drift away from a single source of truth and read ambiguously (seconds? ms?). Compose `C.TIME.days(30)` / `.minutes(5)` etc. — the unit is named at the call site and the framework owns the math. lib/ aliases `var C = _b().constants` at module top (the index entry point exposes `framework` before the require cascade, so module-eval resolution is safe); the Worker uses `b.constants`.",
  },
  {
    id:        "number-coerce-or-zero-on-json-source",
    primitive: "validate finite non-negative integer explicitly; never silently coerce JSON-source untrusted numerics with `Number(x) || 0`",
    regex:     /Number\s*\(\s*\w+\s*\[\s*["'][^"']*["']\s*\]\s*\)\s*\|\|\s*0\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`Number(json['x']) || 0` silently accepts `Infinity` / `NaN` / negative on untrusted JSON-source numeric fields. Use an explicit shape gate (`Number.isFinite(n) && n >= 0`) and throw a typed `TypeError` on bad input — never default to zero. Ported from blamejs's catalog as a downstream inheritance.",
  },
  {
    id:        "slice1-optional-parseint-silent-default",
    primitive: "after `var X = Y.slice(1)`, refuse empty-digit segment with an explicit throw BEFORE parseInt; never silently default to the no-suffix mask",
    regex:     /\.slice\s*\(\s*1\s*\)\s*;[\s\S]{0,80}?if\s*\(\s*\w+\.length\s*>\s*0\s*\)\s*\{[\s\S]{0,160}?\bparseInt\s*\(/,
    scanScope: "shop",
    multiline: true,
    allowlist: [],
    reason:    "`parseInt(X.slice(1))` returns `NaN` on an empty `X` (e.g. `\"/\"` after slicing the leading slash). Combined with a permissive default mask, this silently accepts inputs that the strict grammar refuses. Refuse the empty-digit case with an explicit throw before parseInt. Ported from blamejs's catalog (CIDR / prefix-length parsing context, but the pattern generalises to any sliced-then-parsed numeric).",
  },
  {
    id:        "utf16-length-as-byte-cap",
    primitive: "Buffer.byteLength(name, \"utf8\") > capInBytes — `.length` counts UTF-16 code units, not bytes; a multi-byte char (e.g. emoji surrogate pair) counts as 2 by length but spans 4+ bytes on the wire",
    regex:     /\b(?:name|input|s|str)\s*\.\s*length\s*>\s*\w*(?:maxBytes|MaxBytes|ByteCap|byteCap|maxScriptNameBytes|maxValueBytes|maxLineBytes|maxHeaderBytes)\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Using `s.length` as a byte cap conflates UTF-16 code units with bytes. A 2-byte UTF-16 surrogate pair (representing one 4-byte UTF-8 character) reads as `.length === 2`. Caps meant in bytes must use `Buffer.byteLength(s, \"utf8\")` (Node) or `new TextEncoder().encode(s).length` (Worker). Ported from blamejs's catalog.",
  },
  {
    id:        "raw-audit-emit-without-drop-silent-wrap",
    primitive: "b.audit.safeEmit(...) OR try { b.audit.emit(...) } catch (_e) { /* drop-silent */ }",
    regex:     /\baudit\.emit\s*\(/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`audit.emit(...)` validates strictly and can throw on bad action shape, missing namespace registration, or downstream sink failure. Calling it without a drop-silent wrapper means the audit attempt can crash the request path. The framework ships `audit.safeEmit` as the drop-silent variant; raw `audit.emit` must be inside `try / catch (_e) { /* drop-silent */ }`. Documented `try/catch`-wrapped call sites get per-file or per-line allow markers (see `lib/admin.js` for the canonical wrapped shape). Ported from blamejs's catalog.",
  },
  {
    id:        "non-ct-iss-compare",
    primitive: "b.crypto.timingSafeEqual(actualIssuer, expectedIssuer) — constant-time string comparison",
    regex:     /(?:payload|claims|token)\.iss\s*[!=]==\s*(?:opts\.issuer|vopts\.issuer|expectedIssuer|configuredIssuer|this\.issuer|preset\.issuer)\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "JWT `iss` claim comparison via `!==` / `===` is timing-side-channel-leaky on string compare. An attacker can byte-probe the expected issuer by measuring response time. Use `b.crypto.timingSafeEqual(actual, expected)` for any auth-sensitive identifier compare. Ported from blamejs's catalog.",
  },
  {
    id:        "gunzip-without-output-size-cap",
    primitive: "zlib.gunzipSync(buf, { maxOutputLength: <byte-constant> }) — bound decompression at config time",
    regex:     /\bzlib\s*\.\s*(?:gunzipSync|createGunzip|brotliDecompressSync|createBrotliDecompress)\s*\(/,
    requires:  /\bmaxOutputLength\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Unbounded `zlib.gunzipSync(buf)` on operator-supplied bytes is a zip-bomb amplification sink (CVE-2025-0725 / classic decompression-bomb class). Pass `{ maxOutputLength: <byte-constant> }` so the cap is visible at the call site; oversized inputs throw a typed error before the bomb reaches memory. Ported from blamejs's catalog. `requires` check exempts files that name `maxOutputLength` somewhere — sites with a separate budget helper.",
  },
  {
    id:        "audit-action-with-hyphen",
    primitive: "audit action segments use underscores per the validator regex `[a-z][a-z0-9_]*` — emit `audit.event_kind` not `audit.event-kind`",
    regex:     /\baction\s*:\s*["'][a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+-/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Audit action segments with hyphens (e.g. `system.pubsub.publish-failed`) fail the validator regex enforced by `audit.record()`. `safeEmit` catches the throw and silently drops the event. The convention is dot-separated identifiers with underscores. Detector regex requires at least one `.<segment>` before the hyphen to avoid false-positives on operator-vocabulary enum keys. Ported from blamejs's catalog.",
  },
  {
    id:        "non-canonical-audit-outcome",
    primitive: "outcome ∈ {\"success\", \"failure\", \"denied\"} — the three canonical strings the audit validator accepts at call time",
    regex:     /\boutcome\s*:\s*["'](?:ok|okay|fail|failed|err|error|warn|warning|duplicate|skip|skipped|pass|passed|succeeded|refused|deny)["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Non-canonical outcome strings (`ok`, `fail`, `warn`, `duplicate`, `skipped`, `error`) get normalized by `safeEmit` to one of the canonical triple as a safety net, but the strict `audit.record()` validator refuses them. Code reviewers reading a primitive should see exactly what outcome will land on the chain — use the canonical strings directly. Ported from blamejs's catalog.",
  },
  {
    id:        "jwk-import-without-alg-kty-check",
    primitive: "validate alg matches kty + use (sig vs enc) BEFORE composing `crypto.createPublicKey({ key, format: \"jwk\" })` — a JWK with alg=RS256 + kty=EC is a confused-deputy attack",
    regex:     /createPublicKey\s*\(\s*\{\s*key:\s*\w+\s*,\s*format:\s*["']jwk["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Importing a JWK without first verifying the `alg` matches the key type (`kty`) and intended `use` lets an attacker pass an RSA key marked as EC (or vice versa). The downstream signature verification accepts a key that wasn't issued for the algorithm — confused-deputy. Add `_assertAlgKtyMatch(alg, jwk)` (or equivalent) before the import. Ported from blamejs's catalog.",
  },
  {
    id:        "jose-alg-switch-permissive-default",
    primitive: "throw in the default branch of any switch on a JOSE alg value — `default: throw` refuses unknown alg outright; `default: return` / `default: break` silently accepts whatever the attacker proposed",
    regex:     /switch\s*\(\s*\w*[Aa]lg\w*\s*\)\s*\{[\s\S]{0,1500}?default:\s*(?:return|break|\/\/[^\n]*\n\s*\})/,
    scanScope: "shop",
    multiline: true,
    allowlist: [],
    reason:    "A `switch (alg)` with a permissive default (`return` / `break` / fall-through) accepts unknown algorithm strings, opening alg confusion attacks (HS256-as-RS256, none, etc.). The default branch must `throw` with a typed error refusing the unknown value. Ported from blamejs's catalog.",
  },
  {
    id:        "openmetrics-counter-family-name-mismatch",
    primitive: "OpenMetrics counter metadata (`# HELP / # TYPE / # UNIT`) and sample lines must agree on the family identifier — derive the exposition name once at the top of the loop so the `_total` suffix appears on BOTH the metadata and the samples",
    regex:     /["']# (?:HELP|TYPE|UNIT) ["']\s*\+\s*m\.name\s*\+\s*["'] ["']/,
    scanScope: "shop",
    allowlist: [],
    reason:    "OpenMetrics counter exposition requires the family identifier on both `# HELP / TYPE / UNIT` metadata and the `<name>_total` sample lines to match. Building metadata from `m.name` while the sample uses `m.name + \"_total\"` produces a metadata-vs-sample mismatch that crashes spec-compliant scrapers. Derive the exposed name once at the top of the loop. Ported from blamejs's catalog.",
  },
  {
    id:        "raw-sql-identifier-interpolation",
    primitive: "b.safeSql.quoteIdentifier(name, dialect?) — runs validateIdentifier + emits the dialect-correct quoted form (`\"name\"` for SQLite / Postgres, `` `name` `` for MySQL)",
    regex:     /\b(?:FROM|INTO|UPDATE|TABLE|INDEX|TRIGGER|VIEW|JOIN)\s+["']\s*\+\s*(?![qQ][A-Za-z0-9_]|quoted)\w+\s*\+/,
    scanScope: "shop",
    allowlist: [],
    reason:    "SQL identifier (table / column / index name) interpolated via string concat without a quote-and-validate pass is an identifier-injection sink — bound parameters can't carry identifiers, only values. `b.safeSql.quoteIdentifier(name, dialect)` runs the framework's `validateIdentifier` (length 1–63, charset `[A-Za-z_][A-Za-z0-9_]*`, reserved-word + sqlite_ prefix refusal) then emits the dialect-correct quoted form. Detector skips variables prefixed with `q` / `Q` / `quoted` (project convention for already-validated identifiers). Ported from blamejs's catalog.",
  },
  {
    id:        "inflate-unzip-without-output-size-cap",
    primitive: "zlib.inflateSync(buf, { maxOutputLength: <byte-constant> }) — same defense as gunzip; the inflate / inflateRaw / unzip family is the same RFC 1951 deflate bomb class",
    regex:     /\bzlib\s*\.\s*(?:inflateSync|inflateRawSync|unzipSync|createInflate|createInflateRaw|createUnzip)\s*\(/,
    requires:  /\bmaxOutputLength\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Completes the gunzip-cap detector. RFC 1951 deflate (the algorithm under gzip + zlib + raw inflate + unzip) has the same amplification class as gzip — inflate / inflateRaw / unzip without a cap is equally exploitable. Operators using `zlib.inflateSync` for HTTP `Content-Encoding: deflate` bodies or RFC 1950 zlib streams MUST pass `maxOutputLength`. Ported from blamejs's catalog.",
  },
  {
    id:        "external-callback-await-without-timeout",
    primitive: "b.safeAsync.withTimeout(externalCb(...), TIMEOUT_MS, { name: '<call-site>' }) — operator-supplied callbacks must be bounded; hot-path audit / session / observability emits can hang indefinitely otherwise",
    regex:     /await\s+_external(?:Store|Sink|Cb|Callback|Hook)\b/,
    requires:  /safeAsync\.withTimeout|withTimeout\s*\(/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Awaiting an operator-supplied callback (`_externalStore`, `_externalSink`, etc.) without a timeout means a stalled network call neither resolves nor rejects — the await never returns, the calling primitive's audit / observability emit stalls, the request that triggered it stalls behind. Wrap every external-callback await in `b.safeAsync.withTimeout(cb(), TIMEOUT_MS, { name: ... })`. Ported from blamejs's catalog.",
  },
  {
    id:        "monotonic-terminal-state-overwrite-without-guard",
    primitive: "any state machine with a `done` (or terminal) flag whose async handler writes `state.done = true; state.X = ...` MUST check `if (state.done) return;` first; otherwise a late-arriving handler clobbers an earlier terminal state",
    regex:     /\.done\s*=\s*true\s*;[\s\S]{0,200}?\.\w+\s*=\s*/,
    scanScope: "shop",
    multiline: true,
    allowlist: [],
    reason:    "Long-running-operation / saga / queue-job state machines that set `state.done = true` then write further fields without first checking `if (state.done) return` race condition cancellation, error, and timeout handlers. A late-arriving completion handler clobbers an earlier terminal state. Ported from blamejs's catalog.",
  },
  {
    id:        "optional-iat-age-check-no-required-freshness",
    primitive: "token / assertion verifier must REFUSE missing freshness (iat OR server-nonce) before age-checking — `if (typeof X.iat === \"number\") { age check }` short-circuits to no-check on missing iat",
    regex:     /typeof\s+\w+\.iat\s*===\s*["']number["']\s*&&\s*\w+\s*-\s*\w+\.iat/,
    scanScope: "shop",
    allowlist: [],
    reason:    "An `iat` freshness check that gates ONLY on `typeof iat === \"number\"` (rather than refusing missing-iat first) accepts tokens without an iat as fresh. The verifier must either refuse missing iat outright OR gate `(iat is number OR server-nonce present)` before the age comparison. Ported from blamejs's catalog.",
  },
  {
    id:        "ssrf-skip-without-textual-metadata-check",
    primitive: "any SSRF-skip path (proxy short-circuit, operator-pinned IP, custom dnsLookup) MUST call `b.ssrfGuard.checkUrlTextual(url)` first; metadata IPs (169.254.169.254 / fd00:ec2::254) are NEVER overridable",
    regex:     /=\s*Promise\.resolve\s*\(\s*\{\s*ips:\s*null/,
    scanScope: "shop",
    allowlist: [],
    reason:    "An SSRF-bypass pattern (`Promise.resolve({ ips: null })` to skip resolution / pin a proxy) must FIRST call `b.ssrfGuard.checkUrlTextual(url)` to verify the URL textually doesn't target a metadata service. The textual check refuses link-local + metadata IPs unconditionally — operator-configurable allowlists never apply. Ported from blamejs's catalog.",
  },
  {
    id:        "zlib-decompress-not-via-safedecompress",
    primitive: "b.safeDecompress(buf, { algorithm, maxOutputBytes, maxCompressedBytes, ... }) — composes the algorithm allowlist + ratio cap + audit emission",
    regex:     /\bzlib\.(?:gunzipSync|gunzip|inflateSync|inflateRawSync|inflate|inflateRaw|unzipSync|unzip|brotliDecompressSync|brotliDecompress|createGunzip|createInflate|createInflateRaw|createUnzip|createBrotliDecompress)\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Raw `zlib.*` decompression calls bypass the framework's `b.safeDecompress` which composes algorithm allowlist + ratio cap + decompression-bomb defense + audit emission. New code should compose through the framework primitive; legacy call sites with documented maxOutputLength still satisfy the sibling `gunzip-without-output-size-cap` detector. Ported from blamejs's catalog.",
  },
  {
    id:        "buffer-from-string-on-auth-path",
    primitive: "validate input is a Buffer or string explicitly and refuse other shapes; never `Buffer.from(String(x))` on auth-relevant paths — the `String(x)` coercion lets a prototype-pollution-influenced caller redirect the compare through bytes that have nothing to do with the supplied value",
    regex:     /\bBuffer\.from\s*\(\s*String\s*\(/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`Buffer.from(String(x))` on an auth-relevant input (token, secret, session id) is a prototype-pollution sink — an attacker-controlled `toString()` method on the input redirects the byte sequence the comparison observes. Validate the input is a Buffer OR a string at the boundary, and refuse other shapes with a typed error. `b.crypto.timingSafeEqual` is the canonical shape for the constant-time compare; it already enforces this. Ported from blamejs's catalog.",
  },
  {
    id:        "timing-safe-equal-utf8-without-shape-guard",
    primitive: "validate byte shape (ASCII / hex / base64url) before composing `b.crypto.timingSafeEqual` on UTF-8 encoded strings — the underlying nodeCrypto.timingSafeEqual throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` when UTF-8 byte lengths diverge even though `.length` matches",
    regex:     /\bnodeCrypto\s*\.\s*timingSafeEqual\s*\(\s*Buffer\s*\.\s*from\s*\([^,]+,\s*["']utf8["']\s*\)\s*,\s*Buffer\s*\.\s*from\s*\([^,]+,\s*["']utf8["']\s*\)\s*\)/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`nodeCrypto.timingSafeEqual(Buffer.from(a, \"utf8\"), Buffer.from(b, \"utf8\"))` throws on byte-length mismatch — for non-ASCII strings, character-count parity doesn't guarantee byte-count parity (a 2-character emoji is 8 bytes in UTF-8, 2 in UTF-16). Either restrict the input domain to ASCII (token / hash / base64url shapes), or compare byte lengths explicitly before the timingSafeEqual call. `b.crypto.timingSafeEqual` wraps this with the entry-tier validation. Ported from blamejs's catalog.",
  },
  {
    id:        "wildcard-suffix-match-without-single-label-check",
    primitive: "matching a `*.example.com` wildcard against a host MUST refuse single-label matches (the `*` is one label, not zero+; `example.com` itself is not covered by the wildcard)",
    regex:     /\bendsWith\s*\(\s*["']\.\w+/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Using `host.endsWith(\".example.com\")` to match a `*.example.com` wildcard accepts both `foo.example.com` (intended) AND the bare `.example.com` / unexpected forms (DNS rebinding / phishing). The wildcard `*` covers exactly one DNS label; the matcher must additionally refuse the single-label and zero-label cases. Ported from blamejs's catalog — RFC 6125 §6.4.3 + CABF Baseline Requirements §3.2.2.6.",
  },
  {
    id:        "fs-path-from-operator-identifier-without-traversal-refusal",
    primitive: "validate name against a strict character class + explicit `..` / `\\0` / `/` refusal before passing to path.join / fs.* calls",
    regex:     /\bpath\s*\.\s*join\s*\([^)]*\b\w+\s*\.\s*(?:name|id|slug|filename)\b[^)]*\)/,
    scanScope: "shop",
    allowlist: [],
    reason:    "`path.join(rootDir, x.name)` where `x.name` came from operator / user input is a path-traversal sink — `x.name = \"../../../etc/passwd\"` escapes the root. The composed name must be validated against a strict character class AND an explicit `..` refusal before reaching `path.join` / `fs.*`. Ported from blamejs's catalog.",
  },

  {
    id:        "edge-handler-catch-returns-null",
    primitive: "Each edge handler's catch must return an explicit error Response (e.g. `_edgeError(...)` rendering a 5xx page) — never `return null`, which signals \"this path isn't edge-routed\" to the dispatcher and silently escalates the exception to the container. The container can't fix a render-side bug; the visitor experience of fallback-to-different-backend is worse than a clean error page; the escalation hides the bug from observability.",
    // `[^}]` keeps the match inside the catch body so the detector
    // doesn't span past the closing brace into the next function's
    // guard-clause `return null;`. Catches the shape
    // `catch (e) { ... return null; }` without nested braces — the
    // edge-handler convention is one guard / one return inside the
    // catch, so the no-nested-brace constraint is fine in practice.
    regex:     /catch\s*\(\s*[\w$]+\s*\)\s*\{[^}]{0,400}return\s+null\s*;/,
    scanScope: "worker",
    multiline: true,
    allowlist: [],
    reason:    "`catch (e) { ... return null; }` in a Worker handler routes the exception back to the dispatcher which falls through to `_forwardToContainer`. That's a pass-through: the edge \"detected\" a failure and silently escalated it to a backend that can't help. The legitimate `return null` shape is in routing dispatch (`if (path === \"/\") return ...; return null;`), where null means \"this path isn't edge-routed, fall through\" — NOT \"my render threw, you handle it.\" Edge handlers must serve their own 5xx via `renderInternalError` and log to observability.",
  },
  {
    id:        "worker-uses-sha3-primitive",
    primitive: "Cloudflare Workers' `nodejs_compat` runtime exposes `node:crypto` but the supported digest set is a subset of full Node — `createHash(\"sha3-512\")` / SHAKE256 are NOT in it (`Error: Digest method not supported`). Worker code that needs a stable hash either routes to the container (where the framework's SHA3-512 path runs server-side) or uses an algorithm in the Workers-supported subset (`b.crypto.hmacSha256` already augmented onto `worker/b.js`).",
    regex:     /\bb\.crypto\.(?:sha3Hash|hmacSha3|namespaceHash|shake256|shake512|hkdfSha3)\s*\(/,
    scanScope: "worker",
    allowlist: [],
    reason:    "v0.0.120 — `b.crypto.namespaceHash` shipped in `_edgeNewsletter` returned `Error: Digest method not supported` on every request; the Workers `nodejs_compat` surface doesn't include SHA3-family digests. Working around with a Web-Crypto SHA-256 fallback would silently diverge hash outputs from container-side SHA3-512 values, breaking cross-substrate lookups (e.g. unsubscribe-by-email_hash). When edge code needs to derive a stable identifier from operator-controlled bytes: route the request to the container, OR use `b.crypto.hmacSha256` IFF both sides will read with the same SHA-256 path — never have one substrate write SHA3 and another read SHA-256.",
  },
  {
    id:        "inline-base64url-three-replace",
    primitive: "b.crypto.toBase64Url(buf) — routes through Node's built-in 'base64url' encoding (linear-time, no regex backtracking surface)",
    regex:     /\.replace\(\s*\/=\+\$\/[gG]?\s*,/,
    scanScope: "shop",
    allowlist: [],
    reason:    "The `.replace(/=+$/, \"\")` trailing-padding strip is polynomial-ReDoS-shaped per CodeQL js/polynomial-redos. The framework's `b.crypto.toBase64Url(buf)` helper routes through Node's built-in base64url encoding which is linear-time and produces the same RFC 4648 §5 output. Refactor any server-side reinvention to `_b().crypto.toBase64Url(buf)`. Browser-side string-template helpers shipped in `lib/storefront.js` carry inline `allow:inline-base64url-three-replace` markers because the page has no `b.crypto` to call — `window.btoa` plus the three-replace shim is the runtime-built-in equivalent. Ported from blamejs's catalog.",
  },
  {
    id:        "safeurl-parse-string-method",
    primitive: "`b.safeUrl.parse(s)` returns a WHATWG `URL` instance, not a string. Strip the trailing slash / concatenate the origin off `.href` / `.toString()` / `String(parsed)` — never call a string method (`.replace` / `.startsWith` / `.endsWith` / `.split` / `.includes` / `.slice` / `.indexOf` / `.toLowerCase` / `.toUpperCase`) directly on the return value or the worker throws TypeError at request time and the edge handler 503s.",
    // Matches `b.safeUrl.parse(...).<strMethod>(`. The `\b.\s*` chain
    // tolerates whitespace; the closing `(` requires a method call
    // (so a bare `.href` property access doesn't trip — that one's
    // the correct shape). The string-method set is the high-traffic
    // sample — adding `.match` / `.search` / `.repeat` is fine but
    // these eight cover every callsite shape that's tripped in the
    // worker so far.
    regex:     /\bsafeUrl\s*\.\s*parse\s*\([^)]*\)\s*\.\s*(?:replace|startsWith|endsWith|split|includes|slice|indexOf|toLowerCase|toUpperCase)\s*\(/,
    scanScope: "worker",
    allowlist: [],
    reason:    "Shipping `b.safeUrl.parse(env.X || \"...\").replace(/\\/$/, \"\")` silently throws TypeError in production: `URL.prototype.replace` doesn't exist. The edge handler's catch swallows the throw and returns the canonical 503 — the route looks 'temporarily unavailable' but is actually permanently broken on that callsite. Detected because three handlers (sitemap / feed / cache-warmer) shipped with this shape and went undetected while the upstream production deploy was frozen at an older worker. Fix: chain `.href.replace(/\\/$/, \"\")` so the string method operates on the URL's `href` string. Equivalent expressions: `String(parsed).replace(...)`, `parsed.toString().replace(...)`.",
  },
  {
    id:        "unvalidated-env-url-as-origin",
    primitive: "b.safeUrl.parse(env.<NAME>_URL || \"<default>\") — runs the configured URL through the framework's scheme allowlist (default HTTPS-only; refuses javascript: / file: / data:) and length cap before any callsite uses it as a fetch origin or feed `<link>` href",
    regex:     /\bfetch\s*\(\s*[\w$.]*\bD1_BRIDGE_URL\b|\bfetch\s*\(\s*env\s*\.\s*[A-Z][A-Z0-9_]*_URL\b|\borigin\s*[:=]\s*env\s*\.\s*[A-Z][A-Z0-9_]*_URL\b|\borigin\s*[:=]\s*["']https?:\/\/[^"']*["']\s*\+\s*env/,
    scanScope: "worker",
    allowlist: [],
    reason:    "Using an env-bound URL as a fetch origin or RSS `<link>` href without first running it through `b.safeUrl.parse` skips the framework's scheme allowlist (refuses javascript: / file: / data:) and length cap. The detector flags the unsafe SHAPES — `fetch(env.X_URL)`, `origin: env.X_URL`, or `origin: \"https://...\" + env.X` — without trying to negative-match the safe wrapper around them. Wrap the env access in `b.safeUrl.parse(env.X_URL || \"https://default\")` and assign the normalized return to the origin variable before the call site.",
  },
  {
    id:        "worker-direct-vendor-import",
    primitive: "import b from \"./b.js\" — go through the worker/b.js adapter so the Worker has one validated surface for framework primitives",
    regex:     /from\s+["'][^"']*lib\/vendor\/blamejs\/lib\//,
    scanScope: "worker",
    allowlist: [
      "worker/b.js",                              // the adapter itself imports leaf modules — that's its job
    ],
    reason:    "Direct leaf-module imports (`import bMoney from \"../lib/vendor/blamejs/lib/money.js\"` etc.) bypass the Worker adapter's single point of validation. The adapter is the place where leaf-module Worker-compatibility lives; broadening primitive access through ad-hoc imports drops that gate. Add a new namespace to `worker/b.js` instead.",
  },
  {
    // A new edge-rendered POST form whose action isn't in the CSRF guard's
    // exempt set (EDGE_POST_PATHS in lib/security-middleware.js) would 403 in
    // production: the container scopes its double-submit CSRF check to exempt
    // exactly the edge-cached, cookie-less, dual-rendered forms (cart-add,
    // consent, currency, newsletter, wishlist/compare toggle, announcement
    // dismiss), and the edge copies carry no `_csrf` token. Any OTHER edge
    // POST form's no-JS submit arrives token-less and the guard rejects it.
    // The negative-lookahead prefix list MUST stay in sync with
    // EDGE_POST_PATHS — when that array changes, update this regex too.
    id:        "edge-form-csrf-exempt",
    primitive: "Every `<form method=\"post\">` in worker/render/* must post to an action covered by an EDGE_POST_PATHS prefix (lib/security-middleware.js). Edge forms are cookie-less + token-less, so the container's csrfGuard exempts exactly that set; a new edge POST form to any other action 403s on a no-JS submit. Either move the action under an existing exempt prefix, add the prefix to EDGE_POST_PATHS (+ here), or render that form container-only so it carries the `_csrf` token.",
    regex:     /<form\b[^>\n]*?method=\\"post\\"[^>\n]*?action=\\"(?!(?:\/cart\/lines|\/cart\/bundle|\/wishlist\/toggle|\/compare\/toggle|\/consent|\/currency|\/newsletter|\/unsubscribe|\/announcements\/|\/stock-alert\/subscribe|\/stock-alert\/unsubscribe))/i,
    scanScope: "worker",
    allowlist: [],
    reason:    "The CSRF guard (lib/security-middleware.js) double-submit-validates every state-changing POST except EDGE_POST_PATHS — the edge-cached, cookie-less, dual-rendered forms that cannot carry a per-session token without breaking render-parity or no-JS submission. An edge POST form to any action OUTSIDE that set ships a token-less form whose no-JS submit the guard rejects with 403. This detector fires the moment a new worker/render form posts to an un-exempt action, before it reaches production. Resolution: route the action under an existing exempt prefix, extend EDGE_POST_PATHS (and the lookahead here in lockstep), or move the form to a container-only render where _csrf is injected.",
  },
  {
    // The vendor refresh pins an explicit release tag; `latest` would make a
    // CI run silently adopt whatever the upstream default branch points at —
    // a moving supply-chain target that bypasses the deliberate, reviewed
    // version bump the vendor-update flow exists to gate.
    id:        "workflow-no-vendor-latest",
    primitive: "scripts/vendor-update.sh <name> <tag> — pin an explicit release tag in CI, never `latest`. `latest` resolves to a mutable upstream ref, so a workflow run silently re-vendors a different tree than the one that was reviewed.",
    regex:     /vendor-update\.sh\s+\S+\s+latest\b/,
    scanScope: "workflows",
    allowlist: [],
    reason:    "`vendor-update.sh <name> latest` in a workflow resolves the vendored dependency against a mutable upstream ref at run time — a workflow re-run can pull a different tree than the one a human reviewed, defeating the pinned-tag discipline the vendor refresh enforces. Vendor refreshes are a deliberate, reviewed version bump; CI must pass an explicit `vX.Y.Z` tag (or `--check`, which verifies the pin without refreshing), never `latest`.",
  },

  // ---- Catalog mirror from vendored blamejs ----
  // Ported from lib/vendor/blamejs/test/layer-0-primitives/codebase-patterns.test.js.
  // Detectors scoped "shop" (lib + worker) so reinventions are caught
  // anywhere in the application surface. Allowlist entries that
  // reference vendor paths (e.g. `lib/crypto.js`) are kept verbatim;
  // shop's `_walk` skips the vendor tree so they're harmless no-ops.
    {
    // Codex P1 on v0.12.7 PR #158 — archive-read.extract's rollback
    // cleanup deleted PRE-EXISTING destination files when a later
    // entry failed. The renameSync(tmpPath, resolvedPath) silently
    // overwrote operator files at the destination, then on abort the
    // catch-block rmSync wiped them out — permanent data loss
    // disguised as atomic rollback. Fix: refuse to write when the
    // destination path already exists; force operators to extract
    // into a fresh / empty subtree.
    //
    // Detector scope: any lib/archive*.js or lib/safe-archive.js file
    // that calls renameSync into a path it ALSO tracks for cleanup
    // MUST refuse overwrite up-front. Codify as a file-scoped invariant:
    // archive-read.js must contain "destination-exists" refusal code.
    id: "archive-extract-overwrite-without-refusal",
    primitive: "extract loops in lib/archive-read.js MUST refuse to write to a destination path that already exists — atomic rollback via tmp-rename + tracked-path cleanup is only safe when every tracked path was newly created. Pre-existing files at the destination + catch-block rmSync = data loss.",
    // File-scoped: only fires on archive-read.js / safe-archive.js
    // shape. The pattern is renameSync of a tmpPath onto resolvedPath
    // (the canonical destination variable) — atomic-file.js's
    // operator-file rename is a different shape (operator already
    // owns the destination context); http-client.js's atomic-tmp
    // rename writes operator-supplied paths under operator-supplied
    // tmp dirs, also a different concern.
    regex: /written\.push\s*\(\s*\{[^}]*path:\s*resolvedPath/,
    scanScope: "shop",
    requires: /destination-exists/,
    skipCommentLines: true,
    allowlist: [],
    reason: "Codex P1 on v0.12.7 PR #158 — archive-read.extract used renameSync to atomically place each decompressed entry at its canonical destination + tracked written[].path for catch-block cleanup. When the destination directory was non-empty, the rename silently overwrote operator files; on extract abort, the cleanup deleted them. Fix: refuse upfront if destination path exists, force operators to use a fresh / empty subtree. Detector locks the shape: any extract code that tracks resolvedPath for catch-block cleanup MUST carry a `destination-exists` refusal in the same file.",
  },
    {
    // v0.12.9 — Direct node:zlib gunzip calls in lib/ must compose
    // b.safeDecompress (1 GiB output / 100× ratio default caps) so a
    // hostile gzip stream can't OOM or expand-bomb the host. Mirrors
    // the v0.11.5 must-compose pattern. lib/archive-gz.js IS the
    // canonical gunzip site (it wires safeDecompress in directly);
    // every other lib/ call to zlib.gunzipSync / zlib.createGunzip
    // must either route through b.safeDecompress OR carry a marker
    // explaining why it's safe to bypass (e.g. the caller already
    // applied `maxOutputLength` AND the input is operator-controlled).
    id: "archive-gz-without-safedecompress",
    primitive: "every lib/ call to zlib.gunzipSync / zlib.createGunzip / gunzip MUST either go through lib/archive-gz.js (which composes b.safeDecompress) OR carry an `allow:archive-gz-without-safedecompress` marker with the reason the bomb gate is bypassed (typically: `maxOutputLength` is already enforced + the input is operator-trusted).",
    regex: /zlib\.(?:gunzipSync|createGunzip)\b/,
    scanScope: "shop",
    requires: /safeDecompress|maxOutputLength|allow:archive-gz-without-safedecompress/,
    skipCommentLines: true,
    allowlist: [
      // archive-gz.js is the canonical gunzip site — it directly
      // imports safeDecompress and routes every call through it.
      // Listed here so the detector doesn't false-positive against
      // its own enforcement file.
      "lib/archive-gz.js",
    ],
    reason: "v0.12.9 — b.archive.read.gz is the framework's gzip read primitive and composes b.safeDecompress for every gunzip. Direct lib/ zlib.gunzipSync / zlib.createGunzip calls must either route through b.archive.read.gz, compose b.safeDecompress inline, OR carry an explicit `maxOutputLength` cap with the bypass marker. The detector locks the contract so v0.13+ primitives that handle a gzip-wrapped payload can't quietly drop the bomb cap.",
  },
    {
    // Codex P1 + P2 on v0.12.9 PR #160 — backup readBundle's
    // tar.gz restore path inherited archive.read.gz defaults (1 GiB
    // output / 100× ratio), which made the SAME primitive write
    // bundles it couldn't read back. The detector enforces the
    // write/read contract for self-authored gzip payloads: any
    // lib/ call to `archive.read.gz(...)` from a context that has
    // its own size budget (paired with a `maxBundleBytes` /
    // `maxOutputBytes` / `maxPayloadBytes` opt) MUST propagate
    // that budget to read.gz via `maxDecompressedBytes` AND
    // disable the ratio cap (`maxExpansionRatio: 0`) — bombs in
    // self-authored payloads are already prevented at write time.
    id: "archive-read-gz-without-self-authored-budget",
    primitive: "callers of archive.read.gz from a context that gates its own writes on a size cap (maxBundleBytes / similar) must pass maxDecompressedBytes + maxExpansionRatio:0 so the write/read contract is symmetric. Bomb defenses live at the upstream cap; the gz layer just decompresses.",
    // File-scoped: only fires on backup/index.js shapes for now.
    // archive.read.gz called with no opts is fine in operator code
    // (adversarial-input case); the antipattern is when the caller
    // also writes payloads under its own size cap.
    regex: /archive(?:Lazy\(\))?\.read\.gz\s*\([^)]*\)\s*[^,{]/,
    scanScope: "shop",
    requires: /maxDecompressedBytes/,
    skipCommentLines: true,
    allowlist: [
      // archive-gz.js IS the read.gz primitive itself.
      "lib/archive-gz.js",
    ],
    reason: "Codex P1/P2 on v0.12.9 PR #160 — backup readBundle's tar.gz restore inherited the 100× ratio + 1 GiB output defaults, breaking restore for zero-filled DB dumps + ~1-8 GiB bundles that writeBundle accepts. Fix: every archive.read.gz call from a primitive with its own size budget propagates that budget. Detector locks the symmetry.",
  },
    {
    // Codex P1 on v0.12.8 PR #159 — archive-tar-read.js's walker
    // advanced `pos` by the declared padded block size without
    // checking that those bytes existed in the buffer. A truncated
    // archive (header says 11 bytes, buffer holds 8) silently
    // produced an entry whose extract() sliced the 8-byte prefix
    // and wrote it as if it were the complete file. Fix: refuse
    // upfront with a `truncated-entry` typed error when
    // `bodyStart + paddedSize > bytes.length`. Same shape applies
    // to the pax-extended-header path (its `bodyEnd` advance was
    // the same uncapped arithmetic).
    id: "archive-tar-walker-without-truncation-check",
    primitive: "tar walkers in lib/archive-tar-read.js MUST verify that the declared block size fits within the remaining buffer before advancing `pos` — a header that claims more bytes than the buffer holds is a truncated archive, not a valid entry. The refusal carries `truncated-entry` code so operators can distinguish wire-format-bad input from policy-bad input.",
    // File-scoped: only fires on archive-tar-read.js. The walker
    // advances pos by paddedSize (Math.ceil(hdr.size / BLOCK_SIZE)
    // * BLOCK_SIZE) — any code that adds paddedSize to pos without
    // a preceding bounds check is the smell.
    regex: /pos\s*\+=\s*paddedSize/,
    scanScope: "shop",
    requires: /truncated-entry/,
    skipCommentLines: true,
    allowlist: [],
    reason: "Codex P1 on v0.12.8 PR #159 — archive-tar-read.js's tar walker recorded each entry and advanced pos by paddedSize without verifying the declared bytes existed in the buffer. A truncated archive silently produced a partial-content entry on extract — exact reproducer in the Codex thread: declared 11-byte file backed by 8 bytes of buffer produced an 8-byte output. Fix: refuse upfront with `archive-tar/truncated-entry` typed error. Detector locks the shape: any code path that advances pos by paddedSize in archive-tar-read.js MUST carry a `truncated-entry` refusal in the same file.",
  },
    {
    // v0.12.10 — when bundleAdapterStorage carries a posture that
    // mandates encryption-at-rest (HIPAA / PCI-DSS / similar), the
    // same call-site MUST propagate cryptoStrategy: "recipient"
    // (or refuse upstream) — the storage adapter alone cannot
    // satisfy the regulatory contract. The library-internal refusal
    // at `backup/posture-requires-encryption` is the runtime gate;
    // this detector locks the shape at the static-analysis layer
    // so any future caller that drops cryptoStrategy from a
    // posture-bearing call surfaces during codebase-patterns.
    id: "backup-adapter-storage-without-posture-check",
    primitive: "any bundleAdapterStorage({ ... posture: ... }) call site that names a posture from the HIPAA / PCI-DSS / etc. set MUST also pass cryptoStrategy. The library-side refusal exists; the detector exists so the contract can't drift silently when a primitive composes bundleAdapterStorage indirectly.",
    regex: /bundleAdapterStorage\s*\([^)]*posture:/,
    scanScope: "shop",
    requires: /cryptoStrategy|allow:backup-adapter-storage-without-posture-check/,
    skipCommentLines: true,
    allowlist: [
      // backup/index.js IS the primitive — the runtime refusal lives
      // there. Self-allowed so the detector doesn't flag the
      // refusal-emitting code itself.
      "lib/backup/index.js",
    ],
    reason: "v0.12.10 — Flavor 1 recipient wrap lands as bundleAdapterStorage's cryptoStrategy: \"recipient\". HIPAA + PCI-DSS postures refuse cryptoStrategy: \"none\" at runtime; this detector adds the static-side gate so a primitive composing bundleAdapterStorage with a posture opt can't accidentally drop the cryptoStrategy propagation. Future Flavor 2 (per-entry, v0.12.11) extends the same contract.",
  },
    {
    id: "dot-stuff-jsregex-bare-lf",
    primitive: "b.safeSmtp.dotStuff(buf) — CRLF-aware byte-level dot-stuffing",
    // `.replace(/^\./gm, "..")` on a JS string treats bare LF as a line boundary, so bodies
    // containing bare-LF lines that start with '.' gain spurious stuffing the receiver's strict-CRLF
    // parser won't undo. Route through safeSmtp.dotStuff which only treats canonical \r\n as a boundary.
    regex: /\.replace\(\s*\/\^\\\.\/gm\s*,\s*["']\.\.["']\s*\)/,
    scanScope: "shop",
    allowlist: [],
    reason: "POP3 RETR + SMTP DATA dot-stuffing. The JS regex `/^\\./gm` matches bare-LF line starts as well as CRLF starts, so the stuffing differs from RFC 1939 §3 / RFC 5321 §4.5.2 (canonical CRLF only). Use b.safeSmtp.dotStuff(buf) on the raw Buffer — it walks bytes and recognizes ONLY \\r\\n as a line boundary.",
  },
    {
    // Codex P1 (v0.10.13 PR #102) — ASN.1 context-specific implicit
    // tag bytes (0x80 | N for primitive, 0xa0 | N for constructed)
    // hand-rolled at call sites instead of routed through the
    // dedicated helpers. The bug class: an SKI wrap that should be
    // [0] IMPLICIT OCTET STRING (primitive, 0x80) emitted as
    // constructed (0xa0) because the developer wrote `0xa0 | 0`
    // by hand and didn't think about the CHOICE alternative's
    // primitive-vs-constructed distinction. cms-codec.js provides
    // `_writeImplicitPrimitive` + `_writeImplicitConstructed`;
    // callers pick by intent and the tag byte is built inside the
    // helper, not at the call site.
    id: "hand-rolled-context-specific-implicit-tag",
    primitive: "_writeImplicitPrimitive(N, value)  OR  _writeImplicitConstructed(N, payload)",
    regex: /\b(?:tagByte|tag)\s*=\s*0x(?:80|a0)\s*\|\s*\(?\s*\w+\s*&\s*0x1f\s*\)?/,
    scanScope: "shop",
    allowlist: [
      // Helpers + asn1-der live here; their internal use of the bit
      // pattern is the source-of-truth implementation.
      "lib/cms-codec.js",
      "lib/asn1-der.js",
    ],
    reason: "Codex flagged cms-codec.js _writeImplicit wrapping a SubjectKeyIdentifier in [0] CONSTRUCTED instead of [0] PRIMITIVE — strict CMS parsers reject the structure. New ASN.1 encoders MUST use the named helpers (_writeImplicitPrimitive / _writeImplicitConstructed) rather than hand-rolling the tag byte, so the primitive-vs-constructed distinction is forced by call-site naming.",
  },
    {
    id: "inline-aggregate-issues",
    primitive: "gateContract.aggregateIssues(issues)",
    regex: /return\s*\{\s*ok:\s*!issues\.some\(function\s*\(i\)\s*\{\s*return\s+i\.severity\s*===\s*["']critical["']\s*\|\|\s*i\.severity\s*===\s*["']high["']/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-* validate paths that build the { ok, issues } result. The 5-line ok-aggregation tail (no critical/high → ok=true) was identical across guards; consolidated.",
  },
    {
    id: "inline-assert-no-char-threats",
    primitive: "codepointClass.assertNoCharThreats(text, opts, errorFactory, codePrefix)",
    regex: /opts\.bidiPolicy\s*===\s*["']reject["'][\s\S]{0,150}?BIDI_RE\.test[\s\S]{0,200}?opts\.nullBytePolicy\s*===\s*["']reject["']/,
    scanScope: "shop",
    allowlist: ["lib/codepoint-class.js"],
    reason: "Extracted across guard-html / guard-svg sanitize entry — every guard's reject-on-character-class threats opens with the same `if (opts.bidiPolicy === 'reject' && BIDI_RE.test(s)) throw; if (opts.nullBytePolicy === 'reject' && s.indexOf(NULL_BYTE) !== -1) throw; if (opts.controlPolicy === 'reject' && C0_CTRL_RE.test(s)) throw;` cascade. Centralized so the reject-policy contract is identical across the family. guard-csv keeps its own inline cell-level reject for opt-name vocabulary reasons (bidiCharPolicy etc.).",
  },
    {
    id: "inline-audit-emit-wrapper",
    primitive: "validateOpts.makeAuditEmitter(audit)",
    // Detect the literal `audit.safeEmit(Object.assign({ action: action },
    // info))` shape inside a try/catch — the boilerplate every primitive
    // previously rolled to wrap the operator-supplied audit handle.
    regex: /audit\.safeEmit\s*\(\s*Object\.assign\s*\(\s*\{\s*action\s*:\s*action\s*\}/,
    scanScope: "shop",
    allowlist: ["lib/validate-opts.js"],
    reason: "Extracted to validateOpts.makeAuditEmitter — closure factory parallel to safeAsync.makeDropCallback. Replaces the per-file `function _emit(action, info) { if (!audit) return; try { ... } catch ... }` boilerplate.",
  },
    {
    id: "inline-audit-shape-validation",
    primitive: "validateOpts.auditShape(audit, label, ErrorClass)",
    regex: /opts\.audit\s*!==\s*undefined\s*&&\s*opts\.audit\s*!==\s*null[\s\S]{0,200}?safeEmit\s*!==\s*["']function["']/,
    scanScope: "shop",
    allowlist: [],
    reason: "Extracted across api-key / cache / notify / permissions / seeders / webhook (signer + verifier) / auth/lockout / middleware/db-role-for / external-db-migrate. The inline shape was identical 10x.",
  },
    {
    id: "inline-bad-input-issue-result",
    primitive: "gateContract.badInputResultIfNotStringOrBuffer(input)",
    regex: /typeof\s+input\s*!==\s*["']string["']\s*&&\s*!Buffer\.isBuffer\(input\)\s*\)\s*\{\s*return\s*\{\s*ok:\s*false,\s*issues:\s*\[\s*\{\s*kind:\s*["']bad-input["']/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-svg / guard-filename validate paths that need raw-Buffer input pre-conversion (svg for SVGZ magic, filename for overlong-UTF-8 byte scan). The bad-input fallback `{ ok: false, issues: [{ kind: bad-input, ... }] }` return shape was identical. Sanitize throw paths (different control-flow) are distinct and stay inline.",
  },
    {
    id: "inline-batch-positive-int-validation",
    primitive: "numericBounds.requireAllPositiveFiniteIntIfPresent(opts, names, labelPrefix, ErrorClass, code)",
    regex: /numericBounds\.requirePositiveFiniteIntIfPresent\([\s\S]{0,300}?numericBounds\.requirePositiveFiniteIntIfPresent\([\s\S]{0,300}?numericBounds\.requirePositiveFiniteIntIfPresent\(/,
    scanScope: "shop",
    allowlist: ["lib/numeric-bounds.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg validate-entry numeric-opt cascades. Three or more consecutive `numericBounds.requirePositiveFiniteIntIfPresent(opts.X, ...)` calls in a row is exactly the shape this batch helper consolidates. Other primitives with 1-2 cap-opts can keep the single-call form; the batch helper kicks in at the 3+ threshold.",
  },
    {
    id: "inline-buffer-byte-equality-loop",
    primitive: "Buffer.compare(a, b) === 0 (for non-crypto byte equality)",
    // Hand-rolled loop walking two buffers byte-by-byte and OR-ing into
    // a diff accumulator. Crypto-equality belongs in timingSafeEqual;
    // non-crypto equality belongs in Buffer.compare.
    regex: /for\s*\([^)]*\)\s*\{[\s\S]{0,150}?\|=\s*\w+\[\w+\]\s*\^\s*\w+\[\w+\]/,
    scanScope: "shop",
    allowlist: [
      // timingSafeEqual implementation legitimately walks both buffers.
      "lib/safe-buffer.js",
      "lib/crypto.js",
    ],
    reason: "Non-crypto byte equality is Buffer.compare(a, b) === 0. ssrf-guard / address-equality call sites migrated. New code must use Buffer.compare or timingSafeEqual; never hand-roll the loop.",
  },
    {
    id: "inline-build-guard-gate-forwarder",
    primitive: "gateContract.buildGuardGate(name, opts, check)",
    regex: /forensicEvidenceStore:\s*opts\.forensicEvidenceStore[\s\S]{0,400}?onAudit:\s*opts\.onAudit/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg gate(opts) factories. Every guard's gate() body forwarded the same ~16-key opts bag (mode / audit / observability / forensicEvidenceStore / cache / hooks / runtime cap / ...) to gateContract.defineGate; centralized so each guard's gate() body is just the check function plus a label.",
  },
    {
    id: "inline-char-strip-policy-cascade",
    primitive: "codepointClass.applyCharStripPolicies(text, opts)",
    regex: /opts\.bidiPolicy\s*===\s*["']strip["'][\s\S]{0,200}?opts\.controlPolicy\s*===\s*["']strip["'][\s\S]{0,200}?opts\.nullBytePolicy/,
    scanScope: "shop",
    allowlist: ["lib/codepoint-class.js"],
    reason: "Extracted across guard-html / guard-svg sanitize paths — the 4-line `if (opts.bidiPolicy === 'strip') s = s.replace(BIDI_RE_G, '')` cascade was identical. guard-csv uses different opt-name vocabulary (bidiCharPolicy / nullByteHandling) so it keeps its inline strip block; that's a single-vendor occurrence, below the duplicate-detector floor.",
  },
    {
    id: "inline-codepoint-class-table",
    primitive: "codepointClass.BIDI_RE / C0_CTRL_RE / ZERO_WIDTH_RE / NULL_RE_G / hex4 / charClass / fromCp",
    regex: /var\s+BIDI_RANGES\s*=\s*\[\s*0x200E[\s\S]{0,500}?function\s+_charClass/,
    scanScope: "shop",
    allowlist: ["lib/codepoint-class.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg. The BIDI_RANGES + C0_CTRL_RANGES + ZERO_WIDTH_RANGES literal tables plus the _hex4 / _charClass / _fromCp helpers plus the `new RegExp(\"[\" + _charClass(...) + \"]\")` regex compilations were identical across 3 guard primitives by design. Centralized so the codepoint catalog has a single source of truth and future guards (filename / archive / mime / ...) consume the shared module instead of re-defining the tables.",
  },
    {
    id: "inline-compliance-posture-lookup",
    primitive: "gateContract.lookupCompliancePosture(name, postures, errorFactory, codePrefix)",
    regex: /if\s*\(!COMPLIANCE_POSTURES\[name\]\)[\s\S]{0,150}?bad-posture[\s\S]{0,200}?Object\.assign\(\{\}\s*,\s*COMPLIANCE_POSTURES\[name\]\)/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg compliancePosture(name) entry points. Identical 5-line `if (!COMPLIANCE_POSTURES[name]) throw; return Object.assign({}, COMPLIANCE_POSTURES[name])` shape consolidated.",
  },
    {
    id: "inline-crlf-string-test",
    primitive: "safeBuffer.hasCrlf(s) / safeBuffer.CRLF_RE",
    regex: /\/\[\\r\\n\]\/\s*\.\s*test\s*\(/,
    scanScope: "shop",
    allowlist: ["lib/safe-buffer.js"],
    reason: "CRLF-injection guards now route through safeBuffer.hasCrlf / safeBuffer.CRLF_RE. The lib/safe-buffer.js definition retains the literal regex.",
  },
    {
    id: "inline-default-resolution-cascade",
    primitive: "validateOpts.applyDefaults(opts, DEFAULTS)",
    // Detect the literal shape `(opts.X === undefined) ? DEFAULTS.X : opts.X`
    // — the cascade every primitive's create() previously ran 5–10 times
    // in a row to layer DEFAULTS over operator opts.
    regex: /\(\s*opts\.\w+\s*===\s*undefined\s*\)\s*\?\s*DEFAULTS\.\w+\s*:\s*opts\.\w+/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // testing.js's runMiddleware uses opts.timeoutMs but
      // DEFAULTS.runMiddlewareTimeoutMs — different key names, single
      // field. applyDefaults requires same-key on both sides; this site
      // legitimately keeps the inline ternary.
      "lib/testing.js",
    ],
    reason: "Extracted to validateOpts.applyDefaults — single helper that resolves opts against DEFAULTS in one call. Replaces 5–10 line cascades.",
  },
    {
    id: "inline-detect-char-threats",
    primitive: "codepointClass.detectCharThreats(text, opts, codePrefix)",
    regex: /var\s+bidiMatch\s*=\s*\w+\.match\(BIDI_RE\)[\s\S]{0,200}?bidi-override[\s\S]{0,300}?nullBytePolicy[\s\S]{0,200}?null-byte/,
    scanScope: "shop",
    allowlist: ["lib/codepoint-class.js"],
    reason: "Extracted across guard-html / guard-svg detection passes — the bidi/null-byte/control-char issue-emit cascade was identical at the head of every _detectIssues. guard-csv keeps its inline form because it uses different opt-name vocabulary (bidiCharPolicy / nullByteHandling) and additionally classifies homoglyphs as a CSV-specific threat.",
  },
    {
    id: "inline-emit-event-wrapper",
    primitive: "observability.safeEvent(name, value, labels) — already wraps event() in try/catch",
    // Detect any function that wraps observability.event in try/catch
    // instead of calling the framework helper. The shape is symmetric
    // across every consumer module that needs hot-path emission with
    // drop-silent semantics — extraction was complete, no allowlist.
    regex: /try\s*\{[\s\S]{0,150}?observability\.event\s*\([^)]*\)\s*;?\s*\}\s*catch/,
    scanScope: "shop",
    allowlist: [],
    reason: "Extracted to observability.safeEvent — drop-silent semantics for hot-path event emission. Any module wrapping observability.event in try/catch should call observability.safeEvent instead.",
  },
    {
    id: "inline-extract-bytes-as-text",
    primitive: "gateContract.extractBytesAsText(ctx)",
    regex: /var\s+bytes\s*=\s*ctx\.bytes\s*;\s*if\s*\(!bytes\)\s*return\s*\{\s*ok:\s*true,\s*action:\s*["']serve["'][\s\S]{0,40}\s*var\s+text\s*=\s*Buffer\.isBuffer\(bytes\)/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html check(ctx) entries. The ctx.bytes → Buffer-or-string → utf8 string normalization with empty-bytes-serve early-return was identical. guard-svg keeps the inline shape because it passes bytes (Buffer) directly to validate() for SVGZ magic-byte detection.",
  },
    {
    id: "inline-flush-timer-scheduler",
    primitive: "safeAsync.makeScheduledFlush(delayMs, flushFn)",
    // The literal `var flushTimer = null;` followed by setTimeout idempotent-schedule shape
    // every batched-write sink previously rolled by hand.
    regex: /var\s+flushTimer\s*=\s*null\s*;[\s\S]{0,300}?if\s*\(\s*flushTimer/,
    scanScope: "shop",
    allowlist: ["lib/safe-async.js"],
    reason: "Extracted to safeAsync.makeScheduledFlush — idempotent setTimeout coalesce-and-flush helper used by every log-stream sink.",
  },
    {
    id: "inline-hex-string-validator",
    primitive: "safeBuffer.isHex(s, expectedLength?) — returns boolean",
    regex: /\/\^\[0-9a-fA-F\]\+\$\/\s*\.\s*test\s*\(/,
    scanScope: "shop",
    allowlist: ["lib/safe-buffer.js"],
    reason: "Hex-string validation is now safeBuffer.isHex / safeBuffer.HEX_RE. The lib/safe-buffer.js definition retains the literal regex.",
  },
    {
    id: "inline-iso8601-millisecond-strip",
    primitive: "time.toIso8601NoMs(date)",
    regex: /\.toISOString\s*\(\s*\)\s*\.\s*replace\s*\(\s*\/\\\.\\d\{3\}Z\$\//,
    scanScope: "shop",
    allowlist: ["lib/time.js"],
    reason: "ISO-8601 millisecond stripping is now time.toIso8601NoMs(). The helper definition in lib/time.js keeps the inline form.",
  },
    {
    id: "inline-issue-validator-entry",
    primitive: "gateContract.runIssueValidator(input, opts, detector)",
    regex: /typeof\s+input\s*===\s*["']string["'][\s\S]{0,80}?Buffer\.isBuffer\(input\)[\s\S]{0,200}?bad-input[\s\S]{0,300}?return\s*\{[\s\S]{0,80}?ok:\s*!issues\.some/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html validate() entry points. The string|Buffer normalization + bad-input fallback + issue-aggregation return shape was identical across guards; centralized into gate-contract. guard-svg keeps its inline form because SVGZ magic-byte detection needs the raw Buffer (utf8 conversion would lose the gzip header).",
  },
    {
    id: "inline-log-via-or-fallback",
    primitive: "log.makeViaOrFallback(operatorLog, fallbackLog)",
    // Detect the literal `if (log && typeof log[level] === "function")
    // { try { log[level](message, fields); } catch ... } return; ...
    // fallback;` shape every log-routing primitive previously rolled
    // by hand. Tokenized: `if ( _ID && typeof _ID [ _ID ] === _STR ) {
    // try { _ID [ _ID ] ( _ID , _ID ) ; } catch`.
    regex: /if\s*\(\s*\w+\s*&&\s*typeof\s+\w+\s*\[\s*\w+\s*\]\s*===\s*["']function["']\s*\)\s*\{\s*try\s*\{\s*\w+\s*\[\s*\w+\s*\]\s*\(/,
    scanScope: "shop",
    allowlist: [
      "lib/log.js",   // definition site of makeViaOrFallback
      // dev.js + pqc-gate.js — module-level _logVia(log, level, ...)
      // helpers that take log per-call. Refactoring would either
      // allocate a fresh closure per invocation (wasteful) or require
      // restructuring the file to thread log through closures.
      // Cluster broken (2 files < n=3 threshold); keep until a
      // refactor that consolidates them is justified.
      "lib/dev.js",
      "lib/pqc-gate.js",
    ],
    reason: "Extracted to log.makeViaOrFallback. Replaces the per-file `_logVia` boilerplate that bundler / error-page rolled by hand around an operator-supplied logger with a per-module fallback.",
  },
    {
    id: "inline-migration-filename-regex",
    primitive: "migrationFiles.MIGRATION_FILE_RE / migrationFiles.isMigrationFileName(name)",
    regex: /\/\^\\\?\(\\d\+\)-\(\[A-Za-z0-9_-\]\+\)\\\.js\$\//,
    scanScope: "shop",
    allowlist: ["lib/migration-files.js"],
    reason: "Migration filename pattern is now migrationFiles.MIGRATION_FILE_RE. The migration-files module owns the literal.",
  },
    {
    id: "inline-numeric-bounds-cascade",
    primitive: "numericBounds.requirePositiveFiniteIntIfPresent / requireNonNegativeFiniteIntIfPresent",
    // Detect the literal `if (opts.X !== undefined) { if (!nb.isYFiniteInt(opts.X)) throw new XError(code, ... + nb.shape(opts.X)); }`
    // shape that every primitive's create() rolled by hand. Tokenized:
    // `! _ID . _ID ( _ID . _ID ) ) { throw new _ID ( _STR , _STR + _ID . _ID ( _ID . _ID )`
    // — the distinctive `+ nb.shape(opts.X)` tail fingerprints it.
    regex: /!\s*\w+\.is\w*FiniteInt\s*\(\s*\w+\.\w+\s*\)[\s\S]{0,200}?\w+\.shape\s*\(\s*\w+\.\w+\s*\)/,
    scanScope: "shop",
    allowlist: [
      "lib/numeric-bounds.js",   // definition site
      // The helper signature is `new errorClass(code, message)`. Sites
      // below use one of: factory call `_err(code, msg)`, raw
      // `new Error(...)`, 3rd-arg `permanent: true`, or a reversed
      // `(message, code)` constructor signature. Refactoring would
      // either drop semantics or flip a public error constructor.
      // Tracked as follow-ups in the agent's report.
      "lib/http-client-cookie-jar.js",
      "lib/mail-bounce.js",
      "lib/migrations.js",
      "lib/object-store/gcs.js",
      "lib/object-store/sigv4.js",
      "lib/parsers/safe-env.js",
      "lib/parsers/safe-toml.js",
      "lib/parsers/safe-yaml.js",
      "lib/pqc-gate.js",
      "lib/queue-local.js",
      "lib/safe-buffer.js",
      "lib/safe-url.js",
    ],
    reason: "Extracted to numericBounds.requirePositiveFiniteIntIfPresent / requireNonNegativeFiniteIntIfPresent. Replaces the per-file `if (opts.X !== undefined) { if (!nb.isYFiniteInt(opts.X)) throw }` cascade with a single call.",
  },
    {
    id: "inline-object-store-http-request",
    primitive: "require('./http-request') (lib/object-store/http-request.js)",
    // Detect the literal `httpClient.request({ method, url, headers, body,
    // idleTimeoutMs, errorClass: ObjectStoreError, allowedProtocols })`
    // shape every protocol backend previously rolled by hand.
    regex: /errorClass\s*:\s*ObjectStoreError\s*,\s*allowedProtocols\s*:/,
    scanScope: "shop",
    allowlist: ["lib/object-store/http-request.js"],
    reason: "Extracted across azure-blob / gcs / sigv4 / http-put. The shared helper threads the same five opts (idleTimeoutMs / maxResponseBytes / errorClass / allowedProtocols / allowInternal) through httpClient.request.",
  },
    {
    id: "inline-observability-shape-validation",
    primitive: "validateOpts.observabilityShape(observability, label, ErrorClass)",
    regex: /opts\.observability\s*!==\s*undefined\s*&&\s*opts\.observability\s*!==\s*null[\s\S]{0,200}?event\s*!==\s*["']function["']/,
    scanScope: "shop",
    allowlist: [],
    reason: "Extracted parallel to auditShape — opts.observability shape validation across i18n / cache / auth.lockout.",
  },
    {
    id: "inline-optional-boolean-validation",
    primitive: "validateOpts.optionalBoolean(value, label, ErrorClass, code?)",
    regex: /opts\.\w+\s*!==\s*undefined\s*&&\s*typeof\s+opts\.\w+\s*!==\s*["']boolean["']/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // http-client.js's configurePool throws raw Error, not a
      // framework-error class. Surfaced earlier in the session as a
      // harmonization candidate. Allowlist until a framework-error
      // class is wired into http-client.
      "lib/http-client.js",
    ],
    reason: "Extracted across api-key / cache / notify / permissions / seeders / webhook / db-role-for. Centralized boolean type-check.",
  },
    {
    id: "inline-optional-finite-non-negative-validation",
    primitive: "validateOpts.optionalFiniteNonNegative(value, label, ErrorClass, code?)",
    // Match either `!_isFiniteNonNegative(opts.X)` or the full inline form
    // `typeof opts.X !== "number" || !isFinite(opts.X) || opts.X < 0`.
    regex: /opts\.\w+\s*!==\s*undefined\s*&&\s*\(\s*typeof\s+opts\.\w+\s*!==\s*["']number["']\s*\|\|\s*!isFinite\s*\(\s*opts\.\w+\s*\)\s*\|\|\s*opts\.\w+\s*<\s*0\s*\)/,
    scanScope: "shop",
    allowlist: ["lib/validate-opts.js"],
    reason: "Extracted across primitives. Centralizes the non-negative-finite numeric check.",
  },
    {
    id: "inline-optional-function-validation",
    primitive: "validateOpts.optionalFunction(value, label, ErrorClass, code?)",
    regex: /opts\.\w+\s*!==\s*undefined\s*&&\s*typeof\s+opts\.\w+\s*!==\s*["']function["']/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // http-client.js uses bare `throw new Error(...)` for several opts —
      // doesn't fit the framework-error class signature optionalFunction
      // requires. Tracked in the cross-module follow-ups list.
      "lib/http-client.js",
      // i18n.js's onMissingKey / notify.js's redact include extra
      // signature context in the message ("(key, locale)" /
      // "returning a redacted message") — not a clean shape match.
      "lib/i18n.js",
      "lib/notify.js",
      // retry.js uses raw TypeError, not framework-error.
      "lib/retry.js",
    ],
    reason: "Extracted across api-key / cache / seeders / webhook / db-role-for / permissions / auth/lockout. Centralized function type-check.",
  },
    {
    id: "inline-optional-non-empty-string-array-validation",
    primitive: "validateOpts.optionalNonEmptyStringArray(value, label, ErrorClass, code?)",
    // Match the four-line cascade `if (opts.X !== undefined) { if
    // (!Array.isArray(opts.X)) throw ... ; for (i...) if (typeof opts.X[i]
    // !== "string" || opts.X[i].length === 0) throw }` — recurring across
    // api-key (scopes), file-upload (allowedFileTypes), seeders (dependsOn),
    // i18n (rtlLanguages / eagerLocales), and others.
    regex: /!\s*Array\.isArray\s*\(\s*\w+\.\w+\s*\)[\s\S]{0,400}?typeof\s+\w+\.\w+\s*\[\s*\w+\s*\]\s*!==\s*["']string["']\s*\|\|\s*\w+\.\w+\s*\[\s*\w+\s*\]\.length\s*===\s*0/,
    scanScope: "shop",
    allowlist: ["lib/validate-opts.js"],
    reason: "Extracted to validateOpts.optionalNonEmptyStringArray. Replaces the per-file `if (X !== undefined) { if (!Array.isArray) throw; for (i) if (typeof !== string || === '') throw }` cascade with one call.",
  },
    {
    id: "inline-optional-non-empty-string-validation",
    primitive: "validateOpts.optionalNonEmptyString(value, label, ErrorClass, code?)",
    // Match the OPTIONAL shape only — `X !== undefined && (typeof X !==
    // "string" || X.length === 0)`. The required form (no undefined
    // guard) is a separate primitive (requireNonEmptyString) below.
    regex: /opts\.\w+\s*!==\s*undefined\s*&&\s*\(?\s*typeof\s+opts\.\w+\s*!==\s*["']string["']\s*\|\|\s*opts\.\w+\.length\s*===\s*0/,
    scanScope: "shop",
    allowlist: ["lib/validate-opts.js"],
    reason: "Centralizes the optional non-empty-string gate for fields that may be omitted but must be a non-empty string when present.",
  },
    {
    id: "inline-optional-object-with-method-validation",
    primitive: "validateOpts.optionalObjectWithMethod(value, method, label, ErrorClass, code?, description?)",
    // Match the literal duck-typed-handle shape: `if (opts.X !== undefined
    // && opts.X !== null) { if (typeof opts.X !== "object" || typeof
    // opts.X.method !== "function") throw }` — recurring across file-upload
    // (permissions.check), notify (queue.enqueue), seeders (db.prepare),
    // webhook (nonceStore.checkAndInsert).
    regex: /\w+\.\w+\s*!==\s*undefined\s*&&\s*\w+\.\w+\s*!==\s*null[\s\S]{0,200}?typeof\s+\w+\.\w+\s*!==\s*["']object["']\s*\|\|\s*typeof\s+\w+\.\w+\.\w+\s*!==\s*["']function["']/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // http-client.jar checks TWO methods (cookieHeaderFor + setFromResponse)
      // — the helper validates a single method, so refactoring would
      // silently drop one of the two checks.
      "lib/http-client.js",
      // mail.dkimSigner uses MailError(code, msg, permanent) — the
      // 3-arg constructor signature drops the permanent flag if routed
      // through validateOpts._throw which calls new errorClass(code, msg).
      "lib/mail.js",
    ],
    reason: "Extracted to validateOpts.optionalObjectWithMethod. Replaces the recurring `if (X !== undefined && X !== null) { if (typeof X !== 'object' || typeof X.method !== 'function') throw }` shape used to validate optional duck-typed handles. Allowlisted sites either check multiple methods or use a 3-arg error constructor that the helper would drop.",
  },
    {
    id: "inline-optional-plain-object-validation",
    primitive: "validateOpts.optionalPlainObject(value, label, ErrorClass, code?, description?)",
    // Match the literal three-line cascade `if (X !== undefined && X !==
    // null) { if (typeof X !== "object" || Array.isArray(X)) throw ... }`
    // — the recurring "optional plain object (not array)" validator
    // shape shared by api-key (metadata), db-declare-view (hashColumns),
    // db-declare-row-policy, static.js (contentSafety).
    regex: /\w+\.\w+\s*!==\s*undefined\s*&&\s*\w+\.\w+\s*!==\s*null[\s\S]{0,200}?typeof\s+\w+\.\w+\s*!==\s*["']object["']\s*\|\|\s*Array\.isArray/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // external-db throws ExternalDbError with a 3rd `permanent: true`
      // arg that the validateOpts._throw factory signature doesn't carry
      // through. Routing through the helper would silently drop the
      // permanence flag (which controls retry classification).
      "lib/external-db.js",
      // protocol-dispatcher constructs the error inline with multi-line
      // formatted message details that don't fit the helper's
      // (label + description) shape.
      "lib/protocol-dispatcher.js",
    ],
    reason: "Extracted to validateOpts.optionalPlainObject. Replaces the recurring `if (X !== undefined && X !== null) { if (typeof X !== 'object' || Array.isArray(X)) throw }` shape used to validate optional plain-object opts. Two sites allowlisted: external-db needs the permanent-flag 3rd arg the helper drops; protocol-dispatcher uses multi-line formatted error messages that don't fit the helper's description slot.",
  },
    {
    id: "inline-optional-positive-finite-validation",
    primitive: "validateOpts.optionalPositiveFinite(value, label, ErrorClass, code?)",
    // Match the literal shape `if (X !== undefined && (typeof X !== "number"
    // || !isFinite(X) || X <= 0))` — the strict positive-finite gate that
    // the optionalPositiveFinite helper bakes in.
    regex: /opts\.\w+\s*!==\s*undefined\s*&&\s*\(\s*typeof\s+opts\.\w+\s*!==\s*["']number["']\s*\|\|\s*!isFinite\s*\(\s*opts\.\w+\s*\)\s*\|\|\s*opts\.\w+\s*<=\s*0\s*\)/,
    scanScope: "shop",
    allowlist: ["lib/validate-opts.js"],
    reason: "Centralizes the > 0 finite-number check. Every primitive that gates on a positive finite numeric (e.g. mfaWindowMs, ttlMs minimums) routes through here.",
  },
    {
    id: "inline-optional-positive-int-validation",
    primitive: "validateOpts.optionalPositiveInt(value, label, ErrorClass, code?)",
    regex: /opts\.\w+\s*!==\s*undefined\s*&&\s*!_isPositiveInt\s*\(\s*opts\.\w+\s*\)/,
    scanScope: "shop",
    allowlist: ["lib/validate-opts.js"],
    reason: "Extracted across api-key / others. Routes through numericChecks.isPositiveInt; the helper bakes in the throw semantics.",
  },
    {
    id: "inline-profile-builder-forwarder",
    primitive: "gateContract.makeProfileBuilder(profiles)",
    regex: /function\s+buildProfile\s*\(opts\)\s*\{\s*return\s+gateContract\.buildProfile\(Object\.assign\(\{\}\s*,\s*opts,\s*\{[\s\S]{0,150}?resolveProfile:\s*function\s*\(name\)\s*\{\s*return\s+PROFILES\[name\]/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg buildProfile(opts) wrappers — every guard exposed a 4-line passthrough that injected the per-guard PROFILES into gateContract.buildProfile's resolveProfile callback. Centralized into a closure factory.",
  },
    {
    id: "inline-redis-client-opts-forwarding",
    primitive: "redisClient.pickClientOpts(cfg, prefix?)",
    // Match the literal 9-key opts construction `{ url, password, username,
    // tls, ca, servername, connectTimeoutMs, commandTimeoutMs,
    // maxReconnectAttempts }` that cache-redis / pubsub-redis / queue-redis
    // / etc. previously each rolled by hand to forward to redisClient.create.
    // Detect via the distinctive triple `connectTimeoutMs ... commandTimeoutMs
    // ... maxReconnectAttempts` appearing within a small window (those three
    // keys uniquely identify a redis-client opts bag — no other framework
    // primitive uses all three together).
    regex: /connectTimeoutMs[\s\S]{0,300}?commandTimeoutMs[\s\S]{0,300}?maxReconnectAttempts/,
    scanScope: "shop",
    allowlist: ["lib/redis-client.js"],
    reason: "Extracted to redisClient.pickClientOpts(cfg, prefix?) — single helper that returns the 9-key opts bag. cache-redis / pubsub-redis / queue-redis route through it. New redis-using primitives must call pickClientOpts; never hand-roll the 9-key forward.",
  },
    {
    id: "inline-require-non-empty-string-validation",
    primitive: "validateOpts.requireNonEmptyString(value, label, ErrorClass, code?)",
    // Match the REQUIRED shape — `if (typeof X !== "string" ||
    // X.length === 0) throw` at the top of a validation block. The
    // regex also matches inner if-blocks nested inside outer `X !==
    // undefined &&` guards (compound-optional shape) — those sites are
    // allowlisted below because the helper doesn't compose with the
    // adjacent _validateIdent / format check.
    regex: /\bif\s*\(\s*typeof\s+opts\.\w+\s*!==\s*["']string["']\s*\|\|\s*opts\.\w+\.length\s*===\s*0\s*\)/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // Compound validators — type-check + _validateIdent / format
      // check / URL example combined. Splitting the type check out
      // would scatter validation across two helpers and lose
      // operator-readable error messages.
      "lib/backup/bundle.js",                    // line 92 — operator-meaningful "(use vault.getKeysJson() ...)" hint
      "lib/cache.js",                            // line 192 — backend === "redis" precondition + URL example
      "lib/cli-helpers.js",                      // raw Error (no framework class)
      "lib/db-declare-row-policy.js",            // optional + _validateIdent compound
      "lib/db-declare-view.js",                  // optional + _validateIdent compound
      "lib/middleware/csp-nonce.js",             // optional-with-default + operator hint
      "lib/middleware/db-role-for.js",           // optional + _validateRoleIdentifier compound
      "lib/middleware/nel.js",                   // operator-readable "collectorUrl is required" prose tested by /collectorUrl is required/ regex; validateOpts emits "validate-opts/missing-non-empty-string" instead
      "lib/protocol-dispatcher.js",              // optional fallbackProtocol guard
      "lib/pubsub-redis.js",                     // raw Error (no framework class)
      "lib/restore-rollback.js",                 // compound: derives rollbackRoot from opts.dataDir
      // permanent: true 3rd-arg sites — helper signature doesn't
      // expose the permanent flag. Refactoring would silently drop it.
      "lib/migrations.js",
      "lib/queue-redis.js",
      "lib/queue-sqs.js",
    ],
    reason: "Required non-empty-string fields. Most primitives' create() functions start with this shape for opts.namespace / opts.dir / opts.url / opts.region / etc. Centralizes the throw + message format. 13 sites allowlisted with documented per-site reasons (compound validators, raw Error, permanent-arg, operator-meaningful extra context).",
  },
    {
    id: "inline-require-object-prelude",
    primitive: "validateOpts.requireObject(opts, label, ErrorClass)",
    regex: /if\s*\(\s*!opts\s*\|\|\s*typeof\s+opts\s*!==\s*["']object["']\s*\)\s*\{[\s\S]{0,200}?opts\s+must\s+be\s+an\s+object/,
    scanScope: "shop",
    allowlist: [
      "lib/validate-opts.js",
      // The three call sites below pass `permanent: true` as the 3rd
      // arg to `_err(code, msg, permanent)`. validateOpts.requireObject
      // doesn't expose that arg — refactoring would silently drop the
      // permanence flag (which controls retry classification). Keep
      // these inline until requireObject grows opts.permanent or these
      // sites move to an alwaysPermanent error class.
      "lib/external-db.js",
      "lib/http-client.js",
      "lib/object-store/sigv4-bucket-ops.js",
    ],
    reason: "Extracted across api-key / cache / i18n / notify / permissions / seeders / webhook. Files with custom error codes or divergent messages (break-glass / config / deprecate / etc.) keep their bespoke shape — those preludes use module-namespaced codes that don't fit the generic helper.",
  },
    {
    id: "inline-resolve-profile-and-posture",
    primitive: "gateContract.resolveProfileAndPosture(opts, { profiles, compliancePostures, defaults, errorClass, errCodePrefix })",
    regex: /typeof\s+opts\.profile\s*===\s*["']string["'][\s\S]{0,300}?compliancePosture[\s\S]{0,300}?Object\.assign\(\{\}\s*,\s*[A-Z]+/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg. Every guard primitive's _resolveOpts opens with the identical `if (opts.profile) overlay = PROFILES[opts.profile]; if (opts.compliancePosture) overlay = Object.assign(overlay, COMPLIANCE_POSTURES[...]); return Object.assign({}, DEFAULTS, overlay, opts);` cascade. Centralized in gateContract so future guards consume the shared resolver — keeps the family resolution shape identical across members.",
  },
    {
    id: "inline-rule-pack-loader",
    primitive: "gateContract.makeRulePackLoader(errorClass, codePrefix)",
    regex: /var\s+_\w*[Rr]ulePacks?\s*=\s*\{\}[\s\S]{0,80}function\s+loadRulePack\s*\(\s*pack\s*\)\s*\{[\s\S]{0,200}?validateOpts\.requireObject[\s\S]{0,200}?validateOpts\.requireNonEmptyString[\s\S]{0,100}?_\w*[Rr]ulePacks?\[pack\.id\]\s*=\s*pack/,
    scanScope: "shop",
    allowlist: ["lib/gate-contract.js"],
    reason: "Extracted across guard-csv / guard-html / guard-svg loadRulePack(pack) entry. Identical scaffolding (closed-over store + validateOpts cascade + pack.id keyed insert) consolidated into a closure factory.",
  },
    {
    id: "inline-sql-identifier-regex",
    primitive: "safeSql.DEFAULT_IDENTIFIER_RE / safeSql.MAX_IDENTIFIER_LENGTH",
    regex: /\/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*\$\//,
    scanScope: "shop",
    allowlist: ["lib/safe-sql.js"],
    reason: "SQL identifier validation is now safeSql.DEFAULT_IDENTIFIER_RE. The lib/safe-sql.js definition keeps the literal.",
  },
    {
    id: "inline-trailing-hspace-strip",
    primitive: "safeBuffer.stripTrailingHspace(s) / safeBuffer.TRAILING_HSPACE_RE",
    regex: /\.replace\s*\(\s*\/\[\s\\t\]\+\$\/\s*,/,
    scanScope: "shop",
    allowlist: ["lib/safe-buffer.js"],
    reason: "Trailing horizontal-whitespace strip is now safeBuffer.stripTrailingHspace. The lib/safe-buffer.js definition keeps the literal regex.",
  },
    {
    id: "mailstore-quota-wrong-field",
    primitive: "b.mailStore.quota returns capBytes (not limitBytes)",
    regex: /\bq\.limitBytes\b|\bquota\.limitBytes\b/,
    scanScope: "shop",
    allowlist: [],
    reason: "mailStore.quota returns { usedBytes, usedCount, capBytes, capCount }. Reading q.limitBytes / quota.limitBytes is undefined and silently bypasses the over-quota check. Use q.capBytes.",
  },
    {
    id: "mailstore-quota-wrong-signature",
    primitive: "b.mailStore.quota(folderName) — single-string-arg + reads capBytes/usedBytes",
    // mailStore.quota(folderName) returns
    // { usedBytes, usedCount, capBytes, capCount }. Two-arg call shapes
    // (e.g. mailStore.quota(actor, folderName)) pass the actor as the
    // folder key and throw mail-store/no-folder. Reading q.limitBytes is
    // wrong (the field is capBytes); the over-quota check never trips.
    regex: /mailStore\.quota\s*\([^)]*,/,
    scanScope: "shop",
    allowlist: [],
    reason: "mailStore.quota takes a single folderName argument; the return shape is { usedBytes, usedCount, capBytes, capCount }. A two-arg call (actor, folder) passes the actor object as the folder key and throws mail-store/no-folder, breaking IMAP APPEND for valid writes. Read q.capBytes (not q.limitBytes — undefined, so the over-quota gate would never fire).",
  },
    {
    // v0.11.3 audit found: the existing `map-has-then-set-pre-node-26`
    // detector catches the literal `if (!M.has(k))` shape but misses
    // the semantically-identical `if (!M.get(k))` and `if (M.get(k)
    // === undefined)` variants — same race window, same bug class,
    // same Node-26 getOrInsertComputed migration target. This entry
    // closes those variants.
    id: "map-get-falsy-then-set-pre-node-26",
    primitive: "Node 26 `Map.prototype.getOrInsertComputed(key, factory)` collapses falsy-check + insert into one atomic call",
    regex: /if\s*\(\s*(?:!\s*\w+\.get\s*\([^)]+\)|\w+\.get\s*\([^)]+\)\s*===\s*(?:undefined|null))\s*\)\s*\{[\s\S]{0,300}?\.set\s*\(/,
    scanScope: "shop",
    skipCommentLines: true,
    allowlist: [],
    reason: "Companion to map-has-then-set-pre-node-26 — same Node 26 getOrInsertComputed migration target, captures the `!M.get(k)` / `M.get(k) === undefined|null` syntactic variants. v0.11.3 audit identified the original map-has-then-set detector as bypassable by switching `.has(k)` to `.get(k)` falsy-check; this entry closes that gap.",
  },
    {
    // v0.11.6 — direct `/proc/self/mountinfo` reads in lib/ MUST route
    // through `b.safeMountInfo` instead. The primitive centralizes the
    // field-4 ("root within source FS") parse discipline that the
    // existing `mountinfo-options-bind-check` detector exists to
    // protect — without "must compose" enforcement a new caller can
    // re-derive the parse inline and re-introduce the wrong-field bug.
    id: "mountinfo-not-via-safemountinfo",
    primitive: "b.safeMountInfo.read() / .bestMatch() / .isBindMount() — composes the canonical field-4 parser + bind-mount predicate; raw `nodeFs.readFileSync(\"/proc/self/mountinfo\", ...)` in lib/ bypasses the discipline",
    regex: /\b(?:fs|nodeFs)\.readFile(?:Sync)?\s*\(\s*["']\/proc\/self\/mountinfo["']/,
    scanScope: "shop",
    skipCommentLines: true,
    allowlist: [
      // The primitive itself — canonical reader.
      "lib/safe-mount-info.js",
    ],
    reason: "v0.11.6 — `b.safeMountInfo` centralizes the field-4 parse discipline. Bind-mount detection MUST consult field 4 ('root within source FS'); ad-hoc parsers that scan options for the word 'bind' miss the truth (kernel doesn't emit 'bind' as an option). Direct `/proc/self/mountinfo` reads in new lib/ code bypass the primitive and risk re-deriving the wrong-field parse.",
  },
    {
    id: "mountinfo-options-bind-check",
    primitive: "parse /proc/self/mountinfo field 4 (root within source FS) and check != \"/\" for bind detection",
    regex: /mountinfo[\s\S]{0,800}?options[\s\S]{0,80}?indexOf\(["']bind["']\)/,
    scanScope: "shop",
    allowlist: [],
    reason: "Per Documentation/filesystems/proc.rst §3.5, /proc/self/mountinfo field 6 (mount options) does NOT carry a 'bind' tag — the kernel exposes bind-mount provenance via field 4 ('root within source filesystem'), which is '/' for a regular mount and the bound source path for a bind mount. Checking the options field for 'bind' never fires for actual bind mounts and silently misses the failure mode it claims to defend. Detector catches the mis-parse shape at n=1.",
  },
    {
    // Codex P1 on v0.12.6 PR #157 — `_anyValueToProto`'s negative-int
    // path emitted `pb.embeddedMessage(N, pb._writeVarint(v >>> 0))`
    // which (a) wraps a varint payload in wire-type 2 (length-delimited)
    // instead of wire-type 0 (varint, which int64 mandates per the
    // proto3 spec), AND (b) truncates negatives via `v >>> 0` losing
    // both sign and magnitude beyond 32 bits. Collectors reject the
    // whole batch when they decode a wire-type mismatch on a known
    // scalar field, so a single negative AnyValue poisons the export.
    //
    // The right shape is `pb.int64(field, value)` (10-byte two's-
    // complement varint for negatives via BigInt) or `pb.sint64` (ZigZag
    // when small negatives dominate). The detector flags the
    // `embeddedMessage(N, ..._writeVarint...)` shape that mixes
    // wire types — wrapping a raw varint in a length-delimited message
    // is almost always a bug. Operators legitimately wrapping
    // `_writeVarint` bytes inside `embeddedMessage` for a packed-repeated
    // field MUST allowlist with a written reason.
    id: "protobuf-embeddedmessage-wrapping-varint",
    primitive: "Use `pb.uint64` / `pb.int64` / `pb.sint64` / `pb.uint32` for scalar varint fields; `embeddedMessage` is for nested message bodies, not raw varints. Mixing wire types causes collectors to reject the whole payload.",
    regex: /pb\.embeddedMessage\s*\([^)]*pb\._writeVarint/,
    scanScope: "shop",
    skipCommentLines: true,
    allowlist: [],
    reason: "Codex P1 on v0.12.6 PR #157 — `_anyValueToProto` negative-int path wrapped a varint payload in `embeddedMessage` (wire-type 2) instead of using `int64` (wire-type 0 varint). The wire-type mismatch poisons the whole OTLP batch; the `v >>> 0` truncation also dropped sign + high bits. Fixed by adding `pb.int64` + `pb.sint64` to the encoder + routing the negative-int branch through `pb.int64`. Detector locks the shape: `embeddedMessage(N, _writeVarint(...))` cannot recur.",
  },
    {
    // Codex P1 on v0.11.23 PR #127 — `b.mailStore.create(...).hardExpunge`
    // looped over the input objectids array per-element and ran a
    // `stmtDecrementQuota` inside the loop, so `hardExpunge(folder, [id, id])`
    // double-decremented the per-folder quota even though only one
    // message physically existed. The fix dedupes the input array
    // before the loop. The general bug class — accumulator update
    // inside a loop over operator-supplied ids without dedup — is
    // broader: any sum / count / quota / counter that decrements
    // (or increments) once per loop iteration over an operator-
    // supplied id array MUST dedupe first or the operator can drive
    // the counter past zero / cause double-counting of work.
    id: "quota-decrement-loop-over-ids-without-dedup",
    primitive: "deduplicate operator-supplied id arrays before the per-id accumulator update — `var seen = Object.create(null); var unique = []; for (...) if (!seen[id]) { seen[id] = true; unique.push(id); }` OR `Array.from(new Set(ids))`",
    // Match any file that calls a `stmtDecrement*` / `stmtBumpQuota`
    // / `stmtDecrementBytes` shape inside a per-id loop. The
    // companion check requires a dedup primitive (Object.create(null)
    // + .push to a uniqueIds array, OR `new Set(`) in the same file.
    regex: /stmt(?:Decrement|Bump)(?:Quota|Bytes|Count)/,
    scanScope: "shop",
    requires: /Object\.create\(\s*null\s*\)|new\s+Set\s*\(|uniqueIds|seenIds/,
    skipCommentLines: true,
    allowlist: [],
    reason: "Codex P1 on v0.11.23 PR #127 — `hardExpunge` per-id loop ran a quota decrement against each iteration regardless of duplicates. Calling with `[id, id]` drove `usedBytes` / `usedCount` negative + duplicated the deleted-id list. Bug class: accumulator-update-inside-loop-over-operator-supplied-ids. Detector flags any file that touches `stmtDecrement(Quota|Bytes|Count)` or `stmtBump(Quota|Bytes|Count)` and requires a dedup primitive (`Object.create(null)` + `uniqueIds.push` OR `new Set(`) in the same file. Per-primitive behavioral regression tests (mail-agent.test.js's `[id, id, id]` triple-input case) are the per-call-site guard.",
  },
    {
    id: "sbom-subcomponent-version-inherits-parent",
    primitive: "Sub-component SBOM entries must use their own upstream version, not entry.version",
    // For a meta-bundle whose parent version is a composite tag like
    // `2.0.0+pkijs-3.4.0`, forcing every child component to inherit
    // entry.version makes CVE matchers key off the meta tag instead
    // of the real upstream version, producing false negatives on
    // children. The accepted form is `entry.components[subName]` as
    // either a `{ url, version }` object OR a bare string (legacy
    // form; falls back to parent version). Direct assignment of
    // `version: entry.version` inside the sub-component build
    // without a sub-version lookup is the bug shape.
    regex: /\bversion:\s*entry\.version,?\s*\n\s+license:\s*entry\.license/,
    scanScope: "shop",
    allowlist: [],
    reason: "sub-component SBOM expansion must respect operator-supplied per-sub-component versions when present. The schema accepts `entry.components[subName]` as `{ url, version }` (preferred) or bare string (legacy; falls back to parent). A direct `version: entry.version` inside the sub-component build path skips the lookup and emits a parent-version-shadowed child that CVE matchers can't key off.",
  },
    {
    id: "sbom-toplevel-ref-by-slash-heuristic",
    primitive: "Derive top-level SBOM refs by exclusion from _childRefs, not by substring on '/' in the bom-ref",
    // Scoped npm package names like `@peculiar/x509` contain a `/`
    // in their bom-ref, so a heuristic that filters bom-refs on
    // indexOf("/") === -1 (with or without an `^@` escape hatch)
    // misclassifies the next scoped sub-component naming scheme to
    // arrive. The correct derivation is exclusion from _childRefs
    // (anything that doesn't appear as a child in _subDeps is a
    // top-level ref).
    regex: /\.filter\s*\(\s*function\s*\([^)]*\)\s*\{\s*return\s+c\["bom-ref"\]\.indexOf\("\/"\)/,
    scanScope: "shop",
    allowlist: [],
    reason: "Top-level SBOM bom-refs should be derived by exclusion from _childRefs (any ref not appearing as a child in _subDeps is top-level). The substring heuristic on '/' breaks for scoped npm packages and any future namespacing scheme.",
  },
    {
    id: "starttls-listener-remove-missing",
    primitive: "Use b.mail.server.tls.upgradeSocket which calls removeAllListeners(\"data\") on the plain socket",
    // CVE-2021-33515 / CVE-2021-38371. New listener files that import nodeTls AND construct a TLSSocket
    // anywhere AND do not call mailServerTls (the helper composition) trip this at n=1. Simple regex —
    // matches `new nodeTls.TLSSocket(` without requiring lookbehind.
    regex: /new\s+nodeTls\.TLSSocket\s*\(\s*rawSocket\b/,
    scanScope: "shop",
    allowlist: [
      // Submission listener's implicit-TLS path (port 465) wraps the FIRST byte on the wire — no
      // plaintext predecessor, so listener removal is moot.
      "lib/mail-server-submission.js",
    ],
    reason: "STARTTLS / STLS upgrade — only the upgradeSocket helper is allowed to wrap a TLSSocket around a previously-attached plain socket. The implicit-TLS variant on port 465 wraps the rawSocket BEFORE any plain bytes are read (no listener to remove), so it stays allowlisted.",
  },
    {
    id: "starttls-tlssocket-construct-direct",
    primitive: "b.mail.server.tls.upgradeSocket({ plainSocket, secureContext, onSecure, onData, onError })",
    // CVE-2021-33515 / CVE-2021-38371 class: direct `new nodeTls.TLSSocket(<socket>` construction in a
    // mail-server listener bypasses the shared upgrade helper. The helper strips the plain-socket "data"
    // listener (smuggling defense), pauses, and wires the new TLSSocket. New mail-server-* listeners that
    // construct TLSSocket directly trip this detector at n=1.
    regex: /new\s+nodeTls\.TLSSocket\s*\(\s*socket\b/,
    scanScope: "shop",
    allowlist: [
      // upgradeSocket helper itself constructs the TLSSocket; listener removal happens INSIDE it.
      "lib/mail-server-tls.js",
    ],
    reason: "STARTTLS / STLS upgrade across MX / submission / IMAP / POP3 listeners. CVE-2021-33515 (Dovecot) + CVE-2021-38371 (Exim) — plaintext bytes pipelined ahead of the handshake reach the post-TLS dispatcher when the plain socket's 'data' listener is not stripped before TLSSocket wraps. Centralized in mail-server-tls.upgradeSocket which removes the listener + pauses the socket + wraps + re-arms idle timeout + wires onSecure / onData / onError. New listeners route through the helper.",
  },
    {
    // N3 (v0.10.14) — tests creating a real DB handle without an
    // isolation primitive. Any test file calling `b.db.create(` MUST
    // also name one of: `setupTestDb` / `setupVaultOnly` (framework
    // helpers) or `mkdtempSync` (ad-hoc per-test temp dataDir).
    // Leaked per-test SQLite state corrupts subsequent tests under
    // SMOKE_PARALLEL=64.
    id: "test-creates-db-handle-without-isolation",
    primitive: "helpers.setupTestDb / helpers.setupVaultOnly / mkdtempSync — every test that spins up a real DB handle MUST wire one of these isolation primitives so SQLite state stays per-test",
    scanScope: "test",
    regex: /\bb\.db\.create\s*\(/,
    requires: /\b(?:setupTestDb|setupVaultOnly|mkdtempSync)\b/,
    allowlist: [
      "test/helpers/db.js",
      "test/helpers/index.js",
    ],
    reason: "Tests spinning a real DB handle without a per-test isolation primitive leak SQLite state to a shared directory; subsequent tests see prior rows under SMOKE_PARALLEL=64. Static-API tests that reference b.db.applyPosture() / b.db.declareView() without spinning a real handle don't trip the detector. Use helpers.setupTestDb / helpers.setupVaultOnly, or mkdtempSync the dataDir.",
  },
    {
    // v0.11.13 — `fs.watchFile` / `fs.watch` MUST NOT be called
    // directly from tests. The framework exposes `b.watcher`
    // (kernel-event based) and `b.vault.sealPemFile` (poll-based) as
    // the operator-facing watchers; tests of those primitives compose
    // `helpers.backdateFile` + `helpers.waitForWatcher` to absorb the
    // first-poll race + the macOS FSEvents prime latency. Direct
    // `fs.watch*` in tests re-discovers the same race class.
    id: "test-fs-watch-direct-call",
    primitive: "helpers.backdateFile(path) + helpers.waitForWatcher(predicate) — compose the framework's watcher primitives in tests instead of calling fs.watch / fs.watchFile directly",
    scanScope: "test",
    regex: /\bfs\s*\.\s*watch(?:File)?\s*\(/,
    allowlist: [
      "test/helpers/fs-watch.js",
    ],
    reason: "v0.11.13 — `helpers.backdateFile` + `helpers.waitForWatcher` centralize the discipline for fs.watch / fs.watchFile-driven tests (backdate the source pre-watcher so the first poll's baseline is older than any subsequent mutation; widen the wait budget to 15s for CI-runner cadence drift). Direct `fs.watch*` calls in tests re-discover the race class — multiple historical flakes (vault-seal-pem-file + watcher) were the same bug shape.",
  },
    {
    // v0.11.13 — tests that set a future mtime via fs.utimesSync MUST
    // also call helpers.backdateFile on the source. The future-mtime
    // idiom assumes the watcher has already recorded an OLDER
    // baseline mtime to compare against. Without backdating, the
    // watcher's first poll can record the future-mtime as `prev` and
    // miss the transition entirely.
    id: "test-future-utimes-without-backdated-baseline",
    primitive: "helpers.backdateFile(source) before writing future-mtime via fs.utimesSync(...) so the watcher's baseline is unambiguously older than the post-mutation mtime",
    scanScope: "test",
    regex: /\bfs\s*\.\s*utimesSync\s*\([^,]+,\s*new\s+Date\s*\(\s*Date\s*\.\s*now\s*\(\s*\)\s*\+/,
    requires: /\bbackdateFile\s*\(/,
    allowlist: [
      "test/helpers/fs-watch.js",
    ],
    reason: "v0.11.13 — every recurring flake in the fs.watch test class (vault-seal-pem-file + watcher) shared the same root cause: the test wrote a file with a future mtime expecting the watcher's first poll to detect the change, but the first poll could land AFTER the mutation under runner contention. helpers.backdateFile establishes an unambiguously-older baseline; pairing it with future-mtime writes makes the watcher's transition detection deterministic.",
  },
    {
    // N2 (v0.10.14) — hardcoded non-zero server bind ports race under
    // SMOKE_PARALLEL=64 when two parallel tests pick the same value.
    // Convention: `.listen(0)` then `server.address().port` to read
    // the OS-assigned ephemeral port. Read-only protocol-constant
    // references (autoconfig XML port: 993 / 587, mock-server config
    // port: 1025) don't trip this detector — only `.listen()` with a
    // literal non-zero port does.
    id: "test-hardcoded-server-bind-port",
    primitive: ".listen(0) + server.address().port  (let the OS assign an ephemeral port; read it after bind)",
    scanScope: "test",
    regex: /\.listen\s*\(\s*(?:\{[^}]*port\s*:\s*)?(?!0\b)\d{2,5}\b/,
    allowlist: [],
    reason: "Hardcoded bind ports race under SMOKE_PARALLEL=64 when two parallel tests pick the same value. Convention: .listen(0) + server.address().port. Read-only protocol-constant references (autoconfig XML port: 993 / 587, mock-server config port: 1025) don't trip this detector — only .listen() with a literal non-zero port does.",
  },
    {
    // v0.10.13 PR #102 macOS hang — stream-throttle.test.js used
    // `setTimeout`-based rate enforcement plus `node:stream.pipeline`
    // and hung the macOS GitHub Actions runner for >2h on two
    // separate commit SHAs of the same branch. Identical runs on the
    // same SHA succeeded in 15 min. The hang's symptom is opaque on
    // a remote runner (no partial logs surface until completion), so
    // the only diagnostic is a per-test wall-clock ceiling.
    id: "test-uses-stream-pipeline-without-withtesttimeout",
    primitive: "wrap stream.pipeline-using test bodies with helpers.withTestTimeout(label, async function () { ... })",
    scanScope: "test",
    regex: /\b(?:stream\.pipeline|nodeStream\.pipeline|streamPipeline)\s*\(/,
    requires: /\bwithTestTimeout\b/,
    allowlist: [
      "test/helpers/index.js",
    ],
    reason: "Real-time-dependent tests using node:stream.pipeline without a per-test wall-clock ceiling can hang the smoke runner for the full GH Actions 6h timeout — see the v0.10.13 PR #102 macOS hang on stream-throttle's setTimeout-based rate test. New tests using stream.pipeline MUST import `withTestTimeout` from `test/helpers` and wrap each test body so a hang surfaces as `test timed out: <label>` in seconds instead of an opaque stuck job.",
  },
    {
    // P2 Codex 2026-05-19 on PR #105 — verifyAll() in mail-crypto-smime
    // looped a single-signer verify() helper per signer, but verify()
    // always parsed sd.signerInfos[0]; the second signer's key got
    // tested against the first signer's signature. The detector flags
    // a `for (... signerInfos ...)` loop body that calls a sibling
    // `verify({` (with object opts arg) — the helper that takes the
    // SignerInfo as an explicit positional argument is allowed.
    id: "verifyall-loop-calls-single-signer-verify-helper",
    primitive: "A per-collection-item verify/process loop must call a helper that takes the item as a POSITIONAL argument (`_verifyOne(item, ...)`) — calling the top-level single-item entry point with an opts object inside the loop body re-parses the parent envelope and silently always processes index 0",
    // Catches any `for (... of <collection>) { ... <name>({` shape
    // where the call inside the loop body looks like a top-level
    // entry point (function called with `({` opts-object first arg).
    // The fix in mail-crypto-smime extracted `_verifySignerInfo(si, ...)`
    // which takes the item positionally — that doesn't match the regex.
    regex: /for\s*\(\s*var\s+\w+\s*=\s*0[^)]*\.(?:signerInfos|signers|recipients|items|entries)\.length[^)]*\)\s*\{[\s\S]{0,600}?\bverify\s*\(\s*\{/,
    scanScope: "shop",
    allowlist: [
      // mail-crypto-smime.js verifyAll was fixed v0.11.0 to call
      // _verifySignerInfo(si, ...) (positional `si`), not
      // verify({ signature: ..., signerPublicKey: ... }) which
      // re-parses the same SignedData and only checks signerInfos[0].
    ],
    reason: "CLASS DETECTOR. The bug shape is: a loop iterating a parent's child collection (signerInfos / signers / recipients / items / entries) where the loop body calls a top-level entry point with an opts-object argument, instead of a per-item helper that takes the loop variable. The top-level entry point typically re-parses the parent envelope from raw bytes and always processes index 0 — masking the second-and-onward items. Codex flagged this on smime.verifyAll v0.11.0 (P2). Per-item helpers must accept the loop variable as a positional argument.",
  },

  // ---- Catalog mirror — second pass ----
  // Seven detectors held back from the v0.0.113 bulk port because
  // the splice tool didn't roundtrip their regex literals or runner
  // features (basename match, requires-companion). Hand-ported.

  {
    id:        "archive-wrap-recipient-missing-ec-half",
    primitive: "static-key recipients for b.archive.wrap / bundleAdapterStorage `recipient:` opt MUST carry BOTH publicKey (ML-KEM-1024 PEM) AND ecPublicKey (P-384 ECDH PEM). Partial recipients trip b.crypto.encrypt's ML-KEM-only fallback which silently degrades the hybrid defense-in-depth contract this surface promises.",
    scanScope: "shop",
    regex:     /recipient:\s*\{\s*[^}]*publicKey:/,
    requires:  /ecPublicKey|allow:archive-wrap-partial-recipient/,
    allowlist: [],
    reason:    "Codex P2 on v0.12.10 PR #161 — archive-wrap's recipient contract is hybrid PQC by design. Partial recipient objects degrade to KEM-only with only a one-shot audit. Locks the static-side gate so library code composing wrap/unwrap can't silently drop the ECDH leg. Ported from blamejs's catalog.",
  },

  {
    id:        "inline-sql-transaction-wrapper",
    primitive: "dbSchema.runInTransaction(db, fn, opts?) — the BEGIN / COMMIT / ROLLBACK try/catch boilerplate every SQL-touching primitive previously rolled by hand",
    scanScope: "shop",
    regex:     /"BEGIN"[\s\S]{0,400}?"COMMIT"[\s\S]{0,200}?\}\s*catch[\s\S]{0,300}?"ROLLBACK"/,
    multiline: true,
    allowlist: [],
    reason:    "Extracted to dbSchema.runInTransaction. Replaces the inline BEGIN / COMMIT / ROLLBACK try/catch boilerplate in migrations / seeders / db-schema. Handles both raw better-sqlite3 and b.db framework wrapper handles via runSqlOnHandle. Ported from blamejs's catalog.",
  },

  {
    id:        "map-get-or-insert-pre-node-26",
    primitive: "Map.prototype.getOrInsertComputed(key, factory) (Node 26+); pre-floor-bump call sites are allowlisted with a documented migration target",
    scanScope: "shop",
    regex:     /var\s+\w+\s*=\s*\w+\.get\s*\([^;]+\)\s*;\s*\n\s*if\s*\(\s*!\s*\w+\s*\)\s*\{[\s\S]{0,300}?\.set\s*\(/,
    multiline: true,
    allowlist: [],
    reason:    "Node 26 ships Map.prototype.getOrInsertComputed(key, factory) — a single-lookup get-or-insert that replaces the two-step `var v = m.get(k); if (!v) { v = factory(); m.set(k, v); }` pattern. Variant A (with `var X = M.get(k)` binding). The sweep is deferred to the Node 26 floor-bump (eligible Oct 2026); engines.node is `>=24` today. New code post-this-patch trips the detector. Ported from blamejs's catalog.",
  },

  {
    id:        "map-has-then-set-pre-node-26",
    primitive: "Map.prototype.getOrInsertComputed(key, factory) (Node 26+); pre-floor-bump call sites are allowlisted with a documented migration target",
    scanScope: "shop",
    regex:     /if\s*\(\s*!\s*\w+\.has\s*\([^)]+\)\s*\)\s*\{[\s\S]{0,300}?\.set\s*\(/,
    multiline: true,
    allowlist: [],
    reason:    "Companion to map-get-or-insert-pre-node-26 — same Node 26 getOrInsertComputed migration target, captures the `if (!M.has(k)) { ... M.set(k, ...) ... }` syntactic variant. Ported from blamejs's catalog.",
  },

  {
    id:        "pqc-algid-with-null-params",
    primitive: "ABSENT_PARAM_OIDS.has(oid) ? writeNode(SEQUENCE, writeOid(oid)) : writeNode(SEQUENCE, [writeOid(oid), writeNull()])",
    scanScope: "shop",
    regex:     /writeOid\(\s*["']2\.16\.840\.1\.101\.3\.4\.(?:3\.(?:17|18|19|31)|4\.[23])["']\s*\)[\s\S]{0,160}?writeNull\s*\(\s*\)/,
    multiline: true,
    allowlist: [],
    reason:    "Codex P1 on v0.10.13 PR #102 — PQC AlgorithmIdentifier with NULL parameters. ML-DSA (RFC 9909 §3), SLH-DSA (RFC 9881 §3), and ML-KEM (RFC 9936 §3) all specify that the AlgorithmIdentifier's parameters field is ABSENT. Appending `NULL` makes the CMS (or X.509) structure non-conformant — strict validators reject the signature/recipient. Ported from blamejs's catalog.",
  },

  {
    id:        "release-named-test-file",
    primitive: "split into per-domain test files (one primitive → one test file; share helpers under test/helpers/)",
    scanScope: "test",
    matchOn:   "basename",
    regex:     /^(?:v\d+[-_.]\d+[-_.]\d+(?:[-_.]|$)|slot[-_]\d+|(?:[^/]*[-_])?batch[-_.])/i,
    allowlist: [],
    reason:    "v0.10.14 — release-named test files (v0-8-41-additions.test.js / slot-19-enhancements.test.js / batch-N.test.js) conflate scope across unrelated primitives, break per-file isolation under SMOKE_PARALLEL=64, and rot the moment the release ships. Tests must live in per-domain files. Ported from blamejs's catalog.",
  },

  {
    id:        "safedecompress-omits-max-compressed-bytes",
    primitive: "safeDecompress({ maxOutputBytes, maxCompressedBytes: <operator bound>, ... }) — align both caps with the caller's intent; never rely on the 4 MiB default when maxOutputBytes is operator-configurable",
    scanScope: "shop",
    regex:     /safeDecompress\s*\([\s\S]{0,300}?maxOutputBytes\s*:/,
    multiline: true,
    requires:  /\bmaxCompressedBytes\b/,
    allowlist: [],
    reason:    "Codex P1 on v0.11.5 PR #110 — websocket _inflateMessage routed through safeDecompress without maxCompressedBytes; operators with maxMessageBytes > 4 MiB saw legitimate large permessage-deflate traffic refused at the input cap before decompression. Detector requires every safeDecompress call to ALSO name maxCompressedBytes (companion-check) so future call sites inherit the alignment discipline. Ported from blamejs's catalog.",
  },

  // ---- admin error-state hardening (lib/admin.js + outbound webhooks) -----

  {
    // A handler that JSON.parses an operator-supplied request-body field
    // (`JSON.parse(body.X)` / `JSON.parse(req.body...)`) without a try/catch
    // throws a SyntaxError whose message echoes the parser position
    // ("...JSON at position 1"). On the admin surface that escapes as a 500
    // that leaks the parser internals (the _wrap catch only mapped
    // TypeError → 400). Every such parse must be wrapped so the bad paste
    // degrades to a clean 400 with a generic message (the shipping-zone
    // regions_json / rates_json edit was the live reproducer).
    id:        "admin-unguarded-json-parse-request-field",
    bugClassDeclared: true,
    primitive: "wrap any JSON.parse of an operator-supplied request-body field in try/catch and throw a TypeError (→ clean 400 via _wrap), e.g. `try { patch.regions = JSON.parse(body.regions_json); } catch (_e) { throw new TypeError(\"...must be valid JSON\"); }`",
    regex:     /(?<!try\s*\{[\s\S]{0,80})JSON\.parse\s*\(\s*(?:body|req\s*\.\s*body)\b/,
    scanScope: "lib",
    multiline: true,
    allowlist: [],
    reason:    "An unguarded `JSON.parse(body.X)` inside an admin handler raises a SyntaxError whose message names the parser position; the admin _wrap catch routed everything non-TypeError to a 500 that echoed the raw message, leaking parser internals to the client. The shipping-zone edit (regions_json / rates_json) shipped this shape and returned `500 ...Expected property name...JSON at position 1`. Wrap the parse in try/catch and throw a TypeError with a generic message so both the bearer (_wrap) and cookie (htmlHandler) surfaces degrade to a clean 400. The lookbehind exempts a parse already inside a `try { ... }` block (same-line or up to a few lines above).",
  },
  {
    // A module that validates an OUTBOUND webhook endpoint URL (composing
    // b.safeUrl.parse on the operator-supplied `url`) MUST also compose the
    // SSRF guard — without it, an endpoint pointed at 169.254.169.254 /
    // 127.0.0.1 / localhost / *.internal registers ACTIVE and turns the
    // delivery dial into a probe of the host's own network + the
    // instance-credential metadata service.
    id:        "outbound-webhook-url-without-ssrf-guard",
    bugClassDeclared: true,
    primitive: "compose b.ssrfGuard.classify(host) (literal-IP loopback/private/link-local/reserved/cloud-metadata) + a localhost / metadata.google.internal / *.internal name denylist when validating an outbound webhook endpoint URL — never accept an operator/customer-supplied webhook URL on b.safeUrl.parse alone",
    // Scoped to the webhook endpoint-URL validators by their canonical
    // throw-string shape (`webhooks: url must be ...` /
    // `webhookSubscriptions: endpoint_url must be ...`) so it locks the two
    // outbound webhook-delivery URL gates without flagging content/canonical
    // URL validators (blog / cms / pages) or the operator-set SMS provider
    // endpoint — none of which are attacker-supplied fan-out targets.
    regex:     /["'](?:webhooks: url|webhookSubscriptions: endpoint_url) must be /,
    scanScope: "lib",
    requires:  /ssrfGuard\.classify|ssrfGuard\.checkUrl|textGuard\.hostLabel|host is not allowed \(internal\/loopback\/metadata/,
    allowlist: [],
    reason:    "The webhook subscription/create URL guard enforced https + blocked user:pass@ userinfo but accepted internal/loopback/link-local/cloud-metadata destinations — `https://169.254.169.254/...`, `https://127.0.0.1/x`, `https://localhost/x`, `https://metadata.google.internal/x` all registered ACTIVE (confirmed against the live harness). Any lib module that validates an outbound webhook endpoint URL MUST also compose the framework's SSRF guard — directly via `b.ssrfGuard.classify` (literal-IP hosts) + a known-name denylist, or through `textGuard.hostLabel` which centralizes both. DNS-rebinding is out of scope at registration time by design; the resolving guard belongs on the delivery dial. The `requires` check exonerates a file that names the ssrfGuard composition, the textGuard.hostLabel wrapper, or the canonical refusal message; the regex is tied to the webhook validators' throw strings so content-URL validators and the operator-set SMS provider URL aren't flagged.",
  },
  {
    // An admin handler whose catch branch passes the caught error's raw
    // message straight into a 5xx problem-details body leaks storage-engine
    // / parser internals (e.g. "UNIQUE constraint failed: products.slug").
    // 5xx responses carry NO error-derived detail; the message is recorded
    // server-side (audit) and the client sees a generic code.
    id:        "admin-5xx-echoes-raw-error-message",
    bugClassDeclared: true,
    primitive: "for a 5xx problem-details response, pass NO error-derived detail — record `e.message` server-side via b.audit.safeEmit(outcome:\"failure\") and return `_problem(res, 5xx, \"<code>\")` with no fourth argument; only 4xx (client-shape) errors may surface their message",
    regex:     /_problem\s*\(\s*res\s*,\s*5\d\d\s*,\s*["'][^"']+["']\s*,\s*(?:\(?\s*e\s*&&\s*e\.message|e\.message|String\s*\(\s*e\s*\))/,
    scanScope: "lib",
    allowlist: [],
    reason:    "The admin _wrap fallthrough returned `_problem(res, 500, \"internal-error\", e.message)`, echoing the raw error to the client. A DB constraint violation (`UNIQUE constraint failed: products.slug`, `FOREIGN KEY constraint failed`) or any unexpected throw then leaked SQLite internals. 5xx bodies must carry no error-derived detail: record the message via the framework audit (drop-silent, outcome:\"failure\") and return a generic code. Known 4xx mappings (TypeError → 400, constraint → 409/400) surface a generic operator-facing message instead. Detector flags any `_problem(res, 5xx, code, e.message / e && e.message / String(e))` shape.",
  },
  {
    // The cookie/HTML sibling of admin-5xx-echoes-raw-error-message: an
    // admin HTML handler that renders a caught error's RAW message into a
    // banner/notice (`notice: e.message` / `notice: (e && e.message)` /
    // `notice: String(e)`) leaks storage-engine / parser internals to the
    // operator's browser — the same "UNIQUE constraint failed:
    // products.slug" string the bearer path was hardened against, surfaced
    // through the rendered page instead of the JSON body. Every admin HTML
    // notice/banner built from a thrown error MUST route through _safeNotice,
    // which returns the validation message verbatim for a TypeError and a
    // generic message for a constraint / parser / unknown error (auditing
    // the unknown case server-side). The good shape is `notice:
    // _safeNotice(e, "...").message` (or `n.message` for a hoisted result);
    // a bare `e.message` in a notice value is the antipattern.
    id:        "admin-html-error-banner-echoes-raw-error-message",
    bugClassDeclared: true,
    primitive: "route every admin HTML error banner/notice through _safeNotice(e, \"<action>\") — render `_safeNotice(e, ...).message`, never a raw `e.message` / `(e && e.message)` / `String(e)`; the classifier surfaces TypeError validation text verbatim and genericizes constraint / parser / unknown errors",
    regex:     /notice\s*[:=][^;}\n]*?(?:\b(?:e|e2|e3|err)\s*(?:&&\s*(?:e|e2|e3|err)\s*)?\.message|String\s*\(\s*(?:e|e2|e3|err)\s*\))/,
    scanScope: "lib",
    // The admin console is the surface that composes _safeNotice. The
    // storefront's own form-error renders (survey / return / review / Q&A)
    // already sit inside an `if (e instanceof TypeError)` guard with a
    // `throw e` fall-through, so they only ever render an operator-safe
    // validation message and never a constraint / unknown error — a
    // distinct, already-correct discipline. Exempt that file so the detector
    // locks the admin-banner contract without forcing the storefront to
    // route through an admin-module helper.
    allowlist: ["lib/storefront.js"],
    reason:    "POST /admin/products with a duplicate slug via the cookie/HTML form returned a 400 page whose error banner contained the raw `UNIQUE constraint failed: products.slug` — the bearer JSON path was hardened (the _wrap chokepoint), but the htmlHandler branch passed the caught error's message straight into `renderAdminProducts({ notice: (e && e.message) })`. Every admin HTML notice/banner built from a thrown error must route through the shared _safeNotice classifier so the cookie and bearer surfaces can never diverge: TypeError → its (operator-safe) validation message verbatim; UNIQUE/FOREIGN KEY → a generic in-use / referenced-record message; CHECK/NOT NULL → a generic missing-or-invalid message; SyntaxError → \"Invalid input.\"; anything else → a generic message with the raw text recorded server-side via the framework audit. Detector flags any `notice: <expr with e.message / (e && e.message) / String(e)>` on a single line; the good shapes (`notice: _safeNotice(e, ...).message`, `notice: n.message`) carry no bare `e.message` in the notice value and are not matched. The storefront's TypeError-guarded form renders are exempted via allowlist (they enforce the same no-leak guarantee through an explicit `instanceof TypeError` branch with a `throw e` fall-through).",
  },
  {
    // The PUBLIC, UNAUTHENTICATED catalog API sibling of
    // admin-5xx-echoes-raw-error-message: server.js's _problemFromError
    // maps a thrown error to an RFC 9457 problem document for the
    // anonymous GET /api/catalog/products[/:slug] routes. A TypeError is
    // a client-shape validation error whose message is operator-safe, so
    // it surfaces as a 400 with its detail intact. Any OTHER error is a
    // 500 — and b.problemDetails.fromError copies err.message verbatim
    // into the problem `detail`, which the D1 layer builds from the raw
    // upstream string ("query failed — UNIQUE constraint failed:
    // products.slug"). The 5xx body MUST carry a generic detail; the raw
    // message is recorded server-side via b.audit.safeEmit
    // (outcome:"failure") so an operator can correlate but the anonymous
    // caller never sees the storage-engine internals. The detector
    // anchors on the file-unique _problemFromError helper and is
    // exonerated only when the same function records the raw message via
    // the catalog-API audit action; a regression that drops the scrub
    // (passing e.message straight into a status:500 fromError) removes
    // that token and trips this.
    id:        "public-api-5xx-echoes-raw-error-message",
    bugClassDeclared: true,
    primitive: "the public catalog API's _problemFromError (server.js) must scrub the 5xx detail — a non-TypeError records `e.message` server-side via b.audit.safeEmit(outcome:\"failure\") and returns a GENERIC detail (\"Something went wrong — please try again.\"); only a TypeError (client-shape validation) may surface its message as a 400. Never pass the raw message into a status:500 b.problemDetails.fromError on an unauthenticated route — the D1 layer wraps the upstream constraint/SQL string into err.message and fromError copies it verbatim into the body",
    regex:     /\bfunction\s+_problemFromError\s*\(/,
    scanScope: "server",
    requires:  /shop_catalog_api\.request\.error/,
    allowlist: [],
    reason:    "GET /api/catalog/products and GET /api/catalog/products/:slug are public + unauthenticated; their catch routed every non-TypeError through `b.problemDetails.fromError(e, { status: 500 })`, and fromError copies `err.message` verbatim into the problem `detail`. The shop D1 layer (lib/externaldb-d1.js) builds errors carrying the raw upstream string (`externaldbD1: query failed — UNIQUE constraint failed: products.slug`), so a storage fault leaked SQLite internals to an anonymous caller — the same class the admin side fixed (lib/admin.js _safeNotice). _problemFromError now mirrors that discipline: a TypeError surfaces its (operator-safe) validation message as a 400, and any other error is a 500 whose body carries a fixed generic detail while the raw message is recorded server-side via `b.audit.safeEmit({ action: \"shop_catalog_api.request.error\", outcome: \"failure\", metadata: { message } })`. The detector anchors on the file-unique `_problemFromError` definition (server.js is reached via the dedicated `server` scope) and is exonerated by the whole-file presence of the `shop_catalog_api.request.error` audit token, which lives only in the scrubbed branch; reverting to a raw-message 500 removes that token and trips the detector.",
  },
  {
    // Issuing a gift card binds a money balance to a currency. The
    // giftcards primitive only shape-checks the code (/^[A-Z]{3}$/), so a
    // well-formed-but-nonexistent code like "ZZZ" used to issue a card in a
    // currency the rest of the shop can't price. Any file that issues a
    // card MUST first validate the currency against the framework's ISO
    // 4217 catalog (b.money.CURRENCIES) — the same surface currency-
    // rounding + display compose.
    id:        "giftcard-issue-without-iso4217-currency-check",
    bugClassDeclared: true,
    primitive: "validate the gift-card currency against b.money.CURRENCIES (ISO 4217 catalog membership) before giftcards.issue(...) — a /^[A-Z]{3}$/ shape check alone issues cards in non-existent currencies; textGuard.currencyCode centralizes the shape + membership check",
    regex:     /giftcards\.issue\s*\(/,
    scanScope: "lib",
    requires:  /money\.CURRENCIES|textGuard\.currencyCode/,
    allowlist: [],
    reason:    "POST /admin/gift-cards with `currency=ZZZ` returned 201 and issued a card in a non-existent currency — the only gate was the giftcards primitive's `/^[A-Z]{3}$/` shape check. Any lib file that calls `giftcards.issue(...)` MUST first validate the currency against the framework's ISO 4217 catalog — directly against `b.money.CURRENCIES` (the catalog the currency-rounding + currency-display primitives compose) or through `textGuard.currencyCode`, which runs the shape + membership check in one call — and refuse unknown codes with a clean 400. The `requires` check exonerates a file that composes `money.CURRENCIES` or `textGuard.currencyCode`.",
  },
  {
    // Generalizes the giftcard-specific currency check to every
    // money-binding issue / grant / credit primitive. Binding a balance
    // to a currency that only shape-checks (/^[A-Z]{3}$/) lets a
    // well-formed-but-nonexistent code ("ZZZ") create a balance the rest
    // of the shop can't price — the same class as the giftcard-ZZZ bug,
    // one rung up. Any file that issues / grants / credits a money balance
    // MUST validate the currency against the framework's ISO 4217 catalog
    // (b.money.CURRENCIES) or the textGuard.currencyCode wrapper that
    // composes it. The `requires` exoneration keeps shape-only display
    // sites (the ~50 CURRENCY_RE renderers) out of scope — only a file
    // that BINDS money is matched, and a file that names the catalog check
    // is cleared.
    id:        "money-binding-currency-without-catalog-check",
    bugClassDeclared: true,
    primitive: "validate the currency against b.money.CURRENCIES (or textGuard.currencyCode) before any money-binding issue / grant / credit — a /^[A-Z]{3}$/ shape check alone binds a balance to a non-existent currency",
    regex:     /\b(?:giftcards\.issue|storeCredit\.(?:issue|grant|adjust)|giftCardLedger\.(?:issue|credit))\s*\(/,
    scanScope: "lib",
    requires:  /money\.CURRENCIES|textGuard\.currencyCode/,
    allowlist: [],
    reason:    "A money-binding call (`giftcards.issue`, `storeCredit.issue/grant/adjust`, `giftCardLedger.issue/credit`) that runs only a `/^[A-Z]{3}$/` shape check on the currency binds a balance to a currency code the catalog doesn't recognize — the giftcard-ZZZ bug, generalized to every issue/grant/credit primitive. Validate the currency against `b.money.CURRENCIES` (ISO 4217 catalog membership) or `textGuard.currencyCode` (which centralizes the shape + membership check) before binding the balance, and refuse unknown codes with a clean 400. The `requires` check exonerates a file that names the catalog composition; the regex matches only money-binding calls, so the shape-only display renderers (`CURRENCY_RE`) aren't flagged.",
  },
  {
    // The returns refund MUTATION (POST) must classify a malformed rma id
    // as a 400 bad-request like its approve/received/reject siblings — NOT
    // map the guardUuid TypeError from `returns.get(...)` to a 404
    // return-not-found (whose body was the self-contradictory "not a valid
    // UUID" message). Only a well-formed-but-missing id is a genuine 404.
    // (The GET detail reader legitimately 404s a bad id — it's a defensive
    // request-shape reader, a different tier — so this detector is scoped
    // tightly to the W("return.refund") mutation.)
    id:        "returns-refund-typeerror-mapped-to-404",
    bugClassDeclared: true,
    primitive: "let the malformed-id TypeError from returns.get(...) surface as a clean 400 via _wrap (matching approve/received/reject); only a well-formed id that resolves to null is a 404 return-not-found",
    regex:     /W\(\s*["']return\.refund["'][\s\S]{0,400}?returns\.get\([\s\S]{0,200}?TypeError[\s\S]{0,80}?return-not-found/,
    scanScope: "lib",
    multiline: true,
    allowlist: [],
    reason:    "POST /admin/returns/<malformed-id>/refund returned 404 return-not-found while the three sibling actions (approve/received/reject) returned 400 for the same id — and the 404 body was actually a guardUuid \"not a valid UUID\" message (self-contradictory). The refund handler caught the TypeError from `returns.get(...)` and mapped it to 404 instead of letting it surface as 400. A malformed id is a bad request, not a missing record; only a well-formed id resolving to null is a 404. Detector locks the W(\"return.refund\") mutation so the TypeError → return-not-found mapping can't return. The GET detail reader's bad-id-to-404 is a separate, intentional defensive-reader tier and is not matched.",
  },
  {
    // A shipped header value (container or edge) that re-introduces one of
    // the three legacy Document-Policy feature tokens — document-write,
    // unsized-media, oversized-images. Current browsers recognize none of
    // them: the header parses, every token is rejected, the browser logs
    // "Unrecognized document policy feature name <x>", and nothing is
    // enforced. The vendored blamejs default emits exactly these three; the
    // shop suppresses that copy (securityHeadersOpts → documentPolicy:false)
    // and the edge sends no Document-Policy. This detector locks that: a
    // hand-rolled Document-Policy value carrying any of the three is flagged
    // so the inert-header regression can't return through a shop header layer.
    id:        "document-policy-unrecognized-feature-token",
    bugClassDeclared: true,
    primitive: "do not assert a legacy Document-Policy feature (document-write / unsized-media / oversized-images) — current browsers recognize none of them and log \"Unrecognized document policy feature name\"; suppress the vendored default via securityHeadersOpts (documentPolicy:false) and emit no Document-Policy at the edge, or set only a recognized feature (force-load-at-top / js-profiling / include-js-call-stacks-in-crash-reports / expect-no-linked-resources / network-efficiency-guardrails)",
    // Match the three token names ONLY in a structured-field value shape
    // (`<token>=?0` / `<token>=?1`), the exact form a Document-Policy header
    // value takes. Prose mentioning the names (the explanatory comments in
    // lib/security-middleware.js + worker/index.js) never uses the `=?`
    // boolean syntax, and lib/worker comment lines are skipped by the scanner
    // anyway — so the detector locks the header value without flagging its
    // own rationale text.
    regex:     /\b(?:document-write|unsized-media|oversized-images)=\?[01]\b/,
    scanScope: "shop",
    allowlist: [],
    reason:    "Every container page (e.g. /cart, /admin/*) emitted a Document-Policy header with document-write=?0, unsized-media=?0, oversized-images=?0 — feature names current Chromium no longer recognizes. The browser logged \"Document-Policy HTTP header: Unrecognized document policy feature name <x>\" and applied no policy, so the header was pure console noise with zero protection. The vendored blamejs securityHeaders default hardcodes these three; the shop now passes documentPolicy:false through createApp (lib/security-middleware.js securityHeadersOpts) to suppress the inert header, matching the edge (worker/index.js _SECURITY_HEADERS), which never sent it. Detector matches the three legacy tokens in their structured-field `=?0`/`=?1` value form so a re-introduced Document-Policy value (in either substrate's header set) trips it; the recognized feature set today is force-load-at-top / js-profiling / include-js-call-stacks-in-crash-reports / expect-no-linked-resources / network-efficiency-guardrails — assert one of those instead, or send no header.",
  },
  {
    // The PDP image gallery was a decorative dead end: the thumbnail strip
    // was rendered `aria-hidden` (screen readers couldn't reach it) with
    // bare <img> tiles that did nothing on click, padded to four fixed
    // slots with empty <li> so a one-image product showed three dashed
    // "missing image" squares. The functional gallery is a no-JS,
    // CSS-`:checked` picker (radios + stacked images + `<label for>`
    // thumbnails). This detector locks two specific regressions out of the
    // gallery builders (lib/storefront.js + worker/render/product.js): an
    // `aria-hidden` pdp__thumbs strip (the strip is interactive now — it
    // must NOT be hidden from assistive tech), and the empty-<li>
    // slot-padding shape (`<li></li>` literal or a `while (...) push("<li>
    // </li>")` pad-loop). An empty <li> in markup or a pad-to-N loop both
    // trip it; the real thumbnails are `<li><label ...>...</label></li>`,
    // which carry no empty body and aren't matched.
    id:        "pdp-gallery-inert-thumbnail-strip",
    bugClassDeclared: true,
    primitive: "render the PDP thumbnail strip as an interactive, focusable `<ul class=\"pdp__thumbs\">` of `<label for>` controls bound to hidden radios (no `aria-hidden`, no empty-<li> padding) so the gallery is a working no-JS CSS-`:checked` picker, not a decorative strip that pads a single-image product with empty slots",
    regex:     /class=\\?"pdp__thumbs\\?"[^>]*aria-hidden|<li>\s*<\/li>|while\s*\([^)]*\)\s*[\w$]+\.push\s*\(\s*\\?"<li>\s*<\/li>/,
    scanScope: "shop",
    allowlist: [],
    reason:    "The PDP gallery shipped decorative-only: the thumbnail strip was `aria-hidden` with non-interactive bare-<img> tiles, capped at four images, and padded short strips to four fixed slots with empty <li> — so a single-image product rendered three dashed missing-image squares and clicking a thumbnail did nothing. The functional replacement is a server-rendered, no-JS gallery: N hidden radios (first checked), a stack of N main <img> shown/hidden by the radios' `:checked` state in CSS, and N `<label for>` thumbnails (keyboard-focusable through the radio) that swap the visible image — no island, exactly N thumbnails, no strip at all for a lone image. Detector flags a re-introduced `aria-hidden` on the pdp__thumbs strip (it's interactive now and must reach assistive tech), a literal empty `<li></li>`, or the `while (...) push(\"<li></li>\")` slot-pad loop in either gallery builder.",
  },
  {
    // A media `position` rewrite is what reorder + set-primary do — they
    // renumber the rows whose display order the PDP gallery reads (the first
    // row is the hero). Every such UPDATE MUST scope its WHERE clause by
    // `product_id`: without it, a crafted `ordered_media_ids` (or media id)
    // could renumber a row belonging to ANOTHER product — a cross-product
    // IDOR on display order. The regex matches an `UPDATE media SET position`
    // statement whose SQL string body (up to its closing quote) does NOT
    // mention `product_id`; the two shipped writes (catalog.media.reorder /
    // setPrimary) both carry `AND product_id = ?` and so don't match.
    id:        "media-reorder-unscoped-position-update",
    bugClassDeclared: true,
    primitive: "scope every `UPDATE media SET position` by product_id (e.g. `UPDATE media SET position = ?1 WHERE id = ?2 AND product_id = ?3`) — an unscoped position write lets a crafted media id / id-list renumber another product's gallery row (cross-product display-order IDOR)",
    // Negative-lookahead over the statement body: match `UPDATE media SET
    // position` only when no `product_id` appears before the SQL string
    // literal's closing quote. A scoped write names product_id inside the
    // same string and is not matched.
    regex:     /UPDATE\s+media\s+SET\s+position\b(?:(?!product_id)[\s\S]){0,200}?["']\s*,/,
    scanScope: "lib",
    multiline: true,
    allowlist: [],
    reason:    "catalog.media.reorder + catalog.media.setPrimary renumber a product's media `position` to control which image the PDP gallery shows as the hero (media[0]) and in what order the rest follow. Because D1 has no cross-statement transaction over the HTTP bridge, the renumber is one UPDATE per row — and each MUST be scoped by product_id so a crafted `ordered_media_ids` (reorder) or a foreign media id (set-primary) can never reposition a row that belongs to another product, which would be a cross-product IDOR on display order. Both shipped writes carry `WHERE id = ?2 AND product_id = ?3`. The detector matches an `UPDATE media SET position` whose SQL string body reaches its closing quote without naming product_id, so a re-introduced unscoped write (`UPDATE media SET position = ?1 WHERE id = ?2`) trips it while the scoped form does not.",
  },
  {
    // The storefront search results page reported its match count from the
    // length of the result PAGE slice ("Showing " + products.length +
    // " matches") instead of the real total of every product the query
    // matched. With the grid hard-capped at one page (24 cards), the count
    // both LIED (it said 24 when more matched) and the surplus products were
    // unreachable. The fix drives the count copy off the real total
    // (the searchFacets previewQuery `total` / the full narrowed-set
    // length), windowing only the rendered cards by page. This detector
    // locks both `renderSearch` implementations (lib/storefront.js +
    // worker/render/search.js): a re-introduced `"Showing " + <var>.length
    // + " match"` count built from a page-slice array trips it, while the
    // total-driven `"Showing " + totalCount + " match"` carries no
    // `.length` and is not matched.
    id:        "search-count-from-page-length",
    bugClassDeclared: true,
    primitive: "render the search result-count copy from the REAL match total (searchFacets previewQuery `total`, or the full narrowed-set length), not from the rendered page slice's `.length` — `\"Showing \" + totalCount + \" match\"`, never `\"Showing \" + products.length + \" match\"`; the page slice is what you PAINT, the total is what you COUNT",
    // Match the `Showing " + <identifier>.length + " match` count shape in
    // either renderer. The fixed code interpolates a plain total variable
    // (no `.length`), so it isn't matched; only a count rebuilt from a
    // sliced array's length trips it.
    regex:     /Showing\s*"\s*\+\s*[A-Za-z_$][\w$]*\.length\s*\+\s*"\s*match/,
    scanScope: "shop",
    allowlist: [],
    reason:    "GET /search rendered \"Showing 24 matches\" for any query matching more than one page — the count was built from `products.length` (the 24-card page slice) rather than the real number of matched products. The count lied AND products past the first 24 were unreachable (the grid was `.slice(0, 24)` with no pagination). The fix reads the real total (the searchFacets `previewQuery` `total`, which is the full passing-set length regardless of the page window, or the narrowed set's `.length` on the edge) and drives the count copy + the page math off it, windowing only the rendered cards by `?page=N`. Both `renderSearch` implementations (container + edge) now interpolate a `totalCount` variable into the count string. The detector matches a count rebuilt from a `<var>.length` (a page-slice array), so the page-length regression can't return in either substrate; the total-driven form carries no `.length` in the count string and is not flagged.",
  },
  {
    id:        "blog-create-auto-publishes-draft",
    bugClassDeclared: true,
    primitive: "the blog admin create path must leave a new post a DRAFT — call `blog.createDraft(...)` and stop; never `blog.publish(...)` in the same create handler. A post is hidden from the storefront /blog until the operator explicitly publishes it; auto-publishing on create skips that gate and pushes an unreviewed post live the instant it's typed",
    // Match `blog(Articles).createDraft(` followed within a short window by
    // a `.publish(` call — the auto-publish-on-create shape. The shipped
    // create handlers call createDraft then redirect (PRG); publish lives
    // in a separate, operator-invoked lifecycle route, so the clean tree
    // carries no createDraft→publish proximity and isn't flagged.
    regex:     /\b(?:blog|blogArticles)\.createDraft\s*\([\s\S]{0,400}?\.publish\s*\(/,
    scanScope: "lib",
    multiline: true,
    allowlist: [],
    reason:    "The customer-facing blog (/blog index, /blog/:slug, the RSS feed, the sitemap) reads ONLY rows with status='published'. The admin author flow creates every post as a draft (`blog.createDraft`) and keeps it off the storefront until a separate publish action runs, so an operator can review a post before it goes live. Folding a `blog.publish(...)` call into the create handler would defeat that review gate — the post would be live the moment it's created, with no draft state. The detector flags a createDraft immediately followed by a publish in the same handler; the shipped split (createDraft → PRG to the editor, publish only via POST /admin/blog/:slug/publish) carries no such proximity.",
  },
  {
    // The auto-discount console edit form coerces the rule edit into an
    // updateRule patch via `_discountPatch`. autoDiscount.updateRule
    // accepts `trigger` + `value` in its ALLOWED_PATCH_COLUMNS — those
    // are the actual discount TERMS (the amount / percentage / threshold
    // / BOGO quantities). A `_discountPatch` that forwards only title /
    // priority / active drops the two terms columns: the operator can
    // reprioritise or pause a rule from the console but cannot change
    // what it discounts, a write-but-no-edit dormant gap (the bearer
    // PATCH accepts the columns; the browser edit path silently omits
    // them). The detector matches the helper definition and is exonerated
    // by `requires` only when the same file forwards BOTH terms columns
    // through the create-form vocabulary (`patch.trigger = _discountTrigger`
    // and `patch.value = _discountValue`). A regression that strips either
    // forward re-opens the gap and trips this.
    id: "discount-patch-drops-trigger-or-value",
    bugClassDeclared: true,
    primitive: "the auto-discount edit coercion (`_discountPatch`) must forward the two TERMS columns autoDiscount.updateRule accepts — `patch.trigger = _discountTrigger(body)` and `patch.value = _discountValue(body)` — so an operator can change a rule's amount / percentage / threshold / BOGO terms from the console, not only its priority / active flag. Forwarding only title / priority / active leaves the terms editable solely over the bearer PATCH (a write-but-no-edit dormant gap)",
    regex: /function\s+_discountPatch\s*\(/,
    scanScope: "lib",
    requires: /^(?=[\s\S]*patch\.trigger\s*=\s*_discountTrigger\s*\()(?=[\s\S]*patch\.value\s*=\s*_discountValue\s*\()/,
    allowlist: [],
    reason: "autoDiscount.updateRule's ALLOWED_PATCH_COLUMNS accepts trigger + value (the discount terms) alongside title / priority / active. The console's `_discountPatch` originally forwarded only title / priority / active, so the browser edit path could reprioritise or pause a rule but never change its amount / percentage / threshold / BOGO terms — those were reachable only over the bearer JSON PATCH. The fix re-uses the create form's `_discountTrigger` / `_discountValue` vocabulary (which throws a TypeError on a bad / missing required field, degrading a bad terms edit to a clean 400) so the detail-screen edit form forwards both terms columns. The detector matches the `_discountPatch` definition and is exonerated only when the same file forwards both `patch.trigger = _discountTrigger(...)` and `patch.value = _discountValue(...)`; dropping either forward re-opens the dormant gap and trips this.",
  },
  {
    // The edge Worker serves /assets/* straight from R2, and the media
    // upload path writes arbitrary operator-supplied bytes into that bucket.
    // So an asset leaves the bucket with a content-type the operator
    // DECLARED, not one the edge verified. The asset Response MUST carry the
    // protective header set (X-Content-Type-Options: nosniff so a mis-typed
    // upload can't be MIME-sniffed into something executable, plus a
    // Cross-Origin-Resource-Policy and — for SVG — a script-sandboxing CSP);
    // those are stamped by `_hardenAssetResponse(headers)` right before the
    // Response is built. The detector matches the asset Response shape
    // (`new Response(obj.body`) and is exonerated only when the same file
    // defines + applies the hardener — a re-introduced asset response that
    // skips the hardener trips it.
    id: "r2-asset-response-without-nosniff-hardening",
    bugClassDeclared: true,
    primitive: "stamp every R2-served asset Response with the protective headers via `_hardenAssetResponse(headers)` before `new Response(obj.body, { headers })` — X-Content-Type-Options: nosniff on every asset, Cross-Origin-Resource-Policy: same-origin, and a `default-src 'none'; style-src 'unsafe-inline'; sandbox` CSP on image/svg+xml so a directly-navigated upload can't MIME-sniff into an executable type, be embedded cross-origin, or run script",
    regex: /new\s+Response\s*\(\s*obj\.body\b/,
    scanScope: "worker",
    requires: /_hardenAssetResponse\s*\(\s*headers\s*\)\s*;[\s\S]{0,160}?new\s+Response\s*\(\s*obj\.body\b/,
    multiline: true,
    allowlist: [],
    reason: "worker/index.js streams R2 objects to the browser on the /assets/* path. R2 holds operator-uploaded media (the admin upload-from-URL + upload-file routes write the bytes), and the object's content-type is whatever the operator declared — so without protective headers a browser can MIME-sniff a mis-typed upload into text/html / a script, embed the bytes cross-origin, or (for image/svg+xml opened by direct navigation) run embedded script in the site's own origin even though the upload path sanitizes SVG. The fix stamps X-Content-Type-Options: nosniff + Cross-Origin-Resource-Policy: same-origin on every asset and a `default-src 'none'; style-src 'unsafe-inline'; sandbox` CSP on SVG via `_hardenAssetResponse(headers)` immediately before the asset Response is built. The detector matches the `new Response(obj.body` asset-stream shape and is exonerated only when the same file applies the hardener right before it; an asset response that skips the hardener (dropping nosniff/CORP/the SVG sandbox) trips this.",
  },
  {
    // An admin media route whose path carries BOTH a product id (:id) and a
    // media id (:mid) — `/admin/products/:id/media/:mid/...` — must assert
    // the media row actually belongs to that product before acting on it.
    // catalog.media.setPrimary scopes its reorder by the media row's OWN
    // product_id, so a handler that calls it with `req.params.mid` while
    // ignoring `req.params.id` would act on whatever product owns :mid —
    // letting a request name product A in the path while reordering product
    // B's gallery. The route must gate on `_mediaBelongsToProduct(mid, id)`
    // (or equivalent product_id assertion) first, returning a clean 404 on a
    // mismatch. The detector matches a setPrimary call passing only `mid` and
    // is exonerated when the same file asserts the pairing.
    id: "admin-media-mid-route-ignores-id-segment",
    bugClassDeclared: true,
    primitive: "a `/admin/products/:id/media/:mid/...` route must assert the media row belongs to the :id product (`_mediaBelongsToProduct(req.params.mid, req.params.id)` → clean 404 on a mismatch) before catalog.media.setPrimary(req.params.mid) — the primitive scopes by the row's own product_id, so ignoring the :id path segment lets a request name one product while acting on another's media (an honesty/scope gap)",
    regex: /catalog\.media\.setPrimary\s*\(\s*req\.params\.mid\s*\)/,
    scanScope: "lib",
    requires: /_mediaBelongsToProduct\s*\(/,
    allowlist: [],
    reason: "POST /admin/products/:id/media/:mid/primary promotes a media row to the gallery hero. catalog.media.setPrimary(mid) reorders by the media row's OWN product_id, so it is IDOR-safe at the DB layer — but the route originally ignored the :id path segment entirely, so a request could name product A in the path while :mid pointed at product B's media, and the action would silently apply to B. That makes the path lie about what it touched. The fix asserts `_mediaBelongsToProduct(req.params.mid, req.params.id)` first (false → clean 404 / ?err=1 with no leak; a malformed id still throws TypeError → 400), so the path is self-consistent. The detector matches a `catalog.media.setPrimary(req.params.mid)` call and is exonerated only when the same file performs the product-pairing assertion; a route that drops the guard re-opens the gap and trips this.",
  },
  {
    // A storefront customer-facing order mutation — the cancel route fires
    // the order FSM's `cancel` event via `deps.order.transition(id,
    // "cancel")`. The order primitive transitions by id alone (it does not
    // know which customer is signed in), so a route that calls it WITHOUT
    // first asserting the order belongs to the session customer is a
    // straight IDOR: any signed-in shopper could cancel any order by id.
    // The route must compare `order.customer_id` against the session
    // customer's id (clean 404 on a mismatch / guest-owned order, never
    // act + never leak) before the transition. The detector matches the
    // `deps.order.transition(<id>, "cancel"` shape and is exonerated only
    // when the same file carries the `.customer_id !== <auth>.customer_id`
    // ownership comparison; a route that drops the guard trips this.
    id: "storefront-order-cancel-without-ownership-check",
    bugClassDeclared: true,
    primitive: "a storefront `deps.order.transition(orderId, \"cancel\")` route must first assert the order belongs to the session customer (`order.customer_id !== <auth>.customer_id` → clean 404 on a mismatch / guest-owned order) — the order primitive transitions by id alone, so skipping the ownership check lets any signed-in shopper cancel any order by id (IDOR)",
    regex: /deps\.order\.transition\s*\(\s*[\w$.]+\s*,\s*["']cancel["']/,
    scanScope: "lib",
    requires: /\.customer_id\s*!==\s*\w+\.customer_id/,
    allowlist: [],
    reason: "POST /orders/:id/cancel lets a customer cancel an unfulfilled order by firing the order FSM's `cancel` event (lib/order.js accepts it from pending | paid only). order.transition(id, event) moves the row by id — it has no notion of the requesting customer — so the route alone owns the ownership decision. Without a `customer_id` match against the signed-in session, any authenticated shopper could POST another customer's order id and cancel it (and a paid cancel leaves the operator to refund a charge they never authorized). The fix gates the transition behind `o.customer_id !== cancelAuth.customer_id` (false / guest-owned → clean 404, no act, no leak) and only attempts the FSM event for an owned, still-cancellable order. The detector matches the `deps.order.transition(id, \"cancel\")` shape and is exonerated only when the same file performs the `.customer_id !== <auth>.customer_id` assertion; a route that drops the guard re-opens the IDOR and trips this.",
  },
  {
    // The signed-in customer's support-ticket routes (the thread view
    // `GET /account/support/:id` and the reply `POST /account/support/:id/
    // reply`) act on a ticket named in the path. The support primitive's
    // get / thread / reply move a ticket by id alone — they carry no notion
    // of the requesting customer — and the table stores `customer_id` on
    // every ticket. So the storefront route alone owns the ownership
    // decision: a customer reply route MUST first assert the ticket belongs
    // to the session customer (`ticket.customer_id !== <auth>.customer_id`
    // → clean 404 on a mismatch / guest-owned ticket), or any signed-in
    // shopper could read or append to another customer's ticket by guessing
    // its id (IDOR). The detector matches the reply route registration and
    // is exonerated only when the same file performs the
    // `.customer_id !== <auth>.customer_id` assertion; a route that drops
    // the ownership gate trips this.
    id: "storefront-support-reply-without-ownership-check",
    bugClassDeclared: true,
    primitive: "a storefront customer support route (`POST /account/support/:id/reply`, and the sibling thread view) must first assert the ticket belongs to the session customer (`ticket.customer_id !== <auth>.customer_id` → clean 404 on a mismatch / guest-owned ticket) — the support primitive's get / thread / reply move a ticket by id alone, so skipping the ownership check lets any signed-in shopper read or reply to another customer's ticket by id (IDOR)",
    regex: /router\.post\(\s*["']\/account\/support\/:id\/reply["']/,
    scanScope: "lib",
    requires: /\.customer_id\s*!==\s*\w+\.customer_id/,
    allowlist: [],
    reason: "The customer support surface (/account/support) lets a signed-in shopper raise tickets, list their own, read a thread, and reply. The support primitive stores `customer_id` on each ticket but its get / thread / reply methods take a ticket id alone — they have no notion of the requesting customer — so the storefront route owns the ownership decision. Every per-ticket route funnels through an `_ownedTicket` helper that loads the ticket and refuses it (clean 404, no act, no leak) unless `ticket.customer_id === auth.customer_id`; a malformed id (guardUuid TypeError), an unknown ticket, and a ticket owned by someone else all 404 identically. Without that `customer_id` match any authenticated shopper could POST another customer's ticket id to the reply route and append to (or, via the view, read) a ticket that isn't theirs. The detector matches the `POST /account/support/:id/reply` route registration and is exonerated only when the same file performs the `.customer_id !== <auth>.customer_id` assertion; a route that drops the ownership gate re-opens the IDOR and trips this. (The list / create routes key on the session `customer_id` directly — they never load a path-named ticket — so they carry no IDOR surface and aren't matched.)",
  },
  {
    // The signed-in customer's exchange routes act on an order / exchange
    // named in the path: the request form + POST under
    // `/account/orders/:order_id/exchange` and the status detail
    // `/account/exchanges/:id`. The order-exchanges primitive moves a row
    // by id alone (requestExchange takes an order_id, getExchange a row id)
    // and the order_exchanges table carries `order_id` but NO `customer_id`
    // — the customer→order linkage lives on the order. So the storefront
    // route alone owns the ownership decision: it MUST load the parent
    // order and refuse (clean 404) unless `order.customer_id !==
    // <auth>.customer_id` is false. Skip that, and any signed-in shopper
    // could open an exchange against — or read the status of — another
    // customer's order by guessing its id (IDOR). The detector matches the
    // exchange-request POST route registration and is exonerated only when
    // the same file performs the `.customer_id !== <auth>.customer_id`
    // ownership assertion; a route that drops the gate trips this.
    id: "storefront-exchange-request-without-ownership-check",
    bugClassDeclared: true,
    primitive: "a storefront customer exchange route (`POST /account/orders/:order_id/exchange`, and the sibling /account/exchanges/:id status view) must first assert the target order belongs to the session customer (`order.customer_id !== <auth>.customer_id` → clean 404 on a mismatch / guest-owned order) — the order-exchanges primitive requests/reads by id alone and the row carries no customer_id, so skipping the ownership check lets any signed-in shopper open or read an exchange against another customer's order by id (IDOR)",
    regex: /router\.post\(\s*["']\/account\/orders\/:order_id\/exchange["']/,
    scanScope: "lib",
    requires: /\.customer_id\s*!==\s*\w+\.customer_id/,
    allowlist: [],
    reason: "The customer exchange surface lets a signed-in shopper request a same-value item swap against one of their own orders (/account/orders/:order_id/exchange) and track its status (/account/exchanges, /account/exchanges/:id). The order-exchanges primitive moves a row by id alone — requestExchange validates an order_id, getExchange a row id — and the order_exchanges table stores `order_id` but no `customer_id`, so ownership is asserted transitively through the parent order. The request form + POST funnel through `_ownedOrderForExchange` (loads the order via deps.order.get, refuses unless order.customer_id === auth.customer_id) and the status detail through `_ownedExchange` (loads the exchange, then its parent order, refuses on the same comparison); a malformed id (guardUuid TypeError), an unknown order/exchange, and a foreign-owned one all 404 identically with no leak. Without that `customer_id` match any authenticated shopper could POST another customer's order id and open an exchange against it (or read a stranger's exchange status by guessing its id). The detector matches the `POST /account/orders/:order_id/exchange` route registration and is exonerated only when the same file performs the `.customer_id !== <auth>.customer_id` assertion; a route that drops the gate re-opens the IDOR and trips this. (The list route keys on exchangesForCustomer(auth.customer_id), which resolves the customer→order linkage through the order primitive — it never loads a path-named row — so it carries no IDOR surface.)",
  },
  {
    // The signed-in customer's return-label routes act on a return named in
    // the path: the return status detail `/account/returns/:id` and the
    // label-download redirect `/account/returns/:id/label`. The
    // return-labels primitive resolves a label + its tracking by a return /
    // label id alone (labelForReturn takes a return id, eventsForLabel a
    // label id, getLabel a label id) — none of them know the requesting
    // customer. A return label belongs to a return, which belongs to a
    // customer (return_authorizations carries `customer_id`), so the
    // storefront route alone owns the ownership decision: it MUST load the
    // RETURN and refuse (clean 404) unless `return.customer_id !==
    // <auth>.customer_id` is false, BEFORE resolving the label / tracking /
    // download. Skip that, and any signed-in shopper could read another
    // customer's return label + tracking — or download its prepaid label —
    // by guessing the return id (IDOR). The detector matches the
    // `/account/returns/:id` + `/account/returns/:id/label` route
    // registrations and is exonerated only when the same file routes the
    // read through `_ownedReturn(` (which performs the `.customer_id !==
    // <auth>.customer_id` assertion); a route that resolves a label/return
    // by id alone trips this.
    id: "storefront-return-label-route-without-ownership-check",
    bugClassDeclared: true,
    primitive: "a storefront customer return-label route (`/account/returns/:id` status detail, `/account/returns/:id/label` download) must first load the return and assert it belongs to the session customer via `_ownedReturn` (`return.customer_id !== <auth>.customer_id` → clean 404 on a mismatch / unknown / malformed id) BEFORE resolving the label, its tracking events, or the label_url — the return-labels primitive reads a label + timeline by a return/label id alone and a return label belongs to a return which belongs to a customer, so skipping the ownership check lets any signed-in shopper read or download another customer's return label by guessing the return id (IDOR)",
    regex: /router\.get\(\s*["']\/account\/returns\/:id(?:\/label)?["']/,
    scanScope: "lib",
    requires: /_ownedReturn\s*\(\s*req\s*,\s*res\s*,\s*auth\s*\)/,
    allowlist: [],
    reason: "The customer returns surface lets a signed-in shopper view one of their own returns (/account/returns/:id) and download its prepaid return-shipping label (/account/returns/:id/label). The return-labels primitive reads a label and its carrier-scan timeline by id alone — labelForReturn(return_id), eventsForLabel(label_id), getLabel(label_id) — and has no notion of the requesting customer. A return label belongs to a return, and the return_authorizations row carries `customer_id`, so ownership is a single comparison the storefront route owns. Both routes funnel through `_ownedReturn(req, res, auth)`, which loads the return via deps.returns.get and refuses it (clean 404, no leak) unless `return.customer_id === auth.customer_id` — a malformed id (guardUuid TypeError), an unknown return, and a return owned by someone else all 404 identically — BEFORE the route ever calls labelForReturn / eventsForLabel or reads label_url. The download route then redirects to the carrier label asset resolved through that owned return; the label_url is never emitted or served by a bare label id. Without that ownership gate any authenticated shopper could read another customer's return label + tracking, or pull down their prepaid label, by guessing the return id. The detector matches the `/account/returns/:id` and `/account/returns/:id/label` route registrations and is exonerated only when the same file routes the read through `_ownedReturn(req, res, auth)`; a route that resolves a label/return by id alone re-opens the IDOR and trips this. (The list route /account/returns keys on listForCustomer(auth.customer_id) and never loads a path-named return, so it carries no IDOR surface and isn't matched.)",
  },
  {
    // The edge Worker serves storefront CMS pages at /pages/:slug. The
    // storefront_pages table holds three FSM states (draft / published /
    // archived); only `published` rows may reach a visitor. The edge read
    // for a single page MUST scope its SELECT by status='published', so a
    // staged draft or a retired (archived) page returns null and 404s
    // exactly like an unknown slug. A page read written `SELECT ... FROM
    // storefront_pages WHERE slug = ?` with no status predicate would
    // serve a draft the operator hasn't reviewed — the same dormant-
    // backend / unreviewed-content-leak gap the blog guards against. The
    // detector matches a storefront_pages SELECT-by-slug and is exonerated
    // only when the same statement also constrains status='published'.
    id: "storefront-page-read-without-published-filter",
    bugClassDeclared: true,
    primitive: "the edge storefront page read (`getPublishedPageBySlug`) must scope its `SELECT ... FROM storefront_pages WHERE slug = ?` by `status = 'published'` so a draft / archived page returns null and 404s like an unknown slug — serving a page row by slug alone would push staged or retired copy live, the same unreviewed-content leak the blog read guards against",
    regex: /FROM\s+storefront_pages\b[\s\S]{0,160}?\bWHERE\b[\s\S]{0,160}?\bslug\s*=/,
    scanScope: "worker",
    multiline: true,
    requires: /FROM\s+storefront_pages\b[\s\S]{0,200}?status\s*=\s*'published'/,
    allowlist: [],
    reason: "The customer-facing storefront page (/pages/:slug) reads ONLY rows with status='published' — the storefront_pages FSM has draft (staged, not yet reviewed) and archived (retired) states that must stay off the public storefront. The edge read `getPublishedPageBySlug` constrains `WHERE slug = ?1 AND status = 'published'`, so a draft / archived / unknown slug all return null and render the same 404. A page read that selected by slug alone would serve whatever state the row is in, pushing an unreviewed draft or a deliberately-retired page live the moment its slug is guessed. The detector matches a `FROM storefront_pages ... WHERE ... slug =` read and is exonerated only when the same statement also carries `status = 'published'`; a slug-only read re-opens the leak and trips this. The published-slug list read (`listPublishedPageSlugs`) carries the same status predicate and is not flagged.",
  },
  {
    // The container storefront serves the public help center at /help/:slug.
    // The knowledgeBase article FSM has draft (`published = 0`, staged) and
    // archived (a soft-delete tombstone) states; only a published, non-
    // archived article may reach a visitor. The primitive's `getArticle`
    // returns a DRAFT row (it filters archived, but NOT unpublished — its
    // publishedOnly arg is hard-coded false), so the public route MUST gate
    // the read on a published check before it renders or records a view/vote.
    // Every /help read + vote route funnels through `_kbPublishedArticle`,
    // which loads via getArticle and returns null unless `published === true`
    // and `archived_at == null` — so a draft / archived / unknown slug all
    // 404 identically. A /help/:slug route that rendered straight off
    // `kb.getArticle` with no published gate would push a staged draft live
    // the moment its slug is guessed — the same unreviewed-content leak the
    // blog + CMS-page reads guard against. The detector matches a /help/:slug
    // route registration and is exonerated only when the same file composes
    // `_kbPublishedArticle`; a route that drops the gate re-opens the leak.
    id: "help-article-route-without-published-filter",
    bugClassDeclared: true,
    primitive: "the public /help/:slug reader + vote routes must gate the article read on a published check via `_kbPublishedArticle` (loads through knowledgeBase.getArticle, returns null unless `published === true` && `archived_at == null`) so a draft / archived / unknown slug all 404 alike — the knowledgeBase getArticle returns a draft row (its publishedOnly arg is hard-coded false), so serving an article by slug alone would push staged or retired help content live",
    regex: /router\.(?:get|post)\(\s*["']\/help\/:slug/,
    scanScope: "lib",
    requires: /_kbPublishedArticle\s*\(/,
    allowlist: [],
    reason: "The customer-facing help center (/help/:slug + the /help/:slug/vote POST) reads ONLY published, non-archived articles — the knowledgeBase FSM has a draft state (`published = 0`, staged and not yet reviewed) and an archived tombstone (soft-deleted, retired) that must stay off the public storefront. The primitive's `getArticle` is NOT status-filtered for publication (its internal `_readWithFallback` is called with publishedOnly=false, so it returns a draft row; it does filter archived to null), so the route owns the published decision. Every /help read + vote route funnels through `_kbPublishedArticle(slug)`, which loads the row via getArticle and returns null unless `published === true` and `archived_at == null` — so a draft, an archived tombstone, and an unknown slug all return null and render the same 404, and the view/vote recorders only ever run for a publicly-visible article. A /help/:slug route that rendered straight off `kb.getArticle` (or `listArticles` without `published_only`) would serve whatever state the row is in, pushing an unreviewed draft live the moment its slug is guessed — the same unreviewed-content leak the blog (`getPublishedBlogArticle`) and CMS-page (`getPublishedPageBySlug`) reads guard against. The detector matches a `router.get|post(\"/help/:slug…\")` registration and is exonerated only when the same file composes `_kbPublishedArticle(...)`; a route that drops the published gate re-opens the leak and trips this. The admin authoring routes live under /admin/help (a different prefix) and read every state on purpose, so they aren't matched.",
  },
  {
    // A page's dynamic body (a blog post, a CMS page, a reflected search
    // query) is spliced into the assembled HTML at a `RAW_BODY*`
    // placeholder. `String.prototype.replace(token, replacementString)`
    // gives the replacement STRING special meaning to `$` sequences — `$$`,
    // `$&`, `` $` `` (the text before the match), `$'` (the text after the
    // match), `$1`. A body that contains a dollar followed by a backtick
    // would therefore splice the page HEAD into the body, and any other
    // dollar sequence corrupts the output — HTML-escaping the body upstream
    // does NOT neutralise `$` (it isn't one of `<>&"'`). The fix inserts the
    // body via a REPLACER FUNCTION (the shared `spliceRaw` / `_spliceRaw`
    // helper) so `String.replace` copies the fragment verbatim with no
    // dollar interpretation. The detector matches a `.replace("RAW_BODY…",
    // <dynamic>)` whose replacement is NOT a function literal; the
    // spliceRaw-based sites are not `.replace(` calls and aren't flagged.
    id: "raw-body-replace-string-dollar-injection",
    bugClassDeclared: true,
    primitive: "splice a dynamic page body into the assembled HTML with a REPLACER FUNCTION (the shared `spliceRaw` / `_spliceRaw` helper), never `html.replace(\"RAW_BODY…\", bodyHtml)` with the body as the replacement STRING — `String.replace`'s replacement string interprets `$$` / `$&` / `` $` `` / `$'` / `$N`, so a body carrying a `$` sequence (a blog/CMS post, a reflected search query) corrupts the output or leaks the page head into the body; the function-replacer form inserts the fragment verbatim",
    // Match `.replace("RAW_BODY<TOKEN>", X)` where X does NOT begin with a
    // `function` literal. The fixed code routes every dynamic-body swap
    // through `spliceRaw(...)` (not a `.replace(` call), so the clean tree
    // carries no match; a re-introduced direct string-replacement of a
    // RAW_BODY token trips it.
    regex: /\.replace\(\s*["']RAW_BODY[A-Z_]*["']\s*,\s*(?!function\b)/,
    scanScope: "shop",
    allowlist: [],
    reason: "The storefront/worker renderers assemble a page by filling a LAYOUT template, then splicing the already-rendered body fragment in at a `RAW_BODY_PLACEHOLDER` / `RAW_BODY_HTML_PLACEHOLDER` token. The body is operator- or customer-supplied free text (a blog post, a CMS Markdown page, a reflected search query). When that splice used `assembled.replace(\"RAW_BODY_PLACEHOLDER\", body)`, the body was the REPLACEMENT STRING — and `String.prototype.replace` gives a replacement string special meaning to dollar sequences: `$$`, `$&`, `` $` `` (everything before the match — i.e. the entire page <head>), `$'` (everything after), `$N`. A body containing a dollar immediately followed by a backtick spliced the page head into the body; other dollar sequences silently corrupted the rendered HTML. HTML-escaping the body upstream does not help — `$` is not one of the escaped characters. The fix inserts the body through a REPLACER FUNCTION via the shared `spliceRaw` (worker `_lib.js`) / `_spliceRaw` (lib/storefront.js) helper, which copies the fragment verbatim with no dollar interpretation, on BOTH the edge and the container so the dual-render stays byte-consistent. The detector matches a `.replace(\"RAW_BODY…\", <non-function>)` shape in lib/ + worker/; every shipped body splice is now a `spliceRaw(...)` call (not a `.replace(`), so the clean tree is unflagged and a regression to the string-replacement form re-opens the class.",
  },
  {
    // The admin points-adjustment route grants or deducts a specific
    // customer's loyalty balance. That is a money-adjacent action, so the
    // operator MUST supply a reason that lands in the loyalty ledger row
    // (loyalty.adjust writes the signed delta + the notes to
    // loyalty_transactions). A route that fires loyalty.adjust without
    // first validating + forwarding a required reason would write an
    // unattributed balance change — the audit trail couldn't say WHY the
    // points moved. The detector matches the POST /admin/loyalty/adjust
    // route registration and is exonerated only when the same file
    // composes the reason validator (`_loyaltyReason(...)`); a route that
    // drops the reason gate re-opens the gap and trips this.
    id: "loyalty-adjust-route-without-reason",
    bugClassDeclared: true,
    primitive: "the admin POST /admin/loyalty/adjust route must validate a required reason through `_loyaltyReason(body.reason)` and forward it as the `notes` of `loyalty.adjust({ customer_id, points, source, notes })` — a points adjustment is money-adjacent, so an unattributed grant/deduct (no reason in the ledger row) is refused; the primitive records the signed delta + the reason in loyalty_transactions",
    regex: /router\.post\(\s*["']\/admin\/loyalty\/adjust["']/,
    scanScope: "lib",
    requires: /_loyaltyReason\s*\(/,
    allowlist: [],
    reason: "POST /admin/loyalty/adjust lets an operator grant or deduct a customer's loyalty points from the console. The action composes loyalty.adjust, which writes the signed points delta to the loyalty_transactions ledger and recomputes the customer's tier — a balance mutation an auditor must be able to explain. The route gates on `_loyaltyReason(body.reason)` (throws a TypeError → clean 400 on a missing / blank / over-long / control-byte reason) and forwards the validated reason as the `notes` column of the ledger row, so every adjustment carries WHY it happened. Dropping the reason gate would let an adjustment write an unattributed balance change. The detector matches the adjust route registration and is exonerated only when the same file composes `_loyaltyReason(...)`; a route that fires loyalty.adjust without the reason gate re-opens the gap and trips this. The loyalty-redemption refund path (lib/loyalty-redemption.js) calls loyalty.adjust internally with its own cancel reason and carries no /admin/loyalty/adjust route, so it isn't flagged.",
  },
  {
    // The admin per-customer store-credit route grants or deducts a specific
    // customer's account-bound balance. That is a money-adjacent action, so
    // the operator MUST supply a reason that lands in the store-credit ledger
    // row (storeCredit.credit writes it to source_ref; storeCredit.expire to
    // its reason column). A route that fires the credit/expire primitive
    // without first validating + forwarding a required reason would write an
    // unattributed balance change — the ledger couldn't say WHY the credit
    // moved. The detector matches the POST /admin/customers/:id/store-credit
    // route registration and is exonerated only when the same file composes
    // the reason validator (`_storeCreditReason(...)`); a route that drops the
    // reason gate re-opens the gap and trips this.
    id: "customer-store-credit-route-without-reason",
    bugClassDeclared: true,
    primitive: "the admin POST /admin/customers/:id/store-credit route must validate a required reason through `_storeCreditReason(body.reason)` and forward it into the store-credit ledger (`source_ref` of storeCredit.credit on a grant, the `reason` of storeCredit.expire on a deduct) — a store-credit adjustment is money-adjacent, so an unattributed grant/deduct is refused; the primitive records the amount + reason in store_credit_ledger",
    regex: /router\.post\(\s*["']\/admin\/customers\/:id\/store-credit["']/,
    scanScope: "lib",
    requires: /_storeCreditReason\s*\(/,
    allowlist: [],
    reason: "POST /admin/customers/:id/store-credit lets an operator grant or deduct a customer's account-bound store credit from the customer detail screen. A grant composes storeCredit.credit (the reason rides into the ledger row's source_ref); a deduct composes storeCredit.expire (which carries a required reason column). Both write an audited row to store_credit_ledger that an auditor must be able to explain. The route gates on `_storeCreditReason(body.reason)` (throws a TypeError → clean 400 on a missing / blank / over-long / control-byte reason) and is additionally scoped to the :id customer (the target is the path id, never a form field, so an operator can't act on a different customer than the screen they're on) with an over-deduction refused as a clean 409 before any write. Dropping the reason gate would let an adjustment write an unattributed balance change. The detector matches the store-credit route registration and is exonerated only when the same file composes `_storeCreditReason(...)`; a route that fires the credit/expire primitive without the reason gate re-opens the gap and trips this.",
  },
  {
    // A storefront head builder threads a relative og:image / twitter:image
    // / JSON-LD image. og:image-class metadata is fetched by social-share
    // crawlers (Facebook / Slack / Twitter / iMessage) and by Google's
    // product/article rich result from a SEPARATE origin than the page, so
    // a relative `/assets/...` value resolves against the crawler's host (or
    // not at all) and the share preview shows no image. A renderer that
    // computes an og image from the brand-logo default (or an asset-prefix +
    // R2 key) MUST absolutize it against the page origin. Every renderer
    // that emits an og:image carries the assignment shape this matches; the
    // fix wraps the value in `absolutizeOgImage` (edge, worker/render/
    // _lib.js) / `_absolutizeOgImage` (container, lib/storefront.js), so a
    // file with the assignment is exonerated only when it also names the
    // absolutizer. Stripping the absolutize call from any og:image renderer
    // leaves the bare relative assignment and re-opens the class.
    id: "og-image-relative-without-absolutize",
    bugClassDeclared: true,
    primitive: "absolutize every og:image / twitter:image / JSON-LD image against the page origin via `absolutizeOgImage` (edge) / `_absolutizeOgImage` (container) before it reaches the `<head>` or the structured data — a relative `/assets/...` value (the brand-logo default, or an asset-prefix + R2 hero key) is dropped by social-share crawlers and by Google's rich result; the helper prefixes the canonical origin onto a `/`-rooted path and leaves an already-absolute `http(s)://` value unchanged",
    // Match a JS assignment of an `ogImage` / `og_image` to a value that
    // carries the relative brand-logo default. After the fix that same line
    // also calls `absolutizeOgImage(...)`, and the file-level `requires`
    // below exonerates it; reverting the line to a bare
    // `opts.og_image || "/assets/brand/logo.png"` keeps the match but drops
    // the absolutizer from the file, tripping the detector. The `<img src>`
    // chrome template lines carry no `ogImage =` assignment, so they aren't
    // matched.
    regex: /\bog_?[Ii]mage\s*=\s*[^;]*\/assets\/brand\/logo\.png/,
    scanScope: "shop",
    requires: /absolutizeOgImage\s*\(/,
    allowlist: [],
    reason: "Every storefront page emits an og:image + twitter:image (and the PDP / blog article emit a Product / Article JSON-LD `image`). Those URLs are fetched by social-share crawlers (Facebook / Slack / Twitter / iMessage) and by Google's rich result from a different origin than the page, so a relative `/assets/...` value never resolves and the share preview shows no image. The container funnels every page through `lib/storefront.js#_wrap` (the single head builder) and the PDP/collection/category renderers; each edge renderer (worker/render/{product,home,cart,search,blog}.js) has its own `_wrap`. All of them now compute the og image through `_absolutizeOgImage` / `absolutizeOgImage`, which prefixes the canonical origin onto a `/`-rooted path and passes an already-`http(s)://` value through unchanged (idempotent, so a PDP that absolutizes at the renderer and again at `_wrap` is stable). The detector matches the og-image assignment that carries the brand-logo default and is exonerated only when the same file names the absolutizer; stripping the absolutize call from any og:image renderer re-opens the class. `worker/render/_lib.js` (the helper definition) and the chrome `<img src>` template lines carry no such assignment and aren't flagged.",
  },
  {
    // A worker/render head builder splices a NON-LITERAL fragment into the
    // assembled HTML <head> with `html.replace("RAW_<TOKEN>", value)` where
    // the value is operator-supplied text (meta_keywords, the announcement
    // bar message). The body splice already routes through `spliceRaw`
    // (covered by `raw-body-replace-string-dollar-injection`); the HEAD
    // placeholders carrying escaped-but-`$`-bearing content need the same
    // treatment. `String.prototype.replace(token, replacementString)` gives
    // the replacement string special meaning to `$$` / `$&` / `` $` `` /
    // `$'` / `$N`, and HTML-escaping does NOT neutralise `$` (it isn't one
    // of `<>&"'`), so a `$&`/dollar-backtick inside a keywords value or an
    // announcement message corrupts the head or leaks it. The fix routes
    // these through the replacer-function helper `spliceRaw` (not a
    // `.replace(` call), so the clean tree carries no match; a regression to
    // the string-replacement form for either head token re-opens the class.
    id: "head-raw-replace-string-dollar-injection",
    bugClassDeclared: true,
    primitive: "splice an operator-supplied head fragment (meta_keywords, the announcement bar message) into the assembled HTML with the replacer-function helper `spliceRaw`, never `html.replace(\"RAW_META_KEYWORDS\"|\"RAW_ANNOUNCEMENT_BAR\", value)` with the value as the replacement STRING — `String.replace`'s replacement string interprets `$$` / `$&` / `` $` `` / `$'` / `$N`, so a `$`-bearing value (an operator's keywords / announcement copy) corrupts the head or leaks it into the body; the function-replacer form inserts the fragment verbatim",
    regex: /\.replace\(\s*["']RAW_(?:META_KEYWORDS|ANNOUNCEMENT_BAR)["']\s*,\s*(?!function\b)/,
    scanScope: "shop",
    allowlist: [],
    reason: "The storefront/worker head builders fill a LAYOUT template, then splice operator-supplied head fragments in at `RAW_META_KEYWORDS` (the CMS page's meta_keywords) and `RAW_ANNOUNCEMENT_BAR` (the sitewide announcement message). Both fragments are HTML-escaped at their build sites, but `$` is not one of the escaped characters — so when the splice used `assembled.replace(\"RAW_META_KEYWORDS\", metaKeywords)` / `.replace(\"RAW_ANNOUNCEMENT_BAR\", barHtml)`, the fragment was the REPLACEMENT STRING and `String.prototype.replace` gave its dollar sequences special meaning: `$&` re-emitted the placeholder token, `` $` `` spliced everything before the match (the page <head>) into the value, `$N` indexed a (non-existent) capture group. A keywords value or an announcement message carrying a `$` corrupted the head. The fix routes both head placeholders through the shared replacer-function helper `spliceRaw` (worker `_lib.js`) / `_spliceRaw` (lib/storefront.js), which copies the fragment verbatim with no dollar interpretation, on BOTH the edge and the container so the dual-render stays byte-consistent. The framework-fixed head placeholders (SRI digests, island `<script>` tags, robots meta) carry no `$`-bearing content and stay plain `.replace`. The detector matches a `.replace(\"RAW_META_KEYWORDS\"|\"RAW_ANNOUNCEMENT_BAR\", <non-function>)` shape in lib/ + worker/; every shipped splice of those two tokens is now a `spliceRaw(...)` call, so the clean tree is unflagged and a regression to the string-replacement form re-opens the class.",
  },
  {
    // The signed-in customer's store-credit wallet route
    // (`GET /account/credit`) reads an account-bound balance + ledger.
    // The store-credit primitive's balance / history / expiringWithin
    // take a customer id alone — they carry no notion of the requesting
    // customer — so the storefront route alone owns the session-scoping
    // decision. The route MUST resolve the wallet from the SESSION
    // customer id (`auth.customer_id`, from `_currentCustomer(req)`),
    // never from a request-supplied id / query param. There is
    // deliberately NO `:id` path segment: a route that read a
    // customer id from `req.params` / `req.query` and passed it to
    // `storeCredit.balance(...)` would let any signed-in shopper read
    // another customer's balance + ledger by guessing their id (IDOR).
    // The detector matches the `GET /account/credit` route registration
    // and is exonerated only when the same file resolves the balance from
    // `storeCredit.balance(auth.customer_id)` (the session-scoped read);
    // dropping the session scoping (reading the id from a param instead)
    // removes that token and trips this.
    id: "storefront-store-credit-route-without-session-scope",
    bugClassDeclared: true,
    primitive: "the storefront `GET /account/credit` wallet route must resolve the balance + ledger from the SESSION customer id (`storeCredit.balance(auth.customer_id)` / `.history({ customer_id: auth.customer_id })` / `.expiringWithin({ customer_id: auth.customer_id })`, where `auth` comes from `_currentCustomer(req)`), never from a request-supplied id / query param — the store-credit primitive reads by customer id alone, and there is no `:id` path segment, so a route that read the id from `req.params` / `req.query` would let any signed-in shopper read another customer's balance by id (IDOR)",
    regex: /router\.get\(\s*["']\/account\/credit["']/,
    scanScope: "lib",
    requires: /storeCredit\.balance\s*\(\s*auth\.customer_id\s*\)/,
    allowlist: [],
    reason: "The customer-facing store-credit wallet (/account/credit) is a READ-ONLY surface: the signed-in customer sees their current balance, an expiring-soon callout, and the credit/debit/expire ledger. The store-credit primitive stores `customer_id` on every ledger row but its balance / history / expiringWithin methods take a customer id alone — they have no notion of the requesting customer — so the storefront route owns the session-scoping decision. The route resolves the customer id from the signed-in session via `_currentCustomer(req)` (`auth.customer_id`) and passes ONLY that id to `deps.storeCredit.balance(auth.customer_id)` / `.history({ customer_id: auth.customer_id })` / `.expiringWithin({ customer_id: auth.customer_id })`. There is deliberately no `:id` path segment, and the route never reads a customer id from the query string or body, so a signed-in shopper can only ever see their OWN wallet. Granting / deducting credit is operator-only on the admin customer-detail screen — this surface writes nothing. Without the session-scoped read (e.g. reading a customer id from `req.params` / `req.query` and passing it to `storeCredit.balance(...)`), any authenticated shopper could read another customer's balance + ledger by guessing their id. The detector matches the `GET /account/credit` route registration and is exonerated only when the same file performs the `storeCredit.balance(auth.customer_id)` session-scoped read; dropping the session scoping removes that token and re-opens the IDOR.",
  },
  {
    // The storefront wishlist-share revoke route (`POST /wishlist/share/
    // :share_id/revoke`) acts on a share link named in the path. The sharing
    // primitive's `revokeShareLink({ link_id })` flips the link's revoked_at
    // by id ALONE — it carries no notion of the requesting customer, and
    // `wishlist_shares` stores `owner_customer_id` on every row. So the
    // storefront route alone owns the ownership decision: it must first
    // assert the link belongs to the session customer (load the session
    // customer's links via `listSharesForOwner(auth.customer_id)` and refuse
    // a share_id that isn't among them → clean 404), or any signed-in shopper
    // could revoke another customer's share link by guessing its id (IDOR).
    // The detector matches the revoke route registration and is exonerated
    // only when the same file performs the session-scoped ownership read
    // `listSharesForOwner(auth.customer_id)`; a route that revokes straight
    // off the path id without that scope trips this.
    id: "storefront-wishlist-share-revoke-without-ownership-check",
    bugClassDeclared: true,
    primitive: "the storefront `POST /wishlist/share/:share_id/revoke` route must first assert the share link belongs to the session customer — load the session customer's links via `deps.wishlistSharing.listSharesForOwner(auth.customer_id)` and refuse a `share_id` that isn't among them (clean 404) before `revokeShareLink({ link_id })` — because the sharing primitive revokes a link by id alone, so a route that revoked straight off the path id would let any signed-in shopper revoke another customer's share link by id (IDOR)",
    regex: /router\.post\(\s*["']\/wishlist\/share\/:share_id\/revoke["']/,
    scanScope: "lib",
    requires: /listSharesForOwner\s*\(\s*auth\.customer_id\s*\)/,
    allowlist: [],
    reason: "The wishlist-sharing owner surface (on /account/wishlist) lets a signed-in shopper mint share links for their OWN wishlist, see their active links, and revoke one. The sharing primitive stores `owner_customer_id` on every `wishlist_shares` row, but `revokeShareLink({ link_id, reason })` flips `revoked_at` by id alone — it has no notion of the requesting customer — so the route owns the ownership decision. The revoke route resolves the session customer via `_currentCustomer(req)` (`auth.customer_id`), loads ONLY that customer's links via `deps.wishlistSharing.listSharesForOwner(auth.customer_id)`, and looks the path `share_id` up in that owned set; an unknown id, a malformed id, and a link owned by someone else all resolve identically to a clean 404 (no act, no leak) — only a link the session customer actually owns is revoked. The create route keys on `auth.customer_id` directly (it never names a path link id), so it carries no IDOR surface and isn't matched. Without the `listSharesForOwner(auth.customer_id)` ownership scope, any authenticated shopper could POST another customer's share id to the revoke route and kill a link that isn't theirs. The detector matches the revoke route registration and is exonerated only when the same file performs the session-scoped `listSharesForOwner(auth.customer_id)` read; dropping that scope re-opens the IDOR and trips this.",
  },
  {
    // The storefront gift-registry owner routes (`POST /account/registry/
    // :slug/items`, `…/items/:item_id/remove`, `…/edit`, `…/close`) mutate a
    // registry named by slug in the path. The gift-registry primitive's
    // addItem / removeItem / update / closeRegistry move a registry by slug
    // ALONE — they carry no notion of the requesting customer, and
    // `gift_registries` stores `owner_customer_id` on every row. So the
    // storefront route alone owns the ownership decision: every owner write
    // must first assert the registry belongs to the session customer (load it
    // via `_ownedRegistry(slug, auth.customer_id)`, which reads through
    // getRegistry and returns null unless `owner_customer_id === auth.customer_id`,
    // → clean 404 on a foreign / unknown / malformed slug) before the mutation,
    // or any signed-in shopper could add to / strip / edit / close another
    // customer's registry by guessing its slug (IDOR). The detector matches the
    // owner add-item route registration and is exonerated only when the same
    // file performs the session-scoped ownership read `_ownedRegistry(<slug>,
    // auth.customer_id)`; a route that mutated straight off the path slug
    // without that scope trips this. The public giver view (`GET /registry/
    // :slug`) is NOT matched — it intentionally resolves through getBySlug
    // (never a guessable id), enforces the privacy gate in the route (a
    // private registry 404s) and surfaces items + aggregate counts only, never
    // the owner identity / buyer rows, so it carries no owner-scoped surface to
    // guard.
    id: "storefront-registry-owner-route-without-ownership-check",
    bugClassDeclared: true,
    primitive: "every storefront gift-registry owner write route (`POST /account/registry/:slug/items`, `…/items/:item_id/remove`, `…/edit`, `…/close`) must first assert the registry belongs to the session customer via `_ownedRegistry(slug, auth.customer_id)` (reads through deps.giftRegistry.getRegistry and returns null unless `owner_customer_id === auth.customer_id` → clean 404 on a foreign / unknown / malformed slug) before addItem / removeItem / update / closeRegistry — because the gift-registry primitive mutates a registry by slug alone, so a route that mutated straight off the path slug would let any signed-in shopper add to / strip / edit / close another customer's registry by slug (IDOR)",
    regex: /router\.post\(\s*["']\/account\/registry\/:slug\/items["']/,
    scanScope: "lib",
    requires: /_ownedRegistry\s*\(\s*slug\s*,\s*auth\.customer_id\s*\)/,
    allowlist: [],
    reason: "The gift-registry owner surface (on /account/registry) lets a signed-in shopper create registries, then add / remove items, edit details, and close each registry they own. The primitive stores `owner_customer_id` on every `gift_registries` row, but its addItem / removeItem / update / closeRegistry methods key on the registry slug alone — they have no notion of the requesting customer — so the route owns the ownership decision. Every owner write route resolves the session customer via `_currentCustomer(req)` (`auth.customer_id`) and funnels through `_ownedRegistry(slug, auth.customer_id)`, which loads the registry via `deps.giftRegistry.getRegistry(slug)` and returns null unless `reg.owner_customer_id === auth.customer_id`: a malformed slug throws inside the primitive's slug validator (caught → null), an unknown slug returns null, and a slug owned by a DIFFERENT customer returns null — all three render an identical clean 404, with nothing mutated. The create route (`POST /account/registry`, no `:slug`) keys the new registry's owner on `auth.customer_id` directly, so it carries no cross-customer surface and isn't matched. Without the `_ownedRegistry(slug, auth.customer_id)` scope, any authenticated shopper could POST another customer's registry slug to the add-item / remove / edit / close route and mutate a registry that isn't theirs. The public giver view `GET /registry/:slug` is deliberately NOT in scope: it resolves the registry only through `getBySlug` (never a guessable owner/registry id), enforces the privacy gate in the route (a `private` registry 404s identically to an unknown slug, no existence oracle), and surfaces items + aggregate purchased counts only — the owner's customer id / shipping address and the per-buyer purchase rows are never carried into the public shape. The detector matches the owner add-item route registration and is exonerated only when the same file performs the session-scoped `_ownedRegistry(slug, auth.customer_id)` read; dropping that scope re-opens the IDOR and trips this.",
  },
  {
    id: "admin-discount-value-kind-silent-default",
    bugClassDeclared: true,
    primitive: "the admin auto-discount form/JSON translator `_discountValue(body)` must THROW on an unrecognized `value_kind` (so the route maps it to a clean 400), never fall through to a default `{ kind: \"free_shipping\" }` — free shipping is the most generous discount kind, so a typo'd `value_kind` from a JSON API client (the browser select is constrained to the five valid kinds, but the API is not) silently coercing to free_shipping would create a store-wide free-shipping rule with no operator signal",
    regex: /function _discountValue\b/,
    scanScope: "lib",
    requires: /value_kind must be one of/,
    allowlist: [],
    reason: "`_discountValue` translates the auto-discount create form (and the detail-screen edit form) into the typed `value` object the `autoDiscount` primitive expects — `{ kind: \"percent_off\", basis_points }`, `{ kind: \"amount_off_total\", minor }`, `{ kind: \"bogo\", buy_qty, get_qty }`, or `{ kind: \"free_shipping\" }`. Because it builds a kind-specific shape it must recognise the kind; an unrecognized `value_kind` is operator error. It originally fell through to `return { kind: \"free_shipping\" }` for ANY unrecognized kind. The browser select is constrained to the five valid kinds (and defaults to `percent_off`), so the form never hits the fall-through — but a JSON API client posting a typo (`value_kind: \"percentage\"`, `\"percent\"`, anything) would silently create a store-wide FREE-SHIPPING rule (the most generous kind) and return 201 with no error, a direct margin/revenue risk. The primitive's own validator never fires because the admin layer rewrote the bad kind to a VALID one before the object reached it. The sibling translators (`_rewardValueJson`, `_earnDefineInput`) pass the kind through verbatim so the backend validator catches a bad value with a clean 400; `_discountValue` now matches that discipline by THROWing a `TypeError` (\"autoDiscount: value_kind must be one of …\") on an unrecognized kind, which the create/edit routes already map to a clean 400 the same way a bad numeric field does. The detector matches the `_discountValue` definition and is exonerated only when the file carries the `value_kind must be one of` validation throw; reverting to the silent free_shipping default removes that token and trips the detector.",
  },
  {
    // The storefront collection page (`GET /collections/:slug`) rendered the
    // grid from `collections.productsIn({ slug, limit: 24 })` with no cursor
    // threaded and no pagination control — so a collection with more than 24
    // members silently lost everything past the 24th, with no way for a
    // shopper to reach it. `productsIn` is keyset/offset paginated: it
    // returns an opaque, forward-only `next_cursor`, and the route now reads
    // a `?cursor=` trail, threads its last cursor into `productsIn`, and
    // surfaces `next_cursor` into `renderCollection` (which paints a prev/
    // next nav reusing the search-pagination shell). This detector matches
    // the `/collections/:slug` route registration and is exonerated only
    // when the same file BOTH threads a cursor into a `productsIn(...)` call
    // AND surfaces `next_cursor: result.next_cursor` into the render —
    // dropping either re-introduces the silent 24-cap truncation and trips
    // this.
    id: "collection-route-without-cursor-pagination",
    bugClassDeclared: true,
    primitive: "the GET /collections/:slug route must thread a `?cursor=` trail through `collections.productsIn({ slug, limit, cursor })` and surface the lib's opaque forward `next_cursor` into renderCollection (which paints a prev/next nav) — `productsIn` returns at most one page (no total), so a route that calls it with no cursor and never surfaces next_cursor silently truncates a collection larger than one page, leaving every member past the page size unreachable; a bad / stale cursor falls back to page 1 (clean, link-followable) rather than 404/500, matching how /search treats a bad ?page=",
    regex: /router\.get\(\s*["']\/collections\/:slug/,
    scanScope: "lib",
    // Exonerated only when the file BOTH threads a cursor into a productsIn
    // call AND surfaces next_cursor into the render. Two lookaheads over the
    // whole file (the `discount-patch-drops-trigger-or-value` shape): the
    // fixed route carries both; stripping either re-opens the truncation.
    requires: /^(?=[\s\S]*productsIn\s*\(\s*\{[^}]*\bcursor\s*:)(?=[\s\S]*next_cursor\s*:\s*result\.next_cursor)/,
    allowlist: [],
    reason: "GET /collections/:slug rendered only the first page of a collection: it called `collections.productsIn({ slug, limit: 24 })` with no cursor and passed the resulting rows to renderCollection, which had no pagination block. `productsIn` is keyset (manual collections, by position+id) / offset (smart collections) paginated and returns an opaque, forward-only `next_cursor` (null on the last page) — it never returns a total — so a single un-cursored call caps the page at the limit and discards the rest. A collection with more than 24 members therefore lost every product past the 24th with no shopper-reachable path to it. The fix reads a `?cursor=` trail (a comma-joined list of page-start cursors — cursor chars are base64url plus a `.` tag separator, so the comma join stays URL-safe), threads the trail's last cursor into `productsIn`, and surfaces `next_cursor` into renderCollection, which paints a prev/next nav reusing the search-pagination shell (`rel=\"prev\"/\"next\"` + disabled-state spans, so no new CSS ships). A bad / stale / tampered cursor surfaces as a TypeError naming the cursor; the route retries page 1 rather than 404/500, mirroring how /search clamps a bad ?page=. The canonical stays the bare collection URL on every page (query stripped), like search. The detector matches the route registration and is exonerated only when the same file BOTH threads a cursor into a `productsIn(... cursor: ...)` call AND surfaces `next_cursor: result.next_cursor` into the render; stripping either forward removes a required token and re-opens the silent truncation.",
  },
  {
    // The edge blog index (`_edgeBlogList` in worker/index.js) fetched a
    // single fixed `listBlogArticles({ limit: 12 })` page and rendered it
    // with no pager — so a blog with more than 12 published posts silently
    // lost on-site reachability to every post past the 12th (the surplus
    // stays in sitemap.xml, so Google-discoverable, but a human browsing
    // /blog hits a dead end). `listBlogArticles` is offset-paginated and
    // exposes NO total, so the route reads `?page=N`, threads the matching
    // offset, peeks one row past the page (`limit: BLOG_PAGE_SIZE + 1`) to
    // know whether a real next page exists, slices the peeked row off, and
    // surfaces `hasNext` into renderBlogList (which paints a prev/next nav
    // reusing the search-pagination shell). This detector matches the
    // `_edgeBlogList` definition and is exonerated only when the same file
    // BOTH peeks `limit: BLOG_PAGE_SIZE + 1` AND derives `hasNext` from the
    // peeked row count — dropping either re-introduces the silent 12-cap
    // truncation (or advertises a phantom next page) and trips this.
    id: "blog-list-route-without-pagination",
    bugClassDeclared: true,
    primitive: "the edge `_edgeBlogList` route must read `?page=N`, thread the matching offset into `listBlogArticles({ limit: BLOG_PAGE_SIZE + 1, offset })`, peek one row past the page to set `hasNext = result.rows.length > BLOG_PAGE_SIZE`, slice the peeked row off, and surface `hasNext` into renderBlogList (which paints a prev/next nav reusing the search-pagination shell) — `listBlogArticles` returns at most one page and exposes no total, so a route that fetches a fixed `{ limit: 12 }` with no offset and renders no pager silently truncates a blog larger than one page, leaving every post past the page size unreachable on-site; a garbage `?page` degrades to page 1 (clean, link-followable) rather than 500, matching how /search + /collections treat a bad pagination param",
    regex: /function _edgeBlogList\b/,
    scanScope: "worker",
    // Exonerated only when the file BOTH peeks one row past the page AND
    // derives hasNext from the peeked count. Two lookaheads over the whole
    // file (the `discount-patch-drops-trigger-or-value` shape): the fixed
    // route carries both; stripping either re-opens the truncation.
    requires: /^(?=[\s\S]*limit:\s*BLOG_PAGE_SIZE\s*\+\s*1)(?=[\s\S]*hasNext\s*=\s*[\w.]+\.rows\.length\s*>\s*BLOG_PAGE_SIZE)/,
    allowlist: [],
    reason: "The edge `/blog` index (`_edgeBlogList` in worker/index.js) called `listBlogArticles(env.DB, { limit: 12 })` once, with no offset, and passed the rows to renderBlogList, which emitted the cards and no pager. `listBlogArticles` applies `LIMIT ?1 OFFSET ?2` and returns at most one page — it never returns a total — so the single un-offset call capped the index at 12 and discarded the rest. A blog with more than 12 published posts therefore lost every post past the 12th to on-site browsing (the surplus stays in sitemap.xml / feed.xml, so a crawler still finds it, but a human browsing /blog dead-ends). The fix reads a `?page=N` param (defensive parser — a missing / non-integer / sub-1 value reads as page 1), computes `offset = (page - 1) * BLOG_PAGE_SIZE`, fetches `limit: BLOG_PAGE_SIZE + 1` to peek one row past the page, sets `hasNext = result.rows.length > BLOG_PAGE_SIZE`, slices the page back to BLOG_PAGE_SIZE (so the peeked row is never rendered), and surfaces `page` + `hasNext` into renderBlogList, which paints a prev/next nav reusing the search-pagination shell (`rel=\"prev\"/\"next\"` + disabled-state spans, so no new CSS ships). Peeking one past the page means the Next link is advertised only when a real next page exists — never a phantom page that renders empty, the same lesson the order/loyalty/store-credit/customers cursor peeks encode. A garbage `?page` degrades to page 1 rather than 500, mirroring how /search + /collections clamp a bad pagination param; the canonical stays the bare /blog URL. The detector matches the `_edgeBlogList` definition and is exonerated only when the same file BOTH peeks `limit: BLOG_PAGE_SIZE + 1` AND derives `hasNext` from the peeked row count; dropping either re-opens the silent truncation and trips this.",
  },
  {
    // The edge blog renderers (worker/render/blog.js) surfaced the internal
    // `author_id` (an operator/user id, NOT a public display name) straight
    // into the public byline + the Article JSON-LD author Google reads. The
    // blog model carries no author display-name column and no blog_authors
    // table (author_id is a free-form reference into the operator's own
    // authors directory the primitive doesn't own), so there is no name to
    // resolve at the edge — the byline must fall back to the shop name
    // rather than leak the id. The detector matches an `author: <x>.author_id`
    // / `"name": <x>.author_id` shape (the byline / JSON-LD author binding)
    // in the blog renderer and is exonerated when the file routes the byline
    // through a `byline` variable derived from shopName instead; binding the
    // raw author_id back into either surface re-opens the leak.
    id: "blog-byline-from-raw-author-id",
    bugClassDeclared: true,
    primitive: "the edge blog renderers (worker/render/blog.js) must render the byline + the Article JSON-LD `author` name from the shop name (a `byline` derived from `shopName`), never the raw internal `author_id` — the blog model carries no author display-name column / blog_authors table (author_id is a free-form reference the primitive doesn't own), so surfacing `author_id` leaks an operator/user id into the public byline and the structured-data author Google reads; the shop-name fallback is the cleanest non-leaking source",
    regex: /(?:\bauthor|"name")\s*:\s*\w+\.author_id\b/,
    scanScope: "worker",
    // The RSS feed's `<author>` element (worker/render/feed.js) is a distinct
    // surface: RSS `<author>` conventionally carries an email address, not a
    // display name, and it is not the human-read public byline / structured-
    // data author this bug class is about. It legitimately keeps author_id
    // and is out of scope.
    allowlist: ["worker/render/feed.js"],
    reason: "worker/render/blog.js renders the storefront blog: the list card byline (`By {{author}}`), the article byline, and the Article JSON-LD `author.name`. All three originally bound `article.author_id` / `a.author_id` directly. `author_id` is the blog model's internal reference into the operator's authors directory — a free-form id (a user / operator id), not a public display name; the blog_articles table carries no author display-name column and there is no blog_authors table the edge could join (the blog primitive deliberately does not own the author entity). So the id has no name source to resolve at the edge, and binding it into the byline surfaced an opaque internal id in the public byline AND in the structured-data author name Google reads for the article rich result (a correctness/UX/SEO gap — it's escaped, so not XSS). The fix derives a `byline` from `shopName` (already threaded into every blog render) and uses it for the list card byline, the article byline, and the JSON-LD author name (typed `Organization`, since the shop is the publisher); the raw `author_id` is no longer surfaced on any public blog surface. The RSS feed `<author>` element is a separate surface (RSS author conventionally expects an email) and is out of this detector's scope. The detector matches an `author: <x>.author_id` / `\"name\": <x>.author_id` binding in worker/ and is exonerated when the renderer routes the byline through a shopName-derived `byline` variable instead; rebinding the raw author_id into the byline or the JSON-LD author re-opens the leak and trips this.",
  },
  {
    // A cacheable edge 404 (the blog-post / product not-found paths, served
    // with `status: 404` + a short-TTL cache-control) must guard its body on
    // a HEAD request — `new Response(request.method === "HEAD" ? null : html,
    // { status: 404, ... })` — so a HEAD probe to a missing resource gets the
    // 404 status + headers with no body (HTTP spec: a HEAD response carries no
    // message body). The page-404 + empty-cart paths already carry this guard;
    // the blog-post + product 404s shipped an unconditional `new Response(html,
    // { status: 404, ... })` that returned the full body on a crawler HEAD.
    // The detector matches the unconditional-body 404 Response shape in
    // worker/; every shipped 404 now carries the HEAD guard, so the clean tree
    // is unflagged and a regression to the bare-body form re-opens the class.
    id: "edge-404-response-body-on-head",
    bugClassDeclared: true,
    primitive: "an edge 404 Response must guard its body on a HEAD request — `new Response(request.method === \"HEAD\" ? null : html, { status: 404, ... })` — so a HEAD to a missing blog post / product / page returns the 404 status + headers with no body (a HEAD response carries no message body per the HTTP spec, and a crawler HEAD-probing dead links shouldn't be shipped a full rendered 404 body); never `new Response(html, { status: 404, ... })` with the body sent unconditionally",
    // The 404 Response spans lines (`new Response(html, {\n  status: 404`), so
    // this is a whole-file (multiline) scan, not a per-line one.
    regex: /new Response\(\s*html,\s*\{\s*status:\s*404\b/,
    multiline: true,
    scanScope: "worker",
    allowlist: [],
    reason: "The edge renders its own 404 inline (no container hop) for a missing blog post, product, or CMS page — a short-TTL cacheable `status: 404` so a crawler hitting many stale slugs doesn't re-render each, with `must-revalidate` so the answer flips back to a real page once the resource returns. A HEAD request to a missing resource must get that 404 status + headers with NO body: the HTTP spec says a response to HEAD carries no message body, and a well-behaved crawler HEAD-probes dead links to check for 404s — shipping it a full rendered 404 body wastes bytes on every probe. The page-404 (`_edgePage`) and empty-cart paths already guarded the body with `request.method === \"HEAD\" ? null : html`; the blog-post (`_edgeBlogArticle`) and product (`_edgeProduct`) 404s shipped an unconditional `new Response(html, { status: 404, ... })` that returned the body on HEAD. The fix applies the same `request.method === \"HEAD\" ? null : html` guard to both, keeping the 404 status + headers. The detector matches the unconditional-body 404 Response shape (`new Response(html, { status: 404`) in worker/; every shipped edge 404 now passes `request.method === \"HEAD\" ? null : html` as the body, so the clean tree carries no match, and a regression to the bare-body form re-opens the class and trips this.",
  },
  {
    // The admin customer-segments create/edit form translator must shape the
    // segment's `rules` object by coercing each numeric RFM field through the
    // strict integer reader and hand the typed bag to defineSegment / update,
    // which own validation (unknown rule key, bad integer, bps cap, min ≤ max
    // coherence, the "at least one rule" floor). It must NEVER build a
    // rules_json blob and persist it straight from the body — that would
    // bypass the primitive's validator, letting a malformed / unknown / empty
    // rule reach the customer_segments table unchecked (a silently-empty
    // segment, or a 500 on a later evaluate). The browser form is constrained
    // to the numeric fields, but a JSON API client is not, so the validation
    // has to live in the primitive the translator composes, not in the form.
    id: "segment-rules-form-without-primitive-validation",
    bugClassDeclared: true,
    primitive: "the admin customer-segments form translator `_segmentRules(body)` must coerce each numeric RFM field with `_strictMinorInt(...)` and pass the resulting `rules` object to customerSegments.defineSegment / update (which validate every rule key + value and throw a TypeError the route maps to a clean 400) — it must never assemble a rules_json string from the body and write it directly, which would bypass the primitive's validator and let a malformed / unknown / empty rule reach the customer_segments table unchecked",
    regex: /function _segmentRules\b/,
    scanScope: "lib",
    requires: /_strictMinorInt\s*\(\s*body\[/,
    allowlist: [],
    reason: "`_segmentRules` translates the structured customer-segments create/edit form into the `rules` object the `customerSegments` primitive expects. Each console field (recency_days_max, frequency_orders_min, lifetime_orders_min/max, monetary_minor_min/max, aov_minor_min, refund_rate_bps_min/max) is optional; a blank field is omitted. The translator coerces every present field through `_strictMinorInt(body[k], \"customerSegments\", k)` (which refuses \"\", floats, and parseInt's loose \"12abc\" → 12) and hands the typed bag to `defineSegment({ slug, title, description, rules })` / `update(slug, { rules })`. The primitive's `_validateRules` then enforces the full discipline — only known rule keys, non-negative integers, the 10000-bps cap, min ≤ max coherence, and the \"at least one predicate\" floor — and throws a TypeError on any violation, which the create + edit routes map to a clean 400 (the browser path bounces to the form's err state, the bearer path to a problem-details 400). The risk if the translator regressed to building a `rules_json` string from the body and writing it straight (e.g. `JSON.stringify(body.rules)` into an INSERT, skipping defineSegment): the browser select is constrained to the numeric fields, but a JSON API client can post an unknown rule key, a non-integer value, or an empty rule set, and an unvalidated write would land a malformed / silently-empty segment in customer_segments — a segment that recompute populates with nobody, or that 500s a later evaluate(). The detector matches the `_segmentRules` definition and is exonerated only when the file coerces the numeric fields via `_strictMinorInt(body[...])`; dropping that composition (reaching for a raw rules_json passthrough) removes the required token and trips this.",
  },
  {
    // The admin per-note write routes under /admin/customers/:id/notes/:noteId
    // (edit / pin / unpin / archive / unarchive) mutate a customer note. A
    // note belongs to a customer, but the customerNotes update / pin / archive
    // primitives move a row by note id alone — they carry no notion of which
    // customer the operator is acting on — so every per-note write route MUST
    // first assert the note belongs to the path :id customer before mutating
    // it. Without that pairing an operator on customer A's screen could edit /
    // pin / retire customer B's note by guessing its id (an IDOR). The route
    // funnels every per-note write through `_noteBelongsToCustomer(noteId,
    // customerId)`, which loads via customerNotes.getNote and refuses the
    // mutation (clean 404 on a missing / cross-customer note, 400 on a
    // malformed id) unless `note.customer_id === customerId`. The detector
    // matches a per-note write-route path literal and is exonerated only when
    // the same file composes the ownership helper; a route that drops the
    // guard re-opens the IDOR and trips this.
    id: "customer-note-write-route-without-ownership-check",
    bugClassDeclared: true,
    primitive: "every admin per-note write route under `/admin/customers/:id/notes/:noteId/...` (edit / pin / unpin / archive / unarchive) must first assert the note belongs to the path :id customer via `_noteBelongsToCustomer(req.params.noteId, c.id)` (loads through customerNotes.getNote, returns false unless `note.customer_id === c.id` → clean 404 on a missing / cross-customer note, 400 on a malformed id) before customerNotes.updateNote / pinNote / archiveNote — the note primitive mutates by note id alone, so skipping the ownership check lets an operator on one customer's screen edit / pin / retire another customer's note by id (IDOR)",
    regex: /["']\/admin\/customers\/:id\/notes\/:noteId\/(?:edit|pin|unpin|archive|unarchive)["']/,
    scanScope: "lib",
    requires: /_noteBelongsToCustomer\s*\(/,
    allowlist: [],
    reason: "The customer-detail screen (/admin/customers/:id) carries the full customer-note lifecycle: add, then edit / pin / unpin / archive / unarchive each note. A customer note stores `customer_id` on its row, but the customerNotes update / pin / archive methods take a note id alone — they have no notion of the requesting customer — so the route owns the ownership decision. Every per-note write route registers under `/admin/customers/:id/notes/:noteId/...` and funnels through `_noteBelongsToCustomer(req.params.noteId, c.id)`, which loads the note via customerNotes.getNote and refuses the mutation unless `note.customer_id === c.id`: a malformed note id throws a TypeError inside getNote's UUID guard → a clean 400, a well-formed unknown id (or a note owned by a DIFFERENT customer) returns null / false → a clean 404, with nothing written either way. Without that match an operator viewing customer A could POST customer B's note id to the edit / pin / archive route and mutate a note that isn't on the screen they're acting from. The detector matches a per-note write-route path literal (`/admin/customers/:id/notes/:noteId/edit|pin|unpin|archive|unarchive`) and is exonerated only when the same file composes `_noteBelongsToCustomer(...)`; a route that drops the ownership gate re-opens the IDOR and trips this. The add route (`/admin/customers/:id/notes`, no :noteId) attaches a fresh note to the path customer and carries no cross-customer surface, so it isn't matched.",
  },
  {
    // The storefront pre-order reserve route (`POST /products/:slug/preorder`)
    // writes a reservation pinned to a customer. A reservation is the holder's
    // claim on a not-yet-released unit (and the row the launch flow later
    // converts into THAT customer's order), so the owning customer_id MUST come
    // from the signed-in session (`auth.customer_id`), NEVER from a request body
    // or query field. Reading the owner from the body would let any signed-in
    // shopper (or a forged guest POST) reserve a unit AS another customer —
    // landing a reservation, and at launch an order, against an account that
    // isn't theirs (a reservation-spoofing / cross-account write). The detector
    // matches a `preorder.reserve(` call in lib and is exonerated only when the
    // same file pins the reservation to `auth.customer_id`; a route that sourced
    // the customer id from the body/query would not carry that pin and trips
    // this.
    id: "preorder-reserve-route-without-session-customer-pin",
    bugClassDeclared: true,
    primitive: "the storefront pre-order reserve route (`POST /products/:slug/preorder`) must pin the reservation to the SIGNED-IN SESSION customer — `preorder.reserve({ campaign_slug, customer_id: auth.customer_id, quantity })` with `auth` resolved from the session via `_currentCustomer(req)`, NEVER a `customer_id` read from the request body/query — so a shopper can only ever reserve (and at launch convert into an order) under their own account; sourcing the owner from the body would let any signed-in shopper reserve a unit as another customer (cross-account write)",
    // The primary match is any `preorder.reserve(` call; the `requires`
    // exoneration ties the SESSION pin to THIS call (the `customer_id:
    // auth.customer_id` field inside the same reserve(...) object, within a
    // bounded window) — a file-wide `auth.customer_id` elsewhere can't
    // exonerate a reserve that sourced its owner from the body. multiline so
    // the object literal can span lines.
    regex: /\bpreorder\.reserve\s*\(/,
    scanScope: "lib",
    multiline: true,
    requires: /preorder\.reserve\s*\(\s*\{[\s\S]{0,200}?customer_id\s*:\s*auth\.customer_id\b/,
    allowlist: [],
    reason: "The storefront pre-order reserve route (`POST /products/:slug/preorder`) is auth-gated (a guest 303s to /account/login) and resolves the reserving customer from the sealed session via `_currentCustomer(req)`. The reservation row carries `customer_id` as its ownership key — it's the claim a `/account/preorders` cancel is scoped against, and the account the launch-time `convertReservationToOrder` pins the resulting order to. So the owner MUST be the session customer (`auth.customer_id`); the route resolves the campaign from the product's lead SKU (not a client-supplied slug) and forwards ONLY the session id as `customer_id`. If the route instead read `customer_id` from `req.body` / the query, any signed-in shopper could POST another customer's id and land a reservation — and, at launch, a real order — against an account that isn't theirs. The detector matches a `preorder.reserve(` call in lib and is exonerated only when the same file pins `customer_id: auth.customer_id`; a route that sourced the owner from the request body/query would drop that pin and trip this. (The cancel route is independently ownership-scoped: `_ownedReservation` refuses a reservation whose `customer_id !== auth.customer_id` with a clean 404 before cancelReservation.)",
  },
  {
    // A share / public URL must be built from the request ORIGIN —
    // `new URL(_requestUrls(req).canonical_url).origin` — never by
    // trimming the path off the canonical URL with a path-stripping
    // `.replace(/\/some\/path.*$/, "")`. The canonical URL names the
    // page the request landed on; a POST that lands on a DIFFERENT path
    // than the share link points at (the wishlist-share create POST
    // lands on /wishlist/share, the registry view lands on
    // /account/registry/:slug) mangles the trimmed base, producing a
    // broken link. The same path-trim bug surfaced first on the wishlist
    // share link, then again on the gift-registry share link; both now
    // take the origin form. This detector forbids re-deriving an origin
    // by path-stripping a canonical/url value.
    id: "share-url-from-canonical-path-trim",
    bugClassDeclared: true,
    primitive: "build a share / public URL from the request origin via `new URL(_requestUrls(req).canonical_url).origin` — never derive a base/origin by trimming the path off the canonical URL with a path-stripping `.replace(/\\/<path>...$/, \"\")`; the canonical names the page the request LANDED on, so trimming a path that the request didn't land on mangles the link (a POST that handles a share action lands on a different path than the share link points at)",
    // Matches a path-stripping `.replace(/\/<path-with-a-real-label>...$/, "")`
    // applied to a canonical_url / canonicalUrl value (within a small
    // window). The regex body requires a real path char (letter / dot /
    // star) between the leading escaped slash and the `$` anchor, so a
    // legitimate trailing-slash trim (`.replace(/\/$/, "")` /
    // `.replace(/\/+$/, "")`) on a base URL is NOT matched — only a
    // path-stripping body (`/\/account\/wishlist.*$/`, `/\/.*$/`).
    regex: /\bcanonical_?[uU]rl\b[\s\S]{0,40}?\.replace\s*\(\s*\/\\?\/[^,]*[A-Za-z.*][^,]*\$\/[a-z]*\s*,\s*["']["']\s*\)/,
    scanScope: "lib",
    multiline: true,
    allowlist: [],
    reason: "A one-time wishlist share link (and later a gift-registry share link) was built by trimming the route path off the canonical URL — `_requestUrls(req).canonical_url.replace(/\\/account\\/wishlist.*$/, \"\")` — to recover the site origin, then concatenating the share path. That trim assumes the request landed on the page the share link points at, but the wishlist-share create POST lands on `/wishlist/share` (and the registry share URL is built while serving `/account/registry/:slug`), so the regex stripped the wrong prefix and produced a broken absolute URL — and the token is shown only once. The correct derivation is `new URL(_requestUrls(req).canonical_url).origin`, which yields the scheme + host independent of which path the request landed on. The detector forbids deriving an origin by path-stripping a canonical/url value with a `.replace(/\\/<path>...$/, \"\")`; a legitimate trailing-slash trim on a base URL carries no path label in the stripped body and is not matched.",
  },
  {
    // child_process spawn / spawnSync passing an ARGS ARRAY together
    // with `shell: true` is deprecated (Node DEP0190): with a shell the
    // args array is concatenated onto the command line WITHOUT
    // shell-escaping, so a token with a space / metacharacter is
    // mis-split or injected. When a shell is genuinely needed (a Windows
    // .cmd shim — npm / npx / bash), build ONE per-token-quoted command
    // STRING and pass NO args array; native executables spawn directly
    // with `shell: false` and the args array.
    id: "spawn-shell-true-with-args-array",
    bugClassDeclared: true,
    primitive: "never call spawn / spawnSync with an args ARRAY and `shell: true` together (Node DEP0190 — the array is concatenated onto the command line unescaped). When a shell is needed, build one per-token-quoted command STRING and pass no args array; otherwise pass the args array with `shell: false`",
    // Matches a spawn/spawnSync call whose SECOND positional argument is
    // an array literal `[...]` or a bare identifier (the args), then a
    // top-level comma, then (within a bounded window) `shell: true`. The
    // shell-needed-string form `spawnSync(line, Object.assign(..., {
    // shell: true }))` is the 2-arg shape (command string + options) —
    // its second arg is `Object.assign(...)` (not an array / bare
    // identifier followed by a comma), so it is NOT matched; the native
    // form `spawnSync(cmd, args, { ... shell: false })` carries
    // `shell: false`, also not matched.
    regex: /\bspawn(?:Sync)?\s*\(\s*[^,()]+,\s*(?:\[[^\]]*\]|[A-Za-z_$][\w$.]*)\s*,[\s\S]{0,300}?shell\s*:\s*true\b/,
    scanScope: "scripts",
    multiline: true,
    allowlist: [],
    reason: "Release tooling spawned a Windows .cmd shim (npm / npx / bash) via `spawnSync(cmd, args, { ... shell: true })` — an args array AND `shell: true`. Node 20+ deprecates that combination (DEP0190): with a shell the args array is appended to the command line with no shell-escaping, so an argument containing a space or a shell metacharacter is mis-split or injected, and Node prints a deprecation warning. The single spawn helper now branches: when the command needs a shell it builds one command STRING with every token quoted and passes NO args array (`spawnSync(line, { shell: true })`); a native executable spawns directly with the args array and `shell: false`. The detector flags any spawn / spawnSync call whose second positional argument is an array literal or a bare identifier (the args) followed by another argument carrying `shell: true`; the shell-needed string form and the `shell: false` native form are both spared.",
  },
  {
    // A list method whose `next_cursor` is rendered as a user-facing
    // Next / More link must PEEK one row beyond the page (fetch
    // `limit + 1`, set `hasMore = fetched.length > limit`) and emit the
    // cursor only when `hasMore` — NOT key the cursor off
    // `rows.length === limit`, which advertises a phantom next page when
    // the total is an exact multiple of the limit, so the final full
    // page links to an empty one. The four detectors below lock the peek
    // into exactly the list methods whose cursor surfaces in a rendered
    // Next / More control (customer orders "Load more", loyalty +
    // store-credit "Older activity", admin customers "Next page"). The
    // many other `rows.length === limit` cursor sites feed an API / JSON
    // / internal consumer that handles a maybe-empty next page correctly,
    // so they are idiomatic and out of scope; the storefront collection
    // page is locked separately by collection-route-without-cursor-
    // pagination. `requires` is the whole-file peek token, which lives
    // only in the fixed method — a regression that drops the peek removes
    // it and trips the detector.
    id: "order-listforcustomer-cursor-without-peek",
    bugClassDeclared: true,
    primitive: "order.listForCustomer powers the storefront customer-orders \"Load more\" link, so its `next_cursor` must be emitted only after peeking one row past the page (fetch `limit + 1`, `hasMore = fetched.length > limit`) — keying it off `rows.length === limit` advertises a phantom next page when the order count is an exact multiple of the limit, and the \"Load more\" link then lands on an empty page",
    // Anchored on the file-unique ORDER_ORDER_KEY constant (only lib/order.js
    // names it) so the detector locks the customer-order list method without
    // sweeping every `ORDER BY updated_at` query in the catalog. `requires`
    // is the whole-file peek token, present only in the fixed method.
    regex: /\bORDER_ORDER_KEY\b/,
    scanScope: "lib",
    requires: /hasMore\s*=\s*[\w.]+\.length\s*>\s*limit/,
    allowlist: [],
    reason: "order.listForCustomer paginates the signed-in customer's order history (keyset on updated_at + id) and its `next_cursor` drives the storefront \"Load more orders\" link. Emitting the cursor whenever the page came back full (`rows.length === limit`) advertises a next page that does not exist when the order count is an exact multiple of the page size — following the link runs the keyset query past the last order and renders an empty page. The method fetches `limit + 1` rows, sets `hasMore = fetched.length > limit`, slices the page back to `limit` (so the peeked row is never hydrated or rendered), and emits the cursor only when `hasMore`. The detector anchors on the file-unique ORDER_ORDER_KEY constant (only lib/order.js names it) and is exonerated by the whole-file peek token `hasMore = <rows>.length > limit`; a regression that drops the peek and re-keys the cursor off `rows.length === limit` removes that token and trips this.",
  },
  {
    id: "customers-list-cursor-without-peek",
    bugClassDeclared: true,
    primitive: "customers.list powers the admin customer-roster \"Next page\" link, so its `next_cursor` must be emitted only after peeking one row past the page (fetch `limit + 1`, `hasMore = fetched.length > limit`) — keying it off `rows.length === limit` advertises a phantom next page when the roster size is an exact multiple of the limit, and the console's \"Next page\" link then lands on an empty page",
    // Anchored on the file-unique customers.list cursor-validation throw
    // (only lib/customers.js carries it; CUSTOMERS_ORDER_KEY alone also
    // appears in sales-reports.js, whose cursor is an internal export, so
    // the throw string is the precise file selector).
    regex: /customers\.list:\s*cursor must be an opaque/,
    scanScope: "lib",
    requires: /hasMore\s*=\s*[\w.]+\.length\s*>\s*limit/,
    allowlist: [],
    reason: "customers.list paginates the admin customer roster (keyset on created_at + id) and its `next_cursor` drives the console's \"Next page\" link. Emitting the cursor whenever the page came back full (`rows.length === limit`) advertises a next page that does not exist when the roster size is an exact multiple of the page size — the \"Next page\" link then renders an empty table. The method fetches `limit + 1` rows, sets `hasMore = fetched.length > limit`, slices the page back to `limit`, and emits the cursor only when `hasMore`. The detector anchors on the file-unique customers.list cursor-validation throw and is exonerated by the whole-file peek token `hasMore = <rows>.length > limit`; a regression that drops the peek removes that token and trips this.",
  },
  {
    id: "loyalty-history-cursor-without-peek",
    bugClassDeclared: true,
    primitive: "loyalty.history powers the storefront loyalty \"Older activity\" link, so its `next_cursor` must be emitted only after peeking one row past the page (fetch `limit + 1`, `hasMore = r.rows.length > limit`) — keying it off `rows.length === limit` advertises a phantom next page when the transaction count is an exact multiple of the limit, and the \"Older activity\" link then lands on an empty page",
    // Anchored on the file-unique loyalty.history limit-validation throw
    // (only lib/loyalty.js carries it) so the detector targets exactly the
    // customer-facing history method.
    regex: /loyalty\.history:\s*limit must be/,
    scanScope: "lib",
    requires: /hasMore\s*=\s*[\w.]+\.length\s*>\s*limit/,
    allowlist: [],
    reason: "loyalty.history paginates the customer's loyalty-transaction ledger (newest first, cursor on occurred_at) and its `next_cursor` drives the storefront \"Older activity\" link on /account/loyalty. Emitting the cursor whenever the page came back full (`rows.length === limit`) advertises a next page that does not exist when the history length is an exact multiple of the page size — following the cursor queries `occurred_at < <oldest>` and renders an empty page. The method fetches `limit + 1` rows, sets `hasMore = r.rows.length > limit`, slices the page back to `limit`, and emits the cursor only when `hasMore`. The detector anchors on the file-unique loyalty.history limit-validation throw and is exonerated by the whole-file peek token `hasMore = <rows>.length > limit`; a regression that drops the peek removes that token and trips this.",
  },
  {
    id: "store-credit-history-cursor-without-peek",
    bugClassDeclared: true,
    primitive: "storeCredit.history powers the storefront store-credit \"Older activity\" link, so its `next_cursor` must be emitted only after peeking one row past the page (fetch `limit + 1`, `hasMore = r.rows.length > limit`) — keying it off `rows.length === limit` advertises a phantom next page when the ledger length is an exact multiple of the limit, and the \"Older activity\" link then lands on an empty page",
    // Anchored on the file-unique storeCredit.history input-validation
    // throw (only lib/store-credit.js carries it) so the detector targets
    // exactly the customer-facing ledger-history method.
    regex: /storeCredit\.history:\s*input object required/,
    scanScope: "lib",
    requires: /hasMore\s*=\s*[\w.]+\.length\s*>\s*limit/,
    allowlist: [],
    reason: "storeCredit.history paginates the customer's store-credit ledger (newest first, cursor on occurred_at) and its `next_cursor` drives the storefront \"Older activity\" link on /account/credit. Emitting the cursor whenever the page came back full (`rows.length === limit`) advertises a next page that does not exist when the ledger length is an exact multiple of the page size — following the cursor queries `occurred_at < <oldest>` and renders an empty page. The method fetches `limit + 1` rows, sets `hasMore = r.rows.length > limit`, slices the page back to `limit`, and emits the cursor only when `hasMore`. The detector anchors on the file-unique storeCredit.history input-validation throw and is exonerated by the whole-file peek token `hasMore = <rows>.length > limit`; a regression that drops the peek removes that token and trips this.",
  },
  {
    // The admin return-label issuance route records an operator-funded prepaid
    // return label against an approved return. The return-labels primitive
    // (returnLabels.issueLabel) owns ALL of the validation that keeps the
    // label safe + the customer download surface honest: the carrier /
    // service_level / tracking_number bounds + control-byte refusal, the
    // weight + cost integer shapes, the ISO-4217 currency check, the
    // approved-only RMA-status refusal, and — the load-bearing one — the
    // HTTPS-only label_url gate (b.safeUrl, which rejects a javascript: /
    // credentialed / non-https target). The storefront's /account/returns/:id
    // /label download redirects the shopper straight at that stored
    // label_url, so a route that hand-rolled an `INSERT INTO return_labels`
    // instead of composing issueLabel could land an unvalidated label_url in
    // the column and turn the customer download into an open redirect /
    // scheme-injection sink. The detector matches the POST
    // /admin/returns/:id/label issuance route and is exonerated only when the
    // same file composes returnLabels.issueLabel; a route that builds the
    // label row by hand re-opens the class.
    id: "admin-return-label-issue-without-primitive",
    bugClassDeclared: true,
    primitive: "the admin POST /admin/returns/:id/label issuance route must compose `returnLabels.issueLabel({ return_id, carrier, service_level, weight_grams, label_url, tracking_number, cost_minor, currency })` — the primitive owns every validation gate (carrier/service/tracking bounds, weight/cost integer shapes, ISO-4217 currency, the approved-only RMA-status refusal, and the HTTPS-only label_url check via b.safeUrl), and the storefront download route redirects the shopper at the stored label_url, so a hand-rolled INSERT INTO return_labels could land an unvalidated label_url (javascript: / non-https / credentialed) and turn the customer download into a scheme-injection / open-redirect sink",
    // Match the issuance route registration (the tracking-update routes carry
    // a further /label/<verb> path segment and aren't matched). Anchored with
    // a closing quote so /label/shipped etc. don't match.
    regex: /router\.post\(\s*["']\/admin\/returns\/:id\/label["']/,
    scanScope: "lib",
    requires: /returnLabels\.issueLabel\s*\(/,
    allowlist: [],
    reason: "POST /admin/returns/:id/label lets an operator record a prepaid return-shipping label against an approved return from the console. The return-labels primitive's issueLabel is the single validation funnel: it bounds the carrier / service_level / tracking_number (length + control-byte refusal), demands a positive-integer weight_grams + a non-negative cost_minor, checks the currency against the ISO-4217 shape, refuses unless the underlying return_authorizations row is in `approved` status (a pending/rejected/received claim must never consume operator postage), and runs label_url through b.safeUrl (ALLOW_HTTP_TLS) so a javascript: / data: / credentialed / non-https target is rejected before it ever reaches the return_labels.label_url column. The customer surface (GET /account/returns/:id/label) redirects the shopper straight at that stored label_url, so the column is a redirect target — a route that built the row with a hand-rolled `INSERT INTO return_labels (...) VALUES (...)` instead of composing issueLabel would bypass the scheme gate and the approved-only rule, turning the shopper download into a scheme-injection / open-redirect sink and letting a label be funded against an un-triaged claim. The detector matches the issuance route registration and is exonerated only when the same file composes `returnLabels.issueLabel(...)`; a route that hand-rolls the label insert re-opens the class. The tracking-update routes (/admin/returns/:id/label/shipped|in-transit|delivered|exception) carry a further path segment so they aren't matched, and they compose the primitive's mark-* methods for the same reason.",
  },
  {
    // The admin order-export download route streams the full row-level
    // order set for a date range to a CSV / NDJSON file. The cell content
    // includes customer-controlled free text — the shipping-address fields
    // (line1 / line2 / city / region) sourced from the order's ship_to_json
    // — which is exactly the OWASP "CSV Injection" vector: a cell beginning
    // with = / + / - / @ executes as a formula when the file is opened in
    // Excel or Sheets. The orderExport primitive's csvForRange owns that
    // defense (it RFC-4180-quotes every cell AND prefixes a leading
    // metacharacter with `'`, exempting signed numerics like +15.00), so
    // the download route MUST compose csvForRange / ndjsonForRange and
    // never hand-roll the serialization from raw order fields. A route that
    // assembled the CSV itself (a manual header join + per-row cell
    // concatenation, or b.csv.stringify fed straight from the unprojected
    // order rows) would bypass the formula-injection neutralization and
    // ship a spreadsheet that runs an attacker's formula on the operator's
    // machine. The detector matches the /admin/exports/download route
    // registration and is exonerated only when the same file composes the
    // injection-safe primitive (csvForRange / ndjsonForRange).
    id: "admin-order-export-download-without-primitive",
    bugClassDeclared: true,
    primitive: "the admin GET /admin/exports/download route must stream the orderExport primitive's csvForRange / ndjsonForRange output — the primitive RFC-4180-quotes every cell AND neutralizes the spreadsheet-formula-injection vector via the shared b.guardCsv.escapeCell (a cell whose leading char is any formula trigger — = / + / - / @ / tab / CR / LF / pipe or a full-width variant — is prefixed with a TAB so the spreadsheet treats it as text), and the order rows carry customer-controlled free text (the ship_to_json shipping-address fields), so a route that hand-rolled the CSV from raw order fields would ship a formula-injection sink an operator opens in Excel / Sheets",
    // Match the download route registration. The export screen + the
    // dedicated /download route both register under /admin/exports/download.
    regex: /router\.get\(\s*["']\/admin\/exports\/download["']/,
    scanScope: "lib",
    requires: /orderExport\.(?:csvForRange|ndjsonForRange)\s*\(/,
    allowlist: [],
    reason: "GET /admin/exports/download lets an operator pull the full row-level order set for a date range as a CSV or NDJSON file. The exported cells include customer-controlled free text — the shipping-address fields (line1 / line2 / city / region) the order-export projection reads out of ship_to_json — so the output is squarely in the OWASP CSV-injection threat model: a cell beginning with = / + / - / @ (or a tab / CR / LF / pipe) is interpreted as a formula when the file is opened in a spreadsheet, executing attacker-chosen content on the operator's machine. The orderExport primitive's csvForRange is the single safe funnel: it wraps every cell in RFC-4180 quotes AND runs every cell through the shared b.guardCsv.escapeCell, which prefixes any cell with a dangerous leading metacharacter with a TAB so the spreadsheet treats it as literal text (signed numerics like +15.00 / -3.50 are prefixed too — the safe OWASP posture, since `-2+3+cmd|…` begins like an amount). ndjsonForRange has no spreadsheet-formula surface but shares the same projection. A download route that hand-rolled the serialization — building the header + rows by hand, or feeding the unprojected order rows straight into b.csv.stringify — would bypass the formula-injection neutralization and turn a routine export into a code-execution vector for whoever opens the file. The detector matches the /admin/exports/download route registration and is exonerated only when the same file composes orderExport.csvForRange / orderExport.ndjsonForRange; a route that hand-rolls the CSV re-opens the class.",
  },
  {
    // The order-ratings render path (the customer order page's rating
    // display + the admin moderation queue's rating cards) shows two pieces
    // of customer/operator free text: the rating COMMENT a customer typed
    // and the operator's public REPLY. Both reach the page un-trusted. The
    // order-ratings primitive already exposes PRE-ESCAPED forms of each —
    // `comment_html` and `response_html`, run through b.template.escapeHtml
    // at the primitive's render layer — alongside the raw `comment` /
    // `response_text` (the latter exist for export / analytics consumers
    // that want the original bytes). The render layer MUST splice the
    // pre-escaped `_html` fields; splicing the RAW `comment` / `response_text`
    // straight into the HTML concatenation re-introduces stored XSS (a
    // customer types `<script>…</script>` / `"><img onerror=…>` as their
    // comment, and it executes on the order page + the operator's moderation
    // screen). The detector matches a raw `.comment` (NOT `.comment_html` /
    // `.comment_flagged`) or `.response_text` field adjacent to a string-
    // concatenation `+` — the HTML-build shape; the shipped renderers splice
    // only `.comment_html` / `.response_html`, and the raw fields appear only
    // as object-property reads (the submitRating input, never `+`-adjacent),
    // so the clean tree carries no match and a regression to the raw field
    // trips this.
    id: "order-rating-render-raw-comment-not-escaped-html",
    bugClassDeclared: true,
    primitive: "render the order-rating comment + operator reply from the primitive's PRE-ESCAPED `comment_html` / `response_html` fields (escaped via b.template.escapeHtml at the primitive's render layer), NEVER the raw `comment` / `response_text` — splicing the raw customer/operator free text into the HTML concatenation re-introduces stored XSS on the customer order page + the admin moderation screen; the raw fields exist only for export/analytics consumers and must never reach an HTML sink",
    regex: /(?:\+\s*\w+\.(?:comment(?!_)|response_text)\b|\w+\.(?:comment(?!_)|response_text)\b\s*\+)/,
    scanScope: "shop",
    allowlist: [],
    reason: "The order-ratings feature renders two pieces of un-trusted free text to a page: the COMMENT a customer left on their order rating, and the operator's public REPLY. Both are stored verbatim (the primitive refuses control bytes but keeps the original characters, so a `<script>`/`onerror` payload survives to the read). The order-ratings primitive's decode step exposes a PRE-ESCAPED form of each — `comment_html` and `response_html`, each `b.template.escapeHtml(raw)` — next to the raw `comment` / `response_text` (raw retained for the export / analytics path). The customer order page (lib/storefront.js `_orderRatingDisplay`) and the admin moderation queue (lib/admin.js `_ratingCard`) BOTH splice the `_html` fields into their markup and never touch the raw fields, so the customer's typed payload renders inert. A renderer that spliced the raw `comment` / `response_text` straight into the HTML concatenation (`\"<p>\" + rating.comment + \"</p>\"`) would re-open stored XSS — the payload executes on the order page the customer revisits AND on the operator's moderation screen. The detector matches a raw `.comment` (negative-lookahead excludes `comment_html` / `comment_flagged`) or `.response_text` field adjacent to a string-concatenation `+` (the HTML-build shape); the raw fields legitimately appear elsewhere only as object-property reads (the submitRating call's `comment:` input, the `typeof body.comment` shape check) which are never `+`-adjacent, so the clean tree is unflagged and a regression to splicing the raw field trips this. Re-escaping the already-escaped `_html` field is the opposite, harmless mistake (visible entities, no XSS) and is out of scope.",
  },
];

// ---- expand existing detector scopes to include worker/ ----------------
//
// The four detectors below were originally `lib`-scoped because the
// Worker substrate didn't exist yet. Now that `worker/` ships
// operator-facing code, the same hygiene rules apply.
KNOWN_ANTIPATTERNS.forEach(function (ap) {
  if (ap.scanScope === "lib" && (
        ap.id === "console-direct" ||
        ap.id === "math-random" ||
        ap.id === "todo-fixme-hack-xxx" ||
        ap.id === "empty-catch-swallow"
      )) {
    ap.scanScope = "shop";
  }
});

function _check(antipattern) {
  var raw = _scan(antipattern.regex, antipattern.scanScope || "lib", {
    multiline: !!antipattern.multiline,
    matchOn:   antipattern.matchOn,
  });
  var afterMarkers = _filterMarkers(raw, antipattern.id);
  var allowSet = (antipattern.allowlist || []).reduce(function (acc, p) { acc[p] = true; return acc; }, {});
  var afterAllow = afterMarkers.filter(function (m) { return !allowSet[m.file]; });
  // Optional `requires` — a whole-file regex that, if matched anywhere
  // in the same file as the primary hit, exonerates the hit. Used
  // when the call shape is correct only when paired with a bounding
  // opt elsewhere (e.g. `zlib.gunzipSync(...)` paired with
  // `maxOutputLength: <const>` somewhere in the same module).
  if (antipattern.requires) {
    var fileContents = {};
    return afterAllow.filter(function (m) {
      if (fileContents[m.file] === undefined) {
        try {
          fileContents[m.file] = fs.readFileSync(
            path.resolve(path.resolve(__dirname, "..", ".."), m.file), "utf8"
          );
        } catch (_e) { fileContents[m.file] = ""; }
      }
      return !antipattern.requires.test(fileContents[m.file]);
    });
  }
  return afterAllow;
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
    var headline = fail.ap.primitive || fail.ap.description || "";
    console.error("[" + fail.ap.id + "] " + headline);
    if (fail.ap.reason) console.error("  " + fail.ap.reason);
    for (var h = 0; h < Math.min(fail.hits.length, 8); h += 1) {
      console.error("  " + fail.hits[h].file + ":" + fail.hits[h].line + ":  " + fail.hits[h].content);
    }
    if (fail.hits.length > 8) {
      console.error("  ... and " + (fail.hits.length - 8) + " more");
    }
  }
  process.exit(1);
}

// `KNOWN_ANTIPATTERNS` is exported so the release-time coverage verifier
// (`scripts/gate-contract.js`) can enumerate the detector ids and assert
// every declared preventable bug-class still maps to a live detector
// (and that every `bugClassDeclared` detector is declared in the
// coverage registry). Requiring this module is side-effect-free when
// `require.main !== module` — the heap-ceiling self-spawn at the top is
// a no-op off the entry point, and `run()` only fires on direct
// invocation.
module.exports = { run: run, KNOWN_ANTIPATTERNS: KNOWN_ANTIPATTERNS };

if (require.main === module) run();
