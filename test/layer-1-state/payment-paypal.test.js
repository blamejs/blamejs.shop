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
  check("token uses Basic auth",                   /^Basic /.test(calls[0].headers["authorization"]));
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

async function run() {
  await _createOrder();
  await _tokenCached();
  await _captureAndRefund();
  await _getOrder();
  await _zeroDecimal();
  await _verifyWebhook();
  await _errorPath();
  await _validation();
}

module.exports = { run: run };
