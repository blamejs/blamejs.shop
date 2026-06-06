"use strict";
/**
 * Sidebar-widget dual-render parity + escaping.
 *
 * The storefront right rail is dual-rendered: lib/storefront.js builds it for
 * the container, worker/render/_lib.js builds it for the Cloudflare edge. The
 * two must land BYTE-IDENTICAL so an edge-cached page and a container page
 * render the same rail for the same page + audience. This test invokes BOTH
 * builders with the same resolved widget rows and asserts the output matches,
 * across every widget kind, then asserts every operator free-text value is
 * HTML-escaped at the sink (a `<script>` in a title / message / badge / label
 * lands inert).
 *
 * The worker/ tree is EXCLUDED from the container build context, so the import
 * of worker/render/_lib.js is GUARDED with fs.existsSync IMMEDIATELY before the
 * dynamic import — an unguarded import ENOENT-bricks the in-image smoke and the
 * deploy (see [[worker-test-inimage-deploy-brick]]). When worker/ is absent the
 * test early-returns clean.
 *
 * Network: zero — pure render comparison.
 */

var nodeFs     = require("node:fs");
var nodePath   = require("node:path");
var nodeModule = require("node:module");
var { pathToFileURL } = require("node:url");

var storefront = require("../../lib/storefront");
var helpers    = require("../helpers");
var check      = helpers.check;

// worker/render/_lib.js does `import manifest from "./asset-manifest.json"`,
// which esbuild bundles at build time; Node's native loader needs the
// `type: "json"` import attribute the bundler injects. Register a one-shot
// resolve hook that supplies it so the same source runs unbundled here.
// Mirrors search-faceting-parity.test.js / asset-fingerprint.test.js.
var _jsonHookRegistered = false;
function _registerJsonHook() {
  if (_jsonHookRegistered) return;
  nodeModule.registerHooks({
    resolve: function (spec, ctx, next) {
      var r = next(spec, ctx);
      if (r.url && r.url.slice(-5) === ".json") r.importAttributes = { type: "json" };
      return r;
    },
  });
  _jsonHookRegistered = true;
}

// One representative widget row per kind, each carrying an XSS payload in
// every operator-authored free-text field so the escape assertions exercise
// a hostile value. Payload shapes mirror lib/sidebar-widgets.js.
var XSS = "<script>alert(1)</script>";
function _rows() {
  return [
    { slug: "w-news", title: XSS + " News", kind: "newsletter_signup", audience: "all",
      payload: { list_id: "general", headline: XSS + " join", cta_label: XSS + " go" } },
    { slug: "w-trust", title: "Trust " + XSS, kind: "trust_badges", audience: "all",
      payload: { badges: ["secure", "ssl-256"] } },
    { slug: "w-proof", title: "Proof", kind: "social_proof", audience: "all",
      payload: { headline: XSS + " h", message_template: XSS + " 42 people bought this" } },
    { slug: "w-size", title: "Size", kind: "size_chart", audience: "all",
      payload: { chart_slug: "apparel" } },
    { slug: "w-feat", title: "Featured", kind: "featured_collection", audience: "all",
      payload: { collection_slug: "summer", limit: 4 } },
    { slug: "w-recent", title: "Recent", kind: "recently_viewed", audience: "all",
      payload: { limit: 6 } },
    { slug: "w-live", title: "Live", kind: "live_visitors", audience: "all",
      payload: { window_minutes: 30, min_threshold: 3 } },
    { slug: "w-count", title: "Countdown", kind: "countdown_timer", audience: "all",
      payload: { target_at: 4102444800000, completed_label: XSS + " done" } },
    { slug: "w-sticky", title: "Sticky", kind: "sticky_addtocart", audience: "all",
      payload: { variant_slug: "blue-l" } },
  ];
}

async function _run() {
  var rows = _rows();

  // --- escaping: every rendered widget neutralises the XSS payload ---------
  for (var i = 0; i < rows.length; i += 1) {
    var html = storefront.buildSidebarWidget(rows[i], "home");
    check("widget " + rows[i].kind + " renders non-empty", typeof html === "string" && html.length > 0);
    check("widget " + rows[i].kind + " has no raw <script>", html.indexOf("<script>alert(1)</script>") === -1);
    // The escaped form must be present wherever a payload carried the payload
    // (the escape sink converts `<` to `&lt;`).
    if (rows[i].kind !== "size_chart" && rows[i].kind !== "featured_collection" &&
        rows[i].kind !== "recently_viewed" && rows[i].kind !== "live_visitors" &&
        rows[i].kind !== "sticky_addtocart" && rows[i].kind !== "trust_badges") {
      check("widget " + rows[i].kind + " escapes the payload", html.indexOf("&lt;script&gt;") !== -1);
    }
  }

  // The title is escaped on every kind (it's always operator free text).
  var trustHtml = storefront.buildSidebarWidget(rows[1], "home");
  check("widget title is escaped", trustHtml.indexOf("Trust &lt;script&gt;") !== -1);

  // --- the rail wraps placed widgets in a single <aside> -------------------
  var rail = storefront.buildSidebarRail(rows, { _sidebar_page_key: "home" });
  check("rail is a single <aside>", rail.indexOf("<aside class=\"sidebar-rail\"") === 0);
  check("rail closes the <aside>", rail.endsWith("</aside>"));
  check("rail contains every kind", rows.every(function (r) {
    return rail.indexOf("data-widget-slug=\"" + r.slug + "\"") !== -1;
  }));
  check("empty rail renders nothing", storefront.buildSidebarRail([], { _sidebar_page_key: "home" }) === "");

  // --- the outbound link routes through the click counter ------------------
  var featHtml = storefront.buildSidebarWidget(rows[4], "collection");
  check("featured-collection link routes through /sidebar click counter",
    featHtml.indexOf("/sidebar/w-feat/click?to=") !== -1 &&
    featHtml.indexOf("page_key=collection") !== -1);
  // Without a page_key (a lone-widget render) the link points direct.
  var featDirect = storefront.buildSidebarWidget(rows[4], null);
  check("featured-collection link is direct without a page_key",
    featDirect.indexOf("href=\"/collections/summer\"") !== -1);

  // --- page_key derivation -------------------------------------------------
  check("page_key home",       storefront.sidebarPageKeyForPath("/") === "home");
  check("page_key cart",       storefront.sidebarPageKeyForPath("/cart") === "cart");
  check("page_key search",     storefront.sidebarPageKeyForPath("/search") === "search");
  check("page_key collection", storefront.sidebarPageKeyForPath("/collections/summer") === "collection");
  check("page_key product",    storefront.sidebarPageKeyForPath("/products/widget") === "product");
  check("page_key unknown",    storefront.sidebarPageKeyForPath("/account") === null);

  // --- dual-render parity against the edge twin ----------------------------
  // GUARD: worker/ is excluded from the container build context. An unguarded
  // import would ENOENT-brick the in-image smoke + the deploy. Skip cleanly
  // when worker/render/_lib.js is absent.
  var workerLibPath = nodePath.resolve(__dirname, "..", "..", "worker", "render", "_lib.js");
  if (!nodeFs.existsSync(workerLibPath)) {
    check("sidebar render parity skipped (worker/ excluded from this build)", true);
    return;
  }
  _registerJsonHook();
  var edge = await import(pathToFileURL(workerLibPath).href);
  check("edge exposes sidebarWidget",        typeof edge.sidebarWidget === "function");
  check("edge exposes sidebarRail",          typeof edge.sidebarRail === "function");
  check("edge exposes sidebarPageKeyForPath", typeof edge.sidebarPageKeyForPath === "function");

  for (var k = 0; k < rows.length; k += 1) {
    var c = storefront.buildSidebarWidget(rows[k], "home");
    var e = edge.sidebarWidget(rows[k], "home");
    check("widget " + rows[k].kind + " byte-identical edge/container", c === e);
  }
  // The full rail (no container-only impression handle threaded → pure markup)
  // is byte-identical on both substrates.
  var cRail = storefront.buildSidebarRail(rows, { _sidebar_page_key: "home" });
  var eRail = edge.sidebarRail(rows, "home");
  check("rail byte-identical edge/container", cRail === eRail);

  // page_key derivation is byte-identical between substrates.
  ["/", "/cart", "/search", "/collections/x", "/products/x", "/account"].forEach(function (p) {
    check("page_key parity for " + p,
      storefront.sidebarPageKeyForPath(p) === edge.sidebarPageKeyForPath(p));
  });
}

module.exports = { run: _run };
