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

var nodeHttps = require("node:https");
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

// ---- Idempotency cache --------------------------------------------------
//
// Stripe API calls go through `b.httpClient.request`; the primitive
// now accepts an `httpClient` override (same shape as r2Bridge) so a
// stubbed transport can capture the call without touching the
// network. The `query` opt is the second injection point — when
// supplied, mutating calls go through a SELECT/INSERT round-trip
// against an in-memory table; without it the primitive behaves
// identically to the pre-idempotency surface.

function _fakeHttp(responses) {
  var calls = [];
  var i = 0;
  return {
    calls: calls,
    httpClient: {
      request: async function (opts) {
        calls.push(opts);
        var r = responses[Math.min(i, responses.length - 1)];
        i += 1;
        var bodyStr = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
        return {
          statusCode: r.status,
          headers:    r.headers || { "content-type": "application/json" },
          body:       Buffer.from(bodyStr, "utf8"),
        };
      },
    },
  };
}

// Minimal in-memory `query` that satisfies the SELECT / INSERT /
// DELETE shapes the idempotency layer issues. Returns the D1-style
// `{ rows: [...] }` envelope; DELETE surfaces `meta.changes` so
// `cleanupExpired` can report what it removed.
function _fakeQuery() {
  var rows = [];
  var calls = [];
  function _selectByKey(key) {
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i].idempotency_key === key) return rows[i];
    }
    return null;
  }
  var query = async function (sql, params) {
    calls.push({ sql: sql, params: params });
    if (/^SELECT/.test(sql) && /FROM payment_idempotency/.test(sql)) {
      var hit = _selectByKey(params[0]);
      return { rows: hit ? [hit] : [] };
    }
    if (/^INSERT INTO payment_idempotency/.test(sql)) {
      rows.push({
        idempotency_key: params[0],
        operation:       params[1],
        request_hash:    params[2],
        response_status: params[3],
        response_body:   params[4],
        created_at:      params[5],
        expires_at:      params[6],
      });
      return { rows: [], meta: { changes: 1 } };
    }
    if (/^DELETE FROM payment_idempotency/.test(sql)) {
      var cutoff = params[0];
      var before = rows.length;
      rows = rows.filter(function (r) { return r.expires_at >= cutoff; });
      return { rows: [], meta: { changes: before - rows.length } };
    }
    throw new Error("fakeQuery: unhandled SQL: " + sql);
  };
  return {
    query:    query,
    calls:    calls,
    rows:     function () { return rows.slice(); },
    setRows:  function (r) { rows = r; },
  };
}

async function _idempotencyReplayPaymentIntent() {
  var fake  = _fakeHttp([{ status: 200, body: { id: "pi_abc", amount: 2999, currency: "usd" } }]);
  var store = _fakeQuery();
  var s = payment.create({
    apiKey:        "sk_test_x",
    webhookSecret: "whsec_xxxxxxxx",
    httpClient:    fake.httpClient,
    query:         store.query,
  });

  var key   = "ord_42_pi_create_v1";
  var input = { amount_minor: 2999, currency: "usd", metadata: { order_id: "ord_42" } };

  var r1 = await s.createPaymentIntent(input, key);
  check("first call returns Stripe response",        r1.id === "pi_abc");
  check("first call hit Stripe (1 http request)",     fake.calls.length === 1);
  // The Stripe dial must carry the explicit PSP TLS agent: the vendored
  // httpClient's PQC-hybrid-only group list draws handshake_failure
  // (alert 40) from api.stripe.com, so payment constructs a classical-
  // capable agent (TLS 1.3 min, Node default groups) per the framework's
  // own downgrade-visible-in-the-diff prescription. Losing this agent
  // re-breaks every live charge.
  check("Stripe dial carries the PSP TLS agent",
    fake.calls[0].agent instanceof nodeHttps.Agent);
  check("PSP agent pins TLS 1.3 minimum",
    fake.calls[0].agent.options.minVersion === "TLSv1.3");
  check("PSP agent does NOT carry the PQC-only group list",
    fake.calls[0].agent.options.ecdhCurve === undefined);
  check("first call wrote cache row",                 store.rows().length === 1);
  check("cached row carries operation",               store.rows()[0].operation === "payment_intent.create");
  check("cached row carries 200 status",              store.rows()[0].response_status === 200);
  check("cached row hashes request, not stores raw",  store.rows()[0].request_hash.length === 128);   // SHA3-512 hex
  check("cache row has 24h expiry window",            store.rows()[0].expires_at - store.rows()[0].created_at === payment.IDEMPOTENCY_TTL_MS);

  // Second call — same key, same hash → replay (no second Stripe hit).
  var r2 = await s.createPaymentIntent(input, key);
  check("replay returns stored response",             r2.id === "pi_abc");
  check("replay did NOT hit Stripe",                  fake.calls.length === 1);
  check("replay flag exposed",                        r2._replayed === true);
}

async function _idempotencyCollisionThrows() {
  var fake  = _fakeHttp([{ status: 200, body: { id: "pi_first", amount: 100 } }]);
  var store = _fakeQuery();
  var s = payment.create({
    apiKey:        "sk_test_x",
    webhookSecret: "whsec_xxxxxxxx",
    httpClient:    fake.httpClient,
    query:         store.query,
  });

  var key = "shared_key_collision_v1";
  await s.createPaymentIntent({ amount_minor: 100, currency: "usd" }, key);

  // Same key, DIFFERENT body (attacker tries to replay a larger
  // amount). The primitive MUST refuse — silently returning the
  // stored response would charge the original amount but make the
  // caller believe the new amount succeeded.
  await assert.rejects(
    s.createPaymentIntent({ amount_minor: 99999, currency: "usd" }, key),
    /idempotency_key collision \(different inputs\)/,
  );
  check("collision did NOT issue a second Stripe call", fake.calls.length === 1);
}

async function _idempotencyBypassWhenNoQuery() {
  // No `query` factory opt → idempotency is fully disabled. Each
  // call hits Stripe regardless of whether an idempotency_key is
  // passed (Stripe's own server-side cache is unaffected — we just
  // don't add the local replay layer).
  var fake = _fakeHttp([
    { status: 200, body: { id: "pi_1" } },
    { status: 200, body: { id: "pi_2" } },
  ]);
  var s = payment.create({
    apiKey:        "sk_test_x",
    webhookSecret: "whsec_xxxxxxxx",
    httpClient:    fake.httpClient,
  });
  var key = "same_key_no_cache_v1";
  var r1 = await s.createPaymentIntent({ amount_minor: 500, currency: "usd" }, key);
  var r2 = await s.createPaymentIntent({ amount_minor: 500, currency: "usd" }, key);
  check("no-query: both calls hit Stripe",  fake.calls.length === 2);
  check("no-query: distinct responses",      r1.id === "pi_1" && r2.id === "pi_2");
  check("no-query: idempotency header sent", fake.calls[0].headers["idempotency-key"] === key);
}

async function _idempotencyRefundAndSubscription() {
  // Same replay shape applies to refund + subscriptions.create.
  var fake = _fakeHttp([
    { status: 200, body: { id: "re_1", amount: 500 } },
    { status: 200, body: { id: "sub_1", status: "active" } },
  ]);
  var store = _fakeQuery();
  var s = payment.create({
    apiKey:        "sk_test_x",
    webhookSecret: "whsec_xxxxxxxx",
    httpClient:    fake.httpClient,
    query:         store.query,
  });

  // refund — first call hits Stripe, second replays.
  var refundInput = { payment_intent: "pi_abcd1234", amount_minor: 500, reason: "requested_by_customer" };
  await s.refund(refundInput, "rf_key_v1");
  var rf2 = await s.refund(refundInput, "rf_key_v1");
  check("refund first call hits Stripe",   fake.calls.length === 1);
  check("refund replays from cache",       rf2.id === "re_1" && rf2._replayed === true);
  check("refund stored under refund.create operation",
        store.rows().filter(function (r) { return r.operation === "refund.create"; }).length === 1);

  // subscriptions.create — first call hits Stripe, second replays.
  var subInput = { customer: "cus_abcd1234", items: [{ price: "price_1" }] };
  await s.subscriptions.create(subInput, "sub_key_v1");
  var sc2 = await s.subscriptions.create(subInput, "sub_key_v1");
  check("subscriptions.create first hits Stripe",  fake.calls.length === 2);
  check("subscriptions.create replays",             sc2.id === "sub_1" && sc2._replayed === true);
  check("subscription.create operation recorded",
        store.rows().filter(function (r) { return r.operation === "subscription.create"; }).length === 1);

  // Collision check on refund — same key, different amount.
  await assert.rejects(
    s.refund({ payment_intent: "pi_abcd1234", amount_minor: 9999, reason: "requested_by_customer" }, "rf_key_v1"),
    /idempotency_key collision/,
  );
  check("refund collision did not re-hit Stripe", fake.calls.length === 2);
}

async function _idempotencyKeyValidation() {
  var fake  = _fakeHttp([{ status: 200, body: { id: "pi_1" } }]);
  var store = _fakeQuery();
  var s = payment.create({
    apiKey:        "sk_test_x",
    webhookSecret: "whsec_xxxxxxxx",
    httpClient:    fake.httpClient,
    query:         store.query,
  });
  await assert.rejects(s.createPaymentIntent({ amount_minor: 1, currency: "usd" }, "short"),
                       /idempotency_key must be a string between 8 and 255/);
  await assert.rejects(s.createPaymentIntent({ amount_minor: 1, currency: "usd" }, 12345),
                       /idempotency_key must be a string between 8 and 255/);
}

async function _cleanupExpired() {
  var store = _fakeQuery();
  var now = 1_700_000_000_000;
  store.setRows([
    { idempotency_key: "old_1", operation: "payment_intent.create", request_hash: "h1", response_status: 200, response_body: "{}", created_at: now - 90000000, expires_at: now - 10000 },
    { idempotency_key: "old_2", operation: "refund.create",         request_hash: "h2", response_status: 200, response_body: "{}", created_at: now - 90000000, expires_at: now - 1 },
    { idempotency_key: "fresh", operation: "subscription.create",   request_hash: "h3", response_status: 200, response_body: "{}", created_at: now,             expires_at: now + 86400000 },
  ]);
  var s = payment.create({
    apiKey:        "sk_test_x",
    webhookSecret: "whsec_xxxxxxxx",
    query:         store.query,
    now:           function () { return now; },
  });
  var removed = await s.cleanupExpired();
  check("cleanupExpired removed two expired rows",   removed === 2);
  check("cleanupExpired left the fresh row in place", store.rows().length === 1 && store.rows()[0].idempotency_key === "fresh");

  // Without query, cleanupExpired refuses (idempotency is opt-in;
  // calling cleanup on a primitive that never wrote to the table
  // would silently no-op, which hides a misconfiguration).
  var s2 = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx" });
  await assert.rejects(s2.cleanupExpired(), /requires `query` factory opt/);
}

async function _canonicalHashStable() {
  // Key order doesn't matter; arrays preserve their order.
  var h1 = payment._canonicalHash({ b: 2, a: 1, c: [1, 2] });
  var h2 = payment._canonicalHash({ a: 1, c: [1, 2], b: 2 });
  check("canonical hash stable across key order", h1 === h2);
  var h3 = payment._canonicalHash({ a: 1, c: [2, 1], b: 2 });
  check("canonical hash sensitive to array order", h1 !== h3);
}

async function _factoryRejectsBadOptionTypes() {
  assert.throws(function () { payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", query: 42 }); },
                /query must be a function/);
  assert.throws(function () { payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", now: 42 }); },
                /now must be a function/);
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

async function _paymentMethodDomains() {
  var calls = [];
  var mockHttp = {
    request: function (req) {
      calls.push(req);
      return Promise.resolve({
        statusCode: 200,
        body: Buffer.from(JSON.stringify({ id: "pmd_1", domain_name: "example.com", apple_pay: { status: "active" } }), "utf8"),
      });
    },
  };
  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_test_abcdefghijklmnop", httpClient: mockHttp });

  // Validation — a bad domain throws (TypeError → 400 at the route)
  // before any network call.
  assert.throws(function () { s.registerPaymentMethodDomain("https://example.com/p"); }, /bare hostname/);
  assert.throws(function () { s.registerPaymentMethodDomain("not a domain"); },          /bare hostname/);
  assert.throws(function () { s.registerPaymentMethodDomain(""); },                       /bare hostname/);
  check("no network call on a bad domain",       calls.length === 0);

  // Register POSTs the form-encoded domain_name.
  var reg = await s.registerPaymentMethodDomain("example.com");
  check("register returns the domain object",     reg.id === "pmd_1");
  check("register POSTs to payment_method_domains", calls[0].method === "POST" && calls[0].url.indexOf("/payment_method_domains") !== -1);
  check("register body carries domain_name",      String(calls[0].body).indexOf("domain_name=example.com") !== -1);

  // List with a filter is a GET carrying the query string, no body.
  calls.length = 0;
  await s.listPaymentMethodDomains({ domain_name: "example.com" });
  check("list is a GET",                          calls[0].method === "GET");
  check("list puts the filter in the query",      calls[0].url.indexOf("domain_name=example.com") !== -1);
  check("list sends no body",                     !calls[0].body);
}

// The saved-card vaulting surface: createCustomer + createSetupIntent +
// retrieveSetupIntent + retrievePaymentMethod, each over a stubbed
// httpClient (no network). Asserts the HTTP shapes (path/method/params) +
// the new IDEMPOTENT_OPERATIONS entries + the input validation.
async function _setupIntentAndCustomer() {
  // Realistic-length Stripe ids — the adapter validates them with
  // _assertSecret (min 8 chars), which a real cus_/seti_/pm_ id always clears.
  var CUS = "cus_NffrFeUfNV2Hib";
  var SETI = "seti_1MzFN02eZvKYlo2C";
  var PM = "pm_1MqLiJ2eZvKYlo2C";
  var fake = _fakeHttp([
    { status: 200, body: { id: CUS } },
    { status: 200, body: { id: SETI, client_secret: SETI + "_secret", customer: CUS } },
    { status: 200, body: { id: SETI, payment_method: PM, status: "succeeded" } },
    { status: 200, body: { id: PM, card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 } } },
  ]);
  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fake.httpClient });

  var cust = await s.createCustomer({ metadata: { shop_customer_id: "abc" } });
  check("createCustomer returns the customer",     cust.id === CUS);
  check("createCustomer is a POST /customers",     fake.calls[0].method === "POST" && fake.calls[0].url.indexOf("/customers") !== -1);

  var si = await s.createSetupIntent({ customer: CUS });
  check("createSetupIntent returns client_secret", si.client_secret === SETI + "_secret");
  check("createSetupIntent POSTs /setup_intents",  fake.calls[1].method === "POST" && fake.calls[1].url.indexOf("/setup_intents") !== -1);
  check("setup_intent uses off_session",           (fake.calls[1].body || "").indexOf("usage=off_session") !== -1);
  check("setup_intent binds the customer",          (fake.calls[1].body || "").indexOf("customer=" + CUS) !== -1);

  var got = await s.retrieveSetupIntent(SETI);
  check("retrieveSetupIntent surfaces the pm",     got.payment_method === PM);
  check("retrieveSetupIntent is a GET",            fake.calls[2].method === "GET" && fake.calls[2].url.indexOf("/setup_intents/" + SETI) !== -1);

  var pm = await s.retrievePaymentMethod(PM);
  check("retrievePaymentMethod returns card meta", pm.card.brand === "visa" && pm.card.last4 === "4242");
  check("retrievePaymentMethod is a GET",          fake.calls[3].method === "GET" && fake.calls[3].url.indexOf("/payment_methods/" + PM) !== -1);

  // The new operations are registered as idempotent — proven behaviorally:
  // a keyed setup_intent.create with a `query` caches + replays without a
  // second HTTP hit (an UNregistered operation would throw "unknown
  // idempotent operation" instead).
  var fakeI = _fakeHttp([{ status: 200, body: { id: SETI, client_secret: SETI + "_secret", customer: CUS } }]);
  var storeI = _fakeQuery();
  var sI = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fakeI.httpClient, query: storeI.query });
  var key = "seti_create_v1_key";
  var first = await sI.createSetupIntent({ customer: CUS }, key);
  var replay = await sI.createSetupIntent({ customer: CUS }, key);
  check("setup_intent.create is idempotent (registered)", first.id === SETI && replay._replayed === true && fakeI.calls.length === 1);
  var fakeC = _fakeHttp([{ status: 200, body: { id: CUS } }]);
  var storeC = _fakeQuery();
  var sC = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fakeC.httpClient, query: storeC.query });
  var c1 = await sC.createCustomer({ email: "a@example.com" }, "cust_create_v1_key");
  var c2 = await sC.createCustomer({ email: "a@example.com" }, "cust_create_v1_key");
  check("customer.create is idempotent (registered)", c1.id === CUS && c2._replayed === true && fakeC.calls.length === 1);

  // Input validation.
  assert.throws(function () { s.createSetupIntent({}); },              /customer/);
  assert.throws(function () { s.createSetupIntent(); },                /input object required/);
  assert.throws(function () { s.createCustomer(); },                   /input object required/);
  assert.throws(function () { s.createCustomer({ email: "" }); },      /email must be/);

  // createPaymentIntent's optional off-session params (saved-card reuse):
  // supplying a payment_method confirms immediately + off_session rides.
  var fake2 = _fakeHttp([{ status: 200, body: { id: "pi_off", status: "succeeded" } }]);
  var s2 = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fake2.httpClient });
  await s2.createPaymentIntent({ amount_minor: 2999, currency: "usd", customer: "cus_123", payment_method: "pm_123", off_session: true });
  check("off-session PI sends payment_method",     (fake2.calls[0].body || "").indexOf("payment_method=pm_123") !== -1);
  check("off-session PI confirms immediately",     (fake2.calls[0].body || "").indexOf("confirm=true") !== -1);
  check("off-session PI sends off_session",        (fake2.calls[0].body || "").indexOf("off_session=true") !== -1);
}

// PSP dial resilience: a brown-out (a run of upstream 5xx) trips the
// per-adapter circuit breaker open, the open circuit fast-fails WITHOUT
// touching the network and surfaces a NON-TypeError CIRCUIT_OPEN (so the
// storefront renders the recoverable payment-unavailable page, not a 400
// field error), and a recovery (reset + a healthy response) closes it.
async function _circuitBreakerTripsAndRecovers() {
  // Keyless createPaymentIntent: the breaker counts each 5xx as a failure
  // and (being keyless) the dial does NOT retry, so one POST == one HTTP
  // hit == one breaker tick. Five consecutive failures (the threshold)
  // open the breaker.
  var fake = _fakeHttp([{ status: 503, body: { error: { message: "stripe is down" } } }]);
  var s = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fake.httpClient });
  check("breaker starts closed", s.breaker && s.breaker.getState() === "closed");

  var opened = false;
  var circuitOpenErr = null;
  for (var i = 0; i < 6; i += 1) {
    try { await s.createPaymentIntent({ amount_minor: 100, currency: "usd" }); }
    catch (e) {
      if (e && e.code === "CIRCUIT_OPEN") { opened = true; circuitOpenErr = e; break; }
    }
  }
  check("brown-out trips the breaker open", opened === true && s.breaker.getState() === "open");
  check("open-circuit error is a CIRCUIT_OPEN code", circuitOpenErr && circuitOpenErr.code === "CIRCUIT_OPEN");
  // It must NOT be a TypeError — the storefront treats a TypeError as a
  // shopper-fixable 400 field error; a payment-unavailable must render the
  // recoverable 500-class page instead.
  check("open-circuit error is NOT a TypeError", !(circuitOpenErr instanceof TypeError));
  // The breaker stops the network hit while open: the http stub saw exactly
  // the 5 failures that opened it, not the 6th call.
  check("open circuit fast-fails without a network hit", fake.calls.length === 5);

  // Recovery: reset the breaker (the operator-visible recovery action) and
  // a healthy response closes the loop again.
  s.breaker.reset();
  check("reset returns the breaker to closed", s.breaker.getState() === "closed");
  var fakeOk = _fakeHttp([{ status: 200, body: { id: "pi_recovered", status: "succeeded" } }]);
  var sOk = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fakeOk.httpClient });
  var r = await sOk.createPaymentIntent({ amount_minor: 100, currency: "usd" });
  check("recovery: a healthy dial succeeds with the breaker closed",
    r.id === "pi_recovered" && sOk.breaker.getState() === "closed");

  // Idempotent dials (GET reads / keyed writes) ride the bounded retry: a
  // transient 503 → 503 → 200 is ridden out within ONE breaker call, so the
  // breaker never opens on a blip the retry absorbs.
  var fakeRetry = _fakeHttp([
    { status: 503, body: { error: { message: "blip" } } },
    { status: 503, body: { error: { message: "blip" } } },
    { status: 200, body: { id: "pi_retried", status: "succeeded" } },
  ]);
  var sR = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fakeRetry.httpClient });
  var rr = await sR.retrievePaymentIntent("pi_abcdefgh");
  check("idempotent GET retries through a transient blip (breaker stays closed)",
    rr.id === "pi_retried" && fakeRetry.calls.length === 3 && sR.breaker.getState() === "closed");

  // The breaker is skippable for callers that don't want it.
  var sNB = payment.create({ apiKey: "sk_test_x", webhookSecret: "whsec_xxxxxxxx", httpClient: fakeOk.httpClient, breaker: false });
  check("breaker:false disables the per-adapter breaker", sNB.breaker === null);
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
  await _idempotencyReplayPaymentIntent();
  await _idempotencyCollisionThrows();
  await _idempotencyBypassWhenNoQuery();
  await _idempotencyRefundAndSubscription();
  await _idempotencyKeyValidation();
  await _cleanupExpired();
  await _canonicalHashStable();
  await _factoryRejectsBadOptionTypes();
  await _paymentMethodDomains();
  await _setupIntentAndCustomer();
  await _circuitBreakerTripsAndRecovers();
}

module.exports = { run: run };
