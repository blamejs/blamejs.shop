-- Subscription gifts — giver pays upfront for N billing cycles; the
-- recipient claims the prepaid subscription with a redemption token.
-- Also records ownership transfers (a subscription's payer changes —
-- e.g. a business account passes from one owner to another).
--
-- Two tables:
--
--   * `subscription_gifts` — one row per purchased gift. `id` is the
--     gift UUID. `giver_customer_id` is the buyer (who paid). The
--     recipient is identified one of three ways:
--       - `recipient_email_normalised` / `recipient_email_hash` are
--         populated when the giver entered an email at purchase
--         time. The hash is SHA3-512 under a namespace constant so a
--         dump of this table doesn't expose plaintext recipient
--         addresses; the normalised local-part+domain is kept
--         alongside ONLY when the operator opts in to plaintext
--         recipient storage (e.g. to render "to: alice@…" in the
--         giver's order history). When the operator does not want
--         plaintext stored, the column stays NULL and only the hash
--         persists.
--       - When the giver creates an unaddressed gift (printed
--         claim card, deferred recipient), both columns are NULL and
--         the redemption token is the only credential needed.
--     `token_hash` is the SHA3-512 of the plaintext redemption
--     token under a namespace constant; the plaintext is shown ONCE
--     at `purchaseGift` time and never persisted. UNIQUE — every
--     redemption presents a token whose hash matches exactly one
--     gift row. `cycles_purchased` is the number of billing cycles
--     the giver prepaid; the redemption call hands these forward to
--     `subscriptions.create` as `prepaid_cycles` metadata so the
--     subscription primitive can short-circuit dunning until the
--     prepaid window elapses. `total_charged_minor` + `currency`
--     are operator-facing audit fields — refunds (out of band, see
--     `cancelGift`) reference this amount.
--
--     FSM:
--       pending   — gift purchased; not yet delivered or redeemed.
--       delivered — `scheduled_delivery_at` has elapsed and the
--                   delivery sweep marked the gift visible to the
--                   recipient (a future addition; today the column
--                   is also written when the operator calls a
--                   deliver path). A delivered gift is redeemable.
--       redeemed  — `redeemGift` consumed the token and minted a
--                   subscription. `redeemed_subscription_id` carries
--                   the resulting subscription UUID; `redeemed_at`
--                   stamps the moment.
--       expired   — the sliding window from `created_at` to
--                   `expires_at` elapsed without redemption. The
--                   token is then dead; the operator issues a
--                   refund out of band.
--       cancelled — the giver cancelled before the recipient
--                   redeemed. `cancelled_at` + `cancel_reason`
--                   populate; refund logic is operator-side.
--
--   * `subscription_ownership_transfers` — append-only ledger of
--     subscription-owner changes. The row records the prior owner,
--     the new owner, the reason (e.g. "business sale", "estate
--     transfer"), and the timestamp. The `subscriptions` row itself
--     is updated separately by the caller — this table is the audit
--     trail.
--
-- Schema decisions:
--
--   * `recipient_email_hash` is nullable so an unaddressed gift can
--     ship without an email. When populated, the column is
--     SHA3-512(namespace, normalised_email) — comparison + lookup
--     are by hash only.
--
--   * `expires_at` is the absolute deadline (epoch ms) computed at
--     `purchaseGift` time. Storing the absolute value (vs.
--     recomputing) means a future policy change to the default
--     window doesn't retroactively expire / re-validate prior
--     gifts.
--
--   * `redeemed_subscription_id` is populated on the redeem
--     transition; `cancelled_at` / `cancel_reason` populate on
--     cancel; `delivered_at` populates on the deliver transition.
--     The three FSM-exit columns are nullable on the row's
--     `pending` state and filled by the matching transition.
--
-- Indexes:
--
--   * `(giver_customer_id, created_at DESC)` — drives
--     `giftsForGiver` ordering.
--   * `(status, expires_at)` — drives the sweep that transitions
--     unredeemed gifts to `expired` on a scheduled job, and the
--     `expiringGifts` operator dashboard read.
--   * `(token_hash)` is UNIQUE on the table (the redemption path
--     does a single point lookup by hash).
--   * `(subscription_id, occurred_at DESC)` on the transfers table
--     — drives `transfersForSubscription` ordering.

CREATE TABLE IF NOT EXISTS subscription_gifts (
  id                          TEXT NOT NULL PRIMARY KEY,
  giver_customer_id           TEXT NOT NULL,
  plan_id                     TEXT NOT NULL,
  recipient_email_hash        TEXT,
  recipient_email_normalised  TEXT,
  cycles_purchased            INTEGER NOT NULL CHECK (cycles_purchased > 0),
  total_charged_minor         INTEGER NOT NULL CHECK (total_charged_minor > 0),
  currency                    TEXT NOT NULL CHECK (length(currency) = 3),
  token_hash                  TEXT NOT NULL UNIQUE,
  message                     TEXT,
  scheduled_delivery_at       INTEGER,
  delivered_at                INTEGER,
  status                      TEXT NOT NULL CHECK (status IN ('pending','delivered','redeemed','expired','cancelled')),
  redeemed_at                 INTEGER,
  redeemed_subscription_id    TEXT,
  cancelled_at                INTEGER,
  cancel_reason               TEXT,
  created_at                  INTEGER NOT NULL,
  expires_at                  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_gifts_giver
  ON subscription_gifts(giver_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_gifts_status_expires
  ON subscription_gifts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_subscription_gifts_recipient_hash
  ON subscription_gifts(recipient_email_hash);

CREATE TABLE IF NOT EXISTS subscription_ownership_transfers (
  id                TEXT NOT NULL PRIMARY KEY,
  subscription_id   TEXT NOT NULL,
  from_customer_id  TEXT NOT NULL,
  to_customer_id    TEXT NOT NULL,
  reason            TEXT NOT NULL,
  occurred_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_ownership_transfers_sub
  ON subscription_ownership_transfers(subscription_id, occurred_at DESC);
