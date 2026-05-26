"use strict";
// Passkey (WebAuthn) registration ceremony for /account/register.
//
// External asset (not inline) so the strict `script-src 'self'` CSP allows
// it. The form renders server-side; this island wires the submit handler
// that runs navigator.credentials.create and posts the attestation.
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
  var form = document.getElementById("reg-form");
  var msg  = document.getElementById("reg-message");
  if (!form) return;
  form.addEventListener("submit", async function (ev) {
    ev.preventDefault();
    msg.textContent = "Creating account...";
    try {
      var beginR = await fetch("/account/passkey/register-begin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: document.getElementById("email").value, display_name: document.getElementById("display_name").value }) });
      if (!beginR.ok) { msg.textContent = (await beginR.text()) || "Registration unavailable."; return; }
      var options = await beginR.json();
      options.challenge = _b64uToBuf(options.challenge);
      options.user.id   = _b64uToBuf(options.user.id);
      if (options.excludeCredentials) options.excludeCredentials = options.excludeCredentials.map(function (c) { return Object.assign({}, c, { id: _b64uToBuf(c.id) }); });
      var att = await navigator.credentials.create({ publicKey: options });
      var payload = { id: att.id, rawId: _bufToB64u(att.rawId), type: att.type, response: { attestationObject: _bufToB64u(att.response.attestationObject), clientDataJSON: _bufToB64u(att.response.clientDataJSON), transports: att.response.getTransports ? att.response.getTransports() : [] } };
      var finishR = await fetch("/account/passkey/register-finish", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (finishR.ok) { window.location.href = "/account"; } else { msg.textContent = (await finishR.text()) || "Enrollment failed."; }
    } catch (e) { msg.textContent = (e && e.message) || "Registration error."; }
  });
})();
