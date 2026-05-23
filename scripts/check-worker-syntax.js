"use strict";
/**
 * Network-free worker-syntax check. The smoke runner shells out to
 * this script in place of `npx esbuild worker/index.js`. Node's
 * `--check` tolerates a missing trailing `}` (parser bug-class that
 * shipped in v0.0.95 / v0.0.97 and broke the wrangler bundle); this
 * walker reads the worker entry char by char tracking string /
 * template / comment state and asserts balanced braces / parens /
 * brackets at EOF.
 *
 * Single-file scope: walks `worker/*.js` reachable from the entry
 * (one-deep — the static `import` lines at the top of each file are
 * parsed to find the next file to scan). The set is small (~12 files
 * at the time of writing) so the walk is fast enough to run on every
 * smoke. No npm registry dependency.
 *
 *   node scripts/check-worker-syntax.js
 *
 * Exits 0 on balanced; 1 with file + line + reason on imbalance.
 */

var fs   = require("node:fs");
var path = require("node:path");

var ROOT_DIR = path.resolve(__dirname, "..");

function _scanFile(relPath) {
  var abs = path.resolve(ROOT_DIR, relPath);
  var s;
  try { s = fs.readFileSync(abs, "utf8"); }
  catch (e) { return { ok: false, reason: "read-failed: " + (e && e.message), file: relPath, line: 0 }; }

  var inSingle = false, inDouble = false, inTmpl = false;
  var inLine = false, inBlock = false;
  // Regex literal detection — `/` after a binary-operator-like token
  // opens a regex. We track the last meaningful token via a small
  // state machine. False positives are acceptable: a misclassified
  // division won't introduce imbalance because the regex body is
  // skipped as a single token either way.
  var inRegex = false;
  var lastNonWs = "";
  var braces = 0, parens = 0, brackets = 0, line = 1;
  // Stack of opens with their lines for actionable error messages.
  var stack = [];

  for (var i = 0; i < s.length; i++) {
    var c = s[i], n = s[i + 1];
    if (c === "\n") { line++; if (inLine) inLine = false; continue; }
    if (inLine || inBlock) {
      if (inBlock && c === "*" && n === "/") { inBlock = false; i++; }
      continue;
    }
    if (inSingle) { if (c === "\\") i++; else if (c === "'") inSingle = false; continue; }
    if (inDouble) { if (c === "\\") i++; else if (c === "\"") inDouble = false; continue; }
    if (inTmpl)   { if (c === "\\") i++; else if (c === "`") inTmpl = false; continue; }
    if (inRegex)  {
      // Track char-class state inside the regex so a `/` between `[ ]`
      // doesn't close the literal early. `[`s inside a char class
      // don't count as code brackets; the walker stays opaque to
      // regex internals while inRegex is true.
      if (c === "\\") { i++; continue; }
      if (c === "[" && !inRegex.inCharClass) { inRegex = { inCharClass: true }; continue; }
      if (c === "]" && inRegex && inRegex.inCharClass) { inRegex = true; continue; }
      if (c === "/" && (inRegex === true || !inRegex.inCharClass)) { inRegex = false; }
      continue;
    }
    if (c === "/" && n === "/") { inLine = true; i++; continue; }
    if (c === "/" && n === "*") { inBlock = true; i++; continue; }
    if (c === "'") { inSingle = true; lastNonWs = c; continue; }
    if (c === "\"") { inDouble = true; lastNonWs = c; continue; }
    if (c === "`") { inTmpl = true; lastNonWs = c; continue; }
    if (c === "/") {
      // Decide division vs regex from the last meaningful char.
      // Tokens that PRECEDE a regex literal: `(`, `,`, `=`, `:`,
      // `[`, `!`, `&`, `|`, `?`, `{`, `}` (after `}` is ambiguous —
      // could be end-of-block then `/` for regex; accepting the
      // false positive is fine), `;`, return / typeof / instanceof
      // / in / of (we approximate via empty / word-boundary checks).
      if (lastNonWs === "" || /[(,=:!&|?+\-*/{};]/.test(lastNonWs) || /[\s\n]/.test(lastNonWs)) {
        inRegex = { inCharClass: false };
        continue;
      }
    }
    if (c === "{") { braces++;   stack.push({ kind: "{", line: line }); lastNonWs = c; continue; }
    if (c === "}") { braces--;   if (stack.length && stack[stack.length - 1].kind === "{") stack.pop(); lastNonWs = c; continue; }
    if (c === "(") { parens++;   stack.push({ kind: "(", line: line }); lastNonWs = c; continue; }
    if (c === ")") { parens--;   if (stack.length && stack[stack.length - 1].kind === "(") stack.pop(); lastNonWs = c; continue; }
    if (c === "[") { brackets++; stack.push({ kind: "[", line: line }); lastNonWs = c; continue; }
    if (c === "]") { brackets--; if (stack.length && stack[stack.length - 1].kind === "[") stack.pop(); lastNonWs = c; continue; }
    if (!/\s/.test(c)) lastNonWs = c;
  }
  if (inSingle || inDouble || inTmpl || inBlock || inRegex) {
    return { ok: false, reason: "unterminated " + (inSingle ? "'" : inDouble ? "\"" : inTmpl ? "`" : inBlock ? "/* */" : "regex"), file: relPath, line: line };
  }
  if (braces !== 0 || parens !== 0 || brackets !== 0) {
    var last = stack.length ? stack[stack.length - 1] : null;
    return {
      ok:     false,
      reason: "imbalance braces=" + braces + " parens=" + parens + " brackets=" + brackets +
              (last ? " — opening `" + last.kind + "` at line " + last.line + " not closed" : ""),
      file:   relPath,
      line:   last ? last.line : line,
    };
  }
  return { ok: true };
}

// Walk import statements at the top of the entry file + each
// imported worker-local module. We only follow imports that live
// under `worker/` — vendor + npm package imports are out of scope.
function _findReachableWorkerFiles(entry) {
  var queue = [entry];
  var seen  = {};
  var out   = [];
  while (queue.length) {
    var rel = queue.shift();
    if (seen[rel]) continue;
    seen[rel] = true;
    out.push(rel);
    var abs;
    try { abs = path.resolve(ROOT_DIR, rel); } catch (_e) { continue; }
    var src;
    try { src = fs.readFileSync(abs, "utf8"); } catch (_e) { continue; }
    var lines = src.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/import\s+(?:[^"']*from\s+)?["']([^"']+)["']/);
      if (!m) continue;
      var spec = m[1];
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue;
      var resolved = path.relative(ROOT_DIR, path.resolve(path.dirname(abs), spec)).replace(/\\/g, "/");
      if (!resolved.startsWith("worker/")) continue;
      queue.push(resolved);
    }
  }
  return out;
}

var entry = process.argv[2] || "worker/index.js";
var files = _findReachableWorkerFiles(entry);
var failed = 0;
for (var i = 0; i < files.length; i++) {
  var r = _scanFile(files[i]);
  if (!r.ok) {
    failed++;
    console.error("[worker-syntax] FAIL — " + r.file + ":" + r.line + " — " + r.reason);
  }
}
if (failed > 0) {
  console.error("[worker-syntax] " + failed + " file(s) tripped");
  process.exit(1);
}
console.log("[worker-syntax] OK — " + files.length + " worker file(s) balanced");
