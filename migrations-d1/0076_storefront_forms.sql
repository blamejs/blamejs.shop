-- Storefront forms — operator-defined contact / lead-capture /
-- "request a quote" / "wholesale application" forms. Operators
-- declare the field shape + the submit destination (email or
-- webhook); customers submit; the primitive validates per-field,
-- refuses missing required fields, and dispatches the values
-- through the injected `notifications` or `webhooks` dep.
--
-- Schema decisions:
--
--   * `storefront_forms.slug` is the PK — operators address each
--     form by a stable URL-friendly handle (e.g. "contact",
--     "wholesale", "request-quote"); the slug also addresses the
--     storefront route that renders the form.
--
--   * `fields_json` is the closed-shape field list — each element
--     is `{ name, kind, required, label, options? }`. `kind` is
--     drawn from a closed enum (`text / email / phone / textarea /
--     select / checkbox / number`); `options` is only meaningful
--     for `select`. Stored as JSON so the operator dashboard can
--     reorder / rename / re-required fields without a migration.
--
--   * `submit_to_json` is the dispatch target: `{ kind, value }`
--     with `kind` drawn from `email` / `webhook`. `value` is the
--     recipient email address or the webhook event name; the
--     primitive's `submit(...)` calls the matching injected dep
--     (`notifications.enqueue` for email; `webhooks.send` for
--     webhook).
--
--   * `throttle_per_minute_per_session` is the per-session-id
--     rate limit. Defaults to 5; 0 disables throttling. The
--     check counts rows in `storefront_form_submissions` over the
--     last 60s for the same (form_slug, session_id_hash) tuple.
--
--   * `archived_at` is the soft-delete marker. Archived forms
--     are excluded from `listForms` but still resolvable by
--     `getForm(slug)` for historical lookup.
--
--   * `storefront_form_submissions.id` is a UUIDv7 — monotonic
--     so the `(form_slug, created_at DESC, id DESC)` index gives
--     a stable cursor for paginated listing without an extra
--     wall-clock comparison in the cursor.
--
--   * `session_id_hash` is the SHA3-512 namespace hash of the
--     incoming session id (namespace
--     `"storefront-form-session"`). The raw session id never
--     reaches the table — a database compromise can't unmask
--     visitor session ids.
--
--   * `dispatched_at` + `dispatch_error` capture the dispatch
--     outcome. Both nullable: NULL `dispatched_at` means "not yet
--     dispatched" / "the dispatch dep wasn't wired at submit
--     time"; NULL `dispatch_error` on a dispatched row means the
--     dispatch returned cleanly.
--
-- Indexes:
--   * `(form_slug, created_at DESC, id DESC)` covers the
--     submissions-for-form listing cursor.
--   * `(form_slug, session_id_hash, created_at)` covers the
--     throttle window scan.
--   * `(archived_at)` lets `listForms` skip the archived rows
--     efficiently.

CREATE TABLE IF NOT EXISTS storefront_forms (
  slug                              TEXT NOT NULL PRIMARY KEY,
  title                             TEXT NOT NULL,
  description                       TEXT,
  fields_json                       TEXT NOT NULL,
  submit_to_json                    TEXT NOT NULL,
  success_message                   TEXT NOT NULL,
  throttle_per_minute_per_session   INTEGER NOT NULL DEFAULT 5 CHECK (throttle_per_minute_per_session >= 0),
  archived_at                       INTEGER,
  created_at                        INTEGER NOT NULL,
  updated_at                        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storefront_forms_archived_at
  ON storefront_forms(archived_at);

CREATE TABLE IF NOT EXISTS storefront_form_submissions (
  id                  TEXT NOT NULL PRIMARY KEY,
  form_slug           TEXT NOT NULL,
  values_json         TEXT NOT NULL,
  session_id_hash     TEXT,
  ip_hash             TEXT,
  ua_class            TEXT,
  dispatched_at       INTEGER,
  dispatch_error      TEXT,
  created_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_storefront_form_submissions_form_created
  ON storefront_form_submissions(form_slug, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_storefront_form_submissions_throttle
  ON storefront_form_submissions(form_slug, session_id_hash, created_at);
