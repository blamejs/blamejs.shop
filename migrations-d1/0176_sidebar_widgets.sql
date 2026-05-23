-- Sidebar widgets: operator-curated content blocks rendered into the
-- storefront sidebar across product / collection / cart / search /
-- account pages. Where promo_banners owns horizontal strips at fixed
-- placements, sidebar_widgets owns the vertically-stacked sidebar on
-- pages that have one — each page declares an ordered list of widgets
-- to render, and each widget carries a kind (newsletter_signup /
-- recently_viewed / trust_badges / featured_collection / social_proof
-- / size_chart / live_visitors / countdown_timer / sticky_addtocart),
-- a payload (JSON shaped per kind), a schedule window, an optional
-- audience filter, and impression / click counters.
--
-- Two tables:
--
--   * `sidebar_widgets` — one row per operator-defined widget. `slug`
--     is the PRIMARY KEY (operator-readable identifier). `kind`
--     determines which payload shape applies and how the storefront
--     renderer interprets the widget. `payload_json` carries the
--     kind-specific operator configuration (newsletter list_id, list
--     of trust-badge slugs, featured-collection slug, countdown
--     target_at epoch ms, etc.). `audience` filters who sees the
--     widget: all / logged_in / guest / segment. `segment_slug` is
--     non-NULL exactly when audience = "segment". `priority` orders
--     widgets within a single page placement when more than one
--     widget could render. `starts_at` / `expires_at` define the
--     schedule window; archived_at soft-retires the widget.
--
--   * `sidebar_widget_events` — append-only ledger row per
--     impression / click on a widget for a given page. Operators read
--     aggregated counts via `metricsForWidget`; the per-event ledger
--     supports per-page breakdown (which pages does this widget
--     convert on?) and CTR tracking over a date range. Rows carry an
--     `event_kind` (impression / click) plus the page-key the event
--     occurred on, so an operator can answer "which featured-
--     collection widget converts best on PDP versus cart?"
--
-- Page placement is owned by a third logical table, but represented
-- here as a denormalized JSON column on `sidebar_widgets` plus a
-- per-page lookup table:
--
--   * `sidebar_widget_placements` — (page_key, slug, position) rows.
--     Each page can carry up to N widgets in a defined order; the
--     primitive's `setPagePlacement(page_key, [slugs...])` replaces
--     the page's ordered list atomically (DELETE then INSERT inside a
--     single SQL batch — sqlite/d1 honors the implicit transaction).
--     `position` is a monotonic 0-indexed integer for the page; the
--     renderer reads ordered ASC.
--
-- Indexes drive the hot reads:
--   * (slug) PRIMARY KEY                       — widget lookup by slug
--   * (kind, archived_at)                      — listWidgets by kind filter
--   * (page_key, position)                     — widgetsForPage render path
--   * (widget_slug, event_kind, occurred_at)   — metricsForWidget rollup

CREATE TABLE IF NOT EXISTS sidebar_widgets (
  slug             TEXT    NOT NULL PRIMARY KEY,
  title            TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN (
                                       'newsletter_signup',
                                       'recently_viewed',
                                       'trust_badges',
                                       'featured_collection',
                                       'social_proof',
                                       'size_chart',
                                       'live_visitors',
                                       'countdown_timer',
                                       'sticky_addtocart'
                                     )),
  payload_json     TEXT    NOT NULL,
  audience         TEXT    NOT NULL CHECK (audience IN ('all', 'logged_in', 'guest', 'segment')),
  segment_slug     TEXT,
  priority         INTEGER NOT NULL DEFAULT 0,
  starts_at        INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  CHECK ((audience = 'segment' AND segment_slug IS NOT NULL)
      OR (audience <> 'segment' AND segment_slug IS NULL)),
  CHECK (expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS idx_sidebar_widgets_kind     ON sidebar_widgets(kind, archived_at);
CREATE INDEX IF NOT EXISTS idx_sidebar_widgets_audience ON sidebar_widgets(audience);
CREATE INDEX IF NOT EXISTS idx_sidebar_widgets_window   ON sidebar_widgets(starts_at, expires_at);

CREATE TABLE IF NOT EXISTS sidebar_widget_placements (
  page_key         TEXT    NOT NULL,
  widget_slug      TEXT    NOT NULL,
  position         INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (page_key, widget_slug),
  FOREIGN KEY (widget_slug) REFERENCES sidebar_widgets(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sidebar_widget_placements_page ON sidebar_widget_placements(page_key, position);

CREATE TABLE IF NOT EXISTS sidebar_widget_events (
  id               TEXT    NOT NULL PRIMARY KEY,
  widget_slug      TEXT    NOT NULL,
  page_key         TEXT    NOT NULL,
  event_kind       TEXT    NOT NULL CHECK (event_kind IN ('impression', 'click')),
  occurred_at      INTEGER NOT NULL,
  FOREIGN KEY (widget_slug) REFERENCES sidebar_widgets(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sidebar_widget_events_rollup ON sidebar_widget_events(widget_slug, event_kind, occurred_at);
CREATE INDEX IF NOT EXISTS idx_sidebar_widget_events_page   ON sidebar_widget_events(page_key, event_kind, occurred_at);
