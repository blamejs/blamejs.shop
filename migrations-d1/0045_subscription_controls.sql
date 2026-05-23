-- Subscription controls — operator + customer pause / resume / skip /
-- change-quantity / change-frequency / cancel / reactivate layered on
-- top of the existing `subscriptions` row. The lifecycle the controls
-- primitive walks is local: a logical "active / paused / cancelled"
-- state derived from three nullable timestamp columns added to
-- `subscriptions` — `paused_at`, `paused_until`, `cancelled_at`. The
-- existing Stripe-mirrored `status` column stays the source of truth
-- for the upstream billing state (trialing / active / past_due / …);
-- the local control state is what the customer-service operator sees
-- when they triage a churn ticket.
--
-- Three additional columns on `subscriptions` carry the data the
-- control surface mutates without round-tripping Stripe on every
-- read:
--
--   quantity        INTEGER NOT NULL DEFAULT 1
--                   — the line quantity the customer is billed for.
--                     `changeQuantity` writes here; cap > 0 enforced
--                     at the primitive layer.
--   frequency       TEXT
--                   — the customer-facing cadence enum
--                     (weekly/biweekly/monthly/quarterly/semiannual/
--                     annual). NULL until `changeFrequency` runs;
--                     reads fall through to the plan's `interval` +
--                     `interval_count`.
--   next_billing_at INTEGER
--                   — epoch ms; when the next invoice generates.
--                     `skipNext` adds N billing periods to this
--                     column without changing local state;
--                     `changeFrequency` recomputes it on the new
--                     cadence.
--
-- `subscription_control_events` is the append-only audit ledger.
-- Every control method writes one row with the before/after shape
-- of the relevant subscription fields, the actor that initiated it
-- (`customer` / `operator` / `system`), and the operator-provided
-- reason (capped at 280 bytes). Customer-service operators replay
-- the ledger on the customer profile screen to understand why a
-- subscription is in its current state.
--
-- Indexes:
--   * (subscription_id, occurred_at DESC) — history view per row.
--   * (event, occurred_at) — cross-subscription actor reports
--     ("show me every pause this month").
--   * (paused_until) WHERE paused_until IS NOT NULL — partial index
--     for the auto-resume scheduler walk; scanned every minute by a
--     cron, so the partial index keeps the working set tiny.

ALTER TABLE subscriptions ADD COLUMN paused_at INTEGER;

ALTER TABLE subscriptions ADD COLUMN paused_until INTEGER;

ALTER TABLE subscriptions ADD COLUMN cancelled_at INTEGER;

ALTER TABLE subscriptions ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0);

ALTER TABLE subscriptions ADD COLUMN frequency TEXT CHECK (frequency IS NULL OR frequency IN ('weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'annual'));

ALTER TABLE subscriptions ADD COLUMN next_billing_at INTEGER;

CREATE TABLE IF NOT EXISTS subscription_control_events (
  id                TEXT NOT NULL PRIMARY KEY,
  subscription_id   TEXT NOT NULL,
  event             TEXT NOT NULL CHECK (event IN ('pause', 'resume', 'skip', 'quantity_change', 'frequency_change', 'cancel', 'reactivate')),
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('customer', 'operator', 'system')),
  actor_id          TEXT,
  before_json       TEXT NOT NULL,
  after_json        TEXT NOT NULL,
  reason            TEXT,
  occurred_at       INTEGER NOT NULL,
  FOREIGN KEY (subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sub_ctrl_events_subscription
  ON subscription_control_events(subscription_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_sub_ctrl_events_event
  ON subscription_control_events(event, occurred_at);

CREATE INDEX IF NOT EXISTS idx_subscriptions_paused_until
  ON subscriptions(paused_until) WHERE paused_until IS NOT NULL;
