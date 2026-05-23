-- Trust badges — operator-curated trust signals + certifications
-- shown on the storefront (BBB accredited, GOTS organic certified,
-- ISO 27001, payment-provider lock icons, "ships from USA", custom).
--
-- Distinct from `promoBanners` (marketing) — this is the trust-signal
-- layer. Each badge carries either an inline SVG payload OR a remote
-- image URL (mutually exclusive), an optional link URL, a set of
-- placements the badge surfaces at, an optional active window, alt
-- text for assistive tech, and a priority that orders ties at a
-- placement.
--
-- Schema decisions:
--
--   * `slug` is the PK. Operators address badges by stable
--     human-readable handles (`bbb-accredited`, `iso-27001`,
--     `ships-from-usa`); the primitive enforces a tight alnum +
--     hyphen / dot / underscore shape at the app layer.
--
--   * `svg_payload` carries the SVG markup as TEXT. NULL when the
--     badge uses a remote image instead. The primitive sanitizes
--     the payload through `b.guardSvg` against a strict whitelist
--     (svg / path / circle / rect / g / title / desc only) before
--     persisting. Stored sanitized so reads can pass through to
--     the storefront without re-sanitization on every render.
--
--   * `image_url` carries a remote https:// image URL. NULL when
--     the badge uses an inline SVG payload. Exactly one of
--     `svg_payload` / `image_url` is non-NULL — enforced at the
--     app layer (the schema CHECK below also asserts this).
--
--   * `link_url` is the optional click-through destination. NULL
--     means the badge renders as inert markup (the trust-signal
--     usually doesn't need to click through). When set, the URL
--     passes `b.safeUrl.parse` against https-only or a /-rooted
--     storefront-internal path.
--
--   * `placements_json` is a JSON array of placement strings
--     (header / footer / pdp / cart_review / checkout /
--     order_confirmation). At least one placement is required.
--     `activeForPlacement` filters this column at the app layer
--     (a small set of trust badges with a handful of placements
--     each — no need for a placement-pivot table).
--
--   * `starts_at` / `expires_at` are nullable epoch-ms windows.
--     NULL on either side means "no boundary in that direction"
--     so an evergreen badge sets neither. The evaluator filters
--     by the live window.
--
--   * `alt_text` is the accessibility caption rendered as the
--     <img alt=""> attribute (image_url badges) or <title>/<desc>
--     inside the inline SVG (svg_payload badges). NOT NULL — a
--     trust badge with no alt text is an accessibility regression
--     the operator should fix at define time, not in production.
--
--   * `priority` orders badges at a placement. Higher wins. Same
--     envelope as `promoBanners`: [0, 1000000].
--
--   * `archived_at` is the soft-delete timestamp. Archived badges
--     are excluded from `activeForPlacement` regardless of the
--     active window.
--
--   * `impression_count` / `click_count` are denormalized counters
--     that the hot-path `recordImpression` / `recordClick` calls
--     bump atomically. The companion `trust_badge_events` table is
--     the canonical event log; the counters exist so the admin
--     summary read is a single-row lookup on `trust_badges`.
--
-- Indexes:
--   * (archived_at, priority DESC) — the hot read path in
--     `activeForPlacement` walks non-archived badges in priority
--     order. Placement filtering happens JS-side (small fanout).
--
--   * trust_badge_events (badge_slug, occurred_at) — backs the
--     per-badge event window scan (impressions + clicks over time).
--
--   * trust_badge_events (badge_slug, event_type) — backs the
--     "impressions vs clicks for badge X" rollup.

CREATE TABLE IF NOT EXISTS trust_badges (
  slug                TEXT NOT NULL PRIMARY KEY,
  title               TEXT NOT NULL,
  svg_payload         TEXT,
  image_url           TEXT,
  link_url            TEXT,
  placements_json     TEXT NOT NULL,
  starts_at           INTEGER,
  expires_at          INTEGER,
  alt_text            TEXT NOT NULL,
  priority            INTEGER NOT NULL DEFAULT 0,
  archived_at         INTEGER,
  impression_count    INTEGER NOT NULL DEFAULT 0 CHECK (impression_count >= 0),
  click_count         INTEGER NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (priority >= 0 AND priority <= 1000000),
  CHECK ((svg_payload IS NOT NULL AND image_url IS NULL)
      OR (svg_payload IS NULL AND image_url IS NOT NULL)),
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE IF NOT EXISTS trust_badge_events (
  id                  TEXT NOT NULL PRIMARY KEY,
  badge_slug          TEXT NOT NULL REFERENCES trust_badges(slug) ON DELETE CASCADE,
  placement           TEXT NOT NULL,
  event_type          TEXT NOT NULL CHECK (event_type IN ('impression', 'click')),
  session_id_hash     TEXT,
  occurred_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trust_badges_priority
  ON trust_badges(archived_at, priority DESC);

CREATE INDEX IF NOT EXISTS idx_trust_badge_events_slug_time
  ON trust_badge_events(badge_slug, occurred_at);

CREATE INDEX IF NOT EXISTS idx_trust_badge_events_slug_type
  ON trust_badge_events(badge_slug, event_type);
