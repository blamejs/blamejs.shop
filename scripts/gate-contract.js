"use strict";
/**
 * gate-contract.js — release gate: assert every preventable bug-class
 * the project has fixed once still maps to a live detector and an
 * enforced gate, and surface new code surfaces that look like they need
 * coverage but don't have it yet.
 *
 * Wired into `node scripts/release.js prepare` (static gates) and
 * `node test/smoke.js`. Three things it verifies, plus an advisory scan:
 *
 *   (a) EVERY detector named in the COVERAGE registry below exists in
 *       the codebase-patterns catalog (KNOWN_ANTIPATTERNS). A typo, a
 *       renamed detector, or a removed detector trips this — the bug
 *       class would no longer be caught.
 *
 *   (b) EVERY detector that flags a shipped-bug class (carries
 *       `bugClassDeclared: true` in the catalog) has a COVERAGE row.
 *       A new shipped-bug detector added without a coverage row trips
 *       this — the registry would silently fall out of date.
 *
 *   (c) EVERY gate the registry depends on is still wired into the
 *       release pipeline. The codebase-patterns + currency gates (and
 *       this gate itself) must still be invoked from release.js
 *       `cmdPrepare`. A refactor that drops a gate trips this.
 *
 *   (d) CANDIDATE-GAP SCAN (advisory) — three cheap heuristics over
 *       lib/ flag a NEW surface that looks like it needs a declared
 *       gate but isn't covered: a new outbound webhook-style URL
 *       validator without an SSRF composition, a new money-binding
 *       currency site without the ISO 4217 catalog check, and a new
 *       admin 5xx response that echoes a raw error message. Each prints
 *       a candidate for human classification; a candidate is only a
 *       hard failure when it is genuinely undeclared (the detectors in
 *       (a)/(b) already cover the known-good tree, so a clean tree
 *       emits no candidates).
 *
 * On a gap the gate exits non-zero and prints, per finding, a
 * paste-ready line naming the missing detector / gate / candidate
 * surface so the fix is copy-paste. Conscious deferral (debt you are
 * not ready to close this cut):
 *
 *   RELEASE_ALLOW_GATE_GAPS=1  — downgrades every gap to a warning and
 *   exits 0. The findings still print so the debt stays visible.
 *
 * Zero npm deps — node builtins only. Exposes a pure `verify()`
 * returning `{ ok, gaps }` so the unit test can assert the known-good
 * tree returns `ok: true` without spawning the process.
 */

var fs   = require("node:fs");
var path = require("node:path");

var ROOT = path.resolve(__dirname, "..");
var ALLOW_GAPS = process.env.RELEASE_ALLOW_GATE_GAPS === "1";

// ---- the declared coverage registry ------------------------------------
//
// One row per preventable bug-class the project has fixed once and
// wants locked. `detector` names a codebase-patterns id (asserted to
// exist); `gate` names the pipeline stage that runs it. Adding a new
// shipped-bug detector (one carrying `bugClassDeclared: true`) without
// a row here trips assertion (b).
var COVERAGE = [
  {
    bugClass: "admin 5xx leaks raw error text to the client",
    detector: "admin-5xx-echoes-raw-error-message",
    gate:     "codebase-patterns",
    note:     "5xx problem-details must carry no error-derived detail; record server-side, return a generic code",
  },
  {
    bugClass: "admin cookie/HTML error banner leaks raw error text to the operator's browser",
    detector: "admin-html-error-banner-echoes-raw-error-message",
    gate:     "codebase-patterns",
    note:     "every admin HTML notice/banner built from a thrown error routes through _safeNotice; the cookie path can never diverge from the bearer path on what it reveals",
  },
  {
    bugClass: "operator-supplied outbound webhook URL enables SSRF",
    detector: "outbound-webhook-url-without-ssrf-guard",
    gate:     "codebase-patterns",
    note:     "an outbound webhook endpoint URL must compose the SSRF guard (textGuard.hostLabel / ssrfGuard.classify)",
  },
  {
    bugClass: "gift card issued in a non-ISO-4217 currency",
    detector: "giftcard-issue-without-iso4217-currency-check",
    gate:     "codebase-patterns",
    note:     "validate the currency against b.money.CURRENCIES (or textGuard.currencyCode) before giftcards.issue",
  },
  {
    bugClass: "any money-binding issue/grant/credit in a non-ISO-4217 currency",
    detector: "money-binding-currency-without-catalog-check",
    gate:     "codebase-patterns",
    note:     "generalizes the giftcard check to every balance-binding primitive",
  },
  {
    bugClass: "unguarded JSON.parse of a request-body field 500s on bad paste",
    detector: "admin-unguarded-json-parse-request-field",
    gate:     "codebase-patterns",
    note:     "wrap the parse and throw a TypeError so the bad paste degrades to a clean 400",
  },
  {
    bugClass: "returns-refund maps a malformed-id TypeError to a wrong 404",
    detector: "returns-refund-typeerror-mapped-to-404",
    gate:     "codebase-patterns",
    note:     "a malformed id is a 400 bad-request like its sibling actions; only a well-formed missing id is a 404",
  },
  {
    bugClass: "Document-Policy header asserts a legacy feature token current browsers don't recognize (inert header + console noise)",
    detector: "document-policy-unrecognized-feature-token",
    gate:     "codebase-patterns",
    note:     "suppress the vendored default's inert Document-Policy (securityHeadersOpts → documentPolicy:false) and emit none at the edge; the recognized feature set is force-load-at-top / js-profiling / include-js-call-stacks-in-crash-reports / expect-no-linked-resources / network-efficiency-guardrails — assert one of those or send no header",
  },
  {
    bugClass: "PDP image gallery is decorative-only — aria-hidden thumbnail strip with non-interactive tiles padded to fixed empty slots",
    detector: "pdp-gallery-inert-thumbnail-strip",
    gate:     "codebase-patterns",
    note:     "render the thumbnail strip as a focusable <ul.pdp__thumbs> of <label for> controls bound to hidden radios (no aria-hidden, no empty-<li> padding) so the gallery is a working no-JS CSS-:checked picker — exactly N thumbnails, no strip for a lone image",
  },
  {
    bugClass: "product media reorder/set-primary repositions another product's gallery row via an unscoped position UPDATE (cross-product display-order IDOR)",
    detector: "media-reorder-unscoped-position-update",
    gate:     "codebase-patterns",
    note:     "scope every UPDATE media SET position by product_id (WHERE id = ? AND product_id = ?) so a crafted ordered_media_ids / media id can't renumber another product's hero/order",
  },
  {
    bugClass: "storefront search result-count rendered from the page-slice length instead of the real match total (count lies + surplus products unreachable)",
    detector: "search-count-from-page-length",
    gate:     "codebase-patterns",
    note:     "drive the \"Showing N matches\" copy off the real total (searchFacets previewQuery total / the full narrowed-set length), not the rendered page slice's .length; window only the painted cards by ?page=N",
  },
  {
    bugClass: "blog admin create auto-publishes a new post, pushing it to the storefront before review (skips the draft-stays-hidden gate)",
    detector: "blog-create-auto-publishes-draft",
    gate:     "codebase-patterns",
    note:     "the create handler calls blog.createDraft and stops; publishing is a separate operator-invoked action (POST /admin/blog/:slug/publish) so a post is reviewable as a draft before it goes live on /blog",
  },
  {
    bugClass: "admin discount edit coercion drops the trigger/value terms columns updateRule accepts (operator can reprioritise/pause but not change the discount terms from the console — a write-but-no-edit dormant gap)",
    detector: "discount-patch-drops-trigger-or-value",
    gate:     "codebase-patterns",
    note:     "_discountPatch must forward patch.trigger = _discountTrigger(body) and patch.value = _discountValue(body) so the browser edit path reaches the same terms columns (amount/percentage/threshold/BOGO) as the bearer PATCH; both reuse the create form's validating vocabulary so a bad terms edit is a clean 400",
  },
  {
    bugClass: "R2-served media asset response carries no protective headers — a mis-typed operator upload can be MIME-sniffed into an executable type, embedded cross-origin, or (for a directly-navigated SVG) run script in the site's origin",
    detector: "r2-asset-response-without-nosniff-hardening",
    gate:     "codebase-patterns",
    note:     "stamp the asset Response via _hardenAssetResponse(headers) before new Response(obj.body, { headers }) — X-Content-Type-Options: nosniff + Cross-Origin-Resource-Policy: same-origin on every asset, plus a default-src 'none'; style-src 'unsafe-inline'; sandbox CSP on image/svg+xml",
  },
  {
    bugClass: "admin /admin/products/:id/media/:mid/primary route ignores its :id path segment — setPrimary scopes by the media row's own product, so a request can name product A in the path while acting on product B's media (path/contract honesty gap)",
    detector: "admin-media-mid-route-ignores-id-segment",
    gate:     "codebase-patterns",
    note:     "assert _mediaBelongsToProduct(req.params.mid, req.params.id) (clean 404 on a mismatch, 400 on a malformed id) before catalog.media.setPrimary(req.params.mid) so the path is self-consistent about which product it touched",
  },
  {
    bugClass: "storefront order-cancel route fires the order FSM's cancel event by id without first asserting the order belongs to the session customer (any signed-in shopper could cancel any order by id — IDOR)",
    detector: "storefront-order-cancel-without-ownership-check",
    gate:     "codebase-patterns",
    note:     "compare order.customer_id against the session customer's id (clean 404 on a mismatch / guest-owned order) before deps.order.transition(id, \"cancel\"); the order primitive transitions by id alone, so the route owns the ownership decision",
  },
];

// The release-pipeline stages each declared gate maps to, plus the
// invocation token the static-gates block in release.js must still
// contain. Assertion (c) reads release.js and checks each token.
var PIPELINE_GATES = {
  "codebase-patterns": "test/layer-0-primitives/codebase-patterns.test.js",
  "currency":          "scripts/check-currency.js",
  "gate-contract":     "scripts/gate-contract.js",
};

// ---- helpers ------------------------------------------------------------

function _readLib() {
  var out = [];
  (function walk(dir) {
    if (path.basename(dir) === "vendor") return;
    var entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return; }
    entries.forEach(function (e) {
      var p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".js")) {
        var rel = path.relative(ROOT, p).replace(/\\/g, "/");
        var content = "";
        try { content = fs.readFileSync(p, "utf8"); } catch (_e2) { content = ""; }
        out.push({ rel: rel, content: content });
      }
    });
  })(path.join(ROOT, "lib"));
  return out;
}

// Line number of the first byte offset where `re` matches `content`,
// 1-based, for a paste-ready `file:line` finding. Returns 1 on no match.
function _lineOf(content, re) {
  var m = re.exec(content);
  if (!m) return 1;
  return content.slice(0, m.index).split(/\r?\n/).length;
}

// Every 1-based line at which `re` matches `content`. Walks each
// non-overlapping match so a marked site doesn't mask a later unmarked
// one in the same file (the advisory scan reports each occurrence).
function _matchLines(content, re) {
  var lines = [];
  var flags = re.flags.indexOf("g") === -1 ? re.flags + "g" : re.flags;
  var globalRe = new RegExp(re.source, flags);
  var m;
  while ((m = globalRe.exec(content)) !== null) {
    lines.push(content.slice(0, m.index).split(/\r?\n/).length);
    if (m.index === globalRe.lastIndex) globalRe.lastIndex += 1;   // zero-width guard
  }
  return lines;
}

// Honor the same exception convention the codebase-patterns detectors
// use, so the candidate-gap scan doesn't re-flag a site that already
// carries a documented allow marker for the matching detector class:
//   - file-level header in the first 50 lines:
//       // codebase-patterns:allow-file <class> — <reason>
//   - per-line marker on the match line or up to 2 lines above:
//       ... // allow:<class> — <reason>
// `lineNum` is the 1-based line of the candidate hit.
function _hasAllowMarker(content, lineNum, allowClass) {
  var lines = content.split(/\r?\n/);
  var fileRe = new RegExp("codebase-patterns:allow-file\\s+" + allowClass + "\\b");
  for (var i = 0; i < Math.min(lines.length, 50); i += 1) {
    if (fileRe.test(lines[i])) return true;
  }
  var lineRe = new RegExp("allow:" + allowClass + "\\b");
  var here   = lines[lineNum - 1] || "";
  var above1 = lines[lineNum - 2] || "";
  var above2 = lines[lineNum - 3] || "";
  return lineRe.test(here) || lineRe.test(above1) || lineRe.test(above2);
}

// ---- candidate-gap heuristics ------------------------------------------
//
// Each returns an array of { file, line, why } candidates. A clean tree
// emits none — every known site already names its catalog/SSRF check, so
// the heuristics only fire on a NEW surface that forgot it.

// (1) New outbound webhook-style URL validator without an SSRF compose.
//     The canonical outbound-delivery throw shape is `<ns>: url must be`
//     / `<ns>: endpoint_url must be`. A file carrying that shape AND
//     b.safeUrl.parse, but NOT naming an SSRF composition, is a
//     candidate. Content/canonical URL validators don't carry the
//     outbound throw shape, so they're not flagged.
var WEBHOOK_OUTBOUND_RE = /["'](?:webhooks: url|webhookSubscriptions: endpoint_url) must be /;
var SAFEURL_PARSE_RE = /\bsafeUrl\.parse\s*\(/;
var SSRF_COMPOSE_RE = /textGuard\.hostLabel|ssrfGuard\.classify|ssrfGuard\.checkUrl/;
function _candOutboundUrl(files) {
  var cands = [];
  files.forEach(function (f) {
    // Only the webhook-style outbound delivery validators are in scope:
    // they name an operator/customer-supplied fan-out target. Tie to the
    // webhook canonical throw shape so content-URL validators (which also
    // say "url must be") aren't swept in.
    if (!WEBHOOK_OUTBOUND_RE.test(f.content)) return;
    if (!SAFEURL_PARSE_RE.test(f.content)) return;
    if (SSRF_COMPOSE_RE.test(f.content)) return;        // composes the guard anywhere — covered
    var line = _lineOf(f.content, WEBHOOK_OUTBOUND_RE);
    if (_hasAllowMarker(f.content, line, "outbound-webhook-url-without-ssrf-guard")) return;
    cands.push({
      file: f.rel,
      line: line,
      why:  "outbound webhook-style URL validator without an SSRF composition (textGuard.hostLabel / ssrfGuard.classify)",
    });
  });
  return cands;
}

// (2) New money-binding currency site without the ISO 4217 catalog
//     check. A file that calls a balance-binding issue/grant/credit but
//     names neither money.CURRENCIES nor textGuard.currencyCode is a
//     candidate (the same condition Detector B enforces, surfaced as an
//     advisory the moment a new site appears).
var MONEY_BIND_RE = /\b(?:giftcards\.issue|storeCredit\.(?:issue|grant|adjust)|giftCardLedger\.(?:issue|credit))\s*\(/;
var CATALOG_CHECK_RE = /money\.CURRENCIES|textGuard\.currencyCode/;
function _candMoneyBinding(files) {
  var cands = [];
  files.forEach(function (f) {
    if (!MONEY_BIND_RE.test(f.content)) return;
    if (CATALOG_CHECK_RE.test(f.content)) return;       // composes the catalog check — covered
    var line = _lineOf(f.content, MONEY_BIND_RE);
    if (_hasAllowMarker(f.content, line, "money-binding-currency-without-catalog-check")) return;
    cands.push({
      file: f.rel,
      line: line,
      why:  "money-binding issue/grant/credit without an ISO 4217 catalog check (b.money.CURRENCIES / textGuard.currencyCode)",
    });
  });
  return cands;
}

// (3) New admin 5xx response echoing a raw error message. Mirrors the
//     admin-5xx-echoes-raw-error-message detector shape; surfaced here so
//     a fresh occurrence is flagged for classification even before the
//     detector itself is taught the new file.
var ADMIN_5XX_RAW_RE = /_problem\s*\(\s*res\s*,\s*5\d\d\s*,\s*["'][^"']+["']\s*,\s*(?:\(?\s*e\s*&&\s*e\.message|e\.message|String\s*\(\s*e\s*\))/;
function _candAdmin5xxRaw(files) {
  var cands = [];
  files.forEach(function (f) {
    if (!ADMIN_5XX_RAW_RE.test(f.content)) return;
    _matchLines(f.content, ADMIN_5XX_RAW_RE).forEach(function (line) {
      if (_hasAllowMarker(f.content, line, "admin-5xx-echoes-raw-error-message")) return;
      cands.push({
        file: f.rel,
        line: line,
        why:  "admin 5xx problem-details echoes a raw error message (record server-side; return a generic code)",
      });
    });
  });
  return cands;
}

// ---- the verifier -------------------------------------------------------
//
// Pure: reads the tree, returns { ok, gaps } where each gap is
// { kind, message } with a paste-ready message. No process exit, no
// stdout — the script body below applies the exit-contract.
function verify() {
  var gaps = [];

  // Load the detector catalog. Requiring the test module is
  // side-effect-free off its entry point (no self-spawn, no run()).
  var catalog;
  try {
    catalog = require("../test/layer-0-primitives/codebase-patterns.test.js").KNOWN_ANTIPATTERNS;
  } catch (e) {
    gaps.push({
      kind: "registry-unreadable",
      message: "REGISTRY UNREADABLE  could not load KNOWN_ANTIPATTERNS from codebase-patterns.test.js (" + (e && e.message) + ")",
    });
    return { ok: false, gaps: gaps };
  }
  if (!Array.isArray(catalog)) {
    gaps.push({
      kind: "registry-unreadable",
      message: "REGISTRY UNREADABLE  codebase-patterns.test.js did not export a KNOWN_ANTIPATTERNS array",
    });
    return { ok: false, gaps: gaps };
  }

  var idSet = {};
  var declaredDetectorIds = {};
  catalog.forEach(function (ap) {
    if (ap && ap.id) idSet[ap.id] = ap;
    if (ap && ap.id && ap.bugClassDeclared) declaredDetectorIds[ap.id] = true;
  });

  // (a) every declared detector exists.
  COVERAGE.forEach(function (row) {
    if (!idSet[row.detector]) {
      gaps.push({
        kind: "missing-detector",
        message: "MISSING DETECTOR  " + row.detector +
          "  (declared in gate-contract COVERAGE for \"" + row.bugClass +
          "\", absent from KNOWN_ANTIPATTERNS)",
      });
    }
  });

  // (b) every bugClassDeclared detector has a COVERAGE row.
  var coveredDetectors = {};
  COVERAGE.forEach(function (row) { coveredDetectors[row.detector] = true; });
  Object.keys(declaredDetectorIds).forEach(function (id) {
    if (!coveredDetectors[id]) {
      gaps.push({
        kind: "undeclared-detector",
        message: "UNDECLARED DETECTOR  " + id +
          "  (carries bugClassDeclared:true in KNOWN_ANTIPATTERNS but has no COVERAGE row in gate-contract) " +
          "— add a COVERAGE row naming its bug-class + gate",
      });
    }
  });

  // (c) every gate the registry depends on is still wired into the
  //     release pipeline static-gates block.
  var releaseSrc = "";
  try {
    releaseSrc = fs.readFileSync(path.join(ROOT, "scripts", "release.js"), "utf8");
  } catch (e) {
    gaps.push({
      kind: "release-unreadable",
      message: "PIPELINE UNREADABLE  could not read scripts/release.js (" + (e && e.message) + ")",
    });
  }
  if (releaseSrc) {
    var neededGateNames = {};
    COVERAGE.forEach(function (row) { neededGateNames[row.gate] = true; });
    neededGateNames["gate-contract"] = true;            // this gate must wire itself in
    Object.keys(neededGateNames).forEach(function (gateName) {
      var token = PIPELINE_GATES[gateName];
      if (!token) {
        gaps.push({
          kind: "unknown-gate",
          message: "UNKNOWN GATE  \"" + gateName + "\"  (named in a COVERAGE row but not in gate-contract's PIPELINE_GATES map) " +
            "— add it to PIPELINE_GATES with the release.js invocation token",
        });
        return;
      }
      if (releaseSrc.indexOf(token) === -1) {
        gaps.push({
          kind: "gate-not-wired",
          message: "GATE NOT WIRED  " + gateName + " (\"" + token + "\")  is not invoked in scripts/release.js " +
            "— re-add the `_run(\"node\", [\"" + token + "\"])` line to cmdPrepare's static-gates block",
        });
      }
    });
  }

  // (d) candidate-gap scan over lib/ — advisory, hard-fail only when a
  //     candidate is genuinely undeclared (a clean tree emits none).
  var files = _readLib();
  var candidates = []
    .concat(_candOutboundUrl(files))
    .concat(_candMoneyBinding(files))
    .concat(_candAdmin5xxRaw(files));
  candidates.forEach(function (c) {
    gaps.push({
      kind: "candidate",
      message: "CANDIDATE GAP  " + c.file + ":" + c.line + "  " + c.why +
        "  -> add a detector + a COVERAGE row, or compose the named guard",
    });
  });

  return { ok: gaps.length === 0, gaps: gaps };
}

module.exports = { verify: verify, COVERAGE: COVERAGE, PIPELINE_GATES: PIPELINE_GATES };

// ---- run ----------------------------------------------------------------
if (require.main === module) {
  var result = verify();
  var n = COVERAGE.length;
  process.stdout.write("[gate-contract] verified " + n + " declared bug-class coverage row(s)\n");
  if (result.ok) {
    process.stdout.write("[gate-contract] OK — every declared bug-class maps to a live detector + an enforced gate; no candidate gaps\n");
    process.exit(0);
  }
  process.stderr.write("\n");
  result.gaps.forEach(function (g) { process.stderr.write(g.message + "\n"); });
  process.stderr.write("\n");
  if (ALLOW_GAPS) {
    process.stderr.write("[gate-contract] " + result.gaps.length + " gap(s) — RELEASE_ALLOW_GATE_GAPS=1 set, continuing (deferred).\n");
    process.exit(0);
  }
  process.stderr.write("[gate-contract] FAIL — " + result.gaps.length + " gap(s). Fix the line(s) above, or set RELEASE_ALLOW_GATE_GAPS=1 to consciously defer.\n");
  process.exit(1);
}
