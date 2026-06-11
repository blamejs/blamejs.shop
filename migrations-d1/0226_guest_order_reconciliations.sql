-- Audit trail for guest-order reconciliation.
--
-- When a shopper who checked out as a guest later proves control of the
-- buyer email (an OIDC sign-in whose provider verified the address, or a
-- magic-link click), their prior NULL-owner orders whose
-- customer_email_hash matches are attached to the account. The attach
-- itself flips orders.customer_id; this append-only table records WHEN it
-- happened, FOR which order/customer, by WHICH proof — so a disputed link
-- ("why is this stranger's order on my account?") is traceable end to end
-- and a reconciliation can be replayed for an operator/DSR review without
-- inferring it from a customer_id that was overwritten.
--
-- One row per (order, customer) attach. The UNIQUE index makes the write
-- idempotent: a second reconciliation pass for an order already attached to
-- the same customer is an INSERT-OR-IGNORE no-op, mirroring how the
-- underlying UPDATE only ever touches a still-unowned order. The email_hash
-- recorded is the verified linking key the attach matched on (never the
-- plaintext address — the customers store keeps only the hash). linked_via
-- names the proof route ("verified-email" = OIDC email_verified, or
-- "magic-link" = the buyer clicked an emailed sign-in link).

CREATE TABLE IF NOT EXISTS guest_order_reconciliations (
  id           TEXT NOT NULL PRIMARY KEY,
  order_id     TEXT NOT NULL,
  customer_id  TEXT NOT NULL,
  email_hash   TEXT NOT NULL,
  linked_via   TEXT NOT NULL,
  occurred_at  INTEGER NOT NULL
);

-- One audit row per (order, customer) attach — the UNIQUE index lets the
-- writer use INSERT OR IGNORE so a re-run records nothing new.
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_order_reconciliations_order_customer
  ON guest_order_reconciliations(order_id, customer_id);

-- Reverse lookup: every guest order reconciled into a given account, for
-- the operator/DSR "how did this order get here?" view.
CREATE INDEX IF NOT EXISTS idx_guest_order_reconciliations_customer
  ON guest_order_reconciliations(customer_id);
