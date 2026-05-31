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

function _libFiles()    { return _walk(LIB_ROOT);    }
function _workerFiles() { return _walk(WORKER_ROOT); }
function _shopFiles()   { return _walk(LIB_ROOT).concat(_walk(WORKER_ROOT)); }
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
            : scope === "shop"      ? _shopFiles()
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
    regex:     /<form\b[^>\n]*?method=\\"post\\"[^>\n]*?action=\\"(?!(?:\/cart\/lines|\/cart\/bundle|\/wishlist\/toggle|\/compare\/toggle|\/consent|\/currency|\/newsletter|\/announcements\/))/i,
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
      "test/helpers/wait.js",
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
