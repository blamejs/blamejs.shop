"use strict";
// Passkey (WebAuthn) sign-in ceremony for /account/login.
//
// Served as an external asset (not inline) so the storefront's strict
// `script-src 'self'` CSP allows it — an inline <script> is blocked, which
// is what previously broke sign-in on the deploy. This is the "opt-in
// island" the page progressively enhances with: the form still renders
// server-side; this only wires the submit handler.
(function () {
  function _b64uToBuf(s) {
    s = s.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var raw = atob(s), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr.buffer;
  }
  function _bufToB64u(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  // Read the double-submit CSRF token from the JS-readable cookie
  // (`__Host-csrf` over HTTPS, `csrf` over HTTP) so these fetch POSTs carry
  // the `X-CSRF-Token` header the container's csrfGuard validates.
  function _csrfToken() {
    return (document.cookie.match(/(?:^|; )(?:__Host-csrf|csrf)=([^;]+)/) || [])[1] || "";
  }
  // When a CAPTCHA widget is on the page (operator-configured), captcha.js
  // exposes the solved token via window.__captchaToken(); include it in the
  // begin body so the server verifies it before issuing a challenge. Absent
  // a widget this resolves to "" and the server-side gate is a no-op.
  function _captchaToken() {
    return (typeof window.__captchaToken === "function") ? window.__captchaToken() : "";
  }
  var form = document.getElementById("login-form");
  var msg  = document.getElementById("login-message");
  if (!form) return;

  // The server-rendered email magic-link fallback (the always-available
  // backup path). It is a plain <form> that works with no JS at all; the
  // island only ROUTES a stranded user to it — it never replaces it. Carry
  // the email the shopper already typed into the passkey field across so the
  // fallback is one tap, not a re-type. Absent the block (operator hasn't
  // wired the mailer) the helper is a no-op and the passkey path stands
  // alone, exactly as before.
  var fallback      = document.querySelector("[data-passkey-fallback]");
  var fallbackEmail = fallback && fallback.querySelector("#magic-email");
  function _toFallback(prompt) {
    if (!fallback) return false;
    var typed = document.getElementById("email");
    if (fallbackEmail && typed && typed.value && !fallbackEmail.value) fallbackEmail.value = typed.value;
    if (prompt) msg.textContent = prompt;
    if (fallback.scrollIntoView) fallback.scrollIntoView({ block: "nearest" });
    if (fallbackEmail && fallbackEmail.focus) fallbackEmail.focus();
    return true;
  }

  // No WebAuthn in this browser → there is nothing to enhance. Leave the
  // passkey submit inert and steer the visitor to the email-link form so the
  // page is never a dead end. With a fallback present we disable the passkey
  // button so it can't be pressed into an error; without one we leave the
  // button (the POST fails closed server-side with a clean message).
  var hasWebAuthn = !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.get);
  if (!hasWebAuthn) {
    if (fallback) {
      var pkBtn = form.querySelector("button[type=submit]");
      if (pkBtn) { pkBtn.disabled = true; }
      msg.textContent = "This browser has no passkey support — use the email sign-in link below.";
    }
    return;
  }

  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    msg.textContent = "Requesting challenge...";
    try {
      var beginR = await fetch("/account/passkey/login-begin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "X-CSRF-Token": _csrfToken() }, body: JSON.stringify({ email: document.getElementById("email").value, captcha_token: _captchaToken() }) });
      if (!beginR.ok) { _toFallback("Passkey sign-in is unavailable — try the email link below.") || (msg.textContent = "Sign-in unavailable."); return; }
      var options = await beginR.json();
      options.challenge = _b64uToBuf(options.challenge);
      if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map(function (c) { return Object.assign({}, c, { id: _b64uToBuf(c.id) }); });
      var assertion = await navigator.credentials.get({ publicKey: options });
      var payload = { id: assertion.id, rawId: _bufToB64u(assertion.rawId), type: assertion.type, response: { authenticatorData: _bufToB64u(assertion.response.authenticatorData), clientDataJSON: _bufToB64u(assertion.response.clientDataJSON), signature: _bufToB64u(assertion.response.signature), userHandle: assertion.response.userHandle ? _bufToB64u(assertion.response.userHandle) : null } };
      var finishR = await fetch("/account/passkey/login-finish", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "X-CSRF-Token": _csrfToken() }, body: JSON.stringify(payload) });
      if (finishR.ok) { window.location.href = "/account"; }
      else { _toFallback("Passkey didn't match — sign in with an email link instead.") || (msg.textContent = "Sign-in failed."); }
    } catch (e) {
      // A cancelled / unsupported / errored ceremony lands here. Steer to the
      // email-link fallback so the user is one tap from signing in, never a
      // dead end; with no fallback wired, show the error as before.
      _toFallback("Couldn't use a passkey — sign in with an email link instead.") || (msg.textContent = (e && e.message) || "Sign-in error.");
    }
  });
})();
