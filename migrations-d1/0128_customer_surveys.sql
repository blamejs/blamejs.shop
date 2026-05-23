-- Customer surveys: post-purchase satisfaction / NPS / CSAT / CES
-- feedback loops triggered by lifecycle events (delivery / support
-- ticket close / refund) or operator-initiated manual sends.
--
-- Three tables, slug-keyed primary table:
--
--   * `customer_surveys` — one row per operator-defined survey. `slug`
--     is the PRIMARY KEY (lowercase alnum + dash). `kind` is the
--     scoring family (nps / csat / ces / custom) — operators pick the
--     family up front because the rollup math is family-specific
--     (NPS = %promoters - %detractors; CSAT = %positive; CES = mean
--     rating; custom = per-question aggregates only). `trigger` is
--     the lifecycle event the application listens for to fan out the
--     invitation; `manual` means the operator dispatches via an
--     admin action / API call. `questions_json` is the operator-
--     authored ordered list of question shapes; each row carries a
--     stable `id` so a survey can evolve (add a follow-up question)
--     without breaking historical responses. `archived_at` soft-
--     retires a survey — existing invitations still resolve, new
--     `issueInvitation` calls refuse.
--
--   * `survey_invitations` — one row per (survey_slug, customer_id,
--     source_event_id) issuance. `token_hash` is the SHA3-512 of the
--     plaintext token (with the namespace `survey-invitation-token`)
--     stored UNIQUE. The plaintext is shown EXACTLY ONCE on issue
--     and never persisted — `submitResponse(token, ...)` re-hashes
--     and looks up. `status` is the FSM:
--       - issued     -> responded     (submitResponse)
--       - issued     -> expired       (expires_at passed; cleanupExpired)
--       - issued     -> closed        (closeInvitation — operator
--                                      revokes pre-response)
--     `source_event_id` is the optional event-source breadcrumb
--     (delivery_id, support_ticket_id, refund_id) so an operator
--     auditing a complaint can trace which event triggered the ask.
--     It's an opaque string column at the schema layer (the event
--     domain owns the id-shape contract).
--
--   * `survey_responses` — one row per submitted response. FK CASCADE
--     on `invitation_id` so deleting an invitation also clears its
--     response (an operator who hard-removes a test invitation
--     doesn't leak its answer set). `answers_json` is the validated
--     answer object keyed by question id. `occurred_at` defaults to
--     the submit time but can be operator-supplied for backfills (the
--     primitive snaps it forward when an older timestamp would
--     violate per-invitation monotonicity — see lib/customer-surveys.js).
--
-- Indexes drive the four hot read paths:
--   * (customer_id, status, expires_at) — invitationsForCustomer +
--     cleanupExpired window
--   * (survey_slug, status)             — responsesForSurvey rollup
--   * (token_hash UNIQUE)                — submitResponse lookup
--   * (invitation_id)                    — survey_responses by invite

CREATE TABLE IF NOT EXISTS customer_surveys (
  slug             TEXT    NOT NULL PRIMARY KEY,
  title            TEXT    NOT NULL,
  kind             TEXT    NOT NULL CHECK (kind IN ('nps', 'csat', 'ces', 'custom')),
  trigger_event    TEXT    NOT NULL CHECK (trigger_event IN ('after_delivery', 'after_support_close', 'after_refund', 'manual')),
  questions_json   TEXT    NOT NULL,
  archived_at      INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_customer_surveys_kind     ON customer_surveys(kind);
CREATE INDEX IF NOT EXISTS idx_customer_surveys_trigger  ON customer_surveys(trigger_event);
CREATE INDEX IF NOT EXISTS idx_customer_surveys_archived ON customer_surveys(archived_at);

CREATE TABLE IF NOT EXISTS survey_invitations (
  id               TEXT    NOT NULL PRIMARY KEY,
  survey_slug      TEXT    NOT NULL,
  customer_id      TEXT    NOT NULL,
  token_hash       TEXT    NOT NULL UNIQUE,
  source_event_id  TEXT,
  status           TEXT    NOT NULL CHECK (status IN ('issued', 'responded', 'expired', 'closed')),
  expires_at       INTEGER NOT NULL,
  issued_at        INTEGER NOT NULL,
  responded_at     INTEGER,
  closed_at        INTEGER,
  closed_reason    TEXT,
  FOREIGN KEY (survey_slug) REFERENCES customer_surveys(slug) ON DELETE CASCADE,
  CHECK ((status = 'issued'    AND responded_at IS NULL AND closed_at IS NULL)
      OR (status = 'responded' AND responded_at IS NOT NULL AND closed_at IS NULL)
      OR (status = 'expired'   AND closed_at IS NULL)
      OR (status = 'closed'    AND closed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_survey_invitations_customer ON survey_invitations(customer_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_survey_invitations_slug     ON survey_invitations(survey_slug, status);
CREATE INDEX IF NOT EXISTS idx_survey_invitations_expires  ON survey_invitations(status, expires_at);

CREATE TABLE IF NOT EXISTS survey_responses (
  id              TEXT    NOT NULL PRIMARY KEY,
  invitation_id   TEXT    NOT NULL,
  answers_json    TEXT    NOT NULL,
  occurred_at     INTEGER NOT NULL,
  FOREIGN KEY (invitation_id) REFERENCES survey_invitations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_survey_responses_invitation ON survey_responses(invitation_id);
CREATE INDEX IF NOT EXISTS idx_survey_responses_occurred   ON survey_responses(occurred_at);
