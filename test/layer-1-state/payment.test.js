"use strict";
/**
 * payment — Stripe webhook verifier + form encoder + input validation.
 *
 * Outbound Stripe API calls (createPaymentIntent / refund / etc.)
 * compose b.httpClient — already covered upstream by blamejs's own
 * test suite. The layer-1 test here pins:
 *
 *   - HMAC-SHA256 verifier with constant-time compare
 *   - Stripe-Signature header parser (multiple v1=, t=)
 *   - Timestamp tolerance window
 *   - Body must be the RAW string (not pre-parsed JSON)
 *   - Form encoder for nested Stripe params (`metadata[a]=b`)
 *   - Factory validation (apiKey + webhookSecret required)
 *   - Input validation for createPaymentIntent / refund
 */

var nodeCrypto = require("node:crypto");

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;

var b       = bShop.framework;
var payment = bShop.payment;

function _sign(secret, ts, body) {
  return nodeCrypto.createHmac("sha256", secret).update(ts + "." + body).digest("hex");
}

async function _verifierHappyPath() {
  var secret = "whsec_test_" + b.crypto.generateToken(16);
  var ts     = Math.floor(Date.now() / 1000);
  var body   = JSON.stringify({ id: "evt_1", type: "payment_intent.succeeded" });
  var sig    = _sign(secret, ts, body);

  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: secret });
  var r = await s.verifyWebhook({ "stripe-signature": "t=" + ts + ",v1=" + sig }, body);
  check("verifier ok on valid sig",      r.ok === true);
  check("verifier parses event JSON",     r.event.type === "payment_intent.succeeded");
  check("verifier returns full event",    r.event.id === "evt_1");
}

async function _verifierHeaderCaseInsensitive() {
  var secret = "whsec_test_caps";
  var ts     = Math.floor(Date.now() / 1000);
  var body   = "{}";
  var sig    = _sign(secret, ts, body);
  var s      = payment.create({ apiKey: "sk_test_x", webhookSecret: secret });

  var r = await s.verifyWebhook({ "Stripe-Signature": "t=" + ts + ",v1=" + sig }, body);
  check("verifier handles Title-Case header", r.ok === true);
}

async function _verifierMultipleSignatures() {
  // During secret rotation Stripe sends two v1= entries (one per
  // active secret). The verifier should accept either.
  var oldSecret = "whsec_old";
  var newSecret = "whsec_new_xxxxxxxx";
  var ts = Math.floor(Date.now() / 1000);
  var body = "{}";
  var sigOld = _sign(oldSecret, ts, body);
  var sigNew = _sign(newSecret, ts, body);

  var sNew = payment.create({ apiKey: "sk_test_x", webhookSecret: newSecret });
  var rOld = await sNew.verifyWebhook({ "stripe-signature": "t=" + ts + ",v1=" + sigOld + ",v1=" + sigNew }, body);
  check("verifier matches one of multiple v1= sigs", rOld.ok === true);

  // Rotated to the old secret only — accept anyway since either sig matches.
  var sOld = payment.create({ apiKey: "sk_test_x", webhookSecret: oldSecret });
  var rNew = await sOld.verifyWebhook({ "stripe-signature": "t=" + ts + ",v1=" + sigOld + ",v1=" + sigNew }, body);
  check("verifier matches sig under old secret", rNew.ok === true);
}

async function _verifierRejects() {
  var secret = "whsec_reject_test";
  var ts     = Math.floor(Date.now() / 1000);
  var body   = "{}";
  var goodSig = _sign(secret, ts, body);

  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: secret });

  // Bad signature
  var r1 = await s.verifyWebhook({ "stripe-signature": "t=" + ts + ",v1=" + "00".repeat(32) }, body);
  check("verifier rejects wrong sig", r1.ok === false && r1.reason === "signature-mismatch");

  // No header
  var r2 = await s.verifyWebhook({}, body);
  check("verifier rejects no header", r2.ok === false && r2.reason === "no-signature");

  // Outside tolerance window
  var oldTs = ts - 600;   // 10 minutes ago (default tolerance = 5 min)
  var oldSig = _sign(secret, oldTs, body);
  var r3 = await s.verifyWebhook({ "stripe-signature": "t=" + oldTs + ",v1=" + oldSig }, body);
  check("verifier rejects timestamp outside window", r3.ok === false && r3.reason === "timestamp-outside-tolerance");

  // Body mutated → signature mismatch
  var r4 = await s.verifyWebhook({ "stripe-signature": "t=" + ts + ",v1=" + goodSig }, body + " ");
  check("verifier rejects mutated body", r4.ok === false && r4.reason === "signature-mismatch");

  // No timestamp segment
  var r5 = await s.verifyWebhook({ "stripe-signature": "v1=" + goodSig }, body);
  check("verifier rejects missing t=", r5.ok === false && r5.reason === "no-signature");

  // Malformed body — valid sig over the malformed body BUT JSON.parse throws
  var malformed = "{not json";
  var malformedSig = _sign(secret, ts, malformed);
  var r6 = await s.verifyWebhook({ "stripe-signature": "t=" + ts + ",v1=" + malformedSig }, malformed);
  check("verifier passes sig check but reports bad-json", r6.ok === false && r6.reason === "bad-json");
}

async function _verifierBodyTypeGuard() {
  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_anything" });
  // Caller must pass the RAW body string. Passing a parsed object
  // would be a programmer error (the signature is over the raw
  // bytes, not the round-tripped JSON).
  await assert.rejects(s.verifyWebhook({}, { id: 1 }), /rawBody must be the request body string/);
}

async function _formEncoder() {
  // Stripe form encoding — flat, nested, arrays.
  var enc = payment._formEncode({
    amount:   2999,
    currency: "usd",
    automatic_payment_methods: { enabled: true },
    metadata: { order_id: "ord_1", line_count: 3 },
  });
  check("flat fields encoded",      enc.indexOf("amount=2999") !== -1);
  check("nested with brackets",      enc.indexOf("automatic_payment_methods%5Benabled%5D=true") !== -1);
  check("metadata bracket nesting",  enc.indexOf("metadata%5Border_id%5D=ord_1") !== -1);

  // Arrays use key[]
  var enc2 = payment._formEncode({ items: ["a", "b"] });
  check("array uses []",             enc2.indexOf("items%5B%5D=a") !== -1 && enc2.indexOf("items%5B%5D=b") !== -1);
}

async function _factoryValidation() {
  assert.throws(function () { payment.create(); },                                        /apiKey must be/);
  assert.throws(function () { payment.create({}); },                                       /apiKey must be/);
  assert.throws(function () { payment.create({ apiKey: "sk_test_x" }); },                  /webhookSecret must be/);
  assert.throws(function () { payment.create({ apiKey: "sk_test_x", webhookSecret: "" }); }, /webhookSecret must be/);
  assert.throws(function () { payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_x", adapter: "paddle" }); }, /unknown adapter/);
}

async function _inputValidation() {
  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx" });
  // createPaymentIntent
  assert.throws(function () { s.createPaymentIntent(); },                                   /input object required/);
  assert.throws(function () { s.createPaymentIntent({}); },                                  /amount_minor must be a positive integer/);
  assert.throws(function () { s.createPaymentIntent({ amount_minor: 0, currency: "usd" }); }, /amount_minor must be a positive integer/);
  assert.throws(function () { s.createPaymentIntent({ amount_minor: 100, currency: "USD" }); }, /lowercase ISO 4217/);

  // refund
  assert.throws(function () { s.refund(); },                                                 /input object required/);
  assert.throws(function () { s.refund({}); },                                                /payment_intent must be/);
  assert.throws(function () { s.refund({ payment_intent: "pi_abcd1234", reason: "junk" }); },        /reason must be one of/);
  assert.throws(function () { s.refund({ payment_intent: "pi_abcd1234", amount_minor: 0 }); },        /amount_minor must be a positive/);
}

async function run() {
  await _verifierHappyPath();
  await _verifierHeaderCaseInsensitive();
  await _verifierMultipleSignatures();
  await _verifierRejects();
  await _verifierBodyTypeGuard();
  await _formEncoder();
  await _factoryValidation();
  await _inputValidation();
}

module.exports = { run: run };
