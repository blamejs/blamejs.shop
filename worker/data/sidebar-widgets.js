// Edge-side sidebar-widget read. The Worker holds a direct D1 binding
// (`env.DB`), so it resolves the placed widgets for a page itself rather than
// hopping to the container. The row shape + placement order + audience pick
// mirror lib/sidebar-widgets.js's `widgetsForPage` so the rendered rail is
// byte-identical to the container (the asset-fingerprint parity test guards
// the markup via _lib.sidebarWidget / _lib.sidebarRail).
//
// Audience: the edge serves cacheable anonymous reads (auth lives in the
// container), so it resolves the `all` / `guest` audiences; `logged_in` +
// `segment` widgets are evaluated container-side. The join pulls the page's
// ordered placement with the widget definition, filtered to the active
// schedule window + non-archived rows; the audience gate runs in JS.
//
// Missing-table-resilient: a query that throws (the sidebar_widgets tables not
// migrated on this deploy) reads as "no widgets", so the edge degrades to no
// rail instead of 500-ing the page. This is a DATA read, not an edge route
// handler — the catch assigns rather than returns, mirroring
// worker/data/promo-banners.js + worker/data/announcement.js.

// Resolve the ordered, active, guest-visible widgets for a page_key → an array
// of hydrated widget rows (placement order). Returns [] for a null page_key or
// any read error.
export async function resolveSidebarWidgets(DB, opts) {
  opts = opts || {};
  var pageKey = opts.page_key;
  if (!DB || typeof pageKey !== "string" || !pageKey.length) return [];
  var now = opts.now == null ? Date.now() : opts.now;
  var viewerKind = opts.viewer_kind === "logged_in" ? "logged_in" : "guest";
  var rows = [];
  try {
    rows = (await DB
      .prepare(
        "SELECT w.slug, w.title, w.kind, w.payload_json, w.audience, w.segment_slug, " +
        "       p.position AS _position " +
        "FROM sidebar_widget_placements p " +
        "JOIN sidebar_widgets w ON w.slug = p.widget_slug " +
        "WHERE p.page_key = ?1 AND w.archived_at IS NULL " +
        "  AND w.starts_at <= ?2 AND w.expires_at > ?2 " +
        "ORDER BY p.position ASC",
      )
      .bind(pageKey, now)
      .all()).results || [];
  } catch (_e) {
    rows = [];
  }
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    var r = rows[i];
    // Audience gate — `all` always shows; `guest` / `logged_in` match the
    // viewer; `segment` is evaluated container-side only (the edge never
    // serves a per-customer segment read), so it drops here exactly like the
    // promo-banner + announcement edge resolvers.
    if (r.audience === "logged_in" && viewerKind !== "logged_in") continue;
    if (r.audience === "guest"     && viewerKind !== "guest")     continue;
    if (r.audience === "segment") continue;
    var payload;
    try { payload = JSON.parse(r.payload_json); }
    catch (_pe) { payload = {}; }
    out.push({ slug: r.slug, title: r.title, kind: r.kind, payload: payload, audience: r.audience });
  }
  return out;
}
