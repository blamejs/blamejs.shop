-- Mailing audiences — operator-defined segmentation over the
-- `newsletter_signups` table. Operators name an audience, write a
-- rules JSON (subscribed_at age, source membership, tag filters,
-- country, double-opt-in status, language, customer status), and
-- the primitive resolves the audience to a list of recipient hashes
-- (always) plus optional normalised plaintext (operator-verifier
-- opt-in) for targeted broadcast campaigns. Suppressions are filtered
-- at resolve time when the `emailSuppressions` primitive is composed
-- in.
--
-- Companion columns on `newsletter_signups` — every audience predicate
-- needs a column to filter on. The 0010 migration shipped the lean
-- signup row; this migration extends it additively with `tags_csv`,
-- `country`, `language`, `customer_status`, `double_opt_in_at` so the
-- audience rules can resolve without a downstream migration. The
-- columns default to NULL / empty so existing rows continue to satisfy
-- "the operator never tagged this signup" predicates as a no-match.

ALTER TABLE newsletter_signups ADD COLUMN tags_csv         TEXT NOT NULL DEFAULT '';
ALTER TABLE newsletter_signups ADD COLUMN country          TEXT;
ALTER TABLE newsletter_signups ADD COLUMN language         TEXT;
ALTER TABLE newsletter_signups ADD COLUMN customer_status  TEXT;
ALTER TABLE newsletter_signups ADD COLUMN double_opt_in_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_newsletter_signups_country         ON newsletter_signups(country);
CREATE INDEX IF NOT EXISTS idx_newsletter_signups_language        ON newsletter_signups(language);
CREATE INDEX IF NOT EXISTS idx_newsletter_signups_customer_status ON newsletter_signups(customer_status);
CREATE INDEX IF NOT EXISTS idx_newsletter_signups_double_opt_in   ON newsletter_signups(double_opt_in_at);
--
-- Schema decisions:
--   * `mailing_audiences.slug` is the primary key — operator-chosen,
--     URL-safe, the stable handle that appears in scheduler configs +
--     campaign metadata. Renaming an audience would orphan delivery
--     audit rows; operators archive + redefine instead.
--   * `rules_json` is a JSON blob — the rule shape is wide enough that
--     a wide schema would force a migration per new predicate. The
--     primitive validates each known key, refuses unknown keys, and
--     normalises the structure before persisting (no free-form pass-
--     through of operator input into SQL).
--   * `archived_at` is the soft-delete column. Archived audiences
--     don't show up in `listAudiences` by default and don't recompute
--     under `recompute()`, but their `mailing_audience_deliveries`
--     audit rows stay queryable for compliance reporting.
--   * `mailing_audience_deliveries` is the append-only audit ledger.
--     One row per campaign send — `slug`, `campaign_id`, `sent_count`,
--     `suppressed_count`, `occurred_at`. The operator's compliance
--     export reads this table to demonstrate per-audience send volume
--     + suppression honoring over a time window.
--   * `mailing_audience_membership_cache` is a materialised view the
--     scheduler refreshes via `recompute()`. Resolves are O(rows) on
--     the cache rather than O(signups + rule eval) — operators with
--     six-figure signup lists need the cache to keep resolve latency
--     bounded. Composite primary key `(slug, signup_id)` so a stale
--     cache for a deleted signup can be cleaned up by slug-scoped
--     DELETE during recompute.

CREATE TABLE IF NOT EXISTS mailing_audiences (
  slug         TEXT NOT NULL PRIMARY KEY,
  title        TEXT NOT NULL,
  rules_json   TEXT NOT NULL,
  archived_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailing_audiences_archived ON mailing_audiences(archived_at);

CREATE TABLE IF NOT EXISTS mailing_audience_deliveries (
  id                TEXT NOT NULL PRIMARY KEY,
  slug              TEXT NOT NULL,
  campaign_id       TEXT NOT NULL,
  sent_count        INTEGER NOT NULL CHECK (sent_count >= 0),
  suppressed_count  INTEGER NOT NULL CHECK (suppressed_count >= 0),
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mailing_audience_deliveries_slug      ON mailing_audience_deliveries(slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_mailing_audience_deliveries_campaign  ON mailing_audience_deliveries(campaign_id);

CREATE TABLE IF NOT EXISTS mailing_audience_membership_cache (
  slug          TEXT NOT NULL,
  signup_id     TEXT NOT NULL,
  refreshed_at  INTEGER NOT NULL,
  PRIMARY KEY (slug, signup_id)
);

CREATE INDEX IF NOT EXISTS idx_mailing_audience_membership_cache_slug ON mailing_audience_membership_cache(slug, refreshed_at);
