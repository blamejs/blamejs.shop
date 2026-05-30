"use strict";
/**
 * textGuard — shop input-validation primitives over the framework's
 * codepoint catalog.
 *
 * Pure-function validators, no I/O, so this runs at the state layer
 * against the module directly. Dangerous codepoints are built from
 * escapes so the fixture source stays plain ASCII (no raw control /
 * bidi / zero-width bytes embedded in this file).
 *
 * Coverage:
 *   - currencyCode: accepts a catalog code, refuses lowercase / short /
 *     well-formed-but-absent ("ZZZ")
 *   - asciiUpperLetters: fixed-length A-Z, refuses anything else
 *   - slugLabel: lowercase slug shape, refuses leading / trailing /
 *     doubled hyphen + over-length, accepts a single char
 *   - hostLabel: refuses literal-IP loopback / link-local / metadata,
 *     by-name localhost (+ trailing dot) / *.internal; accepts a public
 *     host and normalizes brackets / trailing dot
 *   - freeText: refuses bidi override / null byte / C0 control by
 *     default; zero-width + mixed-script refused only under policy
 *   - catalog re-exports are the framework's own RegExp instances
 */

require("../../lib");                                                       // ensure entry-point loads + framework handle works
var textGuard = require("../../lib/text-guard");
var b         = require("../../lib/vendor/blamejs");
var helpers   = require("../helpers");
var check     = helpers.check;

// Dangerous codepoints assembled from escapes (plain-ASCII source):
//   U+202E RIGHT-TO-LEFT OVERRIDE (bidi), U+0000 NUL, U+0007 BEL
//   (C0 control), U+200B ZERO WIDTH SPACE, and a Cyrillic small letter
//   'u' (U+0443) inside an otherwise-Latin label (confusable).
var RLO        = String.fromCharCode(0x202E);
var NUL        = String.fromCharCode(0x0000);
var BEL        = String.fromCharCode(0x0007);
var ZWSP       = String.fromCharCode(0x200B);
var CYR_U      = String.fromCharCode(0x0443);
var BIDI       = "a" + RLO + "b";
var NULLBYTE   = "a" + NUL + "b";
var CONTROL    = "a" + BEL + "b";
var ZEROWIDTH  = "a" + ZWSP + "b";
var CONFUSABLE = "pa" + CYR_U + "pal";
var BIDI_CCY   = "U" + RLO + "D";

function _throws(fn) {
  try { fn(); return false; }
  catch (e) { return e instanceof TypeError; }
}

function _currencyCode() {
  check("currencyCode accepts USD", textGuard.currencyCode("USD") === "USD");
  check("currencyCode accepts a catalog code (EUR)", textGuard.currencyCode("EUR") === "EUR");
  check("currencyCode refuses lowercase usd", _throws(function () { textGuard.currencyCode("usd"); }));
  check("currencyCode refuses short US", _throws(function () { textGuard.currencyCode("US"); }));
  check("currencyCode refuses 4-letter USDX", _throws(function () { textGuard.currencyCode("USDX"); }));
  check("currencyCode refuses well-formed-but-absent ZZZ", _throws(function () { textGuard.currencyCode("ZZZ"); }));
  check("currencyCode refuses non-string", _throws(function () { textGuard.currencyCode(null); }));
  check("currencyCode refuses bidi-laden code", _throws(function () { textGuard.currencyCode(BIDI_CCY); }));
}

function _asciiUpperLetters() {
  check("asciiUpperLetters ABC ok", textGuard.asciiUpperLetters("ABC", "x") === "ABC");
  check("asciiUpperLetters refuses lowercase", _throws(function () { textGuard.asciiUpperLetters("abc", "x"); }));
  check("asciiUpperLetters refuses wrong length", _throws(function () { textGuard.asciiUpperLetters("AB", "x"); }));
  check("asciiUpperLetters honors n", textGuard.asciiUpperLetters("AB", "x", 2) === "AB");
  check("asciiUpperLetters refuses bad n", _throws(function () { textGuard.asciiUpperLetters("ABC", "x", 0); }));
}

function _slugLabel() {
  check("slugLabel my-product ok", textGuard.slugLabel("my-product", "s") === "my-product");
  check("slugLabel single char ok", textGuard.slugLabel("a", "s") === "a");
  check("slugLabel digit ok", textGuard.slugLabel("a1b2", "s") === "a1b2");
  check("slugLabel refuses leading hyphen", _throws(function () { textGuard.slugLabel("-bad", "s"); }));
  check("slugLabel refuses trailing hyphen", _throws(function () { textGuard.slugLabel("bad-", "s"); }));
  check("slugLabel refuses doubled hyphen", _throws(function () { textGuard.slugLabel("a--b", "s"); }));
  check("slugLabel refuses uppercase", _throws(function () { textGuard.slugLabel("Abc", "s"); }));
  check("slugLabel refuses empty", _throws(function () { textGuard.slugLabel("", "s"); }));
  check("slugLabel honors maxLen", _throws(function () { textGuard.slugLabel("abcdef", "s", { maxLen: 3 }); }));
}

function _hostLabel() {
  check("hostLabel accepts public host", textGuard.hostLabel("example.com") === "example.com");
  check("hostLabel normalizes uppercase + trailing dot", textGuard.hostLabel("Example.COM.") === "example.com");
  check("hostLabel refuses link-local metadata IP", _throws(function () { textGuard.hostLabel("169.254.169.254"); }));
  check("hostLabel refuses loopback IP", _throws(function () { textGuard.hostLabel("127.0.0.1"); }));
  check("hostLabel refuses private IP", _throws(function () { textGuard.hostLabel("10.0.0.5"); }));
  check("hostLabel refuses localhost", _throws(function () { textGuard.hostLabel("localhost"); }));
  check("hostLabel refuses localhost. (trailing dot)", _throws(function () { textGuard.hostLabel("localhost."); }));
  check("hostLabel refuses metadata.google.internal", _throws(function () { textGuard.hostLabel("metadata.google.internal"); }));
  check("hostLabel refuses *.internal", _throws(function () { textGuard.hostLabel("svc.internal"); }));
  check("hostLabel refuses bare internal", _throws(function () { textGuard.hostLabel("internal"); }));
  check("hostLabel refuses empty", _throws(function () { textGuard.hostLabel(""); }));
}

function _freeText() {
  check("freeText accepts plain text", textGuard.freeText("hello world", "n") === "hello world");
  check("freeText accepts unicode letters", textGuard.freeText("café 日本語", "n") === "café 日本語");
  check("freeText refuses bidi override by default", _throws(function () { textGuard.freeText(BIDI, "n"); }));
  check("freeText refuses null byte by default", _throws(function () { textGuard.freeText(NULLBYTE, "n"); }));
  check("freeText refuses C0 control by default", _throws(function () { textGuard.freeText(CONTROL, "n"); }));
  check("freeText allows zero-width by default", textGuard.freeText(ZEROWIDTH, "n") === ZEROWIDTH);
  check("freeText refuses zero-width under policy", _throws(function () { textGuard.freeText(ZEROWIDTH, "n", { zeroWidth: "reject" }); }));
  check("freeText allows mixed-script by default", textGuard.freeText(CONFUSABLE, "n") === CONFUSABLE);
  check("freeText refuses mixed-script under policy", _throws(function () { textGuard.freeText(CONFUSABLE, "n", { mixedScript: "reject" }); }));
  check("freeText mixed-script allowedScripts clears", textGuard.freeText(CONFUSABLE, "n", { mixedScript: "reject", allowedScripts: ["latin", "cyrillic"] }) === CONFUSABLE);
  check("freeText refuses non-string", _throws(function () { textGuard.freeText(42, "n"); }));
}

function _reExports() {
  // The catalog re-exports are the framework's own instances, so the
  // single source of truth for the codepoint tables stays the framework.
  var cc = require("../../lib/vendor/blamejs/lib/codepoint-class");
  check("BIDI_RE is the framework instance", textGuard.BIDI_RE === cc.BIDI_RE);
  check("C0_CTRL_RE is the framework instance", textGuard.C0_CTRL_RE === cc.C0_CTRL_RE);
  check("ZERO_WIDTH_RE is the framework instance", textGuard.ZERO_WIDTH_RE === cc.ZERO_WIDTH_RE);
  check("NULL_BYTE is the framework value", textGuard.NULL_BYTE === cc.NULL_BYTE);
  check("detectMixedScripts is the framework fn", textGuard.detectMixedScripts === cc.detectMixedScripts);
  // currencyCode composes the framework's live ISO 4217 catalog.
  check("currencyCode rides b.money.CURRENCIES", Object.prototype.hasOwnProperty.call(b.money.CURRENCIES, "USD"));
}

async function run() {
  _currencyCode();
  _asciiUpperLetters();
  _slugLabel();
  _hostLabel();
  _freeText();
  _reExports();
}

module.exports = { run: run };

if (require.main === module) {
  run().then(function () {
    console.log("ok - text-guard (" + helpers.getChecks() + " checks)");
  }).catch(function (err) {
    console.error("FAIL - text-guard: " + err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
}
