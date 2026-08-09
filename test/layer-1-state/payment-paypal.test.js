"use strict";
/**
 * PayPal payment adapter (Orders v2) — unit tests with a STUB httpClient.
 *
 * No network: a stub `httpClient.request` records every outbound call and
 * returns canned PayPal responses. Covers the OAuth2 client-credentials
 * token exchange (+ caching), create / capture / get / refund, minor→major
 * decimal-string conversion (incl. a 0-decimal currency), the API-callback
 * webhook verification, and the error + validation paths.
 */

process.env.BLAMEJS_SKIP_NTP_CHECK = "1";

var bShop   = require("../../lib");
var helpers = require("../helpers");
var check   = helpers.check;
var assert  = helpers.assert;
var payment = bShop.payment;

function _res(status, obj) {
  return { statusCode: status, body: Buffer.from(JSON.stringify(obj), "utf8") };
}

// Read a recorded request header without caring how it was capitalised — the
// adapter's own dials use lowercase, the framework's OAuth client uses the
// canonical spelling, and HTTP treats them as the same header.
function _header(call, name) {
  var headers = (call && call.headers) || {};
  var want = name.toLowerCase();
  var keys = Object.keys(headers);
  for (var i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() === want) return headers[keys[i]];
  }
  return undefined;
}

// Build a stub httpClient that records calls and answers by path. `routes`
// maps a path-substring → function(reqOpts) → response.
function _stub(routes, calls) {
  return {
    request: async function (reqOpts) {
      calls.push(reqOpts);
      var keys = Object.keys(routes);
      for (var i = 0; i < keys.length; i += 1) {
        if (reqOpts.url.indexOf(keys[i]) !== -1) return routes[keys[i]](reqOpts);
      }
      return _res(404, { name: "RESOURCE_NOT_FOUND" });
    },
  };
}

var TOKEN_ROUTE = {
  "/v1/oauth2/token": function () { return _res(200, { access_token: "A21AA-token", token_type: "Bearer", expires_in: 32400 }); },
};

function _adapter(routes, calls, extra) {
  var r = Object.assign({}, TOKEN_ROUTE, routes);
  return payment.create(Object.assign({
    adapter: "paypal", clientId: "AY-client-id-xxxxxxxx", secret: "EL-secret-xxxxxxxx",
    sandbox: true, httpClient: _stub(r, calls), webhookId: "WH-TEST-1",
  }, extra || {}));
}

async function _createOrder() {
  var calls = [];
  var pp = _adapter({
    "/v2/checkout/orders": function () { return _res(201, { id: "ORDER-1", status: "CREATED" }); },
  }, calls);
  var order = await pp.createOrder({ amount_minor: 2999, currency: "USD", order_id: "shop-order-7" });
  check("createOrder returns the PayPal order",   order.id === "ORDER-1" && order.status === "CREATED");
  // First call is the OAuth2 token exchange (Basic auth), second is the order.
  check("token exchanged before the order",        calls.length === 2 && calls[0].url.indexOf("/v1/oauth2/token") !== -1);
  // PayPal requires HTTP Basic client auth. Header names are case-insensitive
  // on the wire, so read it that way rather than pinning one spelling.
  var tokenAuth = _header(calls[0], "authorization");
  check("token uses Basic auth",                   /^Basic /.test(tokenAuth));
  check("Basic credentials are the client id and secret",
    Buffer.from(String(tokenAuth).slice(6), "base64").toString("utf8") ===
      "AY-client-id-xxxxxxxx:EL-secret-xxxxxxxx");
  // client_secret_basic must not ALSO leave the secret in the request body.
  check("the client secret is not repeated in the token request body",
    String(calls[0].body || "").indexOf("EL-secret-xxxxxxxx") === -1);
  check("token dial keeps the PayPal host pin",
    Array.isArray(calls[0].allowedHosts) && calls[0].allowedHosts.indexOf("api-m.sandbox.paypal.com") !== -1);
  check("order call uses the bearer token",        calls[1].headers["authorization"] === "Bearer A21AA-token");
  var sent = JSON.parse(calls[1].body);
  check("order intent is CAPTURE",                 sent.intent === "CAPTURE");
  check("amount is a 2-dp decimal string",         sent.purchase_units[0].amount.value === "29.99" && sent.purchase_units[0].amount.currency_code === "USD");
  check("custom_id carries the shop order id",      sent.purchase_units[0].custom_id === "shop-order-7");
  check("order call sends PayPal-Request-Id",       !!calls[1].headers["paypal-request-id"]);
}

async function _tokenCached() {
  var calls = [];
  var pp = _adapter({
    "/v2/checkout/orders": function () { return _res(201, { id: "ORDER-2", status: "CREATED" }); },
  }, calls);
  await pp.createOrder({ amount_minor: 100, currency: "USD" });
  await pp.createOrder({ amount_minor: 200, currency: "USD" });
  var tokenCalls = calls.filter(function (c) { return c.url.indexOf("/v1/oauth2/token") !== -1; });
  check("token fetched once across two orders (cached)", tokenCalls.length === 1);
}

async function _captureAndRefund() {
  var calls = [];
  var pp = _adapter({
    "/capture": function () { return _res(201, { id: "ORDER-3", status: "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] } }] }); },
    "/refund":  function (req) { return _res(201, { id: "REF-1", status: "COMPLETED", _body: req.body }); },
  }, calls);
  var cap = await pp.captureOrder("ORDER-3");
  check("captureOrder completes",                  cap.status === "COMPLETED" && cap.purchase_units[0].payments.captures[0].id === "CAP-1");
  // Full refund: no amount in the body.
  var refFull = await pp.refund({ capture_id: "CAP-1" });
  check("full refund completes",                   refFull.status === "COMPLETED");
  var fullBody = JSON.parse(calls[calls.length - 1].body);
  check("full refund sends no amount",             fullBody.amount === undefined);
  // Partial refund: amount present.
  await pp.refund({ capture_id: "CAP-1", amount_minor: 500, currency: "USD" });
  var partBody = JSON.parse(calls[calls.length - 1].body);
  check("partial refund sends amount 5.00",        partBody.amount && partBody.amount.value === "5.00");
  // Two keyless refunds on the same capture must NOT share a PayPal-Request-Id
  // (else PayPal replays the first instead of executing the second).
  await pp.refund({ capture_id: "CAP-1", amount_minor: 100, currency: "USD" });
  var refundCalls = calls.filter(function (c) { return c.url.indexOf("/refund") !== -1; });
  var ids = refundCalls.map(function (c) { return c.headers["paypal-request-id"]; });
  check("keyless refunds get distinct request ids", new Set(ids).size === ids.length);
  // An explicit idempotency key makes a retry stable (same id).
  await pp.refund({ capture_id: "CAP-1", amount_minor: 100, currency: "USD" }, "rk-1");
  await pp.refund({ capture_id: "CAP-1", amount_minor: 100, currency: "USD" }, "rk-1");
  var keyed = calls.filter(function (c) { return c.url.indexOf("/refund") !== -1; }).slice(-2)
    .map(function (c) { return c.headers["paypal-request-id"]; });
  check("same idempotency key → same request id",   keyed[0] === keyed[1]);
}

async function _getOrder() {
  var calls = [];
  var pp = _adapter({
    "/v2/checkout/orders/ORDER-9": function () { return _res(200, { id: "ORDER-9", status: "APPROVED" }); },
  }, calls);
  var o = await pp.getOrder("ORDER-9");
  check("getOrder returns the order",              o.id === "ORDER-9" && o.status === "APPROVED");
  check("getOrder is a GET",                       calls[1].method === "GET");
}

async function _zeroDecimal() {
  var calls = [];
  var pp = _adapter({ "/v2/checkout/orders": function () { return _res(201, { id: "O", status: "CREATED" }); } }, calls);
  await pp.createOrder({ amount_minor: 2999, currency: "JPY" });
  var sent = JSON.parse(calls[1].body);
  check("JPY (0-decimal) amount is a plain integer string", sent.purchase_units[0].amount.value === "2999");
}

async function _verifyWebhook() {
  var calls = [];
  var pp = _adapter({
    "/v1/notifications/verify-webhook-signature": function () { return _res(200, { verification_status: "SUCCESS" }); },
  }, calls);
  var rawBody = JSON.stringify({ id: "WH-EVT-1", event_type: "PAYMENT.CAPTURE.COMPLETED" });
  var headers = {
    "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert",
    "paypal-transmission-id": "tx-1", "paypal-transmission-sig": "sig-1", "paypal-transmission-time": "2026-05-25T00:00:00Z",
  };
  var ok = await pp.verifyWebhook(headers, rawBody);
  check("verifyWebhook ok on SUCCESS",             ok.ok === true && ok.event.id === "WH-EVT-1");
  var verifyCall = calls[calls.length - 1];
  var vBody = JSON.parse(verifyCall.body);
  check("verify sends webhook_id + transmission",   vBody.webhook_id === "WH-TEST-1" && vBody.transmission_id === "tx-1" && vBody.webhook_event.id === "WH-EVT-1");

  // Non-SUCCESS verification status → not ok.
  var calls2 = [];
  var pp2 = _adapter({ "/v1/notifications/verify-webhook-signature": function () { return _res(200, { verification_status: "FAILURE" }); } }, calls2);
  var bad = await pp2.verifyWebhook(headers, rawBody);
  check("verifyWebhook not-ok on FAILURE",         bad.ok === false && /verification-status-FAILURE/.test(bad.reason));

  // Missing transmission headers → not ok, no API call.
  var calls3 = [];
  var pp3 = _adapter({}, calls3);
  var miss = await pp3.verifyWebhook({}, rawBody);
  check("verifyWebhook not-ok on missing headers", miss.ok === false && miss.reason === "missing-transmission-headers");
  check("no verify API call when headers missing", calls3.length === 0);

  // No webhook id configured → not ok.
  var calls4 = [];
  var pp4 = payment.create({ adapter: "paypal", clientId: "AY-x-xxxxxxxx", secret: "EL-x-xxxxxxxx", sandbox: true, httpClient: _stub(TOKEN_ROUTE, calls4) });
  var noId = await pp4.verifyWebhook(headers, rawBody);
  check("verifyWebhook not-ok without webhook id", noId.ok === false && noId.reason === "no-webhook-id");
}

async function _errorPath() {
  var calls = [];
  var pp = _adapter({
    "/v2/checkout/orders": function () { return _res(422, { name: "UNPROCESSABLE_ENTITY", message: "bad order", details: [{ description: "amount invalid" }] }); },
  }, calls);
  await assert.rejects(pp.createOrder({ amount_minor: 100, currency: "USD" }), /paypal: POST .* HTTP 422/);
}

// The webhook-verification dial rides its OWN circuit breaker. A spammer can
// drive the verify API into a 4xx stream at will (any header-complete POST
// to the unauthenticated webhook route forces a verify dial), so verify
// failures must never open the circuit live checkout's createOrder rides —
// that would let webhook spam fast-fail real payments for the cooldown
// window.
// The token exchange runs inside b.auth.oauth, but it must still dial through
// THIS adapter's client — so the payment circuit breaker and the bounded retry
// cover it like every other PayPal call. If the manager reached for its own
// client instead, the one endpoint whose failure most clearly says "PayPal is
// unhealthy" would be the one the circuit could not see.
async function _tokenDialRidesBreakerAndRetry() {
  var calls = [];
  var pp = _adapter({
    "/v1/oauth2/token":    function () { return _res(500, { error: "server_error" }); },
    "/v2/checkout/orders": function () { return _res(201, { id: "ORDER-X", status: "CREATED" }); },
  }, calls);
  var tokenDials = function () {
    return calls.filter(function (c) { return c.url.indexOf("/v1/oauth2/token") !== -1; }).length;
  };

  var failed = null;
  try { await pp.createOrder({ amount_minor: 100, currency: "USD" }); }
  catch (e) { failed = e; }

  check("a failing token exchange rejects the order",  failed !== null);
  // b.httpClient resolves a 500 as an ordinary response, so this only holds if
  // the dial raises the non-2xx itself — which is what puts the token endpoint
  // inside the retry and the circuit at all.
  check("a 5xx token exchange is retried, not sent once",   tokenDials() > 1);
  check("the retry stays bounded",                          tokenDials() <= 3);
  check("the breaker recorded the failure (the token dial is inside the circuit)",
    pp.breaker.consecutiveFailures > 0);
  check("a failing token exchange never reaches the orders endpoint",
    calls.filter(function (c) { return c.url.indexOf("/v2/checkout/orders") !== -1; }).length === 0);
  // Checkout renders its recoverable "didn't go through" page for anything
  // that is not a TypeError, so this must not surface as one.
  check("the failure is not a TypeError (recoverable checkout page, not a field error)",
    !(failed instanceof TypeError));

  // Repeated attempts must stop reaching PayPal. The manager opens a backoff
  // window after a transient failure and serves nothing from it, so further
  // orders fail without dialling — protection the previous hand-rolled cache
  // did not have, and it engages sooner than the breaker's own threshold.
  var beforeBurst = tokenDials();
  for (var i = 0; i < 6; i += 1) {
    try { await pp.createOrder({ amount_minor: 200 + i, currency: "USD" }); } catch (_e) { /* expected */ }
  }
  check("further orders during the backoff window dial PayPal zero more times",
    tokenDials() === beforeBurst);
}

async function _verifyBreakerIsolated() {
  var calls = [];
  var pp = _adapter({
    "/v1/notifications/verify-webhook-signature": function () { return _res(400, { name: "INVALID_REQUEST" }); },
    "/v2/checkout/orders": function () { return _res(201, { id: "ORDER-OK", status: "CREATED" }); },
  }, calls);
  check("adapter exposes a distinct verify breaker", !!pp.verifyBreaker && pp.verifyBreaker !== pp.breaker);
  var headers = {
    "paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://api.paypal.com/cert",
    "paypal-transmission-id": "tx-1", "paypal-transmission-sig": "sig-1", "paypal-transmission-time": "2026-05-25T00:00:00Z",
  };
  var rawBody = JSON.stringify({ id: "WH-SPAM", event_type: "PAYMENT.CAPTURE.COMPLETED" });
  // Past the failure threshold (5 consecutive) — enough to open a breaker.
  for (var i = 0; i < 7; i += 1) {
    var r = await pp.verifyWebhook(headers, rawBody);
    check("spam verify " + i + " refused (never ok)", r.ok === false);
  }
  // The verify circuit is now open (fast-fail), but the PAYMENT circuit is
  // untouched: a real checkout dial still goes through and succeeds.
  var order = await pp.createOrder({ amount_minor: 2999, currency: "USD" });
  check("checkout dial unaffected by verify-failure stream", order.id === "ORDER-OK");
}

// _decimalToMinor — the strict inverse of the outbound minor→decimal
// conversion, used by the webhook refund mirror. Exact, zero-decimal-aware,
// and throwing (never guessing) on garbage.
function _decimalToMinorUnit() {
  var d2m = payment._decimalToMinor;
  check("USD 5.00 → 500",        d2m("5.00", "USD") === 500);
  check("USD 5.5 → 550",         d2m("5.5", "USD") === 550);
  check("USD 0.01 → 1",          d2m("0.01", "USD") === 1);
  check("USD 29 → 2900",         d2m("29", "USD") === 2900);
  check("JPY 2999 → 2999",       d2m("2999", "JPY") === 2999);
  check("round-trips the outbound conversion",
    d2m(payment._minorToDecimalString(123456, "USD"), "USD") === 123456);
  assert.throws(function () { d2m("5.001", "USD"); }, /decimal string/);
  assert.throws(function () { d2m("12.5", "JPY"); }, /fractional digits/);
  assert.throws(function () { d2m("-5.00", "USD"); }, /decimal string/);
  assert.throws(function () { d2m("5,00", "USD"); }, /decimal string/);
  assert.throws(function () { d2m(500, "USD"); }, /decimal string/);
  assert.throws(function () { d2m(undefined, "USD"); }, /decimal string/);
  assert.throws(function () { d2m("5.00", "usd"); }, /ISO 4217/);
}

// Boot-time configuration lint: credentials without PAYPAL_WEBHOOK_ID warn
// (verification would refuse every delivery, silently); a complete or empty
// env stays quiet. Pure — never throws, never changes behavior.
function _configWarnings() {
  var warn = payment.paypalConfigWarnings;
  check("no creds → no warning",          warn({}).length === 0);
  check("complete env → no warning",      warn({ PAYPAL_CLIENT_ID: "A", PAYPAL_SECRET: "S", PAYPAL_WEBHOOK_ID: "WH" }).length === 0);
  var w = warn({ PAYPAL_CLIENT_ID: "A", PAYPAL_SECRET: "S" });
  check("creds without webhook id → one warning naming the variable",
    w.length === 1 && w[0].indexOf("PAYPAL_WEBHOOK_ID") !== -1);
  check("partial creds → no warning",     warn({ PAYPAL_CLIENT_ID: "A" }).length === 0);
  check("garbage input → no warning, no throw", warn(null).length === 0);
}

async function _validation() {
  assert.throws(function () { payment.create({ adapter: "paypal" }); }, /clientId/);
  assert.throws(function () { payment.create({ adapter: "paypal", clientId: "AY-client-xxxxxxxx" }); }, /secret/);
  assert.throws(function () { payment.create({ adapter: "wat", clientId: "AY-xxxxxxxx", secret: "EL-xxxxxxxx" }); }, /unknown adapter/);
  var calls = [];
  var pp = _adapter({}, calls);
  // Input shape is validated synchronously (throws before the promise).
  assert.throws(function () { pp.createOrder({ amount_minor: 0, currency: "USD" }); }, /amount_minor/);
  assert.throws(function () { pp.createOrder({ amount_minor: 100, currency: "usd" }); }, /currency/);
  assert.throws(function () { pp.refund({}); }, /capture_id/);
}

// A burst of calls arriving on a cold token cache must mint ONE token, not
// one per call. The exchange runs behind a keyed serializer and re-checks the
// cache inside it, so the callers that queue behind the first find the token
// already there. PayPal rate-limits the token endpoint well below the rate a
// checkout burst can reach, so a per-call exchange is a live outage shape.
async function _tokenSingleFlightUnderBurst() {
  var calls = [];
  var routes = {
    "/v1/oauth2/token": async function () {
      // Hold the exchange open long enough that the whole burst overlaps it.
      await new Promise(function (r) { setTimeout(r, 25); });
      return _res(200, { access_token: "A21AA-token", token_type: "Bearer", expires_in: 32400 });
    },
    "/v2/checkout/orders": function () { return _res(201, { id: "ORDER-B", status: "CREATED" }); },
  };
  var pp = payment.create({
    adapter: "paypal", clientId: "AY-client-id-xxxxxxxx", secret: "EL-secret-xxxxxxxx",
    sandbox: true, httpClient: _stub(routes, calls), webhookId: "WH-TEST-1",
  });

  var burst = [];
  for (var i = 0; i < 6; i += 1) {
    burst.push(pp.createOrder({ amount_minor: 1000 + i, currency: "USD", order_id: "burst-" + i }));
  }
  var orders = await Promise.all(burst);

  var tokenCalls = calls.filter(function (c) { return c.url.indexOf("/v1/oauth2/token") !== -1; });
  var orderCalls = calls.filter(function (c) { return c.url.indexOf("/v2/checkout/orders") !== -1; });
  check("burst of 6 mints exactly one token",        tokenCalls.length === 1);
  check("burst of 6 still places all 6 orders",      orderCalls.length === 6);
  check("every order in the burst succeeded",        orders.length === 6 && orders.every(function (o) { return o.id === "ORDER-B"; }));
}

async function run() {
  await _createOrder();
  await _tokenCached();
  await _tokenSingleFlightUnderBurst();
  await _tokenDialRidesBreakerAndRetry();
  await _captureAndRefund();
  await _getOrder();
  await _zeroDecimal();
  await _verifyWebhook();
  await _errorPath();
  await _verifyBreakerIsolated();
  _decimalToMinorUnit();
  _configWarnings();
  await _validation();
}

module.exports = { run: run };
