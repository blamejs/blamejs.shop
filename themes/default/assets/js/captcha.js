"use strict";
// CAPTCHA widget glue for the auth + checkout pages.
//
// Served as an external same-origin asset (not inline) so the page's
// route-scoped CSP — `script-src 'self' <provider-host>`,
// `require-trusted-types-for 'script'` — admits it without an inline
// `<script>`. The provider SDK (Turnstile / hCaptcha / reCAPTCHA api.js)
// is loaded by a third-party `<script src>` in the markup, permitted by the
// same scoped CSP; this island explicitly renders the widget into the mount
// div (so the provider's auto-render `class="cf-turnstile"` markup, which
// some CSP-strict pages block, isn't relied on) and exposes the current
// token to the passkey ceremony islands via `window.__captchaToken()`.
//
// kind + sitekey are read from `data-*` attributes the server HTML-escaped
// at render time — never interpolated into this script. Trusted-Types safe:
// the provider's own render() owns the widget DOM; this island only writes
// a hidden input value (the explicit-render token sink).
(function () {
  var mount = document.getElementById("captcha-widget");
  if (!mount) return;
  var kind    = mount.getAttribute("data-captcha-kind") || "";
  var sitekey = mount.getAttribute("data-sitekey")      || "";
  if (!kind || !sitekey) return;

  var current = "";
  // The hidden field that rides a plain form POST (checkout). The provider
  // also injects its own field on auto-render, but the explicit-render
  // callback is the reliable token source under a strict CSP.
  var field = document.getElementById("captcha-token-field");
  function setToken(t) {
    current = t || "";
    if (field) field.value = current;
  }
  // Exposed for the passkey register/login islands, which POST JSON (no
  // form field) and add `captcha_token` to the body.
  window.__captchaToken = function () { return current; };

  function renderTurnstile() {
    if (!window.turnstile) return false;
    window.turnstile.render(mount, {
      sitekey:           sitekey,
      callback:          setToken,
      "expired-callback": function () { setToken(""); },
      "error-callback":   function () { setToken(""); },
    });
    return true;
  }
  function renderHcaptcha() {
    if (!window.hcaptcha) return false;
    window.hcaptcha.render(mount, {
      sitekey:          sitekey,
      callback:         setToken,
      "expired-callback": function () { setToken(""); },
      "error-callback":   function () { setToken(""); },
    });
    return true;
  }
  function renderRecaptcha() {
    if (!window.grecaptcha || !window.grecaptcha.render) return false;
    window.grecaptcha.render(mount, {
      sitekey:           sitekey,
      callback:          setToken,
      "expired-callback": function () { setToken(""); },
    });
    return true;
  }

  function attempt() {
    if (kind === "turnstile") return renderTurnstile();
    if (kind === "hcaptcha")  return renderHcaptcha();
    if (kind === "recaptcha_v2" || kind === "recaptcha_v3") return renderRecaptcha();
    return false;
  }

  // The provider SDK loads async (defer); poll briefly until its global is
  // present, then render once. Bounded so a blocked SDK never spins forever.
  if (attempt()) return;
  var tries = 0;
  var timer = setInterval(function () {
    tries += 1;
    if (attempt() || tries > 100) { clearInterval(timer); }
  }, 100);
})();
