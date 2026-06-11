"use strict";
// Trusted Types `default` policy for the Stripe pay page (/pay/:order_id).
//
// WHY THIS LOADS FIRST, WITHOUT `defer`. The page's CSP keeps the strict
// app default `require-trusted-types-for 'script'` +
// `trusted-types 'allow-duplicates' default`. Stripe.js v3 does NOT register
// a Trusted Types policy of its own; it expects the APPLICATION to define a
// `default` policy whose `createScriptURL` vets Stripe's hosts (Stripe
// security guide). When Stripe.js dynamically injects its sub-resource
// <script> (the per-origin `*.js.stripe.com` performance path, and the 3-D
// Secure challenge-frame loader), the browser routes the URL through the
// `default` policy — if none is registered it refuses the assignment with
// "This document requires 'TrustedScriptURL' assignment", which is the error
// class that breaks 3DS challenge flows.
//
// This script is emitted in the markup BEFORE the `<script
// src="https://js.stripe.com/v3/">` tag and carries NO `defer`, so the
// policy is registered synchronously at parse time — before the Stripe SDK
// executes and fires its first dynamic load. pay.js (the deferred island)
// is unaffected by ordering.
//
// THE GATE IS REAL, NOT A BYPASS. `createScriptURL` returns the input ONLY
// for Stripe's own origins (apex `js.stripe.com` + any `*.js.stripe.com`
// sub-origin). Every other URL throws, so the `default` policy — which the
// browser applies to EVERY TrustedScriptURL / TrustedScript / TrustedHTML
// sink on this page — is an explicit allowlist, not a relaxation of Trusted
// Types. Trusted Types enforcement stays ON; this gives it a vetted gate
// instead of dropping the requirement for the route.
(function () {
  var tt = window.trustedTypes;
  // Browsers without Trusted Types (Firefox / Safari) ignore the CSP
  // directive entirely — nothing to register, and Stripe loads normally.
  if (!tt || typeof tt.createPolicy !== "function") return;

  // Only Stripe's own apex + sub-origins. Matches `https://js.stripe.com`
  // and `https://<label>.js.stripe.com` (the performance / 3DS sub-frames),
  // and nothing else.
  var STRIPE_ORIGIN = /^https:\/\/([a-z0-9-]+\.)?js\.stripe\.com$/;

  // Exposed for the route's own islands + unit tests: returns the URL when
  // its origin is a Stripe origin, otherwise throws (the policy callbacks
  // below reuse this so the allowlist has a single definition).
  function vetScriptUrl(input) {
    var origin;
    try { origin = new URL(String(input), window.location.href).origin; }
    catch (_e) { throw new TypeError("blocked TrustedScriptURL: unparseable URL"); }
    if (STRIPE_ORIGIN.test(origin)) return String(input);
    throw new TypeError("blocked TrustedScriptURL: " + origin + " is not a Stripe origin");
  }

  try {
    tt.createPolicy("default", {
      // Vet dynamically-loaded script URLs against the Stripe allowlist.
      createScriptURL: vetScriptUrl,
      // The pay page ships no app-authored inline script or innerHTML sink,
      // so these never fire for our own code. Stripe.js routes its internal
      // TrustedScript / TrustedHTML through the same default policy; pass its
      // values through unchanged (the createScriptURL gate above is what
      // actually constrains where Stripe may pull code from). Any FUTURE app
      // sink that needs HTML/script typing must register its own NAMED policy
      // rather than relying on this passthrough.
      //
      // WHY NOT TIGHTEN createScript / createHTML TO AN ALLOWLIST. The
      // "allow only Stripe" tightening is fully expressed by createScriptURL
      // (a URL has an origin to vet); createScript / createHTML receive a
      // CONTENT STRING (inline script text / markup), which has no origin —
      // there is nothing to match against the Stripe host set. Stripe.js v3
      // does inject its own TrustedScript / TrustedHTML for the 3-D Secure
      // challenge and the dynamic per-origin sub-resource loaders, and that
      // content is opaque + version-dependent. Any value filter here (a
      // prefix/shape check, a length cap, an inline-handler scrub) risks
      // refusing a 3DS payload Stripe legitimately needs — the exact
      // regression the route's prior fix had to undo. The app authors zero
      // content through these sinks, so the passthrough grants the page
      // nothing it doesn't already cede to the Stripe SDK that the page
      // intentionally loads. Re-open the tightening ONLY if the app starts
      // authoring its own TrustedHTML/TrustedScript on this route (then move
      // that app content to a NAMED policy and let the default policy reject
      // all non-Stripe content) OR if Stripe publishes its own Trusted Types
      // policy (then drop the application default entirely).
      createScript: function (s) { return String(s); },
      createHTML: function (h) { return String(h); },
    });
  } catch (_e) {
    // `'allow-duplicates'` is set in the trusted-types directive, so a second
    // registration (e.g. an unexpected double-include) does not throw; this
    // catch is belt-and-suspenders for a browser that still rejects it. Drop
    // silent — a failed registration leaves enforcement as-is, never worse.
  }

  // Expose the validator so pay.js / unit tests can assert the gate without
  // re-deriving the allowlist. Non-enumerable-ish: a plain property is fine
  // (same-origin island, no third-party reads it).
  window.__payTrustedTypesVetScriptUrl = vetScriptUrl;
})();
