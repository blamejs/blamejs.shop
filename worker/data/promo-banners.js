// Edge-side promo-banner read. The Worker holds a direct D1 binding
// (`env.DB`), so it resolves the active banner per placement itself rather
// than hopping to the container. The row shape + priority pick mirror
// lib/promo-banners.js's activeForPlacement so the rendered banner is
// byte-identical to the container (the asset-fingerprint parity test guards
// the markup via _lib.promoBanner).
//
// Audience: the edge serves cacheable anonymous reads (auth lives in the
// container), so it resolves the all / guest audiences; logged_in + segment
// banners are evaluated container-side. The single query pulls every active
// row ordered priority DESC (then created_at ASC, slug ASC — the same order
// the container's listAll uses), and the first audience match per placement
// wins. Impression / click counters are container-only (the edge can't write
// the counter, and an edge-cached page can't bump a per-view count anyway).
//
// Missing-table-resilient: a query that throws (the promo_banners table not
// migrated on this deploy) reads as "no banners", so the edge degrades to no
// banners instead of 500-ing the page. This is a DATA read, not an edge route
// handler — the catch assigns rather than returns, mirroring
// worker/data/announcement.js + worker/data/currency.js.

var _PLACEMENTS = ["top_strip", "homepage_hero", "pdp_side", "cart_side", "search_empty", "footer"];

// Resolve the active banner for each placement → a map keyed by placement
// (value = the row or null). `viewerKind` defaults to "guest" (the cacheable
// anonymous edge audience).
export async function resolvePromoBanners(DB, opts) {
  opts = opts || {};
  var out = {};
  for (var k = 0; k < _PLACEMENTS.length; k += 1) out[_PLACEMENTS[k]] = null;
  if (!DB) return out;
  var now = opts.now == null ? Date.now() : opts.now;
  var viewerKind = opts.viewer_kind === "logged_in" ? "logged_in" : "guest";
  var rows = [];
  try {
    rows = (await DB
      .prepare(
        "SELECT slug, placement, headline, body, cta_label, cta_url, image_url, audience, theme " +
        "FROM promo_banners WHERE archived_at IS NULL " +
        "  AND starts_at  <= ?1 " +
        "  AND expires_at >  ?1 " +
        "ORDER BY priority DESC, created_at ASC, slug ASC",
      )
      .bind(now)
      .all()).results || [];
  } catch (_e) {
    rows = [];
  }
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    var pl = row.placement;
    // Skip unknown placements and ones already filled — the query is
    // priority-sorted so the first audience match per placement is the winner.
    if (!Object.prototype.hasOwnProperty.call(out, pl) || out[pl] !== null) continue;
    if (row.audience === "logged_in" && viewerKind !== "logged_in") continue;
    if (row.audience === "guest"     && viewerKind !== "guest")     continue;
    if (row.audience === "segment") continue;
    out[pl] = row;
  }
  return out;
}
