// Edge-side announcement-bar read. The Worker holds a direct D1 binding
// (`env.DB`), so it resolves the active sitewide announcement itself rather
// than hopping to the container. The row shape + theme-rank pick mirror
// lib/announcement-bar.js's activeAnnouncement so the rendered bar is
// byte-identical to the container (the asset-fingerprint parity test guards
// the markup via _lib.announcementBar).
//
// Audience: the edge serves cacheable anonymous reads (auth lives in the
// container), so it resolves the all / guest audiences; logged_in + segment
// announcements are evaluated container-side. Dismissal is NOT applied here
// — the bar is rendered identically for every viewer (so the shared edge
// cache keyed on URL stays correct) and the announcement island hides any
// bar whose slug is in the visitor's `shop_ann_dismissed` cookie.
//
// Missing-table-resilient: a query that throws (the announcements table not
// migrated on this deploy) reads as "no announcement", so the edge degrades
// to no bar instead of 500-ing the page.

var THEME_RANK = { urgency: 3, promo: 2, info: 1, success: 0 };

// Resolve the active announcement for an edge request, or null. `viewerKind`
// defaults to "guest" (the cacheable anonymous edge audience).
export async function resolveAnnouncement(DB, opts) {
  opts = opts || {};
  if (!DB) return null;
  var now = opts.now == null ? Date.now() : opts.now;
  var viewerKind = opts.viewer_kind === "logged_in" ? "logged_in" : "guest";
  // Missing-table-resilient: a query failure (announcements table not
  // migrated on this deploy) reads as an empty set, so the resolver returns
  // null → no bar. This is a DATA read, not an edge route handler — the null
  // means "no announcement", it never escalates an exception to the
  // container (the catch assigns rather than returns, mirroring
  // worker/data/currency.js).
  var rows = [];
  try {
    rows = (await DB
      .prepare(
        "SELECT slug, message, link_url, link_label, theme, audience, dismissible " +
        "FROM announcements WHERE archived_at IS NULL " +
        "  AND (starts_at  IS NULL OR starts_at  <= ?1) " +
        "  AND (expires_at IS NULL OR expires_at >  ?1) " +
        "ORDER BY updated_at DESC, slug ASC",
      )
      .bind(now)
      .all()).results || [];
  } catch (_e) {
    rows = [];
  }
  if (!rows.length) return null;

  var best = null;
  var bestRank = -1;
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (row.audience === "logged_in" && viewerKind !== "logged_in") continue;
    if (row.audience === "guest"     && viewerKind !== "guest")     continue;
    if (row.audience === "segment") continue;
    var rank = THEME_RANK[row.theme];
    if (rank == null) rank = -1;
    if (rank > bestRank) { best = row; bestRank = rank; }
  }
  return best;
}
