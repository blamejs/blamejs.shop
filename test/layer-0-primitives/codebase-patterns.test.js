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
  var raw = _scan(antipattern.regex, antipattern.scanScope || "lib", { multiline: !!antipattern.multiline });
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

module.exports = { run: run };

if (require.main === module) run();
