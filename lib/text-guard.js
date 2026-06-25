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
 *       unconstrained UTF-8 text fields
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

// freeText(s, label, policy?) — the dangerous-codepoint screen for an
// UNCONSTRAINED UTF-8 text field (customer note, review body, gift
// message, product Q&A). Unlike the ASCII-allowlist validators above,
// these fields legitimately carry arbitrary letters, so the codepoint
// catalog is the right backing: bidi overrides (CVE-2021-42574 Trojan
// Source), null bytes, and C0 control characters are refused by default;
// zero-width / invisible formatting is refused when policy.zeroWidth is
// "reject"; a mixed-script confusable (Cyrillic 'а' inside an otherwise
// Latin label) is refused when policy.mixedScript is "reject". Throws
// TypeError on a refused codepoint. Returns the input on success.
function freeText(s, label, policy) {
  var name = label || "value";
  if (typeof s !== "string") {
    throw new TypeError(name + " must be a string");
  }
  policy = policy || {};
  var bidiP    = policy.bidi    || "reject";
  var nullP    = policy.nullByte || "reject";
  var controlP = policy.control || "reject";
  if (bidiP === "reject" && codepointClass.BIDI_RE.test(s)) {
    throw new TypeError(name + " contains a Unicode bidi override (CVE-2021-42574 Trojan Source)");
  }
  if (nullP === "reject" && s.indexOf(codepointClass.NULL_BYTE) !== -1) {
    throw new TypeError(name + " contains a null byte");
  }
  if (controlP === "reject" && codepointClass.C0_CTRL_RE.test(s)) {
    throw new TypeError(name + " contains a C0 control character");
  }
  if (policy.zeroWidth === "reject" && codepointClass.ZERO_WIDTH_RE.test(s)) {
    throw new TypeError(name + " contains a zero-width / invisible formatting character");
  }
  if (policy.mixedScript === "reject") {
    var scripts = codepointClass.detectMixedScripts(s, policy.allowedScripts);
    if (scripts) {
      throw new TypeError(
        name + " mixes writing systems (" + scripts.join(", ") + ") — possible confusable / homograph"
      );
    }
  }
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
  asciiUpperLetters: asciiUpperLetters,
  currencyCode:      currencyCode,
  slugLabel:         slugLabel,
  hostLabel:         hostLabel,
  freeText:          freeText,
};
