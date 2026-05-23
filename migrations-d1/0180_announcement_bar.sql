-- Announcement bar: operator-controlled top-of-storefront text strip.
-- Distinct from promo_banners (placement-targeted, image-capable) —
-- this is the single thin row of text that sits above the navigation
-- ("Free shipping on orders over $50", "Holiday sale 30% off"). One
-- announcement renders at a time, picked by `activeAnnouncement` using
-- a three-key ordering: theme rank (urgency > promo > info > success) ->
-- updated_at DESC -> slug ASC.
--
-- Two tables:
--
--   * `announcements` — one row per operator-defined announcement.
--     `slug` is the PRIMARY KEY (lowercase alnum + dash). `message` is
--     the customer-visible text (plain string; renderHtml escapes it
--     when assembling the strip). `link_url` + `link_label` are an
--     optional CTA pair — both present or both NULL. `theme` controls
--     the visual treatment (info / promo / urgency / success); the
--     theme also orders `activeAnnouncement` so an urgency announcement
--     wins over a promo one when both are active in the same window.
--     `audience` is the visibility filter (all / logged_in / guest /
--     segment); `segment_slug` is required iff audience='segment'.
--     `starts_at` / `expires_at` are optional epoch-ms bounds — NULL
--     starts_at means "active immediately"; NULL expires_at means "no
--     scheduled end". `dismissible` controls whether the storefront
--     renders a close button — the dismissal record is per-session via
--     `announcement_dismissals`. `archived_at` soft-retires the row
--     without losing the slug; `activeAnnouncement` skips archived rows.
--
--   * `announcement_dismissals` — one row per (announcement_slug,
--     session_id_hash) dismissal. `session_id_hash` is the SHA3-512
--     namespace-hash of the storefront session identifier (the raw
--     session id is never stored at the announcement domain — only its
--     hash, so an operator browsing the dismissal log can't correlate
--     dismissals back to a specific shopper). `UNIQUE(announcement_slug,
--     session_id_hash)` collapses repeat-dismissals (a customer who
--     clicks the X twice via two tabs gets one row). `occurred_at`
--     records when the dismissal happened — useful for "stop showing
--     after N dismissals" sweeps an operator might layer on top.
--
-- Indexes drive the two hot read paths:
--   * (archived_at, starts_at, expires_at, theme, updated_at) — the
--     activeAnnouncement window scan.
--   * (announcement_slug, occurred_at) — dismissal sweep / aggregate.

CREATE TABLE IF NOT EXISTS announcements (
  slug             TEXT    NOT NULL PRIMARY KEY,
  message          TEXT    NOT NULL,
  link_url         TEXT,
  link_label       TEXT,
  theme            TEXT    NOT NULL CHECK (theme IN ('info', 'promo', 'urgency', 'success')),
  audience         TEXT    NOT NULL CHECK (audience IN ('all', 'logged_in', 'guest', 'segment')),
  segment_slug     TEXT,
  starts_at        INTEGER,
  expires_at       INTEGER,
  dismissible      INTEGER NOT NULL CHECK (dismissible IN (0, 1)),
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((link_url IS NULL AND link_label IS NULL) OR (link_url IS NOT NULL AND link_label IS NOT NULL)),
  CHECK ((audience = 'segment' AND segment_slug IS NOT NULL) OR (audience <> 'segment' AND segment_slug IS NULL)),
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_announcements_active     ON announcements(archived_at, starts_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_announcements_theme      ON announcements(theme);
CREATE INDEX IF NOT EXISTS idx_announcements_audience   ON announcements(audience);
CREATE INDEX IF NOT EXISTS idx_announcements_updated    ON announcements(updated_at);

CREATE TABLE IF NOT EXISTS announcement_dismissals (
  id                  TEXT    NOT NULL PRIMARY KEY,
  announcement_slug   TEXT    NOT NULL,
  session_id_hash     TEXT    NOT NULL,
  occurred_at         INTEGER NOT NULL,
  FOREIGN KEY (announcement_slug) REFERENCES announcements(slug) ON DELETE CASCADE,
  UNIQUE (announcement_slug, session_id_hash)
);

CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_slug      ON announcement_dismissals(announcement_slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_announcement_dismissals_session   ON announcement_dismissals(session_id_hash);
