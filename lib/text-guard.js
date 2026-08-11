"use strict";
/**
 * @module shop.textGuard
 * @title  Shop input-validation primitives over the framework's codepoint catalog
 *
 * @intro
 *   One home for the cross-cutting string validators the shop's
 *   handlers reach for at the request boundary: the ISO 4217 currency
 *   code, the URL slug label, the outbound host label, and the
 *   dangerous-codepoint screen for unconstrained free text. Each was
 *   previously open-coded at several call sites with subtly different
 *   shapes; centralizing them keeps the discipline identical
 *   everywhere and gives the codebase one place to tighten.
 *
 *   The dangerous-codepoint surface (bidi overrides, C0 control bytes,
 *   null bytes, zero-width / invisible formatting, mixed-script
 *   confusables) is NOT reinvented here — it composes the framework's
 *   own codepoint catalog (`b.codepointClass`), the single source of
 *   truth the guard-* family already builds on, so the tables and
 *   regexes never drift into a second hand-maintained copy.
 *
 *   Validators THROW a `TypeError` on bad input. The admin / account
 *   request wrappers map a thrown `TypeError` to a clean 400, so a
 *   typo or a hostile value surfaces as a bad-request to the caller
 *   instead of a 500 — the validators are written to be called at the
 *   handler boundary, before the value reaches storage or an outbound
 *   dial.
 *
 *   Surface:
 *     - re-exports of the framework codepoint catalog (BIDI_RE,
 *       C0_CTRL_RE, ZERO_WIDTH_RE, NULL_BYTE, scriptFor,
 *       detectMixedScripts, detectCharThreats, assertNoCharThreats,
 *       applyCharStripPolicies) so consumers grab one import
 *     - asciiUpperLetters(s, label, n?) — fixed-length A-Z token
 *     - currencyCode(s, label?) — ISO 4217 shape + catalog membership
 *     - slugLabel(s, label, opts?) — lowercase URL-slug label
 *     - hostLabel(host, label?) — outbound host SSRF + by-name denylist
 *     - freeText(s, label, policy?) — dangerous-codepoint screen for
 *       unconstrained UTF-8 text fields, throwing on a refusal
 *     - hasCodepointThreat(s, policy?) — the same screen for a defensive
 *       reader that DROPS a bad value instead of refusing the request
 *     - firstCodepointThreat(s, policy?) — the one decision both run, so
 *       the throwing and dropping paths cannot disagree
 *
 * @primitive textGuard
 * @related   b.money, b.ssrfGuard, b.safeUrl, shop.currencyRounding,
 *            shop.webhooks, shop.webhookSubscriptions
 */

var b = require("./vendor/blamejs");

// The framework's codepoint catalog (bidi / control / null / zero-width
// tables + regexes, the script ranges, and the detect/assert/strip helpers
// the guard-* family composes), exposed on the public surface as
// b.codepointClass — so this composes a single source of truth instead of a
// second copy of the tables.
var codepointClass = b.codepointClass;

// Two invisible-codepoint groups this shop refuses that the framework catalog
// does not carry yet. Built with codepointClass.charClass off a range table so
// the escaping is the catalog's, not a second hand-spelled class:
//
//   U+007F DELETE — grouped with the C0 controls everywhere it matters, but
//     outside the 0x00-0x1F block the framework's C0_CTRL_RANGES covers.
//   U+2061-2064 FUNCTION APPLICATION / INVISIBLE TIMES / INVISIBLE SEPARATOR /
//     INVISIBLE PLUS — zero-width invisible operators, the same spoofing class
//     as U+2060 WORD JOINER, which the framework's ZERO_WIDTH_RANGES does have.
//
// Requested upstream (blamejs#580). When a vendor refresh lands them in the
// catalog this supplement becomes dead weight and comes out — the drift test
// in test/layer-1-state/text-guard.test.js fails the moment that happens, so
// it cannot be silently carried forever.
//
// Kept as two classes rather than one so each joins the check whose refusal
// message is already true of it.
// allow:dynamic-regex — codepoints from a literal range table
var DEL_RE = new RegExp("[" + codepointClass.charClass([0x007F]) + "]");
// allow:dynamic-regex — codepoints from a literal range table
var INVISIBLE_OP_RE = new RegExp("[" + codepointClass.charClass([[0x2061, 0x2064]]) + "]");
// Global twin for the strip pass; the unglobbed one above is the presence test.
// allow:dynamic-regex — codepoints from a literal range table
var INVISIBLE_OP_RE_G = new RegExp("[" + codepointClass.charClass([[0x2061, 0x2064]]) + "]", "g");

// The framework's BIDI_RE is the union of two groups that do NOT carry the
// same risk, and refusing both is what broke right-to-left addresses:
//
//   OVERRIDES + ISOLATES — U+202A-202E and U+2066-2069. These reorder a RUN
//     of surrounding text, which is the Trojan Source primitive: a value that
//     displays as something other than what it says. Nothing legitimate in a
//     shop's stored text needs them.
//   MARKS — U+200E LEFT-TO-RIGHT MARK, U+200F RIGHT-TO-LEFT MARK, U+061C
//     ARABIC LETTER MARK. These only resolve the direction of ADJACENT
//     NEUTRAL characters — a house number inside an Arabic street name, a
//     Latin brand inside a Hebrew sentence. They are how mixed-direction text
//     is correctly authored, and an Arabic or Hebrew postal address routinely
//     contains one. They cannot reverse a run.
//
// So the marks are ALLOWED by default and the overrides are refused. A field
// that genuinely wants neither (a machine-readable identifier, a slug) asks
// for `bidiMarks: "reject"`.
// allow:dynamic-regex — codepoints from a literal range table
var BIDI_OVERRIDE_RE = new RegExp(
  "[" + codepointClass.charClass([[0x202A, 0x202E], [0x2066, 0x2069]]) + "]"
);
// allow:dynamic-regex — codepoints from a literal range table
var BIDI_MARK_RE = new RegExp(
  "[" + codepointClass.charClass([0x200E, 0x200F, 0x061C]) + "]"
);

// Everything that ends a line or pads it out, for a value that must stay on
// one. Tab / LF / CR sit outside the framework's C0 table on purpose — a
// multi-line body needs them — so a single-line field asks for them here.
// U+2028 / U+2029 are not control characters at all, but they terminate a
// line for both a renderer and a JS string literal.
// allow:dynamic-regex — codepoints from a literal range table
var LINE_BREAK_RE = new RegExp(
  "[" + codepointClass.charClass([0x0009, 0x000A, 0x000D, [0x2028, 0x2029]]) + "]"
);

// ---- shop validators ----------------------------------------------------

// asciiUpperLetters(s, label, n?) — exactly `n` (default 3) ASCII
// uppercase letters, nothing else. The generalized shape behind every
// `/^[A-Z]{3}$/` token check. ASCII-allowlist by construction, so bidi
// / control / zero-width / confusable codepoints are rejected for free
// (they are not in A-Z). Throws TypeError on a miss.
function asciiUpperLetters(s, label, n) {
  var name = label || "value";
  var len = n == null ? 3 : n;
  if (typeof len !== "number" || !Number.isInteger(len) || len <= 0) {
    throw new TypeError("textGuard: length must be a positive integer, got " + JSON.stringify(n));
  }
  // allow:dynamic-regex — len is a validated positive integer, not external input
  var re = new RegExp("^[A-Z]{" + len + "}$");
  if (typeof s !== "string" || !re.test(s)) {
    throw new TypeError(
      name + " must be exactly " + len + " uppercase ASCII letter(s), got " + JSON.stringify(s)
    );
  }
  return s;
}

// currencyCode(s, label?) — ISO 4217 currency code: the asciiUpperLetters
// shape check THEN membership in the framework's catalog (b.money.CURRENCIES,
// the same surface currency-rounding + currency-display compose). Rejects
// both malformed codes ("usd", "US") and well-formed-but-nonexistent codes
// ("ZZZ") that would shape-check past `/^[A-Z]{3}$/` but bind money to a
// currency the rest of the shop can't price. Throws TypeError on a miss.
function currencyCode(s, label) {
  var name = label || "currency";
  if (typeof s !== "string" || !/^[A-Z]{3}$/.test(s)) {
    throw new TypeError(
      name + " must be a 3-letter uppercase ISO 4217 code, got " + JSON.stringify(s)
    );
  }
  if (!Object.prototype.hasOwnProperty.call(b.money.CURRENCIES, s)) {
    throw new TypeError(name + " " + JSON.stringify(s) + " is not in the ISO 4217 catalog");
  }
  return s;
}

// slugLabel(s, label, opts?) — a lowercase URL-slug label: starts and
// ends with [a-z0-9], inner chars [a-z0-9-], no leading / trailing /
// doubled hyphen, length 1..maxLen (default 80). ASCII-allowlist, so
// dangerous codepoints are rejected by construction. Throws TypeError.
function slugLabel(s, label, opts) {
  var name = label || "slug";
  opts = opts || {};
  var maxLen = opts.maxLen == null ? 80 : opts.maxLen;
  if (typeof maxLen !== "number" || !Number.isInteger(maxLen) || maxLen <= 0) {
    throw new TypeError("textGuard: maxLen must be a positive integer, got " + JSON.stringify(opts.maxLen));
  }
  if (typeof s !== "string" || s.length < 1 || s.length > maxLen) {
    throw new TypeError(
      name + " must be a 1.." + maxLen + "-character lowercase slug, got " + JSON.stringify(s)
    );
  }
  // Single char must itself be [a-z0-9]; longer must match start/inner/end.
  var ok = s.length === 1
    ? /^[a-z0-9]$/.test(s)
    : /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(s);
  if (!ok || /--/.test(s)) {
    throw new TypeError(
      name + " must be a lowercase URL slug ([a-z0-9] separated by single hyphens), got " + JSON.stringify(s)
    );
  }
  return s;
}

// Hostnames that name an internal / metadata destination by name rather
// than by IP literal. The cloud-metadata services answer on a hostname as
// well as the 169.254.169.254 link-local IP; localhost resolves to
// loopback. A literal-IP host is classified directly via b.ssrfGuard
// (no DNS); these names cover the by-name reach of the same targets.
var BLOCKED_HOSTS = Object.freeze({
  "localhost":                1,
  "metadata.google.internal": 1,
});

// hostLabel(host, label?) — refuse an outbound host that targets an
// internal / loopback / link-local / reserved / cloud-metadata
// destination. A literal-IP host is classified via b.ssrfGuard.classify
// (IPv4 + IPv6 + IPv4-mapped, no DNS); a hostname is matched against the
// by-name metadata / loopback denylist plus the *.internal suffix. A
// trailing FQDN dot and IPv6 brackets are stripped first so neither check
// is evaded. DNS-rebinding (a public name resolving to a private IP) is
// out of scope at this gate by design — the resolving guard belongs on
// the delivery dial. Throws TypeError when the host is not allowed.
// Returns the normalized (bracket / trailing-dot stripped, lowercased)
// host on success.
function hostLabel(host, label) {
  var name = label || "host";
  if (typeof host !== "string" || host.length === 0) {
    throw new TypeError(name + " must be a non-empty string");
  }
  var h = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, "");
  if (b.ssrfGuard.classify(h) ||
      BLOCKED_HOSTS[h] ||
      h === "internal" || /\.internal$/.test(h)) {
    throw new TypeError(name + " is not allowed (internal/loopback/metadata address)");
  }
  return h;
}

// firstCodepointThreat(s, policy?) — the single decision both the throwing
// screen (freeText) and the drop-silent one (hasCodepointThreat) run, so a
// field guarded one way and a field guarded the other can never disagree
// about what "dangerous" means. Returns a short reason string naming the
// class, or null when the text is clean. The reason is the clause that
// follows the field name in a refusal ("contains a null byte"), so a caller
// building a message just joins the two.
//
// Policies, each "reject" to enable and any other value to allow:
//   bidi        — default "reject". Bidi OVERRIDES and ISOLATES only
//                 (U+202A-202E, U+2066-2069) — the codepoints that reorder a
//                 run of text (CVE-2021-42574).
//   bidiMarks   — default "reject". U+200E / U+200F / U+061C, the direction
//                 MARKS. These are legitimate in NATURAL-LANGUAGE text — an
//                 Arabic postal address or a Hebrew gift message carries one
//                 wherever a Latin word or number sits inside the line — and
//                 illegitimate in a machine-readable value, where the only
//                 reason for an invisible character is to make the value read
//                 as something it is not. Neither case is the majority, so
//                 the default is chosen by how each mistake fails: refusing a
//                 mark that belonged is reported by the customer it turned
//                 away, while accepting one that did not is silent. A prose
//                 field therefore opts OUT with `bidiMarks: "allow"`.
//   nullByte    — default "reject". U+0000.
//   control     — default "reject". C0 controls + U+007F DELETE. Tab, LF and
//                 CR are ALLOWED here: a multi-line body legitimately has
//                 them. Use singleLine for a field that must not.
//   singleLine  — off by default. Tab / LF / CR, plus U+2028 LINE SEPARATOR
//                 and U+2029 PARAGRAPH SEPARATOR, which break a line without
//                 being C0 at all. For a value rendered on one line — a URL,
//                 a subject, a title, a header value.
//   zeroWidth   — off by default. Zero-width / invisible formatting. Includes
//                 U+00AD SOFT HYPHEN, which text pasted out of a hyphenating
//                 word processor or PDF carries invisibly.
//   mixedScript — off by default. Confusable / homograph across writing
//                 systems, narrowed by policy.allowedScripts.
function firstCodepointThreat(s, policy) {
  policy = policy || {};
  if ((policy.bidi || "reject") === "reject" && BIDI_OVERRIDE_RE.test(s)) {
    return "contains a Unicode bidi override (CVE-2021-42574 Trojan Source)";
  }
  if ((policy.bidiMarks || "reject") === "reject" && BIDI_MARK_RE.test(s)) {
    return "contains a Unicode bidi direction mark";
  }
  if ((policy.nullByte || "reject") === "reject" &&
      s.indexOf(codepointClass.NULL_BYTE) !== -1) {
    return "contains a null byte";
  }
  if ((policy.control || "reject") === "reject" &&
      (codepointClass.C0_CTRL_RE.test(s) || DEL_RE.test(s))) {
    return "contains a C0 control character";
  }
  if (policy.singleLine === "reject" && LINE_BREAK_RE.test(s)) {
    return "contains a line break or tab but must be a single line";
  }
  if (policy.zeroWidth === "reject" &&
      (codepointClass.ZERO_WIDTH_RE.test(s) || INVISIBLE_OP_RE.test(s))) {
    return "contains a zero-width / invisible formatting character";
  }
  if (policy.mixedScript === "reject") {
    var scripts = codepointClass.detectMixedScripts(s, policy.allowedScripts);
    if (scripts) {
      return "mixes writing systems (" + scripts.join(", ") +
             ") — possible confusable / homograph";
    }
  }
  return null;
}

// hasCodepointThreat(s, policy?) — the non-throwing sibling of freeText, for
// the defensive readers that DROP a bad value rather than refusing the
// request (a link URL inside a rendered body, a header line being assembled).
// A non-string is dangerous by definition here: the caller is about to render
// or transmit it. Returns true when the text must not be used.
function hasCodepointThreat(s, policy) {
  if (typeof s !== "string") return true;
  return firstCodepointThreat(s, policy) !== null;
}

// scrubInvisible(s) — remove every bidi override and invisible-formatting
// codepoint and return the cleaned string. The third disposition, alongside
// throwing and dropping: for a value that must be ACCEPTED whatever it
// contains, because refusing it would hand an attacker a denial-of-service
// against a legitimate user (a search query is the standing example — a
// pasted BOM must not cost the shopper their search).
//
// Composes the framework's strip pass and then removes the codepoints the
// catalog does not carry yet, so what this deletes is exactly what
// hasCodepointThreat would have objected to under zeroWidth: "reject".
// Control characters are deliberately NOT touched: a caller stripping those
// usually wants to substitute a space to avoid welding two words together,
// which is its own decision.
function scrubInvisible(s) {
  if (typeof s !== "string") return s;
  var out = codepointClass.applyCharStripPolicies(s, {
    bidiPolicy:      "strip",
    zeroWidthPolicy: "strip",
    tagsPolicy:      "strip",
  });
  return out.replace(INVISIBLE_OP_RE_G, "");
}

// freeText(s, label, policy?) — the dangerous-codepoint screen for an
// UNCONSTRAINED UTF-8 text field (customer note, review body, gift
// message, product Q&A). Unlike the ASCII-allowlist validators above,
// these fields legitimately carry arbitrary letters, so the codepoint
// catalog is the right backing. Throws TypeError on a refused codepoint;
// returns the input on success. See firstCodepointThreat for the policies.
function freeText(s, label, policy) {
  var name = label || "value";
  if (typeof s !== "string") {
    throw new TypeError(name + " must be a string");
  }
  var reason = firstCodepointThreat(s, policy);
  if (reason) throw new TypeError(name + " " + reason);
  return s;
}

module.exports = {
  // Re-exports of the framework codepoint catalog (single source of truth).
  BIDI_RE:                codepointClass.BIDI_RE,
  C0_CTRL_RE:             codepointClass.C0_CTRL_RE,
  ZERO_WIDTH_RE:          codepointClass.ZERO_WIDTH_RE,
  NULL_BYTE:              codepointClass.NULL_BYTE,
  BOM_CHAR:               codepointClass.BOM_CHAR,
  scriptFor:              codepointClass.scriptFor,
  detectMixedScripts:     codepointClass.detectMixedScripts,
  detectCharThreats:      codepointClass.detectCharThreats,
  assertNoCharThreats:    codepointClass.assertNoCharThreats,
  applyCharStripPolicies: codepointClass.applyCharStripPolicies,

  // Shop validators.
  asciiUpperLetters:    asciiUpperLetters,
  currencyCode:         currencyCode,
  slugLabel:            slugLabel,
  hostLabel:            hostLabel,
  freeText:             freeText,
  hasCodepointThreat:   hasCodepointThreat,
  firstCodepointThreat: firstCodepointThreat,
  scrubInvisible:       scrubInvisible,
};
