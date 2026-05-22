-- Gift cards: issue and redeem prepaid balance instruments.
--
-- A gift card is a bearer credential: whoever knows the plaintext
-- code can spend the balance. The shop never stores the plaintext —
-- only the b.crypto.namespaceHash("giftcard-code", plaintext) digest
-- (deterministic SHA3-512 with domain separation) and the last 4
-- characters of the plaintext as `code_hint`. The hint is for
-- operator-side identification ("customer claims they bought card
-- ending in K3Q9 — which row is theirs?") and is far too short to
-- enable plaintext recovery via brute force against a 16-char,
-- 32-character-alphabet code space.
--
-- Recipients without accounts are addressed by an email-hash
-- (b.crypto.namespaceHash("giftcard-recipient", email)) so a stolen
-- D1 dump leaks no recipient addresses while still letting the
-- storefront resolve "this address is the owner of these cards"
-- after the recipient registers.
--
-- Companion table `giftcard_redemptions` is the append-only ledger
-- of every spend against a card. balance_minor on `giftcards` is the
-- live running balance; redemptions are the audit trail.

CREATE TABLE IF NOT EXISTS giftcards (
  id                     TEXT NOT NULL PRIMARY KEY,
  code_hash              TEXT NOT NULL,
  code_hint              TEXT NOT NULL,
  currency               TEXT NOT NULL CHECK (length(currency) = 3),
  issued_minor           INTEGER NOT NULL CHECK (issued_minor > 0),
  balance_minor          INTEGER NOT NULL CHECK (balance_minor >= 0 AND balance_minor <= issued_minor),
  issued_to_customer_id  TEXT,
  issued_to_email_hash   TEXT,
  expires_at             INTEGER,
  status                 TEXT NOT NULL CHECK (status IN ('active', 'redeemed', 'expired', 'voided')),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_giftcards_code_hash      ON giftcards(code_hash);
CREATE        INDEX IF NOT EXISTS idx_giftcards_status_expires ON giftcards(status, expires_at);
CREATE        INDEX IF NOT EXISTS idx_giftcards_customer       ON giftcards(issued_to_customer_id, status);
CREATE        INDEX IF NOT EXISTS idx_giftcards_recipient      ON giftcards(issued_to_email_hash, status);

CREATE TABLE IF NOT EXISTS giftcard_redemptions (
  id            TEXT NOT NULL PRIMARY KEY,
  giftcard_id   TEXT NOT NULL,
  order_id      TEXT,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  redeemed_at   INTEGER NOT NULL,
  FOREIGN KEY (giftcard_id) REFERENCES giftcards(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_giftcard_redemptions_card ON giftcard_redemptions(giftcard_id, redeemed_at);
