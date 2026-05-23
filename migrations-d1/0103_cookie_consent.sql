-- Cookie consent — per-session records of the buyer's category-by-
-- category cookie / tracker decisions, plus the policy versions those
-- decisions were taken against.
--
-- GDPR (EU 2016/679 art. 6 + 7), ePrivacy Directive (2002/58/EC art.
-- 5(3)), and the German TDDDG (formerly TTDSG §25) require informed,
-- specific, freely-given consent BEFORE any non-strictly-necessary
-- cookie / tracker is set. UK PECR mirrors the same rule. The shop's
-- banner UI surfaces a categorised opt-in (functional, analytics,
-- marketing, preferences) with default-deny everywhere except the
-- strictly-necessary tier; this table is the durable record the
-- operator presents to a supervisory authority when asked "show me
-- what this buyer consented to and when."
--
-- One row per recorded decision. The newest row for a given
-- `session_id_hash` is the live consent state; older rows are kept
-- for the audit trail (consent-withdrawal evidence, policy-version
-- migration, dispute resolution). Each row carries the policy
-- version it was taken against — when the operator bumps
-- `policyVersion` (new tracker, expanded purpose, new processor),
-- sessions whose latest record points at an older version are
-- flagged for re-prompt the next time they reach the banner-gated
-- middleware.
--
-- The session id NEVER lands here in cleartext. The application tier
-- runs the raw session id through
-- `b.crypto.namespaceHash("cookie-consent-session", sessionId)`
-- before any write or read; a dump leaks the hash + the decision
-- shape, never the live cookie value an attacker could replay.
--
-- DNT (Mozilla's Do-Not-Track, dead in Chrome but still emitted by
-- Firefox / Safari / Brave) and Sec-GPC (the IAB / CCPA-aligned
-- Global Privacy Control) are recorded as the boolean the browser
-- sent. The application tier honors either signal as an IMPLICIT
-- deny for marketing + analytics regardless of what the per-category
-- columns say — a buyer cannot accidentally opt INTO tracking they
-- explicitly opted out of at the browser level. The columns are
-- recorded so the operator can prove the signal was respected.
--
-- `ip_hash` is OPTIONAL — the caller passes an already-hashed IP if
-- the operator's PII policy requires the consent record to be
-- attributable to a network endpoint (some supervisory authorities
-- expect this; others treat it as excessive). The primitive does NOT
-- do the hashing itself, so it stays orthogonal to the operator's
-- chosen hashing scheme.
--
-- `ua_class` is a coarse classifier ("desktop", "mobile", "tablet",
-- "bot", "unknown") — recorded for analytics (banner-acceptance
-- rates differ wildly by surface) and to detect bot-driven consent
-- spam.
--
-- `withdrawn_at` + `withdrawal_reason` capture the GDPR art. 7(3)
-- right-to-withdraw. Withdrawal is a NEW row in this table (with
-- every category column set to 0 except strictly-necessary, which is
-- implicit), not a destructive update — the audit trail must show
-- the original consent AND the withdrawal that followed it.

CREATE TABLE IF NOT EXISTS cookie_consent_records (
  id                  TEXT    NOT NULL PRIMARY KEY,
  session_id_hash     TEXT    NOT NULL,
  policy_version      TEXT    NOT NULL,
  functional          INTEGER NOT NULL DEFAULT 0 CHECK (functional  IN (0, 1)),
  analytics           INTEGER NOT NULL DEFAULT 0 CHECK (analytics   IN (0, 1)),
  marketing           INTEGER NOT NULL DEFAULT 0 CHECK (marketing   IN (0, 1)),
  preferences         INTEGER NOT NULL DEFAULT 0 CHECK (preferences IN (0, 1)),
  dnt                 INTEGER NOT NULL DEFAULT 0 CHECK (dnt         IN (0, 1)),
  gpc                 INTEGER NOT NULL DEFAULT 0 CHECK (gpc         IN (0, 1)),
  ip_hash             TEXT,
  ua_class            TEXT CHECK (ua_class IS NULL OR ua_class IN (
                        'desktop',
                        'mobile',
                        'tablet',
                        'bot',
                        'unknown'
                      )),
  occurred_at         INTEGER NOT NULL,
  withdrawn_at        INTEGER,
  withdrawal_reason   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cookie_consent_records_session
  ON cookie_consent_records(session_id_hash, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_cookie_consent_records_policy_version
  ON cookie_consent_records(policy_version);

CREATE INDEX IF NOT EXISTS idx_cookie_consent_records_occurred
  ON cookie_consent_records(occurred_at);

-- Policy version registry. Operators register each policy revision
-- ("v1" = launch; "v2" = added Klaviyo analytics; "v3" = added
-- TikTok pixel under marketing) with a human-readable summary + the
-- moment the new version became the live one. The application tier
-- reads `policyVersion` from the latest row to decide whether a
-- session's stored consent is still valid or needs a re-prompt.
--
-- `summary` is a short operator-facing string the banner UI can
-- surface as "what changed since you last consented" alongside the
-- re-prompt — refused above 1024 chars at the app tier.

CREATE TABLE IF NOT EXISTS cookie_consent_policy_versions (
  version         TEXT    NOT NULL PRIMARY KEY,
  summary         TEXT    NOT NULL,
  effective_from  INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);
