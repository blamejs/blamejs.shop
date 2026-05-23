-- Referrals — refer-a-friend with two-sided rewards.
--
-- A `referral_codes` row is the long-lived public identifier a
-- referrer (an existing customer) hands out. The shop generates an
-- 8-character alphanumeric code from a confusion-resistant alphabet
-- (the gift-card alphabet — no 0/O/I/1 collisions); the code is
-- stored uppercase and looked up case-insensitively. One active code
-- per referrer is enforced at the primitive tier; rotating the code
-- means disabling the old row and issuing a new one (audit-friendly:
-- historical invitations still resolve to the original code).
--
-- A `referral_invitations` row tracks one friend's progress through
-- the reward funnel: invited -> visited -> signed up -> first
-- purchase -> both-rewarded. The referred-friend's email is NEVER
-- stored plaintext — only its `b.crypto.namespaceHash` digest
-- ("referral-referee", normalized address). Dedupe is on
-- (referral_code_id, referred_email_hash) so the same friend invited
-- twice by the same referrer collapses to a single row.
--
-- `reward_status` is the FSM: pending -> referrer-rewarded ->
-- both-rewarded, with `expired` and `voided` as terminal opt-outs
-- the operator drives. Payouts themselves (gift card / discount /
-- credit) live in their own primitive — this table only records the
-- reward instrument id (`referrer_reward_id`, `referee_reward_id`)
-- the operator handed out, so a future ledger reconciliation can
-- cross-reference without ambiguity.

CREATE TABLE IF NOT EXISTS referral_codes (
  id              TEXT NOT NULL PRIMARY KEY,
  referrer_customer_id TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL CHECK (status IN ('active','disabled')),
  referrals_count INTEGER NOT NULL DEFAULT 0 CHECK (referrals_count >= 0),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS referral_invitations (
  id                  TEXT NOT NULL PRIMARY KEY,
  referral_code_id    TEXT NOT NULL,
  referred_email_hash TEXT NOT NULL,
  invited_at          INTEGER NOT NULL,
  visited_at          INTEGER,
  signed_up_at        INTEGER,
  signed_up_customer_id TEXT,
  first_purchase_at   INTEGER,
  first_order_id      TEXT,
  reward_status       TEXT NOT NULL CHECK (reward_status IN ('pending','referrer-rewarded','both-rewarded','expired','voided')),
  referrer_reward_id  TEXT,
  referee_reward_id   TEXT,
  FOREIGN KEY (referral_code_id) REFERENCES referral_codes(id)
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_referrer ON referral_codes(referrer_customer_id);
CREATE INDEX IF NOT EXISTS idx_referral_invitations_code ON referral_invitations(referral_code_id, invited_at);
CREATE INDEX IF NOT EXISTS idx_referral_invitations_email ON referral_invitations(referred_email_hash);
CREATE INDEX IF NOT EXISTS idx_referral_invitations_signed_up ON referral_invitations(signed_up_customer_id);
