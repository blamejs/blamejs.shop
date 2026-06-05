"use strict";
// Stripe Elements payment glue for /pay/:order_id.
//
// Served as an external same-origin asset (not inline) so the pay page's
// route-scoped CSP — `script-src 'self' https://js.stripe.com`,
// `require-trusted-types-for 'script'` — admits it without an inline
// `<script>` or a nonce. The Stripe.js SDK is the only third-party
// `<script src>` on the page; this island wires the Payment Element +
// Express Checkout against it.
//
// Per-request data (publishable key, PaymentIntent client_secret, order id)
// is read from `data-*` attributes the server HTML-escaped at render time
// — never interpolated into this script. Trusted-Types safe: only Stripe's
// own DOM API (mount) + textContent are used; no innerHTML.
(function () {
  var island = document.getElementById("pay-island");
  if (!island || typeof window.Stripe !== "function") return;
  var pk      = island.getAttribute("data-pk")      || "";
  var secret  = island.getAttribute("data-cs")      || "";
  var orderId = island.getAttribute("data-order")   || "";
  if (!pk || !secret) return;

  var stripe   = window.Stripe(pk);
  // Appearance: Stripe's "night" base recolored with the shop's own dark
  // tokens (mirrors :root in themes/default/assets/css/main.css — violet
  // accent, neutral near-black surfaces, soft ink) so the iframe'd inputs
  // read as part of the page instead of a white card. Font falls back to
  // the system stack inside Stripe's iframe: shipping the self-hosted
  // Hanken Grotesk into a cross-origin iframe needs CORS-enabled font
  // assets — revisit if the fallback ever reads wrong.
  var appearance = {
    theme: "night",
    variables: {
      colorPrimary:       "#AD38DB",
      colorBackground:    "#131317",
      colorText:          "#F9F8FA",
      colorTextSecondary: "#9b9ba7",
      colorTextPlaceholder: "#9b9ba7",
      colorDanger:        "#ff6b6b",
      fontFamily:         "'Hanken Grotesk', system-ui, sans-serif",
      borderRadius:       "10px",
      focusBoxShadow:     "0 0 0 1px #AD38DB",
      focusOutline:       "1px solid #AD38DB"
    },
    rules: {
      ".Input":          { border: "1px solid #26262e" },
      ".Input:focus":    { border: "1px solid #AD38DB" },
      ".Tab":            { border: "1px solid #26262e" },
      ".Tab--selected":  { borderColor: "#AD38DB" },
      ".Block":          { backgroundColor: "#1b1b21", border: "1px solid #26262e" }
    }
  };
  var elements = stripe.elements({ clientSecret: secret, appearance: appearance });
  var returnUrl = window.location.origin + "/orders/" + orderId;
  var message   = document.getElementById("payment-message");

  function confirm() {
    if (message) message.textContent = "Processing...";
    return stripe.confirmPayment({ elements: elements, confirmParams: { return_url: returnUrl } }).then(function (result) {
      if (result.error && message) { message.textContent = result.error.message || "Payment failed."; }
    });
  }

  // Express Checkout Element — renders Apple Pay / Google Pay / Link wallet
  // buttons when the device + the shop's registered payment-method domain
  // make them available. It confirms the same PaymentIntent as the card
  // form, so the webhook + order FSM are identical. Hidden until Stripe
  // reports an available wallet so the divider never sits over an empty box.
  // White-family wallet buttons — the black variants vanish on the
  // near-black card; white/outline keeps each brand's contrast rules.
  var ece = elements.create("expressCheckout", {
    buttonTheme: { applePay: "white-outline", googlePay: "white", paypal: "white" },
    buttonHeight: 44
  });
  ece.on("ready", function (ev) {
    if (ev && ev.availablePaymentMethods) {
      var box = document.getElementById("express-checkout");
      if (box) box.hidden = false;
    }
  });
  ece.on("confirm", function () { confirm(); });
  ece.mount("#express-checkout-element");

  var paymentElement = elements.create("payment");
  paymentElement.mount("#payment-element");

  var submitBtn = document.getElementById("submit");
  if (submitBtn) submitBtn.addEventListener("click", function () { confirm(); });
})();
