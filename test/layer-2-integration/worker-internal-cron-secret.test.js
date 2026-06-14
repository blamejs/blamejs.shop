"use strict";
/**
 * Worker-edge shared-secret pre-check on the internal cron / event POSTs.
 *
 * The worker→container internal endpoints (cart-recovery-tick,
 * stock-alert-sweep, wishlist-alerts-sweep, wishlist-digest-sweep,
 * stale-order-reap, quote-expiry-tick, customer-portal-expire,
 * campaign-send-tick) are fired
 * machine-to-machine from the worker's own scheduled() handler, each carrying
 * the shared `x-d1-bridge-secret` header. The container validates that secret
 * first thing in every handler; the worker now ALSO validates it at the edge
 * before forwarding, so a forged publicly-reachable POST is refused before any
 * container resource is touched (defense-in-depth).
 *
 * Two properties the gate must keep, both critical to NOT recreating the
 * bot-guard-403'd-cron incident:
 *   - It FAILS OPEN when D1_BRIDGE_SECRET is unconfigured (forwards anyway),
 *     so a deploy that hasn't wired the secret doesn't 401 every cron.
 *   - The worker's own scheduled() fires carry the header, so a configured
 *     deploy never blocks its own cron — every internal POST in the gated set
 *     is constructed with the `x-d1-bridge-secret` header.
 *
 * The Worker imports the Cloudflare containers runtime + ESM render modules,
 * so it can't be require()'d in a plain Node test — the checks anchor to the
 * shipped source (same source-parity discipline worker-asset-security-headers
 * and document-policy-header use for the edge).
 *
 * Guarded by existsSync: worker/ is excluded from the container build context
 * (.dockerignore), so when worker/index.js isn't present (in-image smoke) the
 * assertions are skipped rather than crashing the gate; the full-tree CI run
 * has worker/ present and exercises this.
 *
 * Network: zero.
 */

var nodeFs   = require("node:fs");
var nodePath = require("node:path");

var helpers = require("../helpers");
var check   = helpers.check;

// The internal cron paths that fall THROUGH to the container forward (i.e.
// have no earlier explicit handler) and so must be covered by the new gate.
// /_/low-stock-alert + /_/db/query + /_/r2/put have their own earlier gates;
// /_/health + /_/version are browser-shaped / unauthenticated and must NOT be
// in the set.
var GATED_PATHS = [
  "/_/cart-recovery-tick",
  "/_/stock-alert-sweep",
  "/_/wishlist-alerts-sweep",
  "/_/wishlist-digest-sweep",
  "/_/stale-order-reap",
  "/_/quote-expiry-tick",
  "/_/customer-portal-expire",
  "/_/campaign-send-tick",
  "/_/winback-send-tick",
];

function _run() {
  var workerIndexPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  if (!nodeFs.existsSync(workerIndexPath)) return;   // worker/ absent in-image — skip

  var src = nodeFs.readFileSync(workerIndexPath, "utf8");

  // (1) The gated-path table exists and lists every fall-through cron path.
  check("worker declares _INTERNAL_CRON_PATHS table",
    /var\s+_INTERNAL_CRON_PATHS\s*=\s*\{/.test(src));
  // Isolate the table literal so a path mentioned elsewhere (e.g. in
  // scheduled()) can't satisfy these membership checks by accident.
  var tableStart = src.indexOf("_INTERNAL_CRON_PATHS");
  var tableOpen  = src.indexOf("{", tableStart);
  var tableClose = src.indexOf("}", tableOpen);
  var tableLiteral = (tableStart !== -1 && tableOpen !== -1 && tableClose !== -1)
    ? src.slice(tableOpen, tableClose + 1) : "";
  GATED_PATHS.forEach(function (p) {
    check("cron path " + p + " is in the gated table",
      tableLiteral.indexOf('"' + p + '"') !== -1);
  });
  // /_/health and /_/version must NOT be gated by this table (no secret).
  check("/_/health is NOT in the cron-secret table",
    tableLiteral.indexOf('"/_/health"') === -1);
  check("/_/version is NOT in the cron-secret table",
    tableLiteral.indexOf('"/_/version"') === -1);

  // (2) The gate runs on POST + membership, timing-safe-compares the
  //     x-d1-bridge-secret, and returns 401 on mismatch. Anchor the whole
  //     block so the pieces are proven adjacent, not scattered.
  var gateRe = new RegExp(
    "request\\.method === \"POST\"[\\s\\S]{0,160}?" +
    "_INTERNAL_CRON_PATHS[\\s\\S]{0,400}?" +
    "env\\.D1_BRIDGE_SECRET[\\s\\S]{0,200}?" +
    "_timingSafeEqual\\([\\s\\S]{0,160}?" +
    "UNAUTHORIZED",
  );
  check("worker gates internal cron POSTs with a timing-safe secret check → 401",
    gateRe.test(src));

  // (3) FAIL-OPEN when the secret is unconfigured — the gate only enforces
  //     INSIDE `if (env.D1_BRIDGE_SECRET)`, so an unconfigured worker forwards
  //     rather than 401-ing every cron.
  check("cron-secret gate fails open when D1_BRIDGE_SECRET is unconfigured",
    /Object\.prototype\.hasOwnProperty\.call\(\s*_INTERNAL_CRON_PATHS\s*,\s*pathname\s*\)[\s\S]{0,120}?if\s*\(\s*env\.D1_BRIDGE_SECRET\s*\)/.test(src));

  // (4) Every scheduled() fire of a gated path carries the header — otherwise
  //     a configured deploy would 401 its OWN cron. For each gated path that
  //     scheduled() actually fires, assert a Request to it sets
  //     `x-d1-bridge-secret`. (cart-recovery / stock-alert / wishlist sweeps /
  //     stale-order-reap / customer-portal-expire / campaign-send all fire
  //     from scheduled with the header.)
  GATED_PATHS.forEach(function (p) {
    // Find the `new URL("<path>", ...)` construction; the surrounding Request
    // headers object must include the secret header within a small window.
    var idx = src.indexOf('new URL("' + p + '"');
    if (idx === -1) return;   // not fired from scheduled() — gate still covers it
    var window = src.slice(idx, idx + 600);
    check("scheduled() fire of " + p + " carries x-d1-bridge-secret",
      /"x-d1-bridge-secret"\s*:\s*env\.D1_BRIDGE_SECRET/.test(window));
  });
}

module.exports = { run: _run };

if (require.main === module) {
  _run();
  process.stdout.write("worker-internal-cron-secret OK (" + helpers.getChecks() + " checks)\n");
}
