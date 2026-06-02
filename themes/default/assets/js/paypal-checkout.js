"use strict";
// PayPal Smart Buttons glue for the checkout page.
//
// Served as an external same-origin asset (not inline) so the checkout
// page's route-scoped CSP — `script-src 'self' https://www.paypal.com ...`,
// `require-trusted-types-for 'script'` — admits it without an inline
// `<script>`. The PayPal SDK is loaded by the third-party `<script src>` in
// the markup (permitted by the same scoped CSP); this island only renders
// the Buttons + drives the create/capture round-trip.
//
// The client-id + currency are read from `data-*` attributes the server
// HTML-escaped at render time — never interpolated into this script.
// Trusted-Types safe: PayPal's own render() owns the button DOM; this
// island only sets textContent on the error line.
(function () {
  var island = document.getElementById("paypal-island");
  if (!island || !window.paypal) return;

  var form  = document.querySelector(".checkout-page form");
  var errEl = document.getElementById("paypal-error");

  function vals() {
    var d = {};
    ["email", "name", "line1", "line2", "city", "country", "state", "postal"].forEach(function (k) {
      var el = form && form.elements[k];
      if (el) { d[k] = el.value; }
    });
    return d;
  }
  function showErr(m) {
    if (errEl) { errEl.hidden = false; errEl.textContent = m || "PayPal checkout could not be completed."; }
  }

  window.paypal.Buttons({
    onClick: function (_d, actions) {
      if (form && form.reportValidity && !form.reportValidity()) { return actions.reject(); }
      return actions.resolve();
    },
    createOrder: function () {
      return fetch("/checkout/paypal/create", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({}, vals(), { captcha_token: window.__captchaToken ? window.__captchaToken() : "" })),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d.id) { throw new Error(d.error || "create failed"); }
        return d.id;
      });
    },
    onApprove: function (data) {
      return fetch("/checkout/paypal/capture", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paypal_order_id: data.orderID }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.redirect) { window.location.href = d.redirect; } else { showErr(d.error); }
      });
    },
    onError: function () { showErr(); },
  }).render("#paypal-button-container");
})();
