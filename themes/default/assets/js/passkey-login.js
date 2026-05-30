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
  var form = document.getElementById("login-form");
  var msg  = document.getElementById("login-message");
  if (!form) return;
  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    msg.textContent = "Requesting challenge...";
    try {
      var beginR = await fetch("/account/passkey/login-begin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "X-CSRF-Token": _csrfToken() }, body: JSON.stringify({ email: document.getElementById("email").value }) });
      if (!beginR.ok) { msg.textContent = "Sign-in unavailable."; return; }
      var options = await beginR.json();
      options.challenge = _b64uToBuf(options.challenge);
      if (options.allowCredentials) options.allowCredentials = options.allowCredentials.map(function (c) { return Object.assign({}, c, { id: _b64uToBuf(c.id) }); });
      var assertion = await navigator.credentials.get({ publicKey: options });
      var payload = { id: assertion.id, rawId: _bufToB64u(assertion.rawId), type: assertion.type, response: { authenticatorData: _bufToB64u(assertion.response.authenticatorData), clientDataJSON: _bufToB64u(assertion.response.clientDataJSON), signature: _bufToB64u(assertion.response.signature), userHandle: assertion.response.userHandle ? _bufToB64u(assertion.response.userHandle) : null } };
      var finishR = await fetch("/account/passkey/login-finish", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "X-CSRF-Token": _csrfToken() }, body: JSON.stringify(payload) });
      if (finishR.ok) { window.location.href = "/account"; } else { msg.textContent = "Sign-in failed."; }
    } catch (e) { msg.textContent = (e && e.message) || "Sign-in error."; }
  });
})();
