"use strict";
// Add-another-passkey ceremony for /account/passkeys.
//
// External asset (not inline) so the strict `script-src 'self'` CSP allows
// it. The page renders server-side; this island wires the "Add a passkey"
// button to navigator.credentials.create against the authed begin/finish
// endpoints, then reloads so the new credential shows in the list.
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
  var btn = document.getElementById("passkey-add-btn");
  var msg = document.getElementById("passkey-add-message");
  if (!btn) return;
  btn.addEventListener("click", async function () {
    if (msg) msg.textContent = "Follow your device's prompt…";
    btn.disabled = true;
    try {
      var beginR = await fetch("/account/passkey/add-begin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "X-CSRF-Token": _csrfToken() }, body: "{}" });
      if (!beginR.ok) { if (msg) msg.textContent = (await beginR.text()) || "Could not start enrollment."; btn.disabled = false; return; }
      var options = await beginR.json();
      options.challenge = _b64uToBuf(options.challenge);
      options.user.id   = _b64uToBuf(options.user.id);
      if (options.excludeCredentials) options.excludeCredentials = options.excludeCredentials.map(function (c) { return Object.assign({}, c, { id: _b64uToBuf(c.id) }); });
      var att = await navigator.credentials.create({ publicKey: options });
      var payload = { id: att.id, rawId: _bufToB64u(att.rawId), type: att.type, response: { attestationObject: _bufToB64u(att.response.attestationObject), clientDataJSON: _bufToB64u(att.response.clientDataJSON), transports: att.response.getTransports ? att.response.getTransports() : [] } };
      var finishR = await fetch("/account/passkey/add-finish", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "X-CSRF-Token": _csrfToken() }, body: JSON.stringify(payload) });
      if (finishR.ok) { window.location.href = "/account/passkeys?ok=added"; } else { if (msg) msg.textContent = (await finishR.text()) || "Enrollment failed."; btn.disabled = false; }
    } catch (e) { if (msg) msg.textContent = (e && e.message) || "Enrollment error."; btn.disabled = false; }
  });
})();
