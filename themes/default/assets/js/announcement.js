/* Announcement-bar island.
 *
 * The bar is server-rendered into the top of every page (container + edge)
 * and is visible by default, so a visitor with JavaScript disabled still
 * sees it and can dismiss it through the server-rendered form (POST
 * /announcements/:slug/dismiss, which records the dismissal + sets the
 * cookie + 303s back). This island handles two progressive-enhancement
 * concerns only:
 *
 *   1. Dismissal on cached pages. The edge serves the same cached HTML to
 *      every cookie-less visitor, so a dismissed bar cannot be omitted
 *      server-side per visitor. A returning visitor carries a non-sealed
 *      `shop_ann_dismissed` cookie listing the slugs they've dismissed;
 *      we hide any matching bar locally so it doesn't reappear on every
 *      navigation.
 *
 *   2. Dismiss-without-navigation. Clicking the × normally POSTs the
 *      server form (303 back). Here we intercept it: append the slug to
 *      the cookie and hide the bar in place, no round-trip.
 *
 * No analytics, no network calls. The durable dismissal record (for the
 * no-JS path) is the server's job; this file only reads/writes the local
 * hint cookie and toggles the native `hidden` attribute.
 */
(function () {
  "use strict";

  var COOKIE = "shop_ann_dismissed";

  function readCookie(name) {
    var pairs = (document.cookie || "").split(";");
    for (var i = 0; i < pairs.length; i += 1) {
      var p = pairs[i].trim();
      var eq = p.indexOf("=");
      if (eq <= 0) continue;
      if (p.slice(0, eq) === name) return p.slice(eq + 1);
    }
    return null;
  }

  function parseSlugs(value) {
    if (!value) return [];
    var out = [];
    var parts = value.split(",");
    for (var i = 0; i < parts.length; i += 1) {
      var s = parts[i].trim();
      if (s && out.indexOf(s) === -1) out.push(s);
    }
    return out;
  }

  function persist(slugs) {
    var exp = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toUTCString();
    var secure = (window.location.protocol === "https:") ? "; Secure" : "";
    document.cookie = COOKIE + "=" + slugs.join(",") + "; path=/; expires=" + exp + "; SameSite=Lax" + secure;
  }

  var dismissed = parseSlugs(readCookie(COOKIE));
  var bars = document.querySelectorAll(".announcement-bar[data-announcement-slug]");

  for (var i = 0; i < bars.length; i += 1) {
    var bar = bars[i];
    var slug = bar.getAttribute("data-announcement-slug");
    if (!slug) continue;
    if (dismissed.indexOf(slug) !== -1) {
      bar.hidden = true;
      continue;
    }
    var form = bar.querySelector(".announcement-bar__dismiss");
    if (form) {
      (function (barEl, barSlug, formEl) {
        formEl.addEventListener("submit", function (ev) {
          ev.preventDefault();
          if (dismissed.indexOf(barSlug) === -1) dismissed.push(barSlug);
          persist(dismissed);
          barEl.hidden = true;
        });
      })(bar, slug, form);
    }
  }
})();
