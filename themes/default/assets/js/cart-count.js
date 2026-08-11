/* Session-chrome island — cart badge, and the operator "viewing as customer"
 * banner.
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
 * The same response carries whether this browser is an operator viewing a
 * customer's account, for the same reason the count does: an edge-cached page
 * is one body served to everyone, so nothing about WHO is looking can be
 * baked into it. One request fills both.
 *
 * No analytics, no writes. One same-origin GET. CSP-safe: this file is an
 * external `'self'` script (the strict `script-src 'self'` blocks inline), and
 * it builds nodes with createElement + textContent — never innerHTML — so no
 * Trusted Types sink is touched and no value can become markup.
 */
(function () {
  "use strict";

  function updateCartBadge(count) {
    var pill = document.querySelector(".cart-pill");
    if (!pill) return;
    var badge = pill.querySelector(".cart-pill__count");
    if (!badge) return;
    // Defensive: the badge is display chrome — only a non-negative integer
    // updates it; anything else leaves the server-rendered value untouched.
    if (typeof count !== "number" || !isFinite(count) || count < 0 || Math.floor(count) !== count) return;
    var text = String(count);
    if (badge.textContent === text) return;
    badge.textContent = text;
    // The aria-label carries the count as a digit run (e.g. "Cart, 0 items");
    // swap that run for the live count so the accessible name stays in step
    // with the visible badge, in whatever locale the page rendered.
    var aria = pill.getAttribute("aria-label");
    if (aria && /\d/.test(aria)) {
      pill.setAttribute("aria-label", aria.replace(/\d+/, text));
    }
  }

  // Without this, an operator who starts a support session and then browses
  // the catalog sees a shop that looks exactly like an ordinary visit — and
  // the next thing they do lands on someone else's account.
  function raiseImpersonationBanner(customerId) {
    var host = document.getElementById("impersonation-banner");
    if (!host || host.firstChild) return;

    var strip = document.createElement("div");
    strip.className = "impersonation-banner";
    strip.setAttribute("role", "status");

    var text = document.createElement("span");
    text.className = "impersonation-banner__text";
    text.textContent = "You are viewing the storefront as customer " + customerId +
      ". Anything you do here is recorded against this support session.";
    strip.appendChild(text);

    // A real form POST, not a fetch: leaving must work even if the rest of
    // this script failed, and the POST is what ends the session server-side.
    var form = document.createElement("form");
    form.method = "post";
    form.action = "/account/impersonate/end";
    form.className = "impersonation-banner__exit";

    // The double-submit CSRF field, added here by hand.
    //
    // Server-rendered forms get this injected during render; this one is built
    // in the browser afterwards, so nothing would have injected it and the
    // POST would be refused by the csrf guard. That failure would be a bad
    // one: the exit control is the operator's way OUT of someone else's
    // account, and a button that silently does nothing is worse than no
    // button. Same JS-readable cookie the passkey islands read.
    var csrf = (document.cookie.match(/(?:^|; )(?:__Host-csrf|csrf)=([^;]+)/) || [])[1] || "";
    if (csrf) {
      var hidden = document.createElement("input");
      hidden.type = "hidden";
      hidden.name = "_csrf";
      hidden.value = decodeURIComponent(csrf);
      form.appendChild(hidden);
    }

    var button = document.createElement("button");
    button.type = "submit";
    button.textContent = "Stop viewing as customer";
    form.appendChild(button);
    strip.appendChild(form);

    host.appendChild(strip);
  }

  // The page path rides along. With edge rendering on, the catalog, product,
  // search, blog and content pages are answered by the Worker and never reach
  // the container — so the container's own record of an impersonated session
  // would show a string of /cart/count calls and not one page the operator
  // actually looked at. Reporting the path here is what keeps "every request
  // is recorded" true for the majority of browsing.
  //
  // Only the path, never the query string: a search term or a filter can
  // carry whatever the operator typed, and the audit trail does not need it.
  // The server screens and length-caps this before storing it — it arrives
  // from a browser, so it is not trusted here.
  var here = "/";
  try { here = window.location.pathname || "/"; } catch (_e) { here = "/"; }
  // 256 matches the cap the action log stores, so the value the server keeps
  // is the value sent rather than a silently shortened one.
  var countUrl = "/cart/count?p=" + encodeURIComponent(here.slice(0, 256));

  fetch(countUrl, { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      updateCartBadge(data.count);
      var imp = data.impersonating;
      if (!imp) return;
      var id = imp.customer_id;
      if (typeof id !== "string" || !id.length || id.length > 64) return;
      raiseImpersonationBanner(id);
    })
    .catch(function () { /* drop-silent — keep the server-rendered chrome */ });
})();
