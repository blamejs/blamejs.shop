-- Email templates — operator-editable transactional email bodies.
--
-- The transactional `email` primitive ships with hard-coded HTML +
-- text templates (order_receipt / ship_notification / refund /
-- password_reset / etc.). Operators routinely want to edit those
-- bodies — change the wording, swap the brand voice, localize a
-- subject line, add an A/B variant — without forking the framework.
-- This primitive sits between `email` and the sender: it owns the
-- per-template body + variable schema + locale variants + version
-- history, and renders the chosen variant on demand.
--
-- Two tables back the surface:
--
--   email_templates           — one row per operator-defined slug.
--                               `kind` is a closed enum of
--                               transactional shapes. `archived_at`
--                               soft-deletes the template (every
--                               version goes inactive); the row is
--                               kept so the audit ledger that points
--                               at the slug still resolves.
--
--   email_template_versions   — append-only version log per
--                               (template_slug, locale). One row per
--                               version. `published = 1` marks the
--                               active version; publishing a new
--                               version flips the prior published row
--                               back to 0 inside the same transaction.
--                               `variables_schema_json` is the
--                               operator-declared shape the renderer
--                               validates the per-render variables
--                               against (refuses unknown keys, refuses
--                               missing required keys).
--
-- Indexes:
--   * (template_slug, locale, published) on versions — the renderer's
--     hot read is "give me the published version for this slug at
--     this locale". The composite covers it without a table scan on
--     a multi-thousand-version log.
--   * (template_slug, locale, version_number) on versions — `versionsFor`
--     pages this composite descending; the published flag flip during
--     `publishVersion` updates one prior row by (slug, locale,
--     published=1) and reads the new max version_number by
--     (slug, locale).

CREATE TABLE IF NOT EXISTS email_templates (
  slug         TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN (
    'order_confirmation',
    'order_shipped',
    'order_delivered',
    'order_refunded',
    'password_reset',
    'account_verification',
    'abandoned_cart',
    'wishlist_discount',
    'review_request',
    'welcome',
    'generic'
  )),
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_templates_kind_archived
  ON email_templates(kind, archived_at);

CREATE TABLE IF NOT EXISTS email_template_versions (
  id                     TEXT NOT NULL PRIMARY KEY,
  template_slug          TEXT NOT NULL,
  locale                 TEXT NOT NULL,
  subject                TEXT NOT NULL,
  body_html              TEXT NOT NULL,
  body_text              TEXT NOT NULL,
  variables_schema_json  TEXT NOT NULL,
  version_number         INTEGER NOT NULL,
  published              INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  created_at             INTEGER NOT NULL,
  FOREIGN KEY (template_slug) REFERENCES email_templates(slug) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_template_versions_published
  ON email_template_versions(template_slug, locale, published);

CREATE INDEX IF NOT EXISTS idx_email_template_versions_history
  ON email_template_versions(template_slug, locale, version_number);
