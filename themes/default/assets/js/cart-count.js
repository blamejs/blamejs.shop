/* Cart-count island.
 *
 * The nav cart badge is server-rendered on every storefront chrome page
 * (catalog, product, search, blog, cart, account). On the edge-cached
 * render the badge shows 0: the edge serves one cached HTML body to every
 * cookie-less visitor and cannot read the sealed `shop_sid` to look up a
 * carted/signed-in visitor's real cart. This island corrects the number
 * after load by fetching `/cart/count` — a cheap container route that
 * unseals the session and returns `{"count": N}` (N = cart line count,
 * 0 with no session). A JS-off visitor keeps the server-rendered badge.
 *
 * No analytics, no writes. One same-origin GET; the response updates the
 * badge text and the nav link's aria-label count. CSP-safe: this file is
 * an external `'self'` script (the strict `script-src 'self'` blocks
 * inline), and it touches only `textContent` / `setAttribute`, neither of
 * which is a Trusted Types sink.
 */
(function () {
  "use strict";

  var pill = document.querySelector(".cart-pill");
  if (!pill) return;
  var badge = pill.querySelector(".cart-pill__count");
  if (!badge) return;

  fetch("/cart/count", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      var count = data.count;
      // Defensive: the badge is display chrome — only a non-negative
      // integer updates it; anything else leaves the server-rendered
      // value untouched.
      if (typeof count !== "number" || !isFinite(count) || count < 0 || Math.floor(count) !== count) return;
      var text = String(count);
      if (badge.textContent === text) return;
      badge.textContent = text;
      // The aria-label carries the count as a digit run (e.g.
      // "Cart, 0 items"); swap that run for the live count so the
      // accessible name stays in step with the visible badge, in
      // whatever locale the page rendered.
      var aria = pill.getAttribute("aria-label");
      if (aria && /\d/.test(aria)) {
        pill.setAttribute("aria-label", aria.replace(/\d+/, text));
      }
    })
    .catch(function () { /* drop-silent — keep the server-rendered badge */ });
})();
