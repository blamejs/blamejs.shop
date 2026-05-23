-- wishlist-alerts: notify customers when wishlist items go on sale or
-- come back in stock.
--
-- The primitive composes the existing surface — `wishlist` answers
-- "which customer wants which product", `catalog` answers "what's the
-- current price + inventory state", `email` ships the notification,
-- `stockAlerts` keeps its own per-SKU subscription table for the
-- opt-in PDP "notify me" toggle (a related-but-distinct concern). The
-- alert policies modeled here are operator-authored RULES — "fire when
-- any wishlisted item drops 20%+", "fire when any wishlisted out-of-
-- stock item returns" — applied across the whole wishlist table in one
-- scheduler pass.
--
-- Three tables:
--
--   * wishlist_alert_policies — operator-authored, slug-keyed. Each
--     row carries a `trigger` enum + a `threshold_json` payload whose
--     shape depends on the trigger (price_drop carries
--     `percent_off_bps_min`, the others currently carry an empty
--     payload). A per-customer-per-week cap is the operator's lever
--     for noise control; NULL means "no cap".
--
--   * wishlist_alerts_sent — append-only ledger of every alert the
--     dispatcher actually delivered. Keyed by id, indexed by customer
--     for the customerAlertHistory + max-per-week walk, by policy
--     slug for metricsForPolicy, and by (customer_id, sku, policy_slug)
--     for the "did we already fire this exact alert recently" dedupe.
--
--   * wishlist_alert_unsubscribes — per-customer-per-trigger opt-out.
--     UNIQUE (customer_id, trigger) so re-unsubscribing is a no-op
--     and the dispatcher's "is this customer opted out?" lookup is
--     a single-row hit.
--
-- Schema decisions:
--
--   * `trigger` is a closed enum. `price_drop` and `back_in_stock`
--     are the two ground-truth scanner gates the dispatcher walks.
--     `new_review_high_rating` and `restocked` are operator-authored
--     event kinds the surface accepts at policy definition time so a
--     forward-compatible policy table can be authored before the
--     review-ingestion / inventory-event-feed primitives land. The
--     dispatcher refuses to fire those policies until the matching
--     event source is wired (drop-silent at scan time — the policy
--     row stays valid).
--
--   * `threshold_json` is a JSON object whose validated shape depends
--     on `trigger`. For `price_drop` it MUST contain
--     `percent_off_bps_min` (1..10000 basis points; 2000 = 20% off).
--     For the other triggers it is `{}` — present, empty, refused
--     when populated to keep operator intent unambiguous.
--
--   * `max_alerts_per_week_per_customer` is nullable. A bound rule
--     causes the dispatcher to count this customer's sent alerts for
--     ANY policy in the trailing 7 days; if the count would exceed
--     the cap, the alert is dropped for this scan (and may fire on a
--     later scan once the rolling window clears). NULL = uncapped.
--
--   * `archived_at` is the soft-delete timestamp. Archived policies
--     never fire; the dispatcher skips them entirely. Operators
--     reactivate via updateRule({ archived_at: null }) — though the
--     surfaced gesture is archiveAlertPolicy + a fresh
--     defineAlertPolicy when an operator wants to author a new
--     policy with the same slug shape.
--
--   * The sent ledger's `channel` is closed-enum email / sms / in-app.
--     The dispatcher hands the alert to the injected `email` handle
--     (the only wired channel at v1); sms / in-app are accepted at
--     markAlertSent so operators wiring those transports off-table
--     can record the delivery.
--
-- Indexes:
--
--   * (active, archived_at) on policies — hot read in the scanner.
--   * (customer_id, occurred_at DESC) on sent — customerAlertHistory
--     + per-customer weekly cap walk.
--   * (policy_slug, occurred_at DESC) on sent — metricsForPolicy.
--   * (customer_id, sku, policy_slug, occurred_at DESC) on sent —
--     intra-scan dedupe (don't fire the same (customer, sku, policy)
--     twice in 24h).
--   * UNIQUE (customer_id, trigger) on unsubscribes — opt-out lookup.

CREATE TABLE IF NOT EXISTS wishlist_alert_policies (
  slug                              TEXT NOT NULL PRIMARY KEY,
  trigger                           TEXT NOT NULL CHECK (trigger IN (
                                      'price_drop',
                                      'back_in_stock',
                                      'new_review_high_rating',
                                      'restocked'
                                    )),
  threshold_json                    TEXT NOT NULL DEFAULT '{}',
  max_alerts_per_week_per_customer  INTEGER,
  archived_at                       INTEGER,
  created_at                        INTEGER NOT NULL,
  updated_at                        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wishlist_alert_policies_live
  ON wishlist_alert_policies(archived_at, trigger);

CREATE TABLE IF NOT EXISTS wishlist_alerts_sent (
  id            TEXT NOT NULL PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  policy_slug   TEXT NOT NULL,
  sku           TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'in-app')),
  occurred_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wishlist_alerts_sent_customer
  ON wishlist_alerts_sent(customer_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_wishlist_alerts_sent_policy
  ON wishlist_alerts_sent(policy_slug, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_wishlist_alerts_sent_dedupe
  ON wishlist_alerts_sent(customer_id, sku, policy_slug, occurred_at DESC);

CREATE TABLE IF NOT EXISTS wishlist_alert_unsubscribes (
  id            TEXT NOT NULL PRIMARY KEY,
  customer_id   TEXT NOT NULL,
  trigger       TEXT NOT NULL CHECK (trigger IN (
                  'price_drop',
                  'back_in_stock',
                  'new_review_high_rating',
                  'restocked'
                )),
  occurred_at   INTEGER NOT NULL,
  UNIQUE (customer_id, trigger)
);

CREATE INDEX IF NOT EXISTS idx_wishlist_alert_unsubscribes_customer
  ON wishlist_alert_unsubscribes(customer_id);
