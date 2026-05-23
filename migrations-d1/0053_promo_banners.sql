-- Promotional banners — operator-controlled marketing surface that
-- renders across the storefront. Each banner has a placement (which
-- region of the storefront it appears in), a schedule window
-- (starts_at / expires_at), and an audience filter (everybody / only
-- logged-in shoppers / only guests / a named customer segment). The
-- highest-priority active banner for a given placement wins.
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address banners by a stable
--     human-readable handle (e.g. "summer-sale-top-strip"); the
--     primitive enforces a tight alnum + hyphen / underscore shape
--     at the app layer.
--
--   * `placement` is a CHECK enum so a typo at the SQL layer can't
--     attach a banner to a placement region the storefront doesn't
--     render. The enum mirrors the JS-side ALLOWED_PLACEMENTS.
--
--   * `audience` is a CHECK enum. When audience = "segment", the
--     `segment_slug` column resolves to a customer-segments handle
--     supplied by the operator's segments primitive; the primitive
--     calls `customerSegments.isMember(customer_id, segment_slug)`
--     to gate impressions per request.
--
--   * `theme` is a CHECK enum so the storefront stylesheet only ever
--     receives a known theme token (info / promo / urgency / success).
--     Theme is a presentation hint, not a security gate — the gate
--     is HTML-escaping every operator-input field at render time.
--
--   * `cta_url` is validated at the app layer with `b.safeUrl.parse`
--     restricted to https:// (or a /-rooted absolute path); the SQL
--     layer holds the raw string but never accepts it from anything
--     that hasn't passed through the JS gate.
--
--   * `priority` is an integer; higher wins when two banners overlap
--     in (placement, window, audience). The index orders DESC so the
--     "active for placement" lookup is a single B-tree seek.
--
--   * `archived_at` is the soft-delete column. Archived banners are
--     hidden from `activeForPlacement` regardless of window or
--     priority, but stay in the table so impression / click counters
--     remain auditable after a campaign ends.
--
--   * `impression_count` + `click_count` default to 0 NOT NULL so the
--     counters are always meaningful — `impressionCount` /
--     `clickCount` never have to coalesce against a missing row.
--
-- Indexes:
--   * `(placement, archived_at, priority DESC)` — the hot read path
--     in `activeForPlacement` filters by placement, excludes archived
--     rows, and picks the highest priority. The index covers all
--     three so the lookup is a single seek + bounded scan.
--   * `(segment_slug)` — when audience = "segment", the operator
--     dashboard surfaces "which banners target segment X" via a
--     scan on this column.

CREATE TABLE IF NOT EXISTS promo_banners (
  slug              TEXT NOT NULL PRIMARY KEY,
  placement         TEXT NOT NULL CHECK (placement IN (
                      'top_strip',
                      'homepage_hero',
                      'pdp_side',
                      'cart_side',
                      'search_empty',
                      'footer'
                    )),
  headline          TEXT NOT NULL,
  body              TEXT,
  cta_label         TEXT NOT NULL,
  cta_url           TEXT NOT NULL,
  image_url         TEXT,
  audience          TEXT NOT NULL CHECK (audience IN (
                      'all',
                      'logged_in',
                      'guest',
                      'segment'
                    )),
  segment_slug      TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  theme             TEXT NOT NULL DEFAULT 'info' CHECK (theme IN (
                      'info',
                      'promo',
                      'urgency',
                      'success'
                    )),
  starts_at         INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  archived_at       INTEGER,
  impression_count  INTEGER NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
  click_count       INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_promo_banners_placement_priority
  ON promo_banners(placement, archived_at, priority DESC);

CREATE INDEX IF NOT EXISTS idx_promo_banners_segment_slug
  ON promo_banners(segment_slug);
