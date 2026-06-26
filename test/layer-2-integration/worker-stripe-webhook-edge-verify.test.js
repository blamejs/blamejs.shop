"use strict";
/**
 * Worker-edge Stripe webhook signature verification composes the framework
 * primitive (`b.webhook.verify`, alg "hmac-sha256-stripe") rather than a
 * hand-rolled `t=`/`v1=` parse + HMAC + compare.
 *
 * The edge pre-check rejects unsigned / tampered / replayed deliveries before
 * any container resource is touched; the container then re-verifies
 * authoritatively (defense in depth — covered by stripe-webhook-flow). This
 * gate proves the EDGE path:
 *
 *   (A) The verifier LOGIC the worker composes is correct — exercised
 *       directly against `b.webhook.verify` with the exact call shape the
 *       worker uses (alg, secret, header, body, toleranceMs): a valid
 *       signature passes, a tampered body / tampered signature / stale
 *       timestamp / missing input is refused. Anchored to the vendored
 *       primitive, so it runs in-image too (lib/vendor ships in the container).
 *
 *   (B) Worker-safety regression guard — importing the webhook module for
 *       INBOUND verification must not eager-load the outbound HTTP client
 *       (node:http / node:https / node:http2). That property (the webhook
 *       module resolving its http-client + dispatcher lazily) is exactly what
 *       made composing the verifier at the edge possible; a vendor refresh
 *       that re-introduced an eager load would silently re-brick the Worker
 *       bundle. Proven both behaviourally (require.cache) and by source.
 *
 *   (C) Source-parity on the worker — that worker/index.js composes
 *       `b.webhook.verify` (not the old inline parse) and worker/b.js exposes
 *       the `webhook` namespace. The Worker imports the Cloudflare containers
 *       runtime + ESM render modules, so it can't be require()'d in a plain
 *       Node test (same discipline as worker-internal-cron-secret). Guarded by
 *       existsSync: worker/ is excluded from the container build context, so
 *       the in-image smoke skips (C) rather than crashing.
 *
 * Network: zero — every signature is local HMAC, no call to Stripe.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var nodeFs     = require("node:fs");
var nodePath   = require("node:path");
var nodeCrypto = require("node:crypto");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;
var b       = bShop.framework;

var SECRET = "whsec_test_edge_verify_0123456789";

// Stripe's webhook signature: t=<unix>,v1=<hmac-sha256("<t>.<body>", secret)>.
function _sign(secret, ts, body) {
  return nodeCrypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex");
}
function _header(ts, body, secret) {
  return "t=" + ts + ",v1=" + _sign(secret || SECRET, ts, body);
}

// A byte-for-byte replica of worker/index.js `_verifyStripeSignature` — the
// thin try/catch wrapper around the framework verifier. (C) asserts the worker
// source actually carries this shape; (A) exercises the logic it runs.
async function _edgeVerify(rawBody, header, secret, toleranceSeconds) {
  if (!header || !secret) return { ok: false, reason: "missing-signature-or-secret" };
  try {
    await b.webhook.verify({
      alg:         "hmac-sha256-stripe",
      secret:      secret,
      header:      header,
      body:        rawBody,
      toleranceMs: b.constants.TIME.seconds(toleranceSeconds || 300),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e && e.code) || "signature-invalid" };
  }
}

async function _run() {
  // The framework verifier is reachable under the same namespace the worker
  // adapter re-exports (worker/b.js imports the identical leaf module).
  check("b.webhook.verify is exposed on the framework", typeof b.webhook.verify === "function");

  var body = JSON.stringify({ id: "evt_edge_1", type: "payment_intent.succeeded", data: { object: { id: "pi_edge" } } });
  var nowSec = Math.floor(Date.now() / 1000);

  // ---- (A) verifier logic the worker composes -----------------------------

  var good = await _edgeVerify(body, _header(nowSec, body), SECRET, 300);
  check("valid signature → ok", good.ok === true);

  var tamperedBody = await _edgeVerify(body + " ", _header(nowSec, body), SECRET, 300);
  check("tampered body → refused", tamperedBody.ok === false);

  var tamperedSig = await _edgeVerify(body, "t=" + nowSec + ",v1=" + "00".repeat(32), SECRET, 300);
  check("tampered signature → refused", tamperedSig.ok === false);

  // A signature older than the tolerance window is refused (replay defense).
  var stale = await _edgeVerify(body, _header(nowSec - 1000, body), SECRET, 300);
  check("stale timestamp → refused", stale.ok === false);
  check("stale timestamp carries the stale-timestamp reason", stale.reason === "webhook/stale-timestamp");

  // The same signature, signed under a DIFFERENT secret, must not verify —
  // confirms the secret actually participates (not just header well-formedness).
  var wrongSecret = await _edgeVerify(body, _header(nowSec, body, "whsec_some_other_secret_9999"), SECRET, 300);
  check("signature under the wrong secret → refused", wrongSecret.ok === false);

  // Missing header / secret short-circuit to a stable reason BEFORE the
  // primitive is invoked (the worker never calls verify with a null secret).
  var noHeader = await _edgeVerify(body, null, SECRET, 300);
  check("missing header → missing-signature-or-secret", noHeader.ok === false && noHeader.reason === "missing-signature-or-secret");
  var noSecret = await _edgeVerify(body, _header(nowSec, body), null, 300);
  check("missing secret → missing-signature-or-secret", noSecret.ok === false && noSecret.reason === "missing-signature-or-secret");

  // The primitive itself throws (not returns) on a bad alg — the worker pins
  // "hmac-sha256-stripe", so a regression that dropped the alg would surface
  // here rather than silently verifying under the framework-native scheme.
  await assert.rejects(
    b.webhook.verify({ alg: "hmac-sha3-512", secret: SECRET, header: _header(nowSec, body), body: body, toleranceMs: 300000 }),
    /alg must be/,
    "verify rejects a non-Stripe alg",
  );

  // ---- (B) Worker-safety regression guard ---------------------------------
  //
  // Requiring the webhook module (inbound verification) must not pull the
  // outbound HTTP client into the module graph. Measure a fresh load: the
  // lazyRequire wrapper around http-client must keep it out of require.cache
  // until the send path runs.
  var webhookPath    = require.resolve("../../lib/vendor/blamejs/lib/webhook.js");
  var httpClientPath = require.resolve("../../lib/vendor/blamejs/lib/http-client.js");
  delete require.cache[webhookPath];
  delete require.cache[httpClientPath];
  require(webhookPath);
  check("requiring webhook.js does not eager-load http-client (Worker-safe inbound verify)",
    require.cache[httpClientPath] === undefined);

  // Source-parity on the vendored module: the networking-touching deps
  // (http-client, ssrf-guard, dispatcher, observability) stay behind
  // lazyRequire so a vendor refresh can't re-introduce an eager load.
  var webhookSrc = nodeFs.readFileSync(webhookPath, "utf8");
  check("webhook.js resolves http-client lazily",
    /var\s+httpClient\s*=\s*lazyRequire\(/.test(webhookSrc));
  check("webhook.js resolves the delivery dispatcher lazily",
    /var\s+webhookDispatcher\s*=\s*lazyRequire\(/.test(webhookSrc));

  // ---- (C) worker source-parity (skipped in-image) ------------------------

  var workerIndexPath = nodePath.resolve(__dirname, "..", "..", "worker", "index.js");
  var workerBPath     = nodePath.resolve(__dirname, "..", "..", "worker", "b.js");
  if (!nodeFs.existsSync(workerIndexPath) || !nodeFs.existsSync(workerBPath)) return;   // worker/ absent in-image

  var idxSrc = nodeFs.readFileSync(workerIndexPath, "utf8");
  var bSrc   = nodeFs.readFileSync(workerBPath, "utf8");

  // worker/b.js imports the webhook leaf and exposes it under b.webhook.
  check("worker/b.js imports the webhook leaf module",
    /import\s+bWebhook\s+from\s+["']\.\.\/lib\/vendor\/blamejs\/lib\/webhook\.js["']/.test(bSrc));
  check("worker/b.js exposes b.webhook",
    /webhook:\s*bWebhook/.test(bSrc));

  // worker/index.js _verifyStripeSignature composes b.webhook.verify with the
  // Stripe alg + the seconds→ms tolerance mapping — and no longer hand-rolls
  // the t=/v1= split.
  var verifyStart = idxSrc.indexOf("function _verifyStripeSignature");
  check("worker declares _verifyStripeSignature", verifyStart !== -1);
  var verifyBody = verifyStart !== -1 ? idxSrc.slice(verifyStart, verifyStart + 900) : "";
  check("edge verify composes b.webhook.verify",
    /b\.webhook\.verify\(/.test(verifyBody));
  check("edge verify pins the Stripe HMAC alg",
    /alg:\s*["']hmac-sha256-stripe["']/.test(verifyBody));
  check("edge verify maps the tolerance window to milliseconds via C.TIME",
    /toleranceMs:\s*b\.constants\.TIME\.seconds\(toleranceSeconds\s*\|\|\s*300\)/.test(verifyBody));
  check("edge verify no longer hand-rolls the v1 signature split",
    verifyBody.indexOf('k === "v1"') === -1 && verifyBody.indexOf("sigs.push") === -1);
}

module.exports = { run: _run };

if (require.main === module) {
  _run().then(function () {
    process.stdout.write("worker-stripe-webhook-edge-verify OK (" + helpers.getChecks() + " checks)\n");
  });
}
