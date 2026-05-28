/* Cookie-consent banner island.
 *
 * The banner is server-rendered into the chrome of every page and is
 * visible by default, so a visitor with JavaScript disabled still sees
 * it and can accept / reject / manage entirely through the server-
 * rendered form (POST /consent). This island only handles two
 * progressive-enhancement concerns:
 *
 *   1. Dismissal on cached pages. The storefront edge-caches read pages
 *      for cookie-less visitors, so the same HTML document is served to
 *      everyone — the banner cannot be omitted server-side per visitor.
 *      A returning visitor carries a non-sealed `shop_consent_set` flag
 *      cookie (set alongside the authoritative sealed `shop_consent`
 *      cookie when they decide). When that flag is present we mark the
 *      document so CSS hides the banner, avoiding a re-prompt on every
 *      navigation.
 *
 *   2. Return-to-current-page. The banner form posts back to the path
 *      the visitor is on so the POST 303 lands them where they were
 *      rather than on the home page. The hidden field defaults to "/"
 *      for the JS-off case; here we narrow it to the live path.
 *
 * No analytics, no network calls, no third-party anything — the flag
 * cookie is read locally and the decision itself is recorded by the
 * server. The authoritative gate for non-essential cookies/trackers is
 * the sealed cookie + the consent ledger, never this file.
 */
(function () {
  "use strict";

  function readFlag(name) {
    var pairs = (document.cookie || "").split(";");
    for (var i = 0; i < pairs.length; i += 1) {
      var p = pairs[i].trim();
      var eq = p.indexOf("=");
      if (eq <= 0) continue;
      if (p.slice(0, eq) === name) return p.slice(eq + 1);
    }
    return null;
  }

  // The active consent policy version is stamped on this script's tag by
  // the server (container) / edge worker. A decision counts as current only
  // when the flag cookie's value matches it. A missing flag, a legacy
  // unversioned flag, or one captured under a superseded policy version all
  // fall through to leaving the banner visible, so the visitor re-confirms
  // under the policy now in force — mirroring the server-side gate, which
  // stops honoring a sealed decision whose policy_version has lagged.
  var island = document.getElementById("consent-island");
  var activePolicy = island ? island.getAttribute("data-consent-policy") : null;
  var flag = readFlag("shop_consent_set");
  var DECIDED = flag !== null && activePolicy !== null && flag === activePolicy;

  if (DECIDED) {
    // CSS keys off this attribute to hide #consent-banner. Hiding via a
    // class on <html> (rather than removing the node) keeps the manage
    // page's own re-open affordance intact and avoids a layout jump.
    document.documentElement.setAttribute("data-consent-decided", "1");
  } else {
    // Banner is showing. It's a role="dialog" that sits last in the DOM,
    // so a keyboard visitor would tab through the whole page before
    // reaching Accept / Reject — yet the bar visually overlays the fold.
    // Move focus to its first actionable control on load so the decision
    // is reachable immediately. Focus only, no scroll-jacking: the bar is
    // fixed at the viewport bottom and already in view. The banner stays
    // dismissible by keyboard (Tab/Shift+Tab reach every control; the
    // form submits on Enter).
    var banner = document.getElementById("consent-banner");
    if (banner && typeof banner.querySelector === "function") {
      var firstControl = banner.querySelector("button, a[href]");
      if (firstControl && typeof firstControl.focus === "function") {
        try {
          firstControl.focus({ preventScroll: true });
        } catch (_e) {
          // Older engines reject the options object — fall back to a
          // bare focus() call.
          firstControl.focus();
        }
      }
    }
  }

  // Narrow the form's return_to to the current path so the POST 303
  // returns the visitor to the page they were on. Only same-origin
  // path-and-query is used; anything else falls back to the server
  // default ("/") the hidden field already carries.
  var field = document.querySelector("[data-consent-return]");
  if (field) {
    var here = window.location.pathname + (window.location.search || "");
    if (here.charAt(0) === "/" && here.charAt(1) !== "/") {
      field.value = here;
    }
  }
})();
