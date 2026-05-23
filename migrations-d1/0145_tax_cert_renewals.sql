-- Tax-certificate renewal scheduler — companion to tax_exempt_certificates.
-- A buyer's exemption certificate has a real-world expiry date; once it
-- lapses the operator's checkout path stops honoring the row. To avoid
-- silent lapse the operator pre-schedules per-jurisdiction reminder
-- cadences: a `lead_time_days` window over which `scanAndEnqueue` walks
-- approved certificates with `expires_at IN [now, now + lead_time_days]`
-- and writes one `tax_cert_renewal_reminders` row per (cert, channel)
-- tuple in `queued` state. The dispatcher fans the row out through the
-- notifications primitive and flips `status` to `sent`. If the buyer
-- still hasn't renewed by `created_at + escalate_after_days` the
-- operator flips the row to `escalated` and routes it to the account-
-- manager queue. `markRenewed` / `markExpired` close the loop once the
-- buyer either submits a fresh certificate or the cert lapses entirely.
--
-- Two tables:
--
--   tax_cert_renewal_schedules
--     One row per jurisdiction. Jurisdiction is the PK — the cadence is
--     scoped to a tax authority (e.g. "US-CA" mails 60 days out, "EU-DE"
--     mails 90 days out). `escalate_after_days` is nullable: a
--     jurisdiction that doesn't want post-reminder escalation leaves
--     the column NULL and `markEscalated` callers receive an explicit
--     refusal.
--
--   tax_cert_renewal_reminders
--     One row per (cert_id, channel) reminder attempt. Status follows a
--     queued -> sent -> {escalated,renewed,expired} FSM enforced via a
--     CHECK constraint. Each terminal-state column carries its own
--     timestamp so the audit trail captures which transition fired
--     when, not just the latest state.
--
-- Indexes target the scanner's hot read (find approved certs nearing
-- expiry, filtered by jurisdiction + status) and the metrics rollup
-- (window-bounded reminder counts grouped by status).

CREATE TABLE IF NOT EXISTS tax_cert_renewal_schedules (
  jurisdiction            TEXT NOT NULL PRIMARY KEY,
  lead_time_days          INTEGER NOT NULL CHECK (lead_time_days > 0 AND lead_time_days <= 365),
  reminder_template_slug  TEXT NOT NULL,
  escalate_after_days     INTEGER CHECK (escalate_after_days IS NULL OR escalate_after_days > 0),
  archived_at             INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_cert_renewal_schedules_active
  ON tax_cert_renewal_schedules(jurisdiction) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS tax_cert_renewal_reminders (
  id              TEXT NOT NULL PRIMARY KEY,
  cert_id         TEXT NOT NULL,
  jurisdiction    TEXT NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'escalated', 'renewed', 'expired')),
  sent_at         INTEGER,
  escalated_at    INTEGER,
  escalated_to    TEXT,
  renewed_at      INTEGER,
  new_expiry      INTEGER,
  expired_at      INTEGER,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tax_cert_renewal_reminders_cert
  ON tax_cert_renewal_reminders(cert_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tax_cert_renewal_reminders_status
  ON tax_cert_renewal_reminders(jurisdiction, status, created_at);

CREATE INDEX IF NOT EXISTS idx_tax_cert_renewal_reminders_open
  ON tax_cert_renewal_reminders(cert_id, channel, status)
  WHERE status IN ('queued', 'sent');
