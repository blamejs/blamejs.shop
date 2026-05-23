-- CAPTCHA gate — provider registry plus per-verification audit log for
-- high-risk entry points (signup, password reset, checkout-with-coupon,
-- contact form).
--
-- The shape: each operator-configured CAPTCHA provider lands one row
-- in `captcha_providers` (slug-keyed). The application tier hands
-- buyer-submitted tokens to the primitive's `verifyToken({ ..., verify
-- })` call; `verify` is the operator's worker that talks HTTPS to the
-- provider's siteverify endpoint (Cloudflare Turnstile, hCaptcha,
-- reCAPTCHA v2/v3 each have their own URL + payload shape). The
-- primitive owns the local-side decision: provider lookup, threshold
-- math (reCAPTCHA v3 returns a score in [0.0, 1.0] — operator-set
-- `threshold_score` is the floor below which the verification fails),
-- expected-action equality (reCAPTCHA v3 stamps each token with the
-- action the page declared at challenge time), and the outcome row in
-- `captcha_verifications`.
--
-- The secret_key NEVER lands here in cleartext. The application tier
-- runs every operator-supplied secret through
-- `b.crypto.namespaceHash("captcha-secret", secret)` before storage;
-- a dump leaks the hash + the public key (which is, by design, public)
-- but not the bearer credential an attacker could pose as the operator
-- with. `secret_key_normalized` is the trimmed-whitespace canonical
-- form used to recompute the hash on every verify — operators paste
-- with trailing whitespace surprisingly often, and storing the
-- normalized form makes the gate idempotent under a re-paste.
--
-- `threshold_score` is OPTIONAL — only reCAPTCHA v3 returns a score;
-- the other kinds gate on the boolean `success` field alone. Operators
-- registering Turnstile / hCaptcha / reCAPTCHA v2 leave the column
-- NULL.
--
-- `archived_at` is the audit-friendly soft-delete. Verifications still
-- reference the slug — a hard delete would orphan months of audit-log
-- evidence — so the application tier flips `archived_at` and lets the
-- row outlive the deletion in read-only form.
--
-- `captcha_verifications` is the per-outcome audit log: one row per
-- `verifyToken` AND one row per `recordOutcome`. The two flows differ
-- by intent — `verifyToken` is the local-side decision the primitive
-- produces; `recordOutcome` is the operator's post-hoc tally (the
-- buyer submitted the form, the worker's verify succeeded, the gate
-- rendered the page). Both share the same shape so `metricsForProvider`
-- can compute pass-rate / fail-rate / score-distribution across the
-- full audit surface.
--
-- session_id_hash + ip_hash are OPTIONAL and ALWAYS pre-hashed by the
-- application tier — the raw values never land in this table. The
-- hash is a hex-encoded SHA3-512 from `b.crypto.namespaceHash`; a 128-
-- char column is wide enough for the full digest. Operators with a
-- PII policy that forbids per-row IP retention pass NULL.

CREATE TABLE IF NOT EXISTS captcha_providers (
  slug                   TEXT    NOT NULL PRIMARY KEY,
  kind                   TEXT    NOT NULL CHECK (kind IN (
                            'turnstile',
                            'hcaptcha',
                            'recaptcha_v2',
                            'recaptcha_v3'
                          )),
  public_key             TEXT    NOT NULL,
  secret_key_hash        TEXT    NOT NULL,
  secret_key_normalized  TEXT    NOT NULL,
  threshold_score        INTEGER,
  active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  archived_at            INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_captcha_providers_active
  ON captcha_providers(active, archived_at);

CREATE INDEX IF NOT EXISTS idx_captcha_providers_kind
  ON captcha_providers(kind);

CREATE TABLE IF NOT EXISTS captcha_verifications (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_slug     TEXT    NOT NULL,
  gate              TEXT    NOT NULL CHECK (gate IN (
                       'signup',
                       'password_reset',
                       'checkout_coupon',
                       'contact_form',
                       'other'
                     )),
  ok                INTEGER NOT NULL CHECK (ok IN (0, 1)),
  score             INTEGER,
  action            TEXT,
  session_id_hash   TEXT,
  ip_hash           TEXT,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_captcha_verifications_slug_occurred
  ON captcha_verifications(provider_slug, occurred_at);

CREATE INDEX IF NOT EXISTS idx_captcha_verifications_gate_occurred
  ON captcha_verifications(gate, occurred_at);

CREATE INDEX IF NOT EXISTS idx_captcha_verifications_occurred
  ON captcha_verifications(occurred_at);
