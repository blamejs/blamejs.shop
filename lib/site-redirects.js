"use strict";
/**
 * @module shop.siteRedirects
 * @title  Site-redirects primitive — operator-defined 301/302/307/308
 *         URL redirects with hit counters
 *
 * @intro
 *   When a marketing slug migrates, a product is retired, or a region-
 *   specific landing page rotates, the storefront needs a single
 *   answer: "if a request lands at `/old-path`, where does it go?"
 *   `siteRedirects` is the operator-author table that backs that
 *   answer.
 *
 *   Each redirect carries five operator-author fields plus an
 *   optional expiry:
 *
 *     - `slug`         — stable id for dashboards + audit trails;
 *                        the operator picks the slug, the framework
 *                        guarantees uniqueness.
 *     - `source_path`  — the inbound URL the storefront sees. Always
 *                        /-rooted; trailing slash is significant
 *                        (matches the URL the browser actually sends).
 *     - `target_url`   — either a /-rooted internal path or a full
 *                        https:// URL. javascript: / data: /
 *                        protocol-relative `//host/...` refused via
 *                        `b.safeUrl.parse`.
 *     - `code`         — 301 (permanent), 302 (temporary), 307
 *                        (temporary, preserves method+body) or 308
 *                        (permanent, preserves method+body). The
 *                        primitive enforces the four-verb set at the
 *                        edge so a typo never reaches a customer
 *                        browser.
 *     - `match_kind`   — `exact` (full-path equality), `prefix`
 *                        (request path starts with the source), or
 *                        `regex` (anchored regex against the request
 *                        path). Regex patterns with backreferences or
 *                        lookahead are refused at define time so a
 *                        hostile author can't land a catastrophic-
 *                        backtracking pattern in the live table.
 *     - `expires_at`   — optional epoch-ms cutoff. After expiry the
 *                        redirect stops resolving (treated like
 *                        archived) but persists until cleanupExpired
 *                        sweeps it. Operators wanting a permanent
 *                        redirect leave this null.
 *
 *   `resolveForPath(path)` walks the three match_kinds in precedence
 *   order — exact first, then prefix (longest-source-path-first), then
 *   regex (slug ASC) — returning the most-specific live row whose
 *   pattern covers `path`. Archived rows + expired rows + inactive
 *   rows drop out. Returning the most-specific match keeps a
 *   `/sale/holiday/black-friday` row in charge of its own URL while a
 *   broader `/sale/` prefix row catches everything else.
 *
 *   `recordHit({slug, occurred_at?})` increments the row's running
 *   `hit_count` AND appends a row to `site_redirect_hits` for the
 *   per-event log. Dashboards walk the per-event table via
 *   `topHits({from, to, limit})` to answer "which redirects fired the
 *   most last week"; the running counter is the cheap O(1) lifetime
 *   total when the dashboard doesn't need the window.
 *
 *   Composes:
 *     - `b.uuid.v7` — id mint for `site_redirect_hits` rows.
 *     - `b.safeUrl.parse` — `target_url` https:// gate. /-rooted
 *       internal paths are admitted via the same control-byte +
 *       protocol-relative refusal as `promoBanners.link_url`.
 *
 *   Surface:
 *     defineRedirect({ slug, source_path, target_url, code,
 *                      match_kind, active, expires_at? })
 *     resolveForPath(path)
 *     recordHit({ slug, occurred_at? })
 *     listRedirects({ active_only? })
 *     getRedirect(slug)
 *     updateRedirect({ slug, ... })
 *     archiveRedirect(slug)
 *     unarchiveRedirect(slug)
 *     topHits({ from, to, limit })
 *     cleanupExpired({ now? })
 *
 *   Storage:
 *     - `site_redirects`        (migration `0119_site_redirects.sql`)
 *     - `site_redirect_hits`    (migration `0119_site_redirects.sql`)
 *
 * @primitive siteRedirects
 * @related   b.uuid, b.safeUrl
 */

// ---- constants ----------------------------------------------------------

var MAX_SLUG_LEN          = 80;
var SLUG_RE               = /^[a-z0-9][a-z0-9_-]{0,79}$/;

var MAX_SOURCE_PATH_LEN   = 2048;
var MAX_TARGET_URL_LEN    = 2048;

var CODES                 = Object.freeze([301, 302, 307, 308]);
var MATCH_KINDS           = Object.freeze(["exact", "prefix", "regex"]);

var MAX_REGEX_SOURCE_LEN  = 512;

var MAX_LIMIT             = 1000;
var DEFAULT_LIMIT         = 100;

var CONTROL_BYTE_RE       = /[\x00-\x1f\x7f]/;
// Zero-width + invisible bytes: U+200B (zero-width space),
// U+200C (zero-width non-joiner), U+200D (zero-width joiner),
// U+2060 (word joiner), U+FEFF (zero-width no-break space / BOM).
// Source code uses escape sequences so the file itself stays
// linter-clean (raw zero-width bytes in source trip both
// no-irregular-whitespace and no-misleading-character-class).
var ZERO_WIDTH_RE         = new RegExp(
  "[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\u061C]"
);

var b = require("./vendor/blamejs");

// Monotonic clock — ensures consecutive _now() calls from the same
// process never collide in the same millisecond, so updated_at /
// created_at ordering stays stable when two writes land back-to-back
// inside a single tick. The framework's own observability sinks use
// the same shape.
var _lastTs = 0;
function _now() {
  var t = Date.now();
  if (t <= _lastTs) { t = _lastTs + 1; }
  _lastTs = t;
  return t;
}

// ---- validators ---------------------------------------------------------

function _slug(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("siteRedirects: slug must be a non-empty string");
  }
  if (s.length > MAX_SLUG_LEN) {
    throw new TypeError("siteRedirects: slug must be <= " + MAX_SLUG_LEN + " characters");
  }
  if (!SLUG_RE.test(s)) {
    throw new TypeError(
      "siteRedirects: slug must match /^[a-z0-9][a-z0-9_-]{0,79}$/"
    );
  }
  return s;
}

function _sourcePath(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("siteRedirects: source_path must be a non-empty string");
  }
  if (s.length > MAX_SOURCE_PATH_LEN) {
    throw new TypeError(
      "siteRedirects: source_path must be <= " + MAX_SOURCE_PATH_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("siteRedirects: source_path contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) !== 47 /* "/" */) {
    throw new TypeError("siteRedirects: source_path must be /-rooted (start with '/')");
  }
  if (s.length > 1 && s.charCodeAt(1) === 47) {
    throw new TypeError(
      "siteRedirects: source_path protocol-relative `//host/...` refused — must be /-rooted"
    );
  }
  return s;
}

// /-rooted internal path OR https://. Same envelope as
// promoBanners.link_url / trustBadges.link_url so an operator
// rotating between primitives doesn't relearn the gate.
function _targetUrl(s) {
  if (typeof s !== "string" || !s.length) {
    throw new TypeError("siteRedirects: target_url must be a non-empty string");
  }
  if (s.length > MAX_TARGET_URL_LEN) {
    throw new TypeError(
      "siteRedirects: target_url must be <= " + MAX_TARGET_URL_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(s) || ZERO_WIDTH_RE.test(s)) {
    throw new TypeError("siteRedirects: target_url contains control / zero-width bytes");
  }
  if (s.charCodeAt(0) === 47 /* "/" */) {
    if (s.length > 1 && s.charCodeAt(1) === 47) {
      throw new TypeError(
        "siteRedirects: target_url protocol-relative `//host/...` refused — use absolute https://"
      );
    }
    if (s.indexOf("..") !== -1) {
      throw new TypeError("siteRedirects: target_url path must not contain '..'");
    }
    return s;
  }
  try {
    b.safeUrl.parse(s, { allowedProtocols: ["https:"] });
  } catch (e) {
    throw new TypeError(
      "siteRedirects: target_url — " +
      (e && e.message ? e.message : "must be https:// or a /-rooted absolute path")
    );
  }
  return s;
}

function _code(n) {
  if (!Number.isInteger(n) || CODES.indexOf(n) === -1) {
    throw new TypeError("siteRedirects: code must be one of " + CODES.join(", "));
  }
  return n;
}

function _matchKind(s) {
  if (typeof s !== "string" || MATCH_KINDS.indexOf(s) === -1) {
    throw new TypeError("siteRedirects: match_kind must be one of " + MATCH_KINDS.join(", "));
  }
  return s;
}

function _active(b) {
  if (typeof b !== "boolean") {
    throw new TypeError("siteRedirects: active must be a boolean");
  }
  return b ? 1 : 0;
}

function _expiresAt(n, label) {
  if (n == null) return null;
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("siteRedirects: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

function _epochMs(n, label) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError("siteRedirects: " + label + " must be a positive integer epoch-ms");
  }
  return n;
}

// Refuse regex patterns that carry backreferences (`\1`..`\9`) or
// lookahead/lookbehind (`(?=...)`, `(?!...)`, `(?<=...)`, `(?<!...)`).
// These are the two regex-shape categories that drive catastrophic
// backtracking under adversarial input. Operators wanting these
// shapes register multiple `prefix` / `exact` rules instead — the
// regex match_kind is for cheap path-translation, not arbitrary
// pattern matching.
//
// `_compileRegex` walks the source for the forbidden tokens BEFORE
// handing it to RegExp(), then anchors the compiled pattern with `^`
// and `$` so `resolveForPath` answers an exact-path match (not a
// substring match a la `/foo` finding `/foo/bar`).
function _compileRegex(source) {
  if (typeof source !== "string" || !source.length) {
    throw new TypeError("siteRedirects: source_path (regex) must be a non-empty string");
  }
  if (source.length > MAX_REGEX_SOURCE_LEN) {
    throw new TypeError(
      "siteRedirects: regex source must be <= " + MAX_REGEX_SOURCE_LEN + " characters"
    );
  }
  if (CONTROL_BYTE_RE.test(source) || ZERO_WIDTH_RE.test(source)) {
    throw new TypeError("siteRedirects: regex source contains control / zero-width bytes");
  }
  // Backreferences: \1 .. \9 outside a character class. The walker
  // tracks character-class depth so `[\1]` (literal byte) doesn't
  // trip the gate, but `(.)\1` (a real backreference) does.
  var inClass = 0;
  for (var i = 0; i < source.length; i += 1) {
    var ch = source.charAt(i);
    if (ch === "\\" && i + 1 < source.length) {
      var nxt = source.charAt(i + 1);
      if (inClass === 0 && nxt >= "1" && nxt <= "9") {
        throw new TypeError(
          "siteRedirects: regex backreferences (\\1..\\9) refused — operators register " +
          "separate redirect rows for each variant instead"
        );
      }
      i += 1;                                                          // skip escaped char
      continue;
    }
    if (ch === "[") { inClass += 1; continue; }
    if (ch === "]" && inClass > 0) { inClass -= 1; continue; }
    if (inClass > 0) continue;
    if (ch === "(" && i + 2 < source.length && source.charAt(i + 1) === "?") {
      var third = source.charAt(i + 2);
      if (third === "=" || third === "!" || third === "<") {
        throw new TypeError(
          "siteRedirects: regex lookahead / lookbehind (`(?=`, `(?!`, `(?<=`, `(?<!`) refused " +
          "— catastrophic-backtracking surface; rewrite as `prefix` or split into multiple rows"
        );
      }
    }
  }
  // Build the anchored form. RegExp() throws SyntaxError on a
  // malformed source — re-shape that into the primitive's TypeError
  // envelope so callers can match on the consistent error shape.
  var anchored = "^(?:" + source + ")$";
  var compiled;
  try {
    compiled = new RegExp(anchored);
  } catch (e) {
    throw new TypeError(
      "siteRedirects: regex source did not compile — " +
      (e && e.message ? e.message : "invalid pattern")
    );
  }
  // Extend the backreference / lookaround screen above with the last
  // catastrophic-backtracking class it doesn't cover: a nested unbounded
  // quantifier ((a+)+, (a*)*, (?:a+)+, (.+)+ …). This regex runs against the
  // request path in `resolveForPath`, so a super-linear pattern is a DoS on
  // every matching request. (The framework's b.guardRegex screen is not used
  // here because its text scan misreads the `?` in a `(?:…)` group prefix and
  // a bounded trailing `?` as quantifiers, rejecting linear patterns like
  // `/blog(?:/page/\d+)?` — filed upstream; this walker allows them.)
  if (_hasNestedUnboundedQuantifier(source)) {
    throw new TypeError(
      "siteRedirects: regex source rejected — nested unbounded quantifier " +
      "(catastrophic-backtracking / ReDoS) surface; rewrite as `prefix` / " +
      "`exact`, or split into multiple rows"
    );
  }
  return compiled;
}

// Detect the nested-unbounded-quantifier ReDoS class: a group whose body
// contains an unbounded quantifier (`+`, `*`, `{n,}`) and is itself repeated
// by an unbounded quantifier — `(a+)+`, `(a*)*`, `(?:a+)+`, `(.+)+`,
// `((ab)+)+` at any depth. A single optional / linearly-repeated group
// (`(?:foo)?`, `(?:bar)*`, `/products/.+`) is safe and MUST be allowed. The
// walk mirrors the backreference/lookaround walk: char-by-char, honoring
// escapes, character classes, and the `(?:` / `(?<name>` group prefixes whose
// `?` is group syntax, not a quantifier. Lookaround is already refused before
// this runs, so only `(?:` reaches here.
function _hasNestedUnboundedQuantifier(source) {
  var stack = [];            // open groups: { bodyUnbounded: bool }
  var inClass = false;
  var i = 0;
  var n = source.length;
  function outerUnboundedAt(idx) {
    var c = source.charAt(idx);
    if (c === "*" || c === "+") return true;
    if (c === "{") { return /^\{\d*,\}/.test(source.slice(idx)); }   // {n,} — no upper bound
    return false;
  }
  while (i < n) {
    var ch = source.charAt(i);
    if (ch === "\\") { i += 2; continue; }                            // escaped atom
    if (inClass) { if (ch === "]") { inClass = false; } i += 1; continue; }
    if (ch === "[") { inClass = true; i += 1; continue; }
    if (ch === "(") {
      if (source.charAt(i + 1) === "?") {                             // group prefix — not a quantifier
        i += 2;
        if (source.charAt(i) === ":") { i += 1; }
        else if (source.charAt(i) === "<") { while (i < n && source.charAt(i) !== ">") { i += 1; } if (i < n) { i += 1; } }
      } else { i += 1; }
      stack.push({ bodyUnbounded: false });
      continue;
    }
    if (ch === ")") {
      var g = stack.pop() || { bodyUnbounded: false };
      var outer = outerUnboundedAt(i + 1);
      if (g.bodyUnbounded && outer) { return true; }                 // nested unbounded quantifier
      // A group repeated by an unbounded quantifier is itself an unbounded
      // atom for its parent.
      if (outer && stack.length) { stack[stack.length - 1].bodyUnbounded = true; }
      i += 1;
      continue;
    }
    if (ch === "*" || ch === "+") {
      if (stack.length) { stack[stack.length - 1].bodyUnbounded = true; }
      i += 1;
      continue;
    }
    if (ch === "{" && /^\{\d*,\}/.test(source.slice(i))) {
      if (stack.length) { stack[stack.length - 1].bodyUnbounded = true; }
      i += 1;
      continue;
    }
    i += 1;
  }
  return false;
}

// ---- row hydration ------------------------------------------------------

function _hydrateRedirect(row) {
  if (!row) return null;
  return {
    slug:         row.slug,
    source_path:  row.source_path,
    target_url:   row.target_url,
    code:         Number(row.code),
    match_kind:   row.match_kind,
    active:       Number(row.active) === 1,
    expires_at:   row.expires_at == null ? null : Number(row.expires_at),
    archived_at:  row.archived_at == null ? null : Number(row.archived_at),
    hit_count:    Number(row.hit_count),
    created_at:   Number(row.created_at),
    updated_at:   Number(row.updated_at),
  };
}

// ---- factory ------------------------------------------------------------

function create(opts) {
  opts = opts || {};
  var query = opts.query;
  if (!query) {
    query = function (sql, params) { return b.externalDb.query(sql, params); };
  }

  async function _getRow(slug) {
    var r = await query(
      "SELECT * FROM site_redirects WHERE slug = ?1",
      [slug],
    );
    return r.rows[0] || null;
  }

  async function getRedirect(slug) {
    _slug(slug);
    return _hydrateRedirect(await _getRow(slug));
  }

  async function defineRedirect(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("siteRedirects.defineRedirect: input object required");
    }
    var slug       = _slug(input.slug);
    var matchKind  = _matchKind(input.match_kind);
    var sourcePath;
    if (matchKind === "regex") {
      // The regex compiler refuses backreferences / lookahead /
      // lookbehind + control bytes. We DON'T enforce /-rooted on
      // regex source — operators sometimes want patterns like
      // `/blog/\\d{4}/.+` that ARE /-rooted in practice but where the
      // operator writes the leading `/` themselves. The bytes-level
      // gates above still apply.
      _compileRegex(input.source_path);
      sourcePath = input.source_path;
      if (sourcePath.length > MAX_SOURCE_PATH_LEN) {
        throw new TypeError(
          "siteRedirects: source_path must be <= " + MAX_SOURCE_PATH_LEN + " characters"
        );
      }
    } else {
      sourcePath = _sourcePath(input.source_path);
    }
    var targetUrl  = _targetUrl(input.target_url);
    var code       = _code(input.code);
    var activeInt  = _active(input.active);
    var expiresAt  = _expiresAt(input.expires_at, "expires_at");

    var ts = _now();
    var existing = await _getRow(slug);
    var createdAt = existing ? Number(existing.created_at) : ts;
    var hitCount  = existing ? Number(existing.hit_count) : 0;
    // Re-defining a previously-archived slug clears archived_at — the
    // shape mirrors carrier_transits / shipping_holidays in
    // delivery-estimate: an upsert reopens the row.
    await query(
      "INSERT INTO site_redirects " +
      "(slug, source_path, target_url, code, match_kind, active, expires_at, " +
      " archived_at, hit_count, created_at, updated_at) " +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8, ?9, ?10) " +
      "ON CONFLICT(slug) DO UPDATE SET " +
      "  source_path = excluded.source_path, " +
      "  target_url  = excluded.target_url, " +
      "  code        = excluded.code, " +
      "  match_kind  = excluded.match_kind, " +
      "  active      = excluded.active, " +
      "  expires_at  = excluded.expires_at, " +
      "  archived_at = NULL, " +
      "  updated_at  = excluded.updated_at",
      [slug, sourcePath, targetUrl, code, matchKind, activeInt,
        expiresAt, hitCount, createdAt, ts],
    );
    return _hydrateRedirect(await _getRow(slug));
  }

  async function updateRedirect(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("siteRedirects.updateRedirect: input object required");
    }
    var slug = _slug(input.slug);
    var existing = await _getRow(slug);
    if (!existing) {
      throw new TypeError(
        "siteRedirects.updateRedirect: slug " + JSON.stringify(slug) + " not found"
      );
    }
    // Caller may rotate any combination of fields. `slug` is the key
    // and not rotatable in place — operators wanting a new slug
    // archive the old row and defineRedirect a new one.
    var merged = {
      slug:        slug,
      source_path: input.source_path != null ? input.source_path : existing.source_path,
      target_url:  input.target_url  != null ? input.target_url  : existing.target_url,
      code:        input.code        != null ? input.code        : Number(existing.code),
      match_kind:  input.match_kind  != null ? input.match_kind  : existing.match_kind,
      active:      input.active      != null ? input.active      : (Number(existing.active) === 1),
      // expires_at allows explicit `null` rotation (operator wants the
      // redirect to become permanent) — Object.prototype.hasOwnProperty
      // distinguishes "omitted" from "set to null".
      expires_at:  Object.prototype.hasOwnProperty.call(input, "expires_at")
        ? input.expires_at
        : (existing.expires_at == null ? null : Number(existing.expires_at)),
    };
    return defineRedirect(merged);
  }

  async function archiveRedirect(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE site_redirects SET archived_at = ?1, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getRedirect(slug);
      if (!existing) {
        throw new TypeError(
          "siteRedirects.archiveRedirect: slug " + JSON.stringify(slug) + " not found"
        );
      }
      // Idempotent re-archive — return the already-archived row.
      return existing;
    }
    return await getRedirect(slug);
  }

  async function unarchiveRedirect(slug) {
    _slug(slug);
    var ts = _now();
    var r = await query(
      "UPDATE site_redirects SET archived_at = NULL, updated_at = ?1 " +
      "WHERE slug = ?2 AND archived_at IS NOT NULL",
      [ts, slug],
    );
    if (Number(r.rowCount || 0) === 0) {
      var existing = await getRedirect(slug);
      if (!existing) {
        throw new TypeError(
          "siteRedirects.unarchiveRedirect: slug " + JSON.stringify(slug) + " not found"
        );
      }
      return existing;
    }
    return await getRedirect(slug);
  }

  async function listRedirects(listOpts) {
    listOpts = listOpts || {};
    var sql = "SELECT * FROM site_redirects WHERE archived_at IS NULL";
    var params = [];
    if (listOpts.active_only === true) {
      sql += " AND active = 1";
    }
    sql += " ORDER BY match_kind ASC, length(source_path) DESC, slug ASC";
    var r = await query(sql, params);
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) out.push(_hydrateRedirect(r.rows[i]));
    return out;
  }

  // Resolve `path` against the live redirect table. Precedence:
  //   1. exact match on source_path
  //   2. prefix match — longest source_path wins
  //   3. regex match — first slug in ASCII order whose anchored
  //      pattern accepts the path
  // Archived / inactive / expired rows drop out of every tier.
  async function resolveForPath(path) {
    if (typeof path !== "string" || !path.length) {
      throw new TypeError("siteRedirects.resolveForPath: path must be a non-empty string");
    }
    if (CONTROL_BYTE_RE.test(path)) {
      throw new TypeError("siteRedirects.resolveForPath: path contains control bytes");
    }
    var now = _now();

    // -- exact ----------------------------------------------------------
    var exact = await query(
      "SELECT * FROM site_redirects " +
      "WHERE match_kind = 'exact' AND active = 1 AND archived_at IS NULL " +
      "AND source_path = ?1 " +
      "AND (expires_at IS NULL OR expires_at > ?2) " +
      "LIMIT 1",
      [path, now],
    );
    if (exact.rows.length) return _hydrateRedirect(exact.rows[0]);

    // -- prefix — longest source_path wins -----------------------------
    var prefix = await query(
      "SELECT * FROM site_redirects " +
      "WHERE match_kind = 'prefix' AND active = 1 AND archived_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?1) " +
      "ORDER BY length(source_path) DESC, slug ASC",
      [now],
    );
    for (var i = 0; i < prefix.rows.length; i += 1) {
      var row = prefix.rows[i];
      if (path.indexOf(row.source_path) === 0) return _hydrateRedirect(row);
    }

    // -- regex ---------------------------------------------------------
    var rgx = await query(
      "SELECT * FROM site_redirects " +
      "WHERE match_kind = 'regex' AND active = 1 AND archived_at IS NULL " +
      "AND (expires_at IS NULL OR expires_at > ?1) " +
      "ORDER BY slug ASC",
      [now],
    );
    for (var j = 0; j < rgx.rows.length; j += 1) {
      var rrow = rgx.rows[j];
      // _compileRegex applied the gates + anchored the pattern at
      // define time; we re-compile here on each call because the
      // anchored RegExp object isn't persisted (only the source is).
      // SQLite caches the row scan; the JS-side compile is the hot
      // step but the table is operator-author-small (dozens of rows,
      // not thousands), so the per-call compile is fine.
      var compiled;
      try {
        compiled = _compileRegex(rrow.source_path);
      } catch (_e) {
        // drop-silent — by design: a row that fails re-compile (e.g.
        // because the gate tightened in a later release and an older
        // row predates it) is treated as if it doesn't match. The
        // operator surfaces the row at audit time via listRedirects
        // + a refusal at the next updateRedirect call.
        continue;
      }
      if (compiled.test(path)) return _hydrateRedirect(rrow);
    }
    return null;
  }

  // Append a hit row + bump the running counter. `occurred_at`
  // defaults to the monotonic _now(); operators backfilling historic
  // hits pass it explicitly.
  async function recordHit(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("siteRedirects.recordHit: input object required");
    }
    var slug = _slug(input.slug);
    var occurredAt = input.occurred_at == null ? _now() : _epochMs(input.occurred_at, "occurred_at");
    var existing = await _getRow(slug);
    if (!existing) {
      throw new TypeError(
        "siteRedirects.recordHit: slug " + JSON.stringify(slug) + " not found"
      );
    }
    var hitId = b.uuid.v7();
    await query(
      "INSERT INTO site_redirect_hits (id, slug, occurred_at) VALUES (?1, ?2, ?3)",
      [hitId, slug, occurredAt],
    );
    await query(
      "UPDATE site_redirects SET hit_count = hit_count + 1, updated_at = ?1 WHERE slug = ?2",
      [_now(), slug],
    );
    return {
      id:          hitId,
      slug:        slug,
      occurred_at: occurredAt,
    };
  }

  // Operator dashboard — busiest redirects in a [from, to] window.
  // Walks the hits table (NOT the running counter) so the window is
  // accurate after an archive / cleanupExpired.
  async function topHits(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("siteRedirects.topHits: input object required");
    }
    var from = _epochMs(input.from, "from");
    var to   = _epochMs(input.to,   "to");
    if (to < from) {
      throw new TypeError("siteRedirects.topHits: to must be >= from");
    }
    var limit = input.limit == null ? DEFAULT_LIMIT : input.limit;
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      throw new TypeError(
        "siteRedirects.topHits: limit must be a positive integer <= " + MAX_LIMIT
      );
    }
    var r = await query(
      "SELECT slug, COUNT(*) AS hits FROM site_redirect_hits " +
      "WHERE occurred_at >= ?1 AND occurred_at <= ?2 " +
      "GROUP BY slug ORDER BY hits DESC, slug ASC LIMIT ?3",
      [from, to, limit],
    );
    var out = [];
    for (var i = 0; i < r.rows.length; i += 1) {
      out.push({
        slug: r.rows[i].slug,
        hits: Number(r.rows[i].hits),
      });
    }
    return {
      from:    from,
      to:      to,
      limit:   limit,
      results: out,
    };
  }

  // Delete redirect rows whose expires_at has elapsed. Returns the
  // sweep count + the `now` cutoff for round-trip clarity in tests
  // and dashboards. cleanupExpired does NOT touch site_redirect_hits
  // — the per-event audit log persists beyond the redirect's
  // lifetime so operators can answer "how many requests hit the
  // retired URL before we cleaned it up."
  async function cleanupExpired(cleanupOpts) {
    cleanupOpts = cleanupOpts || {};
    var now = cleanupOpts.now == null ? _now() : _epochMs(cleanupOpts.now, "now");
    var r = await query(
      "DELETE FROM site_redirects WHERE expires_at IS NOT NULL AND expires_at <= ?1",
      [now],
    );
    return {
      now:     now,
      swept:   Number(r.rowCount || 0),
    };
  }

  return {
    CODES:                 CODES,
    MATCH_KINDS:           MATCH_KINDS,
    MAX_SLUG_LEN:          MAX_SLUG_LEN,
    MAX_SOURCE_PATH_LEN:   MAX_SOURCE_PATH_LEN,
    MAX_TARGET_URL_LEN:    MAX_TARGET_URL_LEN,
    SLUG_RE:               SLUG_RE,

    defineRedirect:    defineRedirect,
    updateRedirect:    updateRedirect,
    getRedirect:       getRedirect,
    listRedirects:     listRedirects,
    resolveForPath:    resolveForPath,
    recordHit:         recordHit,
    topHits:           topHits,
    archiveRedirect:   archiveRedirect,
    unarchiveRedirect: unarchiveRedirect,
    cleanupExpired:    cleanupExpired,
  };
}

module.exports = {
  create:              create,
  CODES:               CODES,
  MATCH_KINDS:         MATCH_KINDS,
  MAX_SLUG_LEN:        MAX_SLUG_LEN,
  MAX_SOURCE_PATH_LEN: MAX_SOURCE_PATH_LEN,
  MAX_TARGET_URL_LEN:  MAX_TARGET_URL_LEN,
  SLUG_RE:             SLUG_RE,
};
