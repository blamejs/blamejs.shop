-- Affiliates — partner program. Each affiliate has a unique tracking
-- code; visitors arriving with `?ref=<code>` get an attribution cookie.
-- When an attributed visitor places an order, the primitive writes a
-- `affiliate_commissions` row computing the affiliate's commission
-- share from one of three kinds:
--
--   percent_bps              — basis-points share of order_total_minor
--                              (10000 = 100%). commission_value is the
--                              bps integer.
--   amount_per_order_minor   — flat per-order payout in minor units.
--                              commission_value is the amount.
--   amount_per_signup_minor  — flat per-signup payout; the primitive
--                              still writes a commission row keyed off
--                              the first order_id so the operator's
--                              ledger has a single grain to reconcile
--                              against, but commission_minor is the
--                              flat value regardless of order_total.
--
-- Operator payout flow is handled outside this primitive (a finance
-- process that calls `payoutsDue` + `markCommissionPaid`).
--
-- Three tables:
--
--   affiliates                — one row per partner. `code` is a
--                               URL-safe public handle (the storefront
--                               accepts `?ref=<code>`). `email_hash`
--                               is `b.crypto.namespaceHash("affiliate-
--                               email", lowercased)` so the raw
--                               address never lands on disk; the
--                               operator console re-derives the hash
--                               to look up an affiliate by email.
--                               `email_normalised` keeps the trimmed
--                               + lowercased form so the operator
--                               console can group affiliates by
--                               email-shape without the hash (the
--                               hash is one-way; the normalised form
--                               is what the operator console renders).
--                               `payout_address` is opaque (an IBAN,
--                               PayPal handle, Stripe Connect id —
--                               whatever the operator's payout pipeline
--                               consumes); shape validation is the
--                               payout pipeline's concern, not this
--                               primitive's. `commission_kind` +
--                               `commission_value` carry the payout
--                               rule. `attribution_window_days` is the
--                               cookie lifetime: visits older than
--                               this drop out of `attributionForSession`.
--
--   affiliate_visits          — one row per visit attribution. The
--                               `visitor_session_id_hash` is
--                               `b.crypto.namespaceHash("affiliate-
--                               session", visitor_session_id)`. Indexed
--                               on (visitor_session_id_hash, occurred_at
--                               DESC) so `attributionForSession` picks
--                               the most recent visit in O(log n).
--
--   affiliate_commissions     — one row per qualifying order.
--                               `status` is the payout FSM:
--                                 pending — recorded, not yet paid
--                                 paid    — payout_reference stamped
--                                 voided  — refund / chargeback /
--                                           operator override
--                               `commission_minor` is computed at
--                               write time from commission_kind +
--                               commission_value + order_total_minor;
--                               we don't recompute on read so an
--                               operator changing the affiliate's
--                               rate later doesn't retroactively
--                               adjust historical payouts.

CREATE TABLE IF NOT EXISTS affiliates (
  id                          TEXT NOT NULL PRIMARY KEY,
  code                        TEXT NOT NULL UNIQUE,
  name                        TEXT NOT NULL,
  email_hash                  TEXT NOT NULL,
  email_normalised            TEXT NOT NULL,
  payout_method               TEXT NOT NULL CHECK (payout_method IN (
    'paypal', 'bank_transfer', 'stripe_connect', 'gift_card', 'store_credit'
  )),
  payout_address              TEXT NOT NULL,
  commission_kind             TEXT NOT NULL CHECK (commission_kind IN (
    'percent_bps', 'amount_per_order_minor', 'amount_per_signup_minor'
  )),
  commission_value            INTEGER NOT NULL CHECK (commission_value >= 0),
  attribution_window_days     INTEGER NOT NULL CHECK (attribution_window_days > 0),
  active                      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  paused_at                   INTEGER,
  paused_reason               TEXT,
  created_at                  INTEGER NOT NULL,
  updated_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_affiliates_active
  ON affiliates(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliates_email_hash
  ON affiliates(email_hash);

CREATE TABLE IF NOT EXISTS affiliate_visits (
  id                          TEXT NOT NULL PRIMARY KEY,
  code                        TEXT NOT NULL,
  affiliate_id                TEXT NOT NULL,
  visitor_session_id_hash     TEXT NOT NULL,
  referrer                    TEXT,
  occurred_at                 INTEGER NOT NULL,
  FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_affiliate_visits_session
  ON affiliate_visits(visitor_session_id_hash, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_visits_affiliate
  ON affiliate_visits(affiliate_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id                          TEXT NOT NULL PRIMARY KEY,
  order_id                    TEXT NOT NULL,
  affiliate_id                TEXT NOT NULL,
  order_total_minor           INTEGER NOT NULL CHECK (order_total_minor >= 0),
  commission_minor            INTEGER NOT NULL CHECK (commission_minor >= 0),
  currency                    TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN (
    'pending', 'paid', 'voided'
  )),
  occurred_at                 INTEGER NOT NULL,
  paid_at                     INTEGER,
  voided_at                   INTEGER,
  payout_reference            TEXT,
  void_reason                 TEXT,
  FOREIGN KEY (affiliate_id) REFERENCES affiliates(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_affiliate_commissions_order
  ON affiliate_commissions(order_id, affiliate_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_affiliate_status
  ON affiliate_commissions(affiliate_id, status, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_affiliate_commissions_status_occurred
  ON affiliate_commissions(status, occurred_at DESC);
