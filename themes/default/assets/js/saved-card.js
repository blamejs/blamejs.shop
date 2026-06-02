"use strict";
// Add-a-card glue for /account/payment-methods/add.
//
// Served as an external same-origin asset (not inline) so the page's
// route-scoped CSP — `script-src 'self' https://js.stripe.com`,
// `require-trusted-types-for 'script'` — admits it without an inline
// `<script>` or a nonce. The Stripe.js SDK is the only third-party
// `<script src>` on the page; this island mounts a SetupIntent Payment
// Element against it and, on confirm, posts the resulting setup_intent_id
// back to the server form so the saved pm_… is vaulted.
//
// The publishable key is read from a data-* attribute the server
// HTML-escaped at render time. The SetupIntent client_secret is fetched
// per-session from POST /account/payment-methods/setup-intent (never baked
// into the page HTML). Trusted-Types safe: only Stripe's own DOM API
// (mount) + textContent are used; no innerHTML.
(function () {
  var island = document.getElementById("add-card-island");
  if (!island || typeof window.Stripe !== "function") return;
  var pk = island.getAttribute("data-pk") || "";
  if (!pk) return;

  var form   = document.getElementById("add-card-form");
  var siField = document.getElementById("add-card-si");
  var submit = document.getElementById("add-card-submit");
  var message = document.getElementById("add-card-message");
  if (!form || !siField || !submit) return;

  // Read the double-submit CSRF token from the JS-readable cookie
  // (`__Host-csrf` over HTTPS, `csrf` over HTTP) so the setup-intent fetch
  // POST carries the `X-CSRF-Token` header the container's csrfGuard
  // validates.
  function csrfToken() {
    return (document.cookie.match(/(?:^|; )(?:__Host-csrf|csrf)=([^;]+)/) || [])[1] || "";
  }
  function setMessage(text) { if (message) message.textContent = text || ""; }

  var stripe = window.Stripe(pk);
  var elements = null;
  var ready = false;

  // Open a SetupIntent server-side, then mount the Payment Element against
  // its client_secret. A failure leaves the form inert with a message.
  fetch("/account/payment-methods/setup-intent", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", "X-CSRF-Token": csrfToken() },
    body: "{}",
  }).then(function (r) {
    if (!r.ok) { setMessage("Couldn't start adding a card. Please try again."); return null; }
    return r.json();
  }).then(function (data) {
    if (!data || !data.client_secret) { setMessage("Couldn't start adding a card. Please try again."); return; }
    elements = stripe.elements({ clientSecret: data.client_secret, appearance: { theme: "stripe" } });
    var paymentElement = elements.create("payment");
    paymentElement.mount("#payment-element");
    ready = true;
  }).catch(function () {
    setMessage("Couldn't start adding a card. Please try again.");
  });

  submit.addEventListener("click", function () {
    if (!ready || !elements) { setMessage("Still loading — please wait a moment."); return; }
    setMessage("Saving your card…");
    submit.disabled = true;
    stripe.confirmSetup({
      elements: elements,
      redirect: "if_required",
    }).then(function (result) {
      if (result.error) {
        setMessage(result.error.message || "That card couldn't be saved.");
        submit.disabled = false;
        return;
      }
      var si = result.setupIntent;
      if (si && si.id) {
        // Hand the confirmed SetupIntent id to the server form (which carries
        // the hidden _csrf field the container injects) and submit it — the
        // server reads the pm_… off the intent and vaults it.
        siField.value = si.id;
        form.submit();
      } else {
        setMessage("That card couldn't be confirmed. Please try again.");
        submit.disabled = false;
      }
    }).catch(function (e) {
      setMessage((e && e.message) || "That card couldn't be saved.");
      submit.disabled = false;
    });
  });
})();
