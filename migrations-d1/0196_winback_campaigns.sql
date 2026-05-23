-- Winback campaigns — re-engagement sequences for lapsed customers.
--
-- The cart-recovery primitive nurtures a single abandoned cart; this
-- primitive nurtures a customer who's gone quiet across every cart —
-- the last paid order is N days in the past and the operator wants
-- to land a sequence of escalating offers ("we miss you" → "here's
-- 10% off" → "last call, here's 20%") to pull them back. The
-- operator defines a `winback_campaigns` row keyed by slug; the
-- `lapse_days_min` (and optional `lapse_days_max`) gates the
-- audience; the `steps_json` ordered array declares the per-step
-- delay + email template + coupon kind/value pair.
--
-- Three tables back the surface:
--
--   winback_campaigns   — operator-defined campaign config.
--                         `steps_json` is the ordered array of
--                         `{ delay_days, template_slug, coupon_kind?,
--                         coupon_value? }`. `audience_filter_json`
--                         carries optional extra predicates the
--                         operator narrows on (e.g. country_in,
--                         minimum_lifetime_orders) — evaluated by the
--                         scan call against the operator's order
--                         history. `archived_at` soft-deletes the
--                         campaign without dropping historical
--                         enrollments.
--
--   winback_enrollments — one row per (campaign_slug, customer_id)
--                         pair currently being nurtured. FSM:
--                         active → recovered (customer placed an
--                         order) | exhausted (every step fired) |
--                         cancelled (operator pulled it). The
--                         `next_step_at` epoch-ms drives the
--                         dispatcher's hot read; the
--                         `current_step_index` walks the steps array;
--                         `recovered_order_id` records which order
--                         closed it for the recovery-rate metric.
--
--   winback_deliveries  — append-only per-step delivery log. The
--                         dispatcher writes one row per fired step
--                         with the rendered coupon code (when the
--                         step minted one) so the operator dashboard
--                         can answer "which step delivered which
--                         code at which time".
--
-- Indexes:
--   * (next_step_at, status) on enrollments — dispatcher hot read.
--   * (customer_id, campaign_slug) on enrollments UNIQUE — a customer
--     enrolls at most once per campaign (re-enrolling on an active
--     row is a no-op).
--   * (campaign_slug, status) on enrollments — metricsForCampaign.
--   * (enrollment_id, step_index) on deliveries — per-enrollment
--     audit panel + idempotency check.

CREATE TABLE IF NOT EXISTS winback_campaigns (
  slug                  TEXT NOT NULL PRIMARY KEY,
  lapse_days_min        INTEGER NOT NULL CHECK (lapse_days_min >= 1),
  lapse_days_max        INTEGER,
  steps_json            TEXT NOT NULL,
  audience_filter_json  TEXT NOT NULL DEFAULT '{}',
  archived_at           INTEGER,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_winback_campaigns_archived
  ON winback_campaigns(archived_at);

CREATE TABLE IF NOT EXISTS winback_enrollments (
  id                    TEXT NOT NULL PRIMARY KEY,
  campaign_slug         TEXT NOT NULL,
  customer_id           TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
    'active',
    'recovered',
    'exhausted',
    'cancelled'
  )),
  current_step_index    INTEGER NOT NULL DEFAULT 0,
  next_step_at          INTEGER,
  recovered_order_id    TEXT,
  recovered_at          INTEGER,
  cancelled_at          INTEGER,
  cancelled_reason      TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (campaign_slug) REFERENCES winback_campaigns(slug) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_winback_enrollments_customer_campaign
  ON winback_enrollments(customer_id, campaign_slug);

CREATE INDEX IF NOT EXISTS idx_winback_enrollments_next_step
  ON winback_enrollments(next_step_at, status);

CREATE INDEX IF NOT EXISTS idx_winback_enrollments_campaign_status
  ON winback_enrollments(campaign_slug, status);

CREATE TABLE IF NOT EXISTS winback_deliveries (
  id              TEXT NOT NULL PRIMARY KEY,
  enrollment_id   TEXT NOT NULL,
  step_index      INTEGER NOT NULL,
  coupon_code     TEXT,
  delivered_at    INTEGER NOT NULL,
  FOREIGN KEY (enrollment_id) REFERENCES winback_enrollments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_winback_deliveries_enrollment
  ON winback_deliveries(enrollment_id, step_index);

CREATE UNIQUE INDEX IF NOT EXISTS idx_winback_deliveries_idem
  ON winback_deliveries(enrollment_id, step_index);
